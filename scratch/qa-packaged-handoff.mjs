// QA-only: drives the packaged Windows app through the browser sign-in handoff.
// The app side runs on WebView2 (CDP 9222); the approving browser tab runs in
// the dedicated QA Chrome (CDP 9223), which already holds a site session.
const APP = "http://127.0.0.1:9222";
const WEB = "http://127.0.0.1:9223";
const sleep = ms => new Promise(r => setTimeout(r, ms));

function connect(baseUrl) {
  return {
    async page(match) {
      const list = await (await fetch(`${baseUrl}/json/list`)).json();
      const pages = list.filter(t => t.type === "page" && t.webSocketDebuggerUrl);
      return (match ? pages.find(t => t.url.includes(match)) : pages[0]) ?? pages[0];
    },
    async newTab(url) {
      return (await (await fetch(`${baseUrl}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json());
    },
    async withPage(run, match) {
      const target = await this.page(match);
      if (!target) throw new Error("no page target");
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      let id = 0;
      const pending = new Map();
      ws.addEventListener("message", e => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      });
      await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
      const send = (method, params) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
      await send("Runtime.enable", {});
      const evaluate = async expression => {
        const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 200));
        return r.result?.result?.value;
      };
      try {
        return await run(evaluate, target);
      } finally {
        ws.close();
      }
    }
  };
}

const app = connect(APP);
const web = connect(WEB);

const step = (label, value) => console.log(`${label}: ${value}`);

await sleep(1500);
step("app page", await app.withPage((e) => e(`location.href`)));

// 1. Start the handoff from the app's native sign-in screen.
const started = await app.withPage(e => e(`(async () => {
  localStorage.clear();
  location.assign('/signin?native=windows');
  return 'navigating';
})()`));
step("app reload", started);
await sleep(4000);

const before = await app.withPage(e => e(`JSON.stringify({
  url: location.href,
  native: document.querySelector('.auth-kicker')?.innerText || 'none',
  buttons: [...document.querySelectorAll('button')].map((b, i) => i + ':' + b.textContent.trim().slice(0, 26)).join(' | ')
})`));
step("app sign-in screen", before);

const clicked = await app.withPage(e => e(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => /Sign in with browser/.test(x.textContent));
  if (!b) return 'button missing';
  b.click();
  return 'clicked';
})()`));
step("app click", clicked);
await sleep(5000);

const pending = await app.withPage(e => e(`localStorage.getItem('vupsrouter.desktop-signin') || 'none'`));
step("app pending transaction", String(pending).slice(0, 90));
if (pending === "none") {
  step("RESULT", "FAIL - the app never obtained a ticket");
  process.exit(1);
}
const ticket = JSON.parse(pending).ticket;
const approvalUrl = `http://127.0.0.1:5173/desktop-auth?ticket=${ticket}&client=windows`;

// 2. Approve it from the signed-in browser tab, exactly as the system browser would.
await web.newTab(approvalUrl);
await sleep(6000);
const approvalText = await web.withPage(e => e(`JSON.stringify({url: location.href, text: document.body.innerText.slice(0, 220)})`), "desktop-auth");
step("approval page", approvalText);

// 3. The app polls; it should install the session and open the chat page itself.
await sleep(7000);
const after = await app.withPage(e => e(`JSON.stringify({
  url: location.href,
  pending: localStorage.getItem('vupsrouter.desktop-signin'),
  text: document.body.innerText.slice(0, 220)
})`));
step("app after approval", after);
