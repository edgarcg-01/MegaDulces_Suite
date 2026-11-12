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
 * Sin acentos graves en los SQL de abajo: viven en template literals. Costo medido en prod el 12-nov:
 * markup ~70 ms, promo ~170 ms, nombres ~370 ms.
 */

const T = `'00000000-0000-0000-0000-00000000d01c'`;
const TOPE_WARN = 50;

/** Las dos columnas que espera `db-health` a partir de un CTE `c(vistos, difieren)`. */
function veredicto(que: string, comoCerrar: string): string {
  return `
    SELECT CASE WHEN c.vistos = 0 THEN now() - interval '100 days'
                WHEN c.difieren = 0 THEN now()
                WHEN c.difieren <= ${TOPE_WARN} THEN now() - interval '30 hours'
                ELSE now() - interval '100 days' END AS last_update,
           CASE WHEN c.vistos = 0 THEN 'NO MEDIDO: el sensor no ve catalog.products (sin tenant o sin permiso)'
                WHEN c.difieren = 0 THEN '${que} al día con Kepler: 0 difieren de ' || c.vistos || ' productos'
                ELSE c.difieren || ' con ${que} distinto al de Kepler: el hop-2 no tomó su cambio' ||
                     CASE WHEN c.difieren > ${TOPE_WARN} THEN ' (son demasiados: ¿corre el hop-2 de esa tabla?)' ELSE '' END ||
                     '. ${comoCerrar}' END AS note_extra
      FROM c`;
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
  ${veredicto('markup', 'Medir: node database/importers/kepler/import-margin.js; cerrar: --apply')}`;

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
  ${veredicto('la marca de promo', 'Medir: node database/importers/kepler/repoint-catalog-prices.js; cerrar: --apply')}`;

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
  ${veredicto('nombre', 'Medir: node database/importers/kepler/repoint-catalog-names.js; cerrar: --apply')}`;
