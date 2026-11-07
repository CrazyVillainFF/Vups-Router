/* The composer's slash grammar. PromptBar renders the menu and inserts the
   token; this module decides what a submitted token means. Everything here is
   pure so the rules — which are the part users complain about when they are
   wrong — can be tested without a DOM. */

export const SLASH_COMMANDS = [
  {
    key: "github",
    name: "/github",
    description: "Connect GitHub and open your repositories",
    action: "github"
  },
  {
    key: "repo",
    name: "/repo",
    description: "Pick the repository this chat works on",
    action: "repo"
  },
  {
    key: "help",
    name: "/help",
    description: "List the commands this composer understands",
    action: "help"
  }
];

const BY_ACTION = new Map(SLASH_COMMANDS.map(command => [command.action, command]));

// Only a token at the very start of the draft is a command. "/note this" inside
// a sentence, or a path like "C:/project", stays ordinary text.
const LEADING_TOKEN = /^\/([A-Za-z][\w-]*)([\s\S]*)$/;

/* Three outcomes, and the difference between them is the whole point:
   - "none"     not a slash draft at all → send normally.
   - "command"  a known command → run its action, never send the text.
   - "literal"  "/" alone, or a name nobody recognises → the draft is kept or
                sent exactly as typed. An unknown command must not be silently
                eaten, and a bare "/" must not crash or vanish. */
export function classifySlash(rawText) {
  const text = String(rawText ?? "");
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return { kind: "none", text };

  const match = LEADING_TOKEN.exec(trimmed);
  if (!match) {
    // "/", "/ ", "/ 1 + 2": a slash with no command name after it.
    return { kind: "literal", reason: "empty", text };
  }
  const name = `/${match[1].toLowerCase()}`;
  const command = SLASH_COMMANDS.find(entry => entry.name === name);
  if (!command) return { kind: "literal", reason: "unknown", text };
  return { kind: "command", command, args: match[2].trim(), text };
}

export function commandForAction(action) {
  return BY_ACTION.get(action) || null;
}

// The menu PromptBar shows when the draft starts with "/" and a name is typed.
export function slashMenuItems() {
  return SLASH_COMMANDS.map(command => ({
    key: command.key,
    name: command.name,
    description: command.description
  }));
}

/* /help answers in the composer notice strip, not in the transcript: the server
   stores only user and assistant turns, so a locally written "assistant" line
   would be replayed to the model as an answer it never gave. */
export function helpText() {
  return [
    ...SLASH_COMMANDS.map(command => `${command.name} ${command.description}`),
    "Any other text that starts with / is sent to the model exactly as you typed it."
  ].join(" · ");
}
