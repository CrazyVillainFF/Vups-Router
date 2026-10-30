// Drives the redesigned plugin detail screen in the installed desktop app and
// reports what the UI actually says and does. Read-only except that it installs
// GitHub when it is not already installed, and removes it again if it did.
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
const evaluate = async (expression, timeout = 180000) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const EXPR = String.raw`(async () => {
  const out = { steps: [], path: location.pathname };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const wait = async (fn, label, ms = 25000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { const v = fn(); if (v) return v; } catch {}
      await sleep(150);
    }
    throw new Error("timeout: " + label);
  };
  const btn = (root, text) => [...root.querySelectorAll("button")].find(b => b.textContent.trim() === text) || null;
  const setVal = (el, value) => {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const labelInput = (root, text) => {
    const label = [...root.querySelectorAll("label")].find(l => ((l.querySelector("span")?.textContent || "").trim()).startsWith(text));
    return label ? label.querySelector("input, textarea, select") : null;
  };
  const click = el => {
    if (!el) throw new Error("control not found");
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  };
  const text = el => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");

  try {
  out.path = location.pathname;

  const cards = await wait(() => {
    const list = [...document.querySelectorAll(".vr-plugin-card")];
    return list.length ? list : null;
  }, "plugin cards");
  out.cardCount = cards.length;
  out.pageError = text(document.querySelector(".vr-inline-error"));

  const card = cards.find(c => text(c.querySelector("h2")) === "GitHub");
  if (!card) { out.fatal = "GitHub card missing"; return JSON.stringify(out, null, 2); }
  out.acceptedAtStart = card.hasAttribute("data-installed");
  out.cardPill = text(card.querySelector(".vr-status-pill"));
  click(btn(card, "Details"));

  let detail = await wait(() => document.querySelector(".vr-plugin-detail"), "detail view");
  out.opened = true;
  out.status = {
    pill: text(detail.querySelector(".vr-plugin-status-panel .vr-status-pill")),
    sentence: text(detail.querySelector(".vr-plugin-status-row p")),
    meta: text(detail.querySelector(".vr-plugin-status-meta"))
  };

  const collect = () => {
    detail = document.querySelector(".vr-plugin-detail") || detail;
    const groups = [...detail.querySelectorAll(".vr-plugin-capability-group")].map(g => ({
      kind: g.getAttribute("data-kind"),
      heading: text(g.querySelector("h4")),
      labels: [...g.querySelectorAll(".vr-plugin-action-label")].map(n => text(n))
    }));
    const defaultSurface = [".vr-plugin-status-panel", ".vr-plugin-setup", ".vr-plugin-capabilities"]
      .map(s => text(detail.querySelector(s))).join(" ");
    const advanced = detail.querySelector(".vr-plugin-advanced");
    return {
      installed: Boolean(btn(detail, "Disconnect")),
      buttons: [...detail.querySelectorAll(".vr-plugin-detail-actions button")].map(b => text(b)),
      setup: text(detail.querySelector(".vr-plugin-setup")),
      groups,
      rawNameInDefault: /search_repositories|create_issue|list_issues/.test(defaultSurface),
      advancedPresent: Boolean(advanced),
      advancedOpen: advanced ? advanced.hasAttribute("open") : null,
      advancedToolNames: advanced ? [...advanced.querySelectorAll(".vr-plugin-tool-names code")].map(n => text(n)) : [],
      advancedFacts: advanced ? text(advanced.querySelector(".vr-plugin-facts")) : ""
    };
  };

  out.before = collect();
  detail = document.querySelector(".vr-plugin-detail") || detail;
  if (!out.before.installed) {
    click(btn(detail, "Connect"));
    const connect = await wait(() => document.querySelector("#vr-plugin-connect-form"), "connect form");
    out.connectCopy = text(connect.closest(".vr-plugin-modal-body"));
    const dialog = connect.closest(".vr-plugin-modal");
    click(btn(dialog, "Connect and test"));
    await wait(() => !document.querySelector("#vr-plugin-connect-form"), "connect dialog to close", 40000);
    await wait(() => document.querySelector(".vr-plugin-detail"), "detail after connect");
    detail = document.querySelector(".vr-plugin-detail");
    out.installedDuringProbe = true;
  }

  out.after = collect();
  detail = document.querySelector(".vr-plugin-detail") || detail;
  out.noticeAfterConnect = text(document.querySelector(".vr-inline-success"));

  const testBtn = btn(detail, "Test connection");
  if (testBtn) {
    click(testBtn);
    await wait(() => btn(detail, "Test connection") && !btn(detail, "Testing…"), "test to finish", 40000);
    out.test = {
      notice: text(document.querySelector(".vr-inline-success")),
      error: text(detail.parentElement.querySelector(".vr-inline-error")),
      status: {
        pill: text(detail.querySelector(".vr-plugin-status-panel .vr-status-pill")),
        sentence: text(detail.querySelector(".vr-plugin-status-row p")),
        meta: text(detail.querySelector(".vr-plugin-status-meta"))
      }
    };
  }

  // Read action through the friendly dialog.
  detail = document.querySelector(".vr-plugin-detail") || detail;
  const readItem = detail.querySelector('.vr-plugin-action[data-tool="search_repositories"]');
  if (readItem) {
    click(readItem.querySelector("summary"));
    await sleep(250);
    click(btn(readItem, "Try it"));
    const dialog = await wait(() => document.querySelector(".vr-plugin-action-modal"), "read dialog");
    out.readDialog = { kicker: text(dialog.querySelector(".vr-page-kicker")), title: text(dialog.querySelector("h2")) };
    setVal(labelInput(dialog, "Search words"), "vite");
    dialog.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const done = await wait(
      () => dialog.querySelector(".vr-plugin-result") || dialog.querySelector('[role="alert"]'),
      "read result",
      45000
    );
    out.read = {
      isResult: Boolean(dialog.querySelector(".vr-plugin-result")),
      snippet: text(done).slice(0, 240)
    };
    const close = btn(dialog, "Close") || btn(dialog, "Cancel");
    if (close) click(close);
    await wait(() => !document.querySelector(".vr-plugin-action-modal"), "read dialog to close");
  }

  // Write action: review step must appear and cancel must send nothing.
  detail = document.querySelector(".vr-plugin-detail") || detail;
  const writeItem = detail.querySelector('.vr-plugin-action[data-tool="create_issue"]');
  if (writeItem) {
    out.writeBadges = [...writeItem.querySelectorAll(".vr-status-pill")].map(n => text(n));
    click(writeItem.querySelector("summary"));
    await sleep(250);
    click(btn(writeItem, "Try it"));
    const dialog = await wait(() => document.querySelector(".vr-plugin-action-modal"), "write dialog");
    out.writeKicker = text(dialog.querySelector(".vr-page-kicker"));
    setVal(labelInput(dialog, "Repository owner"), "vitejs");
    setVal(labelInput(dialog, "Repository name"), "vite");
    setVal(labelInput(dialog, "Issue title"), "UI verification title (not submitted)");
    dialog.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const confirm = await wait(() => dialog.querySelector(".vr-plugin-confirm-step"), "review step");
    out.writeReview = {
      copy: text(confirm),
      rows: [...confirm.querySelectorAll(".vr-plugin-confirm-list > div")].map(row => text(row))
    };
    click(btn(dialog, "Cancel"));
    await wait(() => !document.querySelector(".vr-plugin-action-modal"), "write dialog to close");
    out.writeCancelledSafely = true;
  }

  // Advanced section.
  detail = document.querySelector(".vr-plugin-detail") || detail;
  const advanced = detail.querySelector(".vr-plugin-advanced");
  if (advanced) {
    click(advanced.querySelector("summary"));
    await sleep(250);
    out.advanced = {
      open: advanced.hasAttribute("open"),
      toolNames: [...advanced.querySelectorAll(".vr-plugin-tool-names code")].map(n => text(n)),
      facts: text(advanced.querySelector(".vr-plugin-facts")),
      consolePresent: Boolean(advanced.querySelector(".vr-plugin-console"))
    };
  }

  // Restore: only remove what this probe installed.
  if (out.installedDuringProbe) {
    click(btn(detail, "Disconnect"));
    const hold = await wait(() => document.querySelector(".vr-hold-delete-dialog"), "disconnect dialog");
    click(hold.querySelector(".vr-hold-delete-explicit"));
    await wait(() => !document.querySelector(".vr-hold-delete-dialog"), "disconnect to finish", 40000);
    out.restored = true;
  } else {
    const close = [...document.querySelectorAll(".vr-plugin-modal-foot button")].find(b => b.textContent.trim() === "Close");
    if (close) click(close);
  }

  } catch (probeError) {
    out.error = String(probeError && probeError.message ? probeError.message : probeError);
  }
  return JSON.stringify(out, null, 2);
})()`;

ws.addEventListener("open", async () => {
  try {
    await send("Runtime.enable", {});
    const current = await evaluate("location.pathname", 10000);
    if (current !== "/plugins") {
      await evaluate('location.href = "/plugins"; "navigating"', 10000).catch(() => {});
      await sleep(4000);
    }
    const out = await evaluate(EXPR);
    console.log(out);
  } catch (error) {
    console.log("ERR", error.message);
  } finally {
    ws.close();
  }
});
