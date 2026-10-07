-- ---------------------------------------------------------------------------
-- apply-typo-fixes-batch2.sql
--
-- Segunda tanda de typo-fixes — los 3 casos que en el batch1 dejamos para
-- revision manual. Los nombres corregidos vienen confirmados por el usuario.
--
-- Idempotente: WHERE clause verifica el valor actual exacto. Si la fila ya
-- esta corregida, el UPDATE retorna 0 sin error.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on
\timing on

-- Critico: aseguramos UTF8 para que Ñ no se corrompa en transito.
SET client_encoding = 'UTF8';

BEGIN;

\echo ''
\echo '====================================================================='
\echo ' Estado ANTES (las 3 filas afectadas)'
\echo '====================================================================='
SELECT id, nombre
FROM products
WHERE id IN (
  '1e966cde-56ee-42a2-9397-57edda77dadc',  -- A 4S PASTILLAS
  '43b258e0-7bde-413f-9e35-69994035088f',  -- DETIBACK'PINATERS
  '86882f7b-abcc-4c34-81ae-211c250c3a16'   -- KINDER HUEVO NINA'EP
)
ORDER BY nombre;

-- ─────────────────────────────────────────────────────────────────────────
-- Fix 1: LA ROSA — quitar "A " inicial (basura sobrante)
-- ─────────────────────────────────────────────────────────────────────────
\echo ''
\echo '== Fix 1: A 4S PASTILLAS -> 4S PASTILLAS =='
UPDATE products
SET nombre = '4S PASTILLAS DISPLAY /100 LA ROSA',
    updated_at = NOW()
WHERE id = '1e966cde-56ee-42a2-9397-57edda77dadc'
  AND nombre = 'A 4S PASTILLAS DISPLAY /100 LA ROSA';

-- ─────────────────────────────────────────────────────────────────────────
-- Fix 2: DELICIAS — DETIBACK'PINATERS -> DELIPACK PIÑATERA
-- ─────────────────────────────────────────────────────────────────────────
\echo '== Fix 2: DETIBACK''PINATERS -> DELIPACK PIÑATERA =='
UPDATE products
SET nombre = 'DELIPACK PIÑATERA 1KG 115°2 DELICIAS',
    updated_at = NOW()
WHERE id = '43b258e0-7bde-413f-9e35-69994035088f'
  AND nombre = 'DETIBACK''PINATERS 1KG 115°2 DELICIAS';

-- ─────────────────────────────────────────────────────────────────────────
-- Fix 3: FERRERO — NINA'EP -> NIÑA EP
-- ─────────────────────────────────────────────────────────────────────────
\echo '== Fix 3: KINDER HUEVO NINA''EP -> KINDER HUEVO NIÑA EP =='
UPDATE products
SET nombre = 'KINDER HUEVO NIÑA EP',
    updated_at = NOW()
WHERE id = '86882f7b-abcc-4c34-81ae-211c250c3a16'
  AND nombre = 'KINDER HUEVO NINA''EP';

\echo ''
\echo '====================================================================='
\echo ' Estado DESPUES (mismas 3 filas, corregidas)'
\echo '====================================================================='
SELECT id, nombre
FROM products
WHERE id IN (
  '1e966cde-56ee-42a2-9397-57edda77dadc',
  '43b258e0-7bde-413f-9e35-69994035088f',
  '86882f7b-abcc-4c34-81ae-211c250c3a16'
)
ORDER BY nombre;

COMMIT;

\echo ''
\echo '====================================================================='
\echo ' 3 typos corregidos. COMMIT realizado.'
\echo '====================================================================='
