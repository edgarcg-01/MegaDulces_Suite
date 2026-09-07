/**
 * U.10.0 — La vista de renglón contaba la venta DOS VECES. Corrección del mismo día.
 *
 * ── El defecto, que es mío ─────────────────────────────────────────────────────────────────
 * La mig `20260907240000` creó `analytics.v_erp_sales_line_units` con
 * `c4 IN ('5','6','8','9','10','12','40','41','90')`. Elegí esa lista leyendo los CENSOS de
 * `kdm2` — cuáles doctypes tenían volumen — en vez de leer el CATÁLOGO que dice qué es cada uno.
 * `kepler_ods.kdmm` lo dice y contradice la lista:
 *
 *     U-D-10  Ticket Contado Caja N     <- la venta de mostrador
 *     U-D-6   Factura GLOBAL            <- RE-FACTURA los tickets del dia
 *     U-D-5   Factura TK Contado        <- "TK" = ticket; factura tickets
 *     U-D-40  Pedido                    <- una ORDEN, no una venta
 *     U-D-41  Embarque                  <- un embarque
 *     U-D-90  Saldar Documentos         <- ni siquiera toca mercancia
 *
 * Medido en prod (sucursal 01, 30 dias, contra U-D-10 por (SKU, dia)):
 *
 *     doctype   filas    importe      pares con U-D-10   MISMA cantidad
 *     U-D-6    32,099   $4,452,678         32,099        29,882  = 93.1%  <<< DUPLICA
 *     U-D-5       643     $132,141            641           162  = 25.2%
 *     U-D-12    2,337     $576,304          2,337           510  = 21.8%
 *     U-D-8     3,802   $4,415,401          2,570            76  =  2.0%
 *     U-D-9         0           $0              0             0
 *
 * `U-D-6` es inequívoco: **93.1% de sus renglones tienen la MISMA cantidad** que un renglón de
 * `U-D-10` del mismo SKU y el mismo día. Es la factura global del día, no una venta nueva.
 *
 * ── El corte correcto, y por qué ES el del pipeline vivo ───────────────────────────────────
 * `c4 IN ('8','10','12')` — exactamente lo que ya usa `analytics.mv_kepler_sales_daily`
 * (`20260905120000:…`). No lo copio por comodidad: lo copio porque **si la vista de renglón y el
 * sell-out no comparten el corte, comparar el peldaño declarado contra la cifra publicada mediría
 * dos poblaciones distintas** y cualquier delta sería indistinguible de un error de alcance.
 *   ·  8 = Factura Telemarketing (2.0% de solape -> independiente)
 *   · 10 = Ticket Contado Caja
 *   · 12 = Factura Cont No Fiscal (21.8% de solape: coincidencia de SKU+dia, no re-facturacion;
 *          entra porque el pipeline vivo ya la cuenta y sacarla cambiaria el alcance de negocio)
 *
 * `U-D-9` (Ticket Credito) queda fuera con motivo medido: **0 renglones** en 30 dias.
 * `U-D-5` queda fuera: su nombre dice que factura tickets y su solape del 25.2% lo respalda; el
 * pipeline vivo tampoco la cuenta. Si alguien la necesita, entra con su propia medicion.
 *
 * ── Efecto ────────────────────────────────────────────────────────────────────────────────
 * NINGUN consumidor lee esta vista todavia (nacio hace minutos), asi que no hay cifra publicada
 * que se mueva. Lo que cambia son los invariantes del candado: medidos sobre `U-D-10` sola daban
 * 99.99% / 98.89% / 95.58%, y con la lista vieja `test-newdb-sales-line-units.js` reportaba
 * `c13 = c56 x c57` en **18.29% para U-D-6** (una factura global agrega varios tickets en un
 * renglon, asi que su `c56` no multiplica su `c57`). Los 2 FAIL de ese candado ERAN este defecto.
 *
 * ⚠️ `CREATE OR REPLACE`, nunca `DROP`: el orden y el tipo de las columnas no cambian, solo el
 * conjunto de filas. Y se re-aplican `security_invoker` y el `GRANT`, que no se heredan (U.7).
 *
 * SIN BACKTICKS en los comentarios SQL: van dentro de un template literal de JS.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';
const NUMN = (col, dec) => `round(nullif(regexp_replace(${col}::text,'[^0-9.-]','','g'),'')::numeric,${dec})`;

exports.up = async function up(knex) {
  const ods = (await knex.raw(`SELECT to_regclass('analytics.v_erp_sales_line_units') AS v`)).rows[0];
  if (!ods?.v) {
    console.log('  [U.10.0] la vista no existe — no-op (corre despues de 20260907240000).');
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
        -- ⭐ EL MISMO corte que analytics.mv_kepler_sales_daily. U-D-6 (Factura global) RE-FACTURA
        -- los tickets de U-D-10: 93.1% de sus renglones traen la MISMA cantidad del mismo SKU el
        -- mismo dia. U-D-5 factura tickets (25.2%). U-D-40 es un Pedido y U-D-90 no toca mercancia.
        AND btrim(l.c4::text) IN ('8', '10', '12')
        -- Anti-replica que conserva los sub-almacenes de ruta (01-00N -> RUTA-2N).
        AND (btrim(l.c1::text) = l.sucursal::text
             OR btrim(l.c1::text) LIKE l.sucursal::text || '-%')
        AND l.c32 > '1900-01-01'::timestamp
    ),
    res AS (
      SELECT s.*,
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
      w.tenant_id, r.sucursal, r.almacen_erp, r.warehouse_code, w.id AS warehouse_id,
      r.doctype, r.folio, r.linea, r.fecha, r.sku, p.id AS product_id, r.nombre,
      r.unidad_base, r.cantidad_base, r.precio_base, r.importe,
      r.unidad_vendida, r.cantidad_vendida, r.precio_vendido, r.factor_declarado,
      r.factor_resuelto, r.factor_source,
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
    'U.9.0/U.10.0 - El renglon de venta de Kepler con su CONVERSION DECLARADA (kdm2 c55/c56/c57/c58), grano renglon. Kepler no resuelve la unidad: la trae en la linea (c9 = c56 x c58). Doctypes 8/10/12 = EL MISMO corte que mv_kepler_sales_daily (U-D-6 Factura global RE-FACTURA los tickets de U-D-10 al 93.1%; U-D-40 es Pedido). factor_resuelto nunca vale 1 de relleno: si ninguna via alcanza, factor_source = sin_declarar y el factor es NULL.'`);

  // ── Auto-verificacion: los invariantes tienen que RECUPERARSE al sacar la factura global.
  const v = (await knex.raw(`
    SELECT count(*)::int renglones,
           count(*) FILTER (WHERE factor_resuelto IS NOT NULL)::int resueltos,
           count(*) FILTER (WHERE factor_source = 'sin_declarar')::int sin_declarar,
           count(*) FILTER (WHERE factor_declarado > 0 AND cuadra)::int cuadran,
           count(*) FILTER (WHERE factor_declarado > 0)::int con_c58,
           count(*) FILTER (WHERE cantidad_vendida > 0 AND precio_vendido > 0 AND importe > 0
                              AND abs(importe - cantidad_vendida * precio_vendido) <= 0.05)::int imp_ok,
           count(*) FILTER (WHERE cantidad_vendida > 0 AND precio_vendido > 0 AND importe > 0)::int imp_n,
           count(*) FILTER (WHERE doctype = 'U-D-6')::int factura_global
      FROM analytics.v_erp_sales_line_units
     WHERE tenant_id = '${M}'::uuid AND fecha > current_date - 365`)).rows[0];
  const pctRes = (100 * v.resueltos / v.renglones);
  const pctInv = (100 * v.cuadran / v.con_c58);
  const pctImp = (100 * v.imp_ok / v.imp_n);
  console.log(`  renglones=${v.renglones} · resueltos=${v.resueltos} (${pctRes.toFixed(2)}%) · sin_declarar=${v.sin_declarar}`);
  console.log(`  invariante cantidad = cuantos x factor: ${pctInv.toFixed(2)}%`);
  console.log(`  invariante importe   = cuantos x precio: ${pctImp.toFixed(2)}%`);

  if (v.factura_global !== 0) throw new Error(`la factura global sigue adentro: ${v.factura_global} renglones`);
  if (pctInv < 99) throw new Error(`el invariante del renglon no se sostiene: ${pctInv.toFixed(2)}%`);
  // Este es el que el defecto tenia en 61.22% global (18.29% en U-D-6). Sin la factura global
  // tiene que volver a la banda medida sobre U-D-10 sola (98.89%).
  if (pctImp < 95) throw new Error(`el invariante del importe no se recupero: ${pctImp.toFixed(2)}% (se esperaba ~99%)`);
  if (v.sin_declarar === 0) throw new Error('sin_declarar = 0: la vista esta inventando un factor');
};

exports.down = async function down() {
  // No-op: revertir seria volver a contar la factura global como venta nueva.
};
