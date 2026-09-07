#!/usr/bin/env bash
set -euo pipefail
echo "ENV_COUNT=$(grep -c '^GATEWAY_TOKEN=' /home/op/apps/inspiration-catcher/.env)"
echo "ENV_LAST_LEN=$(sed -n 's/^GATEWAY_TOKEN=//p' /home/op/apps/inspiration-catcher/.env | tail -1 | wc -c)"
echo "NGINX_HEADER_COUNT=$(sudo grep -c 'X-Inspiration-Gateway' /etc/nginx/conf.d/inspiration.zzhhh.site.conf)"
echo "NGINX_TOKEN_LEN=$(sudo sed -n 's/.*X-Inspiration-Gateway \(.*\);/\1/p' /etc/nginx/conf.d/inspiration.zzhhh.site.conf | tail -1 | wc -c)"
