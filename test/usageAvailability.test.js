import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const taskContextSource = readFileSync(new URL("../src/desktop/TaskContext.jsx", import.meta.url), "utf8");
const sidebarSource = readFileSync(new URL("../src/desktop/DesktopSidebar.jsx", import.meta.url), "utf8");

// The deployed backend predates /api/auth/usage, so the request answered 404 on
// mount, after every turn and once a minute — a permanent "Usage unavailable"
// that reads like a transient outage.

test("a 404 from the usage endpoint is treated as a missing feature", () => {
  const handler = taskContextSource.slice(
    taskContextSource.indexOf("const refreshUsage = useCallback"),
    taskContextSource.indexOf("const refreshUsage = useCallback") + 900
  );
  assert.match(handler, /error\?\.response\?\.status === 404/);
  assert.match(handler, /setUsageUnsupported\(true\)/);
  assert.match(handler, /This server does not report daily usage/);
  assert.doesNotMatch(handler, /temporarily|right now/);
});

test("usage stops being re-requested once the server says it has no endpoint", () => {
  const handler = taskContextSource.slice(
    taskContextSource.indexOf("const refreshUsage = useCallback"),
    taskContextSource.indexOf("const refreshUsage = useCallback") + 200
  );
  assert.match(handler, /if \(usageUnsupportedRef\.current\) return null;/);
  assert.match(taskContextSource, /const usageUnsupportedRef = useRef\(false\);/);
  // The guard must run before fetchUsage, otherwise every turn still hits the 404.
  assert.ok(
    handler.indexOf("usageUnsupportedRef.current") < handler.indexOf("await fetchUsage()"),
    "the short-circuit has to precede the request"
  );
});

test("the sidebar names the reason instead of showing an error forever", () => {
  assert.match(sidebarSource, /usageUnsupported/);
  const label = sidebarSource.slice(
    sidebarSource.indexOf("const usageLabel = useMemo"),
    sidebarSource.indexOf("const usageLabel = useMemo") + 400
  );
  assert.match(label, /if \(usageUnsupported\) return "Daily usage is not tracked by this server"/);
  // A real failure still has to look like one.
  assert.match(label, /usageError \? "Usage unavailable"/);
});
