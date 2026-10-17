#!/usr/bin/env node
/**
 * `[ARQ-RUTA.0]` Medición previa — SÓLO LECTURA. ¿Qué rutas del arqueo (RD/RV) salen de Kepler por
 * sucursal, y cuánto se parece eso a la asignación manual de hoy?
 *
 * Contexto: el arqueo de ruta ofrece las rutas que alguien asignó a mano a la sucursal
 * (`commercial.route_warehouses`). Se quiere que salgan solas de Kepler. Kepler NO declara el tipo
 * de ruta (`20261006130000_route_kind.js`: la letra V miente, `2V004` es telemarketing), así que el
 * tipo sigue saliendo del catálogo (`trade.catalogs.route_kind`) y lo que se deriva es la SUCURSAL:
 * en cuál vende cada ruta, por el código de vendedor de sus tickets (`kdm1.c12`).
 *
 * Responde:
 *   A. El catálogo: cuántas rutas camión/vecinal hay, cuántas tienen código Kepler, y a qué
 *      sucursal están asignadas hoy.
 *   B. Por cada ruta con código: en qué sucursales vende (30 y 90 días), con qué peso, y si su
 *      sucursal dominante coincide con la asignada.
 *   C. Códigos de ruta que venden en Kepler y NO están en el catálogo (lo que se perdería).
 *   D. El tiempo de la consulta que correría en la pantalla, para una sucursal (gate < 1 s).
 *
 * Uso:  PROD_RO_URL=postgresql://<rol_ro>@192.168.0.222:5434/railway node database/scripts/medir-rutas-arqueo-kepler.js
 * Lo que no se pueda medir se imprime como NO MEDIDO, nunca como cero.
 */
const { Client } = require('pg');

const URL = process.env.PROD_RO_URL;
if (!URL) {
  console.error('Falta PROD_RO_URL (credencial de SÓLO LECTURA a pg-prod, ops/prod/README.md §2.2).');
  process.exit(2);
}

async function medir(c, nombre, sql, params = []) {
  const t0 = Date.now();
  try {
    const r = await c.query(sql, params);
    console.log(`\n── ${nombre}  (${Date.now() - t0} ms, ${r.rows.length} filas)`);
    console.table(r.rows);
    return r.rows;
  } catch (e) {
    console.log(`\n── ${nombre}  NO MEDIDO: ${e.message}`);
    return null;
  }
}

// Las ventas de Kepler: genero U, naturaleza D, sin cancelados. c12 = codigo de vendedor/ruta.
const VENTAS = (dias) => `
  SELECT btrim(h.sucursal::text) AS sucursal, btrim(h.c12::text) AS codigo,
         count(*)::int AS tickets, round(sum(nullif(regexp_replace(h.c16::text,'[^0-9.-]','','g'),'')::numeric), 2) AS monto,
         max(h.c68::date) AS ultima
    FROM kepler_ods.kdm1 h
   WHERE h.c2 = 'U' AND h.c3 = 'D'
     AND btrim(coalesce(h.c43::text, '')) <> 'C'
     AND h.c68::date >= current_date - ${Number(dias)}
     AND btrim(coalesce(h.c12::text, '')) <> ''
   GROUP BY 1, 2`;

(async () => {
  const c = new Client({ connectionString: URL });
  await c.connect();
  await c.query('SET default_transaction_read_only = on');
  const who = await c.query('SELECT current_user, current_database(), now()::text AS ahora');
  console.log('Conectado como', who.rows[0]);

  await medir(c, 'A · catálogo de rutas: tipo, código Kepler y sucursal asignada hoy', `
    SELECT tc.value AS ruta, tc.erp_vendor_code AS codigo_kepler, tc.route_kind AS tipo,
           string_agg(DISTINCT w.code || coalesce(' (' || w.kepler_code || ')', ''), ', ') AS asignada_a
      FROM trade.catalogs tc
      LEFT JOIN commercial.route_warehouses rw ON rw.route_id = tc.id AND rw.tenant_id = tc.tenant_id
      LEFT JOIN commercial.warehouses w ON w.id = rw.warehouse_id AND w.deleted_at IS NULL
     WHERE tc.catalog_id = 'rutas' AND tc.activo AND tc.deleted_at IS NULL
     GROUP BY 1, 2, 3
     ORDER BY 3 NULLS LAST, 1`);

  await medir(c, 'A2 · sucursales con código Kepler', `
    SELECT code, kepler_code, name, sells_to_public FROM commercial.warehouses
     WHERE deleted_at IS NULL AND kepler_code IS NOT NULL ORDER BY kepler_code`);

  for (const dias of [30, 90]) {
    await medir(c, `B · rutas del catálogo con código: dónde venden (${dias} d) y si coincide con la asignada`, `
      WITH v AS (${VENTAS(dias)}),
      cat AS (
        SELECT tc.id, tc.value, upper(btrim(tc.erp_vendor_code)) AS codigo, tc.route_kind
          FROM trade.catalogs tc
         WHERE tc.catalog_id = 'rutas' AND tc.activo AND tc.deleted_at IS NULL
           AND tc.erp_vendor_code IS NOT NULL AND tc.route_kind IN ('camion', 'vecinal')
      ),
      x AS (
        SELECT cat.value, cat.codigo, cat.route_kind, v.sucursal, v.tickets, v.monto, v.ultima,
               round(100.0 * v.tickets / sum(v.tickets) OVER (PARTITION BY cat.codigo), 1) AS pct
          FROM cat JOIN v ON upper(v.codigo) = cat.codigo
      )
      SELECT x.*, (SELECT string_agg(DISTINCT w.kepler_code, ',')
                     FROM commercial.route_warehouses rw
                     JOIN commercial.warehouses w ON w.id = rw.warehouse_id
                     JOIN trade.catalogs tc ON tc.id = rw.route_id
                    WHERE upper(btrim(tc.erp_vendor_code)) = x.codigo) AS asignada_kepler
        FROM x ORDER BY x.codigo, x.tickets DESC`);
  }

  await medir(c, 'C · códigos con forma de ruta que venden (30 d) y NO están en el catálogo', `
    WITH v AS (${VENTAS(30)})
    SELECT v.sucursal, v.codigo, v.tickets, v.monto, v.ultima,
           (SELECT btrim(k.c3) FROM kepler_ods.kduv k WHERE btrim(k.c2) = v.codigo LIMIT 1) AS nombre_kduv
      FROM v
     WHERE v.codigo ~* '^([0-9][VDM][0-9]|RD)'
       AND NOT EXISTS (SELECT 1 FROM trade.catalogs tc
                        WHERE tc.catalog_id = 'rutas' AND tc.deleted_at IS NULL
                          AND upper(btrim(tc.erp_vendor_code)) = upper(v.codigo))
     ORDER BY v.tickets DESC`);

  await medir(c, 'C2 · documentos con c1 compuesto (ruta dentro de la sucursal, 30 d)', `
    SELECT btrim(h.sucursal::text) AS sucursal, btrim(h.c1::text) AS c1, btrim(h.c12::text) AS vendedor,
           count(*)::int AS docs
      FROM kepler_ods.kdm1 h
     WHERE h.c2 = 'U' AND h.c3 = 'D' AND btrim(h.c1::text) LIKE '%-%'
       AND h.c68::date >= current_date - 30
     GROUP BY 1, 2, 3 ORDER BY 1, 2`);

  // D. La consulta que correría al abrir el arqueo: rutas del catálogo que venden en UNA sucursal.
  for (const suc of ['01', '05']) {
    const t0 = Date.now();
    await medir(c, `D · tiempo de la consulta de pantalla, sucursal ${suc}`, `
      SELECT tc.value, tc.route_kind, count(*)::int AS tickets
        FROM trade.catalogs tc
        JOIN kepler_ods.kdm1 h
          ON upper(btrim(h.c12::text)) = upper(btrim(tc.erp_vendor_code))
         AND h.sucursal = $1 AND h.c2 = 'U' AND h.c3 = 'D'
         AND h.c68::date >= current_date - 30
       WHERE tc.catalog_id = 'rutas' AND tc.activo AND tc.deleted_at IS NULL
         AND tc.route_kind IN ('camion', 'vecinal')
       GROUP BY 1, 2`, [suc]);
    console.log(`   total con red: ${Date.now() - t0} ms`);
  }

  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
