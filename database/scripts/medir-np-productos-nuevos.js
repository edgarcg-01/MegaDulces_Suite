#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `[NP.0]` `[NP.6]` `[NP.UI.1]` `[NP.UI.3]` — Medición de Productos nuevos. **SÓLO LECTURA.**
 *
 * Lo que la tarjeta #33 no pudo cerrar sin producción (2026-11-03). Todo lo que aquí no se pueda medir
 * se imprime como NO MEDIDO, nunca como cero (ADR-056). Cada sección arranca con un CONTROL cuya
 * respuesta ya se conoce: si el control falla, la sección no se cree.
 *
 *   A. `[NP.0]` ¿Kepler guarda la fecha de alta del producto en `kdii`? Las 6 columnas fecha
 *      (`c50 c56 c60 c64 c65 c75`): cuántas traen una fecha real (no el vacío `1800-01-01`) por
 *      sucursal, y si alguna se porta como «alta» (≤ primera actividad del kardex y cerca de ella).
 *      En la base local (sucursal 02, 9,678 fichas) las SEIS valen `1800-01-01` en el 100 %.
 *   B. `[NP.0]` El umbral de «carga masiva» (≥ 50 altas en un día en la Suite): histograma de altas
 *      por día y cuántos «dados de alta sin recibir» saldrían con 30 / 50 / 80.
 *   C. `[NP.UI.1]` La compra con el impuesto ADENTRO (tasa negativa en `kdm2.c17/c18` de `XA20`) en
 *      los productos nuevos: renglones, SKUs y pesos de más, por mes. Y `[NP.0]`: qué parte de las
 *      entradas declara su caja (`c55/c56` con la identidad `c9 = c56 × c58`).
 *   D. `[NP.6]` Cuántos productos en seguimiento ya cumplieron 30 / 60 / 90 días (cortes DERIVADOS de la
 *      historia, sin tabla ni cron desde 2026-11-04), la ventana de 180 días (ningún corte 90 sin historia) y lo
 *      que tardó el último refresco de la matvista (`cron_runs`).
 *   E. `[NP.UI.1]` ANTES/DESPUÉS de la venta sin impuestos: con el SERVICIO real (lista completa),
 *      cuántos cambian de recomendación al comparar venta neta contra la compra. El lado de la compra
 *      (sección C) lo netea el SERVIDOR (`[NP.18]` sin migración): `compra_info` dice cuántos documentos.
 *   F. `[NP.UI.3]` (con `--con-pf`) Productos nuevos contra Productos/flujo: el cruce de los dos
 *      veredictos de compra para los MISMOS productos, con el servicio real de cada uno. Pesado: fuera
 *      de horario hábil.
 *
 * Uso:
 *   PROD_DB_URL=postgresql://<dev_ro>@192.168.0.222:5434/railway node database/scripts/medir-np-productos-nuevos.js [--con-pf]
 *   node database/scripts/medir-np-productos-nuevos.js --local [--con-pf]     (control: la base local)
 *
 * ⛔ Destino: `resolverProd()` verifica el clúster por `system_identifier` y exige cuenta de sólo
 *    lectura (NO `FLEET_DB_URL`: apunta a Railway). Además la sesión se pone `read only`.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RAIZ = path.resolve(__dirname, '..', '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env'), quiet: true });

const LOCAL = process.argv.includes('--local');
const CON_PF = process.argv.includes('--con-pf');
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const VACIO = '1800-01-01';

async function conectar() {
  if (LOCAL) {
    const url = process.env.DATABASE_URL_NEW || '';
    if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error('--local exige DATABASE_URL_NEW en 127.0.0.1/localhost');
    return require(path.join(RAIZ, 'node_modules', 'knex'))({ client: 'pg', connection: url, pool: { min: 0, max: 1 } });
  }
  const { resolverProd } = require(path.join(__dirname, 'lib', 'destino-prod.js'));
  return resolverProd({ exigirSoloLectura: true });
}

let fallas = 0;
async function medir(db, titulo, sql, binds = []) {
  const t0 = Date.now();
  try {
    // En su SAVEPOINT: una tabla que no existe (p. ej. el registro de umbrales en una base atrasada) no
    // aborta la transacción y deja sin medir todo lo que sigue.
    const r = await db.transaction((sp) => sp.raw(sql, binds));
    console.log(`\n── ${titulo}  (${Date.now() - t0} ms, ${r.rows.length} filas)`);
    console.table(r.rows);
    return r.rows;
  } catch (e) {
    fallas += 1;
    console.log(`\n── ${titulo}  NO MEDIDO: ${e.message.split('\n')[0]}`);
    return null;
  }
}

/** Carga el servicio real de Productos nuevos (y el de flujo) con los alias del monorepo. */
function servicios() {
  const ts = require(path.join(RAIZ, 'node_modules', 'typescript'));
  const paths = ts.parseConfigFileTextToJson('tsconfig.base.json',
    fs.readFileSync(path.join(RAIZ, 'tsconfig.base.json'), 'utf8')).config.compilerOptions.paths;
  require(path.join(RAIZ, 'node_modules', 'tsconfig-paths')).register({ baseUrl: RAIZ, paths });
  require(path.join(RAIZ, 'node_modules', 'ts-node')).register({
    transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node',
      experimentalDecorators: true, ignoreDeprecations: '6.0' },
  });
  require(path.join(RAIZ, 'node_modules', 'reflect-metadata'));
  const lib = path.join(RAIZ, 'libs/commercial/src/lib/commercial-products');
  return {
    NewProductsService: require(path.join(lib, 'new-products.service.ts')).NewProductsService,
    ProductFlowService: require(path.join(lib, 'product-flow.service.ts')).ProductFlowService,
  };
}

(async () => {
  const db = await conectar();
  const who = (await db.raw(`SELECT current_user AS usuario, current_database() AS base,
    (SELECT system_identifier FROM pg_control_system())::text AS cluster, now()::text AS ahora`)).rows[0];
  console.log(`Destino: ${LOCAL ? 'LOCAL (control)' : 'PRODUCCIÓN'}`, who);

  await db.transaction(async (trx) => {
    await trx.raw('SET TRANSACTION READ ONLY');
    await trx.raw(`SET LOCAL statement_timeout = '120s'`);
    await trx.raw('SET LOCAL jit = off');
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);

    // ── A ───────────────────────────────────────────────────────────────────────────────
    const cols = ['c50', 'c56', 'c60', 'c64', 'c65', 'c75'];
    await medir(trx, 'A0 · CONTROL: kdii existe y la sucursal 02 trae fichas (en local: 9,679)',
      `SELECT sucursal, count(*)::int AS fichas FROM kepler_ods.kdii GROUP BY 1 ORDER BY 1`);
    await medir(trx, `A1 · [NP.0] fechas reales (≠ ${VACIO}) en las 6 columnas fecha de kdii, por sucursal`, `
      SELECT sucursal, count(*)::int AS fichas,
             ${cols.map((c) => `count(*) FILTER (WHERE ${c} IS NOT NULL AND ${c}::date <> DATE '${VACIO}')::int AS ${c}_reales`).join(',\n             ')}
        FROM kepler_ods.kdii GROUP BY 1 ORDER BY 1`);
    for (const c of cols) {
      await medir(trx, `A2 · [NP.0] ${c}: ¿se porta como fecha de ALTA? (contra la primera entrada del kardex, mismo almacén)`, `
        WITH f AS (
          SELECT k.sucursal, btrim(k.c1) AS sku, k.${c}::date AS fecha
            FROM kepler_ods.kdii k
           WHERE k.${c} IS NOT NULL AND k.${c}::date <> DATE '${VACIO}'
        ), pk AS (
          SELECT j.sucursal, btrim(j.c3) AS sku, min(j.c10::date) AS primera
            FROM kepler_ods.kdij j
           WHERE j.c1 = j.sucursal
           GROUP BY 1, 2
        )
        SELECT count(*)::int AS con_fecha,
               count(pk.primera)::int AS con_kardex,
               count(*) FILTER (WHERE f.fecha <= pk.primera)::int AS antes_o_igual_a_la_primera,
               count(*) FILTER (WHERE f.fecha > pk.primera)::int AS despues,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY (pk.primera - f.fecha)) AS mediana_dias_a_primera,
               min(f.fecha)::text AS min, max(f.fecha)::text AS max, count(DISTINCT f.fecha)::int AS dias_distintos
          FROM f LEFT JOIN pk ON pk.sucursal = f.sucursal AND pk.sku = f.sku`);
    }

    // ── B ───────────────────────────────────────────────────────────────────────────────
    await medir(trx, 'B0 · CONTROL: productos del catálogo (no borrados) y su rango de alta en la Suite',
      `SELECT count(*)::int AS productos, min(created_at)::date::text AS desde, max(created_at)::date::text AS hasta
         FROM catalog.products WHERE tenant_id = ? AND deleted_at IS NULL`, [TENANT]);
    await medir(trx, 'B1 · [NP.0] altas por día en la Suite, en tramos (el corte vigente es ≥ 50 = carga masiva)', `
      WITH d AS (SELECT created_at::date AS dia, count(*)::int AS n FROM catalog.products
                  WHERE tenant_id = ? GROUP BY 1)
      SELECT CASE WHEN n < 5 THEN '01-04' WHEN n < 10 THEN '05-09' WHEN n < 24 THEN '10-23' WHEN n < 50 THEN '24-49'
                  WHEN n < 100 THEN '50-99' ELSE '100+' END AS altas_en_el_dia,
             count(*)::int AS dias, sum(n)::int AS productos, max(n)::int AS max_del_tramo
        FROM d GROUP BY 1 ORDER BY 1`, [TENANT]);
    await medir(trx, 'B2 · [NP.0] «dados de alta sin recibir» (últimos 90 días, desde Kepler, sin actividad) según el corte', `
      WITH lot AS (SELECT created_at::date AS dia, count(*) AS n FROM catalog.products WHERE tenant_id = ? GROUP BY 1)
      SELECT u.corte, count(*)::int AS sin_movimiento_que_saldrian
        FROM (VALUES (30), (50), (80), (200)) u(corte)
        CROSS JOIN catalog.products p
        JOIN lot ON lot.dia = p.created_at::date
       WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND p.source = 'kepler'
         AND p.created_at::date >= current_date - 90 AND lot.n < u.corte
         AND NOT EXISTS (SELECT 1 FROM analytics.mv_kepler_sales_daily k WHERE k.product_id = p.id)
       GROUP BY 1 ORDER BY 1`, [TENANT, TENANT]);

    // ── C ───────────────────────────────────────────────────────────────────────────────
    const NP_SKUS = `(SELECT DISTINCT sku FROM analytics.mv_new_products WHERE tenant_id = '${TENANT}' AND lanzamiento IS NOT NULL)`;
    const N = (c) => `nullif(regexp_replace(l.${c}::text, '[^0-9.-]', '', 'g'), '')::numeric`;
    await medir(trx, 'C0 · CONTROL: productos nuevos con lanzamiento en la matvista', `
      SELECT count(*)::int AS filas, count(*) FILTER (WHERE lanzamiento IS NOT NULL)::int AS con_lanzamiento,
             min(corte)::text AS corte FROM analytics.mv_new_products WHERE tenant_id = ?`, [TENANT]);
    await medir(trx, 'C1 · [NP.UI.1] compras XA20 de productos nuevos: impuesto ADENTRO (tasa negativa) vs aparte, por mes', `
      SELECT to_char(h.c9::date, 'YYYY-MM') AS mes, count(*)::int AS renglones,
             count(*) FILTER (WHERE ${N('c17')} < 0 OR ${N('c18')} < 0)::int AS con_impuesto_adentro,
             count(DISTINCT btrim(l.c8)) FILTER (WHERE ${N('c17')} < 0 OR ${N('c18')} < 0)::int AS skus_adentro,
             count(*) FILTER (WHERE ${N('c17')} IS NULL AND ${N('c18')} IS NULL)::int AS sin_tasa,
             round(sum(coalesce(${N('c13')}, 0)), 2) AS importe_como_hoy,
             round(sum(coalesce(${N('c13')}, 0) / ((1 + CASE WHEN ${N('c18')} < 0 THEN abs(${N('c18')}) / 100 ELSE 0 END)
                                                  * (1 + CASE WHEN ${N('c17')} < 0 THEN abs(${N('c17')}) / 100 ELSE 0 END))), 2) AS importe_sin_impuestos
        FROM kepler_ods.kdm1 h
        JOIN kepler_ods.kdm2 l ON l.sucursal = h.sucursal AND l.c1 = h.c1 AND l.c2 = h.c2 AND l.c3 = h.c3
                              AND l.c4 = h.c4 AND l.c5 = h.c5 AND l.c6 = h.c6
       WHERE h.c2 = 'X' AND h.c3 = 'A' AND btrim(h.c4::text) = '20' AND btrim(h.c1::text) = h.sucursal::text
         AND btrim(coalesce(h.c43::text, '')) <> 'C' AND h.c9::date >= current_date - 200
         AND nullif(btrim(l.c8::text), '') IN ${NP_SKUS}
       GROUP BY 1 ORDER BY 1`);
    await medir(trx, 'C2 · [NP.0] entradas XA20 (180 días) que declaran su caja: c55 con c9 = c56 × c58', `
      SELECT count(*)::int AS renglones,
             count(*) FILTER (WHERE nullif(btrim(l.c55::text), '') IS NOT NULL)::int AS declaran_c55,
             count(*) FILTER (WHERE nullif(btrim(l.c55::text), '') IS NOT NULL AND ${N('c56')} <> 0 AND ${N('c58')} > 0
                               AND abs(l.c9::numeric - ${N('c56')} * ${N('c58')}) <= 0.001)::int AS identidad_cierra
        FROM kepler_ods.kdm1 h
        JOIN kepler_ods.kdm2 l ON l.sucursal = h.sucursal AND l.c1 = h.c1 AND l.c2 = h.c2 AND l.c3 = h.c3
                              AND l.c4 = h.c4 AND l.c5 = h.c5 AND l.c6 = h.c6
       WHERE h.c2 = 'X' AND h.c3 = 'A' AND btrim(h.c4::text) = '20' AND btrim(h.c1::text) = h.sucursal::text
         AND h.c9::date >= current_date - 180`);
    await medir(trx, 'C3 · [NP.UI.1] SKUs de venta con MÁS de un par IVA/IEPS (el factor de impuesto por producto supone 0)', `
      SELECT count(*)::int AS skus_nuevos_con_venta, count(*) FILTER (WHERE pares > 1)::int AS con_mas_de_un_par
        FROM (SELECT btrim(l.c8) AS sku, count(DISTINCT (abs(coalesce(${N('c17')}, 0)), abs(coalesce(${N('c18')}, 0)))) AS pares
                FROM kepler_ods.kdm1 h
                JOIN kepler_ods.kdm2 l ON btrim(l.sucursal) = btrim(h.sucursal) AND btrim(l.c1) = btrim(h.c1)
                                      AND l.c2 = h.c2 AND l.c3 = h.c3 AND l.c4::integer = h.c4::integer
                                      AND l.c5::integer = h.c5::integer AND btrim(l.c6) = btrim(h.c6)
               WHERE h.c2 = 'U' AND h.c3 = 'D' AND h.c4::integer IN (8, 10, 12) AND h.c9::date >= current_date - 200
                 AND btrim(l.c8) IN ${NP_SKUS}
               GROUP BY 1) s`);

    // ── D ───────────────────────────────────────────────────────────────────────────────
    await medir(trx, 'D1 · [NP.6] en seguimiento (aprox. SQL) que ya cumplieron cada hito (cortes definitivos, de la historia)', `
      SELECT h.n AS hito, count(*)::int AS productos
        FROM analytics.mv_new_products m
        LEFT JOIN catalog.new_product_reviews r ON r.tenant_id = m.tenant_id AND r.product_id = m.product_id AND r.deleted_at IS NULL
       CROSS JOIN (VALUES (30), (60), (90)) h(n)
       WHERE m.tenant_id = ? AND m.lanzamiento IS NOT NULL AND NOT m.no_medible
         AND (r.kind IS NULL OR r.kind = 'nuevo') AND (m.exclusion_auto IS NULL OR r.kind = 'nuevo')
         AND m.lanzamiento + h.n <= (now() AT TIME ZONE 'America/Mexico_City')::date
       GROUP BY 1 ORDER BY 1`, [TENANT]);
    await medir(trx, 'D2 · refrescos y latidos de Productos nuevos (cron_runs)', `
      SELECT job_key, status, last_finish::text, duration_ms, rows_affected, left(coalesce(error, note, ''), 120) AS detalle
        FROM analytics.cron_runs WHERE tenant_id = ? AND job_key = 'analytics_refresh_new_products'`, [TENANT]);
    await medir(trx, 'D3 · [NP.6] la ventana de 180 días: productos por días desde el lanzamiento y cortes 90 sin historia (debe ser 0)', `
      SELECT count(*) FILTER (WHERE corte - lanzamiento >= 90)::int AS con_corte_90,
             count(*) FILTER (WHERE corte - lanzamiento > 180)::int AS mas_de_180,
             count(*) FILTER (WHERE corte - lanzamiento BETWEEN 90 AND 180 AND coalesce(array_length(venta_dia, 1), 0) < 90)::int AS corte_90_sin_historia,
             to_regclass('analytics.kpi_thresholds')::text AS umbrales
        FROM analytics.mv_new_products WHERE tenant_id = ? AND lanzamiento IS NOT NULL`, [TENANT]);
    await medir(trx, 'D4 · [NP.6] umbrales de los hitos registrados (0 = «sin meta»)', `
      SELECT kpi_key, period, target, warn_at, escalate_at, source FROM analytics.kpi_thresholds
       WHERE tenant_id = '${TENANT}' AND deleted_at IS NULL AND kpi_key LIKE 'compras.productos_nuevos.%'`);

    // ── E / F ───────────────────────────────────────────────────────────────────────────
    let S;
    try { S = servicios(); } catch (e) { fallas += 1; console.log(`\n── E/F NO MEDIDO: no se pudo cargar el servicio (${e.message})`); }
    if (S) {
      const tk = { run: async (a, b) => (typeof a === 'function' ? a : b)(trx), global: trx };
      const np = new S.NewProductsService(tk, { get: () => null });
      const t0 = Date.now();
      let lista = null;
      try { lista = await np.list({ puedeVerCosto: true }); } catch (e) { fallas += 1; console.log(`\n── E NO MEDIDO: ${e.message}`); }
      if (lista && lista.calculado) {
        const seg = lista.filas.filter((f) => f.estado === 'seguimiento');
        console.log(`\n── E · [NP.UI.1] la lista real: ${lista.filas.length} productos, ${seg.length} en seguimiento (${Date.now() - t0} ms) · hitos_info`, lista.hitos_info);
        // [NP.18] La compra sin impuestos la netea el servidor: cuántos documentos, cuántos traían el impuesto adentro, y
        // los que no aparecieron o no cuadraron (se quedan como los escribió Kepler).
        console.log('   compra_info (NP.18):', lista.compra_info);
        // La regla VIEJA sobre los mismos datos: venta CON impuestos contra la compra.
        const rec = require(path.join(RAIZ, 'libs/commercial/src/lib/commercial-products/new-products.ts'));
        // [NP.20] El umbral 0.80 (`recuperadoAlto`) salió del criterio con np6-v2; se conserva AQUÍ, con nombre, sólo
        // para medir cuántos lo cruzaban por los impuestos con la regla vieja (el antes/después de NP.18).
        const C = { recuperadoAlto: 0.8 };
        void rec;
        let cambian = 0; let conCociente = 0; const ej = [];
        for (const f of seg) {
          if (f.inversion_total === null || !f.inversion_total || f.venta_total === null) continue;
          conCociente += 1;
          const vieja = f.venta_total / f.inversion_total;
          const nueva = f.venta_por_peso;
          const cruzaba = vieja >= C.recuperadoAlto && (nueva === null || nueva < C.recuperadoAlto);
          if (cruzaba) { cambian += 1; if (ej.length < 15) ej.push({ sku: f.sku, dia: f.dia, antes: +vieja.toFixed(2), ahora: nueva, veredicto_hoy: f.recomendacion?.veredicto }); }
        }
        console.log(`   con cociente: ${conCociente} · cruzaban el umbral de ${C.recuperadoAlto} SÓLO por los impuestos: ${cambian}`);
        console.table(ej);
        // [NP.21] «Sacar» porque no se vende… ¿o porque no hay? Desde NP.21 sin existencia no se juzga: el candado
        // espera CERO «sacar» sin existencia en ninguna sucursal, y cuenta los que pasaron a «agotado».
        const sacarSinExistencia = seg.filter((f) => f.recomendacion?.veredicto === 'sacar' && f.plazas_con_existencia === 0);
        const agotados = seg.filter((f) => f.recomendacion?.veredicto === 'agotado');
        if (sacarSinExistencia.length) fallas += 1;
        console.log(`   ${sacarSinExistencia.length ? '❌' : '✔'} «Sacar» SIN existencia en ninguna sucursal (debe ser 0): ${sacarSinExistencia.length}`,
          sacarSinExistencia.slice(0, 10).map((f) => f.sku), `· «Agotado: no se juzga»: ${agotados.length}`);
        const porV = {}; for (const f of seg) { const v = f.recomendacion?.veredicto ?? '—'; porV[v] = (porV[v] ?? 0) + 1; }
        console.log('   veredictos de hoy (venta sin impuestos):', porV, '· resumen:', {
          inversion: lista.resumen?.inversion, venta: lista.resumen?.venta, venta_neta: lista.resumen?.venta_neta,
          con_inversion: lista.resumen?.con_inversion, venta_por_peso: lista.resumen?.venta_por_peso });
        if (CON_PF) {
          const pf = new S.ProductFlowService(tk, { get: () => null }, trx);
          const ids = seg.filter((f) => f.recomendacion).map((f) => f.product_id);
          const t1 = Date.now();
          try {
            const flujo = await pf.list(ids, { puedeVerCosto: false });
            const pfPor = new Map(flujo.productos.map((r) => [r.product_id, r.compra.veredicto]));
            const cruce = {};
            const fuerte = []; let urgencia = 0;
            for (const f of seg.filter((x) => x.recomendacion)) {
              const a = f.recomendacion.veredicto; const b = pfPor.get(f.product_id) ?? '(sin PF)';
              cruce[`${a} × ${b}`] = (cruce[`${a} × ${b}`] ?? 0) + 1;
              // [NP.20] NP ya no dice si comprar. Lo que queda por explicar: el lanzamiento «Sacar» y Productos pide reponer
              // (el panel lo dice con `cruceCompra`). «Urgencia»: el lanzamiento pide revisión y Productos pide comprar.
              if (a === 'sacar' && (b === 'comprar' || b === 'traspasar')) fuerte.push({ sku: f.sku, np: a, pf: b });
              else if (a === 'revisar' && b === 'comprar') urgencia += 1;
            }
            console.log(`\n── F · [NP.UI.3] NP × PF sobre ${ids.length} productos (${Date.now() - t1} ms)`);
            console.table(Object.entries(cruce).sort().map(([k, n]) => ({ np_x_pf: k, productos: n })));
            console.log(`   contradicción FUERTE: ${fuerte.length} · desacuerdo de urgencia: ${urgencia}`);
            console.table(fuerte.slice(0, 20));
          } catch (e) { fallas += 1; console.log(`\n── F NO MEDIDO: ${e.message}`); }
        } else {
          console.log('\n── F · [NP.UI.3] NO MEDIDO en esta corrida (sin --con-pf)');
        }
      } else if (lista) {
        console.log('\n── E NO MEDIDO: la matvista no está poblada');
      }
    }
  });
  await db.destroy();
  console.log(`\n${fallas ? `${fallas} sección(es) NO MEDIDA(S)` : 'todas las secciones medidas'} · nada se escribió (transacción de sólo lectura)`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
