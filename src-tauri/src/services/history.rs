//! Export / project history shown on the History screen. Stored as JSON in the app data dir.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::models::error::{AppError, AppResult};

const MAX_ITEMS: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HistoryKind {
    Export,
    Project,
    /// A shadow applied to many images at once.
    Shadow,
    /// An upscaled version that was kept.
    Upscale,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub id: String,
    pub kind: HistoryKind,
    pub name: String,
    /// RFC 3339.
    pub timestamp: String,
    pub source_path: Option<String>,
    pub output_path: Option<String>,
    pub thumbnail: Option<String>,
}

impl HistoryItem {
    pub fn new(
        kind: HistoryKind,
        name: &str,
        source: Option<String>,
        output: Option<String>,
        thumbnail: Option<String>,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            kind,
            name: name.to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            source_path: source,
            output_path: output,
            thumbnail,
        }
    }
}

#[derive(Debug)]
pub struct HistoryStore {
    file: PathBuf,
    items: Vec<HistoryItem>,
}

impl HistoryStore {
    /// Load (tolerantly: unreadable or corrupt files start an empty history).
    pub fn load(file: PathBuf) -> Self {
        let items = fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice::<Vec<HistoryItem>>(&b).ok())
            .unwrap_or_default();
        Self { file, items }
    }

    pub fn list(&self) -> Vec<HistoryItem> {
        self.items.clone()
    }

    fn save(&self) -> AppResult<()> {
        if let Some(p) = self.file.parent() {
            fs::create_dir_all(p)?;
        }
        let tmp = self.file.with_extension("json.tmp");
        fs::write(
            &tmp,
            serde_json::to_vec_pretty(&self.items)
                .map_err(|e| AppError::Internal(e.to_string()))?,
        )?;
        fs::rename(tmp, &self.file)?;
        Ok(())
    }

    /// Newest first; the oldest entries (and their thumbnails) are dropped beyond the cap.
    pub fn add(&mut self, item: HistoryItem) -> AppResult<()> {
        self.items.insert(0, item);
        while self.items.len() > MAX_ITEMS {
            if let Some(old) = self.items.pop() {
                remove_thumb(&old);
            }
        }
        self.save()
    }

    pub fn delete(&mut self, id: &str) -> AppResult<()> {
        if let Some(pos) = self.items.iter().position(|i| i.id == id) {
            remove_thumb(&self.items.remove(pos));
        }
        self.save()
    }

    pub fn clear(&mut self) -> AppResult<()> {
        for i in self.items.drain(..) {
            remove_thumb(&i);
        }
        self.save()
    }
}

/// Only thumbnails inside the history folder are ever deleted.
fn remove_thumb(item: &HistoryItem) {
    if let Some(t) = &item.thumbnail {
        if Path::new(t)
            .components()
            .any(|c| c.as_os_str() == "history")
        {
            let _ = fs::remove_file(t);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(name: &str) -> HistoryItem {
        HistoryItem::new(
            HistoryKind::Export,
            name,
            None,
            Some(format!("/out/{name}.png")),
            None,
        )
    }

    #[test]
    fn newest_first_and_persisted_across_reloads() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("history.json");
        let mut h = HistoryStore::load(file.clone());
        h.add(item("a")).unwrap();
        h.add(item("b")).unwrap();
        assert_eq!(
            h.list().iter().map(|i| i.name.as_str()).collect::<Vec<_>>(),
            ["b", "a"]
        );
        let again = HistoryStore::load(file);
        assert_eq!(again.list().len(), 2);
    }

    #[test]
    fn delete_clear_and_the_item_cap() {
        let dir = tempfile::tempdir().unwrap();
        let mut h = HistoryStore::load(dir.path().join("h.json"));
        let first = item("x");
        let id = first.id.clone();
        h.add(first).unwrap();
        h.add(item("y")).unwrap();
        h.delete(&id).unwrap();
        h.delete("does-not-exist").unwrap();
        assert_eq!(h.list().len(), 1);
        h.clear().unwrap();
        assert!(h.list().is_empty());
        for i in 0..MAX_ITEMS + 10 {
            h.add(item(&i.to_string())).unwrap();
        }
        assert_eq!(h.list().len(), MAX_ITEMS);
        assert_eq!(h.list()[0].name, (MAX_ITEMS + 9).to_string());
    }

    #[test]
    fn corrupt_history_file_starts_empty_instead_of_failing() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("h.json");
        fs::write(&file, b"{{ not json").unwrap();
        assert!(HistoryStore::load(file).list().is_empty());
    }

    #[test]
    fn only_thumbnails_inside_a_history_folder_are_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let inside = dir.path().join("history");
        fs::create_dir_all(&inside).unwrap();
        let mine = inside.join("t.png");
        let theirs = dir.path().join("precious.png");
        fs::write(&mine, b"x").unwrap();
        fs::write(&theirs, b"x").unwrap();
        let mut h = HistoryStore::load(dir.path().join("h.json"));
        for t in [&mine, &theirs] {
            let mut i = item("n");
            i.thumbnail = Some(t.display().to_string());
            h.add(i).unwrap();
        }
        h.clear().unwrap();
        assert!(!mine.exists());
        assert!(theirs.exists());
    }
}
