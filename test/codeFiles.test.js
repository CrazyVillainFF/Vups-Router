import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import {
  extractCodeFiles,
  isWebsitePackage,
  mimeForFile,
  safeFilePath
} from "../src/chat/codeFiles.js";
import { buildProjectZip, projectZipName, ZIP_ROOT } from "../src/chat/downloads.js";

test("structured FILE markers become separate exact source files", () => {
  const markdown = [
    "Here is the website.",
    "",
    "FILE: index.html",
    "```html",
    "<!doctype html>",
    "<main>Hello</main>",
    "```",
    "",
    "FILE: src/styles.css",
    "```css",
    "main { color: lime; }",
    "```",
    "",
    "FILE: src/main.js",
    "```js",
    "document.querySelector('main').dataset.ready = 'true';",
    "```"
  ].join("\n");
  const files = extractCodeFiles(markdown);
  assert.deepEqual(files.map(file => file.path), ["index.html", "src/styles.css", "src/main.js"]);
  assert.equal(files[0].content, "<!doctype html>\n<main>Hello</main>\n");
  assert.equal(files[1].content, "main { color: lime; }\n");
  assert.equal(isWebsitePackage(files), true);
});

test("CRLF responses and language:filename fence metadata are supported", () => {
  const markdown = "```html:index.html\r\n<h1>Windows</h1>\r\n```\r\n";
  const files = extractCodeFiles(markdown);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "index.html");
  assert.equal(files[0].content, "<h1>Windows</h1>\n");
});

test("filenames in fence metadata and headings are recognized", () => {
  const markdown = [
    "### index.html",
    "```html title=\"index.html\"",
    "<h1>Home</h1>",
    "```",
    "",
    "```css",
    "```",
    "**src/app.css**",
    "```css filename=src/app.css",
    "h1 { color: lime; }",
    "```"
  ].join("\n");
  const files = extractCodeFiles(markdown);
  assert.deepEqual(files.map(file => file.path), ["index.html", "src/app.css"]);
});

test("a single unnamed block gets one sensible file, not a fake project", () => {
  const files = extractCodeFiles("```html\n<h1>Only file</h1>\n```");
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "index.html");
  assert.equal(isWebsitePackage(files), false);
});

test("ordinary prose and shell snippets do not create a website package", () => {
  assert.deepEqual(extractCodeFiles("Here is an explanation without code."), []);
  assert.deepEqual(extractCodeFiles("```bash\nnpm install\n```"), []);
  assert.deepEqual(extractCodeFiles("```text\nplain output\n```"), []);
});

test("empty and unsafe paths are skipped or made relative safely", () => {
  const markdown = [
    "FILE: ../secret.txt",
    "```text",
    "nope",
    "```",
    "FILE: /index.html",
    "```html",
    "<h1>Safe</h1>",
    "```",
    "FILE: ../../.env",
    "```bash",
    "SECRET=value",
    "```"
  ].join("\n");
  const files = extractCodeFiles(markdown);
  assert.deepEqual(files.map(file => file.path), ["index.html"]);
  assert.equal(safeFilePath("../escape.js"), null);
  assert.equal(safeFilePath("/absolute/file.js"), "absolute/file.js");
  assert.equal(safeFilePath("src\\windows.js"), "src/windows.js");
  assert.equal(safeFilePath("CON.js"), "_CON.js");
});

test("duplicate generated paths are kept distinct without overwriting", () => {
  const markdown = [
    "FILE: app.js",
    "```js",
    "first",
    "```",
    "FILE: app.js",
    "```js",
    "second",
    "```"
  ].join("\n");
  const files = extractCodeFiles(markdown);
  assert.deepEqual(files.map(file => file.path), ["app.js", "app-2.js"]);
  assert.deepEqual(files.map(file => file.content), ["first\n", "second\n"]);
});

test("the ZIP is real and contains separately extractable files", async () => {
  const files = extractCodeFiles([
    "FILE: index.html",
    "```html",
    "<!doctype html><link rel=\"stylesheet\" href=\"src/styles.css\">",
    "```",
    "FILE: src/styles.css",
    "```css",
    "body { background: #0b0d0a; color: #d4ff3f; }",
    "```"
  ].join("\n"));
  const blob = await buildProjectZip(files);
  assert.ok(blob instanceof Blob);
  assert.ok(blob.size > 100);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  assert.equal(await zip.file(`${ZIP_ROOT}/index.html`).async("string"), files[0].content);
  assert.equal(
    await zip.file(`${ZIP_ROOT}/src/styles.css`).async("string"),
    "body { background: #0b0d0a; color: #d4ff3f; }\n"
  );
  assert.equal(zip.file(`${ZIP_ROOT}/src/styles.css`).dir, false);
  assert.deepEqual(Object.keys(zip.files).filter(path => !zip.files[path].dir).sort(), [
    `${ZIP_ROOT}/index.html`,
    `${ZIP_ROOT}/src/styles.css`
  ]);
  await assert.rejects(buildProjectZip([{ path: "../escape.js", content: "x" }]), /no generated files/i);
  assert.equal(projectZipName(new Date("2026-10-22T12:00:00Z")), "vups-website-2026-10-22.zip");
});

test("download MIME types match the generated file extension", () => {
  assert.match(mimeForFile("index.html"), /^text\/html/);
  assert.match(mimeForFile("styles.css"), /^text\/css/);
  assert.match(mimeForFile("main.js"), /^text\/javascript/);
  assert.match(mimeForFile("data.json"), /^application\/json/);
  assert.match(mimeForFile("logo.svg"), /^image\/svg\+xml/);
});
