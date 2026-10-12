@echo off
setlocal enabledelayedexpansion
rem
rem One-click setup for local pi + extensions development (Windows).
rem Mirrors install.sh. Does not touch the global %USERPROFILE%\.pi install.
rem

set "DIR=%~dp0"
set "DIR=%DIR:~0,-1%"
set "PI_DIR=%DIR%\pi"
set "AGENT_DIR=%DIR%\.pi-agent"
set "SETTINGS_FILE=%AGENT_DIR%\settings.json"
set "GLOBAL_AUTH=%USERPROFILE%\.pi\agent\auth.json"

set EXTENSIONS=pi-subagents pi-web-access pi-mcp-adapter pi-dynamic-workflows

echo.
echo ==^> Checking toolchain
where node >nul 2>&1 || (echo [error] node not found on PATH ^(need Node ^>= 22.19.0^) & exit /b 1)
where npm  >nul 2>&1 || (echo [error] npm not found on PATH & exit /b 1)
for /f "delims=" %%v in ('node -p process.versions.node') do set "NODE_VERSION=%%v"
echo [ok] node %NODE_VERSION%, npm & call npm -v

if not exist "%PI_DIR%" (
  echo [error] pi monorepo not found at %PI_DIR%
  exit /b 1
)

echo.
echo ==^> Installing pi monorepo dependencies
pushd "%PI_DIR%"
call npm install --ignore-scripts --no-audit --no-fund || (popd & exit /b 1)
popd

echo.
echo ==^> Building pi monorepo (tui -^> ai -^> agent -^> coding-agent -^> orchestrator)
rem Build each package individually so pi-ai can skip model regeneration
rem when models.dev is unreachable (committed catalogs are valid for local dev).
set "MODELS_DEV_OK=1"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { $r = Invoke-WebRequest -Uri 'https://models.dev/api.json' -TimeoutSec 5 -UseBasicParsing; if ($r.StatusCode -ne 200) { exit 1 } } catch { exit 1 }"
if errorlevel 1 (
  echo [warn] models.dev unreachable -- pi-ai will use committed catalogs
  set "MODELS_DEV_OK=0"
)

for %%P in (tui ai agent coding-agent orchestrator) do (
  echo.
  echo -- building pi-%%P
  pushd "%PI_DIR%\packages\%%P"
  if /i "%%P"=="ai" (
    if "!MODELS_DEV_OK!"=="1" (
      call npm run build || (popd & exit /b 1)
    ) else (
      call npm run generate-image-models 2>nul
      call npx tsgo -p tsconfig.build.json || (popd & exit /b 1)
    )
  ) else (
    call npm run build || (popd & exit /b 1)
  )
  popd
  echo [ok] built pi-%%P
)

for %%E in (%EXTENSIONS%) do (
  if not exist "%DIR%\%%E" (
    echo [warn] skip %%E: directory missing
  ) else (
    echo.
    echo ==^> Installing %%E dependencies
    pushd "%DIR%\%%E"
    call npm install --ignore-scripts --no-audit --no-fund || (popd & exit /b 1)
    popd
  )
)

echo.
echo ==^> Linking @earendil-works/* into each extension's node_modules
node "%DIR%\linkdev.mjs" || exit /b 1

echo.
echo ==^> Writing %SETTINGS_FILE%
if not exist "%AGENT_DIR%" mkdir "%AGENT_DIR%"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$exts = '%EXTENSIONS%' -split ' '; $root = '%DIR%'; $paths = @(); foreach ($e in $exts) { $p = Join-Path $root $e; if (Test-Path $p) { $paths += $p } }; $file = '%SETTINGS_FILE%'; try { $s = Get-Content $file -Raw | ConvertFrom-Json } catch { $s = [pscustomobject]@{} }; if ($s.PSObject.Properties.Name -contains 'packages') { $s.packages = $paths } else { $s | Add-Member -NotePropertyName packages -NotePropertyValue $paths }; $s | ConvertTo-Json -Depth 10 | Set-Content $file -Encoding utf8" || exit /b 1

if exist "%GLOBAL_AUTH%" (
  if not exist "%AGENT_DIR%\auth.json" (
    echo.
    echo ==^> Copying global auth.json into .pi-agent
    copy "%GLOBAL_AUTH%" "%AGENT_DIR%\auth.json" >nul
    echo [ok] login state copied
  ) else (
    echo [ok] .pi-agent\auth.json already present
  )
) else (
  echo [warn] no global auth.json found — run pi-dev.bat and log in when prompted
)

echo.
echo ==^> Verifying local extensions are registered
if exist "%PI_DIR%\packages\coding-agent\dist\cli.js" (
  set "PI_CODING_AGENT_DIR=%AGENT_DIR%"
  node "%PI_DIR%\packages\coding-agent\dist\cli.js" list
) else (
  echo [warn] pi CLI not built, skipping list
)

echo.
echo Done. Run %DIR%\pi-dev.bat to launch pi against this checkout.
endlocal
