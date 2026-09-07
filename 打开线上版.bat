@echo off
cd /d "%~dp0"
start "" "https://inspiration.zzhhh.site"
start "" notepad "%~dp0.private\credentials.txt"
exit /b 0
