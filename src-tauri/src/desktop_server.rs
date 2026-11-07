use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use reqwest::Client;
use std::time::Duration;
use tauri::AppHandle;

const API_ORIGIN: &str = "https://vups-router-be.onrender.com";
const MAX_PROXY_BODY: usize = 64 * 1024 * 1024;
const HTML_CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ipc: http://ipc.localhost https://api.github.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

// The window is served from a loopback origin, and a browser keeps one storage
// area per origin, port included. An OS-allocated port therefore threw the
// window's own state away on every launch: the pending browser handoff saved
// before a restart could not be resumed, so "close it and open it again" could
// never help a stuck sign-in. The range below is dedicated to VupsRouter and is
// tried in order, so a restart lands on the same origin whenever it is free.
const DESKTOP_PORT_FIRST: u16 = 47821;
const DESKTOP_PORT_COUNT: u16 = 8;

#[derive(Clone)]
struct ServerState {
    app: AppHandle,
    client: Client,
    origin: String,
    environment: &'static str,
    host_authority: String,
    page_origin: String,
}

// A debug build can be aimed at a local backend so an acceptance run exercises
// real persistence without touching deployed data. A packaged app always uses
// the released backend, and even a debug build only accepts a loopback origin,
// so this hook cannot quietly redirect the app to some other server.
pub(crate) fn debug_api_origin(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_end_matches('/').to_string();
    if trimmed.starts_with("http://127.0.0.1:") || trimmed.starts_with("http://localhost:") {
        return Some(trimmed);
    }
    None
}

// Which backend the window is really talking to. A released build always says
// "production"; anything else means this window is a development or QA shell
// and its accounts are not the accounts on the website.
pub(crate) fn api_environment(origin: &str) -> &'static str {
    let origin = origin.trim_end_matches('/');
    if origin == API_ORIGIN {
        return "production";
    }
    if origin.starts_with("http://127.0.0.1:") || origin.starts_with("http://localhost:") {
        return "local";
    }
    "external"
}

fn api_origin() -> String {
    if cfg!(debug_assertions) {
        if let Ok(value) = std::env::var("VUPS_DESKTOP_API_ORIGIN") {
            if let Some(origin) = debug_api_origin(&value) {
                return origin;
            }
            eprintln!(
                "Ignoring VUPS_DESKTOP_API_ORIGIN: a debug build only accepts a loopback http origin. \
                 Using {API_ORIGIN}."
            );
        }
    }
    API_ORIGIN.to_string()
}

pub(crate) fn preferred_ports() -> Vec<u16> {
    (0..DESKTOP_PORT_COUNT).map(|offset| DESKTOP_PORT_FIRST + offset).collect()
}

// A successful bind is the ownership proof: nothing is ever attached to or
// reused from a port that is already answering, so a second window can never be
// handed to another process's server. If the whole range is busy the app still
// launches on an OS-allocated port, which costs only the stable origin.
fn bind_listener() -> Result<std::net::TcpListener, String> {
    for port in preferred_ports() {
        if let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", port)) {
            return Ok(listener);
        }
    }
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("Could not start the local desktop server: {error}"))
}

// The port is now guessable, so the server may not rely on being hard to find.
// Two rules hold for every request, on every route:
//
// * The Host must be exactly the address this listener serves. A page reached by
//   DNS rebinding (an attacker hostname that resolves to loopback) would present
//   itself as same-origin, and this is what stops it from reading the app's
//   session cookie through the proxy.
// * Anything that is not a safe read must come from this window's own origin.
//   A foreign page can aim a form or a fetch at the loopback address, but its
//   Origin never matches, so it cannot spend the signed-in session. A client
//   that omits Origin on a write gets the same refusal: the window always sends
//   it, so absence means the request did not come from the window.
pub(crate) fn guard_headers(
    host_authority: &str,
    page_origin: &str,
    headers: &HeaderMap,
    method: &Method,
) -> Option<StatusCode> {
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if host != host_authority {
        return Some(StatusCode::FORBIDDEN);
    }
    if method != Method::GET && method != Method::HEAD {
        let origin = headers
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        if origin != page_origin {
            return Some(StatusCode::FORBIDDEN);
        }
    }
    None
}

pub fn start(app: AppHandle) -> Result<String, String> {
    let listener = bind_listener()?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Could not prepare the local desktop server: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Could not read the local desktop server address: {error}"))?
        .port();
    let host_authority = format!("127.0.0.1:{port}");
    let page_origin = format!("http://127.0.0.1:{port}");

    let client = Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|error| format!("Could not prepare the desktop API connection: {error}"))?;

    let upstream = api_origin();
    let environment = api_environment(&upstream);
    // One line per launch that names the backend this window will use, so a QA
    // shell is never mistaken for the released app. Nothing secret: an origin
    // and a label.
    println!(
        "VupsRouter window {} → backend {} ({})",
        page_origin, upstream, environment
    );
    let router = Router::new()
        .fallback(any(handle_request))
        .with_state(ServerState {
            app,
            client,
            origin: upstream,
            environment,
            host_authority: host_authority.clone(),
            page_origin: page_origin.clone(),
        });

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

    Ok(format!("{page_origin}/chat?native=windows"))
}

async fn handle_request(State(state): State<ServerState>, request: Request<Body>) -> Response {
    if let Some(status) = guard_headers(
        &state.host_authority,
        &state.page_origin,
        request.headers(),
        request.method(),
    ) {
        return api_error(
            status,
            "The local VupsRouter server only answers its own window.",
        );
    }
    if request.uri().path() == "/__desktop/runtime" {
        return Json(serde_json::json!({
            "apiOrigin": state.origin,
            "apiEnvironment": state.environment,
            "debugBuild": cfg!(debug_assertions),
            "pageOrigin": state.page_origin
        }))
        .into_response();
    }
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
            if path
                .rsplit('/')
                .next()
                .is_some_and(|name| !name.contains('.'))
            {
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
        .request(method, format!("{}{}", state.origin, path))
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
        .unwrap_or_else(|_| {
            api_error(
                StatusCode::BAD_GATEWAY,
                "The backend response could not be read.",
            )
        })
}

fn rewrite_cookie(value: &str) -> String {
    let mut parts = value
        .split(';')
        .map(str::trim)
        .filter(|part| !part.is_empty());
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

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = "127.0.0.1:47821";
    const PAGE: &str = "http://127.0.0.1:47821";

    fn headers(host: &str, origin: Option<&str>) -> HeaderMap {
        let mut map = HeaderMap::new();
        map.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        if let Some(value) = origin {
            map.insert(header::ORIGIN, HeaderValue::from_str(value).unwrap());
        }
        map
    }

    fn deny(map: &HeaderMap, method: &Method) -> Option<StatusCode> {
        guard_headers(HOST, PAGE, map, method)
    }

    #[test]
    fn the_port_range_is_dedicated_and_tried_in_order() {
        let ports = preferred_ports();
        assert_eq!(ports.first().copied(), Some(DESKTOP_PORT_FIRST));
        assert_eq!(ports.len(), DESKTOP_PORT_COUNT as usize);
        let unique: std::collections::HashSet<u16> = ports.iter().copied().collect();
        assert_eq!(unique.len(), ports.len(), "each candidate is a different origin");
        // 4190 is the loopback QA backend port. If the shell ever preferred it,
        // the desktop server would race the backend it is meant to proxy.
        assert!(!ports.contains(&4190), "the desktop server must not sit on the QA backend port");
    }

    #[test]
    fn only_the_address_this_listener_serves_is_accepted() {
        assert_eq!(deny(&headers(HOST, None), &Method::GET), None);
        assert_eq!(deny(&headers("localhost:47821", None), &Method::GET), Some(StatusCode::FORBIDDEN));
        // DNS rebinding: a hostname that resolves to loopback is a different
        // origin from the window, so its page must not read the session cookie.
        assert_eq!(deny(&headers("vupsrouter.test:47821", None), &Method::GET), Some(StatusCode::FORBIDDEN));
        assert_eq!(deny(&headers("", None), &Method::GET), Some(StatusCode::FORBIDDEN));
    }

    #[test]
    fn a_write_from_another_page_never_reaches_the_proxy() {
        assert_eq!(deny(&headers(HOST, Some(PAGE)), &Method::POST), None);
        assert_eq!(
            deny(&headers(HOST, Some("http://127.0.0.1:9999")), &Method::POST),
            Some(StatusCode::FORBIDDEN),
            "another local app is a different origin and cannot spend this session"
        );
        assert_eq!(
            deny(&headers(HOST, Some("https://evil.example")), &Method::POST),
            Some(StatusCode::FORBIDDEN),
            "a form post from the open web is refused"
        );
        assert_eq!(
            deny(&headers(HOST, None), &Method::POST),
            Some(StatusCode::FORBIDDEN),
            "the window always sends Origin on a write, so its absence means it is not the window"
        );
    }

    #[test]
    fn safe_reads_stay_readable_for_the_window() {
        // Top-level navigation and same-origin GETs (the session probe and the
        // streamed chat responses) arrive without Origin, and must still work.
        assert_eq!(deny(&headers(HOST, None), &Method::HEAD), None);
        assert_eq!(
            deny(&headers(HOST, Some(PAGE)), &Method::GET),
            None,
            "an origin on a read is welcome, matching or not is decided by Host alone"
        );
    }

    #[test]
    fn the_active_backend_is_named_by_environment_not_guessed() {
        assert_eq!(api_environment(API_ORIGIN), "production");
        assert_eq!(api_environment("https://vups-router-be.onrender.com/"), "production");
        assert_eq!(
            api_environment("http://127.0.0.1:4190"),
            "local",
            "a debug shell aimed at the QA backend must be labelled local"
        );
        assert_eq!(api_environment("http://localhost:4000"), "local");
        assert_eq!(api_environment("https://someone-elses-host.example"), "external");
        // A released build cannot even produce "local": the override is compiled
        // out, so the label it reports is the label it has.
        assert_eq!(api_environment(&API_ORIGIN.to_string()), "production");
    }

    #[test]
    fn a_debug_override_cannot_point_the_shell_at_the_open_internet() {
        assert_eq!(
            debug_api_origin("http://127.0.0.1:4190/").as_deref(),
            Some("http://127.0.0.1:4190")
        );
        assert_eq!(debug_api_origin("  http://localhost:4190  ").as_deref(), Some("http://localhost:4190"));
        for rejected in [
            "https://attacker.example",
            "http://169.254.169.254",
            "http://10.0.0.5:4190",
            "javascript:alert(1)",
            "",
        ] {
            assert_eq!(debug_api_origin(rejected), None, "{rejected} is not a loopback origin");
        }
    }
}
