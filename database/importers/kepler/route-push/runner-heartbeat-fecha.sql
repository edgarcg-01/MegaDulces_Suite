-- `[RD.53]` — El latido del push de ruta deja de medir FILAS y pasa a medir **FECHA ENTREGADA**.
--
-- Aplicar UNA vez en `kepler_consolidado` (192.168.0.222:5433, el servidor `md`).
-- Aditivo sobre `runner-heartbeat.sql`. Idempotente.
--
-- ── EL DEFECTO, MEDIDO EN VIVO EL 2026-10-08 ──────────────────────────────────────────────
--
--   camioneta    latido dice                        lo que de verdad llego
--   ruta_504     4.3 h sin reportar · 5,348 filas   su venta mas nueva es del 2026-10-01
--   ruta_505     571.6 h sin reportar               2026-09-10
--
-- Las otras nueve estan al dia. O sea que el latido **ve a la 505 y NO ve a la 504**, que es
-- justo la que rompe: sube todos los dias, entrega miles de filas, y lo que entrega no tiene
-- fechas nuevas. `merge_route_sales` borra por fecha e inserta lo que llego, asi que reescribe
-- la misma ventana vieja una y otra vez y reporta exito.
--
-- ⭐ **El problema esta en el Kepler de la camioneta, no en el carril** -- y el latido no podia
-- verlo porque medir "cuantas filas entregó" no distingue *entregar lo de hoy* de *entregar
-- otra vez lo de la semana pasada*. Con la fecha en el latido, la 504 se habria visto el 2 de
-- octubre; se vio el 8, y para entonces la quincena 20 ya le pagaba **$0 en vez de $1,092.46**
-- porque le faltaban 7 de 12 dias y el tramo mas bajo es un acantilado.
--
-- ── LO QUE SE AGREGA, Y POR QUE TRES COLUMNAS Y NO UNA ────────────────────────────────────
--
--   max_fecha              la fecha mas nueva que trajo ESTE push
--   min_fecha              la mas vieja: dice que ventana reescribio
--   max_fecha_avanzo_en    ⭐ CUANDO fue la ultima vez que `max_fecha` CRECIO
--
-- La tercera es la que nombra el defecto. `max_fecha` sola dice "esta atrasado"; con
-- `max_fecha_avanzo_en` se ve **desde cuando** sube lo mismo, que es lo que separa *hoy no
-- vendio* (normal, pasa los domingos) de *hace una semana que no trae nada nuevo*.
--
-- ⚠️ `max_fecha` **sólo avanza, nunca retrocede**: un push parcial que traiga una ventana vieja
-- no puede hacer que el latido se vea peor de lo que esta. Lo que un push viejo NO hace es
-- mover `max_fecha_avanzo_en`, y ahi queda el rastro.

BEGIN;

ALTER TABLE ingest.route_push_heartbeat ADD COLUMN IF NOT EXISTS max_fecha date;
ALTER TABLE ingest.route_push_heartbeat ADD COLUMN IF NOT EXISTS min_fecha date;
ALTER TABLE ingest.route_push_heartbeat ADD COLUMN IF NOT EXISTS max_fecha_avanzo_en timestamptz;

COMMENT ON COLUMN ingest.route_push_heartbeat.max_fecha IS
  'RD.53 - la fecha de venta mas nueva que trajo el push. Solo avanza. Medir filas entregadas no distingue entregar lo de hoy de reentregar lo de la semana pasada: la ruta_504 reportaba 5,348 filas y 4.3 h de frescura con la venta parada el 2026-10-01.';
COMMENT ON COLUMN ingest.route_push_heartbeat.max_fecha_avanzo_en IS
  'RD.53 - cuando crecio max_fecha por ultima vez. Es lo que separa "hoy no vendio" (pasa los domingos) de "hace una semana que sube lo mismo". Un push con ventana vieja NO la mueve.';

-- ── La funcion: IDENTICA A LA QUE CORRE + la captura de fechas ─────────────────────────────
--
-- ⛔ Se copio de `pg_get_functiondef` de la base VIVA, no de `runner-heartbeat.sql`: la que
-- corre **no es** la de ese archivo. Tiene ademas el manejo de `client_ip` que agrego
-- `runner-heartbeat-ip.sql`, con su `COALESCE` para no perder la ultima direccion conocida.
-- Haber copiado del archivo del repo habria borrado esa columna en silencio -- y `client_ip`
-- es justo con lo que se identifico de donde subia la ruta_504 (`192.168.50.21`).
--
-- ⚠️ Las fechas se leen de la staging ANTES de vaciarla, y en la misma transaccion.
CREATE OR REPLACE FUNCTION ingest.merge_route_sales(p_truck text, p_days int DEFAULT 15)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = mart, ingest, public AS $fn$
DECLARE
  n bigint;
  v_max date;
  v_min date;
BEGIN
  -- Lo que trae ESTE push, antes de tocar nada.
  SELECT max(fecha), min(fecha) INTO v_max, v_min
    FROM ingest.route_sales_stg WHERE truck = p_truck;

  DELETE FROM mart.ventas v
   USING (SELECT DISTINCT fecha FROM ingest.route_sales_stg WHERE truck=p_truck) b
   WHERE v.sucursal=p_truck AND v.fecha=b.fecha;
  INSERT INTO mart.ventas (sucursal, almacen, folio, fecha, forma_pago, sku, producto, unidad, cantidad, precio_neto, importe)
    SELECT truck, almacen, folio, fecha, forma_pago, sku, producto, unidad, cantidad, precio_neto, importe
    FROM ingest.route_sales_stg WHERE truck = p_truck;
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM ingest.route_sales_stg WHERE truck = p_truck;

  -- Latido: solo se escribe si el merge llego hasta aqui (push exitoso).
  INSERT INTO ingest.route_push_heartbeat
    (truck, last_ok, rows_last, last_run, client_ip, max_fecha, min_fecha, max_fecha_avanzo_en)
  VALUES (p_truck, now(), n, now(), inet_client_addr(), v_max, v_min,
          CASE WHEN v_max IS NOT NULL THEN now() END)
  ON CONFLICT (truck) DO UPDATE
    SET last_ok   = EXCLUDED.last_ok,
        rows_last = EXCLUDED.rows_last,
        last_run  = EXCLUDED.last_run,
        -- COALESCE: si algun dia el merge se llamara desde un socket local
        -- (sin client_addr), no se pierde la ultima direccion conocida.
        client_ip = COALESCE(EXCLUDED.client_ip, ingest.route_push_heartbeat.client_ip),
        min_fecha = EXCLUDED.min_fecha,
        -- ⭐ `max_fecha` SOLO AVANZA: un push con ventana vieja no puede empeorar el latido.
        max_fecha = GREATEST(route_push_heartbeat.max_fecha, EXCLUDED.max_fecha),
        -- ⭐ Y la marca de avance SOLO se mueve si de verdad crecio. Ese es todo el truco:
        -- un push que reentrega lo mismo deja esta columna quieta y ahi se ve el atraso.
        max_fecha_avanzo_en = CASE
          WHEN EXCLUDED.max_fecha IS NOT NULL
           AND (route_push_heartbeat.max_fecha IS NULL OR EXCLUDED.max_fecha > route_push_heartbeat.max_fecha)
          THEN now()
          ELSE route_push_heartbeat.max_fecha_avanzo_en
        END;

  RETURN n;
END; $fn$;

-- ── La salud de la flota, DECLARADA ────────────────────────────────────────────────────────
-- ⚠️ Esta vista NOMBRA, no alarma: un umbral de dias vive en el monitor, no acá. Y declara las
-- dos ausencias por separado, que no son la misma cosa -- `sin_medir` es que el push todavia
-- no paso por la version nueva de la funcion, y eso NO es que este sano.
CREATE OR REPLACE VIEW ingest.v_route_push_salud AS
SELECT h.truck,
       h.client_ip,
       h.last_ok,
       h.rows_last,
       h.max_fecha,
       h.max_fecha_avanzo_en,
       round(extract(epoch FROM now() - h.last_ok) / 3600, 1)            AS horas_sin_push,
       (current_date - h.max_fecha)                                      AS dias_de_atraso,
       round(extract(epoch FROM now() - h.max_fecha_avanzo_en) / 3600, 1) AS horas_sin_avanzar,
       CASE
         WHEN h.max_fecha IS NULL                        THEN 'sin_medir'
         WHEN now() - h.last_ok > interval '24 hours'    THEN 'no_sube'
         WHEN current_date - h.max_fecha > 1             THEN 'sube_pero_sin_fechas_nuevas'
         ELSE                                                 'al_dia'
       END AS veredicto
  FROM ingest.route_push_heartbeat h;

COMMENT ON VIEW ingest.v_route_push_salud IS
  'RD.53 - la salud del push por camioneta. `no_sube` y `sube_pero_sin_fechas_nuevas` son dos fallas DISTINTAS y se arreglan distinto: la primera es el carril, la segunda es el Kepler de la camioneta. El latido viejo solo veia la primera, y por eso la ruta_504 estuvo 7 dias en verde con la venta parada. `sin_medir` declara que el push todavia no paso por la funcion nueva -- que no es estar sano.';

GRANT SELECT ON ingest.v_route_push_salud TO ingest;

COMMIT;
