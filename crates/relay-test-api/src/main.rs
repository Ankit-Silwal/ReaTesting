use std::path::PathBuf;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut port = 3000_u16;
    let mut file = PathBuf::from("data/test-api.json");
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => {
                port = args.next().ok_or("--port requires a number")?.parse()?;
                if port == 0 {
                    return Err("Use a port from 1 to 65535.".into());
                }
            }
            "--file" => file = PathBuf::from(args.next().ok_or("--file requires a path")?),
            "--help" | "-h" => {
                println!("relay-test-api [--port 3000] [--file data/test-api.json]");
                return Ok(());
            }
            _ => return Err(format!("Unknown argument: {arg}. Use --help.").into()),
        }
    }
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .map_err(|e| {
            format!("Cannot start on localhost:{port}: {e}. Another server may already be running.")
        })?;
    let router = relay_test_api::create_router(file.clone()).map_err(std::io::Error::other)?;
    let full_path = std::env::current_dir()?.join(&file);
    println!("\nRelay Rust test API is running at http://localhost:{port}");
    println!("Data file: {}", full_path.display());
    println!(
        "\nGET    /test       list all records\nGET    /test/1     read a record\nPOST   /test       create a record (automatic ID)\nPUT    /test/1     replace a record\nPATCH  /test/1     update fields\nDELETE /test/1     delete a record\n\nJSON body example: {{\"name\":\"Hello\",\"message\":\"Testing Relay\"}}\nPress Ctrl+C to stop.\n"
    );
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
