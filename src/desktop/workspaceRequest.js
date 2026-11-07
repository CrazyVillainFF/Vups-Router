/* Deciding whether a chat message is a project task — and which folder it means —
   is the part users notice when it is wrong: interrupted trivial questions on one
   side, an agent writing into the wrong directory on the other. Everything here is
   pure so the rules can be tested without a DOM or a filesystem. */

const ACTION_WORDS =
  /\b(build|create|make|set\s?up|scaffold|generate|start|write|implement|add|edit|refactor|fix|change|update|deploy|run|test|debug|install)\b/i;

const CODE_SURFACE =
  /\b(project|workspace|app|application|website|site|landing\s?page|folder|file|repository|repo|code|script|component|page|route|form|api|backend|frontend|server|database|schema|styles|layout|html|css|javascript|typescript|python|react|next|vue|svelte|node|npm|package\.json|main\.rs|\w+\.(jsx?|tsx?|py|rs|go|java|php|rb|cs|md|json|ya?ml|toml|sql|sh|ps1|bat|html|css))\b/i;

// A trivial question must never be interrupted by a folder dialog, so wording that
// only asks about code is excluded even when it matches the rules above.
const NON_TASK =
  /^\s*(hi|hello|hey|yo|thanks|thank\s+you|ok(ay)?|good|nice|who\s+are\s+you|what\s+can\s+you\s+do|test(ing)?|ping)\b[\s!.]*$/i;

const QUESTION_ABOUT =
  /^\s*(what|why|how\s+(do|does|can|should)\s+i|explain|define|describe|meaning\s+of|difference\s+between|is\s+it\s+possible)\b/i;

const WINDOWS_NAME_CHARS = /[\\/:*?"<>|]/;

const RESERVED_DEVICE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9"
]);

export const MAX_PROJECT_NAME_CHARS = 60;

// Mirrors `validate_segment` in src-tauri/src/workspace.rs. The native command is
// the authority; this copy exists so the dialog can say "that name will not work"
// before the user waits for a round trip.
export function validateProjectName(name) {
  const trimmed = String(name || "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
  if (!trimmed) return "Enter a project name.";
  if (trimmed.length > MAX_PROJECT_NAME_CHARS) {
    return `Keep the name to ${MAX_PROJECT_NAME_CHARS} characters or fewer.`;
  }
  if (trimmed === "." || trimmed === "..") return "That name is reserved.";
  if (WINDOWS_NAME_CHARS.test(trimmed)) return 'A name cannot contain \\ / : * ? " < > |.';
  if (/[\u0000-\u001f]/.test(trimmed)) return "A name cannot contain control characters.";
  if (/[. ]$/.test(trimmed)) return "A name cannot end with a dot or a space.";
  if (RESERVED_DEVICE_NAMES.has(trimmed.split(".")[0].toLowerCase())) {
    return "Windows reserves that name.";
  }
  return "";
}

// Drive-letter paths first, then a UNC share. The tail stops at characters that
// cannot appear in a Windows name, so "Open C:\proj\app, run it" still matches.
const WINDOWS_PATH = /(?:[A-Za-z]:[\\/]|\\\\)[^\r\n"*<>|]*/;

const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

// A path typed in chat is the one input that must be honoured exactly, so it is
// reported as its own decision rather than folded into the keyword heuristic.
export function extractFolderPath(text) {
  const match = String(text || "").match(WINDOWS_PATH);
  if (!match) return "";
  let candidate = match[0].trim();
  candidate = candidate.replace(TRAILING_PUNCTUATION, "");
  // A backslash that ends the match is almost always the sentence's punctuation.
  candidate = candidate.replace(/\\$/, "");
  if (candidate.length < 3) return "";
  if (candidate.startsWith("\\\\")) {
    const parts = candidate.slice(2).split(/[\\/]/).filter(Boolean);
    return parts.length >= 2 ? candidate : "";
  }
  const tail = candidate.slice(2);
  return tail.trim() ? candidate : "";
}

// A path typed in the middle of a sentence keeps running to the end of that
// sentence, because Windows folder names may contain spaces. The folder the user
// meant is the longest prefix of what they typed that actually exists, so the
// caller is handed the candidates longest-first and opens the first one the
// native layer can verify. Nothing outside the typed text is ever tried.
const MAX_PATH_CANDIDATES = 6;

export function pathCandidates(text) {
  const full = extractFolderPath(text);
  if (!full) return [];
  const candidates = [];
  const remember = value => {
    const cleaned = value.replace(TRAILING_PUNCTUATION, "").replace(/\\$/, "").trim();
    if (cleaned.length >= 3 && !candidates.includes(cleaned)) candidates.push(cleaned);
  };
  remember(full);
  let trimmed = full;
  for (;;) {
    const cut = trimmed.lastIndexOf(" ");
    if (cut <= 1) break;
    trimmed = trimmed.slice(0, cut);
    remember(trimmed);
    if (candidates.length >= MAX_PATH_CANDIDATES) break;
  }
  return candidates;
}

export function looksLikeProjectTask(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;
  if (NON_TASK.test(trimmed)) return false;
  if (extractFolderPath(trimmed)) return true;
  if (QUESTION_ABOUT.test(trimmed)) return false;
  if (!ACTION_WORDS.test(trimmed)) return false;
  return CODE_SURFACE.test(trimmed);
}

const FILLER_WORDS = new Set([
  "a",
  "an",
  "the",
  "me",
  "my",
  "our",
  "you",
  "your",
  "please",
  "pls",
  "build",
  "create",
  "make",
  "set",
  "up",
  "scaffold",
  "generate",
  "start",
  "write",
  "implement",
  "add",
  "edit",
  "refactor",
  "fix",
  "change",
  "update",
  "deploy",
  "run",
  "test",
  "debug",
  "install",
  "new",
  "simple",
  "small",
  "basic",
  "working",
  "complete",
  "full",
  "for",
  "to",
  "of",
  "in",
  "on",
  "with",
  "that",
  "this",
  "into",
  "from",
  "and",
  "or",
  "it",
  "them"
]);

function titleWord(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// The suggested name is a starting point the user can edit, never a silent
// decision: if nothing readable survives the cleaning it returns "" and the
// dialog asks instead.
export function suggestProjectName(text) {
  const path = extractFolderPath(text);
  if (path) {
    const segments = path.split(/[\\/]+/).filter(Boolean);
    const leaf = segments[segments.length - 1] || "";
    const cleaned = leaf.replace(WINDOWS_NAME_CHARS, "").replace(/[. ]+$/, "");
    if (cleaned && !validateProjectName(cleaned)) return cleaned;
  }
  const words = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s.-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter(word => !FILLER_WORDS.has(word))
    .filter(word => !/^[.-]|[.-]$/.test(word) || word.length > 3)
    .slice(0, 4);
  if (!words.length) return "";
  const candidate = words.map(titleWord).join(" ");
  return validateProjectName(candidate) ? "" : candidate;
}

export function projectTaskReason(text) {
  if (extractFolderPath(text)) return "path";
  if (looksLikeProjectTask(text)) return "task";
  return "";
}
