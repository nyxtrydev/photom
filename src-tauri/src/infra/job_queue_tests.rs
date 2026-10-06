use std::sync::mpsc::{channel, Receiver, Sender};
use std::time::{Duration, Instant};

use serde_json::json;

use super::*;

#[derive(Default)]
struct Recorder {
    log: Mutex<Vec<String>>,
    progress: Mutex<Vec<(usize, usize, JobStatus)>>,
}

impl JobEvents for Recorder {
    fn progress(&self, _: &str, done: usize, total: usize, _: Option<&str>, status: JobStatus) {
        lock(&self.progress).push((done, total, status));
    }
    fn item_complete(&self, _: &str, item: &str, _: &Value) {
        lock(&self.log).push(format!("ok:{item}"));
    }
    fn item_error(&self, _: &str, item: &str, e: &ItemError) {
        lock(&self.log).push(format!("err:{item}:{}", e.code));
    }
}

fn items(n: usize) -> Vec<(String, String)> {
    (0..n)
        .map(|i| (format!("i{i}"), format!("file{i}.png")))
        .collect()
}

fn wait_until(q: &JobQueue, id: &str, f: impl Fn(&JobSnapshot) -> bool) -> JobSnapshot {
    let t = Instant::now();
    loop {
        let s = q.snapshot(id).unwrap();
        if f(&s) {
            return s;
        }
        assert!(
            t.elapsed() < Duration::from_secs(10),
            "timed out waiting; state: {s:?}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn finished(s: &JobSnapshot) -> bool {
    matches!(s.status, JobStatus::Done | JobStatus::Cancelled)
}

#[test]
fn processes_every_item_in_order_with_monotonic_progress() {
    let q = JobQueue::default();
    let rec = Arc::new(Recorder::default());
    let id = q.start("export", items(5), 1, rec.clone(), |i, _| {
        Ok(json!({ "n": i }))
    });
    let s = wait_until(&q, &id, finished);
    assert_eq!(s.status, JobStatus::Done);
    assert_eq!((s.done, s.total), (5, 5));
    assert!(s.items.iter().all(|i| i.status == ItemStatus::Done));
    assert_eq!(
        *lock(&rec.log),
        ["ok:i0", "ok:i1", "ok:i2", "ok:i3", "ok:i4"]
    );
    let progress = lock(&rec.progress).clone();
    assert!(
        progress.windows(2).all(|w| w[0].0 <= w[1].0),
        "done count never goes backwards"
    );
    assert_eq!(progress.last().unwrap(), &(5, 5, JobStatus::Done));
}

#[test]
fn one_failing_item_does_not_stop_the_batch() {
    let q = JobQueue::default();
    let rec = Arc::new(Recorder::default());
    let id = q.start("export", items(4), 1, rec.clone(), |i, _| {
        if i == 1 {
            Err(AppError::Decode("bad file".into()))
        } else {
            Ok(json!(i))
        }
    });
    let s = wait_until(&q, &id, finished);
    assert_eq!(s.status, JobStatus::Done);
    assert_eq!(s.done, 4); // failed items count as finished
    let st: Vec<_> = s.items.iter().map(|i| i.status).collect();
    assert_eq!(
        st,
        [
            ItemStatus::Done,
            ItemStatus::Failed,
            ItemStatus::Done,
            ItemStatus::Done
        ]
    );
    assert_eq!(s.items[1].error.as_ref().unwrap().code, "Decode");
    assert!(lock(&rec.log).contains(&"err:i1:Decode".to_string()));
}

#[test]
fn a_panicking_worker_fails_only_its_item() {
    let q = JobQueue::default();
    let id = q.start(
        "export",
        items(3),
        1,
        Arc::new(Recorder::default()),
        |i, _| {
            if i == 0 {
                panic!("boom");
            }
            Ok(json!(i))
        },
    );
    let s = wait_until(&q, &id, finished);
    assert_eq!(s.items[0].status, ItemStatus::Failed);
    assert_eq!(s.items[0].error.as_ref().unwrap().code, "Internal");
    assert_eq!(s.items[2].status, ItemStatus::Done);
}

/// A worker that blocks until the test sends "go", reporting when each item starts.
fn gated() -> (
    impl Fn(usize, &str) -> AppResult<Value> + Send + Sync + 'static,
    Sender<()>,
    Receiver<usize>,
) {
    let (go_tx, go_rx) = channel::<()>();
    let (started_tx, started_rx) = channel::<usize>();
    let go_rx = Mutex::new(go_rx);
    let started_tx = Mutex::new(started_tx);
    let f = move |i: usize, _: &str| {
        lock(&started_tx).send(i).unwrap();
        lock(&go_rx).recv().unwrap();
        Ok(json!(i))
    };
    (f, go_tx, started_rx)
}

#[test]
fn cancel_stops_cleanly_after_the_running_item() {
    let q = JobQueue::default();
    let (worker, go, started) = gated();
    let id = q.start("export", items(5), 1, Arc::new(Recorder::default()), worker);
    assert_eq!(started.recv().unwrap(), 0);
    q.cancel(&id).unwrap();
    go.send(()).unwrap(); // let item 0 finish
    let s = wait_until(&q, &id, finished);
    assert_eq!(s.status, JobStatus::Cancelled);
    let st: Vec<_> = s.items.iter().map(|i| i.status).collect();
    assert_eq!(st[0], ItemStatus::Done); // the running item completed (no half-written file)
    assert!(st[1..].iter().all(|s| *s == ItemStatus::Cancelled));
    assert!(
        started.try_recv().is_err(),
        "no further item may start after cancel"
    );
}

#[test]
fn cancel_while_paused_does_not_hang() {
    let q = JobQueue::default();
    let (worker, go, started) = gated();
    let id = q.start("export", items(3), 1, Arc::new(Recorder::default()), worker);
    started.recv().unwrap();
    q.pause(&id).unwrap();
    go.send(()).unwrap();
    wait_until(&q, &id, |s| s.items[0].status == ItemStatus::Done);
    q.cancel(&id).unwrap();
    let s = wait_until(&q, &id, finished);
    assert_eq!(s.status, JobStatus::Cancelled);
    assert_eq!(s.items[1].status, ItemStatus::Cancelled);
}

#[test]
fn pause_holds_the_next_item_until_resume() {
    let q = JobQueue::default();
    let (worker, go, started) = gated();
    let id = q.start("export", items(3), 1, Arc::new(Recorder::default()), worker);
    assert_eq!(started.recv().unwrap(), 0);
    q.pause(&id).unwrap();
    assert_eq!(q.snapshot(&id).unwrap().status, JobStatus::Paused);
    go.send(()).unwrap(); // item 0 finishes while paused

    wait_until(&q, &id, |s| s.items[0].status == ItemStatus::Done);
    std::thread::sleep(Duration::from_millis(100));
    assert!(
        started.try_recv().is_err(),
        "item 1 must not start while paused"
    );
    assert_eq!(q.snapshot(&id).unwrap().items[1].status, ItemStatus::Queued);

    q.resume(&id).unwrap();
    assert_eq!(q.snapshot(&id).unwrap().status, JobStatus::Running);
    assert_eq!(started.recv_timeout(Duration::from_secs(5)).unwrap(), 1);
    go.send(()).unwrap();
    assert_eq!(started.recv_timeout(Duration::from_secs(5)).unwrap(), 2);
    go.send(()).unwrap();
    assert_eq!(wait_until(&q, &id, finished).status, JobStatus::Done);
}

#[test]
fn two_workers_run_items_in_parallel_and_each_item_once() {
    let q = JobQueue::default();
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (b, s2) = (barrier.clone(), seen.clone());
    let id = q.start(
        "export",
        items(2),
        2,
        Arc::new(Recorder::default()),
        move |i, _| {
            b.wait(); // only passes if both items are running at the same time
            lock(&s2).push(i);
            Ok(json!(i))
        },
    );
    let s = wait_until(&q, &id, finished);
    assert_eq!(s.status, JobStatus::Done);
    let mut v = lock(&seen).clone();
    v.sort();
    assert_eq!(v, [0, 1]);
}

#[test]
fn concurrency_is_capped_at_two() {
    let q = JobQueue::default();
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let (a, p) = (active.clone(), peak.clone());
    let id = q.start(
        "export",
        items(8),
        99,
        Arc::new(Recorder::default()),
        move |_, _| {
            let now = a.fetch_add(1, Ordering::SeqCst) + 1;
            p.fetch_max(now, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(15));
            a.fetch_sub(1, Ordering::SeqCst);
            Ok(json!(null))
        },
    );
    wait_until(&q, &id, finished);
    assert!(peak.load(Ordering::SeqCst) <= 2);
}

#[test]
fn unknown_jobs_and_empty_batches_are_handled() {
    let q = JobQueue::default();
    assert_eq!(q.pause("nope").unwrap_err().code(), "InvalidInput");
    assert_eq!(q.cancel("nope").unwrap_err().code(), "InvalidInput");
    assert!(q.snapshot("nope").is_err());
    let id = q.start(
        "export",
        vec![],
        1,
        Arc::new(Recorder::default()),
        |_, _| Ok(json!(null)),
    );
    let s = wait_until(&q, &id, finished);
    assert_eq!((s.status, s.done, s.total), (JobStatus::Done, 0, 0));
}

#[test]
fn only_recent_finished_jobs_are_remembered() {
    let q = JobQueue::default();
    let ids: Vec<_> = (0..KEEP_FINISHED + 5)
        .map(|_| {
            let id = q.start(
                "export",
                items(1),
                1,
                Arc::new(Recorder::default()),
                |_, _| Ok(json!(null)),
            );
            wait_until(&q, &id, finished);
            id
        })
        .collect();
    assert!(q.snapshot(&ids[0]).is_err(), "oldest job evicted");
    assert!(q.snapshot(ids.last().unwrap()).is_ok());
}
