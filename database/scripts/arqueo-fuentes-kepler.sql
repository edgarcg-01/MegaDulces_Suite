-- ============================================================================
--  Arqueo de caja — qué más hay en la fuente de Kepler que no estamos leyendo
-- ============================================================================
--
--  SOLO LECTURA. La primera línea lo vuelve una garantía del motor, no una
--  promesa del comentario: cualquier INSERT/UPDATE/DELETE que se cuele aborta.
--
--  Por qué existe: `/tienda/arqueo` entero se para sobre UNA tabla,
--  `kepler_ods.kdpv_folio_caja`. El catálogo la declara con 49 columnas y el
--  código usa 25. Este script mide las siete preguntas que quedaron abiertas,
--  cada una con su control, y DECLARA "NO MEDIDO" cuando no hay datos con qué
--  contestar — un bloque sin filas no se pone verde (ADR-056).
--
--  Cómo correrlo (prod vive en k3s desde el 22-sep):
--      kubectl exec -it deploy/pg-prod -- psql -U postgres -d postgres_platform \
--        -f /tmp/arqueo-fuentes-kepler.sql
--  o, desde la máquina de feeds:
--      psql "$DATABASE_URL_NEW" -f database/scripts/arqueo-fuentes-kepler.sql
--
--  Ventana: son lecturas acotadas (kdpv_folio_caja ~3k cortes cerrados). El
--  único bloque que puede pesar es el 5 (kdc2*), y está detrás de un
--  statement_timeout. Aun así, el bloque 5 conviene correrlo fuera de horario.
-- ============================================================================

SET default_transaction_read_only = on;
SET statement_timeout = '60s';
SET lock_timeout = '2s';

\echo
\echo '════════════════════════════════════════════════════════════════════'
\echo ' 0 — Universo: qué hay en la tabla y desde cuándo'
\echo '════════════════════════════════════════════════════════════════════'

SELECT sucursal,
       count(*)                                           AS filas,
       count(*) FILTER (WHERE c10::date <> DATE '1800-01-01') AS cerrados,
       count(*) FILTER (WHERE c10::date  = DATE '1800-01-01') AS abiertos,
       min(c5::date)                                      AS desde,
       max(c5::date)                                      AS hasta,
       -- El sensor que NO existe: cuántos días hace que esta sucursal no
       -- publica un corte. `kepler_ods_branch_stale` mira kdm1, que viaja en
       -- el carril incremental; esta tabla viaja en el hash-delta.
       (current_date - max(c5::date))                     AS dias_sin_corte
  FROM kepler_ods.kdpv_folio_caja
 GROUP BY sucursal
 ORDER BY sucursal;

\echo
\echo '-- Sucursales con cortes en el ODS que NO están en commercial.warehouses.'
\echo '-- Esas pierden sus cortes en el INNER JOIN de cash-cuts-sync, en silencio,'
\echo '-- mientras la cajera SÍ ve sus turnos (salen del ODS directo).'

SELECT k.sucursal, count(*) AS cortes_que_se_pierden
  FROM kepler_ods.kdpv_folio_caja k
  LEFT JOIN commercial.warehouses w
         ON w.code = k.sucursal AND w.deleted_at IS NULL
 WHERE w.code IS NULL
 GROUP BY k.sucursal
 ORDER BY 2 DESC;

\echo
\echo '════════════════════════════════════════════════════════════════════'
\echo ' 1 — Las formas de pago: leemos c16 y c17, ¿qué traen c18, c19 y c20?'
\echo '════════════════════════════════════════════════════════════════════'
\echo '-- El decode del 07-jul dice que c16/c26, c17/c27 y c18-c20/c28-c30 son'
\echo '-- formas de pago (esperado/contado) y c36-c40 sus diferencias. El código'
\echo '-- lee TRES. Si alguna de las otras trae dinero:'
\echo '--   · cash_cuts.venta_total = c15+c16+c17 subdeclara la venta del turno;'
\echo '--   · Créditos y Cheques dejan de ser "sin contraparte" en la pantalla.'
\echo '-- CONTROL: c16 y c17 van en la misma tabla. Si las conocidas salen con'
\echo '-- dinero y las otras en cero, el cero es un hecho, no un error de lectura.'

WITH cerrados AS (
  SELECT * FROM kepler_ods.kdpv_folio_caja
   WHERE c10::date <> DATE '1800-01-01'
     AND c5::date >= current_date - 180
)
SELECT v.col,
       v.rol,
       count(*) FILTER (WHERE v.monto <> 0)                         AS cortes_con_monto,
       round(100.0 * count(*) FILTER (WHERE v.monto <> 0)
             / NULLIF(count(*), 0), 1)                              AS pct,
       round(sum(v.monto), 2)                                       AS suma_180d,
       round(max(v.monto), 2)                                       AS maximo
  FROM cerrados c
 CROSS JOIN LATERAL (VALUES
        ('c15', 'efectivo esperado   (LEÍDA)',      COALESCE(c.c15, 0)),
        ('c16', 'tarjeta esperado    (LEÍDA)',      COALESCE(c.c16, 0)),
        ('c17', 'transfer esperado   (LEÍDA)',      COALESCE(c.c17, 0)),
        ('c18', 'medio 4 esperado    — SIN LEER',   COALESCE(c.c18, 0)),
        ('c19', 'medio 5 esperado    — SIN LEER',   COALESCE(c.c19, 0)),
        ('c20', 'medio 6 esperado    — SIN LEER',   COALESCE(c.c20, 0)),
        ('c25', 'efectivo contado    (LEÍDA)',      COALESCE(c.c25, 0)),
        ('c26', 'tarjeta contado     (LEÍDA)',      COALESCE(c.c26, 0)),
        ('c27', 'transfer contado    (LEÍDA)',      COALESCE(c.c27, 0)),
        ('c28', 'medio 4 contado     — SIN LEER',   COALESCE(c.c28, 0)),
        ('c29', 'medio 5 contado     — SIN LEER',   COALESCE(c.c29, 0)),
        ('c30', 'medio 6 contado     — SIN LEER',   COALESCE(c.c30, 0))
      ) AS v(col, rol, monto)
 GROUP BY v.col, v.rol
 ORDER BY v.col;

\echo
\echo '-- EL ÁRBITRO: lo que la cajera declaró en Créditos y Cheques, contra las'
\echo '-- columnas candidatas del MISMO turno. Si una pega, el mapeo queda'
\echo '-- confirmado por un testigo independiente, no por el nombre de la columna.'

SELECT b.warehouse_code, b.caja, b.business_date, b.cash_cut_folio,
       round((b.medios->>'creditos')::numeric, 2) AS declaro_creditos,
       round((b.medios->>'cheques')::numeric, 2)  AS declaro_cheques,
       round(COALESCE(k.c28, 0), 2) AS c28,
       round(COALESCE(k.c29, 0), 2) AS c29,
       round(COALESCE(k.c30, 0), 2) AS c30
  FROM reconciliation.blind_counts b
  JOIN kepler_ods.kdpv_folio_caja k
    ON k.sucursal = b.warehouse_code
   AND k.c2       = b.caja
   AND k.c5::date = b.business_date
   AND k.c3::bigint::text = b.cash_cut_folio
 WHERE b.medios IS NOT NULL
   AND (b.medios ? 'creditos' OR b.medios ? 'cheques')
 ORDER BY b.business_date DESC
 LIMIT 50;

\echo '-- ↑ Cero filas = NO MEDIDO: nadie declaró créditos ni cheques todavía.'
\echo '--   No significa que las columnas estén vacías; significa que no hay testigo.'

\echo
\echo '════════════════════════════════════════════════════════════════════'
\echo ' 2 — c45 (`arqueo_otros`): ¿cierra el hueco que la identidad deja abierto?'
\echo '════════════════════════════════════════════════════════════════════'
\echo '-- cuadreTurno() usa c43 + c44 + c48 = c25 y cierra en ~63%. c45 se guarda'
\echo '-- (cash_cuts.arqueo_otros), se publica en /almacen/cuadre como "Otros /'
\echo '-- vales" y NO entra en la identidad. La pregunta es si el hueco ES c45.'

WITH base AS (
  SELECT sucursal, c2 AS caja, c5::date AS fecha,
         COALESCE(c25,0) AS contado,
         COALESCE(c43,0) + COALESCE(c44,0) + COALESCE(c48,0) AS suma_actual,
         COALESCE(c45,0) AS otros
    FROM kepler_ods.kdpv_folio_caja
   WHERE c10::date <> DATE '1800-01-01'
     AND COALESCE(c25,0) <> 0
     AND c5::date >= current_date - 180
), d AS (
  SELECT *,
         round(contado - suma_actual, 2)         AS hueco,
         round(contado - suma_actual - otros, 2) AS hueco_con_c45
    FROM base
)
SELECT count(*)                                                        AS cortes,
       count(*) FILTER (WHERE abs(hueco) <= 1)                         AS cierran_hoy,
       count(*) FILTER (WHERE abs(hueco_con_c45) <= 1)                 AS cierran_sumando_c45,
       count(*) FILTER (WHERE otros <> 0)                              AS cortes_con_c45,
       round(sum(abs(hueco)), 2)                                       AS hueco_total_hoy,
       round(sum(abs(hueco_con_c45)), 2)                               AS hueco_total_con_c45,
       -- EL VEREDICTO. Si "cierran_sumando_c45" supera a "cierran_hoy" de forma
       -- material, c45 es parte del cajón y la identidad está incompleta.
       CASE
         WHEN count(*) = 0 THEN 'NO MEDIDO — sin cortes en la ventana'
         WHEN count(*) FILTER (WHERE otros <> 0) = 0 THEN 'c45 vacía en todos: la afirmación del doc queda CONFIRMADA'
         WHEN count(*) FILTER (WHERE abs(hueco_con_c45) <= 1)
            > count(*) FILTER (WHERE abs(hueco) <= 1) THEN '⚠ c45 CIERRA cortes que hoy no cierran — revisar la identidad'
         ELSE 'c45 no mejora el cuadre: la identidad actual se sostiene'
       END                                                             AS veredicto
  FROM d;

\echo
\echo '-- El detalle de los peores, para mirarlos de a uno.'

WITH base AS (
  SELECT sucursal, c2 AS caja, c5::date AS fecha, c3::bigint AS folio,
         COALESCE(c25,0) AS contado,
         COALESCE(c43,0) AS billetes, COALESCE(c44,0) AS monedas,
         COALESCE(c45,0) AS otros,    COALESCE(c48,0) AS retirado
    FROM kepler_ods.kdpv_folio_caja
   WHERE c10::date <> DATE '1800-01-01' AND COALESCE(c25,0) <> 0
     AND c5::date >= current_date - 180
)
SELECT sucursal, caja, fecha, folio, contado, billetes, monedas, retirado, otros,
       round(contado - (billetes + monedas + retirado), 2)         AS hueco,
       round(contado - (billetes + monedas + retirado + otros), 2) AS hueco_con_c45
  FROM base
 WHERE abs(contado - (billetes + monedas + retirado)) > 1
 ORDER BY abs(contado - (billetes + monedas + retirado)) DESC
 LIMIT 25;

\echo
\echo '════════════════════════════════════════════════════════════════════'
\echo ' 3 — c12 (usuario de cierre): ¿cierra los cortes alguien que no es la cajera?'
\echo '════════════════════════════════════════════════════════════════════'
\echo '-- Usamos c7 (abre) y c8 (cierra). c12 está decodificado como "usuario'
\echo '-- cierre" y nunca se lee. En un módulo sobre a nombre de quién queda el'
\echo '-- dinero, que un tercero cierre el corte es justo lo que no se ve.'

SELECT count(*)                                                          AS cortes,
       count(*) FILTER (WHERE NULLIF(btrim(c12), '') IS NOT NULL)        AS con_c12,
       count(*) FILTER (WHERE upper(btrim(c12)) IS DISTINCT FROM upper(btrim(c8))
                          AND NULLIF(btrim(c12), '') IS NOT NULL)        AS c12_distinto_de_c8,
       count(*) FILTER (WHERE upper(btrim(c7)) IS DISTINCT FROM upper(btrim(c8))) AS handoff_c7_c8,
       CASE WHEN count(*) FILTER (WHERE NULLIF(btrim(c12), '') IS NOT NULL) = 0
            THEN 'NO MEDIDO — c12 viene vacía: no aporta identidad'
            ELSE 'c12 poblada: medir si aporta algo que c7/c8 no dicen'
       END                                                               AS veredicto
  FROM kepler_ods.kdpv_folio_caja
 WHERE c10::date <> DATE '1800-01-01'
   AND c5::date >= current_date - 180;

\echo
\echo '════════════════════════════════════════════════════════════════════'
\echo ' 4 — Inventario: cuáles de las 49 columnas traen dato y nadie lee'
\echo '════════════════════════════════════════════════════════════════════'
\echo '-- Contesta "qué más hay" sin adivinar: lista TODAS las columnas, marca'
\echo '-- las que el código ya consume, y deja ver cuáles tienen contenido.'

SELECT c.ordinal_position AS pos,
       c.column_name,
       c.data_type,
       CASE WHEN c.column_name = ANY (ARRAY[
              'sucursal','c2','c3','c5','c6','c7','c8','c10','c11','c13',
              'c15','c16','c17','c25','c26','c27','c35','c36','c37',
              'c43','c44','c45','c46','c47','c48','c49'])
            THEN 'leída'
            ELSE '— SIN LEER'
       END AS estado
  FROM information_schema.columns c
 WHERE c.table_schema = 'kepler_ods'
   AND c.table_name   = 'kdpv_folio_caja'
 ORDER BY c.ordinal_position;

\echo
\echo '-- Y cuáles de las numéricas sin leer traen dinero de verdad.'
\echo '-- (Recorre las columnas con dato; imprime sólo las que no son cero.)'

DO $$
DECLARE
  r      record;
  n      bigint;
  total  numeric;
  leidas text[] := ARRAY['c2','c3','c5','c15','c16','c17','c25','c26','c27',
                         'c35','c36','c37','c43','c44','c45','c46','c47','c48','c49'];
BEGIN
  RAISE NOTICE '  columna | cortes con valor <> 0 | suma 180d';
  RAISE NOTICE '  --------+-----------------------+----------';
  FOR r IN
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'kepler_ods'
       AND table_name   = 'kdpv_folio_caja'
       AND data_type IN ('numeric','double precision','real','integer','bigint')
       AND NOT (column_name = ANY (leidas))
     ORDER BY ordinal_position
  LOOP
    EXECUTE format(
      'SELECT count(*) FILTER (WHERE COALESCE(%I,0) <> 0), round(COALESCE(sum(%I),0),2)
         FROM kepler_ods.kdpv_folio_caja
        WHERE c10::date <> DATE ''1800-01-01'' AND c5::date >= current_date - 180',
      r.column_name, r.column_name)
      INTO n, total;
    IF n > 0 THEN
      RAISE NOTICE '  % | % | %', rpad(r.column_name, 7), lpad(n::text, 21), total;
    END IF;
  END LOOP;
  RAISE NOTICE '  (las que no aparecen vienen en cero en toda la ventana)';
END $$;

\echo
\echo '════════════════════════════════════════════════════════════════════'
\echo ' 5 — kdc2YYMM: ¿es el corte de caja movimiento a movimiento?'
\echo '════════════════════════════════════════════════════════════════════'
\echo '-- Contradicción a resolver: ops/vl/docker-compose.yml llama a kdc2* "las'
\echo '-- pólizas mensuales" y KEPLER_CATALOGO_TABLAS.md le dice "corte de caja'
\echo '-- diario" (c5=monto, c6=concepto vía kdco, c19=folio). Si lo segundo es'
\echo '-- cierto, la sangría existe como MOVIMIENTO y la tira "Sangrías de este'
\echo '-- turno" deja de inferirse de (c48 − lo que contamos) y pasa a ser exacta.'
\echo '-- Hoy sólo podemos decir "faltan $N por contar", no "falta UNA sangría de $N".'

DO $$
DECLARE
  t      text;
  n      bigint;
BEGIN
  SELECT table_name INTO t
    FROM information_schema.tables
   WHERE table_schema = 'kepler_ods' AND table_name ~ '^kdc2[0-9]{4}$'
   ORDER BY table_name DESC LIMIT 1;

  IF t IS NULL THEN
    RAISE NOTICE '  NO MEDIDO — no hay ninguna kdc2YYMM en kepler_ods.';
    RETURN;
  END IF;

  EXECUTE format('SELECT count(*) FROM kepler_ods.%I', t) INTO n;
  RAISE NOTICE '  Tabla más reciente: % (% filas)', t, n;
  RAISE NOTICE '  Corré a mano, con esa tabla, para decidir qué es:';
  RAISE NOTICE '    SELECT c6 AS concepto, count(*), round(sum(c5),2) AS monto';
  RAISE NOTICE '      FROM kepler_ods.%  GROUP BY c6 ORDER BY 3 DESC LIMIT 40;', t;
  RAISE NOTICE '  Si entre los conceptos aparece la SANGRÍA / RETIRO DE CAJA con';
  RAISE NOTICE '  folio (c19) que case contra kdpv_folio_caja.c3, el punto 5 está resuelto.';
END $$;

\echo
\echo '════════════════════════════════════════════════════════════════════'
\echo ' 6 — Wincaja: el único árbitro independiente del conteo por denominación'
\echo '════════════════════════════════════════════════════════════════════'
\echo '-- wincaja.arqueos tiene denominacion + cantidad por folio y caja, para 3'
\echo '-- sucursales. El módulo afirma que ese desglose "existe únicamente porque'
\echo '-- nuestra cajera lo captura": cierto para Kepler, falso para Wincaja. Es'
\echo '-- la única forma de comprobar que nuestro conteo ciego mide lo que dice.'

SELECT source_branch,
       count(DISTINCT folio)                   AS folios,
       count(*)                                AS renglones_denominacion,
       round(sum(denominacion * cantidad), 2)  AS total_contado,
       min(denominacion)                       AS denom_min,
       max(denominacion)                       AS denom_max
  FROM wincaja.arqueos
 GROUP BY source_branch
 ORDER BY source_branch;

\echo
\echo '-- ¿Hay solape con lo nuestro? Mismo almacén y misma fecha, los dos conteos.'
\echo '-- Cero filas = NO MEDIDO: no hay ventana donde los dos hayan contado.'

SELECT x.kepler_code                       AS sucursal,
       b.business_date,
       b.caja,
       round(b.total_contado, 2)           AS nuestro,
       round(w.total, 2)                   AS wincaja,
       round(b.total_contado - w.total, 2) AS delta
  FROM reconciliation.blind_counts b
  JOIN analytics.v_branch_erp_cutover x
    ON x.kepler_code = b.warehouse_code
  JOIN LATERAL (
        SELECT sum(a.denominacion * a.cantidad) AS total
          FROM wincaja.arqueos a
         WHERE a.source_branch = x.wincaja_source_branch
           AND a.caja = b.caja
       ) w ON w.total IS NOT NULL
 WHERE b.tipo = 'cierre'
 ORDER BY b.business_date DESC
 LIMIT 25;

\echo
\echo '════════════════════════════════════════════════════════════════════'
\echo ' 7 — Lo que el módulo ya tiene guardado, para ponerle tamaño a todo'
\echo '════════════════════════════════════════════════════════════════════'

SELECT tipo,
       count(*)                                    AS arqueos,
       count(DISTINCT warehouse_code)              AS sucursales,
       count(DISTINCT cajero_code)                 AS personas,
       round(sum(total_contado), 2)                AS total_contado,
       count(*) FILTER (WHERE validado_at IS NULL) AS sin_validar,
       min(business_date)                          AS desde,
       max(business_date)                          AS hasta
  FROM reconciliation.blind_counts
 GROUP BY tipo
 ORDER BY 2 DESC;

\echo
\echo '-- EL CANDADO DEL RETIRO: la clave única no excluye tipo=retiro, así que'
\echo '-- sólo cabe UNO por (sucursal, caja, fecha, cajera). Si alguna vez hubo'
\echo '-- dos sangrías el mismo día, la segunda pisó a la primera en silencio.'
\echo '-- Esto NO lo puede mostrar la tabla (la fila pisada ya no existe): se ve'
\echo '-- en el rastro de que el retiro contado quedó por debajo de lo que'
\echo '-- Kepler registró como retirado.'

SELECT b.warehouse_code, b.caja, b.business_date, b.cajero_code,
       round(b.total_contado, 2)            AS retiro_contado,
       round(cc.efectivo_retirado, 2)       AS retirado_kepler,
       round(cc.efectivo_retirado - b.total_contado, 2) AS sin_contar,
       round(cc.efectivo_retirado / NULLIF(b.total_contado, 0), 2) AS veces
  FROM reconciliation.blind_counts b
  JOIN analytics.cash_cuts cc
    ON cc.tenant_id      = b.tenant_id
   AND cc.warehouse_code = b.warehouse_code
   AND cc.caja           = b.caja
   AND cc.business_date  = b.business_date
 WHERE b.tipo = 'retiro'
   AND cc.efectivo_retirado > b.total_contado * 1.5
 ORDER BY (cc.efectivo_retirado - b.total_contado) DESC
 LIMIT 25;

\echo
\echo '-- Un `veces` cercano a un entero (2, 3, 4) es la huella del pisado:'
\echo '-- Kepler retiró N sangrías iguales y a nosotros nos quedó UNA.'
\echo
\echo '════════════════════════════════════════════════════════════════════'
\echo ' Fin. Lo que salió NO MEDIDO queda NO MEDIDO: no es un cero.'
\echo '════════════════════════════════════════════════════════════════════'
