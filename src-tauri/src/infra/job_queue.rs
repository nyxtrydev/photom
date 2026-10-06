//! Batch job queue (batch removal and batch export).
//!
//! Items are processed in order by `concurrency` worker threads (default 1: memory safe).
//! A failing item is recorded and the batch continues. Pause/resume take effect between items;
//! cancel stops before the next item starts (an item already running finishes, so no file is left
//! half-written). Events are emitted at every item boundary.

use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

use serde::Serialize;
use serde_json::Value;

use crate::models::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemStatus {
    Queued,
    Processing,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JobStatus {
    Running,
    Paused,
    /// Every item was attempted (some may have failed).
    Done,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobItem {
    pub id: String,
    pub label: String,
    pub status: ItemStatus,
    pub error: Option<ItemError>,
    /// Whatever the worker returned (e.g. output path, mask result).
    pub result: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    pub job_id: String,
    pub kind: String,
    pub status: JobStatus,
    /// Items that have finished (done or failed).
    pub done: usize,
    pub total: usize,
    pub items: Vec<JobItem>,
}

pub trait JobEvents: Send + Sync + 'static {
    fn progress(
        &self,
        job_id: &str,
        done: usize,
        total: usize,
        current: Option<&str>,
        status: JobStatus,
    );
    fn item_complete(&self, job_id: &str, item_id: &str, result: &Value);
    fn item_error(&self, job_id: &str, item_id: &str, error: &ItemError);
}

#[derive(Default)]
struct Control {
    paused: bool,
    cancelled: bool,
}

struct Job {
    id: String,
    kind: String,
    items: Mutex<Vec<JobItem>>,
    status: Mutex<JobStatus>,
    control: Mutex<Control>,
    wake: Condvar,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Job {
    fn snapshot(&self) -> JobSnapshot {
        let items = lock(&self.items).clone();
        let done = items
            .iter()
            .filter(|i| matches!(i.status, ItemStatus::Done | ItemStatus::Failed))
            .count();
        JobSnapshot {
            job_id: self.id.clone(),
            kind: self.kind.clone(),
            status: *lock(&self.status),
            done,
            total: items.len(),
            items,
        }
    }
}

const KEEP_FINISHED: usize = 20;

#[derive(Default)]
pub struct JobQueue {
    jobs: Mutex<Vec<Arc<Job>>>,
    index: Mutex<HashMap<String, Arc<Job>>>,
}

impl JobQueue {
    fn find(&self, id: &str) -> AppResult<Arc<Job>> {
        lock(&self.index)
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::InvalidInput(format!("unknown job: {id}")))
    }

    pub fn snapshot(&self, id: &str) -> AppResult<JobSnapshot> {
        Ok(self.find(id)?.snapshot())
    }

    pub fn pause(&self, id: &str) -> AppResult<()> {
        let job = self.find(id)?;
        let mut st = lock(&job.status);
        if *st == JobStatus::Running {
            lock(&job.control).paused = true;
            *st = JobStatus::Paused;
        }
        Ok(())
    }

    pub fn resume(&self, id: &str) -> AppResult<()> {
        let job = self.find(id)?;
        let mut st = lock(&job.status);
        if *st == JobStatus::Paused {
            lock(&job.control).paused = false;
            *st = JobStatus::Running;
            job.wake.notify_all();
        }
        Ok(())
    }

    pub fn cancel(&self, id: &str) -> AppResult<()> {
        let job = self.find(id)?;
        lock(&job.control).cancelled = true;
        job.wake.notify_all();
        Ok(())
    }

    fn evict_old(&self) {
        let mut jobs = lock(&self.jobs);
        let finished =
            |j: &Arc<Job>| matches!(*lock(&j.status), JobStatus::Done | JobStatus::Cancelled);
        while jobs.iter().filter(|j| finished(j)).count() > KEEP_FINISHED {
            if let Some(pos) = jobs.iter().position(finished) {
                let old = jobs.remove(pos);
                lock(&self.index).remove(&old.id);
            }
        }
    }

    /// Start a job. `worker(index, item_id)` returns a JSON result or an error; an error (or a
    /// panic) fails only that item.
    pub fn start<W>(
        &self,
        kind: &str,
        items: Vec<(String, String)>,
        concurrency: usize,
        events: Arc<dyn JobEvents>,
        worker: W,
    ) -> String
    where
        W: Fn(usize, &str) -> AppResult<Value> + Send + Sync + 'static,
    {
        let id = uuid::Uuid::new_v4().to_string();
        let job = Arc::new(Job {
            id: id.clone(),
            kind: kind.to_string(),
            items: Mutex::new(
                items
                    .into_iter()
                    .map(|(id, label)| JobItem {
                        id,
                        label,
                        status: ItemStatus::Queued,
                        error: None,
                        result: None,
                    })
                    .collect(),
            ),
            status: Mutex::new(JobStatus::Running),
            control: Mutex::new(Control::default()),
            wake: Condvar::new(),
        });
        lock(&self.jobs).push(job.clone());
        lock(&self.index).insert(id.clone(), job.clone());
        self.evict_old();

        let worker = Arc::new(worker);
        let next = Arc::new(AtomicUsize::new(0));
        let threads = concurrency.clamp(1, 2);

        let events_for_final = events.clone();
        let job_for_final = job.clone();
        std::thread::spawn(move || {
            let handles: Vec<_> = (0..threads)
                .map(|_| {
                    let (job, events, worker, next) =
                        (job.clone(), events.clone(), worker.clone(), next.clone());
                    std::thread::spawn(move || {
                        run_worker(&job, events.as_ref(), worker.as_ref(), &next)
                    })
                })
                .collect();
            for h in handles {
                let _ = h.join();
            }
            finish(&job_for_final, events_for_final.as_ref());
        });
        id
    }
}

fn run_worker<W>(job: &Job, events: &dyn JobEvents, worker: &W, next: &AtomicUsize)
where
    W: Fn(usize, &str) -> AppResult<Value>,
{
    loop {
        // Take the next item, waiting while paused.
        let index = {
            let mut ctl = lock(&job.control);
            while ctl.paused && !ctl.cancelled {
                ctl = job.wake.wait(ctl).unwrap_or_else(|e| e.into_inner());
            }
            if ctl.cancelled {
                return;
            }
            let i = next.fetch_add(1, Ordering::SeqCst);
            if i >= lock(&job.items).len() {
                return;
            }
            i
        };

        let item_id = {
            let mut items = lock(&job.items);
            items[index].status = ItemStatus::Processing;
            items[index].id.clone()
        };
        let snap = job.snapshot();
        events.progress(&job.id, snap.done, snap.total, Some(&item_id), snap.status);

        let outcome = catch_unwind(AssertUnwindSafe(|| worker(index, &item_id)))
            .unwrap_or_else(|_| Err(AppError::Internal("the task crashed unexpectedly".into())));

        match outcome {
            Ok(result) => {
                {
                    let mut items = lock(&job.items);
                    items[index].status = ItemStatus::Done;
                    items[index].result = Some(result.clone());
                }
                events.item_complete(&job.id, &item_id, &result);
            }
            Err(e) => {
                let err = ItemError {
                    code: e.code().to_string(),
                    message: e.to_string(),
                };
                {
                    let mut items = lock(&job.items);
                    items[index].status = ItemStatus::Failed;
                    items[index].error = Some(err.clone());
                }
                tracing::warn!(job = %job.id, item = %item_id, code = %err.code, "batch item failed");
                events.item_error(&job.id, &item_id, &err);
            }
        }
        let snap = job.snapshot();
        events.progress(&job.id, snap.done, snap.total, None, snap.status);
    }
}

fn finish(job: &Job, events: &dyn JobEvents) {
    let cancelled = lock(&job.control).cancelled;
    {
        let mut items = lock(&job.items);
        for i in items.iter_mut().filter(|i| i.status == ItemStatus::Queued) {
            i.status = ItemStatus::Cancelled;
        }
    }
    *lock(&job.status) = if cancelled {
        JobStatus::Cancelled
    } else {
        JobStatus::Done
    };
    let snap = job.snapshot();
    events.progress(&job.id, snap.done, snap.total, None, snap.status);
}

#[cfg(test)]
#[path = "job_queue_tests.rs"]
mod tests;
