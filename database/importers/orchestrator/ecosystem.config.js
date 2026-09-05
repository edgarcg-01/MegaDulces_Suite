/**
 * ⚠️ NO ADOPTADO (estado al 2026-09-05) — no está corriendo y NADIE depende de él todavía.
 * Distinto de `kepler/ecosystem.cdc.config.js` (⛔ retirado, murió) y de
 * `kepler/ecosystem.sync.config.js` (⛔ retirado, duplicaba dueños): esto **nunca se adoptó**.
 *
 * Medido en prod el 2026-09-05: el schema `pgboss` existe con sus 10 tablas y trae `version`=1 y
 * `queue`=1 — o sea el worker arrancó alguna vez y registró su cola — pero **cero jobs**: ninguna
 * tabla de trabajo tiene una sola fila. La orquestación real sigue siendo el Programador de tareas
 * (21 tareas) + Docker (4 contenedores) + PM2 (los 2 carriles de Wincaja).
 *
 * Se conserva a propósito: es la migración gradual planeada para reemplazar el pilón de
 * `.vbs`/`.cmd`, y el código del worker es la parte difícil. Antes de arrancarlo hay que decidir
 * qué feeds se le pasan (`PGBOSS_MODES`) y APAGAR sus tareas de Windows en la misma maniobra —
 * si no, queda el mismo carril con DOS dueños, que es lo que ya nos costó un carril mudo.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * PM2 — mantiene el worker de feeds vivo (arranca en boot, reinicia al crashear).
 * Reemplaza el pilón de tareas + .vbs + .cmd del Task Scheduler por UN proceso.
 *
 *   pm2 start database/importers/orchestrator/ecosystem.config.js
 *   pm2 logs feed-worker      # ver salida en vivo
 *   pm2 restart feed-worker   # tras cambiar PGBOSS_MODES / schedules.js
 *   pm2 save                  # persistir para que resucite en boot
 *
 * El env NO va acá (secretos): el worker lee `orchestrator.local.env` (gitignored).
 * Ver README.md para instalar PM2 como servicio de Windows y la migración gradual.
 */
const path = require('node:path');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

module.exports = {
  apps: [
    {
      name: 'feed-worker',
      script: path.join(__dirname, 'feed-worker.js'),
      cwd: REPO_ROOT,
      autorestart: true,
      restart_delay: 5000,        // no reinicio en bucle apretado si crashea al boot
      max_restarts: 20,
      max_memory_restart: '400M', // el worker es liviano (los feeds corren como subprocesos aparte)
      kill_timeout: 35000,        // > boss.stop graceful (30s) para drenar antes de matar
      out_file: 'C:/KeplerRunner/logs/feed-worker.log',
      error_file: 'C:/KeplerRunner/logs/feed-worker.err.log',
      merge_logs: true,
      time: true,                 // timestamp en cada línea de log
    },
  ],
};
