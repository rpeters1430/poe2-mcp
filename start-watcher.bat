@echo off
title PoE2 Clipboard Watcher
cd /d "%~dp0"
if not exist "dist\clipboard-watcher.js" (
    echo Building project...
    call npm run build
)
echo Starting Path of Exile 2 Ctrl+C Clipboard Watcher...
node dist/clipboard-watcher.js
pause
