/* eslint-disable no-console */
/**
 * SM.20 — El corte de Kepler llega solo.
 *
 * Este smoke existe por un hueco real: el 2026-09-02 había 20 cortes cerrados en
 * `kepler_ods.kdpv_folio_caja` —sucursal 02, $300k+ de efectivo declarado— que
 * nunca habían entrado a `analytics.cash_cuts`, porque el único camino era correr
 * un CLI a mano. En la pantalla esos turnos no se veían "pendientes": no se veían.
 *
 * Lo que se afirma acá es una sola cosa, y es la que importa: **cero cortes de
 * Kepler sin espejo nuestro**. Si alguien toca el UPSERT del servicio o el del
 * CLI y se desincronizan, o si el cron deja de correr, este número deja de ser 0.
 *
 * Corre contra la MISMA base que la app (el ODS y el destino conviven ahí).
 *   node database/tests/test-newdb-cash-cuts-sync.js
 */

const { Client } = require('pg');

const TENANT = process.env.MAAT_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@127.0.0.1:5432/postgres_platform';
const DIAS = 3;   // la misma ventana que CashCutsSyncService.DIAS

let ok = 0, fail = 0;
const t = (nombre, cond, extra = '') => {
  if (cond) { ok++; console.log(`  ✅ ${nombre}`); }
  else { fail++; console.log(`  ❌ ${nombre}${extra ? ' — ' + extra : ''}`); }
};

/**
 * Espejo exacto del filtro del servicio. Si esto y el servicio dejan de coincidir,
 * el smoke pasa a medir otra cosa — por eso va comentado en ambos lados.
 */
const SRC = `
  SELECT DISTINCT ON (k.sucursal, k.c2, k.c5::date, k.c3)
         k.sucursal, k.c2 AS caja, k.c3::bigint::text AS folio, k.c5::date AS business_date,
         round(COALESCE(k.c25, 0), 2) AS contado
    FROM kepler_ods.kdpv_folio_caja k
   WHERE (COALESCE(k.c25, 0) <> 0 OR COALESCE(k.c35, 0) <> 0)
     AND k.c5::date >= current_date - ${DIAS}
   ORDER BY k.sucursal, k.c2, k.c5::date, k.c3, k.c10 DESC NULLS LAST
`;

(async () => {
  const ssl = /rlwy|proxy|railway/.test(DST) ? { rejectUnauthorized: false } : false;
  const pg = new Client({ connectionString: DST, ssl, statement_timeout: 120000 });
  await pg.connect();
  console.log('\n== SM.20 · el corte de Kepler llega solo ==\n');

  try {
    const { rows: [g] } = await pg.query(`
      WITH src AS (${SRC}),
      mios AS (
        SELECT s.*, c.id
          FROM src s
          JOIN commercial.warehouses w
            ON w.tenant_id = $1::uuid AND w.code = s.sucursal AND w.deleted_at IS NULL
          LEFT JOIN analytics.cash_cuts c
            ON c.tenant_id = $1::uuid AND c.warehouse_code = s.sucursal
           AND c.caja = s.caja AND c.business_date = s.business_date AND c.folio = s.folio
      )
      SELECT count(*)::int                                             kepler,
             count(*) FILTER (WHERE id IS NULL)::int                   faltan,
             COALESCE(round(sum(contado) FILTER (WHERE id IS NULL), 2), 0) plata_invisible
        FROM mios`, [TENANT]);

    console.log(`  Kepler cerró ${g.kepler} cortes en los últimos ${DIAS} días.`);
    t('ningún corte de Kepler quedó sin jalar',
      g.faltan === 0,
      `faltan ${g.faltan} · $${Number(g.plata_invisible).toLocaleString('es-MX')} que la pantalla no muestra`);

    // El desglose (c43/c44) es lo que hace comparable el corte contra nuestro conteo.
    // No está en el 100% de las sucursales, pero si cae a cero es que el decode se rompió.
    const { rows: [d] } = await pg.query(`
      SELECT count(*)::int total,
             count(*) FILTER (WHERE COALESCE(arqueo_billetes,0) + COALESCE(arqueo_monedas,0) > 0)::int con_desglose
        FROM analytics.cash_cuts
       WHERE tenant_id = $1::uuid AND business_date >= current_date - 30`, [TENANT]);
    const pct = d.total ? (d.con_desglose / d.total) * 100 : 0;
    t('el desglose billetes/monedas viene poblado (>60% de los cortes)',
      pct > 60, `${d.con_desglose}/${d.total} = ${pct.toFixed(1)}%`);

    // El corte de Kepler NO es un conteo verificado: si algún día dejara de cerrar
    // exacto masivamente, cambió el proceso en tienda y hay que revisar SM.7.
    const { rows: [e] } = await pg.query(`
      SELECT count(*)::int total,
             count(*) FILTER (WHERE abs(COALESCE(efectivo_diff,0)) < 0.005)::int exactos
        FROM analytics.cash_cuts
       WHERE tenant_id = $1::uuid AND business_date >= current_date - 30`, [TENANT]);
    const pe = e.total ? (e.exactos / e.total) * 100 : 0;
    console.log(`  ℹ️  ${pe.toFixed(1)}% de los cortes cierra exacto al centavo (arqueo no ciego, SM.7).`);
    t('el corte de Kepler sigue siendo declarado, no contado', pe > 50, `${pe.toFixed(1)}% exactos`);
  } finally {
    await pg.end();
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok}/${ok + fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
