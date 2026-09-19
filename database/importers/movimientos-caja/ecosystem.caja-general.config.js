/**
 * CG.9e — PM2 ecosystem de la **CAJA GENERAL**. Hermano del de Wincaja: mismo Jet 32-bit, misma
 * máquina (`.249`), y exactamente el mismo motivo para existir.
 *
 * ── Por qué esto es la mitad que faltaba ───────────────────────────────────────────────────────
 *
 * CG.9c/CG.9d dejaron el dato entrando por `derive-no-copy`, pero **un carril que nadie agenda no
 * corre**. Y eso no es hipotético, es el incidente que fundó esta fase:
 *
 *   `import-caja-general.js` se retiró de `intraday`/`nightly` el 2026-09-15 (esos carriles corren
 *   en `md`/Linux y él exige PowerShell + ACE.OLEDB + `Z:`). Quedó sólo en el modo `finance`, que
 *   **no está en `ops/vl/crontab.feeds` ni en ninguna otra agenda**. Resultado: `analytics.caja_*`
 *   congelada desde el **2026-09-11**, y el tablero en `ok` los cuatro días — porque
 *   `run-prod-feeds.js` sólo marca `error` si fallan TODOS los pasos.
 *
 * Dejar el reemplazo colgando del mismo modo `finance` habría sido repetir el defecto con
 * arquitectura nueva. Por eso van bajo PM2, con latido propio por carril y umbral ya registrado en
 * `CRON_JOBS` (`caja_general_replica_all`, `caja_general_ship`).
 *
 * ── DOS CARRILES ───────────────────────────────────────────────────────────────────────────────
 *
 *   caja-general-replica : los `.mdb` → espejo crudo `:5433/caja_general`. Jet 32-bit sobre `Z:`.
 *                          TODO es hash-delta (nada incremental, y está MEDIDO: la PK de `Doctos`
 *                          tiene dos ejes y un watermark escalar dejaría 23,355 filas invisibles
 *                          para siempre). Una pasada completa de las dos ramas: **~192 s**
 *                          (cg20 145 s + cgarq20 47 s) → cadencia @30 min, no @2.
 *   caja-general-ship    : espejo → `caja_general_ods` de la plataforma. Postgres→Postgres, barato
 *                          (2ª pasada medida: **127 filas leídas, 0 escritas**) → @5 min. Es el que
 *                          de verdad decide si la pantalla está fresca.
 *
 * El orden importa poco (el ship toma lo que haya), pero la cadencia sí: ship más rápido que la
 * réplica es gratis y acorta el rezago total a ~35 min en el peor caso.
 *
 * ⚠️ ON-PREM ONLY. Jet 32-bit + `Z:` (= `\\192.168.0.245\D`) ⇒ corre en `.249`, junto a los tres
 * carriles de Wincaja. NO va en `md` (Linux) hasta VL.5. Es la misma restricción que ya existía, no
 * una nueva.
 *
 * Arranque (una vez, en `.249`):
 *   $env:DATABASE_URL_NEW = '<url de la plataforma>'
 *   pm2 start database/importers/movimientos-caja/ecosystem.caja-general.config.js
 *   pm2 save
 *   pm2 startup          # (una vez) para que reviva tras reinicio de Windows
 *
 * ⛔ `pm2 save` NO es opcional. `.249` se reinicia solo por Windows Update —el 2026-09-11 se
 * reinició dos veces de noche y Docker no volvió hasta las 08:35 con el login: **9.5 h sin
 * ingesta**. Sin `pm2 save` + `pm2 startup`, estos dos carriles se van con el reinicio y volvemos
 * al congelamiento silencioso.
 *
 * Operación:  pm2 ls · pm2 logs caja-general-ship · pm2 restart caja-general-replica
 */

const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..'); // .../Trade_marketing
const REPLICA = 'database/importers/movimientos-caja/replicate-caja-general-live.js';
const SHIP = 'database/importers/movimientos-caja/ship-caja-general.js';

/**
 * El latido escribe a `analytics.cron_runs` de la PLATAFORMA, y el ship escribe ahí su dato. PM2 no
 * hereda el entorno del shell de forma confiable, así que se pasa explícita y se falla ACÁ, al
 * arrancar.
 *
 * Es la misma lección que el ecosystem de Wincaja documenta con su propio muerto: sin esta variable
 * los carriles corren MUDOS y `pm2 ls` dice "online" igual. Fallar al arrancar cuesta un minuto; no
 * fallar costó 4 días de réplica en cero (27→31 ago 2026).
 */
const DB = process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;
if (!DB) {
  throw new Error('falta DATABASE_URL_NEW: exportala antes de "pm2 start". La necesitan el latido '
    + '(cron_runs) y el destino del ship. Sin ella los dos carriles corren mudos y pm2 dice online.');
}

/**
 * Dónde vive el ESPEJO. Se deja con default explícito porque, a diferencia de Wincaja, esta base
 * todavía no se mudó a `md` — nació en `.249` y ahí sigue.
 *
 * ⚠️ Cuando se mude (VL), acordarse de que el default de abajo apunta al Postgres viejo: arrancar
 * sin la variable haría que el carril escriba feliz a una base que nadie lee, con pm2 en verde. Es
 * exactamente el modo de falla que el ecosystem de Wincaja describe para `WINCAJA_REPLICA_URL`.
 */
const REPLICA_URL = process.env.CAJA_GENERAL_REPLICA_URL
  || 'postgresql://postgres:superoot@localhost:5433/caja_general';

const base = {
  cwd: REPO,
  autorestart: true,
  max_restarts: 50,
  restart_delay: 5000,
  time: true,
  env: { DATABASE_URL_NEW: DB, CAJA_GENERAL_REPLICA_URL: REPLICA_URL },
};

module.exports = {
  apps: [
    // .mdb → espejo crudo. Pesado (lee y hashea 147k filas), cadencia baja.
    { name: 'caja-general-replica', script: REPLICA, args: '--watch=30', ...base },
    // espejo → caja_general_ods. Barato, cadencia alta. `--apply` explícito: el script es
    // dry-run por default a propósito, y un carril agendado en dry-run es un carril mudo.
    { name: 'caja-general-ship', script: SHIP, args: '--apply --watch=5', ...base },
  ],
};
