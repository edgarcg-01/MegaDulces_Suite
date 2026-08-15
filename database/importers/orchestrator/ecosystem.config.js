/**
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
