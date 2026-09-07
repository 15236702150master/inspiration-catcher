#!/usr/bin/env bash
set -euo pipefail

URL="$1"
JOB_ID="$2"
WORK_DIR="/tmp/inspiration-catcher-$JOB_ID"
REMOTE_DIR="/home/zyw/transcribe_jobs/input"
mkdir -p "$WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

YT_DLP="${YTDLP_PATH:-yt-dlp}"
if [ -x /home/winner/.local/bin/yt-dlp ]; then YT_DLP=/home/winner/.local/bin/yt-dlp; fi
"$YT_DLP" --no-playlist -f 'bestaudio/best' -o "$WORK_DIR/source.%(ext)s" "$URL" >/dev/null
SOURCE="$(find "$WORK_DIR" -maxdepth 1 -type f -name 'source.*' | head -1)"
if [ -z "$SOURCE" ]; then
  echo "video download produced no media file" >&2
  exit 1
fi

EXT="${SOURCE##*.}"
REMOTE_FILE="$REMOTE_DIR/${JOB_ID}.${EXT}"
ssh myserver "mkdir -p '$REMOTE_DIR'"
scp -q "$SOURCE" "myserver:$REMOTE_FILE"
ssh myserver "/home/zyw/transcribe_jobs/run_whisper_job.sh '$REMOTE_FILE' medium"
ssh myserver "cat '/home/zyw/transcribe_jobs/output/${JOB_ID}/${JOB_ID}.txt'"
