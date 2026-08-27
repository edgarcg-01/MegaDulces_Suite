/* eslint-disable no-console */
/**
 * SM.11 — Carga el **arqueo que genera Kepler** a `analytics.cash_cuts` desde el ODS.
 *
 * Hermano de `import-cash-cuts.js`, misma tabla destino y misma llave de conflicto,
 * pero **otra fuente**: en vez de abrir las 6 DBs Kepler de la LAN, lee
 * `kepler_ods.kdpv_folio_caja`, que el CDC ya replica y vive en la MISMA base que
 * el destino. Consecuencias prácticas:
 *   - corre desde cualquier lado (Railway incluido), no solo desde la máquina de feeds;
 *   - es un UPSERT en una sola sentencia SQL: no viajan filas por la red;
 *   - la frescura es la del CDC (minutos), no la de la última corrida del nightly.
 * El importer de LAN se queda como respaldo para cuando el ODS no tenga la sucursal.
 *
 * ── Qué es el arqueo de Kepler (verificado en vivo 2026-08-27, 3,048 cortes cerrados)
 *
 *   `c15` = efectivo ESPERADO (lo que el sistema dice que debe haber)
 *   `c25` = efectivo CONTADO  (el arqueo: lo que el cajero DECLARA que hay)
 *   `c35` = DIFERENCIA        (= c15 − c25; faltante +, sobrante −)
 *
 * Los tres cuadran entre sí en **3048/3048** cortes. Es la base de comparación
 * contra nuestro arqueo ciego (`reconciliation.blind_counts`), con una advertencia
 * que no hay que perder de vista: **`c25` no es un conteo físico verificado**, es un
 * número declarado — el **74.6%** de los cortes cierra con `c25` idéntico a `c15`
 * al centavo, que es el patrón de "arqueo no ciego" que documenta SM.7.
 *
 * **Kepler NO guarda el arqueo por denominación** — solo el total. El detalle pieza
 * por pieza existe únicamente en Wincaja (`wincaja.arqueos`, 3 sucursales) y en el
 * nuestro. Por eso la comparación es total contra total.
 *
 * ⚠️ `c43/c44/c45` se traen tal cual por compatibilidad con el importer viejo, que los
 * mapeó como billetes/monedas/otros en SM.7. **Ese mapeo NO se sostiene con los datos
 * de hoy**: `c43+c44+c45` reproduce `c25` en apenas 428/3048 cortes, y `c46`/`c47`
 * tienen 42 y 44 valores distintos en 3,048 filas (o sea, son parámetros/límites, no
 * montos). No usar esas 3 columnas como desglose del efectivo contado hasta re-decodificarlas.
 *
 * Uso (desde la raíz del repo):
 *   node database/importers/kepler/load-cash-cuts-from-ods.js                 # dry-run
 *   node database/importers/kepler/load-cash-cuts-from-ods.js --apply
 *   node database/importers/kepler/load-cash-cuts-from-ods.js --apply --from 2026-01-01
 *   DATABASE_URL_NEW='postgres://…' node … --apply --sucursal 01
 */

const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');
const TENANT = process.env.MAAT_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const FROM = arg('--from', null);          // 'YYYY-MM-DD' — acota por business_date
const SUC = arg('--sucursal', null);       // '01' — acota a una sucursal
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@127.0.0.1:5432/postgres_platform';

/**
 * Origen normalizado. `DISTINCT ON` porque el ODS puede traer la misma fila dos veces
 * (re-emisión del CDC): sin esto el `ON CONFLICT` revienta con "cannot affect row a
 * second time". Gana el cierre más reciente.
 *
 * Filtro: solo cortes con actividad. Un corte ABIERTO viene con `c10='1800-01-01'` y
 * los montos en cero — no es un arqueo, es una caja en operación.
 */
const SRC = `
  SELECT DISTINCT ON (k.sucursal, k.c2, k.c5::date, k.c3)
         k.sucursal, k.c2 AS caja, k.c3::bigint::text AS folio, k.c5::date AS business_date,
         k.c5 AS opened_at,
         CASE WHEN k.c10::date = DATE '1800-01-01' THEN NULL ELSE k.c10 END AS closed_at,
         NULLIF(btrim(k.c7), '')  AS cajero_apertura,
         NULLIF(btrim(k.c8), '')  AS cajero_cierre,
         NULLIF(btrim(k.c13), '') AS turno,
         NULLIF(btrim(k.c6), '')  AS hora_apertura,
         NULLIF(btrim(k.c11), '') AS hora_cierre,
         round(COALESCE(k.c15, 0), 2) AS ef_esp,
         round(COALESCE(k.c25, 0), 2) AS ef_cont,
         round(COALESCE(k.c35, 0), 2) AS ef_diff,
         round(COALESCE(k.c16, 0), 2) AS tj_esp,
         round(COALESCE(k.c26, 0), 2) AS tj_cont,
         round(COALESCE(k.c36, 0), 2) AS tj_diff,
         round(COALESCE(k.c17, 0), 2) AS tr_esp,
         round(COALESCE(k.c27, 0), 2) AS tr_cont,
         round(COALESCE(k.c37, 0), 2) AS tr_diff,
         round(COALESCE(k.c43, 0), 2) AS arq_bil,
         round(COALESCE(k.c44, 0), 2) AS arq_mon,
         round(COALESCE(k.c45, 0), 2) AS arq_otros,
         round(COALESCE(k.c48, 0), 2) AS retirado,
         round(COALESCE(k.c49, 0), 2) AS total_venta,
         round(COALESCE(k.c15, 0) + COALESCE(k.c16, 0) + COALESCE(k.c17, 0), 2) AS venta_total,
         h.dur AS duracion_horas
    FROM kepler_ods.kdpv_folio_caja k
    CROSS JOIN LATERAL (
      SELECT CASE
               WHEN ha IS NULL OR hc IS NULL THEN NULL
               WHEN hc - ha < 0 THEN hc - ha + 24
               ELSE hc - ha
             END AS dur
        FROM (SELECT substring(btrim(k.c6)  from '^[0-9]{1,2}')::int AS ha,
                     substring(btrim(k.c11) from '^[0-9]{1,2}')::int AS hc) t
    ) h
   WHERE (COALESCE(k.c25, 0) <> 0 OR COALESCE(k.c35, 0) <> 0)
     AND ($1::date IS NULL OR k.c5::date >= $1::date)
     AND ($2::text IS NULL OR k.sucursal = $2::text)
   ORDER BY k.sucursal, k.c2, k.c5::date, k.c3, k.c10 DESC NULLS LAST
`;

// `handoff` NO se lista: es GENERATED ALWAYS (cajero_apertura IS DISTINCT FROM cajero_cierre).
const UPSERT = `
INSERT INTO analytics.cash_cuts (
  tenant_id, warehouse_code, warehouse_name, caja, folio, business_date,
  opened_at, closed_at, cajero_apertura, cajero_cierre, turno,
  efectivo_esperado, efectivo_contado, efectivo_diff,
  tarjeta_esperado, tarjeta_contado, tarjeta_diff,
  transfer_esperado, transfer_contado, transfer_diff,
  arqueo_billetes, arqueo_monedas, arqueo_otros,
  efectivo_retirado, total_venta, venta_total,
  hora_apertura, hora_cierre, duracion_horas,
  warehouse_id, cerrado, source
)
SELECT $3::uuid, s.sucursal, w.name, s.caja, s.folio, s.business_date,
       s.opened_at, s.closed_at, s.cajero_apertura, s.cajero_cierre, s.turno,
       s.ef_esp, s.ef_cont, s.ef_diff,
       s.tj_esp, s.tj_cont, s.tj_diff,
       s.tr_esp, s.tr_cont, s.tr_diff,
       s.arq_bil, s.arq_mon, s.arq_otros,
       s.retirado, s.total_venta, s.venta_total,
       s.hora_apertura, s.hora_cierre, s.duracion_horas,
       w.id, true, 'kepler'
  FROM (${SRC}) s
  LEFT JOIN commercial.warehouses w
    ON w.tenant_id = $3::uuid AND w.code = s.sucursal AND w.deleted_at IS NULL
ON CONFLICT (tenant_id, warehouse_code, caja, business_date, folio) DO UPDATE SET
  warehouse_name    = EXCLUDED.warehouse_name,
  warehouse_id      = EXCLUDED.warehouse_id,
  opened_at         = EXCLUDED.opened_at,
  closed_at         = EXCLUDED.closed_at,
  cajero_apertura   = EXCLUDED.cajero_apertura,
  cajero_cierre     = EXCLUDED.cajero_cierre,
  turno             = EXCLUDED.turno,
  efectivo_esperado = EXCLUDED.efectivo_esperado,
  efectivo_contado  = EXCLUDED.efectivo_contado,
  efectivo_diff     = EXCLUDED.efectivo_diff,
  tarjeta_esperado  = EXCLUDED.tarjeta_esperado,
  tarjeta_contado   = EXCLUDED.tarjeta_contado,
  tarjeta_diff      = EXCLUDED.tarjeta_diff,
  transfer_esperado = EXCLUDED.transfer_esperado,
  transfer_contado  = EXCLUDED.transfer_contado,
  transfer_diff     = EXCLUDED.transfer_diff,
  arqueo_billetes   = EXCLUDED.arqueo_billetes,
  arqueo_monedas    = EXCLUDED.arqueo_monedas,
  arqueo_otros      = EXCLUDED.arqueo_otros,
  efectivo_retirado = EXCLUDED.efectivo_retirado,
  total_venta       = EXCLUDED.total_venta,
  venta_total       = EXCLUDED.venta_total,
  hora_apertura     = EXCLUDED.hora_apertura,
  hora_cierre       = EXCLUDED.hora_cierre,
  duracion_horas    = EXCLUDED.duracion_horas,
  cerrado           = true,
  source            = 'kepler',
  updated_at        = now()
`;

const money = (n) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });

(async () => {
  const ssl = /rlwy|proxy|railway/.test(DST) ? { rejectUnauthorized: false } : false;
  const pg = new Client({ connectionString: DST, ssl, statement_timeout: 120000 });
  await pg.connect();

  // Radiografía de lo que hay del lado de Kepler ANTES de escribir: si el número no
  // tiene sentido, mejor verlo en el dry-run que después en la bandeja.
  const { rows: [r] } = await pg.query(
    `SELECT count(*)::int cortes,
            count(DISTINCT sucursal)::int sucursales,
            min(business_date)::text desde, max(business_date)::text hasta,
            count(*) FILTER (WHERE abs(ef_diff) >= 50)::int descuadres,
            round(sum(ef_diff), 2) suma_diff,
            count(*) FILTER (WHERE abs(ef_diff) < 0.005)::int exactos,
            count(*) FILTER (WHERE abs(ef_diff - (ef_esp - ef_cont)) > 0.005)::int incoherentes
       FROM (${SRC}) s`,
    [FROM, SUC],
  );
  console.log(`Kepler (kepler_ods.kdpv_folio_caja): ${r.cortes} cortes cerrados · ${r.sucursales} sucursales · ${r.desde} → ${r.hasta}`);
  console.log(`  descuadres |diff|>=$50: ${r.descuadres} · suma de diferencias: ${money(r.suma_diff)}`);
  const pct = r.cortes ? ((r.exactos / r.cortes) * 100).toFixed(1) : '0.0';
  console.log(`  cuadran EXACTO al centavo: ${r.exactos} (${pct}%) ← el arqueo de Kepler no es ciego (SM.7)`);
  if (r.incoherentes > 0) console.warn(`  ⚠️ ${r.incoherentes} cortes donde c35 <> c15-c25 (revisar decode)`);

  const top = await pg.query(
    `SELECT sucursal, caja, business_date::text f, cajero_cierre, ef_diff
       FROM (${SRC}) s WHERE abs(ef_diff) >= 50 ORDER BY abs(ef_diff) DESC LIMIT 8`,
    [FROM, SUC],
  );
  if (top.rows.length) {
    console.log('\n  Mayores descuadres declarados por Kepler:');
    for (const x of top.rows) console.log(`    suc${x.sucursal} caja${x.caja} ${x.f} ${x.cajero_cierre || '?'} → ${money(x.ef_diff)}`);
  }

  if (!APPLY) {
    console.log('\n(dry-run — usar --apply para escribir a analytics.cash_cuts)');
    await pg.end();
    return;
  }

  const res = await pg.query(UPSERT, [FROM, SUC, TENANT]);
  const { rows: [after] } = await pg.query(
    `SELECT count(*)::int n FROM analytics.cash_cuts WHERE tenant_id = $1 AND source = 'kepler'`, [TENANT]);
  console.log(`\n✅ UPSERT ${res.rowCount} cortes → analytics.cash_cuts (total con source=kepler: ${after.n})`);
  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
