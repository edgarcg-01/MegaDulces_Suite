-- ---------------------------------------------------------------------------
-- preview-format-fixes.sql — READ ONLY
--
-- Muestra exactamente que nombres cambiarian si aplicamos:
--   A. Unidades pegadas:  "225 ML" -> "225ML", "1 KG" -> "1KG"
--   B. Piezas:            "10 PZAS" / "5 PZS" -> "10P" / "5P"
--   C. # pegado:          "VASO # 10" -> "VASO #10"
--   D. / con espacios:    ".../24" -> "... / 24" (sin tocar fracciones 1/2)
--
-- Solo SELECT — no modifica nada.
-- ---------------------------------------------------------------------------

\pset format aligned
\pset border 2
\pset pager off
SET client_encoding = 'UTF8';

\echo ''
\echo '====================================================================='
\echo ' Preview: products que cambiarian (todos)'
\echo '====================================================================='
WITH norm AS (
  SELECT id, nombre AS actual,
    -- Aplicamos las 4 reglas anidadas en el mismo orden que aplicaremos
    -- despues. D va al final porque sus espacios pueden interactuar con A.
    REGEXP_REPLACE(
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
    ) AS normalizado
  FROM products
)
SELECT actual, normalizado
FROM norm
WHERE actual <> normalizado
ORDER BY actual;

\echo ''
\echo '====================================================================='
\echo ' Resumen: cuantas filas cambiarian'
\echo '====================================================================='
WITH norm AS (
  SELECT id, nombre AS actual,
    REGEXP_REPLACE(
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
    ) AS normalizado
  FROM products
)
SELECT count(*) AS filas_que_cambian FROM norm WHERE actual <> normalizado;
