use reqwest::{
    Client, Method, Url,
    cookie::Jar,
    header::{HeaderMap, HeaderName, HeaderValue},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

pub const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pair {
    pub key: String,
    pub value: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Auth {
    pub kind: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestSpec {
    pub id: String,
    pub method: String,
    pub url: String,
    pub headers: Vec<Pair>,
    pub params: Vec<Pair>,
    pub body_mode: String,
    pub body: String,
    pub auth: Auth,
    pub timeout_ms: u64,
    pub follow_redirects: bool,
    pub verify_tls: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseData {
    pub status: u16,
    pub status_text: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub size: usize,
    pub time_ms: u64,
    pub truncated: bool,
    pub binary: bool,
}

#[derive(Default)]
pub struct HttpEngine {
    active: Mutex<HashMap<String, CancellationToken>>,
    cookies: Arc<Jar>,
}

impl HttpEngine {
    pub async fn send(&self, spec: RequestSpec) -> Result<ResponseData, String> {
        if spec.id.is_empty() {
            return Err("A request identifier is required.".into());
        }
        let token = CancellationToken::new();
        {
            let mut active = self
                .active
                .lock()
                .map_err(|_| "Request manager unavailable.")?;
            if active.contains_key(&spec.id) {
                return Err("This request is already running.".into());
            }
            active.insert(spec.id.clone(), token.clone());
        }
        let outcome = tokio::select! {
            _ = token.cancelled() => Err("Request cancelled.".into()),
            result = self.execute(&spec) => result,
        };
        if let Ok(mut active) = self.active.lock() {
            active.remove(&spec.id);
        }
        outcome
    }

    pub fn cancel(&self, id: &str) -> bool {
        if let Ok(active) = self.active.lock() {
            if let Some(token) = active.get(id) {
                token.cancel();
                return true;
            }
        }
        false
    }

    async fn execute(&self, spec: &RequestSpec) -> Result<ResponseData, String> {
        let started = Instant::now();
        if !(100..=600_000).contains(&spec.timeout_ms) {
            return Err("Timeout must be between 100 and 600000 milliseconds.".into());
        }
        let mut url = Url::parse(spec.url.trim()).map_err(|e| format!("Invalid URL: {e}"))?;
        if !["http", "https"].contains(&url.scheme()) || url.host_str().is_none() {
            return Err("Use an absolute http:// or https:// URL.".into());
        }
        for param in spec
            .params
            .iter()
            .filter(|p| p.enabled && !p.key.is_empty())
        {
            url.query_pairs_mut().append_pair(&param.key, &param.value);
        }
        if !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
            .contains(&spec.method.as_str())
        {
            return Err("Unsupported HTTP method.".into());
        }
        let method = Method::from_bytes(spec.method.as_bytes()).map_err(|e| e.to_string())?;
        let client = Client::builder()
            .user_agent(concat!("Relay/", env!("CARGO_PKG_VERSION")))
            .cookie_provider(self.cookies.clone())
            .timeout(Duration::from_millis(spec.timeout_ms))
            .connect_timeout(Duration::from_secs(15))
            .redirect(if spec.follow_redirects {
                reqwest::redirect::Policy::limited(10)
            } else {
                reqwest::redirect::Policy::none()
            })
            .danger_accept_invalid_certs(!spec.verify_tls)
            .build()
            .map_err(|e| format!("Could not create HTTP client: {e}"))?;
        let mut headers = HeaderMap::new();
        for item in spec
            .headers
            .iter()
            .filter(|h| h.enabled && !h.key.is_empty())
        {
            let key = HeaderName::from_bytes(item.key.as_bytes())
                .map_err(|_| format!("Invalid header name: {}", item.key))?;
            let value = HeaderValue::from_str(&item.value)
                .map_err(|_| format!("Invalid value for header {}", item.key))?;
            headers.append(key, value);
        }
        let mut request = client.request(method, url).headers(headers);
        request = match spec.auth.kind.as_str() {
            "bearer" => request.bearer_auth(&spec.auth.token),
            "basic" => request.basic_auth(&spec.auth.username, Some(&spec.auth.password)),
            "none" => request,
            _ => return Err("Unsupported authentication type.".into()),
        };
        request = match spec.body_mode.as_str() {
            "json" => {
                serde_json::from_str::<serde_json::Value>(&spec.body)
                    .map_err(|e| format!("Invalid JSON body: {e}"))?;
                request
                    .header(reqwest::header::CONTENT_TYPE, "application/json")
                    .body(spec.body.clone())
            }
            "text" => request.body(spec.body.clone()),
            "none" => request,
            _ => return Err("Unsupported request body format.".into()),
        };
        let mut response = request.send().await.map_err(request_error)?;
        let status = response.status();
        let final_url = response.url().to_string();
        let headers: Vec<_> = response
            .headers()
            .iter()
            .map(|(k, v)| {
                (
                    k.to_string(),
                    String::from_utf8_lossy(v.as_bytes()).into_owned(),
                )
            })
            .collect();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_lowercase();
        let is_text = content_type.starts_with("text/")
            || ["json", "xml", "javascript", "form-urlencoded", "svg"]
                .iter()
                .any(|t| content_type.contains(t));
        let mut bytes = Vec::new();
        let mut truncated = false;
        while let Some(chunk) = response.chunk().await.map_err(request_error)? {
            let remaining = MAX_RESPONSE_BYTES.saturating_sub(bytes.len());
            if chunk.len() > remaining {
                bytes.extend_from_slice(&chunk[..remaining]);
                truncated = true;
                break;
            }
            bytes.extend_from_slice(&chunk);
        }
        let binary = !is_text && (bytes.contains(&0) || std::str::from_utf8(&bytes).is_err());
        let body = if binary {
            bytes
                .iter()
                .take(4096)
                .map(|b| format!("{b:02x} "))
                .collect::<String>()
        } else {
            String::from_utf8_lossy(&bytes).into_owned()
        };
        Ok(ResponseData {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or("").into(),
            url: final_url,
            headers,
            body,
            size: bytes.len(),
            time_ms: started.elapsed().as_millis() as u64,
            truncated,
            binary,
        })
    }
}

fn request_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "Request timed out. Check the server or increase the timeout in Settings.".into()
    } else if error.is_connect() {
        format!("Could not connect to the server. {}", error.without_url())
    } else {
        format!("HTTP request failed: {}", error.without_url())
    }
}
