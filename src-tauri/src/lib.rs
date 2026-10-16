use relay_core::{http::{HttpEngine, RequestSpec, ResponseData}, storage::WorkspaceStore, demo::DemoServer};
use std::sync::Arc;
use tauri::{Manager, State};

struct AppState {
    engine: HttpEngine,
    storage: Arc<WorkspaceStore>,
    demo: tokio::sync::Mutex<Option<Arc<DemoServer>>>,
}

#[tauri::command]
async fn send_request(request: RequestSpec, state: State<'_, AppState>) -> Result<ResponseData, String> { state.engine.send(request).await }

#[tauri::command]
fn cancel_request(id: String, state: State<'_, AppState>) -> bool { state.engine.cancel(&id) }

#[tauri::command]
async fn load_workspace(state: State<'_, AppState>) -> Result<Option<serde_json::Value>, String> {
    let storage = state.storage.clone();
    tauri::async_runtime::spawn_blocking(move || storage.load()).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_workspace(data: serde_json::Value, state: State<'_, AppState>) -> Result<(), String> {
    let storage = state.storage.clone();
    tauri::async_runtime::spawn_blocking(move || storage.save(&data)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn start_demo(state: State<'_, AppState>) -> Result<String, String> {
    let mut demo = state.demo.lock().await;
    if let Some(server) = demo.as_ref() { return Ok(server.url.clone()); }
    let server = DemoServer::start().await?;
    let url = server.url.clone();
    *demo = Some(server);
    Ok(url)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let path = app.path().app_data_dir()?.join("workspace.json");
            app.manage(AppState { engine: HttpEngine::default(), storage: Arc::new(WorkspaceStore::new(path)), demo: tokio::sync::Mutex::new(None) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![send_request, cancel_request, load_workspace, save_workspace, start_demo])
        .run(tauri::generate_context!())
        .expect("could not run Relay");
}
