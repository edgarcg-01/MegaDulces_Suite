'use strict';
/**
 * `[VEC.0]` — **La venta de las rutas vecinales se DERIVA del ODS. Se retira el importer.**
 *
 * Disparador: *"las ventas actuales estan infladas en /ventas-por-ruta"*. Medido contra prod el
 * 2026-10-06, la pantalla publicaba **$9,164,175.91** de venta vecinal 2026 donde el ERP dice
 * **$4,417,300.50** — **2.07x**, $4,746,875.41 de exceso. Y ademas faltaban rutas enteras.
 *
 * ── Por que el numero estaba inflado ────────────────────────────────────────────────────────
 *
 * `import-kepler-vecinal-routes.js` unia cabecera y lineas por `(c1,c2,c3,c4,c6)` **sin `c5`**,
 * con este comentario en el codigo:
 *
 *     (c5 varia por linea -> NO es clave de documento, se excluye del join.)
 *
 * ⛔ Es **falso**, y medido fila por fila: en `kdm2` lo que varia por linea es **`c7`**; `c5` es
 * la **CAJA** — el mismo `c5` de la cabecera, donde `U-D-10` = *"Ticket Contado Caja N"*. Los
 * folios se numeran **por caja**, asi que el ticket 881 existe en la caja 1, en la 2 y en la 4.
 * Al soltar `c5`, a cada ticket de la ruta se le pegaban las lineas de los tickets homonimos de
 * **las otras cuatro cajas** — compras de mostrador de otros clientes:
 *
 *     1V001 agosto-2026   lineas 9,021 con el join del feed   vs   1,515 reales
 *     1V002 agosto-2026   lineas 7,702                        vs   1,570 reales
 *
 * ⭐ **El arbitro es `kdm1.c16`** (total del documento), que no depende del join: suma
 * **429,077.18** para 1V001 en agosto y el join con `c5` devuelve **429,077.19** — un centavo de
 * redondeo. El join sin `c5` devolvia **909,833.63**. El testigo y el metodo coinciden al peso,
 * asi que la cifra no esta en disputa.
 *
 * ── Por que una VISTA y no un importer arreglado ────────────────────────────────────────────
 *
 * Regla principal del proyecto: **cero importers, el dato sale del ODS, de una tabla principal,
 * normalizada y verificada**. Arreglar el join habria dejado en pie los tres defectos que lo
 * acompanan, todos propios de *copiar*:
 *
 *   1. `sales_by_route_monthly` sube con `GREATEST(...)` — **nunca baja**. Un feed corregido NO
 *      habria corregido la pantalla: los meses inflados se quedaban clavados para siempre.
 *   2. `route_push_lines` solo hace `DO UPDATE` sobre la llave `(ruta, dia, folio, sku)`. Las
 *      lineas fantasma (SKUs de **otras** cajas) no estan en la nueva corrida: sobrevivian
 *      huerfanas. Son ~75k de las 103,394 lineas vecinales que hay hoy en prod.
 *   3. La cobertura la fijaba una **lista escrita a mano** de 3 ramas. Lo que no estaba en la
 *      lista no existia (ver abajo).
 *
 * Derivando, los tres desaparecen de raiz: no hay estado que corregir, no hay huerfanos, y una
 * ruta nueva aparece sola el dia que vende.
 *
 * ── Lo que la lista a mano dejaba invisible: $1,815,047.93 ──────────────────────────────────
 *
 * El feed solo miraba PH, Piedad Abastos y Yurecuaro. Medido en el ODS, **venden ademas**:
 *
 *     05 3V001  RUTA VECINAL ZAMORA CENTRO        may-oct 2026   $1,082,252
 *     07 2V003  RVMM01 GUILLERMO HERNANDEZ        sep-oct 2026     $477,417
 *     07 2V001  RVMM02 JOSEPH AGUSTIN GUERERRO    sep-oct 2026     $255,379
 *     08 2V005  HUMBERTO PLACENCIA BRAVO          sep 2026          $33,100
 *
 * ⚠️ **El discriminante es el CODIGO, no el nombre.** En Michoacan las rutas se llaman con el
 * nombre de la persona (`RVMM01 GUILLERMO HERNANDEZ`), asi que el criterio `c3 ILIKE 'RUTA
 * VECINAL%'` — el que usa la primera rama del canal en `mv_kepler_sales_daily` — **no las ve**.
 * El patron `^[0-9]V[0-9]` sobre `kdm1.c12` si, y es el que se usa aca.
 *
 * ── Las tres reglas que la vista hereda de superficies ya probadas ──────────────────────────
 *
 *  - **`(d.c5)::int = (h.c5)::int`**: la caja entra al join. Es exactamente lo que ya hace
 *    `mv_kepler_sales_daily`; el defecto era privativo del importer.
 *  - **`btrim(h.c1) = btrim(h.sucursal)`**: el documento se cuenta en SU plaza. El catalogo
 *    `kduv` esta replicado entre sucursales, asi que sin esto la misma ruta aparece en ramas
 *    ajenas ($32,002.51 en 2026, ahora atribuidos donde ocurrieron).
 *  - **`c43 <> 'C'`**: fuera los cancelados. Decode ya verificado (`C` = cancelada, total 0).
 *    Hoy no mueve el monto — 3 documentos en $0.00 — y protege hacia adelante.
 *
 * ⛔ **`U-D-12` NO entra, y es lo contrario de lo que dice la regla general.**
 * `VERDAD_ABSOLUTA.md` §4.4 declara el universo de venta como `U-D` 8/10/12, y para el mostrador
 * es correcto. En las rutas vecinales **`U-D-12` ("Factura Cont No Fiscal") re-factura el mismo
 * ticket**: al repartidor le piden comprobante. Medido por linea (mismo cliente, mismo dia,
 * mismo SKU, misma cantidad), con control de placebo contra OTRA ruta:
 *
 *     ruta vecinal PH (ago)    2,870 de 2,876 lineas ya estaban en U-D-10  (99.8%)   placebo 0
 *     resto de la sucursal        58 de   184                              (31.5%)
 *     Morelia 2V001 (sep)      1,686 de 1,686                              (100%)    placebo 0
 *     Morelia 2V003 (sep)      3,194 de 3,262                              (97.9%)   placebo 0
 *
 * El contraste con "el resto de la sucursal" es lo que convierte esto en un hallazgo y no en una
 * corazonada: fuera de las rutas, `U-D-12` es venta genuina en su mayoria. *Una medicion sobre
 * otro universo es otra afirmacion*, asi que la regla general no se toca: se precisa para este
 * universo. (El doble conteo que esto causa en el sell-out lo corrige `20261006250000`.)
 *
 * ── Dos detalles de grano que el importer tenia mal ─────────────────────────────────────────
 *
 *  - **El ticket es `(caja, folio)`, no el folio.** `count(DISTINCT c6)` sub-cuenta cuando dos
 *    cajas emiten el mismo numero el mismo mes.
 *  - **No se filtran las lineas de servicio** (`c11='SER'`), a diferencia del sell-out, porque
 *    aca el arbitro es el total del documento: filtrarlas descuadraria contra `c16`. El candado
 *    `test-newdb-vecinal-truth.js` vigila ese cuadre y avisaria si algun dia aparecen.
 *
 * ⚠️ `route_code` conserva el prefijo **`WIN-`** aunque estas rutas son de Kepler y no de
 * Wincaja. Es deuda de nombre heredada del importer, y se deja a proposito: es la identidad con
 * la que el drill-down, los filtros guardados y la tarjeta de incentivos resuelven hoy.
 * Renombrarla es un cambio de contrato y va aparte.
 *
 * @param { import("knex").Knex } knex
 */

const T = `'00000000-0000-0000-0000-00000000d01c'::uuid`;

const LINEAS = 'analytics.v_kepler_vecinal_sales_lines';
const MENSUAL = 'analytics.v_kepler_vecinal_monthly';

const DEF_LINEAS = `
SELECT
  ${T}                                                    AS tenant_id,
  btrim(h.sucursal)                                       AS warehouse_code,
  btrim(h.c12)                                            AS route_no,
  'WIN-' || btrim(h.c12)                                  AS route_code,
  NULLIF(btrim(COALESCE(v.c3, '')), '')                   AS route_name,
  (h.c9)::date                                            AS business_date,
  btrim(h.c6)                                             AS folio,
  btrim((h.c5)::text)                                     AS caja,
  NULLIF(NULLIF(btrim(COALESCE(h.c10, '')), ''), '0001')  AS cliente,
  btrim(d.c8)                                             AS sku,
  NULLIF(btrim(COALESCE(d.c10, '')), '')                  AS producto,
  NULLIF(upper(btrim(COALESCE(d.c11, ''))), '')           AS unidad,
  (d.c12)::numeric                                        AS precio_unitario,
  (d.c9)::numeric                                         AS qty,
  (d.c13)::numeric                                        AS importe,
  (h.c16)::numeric                                        AS total_documento
FROM kepler_ods.kdm1 h
JOIN kepler_ods.kdm2 d
  ON  btrim(d.sucursal) = btrim(h.sucursal)
  AND btrim(d.c1)       = btrim(h.c1)
  AND d.c2 = h.c2
  AND d.c3 = h.c3
  AND (d.c4)::integer = (h.c4)::integer
  AND (d.c5)::integer = (h.c5)::integer
  AND btrim(d.c6) = btrim(h.c6)
LEFT JOIN kepler_ods.kduv v
  ON  btrim(v.sucursal) = btrim(h.sucursal)
  AND btrim(v.c2)       = btrim(h.c12)
WHERE h.c2 = 'U'
  AND h.c3 = 'D'
  AND (h.c4)::integer = 10
  AND btrim(COALESCE(h.c12, '')) ~ '^[0-9]V[0-9]'
  AND btrim(COALESCE(h.c1, '')) = btrim(h.sucursal)
  AND COALESCE(NULLIF(btrim(h.c43), ''), '') <> 'C'
  AND btrim(COALESCE(d.c8, '')) <> ''
  AND (h.c9)::date <= ((now() AT TIME ZONE 'America/Mexico_City'))::date`;

const DEF_MENSUAL = `
SELECT
  l.tenant_id,
  l.warehouse_code,
  l.route_code,
  l.route_no,
  max(l.route_name)                            AS route_name,
  date_trunc('month', l.business_date)::date   AS month,
  sum(l.qty)                                   AS units,
  sum(l.importe)                               AS revenue,
  count(DISTINCT (l.caja, l.folio))            AS tickets,
  max(l.business_date)                         AS last_sale_date
FROM ${LINEAS} l
GROUP BY l.tenant_id, l.warehouse_code, l.route_code, l.route_no,
         date_trunc('month', l.business_date)::date`;

const COMENTARIO_LINEAS =
  '[VEC.0] Venta de ruta vecinal derivada del ODS (derive-no-copy, ADR-059). El join incluye '
  + 'la CAJA ((d.c5)::int = (h.c5)::int): sin ella se pegan las lineas de los tickets homonimos '
  + 'de las otras cajas y el monto sale 2.07x. Arbitro: kdm1.c16 (total del documento), que '
  + 'cuadra al centavo. U-D-12 queda FUERA a proposito: en estas rutas re-factura el mismo '
  + 'ticket (99.8% de las lineas, placebo 0) — la regla general de VERDAD_ABSOLUTA 4.4 vale para '
  + 'mostrador, no aca. Reemplaza a import-kepler-vecinal-routes.js, retirado.';

const COMENTARIO_MENSUAL =
  '[VEC.0] Rollup mensual de la venta vecinal, derivado en vivo (sin GREATEST, sin estado que '
  + 'corregir). El ticket es (caja, folio): el folio solo es unico DENTRO de su caja.';

/** `COMMENT ON` no acepta parámetros: el texto va interpolado, con las comillas escapadas. */
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

exports.up = async function up(knex) {
  await knex.raw(`CREATE OR REPLACE VIEW ${LINEAS} AS ${DEF_LINEAS}`);
  await knex.raw(`ALTER VIEW ${LINEAS} SET (security_invoker = true)`);
  // El GRANT se re-aplica explicito: esta casa ya perdio uno en un CREATE OR REPLACE y solo lo
  // vio una asercion de metadata (ADR-057).
  await knex.raw(`GRANT SELECT ON ${LINEAS} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${LINEAS} IS ${lit(COMENTARIO_LINEAS)}`);

  await knex.raw(`CREATE OR REPLACE VIEW ${MENSUAL} AS ${DEF_MENSUAL}`);
  await knex.raw(`ALTER VIEW ${MENSUAL} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${MENSUAL} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${MENSUAL} IS ${lit(COMENTARIO_MENSUAL)}`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${MENSUAL}`);
  await knex.raw(`DROP VIEW IF EXISTS ${LINEAS}`);
};
