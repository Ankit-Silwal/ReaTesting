use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State, rejection::JsonRejection},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tower_http::cors::{Any, CorsLayer};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    version: u8,
    next_id: u64,
    records: Vec<Value>,
}

struct FileStore {
    path: PathBuf,
    document: Document,
}

impl FileStore {
    fn open(path: PathBuf) -> Result<Self, String> {
        if path.exists() {
            let bytes =
                fs::read(&path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
            let document: Document = serde_json::from_slice(&bytes).map_err(|e| {
                format!(
                    "Invalid JSON in {}. Original file preserved: {e}",
                    path.display()
                )
            })?;
            let mut ids = HashSet::new();
            let valid = document.version == 1
                && document.next_id > 0
                && document.records.iter().all(|record| {
                    record.is_object()
                        && record
                            .get("id")
                            .and_then(Value::as_u64)
                            .is_some_and(|id| id > 0 && id < document.next_id && ids.insert(id))
                });
            if !valid {
                return Err(format!(
                    "Invalid record IDs or data format in {}. Original file preserved.",
                    path.display()
                ));
            }
            return Ok(Self { path, document });
        }
        let document = Document {
            version: 1,
            next_id: 2,
            records: vec![
                json!({"id":1,"name":"First test item","message":"Your local Rust test API is working."}),
            ],
        };
        let mut store = Self {
            path,
            document: document.clone(),
        };
        store.commit(document).map_err(|e| e.message)?;
        Ok(store)
    }

    fn commit(&mut self, next: Document) -> Result<(), ApiError> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| ApiError::storage("Invalid data file location."))?;
        fs::create_dir_all(parent).map_err(|e| ApiError::storage(e.to_string()))?;
        let bytes =
            serde_json::to_vec_pretty(&next).map_err(|e| ApiError::storage(e.to_string()))?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err(ApiError::new(
                StatusCode::INSUFFICIENT_STORAGE,
                "Test data exceeds the 16 MiB file limit.",
            ));
        }
        let mut temp = tempfile::NamedTempFile::new_in(parent)
            .map_err(|e| ApiError::storage(e.to_string()))?;
        temp.write_all(&bytes)
            .map_err(|e| ApiError::storage(e.to_string()))?;
        temp.as_file()
            .sync_all()
            .map_err(|e| ApiError::storage(e.to_string()))?;
        temp.persist(&self.path)
            .map_err(|e| ApiError::storage(e.error.to_string()))?;
        // Memory is committed only after the atomic file replacement succeeds.
        self.document = next;
        Ok(())
    }
}

#[derive(Clone)]
struct ApiState(Arc<Mutex<FileStore>>);

impl ApiState {
    async fn access<F>(&self, operation: F) -> Result<Value, ApiError>
    where
        F: FnOnce(&mut FileStore) -> Result<Value, ApiError> + Send + 'static,
    {
        let state = self.0.clone();
        tokio::task::spawn_blocking(move || {
            let mut store = state
                .lock()
                .map_err(|_| ApiError::storage("Storage lock unavailable."))?;
            operation(&mut store)
        })
        .await
        .map_err(|e| ApiError::storage(e.to_string()))?
    }
}

pub struct ApiError {
    status: StatusCode,
    message: String,
}
impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
    fn storage(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Could not persist test data: {}", message.into()),
        )
    }
    fn missing(id: u64) -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            format!("Test item {id} was not found."),
        )
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"error":self.message,"status":self.status.as_u16()})),
        )
            .into_response()
    }
}

pub fn create_router(path: PathBuf) -> Result<Router, String> {
    let path = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(path)
    };
    let state = ApiState(Arc::new(Mutex::new(FileStore::open(path)?)));
    Ok(Router::new()
        .route("/", get(index))
        .route(
            "/health",
            get(|| async {
                Json(json!({"status":"ok","service":"Relay Rust test API","storage":"JSON file"}))
            }),
        )
        .route("/test", get(list).post(create).fallback(method_not_allowed))
        .route(
            "/test/{id}",
            get(read)
                .put(replace)
                .patch(patch)
                .delete(delete)
                .fallback(method_not_allowed),
        )
        .fallback(not_found)
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods([
                    axum::http::Method::GET,
                    axum::http::Method::POST,
                    axum::http::Method::PUT,
                    axum::http::Method::PATCH,
                    axum::http::Method::DELETE,
                    axum::http::Method::HEAD,
                    axum::http::Method::OPTIONS,
                ])
                .allow_headers(Any),
        )
        .with_state(state))
}

async fn index() -> Json<Value> {
    Json(
        json!({"service":"Relay Rust test API","endpoints":{"GET /test":"List all records","GET /test/1":"Read a record","POST /test":"Create a record with an automatically increasing id","PUT /test/1":"Replace a record","PATCH /test/1":"Update selected fields","DELETE /test/1":"Delete a record"},"exampleBody":{"name":"Hello","message":"Testing Relay"}}),
    )
}

fn id_from(value: String) -> Result<u64, ApiError> {
    value
        .parse::<u64>()
        .ok()
        .filter(|id| *id > 0)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "The item ID must be a positive integer.",
            )
        })
}
fn object_from(
    payload: Result<Json<Value>, JsonRejection>,
) -> Result<Map<String, Value>, ApiError> {
    let Json(value) = payload.map_err(|e| {
        ApiError::new(
            e.status(),
            format!(
                "Send a valid JSON object with Content-Type: application/json. {}",
                e.body_text()
            ),
        )
    })?;
    value.as_object().cloned().ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "Request body must be a JSON object, for example {\"name\":\"Hello\"}.",
        )
    })
}

async fn list(State(state): State<ApiState>) -> Result<Json<Value>, ApiError> {
    state
        .access(|store| {
            Ok(json!({"items":store.document.records,"total":store.document.records.len()}))
        })
        .await
        .map(Json)
}
async fn read(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let id = id_from(id)?;
    state
        .access(move |store| {
            store
                .document
                .records
                .iter()
                .find(|r| r["id"] == id)
                .cloned()
                .ok_or_else(|| ApiError::missing(id))
        })
        .await
        .map(Json)
}
async fn create(
    State(state): State<ApiState>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Result<Response, ApiError> {
    let mut fields = object_from(payload)?;
    let item = state
        .access(move |store| {
            let mut next = store.document.clone();
            let id = next.next_id;
            next.next_id = id
                .checked_add(1)
                .ok_or_else(|| ApiError::storage("ID counter exhausted."))?;
            fields.insert("id".into(), json!(id));
            let item = Value::Object(fields);
            next.records.push(item.clone());
            store.commit(next)?;
            Ok(item)
        })
        .await?;
    let location = format!("/test/{}", item["id"]);
    Ok((
        StatusCode::CREATED,
        [(header::LOCATION, location)],
        Json(item),
    )
        .into_response())
}
async fn replace(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    update(state, id, object_from(payload)?, false)
        .await
        .map(Json)
}
async fn patch(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    update(state, id, object_from(payload)?, true)
        .await
        .map(Json)
}
async fn update(
    state: ApiState,
    id: String,
    mut fields: Map<String, Value>,
    merge: bool,
) -> Result<Value, ApiError> {
    let id = id_from(id)?;
    state
        .access(move |store| {
            let mut next = store.document.clone();
            let item = next
                .records
                .iter_mut()
                .find(|r| r["id"] == id)
                .ok_or_else(|| ApiError::missing(id))?;
            fields.insert("id".into(), json!(id));
            if merge {
                item.as_object_mut()
                    .expect("validated stored record")
                    .extend(fields);
            } else {
                *item = Value::Object(fields);
            }
            let result = item.clone();
            store.commit(next)?;
            Ok(result)
        })
        .await
}
async fn delete(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let id = id_from(id)?;
    state
        .access(move |store| {
            let mut next = store.document.clone();
            let index = next
                .records
                .iter()
                .position(|r| r["id"] == id)
                .ok_or_else(|| ApiError::missing(id))?;
            next.records.remove(index);
            store.commit(next)?;
            Ok(json!({"deleted":true,"id":id}))
        })
        .await
        .map(Json)
}
async fn not_found() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "Endpoint not found. Open GET / for the available endpoints.",
    )
}
async fn method_not_allowed() -> ApiError {
    ApiError::new(
        StatusCode::METHOD_NOT_ALLOWED,
        "Use GET/POST on /test and GET/PUT/PATCH/DELETE on /test/{id}.",
    )
}
