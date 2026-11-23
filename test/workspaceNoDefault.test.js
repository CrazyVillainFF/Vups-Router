import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const rootSource = read("../src-tauri/src/vups_root.rs");
const toolsSource = read("../src-tauri/src/desktop_tools.rs");
const workspaceSource = read("../src-tauri/src/workspace.rs");
const mainSource = read("../src-tauri/src/main.rs");
const permissions = read("../src-tauri/permissions/workspace.toml");
const remedySource = read("../src/services/desktopChat.js");

// Registering the app-owned folder commands is allowed (they are invoked only
// when the user explicitly selects that folder as a project). The security
// invariant is that an UNBOUND task never silently falls back to them — that
// check lives in the desktop tool policy (see the next test).
test("app-owned folder commands are registered but never used as an implicit fallback", () => {
  assert.match(mainSource, /vups_root_project/, "the command is available for explicit selection");
  assert.match(mainSource, /vups_root_default_workspace/, "the command is available for explicit selection");
});

test("the desktop policy resolves only the selected workspace, for every mode", () => {
  const builder = /pub async fn desktop_tool_set_policy[\s\S]*?\n\}/.exec(toolsSource)[0];
  assert.doesNotMatch(builder, /vups_root::/, "the app's storage folder is never a fallback root");
  assert.match(
    builder,
    /workspace::workspace_path\(&app, &owner, &workspace_id\)/,
    "the id is resolved under the calling owner"
  );
  assert.match(builder, /workspace_error = Some\(message\)/, "an unreadable folder is reported");
  assert.match(
    builder,
    /matches!\(mode, ToolMode::Workspace \| ToolMode::Full\)/,
    "scoped modes without a folder are an error, not a silent grant"
  );
  assert.doesNotMatch(builder, /default_working_directory\(\)/, "no fabricated root is consulted");
});

test("a terminal or command without a project folder refuses and names the cause", () => {
  const resolver = /fn default_working_directory[\s\S]*?\n\}/.exec(toolsSource)[0];
  assert.match(resolver, /policy\.workspace_root\.clone\(\)\.ok_or_else/);
  assert.match(resolver, /"no_workspace"/);
  assert.match(resolver, /No project folder is selected for this chat/);
  assert.match(resolver, /folder, then try again/);
  assert.match(toolsSource, /None => default_working_directory\(policy\)\?/, "a terminal with no cwd uses the project");
  assert.match(
    toolsSource,
    /CommandSpec::parse\(&args, default_working_directory\(policy\)\?\)/,
    "a shell command uses the project"
  );
});

test("validation is owner-scoped and re-checks the real folder", () => {
  const validate = /pub async fn workspace_validate[\s\S]*?\n\}/.exec(workspaceSource)[0];
  assert.match(validate, /normalize_owner\(&owner\)\?/);
  assert.match(validate, /find_workspace\(&store, &owner, id\.trim\(\)\)/);
  assert.match(validate, /canonical_directory\(Path::new\(&workspace\.path\)\)/);
  assert.doesNotMatch(validate, /default|Documents/);
});

test("the remedy text tells the user to choose a folder, not that one was provided", () => {
  assert.match(remedySource, /no_workspace:/);
  assert.match(remedySource, /Choose a project folder, then try again/);
  assert.doesNotMatch(remedySource, /the app never creates a folder for you/);
  assert.doesNotMatch(remedySource, /switch modes\. Nothing was read or changed/);
});
