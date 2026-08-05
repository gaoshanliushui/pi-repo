@echo off
setlocal
set "PI_CODING_AGENT_DIR=%~dp0.pi-agent"
node "%~dp0pi\packages\coding-agent\dist\cli.js" %*
endlocal
