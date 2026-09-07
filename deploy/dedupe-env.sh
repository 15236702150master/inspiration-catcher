#!/usr/bin/env bash
set -euo pipefail
env_file=/home/op/apps/inspiration-catcher/.env
gateway="$(sed -n 's/^GATEWAY_TOKEN=//p' "$env_file" | grep . | tail -1)"
grep -v '^GATEWAY_TOKEN=' "$env_file" > "$env_file.tmp"
printf 'GATEWAY_TOKEN=%s\n' "$gateway" >> "$env_file.tmp"
mv "$env_file.tmp" "$env_file"
chmod 600 "$env_file"
systemctl --user restart inspiration-catcher.service
