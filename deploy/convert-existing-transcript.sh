#!/usr/bin/env bash
set -euo pipefail
job_id="4b081a3e-de76-46d1-9494-0a1dda0a355c"
source /home/zyw/transcribe_jobs/worker.env
input=/tmp/${job_id}.txt
output=/tmp/${job_id}-simplified.json
/home/zyw/miniconda3/envs/whisper310/bin/python - "$input" "$output" <<'PY'
import json, sys
from pathlib import Path
from opencc import OpenCC
text = OpenCC("t2s").convert(Path(sys.argv[1]).read_text(encoding="utf-8"))
Path(sys.argv[2]).write_text(json.dumps({"transcript": text}, ensure_ascii=False), encoding="utf-8")
PY
curl -fsS -X POST "$INSPIRATION_BASE_URL/api/worker/complete/$job_id" -H "Host: $INSPIRATION_HOST_HEADER" -H "Authorization: Bearer $INSPIRATION_WORKER_TOKEN" -H 'Content-Type: application/json' --data-binary "@$output"
rm -f "$input" "$output"
