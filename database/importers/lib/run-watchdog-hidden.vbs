' Lanza health-watchdog.js SIN mostrar consola (WindowStyle=0, oculto).
' Tarea independiente (NO acoplada a WincajaLive) para que vigile aunque otro feed se cuelgue.
' Uso desde Task Scheduler: wscript.exe "C:\...\lib\run-watchdog-hidden.vbs"
Set sh = CreateObject("WScript.Shell")
node = "node ""C:\Users\Sistemas\CascadeProjects\Trade_marketing\database\importers\lib\health-watchdog.js"""
' 0 = ventana oculta ; True = esperar a que termine
sh.Run "cmd /c cd /d ""C:\Users\Sistemas\CascadeProjects\Trade_marketing"" && " & node, 0, True
