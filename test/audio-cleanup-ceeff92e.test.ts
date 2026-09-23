import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const repoRoot = resolve(".");
const candidatePath = resolve(repoRoot, "test/audio-timeout-ceb5d79d.test.ts");

test("audio timeout test cleanup preserves sibling files", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "audio-cleanup-ceeff92e-"));
  const sharedTmpDir = join(tempRoot, "shared");
  const marker = join(sharedTmpDir, "sibling.marker");
  const copiedTest = join(tempRoot, "audio-timeout-poc.test.ts");

  try {
    await mkdir(sharedTmpDir, { recursive: true });
    await writeFile(marker, "must survive cleanup of the test-specific child\n", { flag: "wx" });

    const source = await readFile(candidatePath, "utf8");
    const relocated = source
      .replace(
        'const tmpDir = ".tmp_audit_poc/01a0cb4f-1df2-78c1-a370-f700d9497efb/r2/promoted-timeout";',
        `const tmpDir = ${JSON.stringify(sharedTmpDir)};`,
      )
      .replaceAll('"../src/', `"${pathToFileURL(`${resolve(repoRoot, "src")}${sep}`).href}`);
    assert.notEqual(relocated, source, "candidate test did not contain the expected temp path");
    await writeFile(copiedTest, relocated, { flag: "wx" });

    const result = spawnSync(process.execPath, ["--import", "tsx/esm", "--test", copiedTest], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        TUXEVIL_ROTATOR_ADMIN_TOKEN: "",
        PI_ROTATOR_ADMIN_TOKEN: "",
        ANTIGRAVITY_CLIENT_ID: "test-client-id",
        ANTIGRAVITY_CLIENT_SECRET: "test-client-secret",
        TUXEVIL_ROTATOR_DIR: join(sharedTmpDir, "config"),
      },
    });
    if (result.error) throw result.error;
    assert.equal(
      result.status,
      0,
      `candidate test did not complete successfully (status=${result.status}, signal=${result.signal})\n${result.stdout}\n${result.stderr}`,
    );
    await access(marker);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
