' Lanza el poller GPS on-prem SIN ventana (WindowStyle=0, oculto) — mismo patrón
' que C:\KeplerRunner\run-hidden.vbs. Una corrida (FLEET_RUN_ONCE=1); el Task
' Scheduler lo dispara cada minuto. Credenciales viven en el .env del repo.
' Uso: wscript.exe "C:\Users\Sistemas\CascadeProjects\Trade_marketing\database\scripts\fleet-gps-hidden.vbs"
Set sh = CreateObject("WScript.Shell")
sh.Environment("PROCESS")("FLEET_RUN_ONCE") = "1"
' 0 = ventana oculta ; True = esperar (para que IgnoreNew evite solapes)
sh.Run """C:\Program Files\nodejs\node.exe"" ""C:\Users\Sistemas\CascadeProjects\Trade_marketing\database\scripts\fleet-poll-onprem.js""", 0, True
