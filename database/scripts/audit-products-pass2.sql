-- ---------------------------------------------------------------------------
-- audit-products-pass2.sql
--
-- Segunda pasada de auditoria READ-ONLY despues de la normalizacion. Busca
-- irregularidades que no eran de formato (casing, whitespace) sino de
-- contenido y consistencia: unidades, abreviaturas, patrones de paquete,
-- caracteres raros, posibles duplicados con variantes, truncamientos.
--
-- Solo SELECT — no modifica nada.
-- ---------------------------------------------------------------------------

\pset format aligned
\pset border 2
\pset pager off

SET client_encoding = 'UTF8';

\echo ''
\echo '====================================================================='
\echo ' 1. UNIDADES PEGADAS A NUMEROS vs SEPARADAS POR ESPACIO'
\echo '    Ejemplos: 225ML vs 225 ML, 1KG vs 1 KG'
\echo '====================================================================='
SELECT
  count(*) FILTER (WHERE nombre ~ '[0-9](ML|GR|KG|G|L|MG)\M')      AS "sin_espacio (225ML)",
  count(*) FILTER (WHERE nombre ~ '[0-9] (ML|GR|KG|G|L|MG)\M')     AS "con_espacio (225 ML)"
FROM products;

\echo ''
\echo '== Muestra de 20 con espacio (formato que rompe el patron dominante) =='
SELECT id, nombre
FROM products
WHERE nombre ~ '[0-9] (ML|GR|KG|G|L|MG)\M'
LIMIT 20;

\echo ''
\echo '====================================================================='
\echo ' 2. ABREVIATURAS DE "PIEZAS" — todas las variantes presentes'
\echo '====================================================================='
SELECT 'PZAS' AS variante, count(*) AS n FROM products WHERE nombre ~ '\mPZAS\M'
UNION ALL SELECT 'PZS',     count(*) FROM products WHERE nombre ~ '\mPZS\M'
UNION ALL SELECT 'PZ',      count(*) FROM products WHERE nombre ~ '\mPZ\M'
UNION ALL SELECT 'PIEZAS',  count(*) FROM products WHERE nombre ~ '\mPIEZAS\M'
UNION ALL SELECT 'PIEZA',   count(*) FROM products WHERE nombre ~ '\mPIEZA\M'
UNION ALL SELECT 'P (sufijo de digito, ej. 10P)', count(*) FROM products WHERE nombre ~ '[0-9]+P\M(?! [A-Z])'
ORDER BY n DESC;

\echo ''
\echo '====================================================================='
\echo ' 3. SUFIJOS DE PAQUETE — distribucion de patrones "/<N>" y similares'
\echo '====================================================================='
SELECT 'termina en /N (ej. /24)'        AS patron, count(*) AS n FROM products WHERE nombre ~ '/[0-9]+$'
UNION ALL SELECT 'termina en /N MARCA',        count(*) FROM products WHERE nombre ~ '/[0-9]+ [A-ZÑ]+$'
UNION ALL SELECT 'tiene / con espacio antes (ej. " / 24")', count(*) FROM products WHERE nombre ~ ' / [0-9]'
UNION ALL SELECT 'tiene /N PZAS, /N PZ, /N P', count(*) FROM products WHERE nombre ~ '/[0-9]+ ?(PZ|PZS|PZAS|PIEZAS|P)\M'
UNION ALL SELECT 'tiene "C/" (con)',           count(*) FROM products WHERE nombre ~ '\bC/'
ORDER BY n DESC;

\echo ''
\echo '====================================================================='
\echo ' 4. PRODUCTOS QUE TERMINAN CON SU MARCA — repeticion redundante'
\echo '====================================================================='
SELECT b.nombre AS marca, count(*) AS productos_con_marca_al_final
FROM products p
JOIN brands b ON b.id = p.brand_id
WHERE upper(p.nombre) LIKE '%' || upper(b.nombre) || '$' ESCAPE '\' -- no usar
   OR p.nombre ~ ('\m' || replace(b.nombre, ' ', '\s+') || '\s*$')
GROUP BY b.nombre
HAVING count(*) > 0
ORDER BY 2 DESC
LIMIT 15;

\echo ''
\echo '====================================================================='
\echo ' 5. CARACTERES "RAROS" QUE PUEDEN INDICAR ERRORES'
\echo '    ° (grado), # (numero), : (colon), ! (exclamacion), tabs/saltos'
\echo '====================================================================='
SELECT id, b.nombre AS marca, p.nombre
FROM products p
JOIN brands b ON b.id = p.brand_id
WHERE p.nombre ~ '[°#:!\t]'
ORDER BY p.nombre
LIMIT 30;

\echo ''
\echo '====================================================================='
\echo ' 6. NOMBRES DEMASIADO CORTOS (< 6 chars) - posibles abreviaturas raras'
\echo '====================================================================='
SELECT id, b.nombre AS marca, p.nombre, length(p.nombre) AS len
FROM products p
JOIN brands b ON b.id = p.brand_id
WHERE length(p.nombre) < 6
ORDER BY len, p.nombre;

\echo ''
\echo '====================================================================='
\echo ' 7. NOMBRES MUY LARGOS (> 70 chars) - posibles descripciones embebidas'
\echo '====================================================================='
SELECT id, b.nombre AS marca, length(p.nombre) AS len, p.nombre
FROM products p
JOIN brands b ON b.id = p.brand_id
WHERE length(p.nombre) > 70
ORDER BY len DESC
LIMIT 15;

\echo ''
\echo '====================================================================='
\echo ' 8. POSIBLES TRUNCAMIENTOS — terminan en letra suelta o preposicion'
\echo '====================================================================='
SELECT id, b.nombre AS marca, p.nombre
FROM products p
JOIN brands b ON b.id = p.brand_id
WHERE p.nombre ~ '\m(DE|CON|EN|LA|EL|UN|UNA|Y|O|DEL|AL|PARA)$'
   OR p.nombre ~ ' [A-Z]$'  -- letra suelta al final
ORDER BY p.nombre
LIMIT 30;

\echo ''
\echo '====================================================================='
\echo ' 9. POSIBLES DUPLICADOS POR VARIANTE DE TAMAÑO/CANTIDAD'
\echo '    Estrategia: quitar TODOS los digitos+unidades y agrupar.'
\echo '    Si quedan >=3 variantes del mismo "core" en la misma marca,'
\echo '    pueden ser productos legitimos (tamanos distintos) o duplicados.'
\echo '====================================================================='
WITH stripped AS (
  SELECT p.id, b.nombre AS marca, p.nombre AS original,
    -- Quitar digitos, unidades y separadores comunes para revelar el "core"
    TRIM(REGEXP_REPLACE(
      REGEXP_REPLACE(
        p.nombre,
        '[0-9]+\.?[0-9]*\s*(KG|GR|G|ML|L|MG|PZ|PZS|PZAS|PIEZAS|P)?', '', 'g'
      ),
      '\s+', ' ', 'g'
    )) AS core
  FROM products p
  JOIN brands b ON b.id = p.brand_id
)
SELECT marca, core, count(*) AS variantes, array_agg(original ORDER BY original) AS productos
FROM stripped
WHERE length(core) > 5
GROUP BY marca, core
HAVING count(*) >= 4
ORDER BY count(*) DESC
LIMIT 20;

\echo ''
\echo '====================================================================='
\echo ' 10. CARACTERES NO-ASCII USADOS (excluyendo Ñ que es valido)'
\echo '====================================================================='
WITH chars AS (
  SELECT unnest(regexp_split_to_array(string_agg(nombre, ''), '')) AS c FROM products
)
SELECT c AS caracter, ascii(c) AS codigo, count(*) AS apariciones
FROM chars
WHERE ascii(c) > 127 AND c <> 'Ñ' AND c <> 'ñ'
GROUP BY c
ORDER BY count(*) DESC
LIMIT 20;

\echo ''
\echo '====================================================================='
\echo ' AUDITORIA PASS 2 COMPLETA. Nada fue modificado.'
\echo '====================================================================='
