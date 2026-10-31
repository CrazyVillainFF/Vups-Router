import { desktopToolNames } from "./desktopTools.js";
import { permissionModeInfo } from "./permissions.js";

// Every value here comes from live app state. Nothing is probed, guessed or
// invented, and no credential, token or file body is ever included.
export function toolAccessRows({
  windowsShell = false,
  tauriAvailable = false,
  serverToolEndpoint = true,
  model = "",
  provider = "",
  permissionMode = "ask",
  workspace = null,
  bridgeError = "",
  waitingApprovals = 0
} = {}) {
  const mode = permissionModeInfo(permissionMode);
  const toolNames = desktopToolNames();
  const sessionReady = Boolean(windowsShell && tauriAvailable);
  return {
    toolNames,
    rows: [
      {
        key: "session",
        label: "Desktop session",
        value: sessionReady
          ? "Windows app"
          : windowsShell
            ? "Engine not reachable"
            : "Not available on this platform",
        hint: sessionReady
          ? "Local tools run on this PC through the Windows app."
          : "Local file, app and terminal tools need the Windows desktop app.",
        tone: sessionReady ? "ok" : "off"
      },
      {
        key: "server",
        label: "Server tool endpoint",
        value: serverToolEndpoint ? "Available" : "Missing",
        hint: serverToolEndpoint
          ? "The backend can relay tool calls from any provider."
          : "This server has no local-tool endpoint yet, so turns are sent as plain chat.",
        tone: serverToolEndpoint ? "ok" : "warn"
      },
      {
        key: "model",
        label: "Selected model",
        value: model ? (provider ? `${model} · ${provider}` : model) : "No model selected",
        hint: "Every model and provider uses this same registry; access never depends on the model.",
        tone: model ? "ok" : "off"
      },
      {
        key: "permission",
        label: "Permission mode",
        value: mode.label,
        hint: mode.description,
        tone: mode.id === "full" ? "warn" : "ok"
      },
      {
        key: "workspace",
        label: "Folder for this chat",
        value: workspace?.title || "No folder attached",
        hint: workspace?.path || "Choose a folder in the workspace bar to give this chat real project files.",
        tone: workspace ? "ok" : "off"
      },
      {
        key: "tools",
        label: "Registered tools",
        value: `${toolNames.length} tools`,
        hint: "The same names are offered to every provider.",
        tone: toolNames.length > 0 ? "ok" : "warn"
      },
      {
        key: "approvals",
        label: "Permission cards waiting",
        value: waitingApprovals > 0 ? `${waitingApprovals} waiting` : "None",
        hint: "A waiting card pauses that one tool call; Stop cancels it.",
        tone: waitingApprovals > 0 ? "warn" : "ok"
      },
      {
        key: "failure",
        label: "Last tool problem",
        value: bridgeError || "None this session",
        hint: bridgeError ? "" : "Errors reported by the local engine appear here.",
        tone: bridgeError ? "warn" : "ok"
      }
    ]
  };
}
