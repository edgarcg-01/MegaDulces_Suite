' ⛔⛔ RETIRADO [CT.2, 2026-09-24]. NO volver a registrar esta tarea.
'
' El watchdog tiene UN dueño desde la Fase VL: la línea `*/5 * * * * watchdog` de
' ops/vl/crontab.feeds, dentro del contenedor `feeds-cron` en el servidor `md`.
'
' Levantarlo también acá crea un SEGUNDO escritor del mismo `job_key`, y
' `analytics.cron_runs` tiene PRIMARY KEY (tenant_id, job_key) SIN host: los dos se
' pisan el renglón y uno le presta el pulso al otro. No es hipotético — ops/README.md
' ya documenta que el watchdog se pisó exactamente así.
'
' Medido antes de escribir esto: en 7 días, los 9 hosts que escribieron `health_watchdog`
' en `analytics.cron_run_log` son IDs de contenedor (el `feeds-cron` recreándose). Ninguna
' máquina Windows. La tarea está muerta de hecho; esta cabecera la declara muerta de derecho.
'
' Se conserva el archivo, no se borra: documenta el lanzador oculto que usaba `.249`.
'
' ── original ──────────────────────────────────────────────────────────────────────────
' Lanza health-watchdog.js SIN mostrar consola (WindowStyle=0, oculto).
' Tarea independiente (NO acoplada a WincajaLive) para que vigile aunque otro feed se cuelgue.
' Uso desde Task Scheduler: wscript.exe "C:\...\lib\run-watchdog-hidden.vbs"
Set sh = CreateObject("WScript.Shell")
node = "node ""C:\Users\Sistemas\CascadeProjects\Trade_marketing\database\importers\lib\health-watchdog.js"""
' 0 = ventana oculta ; True = esperar a que termine
sh.Run "cmd /c cd /d ""C:\Users\Sistemas\CascadeProjects\Trade_marketing"" && " & node, 0, True
