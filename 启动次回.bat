@echo off
setlocal
title 次回 jikai

rem ===============================================================
rem  本文件编码为 GBK(cp936)，与简体中文 Windows 的 cmd 原生一致。
rem  不要另存为 UTF-8，否则中文提示会乱码、批处理按字节解析还会错位。
rem ===============================================================

cd /d "%~dp0"

echo.
echo   ==========================================
echo     次回  jikai
echo   ==========================================
echo.

rem ---------------------------------------------------------------
rem 0. 清掉会捣乱的环境变量：
rem    ELECTRON_RUN_AS_NODE=1 会让 electron.exe 退化成普通 node，
rem    桌面壳直接起不来，所以必须先清空。
rem ---------------------------------------------------------------
set "ELECTRON_RUN_AS_NODE="

rem ---------------------------------------------------------------
rem 1. 找 npm。优先 PATH，找不到再兜到 Node.js 默认安装目录——
rem    双击运行时继承的是系统 PATH，未必有开发环境里的那一条。
rem ---------------------------------------------------------------
set "NPM="
for %%I in (npm.cmd) do if not defined NPM set "NPM=%%~$PATH:I"
if not defined NPM if exist "%ProgramFiles%\nodejs\npm.cmd" set "NPM=%ProgramFiles%\nodejs\npm.cmd"
if not defined NPM if exist "%ProgramFiles(x86)%\nodejs\npm.cmd" set "NPM=%ProgramFiles(x86)%\nodejs\npm.cmd"

rem ---------------------------------------------------------------
rem 2. 定位 Electron 本体与前端产物（直接跑 exe，不依赖 PATH）
rem ---------------------------------------------------------------
set "ELECTRON=%~dp0node_modules\electron\dist\electron.exe"
set "DIST_HTML=%~dp0dist\index.html"

if not exist "%ELECTRON%" goto install
goto check_build

rem ---------------------------------------------------------------
:install
echo   [!] 还没装依赖（找不到 Electron 本体）。
if not defined NPM (
  echo.
  echo   [x] 同时也没找到 npm，说明这台机器还没装 Node.js。
  echo       请先装 Node.js 18 或更新版本，再双击本文件：
  echo         https://nodejs.org/
  echo.
  pause
  exit /b 1
)
echo       正在执行 npm install，第一次要几分钟，请别关这个窗口...
echo.
call "%NPM%" install
if errorlevel 1 (
  echo.
  echo   [x] npm install 失败了，把上面的报错截图保留下来就行。
  echo.
  pause
  exit /b 1
)
echo.
if not exist "%ELECTRON%" (
  echo   [x] 装完了但仍然找不到 Electron 本体，状态不正常。
  echo       建议删掉 node_modules 目录后重新双击本文件。
  echo.
  pause
  exit /b 1
)
goto check_build

rem ---------------------------------------------------------------
:check_build
if not exist "%DIST_HTML%" goto build
goto launch

rem ---------------------------------------------------------------
:build
echo   [i] 还没构建前端产物，正在执行 npm run build...
echo.
call "%NPM%" run build
if errorlevel 1 (
  echo.
  echo   [x] 构建失败，把上面的报错截图保留下来就行。
  echo.
  pause
  exit /b 1
)
if not exist "%DIST_HTML%" (
  echo   [x] 构建跑完了却没产出 dist\index.html，状态不正常。
  echo.
  pause
  exit /b 1
)

rem ---------------------------------------------------------------
:launch
echo   启动中，桌面窗口马上出来...
echo   （这个黑窗口会自己关掉；想退出程序，关掉那个窗口就行）
echo.
start "" "%ELECTRON%" "%~dp0."

endlocal
exit /b 0
