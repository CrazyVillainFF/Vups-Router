import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = relative => readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");

const comboPage = read("src/combo/ComboPage.jsx");
const comboCss = read("src/combo/combo.css");
const chatPage = read("src/ChatPage.jsx");
const promptBar = read("src/components/reactbits/PromptBar.jsx");
const appSource = read("src/App.jsx");
const catalogSource = read("src/chat/modelCatalog.js");

const comboJsx = readdirSync(path.join(root, "src/combo"))
  .filter(name => name.endsWith(".jsx"))
  .map(name => [`combo/${name}`, read(path.join("src/combo", name))]);

// esbuild does not resolve identifiers, so a symbol used in JSX but never imported
// builds cleanly and only fails when the page renders. This is the cheapest guard
// against that class of breakage in the Combo screens.
function importedNames(source) {
  const names = new Set();
  for (const clause of source.matchAll(/import\s+([^;]*?)\s+from\s+["'][^"']+["']/gs)) {
    const body = clause[1].replace(/\s+/g, " ").trim();
    const braces = /\{([^}]*)\}/.exec(body);
    const parts = [];
    if (braces) parts.push(...braces[1].split(","));
    parts.push(...body.replace(/\{[^}]*\}/g, "").split(","));
    for (const part of parts) {
      const token = part.trim();
      if (!token) continue;
      const alias = /\s+as\s+([A-Za-z_$][\w$]*)$/.exec(token);
      names.add((alias ? alias[1] : token).trim());
    }
  }
  return names;
}

function declaredNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/(?:function|const|let|var|class)\s+([A-Z][\w$]*)/g)) names.add(m[1]);
  return names;
}

function usedTags(source) {
  const tags = new Set();
  for (const m of source.matchAll(/<([A-Z][\w$]*)(?=[\s/>])/g)) tags.add(m[1]);
  return tags;
}

test("every component used in a Combo screen is imported or declared in that file", () => {
  const files = [...comboJsx, ["ChatPage.jsx", chatPage], ["App.jsx", appSource]];
  const missing = [];
  for (const [name, source] of files) {
    const known = new Set([...importedNames(source), ...declaredNames(source)]);
    for (const tag of usedTags(source)) {
      if (!known.has(tag)) missing.push(`${name}: <${tag}>`);
    }
  }
  assert.deepEqual(missing, []);
});

test("the standalone Combo prompt panel is removed, not hidden", () => {
  for (const pattern of [
    /<textarea/,
    /const \[prompt, setPrompt\]/,
    /const \[answer, setAnswer\]/,
    /const \[running, setRunning\]/,
    /const \[runStage/,
    /const \[pool, setPool\]/,
    /const \[activity, setActivity\]/,
    /function submitRun/,
    /function cancelRun/,
    /function copyAnswer/,
    /function newConversation/,
    /streamComboChat/,
    /runComboTurn/,
    /combo-compose/,
    /combo-run/,
    /combo-answer/,
    /combo-pool/,
    /combo-chip/,
    /combo-btn--stop/,
    /Run combo/i,
    /Ask the combo/i,
    /Select models, then send/i,
    /PROMPT/
  ]) {
    assert.equal(pattern.test(comboPage), false, `ComboPage still contains ${pattern}`);
  }
  assert.equal(comboPage.includes("aria-label=\"Prompt\""), false);
  assert.equal(comboPage.includes("<PromptBar"), false, "no second composer on the Combo page");
});

test("the removed panel leaves no orphan styling behind", () => {
  for (const selector of ["combo-compose", "combo-run", "combo-answer", "combo-pool", "combo-chip", "combo-pulse"]) {
    assert.equal(new RegExp(`\\.${selector}[\\w_-]*\\s*[\\{,:]`).test(comboCss), false, `combo.css still styles .${selector}`);
  }
  assert.match(comboCss, /\.combo-stage__note\s*\{/, "the run-state note needs its own style");
  assert.match(comboCss, /\.combo-head__links\s*\{/, "the chat and settings links need their own style");
  assert.match(comboCss, /\.combo-alert\s*\{/, "the disabled notice is still rendered");
  // .combo-stage is display:contents on a phone, so its children are ordered by
  // the layout grid: core, then its run-state note, then the alert, then the list.
  assert.match(
    comboCss,
    /\.combo-stage \{\s*display: contents;\s*\}\s*\.combo-stage__core \{\s*order: 1;\s*\}\s*\.combo-stage__note \{\s*order: 2;\s*\}\s*\.combo-alert \{\s*order: 3;\s*\}\s*\.combo-panel \{\s*order: 4;/s,
    "the note and alert must stay below the core on mobile"
  );
});

test("the Combo page keeps the library, visualization, settings and availability checks", () => {
  assert.match(comboPage, /import ComboPowerCore from "\.\/ComboPowerCore\.jsx"/);
  assert.match(comboPage, /<ComboPowerCore/);
  assert.match(comboPage, /activity=\{liveRun\.activity\}/, "the network mirrors the live chat run");
  assert.match(comboPage, /subscribeComboRun/);
  assert.match(comboPage, /fetchComboState, runComboAvailability, saveComboState/);
  assert.match(comboPage, /MODEL LIBRARY/);
  assert.match(comboPage, /Recheck model availability/);
  assert.match(comboPage, /Not Working/);
  assert.match(comboPage, /to="\/combo\/settings"/);
  assert.match(comboPage, /to="\/chat"/);
  assert.match(comboPage, /type="search"/);
  assert.match(comboPage, /Vision only/);
  assert.match(appSource, /path="\/combo" element=\{<><PageMeta title="Vups Combo AI — VupsRouter" noIndex \/><ComboPage \/>/);
  assert.match(appSource, /path="\/combo\/settings"/);
});

test("the chat composer is the only prompt interface that runs Combo", () => {
  assert.match(chatPage, /if \(selectedRow\?\.combo\) \{/);
  assert.match(chatPage, /result = await runComboTurn\(\{ \.\.\.requestOptions/);
  assert.match(chatPage, /startComboRun\(\)/);
  assert.match(chatPage, /onRunEvent: reportComboEvent/);
  assert.match(chatPage, /endComboRun\(\)/);
  assert.match(chatPage, /"Message Vups Combo AI\.\.\."/);
  assert.match(chatPage, /Vups Combo AI cannot run yet/);
  assert.match(chatPage, /\{activeRow\.combo \? "Apex" : activeRow\.provider\}/);
  assert.equal(chatPage.match(/from "\.\/components\/reactbits\/PromptBar\.jsx"/g).length, 1);
  assert.equal(/setComposerText\(""\)|setAttachments\(\[\]\)/.test(/function changeModel[\s\S]*?\n  \}/.exec(chatPage)[0]), false);
});

test("Combo never receives a single-model provider request and never accepts images silently", () => {
  assert.match(catalogSource, /if \(row\.combo\) return \{ model: COMBO_MODEL_ID, combo: true \}/);
  assert.match(chatPage, /if \(selectedRow\?\.combo && imagePayload\.length > 0\)/);
  assert.match(chatPage, /Remove the images to run this task on Combo/);
  const beforeComposer = /async function beforeComposerSend[\s\S]*?\n  \}/.exec(chatPage)[0];
  assert.match(beforeComposer, /if \(selectedRow\?\.combo\)/);
  assert.match(beforeComposer, /return false/);
  assert.equal(beforeComposer.includes("attachments = []"), false);
});

test("switching to and from Apex keeps the draft, the attachments and the history", () => {
  const modelSync = /useEffect\(\(\) => \{\s*if \(defaultModel === lastDefault\.current\) return;[\s\S]*?\}, \[defaultModel, models\]\);/.exec(
    promptBar
  );
  assert.ok(modelSync, "PromptBar syncs its model from the chat selection");
  assert.equal(modelSync[0].includes("setDraft"), false, "changing the model must not clear the draft");
  assert.equal(modelSync[0].includes("setAttachments"), false, "changing the model must not clear attachments");
  assert.equal(/<PromptBar[^>]*\skey=/.test(chatPage), false, "the composer must not remount on a model change");
  assert.match(chatPage, /const comboMessages = history\.map/, "the full conversation is handed to the orchestrator");
});
