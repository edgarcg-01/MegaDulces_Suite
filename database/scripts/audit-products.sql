-- ---------------------------------------------------------------------------
-- audit-products.sql
--
-- Auditoria READ-ONLY de irregularidades en brands/products.
-- Se ejecuta antes de definir las reglas de normalizacion. No modifica
-- absolutamente nada (solo SELECT).
--
-- Uso:
--   psql --dbname "$DATABASE_URL" -f database/audit-products.sql > audit.txt
-- ---------------------------------------------------------------------------

\echo '====================================================================='
\echo ' 1. CONTEOS BASE'
\echo '====================================================================='
SELECT 'brands'   AS tabla,
       count(*)                              AS total,
       count(*) FILTER (WHERE activo)        AS activos,
       count(*) FILTER (WHERE NOT activo)    AS inactivos
FROM brands
UNION ALL
SELECT 'products', count(*),
       count(*) FILTER (WHERE activo),
       count(*) FILTER (WHERE NOT activo)
FROM products;

\echo ''
\echo '====================================================================='
\echo ' 2. BRANDS CON PROBLEMAS DE WHITESPACE'
\echo '    (trailing/leading spaces, espacios dobles internos)'
\echo '====================================================================='
SELECT id, nombre, length(nombre) AS len_actual, length(regexp_replace(trim(nombre), '\s+', ' ', 'g')) AS len_normalizada
FROM brands
WHERE nombre <> regexp_replace(trim(nombre), '\s+', ' ', 'g');

\echo ''
\echo '====================================================================='
\echo ' 3. PRODUCTS CON PROBLEMAS DE WHITESPACE'
\echo '====================================================================='
SELECT id, brand_id, nombre, length(nombre) AS len_actual
FROM products
WHERE nombre <> regexp_replace(trim(nombre), '\s+', ' ', 'g')
ORDER BY nombre
LIMIT 50;

\echo ''
\echo '====================================================================='
\echo ' 4. BRANDS DUPLICADAS (case-insensitive + trim)'
\echo '====================================================================='
SELECT lower(regexp_replace(trim(nombre), '\s+', ' ', 'g')) AS nombre_normalizado,
       count(*) AS n,
       array_agg(nombre ORDER BY nombre) AS variantes,
       array_agg(id ORDER BY nombre) AS ids
FROM brands
GROUP BY 1
HAVING count(*) > 1
ORDER BY n DESC;

\echo ''
\echo '====================================================================='
\echo ' 5. PRODUCTS DUPLICADOS DENTRO DE UNA MISMA MARCA'
\echo '    (mismo brand_id + nombre normalizado, case-insensitive + trim)'
\echo '====================================================================='
SELECT b.nombre AS marca,
       lower(regexp_replace(trim(p.nombre), '\s+', ' ', 'g')) AS nombre_normalizado,
       count(*) AS n,
       array_agg(p.nombre ORDER BY p.nombre) AS variantes,
       array_agg(p.id ORDER BY p.nombre) AS ids
FROM products p
JOIN brands b ON b.id = p.brand_id
GROUP BY b.nombre, nombre_normalizado
HAVING count(*) > 1
ORDER BY n DESC
LIMIT 30;

\echo ''
\echo '====================================================================='
\echo ' 6. DIVERSIDAD DE CASING POR MARCA (top 15)'
\echo '    Identifica marcas con mezcla de UPPERCASE / lowercase / Title Case'
\echo '====================================================================='
SELECT b.nombre AS marca,
       count(*) AS productos,
       count(*) FILTER (WHERE p.nombre = upper(p.nombre))   AS en_mayusculas,
       count(*) FILTER (WHERE p.nombre = lower(p.nombre))   AS en_minusculas,
       count(*) FILTER (WHERE p.nombre = initcap(p.nombre)) AS title_case
FROM brands b
JOIN products p ON p.brand_id = b.id
GROUP BY b.nombre
ORDER BY productos DESC
LIMIT 15;

\echo ''
\echo '====================================================================='
\echo ' 7. CARACTERES ESPECIALES PROBLEMATICOS'
\echo '    Apostrofes curvos, comillas tipograficas, non-breaking spaces, etc.'
\echo '====================================================================='
SELECT id, nombre
FROM products
WHERE nombre ~ '[‘’“” ​]'
   OR nombre LIKE '%´%'
   OR nombre LIKE '%`%'
LIMIT 30;

\echo ''
\echo '====================================================================='
\echo ' 8. PRODUCTOS HUERFANOS (brand_id NULL o que apunta a marca inexistente)'
\echo '====================================================================='
SELECT count(*) AS huerfanos
FROM products p
LEFT JOIN brands b ON b.id = p.brand_id
WHERE p.brand_id IS NULL OR b.id IS NULL;

\echo ''
\echo '====================================================================='
\echo ' 9. MUESTRA DE 30 PRODUCTOS AL AZAR (para ver el estilo general)'
\echo '====================================================================='
SELECT b.nombre AS marca, p.nombre AS producto
FROM products p
JOIN brands b ON b.id = p.brand_id
ORDER BY random()
LIMIT 30;

\echo ''
\echo '====================================================================='
\echo ' AUDITORIA COMPLETA. Ningun dato fue modificado.'
\echo '====================================================================='
