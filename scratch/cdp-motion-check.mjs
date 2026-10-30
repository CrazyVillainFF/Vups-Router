const CDP_PORT = process.env.CDP_PORT || "9224";
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = targets.find(t => t.type === "page" && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const errors = [];
const send = (method, params) => new Promise((resolve, reject) => {
  const msgId = ++id;
  pending.set(msgId, { resolve, reject });
  ws.send(JSON.stringify({ id: msgId, method, params }));
});
ws.addEventListener("message", event => {
  const msg = JSON.parse(event.data);
  if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails?.text || "exception");
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    errors.push(msg.params.args.map(a => a.value ?? a.description).join(" "));
  }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
});
const evaluate = async expression => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 30000 });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
ws.addEventListener("open", async () => {
  try {
    await send("Runtime.enable", {});
    if ((await evaluate("location.pathname")) !== "/chat") {
      await evaluate(`location.href = "/chat?native=windows"; "nav"`).catch(() => {});
      await sleep(2800);
    }
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await sleep(400);
    const reduce = await evaluate(`(() => {
      const ring = document.querySelector(".vr-welcome-ring");
      const style = ring ? getComputedStyle(ring) : null;
      return JSON.stringify({ ringDuration: style?.animationDuration ?? null, ringIterations: style?.animationIterationCount ?? null });
    })()`);
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
    await sleep(300);
    const normal = await evaluate(`(() => {
      const ring = document.querySelector(".vr-welcome-ring");
      return ring ? getComputedStyle(ring).animationDuration : null;
    })()`);
    console.log(JSON.stringify({ reduce: JSON.parse(reduce), normalRingDuration: normal, runtimeErrors: errors }, null, 2));
  } catch (e) {
    console.log("ERR", e.message, JSON.stringify(errors));
  } finally {
    ws.close();
  }
});
