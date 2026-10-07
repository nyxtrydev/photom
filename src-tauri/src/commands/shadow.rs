//! Custom shadow presets. They live in settings (like export presets); the editor applies them.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, State};

use super::export::{validate_items, ExportItemRequest, TauriEvents};
use crate::models::error::AppError;
use crate::services::exporter;
use crate::services::history::{HistoryItem, HistoryKind};
use crate::services::settings::Settings;
use crate::services::shadow::ShadowParams;
use crate::state::AppState;

const MAX_PRESETS: usize = 30;

fn validate_preset(mut v: Value) -> Result<Value, AppError> {
    let obj = v
        .as_object_mut()
        .ok_or_else(|| AppError::InvalidInput("preset must be an object".into()))?;
    let name = obj
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if name.is_empty() || name.chars().count() > 60 {
        return Err(AppError::InvalidInput(
            "Give the preset a name (up to 60 characters).".into(),
        ));
    }
    let name = name.to_string();
    obj.insert("name".into(), json!(name));
    // Layers must parse as a shadow; unknown layer types are dropped, values are clamped.
    let layers = obj
        .get("layers")
        .filter(|l| l.is_array())
        .ok_or_else(|| AppError::InvalidInput("preset has no layers".into()))?;
    let probe = ShadowParams::from_value(&json!({ "enabled": true, "layers": layers }))
        .ok_or_else(|| AppError::InvalidInput("preset has no layers".into()))?;
    if probe.layers.is_empty() {
        return Err(AppError::InvalidInput(
            "The preset needs at least one layer.".into(),
        ));
    }
    let id = obj
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 64
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    obj.insert("id".into(), json!(id));
    Ok(v)
}

fn save_presets(
    app: &AppHandle,
    st: &AppState,
    f: impl FnOnce(&mut Settings) -> Result<(), AppError>,
) -> Result<Vec<Value>, AppError> {
    let mut s = st.settings();
    f(&mut s)?;
    Ok(super::settings::persist(app, st, s)?.shadow_presets)
}

#[tauri::command]
pub fn list_shadow_presets(state: State<'_, AppState>) -> Vec<Value> {
    state.settings().shadow_presets
}

#[tauri::command]
pub fn save_shadow_preset(
    app: AppHandle,
    state: State<'_, AppState>,
    preset: Value,
) -> Result<Vec<Value>, AppError> {
    let preset = validate_preset(preset)?;
    save_presets(&app, state.inner(), |s| {
        let id = preset["id"].clone();
        match s.shadow_presets.iter().position(|p| p["id"] == id) {
            Some(i) => s.shadow_presets[i] = preset,
            None if s.shadow_presets.len() >= MAX_PRESETS => {
                return Err(AppError::InvalidInput(format!(
                    "You can keep up to {MAX_PRESETS} shadow presets. Delete one first."
                )))
            }
            None => s.shadow_presets.push(preset),
        }
        Ok(())
    })
}

#[tauri::command]
pub fn delete_shadow_preset(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<Value>, AppError> {
    save_presets(&app, state.inner(), |s| {
        s.shadow_presets.retain(|p| p["id"] != json!(id));
        Ok(())
    })
}

/// Check a shadow against many images as a background job (progress, pause, cancel and per-image
/// errors come from the job queue). The editor adopts the settings for the images that pass.
/// `items` carry each image's editor state with the shadow already scaled to that image.
#[tauri::command]
pub fn shadow_apply_batch(
    app: AppHandle,
    state: State<'_, AppState>,
    items: Vec<ExportItemRequest>,
    label: String,
) -> Result<String, AppError> {
    validate_items(&items)?;
    let st = state.inner().clone();
    let total = items.len();
    let labels = items
        .iter()
        .map(|i| {
            let name = st
                .images
                .get(&i.id)
                .map(|r| r.meta.name)
                .unwrap_or_else(|_| i.id.clone());
            (i.id.clone(), name)
        })
        .collect::<Vec<_>>();
    let events = Arc::new(TauriEvents { app });
    let applied = Arc::new(AtomicUsize::new(0));
    let label: String = label.chars().take(60).collect();
    let st2 = st.clone();
    Ok(st
        .jobs
        .start("applyShadow", labels, 1, events, move |index, id| {
            let req = items
                .iter()
                .find(|i| i.id == id)
                .ok_or_else(|| AppError::Internal("item vanished".into()))?;
            let result = st2
                .images
                .get(id)
                .and_then(|rec| exporter::shadow_check(&rec, &req.state, st2.pixel_limit()));
            if result.is_ok() {
                applied.fetch_add(1, Ordering::SeqCst);
            }
            // One History entry for the whole batch, written when its last image is done.
            if index + 1 == total {
                let n = applied.load(Ordering::SeqCst);
                if n > 0 {
                    if let Ok(mut h) = st2.history.lock() {
                        let what = if label.trim().is_empty() {
                            "Shadow".to_string()
                        } else {
                            format!("Shadow: {label}")
                        };
                        let _ = h.add(HistoryItem::new(
                            HistoryKind::Shadow,
                            &format!(
                                "{what} applied to {n} image{}",
                                if n == 1 { "" } else { "s" }
                            ),
                            None,
                            None,
                            None,
                        ));
                    }
                }
            }
            result.and_then(|c| {
                serde_json::to_value(c).map_err(|e| AppError::Internal(e.to_string()))
            })
        }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layers() -> Value {
        json!([{"type": "drop"}, {"type": "contact"}])
    }

    #[test]
    fn presets_are_validated_and_get_an_id() {
        let p = validate_preset(json!({"name": "  Shop  ", "layers": layers()})).unwrap();
        assert_eq!(p["name"], "Shop");
        assert!(p["id"].as_str().unwrap().len() > 10);
        assert!(validate_preset(json!({"name": "", "layers": layers()})).is_err());
        assert!(validate_preset(json!({"name": "x"})).is_err());
        assert!(validate_preset(json!({"name": "x", "layers": []})).is_err());
        assert!(validate_preset(json!({"name": "x", "layers": [{"type": "hologram"}]})).is_err());
        assert!(validate_preset(json!("nope")).is_err());
        assert!(validate_preset(json!({"name": "x".repeat(61), "layers": layers()})).is_err());
    }

    #[test]
    fn an_unsafe_id_is_replaced() {
        let p = validate_preset(json!({"id": "../x", "name": "a", "layers": layers()})).unwrap();
        assert_ne!(p["id"], "../x");
        let keep =
            validate_preset(json!({"id": "my-id_1", "name": "a", "layers": layers()})).unwrap();
        assert_eq!(keep["id"], "my-id_1");
    }
}
