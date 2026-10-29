const BASE = "https://vups-router-be.onrender.com";
const stamp = Date.now();
const email = `qoder-verify-${stamp}@vupsrouter.test`;
const password = "Verify-2026-testpass!";

function maskCookie(value) {
  const name = value.split("=")[0];
  const token = value.split("=").slice(1).join("=");
  return `${name}=${token.slice(0, 6)}…(${token.length} chars)`;
}

async function main() {
  const signup = await fetch(`${BASE}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Qoder Verify", email, password })
  });
  const signupBody = await signup.text();
  const setCookie = signup.headers.getSetCookie?.() ?? [];
  const cookie = setCookie.map(c => c.split(";")[0]).join("; ");
  console.log("signup:", signup.status, signupBody.slice(0, 160));
  console.log("session cookie:", cookie ? maskCookie(cookie) : "(none returned)");
  if (!cookie) {
    const signin = await fetch(`${BASE}/api/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    const sc = (signin.headers.getSetCookie?.() ?? []).map(c => c.split(";")[0]).join("; ");
    console.log("signin:", signin.status, "cookie:", sc ? maskCookie(sc) : "(none)");
    if (!sc) return;
    return run(sc);
  }
  return run(cookie);
}

async function run(cookie) {
  const me = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } });
  console.log("auth/me:", me.status, JSON.stringify(await me.text()).slice(0, 200));

  const messages = [{ role: "user", content: "Reply with exactly: VupsRouter works." }];

  for (const attempt of [
    { label: "Vups v3 Galax", path: "/api/chat/vups-v3-galax", body: { messages, model: "vups-v3-galax", stream: true } },
    { label: "OpenRouter flint (no user key)", path: "/api/chat", body: { messages, model: "recursive/flint-v1.0:free", stream: true } }
  ]) {
    console.log(`\n--- ${attempt.label} ---`);
    const started = Date.now();
    let res;
    try {
      res = await fetch(`${BASE}${attempt.path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream", Cookie: cookie },
        body: JSON.stringify(attempt.body)
      });
    } catch (error) {
      console.log("fetch failed:", error?.name, error?.message);
      continue;
    }
    console.log("HTTP", res.status, "content-type:", res.headers.get("content-type"), "in", Date.now() - started, "ms");
    const text = await res.text();
    if (!res.ok) {
      console.log("error body:", text.slice(0, 500));
      continue;
    }
    const events = text.split("\n").filter(l => l.startsWith("event:") || l.startsWith("data:"));
    const kinds = new Set(events.filter(l => l.startsWith("event:")).map(l => l.slice(7).trim()));
    console.log("sse lines:", events.length, "event kinds:", [...kinds].join(",") || "(none)");
    const delta = events
      .filter(l => l.startsWith("data:"))
      .map(l => l.slice(6))
      .join("");
    console.log("raw head:", JSON.stringify(text.slice(0, 300)));
    console.log("raw tail:", JSON.stringify(text.slice(-300)));
    if (Date.now() - started > 120000) break;
  }
}

main().catch(error => console.log("fatal:", error?.name, error?.message));
