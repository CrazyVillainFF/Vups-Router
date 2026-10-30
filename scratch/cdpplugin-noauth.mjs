// Checks the no-account pattern on a public-data plugin without installing it.
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
  const wait = async (fn, label, ms = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(120); }
    throw new Error("timeout: " + label);
  };
  const cards = await wait(() => document.querySelectorAll(".vr-plugin-card").length ? [...document.querySelectorAll(".vr-plugin-card")] : null, "cards");
  const card = cards.find(c => text(c.querySelector("h2")) === "npm Registry");
  if (!card) return JSON.stringify({ skipped: "npm card missing" }, null, 2);
  const out = { cardButtons: [...card.querySelectorAll("button")].map(b => text(b)) };
  [...card.querySelectorAll("button")].find(b => text(b) === "Details").click();
  const detail = await wait(() => document.querySelector(".vr-plugin-detail"), "detail");
  out.detailButtons = [...detail.querySelectorAll("button")].map(b => text(b));
  out.setup = text(detail.querySelector(".vr-plugin-setup"));
  out.status = text(detail.querySelector(".vr-plugin-status-panel"));
  out.headings = [...detail.querySelectorAll(".vr-plugin-capability-group h4")].map(h => text(h));
  const turnOn = [...detail.querySelectorAll("button")].find(b => text(b) === "Turn on");
  if (!turnOn) return JSON.stringify({ ...out, error: "no Turn on button" }, null, 2);
  turnOn.click();
  const form = await wait(() => document.querySelector("#vr-plugin-connect-form"), "connect form");
  const dialog = form.closest(".vr-plugin-modal");
  out.connectCopy = text(form.closest(".vr-plugin-modal-body"));
  out.footer = [...dialog.querySelectorAll(".vr-plugin-modal-foot button")].map(b => text(b));
  [...dialog.querySelectorAll(".vr-plugin-modal-foot button")].find(b => text(b) === "Cancel").click();
  await wait(() => !document.querySelector("#vr-plugin-connect-form"), "dialog close");
  const close = [...document.querySelectorAll(".vr-plugin-modal-foot button")].find(b => text(b) === "Close");
  if (close) close.click();
  return JSON.stringify(out, null, 2);
})()`;
ws.addEventListener("open", async () => {
  try {
    await send("Runtime.enable", {});
    const r = await send("Runtime.evaluate", { expression: EXPR, awaitPromise: true, returnByValue: true, timeout: 90000 });
    console.log(r.exceptionDetails ? JSON.stringify(r.exceptionDetails, null, 2) : r.result.value);
  } catch (error) { console.log("ERR", error.message); } finally { ws.close(); }
});
