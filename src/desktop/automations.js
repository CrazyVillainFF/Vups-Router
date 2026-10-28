export const AUTOMATION_SCHEDULES = Object.freeze([
  { value: "manual", label: "Manual only" },
  { value: "daily", label: "Every day (not scheduled)" },
  { value: "weekdays", label: "Weekdays (not scheduled)" }
]);

const MAX_NAME_CHARS = 80;
const MAX_PROMPT_CHARS = 4000;

export function automationStorageKey(owner) {
  return `vupsrouter.desktop.automations.${owner || "guest"}.v1`;
}

export function createAutomationId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `automation-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function validTime(value) {
  if (!/^\d{2}:\d{2}$/.test(value || "")) return false;
  const [hours, minutes] = value.split(":").map(Number);
  return hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60;
}

export function normalizeAutomation(value) {
  const source = value && typeof value === "object" ? value : {};
  const schedule = AUTOMATION_SCHEDULES.some(item => item.value === source.schedule)
    ? source.schedule
    : "manual";
  return {
    id: typeof source.id === "string" && source.id ? source.id : createAutomationId(),
    name: String(source.name || "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS),
    prompt: String(source.prompt || "").trim().slice(0, MAX_PROMPT_CHARS),
    schedule,
    time: validTime(source.time) ? source.time : "09:00",
    createdAt: typeof source.createdAt === "string" ? source.createdAt : new Date().toISOString(),
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : new Date().toISOString()
  };
}

export function automationError({ name, prompt }) {
  if (!String(name || "").trim()) return "Enter a name for this automation.";
  if (!String(prompt || "").trim()) return "Enter the task to run.";
  if (String(prompt).length > MAX_PROMPT_CHARS) return `Task text must be ${MAX_PROMPT_CHARS} characters or fewer.`;
  return "";
}

export function loadAutomations(storage, owner) {
  if (!storage) return [];
  try {
    const stored = storage.getItem(automationStorageKey(owner));
    const list = stored ? JSON.parse(stored) : [];
    return Array.isArray(list) ? list.map(normalizeAutomation).filter(item => item.name && item.prompt) : [];
  } catch {
    return [];
  }
}

export function saveAutomations(storage, owner, automations) {
  const list = Array.isArray(automations)
    ? automations.map(normalizeAutomation).filter(item => item.name && item.prompt)
    : [];
  if (storage) {
    try {
      storage.setItem(automationStorageKey(owner), JSON.stringify(list));
    } catch {
      /* storage is best-effort */
    }
  }
  return list;
}
