@echo off
REM ============================================================================
REM  Instala la tarea del extractor de tickets EN VIVO de Wincaja en .249.
REM  Ejecutar UNA vez como ADMINISTRADOR.
REM
REM  Patron (mismo que WincajaSyncActual / Nightly / Stock): corre como
REM  "Desarrollo MD" INTERACTIVO (/IT) para que vea el drive Z: mapeado.
REM  SYSTEM NO sirve aca (no ve drives de usuario) — a diferencia de LivePoller
REM  (Kepler), que lee Postgres y sí corre como SYSTEM.
REM
REM  Cada 5 min, un ciclo --once. La frescura real = cadencia de SyncBack (copia
REM  el .mdb a Z:) + estos 5 min.
REM
REM  Requisitos previos:
REM    - <repo>\.env con STORE_INGEST_URL (ya) + STORE_INGEST_KEY (pegar el valor de prod).
REM    - "Desarrollo MD" logueado (Interactive) — igual que las demas tareas de feeds.
REM ============================================================================
setlocal
set "TASKNAME=Tienda\WincajaLive"
set "USERID=Desarrollo MD"
set "CMD=%~dp0wincaja-live-poller.cmd"

if not exist "%CMD%" ( echo ERROR: no existe %CMD%. & pause & exit /b 1 )

schtasks /Create /F /TN "%TASKNAME%" /TR "\"%CMD%\"" /SC MINUTE /MO 5 /RU "%USERID%" /IT /RL HIGHEST
if errorlevel 1 ( echo. & echo Fallo la creacion. Si pide password, es la de "%USERID%". & pause & exit /b 1 )

echo.
echo Tarea "%TASKNAME%" creada (cada 5 min, como "%USERID%" interactivo).
echo   Probar ya:   schtasks /Run /TN "%TASKNAME%"
echo   Ver log:     type "%~dp0logs\wincaja-live.log"
echo   Ver estado:  schtasks /Query /TN "%TASKNAME%" /V /FO LIST
echo   Quitar:      schtasks /Delete /TN "%TASKNAME%" /F
echo.
echo IMPORTANTE: antes de correr, poner STORE_INGEST_KEY en ^<repo^>\.env.
echo.
pause
endlocal
