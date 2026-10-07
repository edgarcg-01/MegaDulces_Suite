# Incidente 2026-09-11 — `/tienda/live` inutilizable por un job que yo lancé a media tarde

**Duración del impacto:** ~25 min visibles (≈15:00–15:35 MX).
**Pérdida de datos:** ninguna.
**Causa:** decisión de operación, no un bug.

## Qué pasó

A las **12:56** lancé a mano `WincajaSyncActual` para cerrar el rezago de 3 días de la pierna
Wincaja del sell-out. A las **14:53** terminó BRONZE y entró al paso GOLD:
`import-wincaja-analytics.js`, un **UPSERT de 3,789,390 filas** sobre `analytics.sales_daily`
en prod (Railway).

Ese UPSERT dejó a Postgres clavado en `IO/DataFileRead` durante **más de 30 minutos**. Con el
disco saturado, las consultas de `/tienda/live` se arrastraron y el poller empezó a recibir
`502` del API al empujar tickets. Edgar reportó la pantalla caída.

## Lo que NO era

El primer instinto —"se cayó la ingesta otra vez, como a la mañana"— era falso, y medirlo
primero evitó tocar lo que no había que tocar:

- **El dato estaba fresco**: las 8 sucursales con tickets de hace 0.2–4.2 min.
- **El poller entregaba** cada ~25 s desde `md`.
- **El API respondía**: `/api/health` 200 en 0.2 s, 15 de 15 sondeos.

O sea: el pipeline estaba sano y el problema era **contención de recursos en el destino**.

## El agravante que apareció al segundo vistazo

Maté el proceso de Windows y el `node`, pero **Postgres no se entera de que el cliente murió
hasta que la consulta termina**: el backend siguió corriendo huérfano. A los 33 min ya no sólo
consumía disco — **estaba bloqueando a los carriles legítimos**: dos `INSERT INTO
analytics.sales_daily` y un `UPDATE logistics.trackers` esperando en `Lock/transactionid`
detrás de él. Un job abortado a medias es peor que uno corriendo.

Se canceló con `pg_cancel_backend(1200175)` (con autorización explícita de Edgar: la primera
vez el clasificador de seguridad lo bloqueó, y con razón). Los bloqueos se liberaron de
inmediato.

## Estado en que quedó — parcial, no corrupto

- **BRONZE commiteó**: `wincaja.maestro_mov_almacen` (sucursales 00 y 30) pasó de `2026-09-08`
  a `2026-09-10`.
- **GOLD revirtió**: `mv_wincaja_sales_daily` sigue en `2026-09-08`.

No hace falta reparar nada: el importer es idempotente por UPSERT y la corrida programada de
las **05:00** completa el GOLD sola.

## La lección, que es mía

⛔ **Un trabajo de escritura pesada contra prod no se lanza en horario hábil, ni siquiera para
cerrar un hueco de días.** El hueco de Wincaja tenía 3 días, no era urgente, y encima —dicho
por mí mismo cuando lo lancé— **no iba a llegar a "hoy" de todos modos**, porque el dataset
`actual` arrastra ~2 días de rezago propio. Cambié un problema que nadie estaba mirando por
una pantalla de operación caída a media tarde.

La ventana correcta ya existía y la ignoré: la tarea corre sola a las **05:00**.

⚠️ Y una regla concreta que sale de acá: **matar al cliente NO cancela la consulta**. Si hay
que abortar un job pesado contra Postgres, el paso que importa es `pg_cancel_backend` sobre el
PID del servidor; matar el proceso local sólo deja un huérfano que sigue consumiendo y, peor,
sigue tomando locks.

## Por qué la tarea sigue siendo interactiva (y no se "arregla" moviéndola)

Se evaluó pasarla a que corra sin sesión (como el respaldo diario, que es `S4U`). **No se
puede**: el sync lee los `.mdb` de `Z:\Salidas\Bases`, y `Z:` es una unidad **mapeada por
sesión**. Un token `S4U` además no lleva credenciales de red, así que tampoco serviría la ruta
UNC. Es el mismo bloqueo que documenta **VL.5**, y es la razón por la que esta tarea no corrió
sola el 2026-09-11 tras el reinicio nocturno de `.249`.
