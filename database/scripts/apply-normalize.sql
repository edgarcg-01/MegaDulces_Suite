-- ---------------------------------------------------------------------------
-- apply-normalize.sql
--
-- Aplica las reglas R1+R2+R3+R4a contra brands/products en una transaccion
-- con COMMIT al final. Idempotente: si se vuelve a correr, las filas ya
-- normalizadas no se actualizan (gracias al `nombre <> normalizado` en WHERE).
--
-- Antes de correr esto YA debe existir un backup .dump fresco. Revisar
-- `scripts/backup-db.ps1`.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on
\timing on
\set QUIET on

BEGIN;

\echo ''
\echo '====================================================================='
\echo ' Pre-check: ninguna brand debe colisionar tras normalizar'
\echo '====================================================================='
DO $$
DECLARE
  collision_count int;
BEGIN
  SELECT count(*) INTO collision_count
  FROM (
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
    GROUP BY norm
    HAVING count(*) > 1
  ) c;

  IF collision_count > 0 THEN
    RAISE EXCEPTION 'Colisiones detectadas: % grupos. ABORTANDO.', collision_count;
  END IF;
  RAISE NOTICE 'Pre-check OK: sin colisiones.';
END $$;

\echo ''
\echo '====================================================================='
\echo ' UPDATE brands'
\echo '====================================================================='
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
  RETURNING id
)
SELECT count(*) AS brands_actualizadas FROM updates;

\echo ''
\echo '====================================================================='
\echo ' UPDATE products'
\echo '====================================================================='
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
  RETURNING id
)
SELECT count(*) AS products_actualizados FROM updates;

\echo ''
\echo '====================================================================='
\echo ' Verificacion: deben quedar 0 filas con anomalias'
\echo '====================================================================='
SELECT 'brands con whitespace anomalo' AS check, count(*) AS n
FROM brands WHERE nombre <> REGEXP_REPLACE(TRIM(nombre), '\s+', ' ', 'g')
UNION ALL
SELECT 'products con whitespace anomalo', count(*)
FROM products WHERE nombre <> REGEXP_REPLACE(TRIM(nombre), '\s+', ' ', 'g')
UNION ALL
SELECT 'brands no en UPPER', count(*)
FROM brands WHERE nombre <> TRANSLATE(UPPER(nombre), 'ÁÉÍÓÚÜáéíóúü', 'AEIOUUAEIOUU')
UNION ALL
SELECT 'products no en UPPER', count(*)
FROM products WHERE nombre <> TRANSLATE(UPPER(nombre), 'ÁÉÍÓÚÜáéíóúü', 'AEIOUUAEIOUU')
UNION ALL
SELECT 'products con apostrofes raros', count(*)
FROM products WHERE nombre ~ '[‘’´`]'
UNION ALL
SELECT 'brands con apostrofes raros', count(*)
FROM brands WHERE nombre ~ '[‘’´`]';

COMMIT;

\echo ''
\echo '====================================================================='
\echo ' COMMIT realizado. Cambios persistidos.'
\echo '====================================================================='
