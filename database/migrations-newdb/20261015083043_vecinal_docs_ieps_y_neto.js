'use strict';
/**
 * `[VEC.14]` — **La venta vecinal publica también su NETO, porque el negocio cuenta sin impuestos.**
 *
 * Pedido de Edgar (2026-10-15): *"conciliemos las ventas vs las de Kepler, considerando que ellos
 * no toman IEPS e IVA"*. `/comercial/ventas-por-ruta` publica `kdm1.c16`, que es el total **CON**
 * impuestos (el precio del renglón ya los trae: Σ`kdm2.c13` = `c16` en 99.84%). La cifra que se
 * cita del otro lado es la neta. Mientras una superficie publique bruto y la otra neto, la
 * diferencia se lee como descuadre.
 *
 * ── El decode, ARBITRADO POR EL DINERO y no por el documento ────────────────────────────────
 *
 * `ERP_KEPLER.md` §2 dice `c14`=IVA y `c15`=IEPS. Se verificó contra prod (vecinal, sep-2026)
 * midiendo la razón, que es lo que delata la tasa:
 *
 *     c14 / (c16 − c14) ............ 0.1600–0.1602 en 646 documentos   -> IVA 16%
 *     c15 / (c16 − c14 − c15) ...... exactamente 0.080 en 417          -> IEPS 8%
 *
 * ⚠️ Los demás valores de la razón (0.02, 0.04, 0.06…) **no contradicen**: son tickets MIXTOS,
 * con renglones gravados y renglones a tasa 0 (alimento básico). La razón mezclada cae por debajo
 * de la tasa, nunca por encima — y no hay ningún bucket arriba de 0.1602.
 *
 * ── ⛔ Por qué el IEPS tiene que viajar aparte, y no basta dividir entre 1.16 ────────────────
 *
 * Medido, vecinal sep-2026: netear SÓLO por IVA deja **$69,251.27 de IEPS adentro** sobre
 * $1,943,014.72. En cuatro meses (jul–oct) son **$198,536.34**, y **4,585 de 7,253 documentos
 * (63%) lo llevan** — no es un caso de borde, es la mayoría del dulce.
 *
 *     bruto (c16) .................. $1,943,014.72
 *     − IVA (c14) ..................   −$112,060.52
 *     − IEPS (c15) .................    −$69,251.27
 *     = neto ....................... $1,761,702.93   (el impuesto es el 9.33% del bruto)
 *
 * ── Qué agrega, y por qué acá y no en cada consumidor ───────────────────────────────────────
 *
 * `ieps` y `neto` se publican en la **vista canónica**, no se re-derivan en quien los necesite.
 * El antecedente está medido en esta misma casa: cuando cada pantalla re-deriva, divergen. La
 * vista ya exponía `impuesto` (= `c14`) y **el IEPS no estaba** — o sea que un consumidor que
 * neteara con lo que había se quedaba corto por esos $69k, sin error y sin aviso.
 *
 * `CREATE OR REPLACE VIEW` agrega columnas **al final** y `impuesto` era la última, así que el
 * orden de las que ya existían no se mueve. Su único consumidor (`v_kepler_vecinal_monthly`)
 * selecciona por nombre, no con `*`.
 *
 * ⚠️ **`security_invoker` y los GRANT se reponen a mano**: esta casa ya los perdió en un
 * `CREATE OR REPLACE VIEW` y sólo lo vio la aserción de metadata del candado (ADR-057). Se
 * reponen aunque Postgres los conserve — cuesta nada y el candado los exige.
 *
 * ⛔ **Lo que esto NO afirma:** que el número que cita el negocio SEA este neto. Hay precedente
 * medido en contra — `VERDAD_ABSOLUTA` §16.6: la pantalla de utilidad de Kepler rotulada
 * *«Monto sin IVA»* **sí traía el impuesto** ($2,237,689 escondidos en $26,764,462). Acá se
 * publica una cifra **definida y arbitrada**; a qué reporte de Kepler corresponde se ancla
 * mirando ese reporte, no suponiéndolo.
 *
 * Idempotente (`CREATE OR REPLACE`).
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_kepler_vecinal_sales_docs AS
    SELECT '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
           btrim(h.sucursal) AS warehouse_code,
           btrim(h.c12) AS route_no,
           'WIN-'::text || btrim(h.c12) AS route_code,
           NULLIF(btrim(COALESCE(v.c3, ''::text)), ''::text) AS route_name,
           h.c9::date AS business_date,
           btrim(h.c6) AS folio,
           btrim(h.c5::text) AS caja,
           NULLIF(NULLIF(btrim(COALESCE(h.c10, ''::text)), ''::text), '0001'::text) AS cliente,
           h.c16 AS total,
           COALESCE(h.c13, 0::numeric) AS descuento,
           COALESCE(h.c14, 0::numeric) AS impuesto,
           -- [VEC.14] IEPS del documento. Verificado: la razón se pega a 0.080 en 417 docs.
           COALESCE(h.c15, 0::numeric) AS ieps,
           -- La venta SIN impuestos. Se publica calculada acá y no en cada consumidor: cuando
           -- cada pantalla re-deriva una definición, divergen — y el que netee sólo por IVA se
           -- queda corto por el IEPS sin enterarse.
           h.c16 - COALESCE(h.c14, 0::numeric) - COALESCE(h.c15, 0::numeric) AS neto
      FROM kepler_ods.kdm1 h
      LEFT JOIN kepler_ods.kduv v
        ON btrim(v.sucursal) = btrim(h.sucursal) AND btrim(v.c2) = btrim(h.c12)
     WHERE h.c2 = 'U'::text AND h.c3 = 'D'::text AND h.c4::integer = 10
       AND btrim(COALESCE(h.c12, ''::text)) ~ '^[0-9]V[0-9]'::text
       AND btrim(COALESCE(h.c1, ''::text)) = btrim(h.sucursal)
       AND COALESCE(NULLIF(btrim(h.c43), ''::text), ''::text) <> 'C'::text
       AND h.c9::date <= (now() AT TIME ZONE 'America/Mexico_City'::text)::date`);

  // ⚠️ ADR-057: no se dan por heredados. El candado los verifica por metadata.
  await knex.raw(`ALTER VIEW analytics.v_kepler_vecinal_sales_docs SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_kepler_vecinal_sales_docs TO app_runtime`);
  await knex.raw(`GRANT SELECT ON analytics.v_kepler_vecinal_sales_docs TO dev_ro`);
  await knex.raw(`
    COMMENT ON VIEW analytics.v_kepler_vecinal_sales_docs IS
      '[VEC.14] Venta vecinal U-D-10 al grano de documento. total=c16 CON impuestos; neto=c16-IVA-IEPS. El IEPS (c15) viaja aparte porque netear solo por IVA deja $69,251.27 adentro en sep-2026 (63% de los documentos lo llevan).'`);
};

/**
 * ⛔⛔ **NO-OP DELIBERADO, y acá está por qué — no es pereza.**
 *
 * `CREATE OR REPLACE VIEW` **no puede quitar columnas**: el único `down` literal sería
 * `DROP VIEW ... CASCADE` + recrear. Se midió qué arrastra ese CASCADE contra prod:
 *
 *     n0  vista      analytics.v_kepler_vecinal_sales_docs
 *     n1  vista      analytics.v_kepler_vecinal_monthly
 *     n2  MATVISTA   analytics.mv_kepler_vecinal_monthly   <- con su PK UNIQUE
 *
 * O sea que un `down` "fiel" se lleva puesta la matvista que la matriz de
 * `/comercial/ventas-por-ruta` lee, **y su índice UNIQUE**, que es lo que permite el
 * `REFRESH CONCURRENTLY` cada 30 min. Un `down` que rompe la pantalla para quitar dos columnas
 * que nadie estaba obligado a leer es peor que el estado que revierte.
 *
 * ⭐ Y las columnas son **aditivas e inertes**: `v_kepler_vecinal_monthly` —su único consumidor—
 * selecciona por nombre, no con `*`, así que dejarlas no cambia una sola cifra publicada.
 *
 * Si de verdad hace falta quitarlas, es una migración NUEVA que recree los tres objetos **y sus
 * dos índices**, no este `down`. Queda declarado acá en vez de fingir que revierte.
 *
 * @param { import("knex").Knex } knex
 */
exports.down = async function down(knex) {
  void knex;
};
