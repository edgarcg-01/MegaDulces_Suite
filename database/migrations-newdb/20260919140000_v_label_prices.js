/**
 * `[ETQ-ODS.1]` La etiqueta de anaquel, DERIVADA del ODS. Una sola fuente, una sola frescura.
 *
 * ── El defecto que cierra ───────────────────────────────────────────────────────────────────
 * Hoy la etiqueta mezcla DOS fuentes con frescuras distintas dentro del mismo papel:
 *
 *   `piece_price` (el precio tachado) ... ODS VIVO       (`commercial-labels.service.ts:340`,
 *                                                         `precioVivoDe` lee `kdii.c90`)  ~1-2 min
 *   mayoreo / caja / paquete / unidad .. TABLA `commercial.product_label_prices`, que puebla
 *                                        `import-label-data.js` en el grupo `prices`
 *                                        (crontab: minutos 02 y 32)                  hasta 32 min
 *
 * Y desde `[ETQ-AIDA.1]` el precio GRANDE pasó a ser `mayoreo x (1 - pct)` — o sea que el número
 * más grande de la etiqueta quedó colgando de la tabla batch mientras el tachado de al lado viene
 * del ODS vivo. Pueden contradecirse entre sí en la misma etiqueta.
 *
 * Medido en prod el 2026-09-19: **63 de 294 (21.4%)** de las etiquetas en promo de la plaza 05
 * tienen en la tabla un `wholesale_pack_price` distinto del que `kdpv_prod_util` dice AHORA
 * (peor caso $26.23); en la 08, 5 de 117. Y en el precio base difieren sólo 2 por plaza, pero el
 * peor es **$933.34**.
 *
 * ⛔ **Ese 21.4% era MÍO, no de la tabla.** El cuadre fila por fila lo refutó: se había medido
 * contra `min(c7)` mientras el importer elige el PRIMER peldaño alcanzable. Medido bien, sobre
 * **78,531 pares (sku, plaza)** de las 9 plazas:
 *
 *   content · barcode · barcode_format · pack_size · pack_price · sold_by_kg ....... 0 difieren
 *   piece_price · wholesale_pack_price · box_price ................................ 18 difieren
 *   wholesale_piece_* · wholesale_pack_min_qty · box_size · unit_base .............. 9 difieren
 *
 * Y las 18 son **2 SKUs x 9 plazas**, todas por rezago de la tabla — cero diferencias de lógica:
 *
 *   84234 SUPER VELA AGUA TUBO .. tabla $71.51 / mayoreo $70.88  vs  ODS $40.37 / $40.37
 *   96842 BLISTER FOAMY ......... tabla $74.69, unidad PAQ       vs  ODS $48.99, unidad PZA
 *
 * con `computed_at` de la tabla en 01:02 (23:32 en la plaza 08). O sea: el ERP bajó un precio a
 * la mitad y la etiqueta seguiría ofreciendo el mayoreo viejo, que además queda por ENCIMA del
 * precio de menudeo vivo. Es la misma familia del incidente que fundó la Fase OBS.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 * Porta `services/feeds-ingest/label-compute.js` a SQL, 1:1, sin reinventar nada:
 * `basePresentKey`, el selector de peldaño, `resolveUnits`, el barcode y `parseGramaje`.
 * Es la REGLA PRINCIPAL del proyecto aplicada: cero importers, todo del ODS, de una tabla
 * principal normalizada. `commercial.product_label_prices` queda como está hasta que el candado
 * de paridad explique cada diferencia; esta migración NO la toca ni la borra.
 *
 * ── Por qué los predicados se ven asimétricos (y no es descuido) ────────────────────────────
 * `kdii` tiene `ix_kdii_suc_sku` sobre `(btrim(sucursal), btrim(c1))` -> ahí el `btrim` VA.
 * `kdpv_prod_util` sólo tiene su PK sobre columnas CRUDAS `(sucursal, c1, c2, c3)` -> ahí el
 * `btrim` lo anula (GOTCHAS 28). Medido por BLOQUES, que es lo que no miente cuando la base está
 * del otro lado de la red: crudo **5 bloques**, con btrim **3,614**. Y se puede: `kdpv_prod_util`
 * no tiene padding en ninguna de sus 379,214 filas (verificado antes de escribirlo).
 *
 * ⚠️ Las expresiones regulares usan clases POSIX (`[0-9]`, `[[:space:]]`) y NO `\d`/`\s`: este
 * SQL viaja dentro de un template literal de JS, donde `\d` se convierte en `d` y la expresión
 * dejaría de matchear en silencio.
 */

/**
 * El gramaje sale del NOMBRE del producto (`kdii.c2`), igual que `parseGramaje`. El grupo 1 es el
 * número y el 3 la unidad; el grupo 4 emula el `(?![a-z0-9])` de JS, que Postgres no soporta.
 *
 * ⛔⛔ **Los cuantificadores van como `{0,1}` y NO como `?` — a propósito.** `knex.raw()` trata
 * CADA `?` del SQL como un placeholder de binding, así que un `?` de expresión regular sale
 * reescrito a `$1`, `$2`, `$3`… La primera versión de esta vista se creó **sin dar ningún error**
 * con la expresión `([0-9]+([.,][0-9]+)$1)[[:space:]]*(kilogramos$2|kgs$3|…)` grabada adentro, y
 * devolvía NULL en el 100% de las filas — 41,847 etiquetas se quedaban sin gramaje y el candado
 * de paridad fue lo único que lo vio. Es la misma colisión que documenta la Fase CV
 * (`pg-raw.util.ts`), en el sentido contrario.
 *
 * La otra salida era escapar (`\\?`), pero se descartó: deja el archivo lleno de escapes que el
 * próximo que lo lea va a "limpiar". `{0,1}` dice lo mismo y no se puede romper por accidente.
 */
const GRAMAJE = `regexp_match(btrim(k.c2::text),
  '([0-9]+([.,][0-9]+){0,1})[[:space:]]*(kilogramos{0,1}|kgs{0,1}|kilos{0,1}|gramos{0,1}|grs{0,1}|mililitros{0,1}|mls{0,1}|litros{0,1}|lts{0,1}|oz|kg|gr|ml|lt|k|g|l)([^a-z0-9]|$)', 'i')`;

// EAN/UPC válido o nada. `c7` manda; si no cuadra, se cae a `c95`.
const BC_RAW = `CASE WHEN btrim(k.c7::text) ~ '^([0-9]{13}|[0-9]{12}|[0-9]{8})$'
                     THEN btrim(k.c7::text) ELSE btrim(coalesce(k.c95::text,'')) END`;

const VIEW = `
CREATE OR REPLACE VIEW analytics.v_label_prices AS
SELECT
  btrim(k.sucursal::text)                       AS sucursal,
  btrim(k.c1)                                   AS sku,
  btrim(k.c2::text)                             AS name,
  g.content,
  CASE WHEN b.fmt IS NULL THEN NULL ELSE b.raw END AS barcode,
  b.fmt                                         AS barcode_format,
  k.c90::numeric                                AS piece_price,
  -- El mayoreo se reparte segun la unidad BASE, igual que assembleLabel(): con base agrupada
  -- (PAQ/CJA) el peldano de la base va a las columnas de PAQUETE y las de PIEZA quedan NULL.
  CASE WHEN bp.grouped THEN NULL ELSE bt.min_qty END AS wholesale_piece_min_qty,
  CASE WHEN bp.grouped THEN NULL ELSE bt.price   END AS wholesale_piece_price,
  u.pack_size,
  u.pack_price,
  CASE WHEN bp.grouped THEN bt.price
       WHEN bp.key = 'PZA' THEN pt.price END     AS wholesale_pack_price,
  CASE WHEN bp.grouped THEN bt.min_qty
       WHEN bp.key = 'PZA' THEN pt.min_qty END   AS wholesale_pack_min_qty,
  u.box_size,
  u.box_price,
  nullif(upper(btrim(k.c11::text)), '')         AS unit_base,
  (bp.key = 'KG')                               AS sold_by_kg,
  now()                                         AS computed_at
FROM kepler_ods.kdii k
CROSS JOIN LATERAL (
  SELECT key, key IN ('PAQ','CJA') AS grouped FROM (
    SELECT CASE WHEN upper(btrim(k.c11::text)) = 'KG'  THEN 'KG'
                WHEN upper(btrim(k.c11::text)) ~ '^[0-9]+$' THEN upper(btrim(k.c11::text))
                WHEN upper(btrim(k.c11::text)) = 'PAQ' THEN 'PAQ'
                WHEN upper(btrim(k.c11::text)) = 'CJA' THEN 'CJA'
                ELSE 'PZA' END AS key) z
) bp
-- El PRIMER peldano alcanzable (menor umbral), desempatado por menor precio. NO el mas barato:
-- medido en prod, el mas barato es casi siempre el mas profundo y la etiqueta terminaba pidiendo
-- el triple de cantidad para ahorrar menos del 1%.
LEFT JOIN LATERAL (
  SELECT u2.c7::numeric AS price, floor(u2.c4::numeric)::int AS min_qty
    FROM kepler_ods.kdpv_prod_util u2
   WHERE u2.sucursal = btrim(k.sucursal::text) AND u2.c1 = btrim(k.c1)
     AND btrim(u2.c2::text) = bp.key
     AND u2.c7::numeric > 0 AND floor(u2.c4::numeric)::int > 1
   ORDER BY floor(u2.c4::numeric)::int ASC, u2.c7::numeric ASC
   LIMIT 1) bt ON true
LEFT JOIN LATERAL (
  SELECT u3.c7::numeric AS price, floor(u3.c4::numeric)::int AS min_qty
    FROM kepler_ods.kdpv_prod_util u3
   WHERE u3.sucursal = btrim(k.sucursal::text) AND u3.c1 = btrim(k.c1)
     AND btrim(u3.c2::text) = 'PAQ'
     AND u3.c7::numeric > 0 AND floor(u3.c4::numeric)::int > 1
   ORDER BY floor(u3.c4::numeric)::int ASC, u3.c7::numeric ASC
   LIMIT 1) pt ON true
-- resolveUnits(): las dos ranuras de kdii, y la SEGUNDA pisa a la primera si las dos son PAQ
-- (es el orden en que las recorre el importer). Solo cuenta con factor > 1.
CROSS JOIN LATERAL (
  SELECT
    CASE WHEN btrim(k.c83::text)='PAQ' AND floor(k.c84::numeric)::int > 1 THEN floor(k.c84::numeric)::int
         WHEN btrim(k.c80::text)='PAQ' AND floor(k.c81::numeric)::int > 1 THEN floor(k.c81::numeric)::int END AS pack_size,
    CASE WHEN btrim(k.c83::text)='PAQ' AND floor(k.c84::numeric)::int > 1 THEN k.c92::numeric
         WHEN btrim(k.c80::text)='PAQ' AND floor(k.c81::numeric)::int > 1 THEN k.c91::numeric END AS pack_price,
    CASE WHEN btrim(k.c83::text)='CJA' AND floor(k.c84::numeric)::int > 1 THEN floor(k.c84::numeric)::int
         WHEN btrim(k.c80::text)='CJA' AND floor(k.c81::numeric)::int > 1 THEN floor(k.c81::numeric)::int END AS box_size,
    CASE WHEN btrim(k.c83::text)='CJA' AND floor(k.c84::numeric)::int > 1 THEN k.c92::numeric
         WHEN btrim(k.c80::text)='CJA' AND floor(k.c81::numeric)::int > 1 THEN k.c91::numeric END AS box_price
) u
CROSS JOIN LATERAL (
  SELECT raw, CASE WHEN raw ~ '^[0-9]{13}$' THEN 'EAN13'
                   WHEN raw ~ '^[0-9]{12}$' THEN 'UPC'
                   WHEN raw ~ '^[0-9]{8}$'  THEN 'EAN8' END AS fmt
    FROM (SELECT ${BC_RAW} AS raw) y
) b
CROSS JOIN LATERAL (
  SELECT CASE WHEN m IS NULL THEN NULL ELSE
    replace(m[1], ',', '.') || ' ' ||
    CASE WHEN lower(m[3]) = 'oz'                 THEN 'oz'
         WHEN lower(m[3]) LIKE 'k%'              THEN 'kg'
         WHEN lower(m[3]) LIKE 'ml%'             THEN 'ml'
         WHEN lower(m[3]) LIKE 'mili%'           THEN 'ml'
         WHEN lower(m[3]) LIKE 'g%'              THEN 'g'
         ELSE 'l' END
  END AS content
  FROM (SELECT ${GRAMAJE} AS m) x
) g
WHERE btrim(coalesce(k.c1,'')) <> '' AND k.c90::numeric > 0.05`;

exports.up = async function up(knex) {
  await knex.raw(VIEW);
  await knex.raw('GRANT SELECT ON analytics.v_label_prices TO app_runtime');
  await knex.raw(`COMMENT ON VIEW analytics.v_label_prices IS
    'derive-no-copy sobre kepler_ods.kdii + kdpv_prod_util: la etiqueta de anaquel por (sucursal, sku), con la MISMA logica que services/feeds-ingest/label-compute.js. Existe para que la etiqueta tenga UNA sola fuente y UNA sola frescura (~1-2 min del carril del ODS) en vez de mezclar el precio base vivo con el mayoreo/caja de una tabla batch de hasta 32 min. Predicados CRUDOS sobre kdpv_prod_util a proposito: su PK es sobre columnas sin btrim (5 bloques contra 3,614).'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_label_prices');
};
