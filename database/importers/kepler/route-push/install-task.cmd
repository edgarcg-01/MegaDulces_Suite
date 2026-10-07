@echo off
REM ============================================================================
REM  Instala la tarea del push de ruta — corre OCULTO (sin consolas).
REM  Ejecutar UNA vez como ADMINISTRADOR.
REM
REM  Como SYSTEM -> sin contrasena, corre logueado o no, SIN ventana visible.
REM  Cada 15 min, todo el dia (el merge es idempotente; fuera de horario de ruta
REM  simplemente no hay venta nueva que subir).
REM
REM  Requisito previo: haber copiado push-ruta.cmd (ya con credenciales) a C:\KeplerPush\.
REM ============================================================================
setlocal
set TASKNAME=Ruta27
set CMD=C:\KeplerPush\push-ruta.cmd

if not exist "%CMD%" (
  echo ERROR: no existe %CMD%. Copialo a C:\KeplerPush\ primero.
  pause & exit /b 1
)

schtasks /Create /F /TN "%TASKNAME%" /TR "\"%CMD%\"" /SC MINUTE /MO 15 /RU SYSTEM /RL HIGHEST

if errorlevel 1 ( echo. & echo Fallo la creacion de la tarea. & pause & exit /b 1 )

echo.
echo Tarea "%TASKNAME%" creada. Corre oculta cada 15 min.
echo   Probar ya:   schtasks /Run /TN "%TASKNAME%"
echo   Ver log:     type C:\KeplerPush\push_ruta_27.log
echo   Quitar:      schtasks /Delete /TN "%TASKNAME%" /F
echo.
pause
endlocal
