@echo off
REM ============================================================================
REM  Instala la tarea del push de ruta v2 (REACTIVA A LA RED) desde XML.
REM  Ejecutar UNA vez como ADMINISTRADOR en la laptop de la camioneta.
REM
REM  Requisitos previos en C:\KeplerPush\ :
REM    - push-ruta.cmd     (copiado de push-ruta.v2.template.cmd, ya con credenciales)
REM    - ruta.task.xml     (copiado de este repo)
REM
REM  El XML define: disparo al conectar la red (evento 10000) + heartbeat cada 15 min,
REM  como SYSTEM, oculto, solo si hay red, con reintento en falla.
REM ============================================================================
setlocal
set TASKNAME=Ruta27
set CMD=C:\KeplerPush\push-ruta.cmd
set XML=C:\KeplerPush\ruta.task.xml

if not exist "%CMD%" ( echo ERROR: no existe %CMD%. Copialo primero. & pause & exit /b 1 )
if not exist "%XML%" ( echo ERROR: no existe %XML%. Copialo primero. & pause & exit /b 1 )

schtasks /Create /F /TN "%TASKNAME%" /XML "%XML%"
if errorlevel 1 (
  echo.
  echo Fallo la creacion desde XML. Si el error es de encoding, guarda ruta.task.xml
  echo como UTF-16 LE y cambia la 1a linea a encoding="UTF-16".
  pause & exit /b 1
)

echo.
echo Tarea "%TASKNAME%" creada (reactiva a la red + cada 15 min, oculta).
echo   Probar ya:   schtasks /Run /TN "%TASKNAME%"
echo   Ver estado:  schtasks /Query /TN "%TASKNAME%" /V /FO LIST
echo   Ver log:     type C:\KeplerPush\push_ruta_27.log
echo   Quitar:      schtasks /Delete /TN "%TASKNAME%" /F
echo.
pause
endlocal
