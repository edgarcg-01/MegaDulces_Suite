-- ---------------------------------------------------------------------------
-- dry-run-normalize.sql
--
-- Aplica la MISMA logica de migrations/20260526180000_normalize_product_names.js
-- pero en una transaccion explicita contra LOCAL para ver el resultado antes
-- de pegarle a prod.
--
-- Si algo se ve mal: ROLLBACK manual. Por seguridad, no hace COMMIT
-- automatico al final — el script imprime resultados y deja la tx abierta
-- para que el operador decida.
-- ---------------------------------------------------------------------------

\set QUIET on
\timing on

BEGIN;

\echo '====================================================================='
\echo ' DRY-RUN: aplicando normalizacion en LOCAL (tx abierta)'
\echo '====================================================================='

-- ─────────────────────────────────────────────────────────────────────────
-- 0. Pre-check: la normalizacion de brands no debe generar colisiones.
-- ─────────────────────────────────────────────────────────────────────────
\echo ''
\echo '== 0. Pre-check: colisiones de brands tras normalizar =='
WITH norm AS (
  SELECT id, nombre,
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
    ) AS norm_name
  FROM brands
)
SELECT norm_name, count(*) AS n, array_agg(nombre) AS variantes
FROM norm
GROUP BY norm_name
HAVING count(*) > 1;
\echo '(si arriba aparecen filas, ABORTA: ROLLBACK manual)'

-- ─────────────────────────────────────────────────────────────────────────
-- 1. UPDATE brands
-- ─────────────────────────────────────────────────────────────────────────
\echo ''
\echo '== 1. Actualizando brands... =='
WITH updates AS (
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
      ),
      updated_at = NOW()
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
  RETURNING id, nombre
)
SELECT count(*) AS brands_actualizadas FROM updates;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. UPDATE products
-- ─────────────────────────────────────────────────────────────────────────
\echo ''
\echo '== 2. Actualizando products... =='
WITH updates AS (
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
      ),
      updated_at = NOW()
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
  RETURNING id, nombre
)
SELECT count(*) AS products_actualizados FROM updates;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Verificacion post-cambio: deben estar TODOS los nombres en UPPER, sin
--    whitespace doble ni residuos al final ni apostrofes raros.
-- ─────────────────────────────────────────────────────────────────────────
\echo ''
\echo '== 3. Verificacion: nombres que aun NO cumplen reglas =='

SELECT 'brands ' || count(*) || ' filas con whitespace anomalo' AS check
FROM brands
WHERE nombre <> REGEXP_REPLACE(TRIM(nombre), '\s+', ' ', 'g')
UNION ALL
SELECT 'products ' || count(*) || ' filas con whitespace anomalo'
FROM products
WHERE nombre <> REGEXP_REPLACE(TRIM(nombre), '\s+', ' ', 'g')
UNION ALL
SELECT 'products ' || count(*) || ' filas con apostrofes/agudos raros'
FROM products
WHERE nombre ~ '[‘’´`]'
UNION ALL
SELECT 'products ' || count(*) || ' filas que NO estan en UPPER (sin acento)'
FROM products
WHERE nombre <> TRANSLATE(UPPER(nombre), 'ÁÉÍÓÚÜáéíóúü', 'AEIOUUAEIOUU')
UNION ALL
SELECT 'brands ' || count(*) || ' filas que NO estan en UPPER (sin acento)'
FROM brands
WHERE nombre <> TRANSLATE(UPPER(nombre), 'ÁÉÍÓÚÜáéíóúü', 'AEIOUUAEIOUU');

\echo ''
\echo '====================================================================='
\echo ' TX abierta. Inspecciona y luego: COMMIT (para guardar) o ROLLBACK.'
\echo ' Como este script termina sin COMMIT, psql cierra la conexion y la'
\echo ' tx se ROLLBACK automaticamente. Para hacer permanente, correr en'
\echo ' una sesion psql interactiva o agregar COMMIT al final.'
\echo '====================================================================='
