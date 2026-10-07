-- ---------------------------------------------------------------------------
-- apply-typo-fixes.sql
--
-- Correcciones manuales de typos detectados despues de la normalizacion
-- (apply-normalize.sql del 26-may-2026). NO sustituye a la normalizacion,
-- la complementa: aqui solo van casos puntuales que requieren juicio humano.
--
-- Cada UPDATE apunta a un UUID especifico para evitar matches ambiguos.
-- Idempotente: si el valor ya esta corregido, el WHERE no machea y no hace nada.
--
-- Antes de correr: backup fresco. Despues de correr: COMMIT atomico.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on
\timing on

BEGIN;

\echo ''
\echo '====================================================================='
\echo ' Estado ANTES de los fixes (filas afectadas)'
\echo '====================================================================='
SELECT id, nombre
FROM products
WHERE id IN (
  '123fd88b-b826-4cb5-80e0-7264b9b0c39a',  -- A ROSA BOMBON GRANDE
  '569a6349-0c8a-4870-a85e-806f35c60f26',  -- A ROSA JAPONES 800GR GRANEL
  '3a2d73aa-249a-483c-a91c-4c2523177376',  -- A ROSA JAPONES TUBO 200G
  '1afb4253-0381-495a-a3a7-9620f03efad7',  -- A ROSA JAPONES TUBO 42G
  '18158d00-f1b3-44db-8960-82f6dd7ad86a',  -- A ROSA JAPONES TUBO 60G
  '4ce6cd0f-3b23-4471-aa49-944afd0eb448',  -- A ROSA MAZAPAN C/CHOC
  '09b4ca2d-f560-4dfd-8164-097e2782e451',  -- A ROSA NUGS RECREO
  '4e34e0fa-6247-4c6a-956a-5099a55ae37e'   -- FURA SODA 224GR DETICIAS
)
ORDER BY nombre;

-- ─────────────────────────────────────────────────────────────────────────
-- LA ROSA: 7 productos con "A ROSA ..." -> "LA ROSA ..."
-- Solo agregamos el "L" perdido al inicio. Resto del nombre intacto.
-- ─────────────────────────────────────────────────────────────────────────

\echo ''
\echo '== Fix 1: A ROSA BOMBON GRANDE =='
UPDATE products
SET nombre = 'LA ROSA BOMBON GRANDE BLANCO/ROSA',
    updated_at = NOW()
WHERE id = '123fd88b-b826-4cb5-80e0-7264b9b0c39a'
  AND nombre = 'A ROSA BOMBON GRANDE BLANCO/ROSA';

\echo '== Fix 2: A ROSA JAPONES 800GR =='
UPDATE products
SET nombre = 'LA ROSA JAPONES 800GR GRANEL',
    updated_at = NOW()
WHERE id = '569a6349-0c8a-4870-a85e-806f35c60f26'
  AND nombre = 'A ROSA JAPONES 800GR GRANEL';

\echo '== Fix 3: A ROSA JAPONES TUBO 200G =='
UPDATE products
SET nombre = 'LA ROSA JAPONES TUBO 200G 6P NISHIYAMA',
    updated_at = NOW()
WHERE id = '3a2d73aa-249a-483c-a91c-4c2523177376'
  AND nombre = 'A ROSA JAPONES TUBO 200G 6P NISHIYAMA';

\echo '== Fix 4: A ROSA JAPONES TUBO 42G =='
UPDATE products
SET nombre = 'LA ROSA JAPONES TUBO 42G ''14P NISHIYAMA',
    updated_at = NOW()
WHERE id = '1afb4253-0381-495a-a3a7-9620f03efad7'
  AND nombre = 'A ROSA JAPONES TUBO 42G ''14P NISHIYAMA';

\echo '== Fix 5: A ROSA JAPONES TUBO 60G =='
UPDATE products
SET nombre = 'LA ROSA JAPONES TUBO 60G''12P NISHIYAMA',
    updated_at = NOW()
WHERE id = '18158d00-f1b3-44db-8960-82f6dd7ad86a'
  AND nombre = 'A ROSA JAPONES TUBO 60G''12P NISHIYAMA';

\echo '== Fix 6: A ROSA MAZAPAN =='
UPDATE products
SET nombre = 'LA ROSA MAZAPAN C/CHOC /16',
    updated_at = NOW()
WHERE id = '4ce6cd0f-3b23-4471-aa49-944afd0eb448'
  AND nombre = 'A ROSA MAZAPAN C/CHOC /16';

\echo '== Fix 7: A ROSA NUGS RECREO =='
UPDATE products
SET nombre = 'LA ROSA NUGS RECREO 56G:10P',
    updated_at = NOW()
WHERE id = '09b4ca2d-f560-4dfd-8164-097e2782e451'
  AND nombre = 'A ROSA NUGS RECREO 56G:10P';

-- ─────────────────────────────────────────────────────────────────────────
-- DELICIAS: FURA SODA con dos typos juntos
--   DETICIAS -> DELICIAS  (typo de marca)
--   /O4      -> /04       (letra O confundida con cero, patron de cantidad)
-- ─────────────────────────────────────────────────────────────────────────

\echo '== Fix 8: FURA SODA DETICIAS /O4 =='
UPDATE products
SET nombre = 'FURA SODA 224GR DELICIAS /04',
    updated_at = NOW()
WHERE id = '4e34e0fa-6247-4c6a-956a-5099a55ae37e'
  AND nombre = 'FURA SODA 224GR DETICIAS /O4';

-- ─────────────────────────────────────────────────────────────────────────
-- Verificacion: las filas deben mostrar los valores corregidos.
-- ─────────────────────────────────────────────────────────────────────────

\echo ''
\echo '====================================================================='
\echo ' Estado DESPUES de los fixes (mismas filas, ya corregidas)'
\echo '====================================================================='
SELECT id, nombre
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

COMMIT;

\echo ''
\echo '====================================================================='
\echo ' 8 typos corregidos. COMMIT realizado.'
\echo ''
\echo ' Casos pendientes de revision MANUAL (no se tocaron):'
\echo '   - LA ROSA  : "A 4S PASTILLAS DISPLAY /100 LA ROSA"'
\echo '                (UUID: 1e966cde-56ee-42a2-9397-57edda77dadc)'
\echo '   - DELICIAS : "DETIBACK''PINATERS 1KG 115°2 DELICIAS"'
\echo '                (UUID: 43b258e0-7bde-413f-9e35-69994035088f)'
\echo '   - FERRERO  : "KINDER HUEVO NINA''EP"'
\echo '                (UUID: 86882f7b-abcc-4c34-81ae-211c250c3a16)'
\echo '====================================================================='
