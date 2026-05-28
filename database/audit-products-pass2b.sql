-- Continuacion de audit-products-pass2.sql — secciones 5-8 con p.id qualificado.

\pset format aligned
\pset border 2
\pset pager off

SET client_encoding = 'UTF8';

\echo '====================================================================='
\echo ' 5. CARACTERES "RAROS" (°, #, :, !) que pueden indicar errores'
\echo '====================================================================='
SELECT p.id, b.nombre AS marca, p.nombre
FROM products p
JOIN brands b ON b.id = p.brand_id
WHERE p.nombre ~ '[°#:!]'
ORDER BY p.nombre
LIMIT 40;

\echo ''
\echo '====================================================================='
\echo ' 6. NOMBRES DEMASIADO CORTOS (< 6 chars)'
\echo '====================================================================='
SELECT p.id, b.nombre AS marca, p.nombre, length(p.nombre) AS len
FROM products p
JOIN brands b ON b.id = p.brand_id
WHERE length(p.nombre) < 6
ORDER BY len, p.nombre;

\echo ''
\echo '====================================================================='
\echo ' 7. NOMBRES MUY LARGOS (> 70 chars)'
\echo '====================================================================='
SELECT p.id, b.nombre AS marca, length(p.nombre) AS len, p.nombre
FROM products p
JOIN brands b ON b.id = p.brand_id
WHERE length(p.nombre) > 70
ORDER BY len DESC
LIMIT 15;

\echo ''
\echo '====================================================================='
\echo ' 8. POSIBLES TRUNCAMIENTOS (terminan en preposicion o letra suelta)'
\echo '====================================================================='
SELECT p.id, b.nombre AS marca, p.nombre
FROM products p
JOIN brands b ON b.id = p.brand_id
WHERE p.nombre ~ '\m(DE|CON|EN|LA|EL|UN|UNA|Y|O|DEL|AL|PARA)$'
   OR p.nombre ~ ' [A-Z]$'
ORDER BY p.nombre
LIMIT 30;
