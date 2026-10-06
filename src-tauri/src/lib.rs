pub mod commands;
pub mod infra;
pub mod launch;
pub mod models;
pub mod services;
pub mod smoke;
pub mod state;

#[cfg(test)]
mod tests;

use std::sync::{Arc, Mutex, RwLock};

use tauri::Manager;

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
            let settings = commands::settings::load(app.handle());
            app.manage(state::AppState {
                images: Default::default(),
                engine: Arc::new(Default::default()),
                models,
                settings: Arc::new(RwLock::new(settings)),
                jobs: Arc::new(infra::job_queue::JobQueue::default()),
                history: Arc::new(Mutex::new(services::history::HistoryStore::load(
                    data_dir.join("history.json"),
                ))),
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
