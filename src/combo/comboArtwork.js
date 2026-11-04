const LOGO_BASE = "/model-logos/";
const ACCENT = "var(--accent)";
const NEUTRAL = "var(--muted)";

const LOGOS = {
  anthropic: { name: "Anthropic", src: `${LOGO_BASE}anthropic.svg`, color: "#d97757" }, /* brand: third-party identity */
  googlegemini: { name: "Google Gemini", src: `${LOGO_BASE}googlegemini.svg`, color: "#8ab4f8" }, /* brand: third-party identity */
  meta: { name: "Meta", src: `${LOGO_BASE}meta.svg`, color: "#4d8bff" }, /* brand: third-party identity */
  mistralai: { name: "Mistral AI", src: `${LOGO_BASE}mistralai.svg`, color: "#fa520f" }, /* brand: third-party identity */
  deepseek: { name: "DeepSeek", src: `${LOGO_BASE}deepseek.svg`, color: "#6a86ff" }, /* brand: third-party identity */
  qwen: { name: "Qwen", src: `${LOGO_BASE}qwen.svg`, color: "#8b7cf6" }, /* brand: third-party identity */
  alibabacloud: { name: "Alibaba Cloud", src: `${LOGO_BASE}alibabacloud.svg`, color: "#ff8a3d" }, /* brand: third-party identity */
  openrouter: { name: "OpenRouter", src: `${LOGO_BASE}openrouter.svg`, color: "#a5b4fc" }, /* brand: third-party identity */
  ollama: { name: "Ollama", src: `${LOGO_BASE}ollama.svg`, color: "#e5e7eb" }, /* brand: third-party identity */
  huggingface: { name: "Hugging Face", src: `${LOGO_BASE}huggingface.svg`, color: "#ffd21e" }, /* brand: third-party identity */
  nvidia: { name: "NVIDIA", src: `${LOGO_BASE}nvidia.svg`, color: "#76b900" }, /* brand: third-party identity */
  perplexity: { name: "Perplexity", src: `${LOGO_BASE}perplexity.svg`, color: "#54c8d8" }, /* brand: third-party identity */
  moonshotai: { name: "Moonshot AI", src: `${LOGO_BASE}moonshotai.svg`, color: "#9db8ff" }, /* brand: third-party identity */
  githubcopilot: { name: "GitHub Copilot", src: `${LOGO_BASE}githubcopilot.svg`, color: "#c7cdd6" } /* brand: third-party identity */
};

const WORDMARKS = {
  openai: { name: "OpenAI", wordmark: "OpenAI", color: "#e7edf7" }, /* brand: third-party identity */
  xai: { name: "xAI", wordmark: "xAI", color: "#e7edf7" }, /* brand: third-party identity */
  groq: { name: "Groq", wordmark: "Groq", color: "#f5a97f" }, /* brand: third-party identity */
  together: { name: "Together AI", wordmark: "Together", color: "#9eb6ff" }, /* brand: third-party identity */
  fireworks: { name: "Fireworks AI", wordmark: "Fireworks", color: "#ffb86b" }, /* brand: third-party identity */
  microsoft: { name: "Microsoft", wordmark: "Microsoft", color: "#a9c3e8" }, /* brand: third-party identity */
  amazon: { name: "Amazon", wordmark: "Amazon", color: "#ffb86b" }, /* brand: third-party identity */
  ibm: { name: "IBM", wordmark: "IBM", color: "#a5b4fc" }, /* brand: third-party identity */
  cohere: { name: "Cohere", wordmark: "Cohere", color: "#d9b8ff" }, /* brand: third-party identity */
  zhipu: { name: "Zhipu AI", wordmark: "Zhipu", color: "#8fd3ff" }, /* brand: third-party identity */
  minimax: { name: "MiniMax", wordmark: "MiniMax", color: "#ffb0c8" }, /* brand: third-party identity */
  stepfun: { name: "StepFun", wordmark: "StepFun", color: "#8fe0c8" }, /* brand: third-party identity */
  cerebras: { name: "Cerebras", wordmark: "Cerebras", color: "#ffcf8a" }, /* brand: third-party identity */
  sambanova: { name: "SambaNova", wordmark: "SambaNova", color: "#a4e0b8" }, /* brand: third-party identity */
  deepinfra: { name: "DeepInfra", wordmark: "DeepInfra", color: "#b6c6e3" }, /* brand: third-party identity */
  hyperbolic: { name: "Hyperbolic", wordmark: "Hyperbolic", color: "#b8b1ff" }, /* brand: third-party identity */
  nebius: { name: "Nebius", wordmark: "Nebius", color: "#a8c8ff" }, /* brand: third-party identity */
  parasail: { name: "Parasail", wordmark: "Parasail", color: "#8fd3c8" }, /* brand: third-party identity */
  kilo: { name: "Kilo Gateway", wordmark: "Kilo", color: "#b7f08a" }, /* brand: third-party identity */
  qoder: { name: "Qoder", wordmark: "Qoder", color: "#8fd3ff" }, /* brand: third-party identity */
  novita: { name: "Novita AI", wordmark: "Novita", color: "#b6c6e3" }, /* brand: third-party identity */
  cloudflare: { name: "Cloudflare", wordmark: "Cloudflare", color: "#f4a261" }, /* brand: third-party identity */
  ai21: { name: "AI21 Labs", wordmark: "AI21", color: "#c7b8ff" }, /* brand: third-party identity */
  vllm: { name: "vLLM", wordmark: "vLLM", color: "#a8c8ff" }, /* brand: third-party identity */
  localai: { name: "LocalAI", wordmark: "LocalAI", color: "#9fd8c8" }, /* brand: third-party identity */
  lmstudio: { name: "LM Studio", wordmark: "LM Studio", color: "#b8c8e8" }, /* brand: third-party identity */
  litellm: { name: "LiteLLM", wordmark: "LiteLLM", color: "#b0c4ff" }, /* brand: third-party identity */
  omniroute: { name: "OmniRoute", wordmark: "OmniRoute", color: "#a8d8ff" }, /* brand: third-party identity */
  portkey: { name: "Portkey", wordmark: "Portkey", color: "#c8b8ff" }, /* brand: third-party identity */
  vercel: { name: "Vercel AI Gateway", wordmark: "Vercel", color: "#e7edf7" }, /* brand: third-party identity */
  requesty: { name: "Requesty", wordmark: "Requesty", color: "#b8e0c8" }, /* brand: third-party identity */
  agentrouter: { name: "AgentRouter", wordmark: "AgentRouter", color: "#a8c8ff" }, /* brand: third-party identity */
  opencode: { name: "OpenCode Zen", wordmark: "OpenCode", color: "#c8d8e8" }, /* brand: third-party identity */
  flagshiprouter: { name: "FlagshipRouter", wordmark: "Flagship", color: "#b8c8ff" }, /* brand: third-party identity */
  vups: { name: "Vups", wordmark: "Vups", color: ACCENT }
};

const SIGNALS = [
  { id: "githubcopilot", test: /copilot|github/i },
  { id: "anthropic", test: /anthropic|claude/i },
  { id: "googlegemini", test: /gemini|google|bard|palm/i },
  { id: "ollama", test: /ollama/i },
  { id: "meta", test: /\bmeta\b|\bllama/i },
  { id: "mistralai", test: /mistral|mixtral|codestral|magistral/i },
  { id: "deepseek", test: /deepseek/i },
  { id: "qwen", test: /qwen|tongyi|qwq/i },
  { id: "alibabacloud", test: /alibaba|dashscope/i },
  { id: "openrouter", test: /openrouter/i },
  { id: "huggingface", test: /hugging ?face|hf\.co/i },
  { id: "nvidia", test: /nvidia|nemotron/i },
  { id: "perplexity", test: /perplexity|sonar/i },
  { id: "moonshotai", test: /moonshot|kimi/i },
  { id: "openai", test: /openai|chatgpt|(^|[^a-z])gpt[-.\d]|(^|[^a-z])o[134]([^a-z0-9]|$)/i },
  { id: "xai", test: /\bxai\b|grok/i },
  { id: "groq", test: /\bgroq\b/i },
  { id: "together", test: /together/i },
  { id: "fireworks", test: /fireworks/i },
  { id: "microsoft", test: /microsoft|azure|\bphi-?\d/i },
  { id: "amazon", test: /amazon|bedrock|nova/i },
  { id: "ibm", test: /\bibm\b|granite/i },
  { id: "cohere", test: /cohere|command[- ]?[ar]/i },
  { id: "zhipu", test: /zhipu|glm-?\d/i },
  { id: "minimax", test: /minimax|abab/i },
  { id: "stepfun", test: /stepfun|step-\d/i },
  { id: "cerebras", test: /cerebras/i },
  { id: "sambanova", test: /samba ?nova/i },
  { id: "deepinfra", test: /deepinfra/i },
  { id: "hyperbolic", test: /hyperbolic/i },
  { id: "nebius", test: /nebius/i },
  { id: "parasail", test: /parasail/i },
  { id: "kilo", test: /kilo/i },
  { id: "qoder", test: /qoder/i },
  { id: "novita", test: /novita/i },
  { id: "cloudflare", test: /cloudflare/i },
  { id: "ai21", test: /\bai21\b/i },
  { id: "vllm", test: /\bvllm\b/i },
  { id: "localai", test: /\blocalai\b|\blocal ai\b/i },
  { id: "lmstudio", test: /\blm ?studio\b/i },
  { id: "litellm", test: /litellm/i },
  { id: "omniroute", test: /omniroute/i },
  { id: "portkey", test: /portkey/i },
  { id: "vercel", test: /vercel/i },
  { id: "requesty", test: /requesty/i },
  { id: "agentrouter", test: /agentrouter/i },
  { id: "opencode", test: /opencode/i },
  { id: "flagshiprouter", test: /flagship/i },
  { id: "vups", test: /\bvups\b|vups-v3/i }
];

function detectId(text) {
  const value = String(text || "");
  if (!value.trim()) return null;
  for (const signal of SIGNALS) {
    if (signal.test.test(value)) return signal.id;
  }
  return null;
}

function shortWordmark(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "Model";
  return text.length > 16 ? `${text.slice(0, 15)}…` : text;
}

export function providerArtworkById(id) {
  const key = String(id || "").trim().toLowerCase();
  if (!key) return null;
  if (key === "vups") {
    return {
      id: "vups",
      name: "Vups",
      type: "image",
      src: "/vups-logo.png",
      color: ACCENT,
      wordmark: null
    };
  }
  if (LOGOS[key]) {
    return { id: key, name: LOGOS[key].name, type: "logo", src: LOGOS[key].src, color: LOGOS[key].color, wordmark: null };
  }
  if (WORDMARKS[key]) {
    return {
      id: key,
      name: WORDMARKS[key].name,
      type: "wordmark",
      src: null,
      color: WORDMARKS[key].color,
      wordmark: WORDMARKS[key].wordmark
    };
  }
  return null;
}

export function providerArtwork({ provider, model, label, kind } = {}) {
  if (kind === "vups" || detectId(provider) === "vups") {
    return providerArtworkById("vups");
  }
  const id = detectId(provider) || detectId(label) || detectId(model);
  const known = id ? providerArtworkById(id) : null;
  if (known) return known;
  const fallback = shortWordmark(provider || label || model);
  return {
    id: "fallback",
    name: String(provider || label || model || "Model"),
    type: "wordmark",
    src: null,
    color: NEUTRAL,
    wordmark: fallback
  };
}

export function artworkStyle(art) {
  if (!art) return undefined;
  return {
    "--combo-art-color": art.color || NEUTRAL,
    ...(art.type === "logo" && art.src ? { "--combo-art-url": `url("${art.src}")` } : {})
  };
}
