#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${INSPIRATION_BASE_URL:-http://193.112.87.124}"
HOST_HEADER="${INSPIRATION_HOST_HEADER:-inspiration.zzhhh.site}"
TOKEN="${INSPIRATION_WORKER_TOKEN:?INSPIRATION_WORKER_TOKEN is required}"
WORK_ROOT="/home/zyw/transcribe_jobs/worker"
mkdir -p "$WORK_ROOT"
exec 9>"$WORK_ROOT/worker.lock"
flock -n 9 || exit 0

claim="$(curl -fsS -X POST "$BASE_URL/api/worker/claim" -H "Host: $HOST_HEADER" -H "Authorization: Bearer $TOKEN")"
job_id="$(printf '%s' "$claim" | /home/zyw/miniconda3/envs/whisper310/bin/python -c 'import json,sys; print((json.load(sys.stdin).get("job") or {}).get("id", ""))')"
[ -n "$job_id" ] || exit 0

media="$WORK_ROOT/$job_id.flac"
result="$WORK_ROOT/$job_id-result.json"
cleanup() { rm -f "$media" "$result"; }
trap cleanup EXIT

report_progress() {
  curl -fsS -X POST "$BASE_URL/api/worker/progress/$job_id" -H "Host: $HOST_HEADER" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data "{\"progress\":$1,\"stage\":\"$2\"}" >/dev/null || true
}

report_progress 32 "正在获取音频"
if curl -fsS "$BASE_URL/api/worker/media/$job_id" -H "Host: $HOST_HEADER" -H "Authorization: Bearer $TOKEN" -o "$media"; then
  report_progress 35 "正在加载 Whisper medium"
  /home/zyw/transcribe_jobs/run_whisper_job.sh "$media" medium &
  whisper_pid=$!
  log_file="/home/zyw/transcribe_jobs/logs/$job_id.log"
  while kill -0 "$whisper_pid" 2>/dev/null; do
    raw_percent="$(grep -aoE '[0-9]{1,3}%' "$log_file" 2>/dev/null | tail -1 | tr -d '%' || true)"
    if [ -n "$raw_percent" ]; then
      mapped=$((35 + raw_percent * 60 / 100))
      report_progress "$mapped" "正在识别音频"
    else
      report_progress 36 "正在加载 Whisper medium"
    fi
    sleep 5
  done
  if wait "$whisper_pid"; then
    report_progress 97 "正在整理转写正文"
  transcript="/home/zyw/transcribe_jobs/output/$job_id/$job_id.txt"
  /home/zyw/miniconda3/envs/whisper310/bin/python - "$transcript" "$result" <<'PY'
import json, sys
from pathlib import Path
from opencc import OpenCC
text = Path(sys.argv[1]).read_text(encoding="utf-8")
text = OpenCC("t2s").convert(text)
Path(sys.argv[2]).write_text(json.dumps({"transcript": text}, ensure_ascii=False), encoding="utf-8")
PY
  else
    printf '{"error":"Gaia Whisper medium transcription failed"}' > "$result"
  fi
else
  printf '{"error":"Gaia Whisper medium transcription failed"}' > "$result"
fi

curl -fsS -X POST "$BASE_URL/api/worker/complete/$job_id" -H "Host: $HOST_HEADER" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data-binary "@$result"

# The cloud keeps only the recovered正文 and task metadata. Remove all raw artifacts from Gaia.
rm -rf "/home/zyw/transcribe_jobs/output/$job_id"
rm -f "/home/zyw/transcribe_jobs/logs/$job_id.log"
