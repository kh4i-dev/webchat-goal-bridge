@echo off
rem Chạy watcher (cần Brave đã mở bằng start_brave_cdp.bat)
cd /d "%~dp0"
node gemini_cdp_watcher.mjs %*
