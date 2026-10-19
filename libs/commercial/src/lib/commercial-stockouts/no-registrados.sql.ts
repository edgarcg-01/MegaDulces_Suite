/**
 * `[MOS.2]` — **No registrados**: lo que se escaneó en el mostrador y Kepler no reconoció, POR
 * SUCURSAL, mientras Kepler siga sin tenerlo.
 *
 * ── De dónde sale ─────────────────────────────────────────────────────────────────────────────
 * No hay tabla nueva. El mostrador ya anota en `commercial.floor_stockouts` con dos motivos:
 *   · `no_en_catalogo` — el código no existe en ninguna sucursal de Kepler.
 *   · `no_en_sucursal` — existe en otra sucursal, pero no en ésta.
 * Esta consulta junta las semanas (el grano de la tabla es sucursal × motivo × cosa × SEMANA) y
 * deja una fila por sucursal × cosa.
 *
 * ── Sale sola de la lista ─────────────────────────────────────────────────────────────────────
 * Se descarta lo que YA aparece en `kepler_ods.kdii` de esa sucursal — por clave o por cualquiera
 * de sus casillas de código de barras (las mismas que lee el verificador, `KpService.COLS_PRECIO`).
 * Es una lectura, no una marca: no hay proceso que tenga que correr para que el renglón salga, y
 * el ODS llega en minutos. ⚠️ Una sucursal sin `kepler_code` (Wincaja) no se puede verificar y
 * sus renglones SE QUEDAN: borrarlos sería afirmar que se registraron sin haberlo visto.
 *
 * ── Lo que se completa desde Kepler ───────────────────────────────────────────────────────────
 * Un código `no_en_catalogo` llega sin clave ni nombre. Si después aparece en OTRA sucursal, de ahí
 * se toman la clave y el nombre (`sku` / `kepler_nombre`): ya no hace falta adivinar qué era. El
 * proveedor sale de la ficha del catálogo (`catalog.suppliers`), el mismo que ve Compras.
 *
 * ── Por qué así y no un EXISTS por renglón ────────────────────────────────────────────────────
 * Las casillas de código de barras de `kdii` no tienen índice. Un EXISTS por renglón recorrería el
 * catálogo entero una vez por cada código pendiente. Acá `kdii` se lee UNA vez: cada fila se
 * despliega en sus 7 llaves (clave + 6 casillas) y se queda sólo lo que coincide con algún código
 * buscado, con un semi-join por hash.
 *
 * ⚠️ Sin acentos graves aquí adentro: este texto vive en un template literal.
 */
/** Tope de renglones. Si se alcanza, el servicio lo declara (`recortado`) en vez de callarlo. */
export const NO_REGISTRADOS_TOPE = 1000;

export const SQL_NO_REGISTRADOS = `
  WITH f AS (
    SELECT f.warehouse_id,
           NULLIF(btrim(f.sku), '')                       AS sku,
           NULLIF(btrim(f.scanned_code), '')              AS code,
           NULLIF(btrim(f.product_name), '')              AS product_name,
           f.times_reported, f.last_reported_at,
           CASE WHEN NULLIF(btrim(f.sku), '') IS NOT NULL
                  THEN 'sku:' || ltrim(btrim(f.sku), '0')
                WHEN NULLIF(btrim(f.scanned_code), '') IS NOT NULL
                  THEN 'code:' || ltrim(btrim(f.scanned_code), '0')
                ELSE 'txt:' || lower(btrim(coalesce(f.product_name, ''))) END AS cosa
      FROM commercial.floor_stockouts f
     WHERE f.kind IN ('no_en_catalogo', 'no_en_sucursal')
       AND f.status IN ('open', 'in_progress')
  ), g AS (
    SELECT warehouse_id, cosa,
           max(sku)                     AS sku,
           max(code)                    AS code,
           -- Lo que escribio la persona: el reporte mas reciente que trae texto.
           (array_agg(product_name ORDER BY last_reported_at DESC)
              FILTER (WHERE product_name IS NOT NULL))[1] AS product_name,
           sum(times_reported)::int     AS veces,
           max(last_reported_at)        AS ultima_vez
      FROM f
     GROUP BY warehouse_id, cosa
  ), buscados AS (
    SELECT ltrim(sku, '0') AS v FROM g WHERE sku IS NOT NULL
    UNION SELECT code            FROM g WHERE code IS NOT NULL
    UNION SELECT ltrim(code, '0') FROM g WHERE code IS NOT NULL
  ), kh AS (
    -- kdii leido UNA vez: cada fila en sus 7 llaves, y solo las que se buscan.
    SELECT DISTINCT btrim(k.sucursal) AS suc,
           ltrim(btrim(k.c1::text), '0') AS sku,
           btrim(k.c2::text) AS nombre,
           x.v
      FROM kepler_ods.kdii k
     CROSS JOIN LATERAL (VALUES
             (ltrim(btrim(k.c1::text), '0')),
             (btrim(k.c7::text)),  (btrim(k.c82::text)), (btrim(k.c93::text)),
             (btrim(k.c95::text)), (btrim(k.c85::text)), (btrim(k.c96::text))
           ) x(v)
     WHERE x.v <> '' AND x.v IN (SELECT v FROM buscados)
  ), m AS (
    -- Cada cosa pendiente contra cada fila de Kepler (de cualquier sucursal) que la reconoce.
    -- La clave solo casa contra la casilla de la clave (kh.v = kh.sku), no contra un barcode.
    SELECT g.warehouse_id, g.cosa, kh.suc, kh.sku, kh.nombre
      FROM g
      JOIN kh ON (g.sku IS NOT NULL AND kh.v = ltrim(g.sku, '0') AND kh.v = kh.sku)
              OR (g.code IS NOT NULL
                  AND (kh.v = g.code OR (kh.v = ltrim(g.code, '0') AND kh.v = kh.sku)))
  )
  SELECT g.cosa,
         w.code                         AS warehouse_code,
         w.name                         AS warehouse_name,
         w.kepler_code,
         g.code                         AS scanned_code,
         coalesce(g.sku, ke.sku)        AS sku,
         g.product_name,
         ke.nombre                      AS kepler_nombre,
         pv.proveedor,
         g.veces,
         g.ultima_vez
    FROM g
    JOIN commercial.warehouses w ON w.id = g.warehouse_id
    -- Si ya existe en OTRA sucursal, de ahi salen la clave y el nombre (retail antes que CEDIS).
    LEFT JOIN LATERAL (
      SELECT m.sku, m.nombre
        FROM m
       WHERE m.warehouse_id = g.warehouse_id AND m.cosa = g.cosa
       ORDER BY (m.suc = '00'), m.suc
       LIMIT 1
    ) ke ON true
    -- LATERAL con LIMIT 1 y no un JOIN: una clave repetida en el catalogo duplicaria el renglon.
    -- La clave de catalog.products no lleva ceros a la izquierda (igual que en KpService).
    LEFT JOIN LATERAL (
      SELECT s.name AS proveedor
        FROM catalog.products p
        JOIN catalog.suppliers s ON s.id = p.supplier_id
       WHERE p.deleted_at IS NULL
         AND btrim(p.sku) = coalesce(ltrim(g.sku, '0'), ke.sku)
       LIMIT 1
    ) pv ON true
   WHERE NOT EXISTS (
           SELECT 1 FROM m
            WHERE m.warehouse_id = g.warehouse_id AND m.cosa = g.cosa
              AND w.kepler_code IS NOT NULL AND m.suc = w.kepler_code
         )
   ORDER BY g.ultima_vez DESC, w.code, g.cosa
   LIMIT ${NO_REGISTRADOS_TOPE}
`;
