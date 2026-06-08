@echo off
setlocal enabledelayedexpansion

echo ============================================
echo   Unanet MCP Server Setup for Windows
echo ============================================
echo.
echo This setup installs dependencies, builds the MCP server,
echo creates a local .env file if needed, and configures Claude Desktop.
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed.
    echo.
    echo Install Node.js 20 LTS or newer from https://nodejs.org/
    echo Then run this setup again.
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
for /f "tokens=*" %%i in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%i
if !NODE_MAJOR! LSS 20 (
    echo [ERROR] Found Node.js !NODE_VERSION!, but this project requires Node.js 20 or newer.
    echo Install the current LTS from https://nodejs.org/ and run this setup again.
    pause
    exit /b 1
)
echo [OK] Node.js found: !NODE_VERSION!

where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] npm is not installed properly. Reinstall Node.js and try again.
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('npm --version') do set NPM_VERSION=%%i
echo [OK] npm found: !NPM_VERSION!

echo.
echo Installing dependencies. This may take a few minutes...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] Failed to install dependencies.
    pause
    exit /b 1
)

echo.
echo Building the MCP server...
call npm run build
if %errorlevel% neq 0 (
    echo [ERROR] Failed to build the project.
    pause
    exit /b 1
)
echo [OK] Build completed successfully.

echo.
if not exist .env (
    echo Creating .env from .env.example...
    copy .env.example .env >nul
    echo [OK] Created .env
    echo.
    echo IMPORTANT: Notepad will open .env now.
    echo Fill in UNANET_USERNAME and UNANET_PASSWORD, then save and close Notepad.
    echo Leave UNANET_BASE_URL as https://navapbc.unanet.biz unless your team tells you otherwise.
    pause
    notepad .env
) else (
    echo [OK] .env already exists. Leaving it unchanged.
    choice /C YN /M "Open .env for review now"
    if !errorlevel! equ 1 notepad .env
)

echo.
echo Configuring Claude Desktop...
set CURRENT_DIR=%CD%

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$configDir=Join-Path $env:APPDATA 'Claude';" ^
  "$configPath=Join-Path $configDir 'claude_desktop_config.json';" ^
  "$currentDir=$env:CURRENT_DIR;" ^
  "New-Item -ItemType Directory -Force -Path $configDir | Out-Null;" ^
  "if (Test-Path $configPath) { Copy-Item $configPath ($configPath + '.bak.' + (Get-Date -Format 'yyyyMMddHHmmss')); $config = Get-Content $configPath -Raw | ConvertFrom-Json; } else { $config = [pscustomobject]@{} };" ^
  "if (-not ($config.PSObject.Properties.Name -contains 'mcpServers') -or $null -eq $config.mcpServers) { $config | Add-Member -Force -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}); };" ^
  "$server = [ordered]@{ command = 'cmd.exe'; args = @('/c', ('cd /d ""' + $currentDir + '"" && node dist\index.js')) };" ^
  "if ($config.mcpServers.PSObject.Properties.Name -contains 'unanet') { $config.mcpServers.unanet = $server } else { $config.mcpServers | Add-Member -NotePropertyName unanet -NotePropertyValue $server };" ^
  "$config | ConvertTo-Json -Depth 20 | Set-Content -Encoding UTF8 $configPath;" ^
  "Write-Host ('[OK] Updated Claude Desktop config: ' + $configPath);"

if %errorlevel% neq 0 (
    echo [ERROR] Failed to update Claude Desktop configuration.
    echo You can still configure it manually using the README instructions.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Setup Complete!
echo ============================================
echo.
echo Next steps:
echo 1. Fully quit and reopen Claude Desktop.
echo 2. Ask Claude: "Show my Unanet leave balances."
echo 3. If tools do not appear, check Claude Desktop's MCP logs.
echo.
echo Note: This setup stores credentials only in the local .env file.
echo The Claude Desktop config points to this project and does not contain your password.
echo.
pause
