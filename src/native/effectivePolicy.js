// The selector states what a chat asked for. The native layer decides what local
// tools may do right now, so the page compares the two before treating local
// access as available. A mode nobody can see the effect of is worse than a mode
// that says it is not running.

const MODE_LABELS = {
  ask: "Ask me every time",
  workspace: "Agent (workspace)",
  full: "Full access"
};

function askedLabel(mode) {
  return MODE_LABELS[mode] || "requested mode";
}

export function effectivePolicyProblem(
  status,
  { owner = "", mode = "", workspaceId = "" } = {}
) {
  if (!owner) return "";
  if (!status || typeof status !== "object") {
    return "The Windows app reported no file access mode, so this chat has no local tools.";
  }
  if (status.owner !== owner) {
    return (
      "The file access mode in this Windows app belongs to another account, so local tools are " +
      `closed for ${askedLabel(mode)} until this account installs its own mode.`
    );
  }
  if (status.mode !== mode) {
    return (
      `This Windows app is running ${status.label || status.mode || "no mode"}, not the ` +
      `${askedLabel(mode)} this chat selected.`
    );
  }
  if (mode === "workspace" && workspaceId && !status.workspaceRoot) {
    return (
      "The project folder for this chat could not be resolved, so Agent (workspace) has no folder " +
      "to stay inside and every local file call is blocked."
    );
  }
  return "";
}
