'use strict';
/**
 * `[RD.9]` + `[RD.10]` — **El inventario de los camiones de Ruta Directa.**
 *
 * ── Por qué esto tiene que existir ──────────────────────────────────────────────────────────
 * ⛔ **Kepler no publica ningún saldo de ruta.** Medido contra prod el 2026-10-02:
 * `kepler_ods.kdil` (existencia por almacén) y `kepler_ods.kdij` (kardex) tienen **cero filas**
 * de cualquier almacén de ruta — todas sus filas cumplen `c1 = sucursal`. Lo único que existe de
 * una ruta son **documentos** (`kdm1`/`kdm2` con `c1` = `01-001`…`01-006`).
 *
 * ⇒ La existencia de una ruta **no se LEE, se RECONSTRUYE**. Por eso esto es una vista de
 * movimiento y no una consulta a una tabla de saldo: no hay tal tabla.
 *
 * ⛔ Y `analytics.stock_movements` —la fuente de `/almacen/movimientos`— **no puede servir**:
 * su importer des-duplica las réplicas cruzadas del ODS con `WHERE btrim(h.c1)=btrim(h.sucursal)`,
 * y `c1` **es el almacén**, así que el mismo filtro tira todo almacén que no sea el principal.
 * Medido: 0 filas de ruta en 90 días. (Sí conserva la CARGA, del lado del emisor, con
 * `dest_code='RUTA 23'` — y por eso sirve como **árbitro independiente** del candado.)
 *
 * ── Los dos documentos, decodificados y medidos ─────────────────────────────────────────────
 *   ENTRADA  `U-D-41-2` *Embarque* emitido por el almacén MADRE, con `c10` = `RUTA 21`…`RUTA 28`
 *            (sucursal `01`) o `RD 501`…`RD 505` (sucursal `06`).
 *   SALIDA   `U-D-10` *Ticket Contado* en el almacén de la ruta.
 *   ⛔ **No existe documento de RETORNO**: ningún `U-A-50` del almacén `01` viene de una ruta
 *      (sólo de `TI000` CEDIS y de otras sucursales). Es consistente con un camión de inventario
 *      rodante, pero significa que lo que baje del camión sin papel queda sumando en el saldo.
 *
 * ── De dónde sale cada cifra, y por qué no de la otra fuente ────────────────────────────────
 * **La VENTA sale del carril push** (`analytics.route_push_lines`), no de la copia que la
 * sucursal tiene del mismo ticket. Medido en la ventana completa, la copia del ODS cubre sólo
 * **41.8%–49.8%** de la venta del push por ruta (le faltan días, no dinero: la venta por día
 * coincide). Usar el ODS inflaría el inventario con venta que no vio.
 *
 * **El COSTO sale del propio embarque** (`c13`/`c9` de la línea). Cubre, por construcción, el
 * 100% de lo que entró al camión.
 *
 * ── ⚠️ Hay DOS costos para la misma mercancía, y aquí se eligió uno ──────────────────────────
 * El costo del embarque **no** es el mismo que el `c62`/`c63` que el ERP escribe en la línea de
 * venta. Medido sobre el MISMO universo (ruta 23, misma venta, mismos días):
 *
 *     COGS con el costo del embarque .... $504,835
 *     COGS con el `c62` del ERP ......... $429,848     razón 1.1744
 *
 * Y la forma de la diferencia **no es un impuesto** (se probó: las razones no caen en 1.08 / 1.16
 * / 1.2528): **316 pares coinciden exacto** y 326 tienen el embarque por arriba, con razones que
 * van de 1.01 a 1.32. Es la misma familia que la Fase CE documentó — la ficha contra el costo del
 * documento.
 *
 * ⭐ **Se eligió el costo del embarque porque es el único con el que el cuadre CIERRA**, y porque
 * es la cuenta real del camión contra su sucursal: el camión responde por lo que se le cargó.
 * El `c62` viaja igual en la columna `costo_erp` como **línea de contraste**, nunca mezclado.
 *
 * ⚠️ **Una medición anterior de esta misma fase dijo "90% coinciden al costo" y estaba mal
 * ponderada**: contaba pares con `avg()` sin peso y sobre un solo mes. Pesado por dinero son
 * **46%**. *Contar filas ordena al revés que contar pesos.*
 *
 * ── Grano y unidad ──────────────────────────────────────────────────────────────────────────
 * El grano es `(ruta, fecha, clase, sku, unidad)`. **La unidad es parte de la llave**: el mismo
 * SKU se carga y se vende en `PZA` y en `PAQ` el mismo día, y restar sin fijar el peldaño mezcla
 * piezas con paquetes (ADR-055). Se verificó que los dos lados usan el mismo vocabulario
 * (`PAQ`/`PZA`/`KG`/`CJA`/`CUB`/`250`/`400`/`500`); las líneas sin unidad se excluyen y el
 * consumidor las declara.
 *
 * ── Ventana ─────────────────────────────────────────────────────────────────────────────────
 * `carga_desde` se DERIVA (primera carga documentada de cada ruta: 15-jul-2026 en PH,
 * 14/15-ago-2026 en Canindo). ⚠️ Arranca en la primera CARGA, **no** en la primera venta: el push
 * de PH empieza el 29-jun y arrancar ahí mete dos semanas de salidas sin su entrada.
 *
 * ── Por qué VISTA y no matvista ─────────────────────────────────────────────────────────────
 * El ledger completo (toda la historia, 107,747 filas) corre en **664 ms** contra prod, dentro
 * del gate de 1 s. Derivar en vez de materializar es la regla #1 del proyecto, y acá no hay un
 * costo que justifique la excepción.
 *
 * ── El CEDIS no carga rutas ─────────────────────────────────────────────────────────────────
 * `suc_emisor` es la sucursal madre y nada más. Confirmado por Edgar y medido: filtrando el
 * doctype correcto, el CEDIS emitió **un solo embarque a una ruta en toda la historia**
 * (`RD 502`, $23,263, 11-ago-2026 — tres días ANTES del cutover de Canindo a Kepler). Lo que
 * parecía carga del CEDIS eran traspasos de cuando Canindo no tenía Kepler.
 * ⚠️ La medición que decía "112 docs / $1.68M desde el CEDIS" **no filtraba el doctype** y sumaba
 * el pedido `U-D-40` junto con el embarque. *Una consulta sobre `c10` sin `c4` no mide el hecho,
 * mide la familia.*
 *
 * ⛔ **Morelia `321`/`322` y las vecinales `1V00N` quedan FUERA**: no tienen embarque en Kepler.
 * No se les inventa una entrada; simplemente no aparecen.
 *
 * @param { import("knex").Knex } knex
 */

const IDENT = 'analytics.v_rd_route_identity';
const LEDGER = 'analytics.v_rd_route_ledger';

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW ${IDENT} AS
    SELECT t.id AS tenant_id,
           m.route_no, m.destino, m.almacen_erp, m.suc_emisor, m.plaza,
           c.carga_desde
      FROM (VALUES
              ('21','RUTA 21','01-001','01','Padre Hidalgo'),
              ('22','RUTA 22','01-002','01','Padre Hidalgo'),
              ('23','RUTA 23','01-003','01','Padre Hidalgo'),
              ('26','RUTA 26','01-004','01','Padre Hidalgo'),
              ('27','RUTA 27','01-005','01','Padre Hidalgo'),
              ('28','RUTA 28','01-006','01','Padre Hidalgo'),
              ('501','RD 501',NULL,'06','Canindo'),
              ('502','RD 502',NULL,'06','Canindo'),
              ('503','RD 503',NULL,'06','Canindo'),
              ('504','RD 504',NULL,'06','Canindo'),
              ('505','RD 505',NULL,'06','Canindo')
           ) AS m(route_no, destino, almacen_erp, suc_emisor, plaza)
      CROSS JOIN LATERAL (
           SELECT min(h.c9)::date AS carga_desde
             FROM kepler_ods.kdm1 h
            WHERE h.sucursal = m.suc_emisor
              AND h.c2 = 'U' AND h.c3 = 'D' AND h.c4 = 41
              AND h.c10 = m.destino
              AND h.c9 > '2020-01-01'
      ) c
      CROSS JOIN (SELECT id FROM identity.tenants WHERE slug = 'mega_dulces') t
  `);

  await knex.raw(`
    CREATE OR REPLACE VIEW ${LEDGER} AS
    WITH carga AS (
      SELECT i.tenant_id, i.route_no, h.c9::date AS business_date,
             btrim(d.c8) AS sku, btrim(d.c11) AS unidad,
             sum(d.c9::numeric)  AS qty,
             sum(d.c13::numeric) AS costo_doc
        FROM ${IDENT} i
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
             btrim(d.c8) AS sku, btrim(d.c11) AS unidad,
             sum(d.c62::numeric) AS costo_erp
        FROM ${IDENT} i
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
        FROM ${IDENT} i
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

  // ⚠️ `security_invoker` y el GRANT van EXPLÍCITOS: un `CREATE OR REPLACE VIEW` no los hereda
  // (ADR-057 lo perdió una vez y sólo lo vio la aserción de metadata del candado).
  for (const v of [IDENT, LEDGER]) {
    await knex.raw(`ALTER VIEW ${v} SET (security_invoker = true)`);
    await knex.raw(`GRANT SELECT ON ${v} TO app_runtime`);
  }

  await knex.raw(`COMMENT ON VIEW ${IDENT} IS
    'RD.9 — resolvedor de las 11 rutas RD con camion: route_no / destino (c10 del embarque) / almacen ERP / sucursal emisora / primera carga. Morelia 321-322 y las vecinales 1V00N NO estan: no tienen embarque en Kepler.'`);
  await knex.raw(`COMMENT ON VIEW ${LEDGER} IS
    'RD.10 — movimiento de los camiones RD al grano (ruta, fecha, clase, sku, unidad). carga = U-D-41 del almacen madre valuado a su costo de documento; venta = carril push (la copia del ODS cubre solo 42-50% de los dias). costo_erp = el c62 de la linea de venta, LINEA DE CONTRASTE, no mezclar con costo_doc: miden cosas distintas (razon medida 1.1744).'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${LEDGER}`);
  await knex.raw(`DROP VIEW IF EXISTS ${IDENT}`);
};
