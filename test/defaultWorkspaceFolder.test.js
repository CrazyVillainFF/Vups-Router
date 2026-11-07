import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const rootSource = read("../src-tauri/src/vups_root.rs");
const toolsSource = read("../src-tauri/src/desktop_tools.rs");
const remedySource = read("../src/services/desktopChat.js");

// A project task that names no folder, an AI that wants to save a file, a test
// run and a log write must all land in the folder the app owns instead of
// stopping to ask the user where the work should live.
test("the app's own default task folder is resolved from the known Documents folder", () => {
  assert.match(
    rootSource,
    /pub fn default_task_directory_in\(documents: &Path\) -> Result<PathBuf, String>/,
    "the resolution is testable against any Documents path"
  );
  assert.match(
    rootSource,
    /default_task_directory_in\(&documents_directory\(\)\?\)/,
    "the live command asks Windows"
  );
  assert.match(
    /pub fn default_task_directory_in[\s\S]*?\n\}/.exec(rootSource)[0],
    /is_reparse_point\(&files\)/,
    "the default folder is refused when it is a link, because it becomes the authorization root"
  );
  assert.match(
    /pub fn default_task_directory_in[\s\S]*?\n\}/.exec(rootSource)[0],
    /if !files\.is_dir\(\)/,
    "a file standing in for the default folder is refused too"
  );
  assert.match(rootSource, /ensure_layout\(&root\)\?/, "the layout is made before the folder is used");
});

test("Agent (workspace) mode adopts the app's own folder instead of asking for one", () => {
  const builder = /pub async fn desktop_tool_set_policy[\s\S]*?\n\}/.exec(toolsSource)[0];
  assert.match(
    builder,
    /vups_root::default_files_directory\(\)/,
    "an unbound chat gets the app's folder, not a refusal"
  );
  assert.doesNotMatch(
    builder,
    /if id\.trim\(\)\.is_empty\(\) \{\s*None/,
    "an empty workspace id is no longer a silent no-root policy"
  );
  // The boundary itself stays: a tool call with no root at all is refused, and
  // no approval card can turn that into permission over the whole computer.
  assert.match(toolsSource, /"workspace_required"/);
  assert.doesNotMatch(toolsSource, /Pick a folder or/, "the refusal states a cause, not a request");
  assert.doesNotMatch(toolsSource, /switch modes\. Nothing was read or changed/);
});

test("a folder that vanished is not silently replaced by the default", () => {
  const builder = /pub async fn desktop_tool_set_policy[\s\S]*?\n\}/.exec(toolsSource)[0];
  assert.match(
    builder,
    /workspace_error = Some\(message\)/,
    "the real reason a bound folder could not be read is still reported"
  );
});

// The matching instruction the model is given lives in server/src/desktopTools.js
// (DESKTOP_TOOL_PROMPT) and is pinned by the server's own suite; the two halves
// are separate repositories, so no test here reaches across for it.
test("the chat remedy text no longer tells the user to pick a folder", () => {
  assert.doesNotMatch(remedySource, /the app never creates a folder for you/);
  assert.doesNotMatch(remedySource, /pick it again/);
  assert.doesNotMatch(remedySource, /Add the folder as a workspace or switch modes/);
  assert.match(remedySource, /path_not_found: "[^"]*"/, "the code still gets a plain-language remedy");
});
