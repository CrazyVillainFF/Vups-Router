const CDP = "http://127.0.0.1:9223/json/list";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(CDP)).json();
const page = targets.find((t) => t.type === "page" && t.url.includes(":55010") && t.webSocketDebuggerUrl);
if (!page) {
  console.log("no dev-shell page target");
  process.exit(1);
}
console.log("target:", page.url);

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

async function evalJs(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    return "EXCEPTION " + JSON.stringify(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}

const DRIVER = `(async () => {
  const box =
    document.querySelector("textarea") ||
    document.querySelector('[contenteditable="true"]') ||
    document.querySelector('[role="textbox"]');
  if (!box) return "no input found";
  if (box.tagName === "TEXTAREA") {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(box, ${JSON.stringify("hii")});
    box.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    box.textContent = ${JSON.stringify("hii")};
    box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  }
  await new Promise((r) => setTimeout(r, 400));
  const named = (b) => (b.getAttribute("aria-label") || "") + " " + (b.title || "") + " " + b.textContent;
  const sendBtn = [...document.querySelectorAll("button")].find((b) => /send/i.test(named(b)));
  if (!sendBtn) return "no send button";
  if (sendBtn.disabled) return "send disabled";
  sendBtn.click();
  return "clicked";
})()`;

const SNAPSHOT = `(() => {
  const text = document.body.innerText;
  const urls = performance.getEntriesByType("resource").map((e) => e.name);
  const tail = [...document.querySelectorAll("[class*='message'],[class*='turn'],article")];
  return JSON.stringify({
    toolCalls: urls.filter((u) => u.includes("desktop-tools")).length,
    usageCalls: urls.filter((u) => u.includes("auth/usage")).length,
    hasFallbackBanner: /sent as a normal chat/i.test(text),
    hasGenericError: /something went wrong/i.test(text),
    usageFoot: (text.match(/Daily usage[\\s\\S]{0,120}/) || [""])[0].replace(/\\s+/g, " ").trim(),
    answerTail: (text.match(/Hi there[\\s\\S]{0,80}|VupsRouter works[\\s\\S]{0,40}/) || [""])[0].replace(/\\s+/g, " ").trim()
  });
})()`;

ws.addEventListener("open", async () => {
  try {
    await send("Runtime.enable", {});
    await send("Page.enable", {});
    await send("Page.reload", { ignoreCache: true });
    console.log("reloaded, waiting for boot...");
    await sleep(12000);
    console.log("drive turn 1:", await evalJs(DRIVER));
    await sleep(25000);
    console.log("after turn 1:", await evalJs(SNAPSHOT));
    console.log("drive turn 2:", await evalJs(DRIVER));
    await sleep(25000);
    console.log("after turn 2:", await evalJs(SNAPSHOT));
  } catch (error) {
    console.log("cdp error:", error.message);
  } finally {
    ws.close();
  }
});
