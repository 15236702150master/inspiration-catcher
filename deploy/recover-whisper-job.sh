#!/usr/bin/env bash
set -euo pipefail
job_id="4b081a3e-de76-46d1-9494-0a1dda0a355c"
source /home/zyw/transcribe_jobs/worker.env
transcript="/home/zyw/transcribe_jobs/output/$job_id/$job_id.txt"
payload="$(/home/zyw/miniconda3/envs/whisper310/bin/python - "$transcript" <<'PY'
import json, sys
from pathlib import Path
print(json.dumps({"transcript": Path(sys.argv[1]).read_text(encoding="utf-8")}, ensure_ascii=False))
PY
)"
curl -fsS -X POST "$INSPIRATION_BASE_URL/api/worker/complete/$job_id" -H "Host: $INSPIRATION_HOST_HEADER" -H "Authorization: Bearer $INSPIRATION_WORKER_TOKEN" -H 'Content-Type: application/json' --data "$payload"
