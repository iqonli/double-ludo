import json
import os
import re
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

temp_data = tempfile.TemporaryDirectory(prefix="double-flight-random-port-")
env = os.environ.copy()
env.pop("PORT", None)
env["DATA_DIR"] = temp_data.name
process = subprocess.Popen(
    ["node", "server.js"],
    cwd=ROOT,
    env=env,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    bufsize=1,
)
result = {"ok": False, "port": None, "inRange": False, "apiMatches": False, "fileClientCors": False, "log": ""}
lines = []
try:
    deadline = time.time() + 10
    port = None
    while time.time() < deadline and process.poll() is None:
        line = process.stdout.readline()
        if not line:
            time.sleep(0.05)
            continue
        lines.append(line)
        match = re.search(r"本次随机端口：(\d+)", line)
        if match:
            port = int(match.group(1))
            break
    if port is None:
        raise RuntimeError("未读取到随机端口")
    result["port"] = port
    result["inRange"] = 6666 <= port <= 8888
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/info", timeout=5) as response:
        info = json.loads(response.read().decode("utf-8"))
    result["apiMatches"] = info.get("port") == port and info.get("portRange") == [6666, 8888]
    options = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/login",
        method="OPTIONS",
        headers={
            "Origin": "null",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
            "Access-Control-Request-Private-Network": "true",
        },
    )
    with urllib.request.urlopen(options, timeout=5) as response:
        headers = {key.lower(): value for key, value in response.headers.items()}
    result["fileClientCors"] = (
        headers.get("access-control-allow-origin") == "*"
        and headers.get("access-control-allow-private-network") == "true"
    )
    result["ok"] = result["inRange"] and result["apiMatches"] and result["fileClientCors"]
finally:
    process.terminate()
    try:
        tail, _ = process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        tail, _ = process.communicate()
    result["log"] = "".join(lines) + tail
    temp_data.cleanup()

out = ROOT / "tests/random-port-smoke.json"
out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(result, ensure_ascii=False, indent=2))
raise SystemExit(0 if result["ok"] else 1)
