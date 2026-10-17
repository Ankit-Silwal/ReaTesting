use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use relay_test_api::create_router;
use serde_json::{Value, json};
use tower::ServiceExt;

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(path);
    let bytes = if let Some(value) = body {
        builder = builder.header("content-type", "application/json");
        serde_json::to_vec(&value).unwrap()
    } else {
        vec![]
    };
    let response = app
        .clone()
        .oneshot(builder.body(Body::from(bytes)).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn creates_reads_replaces_patches_and_deletes_records() {
    let dir = tempfile::tempdir().unwrap();
    let app = create_router(dir.path().join("data.json")).unwrap();
    assert_eq!(request(&app, "GET", "/test/1", None).await.1["id"], 1);
    let (status, created) = request(
        &app,
        "POST",
        "/test",
        Some(json!({"id":999,"name":"Ada","keep":true})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["id"], 2);
    assert_eq!(request(&app, "GET", "/test/2", None).await.1["name"], "Ada");
    let (_, updated) = request(
        &app,
        "PATCH",
        "/test/2",
        Some(json!({"id":500,"name":"Grace"})),
    )
    .await;
    assert_eq!(updated["id"], 2);
    assert_eq!(updated["keep"], true);
    assert_eq!(updated["name"], "Grace");
    let (_, replaced) = request(&app, "PUT", "/test/2", Some(json!({"name":"Lin"}))).await;
    assert_eq!(replaced["id"], 2);
    assert!(replaced.get("keep").is_none());
    assert_eq!(
        request(&app, "DELETE", "/test/2", None).await.1,
        json!({"deleted":true,"id":2})
    );
    assert_eq!(
        request(&app, "GET", "/test/2", None).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(request(&app, "GET", "/test", None).await.1["total"], 1);
}

#[tokio::test]
async fn persists_changes_and_does_not_reuse_ids_after_deletion_or_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("data.json");
    let app = create_router(path.clone()).unwrap();
    request(&app, "POST", "/test", Some(json!({"name":"two"}))).await;
    request(&app, "DELETE", "/test/2", None).await;
    drop(app);
    let app = create_router(path.clone()).unwrap();
    assert_eq!(
        request(&app, "POST", "/test", Some(json!({"name":"three"})))
            .await
            .1["id"],
        3
    );
    let disk: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(disk["nextId"], 4);
    assert_eq!(disk["records"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn concurrent_posts_have_unique_ids_and_complete_file_contents() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("data.json");
    let app = create_router(path.clone()).unwrap();
    let mut tasks = vec![];
    for index in 0..12 {
        let app = app.clone();
        tasks.push(tokio::spawn(async move {
            request(&app, "POST", "/test", Some(json!({"index":index})))
                .await
                .1["id"]
                .as_u64()
                .unwrap()
        }));
    }
    let mut ids = vec![];
    for task in tasks {
        ids.push(task.await.unwrap());
    }
    ids.sort_unstable();
    assert_eq!(ids, (2..14).collect::<Vec<_>>());
    let disk: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(disk["records"].as_array().unwrap().len(), 13);
    assert_eq!(disk["nextId"], 14);
}

#[tokio::test]
async fn validates_json_ids_routes_methods_and_cors() {
    let dir = tempfile::tempdir().unwrap();
    let app = create_router(dir.path().join("data.json")).unwrap();
    assert_eq!(
        request(&app, "POST", "/test", Some(json!([1, 2]))).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(&app, "POST", "/test", None).await.0,
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    assert_eq!(
        request(&app, "GET", "/test/0", None).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(&app, "GET", "/test/not-a-number", None).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(&app, "GET", "/unknown", None).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(&app, "POST", "/test/1", Some(json!({}))).await.0,
        StatusCode::METHOD_NOT_ALLOWED
    );
    let response = app
        .oneshot(
            Request::builder()
                .method("OPTIONS")
                .uri("/test/1")
                .header("origin", "http://localhost:1420")
                .header("access-control-request-method", "DELETE")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(response.status().is_success());
    assert_eq!(response.headers()["access-control-allow-origin"], "*");
}

#[test]
fn refuses_to_overwrite_malformed_or_duplicate_saved_data() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("data.json");
    std::fs::write(&path, b"invalid original data").unwrap();
    assert!(create_router(path.clone()).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"invalid original data");
    let invalid = json!({"version":1,"nextId":2,"records":[{"id":1},{"id":1}]});
    std::fs::write(&path, serde_json::to_vec(&invalid).unwrap()).unwrap();
    assert!(create_router(path).is_err());
}

#[tokio::test]
async fn failed_disk_write_does_not_commit_memory_or_increment_id() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("data.json");
    let app = create_router(path.clone()).unwrap();
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert_eq!(
        request(&app, "POST", "/test", Some(json!({"name":"failed"})))
            .await
            .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(request(&app, "GET", "/test", None).await.1["total"], 1);
    std::fs::remove_dir(&path).unwrap();
    assert_eq!(
        request(&app, "POST", "/test", Some(json!({"name":"retry"})))
            .await
            .1["id"],
        2
    );
}
