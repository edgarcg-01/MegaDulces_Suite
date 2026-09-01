/**
 * PM2 ecosystem — carril continuo de CFDIs del ADD de ContPAQi → `fiscal.cfdis` (LC.1.1).
 *
 * Sustituye la idea de "un importer que corre de madrugada": arranca del sello del ADD
 * (`Documento.TimeStamp`, guardado en `analytics.feed_watermarks`) y en cada vuelta solo
 * trae lo que cambió. Medido 2026-09-01: una pasada sin novedad tarda **1.6 s** contra los
 * minutos que costaba releer los 167 mil comprobantes.
 *
 * DOS CARRILES, misma lógica que la réplica de Wincaja:
 *   - contpaqi-cfdis-inc  : incremental por watermark, barato → cada 5 min.
 *   - contpaqi-cfdis-full : recorrido por año, caro → una vez al día. Es el RECONCILIADOR:
 *     si algún cambio del ADD no tocara el sello, esta pasada lo levanta igual.
 *
 * ON-PREM ONLY: lee SQL Server `COMPAC` en 192.168.0.35, que Railway no alcanza. Correr en
 * una máquina de la LAN. Escribe a la DB de plataforma por DATABASE_URL_NEW.
 *
 * Arranque (una vez, en la box de la LAN):
 *   pm2 start database/importers/contpaqi/ecosystem.contpaqi.config.js
 *   pm2 save
 *   pm2 startup         # (una vez) para que reviva tras reinicio de Windows
 *
 * Operación: pm2 ls · pm2 logs contpaqi-cfdis-inc · pm2 restart contpaqi-cfdis-full
 * Observabilidad: ambos carriles laten a `analytics.cron_runs` con job_key
 * `contpaqi_add_cfdis` (Salud BD). Umbral sugerido: inc ~15 min, full ~26 h.
 */

const path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..'); // .../Trade_marketing
const SCRIPT = 'database/importers/contpaqi/import-contpaqi-cfdis.js';

// PM2 no hereda el entorno del shell de forma confiable, y sin esta variable el importer
// escribiría a la base equivocada (el default del script es la local :5433) y el heartbeat
// quedaría mudo — que es justo cómo la réplica de Wincaja pasó 4 días en cero diciendo
// "online". Se falla ACÁ, al arrancar, en vez de dos días después en un log que nadie mira.
const DB = process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;
if (!DB) {
  throw new Error('falta DATABASE_URL_NEW: expórtala antes de "pm2 start" — el importer y el heartbeat la necesitan');
}

const base = {
  cwd: REPO,
  autorestart: true,
  max_restarts: 50,
  restart_delay: 30000,
  env: { DATABASE_URL_NEW: DB },
};

module.exports = {
  apps: [
    {
      ...base,
      name: 'contpaqi-cfdis-inc',
      script: SCRIPT,
      args: '--apply --watch 300',
    },
    {
      ...base,
      name: 'contpaqi-cfdis-full',
      script: SCRIPT,
      args: '--apply --full --from 2018-01-01 --watch 86400',
    },
  ],
};
