// Verifies the redesigned chat entries, focus, spacing, and reduced motion.
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
const evaluate = async expression => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 30000 });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

ws.addEventListener("open", async () => {
  const out = {};
  try {
    await send("Page.enable", {});
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    if ((await evaluate("location.pathname")) !== "/chat") {
      await evaluate(`location.href = "/chat?native=windows"; "nav"`).catch(() => {});
      await sleep(2600);
    }
    await sleep(700);

    out.starters = await evaluate(`JSON.stringify(
      [...document.querySelectorAll(".vr-welcome-starter")].map(b => b.innerText.replace(/\\n/g, " | "))
    )`);

    // Clicking a starter must fill the composer and must not create a turn.
    out.starterClick = await evaluate(`(async () => {
      const before = document.querySelectorAll(".vr-msg-row, [data-message-role]").length;
      const textBefore = document.querySelector(".prompt-bar__input")?.value ?? null;
      document.querySelector(".vr-welcome-starter")?.click();
      await new Promise(r => setTimeout(r, 500));
      const input = document.querySelector(".prompt-bar__input");
      return JSON.stringify({
        textBefore,
        inputValue: input?.value?.slice(0, 80) ?? null,
        focused: document.activeElement === input,
        welcomeStillVisible: Boolean(document.querySelector(".vr-welcome")),
        messageCountBefore: before,
        messageCountAfter: document.querySelectorAll(".vr-msg-row, [data-message-role]").length
      });
    })()`);

    out.focusStyle = await evaluate(`(() => {
      const el = document.querySelector(".vr-welcome-starter");
      el.focus();
      const cs = getComputedStyle(el, null);
      return JSON.stringify({ outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor, outlineOffset: cs.outlineOffset });
    })()`);

    // Clear the draft so the composer returns to its placeholder for the next run.
    await evaluate(`(() => {
      const input = document.querySelector(".prompt-bar__input");
      if (!input) return "no input";
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return "cleared";
    })()`);

    out.sidebarFade = await evaluate(`(() => {
      const scroller = document.querySelector(".vr-sidebar-scroll");
      if (!scroller) return "no scroller";
      const cs = getComputedStyle(scroller, "::after");
      return JSON.stringify({ background: cs.backgroundImage, height: cs.height, pointerEvents: cs.pointerEvents });
    })()`);

    // Settings: measure the header gap and the destructive-action alignment.
    await evaluate(`location.href = "/settings?native=windows"; "nav"`).catch(() => {});
    await sleep(2600);
    out.settings = await evaluate(`(() => {
      const label = document.querySelector("#model-type-heading");
      const card = label?.closest(".settings-card");
      const desc = card?.querySelector(".settings-empty");
      const preset = label?.closest(".settings-presets");
      const routine = [...(card?.querySelectorAll(".settings-saved-actions .MuiButton-root") || [])];
      const remove = document.querySelector(".settings-saved-actions .settings-remove-action");
      const testModel = [...document.querySelectorAll(".settings-saved-actions .MuiButton-root")]
        .find(b => /Test model/.test(b.textContent));
      const removeRect = remove?.getBoundingClientRect();
      const testRect = testModel?.getBoundingClientRect();
      return JSON.stringify({
        labelToCopyGap: label && desc ? Math.round(desc.getBoundingClientRect().top - preset.getBoundingClientRect().bottom) : null,
        removeRightOfTestModel: removeRect && testRect ? removeRect.left > testRect.right : null,
        removeAlignedToCardRight: removeRect && card ? Math.round(card.getBoundingClientRect().right - removeRect.right) : null
      });
    })()`);

    // Reduced motion: decorative loops collapse, progress keeps spinning.
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await sleep(300);
    out.reducedMotion = await evaluate(`(() => {
      const ring = document.querySelector(".vr-welcome-ring");
      const css = [];
      if (ring) css.push(getComputedStyle(ring).animationDuration);
      const probe = document.createElement("div");
      probe.setAttribute("role", "progressbar");
      probe.className = "vr-spinner";
      document.body.appendChild(probe);
      const spinning = getComputedStyle(probe).animationIterationCount;
      probe.remove();
      return JSON.stringify({ decorativeAnimationDuration: css[0] ?? null, progressIteration: spinning });
    })()`);
    await send("Emulation.setEmulatedMedia", { features: [] });

    out.consoleErrors = await evaluate(`JSON.stringify(window.__vrConsoleErrors || [])`);
  } catch (error) {
    out.error = error.message;
  } finally {
    console.log(JSON.stringify(out, null, 2));
    ws.close();
  }
});
