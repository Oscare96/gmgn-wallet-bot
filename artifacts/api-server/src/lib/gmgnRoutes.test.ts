import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import gmgnRouter from "../routes/gmgn";
import { GMGN_BASE_ROUTE } from "../routes";
import discoveryRouter, { DISCOVERY_PATH } from "../routes/discovery";
import backtestingRouter, { BACKTESTING_PATH } from "../routes/backtesting";

test("every generated GMGN dashboard request has a matching backend route", () => {
  const stack = (gmgnRouter as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
  }).stack;
  const implemented = new Set(stack.flatMap(({ route }) => route
    ? Object.keys(route.methods).map((method) => `${method} ${GMGN_BASE_ROUTE}${route.path}`)
    : []));
  const discoveryStack = (discoveryRouter as unknown as { stack: typeof stack }).stack;
  for (const { route } of discoveryStack) {
    if (route) for (const method of Object.keys(route.methods)) {
      implemented.add(`${method} ${GMGN_BASE_ROUTE}${DISCOVERY_PATH}${route.path === "/" ? "" : route.path}`);
    }
  }
  for (const { route } of (backtestingRouter as unknown as { stack: typeof stack }).stack) {
    if (route) for (const method of Object.keys(route.methods)) implemented.add(`${method} ${GMGN_BASE_ROUTE}${BACKTESTING_PATH}${route.path === "/" ? "" : route.path}`);
  }
  const spec = readFileSync(new URL("../../../../lib/api-spec/openapi.yaml", import.meta.url), "utf8");
  const pathBlocks = [...spec.matchAll(/^  (\/gmgn\/[^:]+):\n([\s\S]*?)(?=^  \/|^components:|(?![\s\S]))/gm)];
  assert.ok(pathBlocks.length >= 9);
  for (const [, path, block] of pathBlocks) {
    const expressPath = path.replace(/\{([^}]+)\}/g, ":$1");
    for (const [, method] of block.matchAll(/^    (get|post|patch|delete):/gm)) {
      assert.ok(implemented.has(`${method} ${expressPath}`), `Missing generated-client route: ${method} ${path}`);
    }
  }
});
