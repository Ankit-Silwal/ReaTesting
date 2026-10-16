use std::{collections::BTreeMap, sync::Arc};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use tokio_util::sync::CancellationToken;

pub struct DemoServer {
    pub url: String,
    shutdown: CancellationToken,
}

impl DemoServer {
    pub async fn start() -> Result<Arc<Self>, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| e.to_string())?;
        let url = format!(
            "http://{}",
            listener.local_addr().map_err(|e| e.to_string())?
        );
        let shutdown = CancellationToken::new();
        let stop = shutdown.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = stop.cancelled() => break,
                    result = listener.accept() => match result {
                        Ok((stream, _)) => { tokio::spawn(serve(stream)); },
                        Err(_) => break,
                    }
                }
            }
        });
        Ok(Arc::new(Self { url, shutdown }))
    }
}

impl Drop for DemoServer {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

async fn serve(mut stream: TcpStream) {
    let _ = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let mut buffer = Vec::new();
        let header_end;
        loop {
            let mut chunk = [0; 4096];
            let size = stream.read(&mut chunk).await?;
            if size == 0 || buffer.len() > 1024 * 1024 { return Ok::<_, std::io::Error>(()); }
            buffer.extend_from_slice(&chunk[..size]);
            if let Some(index) = buffer.windows(4).position(|b| b == b"\r\n\r\n") { header_end = index + 4; break; }
        }
        let header_text = String::from_utf8_lossy(&buffer[..header_end]).to_string();
        let mut lines = header_text.lines();
        let mut request_line = lines.next().unwrap_or("").split_whitespace();
        let method = request_line.next().unwrap_or("GET");
        let target = request_line.next().unwrap_or("/");
        let headers: BTreeMap<String, String> = lines.filter_map(|line| line.split_once(':').map(|(k,v)| (k.to_lowercase(),v.trim().to_string()))).collect();
        let length = headers.get("content-length").and_then(|n| n.parse::<usize>().ok()).unwrap_or(0);
        if length > 1024 * 1024 { return Ok(()); }
        while buffer.len() - header_end < length {
            let mut chunk = [0; 4096];
            let size = stream.read(&mut chunk).await?;
            if size == 0 { break; }
            buffer.extend_from_slice(&chunk[..size]);
        }
        let parsed = reqwest::Url::parse(&format!("http://localhost{target}")).unwrap();
        let path = parsed.path();
        if let Some(delay) = path.strip_prefix("/delay/").and_then(|v| v.parse::<u64>().ok()) {
            tokio::time::sleep(std::time::Duration::from_secs(delay.min(5))).await;
        }
        let status = path.strip_prefix("/status/").and_then(|n| n.parse::<u16>().ok()).filter(|n| (200..=599).contains(n)).unwrap_or(200);
        let query: BTreeMap<_,_> = parsed.query_pairs().map(|(k,v)| (k.into_owned(),v.into_owned())).collect();
        let body = String::from_utf8_lossy(&buffer[header_end..]);
        let data = if path == "/health" { serde_json::json!({"status":"ok","service":"Relay demo API"}) }
        else if path == "/users" { serde_json::json!({"users":[{"id":1,"name":"Alex Morgan","email":"alex@example.com","role":"developer"},{"id":2,"name":"Sam Rivera","email":"sam@example.com","role":"designer"}],"total":2,"page":query.get("page").map(String::as_str).unwrap_or("1")}) }
        else { serde_json::json!({"method":method,"path":path,"args":query,"headers":headers,"json":serde_json::from_str::<serde_json::Value>(&body).ok(),"body":body,"message":"Hello from your local Relay API"}) };
        let body = serde_json::to_vec_pretty(&data).unwrap();
        let reason = reqwest::StatusCode::from_u16(status).ok().and_then(|s| s.canonical_reason()).unwrap_or("Response");
        let extra = if path == "/redirect" { "Location: /health\r\n" } else if path == "/cookie" { "Set-Cookie: relay_session=demo; Path=/; HttpOnly\r\n" } else { "" };
        let (status, reason) = if path == "/redirect" { (302, "Found") } else { (status, reason) };
        let head = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nX-Powered-By: Relay\r\n{extra}Connection: close\r\n\r\n",body.len());
        stream.write_all(head.as_bytes()).await?;
        if method != "HEAD" { stream.write_all(&body).await?; }
        stream.shutdown().await
    }).await;
}
