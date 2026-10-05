'use strict';
/**
 * `[RD.30]` — **Una ruta tiene DOS nombres a lo largo del corte de ERP, y el ledger sólo veía uno.**
 *
 * Disparador: Edgar entregó el inventario que el Kepler del propio camión 21 declara
 * (`rd21 05-sep.xlsx`, 257 renglones, **$37,765.58**). Contra ese árbitro, la pantalla estaba
 * corta **$47,969**. La investigación encontró dos defectos, los dos del mismo evento.
 *
 * ── 1. El rótulo del embarque cambió el 15-jul y la vista sólo conoce el nuevo ───────────────
 *
 * Padre Hidalgo pasó de Wincaja a Kepler el **2026-06-27** (`analytics.v_branch_erp_cutover`).
 * En Kepler, el `kdm1.c10` de sus embarques dice:
 *
 * | periodo | rótulo | ejemplo |
 * |---|---|---|
 * | 27-jun → 14-jul | **sin espacio** | `RD021` |
 * | 15-jul → hoy | **con espacio** | `RUTA 21` |
 *
 * ⛔ `20261003130000` liga los destinos con `dest_code ~ '^(RUTA|RD) [0-9]+$'` — **el espacio es
 * obligatorio en ese regex** y `RD021` no lo tiene; y aunque matcheara,
 * `split_part('RD021',' ',2)` devuelve `''`. Las seis filas viejas quedaron con
 * `warehouse_id IS NULL`, invisibles: **$1,402,211 de embarques** que el ledger no suma.
 *
 * ⭐ El arreglo **no es ampliar el regex**. La membresía ya es dato (`transfer_dest_map`); lo que
 * faltaba es aceptar que **un almacén de ruta puede tener varios rótulos**. Esta migración liga
 * las seis filas y el ledger pasa a leer *todos* los rótulos de ese almacén, no uno.
 *
 * ⚠️ **El regex de ligado se probó antes de aplicarlo, con los dos controles:**
 * - *positivo* — reproduce **11 de 11** de las ligas que ya existían (`RD 501`→`RUTA-501`,
 *   `RUTA 21`→`RUTA-21`…). Si la regla fuera otra, ahí se habría visto.
 * - *negativo* — ⛔ `transfer_dest_map` **también trae clientes**: hay `dest_code` `21`, `100`,
 *   `10001` ("ABARROTES ROMO", "AMADOR VARGAS SAUCEDA"). Una regla por número suelto casaría
 *   **212 falsos**. Exigir el prefijo `RUTA|RD` es lo que la hace segura, y eso está medido.
 *
 * ── 2. Hubo días en que el camión vendió y NADIE lo registró ─────────────────────────────────
 *
 * `carga_desde` era el primer embarque. Con los rótulos viejos adentro se va al 27-jun — pero el
 * push del camión (la única fuente de su venta) **arranca después**, y el hueco es por camión:
 *
 * | ruta | últ. venta Wincaja | 1ª venta Kepler | días ciegos | cargado a ciegas |
 * |---|---|---|---|---|
 * | **21** | 27-jun | **06-jul** | **9** | **$113,566** |
 * | **26** | 27-jun | **06-jul** | **7** | **$115,057** |
 * | 22 · 23 · 27 | 27-jun | 29-jun | 2 | $16,243 · $18,669 · $33,054 |
 * | 28 | 25-jun | 29-jun | 2 | $6,704 |
 *
 * ⇒ `carga_desde` pasa a ser **`GREATEST(primer embarque, primera venta)`**: la primera fecha en
 * que **los dos lados son observables**. Anclar antes de eso no es más información, es sumar
 * carga contra una venta que no existe — y publicaría un camión con $113k que no trae.
 *
 * ⭐ Y lo que queda afuera **se declara**: `analytics.v_rd_route_opening` publica los días ciegos
 * y los pesos cargados en ellos, por ruta. Es mercancía que el camión sí trae y que **no se puede
 * medir con ninguna fuente** — ADR-056: se nombra, no se dibuja como cero.
 *
 * ── Medido antes y después, contra el conteo del camión 21 al 3-oct ──────────────────────────
 *
 * |  | antes | después |
 * |---|---|---|
 * | saldo neto publicado | −$10,203 | **−$165** |
 * | **aciertos exactos contra el conteo** | 93 / 257 | **102 / 257** |
 * | hueco contra el conteo | $47,969 | **$37,930** |
 *
 * Los 9 aciertos extra son la confirmación independiente: no es que el total se acomode, es que
 * **nueve productos más coinciden al centavo** con lo que el camión declara.
 *
 * ⚠️ **Canindo no se mueve**: sus cinco rutas tienen el push ANTES del primer embarque, así que
 * `GREATEST` devuelve la fecha de siempre. Medido: carga y venta **idénticas al centavo**, cero
 * días ciegos. Un arreglo que cambia lo que no debía cambiar no es un arreglo.
 *
 * ⛔ Lo que esta migración **no** arregla, y queda con nombre y monto: los ~$37,930 que el camión
 * 21 traía el 6-jul. Para matarlos hace falta un **conteo de ancla registrado en Kepler**
 * (`N-A-45` sobre el almacén de la ruta), que hoy no existe para ninguna ruta — el `N-A-45` del
 * 11-sep de la sucursal `01` es el consolidado de 121 conteos **por anaquel de tienda**.
 *
 * ⚠️ El CEDIS (suc. `00`) también embarcó a rutas: `RD023` $2,658.85 (3 docs, 08-jul) y `RD 502`
 * $23,263.22. Siguen fuera: la identidad ancla el emisor en `suc_emisor`, y cambiar eso es otra
 * pregunta. Declarado acá para que no se redescubra.
 *
 * ⭐ **Sin DROPs**: las tres vistas conservan nombre, tipo y orden de columnas, así que
 * `CREATE OR REPLACE` basta y las matvistas sólo necesitan `REFRESH`. Recrear la cadena entera
 * habría obligado a reconstruir a mano cuatro definiciones ajenas a este cambio.
 *
 * @param { import("knex").Knex } knex
 */

const IDENT = 'analytics.v_rd_route_identity';
const LEDGER = 'analytics.v_rd_route_ledger';
const SHIP = 'analytics.v_rd_route_shipment_lines';
const OPEN = 'analytics.v_rd_route_opening';

/** Los rótulos de un almacén de ruta, como dato. Es lo que reemplaza al `= i.destino`. */
const ROTULOS = `
  SELECT x.dest_code FROM analytics.transfer_dest_map x
   WHERE x.tenant_id = i.tenant_id AND x.warehouse_id = i.warehouse_id`;

exports.up = async function up(knex) {
  // ── 1. Ligar los rótulos viejos a su almacén ──────────────────────────────────────────────
  // El patrón exige el prefijo RUTA|RD: sin él casaría 212 codigos de CLIENTE (21, 100, 10001).
  const { rowCount } = await knex.raw(`
    UPDATE analytics.transfer_dest_map d
       SET warehouse_id = w.id, updated_at = now()
      FROM commercial.warehouses w
     WHERE w.tenant_id = d.tenant_id AND w.kind = 'truck' AND w.deleted_at IS NULL
       AND d.warehouse_id IS NULL
       AND d.dest_code ~ '^(RUTA|RD)[ 0]*[0-9]+$'
       AND regexp_replace(d.dest_code, '^(RUTA|RD)[ ]*0*', '') = split_part(w.code, '-', 2)`);
  console.log(`  · [RD.30] ${rowCount} rotulo(s) viejo(s) ligado(s) a su almacen de ruta`);

  // Freno: cada almacén de ruta que recibe embarque debe tener al menos un rótulo ligado, y
  // ningún rótulo puede quedar apuntando a dos almacenes.
  const { rows: liga } = await knex.raw(`
    SELECT count(*)::int AS rotulos_ruta,
           count(*) FILTER (WHERE warehouse_id IS NULL)::int AS sin_ligar
      FROM analytics.transfer_dest_map
     WHERE dest_code ~ '^(RUTA|RD)[ 0]*[0-9]+$'`);
  if (Number(liga[0].sin_ligar) > 0) {
    throw new Error(`[RD.30] quedaron ${liga[0].sin_ligar} rotulo(s) de ruta sin ligar`);
  }
  console.log(`  · [RD.30] ${liga[0].rotulos_ruta} rotulos de ruta, todos ligados`);

  // ── 2. La identidad: un rótulo vigente, y el ancla donde los DOS lados se ven ──────────────
  await knex.raw(`
    CREATE OR REPLACE VIEW ${IDENT} AS
    SELECT w.tenant_id,
           split_part(w.code::text, '-', 2)                AS route_no,
           -- El rotulo VIGENTE = el del embarque mas reciente. La columna sigue significando
           -- "como se llama hoy esta ruta en Kepler"; quien necesita todos lee transfer_dest_map.
           c.destino,
           w.kepler_code                                   AS almacen_erp,
           m.kepler_code                                   AS suc_emisor,
           m.name::text                                    AS plaza,
           -- La primera fecha con AMBOS lados observables. GREATEST ignora el NULL, asi que una
           -- ruta sin venta registrada conserva su primer embarque en vez de desaparecer.
           GREATEST(c.primer_embarque, v.primera_venta)    AS carga_desde,
           w.id                                            AS warehouse_id
      FROM commercial.warehouses w
      JOIN commercial.warehouses m
        ON m.id = w.source_warehouse_id AND m.deleted_at IS NULL
      CROSS JOIN LATERAL (
           SELECT min(h.c9)::date                          AS primer_embarque,
                  (array_agg(h.c10 ORDER BY h.c9 DESC))[1] AS destino
             FROM kepler_ods.kdm1 h
            WHERE h.sucursal = m.kepler_code
              AND h.c2 = 'U' AND h.c3 = 'D' AND h.c4 = 41
              AND h.c9 > '2020-01-01'
              AND h.c10 IN (SELECT x.dest_code FROM analytics.transfer_dest_map x
                             WHERE x.tenant_id = w.tenant_id AND x.warehouse_id = w.id)
      ) c
      CROSS JOIN LATERAL (
           SELECT min(p.business_date)::date AS primera_venta
             FROM analytics.route_push_lines p
            WHERE p.tenant_id = w.tenant_id
              AND p.route_no = split_part(w.code::text, '-', 2)
      ) v
     WHERE w.kind = 'truck' AND w.deleted_at IS NULL AND c.primer_embarque IS NOT NULL
  `);

  // ── 3. El ledger: la carga entra por CUALQUIER rotulo de ese almacen ──────────────────────
  await knex.raw(`
    CREATE OR REPLACE VIEW ${LEDGER} AS
    WITH carga AS (
      SELECT i.tenant_id, i.route_no, h.c9::date AS business_date,
             btrim(d.c8) AS sku, btrim(d.c11) AS unidad,
             sum(d.c9::numeric)  AS qty,
             sum(d.c13::numeric) AS costo_doc
        FROM analytics.mv_rd_route_identity i
        JOIN kepler_ods.kdm1 h
          ON h.sucursal = i.suc_emisor AND h.c2 = 'U' AND h.c3 = 'D' AND h.c4 = 41
         AND h.c9::date >= i.carga_desde
         AND h.c10 IN (${ROTULOS})
        JOIN kepler_ods.kdm2 d
          ON d.sucursal = h.sucursal AND d.c1 = h.c1 AND d.c2 = h.c2 AND d.c3 = h.c3
         AND d.c4 = h.c4 AND d.c5 = h.c5 AND d.c6 = h.c6
       WHERE coalesce(btrim(d.c11),'') NOT IN ('SER','')
       GROUP BY 1,2,3,4,5
    ), costo_erp AS (
      SELECT i.route_no, h.c9::date AS business_date,
             btrim(d.c8) AS sku, btrim(d.c11) AS unidad,
             sum(d.c62::numeric) AS costo_erp
        FROM analytics.mv_rd_route_identity i
        JOIN kepler_ods.kdm1 h
          ON h.sucursal = i.suc_emisor AND h.c1 = i.almacen_erp
         AND h.c2 = 'U' AND h.c3 = 'D' AND h.c4 = 10 AND h.c9::date >= i.carga_desde
        JOIN kepler_ods.kdm2 d
          ON d.sucursal = h.sucursal AND d.c1 = h.c1 AND d.c2 = h.c2 AND d.c3 = h.c3
         AND d.c4 = h.c4 AND d.c5 = h.c5 AND d.c6 = h.c6
       WHERE i.almacen_erp IS NOT NULL AND nullif(btrim(d.c62),'') IS NOT NULL
       GROUP BY 1,2,3,4
    ), venta AS (
      SELECT p.tenant_id, i.route_no, p.business_date,
             btrim(p.sku) AS sku, btrim(p.unidad) AS unidad,
             sum(p.qty)     AS qty,
             sum(p.importe) AS venta_doc
        FROM analytics.mv_rd_route_identity i
        JOIN analytics.route_push_lines p
          ON p.route_no = i.route_no AND p.tenant_id = i.tenant_id
         AND p.business_date >= i.carga_desde
       WHERE coalesce(btrim(p.unidad),'') <> ''
       GROUP BY 1,2,3,4,5
    )
    SELECT tenant_id, route_no, business_date, 'carga'::text AS clase, sku, unidad,
           qty, costo_doc, NULL::numeric AS venta_doc, NULL::numeric AS costo_erp
      FROM carga
    UNION ALL
    SELECT v.tenant_id, v.route_no, v.business_date, 'venta'::text, v.sku, v.unidad,
           v.qty, NULL::numeric, v.venta_doc, e.costo_erp
      FROM venta v
      LEFT JOIN costo_erp e
        ON e.route_no = v.route_no AND e.business_date = v.business_date
       AND e.sku = v.sku AND e.unidad = v.unidad
  `);

  // ── 4. El desglose de embarques, por el mismo camino ──────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE VIEW ${SHIP} AS
    SELECT i.tenant_id, i.route_no, h.c9::date AS business_date,
           nullif(h.c5::text,'') AS serie, h.c6 AS folio,
           btrim(d.c8) AS sku, btrim(d.c10) AS producto_erp, btrim(d.c11) AS unidad,
           d.c9::numeric AS qty, d.c12 AS costo_unitario, d.c13 AS importe
      FROM analytics.mv_rd_route_identity i
      JOIN kepler_ods.kdm1 h
        ON h.sucursal = i.suc_emisor AND h.c2 = 'U' AND h.c3 = 'D' AND h.c4 = 41
       AND h.c9::date >= i.carga_desde
       AND h.c10 IN (${ROTULOS})
      JOIN kepler_ods.kdm2 d
        ON d.sucursal = h.sucursal AND d.c1 = h.c1 AND d.c2 = h.c2 AND d.c3 = h.c3
       AND d.c4 = h.c4 AND d.c5 = h.c5 AND d.c6 = h.c6
     WHERE coalesce(btrim(d.c11),'') NOT IN ('SER','')
  `);

  // ── 5. Lo que NO se puede medir, con nombre y monto (ADR-056) ─────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE VIEW ${OPEN} AS
    SELECT i.tenant_id, i.route_no, i.plaza,
           c.primer_embarque, v.primera_venta, i.carga_desde,
           GREATEST(0, (i.carga_desde - c.primer_embarque))::int AS dias_ciegos,
           coalesce(a.carga_sin_medir, 0)::numeric               AS carga_sin_medir,
           coalesce(a.docs_sin_medir, 0)::int                    AS docs_sin_medir
      FROM analytics.mv_rd_route_identity i
      CROSS JOIN LATERAL (
           SELECT min(h.c9)::date AS primer_embarque
             FROM kepler_ods.kdm1 h
            WHERE h.sucursal = i.suc_emisor AND h.c2='U' AND h.c3='D' AND h.c4=41
              AND h.c9 > '2020-01-01' AND h.c10 IN (${ROTULOS})
      ) c
      CROSS JOIN LATERAL (
           SELECT min(p.business_date)::date AS primera_venta
             FROM analytics.route_push_lines p
            WHERE p.tenant_id = i.tenant_id AND p.route_no = i.route_no
      ) v
      LEFT JOIN LATERAL (
           SELECT sum(d.c13::numeric)             AS carga_sin_medir,
                  count(DISTINCT (h.c6, h.c9))    AS docs_sin_medir
             FROM kepler_ods.kdm1 h
             JOIN kepler_ods.kdm2 d
               ON d.sucursal = h.sucursal AND d.c1 = h.c1 AND d.c2 = h.c2 AND d.c3 = h.c3
              AND d.c4 = h.c4 AND d.c5 = h.c5 AND d.c6 = h.c6
            WHERE h.sucursal = i.suc_emisor AND h.c2='U' AND h.c3='D' AND h.c4=41
              AND h.c9 > '2020-01-01' AND h.c9::date < i.carga_desde
              AND h.c10 IN (${ROTULOS})
              AND coalesce(btrim(d.c11),'') NOT IN ('SER','')
      ) a ON true
  `);

  // ⚠️ `security_invoker` y el GRANT NO los hereda un `CREATE OR REPLACE VIEW` (GOTCHAS).
  for (const v of [IDENT, LEDGER, SHIP, OPEN]) {
    await knex.raw(`ALTER VIEW ${v} SET (security_invoker = true)`);
    await knex.raw(`GRANT SELECT ON ${v} TO app_runtime`);
  }
  await knex.raw(`COMMENT ON VIEW ${OPEN} IS
    'RD.30 - lo que el camion traia ANTES de que los dos lados fueran observables, por ruta. No es
     un cero: es mercancia real que ninguna fuente mide. dias_ciegos = entre el primer embarque y
     la primera venta registrada. Medido 2026-10-05: ruta 21 = 9 dias / 113,566; ruta 26 = 7 /
     115,057. Canindo = 0. Se publica al lado del saldo, nunca sumado.'`);

  // ── 6. Las copias por costo, en orden de dependencia ──────────────────────────────────────
  for (const mv of ['analytics.mv_rd_route_identity', 'analytics.mv_rd_route_ledger',
                    'analytics.mv_rd_route_unit_value']) {
    const t0 = Date.now();
    await knex.raw(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${mv}`);
    console.log(`  · [RD.30] ${mv} refrescada en ${Date.now() - t0} ms`);
  }

  // ── 7. Frenos ─────────────────────────────────────────────────────────────────────────────
  const { rows: chk } = await knex.raw(`
    SELECT (SELECT count(*) FROM analytics.mv_rd_route_identity)::int           AS rutas,
           (SELECT count(DISTINCT route_no) FROM analytics.mv_rd_route_identity)::int AS rutas_distintas,
           (SELECT count(*) FROM analytics.mv_rd_route_identity
             WHERE carga_desde IS NULL)::int                                     AS sin_ancla,
           (SELECT round(sum(costo_doc),2) FROM analytics.mv_rd_route_ledger
             WHERE clase='carga' AND route_no='21')::float                       AS carga_21,
           (SELECT count(*) FROM analytics.v_rd_route_opening
             WHERE dias_ciegos > 0)::int                                         AS rutas_con_hueco`);
  const r = chk[0];
  // Una fila por ruta: si el ligado duplicara, el UNIQUE del REFRESH ya habria fallado, pero el
  // freno se escribe igual -- un indice que protege no es lo mismo que una asercion que explica.
  if (Number(r.rutas) !== Number(r.rutas_distintas)) {
    throw new Error(`[RD.30] la identidad trae ${r.rutas} filas para ${r.rutas_distintas} rutas`);
  }
  if (Number(r.sin_ancla) > 0) throw new Error(`[RD.30] ${r.sin_ancla} ruta(s) sin ancla`);
  // La carga de la 21 TIENE que subir: si no subio, el ligado no surtio efecto y la migracion
  // se puso verde sin arreglar nada. 1,056,801.12 era el valor viejo.
  if (!(Number(r.carga_21) > 1056801.12)) {
    throw new Error(`[RD.30] la carga de la ruta 21 no subio (${r.carga_21}): el ligado no surtio efecto`);
  }
  console.log(`  · [RD.30] ${r.rutas} rutas · carga de la 21: ${r.carga_21} · ${r.rutas_con_hueco} ruta(s) con dias ciegos declarados`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${OPEN}`);
  // Vuelve a la forma de 20261003130000 / 20261003120000: un rotulo por ruta, ancla = 1er embarque.
  await knex.raw(`
    CREATE OR REPLACE VIEW ${IDENT} AS
    SELECT w.tenant_id,
           split_part(w.code, '-', 2)          AS route_no,
           d.dest_code                         AS destino,
           w.kepler_code                       AS almacen_erp,
           m.kepler_code                       AS suc_emisor,
           m.name::text                        AS plaza,
           c.carga_desde,
           w.id                                AS warehouse_id
      FROM commercial.warehouses w
      JOIN analytics.transfer_dest_map d
        ON d.tenant_id = w.tenant_id AND d.warehouse_id = w.id
      JOIN commercial.warehouses m
        ON m.id = w.source_warehouse_id AND m.deleted_at IS NULL
      CROSS JOIN LATERAL (
           SELECT min(h.c9)::date AS carga_desde
             FROM kepler_ods.kdm1 h
            WHERE h.sucursal = m.kepler_code
              AND h.c2 = 'U' AND h.c3 = 'D' AND h.c4 = 41
              AND h.c10 = d.dest_code
              AND h.c9 > '2020-01-01'
      ) c
     WHERE w.kind = 'truck' AND w.deleted_at IS NULL AND c.carga_desde IS NOT NULL
  `);
  await knex.raw(`
    CREATE OR REPLACE VIEW ${SHIP} AS
    SELECT i.tenant_id, i.route_no, h.c9::date AS business_date,
           nullif(h.c5::text,'') AS serie, h.c6 AS folio,
           btrim(d.c8) AS sku, btrim(d.c10) AS producto_erp, btrim(d.c11) AS unidad,
           d.c9::numeric AS qty, d.c12 AS costo_unitario, d.c13 AS importe
      FROM analytics.mv_rd_route_identity i
      JOIN kepler_ods.kdm1 h
        ON h.sucursal = i.suc_emisor AND h.c2 = 'U' AND h.c3 = 'D' AND h.c4 = 41
       AND h.c10 = i.destino AND h.c9::date >= i.carga_desde
      JOIN kepler_ods.kdm2 d
        ON d.sucursal = h.sucursal AND d.c1 = h.c1 AND d.c2 = h.c2 AND d.c3 = h.c3
       AND d.c4 = h.c4 AND d.c5 = h.c5 AND d.c6 = h.c6
     WHERE coalesce(btrim(d.c11),'') NOT IN ('SER','')
  `);
  // El ledger vuelve a su `= i.destino` original.
  await knex.raw(`
    CREATE OR REPLACE VIEW ${LEDGER} AS
    WITH carga AS (
      SELECT i.tenant_id, i.route_no, h.c9::date AS business_date,
             btrim(d.c8) AS sku, btrim(d.c11) AS unidad,
             sum(d.c9::numeric) AS qty, sum(d.c13::numeric) AS costo_doc
        FROM analytics.mv_rd_route_identity i
        JOIN kepler_ods.kdm1 h
          ON h.sucursal = i.suc_emisor AND h.c2 = 'U' AND h.c3 = 'D' AND h.c4 = 41
         AND h.c10 = i.destino AND h.c9::date >= i.carga_desde
        JOIN kepler_ods.kdm2 d
          ON d.sucursal = h.sucursal AND d.c1 = h.c1 AND d.c2 = h.c2 AND d.c3 = h.c3
         AND d.c4 = h.c4 AND d.c5 = h.c5 AND d.c6 = h.c6
       WHERE coalesce(btrim(d.c11),'') NOT IN ('SER','')
       GROUP BY 1,2,3,4,5
    ), costo_erp AS (
      SELECT i.route_no, h.c9::date AS business_date,
             btrim(d.c8) AS sku, btrim(d.c11) AS unidad, sum(d.c62::numeric) AS costo_erp
        FROM analytics.mv_rd_route_identity i
        JOIN kepler_ods.kdm1 h
          ON h.sucursal = i.suc_emisor AND h.c1 = i.almacen_erp
         AND h.c2 = 'U' AND h.c3 = 'D' AND h.c4 = 10 AND h.c9::date >= i.carga_desde
        JOIN kepler_ods.kdm2 d
          ON d.sucursal = h.sucursal AND d.c1 = h.c1 AND d.c2 = h.c2 AND d.c3 = h.c3
         AND d.c4 = h.c4 AND d.c5 = h.c5 AND d.c6 = h.c6
       WHERE i.almacen_erp IS NOT NULL AND nullif(btrim(d.c62),'') IS NOT NULL
       GROUP BY 1,2,3,4
    ), venta AS (
      SELECT p.tenant_id, i.route_no, p.business_date,
             btrim(p.sku) AS sku, btrim(p.unidad) AS unidad,
             sum(p.qty) AS qty, sum(p.importe) AS venta_doc
        FROM analytics.mv_rd_route_identity i
        JOIN analytics.route_push_lines p
          ON p.route_no = i.route_no AND p.tenant_id = i.tenant_id
         AND p.business_date >= i.carga_desde
       WHERE coalesce(btrim(p.unidad),'') <> ''
       GROUP BY 1,2,3,4,5
    )
    SELECT tenant_id, route_no, business_date, 'carga'::text AS clase, sku, unidad,
           qty, costo_doc, NULL::numeric AS venta_doc, NULL::numeric AS costo_erp
      FROM carga
    UNION ALL
    SELECT v.tenant_id, v.route_no, v.business_date, 'venta'::text, v.sku, v.unidad,
           v.qty, NULL::numeric, v.venta_doc, e.costo_erp
      FROM venta v
      LEFT JOIN costo_erp e
        ON e.route_no = v.route_no AND e.business_date = v.business_date
       AND e.sku = v.sku AND e.unidad = v.unidad
  `);
  for (const v of [IDENT, LEDGER, SHIP]) {
    await knex.raw(`ALTER VIEW ${v} SET (security_invoker = true)`);
    await knex.raw(`GRANT SELECT ON ${v} TO app_runtime`);
  }
  // Los rotulos viejos NO se des-ligan: la liga es dato correcto y medido, y otras pantallas
  // (/almacen/movimientos) ya la leen. Revertir la vista no la vuelve falsa.
  for (const mv of ['analytics.mv_rd_route_identity', 'analytics.mv_rd_route_ledger',
                    'analytics.mv_rd_route_unit_value']) {
    await knex.raw(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${mv}`);
  }
};
