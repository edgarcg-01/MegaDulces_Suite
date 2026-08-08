@echo off
REM ============================================================================
REM  AGENTE de tickets en vivo Wincaja — corre EN EL SERVIDOR POS de la tienda.
REM  Loop: cada ~45s lanza el agente PS (--once) que lee el .mdb VIVO LOCAL read-only
REM  y empuja los tickets nuevos al API de prod (WS /store -> /tienda/live).
REM
REM  INSTALAR (por tienda):
REM   1. Copiar wincaja-store-agent.ps1 + este archivo a C:\WincajaAgent\ del servidor POS.
REM   2. Renombrar este a store-agent.cmd (SIN .template) y rellenar los <...> + KEY.
REM   3. schtasks /Create /TN "Tienda\WincajaAgent" /TR "C:\WincajaAgent\store-agent.cmd" ^
REM               /SC ONSTART /RU SYSTEM /RL HIGHEST /F   (o usar install-store-agent-task.cmd)
REM
REM  Corre como SYSTEM (archivo .mdb LOCAL, no necesita drive mapeado). Lee read-only:
REM  NO bloquea la caja. Este archivo lleva la KEY -> vive FUERA del repo (gitignored).
REM ============================================================================
setlocal
set "PS32=C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe"
set "AGENT=%~dp0wincaja-store-agent.ps1"

REM ===== CONFIG POR TIENDA (rellenar) =========================================
set "STORE_INGEST_URL=https://trademarketing-production-5084.up.railway.app/api/store/live/ingest"
set "STORE_INGEST_KEY=<PEGAR_LA_KEY_DEL_API>"
set "MDB=D:\Datos\WinCaja\30 MORELIA ABASTOS.mdb"
set "WHCODE=MD-30"
set "WHNAME=Morelia Abastos"
set "SECONDS=45"
REM ============================================================================

set "LOG=%~dp0store-agent.log"
if not exist "%AGENT%" ( echo ERROR: no existe %AGENT% >> "%LOG%" & exit /b 1 )

:loop
"%PS32%" -NoProfile -ExecutionPolicy Bypass -File "%AGENT%" -Mdb "%MDB%" -WarehouseCode "%WHCODE%" -WarehouseName "%WHNAME%" -Once >> "%LOG%" 2>&1
timeout /t %SECONDS% /nobreak >nul
goto loop
