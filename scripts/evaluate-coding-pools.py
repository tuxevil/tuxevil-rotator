"""Bounded coding trial. Execute generated JavaScript only inside bubblewrap."""
import json
import os
from pathlib import Path
import secrets
import sys
import shutil
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
MODELS = ["gemini-3.8-flash-medium", "gemini-4-argon-medium", "claude-sonnet-5-5-medium", "gpt-6.1-terra"]
TASKS = json.loads((ROOT / "test/fixtures/auto-routing/coding/tasks.json").read_text())
OUTPUT = Path(os.environ.get("CODING_EVAL_OUTPUT", "/tmp/coding-eval-self-test-unused.json"))
NODE = shutil.which("node")
BASE = os.environ.get("ROTATOR_EVAL_BASE_URL", "http://127.0.0.1:51200/v1/").rstrip("/")
KEY = os.environ.get("ROTATOR_EVAL_API_KEY", "")
rows = []
failed = set()
artifact = {"status": "running", "models": MODELS, "maxTokens": 2048, "timeoutSeconds": 45, "results": rows}
# Fail before making requests if the sandbox is unavailable.
base_command = ["bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64", "--ro-bind", NODE, "/node", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--clearenv"]
subprocess.run(base_command + ["/node", "-e", "process.exit(0)"], check=True, timeout=5, capture_output=True)
def grade(code, tests):
    marker = secrets.token_hex(24)
    with tempfile.TemporaryDirectory(prefix="coding-pool-") as directory:
        work = Path(directory)
        (work / "solution.cjs").write_text(code)
        (work / "tests.cjs").write_text("const assert=require('node:assert/strict');const fn=require('./solution.cjs');" + tests + f"\nconsole.log('{marker}');")
        command = base_command + ["--ro-bind", directory, "/work", "--chdir", "/work", "/node", "--max-old-space-size=128", "/work/tests.cjs"]
        result = subprocess.run(command, capture_output=True, timeout=5)
        return result.returncode == 0 and marker.encode() in result.stdout.splitlines()

if "--self-test" in sys.argv:
    references = json.loads((ROOT / "test/fixtures/auto-routing/coding/references.json").read_text())
    for task in TASKS:
        assert grade(references[task["id"]], task["tests"]), task["id"]
        assert not grade("module.exports=()=>null", task["tests"]), task["id"]
    print("Reference solutions pass; broken solutions fail in sandbox")
    sys.exit(0)

with OUTPUT.open("x", encoding="utf8") as report:
    os.chmod(OUTPUT, 0o600)
    def persist():
        report.seek(0)
        json.dump(artifact, report, indent=2)
        report.truncate()
        report.flush()
    persist()
    for index, task in enumerate(TASKS):
        # Rotate all positions rather than leaving one model always in the middle.
        order = MODELS[index % len(MODELS):] + MODELS[:index % len(MODELS)]
        for model in order:
            row = {"task": task["id"], "model": model, "passed": False}
            if model in failed:
                row["error"] = "skipped-after-operational-failure"
                rows.append(row)
                persist()
                continue
            started = time.monotonic()
            try:
                request = urllib.request.Request(BASE + "/chat/completions", data=json.dumps({"model": model, "messages": [{"role": "user", "content": task["prompt"]}], "max_tokens": 2048, "stream": False}).encode(), headers={"content-type": "application/json", "authorization": "Bearer " + KEY})
                with urllib.request.urlopen(request, timeout=45) as response:
                    data = json.load(response)
                choice = data["choices"][0]
                code = choice["message"].get("content")
                row.update({"finishReason": choice.get("finish_reason"), "usage": data.get("usage"), "servedModel": data.get("model")})
                if not isinstance(code, str) or not code.strip():
                    row["error"] = "empty-completion"
                    failed.add(model)
                elif choice.get("finish_reason") == "length":
                    row["error"] = "output-limit"
                else:
                    code = code.strip()
                    if code.startswith("```") and code.endswith("```"):
                        code = code.split("\n", 1)[1].rsplit("```", 1)[0]
                    row["passed"] = grade(code, task["tests"])
                    if not row["passed"]:
                        row["error"] = "code-tests-failed"
            except subprocess.TimeoutExpired:
                row["error"] = "code-timeout"
            except Exception as error:
                status = getattr(error, "code", None)
                row["error"] = f"http-{status}" if isinstance(status, int) else "completion-failed"
                failed.add(model)
            row["latencyMs"] = round((time.monotonic() - started) * 1000)
            rows.append(row)
            persist()
            print(json.dumps({key: row[key] for key in ["task", "model", "passed", "error"] if key in row}), flush=True)
    artifact["status"] = "complete"
    persist()
