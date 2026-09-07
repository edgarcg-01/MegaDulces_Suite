/**
 * U.9.0 — El renglón de venta ya trae su propia conversión de unidad. Se lee, no se reconstruye.
 *
 * ── La pregunta que la originó ─────────────────────────────────────────────────────────────
 * Edgar: *"¿por qué Kepler UI puede sacar las unidades correctamente y nosotros no?"*
 *
 * Respuesta, medida contra prod 2026-09-07: **Kepler no resuelve la unidad — nunca la pierde.**
 * Cada renglón de `kdm2` trae la escalera completa y la pantalla del ERP sólo la imprime:
 *
 *     c11 / c9  / c12   la unidad BASE del renglón, la cantidad en ella, su precio
 *     c55       cual unidad COMPRO el cliente (siempre la mayor: PAQ, CJA, BTO)
 *     c56       cuantas de esa unidad
 *     c57       el precio de esa unidad
 *     c58       el FACTOR: unidades de c11 por unidad de c55
 *
 * Los invariantes, medidos sobre los renglones U-D-10 de las 6 sucursales:
 *
 *     c9  = c56 * c58     99.99% de 899,646 renglones   (solo $6,702 no cierra)
 *     c13 = c56 * c57     98.89%
 *     c57 / c12 = c58     95.58% de los 58,599 donde la unidad vendida difiere, mediana 1.0000
 *     c58 vs la etiquetera: = f2 en 51,326 renglones, = f3 en 6,959
 *
 * El caso que lo vuelve obvio: `70031 CHOC EST SUIZO /16` es el SKU que docs/UNIDADES_DE_MEDIDA.md
 * cita como prueba de que "el rotulo c11 miente" — 45 renglones marcados PZA a $90.96, precio de
 * paquete de 16. **No miente.** El renglon dice c9=48 piezas, c55=PAQ, c56=3, c58=16: tres paquetes
 * de dieciseis. c11=PZA es correcto, la cantidad SI esta en piezas. Leiamos media linea.
 *
 * ── Y el repo ya lo habia descubierto, del lado de las COMPRAS ─────────────────────────────
 * La mig 20260829190000 (RA-PRO.43/45) decodifico estas mismas columnas para la orden de compra y
 * las expone en `analytics.erp_purchase_doc_lines` como unidad_caja / unidades_por_caja /
 * costo_caja, con el header diciendo *"la linea trae su PROPIA conversion declarada ... verificado
 * c12 x c58 = c57. Es lo que hace convertible una linea sin adivinar la unidad."*
 *
 * Nunca se cruzo al lado de la venta. Esta vista es esa misma forma, para el otro lado del
 * documento — misma nomenclatura a proposito, para que las dos caras se lean igual.
 *
 * ── Decisiones de construccion ─────────────────────────────────────────────────────────────
 *
 * 1. **Lee `kdm2` SOLA, sin unir a `kdm1`.** Todo lo que hace falta esta en el renglon: almacen
 *    (c1), doctype (c2/c3/c4), folio (c6), linea (c7), sku (c8) y su fecha PROPIA (c32). Unir al
 *    encabezado costaria el riesgo de duplicacion 2x que ERP_KEPLER.md documenta y no aporta nada
 *    a la unidad. Quien necesite cliente o forma de pago une `kdm1` por su cuenta.
 *
 * 2. **Anti-replica que NO mata las rutas.** `kdil`/`kdm1` arrastran filas de otras sucursales y la
 *    regla del repo es `c1 = sucursal`. Pero en la venta `c1` tambien lleva los SUB-ALMACENES de
 *    ruta (`01-001`..`01-006` -> RUTA-21..28), asi que la regla estricta los borraria. Medido:
 *      · suc=03 con c1=02 -> 112,377 renglones / $7,496,155 / c58 al 0% / murio el 2026-01-07
 *        = REPLICA, fuera.
 *      · suc=01 con c1=01-00N -> 11,613 renglones / $1,232,618 / **c58 al 100%** / vivos al 05-sep
 *        = las 6 rutas, DENTRO.
 *    Por eso el predicado es `c1 = sucursal OR c1 LIKE sucursal||'-%'`.
 *    ⭐ Y es un hallazgo por derecho propio: esas 6 rutas son exactamente las que
 *    `v_unit_truth_coverage` declara SIN CUBRIR (cambiaron de ERP a mitad de ano, su divisor
 *    depende de la fecha). El renglon las cubre al 100% porque no necesita divisor: trae el suyo.
 *
 * 3. **`factor_resuelto` nunca se rellena con 1.** Precedencia, y cada peldano dice de donde vino:
 *      linea_c58    c58 numerico > 0                      (la conversion declarada)
 *      linea_base   c55 = c11                             (se vendio en la unidad base -> 1)
 *      linea_precio c55 <> c11 y c57/c12 da un entero      (se recupera del dinero, MISMA fila)
 *      sin_declarar NULL + motivo                          (nunca 1 de relleno)
 *    La rama `linea_precio` NO consulta ningun catalogo: exige que la razon sea >= 1 (la unidad
 *    vendida siempre es la mayor) y que caiga a menos de 1% de un entero. Eso la mantiene
 *    independiente de la etiquetera, que es lo que permite usarla despues como testigo.
 *
 * 4. **`U-D-13` FUERA.** 7,042 renglones por $461.7M con c58 al 0%: es el traspaso al CEDIS, no
 *    venta (100% servicio; Fase AX ya lo excluye). Meterlo multiplicaria por 5 el "importe" de la
 *    vista con dinero que no es venta.
 *
 * SIN BACKTICKS en los comentarios SQL: van dentro de un template literal de JS (8va vez).
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';
/** Numerico de Kepler (texto con formato) preservando NULL: "no declarado" no es "cero". */
const NUMN = (col, dec) => `round(nullif(regexp_replace(${col}::text,'[^0-9.-]','','g'),'')::numeric,${dec})`;

exports.up = async function up(knex) {
  const ods = (await knex.raw(`SELECT to_regclass('kepler_ods.kdm2') AS l`)).rows[0];
  if (!ods?.l) {
    console.log('  [U.9.0] kepler_ods.kdm2 ausente — no-op (local sin replica).');
    return;
  }

  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_erp_sales_line_units AS
    WITH src AS (
      SELECT
        l.sucursal::text                              AS sucursal,
        btrim(l.c1::text)                             AS almacen_erp,
        btrim(l.c2::text)||'-'||btrim(l.c3::text)||'-'||btrim(l.c4::text) AS doctype,
        btrim(l.c6::text)                             AS folio,
        btrim(l.c7::text)                             AS linea,
        l.c32::date                                   AS fecha,
        NULLIF(btrim(l.c8::text),'')                  AS sku,
        NULLIF(btrim(l.c10::text),'')                 AS nombre,
        NULLIF(btrim(l.c11::text),'')                 AS unidad_base,
        ${NUMN('l.c9', 4)}                            AS cantidad_base,
        ${NUMN('l.c12', 6)}                           AS precio_base,
        ${NUMN('l.c13', 2)}                           AS importe,
        NULLIF(btrim(l.c55::text),'')                 AS unidad_vendida,
        ${NUMN('l.c56', 4)}                           AS cantidad_vendida,
        ${NUMN('l.c57', 6)}                           AS precio_vendido,
        ${NUMN('l.c58', 4)}                           AS factor_declarado
      FROM kepler_ods.kdm2 l
      WHERE l.c2 = 'U' AND l.c3 = 'D'
        -- Venta y salida de mercancia. U-D-13 fuera: es traspaso al CEDIS, no venta.
        AND btrim(l.c4::text) IN ('5','6','8','9','10','12','40','41','90')
        -- Anti-replica que conserva los sub-almacenes de ruta (ver header, decision 2).
        AND (btrim(l.c1::text) = l.sucursal::text
             OR btrim(l.c1::text) LIKE l.sucursal::text || '-%')
        -- Centinela de Kepler para "sin fecha".
        AND l.c32 > '1900-01-01'::timestamp
    ),
    res AS (
      SELECT s.*,
             -- El codigo de almacen tal como lo nombra la plataforma. Los sub-almacenes de la
             -- sucursal 01 son las rutas (mismo mapa que ROUTE_MAP en import-sales-fact.js).
             CASE btrim(s.almacen_erp)
               WHEN '01-001' THEN 'RUTA-21' WHEN '01-002' THEN 'RUTA-22'
               WHEN '01-003' THEN 'RUTA-23' WHEN '01-004' THEN 'RUTA-26'
               WHEN '01-005' THEN 'RUTA-27' WHEN '01-006' THEN 'RUTA-28'
               ELSE s.sucursal END                    AS warehouse_code,
             CASE
               WHEN s.factor_declarado > 0                          THEN s.factor_declarado
               WHEN s.unidad_vendida IS NOT NULL
                AND s.unidad_vendida = s.unidad_base                THEN 1::numeric
               WHEN s.unidad_vendida IS NOT NULL
                AND s.unidad_vendida <> s.unidad_base
                AND s.precio_base > 0 AND s.precio_vendido > 0
                AND (s.precio_vendido / s.precio_base) >= 1
                AND abs((s.precio_vendido / s.precio_base)
                        - round(s.precio_vendido / s.precio_base)) <= 0.01
                                                                    THEN round(s.precio_vendido / s.precio_base)
             END                                      AS factor_resuelto,
             CASE
               WHEN s.factor_declarado > 0                          THEN 'linea_c58'
               WHEN s.unidad_vendida IS NOT NULL
                AND s.unidad_vendida = s.unidad_base                THEN 'linea_base'
               WHEN s.unidad_vendida IS NOT NULL
                AND s.unidad_vendida <> s.unidad_base
                AND s.precio_base > 0 AND s.precio_vendido > 0
                AND (s.precio_vendido / s.precio_base) >= 1
                AND abs((s.precio_vendido / s.precio_base)
                        - round(s.precio_vendido / s.precio_base)) <= 0.01
                                                                    THEN 'linea_precio'
               ELSE                                                      'sin_declarar'
             END                                      AS factor_source
        FROM src s
    )
    SELECT
      w.tenant_id,
      r.sucursal,
      r.almacen_erp,
      r.warehouse_code,
      w.id                                            AS warehouse_id,
      r.doctype,
      r.folio,
      r.linea,
      r.fecha,
      r.sku,
      p.id                                            AS product_id,
      r.nombre,
      r.unidad_base,
      r.cantidad_base,
      r.precio_base,
      r.importe,
      r.unidad_vendida,
      r.cantidad_vendida,
      r.precio_vendido,
      r.factor_declarado,
      r.factor_resuelto,
      r.factor_source,
      -- El invariante del renglon, expuesto por fila para que nadie tenga que re-derivarlo.
      (r.factor_declarado > 0 AND r.cantidad_vendida IS NOT NULL
        AND abs(r.cantidad_base - r.cantidad_vendida * r.factor_declarado) <= 0.001) AS cuadra
      FROM res r
      JOIN commercial.warehouses w
        ON w.code = r.warehouse_code AND w.deleted_at IS NULL
      LEFT JOIN catalog.products p
        ON p.tenant_id = w.tenant_id AND p.sku = r.sku AND p.deleted_at IS NULL
  `);

  await knex.raw('ALTER VIEW analytics.v_erp_sales_line_units SET (security_invoker = true)');
  await knex.raw('GRANT SELECT ON analytics.v_erp_sales_line_units TO app_runtime');
  await knex.raw(`COMMENT ON VIEW analytics.v_erp_sales_line_units IS
    'U.9.0 - El renglon de venta de Kepler con su CONVERSION DECLARADA (kdm2 c55/c56/c57/c58), grano renglon. Kepler no resuelve la unidad: la trae en la linea (c9 = c56 x c58 en 99.99%). factor_resuelto nunca vale 1 de relleno; cuando ninguna via alcanza, factor_source = sin_declarar y el factor es NULL. Hermana de analytics.erp_purchase_doc_lines (misma nomenclatura, otro lado del documento). NO une kdm1 a proposito: todo lo de unidad esta en el renglon y el join al encabezado duplica 2x.'`);

  // ── Auto-verificacion: los invariantes que este trabajo afirma. Si la vista no los cumple,
  // la migracion no debe quedarse aplicada en silencio.
  const v = (await knex.raw(`
    SELECT count(*)::int                                                        AS renglones,
           count(*) FILTER (WHERE factor_resuelto IS NOT NULL)::int             AS resueltos,
           count(*) FILTER (WHERE factor_source = 'sin_declarar')::int          AS sin_declarar,
           count(*) FILTER (WHERE factor_declarado > 0 AND cuadra)::int         AS cuadran,
           count(*) FILTER (WHERE factor_declarado > 0)::int                    AS con_c58
      FROM analytics.v_erp_sales_line_units
     WHERE tenant_id = '${M}'::uuid AND fecha > current_date - 365`)).rows[0];
  const pctRes = (100 * v.resueltos / v.renglones).toFixed(2);
  const pctInv = (100 * v.cuadran / v.con_c58).toFixed(2);
  console.log(`  renglones=${v.renglones} · resueltos=${v.resueltos} (${pctRes}%) · sin_declarar=${v.sin_declarar}`);
  console.log(`  invariante c9 = c56 x c58: ${v.cuadran}/${v.con_c58} (${pctInv}%)`);
  if (Number(pctInv) < 99) {
    throw new Error(`el invariante del renglon no se sostiene: ${pctInv}% (se midieron 99.99%)`);
  }
  if (Number(pctRes) < 95) {
    throw new Error(`cobertura del factor por renglon ${pctRes}%, se midio 97.61%`);
  }
  // Un "sin_declarar" en cero significaria que la vista se esta rellenando sola.
  if (v.sin_declarar === 0) {
    throw new Error('sin_declarar = 0: la vista esta inventando un factor donde no lo hay');
  }
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_erp_sales_line_units');
};
