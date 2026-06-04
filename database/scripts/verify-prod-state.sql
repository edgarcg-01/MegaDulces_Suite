-- Verifica si la normalizacion y los typo-fixes realmente estan en prod.
\pset format aligned
\pset border 2
\pset pager off
SET client_encoding = 'UTF8';

\echo ''
\echo '====================================================================='
\echo ' 1. CONTEOS BASE'
\echo '====================================================================='
SELECT 'brands' AS tabla, count(*) AS total FROM brands
UNION ALL SELECT 'products', count(*) FROM products;

\echo ''
\echo '====================================================================='
\echo ' 2. RESIDUOS DE LA NORMALIZACION (todo deberia ser 0)'
\echo '====================================================================='
SELECT 'brands NO en UPPER' AS check, count(*) AS n
FROM brands WHERE nombre <> TRANSLATE(UPPER(nombre), 'ÁÉÍÓÚÜáéíóúü', 'AEIOUUAEIOUU')
UNION ALL
SELECT 'products NO en UPPER', count(*)
FROM products WHERE nombre <> TRANSLATE(UPPER(nombre), 'ÁÉÍÓÚÜáéíóúü', 'AEIOUUAEIOUU')
UNION ALL
SELECT 'brands con apostrofes raros', count(*)
FROM brands WHERE nombre ~ '[‘’´`]'
UNION ALL
SELECT 'products con apostrofes raros', count(*)
FROM products WHERE nombre ~ '[‘’´`]'
UNION ALL
SELECT 'brands con whitespace anomalo', count(*)
FROM brands WHERE nombre <> REGEXP_REPLACE(TRIM(nombre), '\s+', ' ', 'g')
UNION ALL
SELECT 'products con whitespace anomalo', count(*)
FROM products WHERE nombre <> REGEXP_REPLACE(TRIM(nombre), '\s+', ' ', 'g');

\echo ''
\echo '====================================================================='
\echo ' 3. TYPO FIXES BATCH 1 (8 filas, esperadas en LA ROSA y DELICIAS)'
\echo '====================================================================='
SELECT id, nombre, updated_at
FROM products
WHERE id IN (
  '123fd88b-b826-4cb5-80e0-7264b9b0c39a',
  '569a6349-0c8a-4870-a85e-806f35c60f26',
  '3a2d73aa-249a-483c-a91c-4c2523177376',
  '1afb4253-0381-495a-a3a7-9620f03efad7',
  '18158d00-f1b3-44db-8960-82f6dd7ad86a',
  '4ce6cd0f-3b23-4471-aa49-944afd0eb448',
  '09b4ca2d-f560-4dfd-8164-097e2782e451',
  '4e34e0fa-6247-4c6a-956a-5099a55ae37e'
)
ORDER BY nombre;

\echo ''
\echo '====================================================================='
\echo ' 4. TYPO FIXES BATCH 2 (3 filas)'
\echo '====================================================================='
SELECT id, nombre, updated_at
FROM products
WHERE id IN (
  '1e966cde-56ee-42a2-9397-57edda77dadc',
  '43b258e0-7bde-413f-9e35-69994035088f',
  '86882f7b-abcc-4c34-81ae-211c250c3a16'
)
ORDER BY nombre;
