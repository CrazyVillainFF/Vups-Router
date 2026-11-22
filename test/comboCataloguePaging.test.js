/**
 * The Combo AI model library: a catalogue that arrives a page at a time.
 *
 * A library can hold thousands of models, and a reader should not wait for all
 * of them before the first row appears. These tests pin the shape of that:
 * one page is asked for, the next is fetched only when it is wanted, a search
 * reaches models that were never loaded, and the checking queue still covers
 * everything the account holds.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = relative => readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");
const comboPage = read("src/combo/ComboPage.jsx");
const comboApi = read("src/combo/comboApi.js");
const serverRoute = read("../server/src/routes/combo.js");
const serverCatalog = read("../server/src/comboCatalog.js");

// ─── 1. The server can answer with one page ────────────────────────────────

test("the catalogue endpoint takes an offset, a limit and a search", () => {
  assert.match(serverRoute, /const offset = Number\(req\.query\?\.offset\) \|\| 0;/);
  assert.match(serverRoute, /const limit = Number\(req\.query\?\.limit\) \|\| 0;/);
  assert.match(serverRoute, /const query = typeof req\.query\?\.q === "string" \? req\.query\.q : "";/);
  assert.match(serverRoute, /const provider = typeof req\.query\?\.provider === "string" \? req\.query\.provider : "";/);
  assert.match(serverRoute, /comboCatalogForUser\(req\.userId, \{ offset, limit, query, provider \}\)/);
});

test("a request without a limit still returns the whole catalogue", () => {
  // Existing clients ask for the catalogue and expect every model in it.
  assert.match(serverCatalog, /const page = size > 0 \? matching\.slice\(start, start \+ size\) : matching\.slice\(start\);/);
  assert.match(serverCatalog, /total: matching\.length,/);
  assert.match(serverCatalog, /keys: matching\.map\(model => model\.key\),/);
});

test("the server filters by the search term and the provider", () => {
  assert.match(serverCatalog, /if \(providerName && model\.provider !== providerName\) return false;/);
  assert.match(serverCatalog, /\[model\.label, model\.model, model\.provider\]/);
  assert.match(serverCatalog, /providers,/);
});

// ─── 2. The page asks for one page at a time ────────────────────────────────

test("the first load asks for one page, not the whole catalogue", () => {
  assert.match(comboPage, /requestCatalogue\(\{ offset: 0, limit: LIBRARY_PAGE_SIZE \}/);
  assert.match(comboPage, /const LIBRARY_PAGE_SIZE = 100;/);
});

test("the client sends the paging and the search with every page request", () => {
  assert.match(comboApi, /if \(offset\) params\.offset = String\(offset\);/);
  assert.match(comboApi, /if \(limit\) params\.limit = String\(limit\);/);
  assert.match(comboApi, /if \(query\) params\.q = query;/);
  assert.match(comboApi, /if \(provider\) params\.provider = provider;/);
  assert.match(comboPage, /offset: page \* LIBRARY_PAGE_SIZE,/);
});

// ─── 3. Pages are fetched only when they are wanted ─────────────────────────

test("a page is fetched only when the reader asks for it", () => {
  assert.match(comboPage, /loadCataloguePage\(\{ page: Math\.max\(0, page - 1\), query, provider:/);
  assert.match(comboPage, /loadCataloguePage\(\{ page: Math\.min\(pageCount - 1, page \+ 1\), query, provider:/);
});

test("the same page is never requested twice while one is in flight", () => {
  assert.match(comboPage, /const catalogueRequest = useRef\(""\);/);
  assert.match(comboPage, /if \(catalogueRequest\.current === requestKey\) return null;/);
  assert.match(comboPage, /catalogueRequest\.current = requestKey;/);
  assert.match(comboPage, /if \(catalogueRequest\.current === requestKey\) catalogueRequest\.current = "";/);
});

test("a failed page can be asked for again", () => {
  assert.match(comboPage, /catch \(error\) \{\s*setCatalogError\(getApiErrorMessage\(error\)\);\s*return null;/);
  assert.match(comboPage, /setCatalogError\(""\);/);
});

test("the reader is told while a page is on its way", () => {
  assert.match(comboPage, /const \[catalogLoading, setCatalogLoading\] = useState\(false\);/);
  assert.match(comboPage, /"Loading models…"/);
});

// ─── 4. Search and filtering reach the whole catalogue ──────────────────────

test("a search is answered by the server, not by the loaded page", () => {
  assert.match(comboPage, /loadCataloguePage\(\{ page: 0, query, provider: workingOnly \? "" : providerFilter \}\);/);
  // The page on screen is the server's answer; it is not searched again.
  assert.match(comboPage, /const list = filterModels\(catalogModels, \{\s*query: "",\s*provider: "",/);
});

test("the provider list comes from the server, which knows every model", () => {
  assert.match(comboPage, /const providers = catalog\.providers\.length > 0 \? catalog\.providers : providerOptions\(catalogModels\);/);
});

// ─── 5. The checking queue still covers everything ─────────────────────────

test("Test All covers the whole catalogue, not only the loaded page", () => {
  assert.match(comboPage, /const keys = catalog\.keys\.length > 0 \? catalog\.keys : catalogModels\.map\(model => model\.key\);/);
  assert.match(comboPage, /const unchecked = keys\.filter\(key => statusFor\(displayAvailability, key\) === "unknown"\);/);
  assert.match(comboPage, /queue\.enqueue\(unchecked\.map\(key => \(\{ key, label: modelTitle\(\{ key, model: key \}\), silent: true \}\)\)\);/);
});

test("selecting every model asks for the whole catalogue when the page is not enough", () => {
  assert.match(comboPage, /if \(catalogModels\.length < total\) \{/);
  assert.match(comboPage, /fetchComboState\(\{\s*offset: 0,\s*limit: 0,\s*query,\s*provider: workingOnly \? "" : providerFilter\s*\}\);/);
});

// ─── 6. The queue and the catalogue do not interfere ───────────────────────

test("loading more records does not touch the queue", () => {
  const load = comboPage.slice(
    comboPage.indexOf("async function loadCataloguePage("),
    comboPage.indexOf("// A search or a provider filter is answered by the server")
  );
  assert.ok(!/enqueue\(/.test(load), "a page request never queues a check");
  assert.ok(!/cancelKey\(/.test(load), "a page request never cancels a check");
});

test("the queue still caps the probes at ten", () => {
  assert.match(comboPage, /concurrency: MODEL_CHECK_CONCURRENCY/);
  assert.match(read("src/combo/modelCheckQueue.js"), /export const MODEL_CHECK_CONCURRENCY = 10;/);
});

test("Combo AI execution and the chat picker are untouched", () => {
  const serverOrchestrator = read("../server/src/comboOrchestrator.js");
  assert.match(serverOrchestrator, /Math\.min\(COMBO_MAX_WORKING_MODELS, Number\(settings\.maxWorkingModels\)/);
  assert.match(serverOrchestrator, /for \(let index = 0; index < working\.length; index \+= 1\)/);
  assert.match(read("src/components/reactbits/PromptBar.jsx"), /const openModelMenu = event => \{/);
});
