const BASE = "https://vups-router-be.onrender.com";
const email = process.argv[2];
const password = process.argv[3];

async function main() {
  const signin = await fetch(`${BASE}/api/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const cookie = (signin.headers.getSetCookie?.() ?? []).map(c => c.split(";")[0]).join("; ");
  console.log("signin:", signin.status, cookie ? "(session obtained)" : "(no cookie)");
  if (!cookie) return;

  for (const path of ["/api/settings/shared-model", "/api/settings/free-models", "/api/settings/models", "/api/settings/omniroute/status"]) {
    const r = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie } });
    const t = await r.text();
    console.log(`\nGET ${path} -> ${r.status}`);
    console.log(t.slice(0, 700));
  }

  const r = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream", Cookie: cookie },
    body: JSON.stringify({ messages: [{ role: "user", content: "Reply with exactly: VupsRouter works." }], model: "recursive/flint-v1.0:free", stream: true })
  });
  const t = await r.text();
  console.log(`\nPOST /api/chat (flint) -> ${r.status}`);
  console.log(t.slice(0, 600));
}

main().catch(e => console.log("fatal:", e?.name, e?.message));
