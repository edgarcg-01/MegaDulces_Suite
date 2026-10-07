REM ============================================================================
REM  [VL.11.B] RETIRADO 2026-09-23 -- WINCAJA YA NO EXISTE.
REM
REM  Los tres POS que usaban este agente migraron a Kepler y lo confirman los datos,
REM  no una nota: en analytics.store_live_tickets los codigos MD-* cortan EXACTAMENTE
REM  en su fecha de migracion y llevan 0 tickets en 24 h.
REM
REM      MD-32  Morelia Madero   ultimo ticket 2026-09-07 19:22  -> Kepler md_07 (08-sep)
REM      MD-30  Morelia Abastos  ultimo ticket 2026-09-18 20:40  -> Kepler md_08 (18-sep)
REM      50     Canindo                                          -> Kepler '06'
REM
REM  Hoy los tickets de las 8 ramas los lee `store-poller`, que corre EN `md` y no en
REM  una caja. Este archivo se conserva como historia y por si algun POS volviera a
REM  Wincaja; su URL quedo apuntando al destino interno correcto.
REM
REM  ⚠️ NO es la fuente viva de nada. Antes de usarlo, medir.
REM ============================================================================
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
REM  [VL.11.B] DESTINO INTERNO. `interno.megadulcessuite.com` es un registro PUBLICO
REM  que apunta a 192.168.0.222 -- el servidor `md`, en la red de la empresa. El ticket
REM  deja de salir a internet para llegar a una maquina de la misma red.
REM
REM  ⚠️ SIGUE SIENDO https:// Y NO ES UN DETALLE: la llave viaja en una cabecera, y
REM  `install-service.js` RECHAZA una URL que no sea https por ese motivo. El
REM  certificado es publico (Let's Encrypt), no autofirmado.
REM
REM  Sondeado el 2026-09-23: los 8 routers de plaza devuelven la IP privada sin
REM  filtrar, asi que este nombre resuelve en TODAS las sucursales sin tocar la red.
set "STORE_INGEST_URL=https://interno.megadulcessuite.com/api/store/live/ingest"
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
