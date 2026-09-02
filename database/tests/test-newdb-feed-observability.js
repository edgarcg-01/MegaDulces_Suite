/* eslint-disable no-console */
/**
 * OBS — CANDADOS de observabilidad de la ingesta (ADR-053).
 *
 * ── EL INCIDENTE QUE ESTE TEST EXISTE PARA QUE NO VUELVA ─────────────────────────────────
 * Del 2026-08-27 al 09-02 el carril de catálogos del ODS estuvo parado. Seis días. `kdii`, `kdik`,
 * `kdil` y `kdud` acumularon ~23,200 filas sin shipear — 10,248 de ellas de **costo** — y la
 * plataforma siguió publicando precio, costo, margen y reorden con total confianza. Lo encontró un
 * humano por casualidad: Edgar corrigió a mano el SKU 88222 ($54.00 → $165.28, 54% bajo costo) y el
 * cambio nunca apareció en la app.
 *
 * La detección existía y funcionó. Fallaron cuatro cosas distintas, y las cuatro tienen la misma
 * forma: **algo se cayó a "verde" porque nadie lo estaba mirando**.
 *
 * ── LO QUE SE CANDADEA ──────────────────────────────────────────────────────────────────
 *  1. Los carriles que alimentan prod tienen latido REGISTRADO. Un carril mudo es invisible: su
 *     única señal era el `mtime` de un `.log`.
 *  2. `analytics.v_feed_freshness` existe, une las dos primarias y **NO trae umbrales** (esos
 *     tienen dueño único en `CRON_JOBS`; una segunda copia se separa en silencio).
 *  3. `clase` es NULL para las tablas del ODS. Es el candado contra el falso positivo: con los tres
 *     carriles sanos, `k95doc` y las tablas de RH dan ~334 h de "edad" y están al día.
 *  4. La regla que atravesó toda la fase: **sin señal NO es "ok"**. El default permisivo es cómo un
 *     feed muerto se disfraza de sano.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-feed-observability.js
 */
const { Client } = require('pg');
const path = require('path');
const fs = require('fs');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';

let ok = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const RAIZ = path.join(__dirname, '..', '..');
const leer = (rel) => {
  try { return fs.readFileSync(path.join(RAIZ, rel), 'utf8'); } catch { return null; }
};

(async () => {
  const c = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await c.connect();
  console.log('\n=== OBS · la ingesta no se cae en silencio ===\n');

  // ── 1. La vista de frescura existe y une las DOS primarias ────────────────────────────────
  const v = (await c.query(`SELECT to_regclass('analytics.v_feed_freshness') IS NOT NULL AS ok`)).rows[0];
  check('analytics.v_feed_freshness existe', !!v?.ok);

  if (v?.ok) {
    const cols = (await c.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema='analytics' AND table_name='v_feed_freshness'`)).rows.map((r) => r.column_name);
    for (const col of ['origen', 'feed', 'label', 'status', 'dato_al', 'edad_seg', 'clase', 'nota']) {
      check(`la vista expone "${col}"`, cols.includes(col), `columnas: ${cols.join(', ')}`);
    }

    // El punto de la vista es que un consumidor NO tenga que saber en cuál de las dos tablas cae
    // su feed. Si un origen desaparece, la vista dejó de servir para eso.
    const orig = (await c.query(`SELECT origen, count(*)::int n FROM analytics.v_feed_freshness GROUP BY 1`)).rows;
    const porOrigen = Object.fromEntries(orig.map((r) => [r.origen, r.n]));
    check('la vista trae los carriles (origen=cron)', (porOrigen.cron || 0) > 0, JSON.stringify(porOrigen));
    check('la vista trae las tablas del ODS (origen=ods_table)', (porOrigen.ods_table || 0) > 0, JSON.stringify(porOrigen));

    // ⭐ El candado contra el falso positivo. `last_push_at` marca el último EMPUJE, no la última
    // revisión: una tabla vieja puede estar rezagada O simplemente no haber cambiado. Ponerle
    // clase a eso sería emitir un veredicto que no se puede sostener.
    const conClase = (await c.query(`
      SELECT count(*)::int n FROM analytics.v_feed_freshness WHERE origen='ods_table' AND clase IS NOT NULL`)).rows[0];
    check('clase es NULL para las tablas del ODS (no se inventa un ritmo que no se puede medir)',
      Number(conClase.n) === 0, `${conClase.n} fila(s) con clase — reintroduce el falso positivo de k95doc/RH`);

    const sinClase = (await c.query(`
      SELECT count(*)::int n FROM analytics.v_feed_freshness WHERE origen='cron' AND clase IS NULL`)).rows[0];
    check('todo carril tiene clase (su ritmo SÍ se conoce)', Number(sinClase.n) === 0, `${sinClase.n} sin clase`);

    const neg = (await c.query(`SELECT count(*)::int n FROM analytics.v_feed_freshness WHERE edad_seg < 0`)).rows[0];
    check('la edad nunca es negativa', Number(neg.n) === 0);

    // La vista da HECHOS. Si alguien le mete un umbral, se vuelve la segunda fuente de verdad que
    // ADR-053 §1 prohíbe y el tablero y la pantalla empiezan a contradecirse.
    const def = (await c.query(`SELECT pg_get_viewdef('analytics.v_feed_freshness'::regclass, true) AS d`)).rows[0].d;
    check('la vista no lleva umbrales (ni warn_h ni crit_h ni stale)',
      !/\b(warn_h|crit_h|stale)\b/i.test(def),
      'los umbrales viven SÓLO en CRON_JOBS/EXT_SOURCES de db-health.service.ts');
  }

  // ── 1b. La marca por sucursal: "se REVISÓ" ≠ "se le empujó algo" ─────────────────────────
  // `_sync_status` no servía para esto: sólo se escribe cuando llega un lote, y el carril hash no
  // empuja nada si no hay cambios. Esta tabla la escribe el shipper al cerrar la pasada de cada
  // rama, haya o no filas — por eso acá "viejo" tiene un solo significado: nadie miró esa rama.
  const t = (await c.query(`SELECT to_regclass('analytics.ods_branch_checks') IS NOT NULL AS ok`)).rows[0];
  check('analytics.ods_branch_checks existe', !!t?.ok);

  if (t?.ok) {
    // last_check_at DEBE admitir NULL: una rama que nunca se pudo revisar no tiene fecha que poner,
    // y rellenarla con now() sería registrar como hecho algo que falló.
    const nulable = (await c.query(`
      SELECT is_nullable FROM information_schema.columns
       WHERE table_schema='analytics' AND table_name='ods_branch_checks' AND column_name='last_check_at'`)).rows[0];
    check('last_check_at admite NULL (= nunca se pudo revisar)', nulable?.is_nullable === 'YES');

    // ⭐ El candado de fondo, ejercitado contra la DB real con un carril sintético.
    const TEN = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
    const LANE = '__test_obs32';
    const upsert = `
      INSERT INTO analytics.ods_branch_checks
             (tenant_id, lane, sucursal, last_check_at, tables_checked, rows_shipped, last_error)
      VALUES ($1,$2,$3, CASE WHEN $7::text IS NULL THEN now() ELSE NULL END, $4, $5, $6)
      ON CONFLICT (tenant_id, lane, sucursal) DO UPDATE SET
        last_check_at  = CASE WHEN $7::text IS NULL THEN now()
                              ELSE analytics.ods_branch_checks.last_check_at END,
        tables_checked = EXCLUDED.tables_checked,
        rows_shipped   = EXCLUDED.rows_shipped,
        last_error     = EXCLUDED.last_error`;
    try {
      await c.query(`DELETE FROM analytics.ods_branch_checks WHERE lane=$1`, [LANE]);

      // (a) Primera vez CON error → la rama nunca se revisó: sin fecha.
      await c.query(upsert, [TEN, LANE, '99', 0, 0, 'no conecta', 'no conecta']);
      const a = (await c.query(`SELECT last_check_at FROM analytics.ods_branch_checks WHERE lane=$1 AND sucursal='99'`, [LANE])).rows[0];
      check('rama que falla desde el arranque queda SIN fecha (no se inventa una revisión)', a?.last_check_at === null);

      // (b) Pasada limpia → la marca avanza.
      await c.query(upsert, [TEN, LANE, '99', 19, 5, null, null]);
      const b = (await c.query(`SELECT last_check_at, tables_checked FROM analytics.ods_branch_checks WHERE lane=$1 AND sucursal='99'`, [LANE])).rows[0];
      check('una pasada limpia SÍ mueve la marca', !!b?.last_check_at);
      check('tables_checked queda registrado (caza la config recortada)', Number(b?.tables_checked) === 19);

      // (c) ⭐ Después falla → la marca NO avanza. Si avanzara, una rama caída se vería revisada
      //     para siempre y el sensor jamás la alcanzaría: el verde falso de nuevo.
      const antes = b.last_check_at;
      await new Promise((r) => setTimeout(r, 60));
      await c.query(upsert, [TEN, LANE, '99', 0, 0, 'se cayó', 'se cayó']);
      const d = (await c.query(`SELECT last_check_at, last_error FROM analytics.ods_branch_checks WHERE lane=$1 AND sucursal='99'`, [LANE])).rows[0];
      check('una pasada CON ERROR no mueve la marca (la rama no se revisó)',
        new Date(d.last_check_at).getTime() === new Date(antes).getTime(),
        `antes=${antes} después=${d.last_check_at}`);
      check('pero sí deja el error registrado', /se cayó/.test(d?.last_error || ''));
    } finally {
      await c.query(`DELETE FROM analytics.ods_branch_checks WHERE lane=$1`, [LANE]).catch(() => {});
    }
  }

  // ── 2. Los carriles que alimentan prod están REGISTRADOS con umbral ──────────────────────
  // El bug de fondo del incidente: `checkCronRuns` clasifica con `cfg ? classify(...) : 'ok'`, así
  // que un job SIN entrada en CRON_JOBS sale VERDE INCONDICIONAL por más viejo que esté. Cinco
  // carriles ya latían y caían justo en ese default.
  const svc = leer('apps/api/src/modules/db-health/db-health.service.ts');
  check('db-health.service.ts se puede leer', !!svc);
  if (svc) {
    for (const job of ['ods_live_hot', 'ods_live_mirror', 'cdc_reconcile',
      'wincaja_replica_inc', 'wincaja_replica_hash', 'contpaqi_add_cfdis', 'analytics_refresh_wincaja']) {
      check(`CRON_JOBS registra "${job}" (si no, sale verde incondicional)`, svc.includes(`'${job}'`));
    }
  }

  // ── 3. El carril late a PROD, por un canal que NO es el que vigila ───────────────────────
  // `reconcile-ods-window.js:154-166`: `ods-cdc-wal` latía por el sink que monitorea, así que el
  // 2026-08-26 una rotación de key dio 401 en los 7 consumidores SIN alarma. Var propia, a propósito.
  const ship = leer('database/importers/kepler/replicate-ods-live.js');
  check('replicate-ods-live.js se puede leer', !!ship);
  if (ship) {
    check('el shipper late (tiene función de latido)', /function\s+latir|latir\s*\(/.test(ship));
    check('el latido usa su propia var de destino (ODS_HB_URL), no la del sink',
      ship.includes('ODS_HB_URL'),
      'con DATABASE_URL_NEW el latido caería en la FUENTE :5433 — GOTCHAS §17');
    check('preflight fail-fast: en watch sin destino de latido ABORTA',
      /late\s*&&\s*!HB_URL/.test(ship) && /if\s*\(WATCH_SEC\)\s*\{[\s\S]{0,220}?process\.exit\(1\)/.test(ship),
      'un carril que no puede latir es un carril invisible');
    // GOTCHAS §18 — el latido no puede viajar por el canal que vigila. El 2026-08-26 una rotación
    // de key dio 401 en los 7 consumidores CDC sin una sola alarma, porque latían por el sink.
    check('preflight: aborta si el latido apunta a la FUENTE en vez de prod',
      /HB_URL[\s\S]{0,120}SUB_BASE[\s\S]{0,300}?process\.exit\(1\)/.test(ship),
      'con el latido en la fuente, un carril muerto es indistinguible de uno sano');
    check('las fallas por rama se AGREGAN al latido (no `continue` mudo)',
      /fallas/.test(ship),
      'antes una pasada podía shipear cero e imprimir "APPLY hecho."');
    // [OBS.3.2] El shipper deja la marca por rama. Sin esto el latido agregado seguiría verde con
    // "1/1 ramas" si alguien deja el contenedor corriendo con --branch=03.
    check('el shipper marca cada sucursal como revisada', /marcarRamas/.test(ship));
    check('la marca NO avanza cuando la rama falló',
      ship.includes('ELSE analytics.ods_branch_checks.last_check_at END'),
      'bumpearla con error dejaría a una rama caída viéndose revisada para siempre');
  }

  // ── 4. El healthcheck mide ENTREGA, no que el PID exista ─────────────────────────────────
  // `pm2 ls` decía **online** para dos carriles cuyo batch nunca se ejecutó. Un chequeo de proceso
  // no puede ver eso.
  const hc = leer('ops/ingest/health.js');
  check('ops/ingest/health.js existe', !!hc);
  if (hc) {
    check('el healthcheck lee el latido en PROD (analytics.cron_runs), no ods.ctl del replica',
      hc.includes('analytics.cron_runs'),
      'ods.ctl prueba la pasada local, no que el dato llegó al otro lado');
    check('sale ≠ 0 cuando el latido está viejo', /process\.exit\(1\)/.test(hc));
    // ⭐ La regla 2 de shared/freshness, acá abajo: si no se puede LEER el latido, no se puede
    // afirmar que esté sano. Un healthcheck que cae a "sano" ante un error es el falso verde otra vez.
    const catchBlock = hc.slice(hc.indexOf('} catch'));
    check('si no puede verificar reporta ENFERMO (no se cae a sano)',
      /process\.exit\(1\)/.test(catchBlock),
      'el catch debe salir 1');
  }

  // ── 5. La auto-curación DECLARA el hueco ─────────────────────────────────────────────────
  // Recrear un slot invalidado no repone el WAL perdido. Si el consumidor volviera a decir `ok`
  // sólo porque el stream fluye, estaría tapando una pérdida de datos con un semáforo verde.
  const wal = leer('database/importers/kepler/ods-cdc-wal.js');
  check('ods-cdc-wal.js se puede leer', !!wal);
  if (wal) {
    check('ensurePubSlot valida wal_status (no sólo que el slot exista)', wal.includes('wal_status'));
    check('un slot lost/unreserved se recrea', /lost['"\s,]*[\s\S]{0,40}unreserved|unreserved[\s\S]{0,40}lost/.test(wal));
    check('el hueco se DECLARA en el latido (recrear no repone el WAL)',
      /huecoDeclarado/.test(wal),
      'sin esto el carril diría ok mientras faltan filas para siempre');
    check('backoff anti-bucle antes de salir', /ODS_CDC_EXIT_DELAY_MS/.test(wal),
      'salir inmediato dio 4,591–5,564 reinicios por rama');
  }

  // ── 6. El dato declara su rezago, y "sin señal" NO es ok ─────────────────────────────────
  const fr = leer('libs/commercial/src/lib/shared/freshness.ts');
  check('libs/commercial/.../shared/freshness.ts existe', !!fr);
  if (fr) {
    // Las dos reglas de la fase, verificadas en el código y no sólo en el comentario.
    check('evalInput trata la ausencia de señal como rezago',
      /ms\s*===\s*null\s*\?\s*true/.test(fr),
      'sin señal es la falla MÁS grave: la fuente ni siquiera reporta');
    check('composeFreshness toma el eslabón más VIEJO (Math.min), no el mejor',
      /Math\.min/.test(fr),
      'una cadena es tan fresca como su peor tramo');
    check('FRESHNESS_UNKNOWN no afirma frescura', /FRESHNESS_UNKNOWN[\s\S]{0,200}data_as_of:\s*null/.test(fr));
    check('laneAt tolera que la vista no esté aplicada (to_regclass)', fr.includes('to_regclass'),
      'el consumidor no puede romperse entre el deploy y la migración');
  }

  const lab = leer('libs/commercial/src/lib/commercial-labels/commercial-labels.service.ts');
  check('la etiquetera declara frescura', !!lab && /freshness/.test(lab));
  if (lab) {
    // Los DOS eslabones. Vigilar uno deja el otro ciego: si el carril shipea pero el recálculo
    // murió, el ODS está fresco y la etiqueta igual sale vieja.
    check('la etiquetera vigila el carril del ODS', lab.includes('ods_live_hot'));
    check('la etiquetera vigila el recálculo (max(computed_at), NO el de la fila)',
      /computed_at/.test(lab) && /max\(/i.test(lab),
      'el computed_at de la FILA se mueve sólo si ESE producto cambió → semanas de falsa edad');
  }

  await c.end();
  console.log(`\n  ${ok} OK · ${fail} falla(s)\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
