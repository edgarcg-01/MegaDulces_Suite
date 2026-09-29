'use strict';
/**
 * [IC.0] Smoke de `analytics.v_erp_physical_count_variance` — el descuadre del conteo físico.
 *
 * Lo que protege: la vista es la única fuente de la pantalla de Diferencias, y tres decisiones
 * suyas son fáciles de romper sin que nadie lo note, porque el resultado sigue siendo un
 * número plausible.
 *
 *   node database/tests/test-newdb-inventory-variance.js
 *
 * Sólo lee. Si la vista todavía no está aplicada, lo DECLARA y sale 0 — "no existe" no es
 * "está mal", y tampoco es "está bien".
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

let ok = 0, bad = 0;
const t = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { bad++; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
};

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({
    client: 'pg',
    connection: { connectionString: url, ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(url) ? false : { rejectUnauthorized: false } },
    pool: { min: 0, max: 2 },
  });

  console.log('\n=== [IC.0] descuadre del conteo físico de Kepler ===\n');

  try {
    // ── De dónde sale el SQL que se ejerce ────────────────────────────────────
    // Si la vista ya está aplicada, se prueba EL OBJETO. Si no —destino sin la migración, o
    // una conexión de sólo lectura donde no se puede crear— se ejerce el MISMO SELECT leído
    // de la migración, montado como CTE. No es una copia del SQL: se lee del archivo, así que
    // si la migración cambia, el test sigue el cambio.
    // Un test que nunca corre no protege nada, y declarar NO MEDIDO y salir habría dejado
    // estas ocho aserciones sin ejercer una sola vez.
    const [{ existe }] = (await db.raw(
      `SELECT to_regclass('analytics.v_erp_physical_count_variance') IS NOT NULL AS existe`)).rows;

    let FROM_V = 'analytics.v_erp_physical_count_variance';
    let PRE = '';
    if (!existe) {
      const fs = require('fs');
      const mig = fs.readFileSync(path.resolve(__dirname, '..', 'migrations-newdb',
        '20260928260000_erp_physical_count_variance_view.js'), 'utf8');
      const m = mig.split('WITH (security_invoker = true) AS')[1];
      if (!m) throw new Error('no se pudo extraer el SELECT de la migración');
      const sel = m.split('`);')[0].trim();
      PRE = `WITH _v AS (${sel}) `;
      FROM_V = '_v';
      console.log('  ⓘ la vista NO está aplicada acá → se ejerce el SELECT de la migración');
      console.log('    (prueba la LÓGICA; la existencia del objeto queda NO MEDIDA)\n');
    } else {
      console.log('  ⓘ la vista está aplicada → se ejerce el objeto real\n');
    }
    // `q()` apunta cada consulta al origen elegido: el objeto si existe, el CTE si no.
    // Si la consulta ya trae su propio WITH, los CTE se FUSIONAN — anteponer un segundo WITH
    // es un error de sintaxis, y ése es justo el bloque que cuadra la vista contra el ODS.
    const q = (sql) => {
      const s2 = sql.replace(/analytics\.v_erp_physical_count_variance/g, FROM_V);
      if (!PRE) return db.raw(s2);
      const t2 = s2.trimStart();
      return db.raw(/^WITH\s/i.test(t2)
        ? PRE.trimEnd() + ', ' + t2.replace(/^WITH\s+/i, '')
        : PRE + s2);
    };

    // ── 1. La vista responde y es rápida ──────────────────────────────────────
    const t0 = Date.now();
    const [tot] = (await q(
      `SELECT count(*)::int AS filas,
              count(DISTINCT warehouse_code)::int AS almacenes,
              count(DISTINCT fecha)::int AS fechas
         FROM analytics.v_erp_physical_count_variance`)).rows;
    const ms = Date.now() - t0;
    t(`responde en menos de 1 s (${ms} ms, ${tot.filas} filas)`, ms < 1000, `${ms} ms`);
    t('tiene datos de más de un almacén', Number(tot.almacenes) > 1, JSON.stringify(tot));

    // ── 2. ⛔ Una CARGA INICIAL no es un descuadre ─────────────────────────────
    // La firma: la entrada replica la captura y no hay faltante. Si esto se rompe, $30.8M de
    // migraciones de ERP se cuelan como si fueran descuadre de inventario.
    const [ci] = (await q(
      `SELECT count(*) FILTER (WHERE tipo_evento = 'carga_inicial')::int AS carga,
              count(*) FILTER (WHERE tipo_evento = 'conteo')::int AS conteo,
              count(*) FILTER (WHERE tipo_evento = 'carga_inicial' AND signo = 'faltante')::int AS carga_con_faltante
         FROM analytics.v_erp_physical_count_variance`)).rows;
    t('clasifica los dos tipos de evento (conteo y carga_inicial)',
      Number(ci.carga) > 0 && Number(ci.conteo) > 0, JSON.stringify(ci));
    t('⛔ una carga inicial NUNCA trae faltante (si lo trae, la firma está mal)',
      Number(ci.carga_con_faltante) === 0, `${ci.carga_con_faltante} filas de carga con faltante`);

    // ── 3. ⛔ EL JOIN NO DUPLICA ───────────────────────────────────────────────
    // La trampa que ya cobró: el folio no es único entre almacenes de la misma sucursal, y sin
    // c2/c3 se cuelan doctypes ajenos. Ambos defectos INFLAN el conteo de líneas sin cambiar
    // la forma del resultado — por eso hace falta una aserción y no basta con mirar.
    const [dup] = (await q(
      `SELECT count(*)::int AS repetidos FROM (
         SELECT warehouse_id, fecha, kepler_almacen, folio, sku, signo, count(*) AS n
           FROM analytics.v_erp_physical_count_variance
          GROUP BY 1,2,3,4,5,6 HAVING count(*) > 1) x`)).rows;
    t('⛔ ningún (almacén, fecha, folio, SKU, signo) aparece dos veces — el join no duplica',
      Number(dup.repetidos) === 0, `${dup.repetidos} combinaciones repetidas`);

    // ── 4. Cuadra contra el ODS crudo ─────────────────────────────────────────
    // Si la vista y una consulta directa al ODS no dan lo mismo, la vista agregó o perdió algo.
    const [cruz] = (await q(
      `WITH v AS (
         SELECT round(sum(importe), 2) AS pesos
           FROM analytics.v_erp_physical_count_variance
          WHERE signo = 'sobrante' AND tipo_evento = 'conteo' AND fecha >= '2026-09-01'
       ), crudo AS (
         SELECT round(sum(l.c13::numeric), 2) AS pesos
           FROM kepler_ods.kdm1 m
           JOIN kepler_ods.kdm2 l
             ON l.sucursal=m.sucursal AND l.c1=m.c1 AND l.c2=m.c2 AND l.c3=m.c3
            AND l.c4=m.c4 AND l.c5=m.c5 AND l.c6=m.c6
           JOIN commercial.warehouses w
             ON w.kepler_code = m.sucursal AND w.kepler_code <> '00' AND w.deleted_at IS NULL
          WHERE m.c2='N' AND m.c3='A' AND m.c4='30' AND m.c9 >= '2026-09-01'
            AND btrim(l.c8) <> ALL (ARRAY['00001','00002','00022'])
            -- sólo los almacenes cuyo conteo NO fue carga inicial
            AND NOT EXISTS (
              SELECT 1 FROM analytics.v_erp_physical_count_variance z
               WHERE z.kepler_sucursal = m.sucursal AND z.fecha = m.c9::date
                 AND z.tipo_evento = 'carga_inicial')
       )
       SELECT v.pesos AS vista, crudo.pesos AS crudo,
              abs(coalesce(v.pesos,0) - coalesce(crudo.pesos,0)) AS delta
         FROM v, crudo`)).rows;
    t('el sobrante de la vista cuadra con el ODS crudo (Δ < $1)',
      Number(cruz.delta) < 1, `vista ${cruz.vista} vs crudo ${cruz.crudo}, Δ ${cruz.delta}`);
    console.log(`     sep-2026 sobrante de conteos: $${Number(cruz.vista || 0).toLocaleString('en-US')}`);

    // ── 4b. ⛔ ANTI-RÉPLICA: ningún documento de un almacén AJENO a su sucursal ──
    // Medido: `kepler_ods.kdm1` con sucursal='03' trae 220 cabeceras del almacén '02'
    // (nov-2025 a ene-2026) — la misma réplica cruzada que `kdil` ya documenta. Sin filtro,
    // 220 documentos de La Piedad se publican como descuadre de 8ESQ.
    // ⚠️ Esta aserción existe porque el bloque 4 NO cubría el arreglo: su ventana es
    // sep-2026 y la réplica es de nov-ene, así que pasaba en verde sin ejercerlo.
    const [rep] = (await q(
      `SELECT count(*)::int AS n FROM analytics.v_erp_physical_count_variance
        WHERE kepler_almacen <> kepler_sucursal
          AND kepler_almacen NOT LIKE kepler_sucursal || '-%'`)).rows;
    t('⛔ ANTI-RÉPLICA: ningún renglón viene de un almacén ajeno a su sucursal',
      Number(rep.n) === 0, `${rep.n} renglones replicados`);

    // Y el contrapeso: los SUB-ALMACENES legítimos SÍ tienen que estar. Un filtro
    // `almacen = sucursal` a secas los habría borrado — la única carga de Padre Hidalgo
    // vive en el almacén '01-006' (la Ruta 28).
    const [sub] = (await q(
      `SELECT count(*)::int AS n FROM analytics.v_erp_physical_count_variance
        WHERE kepler_almacen LIKE kepler_sucursal || '-%'`)).rows;
    t('los SUB-ALMACENES legítimos (01-006 = Ruta 28) SÍ entran',
      Number(sub.n) > 0, `${sub.n} renglones de sub-almacén`);

    // ── 4c. ⛔ Un evento con MUCHOS folios se clasifica por el TOTAL ────────────
    // Medido: hay eventos con 64 folios del mismo doctype en la misma fecha. Agrupando por
    // folio y comparando con max() se contrasta el folio más grande de captura contra el más
    // grande de entrada, no el total del evento — y la firma de carga inicial deja de
    // significar lo que dice. Estos eventos multi-folio son conteos reales, no cargas.
    const [multi] = (await q(
      `SELECT count(*)::int AS mal FROM analytics.v_erp_physical_count_variance v
        WHERE v.tipo_evento = 'carga_inicial'
          AND EXISTS (SELECT 1 FROM kepler_ods.kdm1 m
                       WHERE m.sucursal = v.kepler_sucursal AND m.c1 = v.kepler_almacen
                         AND m.c9::date = v.fecha AND m.c2 = 'N' AND m.c4 = '45'
                       GROUP BY m.sucursal, m.c1, m.c9::date
                      HAVING count(DISTINCT m.c6) > 5)`)).rows;
    t('⛔ un evento con muchos folios NO se clasifica como carga inicial (se suma, no max())',
      Number(multi.mal) === 0, `${multi.mal} renglones mal clasificados`);

    // ── 4d. ⛔ EL ANTI-RÉPLICA, EN TODOS LOS CONSUMIDORES ─────────────────────
    // No alcanza con que la VISTA lo tenga: el servicio hace sus propias consultas sobre
    // `kdm1` (la cobertura y el KPI) y cada una necesita el mismo filtro. Medido: faltaba
    // en `coverage()` cuando ya estaba en la vista y en `kpi()` — y un filtro aplicado en
    // dos de tres lugares es PEOR que no aplicarlo, porque las cifras se contradicen entre
    // sí sin que nada falle. Este candado lee el fuente, que es donde se puede olvidar.
    const fs2 = require('fs');
    const svc = fs2.readFileSync(path.resolve(__dirname, '..', '..', 'libs', 'commercial',
      'src', 'lib', 'commercial-inventory', 'inventory-variance.service.ts'), 'utf8');
    const consultas = (svc.match(/FROM kepler_ods\.kdm1/g) || []).length;
    const filtros = (svc.match(/m\.c1 = m\.sucursal OR m\.c1 LIKE/g) || []).length;
    t('⛔ TODA consulta del servicio sobre kdm1 lleva el filtro anti-réplica',
      consultas > 0 && filtros >= consultas,
      `${consultas} consultas contra ${filtros} filtros — falta en alguna`);
    console.log(`     servicio: ${consultas} consultas sobre kdm1, ${filtros} con anti-réplica`);

    // ── 5. ⛔ La 00 es OFICINAS y NO entra ─────────────────────────────────────
    const [of] = (await q(
      `SELECT count(*)::int AS n FROM analytics.v_erp_physical_count_variance
        WHERE kepler_sucursal = '00'`)).rows;
    t('⛔ la sucursal 00 (OFICINAS, existencia artefacto) queda fuera',
      Number(of.n) === 0, `${of.n} filas de la 00`);

    // ── 6. Los pseudo-SKUs contables no entran ────────────────────────────────
    const [ps] = (await q(
      `SELECT count(*)::int AS n FROM analytics.v_erp_physical_count_variance
        WHERE sku = ANY (ARRAY['00001','00002','00022'])`)).rows;
    t('los pseudo-SKUs contables (VENTAS AL 0%, TIEMPO AIRE) quedan fuera',
      Number(ps.n) === 0, `${ps.n} filas`);

    // ── 7. PRUEBA NEGATIVA de la firma ────────────────────────────────────────
    // Que la clasificación DISCRIMINE: si todo cayera en un solo tipo, la columna sería
    // decorativa y el tablero mezclaría $30.8M de migraciones con el descuadre real.
    const [disc] = (await q(
      `SELECT count(DISTINCT tipo_evento)::int AS tipos,
              count(DISTINCT warehouse_code) FILTER (WHERE tipo_evento='carga_inicial')::int AS wh_carga
         FROM analytics.v_erp_physical_count_variance`)).rows;
    t('PRUEBA NEGATIVA: la firma DISCRIMINA (no todo cae en un solo tipo)',
      Number(disc.tipos) === 2, JSON.stringify(disc));
    console.log(`     almacenes con carga inicial detectada: ${disc.wh_carga}`);

    // ── 8. El signo es coherente con la naturaleza del documento ──────────────
    const [sg] = (await q(
      `SELECT count(*)::int AS n FROM analytics.v_erp_physical_count_variance
        WHERE signo NOT IN ('sobrante','faltante')`)).rows;
    t('el signo sólo toma los dos valores declarados', Number(sg.n) === 0, `${sg.n} filas raras`);
  } catch (e) {
    bad++; console.log(`  ✘ excepción: ${e.message}`);
  } finally {
    await db.destroy();
  }

  console.log(`\n=== ${ok} ✓ / ${bad} ✗ ===\n`);
  process.exit(bad === 0 ? 0 : 1);
})();
