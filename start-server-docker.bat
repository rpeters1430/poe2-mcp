@echo off
title PoE2 MCP Server (Docker)
cd /d "%~dp0"
echo Starting PoE2 MCP Server in Docker...
docker compose up -d
echo.
echo ===============================================================
echo  PoE2 MCP Server is running!
echo ===============================================================
echo  Local Dashboard : http://localhost:8787/
echo  Local MCP URL   : http://localhost:8787/mcp
echo.
echo  For your laptop on LAN, connect to:
echo  LAN MCP URL     : http://192.168.50.163:8787/mcp
echo ===============================================================
echo.
pause
