#!/usr/bin/env bash
set -euo pipefail
cp /tmp/inspiration-auth-nginx.conf /tmp/inspiration-final.conf
sudo cp /tmp/inspiration-final.conf /etc/nginx/conf.d/inspiration.zzhhh.site.conf
rm -f /tmp/inspiration-auth-nginx.conf /tmp/inspiration-final.conf
sudo nginx -t
sudo systemctl reload nginx
systemctl --user restart inspiration-catcher.service
