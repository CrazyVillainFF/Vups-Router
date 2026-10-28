import { extractCodeFiles } from "./codeFiles.js";

export const HANDOFF_LIMITS = {
  maxChars: 6000,
  maxUserMessages: 6,
  maxAssistantMessages: 4,
  maxGoalChars: 1200,
  maxRequirementChars: 400,
  maxDetailChars: 600
};

function cleanText(content, limit) {
  const text = String(content || "")
    .replace(/\r\n?/g, "\n")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/^FILE:\s*\S+\s*$/gim, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).replace(/\s+\S*$/, "")}…`;
}

function listArtifacts(messages) {
  const seen = new Set();
  const rows = [];
  for (const message of messages) {
    const artifact = message?.artifact;
    if (!artifact || !Array.isArray(artifact.files)) continue;
    for (const file of artifact.files) {
      if (!file?.path || seen.has(file.path)) continue;
      seen.add(file.path);
      rows.push(
        `- ${file.path} (${file.language || "text"}, ${file.complete === false ? "incomplete" : "complete"})`
      );
    }
    for (const file of extractCodeFiles(message.content || "", { includeUnclosed: true })) {
      if (!file.path || seen.has(file.path)) continue;
      seen.add(file.path);
      rows.push(`- ${file.path} (${file.language || "text"})`);
    }
  }
  return rows.slice(0, 40);
}

export function buildContextHandoff(messages, { model = "", title = "" } = {}) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const users = safeMessages.filter(message => message.role === "user" && cleanText(message.content, 80));
  const assistants = safeMessages.filter(message => message.role === "assistant" && cleanText(message.content, 80));
  const goal = cleanText(users[0]?.content, HANDOFF_LIMITS.maxGoalChars);
  const requirements = users
    .slice(1)
    .slice(-HANDOFF_LIMITS.maxUserMessages)
    .map((message, index) => `${index + 1}. ${cleanText(message.content, HANDOFF_LIMITS.maxRequirementChars)}`)
    .filter(row => !row.endsWith(". "));
  const details = assistants
    .slice(-HANDOFF_LIMITS.maxAssistantMessages)
    .map((message, index) => `${index + 1}. ${cleanText(message.content, HANDOFF_LIMITS.maxDetailChars)}`)
    .filter(row => !row.endsWith(". "));
  const constraints = users
    .flatMap(message => String(message.content || "").split(/(?<=[.!?])\s+|\n+/))
    .map(line => line.trim())
    .filter(line => /\b(?:must|do not|don't|never|always|only|avoid|required|constraint)\b/i.test(line))
    .slice(0, 6)
    .map(line => `- ${cleanText(line, 260)}`);
  const files = listArtifacts(safeMessages);
  const incomplete = safeMessages.some(
    message =>
      message?.truncated ||
      (Array.isArray(message?.artifact?.files) && message.artifact.files.some(file => file.complete === false))
  );
  const errors = safeMessages
    .filter(message => message.role === "error")
    .slice(-3)
    .map(message => `- ${cleanText(message.content, 220)}`);

  const nextSteps = incomplete
    ? "Continue the unfinished response or incomplete file from the previous chat, preserving completed work."
    : "Continue the user's most recent request. Ask only for information that is genuinely missing.";

  const sections = [
    "Context carried over from a previous VupsRouter chat that reached the model's context limit.",
    "",
    `Previous conversation: ${title || "Untitled chat"}`,
    `Selected model: ${model || "the previously selected model"}`,
    "",
    "Goal:",
    goal || "Continue the previous work.",
    "",
    "Requirements and preferences:",
    requirements.length ? requirements.join("\n") : "- Preserve the previously stated requirements.",
    "",
    "Decisions and technical context:",
    details.length ? details.join("\n") : "- No assistant summary was available.",
    "",
    "Files and artifacts from the previous chat:",
    files.length ? files.join("\n") : "- No generated files were recorded.",
    "",
    "Constraints:",
    constraints.length ? constraints.join("\n") : "- Preserve the previous instructions and do not repeat completed work.",
    "",
    "Current status:",
    incomplete ? "The previous response or generated files were incomplete." : "The previous task was in progress.",
    ...(errors.length ? ["", "Recent errors:", ...errors] : []),
    "",
    "Next steps:",
    nextSteps
  ];

  let handoff = sections.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (handoff.length > HANDOFF_LIMITS.maxChars) {
    handoff = `${handoff.slice(0, HANDOFF_LIMITS.maxChars).replace(/\s+\S*$/, "")}\n\n[Handoff truncated to stay within the new chat's context window.]`;
  }
  return handoff;
}

export function handoffTitle(messages, fallback = "Continued chat") {
  const first = Array.isArray(messages) ? messages.find(message => message.role === "user" && cleanText(message.content, 10)) : null;
  const base = cleanText(first?.content, 90).replace(/[.!?]+$/, "");
  return (base ? `${base} (continued)` : fallback).slice(0, 120);
}
