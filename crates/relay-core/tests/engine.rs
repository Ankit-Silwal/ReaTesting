use relay_core::{
    demo::DemoServer,
    http::{Auth, HttpEngine, Pair, RequestSpec},
    storage::WorkspaceStore,
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

fn request(url: String) -> RequestSpec {
    RequestSpec {
        id: "test".into(),
        method: "GET".into(),
        url,
        headers: vec![],
        params: vec![],
        body_mode: "none".into(),
        body: String::new(),
        auth: Auth {
            kind: "none".into(),
            token: String::new(),
            username: String::new(),
            password: String::new(),
        },
        timeout_ms: 5000,
        follow_redirects: true,
        verify_tls: true,
    }
}
fn pair(key: &str, value: &str, enabled: bool) -> Pair {
    Pair {
        key: key.into(),
        value: value.into(),
        enabled,
    }
}

#[tokio::test]
async fn sends_query_headers_json_and_bearer_auth() {
    let server = DemoServer::start().await.unwrap();
    let mut spec = request(format!("{}/echo?existing=yes", server.url));
    spec.method = "POST".into();
    spec.params = vec![
        pair("q", "hello & world", true),
        pair("ignored", "secret", false),
    ];
    spec.headers = vec![
        pair("X-Relay-Test", "works", true),
        pair("X-Disabled", "no", false),
    ];
    spec.body_mode = "json".into();
    spec.body = r#"{"name":"Ada","count":3}"#.into();
    spec.auth.kind = "bearer".into();
    spec.auth.token = "sample-token".into();
    let response = HttpEngine::default().send(spec).await.unwrap();
    assert_eq!(response.status, 200);
    let data: Value = serde_json::from_str(&response.body).unwrap();
    assert_eq!(data["method"], "POST");
    assert_eq!(data["args"]["q"], "hello & world");
    assert_eq!(data["args"]["existing"], "yes");
    assert!(data["args"].get("ignored").is_none());
    assert_eq!(data["headers"]["authorization"], "Bearer sample-token");
    assert_eq!(data["headers"]["x-relay-test"], "works");
    assert!(data["headers"].get("x-disabled").is_none());
    assert_eq!(data["json"]["name"], "Ada");
    assert!(!response.binary);
}

#[tokio::test]
async fn supports_basic_auth_http_errors_head_and_cookies() {
    let server = DemoServer::start().await.unwrap();
    let engine = HttpEngine::default();
    let mut spec = request(format!("{}/echo", server.url));
    spec.auth.kind = "basic".into();
    spec.auth.username = "user".into();
    spec.auth.password = "pass".into();
    let response = engine.send(spec).await.unwrap();
    let body: Value = serde_json::from_str(&response.body).unwrap();
    assert_eq!(body["headers"]["authorization"], "Basic dXNlcjpwYXNz");
    assert_eq!(
        engine
            .send(request(format!("{}/status/404", server.url)))
            .await
            .unwrap()
            .status,
        404
    );
    engine
        .send(request(format!("{}/cookie", server.url)))
        .await
        .unwrap();
    let body: Value = serde_json::from_str(
        &engine
            .send(request(format!("{}/echo", server.url)))
            .await
            .unwrap()
            .body,
    )
    .unwrap();
    assert!(
        body["headers"]["cookie"]
            .as_str()
            .unwrap()
            .contains("relay_session=demo")
    );
    let mut spec = request(format!("{}/health", server.url));
    spec.method = "HEAD".into();
    assert!(engine.send(spec).await.unwrap().body.is_empty());
}

#[tokio::test]
async fn respects_redirect_and_timeout_settings() {
    let server = DemoServer::start().await.unwrap();
    let engine = HttpEngine::default();
    let mut spec = request(format!("{}/redirect", server.url));
    spec.follow_redirects = false;
    assert_eq!(engine.send(spec.clone()).await.unwrap().status, 302);
    spec.follow_redirects = true;
    assert!(engine.send(spec).await.unwrap().url.ends_with("/health"));
    let mut spec = request(format!("{}/delay/2", server.url));
    spec.timeout_ms = 100;
    assert!(engine.send(spec).await.unwrap_err().contains("timed out"));
}

#[tokio::test]
async fn cancels_and_releases_running_identifiers() {
    let server = DemoServer::start().await.unwrap();
    let engine = Arc::new(HttpEngine::default());
    let spec = request(format!("{}/delay/2", server.url));
    let engine2 = engine.clone();
    let pending = tokio::spawn(async move { engine2.send(spec).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        engine
            .send(request(format!("{}/health", server.url)))
            .await
            .unwrap_err()
            .contains("already running")
    );
    assert!(engine.cancel("test"));
    assert_eq!(pending.await.unwrap().unwrap_err(), "Request cancelled.");
    assert_eq!(
        engine
            .send(request(format!("{}/health", server.url)))
            .await
            .unwrap()
            .status,
        200
    );
    assert!(!engine.cancel("missing"));
}

#[tokio::test]
async fn rejects_invalid_input_before_network_access() {
    let engine = HttpEngine::default();
    assert!(
        engine
            .send(request("file:///secret".into()))
            .await
            .unwrap_err()
            .contains("http://")
    );
    let mut spec = request("http://127.0.0.1:1".into());
    spec.body_mode = "json".into();
    spec.body = "{bad".into();
    assert!(
        engine
            .send(spec)
            .await
            .unwrap_err()
            .contains("Invalid JSON")
    );
    let mut spec = request("http://127.0.0.1:1".into());
    spec.headers.push(pair("bad\nname", "value", true));
    assert!(engine.send(spec).await.unwrap_err().contains("header name"));
}

#[test]
fn persists_workspace_atomically_and_preserves_invalid_files() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.json");
    let store = WorkspaceStore::new(path.clone());
    assert!(store.load().unwrap().is_none());
    let mut value =
        json!({"schemaVersion":1,"tabs":[],"collections":[],"history":[],"environments":[]});
    store.save(&value).unwrap();
    assert_eq!(store.load().unwrap(), Some(value.clone()));
    value["tabs"] = json!([{"name":"new"}]);
    store.save(&value).unwrap();
    assert_eq!(store.load().unwrap(), Some(value));
    std::fs::write(&path, b"invalid original bytes").unwrap();
    assert!(store.load().unwrap_err().contains("preserved"));
    assert_eq!(std::fs::read(&path).unwrap(), b"invalid original bytes");
    assert!(store.save(&json!({"schemaVersion":2})).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"invalid original bytes");
}
