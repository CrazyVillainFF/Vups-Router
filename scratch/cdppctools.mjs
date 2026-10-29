const CDP = "http://127.0.0.1:9223/json/list";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(CDP)).json();
const page = targets.find((t) => t.type === "page" && t.url.includes(":55010") && t.webSocketDebuggerUrl);
if (!page) {
  console.log("no dev-shell page target");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});

async function js(expression, label) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    console.log(label + " EXCEPTION:", r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return null;
  }
  const value = r.result.value;
  console.log(label + ":", typeof value === "string" ? value : JSON.stringify(value));
  return value;
}

const PROMPT = "List the 5 newest files in my Windows Downloads folder and give me their full paths.";

const CLEAR = `(() => { sessionStorage.removeItem("vr.desktopToolsMissing"); return "cleared"; })()`;

const PICK_MODEL = `(async () => {
  const named = (b) => ((b.getAttribute("aria-label") || "") + " " + (b.title || "")).trim();
  const trigger = [...document.querySelectorAll("button")].find((b) => /choose model/i.test(named(b)));
  if (!trigger) return "no model button";
  const current = named(trigger);
  if (/vups v3 galax/i.test(current)) return "already: " + current;
  trigger.click();
  await new Promise((r) => setTimeout(r, 900));
  const option = [...document.querySelectorAll("button,[role='option'],[role='menuitem']")]
    .find((el) => /vups v3 galax/i.test(el.textContent || "") && el !== trigger);
  if (!option) return "no galax option (" + current + ")";
  option.click();
  await new Promise((r) => setTimeout(r, 700));
  return "picked (was " + current + ")";
})()`;

const TYPE_AND_SEND = `(async () => {
  const box = document.querySelector("textarea") || document.querySelector('[contenteditable="true"]');
  if (!box) return "no input";
  if (box.tagName === "TEXTAREA") {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, ${JSON.stringify(PROMPT)});
    box.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    box.textContent = ${JSON.stringify(PROMPT)};
    box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  }
  await new Promise((r) => setTimeout(r, 400));
  const named = (b) => (b.getAttribute("aria-label") || "") + " " + (b.title || "") + " " + b.textContent;
  const btn = [...document.querySelectorAll("button")].find((b) => /send/i.test(named(b)));
  if (!btn) return "no send button";
  if (btn.disabled) return "send disabled";
  btn.click();
  return "sent";
})()`;

const WATCH = `(() => {
  const text = document.body.innerText;
  const named = (b) => (b.getAttribute("aria-label") || "") + " " + (b.title || "") + " " + b.textContent.trim();
  const approvals = [...document.querySelectorAll("button")]
    .map((b) => named(b))
    .filter((t) => /allow|approve|deny|once|always/i.test(t));
  const urls = performance.getEntriesByType("resource").map((e) => e.name);
  return JSON.stringify({
    toolCalls: urls.filter((u) => u.includes("desktop-tools")).length,
    approvals,
    hasPcAccessRefusal: /can'?t directly browse|I cannot access|don'?t have access to your (local )?files|unless your app has local file access/i.test(text),
    downloadsPaths: (text.match(/[A-Za-z]:\\\\Users\\\\[^\\s"]+/g) || []).slice(0, 8),
    tail: text.slice(-700).replace(/\\n{2,}/g, "\\n")
  });
})()`;

const APPROVE = `(() => {
  const named = (b) => (b.getAttribute("aria-label") || "") + " " + (b.title || "") + " " + b.textContent.trim();
  const btn = [...document.querySelectorAll("button")].find((b) => /^(allow|allow once|allow this once|approve|yes)/i.test(named(b).trim()));
  if (!btn) return "nothing to approve";
  const label = named(btn).trim();
  btn.click();
  return "clicked " + label;
})()`;

ws.addEventListener("open", async () => {
  try {
    await send("Runtime.enable", {});
    await send("Page.enable", {});
    await js(CLEAR, "session flag");
    await send("Page.navigate", { url: "http://127.0.0.1:55010/chat?native=windows&new=1" });
    await sleep(14000);
    await js(PICK_MODEL, "model");
    await js(TYPE_AND_SEND, "turn");
    for (let i = 0; i < 24; i += 1) {
      await sleep(5000);
      const raw = await js(WATCH, "watch#" + i);
      if (!raw) continue;
      const state = JSON.parse(raw);
      console.log("  toolCalls=" + state.toolCalls + " approvals=" + JSON.stringify(state.approvals) + " refusal=" + state.hasPcAccessRefusal + " paths=" + JSON.stringify(state.downloadsPaths));
      if (state.approvals.length) {
        await js(APPROVE, "approve");
      }
      if (state.downloadsPaths.length >= 2) {
        console.log("REAL PATHS SEEN");
        console.log(state.tail);
        break;
      }
      if (i === 23) console.log("FINAL TAIL:\n" + state.tail);
    }
  } catch (error) {
    console.log("cdp error:", error.message);
  } finally {
    ws.close();
  }
});
