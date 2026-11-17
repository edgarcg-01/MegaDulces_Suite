/**
 * `[CANON.6.21]` Sensor de Salud BD de la EXISTENCIA POR EVENTO: el precio, los dos factores de caja y el costo
 * unitario que dejan de refrescarse cada 5 minutos (`existencia-aux`) y se recalculan al llegar el cambio.
 *
 * La cadena: los disparadores `tg_existencia_*` anotan SKUs en `analytics.llaves_sucias` (si el interruptor
 * `analytics.existencia_por_evento` está prendido) → el worker (`ExistenciaPorEventoService`) llama a
 * `analytics.drenar_existencia()` → cada corrida queda en `analytics.existencia_corridas`. Este sensor no compara
 * nada: lee lo que la cadena dejó escrito y dice si está viva. Es el sensor que reemplaza al latido de
 * `existencia-aux` (oleada 8b, paso 6: ese latido no se retira antes de que éste exista).
 *
 * Veredicto, codificado como EDAD porque `classify()` sólo sabe leer edad (`warnH 24 / critH 48`):
 *   apagado        → now() - 30 h  → warn      el estado objetivo no está alcanzado; encenderlo es del PM
 *   falla          → now() - 100 d → critical  la última corrida falló (la cola quedó intacta)
 *   atorada        → now() - 100 d → critical  una marca lleva más de 15 min en la cola: el worker no drena
 *   errores        → now() - 30 h  → warn      un disparador no pudo anotar (la escritura pasó; la corrige la mañana)
 *   sin_completo   → now() - 30 h  → warn      30 h sin recálculo completo: el worker no ha corrido hoy
 *   ok             → now()                     y la nota trae el árbitro de la última completa
 * Si las tablas no existen todavía (la migración 20261117094325 sin aplicar), `db-health` lo dice solo: «tabla
 * no existe», sin color.
 *
 * El árbitro de la nota (filas escritas por la última corrida completa) INCLUYE lo que la fecha movió: precios que
 * salen de la ventana de 90 días cada medianoche. No es un conteo de eventos perdidos.
 *
 * Sin acentos graves en el SQL: vive en un template literal. La prueba que lo ejerce contra base real, en cada
 * estado: `database/tests/test-newdb-existencia-por-evento.js` (sección L).
 */
export const EXISTENCIA_EVENTO_SQL = `
  WITH s AS MATERIALIZED (
    SELECT (SELECT bool_or(encendida) FROM analytics.existencia_por_evento) AS encendida,
           (SELECT count(*) FROM analytics.llaves_sucias)::int AS marcas,
           (SELECT min(created_at) FROM analytics.llaves_sucias) AS mas_vieja,
           (SELECT count(*) FROM analytics.llaves_sucias_errores WHERE created_at > now() - interval '24 hours')::int AS errores,
           (SELECT string_agg(DISTINCT tabla || ':' || operacion, ', ') FROM analytics.llaves_sucias_errores
             WHERE created_at > now() - interval '24 hours') AS donde,
           (SELECT modo FROM analytics.existencia_corridas ORDER BY id DESC LIMIT 1) AS ultimo_modo,
           (SELECT mensaje FROM analytics.existencia_corridas ORDER BY id DESC LIMIT 1) AS ultimo_mensaje,
           (SELECT max(created_at) FROM analytics.existencia_corridas WHERE modo = 'completo') AS ultimo_completo,
           (SELECT resultado FROM analytics.existencia_corridas WHERE modo = 'completo' ORDER BY id DESC LIMIT 1) AS arbitro,
           (SELECT count(*) FROM analytics.existencia_corridas WHERE modo = 'llave' AND created_at > now() - interval '24 hours')::int AS por_llave,
           (SELECT count(*) FROM analytics.existencia_corridas WHERE modo = 'completo' AND created_at > now() - interval '24 hours')::int AS completas),
  e AS (
    SELECT s.*, CASE WHEN s.encendida IS NOT TRUE THEN 'apagado'
                     WHEN s.ultimo_modo = 'error' THEN 'falla'
                     WHEN s.mas_vieja < now() - interval '15 minutes' THEN 'atorada'
                     WHEN s.errores > 0 THEN 'errores'
                     WHEN s.ultimo_completo IS NULL OR s.ultimo_completo < now() - interval '30 hours' THEN 'sin_completo'
                     ELSE 'ok' END AS estado
      FROM s),
  a AS (
    SELECT COALESCE(sum((x->>'insertadas')::int + (x->>'actualizadas')::int + (x->>'borradas')::int), 0) AS dif,
           string_agg((x->>'objeto') || ' ' || (x->>'insertadas') || '/' || (x->>'actualizadas') || '/' || (x->>'borradas'), ' · ') AS por_tabla
      FROM e LEFT JOIN LATERAL jsonb_array_elements(COALESCE(e.arbitro, '[]'::jsonb)) x ON true)
  SELECT CASE e.estado WHEN 'ok' THEN now()
                       WHEN 'falla' THEN now() - interval '100 days'
                       WHEN 'atorada' THEN now() - interval '100 days'
                       ELSE now() - interval '30 hours' END AS last_update,
         CASE e.estado
           WHEN 'apagado' THEN 'APAGADO: los disparadores no anotan y existencia-aux sigue refrescando cada 5 min — encenderlo (analytics.existencia_por_evento) es decisión del PM'
           WHEN 'falla' THEN 'la última corrida FALLÓ (' || coalesce(e.ultimo_mensaje, '?') || '): la cola quedó intacta; detalle en analytics.existencia_corridas'
           WHEN 'atorada' THEN e.marcas || ' marcas en la cola, la más vieja del ' || to_char(e.mas_vieja AT TIME ZONE 'America/Mexico_City', 'DD/MM HH24:MI')
                               || ': el que drena (worker) no está corriendo'
           WHEN 'errores' THEN e.errores || ' fallas de los disparadores en 24 h (' || coalesce(e.donde, '?')
                               || '): esas escrituras pasaron sin anotar; las corrige el recálculo completo de la mañana'
           WHEN 'sin_completo' THEN 'sin recálculo completo en 30 h (último: '
                               || coalesce(to_char(e.ultimo_completo AT TIME ZONE 'America/Mexico_City', 'DD/MM HH24:MI'), 'nunca')
                               || '): el que drena no ha corrido'
           ELSE e.por_llave || ' corridas por llave y ' || e.completas || ' completas en 24 h · cola: ' || e.marcas || ' marcas · última completa '
                || to_char(e.ultimo_completo AT TIME ZONE 'America/Mexico_City', 'DD/MM HH24:MI') || ', árbitro: ' || a.dif
                || ' filas escritas (' || coalesce(a.por_tabla, '—') || '; incluye lo que la fecha movió)'
         END AS note_extra
    FROM e, a`;
