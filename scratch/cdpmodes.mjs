// Drives the real Windows build over the WebView2 DevTools protocol and calls
// the Tauri commands directly, so the evidence is the native layer's answers
// rather than the React selector's state.
const CDP_PORT = process.env.CDP_PORT || "9223";
const ROOT = "C:/Users/Vishnu/AppData/Local/Temp/vups-mode-verify";
const OWNER = "verifyacct";

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = targets.find(t => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) {
  console.log("NO PAGE TARGET", JSON.stringify(targets.map(t => [t.type, t.url])));
  process.exit(1);
}
console.log("PAGE", page.url);

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
  const internals = window.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== "function") {
    return JSON.stringify({ fatal: "no tauri internals" });
  }
  const invoke = internals.invoke;
  const approvals = [];
  await invoke("plugin:event|listen", {
    event: "desktop-tool:approval",
    target: { kind: "Any" },
    handler: internals.transformCallback(message => approvals.push(message.payload))
  });

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ROOT = ${JSON.stringify(ROOT)};
  const OUTSIDE = ROOT + "/outside/notes.txt";
  const WS_A_FILE = ROOT + "/wsA/inside.txt";
  const WS_B_FILE = ROOT + "/wsB/other.txt";
  const results = [];
  const record = (name, value) => results.push({ name, ...value });

  const setPolicy = (mode, workspaceId = null) =>
    invoke("desktop_tool_set_policy", { input: { owner: ${JSON.stringify(OWNER)}, mode, workspaceId } });
  const exec = (tool, args) => invoke("desktop_tool_execute", { request: { tool, args } });
  const cancelAll = () => invoke("desktop_tool_approvals_cancel");
  const respond = (requestId, decision) =>
    invoke("desktop_tool_respond", { input: { requestId, decision } });

  const waitCard = async (label, timeout = 6000) => {
    const start = Date.now();
    let seen = approvals.length;
    while (Date.now() - start < timeout) {
      if (approvals.length > seen) return approvals[approvals.length - 1];
      await sleep(50);
    }
    return null;
  };
  const settle = promise => {
    const box = { settled: false, value: null, error: null };
    promise.then(
      v => { box.settled = true; box.value = v; },
      e => { box.settled = true; box.error = String(e); }
    );
    return box;
  };
  const brief = r => {
    if (!r) return null;
    if (r.code) return { code: r.code, message: r.message };
    if (r.ok === false) return { code: r.error?.code, message: r.error?.message };
    if (r.error) return { error: r.error };
    return r;
  };

  // 1. Ask: a card is raised, nothing is read, cancel denies it.
  await setPolicy("ask");
  const denied = settle(exec("read_file", { path: OUTSIDE }));
  const card1 = await waitCard("ask");
  await sleep(500);
  record("ask_card", { raised: !!card1, scopePath: card1?.scopePath, action: card1?.action, readWhileOpen: denied.settled });
  const cancelled = await cancelAll();
  await sleep(600);
  record("ask_cancel", { cancelled, settled: denied.settled, result: brief(denied.value) || denied.error });

  // 2. Ask: approving once lets the same pending call finish.
  const approved = settle(exec("list_directory", { path: ROOT + "/wsA" }));
  const card2 = await waitCard("ask2");
  record("ask_card_again", { raised: !!card2, scopePath: card2?.scopePath });
  if (card2) await respond(card2.requestId, "once");
  await sleep(800);
  record("ask_approve", {
    settled: approved.settled,
    ok: approved.value?.ok,
    entryNames: approved.value?.data?.entries?.map(e => e.name),
    failure: approved.value?.error ? brief(approved.value) : approved.error
  });

  // 3. Full: a normal read runs with no card, a protected folder still asks.
  await setPolicy("full");
  const before = approvals.length;
  const fullRead = await exec("read_file", { path: OUTSIDE });
  record("full_read", { ok: fullRead.ok, prompted: approvals.length > before, text: fullRead.data?.content?.slice(0, 40) });

  const protectedCall = settle(exec("list_directory", { path: "C:\\Windows" }));
  const card3 = await waitCard("full-protected");
  record("full_protected", { raised: !!card3, scopePath: card3?.scopePath, readWhileOpen: protectedCall.settled });

  // 4. Switching to Ask while that card is on screen must abandon the read.
  const switched = await setPolicy("ask");
  await sleep(800);
  record("switch_mid_card", {
    status: switched,
    settled: protectedCall.settled,
    result: brief(protectedCall.value) || protectedCall.error
  });
  let replay = null;
  try {
    replay = await respond(card3?.requestId, "once");
  } catch (error) {
    replay = { error: String(error) };
  }
  record("approval_replay", replay);

  // 5. Workspace: inside is free, outside asks, switching roots closes the old one.
  const policyA = await setPolicy("workspace", "wsverifyA");
  const insideBefore = approvals.length;
  const insideA = await exec("read_file", { path: WS_A_FILE });
  record("workspace_inside", {
    root: policyA?.workspaceRoot,
    ok: insideA.ok,
    prompted: approvals.length > insideBefore,
    text: insideA.data?.content?.slice(0, 20)
  });

  const outsideB = settle(exec("read_file", { path: WS_B_FILE }));
  const card4 = await waitCard("workspace-outside");
  record("workspace_outside", { raised: !!card4, scopePath: card4?.scopePath, readWhileOpen: outsideB.settled });
  if (card4) await respond(card4.requestId, "deny");
  await sleep(600);
  record("workspace_outside_denied", { settled: outsideB.settled, result: brief(outsideB.value) || outsideB.error });

  const policyB = await setPolicy("workspace", "wsverifyB");
  const oldRoot = settle(exec("read_file", { path: WS_A_FILE }));
  const card5 = await waitCard("workspace-switched");
  record("workspace_switch", {
    root: policyB?.workspaceRoot,
    oldRootRaised: !!card5,
    scopePath: card5?.scopePath,
    oldReadWhileOpen: oldRoot.settled
  });
  if (card5) await respond(card5.requestId, "deny");
  await sleep(400);
  const newRoot = await exec("read_file", { path: WS_B_FILE });
  record("workspace_new_root", { ok: newRoot.ok, text: newRoot.data?.content?.slice(0, 20) });

  // 6. A missing workspace is not whole-disk access.
  let missing = null;
  try {
    await setPolicy("workspace", "wsdoesnotexist");
    missing = "NO ERROR";
  } catch (error) {
    missing = String(error);
  }
  const noRoot = settle(exec("read_file", { path: WS_B_FILE }));
  const card6 = await waitCard("workspace-missing");
  record("workspace_missing", { error: missing, raised: !!card6, readWhileOpen: noRoot.settled });
  await cancelAll();
  await sleep(400);

  // 7. Traversal out of the workspace asks, a junction cannot carry a read out.
  await setPolicy("workspace", "wsverifyA");
  const beforeEscape = approvals.length;
  const junction = await exec("read_file", { path: ROOT + "/wsA/escape/notes.txt" });
  const traversal = settle(exec("read_file", { path: ROOT + "/wsA/../outside/notes.txt" }));
  const card7 = await waitCard("workspace-traversal");
  record("escapes", {
    junction: brief(junction),
    junctionPrompted: false,
    traversalRaised: !!card7,
    traversalScope: card7?.scopePath,
    traversalReadWhileOpen: traversal.settled,
    promptedCount: approvals.length - beforeEscape
  });
  await cancelAll();
  await sleep(400);

  await setPolicy("ask");
  record("final_status", await invoke("desktop_tool_policy_status"));
  return JSON.stringify({ results }, null, 2);
})()`;

ws.addEventListener("open", async () => {
  try {
    await send("Runtime.enable", {});
    const r = await send("Runtime.evaluate", {
      expression: EXPR,
      awaitPromise: true,
      returnByValue: true,
      timeout: 180000
    });
    if (r.exceptionDetails) {
      console.log("EXCEPTION", JSON.stringify(r.exceptionDetails, null, 2));
    } else {
      console.log(r.result.value);
    }
  } catch (error) {
    console.log("ERR", error.message);
  } finally {
    ws.close();
  }
});
