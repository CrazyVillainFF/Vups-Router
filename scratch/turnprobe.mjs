const BASE = "https://vups-router-be.onrender.com";
const stamp = Date.now();
const email = `qoder-turn-${stamp}@vupsrouter.test`;
const password = "Verify-2026-testpass!";

async function main() {
  const signup = await fetch(`${BASE}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Qoder Turn", email, password })
  });
  console.log("signup:", signup.status);
  const cookie = (signup.headers.getSetCookie?.() ?? []).map(c => c.split(";")[0]).join("; ");
  if (!cookie) {
    console.log("no session cookie returned, aborting");
    return;
  }

  async function send(label, body) {
    const started = Date.now();
    const res = await fetch(`${BASE}/api/chat/vups-v3-galax`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", Cookie: cookie },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    console.log(`\n=== ${label}`);
    console.log("HTTP", res.status, "|", res.headers.get("content-type"), "|", Date.now() - started, "ms");
    if (!res.ok) {
      console.log("body:", text.slice(0, 900));
      return null;
    }
    let conversationId = "";
    let answer = "";
    const events = [];
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      let json;
      try {
        json = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      if (json.type) events.push(json.type);
      if (json.type === "delta") answer += json.content ?? "";
      if (json.type === "meta" || json.type === "done" || json.type === "error") {
        if (json.conversationId) conversationId = json.conversationId;
      }
      if (json.type === "error") {
        console.log("ERROR EVENT:", JSON.stringify(json).slice(0, 700));
      }
    }
    console.log("event kinds:", [...new Set(events)].join(",") || "(none)");
    console.log("answer:", JSON.stringify(answer.slice(0, 160)));
    console.log("conversationId:", conversationId || "(none)");
    console.log("raw tail:", JSON.stringify(text.slice(-400)));
    return conversationId;
  }

  const turn1 = await send("turn 1 (fresh)", {
    model: "vups-v3-galax",
    stream: true,
    messages: [{ role: "user", content: "Reply with exactly: VupsRouter works." }]
  });

  const messages = [
    { role: "user", content: "Reply with exactly: VupsRouter works." },
    { role: "assistant", content: "VupsRouter works." },
    { role: "user", content: "hii" }
  ];

  await send("turn 2 with conversationId", { model: "vups-v3-galax", stream: true, conversationId: turn1, messages });
  await send("turn 2 without conversationId", { model: "vups-v3-galax", stream: true, messages });
}

main().catch(error => console.log("fatal:", error?.name, error?.message, error?.cause));
