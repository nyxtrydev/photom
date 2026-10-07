//! One warm ONNX session per installed model, shared by every feature.
//!
//! Generic over the session type so the caching rules (reuse, replace on a new version or device,
//! evict on removal) are testable without ONNX Runtime.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use super::hub::ModelHub;
use crate::models::error::{AppError, AppResult};

struct Entry<S> {
    /// Model version and a caller-chosen key (e.g. the device preference) the session was built for.
    stamp: String,
    session: Arc<Mutex<S>>,
}

pub struct SessionCache<S> {
    entries: Mutex<HashMap<String, Entry<S>>>,
}

impl<S> Default for SessionCache<S> {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }
}

impl<S> SessionCache<S> {
    /// The session for `id`, building it with `load` on first use. A different installed version
    /// or `variant` (device preference) replaces the cached one. A model that is not installed is
    /// `ModelMissing` carrying its id, so the UI can offer the install.
    pub fn get(
        &self,
        hub: &ModelHub,
        id: &str,
        variant: &str,
        load: impl FnOnce(&Path) -> AppResult<S>,
    ) -> AppResult<Arc<Mutex<S>>> {
        let path = hub.model_path(id)?;
        let version = hub
            .installed_version(id)
            .ok_or_else(|| AppError::ModelMissing(id.to_string()))?;
        let stamp = format!("{version}|{variant}");
        let mut map = self
            .entries
            .lock()
            .map_err(|_| AppError::Internal("session cache poisoned".into()))?;
        if let Some(e) = map.get(id) {
            if e.stamp == stamp {
                return Ok(Arc::clone(&e.session));
            }
        }
        map.remove(id); // free the old session before loading the new one
        let session = Arc::new(Mutex::new(load(&path)?));
        map.insert(
            id.to_string(),
            Entry {
                stamp,
                session: Arc::clone(&session),
            },
        );
        Ok(session)
    }

    /// Drop the cached session (removal, update). In-flight users keep their `Arc` until done.
    pub fn evict(&self, id: &str) {
        if let Ok(mut m) = self.entries.lock() {
            m.remove(id);
        }
    }

    pub fn contains(&self, id: &str) -> bool {
        self.entries
            .lock()
            .map(|m| m.contains_key(id))
            .unwrap_or(false)
    }

    /// Drop everything (before the process exits, see decision 44).
    pub fn clear(&self) {
        if let Ok(mut m) = self.entries.lock() {
            m.clear();
        }
    }
}
