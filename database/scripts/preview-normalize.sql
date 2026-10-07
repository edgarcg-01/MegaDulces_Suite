-- ---------------------------------------------------------------------------
-- preview-normalize.sql
--
-- PURO SELECT. Muestra exactamente que nombres cambiarian al aplicar las
-- reglas R1+R2+R3+R4a, sin tocar ningun dato. Ideal como "diff" antes de
-- aprobar la migracion.
-- ---------------------------------------------------------------------------

\pset format aligned
\pset border 2

\echo ''
\echo '====================================================================='
\echo ' Preview: brands que cambiarian'
\echo '====================================================================='
WITH norm AS (
  SELECT id, nombre AS actual,
    TRANSLATE(
      UPPER(
        REGEXP_REPLACE(
          REGEXP_REPLACE(
            TRIM(REGEXP_REPLACE(nombre, '[‘’´`]', '''', 'g')),
            '\s+', ' ', 'g'
          ),
          '[\s\-]+$', '', 'g'
        )
      ),
      'ÁÉÍÓÚÜáéíóúü',
      'AEIOUUAEIOUU'
    ) AS normalizado
  FROM brands
)
SELECT actual, normalizado
FROM norm
WHERE actual <> normalizado
ORDER BY actual;

\echo ''
\echo '====================================================================='
\echo ' Preview: products que cambiarian (todos)'
\echo '====================================================================='
WITH norm AS (
  SELECT p.id, b.nombre AS marca, p.nombre AS actual,
    TRANSLATE(
      UPPER(
        REGEXP_REPLACE(
          REGEXP_REPLACE(
            TRIM(REGEXP_REPLACE(p.nombre, '[‘’´`]', '''', 'g')),
            '\s+', ' ', 'g'
          ),
          '[\s\-]+$', '', 'g'
        )
      ),
      'ÁÉÍÓÚÜáéíóúü',
      'AEIOUUAEIOUU'
    ) AS normalizado
  FROM products p
  LEFT JOIN brands b ON b.id = p.brand_id
)
SELECT marca, actual, normalizado
FROM norm
WHERE actual <> normalizado
ORDER BY marca, actual;

\echo ''
\echo '====================================================================='
\echo ' Resumen: cuantas filas cambiarian'
\echo '====================================================================='
WITH norm_brands AS (
  SELECT count(*) AS n
  FROM brands
  WHERE nombre <> TRANSLATE(
    UPPER(
      REGEXP_REPLACE(
        REGEXP_REPLACE(
          TRIM(REGEXP_REPLACE(nombre, '[‘’´`]', '''', 'g')),
          '\s+', ' ', 'g'
        ),
        '[\s\-]+$', '', 'g'
      )
    ),
    'ÁÉÍÓÚÜáéíóúü',
    'AEIOUUAEIOUU'
  )
), norm_products AS (
  SELECT count(*) AS n
  FROM products
  WHERE nombre <> TRANSLATE(
    UPPER(
      REGEXP_REPLACE(
        REGEXP_REPLACE(
          TRIM(REGEXP_REPLACE(nombre, '[‘’´`]', '''', 'g')),
          '\s+', ' ', 'g'
        ),
        '[\s\-]+$', '', 'g'
      )
    ),
    'ÁÉÍÓÚÜáéíóúü',
    'AEIOUUAEIOUU'
  )
)
SELECT 'brands' AS tabla, (SELECT n FROM norm_brands) AS filas_que_cambian
UNION ALL
SELECT 'products', (SELECT n FROM norm_products);
