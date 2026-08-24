/* eslint-disable no-console */
/**
 * Precio base desde la BITÁCORA de Kepler (`kdpv_bitacora_precios`) → `BASE-MXN`, con validaciones.
 *
 * Reemplaza la lectura de `kdii.c90` de `repoint-catalog-prices.js`. Motivo (investigación
 * 2026-08-24, ver `docs/IMPLEMENTACION/KEPLER_PRECIOS_MODELO.md`):
 *
 *   1. `kdii.c90` NO es "precio pieza": es el precio de la UNIDAD BASE (`c11`), y el slot de
 *      `c91`/`c92` cambia por producto y por sucursal. Leerlo como pieza es un error de raíz.
 *   2. `kdii` se corrompe: 219 tripletas `(c90,c91,c92)` de plantilla compartidas por 4+ SKUs sin
 *      relación afectan a 1,667 productos (ahí viven los $15.25 y $7.02). La bitácora no.
 *   3. La bitácora es la única fuente con precio + UNIDAD + momento juntos, y está viva en las 7
 *      sucursales (5.27M filas, cambios de hoy).
 *
 * Cómo funciona:
 *   · precio vigente por rama = último `c7` por `(sucursal, SKU, unidad)` donde la unidad ES la
 *     unidad base que declara `kdii.c11` para esa misma rama.
 *   · consolidación = MEDIANA de las sucursales retail 01-06 (CEDIS 00 sólo como fallback: cotiza
 *     mayoreo más alto). Mediana y no moda: la moda premia a la mayoría, y cuando la plantilla mala
 *     está en más ramas que el dato bueno la moda elige la plantilla con confianza máxima.
 *   · redondeo a 2 decimales — Kepler reescribe con fracciones de centavo ($27.96 → $27.9644) y eso
 *     produce churn puro.
 *
 * Validaciones (el precio se RECHAZA, se conserva el anterior y se reporta — nunca se inventa uno):
 *   · `<= $0.05`           marcador de promo, no precio público
 *   · `< costo`            se vendería perdiendo
 *   · `> 3 × costo`        p99 de la razón precio/costo es 2.03× — arriba de 3× es dato malo
 *   · `< 0.9 × su escalón` un precio no puede ser menor que su propio precio por volumen
 *
 * Esto NO corrige a Kepler: se niega a propagar un valor imposible. Lo que salga rechazado se
 * arregla EN Kepler.
 *
 *   node database/importers/kepler/repoint-prices-from-bitacora.js              # dry-run
 *   node database/importers/kepler/repoint-prices-from-bitacora.js --apply
 *   node database/importers/kepler/repoint-prices-from-bitacora.js --rechazados # lista completa
 */
const { Client } = require('pg');
const heartbeat = require('../lib/cron-heartbeat');

const M = '00000000-0000-0000-0000-00000000d01c';
const BASE_LIST = '00000000-0000-0000-0000-0000c0ffee02'; // commercial.price_lists BASE-MXN (is_default)
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const VER_RECHAZOS = process.argv.includes('--rechazados');
const MAX_COSTO = Number((process.argv.find((a) => a.startsWith('--max-costo=')) || '').split('=')[1] || 3);
const VENTANA_DIAS = Number((process.argv.find((a) => a.startsWith('--dias=')) || '').split('=')[1] || 400);

const $ = (n) => (n === null || n === undefined ? '—' : `$${Number(n).toFixed(2)}`);
const num = (n) => Number(n).toLocaleString('es-MX');

/** Precio propuesto por SKU + su veredicto. Todo server-side sobre kepler_ods (same-DB). */
const EVALUADO = `
  WITH base_unit AS (
    SELECT btrim(sucursal) AS suc, btrim(c1) AS sku, btrim(c11::text) AS unidad
      FROM kepler_ods.kdii
     WHERE btrim(coalesce(c1, '')) <> '' AND btrim(coalesce(c11::text, '')) <> ''
  ), ult AS (
    SELECT DISTINCT ON (btrim(b.sucursal), btrim(b.c3), btrim(b.c4))
           btrim(b.sucursal) AS suc, btrim(b.c3) AS sku, btrim(b.c4) AS unidad,
           b.c7::numeric AS precio, b.c1::date AS fecha
      FROM kepler_ods.kdpv_bitacora_precios b
     WHERE b.c1::date >= current_date - ${VENTANA_DIAS} AND b.c7::numeric > 0
     ORDER BY btrim(b.sucursal), btrim(b.c3), btrim(b.c4), b.c1 DESC, b.c2 DESC
  ), precio_rama AS (
    SELECT u.suc, u.sku, u.unidad, u.precio, u.fecha
      FROM ult u
      JOIN base_unit bu ON bu.suc = u.suc AND bu.sku = u.sku AND bu.unidad = u.unidad
  ), retail AS (
    SELECT sku,
           mode() WITHIN GROUP (ORDER BY unidad) AS unidad,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY precio)::numeric, 2) AS precio,
           count(*)::int AS ramas, max(fecha) AS fecha
      FROM precio_rama WHERE suc <> '00' GROUP BY sku
  ), propuesto AS (
    SELECT sku, unidad, precio, ramas, fecha, 'retail'::text AS origen FROM retail
    UNION ALL
    SELECT c.sku, c.unidad, round(c.precio, 2), 1, c.fecha, 'cedis'
      FROM precio_rama c
     WHERE c.suc = '00' AND NOT EXISTS (SELECT 1 FROM retail r WHERE r.sku = c.sku)
  ), tier AS (
    SELECT btrim(c1) AS sku, btrim(c2) AS present, max(c7::numeric) AS tope
      FROM kepler_ods.kdpv_prod_util
     WHERE btrim(sucursal) <> '00' AND c7::numeric > 0.05
     GROUP BY 1, 2
  ), cobrado AS (
    -- El testigo mas fuerte: lo que Kepler COBRO de verdad. Ni la bitacora ni kdii ni la escalera
    -- son infalibles en la ETIQUETA de unidad (ej. 89106: las tres dicen PAQ=798.97, pero 798.97 es
    -- la caja de 24 y las 99 lineas de venta reales dicen 33.29). Se excluye la sucursal 00 y los
    -- doctypes de traspaso (U-A-50 recepcion, U-D-6 consolidacion, U-D-13 salida CEDIS) porque
    -- esos se mueven A COSTO y no son precio de venta.
    SELECT btrim(m2.c8::text) AS sku,
           mode() WITHIN GROUP (ORDER BY round(m2.c12::numeric, 2)) AS precio,
           count(*)::int AS lineas
      FROM kepler_ods.kdm2 m2
      JOIN kepler_ods.kdm1 m1
        ON btrim(m1.sucursal) = btrim(m2.sucursal)
       AND btrim(m1.c5::text) = btrim(m2.c5::text)
       AND btrim(m1.c6::text) = btrim(m2.c6::text)
     WHERE m1.c9::date >= current_date - 90
       AND btrim(coalesce(m1.c43::text, 'N')) = 'N'
       AND m2.c12::numeric > 0.05
       AND btrim(m1.sucursal) <> '00'
       AND NOT (btrim(m1.c2::text) = 'U' AND btrim(m1.c3::text) = 'A' AND m1.c4::int = 50)
       AND NOT (btrim(m1.c2::text) = 'U' AND btrim(m1.c3::text) = 'D' AND m1.c4::int IN (6, 13))
     GROUP BY 1
    HAVING count(*) >= 5
  )
  SELECT p.sku, p.unidad, p.precio, p.ramas, p.fecha, p.origen,
         pr.id AS product_id, pr.nombre, pr.cost_base, pp.price AS actual, t.tope AS tier_tope,
         cb.precio AS cobrado, cb.lineas AS lineas_cobradas,
         CASE
           WHEN p.precio <= 0.05                                              THEN 'marcador_promo'
           -- Lo cobrado manda sobre todo lo demas: es el unico testigo que no depende de una etiqueta.
           WHEN cb.lineas IS NOT NULL
            AND (p.precio > cb.precio * 1.5 OR p.precio < cb.precio * 0.67)   THEN 'contradice_cobrado'
           -- El escalon de volumen esta en la MISMA unidad que el precio (ambos salen de la
           -- presentacion). El costo no: cost_base viene de kdik y con frecuencia esta en caja
           -- mientras el precio esta en pieza (ej. 02020 TRIDENT /12: precio 8.50, escalon 8.31,
           -- costo 66.50 = la caja). Por eso, cuando el escalon confirma el precio, MANDA sobre el
           -- costo; el costo solo decide donde no hay escalera que consultar.
           WHEN t.tope IS NOT NULL AND p.precio >= t.tope * 0.9               THEN NULL
           WHEN t.tope IS NOT NULL                                            THEN 'bajo_su_escalon'
           WHEN pr.cost_base > 0 AND p.precio < pr.cost_base                  THEN 'bajo_costo'
           WHEN pr.cost_base > 0 AND p.precio > pr.cost_base * ${MAX_COSTO}   THEN 'sobre_costo'
         END AS rechazo
    FROM propuesto p
    JOIN catalog.products pr
      ON btrim(pr.sku) = p.sku AND pr.tenant_id = $1 AND pr.deleted_at IS NULL
     AND NOT coalesce(pr.is_promo, false)
    LEFT JOIN commercial.product_prices pp
      ON pp.tenant_id = $1 AND pp.price_list_id = '${BASE_LIST}' AND pp.product_id = pr.id
     AND pp.deleted_at IS NULL
    LEFT JOIN tier t ON t.sku = p.sku AND t.present = p.unidad
    LEFT JOIN cobrado cb ON cb.sku = p.sku`;

(async () => {
  const dst = new Client({
    connectionString: DST,
    ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false,
    statement_timeout: 900000,
  });
  await dst.connect();
  await heartbeat.begin('kepler_prices_bitacora', 'Precio base desde bitácora Kepler').catch(() => {});

  try {
    console.log(`\n=== Precio base ← kdpv_bitacora_precios (unidad base, mediana retail) → BASE-MXN (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
    await dst.query(`SET work_mem='256MB'`);
    await dst.query('BEGIN');
    await dst.query(`SET LOCAL app.tenant_id = '${M}'`);

    await dst.query(`CREATE TEMP TABLE ev ON COMMIT DROP AS ${EVALUADO}`, [M]);
    await dst.query(`CREATE INDEX ON ev (product_id)`);

    const s = (await dst.query(`
      SELECT count(*)::int total,
             count(*) FILTER (WHERE rechazo IS NULL)::int validos,
             count(*) FILTER (WHERE rechazo IS NOT NULL)::int rechazados,
             count(*) FILTER (WHERE origen = 'cedis')::int por_cedis,
             round(avg(ramas)::numeric, 2) ramas_prom
        FROM ev`)).rows[0];
    console.log(`Evaluados:      ${num(s.total)} productos · ${s.ramas_prom} sucursales por SKU · ${num(s.por_cedis)} sólo con precio de CEDIS`);
    console.log(`Válidos:        ${num(s.validos)}`);
    console.log(`Rechazados:     ${num(s.rechazados)}`);

    const porRechazo = (await dst.query(`
      SELECT rechazo, count(*)::int n FROM ev WHERE rechazo IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`)).rows;
    porRechazo.forEach((r) => console.log(`   · ${String(r.rechazo).padEnd(18)} ${num(r.n)}`));

    const d = (await dst.query(`
      SELECT count(*) FILTER (WHERE actual IS NULL)::int nuevos,
             count(*) FILTER (WHERE actual IS NOT NULL AND abs(precio - actual) < 0.005)::int iguales,
             count(*) FILTER (WHERE actual IS NOT NULL AND precio > actual + 0.005)::int suben,
             count(*) FILTER (WHERE actual IS NOT NULL AND precio < actual - 0.005)::int bajan
        FROM ev WHERE rechazo IS NULL`)).rows[0];
    console.log(`\nCambio sobre BASE-MXN:  ${num(d.iguales)} quedan igual · ${num(d.suben)} suben · ${num(d.bajan)} bajan · ${num(d.nuevos)} sin precio previo`);

    const top = (await dst.query(`
      SELECT sku, nombre, actual, precio, cost_base, unidad, ramas, cobrado, lineas_cobradas
        FROM ev WHERE rechazo IS NULL AND actual IS NOT NULL AND abs(precio - actual) >= 0.005
       ORDER BY abs(precio - actual) * LEAST(coalesce((SELECT sales_units_30d FROM catalog.products WHERE id = ev.product_id), 0), 1000000) DESC
       LIMIT 12`)).rows;
    if (top.length) {
      console.log('\n  Mayor impacto (rotación × diferencia):');
      top.forEach((x) => console.log(`  ${x.sku.padEnd(7)} ${String(x.nombre).slice(0, 32).padEnd(32)} ${$(x.actual).padStart(10)} → ${$(x.precio).padStart(10)}` +
        ` · costo ${$(x.cost_base).padStart(9)} · ${x.unidad} · ${x.ramas} suc`));
    }

    const rech = (await dst.query(`
      SELECT sku, nombre, actual, precio, cost_base, tier_tope, rechazo
        FROM ev WHERE rechazo IS NOT NULL ORDER BY rechazo, sku ${VER_RECHAZOS ? '' : 'LIMIT 12'}`)).rows;
    if (rech.length) {
      console.log(`\n  Rechazados (se conserva el precio actual; arreglar EN Kepler)${VER_RECHAZOS ? '' : ' — primeros 12, usar --rechazados para la lista completa'}:`);
      rech.forEach((x) => console.log(`  ${String(x.rechazo).padEnd(16)} ${x.sku.padEnd(7)} ${String(x.nombre).slice(0, 28).padEnd(28)}` +
        ` propuesto ${$(x.precio).padStart(10)} · actual ${$(x.actual).padStart(10)} · costo ${$(x.cost_base).padStart(9)}` +
        `${x.tier_tope ? ` · escalón ${$(x.tier_tope)}` : ''}`));
    }

    if (!APPLY) {
      await dst.query('ROLLBACK');
      console.log('\n[DRY-RUN] ROLLBACK — nada cambió.\n');
      await heartbeat.end('kepler_prices_bitacora', { status: 'ok', rows: 0, note: `dry-run: ${s.validos} válidos, ${s.rechazados} rechazados` }).catch(() => {});
      return;
    }

    const res = await dst.query(`
      INSERT INTO commercial.product_prices (id, tenant_id, price_list_id, product_id, price, tax_rate, min_qty, created_at, updated_at)
      SELECT gen_random_uuid(), $1, '${BASE_LIST}', e.product_id, e.precio, COALESCE(p.iva_rate, 0), 1, now(), now()
        FROM ev e JOIN catalog.products p ON p.id = e.product_id
       WHERE e.rechazo IS NULL
      ON CONFLICT (tenant_id, price_list_id, product_id) DO UPDATE
        SET price = EXCLUDED.price, updated_at = now()
      WHERE commercial.product_prices.price IS DISTINCT FROM EXCLUDED.price`, [M]);

    await dst.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${num(res.rowCount)} precios escritos (churn-free) · ${num(s.rechazados)} rechazados por validación.\n`);
    await heartbeat.end('kepler_prices_bitacora', { status: 'ok', rows: res.rowCount, note: `${s.rechazados} rechazados` }).catch(() => {});
  } catch (e) {
    await dst.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    await heartbeat.end('kepler_prices_bitacora', { status: 'error', error: e.message }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await dst.end().catch(() => {});
  }
})();
