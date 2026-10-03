import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getProxyExposureWarning,
  isLoopbackBindHost,
  isRunningInContainer,
} from "../src/exposure.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("public exposure guardrails", () => {
  it("recognizes loopback bind hosts", () => {
    assert.equal(isLoopbackBindHost("localhost"), true);
    assert.equal(isLoopbackBindHost("127.0.0.1"), true);
    assert.equal(isLoopbackBindHost("::1"), true);
    assert.equal(isLoopbackBindHost("0.0.0.0"), false);
    assert.equal(isLoopbackBindHost("192.168.1.10"), false);
  });

  it("warns when unauthenticated proxy routes bind to non-loopback", () => {
    const warning = getProxyExposureWarning(
      { bindHost: "0.0.0.0", proxyPort: 51200 },
      false,
    );

    assert.match(warning || "", /unauthenticated by design/);
    assert.match(warning || "", /bindHost to 127\.0\.0\.1/);
  });

  it("points at the published port instead of bindHost inside a container", () => {
    const warning = getProxyExposureWarning(
      { bindHost: "0.0.0.0", proxyPort: 51200 },
      true,
    );

    assert.match(warning || "", /unauthenticated by design/);
    assert.match(warning || "", /inside this container/);
    assert.match(warning || "", /docker-compose\.yml publishes it on 127\.0\.0\.1/);
    assert.doesNotMatch(warning || "", /bindHost/);
  });

  it("treats TUXEVIL_ROTATOR_CONTAINER=1 as running in a container", () => {
    assert.equal(isRunningInContainer({ TUXEVIL_ROTATOR_CONTAINER: "1" }), true);
  });

  it("does not warn for local-only proxy binds", () => {
    const warning = getProxyExposureWarning({
      bindHost: "127.0.0.1",
      proxyPort: 51200,
    });

    assert.equal(warning, null);
  });

  it("ships Docker compose with localhost-only port publishing by default", () => {
    const compose = readFileSync(
      join(__dirname, "..", "docker-compose.yml"),
      "utf-8",
    );

    assert.match(compose, /127\.0\.0\.1:51200:51200/);
  });

  it("marks the Docker image as a container", () => {
    const dockerfile = readFileSync(join(__dirname, "..", "Dockerfile"), "utf-8");

    assert.match(dockerfile, /^ENV TUXEVIL_ROTATOR_CONTAINER=1$/m);
  });
});
