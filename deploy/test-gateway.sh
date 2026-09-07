#!/usr/bin/env bash
set -euo pipefail
token="$(sed -n 's/^GATEWAY_TOKEN=//p' /home/op/apps/inspiration-catcher/.env | tail -1)"
payload='{"baseUrl":"https://api.deepseek.com/v1/chat/completions","model":"deepseek-chat","protocol":"openai"}'
curl -sS -o /tmp/gateway-test-body -w 'DIRECT=%{http_code}\n' -X PUT http://127.0.0.1:4173/api/settings/providers/deepseek -H "X-Inspiration-Gateway: $token" -H 'Content-Type: application/json' --data "$payload"
rm -f /tmp/gateway-test-body
