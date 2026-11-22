/* Whether a chat request may reach a native tool at all.

   The model decides *which* tool to call; this module decides whether a tool may
   be called for this request. It is deterministic and pure so the same sentence
   always produces the same decision with no model, no DOM and no filesystem, and
   so the rule can be tested directly instead of through a whole agent run.

   Three intents:
   - "none"    nothing was asked of the machine: no tool at all runs.
   - "inspect" the request only asks about something: reading is allowed, but
               nothing may be started and nothing may be changed.
   - "action"  the request asks for work: every tool the app offers is allowed.
*/

import { extractFolderPath } from "../desktop/workspaceRequest.js";

/** Tools that start a program or change what is on disk. */
export const EXECUTION_TOOLS = Object.freeze([
  "open_terminal",
  "run_command",
  "start_command",
  "stop_command",
  "launch_app",
  "close_app",
  "write_file",
  "append_file",
  "edit_file",
  "delete_path",
  "create_directory"
]);

const EXECUTION_TOOL_SET = new Set(EXECUTION_TOOLS);

// Chit-chat and acknowledgements. `hi+` covers "hi", "hii", "heyyy"; the whole
// string must be the greeting, so "hi, open notepad" is not small talk.
const SMALL_TALK =
  /^(?:(?:hi+|hey+|helo+|hello+|yo+)(?:\s+(?:there|all|everyone|guys))?|how\s+are\s+(?:you|things|it\s+going)|hola|ola|howdy|sup|good\s+(?:morning|afternoon|evening|night)|gm|gn|thanks?|thank\s+you|thx|ty|ok(?:ay)?|sure|yeah|yep|nope|yes|no|bye+|goodbye|later|test(?:ing)?|ping|who\s+are\s+you|what\s+can\s+you\s+do|help|please|go\s+ahead|appreciate\s+it)\b[\s!.?,]*$/i;

// A question or an explanation. These are answered with words; they are not a
// instruction to touch the machine.
const QUESTION_OR_EXPLANATION =
  /^(?:what|why|when|where|which|who|whose|whom|explain|define|describe|compare|contrast|analy[sz]e|discuss|summari[sz]e|calculate|solve|meaning\s+of|difference\s+between|trade[- ]offs?|is\s+it\s+possible|help\s+me\s+(?:understand|explain|figure\s+out|grasp|know)|tell\s+me\s+(?:about|what|how|why|whether|if)|walk\s+me\s+through|show\s+me\s+(?:how|why|what)|how\s+(?:do|does|did|can|should|would|is|are|to)|can\s+you\s+(?:explain|describe|define|tell|walk|show|help|clarify)|could\s+you\s+(?:explain|describe|tell|show))\b/i;

// Asking for code to read is ordinary coding: the answer belongs in the chat,
// not in a file the user never named.
const CODE_GENERATION =
  /^(?:write|create|make|generate|build|add|implement|program|code|draft|compose|design|give\s+me|show\s+me|come\s+up\s+with)\b/i;

// Something that exists on this PC the request is about. Only a request that
// names one of these — or a path the user typed — may reach the disk at all.
// Code concepts (api, component, styles) are deliberately absent: naming one
// means the answer is code to read, not a file to touch.
const DISK_TARGET =
  /\b(?:files?|folders?|directories|directory|projects?|workspace|repos?|repository|codebase|paths?|drive|disk|documents?|downloads?|desktop)\b/i;

function hasDiskTarget(text) {
  if (extractFolderPath(text)) return true;
  return DISK_TARGET.test(text);
}

/**
 * Classifies a request. `text` is the message the user actually typed for this
 * turn; an empty request has no intent and nothing may run for it.
 */
export function classifyRequestIntent(text) {
  const request = String(text || "").trim();
  if (!request) return "none";
  if (SMALL_TALK.test(request)) return "none";
  const target = hasDiskTarget(request);
  if (QUESTION_OR_EXPLANATION.test(request)) return target ? "inspect" : "none";
  if (CODE_GENERATION.test(request)) return target ? "action" : "none";
  return "action";
}

/** True when some tool may run for this request at all. */
export function requestAllowsTools(text) {
  return classifyRequestIntent(text) !== "none";
}

/** True when this specific tool may run for this request. */
export function toolAllowedForRequest(tool, text) {
  const intent = classifyRequestIntent(text);
  if (intent === "none") return false;
  if (intent === "inspect") return !EXECUTION_TOOL_SET.has(String(tool || ""));
  return true;
}

/** The refusal the model is shown instead of a native call that must not happen. */
export function toolDenial(tool, text) {
  const intent = classifyRequestIntent(text);
  return {
    code: "not_requested",
    message:
      intent === "inspect"
        ? `"${String(tool || "that tool")}" was not run: this message only asks a question, so nothing was started and nothing was changed.`
        : `"${String(tool || "that tool")}" was not run: this message does not ask for any action on this PC. Answer the request in chat instead.`
  };
}

/** Signature of one attempt, used to stop a failed call being made twice. */
export function toolCallSignature(tool, args) {
  let encoded;
  try {
    const keys = args && typeof args === "object" && !Array.isArray(args) ? Object.keys(args).sort() : [];
    const ordered = {};
    for (const key of keys) ordered[key] = args[key];
    encoded = JSON.stringify(ordered ?? null);
  } catch {
    encoded = String(args);
  }
  return `${String(tool || "")}:${encoded}`;
}
