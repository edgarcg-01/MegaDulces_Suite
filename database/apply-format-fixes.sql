-- ---------------------------------------------------------------------------
-- apply-format-fixes.sql
--
-- Normalizacion de formato (segundo pase, despues de apply-normalize.sql).
-- Aplica 4 reglas en orden, dentro de una transaccion atomica.
--
--   A. "225 ML" -> "225ML"   (unidades pegadas al numero)
--      Unidades cubiertas: ML, GR, KG, MG, G, L
--   B. "10 PZAS" / "5 PZS" -> "10P" / "5P"
--   C. "VASO # 10" -> "VASO #10"   (# pegado al digito)
--   D. ".../24" -> "... / 24"       (slash con espacios cuando separa item)
--      No toca fracciones tipo 1/2 ni patrones tipo C/CHOC.
--
-- Idempotente: WHERE detecta solo filas que necesitan cambio.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on
\timing on
SET client_encoding = 'UTF8';

BEGIN;

\echo ''
\echo '====================================================================='
\echo ' Aplicando A+B+C+D en un UPDATE atomico por tabla'
\echo '====================================================================='

WITH updates AS (
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
  ),
  updated_at = NOW()
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
)
SELECT count(*) AS products_actualizados FROM updates;

\echo ''
\echo '====================================================================='
\echo ' Verificacion: ninguna anomalia residual'
\echo '====================================================================='
SELECT 'products con espacio antes de ML/GR/KG/MG/G/L' AS check, count(*) AS n
FROM products WHERE nombre ~ '[0-9]\s+(ML|GR|KG|MG|G|L)\M'
UNION ALL
SELECT 'products con PZAS o PZS sueltos', count(*)
FROM products WHERE nombre ~ '[0-9]\s*PZ(A?S)\M'
UNION ALL
SELECT 'products con # seguido de espacio + digito', count(*)
FROM products WHERE nombre ~ '#\s+[0-9]'
UNION ALL
SELECT 'products con /digito pegado a letra (debe ser / digito)', count(*)
FROM products WHERE nombre ~ '[A-Z]/[0-9]';

COMMIT;

\echo ''
\echo '====================================================================='
\echo ' COMMIT realizado.'
\echo '====================================================================='
