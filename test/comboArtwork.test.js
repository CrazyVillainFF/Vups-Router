import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { artworkStyle, providerArtwork } from "../src/combo/comboArtwork.js";

function publicFile(src) {
  return fileURLToPath(new URL(`../public${src}`, import.meta.url));
}

test("known providers resolve to authentic bundled logo files", () => {
  const cases = [
    ["Anthropic", "anthropic"],
    ["Google Gemini", "googlegemini"],
    ["DeepSeek", "deepseek"],
    ["Meta", "meta"],
    ["Mistral AI", "mistralai"],
    ["Qwen", "qwen"],
    ["OpenRouter", "openrouter"],
    ["Ollama", "ollama"],
    ["NVIDIA", "nvidia"],
    ["GitHub Copilot", "githubcopilot"]
  ];
  for (const [provider, id] of cases) {
    const art = providerArtwork({ provider });
    assert.equal(art.type, "logo", `${provider} should use a logo`);
    assert.equal(art.id, id);
    assert.match(art.src, /^\/model-logos\/[a-z]+\.svg$/);
    assert.ok(existsSync(publicFile(art.src)), `${art.src} must exist`);
    assert.match(artworkStyle(art)["--combo-art-url"], /model-logos/);
  }
});

test("providers without a bundled mark use a designed wordmark, never a fake logo", () => {
  for (const provider of ["OpenAI", "xAI", "Groq", "Together AI", "Cohere"]) {
    const art = providerArtwork({ provider });
    assert.equal(art.type, "wordmark");
    assert.equal(art.src, null);
    assert.ok(art.wordmark.length > 0);
    assert.equal(artworkStyle(art)["--combo-art-url"], undefined);
  }
  assert.equal(providerArtwork({ provider: "OpenAI" }).wordmark, "OpenAI");
  assert.equal(providerArtwork({ provider: "xAI" }).wordmark, "xAI");
});

test("model identifiers can select provider artwork when the provider is generic", () => {
  assert.equal(providerArtwork({ provider: "Custom gateway", model: "claude-sonnet-4" }).id, "anthropic");
  assert.equal(providerArtwork({ provider: "Custom gateway", model: "llama-3.3-70b" }).id, "meta");
  assert.equal(providerArtwork({ provider: "Custom gateway", model: "gemini-2.5-pro" }).id, "googlegemini");
  assert.equal(providerArtwork({ provider: "Custom gateway", model: "gpt-5" }).id, "openai");
});

test("Vups models use the real VupsRouter brand image", () => {
  const art = providerArtwork({ kind: "vups", provider: "Vups", model: "vups-v3-galax" });
  assert.equal(art.type, "image");
  assert.equal(art.src, "/vups-logo.png");
  assert.ok(existsSync(publicFile("/vups-logo.png")));
  assert.equal(artworkStyle(art)["--combo-art-url"], undefined);
});

test("unknown providers fall back to a truncated provider wordmark", () => {
  const art = providerArtwork({ provider: "Acme Super Long Provider Name" });
  assert.equal(art.type, "wordmark");
  assert.equal(art.id, "fallback");
  assert.equal(art.wordmark.length, 16);
  assert.ok(art.wordmark.endsWith("…"));
  /* Fallback wordmarks use a semantic token that resolves to --muted in CSS; no hexes allowed. */
  assert.equal(artworkStyle(art)["--combo-art-color"], "var(--muted)");

  const empty = providerArtwork({});
  assert.equal(empty.type, "wordmark");
  assert.equal(empty.wordmark, "Model");
});

test("every bundled logo referenced by the artwork map exists on disk", () => {
  const providers = [
    "Anthropic",
    "Google Gemini",
    "Meta",
    "Mistral AI",
    "DeepSeek",
    "Qwen",
    "Alibaba Cloud",
    "OpenRouter",
    "Ollama",
    "Hugging Face",
    "NVIDIA",
    "Perplexity",
    "Moonshot AI",
    "GitHub Copilot"
  ];
  for (const provider of providers) {
    const art = providerArtwork({ provider });
    assert.equal(art.type, "logo", `${provider} should have a bundled logo`);
    assert.ok(existsSync(publicFile(art.src)), `${provider} logo missing: ${art.src}`);
  }
});
