import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = path.join(root, "src", "desktop");
const pagesSource = readFileSync(path.join(desktopDir, "DesktopPages.jsx"), "utf8");
const skillsEngine = readFileSync(
  path.join(root, "src-tauri", "src", "skills.rs"),
  "utf8"
);

// The engine's own permission vocabulary, read rather than restated, so no
// fixture below can carry a permission the validator would reject.
const vocabularyBlock = skillsEngine.match(
  /pub const PERMISSION_VOCABULARY: \[&str; (\d+)\] = \[([\s\S]*?)\];/
);
const permissionVocabulary = vocabularyBlock
  ? [...vocabularyBlock[2].matchAll(/"([a-z]+)"/g)].map(match => match[1])
  : [];

/**
 * The failure code a `Failure::new` belongs to, looked up from the position of a
 * phrase in its message. The client may only offer an action the engine actually
 * invites, and the invitation lives in the message text.
 */
function codesSaying(phrase) {
  const codes = new Set();
  let from = 0;
  for (;;) {
    const at = skillsEngine.indexOf(phrase, from);
    if (at === -1) break;
    const before = skillsEngine.slice(0, at);
    const matches = [...before.matchAll(/Failure::new\(\s*\n?\s*"(skill_[a-z_]+)"/g)];
    if (matches.length > 0) codes.add(matches[matches.length - 1][1]);
    from = at + phrase.length;
  }
  return codes;
}

// Shapes copied field for field from the Rust structs in src-tauri/src/skills.rs
// (SkillsStatus, SkillRecord, ScanSummary, ActionResult). If a field here is
// wrong, the engine is the thing that has changed and the test should fail.
// `permissions` holds only entries from PERMISSION_VOCABULARY, checked against
// the engine source below rather than trusted from here.
function skillRecord(overrides = {}) {
  return {
    id: "vupsrouter-qa-inspector",
    name: "QA Inspector",
    version: "1.0.0",
    description: "Inspect a supplied text file and write the report the checklist asks for.",
    author: "VupsRouter QA",
    path: "C:\\Users\\tester\\Documents\\VupsRouter\\Skills\\vupsrouter-qa-inspector",
    status: "ready",
    enabled: true,
    errorCode: "",
    errors: [],
    permissions: ["read", "write"],
    capabilities: ["files"],
    references: ["checklist.md", "report-format.md"],
    instructionsPath: "SKILL.md",
    bytes: 1420,
    integrity: "not declared",
    installedAt: 1762400000000,
    sourceKind: "archive",
    ...overrides
  };
}

function scanSummary(overrides = {}) {
  return {
    at: 1762400000000,
    folders: 1,
    ready: 1,
    invalid: 0,
    disabled: 0,
    note: "1 folder read",
    ...overrides
  };
}

function statusFixture(overrides = {}) {
  return {
    rootPath: "C:\\Users\\tester\\Documents\\VupsRouter\\Skills",
    statePath: "C:\\Users\\tester\\Documents\\VupsRouter\\Skills\\.vupsrouter-skills.json",
    manifestVersion: 1,
    skills: [skillRecord()],
    scan: scanSummary(),
    lastScan: null,
    stateCorrupted: false,
    action: null,
    note: "",
    ...overrides
  };
}

let bridge;

// Imported inside the tests that need it: a missing module has to fail those
// cases alone, not the guards that already hold.
async function loadBridge() {
  if (!bridge) bridge = await import(pathToFileURL(path.join(desktopDir, "skillsBridge.js")).href);
  return bridge;
}

// -- the bridge: one control, one real command, with the arguments Rust reads --

test("the bridge calls the six skills commands with exactly the arguments the engine reads", async () => {
  const seen = [];
  const invoke = async (command, args) => {
    seen.push({ command, args });
    return command === "skills_pick_source" ? "C:\\qa\\pkg" : statusFixture();
  };
  globalThis.window = { __TAURI_INTERNALS__: { invoke }, __TAURI__: { internal: { invoke } } };
  const skills = await loadBridge();
  assert.equal((await skills.readSkills()).rootPath, "C:\\Users\\tester\\Documents\\VupsRouter\\Skills");
  await skills.rescanSkills();
  await skills.pickSkillSource({ archive: true });
  await skills.installSkill("C:\\qa\\pkg");
  await skills.installSkill("C:\\qa\\pkg", { overwrite: true });
  await skills.uninstallSkill("vupsrouter-qa-inspector");
  await skills.setSkillEnabled("vupsrouter-qa-inspector", false);
  assert.deepEqual(seen.map(entry => entry.command), [
    "skills_status",
    "skills_scan",
    "skills_pick_source",
    "skills_install",
    "skills_install",
    "skills_uninstall",
    "skills_set_enabled"
  ]);
  assert.deepEqual(seen[0].args, {});
  assert.deepEqual(seen[1].args, {});
  assert.deepEqual(seen[2].args, { archive: true });
  assert.deepEqual(seen[3].args, { source: "C:\\qa\\pkg", overwrite: false });
  assert.deepEqual(seen[4].args, { source: "C:\\qa\\pkg", overwrite: true });
  assert.deepEqual(seen[5].args, { id: "vupsrouter-qa-inspector" });
  assert.deepEqual(seen[6].args, { id: "vupsrouter-qa-inspector", enabled: false });
  delete globalThis.window;
});

test("the bridge reports the engine's own reason instead of a generic failure", async () => {
  const invoke = async () => {
    throw { code: "skill_archive_invalid", message: "The archive has no manifest at its top level." };
  };
  globalThis.window = { __TAURI_INTERNALS__: { invoke }, __TAURI__: { internal: { invoke } } };
  const skills = await loadBridge();
  await assert.rejects(
    () => skills.installSkill("C:\\qa\\broken.zip"),
    /no manifest at its top level/,
    "the rejection the Rust side sent is what the user reads"
  );
  const silent = async () => {
    throw null;
  };
  globalThis.window = { __TAURI_INTERNALS__: { invoke: silent }, __TAURI__: { internal: { invoke: silent } } };
  await assert.rejects(() => skills.readSkills(), /Skills/, "a messageless failure still says what was attempted");
  delete globalThis.window;
});

test("outside the Windows app the skills bridge refuses rather than pretending to read a folder", async () => {
  delete globalThis.window;
  const skills = await loadBridge();
  await assert.rejects(() => skills.readSkills(), /Windows app/);
  await assert.rejects(() => skills.installSkill("C:\\qa\\pkg"), /Windows app/);
  await assert.rejects(() => skills.uninstallSkill("x"), /Windows app/);
});

test("every skills command the bridge calls is registered, permitted and enabled in both webviews", () => {
  const main = readFileSync(path.join(root, "src-tauri", "src", "main.rs"), "utf8");
  const permissions = readFileSync(path.join(root, "src-tauri", "permissions", "skills.toml"), "utf8");
  const capabilities = ["default", "desktop-local"].map(name =>
    readFileSync(path.join(root, "src-tauri", "capabilities", `${name}.json`), "utf8")
  );
  const dispatcher = readFileSync(path.join(root, "src-tauri", "src", "desktop_tools.rs"), "utf8");
  const bridge = readFileSync(path.join(desktopDir, "skillsBridge.js"), "utf8");
  const invoked = [...bridge.matchAll(/tauriInvoke\("([a-z_]+)"/g)].map(match => match[1]);
  assert.deepEqual(invoked.sort(), [
    "skills_install",
    "skills_pick_source",
    "skills_scan",
    "skills_set_enabled",
    "skills_status",
    "skills_uninstall"
  ]);
  const handler = main.match(/generate_handler!\[([\s\S]*?)\]/);
  assert.ok(handler, "main.rs still declares one generate_handler list");
  for (const command of invoked) {
    assert.ok(handler[1].includes(`skills::${command}`), `${command} is in generate_handler!`);
    assert.ok(permissions.includes(`"${command}"`), `${command} is allowed by the permission set`);
  }
  for (const capability of capabilities) {
    assert.match(capability, /allow-skills-commands/);
  }
  // The chat path reaches the engine through desktop_tool_execute, so the three
  // tools the model may call have to be dispatched there, not only as commands.
  for (const tool of ["list_skills", "use_skill", "read_skill_reference"]) {
    assert.match(dispatcher, new RegExp(`"${tool}"`), `${tool} is dispatched by the native tool executor`);
  }
});

// -- the view model: what the screen is allowed to say --

test("a ready, switched-on package reads as usable with its real files and declared permissions", async () => {
  const view = await import(pathToFileURL(path.join(desktopDir, "skillsView.js")).href);
  const model = view.skillsView(statusFixture());
  assert.equal(model.tone, "ok");
  assert.equal(model.rootPath, "C:\\Users\\tester\\Documents\\VupsRouter\\Skills");
  assert.equal(model.rows.length, 1);
  const row = model.rows[0];
  assert.equal(row.state, "ready");
  assert.equal(row.usable, true, "the engine said ready and on, so the model may be given it");
  assert.deepEqual(row.permissions, ["read", "write"], "declared permissions are shown as declared");
  for (const word of row.permissions) {
    assert.ok(permissionVocabulary.includes(word), `${word} is a permission the engine can emit`);
  }
  assert.deepEqual(row.references, ["checklist.md", "report-format.md"]);
  assert.equal(row.instructionsPath, "SKILL.md");
  assert.equal(row.bytes, 1420);
  assert.equal(model.usable.length, 1);
  assert.match(model.scanLine, /1 folder/i);
});

test("a switched-off package is named as off, not as broken and not as usable", async () => {
  const view = await import(pathToFileURL(path.join(desktopDir, "skillsView.js")).href);
  const model = view.skillsView(
    statusFixture({
      skills: [skillRecord({ enabled: false }), skillRecord({ id: "other", name: "Other" })],
      scan: scanSummary({ folders: 2, ready: 2, disabled: 1 })
    })
  );
  const off = model.rows.find(row => row.id === "vupsrouter-qa-inspector");
  assert.equal(off.state, "disabled");
  assert.equal(off.usable, false, "a switched-off skill must never reach the model");
  assert.equal(off.status, "ready", "disabled is not the same as broken");
  assert.equal(model.usable.length, 1);
  assert.equal(model.disabled.length, 1);
  assert.match(model.label, /off|switched/i);
});

test("an invalid package shows the engine's own code and message and never reads as ready", async () => {
  const view = await import(pathToFileURL(path.join(desktopDir, "skillsView.js")).href);
  const broken = skillRecord({
    id: "broken-one",
    name: "Broken One",
    status: "invalid",
    enabled: false,
    errorCode: "skill_manifest_missing",
    errors: ["This folder has no vupsrouter-skill.json, so VupsRouter cannot read it as a skill."],
    integrity: "not checked",
    references: []
  });
  const model = view.skillsView(
    statusFixture({ skills: [skillRecord(), broken], scan: scanSummary({ folders: 2, ready: 1, invalid: 1 }) })
  );
  assert.equal(model.tone, "warn", "one rejected package is not an all-green folder");
  assert.equal(model.invalid.length, 1);
  const row = model.rows.find(item => item.id === "broken-one");
  assert.equal(row.state, "invalid");
  assert.equal(row.usable, false);
  assert.equal(row.errorCode, "skill_manifest_missing", "the code is shown so the reason is searchable");
  assert.match(row.errors[0], /no vupsrouter-skill\.json/);
  assert.notEqual(row.state, "ready");
});

test("a duplicate id the engine marked as a conflict is not offered to the model", async () => {
  const view = await import(pathToFileURL(path.join(desktopDir, "skillsView.js")).href);
  const model = view.skillsView(
    statusFixture({
      skills: [
        skillRecord(),
        skillRecord({
          id: "vupsrouter-qa-inspector",
          name: "QA Inspector copy",
          status: "conflict",
          enabled: false,
          errorCode: "skill_duplicate_id",
          errors: ["Two folders declare the identifier vupsrouter-qa-inspector."]
        })
      ],
      scan: scanSummary({ folders: 2, ready: 1, invalid: 1 })
    })
  );
  const conflict = model.rows.find(row => row.state === "conflict");
  assert.ok(conflict, "a conflict keeps its own state instead of becoming ready or invalid");
  assert.equal(conflict.usable, false);
  assert.match(conflict.errorCode, /duplicate/);
});

test("an integrity the package never declared is not shown as verified", async () => {
  const view = await import(pathToFileURL(path.join(desktopDir, "skillsView.js")).href);
  const undeclared = view.skillsView(statusFixture()).rows[0];
  assert.equal(undeclared.integrity, "not declared");
  assert.doesNotMatch(undeclared.integrityLabel, /verified/i, "nothing was checked, so nothing may say it was");

  const verified = view.skillsView(statusFixture({ skills: [skillRecord({ integrity: "verified" })] })).rows[0];
  assert.match(verified.integrityLabel, /verified/i);

  const unchecked = view
    .skillsView(statusFixture({ skills: [skillRecord({ status: "invalid", integrity: "not checked" })] }))
    .rows[0];
  assert.doesNotMatch(unchecked.integrityLabel, /verified/i);
});

test("the counts come from the engine's scan, and a folder that was never scanned says so", async () => {
  const view = await import(pathToFileURL(path.join(desktopDir, "skillsView.js")).href);
  const scanned = view.skillsView(statusFixture());
  assert.deepEqual(scanned.counts, { folders: 1, ready: 1, invalid: 0, disabled: 0 });
  assert.match(scanned.scanLine, /1 folder read/);

  const previous = view.skillsView(statusFixture({ scan: null, lastScan: scanSummary({ folders: 3, ready: 2 }) }));
  assert.deepEqual(previous.counts, { folders: null, ready: null, invalid: null, disabled: null });
  assert.match(previous.scanLine, /not scanned|never scanned/i, "no scan is reported as a scan of zero");
  assert.match(previous.lastScanLine, /2 of 3|3 folders/i, "the earlier scan is still shown");
});

test("an empty Skills folder is reported as empty instead of as a working set", async () => {
  const view = await import(pathToFileURL(path.join(desktopDir, "skillsView.js")).href);
  const model = view.skillsView(statusFixture({ skills: [], scan: scanSummary({ folders: 0, ready: 0 }) }));
  assert.equal(model.rows.length, 0);
  assert.equal(model.usable.length, 0);
  assert.equal(model.tone, "empty", "nothing installed is not an error, and it is not ready either");
  assert.match(model.label, /no skills/i);
  assert.doesNotMatch(`${model.label} ${model.detail}`, /ready/i);
});

test("a corrupted state file is shown as a problem the user can read", async () => {
  const view = await import(pathToFileURL(path.join(desktopDir, "skillsView.js")).href);
  const model = view.skillsView(
    statusFixture({ stateCorrupted: true, note: "The skills state file could not be read and was replaced." })
  );
  assert.equal(model.corrupted, true);
  assert.notEqual(model.tone, "ok", "a state the app had to throw away is not a healthy folder");
  assert.match(model.error, /state/i);
  assert.equal(model.note, "The skills state file could not be read and was replaced.");
});

test("the action the engine just performed reaches the screen as its own sentence", async () => {
  const view = await import(pathToFileURL(path.join(desktopDir, "skillsView.js")).href);
  for (const kind of ["install", "uninstall", "enable", "disable"]) {
    const message = `${kind} done by the engine`;
    const model = view.skillsView(statusFixture({ action: { kind, message, skill: skillRecord() } }));
    assert.equal(model.action, message, `${kind} is shown as the engine worded it`);
    assert.equal(model.actionKind, kind);
  }
  assert.equal(view.skillsView(statusFixture()).action, "");
});

test("the panel says which folder it was given and never a guessed one", async () => {
  const view = await import(pathToFileURL(path.join(desktopDir, "skillsView.js")).href);
  const source = readFileSync(path.join(desktopDir, "skillsView.js"), "utf8");
  assert.doesNotMatch(source, /Documents/, "the resolved path comes from Rust, not from a string in the view");
  assert.doesNotMatch(source, /%USERPROFILE%/i);
  const elsewhere = view.skillsView(statusFixture({ rootPath: "D:\\Elsewhere\\Skills" }));
  assert.equal(elsewhere.rootPath, "D:\\Elsewhere\\Skills");
  assert.equal(view.skillsView(null).rootPath, "", "no response is not a response that names a folder");
  assert.equal(view.skillsView({}).statePath, "");
});

// -- the settings screen: one control, one command --

function skillsSection() {
  const start = pagesSource.indexOf("function SkillsSection");
  const end = pagesSource.indexOf("export function AppSettingsPage");
  assert.ok(start > 0 && end > start, "SkillsSection is its own component, declared before the settings page");
  return pagesSource.slice(start, end);
}

test("the settings section wires each control to the command that performs it", () => {
  const section = skillsSection();
  assert.ok(section.length > 600, "the skills screen is a real section, not a stub");
  for (const call of [
    "readSkills(",
    "rescanSkills(",
    "pickSkillSource(",
    "installSkill(",
    "uninstallSkill(",
    "setSkillEnabled("
  ]) {
    assert.ok(section.includes(call), `${call} is actually invoked by a control`);
  }
  assert.match(section, /skillsView\(status\)/, "the panel renders through the view model, not raw fields");
  assert.match(section, /Install from a folder/);
  assert.match(section, /\.zip/, "a package archive is a distinct real action");
  assert.match(section, /Re-scan/);
  assert.match(section, /view\.usable|view\.rows/, "the installed packages are listed");
  assert.match(section, /permission/i, "a package's declared permissions are visible before it is used");
  assert.match(section, /view\.action/, "the message the engine wrote after an action is shown");
  assert.match(section, /row\.errors|view\.error/, "a rejected package is shown with its reason");
  assert.match(section, /HoldToDeleteDialog/, "uninstalling is held, not clicked");
  assert.match(section, /setSkillEnabled\(\w+\.id, (?:true|false)\)/, "the switch calls the engine with the real id");
  assert.match(pagesSource, /<SkillsSection \/>/, "the section is on the settings page");
});

test("the replace offer appears for exactly the codes that ask for it", () => {
  // "replace to overwrite it" is the engine inviting an overwrite. The screen
  // may put a Replace button on screen for those codes and no others, because a
  // button that cannot fix the reported problem is a lie about what it does.
  const invited = codesSaying("replace to overwrite it");
  assert.ok(invited.size > 0, "the engine does invite a replace somewhere");
  const section = skillsSection();
  const guard = section.match(/if \(\/([a-z_|]+)\/\.test\(installError\.message\)\)/);
  assert.ok(guard, "the section decides the replace offer from the engine's own code");
  const offered = new Set(guard[1].split("|"));
  assert.deepEqual(
    [...offered].sort(),
    [...invited].sort(),
    "the button appears for exactly the codes whose message offers to overwrite"
  );
  assert.ok(
    !offered.has("skill_duplicate_id"),
    "two folders claiming one id is a manual fix; replacing one of them is not the engine's offer"
  );
});

test("a switched-off package can be switched on again, a rejected one cannot", async () => {
  // A control the user can never press is a decorative control. The switch-off
  // half had been gated on the derived `state` (which is "disabled" precisely
  // for the package the user wants to re-enable), so it could only ever be
  // pressed once. The guard expressions are read out of the JSX and evaluated
  // against real view-model rows, so this fails on behaviour and not on wording.
  const view = await import(pathToFileURL(path.join(desktopDir, "skillsView.js")).href);
  const section = skillsSection();

  function guardFor(label) {
    const at = section.indexOf(`"${label}"}`);
    assert.ok(at > 0, `the section renders a ${label} button`);
    const tag = section.slice(section.lastIndexOf("<button", at), at);
    const expression = tag.match(/disabled=\{([^}]*)\}/);
    assert.ok(expression, `the ${label} button declares when it is disabled`);
    return new Function("row", "busy", `return (${expression[1]});`);
  }

  const canSwitchOn = guardFor("Switch on");
  const canSwitchOff = guardFor("Switch off");
  const model = view.skillsView(
    statusFixture({
      skills: [
        skillRecord({ enabled: false }),
        skillRecord({
          id: "broken-one",
          name: "Broken One",
          status: "invalid",
          enabled: false,
          errorCode: "skill_manifest_missing"
        }),
        skillRecord({
          id: "dupe-one",
          name: "Dupe One",
          status: "conflict",
          enabled: false,
          errorCode: "skill_duplicate_id"
        })
      ],
      scan: scanSummary({ folders: 3, ready: 3, disabled: 1, invalid: 1 })
    })
  );
  const [switchedOff, rejected, conflicting] = model.rows;

  assert.equal(canSwitchOn(switchedOff, ""), false, "a valid package that is off must offer Switch on");
  assert.equal(canSwitchOn({ ...switchedOff, enabled: true }, ""), false);
  assert.equal(canSwitchOn(switchedOff, "switch-vupsrouter-qa-inspector"), true, "one switch at a time");
  assert.equal(canSwitchOn(rejected, ""), true, "a rejected package is not made usable by pressing a button");
  assert.equal(canSwitchOn(conflicting, ""), true, "a conflict is fixed by removing a folder, not by a switch");
  assert.equal(canSwitchOff({ ...switchedOff, enabled: true }, ""), false, "Switch off stays pressable");
});

test("the settings section has no decorative controls and no invented progress", () => {
  const section = skillsSection();
  assert.doesNotMatch(section, /onClick=\{\(\) => \{\}\}/, "a button that does nothing is not shipped");
  assert.doesNotMatch(section, /\balert\(/, "a native dialog is not how this app reports");
  assert.doesNotMatch(section, /TODO|Coming soon|not implemented yet/i);
  assert.doesNotMatch(section, /\d+%\s*(done|complete)/i, "installation has no fake percentage");
  assert.doesNotMatch(section, /setTimeout\(\s*\(\) => \{\s*set.*Status/s, "a status is never staged on a timer");
});

test("the website says skills are a Windows-app feature instead of faking buttons", () => {
  const section = skillsSection();
  assert.match(section, /isTauriRuntime\(\)/, "the section knows whether it is in the native shell");
  assert.match(section, /Windows app/);
  assert.doesNotMatch(
    section.slice(0, section.indexOf("const view = skillsView")),
    /installSkill\(|uninstallSkill\(/,
    "the fallback branch offers no command it cannot run"
  );
});

// -- the chat path: the row the engine wrote is the row the user reads --

test("the three skills tools have labels the progress list can use", async () => {
  const tools = await import(pathToFileURL(path.join(root, "src", "native", "desktopTools.js")).href);
  assert.equal(tools.DESKTOP_TOOL_LABELS.list_skills, "Listing installed skills");
  assert.equal(tools.DESKTOP_TOOL_LABELS.use_skill, "Reading a skill's instructions");
  assert.equal(tools.DESKTOP_TOOL_LABELS.read_skill_reference, "Reading a skill reference");
  assert.equal(tools.desktopToolNames().length, 30, "the client table matches the server registry");
  for (const name of ["list_skills", "use_skill", "read_skill_reference"]) {
    assert.notEqual(tools.desktopToolLabel(name), "Using a local Windows tool", `${name} is not left generic`);
  }
});

test("a skill row keeps the engine's own sentence instead of a generic tool label", async () => {
  const activity = await import(pathToFileURL(path.join(root, "src", "chat", "activity.js")).href);
  const row = activity.activityRowFromProgress({
    key: "call_1",
    phase: "skill",
    status: "completed",
    tool: "use_skill",
    message: "Loaded the QA Inspector 1.0.0 instruction file (1420 bytes, 2 reference files)"
  });
  assert.match(row.label, /QA Inspector/);
  assert.match(row.label, /1\.0\.0/);
  assert.equal(row.status, "completed");

  // desktopChat relabels every forwarded row from its tool name. A row that
  // already names a package must be left alone or the user loses which one.
  const source = readFileSync(path.join(root, "src", "services", "desktopChat.js"), "utf8");
  const body = source.slice(source.indexOf("function progressRowLabel"), source.indexOf("/**", source.indexOf("function progressRowLabel")));
  const skillGuard = body.indexOf('phase === "skill"');
  assert.ok(skillGuard >= 0, "the skill phase is recognised before any tool-name label is applied");
  assert.ok(
    skillGuard < body.indexOf("event?.tool"),
    "the skill check comes first, so a skill row is never renamed to a generic label"
  );
  // The guard's own statement is checked, not a window of characters, so the
  // assertion cannot be satisfied by an accident of line length.
  assert.match(body, /if \(event\?\.phase === "skill"\) return "";/, "a skill row is given no label, so its sentence survives");
});

test("the skills bridge file is where the section expects it", () => {
  assert.ok(existsSync(path.join(desktopDir, "skillsBridge.js")));
  assert.ok(existsSync(path.join(desktopDir, "skillsView.js")));
});

test("a skill line and the tool call behind it stay two separate lines", async () => {
  const activity = await import(pathToFileURL(path.join(root, "src", "chat", "activity.js")).href);
  const toolRow = {
    key: "",
    callId: "call_1",
    phase: "tool",
    status: "completed",
    tool: "use_skill",
    message: "use_skill completed"
  };
  const skillRow = {
    callId: "call_1",
    phase: "skill",
    status: "completed",
    tool: "use_skill",
    message: "Loaded the QA Inspector 1.0.0 instruction file (1420 bytes, 2 reference files)"
  };
  const rows = activity.applyProgressRows([], [toolRow, skillRow], { runId: "run-1" });
  assert.equal(rows.length, 2, "one call is one tool line and one skill line, not one that overwrites the other");
  assert.equal(rows.find(row => row.phase === "skill").status, "completed");
  assert.equal(rows.find(row => row.phase === "tool").label, "use_skill completed");

  // Replaying the same pair (a refresh of a finished task) must not duplicate it.
  assert.equal(activity.applyProgressRows(rows, [toolRow, skillRow], { runId: "run-1" }).length, 2);
});
