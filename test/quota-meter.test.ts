import { it } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

it("renders the same quota-bar footprint for measured, partial and unknown values", async () => {
  // Isolate the actual UI component from browser-only state during server tests.
  const output = await build({
    stdin: { contents: 'export { Meter } from "./src/web/components/ui.tsx";', resolveDir: process.cwd() },
    bundle: true, write: false, format: "esm", platform: "node",
    jsx: "automatic", jsxImportSource: "preact",
    plugins: [{ name: "browser-state-stub", setup(builder) {
      builder.onLoad({ filter: /src\/web\/state\/(router|store)\.ts$/ }, () => ({
        contents: "export const now = { value: 0 }; export function navigate() {}", loader: "js",
      }));
    } }],
  });
  const { Meter } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
  for (const value of [0, 73, 100]) {
    const node = Meter({ value, label: value === 73 ? "Partial quota: 34/48 accounts measured" : "Remaining quota" });
    assert.equal(node.type, "span");
    assert.match(node.props.class, /meter meter-md/);
    assert.equal(node.props.role, "meter");
    assert.equal(node.props["aria-valuenow"], value);
    assert.equal(node.props.children.props.style.width, `${value}%`);
  }
  const unknown = Meter({ value: null, label: "Quota not reported" });
  assert.match(unknown.props.class, /meter meter-md.*meter-unknown/);
  assert.equal(unknown.props.role, "img");
  assert.equal(unknown.props["aria-valuenow"], undefined, "unknown never announces a fabricated percentage");
  assert.equal(unknown.props["aria-label"], "Quota not reported");
  assert.equal(unknown.props.children, false, "unknown has a neutral track, not a zero/full fill");
});
