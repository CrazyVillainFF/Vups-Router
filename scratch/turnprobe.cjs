// Two turns in one conversation, against the deployed backend, with a throwaway
// account. The desktop screenshot shows turn 1 succeeding and turn 2 failing
// with the generic card, so the shape of the replayed history is the suspect.
const BASE = "https://vups-router-be.onrender.com";
const stamp = Date.now();
const email = `qoder-turn-${stamp}@vupsrouter.test`;
const password = "Verify-2026-testpass!";

async function call(cookie, path, body) {
  const started = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, type: res.headers.get("content-type"), ms: Date.now() - started, text };
}

const signup = await fetch(`${BASE}/api/auth/signup`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Qoder Turn Verify", email, password })
});
let cookie = (signup.headers.getSetCookie?.() ?? []).map(c => c.split(";")[0]).join("; ");
console.log("signup", signup.status, cookie ? "cookie ok" : "(no cookie)");
if (!cookie) {
  const signin = await fetch(`${BASE}/api/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  cookie = (signin.headers.getSetCookie?.() ?? []).map(c => c.split(";")[0]).join("; ");
  console.log("signin", signin.status);
}

const sse = text => {
  const meta = /"type":"meta"[^\n]*/.exec(text);
  const deltas = [...text.matchAll(/"type":"delta","content":"((?:[^"\\]|\\.)*)"/g)].map(m =>
    JSON.parse(`"${m[1]}"`)
  );
  return { meta: meta ? JSON.parse(meta[0]) : null, answer: deltas.join("") };
};

const prompt = "Reply with exactly: VupsRouter works.";

// Turn 1, exactly as the client sends it: no conversationId, no history.
let out = sse((await call(cookie, "/api/chat/vups-v3-galax", {
  messages: [{ role: "user", content: prompt }],
  model: "vups-v3-galax",
  stream: true
})).text);
const conversationId = out.meta?.conversationId;
const assistantContent = out.answer;
console.log("turn 1:", JSON.stringify(assistantContent.slice(0, 60)), "conversationId:", conversationId);

// Turn 2, replaying the history the way the client does.
const history = [
  { role: "user", content: prompt },
  { role: "assistant", content: assistantContent },
  { role: "user", content: "hii" }
];
for (const variant of [
  { label: "with conversationId", body: { conversationId, messages: history, model: "vups-v3-galax", stream: true } },
  { label: "without conversationId", body: { messages: history, model: "vups-v3-galax", stream: true } }
]) {
  const r = await call(cookie, "/api/chat/vups-v3-galax", variant.body);
  console.log(`\nturn 2 (${variant.label}): HTTP ${r.status} ${r.type} in ${r.ms}ms`);
  console.log("body:", r.text.slice(0, 700));
}
