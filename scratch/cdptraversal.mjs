const CDP_PORT = process.env.CDP_PORT || "9223";
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
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const approvals = [];
  await invoke("plugin:event|listen", {
    event: "desktop-tool:approval",
    target: { kind: "Any" },
    handler: window.__TAURI_INTERNALS__.transformCallback(m => approvals.push(m.payload))
  });
  const ROOT = "C:/Users/Vishnu/AppData/Local/Temp/vups-mode-verify";
  const out = {};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const settle = promise => {
    const box = { settled: false, value: null, error: null };
    promise.then(v => { box.settled = true; box.value = v; }, e => { box.settled = true; box.error = String(e); });
    return box;
  };
  await invoke("desktop_tool_set_policy", { input: { owner: "verifyacct", mode: "workspace", workspaceId: "wsverifyA" } });
  const traversal = settle(invoke("desktop_tool_execute", {
    request: { tool: "read_file", args: { path: ROOT + "/wsA/../outside/notes.txt" } }
  }));
  await sleep(1200);
  out.afterOneSecond = { settled: traversal.settled, response: traversal.value, error: traversal.error };
  out.approvals = approvals.map(a => ({ scopePath: a.scopePath, action: a.action }));
  if (approvals.length) {
    await invoke("desktop_tool_respond", { input: { requestId: approvals[0].requestId, decision: "deny" } });
    await sleep(500);
    out.afterDeny = { settled: traversal.settled, response: traversal.value, error: traversal.error };
  }
  out.pending = await invoke("desktop_tool_approvals_cancel");
  await invoke("desktop_tool_set_policy", { input: { owner: "verifyacct", mode: "ask", workspaceId: null } });
  return JSON.stringify(out, null, 2);
})()`;

ws.addEventListener("open", async () => {
  try {
    await send("Runtime.enable", {});
    const r = await send("Runtime.evaluate", { expression: EXPR, awaitPromise: true, returnByValue: true, timeout: 60000 });
    console.log(r.exceptionDetails ? JSON.stringify(r.exceptionDetails, null, 2) : r.result.value);
  } catch (error) {
    console.log("ERR", error.message);
  } finally {
    ws.close();
  }
});
