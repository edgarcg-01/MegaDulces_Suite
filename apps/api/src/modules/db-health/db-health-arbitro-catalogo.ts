/**
 * `[CANON.6.11]` ÁRBITRO del catálogo mantenido por evento: tres sensores de `db-health` que dicen si el
 * hop-2 de la ingesta dejó algo sin tomar.
 *
 * Desde CANON.6.8–6.10 tres datos de `catalog.products` ya no los reescribe un nocturno: los mantiene el
 * hop-2 (`services/feeds-ingest`) AL LLEGAR el cambio de Kepler, y si un normalizador falla se reintenta
 * partiendo el lote. Lo que siga sin tomarse no lo vería nadie — por eso estos sensores: comparan lo
 * guardado contra lo que la regla dice HOY sobre `kepler_ods` y **deben dar 0**. Es el «reloj que sólo se
 * tolera como árbitro que alarma» del anexo CANON §8.0: el escáner de `db-health` ya corre cada 5 min y
 * abre la alerta (warn → bandeja; critical → además correo).
 *
 *   markup  — `markup_pct` vs promedio de `kdpv_prod_util.c6` en la '03'   (normalizeMarkup)
 *   promo   — `is_promo` vs la regla única de CANON.6.9                     (normalizePromo)
 *   nombres — `nombre` vs la identidad retail-primero de `kdii`, SIN contar los que frena la unique
 *             (marca, nombre): Kepler llama «INHABILITADO»/«* DESCONTINUADO» a varios de una misma
 *             marca y sólo uno puede llevar ese nombre                       (normalizeProductsFromOds)
 *
 * ⚠️ La regla está escrita DOS veces a propósito — aquí en SQL y en el normalizador en JS — y la prueba
 * `database/tests/test-newdb-arbitro-catalogo.js` las cruza: con el normalizador recién corrido el sensor
 * da 0, y con un valor alterado da exactamente uno. Si alguien cambia una sin la otra, esa prueba lo ve.
 * Lo que este árbitro NO puede ver: que la regla misma esté mal (para eso los dos lados dirían lo mismo).
 *
 * Veredicto, codificado como EDAD porque `classify()` sólo sabe leer edad (mismo recurso que
 * `cedis_kepler_saldo`), con `warnH 24 / critH 48`:
 *   0 difieren          → `now()`                    → ok
 *   1–50                → `now() - 30 h`             → warn  (un evento que no se tomó)
 *   más de 50           → `now() - 100 días`         → critical (el hop-2 de esa tabla no corre)
 *   0 productos a la vista → `now() - 100 días` + «NO MEDIDO» (sin tenant o sin permiso: nunca verde)
 * Un evento a medio camino (fila ya en el ODS, normalizador aún corriendo, ~1–2 s) puede dar un warn de
 * un ciclo: se resuelve solo en el siguiente escaneo.
 *
 * ⛔ FECHA DE RETIRO (Edgar, 2026-11-12: el reloj sólo como árbitro, y con fecha de retiro). Cada sensor
 * PIDE SU PROPIO RETIRO —se pone en warn con «CUMPLIÓ … retirar este sensor»— cuando su script nocturno
 * lleva 30 días sin correr (`analytics.cron_run_log`) y en esos 30 días no tuvo ni una alerta
 * (`analytics.db_health_alerts`). Con la ingesta desplegada esta semana, cae a mediados de diciembre. Si el
 * nocturno sigue corriendo, o hubo una alerta, NO se retira y la nota lo dice. Retirarlo = borrar su
 * entrada en `db-health.service.ts` y su SQL de aquí.
 *
 * La falla por EVENTO (la que el hop-2 escribe en `analytics.hop2_fallas` en el momento) tiene su propio
 * sensor, `hop2_fallas`: ése no compara nada, sólo lee lo que el hop-2 registró. Ése no se retira con
 * éstos: es la alarma del hop-2 mismo.
 *
 * Sin acentos graves en los SQL de abajo: viven en template literals. Costo medido en prod el 12-nov:
 * markup ~85 ms, promo ~150 ms, nombres ~300–380 ms; marcas ~200–450 ms y códigos ~400 ms (CANON.6.12/6.14).
 */

const T = `'00000000-0000-0000-0000-00000000d01c'`;
const TOPE_WARN = 50;

/**
 * Las dos columnas que espera `db-health`, a partir de un CTE `c(vistos, difieren)` que el sensor deja
 * abierto. Agrega `ret` (¿ya cumplió su condición de retiro?). `paso` = el script nocturno que este sensor
 * reemplaza; `llaves` = sus `cron_run_log.job_key` EXACTAS (con `LIKE '%…'` recorría las 2.18 M filas de la
 * bitácora: +500 ms por sensor; con la llave exacta va por `ix_crl_job`).
 */
function veredicto(clave: string, que: string, comoCerrar: string, paso: string, llaves: string[],
                   difiere = `con ${que} distinto al de Kepler`): string {
  const corridas = `analytics.cron_run_log WHERE tenant_id = ${T}
                       AND job_key = ANY(ARRAY[${llaves.map((k) => `'${k}'`).join(', ')}])`;
  return `,
  ret AS MATERIALIZED (
    SELECT NOT EXISTS (SELECT 1 FROM ${corridas} AND finished_at > now() - interval '30 days')
           AND NOT EXISTS (SELECT 1 FROM analytics.db_health_alerts
                            WHERE source_key = '${clave}' AND last_seen_at > now() - interval '30 days') AS retirable,
           (SELECT max(finished_at) FROM ${corridas}) AS ultimo_nocturno)
    SELECT CASE WHEN c.vistos = 0 THEN now() - interval '100 days'
                WHEN c.difieren = 0 AND ret.retirable THEN now() - interval '30 hours'
                WHEN c.difieren = 0 THEN now()
                WHEN c.difieren <= ${TOPE_WARN} THEN now() - interval '30 hours'
                ELSE now() - interval '100 days' END AS last_update,
           CASE WHEN c.vistos = 0 THEN 'NO MEDIDO: el sensor no ve catalog.products (sin tenant o sin permiso)'
                WHEN c.difieren = 0 AND ret.retirable
                  THEN 'CUMPLIÓ: 0 difieren, 30 días sin ${paso} y sin una alerta — retirar este sensor ([CANON.6.11])'
                WHEN c.difieren = 0
                  THEN '${que} al día con Kepler: 0 difieren de ' || c.vistos || ' productos · se retira con 30 días sin ${paso}'
                       || coalesce(' (corrió por última vez el ' || to_char(ret.ultimo_nocturno AT TIME ZONE 'America/Mexico_City', 'DD/MM') || ')', '')
                       || ' y sin alertas'
                ELSE c.difieren || ' ${difiere}: el hop-2 no tomó su cambio' ||
                     CASE WHEN c.difieren > ${TOPE_WARN} THEN ' (son demasiados: ¿corre el hop-2 de esa tabla?)' ELSE '' END ||
                     '. ${comoCerrar}' END AS note_extra
      FROM c, ret`;
}

const VISTOS = `(SELECT count(*) FROM catalog.products WHERE tenant_id = ${T} AND deleted_at IS NULL)`;

/** Markup: misma regla que `normalizeMarkup` (sucursal de referencia '03' = MARGIN_BRANCH por defecto). */
export const ARBITRO_MARKUP_SQL = `
  WITH f AS (
    SELECT c1 AS sku, round(avg(c6::numeric), 4) AS markup
      FROM kepler_ods.kdpv_prod_util
     WHERE sucursal = '03' AND c6 IS NOT NULL AND btrim(coalesce(c1, '')) <> ''
     GROUP BY c1),
  c AS MATERIALIZED (
    SELECT ${VISTOS} AS vistos,
           count(*) FILTER (WHERE p.markup_pct IS DISTINCT FROM f.markup) AS difieren
      FROM f JOIN catalog.products p ON p.sku = f.sku AND p.tenant_id = ${T} AND p.deleted_at IS NULL)
  ${veredicto('catalogo_markup_evento', 'markup', 'Medir: node database/importers/kepler/import-margin.js; cerrar: --apply', 'import-margin.js',
    ['feed_nightly/import-margin.js'])}`;

/** Promo: misma regla que `normalizePromo` (todas las filas, borradas incluidas). */
export const ARBITRO_PROMO_SQL = `
  WITH k AS (
    SELECT btrim(c1) AS sku, max(c90::numeric) AS maxp
      FROM kepler_ods.kdii
     WHERE btrim(coalesce(c1, '')) <> '' AND btrim(sucursal) <> '00'
     GROUP BY btrim(c1)),
  r AS (
    SELECT p.is_promo AS antes,
           (CASE WHEN k.maxp IS NOT NULL THEN k.maxp <= 0.05 ELSE p.is_promo END)
           OR (p.deleted_at IS NULL AND (
                 coalesce(p.cost_base > 0 AND p.cost_base <= 0.05, false)
              OR (upper(p.nombre) LIKE '%= GRATIS%' AND (p.cost_base IS NULL OR p.cost_base <= 0.05)))) AS promo
      FROM catalog.products p LEFT JOIN k ON k.sku = p.sku
     WHERE p.tenant_id = ${T}),
  c AS MATERIALIZED (SELECT ${VISTOS} AS vistos, count(*) FILTER (WHERE promo IS DISTINCT FROM antes) AS difieren FROM r)
  ${veredicto('catalogo_promo_evento', 'la marca de promo', 'Medir: node database/importers/kepler/repoint-catalog-prices.js; cerrar: --apply', 'repoint-catalog-prices.js',
    ['feed_prices/repoint-catalog-prices.js --solo-promo', 'feed_nightly/repoint-catalog-prices.js --solo-promo',
     'feed_prices/repoint-catalog-prices.js --sync', 'feed_nightly/repoint-catalog-prices.js --gap-fill-only'])}`;

/** Nombres: identidad retail-primero de `kdii` (`identitySnapshotSql`), sin los que frena la unique. */
//  Atajo EXACTO, para no ordenar las ~76k filas de kdii en cada escaneo (eso costaba 0.6–5 s): un producto
//  cuyo nombre coincide con TODAS sus filas de kdii no puede diferir del ganador, así que la regla de
//  desempate (retail primero, precio más alto, sucursal menor) sólo se aplica a los que difieren de ALGUNA
//  fila — incluido el caso CEDIS contra tiendas (H12). Hoy son ~11.
export const ARBITRO_NOMBRES_SQL = `
  WITH cand AS MATERIALIZED (
    SELECT DISTINCT p.sku
      FROM kepler_ods.kdii k
      JOIN catalog.products p ON p.sku = btrim(k.c1) AND p.tenant_id = ${T} AND p.deleted_at IS NULL
     WHERE btrim(coalesce(k.c2, '')) <> '' AND p.nombre IS DISTINCT FROM btrim(k.c2)),
  una AS (
    SELECT DISTINCT ON (btrim(k.c1)) btrim(k.c1) AS sku, btrim(k.c2) AS nombre, btrim(k.c3::text) AS linea
      FROM kepler_ods.kdii k
     WHERE btrim(k.c1) IN (SELECT sku FROM cand) AND btrim(coalesce(k.c2, '')) <> ''
     ORDER BY btrim(k.c1), (btrim(k.sucursal) <> '00') DESC, k.c90::numeric DESC NULLS LAST, btrim(k.sucursal)),
  d AS (
    SELECT p.id, p.brand_id, u.nombre,
           CASE WHEN btrim(upper(p.nombre)) <> btrim(upper(u.nombre))
                THEN coalesce((SELECT b.id FROM catalog.brands b WHERE b.tenant_id = ${T} AND b.deleted_at IS NULL
                                 AND btrim(b.code) = u.linea LIMIT 1), p.brand_id)
                ELSE p.brand_id END AS marca
      FROM una u JOIN catalog.products p ON p.sku = u.sku AND p.tenant_id = ${T} AND p.deleted_at IS NULL
     WHERE p.nombre IS DISTINCT FROM u.nombre),
  c AS MATERIALIZED (
    SELECT ${VISTOS} AS vistos,
           (SELECT count(*) FROM d WHERE NOT EXISTS (
              SELECT 1 FROM catalog.products p2 WHERE p2.tenant_id = ${T} AND p2.id <> d.id
                 AND p2.brand_id = d.marca AND p2.nombre = d.nombre)) AS difieren)
  ${veredicto('catalogo_nombres_evento', 'nombre', 'Medir: node database/importers/kepler/repoint-catalog-names.js; cerrar: --apply', 'repoint-catalog-names.js',
    ['feed_nightly/repoint-catalog-names.js'])}`;

/**
 * `[CANON.6.12]` Marcas: misma regla que `normalizeBrandsFromKdig` (y `normalizeProductsFromOds` para SIN-LINEA).
 * Cuenta dos cosas que deben ser 0:
 *   · nombres de línea de `kdig` cuyo código no es de ninguna marca viva y que la regla daría de alta (el nombre
 *     no es de ninguna marca, viva o borrada) o adoptaría (es de UNA marca viva sin código). Los conflictos —el
 *     nombre ya es de otra marca con código— y los nombres borrados en la dedup NO cuentan: son decisión, no hueco;
 *   · productos vivos en SIN-LINEA cuya línea (identidad retail-primero de `kdii`) ya es una marca viva, sin
 *     contar los que frena la unique (marca, nombre).
 * Sólo mira los productos en SIN-LINEA (~250), no todo `kdii`: ~10 ms de catálogo + un recorrido de `kdii`.
 */
export const ARBITRO_MARCAS_SQL = `
  WITH k AS (
    SELECT DISTINCT ON (btrim(c1)) btrim(c1) AS code, upper(btrim(regexp_replace(c2, '\\s+', ' ', 'g'))) AS nombre
      FROM kepler_ods.kdig
     WHERE btrim(coalesce(c1, '')) <> '' AND btrim(coalesce(c2, '')) <> ''
     ORDER BY btrim(c1), btrim(sucursal)),
  alta AS (
    SELECT DISTINCT k.nombre FROM k
     WHERE NOT EXISTS (SELECT 1 FROM catalog.brands b WHERE b.tenant_id = ${T} AND b.deleted_at IS NULL AND btrim(b.code) = k.code)
       AND (NOT EXISTS (SELECT 1 FROM catalog.brands b WHERE b.tenant_id = ${T} AND btrim(upper(b.nombre)) = k.nombre)
            OR (SELECT count(*) FROM catalog.brands b WHERE b.tenant_id = ${T} AND b.deleted_at IS NULL
                   AND btrim(upper(b.nombre)) = k.nombre) = 1
               AND EXISTS (SELECT 1 FROM catalog.brands b WHERE b.tenant_id = ${T} AND b.deleted_at IS NULL
                              AND b.code IS NULL AND btrim(upper(b.nombre)) = k.nombre))),
  sl AS MATERIALIZED (
    SELECT p.id, p.sku, p.nombre
      FROM catalog.products p JOIN catalog.brands b ON b.id = p.brand_id AND b.code = 'SIN-LINEA'
     WHERE p.tenant_id = ${T} AND p.deleted_at IS NULL AND p.sku IS NOT NULL),
  una AS (
    SELECT DISTINCT ON (btrim(k.c1)) btrim(k.c1) AS sku, btrim(k.c3::text) AS linea
      FROM kepler_ods.kdii k
     WHERE btrim(k.c1) IN (SELECT sku FROM sl) AND btrim(coalesce(k.c2, '')) <> ''
     ORDER BY btrim(k.c1), (btrim(k.sucursal) <> '00') DESC, k.c90::numeric DESC NULLS LAST, btrim(k.sucursal)),
  mov AS (
    SELECT sl.id, sl.nombre, b.id AS marca
      FROM sl JOIN una u ON u.sku = sl.sku
      JOIN catalog.brands b ON b.tenant_id = ${T} AND b.deleted_at IS NULL AND btrim(b.code) = u.linea AND b.code <> 'SIN-LINEA'),
  c AS MATERIALIZED (
    SELECT ${VISTOS} AS vistos,
           (SELECT count(*) FROM alta)
           + (SELECT count(*) FROM mov WHERE NOT EXISTS (
                SELECT 1 FROM catalog.products p2 WHERE p2.tenant_id = ${T} AND p2.id <> mov.id
                   AND p2.brand_id = mov.marca AND p2.nombre = mov.nombre)) AS difieren)
  ${veredicto('catalogo_marcas_evento', 'marca', 'Medir: node database/importers/kepler/import-brands-lineas.js; cerrar: --apply', 'import-brands-lineas.js',
    ['feed_catalog/import-brands-lineas.js'],
    'sin tomar de Kepler (líneas sin marca, o productos en SIN-LINEA cuya línea ya es marca)')}`;

/**
 * `[CANON.6.14]` Códigos de barras: misma regla que `computeBarcodes` (`services/feeds-ingest/barcode-compute.js`)
 * — por plaza, slots BASE c7/c93 (unidad c11, PZA si falta), U2 c82/c95 (c80), U3 c85 (c83); código real = 8–14
 * dígitos, no todo ceros, distinto del SKU; un (sku, código) en varios slots se queda con el de mayor precedencia.
 * Cuenta tres cosas que deben ser 0:
 *   · faltan  — Kepler trae el código, el producto vive, y no hay fila viva con ese (sku, código);
 *   · sobran  — fila viva `kepler_*` cuyo (sku, código) Kepler ya no trae (lo que se escapaba cuando Kepler BORRABA
 *               una fila de `kdii`, antes de `[CANON.6.14]`);
 *   · como Wincaja — fila viva `wincaja` de un (sku, código) que Kepler sí trae (el hop-2 la vuelve `kepler_*`).
 * NO compara unidad ni factor: el mismo código con unidades distintas entre plazas se desempata en el orden en que
 * llegan las filas, y eso no es determinista entre el sensor y el hop-2. Las filas `wincaja` cuyo código Kepler ya
 * retiró tampoco cuentan: son decisión aparte (102 el 12-nov), no hueco del hop-2.
 */
//  Para contar PRESENCIA no hace falta la precedencia entre unidades: basta el conjunto (sku, código). Un slot cuya
//  unidad no existe (c80 / c83 vacíos) no aporta código, como en `computeBarcodes`. Cada código viene repetido en
//  las 9 plazas: se deduplica ANTES de la regex (medido en prod: la regex sobre los ~430 mil valores crudos costaba
//  ~500 ms; el sensor entero pasó de ~1.1 s a ~400 ms en prod, con el mismo resultado).
export const ARBITRO_CODIGOS_SQL = `
  WITH kep AS MATERIALIZED (
    SELECT sku, bc FROM (
      SELECT DISTINCT btrim(k.c1) AS sku, btrim(v) AS bc
        FROM kepler_ods.kdii k,
             unnest(array_remove(ARRAY[k.c7, k.c93,
               CASE WHEN btrim(coalesce(k.c80, '')) <> '' THEN k.c82 END,
               CASE WHEN btrim(coalesce(k.c80, '')) <> '' THEN k.c95 END,
               CASE WHEN btrim(coalesce(k.c83, '')) <> '' THEN k.c85 END], NULL)) AS v
       WHERE btrim(coalesce(k.c1, '')) <> '') x
     WHERE length(bc) BETWEEN 8 AND 14 AND bc ~ '^[0-9]{8,14}$' AND bc !~ '^0+$' AND ltrim(bc, '0') <> ltrim(sku, '0')),
  pb AS MATERIALIZED (
    SELECT btrim(sku) AS sku, barcode, source FROM catalog.product_barcodes
     WHERE tenant_id = ${T} AND deleted_at IS NULL),
  c AS MATERIALIZED (
    SELECT ${VISTOS} AS vistos,
           (SELECT count(*) FROM kep
             WHERE EXISTS (SELECT 1 FROM catalog.products p WHERE p.tenant_id = ${T} AND btrim(p.sku) = kep.sku AND p.deleted_at IS NULL)
               AND NOT EXISTS (SELECT 1 FROM pb WHERE pb.sku = kep.sku AND pb.barcode = kep.bc))
         + (SELECT count(*) FROM pb WHERE pb.source LIKE 'kepler\\_%'
               AND NOT EXISTS (SELECT 1 FROM kep WHERE kep.sku = pb.sku AND kep.bc = pb.barcode))
         + (SELECT count(*) FROM pb WHERE pb.source = 'wincaja'
               AND EXISTS (SELECT 1 FROM kep WHERE kep.sku = pb.sku AND kep.bc = pb.barcode)) AS difieren)
  ${veredicto('catalogo_codigos_evento', 'código de barras', 'Medir: node database/importers/kepler/import-product-barcodes.js; cerrar: --apply', 'import-product-barcodes.js',
    ['feed_prices/import-product-barcodes.js'],
    'códigos sin tomar de Kepler (faltan, sobran o siguen como Wincaja)')}`;

/**
 * `[CANON.6.11]` La alarma por EVENTO del hop-2: lo que el propio hop-2 escribió en `analytics.hop2_fallas`
 * cuando un normalizador siguió fallando después de reintentar por partes. No compara nada contra Kepler:
 * sólo lee el registro. Una falla en las últimas 24 h → warn (más de 50 → critical); se limpia sola a las
 * 24 h, y si el dato sigue mal lo dicen los tres árbitros de arriba. Sin productos a la vista → NO MEDIDO
 * (la misma RLS que cegaría el catálogo cegaría esta tabla: un 0 ciego sería un verde falso).
 */
export const HOP2_FALLAS_SQL = `
  WITH f AS (
    SELECT tabla, normalizador, llaves FROM analytics.hop2_fallas
     WHERE tenant_id = ${T} AND created_at > now() - interval '24 hours'),
  c AS MATERIALIZED (
    SELECT ${VISTOS} AS vistos, (SELECT count(*) FROM f) AS n,
           (SELECT string_agg(DISTINCT tabla || ':' || normalizador, ', ') FROM f) AS donde,
           (SELECT string_agg(l, ', ') FROM (SELECT DISTINCT unnest(llaves) AS l FROM f ORDER BY 1 LIMIT 8) x) AS llaves)
  SELECT CASE WHEN c.vistos = 0 THEN now() - interval '100 days'
              WHEN c.n = 0 THEN now()
              WHEN c.n <= ${TOPE_WARN} THEN now() - interval '30 hours'
              ELSE now() - interval '100 days' END AS last_update,
         CASE WHEN c.vistos = 0 THEN 'NO MEDIDO: el sensor no ve catalog.products (sin tenant o sin permiso)'
              WHEN c.n = 0 THEN 'sin fallas del hop-2 en las últimas 24 h'
              ELSE c.n || ' fallas del hop-2 en 24 h (' || c.donde || ') · llaves: ' || coalesce(c.llaves, '?') ||
                   ' — quedan como estaban hasta su próximo cambio; detalle en analytics.hop2_fallas' END AS note_extra
    FROM c`;
