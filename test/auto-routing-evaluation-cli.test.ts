import { it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

it("runs explicit model comparisons with the same output budget and records settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pool-eval-cli-"));
  const calls: Array<{ model: string; max_tokens: number }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += String(chunk); });
    req.on("end", () => {
      calls.push(JSON.parse(body));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ model: "mock", choices: [{ message: { content: "4" } }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const suite = join(dir, "suite.json");
    const output = join(dir, "result.json");
    await writeFile(suite, JSON.stringify([{ id: "sum", prompt: "2+2", expected: "4" }]));
    const env = { ...process.env, ROTATOR_EVAL_BASE_URL: `http://127.0.0.1:${address.port}/v1/`, ROTATOR_EVAL_API_KEY: "", ROTATOR_EVAL_MODELS: "first,second,third", ROTATOR_EVAL_MAX_TOKENS: "2048" };
    const args = ["--import", "tsx/esm", "scripts/evaluate-auto-routing.ts", suite, "baseline", output];
    await promisify(execFile)(process.execPath, args, { env });
    const artifact = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(artifact.models, ["first", "second", "third"]);
    assert.equal(artifact.maxTokens, 2048);
    assert.equal(artifact.results.length, 3);
    assert.deepEqual(calls.map(call => call.max_tokens), [2048, 2048, 2048]);
    await assert.rejects(promisify(execFile)(process.execPath, args, { env: { ...env, ROTATOR_EVAL_MAX_TOKENS: "0" } }));
    assert.equal(calls.length, 3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
