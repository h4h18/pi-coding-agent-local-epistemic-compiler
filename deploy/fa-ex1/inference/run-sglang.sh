#!/usr/bin/env bash
set -euo pipefail

# SGLang is not a selected runtime until an explicit gfx1151 qualification
# record exists. This host/script refuses.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
RECORD="${SGLang_GFX1151_RECORD:-${REPO_ROOT}/config/models/runtime-sglang-gfx1151.json}"

python3 - "${RECORD}" <<'PY'
import json
import sys

path = sys.argv[1]
try:
    with open(path, encoding="utf-8") as handle:
        record = json.load(handle)
except OSError:
    print('{"ok":false,"runtimeId":"sglang-gfx1151","qualificationStatus":"unqualified","reason":"no gfx1151 qualification record"}')
    sys.exit(1)

status = record.get("qualificationStatus")
runtime_id = record.get("runtimeId")
if runtime_id != "sglang-gfx1151" or status not in ("measured", "selected"):
    print(json.dumps({
        "ok": False,
        "runtimeId": "sglang-gfx1151",
        "qualificationStatus": status or "unqualified",
        "reason": "SGLang refused until gfx1151 qualificationStatus is measured or selected",
    }))
    sys.exit(1)
print(json.dumps({"ok": True, "runtimeId": "sglang-gfx1151"}))
PY
