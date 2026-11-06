-- `[CANON.5.11]` El refresco del consolidado Kepler (md:5433/kepler_consolidado) deja de colgarse
-- cuando la red parpadea.
--
-- ── QUÉ PASÓ ──────────────────────────────────────────────────────────────────────────────────
-- 2026-11-06, 09:14–10:36 (MX). Un corte de red de segundos dejó colgada la conexión `dblink` de
-- `mart.refresh_si_cambio` hacia una sucursal (wait_event = DblinkGetResult, 73 min). La sesión
-- retenía `mart.ventas` y las filas de `mart.refresh_state`, y cada refresco siguiente (cada 2 min,
-- `refresh-consolidado.js`) esperó su transacción hasta morir a los 60 s. Todas las sucursales
-- contestaban `pg_isready`. Se destrabó con `pg_terminate_backend`. Dos consultas por los
-- servidores `postgres_fdw` (`srv_md00..05`) estaban colgadas igual.
--
-- Causa: ninguna de esas conexiones tenía keepalives TCP ni límite de tiempo remoto. Además,
-- `refresh_si_cambio` no estaba versionada en ningún lado, y las tres funciones llevaban la
-- contraseña de `platform_ro` escrita en su código.
--
-- ── LO QUE SE MIDIÓ ANTES DE ESCRIBIR ESTO (PostgreSQL 18.6, contenedores desechables en md) ──
--   · Cortar la red de la "sucursal" a media consulta: SIN keepalives, dblink seguía esperando a
--     los 45 s (el incidente, reproducido); CON keepalives + tcp_user_timeout falló en 9 s.
--   · El statement_timeout LOCAL (el de 60 s que pone refresh-consolidado.js) NO interrumpe la
--     espera del resultado de dblink: con 3 s local, un pg_sleep(30) remoto esperó los 30 s. Por
--     eso el refresco no pudo cortarse solo. Sí interrumpe la espera al CONECTAR (5 s, medido).
--   · El statement_timeout REMOTO (options '-c statement_timeout=…') corta en el tiempo pedido.
--   · ⚠️ connect_timeout NO aplica bajo dblink en PG 18 (conecta en modo asíncrono): un destino
--     caído tardó 133 s en fallar (reintentos SYN del kernel). Se deja puesto porque no estorba,
--     pero NO es lo que protege: la conexión la acota el statement_timeout local del refresco.
--
-- ── QUÉ HACE ESTE SCRIPT ──────────────────────────────────────────────────────────────────────
--   0. Respalda las definiciones actuales en `refresh_si_cambio.antes.sql` (directorio donde se
--      corre). Ese archivo LLEVA LA CONTRASEÑA: no se sube al repo.
--   1. Un servidor `dblink_fdw` por sucursal de `dim.sucursales` (`srv_cons_<db>`) con
--      keepalives (20 s + 3 × 10 s) y tcp_user_timeout de 50 s para detectar una conexión muerta,
--      statement_timeout remoto de 50 s, y connect_timeout=10 (ver arriba: no es lo que protege). La credencial vive en su USER MAPPING (para `postgres`,
--      el rol con que corre el refresco), que se crea con la variable de psql `kepler_ro_pass`.
--   2. `mart.refresh_si_cambio` y `mart._refresh_one` conectan por NOMBRE de servidor. El resto
--      de su lógica es idéntica a lo que corría (medido con pg_get_functiondef el 2026-11-06).
--   3. A los `postgres_fdw` existentes (`srv_md00..05`) les agrega keepalives, tcp_user_timeout y
--      connect_timeout. NO les pone statement_timeout: los usan otras consultas que pueden ser
--      legítimamente largas.
--   4. Verificación: cada servidor nuevo contesta, y prueba negativa de que una consulta remota
--      lenta se CORTA por el statement_timeout remoto en vez de esperar (todo dentro de un ROLLBACK).
--
-- Con esto, un corte de red se vuelve un ERROR: la transacción se revierte (`mart.ventas` queda
-- como estaba) y el siguiente refresco, 2 min después, se recupera solo.
--
-- ⚠️ `mart.refresh_ventas` (el refresco completo, legado) sigue con su conexión vieja: no lo llama
-- ningún carril. Y NO reaplicar `mart_refresh_ventas.sql` después de esto: devolvería
-- `_refresh_one` a la versión sin timeouts.
--
-- ── CÓMO SE CORRE (en md) ─────────────────────────────────────────────────────────────────────
--   read -rs KEPLER_RO_PASS        # la de platform_ro en las sucursales; no queda en el historial
--   PGPASSWORD=... psql -h localhost -p 5433 -U postgres -d kepler_consolidado \
--        -v kepler_ro_pass="$KEPLER_RO_PASS" -f mart_refresh_si_cambio.sql
-- Idempotente: se puede correr de nuevo (crea lo que falta y actualiza lo que existe).
-- Para revertir: psql ... -f refresh_si_cambio.antes.sql (las funciones vuelven a la conexión vieja;
-- los servidores y mappings nuevos quedan sin uso).

\set ON_ERROR_STOP on
\if :{?kepler_ro_pass}
\else
  \echo '⛔ falta -v kepler_ro_pass=... (la contraseña de platform_ro). No se cambió nada.'
  \quit
\endif

-- ── 0. Respaldo de lo que hay ────────────────────────────────────────────────────────────────
\echo '== 0. respaldo de las definiciones actuales -> refresh_si_cambio.antes.sql'
\pset tuples_only on
\pset format unaligned
\o refresh_si_cambio.antes.sql
SELECT pg_get_functiondef('mart.refresh_si_cambio(integer)'::regprocedure) || ';';
SELECT pg_get_functiondef('mart._refresh_one(text,integer)'::regprocedure) || ';';
\o
\pset tuples_only off
\pset format aligned

BEGIN;

SELECT set_config('cons.kepler_ro_pass', :'kepler_ro_pass', true) IS NOT NULL AS credencial_cargada;

-- ── 1. Servidores dblink_fdw por sucursal + su USER MAPPING ──────────────────────────────────
\echo '== 1. servidores srv_cons_<db> con timeout y keepalives'
DO $do$
DECLARE
  r record; srv text; opts text;
BEGIN
  FOR r IN SELECT db, host, port, dbname FROM dim.sucursales ORDER BY db LOOP
    srv := 'srv_cons_' || r.db;
    IF NOT EXISTS (SELECT 1 FROM pg_foreign_server WHERE srvname = srv) THEN
      EXECUTE format(
        'CREATE SERVER %I FOREIGN DATA WRAPPER dblink_fdw OPTIONS ('
        || 'host %L, port %L, dbname %L, connect_timeout %L, keepalives %L, '
        || 'keepalives_idle %L, keepalives_interval %L, keepalives_count %L, tcp_user_timeout %L, options %L)',
        srv, r.host, r.port::text, r.dbname, '10', '1', '20', '10', '3', '50000', '-c statement_timeout=50000');
      RAISE NOTICE 'creado %', srv;
    ELSE
      EXECUTE format(
        'ALTER SERVER %I OPTIONS (SET host %L, SET port %L, SET dbname %L, SET connect_timeout %L, '
        || 'SET keepalives %L, SET keepalives_idle %L, SET keepalives_interval %L, SET keepalives_count %L, '
        || 'SET tcp_user_timeout %L, SET options %L)',
        srv, r.host, r.port::text, r.dbname, '10', '1', '20', '10', '3', '50000', '-c statement_timeout=50000');
      RAISE NOTICE 'actualizado %', srv;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_user_mappings WHERE srvname = srv AND usename = 'postgres') THEN
      EXECUTE format('CREATE USER MAPPING FOR postgres SERVER %I OPTIONS (user %L, password %L)',
                     srv, 'platform_ro', current_setting('cons.kepler_ro_pass'));
    ELSE
      EXECUTE format('ALTER USER MAPPING FOR postgres SERVER %I OPTIONS (SET user %L, SET password %L)',
                     srv, 'platform_ro', current_setting('cons.kepler_ro_pass'));
    END IF;
  END LOOP;
END
$do$;

-- ── 2. Las funciones conectan por nombre de servidor ─────────────────────────────────────────
\echo '== 2. mart.refresh_si_cambio y mart._refresh_one por servidor'
CREATE OR REPLACE FUNCTION mart.refresh_si_cambio(p_days integer DEFAULT 7)
 RETURNS TABLE(sucursal text, accion text, marcador bigint, filas bigint)
 LANGUAGE plpgsql
AS $function$
DECLARE
  r record; conninfo text; cur_marker bigint; prev_marker bigint; n bigint;
BEGIN
  FOR r IN SELECT db, host, port, dbname FROM dim.sucursales ORDER BY db LOOP
    -- [CANON.5.11] servidor dblink_fdw con timeout/keepalives; la credencial vive en su USER MAPPING
    conninfo := 'srv_cons_' || r.db;
    -- marcador barato: count de cabeceras de venta (read-only)
    SELECT m INTO cur_marker FROM dblink(conninfo,
      'SELECT count(*) FROM md.kdm1 WHERE c2=''U'' AND c3=''D''') AS t(m bigint);
    SELECT last_marker INTO prev_marker FROM mart.refresh_state WHERE db = r.db;

    IF prev_marker IS DISTINCT FROM cur_marker THEN
      n := mart._refresh_one(r.db, p_days);
      INSERT INTO mart.refresh_state(db, last_marker, last_checked, last_refreshed)
        VALUES (r.db, cur_marker, now(), now())
        ON CONFLICT (db) DO UPDATE SET last_marker=cur_marker, last_checked=now(), last_refreshed=now();
      sucursal:=r.db; accion:='REFRESCADO'; marcador:=cur_marker; filas:=n; RETURN NEXT;
    ELSE
      UPDATE mart.refresh_state SET last_checked=now() WHERE db=r.db;
      sucursal:=r.db; accion:='sin cambios'; marcador:=cur_marker; filas:=0; RETURN NEXT;
    END IF;
  END LOOP;
END; $function$;

CREATE OR REPLACE FUNCTION mart._refresh_one(p_db text, p_days integer)
 RETURNS bigint
 LANGUAGE plpgsql
AS $function$
DECLARE
  n bigint; v_cut date := current_date - p_days;
  conninfo text; remote_sql text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM dim.sucursales WHERE db = p_db) THEN
    RAISE EXCEPTION 'sucursal desconocida: %', p_db;
  END IF;
  -- [CANON.5.11] servidor dblink_fdw con timeout/keepalives; la credencial vive en su USER MAPPING
  conninfo := 'srv_cons_' || p_db;
  remote_sql := format($q$
    SELECT h.c1, h.c6, h.c9::date, h.c10, d.c8, d.c10, d.c11, d.c9::numeric, d.c12::numeric, d.c13::numeric, h.c4::int
    FROM md.kdm2 d JOIN md.kdm1 h ON h.c1=d.c1 AND h.c2=d.c2 AND h.c3=d.c3 AND h.c4=d.c4 AND h.c5=d.c5 AND h.c6=d.c6
    WHERE d.c2='U' AND d.c3='D' AND h.c4 IN (8,10,12) AND h.c9 >= %L
      AND d.c8 NOT IN ('00001','00002') AND btrim(d.c8) <> '' AND btrim(d.c10) <> ''
  $q$, v_cut);
  EXECUTE format('DELETE FROM mart.ventas WHERE sucursal=%L AND fecha >= %L', p_db, v_cut);
  -- Lista de columnas EXPLÍCITA (K.3): el `SELECT %L, t.*` posicional se rompía al agregar
  -- `doctype`, y peor, un día una columna nueva en otro orden lo habría desalineado en silencio.
  EXECUTE format($i$ INSERT INTO mart.ventas
      (sucursal, almacen, folio, fecha, forma_pago, sku, producto, unidad, cantidad, precio_neto, importe, doctype)
      SELECT %L, t.* FROM dblink(%L,%L) AS t(
      almacen text, folio text, fecha date, forma_pago text, sku text, producto text, unidad text,
      cantidad numeric, precio_neto numeric, importe numeric, doctype int) $i$, p_db, conninfo, remote_sql);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END; $function$;

-- ── 3. Los postgres_fdw existentes: connect_timeout + keepalives (sin statement_timeout) ─────
\echo '== 3. srv_md00..05 (postgres_fdw): keepalives, tcp_user_timeout y connect_timeout'
DO $do$
DECLARE
  s record; k text; v text;
  pares text[][] := ARRAY[['connect_timeout','10'],['keepalives','1'],['keepalives_idle','20'],
                          ['keepalives_interval','10'],['keepalives_count','3'],
                          ['tcp_user_timeout','50000']];
BEGIN
  FOR s IN SELECT srv.srvname, srv.srvoptions FROM pg_foreign_server srv
             JOIN pg_foreign_data_wrapper w ON w.oid = srv.srvfdw
            WHERE w.fdwname = 'postgres_fdw' AND srv.srvname ~ '^srv_md[0-9]+$' LOOP
    FOR i IN 1 .. array_length(pares, 1) LOOP
      k := pares[i][1]; v := pares[i][2];
      IF EXISTS (SELECT 1 FROM unnest(coalesce(s.srvoptions, '{}')) o WHERE split_part(o, '=', 1) = k) THEN
        EXECUTE format('ALTER SERVER %I OPTIONS (SET %I %L)', s.srvname, k, v);
      ELSE
        EXECUTE format('ALTER SERVER %I OPTIONS (ADD %I %L)', s.srvname, k, v);
      END IF;
    END LOOP;
    RAISE NOTICE 'endurecido %', s.srvname;
  END LOOP;
END
$do$;

COMMIT;

-- ── 4. Verificación ──────────────────────────────────────────────────────────────────────────
\echo '== 4a. cada servidor nuevo contesta (debe salir 1 en todas)'
SELECT r.db, t.ok
  FROM dim.sucursales r
  CROSS JOIN LATERAL dblink('srv_cons_' || r.db, 'SELECT 1') AS t(ok int)
 ORDER BY r.db;

\echo '== 4b. prueba negativa: una consulta remota lenta debe CORTARSE, no esperar'
--     Mide lo que SÍ protege (ver el encabezado): un servidor temporal, idéntico a srv_cons_<db>
--     pero con statement_timeout remoto de 2 s, contra un pg_sleep(20) remoto. Debe FALLAR en ~2 s;
--     si espera los 20 s, el límite remoto no está llegando. Va contra una réplica local
--     (127.0.0.1) si la hay, para no dormir ni 2 s a la caja de una sucursal. Todo se revierte.
--     El corte de red (keepalives) no se puede provocar desde aquí: se midió en contenedores
--     (9 s con keepalives, colgado a los 45 s sin ellos).
BEGIN;
SELECT set_config('cons.kepler_ro_pass', :'kepler_ro_pass', true) IS NOT NULL AS credencial_cargada;
DO $do$
DECLARE
  r record; t0 timestamptz; fallo boolean := false; msg text; seg numeric;
BEGIN
  SELECT db, host, port, dbname INTO r FROM dim.sucursales ORDER BY (host = '127.0.0.1') DESC, db LIMIT 1;
  EXECUTE format('CREATE SERVER srv_cons_prueba FOREIGN DATA WRAPPER dblink_fdw OPTIONS ('
              || 'host %L, port %L, dbname %L, keepalives %L, options %L)',
              r.host, r.port::text, r.dbname, '1', '-c statement_timeout=2000');
  EXECUTE format('CREATE USER MAPPING FOR postgres SERVER srv_cons_prueba OPTIONS (user %L, password %L)',
              'platform_ro', current_setting('cons.kepler_ro_pass'));
  t0 := clock_timestamp();
  BEGIN
    PERFORM * FROM dblink('srv_cons_prueba', 'SELECT pg_sleep(20)::text') AS t(x text);
  -- ⚠️ el corte remoto llega como 57014 (query_canceled), que `WHEN others` NO atrapa.
  EXCEPTION WHEN query_canceled OR others THEN fallo := true; msg := SQLERRM;
  END;
  seg := round(extract(epoch FROM clock_timestamp() - t0)::numeric, 1);
  IF NOT fallo OR seg > 10 THEN
    RAISE EXCEPTION 'el statement_timeout remoto NO cortó (contra %: % s, %)', r.db, seg, coalesce(msg, 'sin error');
  END IF;
  RAISE NOTICE 'statement_timeout remoto funciona: contra % cortó en % s (%)', r.db, seg, left(msg, 70);
END
$do$;
ROLLBACK;

\echo '== 4c. opciones finales (sin credenciales)'
SELECT srvname, array_to_string(srvoptions, ' ') AS opciones
  FROM pg_foreign_server WHERE srvname ~ '^srv_(cons_md_|md)[0-9]+' ORDER BY 1;
