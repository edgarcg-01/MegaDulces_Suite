@echo off
REM ============================================================================
REM  Proyecto Tienda (TDA) — RUNNER del extractor de tickets EN VIVO de Wincaja.
REM  Corre en el RUNNER on-prem (192.168.0.249). Un ciclo (--once) y sale: lo agenda
REM  Task Scheduler cada 5 min (ver install-wincaja-live-task.cmd). Modo --once =
REM  sin proceso huerfano; si un ciclo falla, el scheduler reintenta a los 5 min.
REM
REM  Lee las COPIAS-sombra de los .mdb desde Z:\Salidas\Bases\Actuales (= \\.245\D).
REM  DEBE correr como el usuario que tiene Z: mapeado ("Desarrollo MD"); SYSTEM NO ve Z:.
REM
REM  STORE_INGEST_URL y STORE_INGEST_KEY se leen de <repo>\.env (gitignored) via dotenv.
REM  No hay secretos en este archivo → vive en el repo.
REM ============================================================================
setlocal
set "HERE=%~dp0"
set "REPO=%HERE%..\..\.."
set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
if not exist "%HERE%logs" mkdir "%HERE%logs"

cd /d "%REPO%"
echo [%date% %time%] --- wincaja live --once --- >> "%HERE%logs\wincaja-live.log"
"%NODE%" "%HERE%wincaja-live-extract.js" --once >> "%HERE%logs\wincaja-live.log" 2>&1
endlocal
