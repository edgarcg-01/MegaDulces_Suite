'use strict';
/**
 * `[VEC.7]` — **Una sola línea de venta de Kepler, de la que derivan el sell-out y la venta por
 * ruta.** (ADR-056: un primitivo que resuelve un dominio y no se generaliza es deuda.)
 *
 * Pedido de Edgar al cerrar `[VEC.0-6.2]`: *"sell-out debería compartir tabla o relación con
 * ventas por ruta para mantener una fiabilidad de datos y verdad absoluta compartida"*. Tiene
 * nombre propio en este repo y está medido: hoy **cada superficie deriva por su cuenta el mismo
 * hecho**, y por eso se contradicen.
 *
 * ── Lo que la medición muestra ──────────────────────────────────────────────────────────────
 *
 * **44 vistas de `analytics` leen `kdm1`/`kdm2`.** De las que miden venta, ninguna comparte
 * reglas con otra: unas unen por caja y otras no, unas excluyen cancelados y otras no, unas
 * acotan el documento a su plaza y otras no. No es un problema estético — cada diferencia es una
 * cifra distinta para la misma pregunta.
 *
 * El caso que lo disparó, septiembre-2026, rutas vecinales:
 *
 *     venta real (U-D-10)                        $1,943,014.72
 *     re-facturación del mismo ticket (U-D-12)   $1,096,675.54   ← el sell-out la suma
 *                                                ─────────────
 *     lo que el sell-out publica                 $3,039,690.26   = 36.1% inflado
 *
 * ⚠️ Y en el total de una plaza **no se nota**: PH agosto da $10,557,889.02 en el sell-out contra
 * $10,505,404.24 del árbitro `kdm1.c16` — medio punto de diferencia. Coinciden porque **los dos
 * cuentan el espejo**. *Dos derivaciones que comparten el error se confirman entre sí*, que es
 * exactamente lo que una verdad compartida tiene que impedir.
 *
 * ── Qué resuelve esta vista, y qué deja a cada consumidor ───────────────────────────────────
 *
 * Resuelve **una vez** lo que hoy cada uno resuelve a su manera:
 *
 *   · la llave del documento **incluye la CAJA** (`c5`) — sin ella se pegan las líneas de los
 *     tickets homónimos de otras cajas (`[VEC.0]`: 2.07× en la venta vecinal);
 *   · el documento cuenta en **su** plaza (`c1 = sucursal`), porque `kduv` está replicado;
 *   · los **cancelados** (`c43 = 'C'`) quedan fuera;
 *   · el **canal** y el **vendedor/ruta** se deciden en un solo lugar;
 *   · ⭐ **`es_refactura`** marca el documento espejo en vez de esconderlo.
 *
 * NO decide por nadie: el `doc_tipo` viaja como columna y cada superficie elige su universo. El
 * sell-out quiere `8/10/12`; la venta por ruta, `10`. Lo que ya no puede pasar es que elijan
 * **reglas** distintas para el mismo universo.
 *
 * ── `es_refactura`: por qué una regla y no un cruce ─────────────────────────────────────────
 *
 * En las rutas vecinales, `U-D-12` ("Factura Cont No Fiscal") re-emite el ticket de caja: al
 * repartidor le piden comprobante. Medido por línea (mismo cliente, día, SKU y cantidad), **con
 * placebo contra otra ruta**: PH 99.8%, Morelia 2V001 100%, 2V003 97.9%, placebo **0** en las
 * tres. Fuera de las rutas, `U-D-12` es venta genuina en el 68.5% — por eso la marca **sólo**
 * aplica a documentos con código de ruta vecinal.
 *
 * ⛔ Se descartó calcular la marca cruzando documento contra documento: a nivel ticket el cruce
 * por (cliente, día, importe) acierta **133 de 384** en PH, porque el espejo agrupa distinto. El
 * cruce fino que sí acierta es por línea, y hacerlo dentro de una vista en vivo cuesta un
 * self-join sobre 4.9 millones de renglones. La regla es barata, está arbitrada y **declara su
 * residuo**: ~1.2% de esas líneas no tiene gemela y se marca igual.
 *
 * ⚠️ Esta vista **no cambia ninguna cifra publicada todavía**. Es aditiva a propósito: migrar
 * `mv_kepler_sales_daily` a leer de acá baja la venta publicada del sell-out ~$1.1M/mes y exige
 * recrear una matview de 878k filas con 5 objetos dependientes. Eso va en ventana y con aviso,
 * no de pasada.
 *
 * @param { import("knex").Knex } knex
 */

const T = `'00000000-0000-0000-0000-00000000d01c'::uuid`;
const VISTA = 'analytics.v_kepler_sales_lines';

const DEF = `
SELECT
  ${T}                                                    AS tenant_id,
  btrim(h.sucursal)                                       AS warehouse_code,
  (h.c4)::integer                                         AS doc_tipo,
  btrim((h.c5)::text)                                     AS caja,
  btrim(h.c6)                                             AS folio,
  (h.c9)::date                                            AS business_date,
  -- El ticket es (plaza, caja, folio): el folio sólo es único DENTRO de su caja.
  btrim(h.sucursal) || '-' || btrim((h.c5)::text) || '-' || btrim(h.c6) AS ticket_id,
  NULLIF(NULLIF(btrim(COALESCE(h.c10, '')), ''), '0001')  AS cliente,
  btrim(COALESCE(h.c12, ''))                              AS vendor_code,
  NULLIF(btrim(COALESCE(v.c3, '')), '')                   AS vendor_name,
  CASE
    WHEN btrim(COALESCE(h.c12, '')) ~ '^[0-9]V[0-9]' THEN 'vecinal'
    WHEN (h.c4)::integer = 8  THEN 'mayoreo'
    WHEN (h.c4)::integer = 12 THEN 'credito'
    ELSE 'mostrador'
  END                                                     AS canal,
  -- ⭐ El documento espejo se MARCA, no se esconde: cada consumidor decide si lo suma.
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
  '[VEC.7] La linea de venta de Kepler, resuelta UNA vez (ADR-056). La llave del documento '
  + 'incluye la CAJA (c5), el documento cuenta en SU plaza (c1=sucursal) y los cancelados quedan '
  + 'fuera. doc_tipo viaja como columna: el sell-out quiere 8/10/12 y la venta por ruta 10 — lo '
  + 'que no pueden es usar REGLAS distintas para el mismo universo. es_refactura marca el '
  + 'U-D-12 que re-emite un ticket de ruta vecinal (medido 97.9-100% por linea, placebo 0; '
  + 'residuo ~1.2% declarado). Arbitro de cualquier total: kdm1.c16. NO la lee nadie todavia: '
  + 'migrar mv_kepler_sales_daily baja la venta publicada ~$1.1M/mes y va en ventana.';

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

exports.up = async function up(knex) {
  await knex.raw(`CREATE OR REPLACE VIEW ${VISTA} AS ${DEF}`);
  await knex.raw(`ALTER VIEW ${VISTA} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${VISTA} IS ${lit(COMENTARIO)}`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VISTA}`);
};
