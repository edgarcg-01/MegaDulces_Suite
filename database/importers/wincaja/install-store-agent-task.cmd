@echo off
REM ============================================================================
REM  Instala el AGENTE de tickets en vivo en el SERVIDOR POS de la tienda.
REM  Ejecutar UNA vez como ADMINISTRADOR en cada servidor (a30/a32/a50...).
REM
REM  Como SYSTEM (el .mdb es LOCAL → SYSTEM lo ve; no hay drive mapeado que dependa
REM  del usuario). ONSTART = arranca al bootear; el .cmd tiene su propio loop que
REM  reinicia el agente si cae.
REM
REM  Requisito previo en C:\WincajaAgent\ :
REM    - wincaja-store-agent.ps1   (copiado de este repo)
REM    - store-agent.cmd           (copiado de store-agent.template.cmd, ya con KEY + config)
REM ============================================================================
setlocal
set "TASKNAME=Tienda\WincajaAgent"
set "CMD=C:\WincajaAgent\store-agent.cmd"

if not exist "%CMD%" ( echo ERROR: no existe %CMD%. Copialo primero. & pause & exit /b 1 )

schtasks /Create /F /TN "%TASKNAME%" /TR "\"%CMD%\"" /SC ONSTART /RU SYSTEM /RL HIGHEST
if errorlevel 1 ( echo. & echo Fallo la creacion. & pause & exit /b 1 )

echo.
echo Tarea "%TASKNAME%" creada (arranca al boot, como SYSTEM, loop ~45s).
echo   Arrancar ya: schtasks /Run /TN "%TASKNAME%"
echo   Ver log:     type C:\WincajaAgent\store-agent.log
echo   Quitar:      schtasks /Delete /TN "%TASKNAME%" /F
echo.
pause
endlocal
