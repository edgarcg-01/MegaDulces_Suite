-- ---------------------------------------------------------------------------
-- apply-all-prod.sql
--
-- Script UNICO contra la BD real de produccion (Railway):
-- postgresql://postgres:...@switchback.proxy.rlwy.net:16885/railway
--
-- Aplica en orden, dentro de una sola transaccion:
--   1. Normalizacion (R1+R2+R3+R4a):
--      - trim + colapsar espacios dobles
--      - apostrofes curvos -> recto
--      - basura final (espacios, dashes)
--      - UPPER + strip de acentos vocales (deja Ñ)
--   2. Typo fixes batch 1 (8 productos LA ROSA + FURA SODA)
--   3. Typo fixes batch 2 (3 productos con Ñ: PIÑATERA, NIÑA EP, 4S PASTILLAS)
--   4. Format fixes (A+B+C+D):
--      - unidades pegadas (225 ML -> 225ML)
--      - piezas (PZAS/PZS -> P)
--      - # pegado al digito
--      - / con espacios alrededor cuando separa items
--
-- IMPORTANTE: schema de prod no tiene updated_at en brands/products, asi
-- que NO se setea esa columna (a diferencia de los scripts contra local).
--
-- Idempotente: re-ejecutar es seguro. WHERE filtra solo filas a cambiar.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on
\timing on
SET client_encoding = 'UTF8';

BEGIN;

\echo ''
\echo '====================================================================='
\echo ' 0. Pre-check de colisiones en brands'
\echo '====================================================================='
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM (
    SELECT TRANSLATE(
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
    ) AS norm
    FROM brands
    GROUP BY norm HAVING count(*) > 1
  ) c;
  IF n > 0 THEN
    RAISE EXCEPTION 'Colisiones detectadas: % grupos. ABORTANDO.', n;
  END IF;
  RAISE NOTICE 'Pre-check OK.';
END $$;

\echo ''
\echo '====================================================================='
\echo ' 1. Normalizacion R1+R2+R3+R4a (brands)'
\echo '====================================================================='
WITH up AS (
  UPDATE brands
  SET nombre = TRANSLATE(
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
  WHERE nombre IS NOT NULL
    AND nombre <> TRANSLATE(
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
  RETURNING id
) SELECT count(*) AS brands_normalizadas FROM up;

\echo ''
\echo '====================================================================='
\echo ' 2. Normalizacion R1+R2+R3+R4a (products)'
\echo '====================================================================='
WITH up AS (
  UPDATE products
  SET nombre = TRANSLATE(
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
  WHERE nombre IS NOT NULL
    AND nombre <> TRANSLATE(
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
  RETURNING id
) SELECT count(*) AS products_normalizados FROM up;

\echo ''
\echo '====================================================================='
\echo ' 3. Typo fixes batch 1 (8 productos)'
\echo '====================================================================='

UPDATE products SET nombre='LA ROSA BOMBON GRANDE BLANCO/ROSA'
WHERE id='123fd88b-b826-4cb5-80e0-7264b9b0c39a' AND nombre='A ROSA BOMBON GRANDE BLANCO/ROSA';

UPDATE products SET nombre='LA ROSA JAPONES 800GR GRANEL'
WHERE id='569a6349-0c8a-4870-a85e-806f35c60f26' AND nombre='A ROSA JAPONES 800GR GRANEL';

UPDATE products SET nombre='LA ROSA JAPONES TUBO 200G 6P NISHIYAMA'
WHERE id='3a2d73aa-249a-483c-a91c-4c2523177376' AND nombre='A ROSA JAPONES TUBO 200G 6P NISHIYAMA';

UPDATE products SET nombre='LA ROSA JAPONES TUBO 42G ''14P NISHIYAMA'
WHERE id='1afb4253-0381-495a-a3a7-9620f03efad7' AND nombre='A ROSA JAPONES TUBO 42G ''14P NISHIYAMA';

UPDATE products SET nombre='LA ROSA JAPONES TUBO 60G''12P NISHIYAMA'
WHERE id='18158d00-f1b3-44db-8960-82f6dd7ad86a' AND nombre='A ROSA JAPONES TUBO 60G''12P NISHIYAMA';

UPDATE products SET nombre='LA ROSA MAZAPAN C/CHOC /16'
WHERE id='4ce6cd0f-3b23-4471-aa49-944afd0eb448' AND nombre='A ROSA MAZAPAN C/CHOC /16';

UPDATE products SET nombre='LA ROSA NUGS RECREO 56G:10P'
WHERE id='09b4ca2d-f560-4dfd-8164-097e2782e451' AND nombre='A ROSA NUGS RECREO 56G:10P';

UPDATE products SET nombre='FURA SODA 224GR DELICIAS /04'
WHERE id='4e34e0fa-6247-4c6a-956a-5099a55ae37e' AND nombre='FURA SODA 224GR DETICIAS /O4';

\echo ''
\echo '====================================================================='
\echo ' 4. Typo fixes batch 2 (3 productos con Ñ)'
\echo '====================================================================='

UPDATE products SET nombre='4S PASTILLAS DISPLAY /100 LA ROSA'
WHERE id='1e966cde-56ee-42a2-9397-57edda77dadc' AND nombre='A 4S PASTILLAS DISPLAY /100 LA ROSA';

UPDATE products SET nombre='DELIPACK PIÑATERA 1KG 115°2 DELICIAS'
WHERE id='43b258e0-7bde-413f-9e35-69994035088f' AND nombre='DETIBACK''PINATERS 1KG 115°2 DELICIAS';

UPDATE products SET nombre='KINDER HUEVO NIÑA EP'
WHERE id='86882f7b-abcc-4c34-81ae-211c250c3a16' AND nombre='KINDER HUEVO NINA''EP';

\echo ''
\echo '====================================================================='
\echo ' 5. Format fixes A+B+C+D (products)'
\echo '====================================================================='
WITH up AS (
  UPDATE products
  SET nombre = REGEXP_REPLACE(
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
  )
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
  )
  RETURNING id
) SELECT count(*) AS products_format_fixed FROM up;

\echo ''
\echo '====================================================================='
\echo ' 6. Verificacion: anomalias residuales (todo deberia ser 0)'
\echo '====================================================================='
SELECT 'brands no en UPPER' AS check, count(*) AS n
FROM brands WHERE nombre <> TRANSLATE(UPPER(nombre), 'ÁÉÍÓÚÜáéíóúü', 'AEIOUUAEIOUU')
UNION ALL SELECT 'products no en UPPER', count(*)
FROM products WHERE nombre <> TRANSLATE(UPPER(nombre), 'ÁÉÍÓÚÜáéíóúü', 'AEIOUUAEIOUU')
UNION ALL SELECT 'apostrofes raros (brands+products)',
  (SELECT count(*) FROM brands WHERE nombre ~ '[‘’´`]') +
  (SELECT count(*) FROM products WHERE nombre ~ '[‘’´`]')
UNION ALL SELECT 'whitespace anomalo', count(*)
FROM products WHERE nombre <> REGEXP_REPLACE(TRIM(nombre), '\s+', ' ', 'g')
UNION ALL SELECT 'NN ML/GR/KG sin pegar', count(*)
FROM products WHERE nombre ~ '[0-9]\s+(ML|GR|KG|MG|G|L)\M'
UNION ALL SELECT '# con espacio', count(*)
FROM products WHERE nombre ~ '#\s+[0-9]'
UNION ALL SELECT 'PZAS/PZS sueltos', count(*)
FROM products WHERE nombre ~ '[0-9]\s*PZ(A?S)\M';

COMMIT;

\echo ''
\echo '====================================================================='
\echo ' COMMIT realizado contra PRODUCCION (Railway / db=railway).'
\echo '====================================================================='
