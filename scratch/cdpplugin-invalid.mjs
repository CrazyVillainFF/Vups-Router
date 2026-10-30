// Attempts to connect an uninstalled key-only plugin with a deliberately invalid
// key and reports exactly what the dialog says. The server tests before saving,
// so nothing should be installed afterwards.
const CDP_PORT = process.env.CDP_PORT || "9224";
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = targets.find(t => t.type === "page" && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params) => new Promise((resolve, reject) => {
  const msgId = ++id;
  pending.set(msgId, { resolve, reject });
  ws.send(JSON.stringify({ id: msgId, method, params }));
});
ws.addEventListener("message", event => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});
const EXPR = String.raw`(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const text = el => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
  const wait = async (fn, label, ms = 60000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(120); }
    throw new Error("timeout: " + label);
  };
  const cards = await wait(() => document.querySelectorAll(".vr-plugin-card").length ? [...document.querySelectorAll(".vr-plugin-card")] : null, "cards");
  const card = cards.find(c => text(c.querySelector(".vr-plugin-card-head .vr-status-pill")) === "Needs setup" && !c.hasAttribute("data-installed"));
  if (!card) return JSON.stringify({ skipped: "no uninstalled key plugin on screen" }, null, 2);
  const name = text(card.querySelector("h2"));
  const out = { name };
  const connectButton = [...card.querySelectorAll("button")].find(b => text(b) === "Connect");
  if (!connectButton) { out.skipped = "no Connect button"; return JSON.stringify(out, null, 2); }
  connectButton.click();
  const form = await wait(() => document.querySelector("#vr-plugin-connect-form"), "connect form");
  out.dialogCopy = text(form.closest(".vr-plugin-modal-body"));
  const field = form.querySelector('input[type="password"]') || form.querySelector("input");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, "definitely-invalid-key-123456");
  field.dispatchEvent(new Event("input", { bubbles: true }));
  const dialog = form.closest(".vr-plugin-modal");
  [...dialog.querySelectorAll("button")].find(b => text(b) === "Connect and test").click();
  const alert = await wait(() => dialog.querySelector('[role="alert"]'), "connect error");
  out.error = text(alert);
  out.errorLeaksKey = text(alert).includes("definitely-invalid-key-123456");
  const cancel = [...dialog.querySelectorAll("button")].find(b => text(b) === "Cancel");
  if (cancel) cancel.click();
  await wait(() => !document.querySelector("#vr-plugin-connect-form"), "dialog to close");
  const after = [...document.querySelectorAll(".vr-plugin-card")].find(c => text(c.querySelector("h2")) === name);
  out.installedAfter = after.hasAttribute("data-installed");
  out.pillAfter = text(after.querySelector(".vr-status-pill"));
  return JSON.stringify(out, null, 2);
})()`;
ws.addEventListener("open", async () => {
  try {
    await send("Runtime.enable", {});
    const r = await send("Runtime.evaluate", { expression: EXPR, awaitPromise: true, returnByValue: true, timeout: 120000 });
    console.log(r.exceptionDetails ? JSON.stringify(r.exceptionDetails, null, 2) : r.result.value);
  } catch (error) { console.log("ERR", error.message); } finally { ws.close(); }
});
