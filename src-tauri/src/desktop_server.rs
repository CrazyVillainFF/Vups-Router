use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{header, HeaderName, HeaderValue, Method, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use reqwest::Client;
use std::time::Duration;
use tauri::AppHandle;

const API_ORIGIN: &str = "https://vups-router-be.onrender.com";
const MAX_PROXY_BODY: usize = 64 * 1024 * 1024;
const HTML_CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ipc: http://ipc.localhost https://api.github.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

#[derive(Clone)]
struct ServerState {
    app: AppHandle,
    client: Client,
}

pub fn start(app: AppHandle) -> Result<String, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("Could not start the local desktop server: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Could not prepare the local desktop server: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Could not read the local desktop server address: {error}"))?
        .port();

    let client = Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|error| format!("Could not prepare the desktop API connection: {error}"))?;

    let router = Router::new()
        .fallback(any(handle_request))
        .with_state(ServerState { app, client });

    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("VupsRouter desktop server could not start: {error}");
                return;
            }
        };
        if let Err(error) = axum::serve(listener, router).await {
            eprintln!("VupsRouter desktop server stopped: {error}");
        }
    });

    Ok(format!(
        "http://127.0.0.1:{port}/chat?native=windows"
    ))
}

async fn handle_request(
    State(state): State<ServerState>,
    request: Request<Body>,
) -> Response {
    if request.uri().path() == "/api" || request.uri().path().starts_with("/api/") {
        return proxy_api(State(state), request).await;
    }
    serve_asset(State(state), request).await
}

async fn serve_asset(State(state): State<ServerState>, request: Request<Body>) -> Response {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return (StatusCode::METHOD_NOT_ALLOWED, "Method not allowed").into_response();
    }

    let path = request.uri().path().trim_start_matches('/');
    let is_head = request.method() == Method::HEAD;
    let resolver = state.app.asset_resolver();
    let asset = if path.is_empty() {
        resolver.get("index.html".to_string())
    } else {
        resolver.get(path.to_string()).or_else(|| {
            if path.rsplit('/').next().is_some_and(|name| !name.contains('.')) {
                resolver.get("index.html".to_string())
            } else {
                None
            }
        })
    };

    let Some(asset) = asset else {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    };

    let content_type = asset.mime_type.clone();
    let is_html = content_type.starts_with("text/html");
    let body = if is_head {
        Body::empty()
    } else {
        Body::from(asset.bytes)
    };
    let mut response = Response::new(body);
    *response.status_mut() = StatusCode::OK;

    if let Ok(value) = HeaderValue::from_str(&content_type) {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    response.headers_mut().insert(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );

    let cache = if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else if is_html {
        "no-store"
    } else {
        "no-cache"
    };
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_str(cache).expect("static cache value is valid"),
    );

    if is_html {
        response.headers_mut().insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(HTML_CSP),
        );
    }

    response
}

async fn proxy_api(State(state): State<ServerState>, request: Request<Body>) -> Response {
    let path = request
        .uri()
        .path_and_query()
        .map(|value| value.as_str().to_string())
        .unwrap_or_else(|| "/api".to_string());
    let method = request.method().clone();
    let request_headers = request.headers().clone();
    let body = match to_bytes(request.into_body(), MAX_PROXY_BODY).await {
        Ok(body) => body,
        Err(_) => return api_error(StatusCode::PAYLOAD_TOO_LARGE, "The request is too large."),
    };

    let mut headers = request_headers;
    headers.remove(header::HOST);
    headers.remove(header::ORIGIN);
    headers.remove(header::REFERER);
    headers.remove(header::ACCEPT_ENCODING);
    headers.remove(header::CONTENT_LENGTH);
    headers.remove(header::CONNECTION);
    headers.remove(header::TRANSFER_ENCODING);
    headers.remove(header::UPGRADE);
    headers.remove("sec-fetch-site");
    headers.remove("sec-fetch-mode");
    headers.remove("sec-fetch-dest");
    headers.remove("sec-fetch-user");

    let upstream = state
        .client
        .request(method, format!("{API_ORIGIN}{path}"))
        .headers(headers)
        .body(body)
        .send()
        .await;

    let upstream = match upstream {
        Ok(response) => response,
        Err(_) => {
            return api_error(
                StatusCode::BAD_GATEWAY,
                "Could not reach the VupsRouter backend. Check your connection and try again.",
            )
        }
    };

    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    let content_type = upstream_headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/json");
    let is_sse = content_type.starts_with("text/event-stream");

    let mut builder = Response::builder().status(status);
    for name in [
        header::CONTENT_TYPE,
        header::CACHE_CONTROL,
        header::RETRY_AFTER,
        header::CONTENT_DISPOSITION,
    ] {
        if let Some(value) = upstream_headers.get(&name) {
            builder = builder.header(name, value);
        }
    }
    for name in ["x-request-id", "www-authenticate"] {
        if let Some(value) = upstream_headers.get(name) {
            builder = builder.header(name, value);
        }
    }
    for value in upstream_headers.get_all(header::SET_COOKIE) {
        if let Ok(value) = value.to_str() {
            if let Ok(value) = HeaderValue::from_str(&rewrite_cookie(value)) {
                builder = builder.header(header::SET_COOKIE, value);
            }
        }
    }
    if is_sse {
        builder = builder
            .header(header::CACHE_CONTROL, "no-cache, no-transform")
            .header("x-accel-buffering", "no");
    }

    builder
        .body(Body::from_stream(upstream.bytes_stream()))
        .unwrap_or_else(|_| api_error(StatusCode::BAD_GATEWAY, "The backend response could not be read."))
}

fn rewrite_cookie(value: &str) -> String {
    let mut parts = value.split(';').map(str::trim).filter(|part| !part.is_empty());
    let Some(name_and_value) = parts.next() else {
        return value.to_string();
    };
    let mut output = vec![name_and_value.to_string()];
    for part in parts {
        let lower = part.to_ascii_lowercase();
        if lower.starts_with("domain=")
            || lower == "secure"
            || lower.starts_with("partitioned")
            || lower.starts_with("samesite=")
        {
            continue;
        }
        output.push(part.to_string());
    }
    output.push("SameSite=Lax".to_string());
    output.join("; ")
}

fn api_error(status: StatusCode, message: &str) -> Response {
    (
        status,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        serde_json::json!({ "message": message }).to_string(),
    )
        .into_response()
}
