'use strict';
/**
 * `[VEC.7.1]` — **La canónica reproduce las reglas de canal del sell-out, no una versión propia.**
 *
 * `[VEC.7]` creó `analytics.v_kepler_sales_lines` como fuente compartida y le puso una columna
 * `canal` **más simple** que la que `mv_kepler_sales_daily` usa hoy. Revisado antes de que nadie
 * la adopte: migrar el sell-out a esa versión habría cambiado la clasificación de ventas que no
 * tienen nada que ver con las rutas vecinales.
 *
 * Lo que la versión simplificada se comía:
 *
 *   · **Canindo (plaza `06`)**: sus rutas 5001-5009 se reconocen por `kdm1.c67`, no por el
 *     vendedor. Sin esa rama, la venta de ruta de esa plaza caía en `mostrador`.
 *   · **`RUTA %` por nombre del vendedor** en `kduv.c3` — la rama que atrapa rutas que no llevan
 *     el código `NVNNN`.
 *   · El nombre del canal: el sell-out llama **`preventa`** a la vecinal desde el relabel de
 *     `[RS.9]`, y la canónica decía `vecinal`. Un consumidor que filtre por `'preventa'` se
 *     habría quedado sin filas, en silencio.
 *
 * ⭐ La lección es la que justifica toda esta fase: **una fuente compartida sólo sirve si es fiel
 * a lo que ya se publica.** Si al unificar cambio de paso las definiciones, no estoy unificando
 * — estoy agregando una tercera versión y rompiendo las dos que había.
 *
 * Ahora `canal` es **carácter por carácter** la expresión del sell-out, y lo que la canónica
 * aporta de nuevo viaja en columnas aparte (`es_vecinal`, `es_refactura`), que no pisan nada.
 *
 * ⚠️ El orden de las ramas importa y se conserva: la vecinal se evalúa **antes** que el `ruta`
 * genérico. Invertirlas reclasifica toda la venta vecinal.
 *
 * @param { import("knex").Knex } knex
 */

const T = `'00000000-0000-0000-0000-00000000d01c'::uuid`;
const VISTA = 'analytics.v_kepler_sales_lines';

/** Copiada de `mv_kepler_sales_daily`, sin tocar una coma. */
const CANAL = `
  CASE
    WHEN ((btrim(v.c3) ILIKE 'RUTA VECINAL%') OR (btrim(h.c12) ~ '^[0-9]+V[0-9]')) THEN 'preventa'
    WHEN ((btrim(v.c3) ILIKE 'RUTA %') OR (btrim(v.c3) ILIKE 'RUTA VECINAL%') OR (btrim(h.c12) ~ '^1V')) THEN 'ruta'
    WHEN ((btrim(h.sucursal) = '06') AND ((h.c4)::integer = 10) AND (btrim(h.c67) ~ '^500[1-9]$')) THEN 'ruta'
    WHEN ((h.c4)::integer = 8) THEN 'mayoreo'
    WHEN ((h.c4)::integer = 12) THEN 'credito'
    ELSE 'mostrador'
  END`;

const DEF = `
SELECT
  ${T}                                                    AS tenant_id,
  btrim(h.sucursal)                                       AS warehouse_code,
  (h.c4)::integer                                         AS doc_tipo,
  btrim((h.c5)::text)                                     AS caja,
  btrim(h.c6)                                             AS folio,
  (h.c9)::date                                            AS business_date,
  btrim(h.sucursal) || '-' || btrim((h.c5)::text) || '-' || btrim(h.c6) AS ticket_id,
  NULLIF(NULLIF(btrim(COALESCE(h.c10, '')), ''), '0001')  AS cliente,
  (btrim(h.sucursal) || ':' || btrim(COALESCE(h.c12, ''))) AS vendor_code,
  COALESCE(NULLIF(btrim(COALESCE(v.c3, '')), ''), NULLIF(btrim(COALESCE(h.c12, '')), ''), 'Sin vendedor') AS vendor_name,
  ${CANAL}                                                AS canal,
  (btrim(COALESCE(h.c12, '')) ~ '^[0-9]V[0-9]')           AS es_vecinal,
  ((h.c4)::integer = 12 AND btrim(COALESCE(h.c12, '')) ~ '^[0-9]V[0-9]') AS es_refactura,
  (h.c16)::numeric                                        AS total_documento,
  COALESCE((h.c13)::numeric, 0)                           AS descuento_documento,
  (d.c7)::integer                                         AS num_linea,
  btrim(d.c8)                                             AS sku,
  NULLIF(btrim(COALESCE(d.c10, '')), '')                  AS producto,
  NULLIF(upper(btrim(COALESCE(d.c11, ''))), '')           AS unidad,
  (d.c12)::numeric                                        AS precio_unitario,
  (d.c9)::numeric                                         AS qty,
  (d.c13)::numeric                                        AS importe
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
  AND (h.c4)::integer IN (8, 10, 12)
  AND btrim(COALESCE(h.c1, '')) = btrim(h.sucursal)
  AND COALESCE(NULLIF(btrim(h.c43), ''), '') <> 'C'
  AND (h.c9)::date <= ((now() AT TIME ZONE 'America/Mexico_City'))::date`;

const COMENTARIO =
  '[VEC.7.1] La linea de venta de Kepler, resuelta UNA vez (ADR-056). canal y vendor_code son '
  + 'CARACTER POR CARACTER los de mv_kepler_sales_daily — una fuente compartida solo sirve si es '
  + 'fiel a lo que ya se publica; lo nuevo viaja en es_vecinal / es_refactura, que no pisan nada. '
  + 'La llave del documento incluye la CAJA (c5), el documento cuenta en SU plaza y los '
  + 'cancelados quedan fuera. doc_tipo viaja como columna: cada superficie elige su universo, no '
  + 'sus reglas. Arbitro de cualquier total: kdm1.c16.';

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

exports.up = async function up(knex) {
  // Cambian columnas (canal pasa a 'preventa', entra es_vecinal) → no basta un REPLACE.
  await knex.raw(`DROP VIEW IF EXISTS ${VISTA}`);
  await knex.raw(`CREATE VIEW ${VISTA} AS ${DEF}`);
  await knex.raw(`ALTER VIEW ${VISTA} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${VISTA} IS ${lit(COMENTARIO)}`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VISTA}`);
};
