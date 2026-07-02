@echo off
REM ============================================================================
REM  Proyecto Tienda (TDA) — poller de tickets EN VIVO. Corre en el RUNNER on-prem
REM  (192.168.0.249). Proceso CONTINUO: cada ~25s lee tickets nuevos de las 6
REM  sucursales y los empuja al API de prod (WebSocket /store).
REM
REM  INSTALAR:
REM   1. Rellenar REPO, STORE_INGEST_URL y STORE_INGEST_KEY (esta = la del API).
REM   2. Guardar como store-poller.cmd (sin .template).
REM   3. Arrancar al inicio (una sola instancia):
REM        schtasks /Create /TN "Tienda\LivePoller" /TR "C:\ruta\store-poller.cmd" ^
REM                 /SC ONSTART /RU SYSTEM /RL HIGHEST /F
REM      (o correr a mano en una consola que quede abierta).
REM  El loop reinicia el proceso si node cae (resiliencia).
REM ============================================================================
setlocal

set REPO=C:\ruta\a\Trade_marketing
set STORE_INGEST_URL=https://TU-API-PROD/api/store/live/ingest
set STORE_INGEST_KEY=PON_LA_MISMA_CLAVE_QUE_EL_API
set POLL_SECONDS=25
set WINDOW_MINUTES=5
set NODE_PATH=%REPO%\node_modules

cd /d "%REPO%"

:loop
node database\importers\kepler\live-tickets-poller.js
echo [%date% %time%] poller termino/cayo, reiniciando en 10s...
timeout /t 10 /nobreak >nul
goto loop
