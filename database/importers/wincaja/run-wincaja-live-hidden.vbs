' Lanza run-wincaja-live.ps1 SIN mostrar consola (WindowStyle=0, oculto).
' Mismo patron que C:\KeplerRunner\run-hidden.vbs: la tarea sigue Interactive
' (necesita Z: mapeado + PowerShell 32-bit/Jet de la sesion del usuario) pero ya
' no aparece ninguna ventana de PowerShell cada N min.
' Uso desde Task Scheduler: wscript.exe "C:\...\wincaja\run-wincaja-live-hidden.vbs"
Set sh = CreateObject("WScript.Shell")
ps = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""C:\Users\Sistemas\CascadeProjects\Trade_marketing\database\importers\wincaja\run-wincaja-live.ps1"""
' 0 = ventana oculta ; True = esperar a que termine (IgnoreNew evita solapes)
sh.Run ps, 0, True
