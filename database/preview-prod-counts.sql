-- Conteo READ-ONLY de filas que cambiarian en cada categoria sobre PROD.
SET client_encoding = 'UTF8';
\pset format aligned
\pset border 2

SELECT 'brands no normalizados' AS check, count(*) AS n
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
UNION ALL
SELECT 'products no normalizados', count(*)
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
UNION ALL
SELECT 'products afectados por format-fixes', count(*)
FROM products
WHERE nombre <> REGEXP_REPLACE(
  REGEXP_REPLACE(
    REGEXP_REPLACE(
      REGEXP_REPLACE(
        REGEXP_REPLACE(nombre, '([0-9])\s+(ML|GR|KG|MG)\M', '\1\2', 'g'),
        '([0-9])\s+(G|L)\M', '\1\2', 'g'
      ),
      '([0-9])\s*PZ(A?S)\M', '\1P', 'g'
    ),
    '#\s+([0-9])', '#\1', 'g'
  ),
  '([^0-9\s])\s*/\s*([0-9])', '\1 / \2', 'g'
);
