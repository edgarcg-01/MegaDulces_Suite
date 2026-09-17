' Levanta los procesos de PM2 al iniciar sesion, SIN mostrar consola (WindowStyle=0, oculto).
'
' [OPS.1] Por que existe. La tarea `PM2 Resurrect ODS` corria `cmd /c pm2.cmd resurrect` DIRECTO,
' asi que abria una ventana de consola en la cara del usuario cada vez que iniciaba sesion. Era la
' UNICA de las cuatro tareas frecuentes de esta maquina sin envoltorio: FeedGuardian, WincajaLive
' y WincajaSyncActual ya usaban este mismo patron (`sh.Run ..., 0, True`).
'
' ⚠️ La tarea NO es residuo, aunque el tracker la tenia anotada asi. Levanta 5 procesos que hoy
' estan vivos y trabajando -- entre ellos los carriles Wincaja (`wincaja-inc`, `wincaja-hash`,
' `wincaja-live-tickets`), que la Fase VL.5 dejo a proposito en esta maquina porque necesitan
' Jet de 32 bits y no se pueden containerizar. Sin esto, un reinicio los deja caidos.
'
' Uso desde el Programador de tareas:
'   wscript.exe "C:\Users\Sistemas\CascadeProjects\Trade_marketing\database\importers\lib\run-pm2-resurrect-hidden.vbs"
Set sh = CreateObject("WScript.Shell")
' 0 = ventana oculta ; True = esperar a que termine
sh.Run "cmd /c ""C:\Users\Sistemas\AppData\Roaming\npm\pm2.cmd"" resurrect", 0, True
