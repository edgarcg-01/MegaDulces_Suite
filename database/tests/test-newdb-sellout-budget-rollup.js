/**
 * [PU.V1] Candado de `analytics.mv_sellout_budget_rollup` — el real del sell-out que publica toda
 * la pestaña de Ventas de Presupuestos.
 *
 * ── Qué vigila, y por qué estas pruebas y no otras ─────────────────────────────────────────
 *
 * El defecto que esta MV arregla era invisible por construcción: `v_sales_entity` publica el canal
 * CANÓNICO y `v_sellout_daily` emite el CRUDO, y los consumidores los unían directo. El join no
 * fallaba — simplemente no encontraba fila, y una fila que no aparece no deja error. Resultado
 * medido contra prod el 2026-10-07: **$314,428,861 (28.70 %) fuera**, con `mayoreo:01`, `:06` y
 * `:08` publicando **$0 sobre $208 millones** en FY2025.
 *
 * Por eso el candado NO se conforma con «la MV tiene filas»:
 *
 *  1. **Cruza DOS derivaciones independientes.** La MV sale de `v_sellout_daily × v_retail_calendar
 *     × v_sales_entity`; el testigo sale de `mv_sellout_monthly` (otro objeto, otro grano) por el
 *     mismo mapa de canal. Verificar una vista contra sí misma pasa bugs en verde — la lección de
 *     IC.0, que pasó dos bugs comprobándose contra el ODS con su propia lógica.
 *
 *  2. **PRUEBA NEGATIVA (ADR-056): el join viejo tiene que dar ESTRICTAMENTE MENOS.** Si diera
 *     igual, la MV no estaría arreglando nada y este archivo se pondría verde de todos modos.
 *
 *  3. **CONTROL DE PLACEBO.** El arreglo sólo puede mover los canales que el mapa TRADUCE
 *     (`credito`→`mayoreo`, `contado_nf`→`mostrador`). Los que ya coincidían —`mostrador` de
 *     Kepler, `ruta`, `preventa`— tienen que quedar IDÉNTICOS. Un arreglo que mueve todo no es un
 *     arreglo: es otra consulta.
 *
 *  4. **Las tres celdas con nombre.** `mayoreo:01/06/08` en FY2025 valían $0 y valen $67.7M,
 *     $67.1M y $73.5M. Se exigen por nombre, no por agregado: un total correcto puede esconder
 *     una celda en cero.
 *
 *  5. **El tiempo**, que es lo que disparó todo esto: 56,397 ms y 61,182 ms medidos contra un gate
 *     de 500 ms, y `/sales-reconciliation` que directamente moría en el `statement_timeout`.
 *
 * ── Cómo correrlo ──────────────────────────────────────────────────────────────────────────
 *
 *     DATABASE_URL_NEW=<prod> node database/tests/test-newdb-sellout-budget-rollup.js
 *
 * Es de SÓLO LECTURA: no escribe, no muta, no refresca. Lo que no se puede medir se reporta
 * `NO MEDIDO`, nunca ✔ (ADR-056).
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

const MV = 'analytics.mv_sellout_budget_rollup';
const GATE_MS = 500;            // el gate del proyecto para una consulta de pantalla
const TENANT_FALSO = '00000000-0000-0000-0000-0000000f0f0f';

let ok = 0, bad = 0, nm = 0;
const t = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { bad++; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
};
const noMedido = (name, motivo) => { nm++; console.log(`  ◻ NO MEDIDO: ${name} — ${motivo}`); };
const mx = (x) => Number(x || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({ client: 'pg', connection: url, pool: { min: 0, max: 2 } });

  try {
    await db.raw(`SET statement_timeout = '180s'`);

    // ── [1] El objeto existe y es lo que dice ser ─────────────────────────────────────────
    console.log('\n[1] El objeto');
    const existe = (await db.raw(`SELECT to_regclass(?) AS t`, [MV])).rows[0].t;
    if (!existe) {
      noMedido('toda la suite', `${MV} no existe: falta aplicar la migración 20261007202137`);
      console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
      await db.destroy();
      process.exit(0);
    }
    t(`${MV} existe`, true);

    const llave = (await db.raw(`
      SELECT count(*) AS filas,
             count(DISTINCT (tenant_id::text || '|' || entity_key || '|' || fiscal_year || '|' || period_no)) AS llaves,
             count(*) FILTER (WHERE tenant_id IS NULL OR entity_key IS NULL
                                OR fiscal_year IS NULL OR period_no IS NULL) AS nulos,
             count(*) FILTER (WHERE max_business_date IS NULL) AS sin_fecha
        FROM ${MV}`)).rows[0];
    t('la llave es única (requisito de REFRESH CONCURRENTLY)',
      Number(llave.filas) === Number(llave.llaves), `${llave.filas} filas / ${llave.llaves} llaves`);
    t('ninguna columna de la llave viene NULL (UNIQUE los trata como distintos)',
      Number(llave.nulos) === 0, `${llave.nulos} filas`);
    t('toda fila declara su `max_business_date` (frescura, no se dibuja)',
      Number(llave.sin_fecha) === 0, `${llave.sin_fecha} filas sin fecha`);

    const idx = (await db.raw(`
      SELECT count(*) AS n FROM pg_index i
       WHERE i.indrelid = ?::regclass AND i.indisunique`, [MV])).rows[0];
    t('tiene índice UNIQUE', Number(idx.n) >= 1, `${idx.n} índices unique`);

    // ⛔ NO se pregunta por `information_schema.role_table_grants`: **no lista matvistas**. Son
    //    `relkind='m'`, que queda fuera del estándar SQL, así que esa vista devuelve CERO filas
    //    para una MV con el GRANT perfectamente puesto. Escrito así primero, y contra prod dio
    //    ✘ con `app_runtime=r/postgres` en el `relacl` — un gate que le pregunta al catálogo
    //    equivocado inventa un problema, que es el reflejo exacto de uno que inventa un verde.
    //    Se usa `has_table_privilege`, que contesta por el privilegio EFECTIVO (incluye lo
    //    heredado por pertenencia a rol, que un recuento de filas tampoco vería).
    const grant = (await db.raw(`
      SELECT has_table_privilege('app_runtime', ?::regclass, 'SELECT') AS puede`, [MV])).rows[0];
    t('`app_runtime` puede leerla (el API corre con ese rol)', grant.puede === true);

    // [PU.V3] El rollup de canal × mes que sirve la Conciliación. Es OTRA pregunta, no otra copia:
    // el mes calendario NO es el periodo fiscal 13×4, así que ninguna de las dos MV deriva de la otra.
    const ch = (await db.raw(`SELECT to_regclass('analytics.mv_sellout_channel_monthly') AS t`)).rows[0].t;
    if (!ch) {
      noMedido('mv_sellout_channel_monthly', 'falta aplicar la migración 20261008082018');
    } else {
      const chk = (await db.raw(`
        SELECT count(*) AS filas,
               count(DISTINCT (tenant_id::text || '|' || channel || '|' || year_month)) AS llaves,
               count(*) FILTER (WHERE tenant_id IS NULL OR channel IS NULL OR year_month IS NULL) AS nulos
          FROM analytics.mv_sellout_channel_monthly`)).rows[0];
      t('mv_sellout_channel_monthly: la llave es única y sin NULL',
        Number(chk.filas) === Number(chk.llaves) && Number(chk.nulos) === 0,
        `${chk.filas} filas / ${chk.llaves} llaves / ${chk.nulos} nulos`);
      t('`app_runtime` puede leer el rollup de canal',
        (await db.raw(`SELECT has_table_privilege('app_runtime','analytics.mv_sellout_channel_monthly','SELECT') AS p`)).rows[0].p === true);
      // ⭐ Y que siga siendo el MISMO universo que su fuente: un rollup que se desincroniza del
      //    espejo mensual publicaría una conciliación contra un sell-out que ya no existe.
      const par = (await db.raw(`
        SELECT round(abs((SELECT sum(sell_out) FROM analytics.mv_sellout_channel_monthly)
                       - (SELECT sum(monto)    FROM analytics.mv_sellout_monthly)), 2) AS d`)).rows[0];
      t('el rollup de canal cuadra al peso con el espejo mensual', Number(par.d) < 1, `Δ ${mx(par.d)}`);
    }

    // ── [2] El NÚMERO: prueba negativa + control de placebo ───────────────────────────────
    console.log('\n[2] El número — el join por el mapa de canal');
    const cmp = (await db.raw(`
      WITH base AS (SELECT tenant_id, source, channel, warehouse_code, monto FROM analytics.mv_sellout_monthly),
      viejo AS (
        SELECT sum(b.monto) AS v FROM base b
          JOIN analytics.v_sales_entity se
            ON se.tenant_id=b.tenant_id AND se.channel=b.channel AND se.warehouse_code=b.warehouse_code
      ), conmapa AS (
        SELECT sum(b.monto) AS v FROM base b
          LEFT JOIN analytics.sellout_channel_map cm
            ON cm.tenant_id=b.tenant_id AND cm.source=b.source AND cm.raw_channel=b.channel
          JOIN analytics.v_sales_entity se
            ON se.tenant_id=b.tenant_id AND se.channel=COALESCE(cm.canonical_channel,b.channel)
           AND se.warehouse_code=b.warehouse_code
      ), crudo AS (SELECT sum(monto) AS v FROM base)
      SELECT (SELECT v FROM viejo) viejo, (SELECT v FROM conmapa) conmapa, (SELECT v FROM crudo) crudo`)).rows[0];
    const viejo = Number(cmp.viejo), conMapa = Number(cmp.conmapa), crudo = Number(cmp.crudo);

    // ⭐ PRUEBA NEGATIVA: sin esto el candado se pondría verde con el arreglo deshecho.
    t(`PRUEBA NEGATIVA: el join viejo da MENOS (${mx(viejo)} < ${mx(conMapa)})`,
      conMapa > viejo, `diferencia ${mx(conMapa - viejo)}`);
    t('el join por entidad no pierde venta (ADR-056: nada se cae en silencio)',
      crudo > 0 && (crudo - conMapa) / crudo < 0.001, `fuera ${mx(crudo - conMapa)} de ${mx(crudo)}`);

    // ⭐ CONTROL DE PLACEBO: lo que el mapa NO traduce no se puede mover.
    const placebo = (await db.raw(`
      WITH base AS (SELECT tenant_id, source, channel, warehouse_code, monto FROM analytics.mv_sellout_monthly
                     WHERE channel NOT IN ('credito','contado_nf')),
      viejo AS (
        SELECT sum(b.monto) AS v FROM base b
          JOIN analytics.v_sales_entity se
            ON se.tenant_id=b.tenant_id AND se.channel=b.channel AND se.warehouse_code=b.warehouse_code
      ), conmapa AS (
        SELECT sum(b.monto) AS v FROM base b
          LEFT JOIN analytics.sellout_channel_map cm
            ON cm.tenant_id=b.tenant_id AND cm.source=b.source AND cm.raw_channel=b.channel
          JOIN analytics.v_sales_entity se
            ON se.tenant_id=b.tenant_id AND se.channel=COALESCE(cm.canonical_channel,b.channel)
           AND se.warehouse_code=b.warehouse_code
      ) SELECT (SELECT v FROM viejo) viejo, (SELECT v FROM conmapa) conmapa`)).rows[0];
    t('PLACEBO: los canales que el mapa no traduce quedan IDÉNTICOS',
      Math.abs(Number(placebo.viejo) - Number(placebo.conmapa)) < 1,
      `${mx(placebo.viejo)} vs ${mx(placebo.conmapa)} — si esto se mueve, el arreglo cambió otra cosa`);

    // ── [3] Cruce con una SEGUNDA derivación (no consigo misma) ───────────────────────────
    console.log('\n[3] Cruce contra una derivación independiente');
    const cruce = (await db.raw(`
      WITH testigo AS (
        SELECT se.entity_key, sum(b.monto) AS v
          FROM analytics.mv_sellout_monthly b
          LEFT JOIN analytics.sellout_channel_map cm
            ON cm.tenant_id=b.tenant_id AND cm.source=b.source AND cm.raw_channel=b.channel
          JOIN analytics.v_sales_entity se
            ON se.tenant_id=b.tenant_id AND se.channel=COALESCE(cm.canonical_channel,b.channel)
           AND se.warehouse_code=b.warehouse_code
         GROUP BY 1
      ), mv AS (SELECT entity_key, sum(monto) AS v FROM ${MV} GROUP BY 1)
      SELECT count(*) FILTER (WHERE abs(COALESCE(mv.v,0) - COALESCE(testigo.v,0))
                                    > greatest(1, 0.02 * COALESCE(testigo.v,0))) AS difieren,
             count(*) AS pares
        FROM testigo FULL JOIN mv USING (entity_key)`)).rows[0];
    t('cada entidad cuadra contra el testigo mensual (tolerancia 2 % = rezago de un día)',
      Number(cruce.difieren) === 0, `${cruce.difieren} de ${cruce.pares} entidades difieren`);

    // ── [4] Las tres celdas que valían $0 ─────────────────────────────────────────────────
    console.log('\n[4] Las celdas con nombre — un total correcto puede esconder un cero');
    const celdas = (await db.raw(`
      SELECT entity_key, sum(monto) AS v FROM ${MV}
       WHERE fiscal_year = 2025 AND entity_key IN ('mayoreo:01','mayoreo:06','mayoreo:08')
       GROUP BY 1 ORDER BY 1`)).rows;
    for (const ek of ['mayoreo:01', 'mayoreo:06', 'mayoreo:08']) {
      const f = celdas.find((r) => r.entity_key === ek);
      const v = Number(f?.v || 0);
      t(`${ek} FY2025 publica dinero, no $0 (valía $0, mide ~$67–73M)`,
        v > 10000000, `mide ${mx(v)}`);
    }

    // ── [5] El TIEMPO, que es lo que disparó la fase ──────────────────────────────────────
    console.log('\n[5] El tiempo');
    const tenant = (await db.raw(`SELECT tenant_id FROM ${MV} GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`)).rows[0];
    if (!tenant) {
      noMedido('los gates de tiempo', 'la MV está vacía');
    } else {
      const medir = async (sql, binds) => {
        const t0 = Date.now(); await db.raw(sql, binds); return Date.now() - t0;
      };
      const msComp = await medir(
        `SELECT entity_key, fiscal_year, period_no, sum(monto) FROM ${MV}
          WHERE tenant_id = ? AND fiscal_year IN (2025, 2026)
          GROUP BY 1,2,3`, [tenant.tenant_id]);
      t(`la consulta de /sales-comparison baja de 56,397 ms al gate de ${GATE_MS} ms`,
        msComp < GATE_MS, `${msComp} ms`);

      const msInd = await medir(
        `SELECT entity_key, channel, branch_name, fiscal_year, sum(monto) FROM ${MV}
          WHERE tenant_id = ? AND fiscal_year <= 2026
          GROUP BY 1,2,3,4`, [tenant.tenant_id]);
      t(`la consulta de /sales-indicators baja de 61,182 ms al gate de ${GATE_MS} ms`,
        msInd < GATE_MS, `${msInd} ms`);

      const msFresh = await medir(
        `SELECT max(max_business_date) FROM ${MV} WHERE tenant_id = ?`, [tenant.tenant_id]);
      t(`el sondeo de frescura baja de 14,587 ms al gate de ${GATE_MS} ms`,
        msFresh < GATE_MS, `${msFresh} ms`);

      // La conciliación es OTRO objeto y otro grano (canal × mes calendario, no periodo fiscal),
      // pero el gate es el MISMO. [PU.V2] la dejó en 592 ms y eso seguía siendo «más de medio
      // segundo», que es la queja que abrió la fase; [PU.V3] le dio su propio rollup de ~97 filas.
      const msRec = await medir(`SELECT count(*), sum(sell_out) FROM analytics.v_sellout_vs_facturacion`);
      t(`/sales-reconciliation baja al gate de ${GATE_MS} ms (medía >300,000 ms: moría en el timeout)`,
        msRec < GATE_MS, `${msRec} ms`);

      // Control negativo de tenant: la MV no tiene RLS, el filtro lo pone el service.
      const falso = (await db.raw(`SELECT count(*) n FROM ${MV} WHERE tenant_id = ?`, [TENANT_FALSO])).rows[0];
      t('CONTROL NEGATIVO: un tenant inexistente devuelve cero filas', Number(falso.n) === 0);
    }

    // ── [6] El latido, con su umbral ──────────────────────────────────────────────────────
    console.log('\n[6] El latido');
    const hb = (await db.raw(`
      SELECT status, last_finish, extract(epoch FROM (now() - last_finish))/3600 AS horas
        FROM analytics.cron_runs WHERE job_key = 'analytics_refresh_sellout_budget'`)).rows;
    if (!hb.length) {
      noMedido('el latido del refresco', 'aún no corrió el nocturno (job analytics_refresh_sellout_budget)');
    } else {
      t('el refresco reportó `ok` en su última corrida', hb[0].status === 'ok',
        `status=${hb[0].status} last_finish=${hb[0].last_finish}`);
      t('el refresco cerró dentro de su umbral de 26 h',
        Number(hb[0].horas) < 26, `${Number(hb[0].horas).toFixed(1)} h`);
    }

    console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
  } catch (e) {
    console.error('ERROR:', e.message);
    bad++;
  } finally {
    await db.destroy();
  }
  process.exit(bad > 0 ? 1 : 0);
})();
