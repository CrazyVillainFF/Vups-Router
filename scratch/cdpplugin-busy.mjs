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
  const wait = async (fn, label, ms = 40000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(80); }
    throw new Error("timeout: " + label);
  };
  const cards = await wait(() => document.querySelectorAll(".vr-plugin-card").length ? [...document.querySelectorAll(".vr-plugin-card")] : null, "cards");
  const card = cards.find(c => text(c.querySelector("h2")) === "GitHub");
  card.querySelectorAll("button").forEach(b => { if (text(b) === "Details") b.click(); });
  const detail = await wait(() => document.querySelector(".vr-plugin-detail"), "detail");
  const button = () => detail.querySelector(".vr-plugin-status-meta button");
  const samples = [];
  const record = () => { const b = button(); if (b) samples.push(text(b) + (b.disabled ? " (disabled)" : "")); };
  record();
  button().click();
  record();
  for (let i = 0; i < 60; i += 1) {
    await sleep(40);
    record();
    if (i > 5 && text(button()) === "Test connection") break;
  }
  const ordered = samples.filter((value, index) => index === 0 || value !== samples[index - 1]);
  const close = [...document.querySelectorAll(".vr-plugin-modal-foot button")].find(b => text(b) === "Close");
  if (close) close.click();
  return JSON.stringify({ ordered }, null, 2);
})()`;
ws.addEventListener("open", async () => {
  try {
    await send("Runtime.enable", {});
    const r = await send("Runtime.evaluate", { expression: EXPR, awaitPromise: true, returnByValue: true, timeout: 120000 });
    console.log(r.exceptionDetails ? JSON.stringify(r.exceptionDetails, null, 2) : r.result.value);
  } catch (error) { console.log("ERR", error.message); } finally { ws.close(); }
});
