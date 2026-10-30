// Clicks Test connection in the installed app, watches the loading state, and
// reports the real outcome the app shows afterwards.
const CDP_PORT = process.env.CDP_PORT || "9224";
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = targets.find(t => t.type === "page" && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params) =>
  new Promise((resolve, reject) => {
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
  const wait = async (fn, label, ms = 40000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = fn();
      if (v) return v;
      await sleep(100);
    }
    throw new Error("timeout: " + label);
  };
  const text = el => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
  const out = {};
  if (location.pathname !== "/plugins") throw new Error("not on /plugins");
  const cards = await wait(() => [...document.querySelectorAll(".vr-plugin-card")].length ? [...document.querySelectorAll(".vr-plugin-card")] : null, "cards");
  const card = cards.find(c => text(c.querySelector("h2")) === "GitHub");
  [...card.querySelectorAll("button")].find(b => text(b) === "Details").click();
  const detail = await wait(() => document.querySelector(".vr-plugin-detail"), "detail");
  const before = text(detail.querySelector(".vr-plugin-status-meta"));
  [...detail.querySelectorAll("button")].find(b => text(b) === "Test connection").click();
  out.busyLabel = await wait(() => text(detail.querySelector(".vr-plugin-status-meta button")), "busy label");
  out.busyDisabled = detail.querySelector(".vr-plugin-status-meta button").disabled;
  await wait(() => text(detail.querySelector(".vr-plugin-status-meta button")) === "Test connection", "test to finish");
  out.after = {
    meta: text(detail.querySelector(".vr-plugin-status-meta")),
    pill: text(detail.querySelector(".vr-plugin-status-panel .vr-status-pill")),
    sentence: text(detail.querySelector(".vr-plugin-status-row p")),
    notice: text(document.querySelector(".vr-inline-success")),
    error: text(detail.closest(".vr-plugin-modal-body").querySelector(".vr-inline-error"))
  };
  out.metaChanged = before !== out.after.meta;
  const close = [...document.querySelectorAll(".vr-plugin-modal-foot button")].find(b => text(b) === "Close");
  if (close) close.click();
  return JSON.stringify(out, null, 2);
})()`;
ws.addEventListener("open", async () => {
  try {
    await send("Runtime.enable", {});
    const r = await send("Runtime.evaluate", { expression: EXPR, awaitPromise: true, returnByValue: true, timeout: 120000 });
    console.log(r.exceptionDetails ? JSON.stringify(r.exceptionDetails, null, 2) : r.result.value);
  } catch (error) {
    console.log("ERR", error.message);
  } finally {
    ws.close();
  }
});
