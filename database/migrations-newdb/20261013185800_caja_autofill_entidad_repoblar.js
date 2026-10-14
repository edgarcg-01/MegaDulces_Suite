'use strict';
/**
 * ⛔⛔ `[CG.141]` — **La matvista del autollenado NACIÓ VACÍA, y el motivo que publica le echa la
 * culpa al dato.**
 *
 * `analytics.mv_caja_autofill_entidad` (creada hoy por `20261013102052`) está en producción
 * **poblada y con CERO filas**. Medido el 2026-10-13 contra prod:
 *
 *     relispopulated = t   ·   count(*) = 0
 *
 * ── La causa, con la prueba que la decide ───────────────────────────────────────────────────
 *
 * La matvista se construye leyendo `finance.v_caja_movimientos_pendientes`, y esa vista filtra
 * `WHERE tenant_id = current_tenant_id()`. La migración que la creó **etiqueta** el tenant en la
 * lista de selección (`'…d01c'::uuid AS tenant_id`) pero nunca lo **fija** en la sesión, así que
 * la fuente devolvió cero y la copia nació vacía. Misma sesión, mismo instante, misma consulta:
 *
 *     sin tenant (como corrió la migración) ......      0 filas
 *     con tenant (como la lee la app) ............ 13,302 filas
 *
 * ⭐⭐ La advertencia estaba escrita **en el archivo de al lado** y no se aplicó acá:
 * `caja-fecha-futura-scanner.service.ts` dice *"⛔ SIN ESTA LÍNEA EL UNIVERSO ES CERO, Y EL CERO
 * SE LEE COMO «no hay nada mal»"* sobre este mismísimo `set_config`. *Una lección documentada en
 * el servicio no protege a la migración que vive dos carpetas más allá.*
 *
 * ── Por qué importa más de lo que parece ────────────────────────────────────────────────────
 *
 * `CajaAutofillService.porEntidad()` consulta dos fuentes: `finance.caja_autofill_declarada`
 * (0 filas en prod) y esta matvista (0 filas). Con las dos vacías **toda** entidad cae en
 * `if (!r) return { reason: 'sin_historia' }` — o sea que el nivel «entidad» del autollenado no
 * propone nunca, y además **miente el motivo**: ese servicio distingue con cuidado `sin_fuente`
 * (el carril se cayó) de `sin_historia` (Kepler no tiene con qué), y una tabla que existe, se lee
 * y está vacía derrota esa distinción. El backend culpa al dato de un defecto de construcción.
 *
 * ⚠️ Es el mismo `[CG.127]` de ayer («el ingreso no tenía NINGÚN nivel de autollenado») un piso
 * más abajo, y es consistente con lo medido: **25 reclasificaciones sobre 70 movimientos (36 %)**.
 *
 * ── Lo que hace esta migración, y lo que NO ─────────────────────────────────────────────────
 *
 * Repuebla la copia con el tenant puesto. **No toca la definición**: la matvista está bien escrita
 * y su costo justifica materializarla — medido, la misma consulta en vivo cuesta **729–849 ms** la
 * pasada completa y **476–554 ms para UNA sola entidad** (el filtro no se empuja a través del
 * `rank()`), contra un presupuesto de 500 ms para una pantalla que consulta ~8 niveles por
 * captura. Materializar por costo es legítimo; lo que no lo es, es publicar el vacío.
 *
 * ⭐ El `REFRESH` va **sin `CONCURRENTLY` a propósito**, y no por comodidad: `CONCURRENTLY` no
 * corre dentro de una transacción, y es justamente la transacción la que hace que este defecto no
 * pueda repetirse — si al terminar la copia quedara vacía, la migración **se revierte entera** y
 * el contenido anterior sobrevive. Una copia vacía no se publica nunca más.
 *
 * ⚠️ Idempotente: repoblar dos veces con la misma fuente da el mismo resultado.
 *
 * ⭐ **Ensayado contra prod con el rol que ejecuta (`postgres`), en transacción y con `ROLLBACK`**
 * el 2026-10-13: 13,302 pendientes → **285 entidades** publicadas en **1,553 ms**
 * (210 `unanime` · 16 `dominante` · 10 `catalogo` · 49 `disperso`, que por diseño NO proponen),
 * y tras el `ROLLBACK` la copia volvió a 0 — o sea que la atomicidad de la que depende el párrafo
 * de arriba está probada, no supuesta. Son **236 entidades que hoy no proponen y van a proponer**.
 *
 * ⚠️ Esto repara el dato de HOY. Que no se vuelva a congelar es del carril de refresco
 * (`CajaAutofillRefreshService` + su renglón en `CRON_JOBS`), que va en el mismo cambio: **nada
 * refrescaba esta matvista** — cero consumidores de `REFRESH` en el repo, cero `job_key` en
 * `analytics.cron_runs`, cero umbral. Sin eso, repoblarla hoy sólo mueve la fecha del congelado.
 *
 * @param { import("knex").Knex } knex
 */

const MEGA = '00000000-0000-0000-0000-00000000d01c';
const MV = 'analytics.mv_caja_autofill_entidad';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ⛔ LA LÍNEA QUE FALTABA. `set_config(k, v, true)` y no `SET LOCAL`: Postgres rechaza
  // parámetros ligados en `SET` (42601), y el `true` lo hace local a ESTA transacción — así no
  // se filtra el tenant a la conexión que el pool le preste al siguiente.
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [MEGA]);

  // ── Prevuelo: ¿la FUENTE tiene algo? ───────────────────────────────────────────────────────
  // Se pregunta ANTES de refrescar para no cambiar una copia buena por una vacía. Cuesta ~20 ms.
  const fuente = Number((await knex.raw(
    `SELECT count(*)::int AS n
       FROM finance.v_caja_movimientos_pendientes
      WHERE entidad_code IS NOT NULL`,
  )).rows[0].n);

  if (fuente === 0) {
    throw new Error(
      '[CG.141] la fuente devolvió 0 filas CON el tenant puesto: refrescar ahora publicaría el '
      + 'vacío otra vez. Revisar `finance.v_caja_movimientos_pendientes` antes de reintentar.',
    );
  }

  const antes = Number((await knex.raw(`SELECT count(*)::int AS n FROM ${MV}`)).rows[0].n);

  await knex.raw(`REFRESH MATERIALIZED VIEW ${MV}`);

  const despues = Number((await knex.raw(`SELECT count(*)::int AS n FROM ${MV}`)).rows[0].n);

  if (despues === 0) {
    throw new Error(
      `[CG.141] la copia quedó VACÍA después del refresh (fuente ${fuente} filas). La migración se `
      + 'revierte entera: una matvista vacía se lee como «esta entidad no tiene historia», que es '
      + 'exactamente la mentira que este cambio viene a cerrar.',
    );
  }

  // eslint-disable-next-line no-console
  console.log(`[CG.141] ${MV}: ${antes} → ${despues} filas (fuente: ${fuente} pendientes con entidad).`);
};

/**
 * Sin vuelta atrás: el `up` sólo repuebla una copia derivada. Volver a vaciarla sería restaurar
 * el defecto, no revertir un cambio.
 */
exports.down = async function down() {
  // eslint-disable-next-line no-console
  console.log('[CG.141] sin vuelta: sólo repobló una copia derivada que estaba vacía.');
};
