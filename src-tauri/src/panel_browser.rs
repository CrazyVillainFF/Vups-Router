use serde::Deserialize;
use std::{
    collections::HashMap,
    io::Read,
    process::{Command, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{
    webview::WebviewBuilder, AppHandle, LogicalPosition, LogicalSize, Manager, State, Webview,
    WebviewUrl,
};

const MAX_TABS: usize = 8;
const MAX_URL_CHARS: usize = 2048;
const MAX_SCRIPT_RESULT_CHARS: usize = 200_000;
const SCREENSHOT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Default)]
pub struct BrowserState {
    tabs: Mutex<HashMap<String, Webview>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeInput {
    selector: String,
    text: String,
    submit: bool,
}

fn tab_label(tab_id: &str) -> Result<String, String> {
    let trimmed = tab_id.trim();
    if trimmed.is_empty()
        || trimmed.len() > 64
        || !trimmed
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("That browser tab id is not valid.".into());
    }
    Ok(format!("panel-browser-{trimmed}"))
}

fn normalize_url(raw: &str) -> Result<WebviewUrl, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Enter a page address.".into());
    }
    if trimmed.len() > MAX_URL_CHARS {
        return Err("That address is too long.".into());
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let url = tauri::Url::parse(&candidate)
        .map_err(|_| "That page address is not a valid URL.".to_string())?;
    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("The panel browser only opens http and https addresses.".into());
    }
    Ok(WebviewUrl::External(url))
}

fn bounds_geometry(bounds: &BrowserBounds) -> Result<(LogicalPosition<f64>, LogicalSize<f64>), String> {
    let width = bounds.width.clamp(1.0, 8000.0);
    let height = bounds.height.clamp(1.0, 8000.0);
    let x = bounds.x.clamp(-20000.0, 20000.0);
    let y = bounds.y.clamp(-20000.0, 20000.0);
    Ok((LogicalPosition::new(x, y), LogicalSize::new(width, height)))
}

fn with_tab<T>(
    state: &State<'_, BrowserState>,
    tab_id: &str,
    work: impl FnOnce(&Webview) -> Result<T, String>,
) -> Result<T, String> {
    let label = tab_label(tab_id)?;
    let guard = state
        .tabs
        .lock()
        .map_err(|_| "The panel browser is unavailable.".to_string())?;
    let webview = guard
        .get(&label)
        .ok_or_else(|| "That browser tab is not open.".to_string())?;
    work(webview)
}

fn decode_eval_string(raw: &str) -> String {
    serde_json::from_str::<String>(raw).unwrap_or_else(|_| raw.to_string())
}

async fn eval_json(webview: Webview, script: String) -> Result<String, String> {
    let (tx, rx) = mpsc::channel::<String>();
    webview
        .eval_with_callback(script, move |result| {
            let _ = tx.send(result);
        })
        .map_err(|_| "The page could not be inspected.".to_string())?;
    let received = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(6)))
        .await
        .map_err(|_| "The page did not answer.".to_string())?;
    let raw = received.map_err(|_| "The page did not answer in time.".to_string())?;
    let decoded = decode_eval_string(&raw);
    if decoded.len() > MAX_SCRIPT_RESULT_CHARS {
        return Err("The page returned more data than the panel can display.".into());
    }
    Ok(decoded)
}

fn script_result(body: &str) -> String {
    format!(
        "(() => {{ try {{ const value = (() => {{ {body} }})(); return JSON.stringify({{ ok: true, value }}); }} catch (error) {{ return JSON.stringify({{ ok: false, error: String(error && error.message || error) }}); }} }})()"
    )
}

fn unwrap_script_result(decoded: &str) -> Result<serde_json::Value, String> {
    let envelope: serde_json::Value = serde_json::from_str(decoded)
        .map_err(|_| "The page returned an unreadable answer.".to_string())?;
    if envelope.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        let message = envelope
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("The page script failed.");
        return Err(message.to_string());
    }
    Ok(envelope
        .get("value")
        .cloned()
        .unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
pub async fn panel_browser_create(
    app: AppHandle,
    state: State<'_, BrowserState>,
    tab_id: String,
    url: String,
    bounds: BrowserBounds,
) -> Result<(), String> {
    let label = tab_label(&tab_id)?;
    let target = normalize_url(&url)?;
    {
        let guard = state
            .tabs
            .lock()
            .map_err(|_| "The panel browser is unavailable.".to_string())?;
        if guard.contains_key(&label) {
            return Err("That browser tab already exists.".into());
        }
        if guard.len() >= MAX_TABS {
            return Err(format!("The panel supports at most {MAX_TABS} browser tabs."));
        }
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| "The app window is unavailable.".to_string())?;
    let (position, size) = bounds_geometry(&bounds)?;
    let builder = WebviewBuilder::new(label.clone(), target);
    let webview = window
        .add_child(builder, position, size)
        .map_err(|error| format!("Windows could not open the panel browser: {error}"))?;
    if !bounds.visible {
        let _ = webview.hide();
    }
    let mut guard = state
        .tabs
        .lock()
        .map_err(|_| "The panel browser is unavailable.".to_string())?;
    guard.insert(label, webview);
    Ok(())
}

#[tauri::command]
pub async fn panel_browser_set_bounds(
    state: State<'_, BrowserState>,
    tab_id: String,
    bounds: BrowserBounds,
) -> Result<(), String> {
    let (position, size) = bounds_geometry(&bounds)?;
    with_tab(&state, &tab_id, |webview| {
        webview
            .set_size(size)
            .map_err(|_| "The panel browser could not be sized.".to_string())?;
        webview
            .set_position(position)
            .map_err(|_| "The panel browser could not be positioned.".to_string())?;
        if bounds.visible {
            webview
                .show()
                .map_err(|_| "The panel browser could not be shown.".to_string())?;
        } else {
            let _ = webview.hide();
        }
        Ok(())
    })
}

#[tauri::command]
pub async fn panel_browser_navigate(
    state: State<'_, BrowserState>,
    tab_id: String,
    url: String,
) -> Result<(), String> {
    let target = normalize_url(&url)?;
    let WebviewUrl::External(target) = target else {
        return Err("That page address is not supported.".into());
    };
    with_tab(&state, &tab_id, |webview| {
        webview
            .navigate(target)
            .map_err(|_| "The panel browser could not open that page.".to_string())
    })
}

#[tauri::command]
pub async fn panel_browser_back(
    state: State<'_, BrowserState>,
    tab_id: String,
) -> Result<(), String> {
    with_tab(&state, &tab_id, |webview| {
        webview
            .eval(script_result("history.back(); return true;"))
            .map_err(|_| "The page could not go back.".to_string())
    })
}

#[tauri::command]
pub async fn panel_browser_forward(
    state: State<'_, BrowserState>,
    tab_id: String,
) -> Result<(), String> {
    with_tab(&state, &tab_id, |webview| {
        webview
            .eval(script_result("history.forward(); return true;"))
            .map_err(|_| "The page could not go forward.".to_string())
    })
}

#[tauri::command]
pub async fn panel_browser_reload(
    state: State<'_, BrowserState>,
    tab_id: String,
) -> Result<(), String> {
    with_tab(&state, &tab_id, |webview| {
        webview
            .eval(script_result("location.reload(); return true;"))
            .map_err(|_| "The page could not reload.".to_string())
    })
}

#[tauri::command]
pub async fn panel_browser_status(
    state: State<'_, BrowserState>,
    tab_id: String,
) -> Result<serde_json::Value, String> {
    let webview = with_tab(&state, &tab_id, |webview| Ok(webview.clone()))?;
    let script = script_result(
        "return { url: location.href, title: document.title, readyState: document.readyState, canGoBack: history.length > 1 };",
    );
    let decoded = eval_json(webview, script).await?;
    unwrap_script_result(&decoded)
}

#[tauri::command]
pub async fn panel_browser_inspect(
    state: State<'_, BrowserState>,
    tab_id: String,
) -> Result<serde_json::Value, String> {
    let webview = with_tab(&state, &tab_id, |webview| Ok(webview.clone()))?;
    let script = script_result(
        r#"
        const clip = (value, limit) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
        const seen = new Set();
        const links = [];
        for (const anchor of Array.from(document.querySelectorAll("a[href]")).slice(0, 200)) {
          const href = anchor.href || "";
          if (!href || seen.has(href)) continue;
          seen.add(href);
          links.push({ text: clip(anchor.innerText, 80), href: clip(href, 300) });
          if (links.length >= 40) break;
        }
        const controls = Array.from(document.querySelectorAll("button, input, select, textarea, [role=button]"))
          .slice(0, 60)
          .map(node => ({
            tag: node.tagName.toLowerCase(),
            type: clip(node.getAttribute("type"), 30),
            name: clip(node.getAttribute("name") || node.getAttribute("aria-label") || node.getAttribute("placeholder"), 80),
            text: clip(node.innerText || node.value, 80),
            disabled: Boolean(node.disabled)
          }));
        const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
          .slice(0, 40)
          .map(node => ({ level: Number(node.tagName.slice(1)) || 0, text: clip(node.innerText, 160) }));
        return {
          url: location.href,
          title: document.title,
          text: clip(document.body ? document.body.innerText : "", 4000),
          headings,
          links,
          controls
        };
        "#,
    );
    let decoded = eval_json(webview, script).await?;
    unwrap_script_result(&decoded)
}

#[tauri::command]
pub async fn panel_browser_click(
    state: State<'_, BrowserState>,
    tab_id: String,
    selector: String,
) -> Result<serde_json::Value, String> {
    let webview = with_tab(&state, &tab_id, |webview| Ok(webview.clone()))?;
    let selector = serde_json::to_string(selector.trim())
        .map_err(|_| "That selector is not valid.".to_string())?;
    let script = script_result(&format!(
        r#"
        const node = document.querySelector({selector});
        if (!node) throw new Error("No element matches that selector.");
        node.scrollIntoView({{ block: "center", inline: "center" }});
        node.focus({{ preventScroll: true }});
        node.click();
        return {{ clicked: true, tag: node.tagName.toLowerCase(), text: (node.innerText || node.value || "").trim().slice(0, 120) }};
        "#
    ));
    let decoded = eval_json(webview, script).await?;
    unwrap_script_result(&decoded)
}

#[tauri::command]
pub async fn panel_browser_type(
    state: State<'_, BrowserState>,
    tab_id: String,
    input: TypeInput,
) -> Result<serde_json::Value, String> {
    let webview = with_tab(&state, &tab_id, |webview| Ok(webview.clone()))?;
    let selector = serde_json::to_string(input.selector.trim())
        .map_err(|_| "That selector is not valid.".to_string())?;
    let text = serde_json::to_string(&input.text)
        .map_err(|_| "That text is not valid.".to_string())?;
    let submit = if input.submit { "true" } else { "false" };
    let script = script_result(&format!(
        r#"
        const node = document.querySelector({selector});
        if (!node) throw new Error("No element matches that selector.");
        node.focus({{ preventScroll: true }});
        const text = {text};
        const prototype = node instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : node instanceof HTMLInputElement
            ? HTMLInputElement.prototype
            : null;
        const setter = prototype ? Object.getOwnPropertyDescriptor(prototype, "value")?.set : null;
        if (setter) setter.call(node, text);
        else node.textContent = text;
        node.dispatchEvent(new Event("input", {{ bubbles: true }}));
        node.dispatchEvent(new Event("change", {{ bubbles: true }}));
        if ({submit}) {{
          node.dispatchEvent(new KeyboardEvent("keydown", {{ key: "Enter", code: "Enter", bubbles: true }}));
          if (node.form && typeof node.form.requestSubmit === "function") node.form.requestSubmit();
        }}
        return {{ typed: true, length: text.length, submitted: {submit} }};
        "#
    ));
    let decoded = eval_json(webview, script).await?;
    unwrap_script_result(&decoded)
}

#[tauri::command]
pub async fn panel_browser_scroll(
    state: State<'_, BrowserState>,
    tab_id: String,
    selector: String,
    delta_y: f64,
) -> Result<serde_json::Value, String> {
    let webview = with_tab(&state, &tab_id, |webview| Ok(webview.clone()))?;
    let selector = serde_json::to_string(selector.trim())
        .map_err(|_| "That selector is not valid.".to_string())?;
    let delta = delta_y.clamp(-20000.0, 20000.0);
    let script = script_result(&format!(
        r#"
        const selector = {selector};
        if (selector) {{
          const node = document.querySelector(selector);
          if (!node) throw new Error("No element matches that selector.");
          node.scrollIntoView({{ block: "center", inline: "nearest" }});
        }} else {{
          window.scrollBy({{ top: {delta}, behavior: "smooth" }});
        }}
        return {{ scrolled: true, y: window.scrollY }};
        "#
    ));
    let decoded = eval_json(webview, script).await?;
    unwrap_script_result(&decoded)
}

fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

fn capture_region_png(x: i32, y: i32, width: u32, height: u32) -> Result<String, String> {
    if width == 0 || height == 0 || width > 6000 || height > 6000 {
        return Err("That screenshot size is not supported.".into());
    }
    let script = format!(
        r#"$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap({width},{height})
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen({x},{y},0,0,$bitmap.Size)
$stream = New-Object System.IO.MemoryStream
$bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
[Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))
$graphics.Dispose()
$bitmap.Dispose()
$stream.Dispose()
"#
    );
    let mut command = Command::new("powershell.exe");
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    let mut child = command
        .spawn()
        .map_err(|_| "Windows could not capture the page.".to_string())?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut stream) = stdout {
            let _ = stream.read_to_end(&mut bytes);
        }
        bytes
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut stream) = stderr {
            let _ = stream.read_to_end(&mut bytes);
        }
        bytes
    });
    let deadline = Instant::now() + SCREENSHOT_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err("Capturing the page took too long. Try again.".into());
            }
        }
    };
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr);
        let detail = detail.trim();
        return Err(if detail.is_empty() {
            "Windows could not capture the page.".into()
        } else {
            format!("Windows could not capture the page: {detail}")
        });
    }
    let encoded = String::from_utf8_lossy(&stdout).trim().to_string();
    if encoded.is_empty() {
        return Err("Windows returned an empty screenshot.".into());
    }
    Ok(format!("data:image/png;base64,{encoded}"))
}

#[tauri::command]
pub async fn panel_browser_screenshot(
    app: AppHandle,
    state: State<'_, BrowserState>,
    tab_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<String, String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "The app window is unavailable.".to_string())?;
    let origin = window
        .inner_position()
        .map_err(|_| "The app window position is unavailable.".to_string())?;
    let scale = window
        .scale_factor()
        .map_err(|_| "The display scale is unavailable.".to_string())?;
    let _ = with_tab(&state, &tab_id, |_| Ok(()))?;
    let physical_x = origin.x + (x * scale).round() as i32;
    let physical_y = origin.y + (y * scale).round() as i32;
    let physical_width = (width * scale).round().clamp(1.0, 6000.0) as u32;
    let physical_height = (height * scale).round().clamp(1.0, 6000.0) as u32;
    tauri::async_runtime::spawn_blocking(move || {
        capture_region_png(physical_x, physical_y, physical_width, physical_height)
    })
    .await
    .map_err(|_| "Windows could not capture the page.".to_string())?
}

#[tauri::command]
pub async fn panel_browser_close(
    state: State<'_, BrowserState>,
    tab_id: String,
) -> Result<(), String> {
    let label = tab_label(&tab_id)?;
    let webview = {
        let mut guard = state
            .tabs
            .lock()
            .map_err(|_| "The panel browser is unavailable.".to_string())?;
        guard.remove(&label)
    };
    let Some(webview) = webview else {
        return Ok(());
    };
    webview
        .close()
        .map_err(|_| "That browser tab could not be closed.".to_string())
}

#[tauri::command]
pub async fn panel_browser_close_all(state: State<'_, BrowserState>) -> Result<(), String> {
    let tabs = {
        let mut guard = state
            .tabs
            .lock()
            .map_err(|_| "The panel browser is unavailable.".to_string())?;
        guard.drain().map(|(_, webview)| webview).collect::<Vec<_>>()
    };
    for webview in tabs {
        let _ = webview.close();
    }
    Ok(())
}

#[cfg(test)]
pub fn normalize_url_for_test(raw: &str) -> Result<String, String> {
    match normalize_url(raw)? {
        WebviewUrl::External(url) => Ok(url.to_string()),
        _ => Err("That page address is not supported.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panel_browser_only_accepts_web_addresses() {
        assert_eq!(
            normalize_url_for_test("example.com").unwrap(),
            "https://example.com/"
        );
        assert_eq!(
            normalize_url_for_test("http://127.0.0.1:3000/app").unwrap(),
            "http://127.0.0.1:3000/app"
        );
        assert!(normalize_url_for_test("javascript:alert(1)").is_err());
        assert!(normalize_url_for_test("file:///C:/Windows/win.ini").is_err());
        assert!(normalize_url_for_test("data:text/html,hi").is_err());
        assert!(normalize_url_for_test("   ").is_err());
    }

    #[test]
    fn browser_script_results_are_unwrapped_or_reported() {
        assert_eq!(
            unwrap_script_result(r#"{"ok":true,"value":{"title":"Example"}}"#).unwrap()["title"],
            "Example"
        );
        let error = unwrap_script_result(r#"{"ok":false,"error":"No element matches that selector."}"#)
            .unwrap_err();
        assert_eq!(error, "No element matches that selector.");
        assert!(unwrap_script_result("not json").is_err());
    }

    #[test]
    fn tab_labels_are_bounded_to_safe_identifiers() {
        assert_eq!(tab_label("tab-1").unwrap(), "panel-browser-tab-1");
        assert!(tab_label("../owned").is_err());
        assert!(tab_label("").is_err());
        assert!(tab_label(&"a".repeat(65)).is_err());
    }
}
