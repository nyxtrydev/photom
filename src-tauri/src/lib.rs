pub mod commands;
pub mod infra;
pub mod launch;
pub mod model_hub;
pub mod models;
pub mod services;
pub mod smoke;
pub mod state;

#[cfg(test)]
mod tests;

use std::sync::{Arc, Mutex, RwLock};

use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A second launch (e.g. double-clicking another .photom): focus us and open that file.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            if let Some(p) = launch::project_from_args(&args) {
                launch::deliver(app, &p);
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let dir = infra::paths::log_dir(app.handle())?;
            match infra::logging::init(&dir) {
                Ok(guard) => {
                    app.manage(guard);
                    tracing::info!(version = env!("CARGO_PKG_VERSION"), "Photom started");
                }
                Err(e) => eprintln!("logging disabled: {e}"),
            }

            let cache_dir = app.path().app_cache_dir()?;
            std::fs::create_dir_all(&cache_dir)?;
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let user_models = Some(data_dir.join("models"));
            let models = infra::model_manager::ModelManager::new(
                user_models,
                app.path().resource_dir().ok(),
            );
            let hub_events = app.handle().clone();
            let hub = Arc::new(model_hub::ModelHub::new(
                data_dir.join("models"),
                models.clone(),
                Arc::new(move |name, payload| {
                    let _ = hub_events.emit(name, payload);
                }),
            ));
            let settings = commands::settings::load(app.handle());
            let installer = model_hub::installer::Installer::new(
                hub.clone(),
                model_hub::downloader::NetConfig::default(),
                tauri::async_runtime::handle().inner().clone(),
            )?;
            let engine: Arc<services::inference::InferenceEngine> = Arc::new(Default::default());
            let sessions = Arc::new(model_hub::session_cache::SessionCache::default());
            {
                // Removing or replacing a model first lets go of every session built from it.
                let (sessions, engine) = (sessions.clone(), engine.clone());
                hub.add_unload_hook(Arc::new(move |id| {
                    use model_hub::hub::{BG_FAST, BG_QUALITY};
                    sessions.evict(id);
                    let kind = match id {
                        BG_FAST => models::dto::ModelKind::Fast,
                        BG_QUALITY => models::dto::ModelKind::Quality,
                        _ => return,
                    };
                    if engine.loaded_info().is_some_and(|l| l.kind == kind) {
                        engine.unload();
                    }
                }));
            }
            if let Err(e) = installer.apply_overrides(
                settings.models_catalog_url.as_deref(),
                settings.models_extra_host.as_deref(),
            ) {
                tracing::warn!(error = %e, "ignoring the model download overrides");
            }
            app.manage(state::AppState {
                images: Default::default(),
                engine,
                sessions,
                models,
                hub,
                installer,
                settings: Arc::new(RwLock::new(settings)),
                jobs: Arc::new(infra::job_queue::JobQueue::default()),
                history: Arc::new(Mutex::new(services::history::HistoryStore::load(
                    data_dir.join("history.json"),
                ))),
                upscale: Default::default(),
                pending_update: Default::default(),
                launch_file: Arc::new(Mutex::new(launch::project_from_args(std::env::args()))),
                frontend_ready: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                cache_dir,
                data_dir,
            });
            if smoke::requested() {
                run_smoke_test(app.handle().clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::system::ping,
            launch::take_launch_file,
            commands::image::import_images,
            commands::image::get_thumbnail,
            commands::image::prepare_working_set,
            commands::image::prepare_background_image,
            commands::image::reveal_in_folder,
            commands::image::read_cache_file,
            commands::inference::get_model_status,
            commands::inference::remove_background,
            commands::inference::set_active_mask,
            commands::project::save_project,
            commands::project::save_project_as,
            commands::project::open_project,
            commands::project::project_backup_path,
            commands::project::reset_session,
            commands::project::autosave_project,
            commands::project::list_recovery,
            commands::project::restore_recovery,
            commands::project::discard_recovery,
            commands::settings::get_settings,
            commands::settings::update_settings,
            commands::settings::remove_recent_project,
            commands::settings::clear_recent_projects,
            commands::settings::get_app_info,
            commands::settings::open_logs_folder,
            commands::settings::reveal_path,
            commands::settings::import_model,
            commands::settings::paths_exist,
            commands::settings::read_licences,
            model_hub::commands::models_list,
            model_hub::commands::model_catalog_status,
            model_hub::commands::model_check_requirements,
            model_hub::commands::models_refresh_catalog,
            model_hub::commands::model_install,
            model_hub::commands::model_pause,
            model_hub::commands::model_resume,
            model_hub::commands::model_cancel,
            model_hub::commands::model_install_many,
            model_hub::commands::model_install_recommended,
            model_hub::commands::model_install_all,
            model_hub::commands::model_open_folder,
            model_hub::commands::model_import_file,
            model_hub::commands::model_remove,
            commands::updates::check_for_update,
            commands::updates::install_update,
            commands::updates::restart_app,
            commands::export::export_png,
            commands::export::remove_background_batch,
            commands::export::cancel_job,
            commands::export::pause_job,
            commands::export::resume_job,
            commands::export::get_job,
            commands::export::copy_to_clipboard,
            commands::export::list_history,
            commands::export::delete_history_item,
            commands::export::clear_history,
            commands::export::list_export_presets,
            commands::export::save_export_preset,
            commands::export::delete_export_preset,
            commands::shadow::list_shadow_presets,
            commands::shadow::save_shadow_preset,
            commands::shadow::delete_shadow_preset,
            commands::shadow::shadow_apply_batch,
            commands::upscale::upscale_estimate,
            commands::upscale::upscale_run,
            commands::upscale::upscale_accept,
            commands::upscale::upscale_discard,
            commands::upscale::upscale_cancel,
            commands::upscale::upscale_batch,
            commands::upscale::upscale_loupe,
            commands::upscale::upscale_requirements,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Photom")
        .run(|app, event| {
            // macOS delivers "Open with" / double-click as an event rather than an argument.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &event {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        if launch::project_from_args([path.display().to_string()]).is_some() {
                            launch::deliver(app, &path);
                        }
                    }
                }
            }
            if let tauri::RunEvent::Exit = event {
                if let Some(st) = app.try_state::<state::AppState>() {
                    st.engine.unload();
                    st.sessions.clear();
                }
            }
        });
}

/// `--smoke-test [--smoke-out <file>]`: run the pipeline once, report, and exit 0/1.
fn run_smoke_test(app: tauri::AppHandle) {
    let out = std::env::args()
        .skip_while(|a| a != "--smoke-out")
        .nth(1)
        .map(std::path::PathBuf::from);
    std::thread::spawn(move || {
        let (code, message) = match smoke::run(&app) {
            Ok(m) => (0, m),
            Err(e) => (1, format!("SMOKE FAILED: {e}")),
        };
        println!("{message}");
        if let Some(path) = out {
            let _ = std::fs::write(path, &message);
        }
        if let Some(st) = app.try_state::<state::AppState>() {
            st.engine.unload();
        }
        app.exit(code);
    });
}
