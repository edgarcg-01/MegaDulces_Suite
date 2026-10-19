/* eslint-disable no-console */
/**
 * `[VEC.33]` — **El lente de clasificación deja de mirar sólo el 2 % del dinero.**
 *
 * `[VEC.25]` puso la clase de cada documento en un solo lugar, pero su vista de cobertura
 * —y por lo tanto su compuerta— se acotó a las rutas vecinales. Medido hoy sobre 2026:
 *
 *     vecinal ...  19,990 docs ...  $20,034,343   <- lo unico vigilado
 *     numerica ... 508,333 docs ... $674,802,567
 *     otra ........  2,986 docs ... $338,572,419
 *     sin ruta ....  9,351 docs ...  $61,506,143
 *
 * O sea que la compuerta decía «ninguna venta queda sin clasificar» mirando el **2 %**.
 *
 * ── Lo que apareció al abrir el lente ───────────────────────────────────────────────────────
 *
 * **$22,062,513 sin clasificar**, en dos tipos que la vista nueva nombra sola:
 *
 *   `UD2301 «Corte de Caja POS»` ... 508 docs ... $20,845,963
 *   `UD6001 «Documento por Cobrar»` .. 4 docs ...  $1,216,550
 *
 * ⛔ Ninguno se clasificó por su nombre. Medido:
 *
 *   - **UD2301 es un AGREGADO, no una venta.** Su importe del día contra los tickets de esa
 *     sucursal: promedio $143,765 contra $144,322 = **99 %**, y **56 de 145 días son iguales al
 *     peso**. Sumarlo duplicaría $20.8 M.
 *   - **UD6001 es CRÉDITO.** Los 4 documentos abren cargo en `kdue` con vencimiento y saldo
 *     completo; $1,216,550 siguen abiertos.
 *
 * ── ⭐⭐ Y lo que casi se me escapa: $116 M apoyados en una corazonada ──────────────────────
 *
 * `UD0601 «Factura global»` son **$116,358,053** en rutas numéricas, y yo la había marcado
 * `espejo_factura` **por el nombre**, en el sembrado de `[VEC.25]`, sin medir nada. Si estaba
 * mal, el lente general habría escondido $116 M de venta real.
 *
 * Medida contra los tickets de contado, por sucursal y mes, todo 2026:
 *
 *     ene 93% · feb 98% · mar 93% · abr 86% · may 91% · jun 92%
 *     jul 89% · ago 90% · sep 89% · oct 87%        TOTAL: 90 %
 *
 * Nunca los excede, ningún mes. Es la firma de un espejo: re-factura los tickets a los que nadie
 * pidió factura nominativa (el resto se fue por `UD0501`/`UD1201`). La corazonada era correcta;
 * ahora además está medida.
 *
 * ── Qué entrega ─────────────────────────────────────────────────────────────────────────────
 *   1. La clase `agregado`, que antes no existía. `UD2301` no es ni venta ni re-factura: es la
 *      SUMA de ventas ya contadas. Meterlo en `espejo_factura` habría guardado un hecho falso.
 *   2. Las dos clases que faltaban.
 *   3. `analytics.v_sale_doc_coverage` — la misma pregunta de `[VEC.25]` sobre **todas** las
 *      rutas, no sólo las vecinales. Medida: **1.0 s / 0.9 s** sobre 576,085 documentos.
 *
 * ⚠️ `v_vecinal_route_doc_coverage` se deja intacta: su compuerta sigue viva y mira lo vecinal
 * con el detalle de ruta que la nueva no necesita repetir.
 */
'use strict';

const TENANT = '00000000-0000-0000-0000-00000000d01c';

/** Lo que faltaba, cada uno con el hecho que lo decidió. */
const NUEVAS = [
  ['UD2301', 'agregado',
    'Corte de Caja POS: es la SUMA de los tickets del dia, no una venta. Medido 2026: ' +
    '$143,765 promedio contra $144,322 de tickets (99%), y 56 de 145 dias iguales al peso.'],
  ['UD6001', 'credito',
    'Documento por Cobrar: abre cargo en kdue con vencimiento y saldo. 4 documentos en 2026, ' +
    '$1,216,550 todos abiertos.'],
];

exports.up = async function up(knex) {
  /**
   * ⛔ La clase `agregado` es NUEVA y no es un sinónimo de `espejo_factura`. El espejo RE-EMITE
   * un documento ya contado; un corte de caja es la SUMA de muchos. Las dos se excluyen del
   * total de venta, pero guardar una por la otra almacena un hecho falso — y el día que alguien
   * quiera listar «las re-facturas», le saldría un corte de caja.
   */
  await knex.raw(`ALTER TABLE analytics.kepler_sale_doc_class
    DROP CONSTRAINT IF EXISTS kepler_sale_doc_class_clase_chk`);
  await knex.raw(`ALTER TABLE analytics.kepler_sale_doc_class
    ADD CONSTRAINT kepler_sale_doc_class_clase_chk
    CHECK (clase IN ('contado_caja','credito','espejo_factura','agregado','no_venta'))`);

  for (const [doc_code, clase, nota] of NUEVAS) {
    await knex('analytics.kepler_sale_doc_class')
      .insert({ tenant_id: TENANT, doc_code, clase, nota, created_by: 'migracion [VEC.33]' })
      .onConflict(['tenant_id', 'doc_code']).ignore();
  }

  /**
   * La cobertura SIN acotar a vecinal. El grano es (sucursal, ruta, tipo), que es lo que hace
   * falta para responder «¿qué tipo de documento usa esta ruta y qué estamos haciendo con él?».
   *
   * ⚠️ `familia` no sale de un catálogo porque **no hay uno que cubra las 76 formas de código
   * que aparecen en los documentos**: `kduv` tiene las vecinales, el resto se nombra por su
   * forma. Es una clasificación de FORMA y se declara como tal — si mañana alguien crea el
   * catálogo de verdad, esto se reemplaza por un join, no se parcha.
   *
   * ⚠️ `route_no` llega NULL cuando el documento no declara ruta (9,351 docs, $61.5 M en 2026).
   * NULL y no la cadena vacía: «no tiene ruta» es un hecho, no un código de ruta llamado "".
   */
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_sale_doc_coverage AS
    WITH docs AS (
      SELECT btrim(h.sucursal) AS warehouse_code,
             NULLIF(btrim(COALESCE(h.c12, '')), '') AS route_no,
             'UD' || lpad((h.c4)::int::text, 2, '0') || lpad((h.c5)::int::text, 2, '0') AS doc_code,
             h.c9::date AS business_date,
             h.c16      AS importe
        FROM kepler_ods.kdm1 h
       WHERE h.c2 = 'U' AND h.c3 = 'D'
         -- Sin esto, lo que una sucursal registra contra otra se cuenta dos veces.
         AND btrim(COALESCE(h.c1, '')) = btrim(h.sucursal)
         AND COALESCE(NULLIF(btrim(h.c43), ''), '') <> 'C'
         AND h.c9::date <= (now() AT TIME ZONE 'America/Mexico_City')::date)
    SELECT '${TENANT}'::uuid AS tenant_id,
           d.warehouse_code,
           d.route_no,
           CASE
             WHEN d.route_no IS NULL                 THEN 'sin_ruta'
             WHEN d.route_no ~ '^[0-9]V[0-9]'        THEN 'vecinal'
             WHEN d.route_no ~ '^[0-9]+$'            THEN 'numerica'
             ELSE 'otra'
           END AS familia,
           d.doc_code,
           c.nombre                            AS doc_nombre,
           COALESCE(c.clase, 'sin_clasificar') AS clase,
           count(*)::int                       AS docs,
           sum(d.importe)                      AS importe,
           min(d.business_date)                AS desde,
           max(d.business_date)                AS hasta
      FROM docs d
      LEFT JOIN analytics.v_kepler_sale_doc_class c ON c.doc_code = d.doc_code
     GROUP BY 1,2,3,4,5,6,7`);

  await knex.raw('GRANT SELECT ON analytics.v_sale_doc_coverage TO PUBLIC');
};

exports.down = async function down(knex) {
  // ⛔ No se quita la clase `agregado` del CHECK: hay filas que la usan y el CHECK fallaría.
  // Tampoco se borran las clases sembradas (son un dato propio).
  await knex.raw('DROP VIEW IF EXISTS analytics.v_sale_doc_coverage');
};
