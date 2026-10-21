'use strict';
/**
 * ⭐⭐ `[CGA-A.17u]` — **UNA SOLA REGLA para el concepto por cuenta.** Dos sesiones la
 * escribieron el mismo día, en dos lenguajes, con umbrales distintos.
 *
 * ── Lo que había ────────────────────────────────────────────────────────────────────────────
 *
 *   · `[CGA-A.17]` (migración `20261019135141`) la puso en SQL, como el peldaño `hist_cta` de
 *     la matvista `analytics.mv_caja_autofill_entidad` → la consume `porEntidad()`, o sea el
 *     formulario de captura.
 *   · `[CGA-A.17]` (TypeScript, `conceptoDominantePorCuenta()`) la puso en
 *     `cash-ledger.service.ts` → la consume `resolverCuentas()`: la bandeja, el lote y el
 *     autollenado.
 *
 * **Mismo código de ticket, misma pregunta, dos respuestas.** Es el defecto que `[CG.27-B.0]`
 * ya pagó entre la bandeja y el autofill: dos motores del mismo criterio divergen en silencio.
 *
 * ── En qué diferían, contrastadas contra prod el 2026-10-19 ─────────────────────────────────
 *
 *     coinciden en 3 cuentas:  115→071 · 201→201 · 511→059   (las que mueven el dinero)
 *     NUNCA proponen distinto  → no había error activo, pero sí uno latente
 *     la de SQL proponía 7 más, y las guardas de la de TS las frenaban:
 *
 *       102 → 011  ·  102-0011 → 011     ⛔ CAJA: el concepto dice CUÁL caja chica
 *       601-001 → 002 · 606-014 → 074    ⚠️ UNA sola entidad: no prueba ser de la cuenta
 *       150-002 · 601-010 · 611-007      soporte 3 < 5
 *
 * ⛔ **El caso de `102` ya tenía control.** Contra el puente por nombre de Kepler —otra fuente,
 * otro camino— sobre las 44 entidades con respuesta conocida, la dominancia coincidió 0 y
 * discrepó 1: `GG015`, cuenta `102`, donde Kepler dice `037` (CAJA CHICA MORELIA ABASTOS) y la
 * dominancia diría `011`. En una cuenta de CAJA el concepto identifica **cuál** caja: es de la
 * ENTIDAD. Derivarlo por cuenta manda el dinero a la caja de otra plaza. La migración
 * `20261013102052` ya lo había escrito con todas las letras.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *
 * 1. Crea `analytics.v_caja_concepto_por_cuenta`: **la regla, una vez**, con las guardas de la
 *    versión estricta y la procedencia de la otra (`n`, `total`, `entidades`, `dominancia`).
 * 2. Recrea la matvista para que su `hist_cta` **lea esa vista** en vez de recalcular.
 * 3. `cash-ledger.service.ts` consulta la misma vista (va en el mismo commit).
 *
 * ⭐ Gana la versión ESTRICTA, y el criterio es: *una propuesta que no se puede probar es peor
 * que ninguna, porque se acepta sin mirarla*. Lo que las guardas dejan fuera no se pierde: cae a
 * `finance.caja_autofill_declarada`, que desde `[CGA-A.18]` tiene endpoint propio y ya no exige
 * psql.
 *
 * ⚠️ **Sólo capturas de PERSONAS** (`created_by <> svc_caja_autollenado`). Ninguna de las dos
 * versiones lo filtraba del lado SQL. Hoy no cambia nada —el motor lleva 43 filas contra 229 de
 * personas— pero cuando escriba en volumen, derivar de sus propias filas sería pedirle que
 * confirme su decisión: el espejo de ADR-059.
 *
 * ── ⛔⛔ Dos trampas que esta migración respeta, y las dos ya están escritas en el repo ──────
 *
 * 1. **El tenant** (GOTCHAS §87.1, documentado HOY por la otra sesión): recrear esta matvista
 *    sin `app.tenant_id` la deja en CERO, porque su fuente `v_caja_movimientos_pendientes`
 *    filtra por `current_tenant_id()`. Se fija antes y **se verifica después**: si nace vacía,
 *    aborta.
 * 2. **`pg_get_viewdef` imprime según el `search_path` de quien pregunta** (`[VEC.1]`). Por eso
 *    la definición se toma del catálogo **con el `search_path` fijado**, y el reemplazo del
 *    bloque se **verifica**: si el marcador no aparece, aborta en vez de recrear algo distinto.
 *
 * ⭐ Y se parchea la definición VIVA en vez de congelar una copia: una copia se desincroniza en
 * cuanto alguien toque la matvista, y nadie se entera hasta que las dos vuelven a divergir —
 * que es exactamente el problema que esta migración viene a cerrar.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const MV = 'analytics.mv_caja_autofill_entidad';
const IDX = 'mv_caja_autofill_entidad_uq';
const SVC = '00000000-0000-0000-0000-0000000ca11e';

/**
 * ⭐ LA REGLA, UNA VEZ. Cada guarda con su porqué medido:
 *   · `102%` / `122%` fuera — CAJA y BANCO: ahí el concepto es de la entidad.
 *   · `entidades >= 3` — convierte «el concepto es de la CUENTA» en una MEDICIÓN: `511` tiene 19
 *     entidades distintas, `115` tiene 16; `601-001` tiene 1 y por eso no entra.
 *   · `total >= 5` y `n/total >= 0.8`, sin empate — soporte y dominancia.
 *   · `created_by <> SVC` — sólo personas, para que el motor no se confirme a sí mismo.
 */
const VISTA = `
CREATE OR REPLACE VIEW analytics.v_caja_concepto_por_cuenta AS
WITH h AS (
  SELECT l.tenant_id,
         l.kepler_cuenta   AS cuenta,
         l.kepler_concepto AS concepto,
         count(*)::int                       AS n,
         count(DISTINCT l.beneficiario)::int AS entidades
    FROM finance.cash_ledger l
   WHERE l.deleted_at IS NULL
     AND l.estado <> 'cancelado'::text
     AND l.kepler_cuenta IS NOT NULL
     AND l.kepler_concepto IS NOT NULL
     AND l.created_by <> '${SVC}'::uuid
     AND l.kepler_cuenta NOT LIKE '102%'
     AND l.kepler_cuenta NOT LIKE '122%'
   GROUP BY 1,2,3
), r AS (
  SELECT h.*,
         sum(h.n)     OVER (PARTITION BY h.tenant_id, h.cuenta)                              AS total,
         row_number() OVER (PARTITION BY h.tenant_id, h.cuenta ORDER BY h.n DESC, h.concepto) AS rk,
         lead(h.n)    OVER (PARTITION BY h.tenant_id, h.cuenta ORDER BY h.n DESC, h.concepto) AS n_siguiente
    FROM h
)
SELECT r.tenant_id, r.cuenta, r.concepto, r.n, r.total::int AS total, r.entidades,
       round(r.n::numeric / NULLIF(r.total,0), 4) AS dominancia
  FROM r
 WHERE r.rk = 1
   AND r.total >= 5
   AND r.entidades >= 3
   AND r.n::numeric / NULLIF(r.total,0) >= 0.8
   AND (r.n_siguiente IS NULL OR r.n_siguiente < r.n)
`;

/** El bloque que se reemplaza. Si no aparece TAL CUAL, la migración aborta. */
const MARCADOR = 'hist_cta AS (';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  // ⛔ Antes de tocar la matvista: su fuente filtra por current_tenant_id(). Sin esto nace vacía.
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  // ⛔ Y antes de leer la definición: `pg_get_viewdef` imprime según el search_path.
  await knex.raw(`SET LOCAL search_path = public, analytics, finance, kepler_ods`);

  await knex.raw(VISTA);
  await knex.raw(`GRANT SELECT ON analytics.v_caja_concepto_por_cuenta TO app_runtime`)
    .catch(() => undefined); // el rol puede no existir en un destino de desarrollo

  const { rows: [d] } = await knex.raw(
    `SELECT pg_get_viewdef(?::regclass, true) AS def`, [MV]);
  const defVieja = String(d && d.def ? d.def : '');
  if (!defVieja.includes(MARCADOR)) {
    throw new Error(
      `[CGA-A.17u] no encontré "${MARCADOR}" en la definición viva de ${MV}. `
      + 'La matvista cambió de forma: revisá el diff ANTES de recrearla, no la pises a ciegas.');
  }

  // Se reemplaza el CUERPO del CTE `hist_cta` por una lectura de la vista. El cuerpo va desde el
  // marcador hasta el paréntesis que lo cierra, que se localiza CONTANDO paréntesis — un regex
  // perezoso cortaría en el primer `)` interno, que los hay.
  const ini = defVieja.indexOf(MARCADOR) + MARCADOR.length;
  let prof = 1;
  let fin = ini;
  while (fin < defVieja.length && prof > 0) {
    const ch = defVieja[fin];
    if (ch === '(') prof += 1;
    else if (ch === ')') prof -= 1;
    if (prof === 0) break;
    fin += 1;
  }
  if (prof !== 0) {
    throw new Error('[CGA-A.17u] no pude cerrar el paréntesis de hist_cta: definición inesperada.');
  }
  const defNueva = defVieja.slice(0, ini)
    + `
         /* [CGA-A.17u] UNA SOLA REGLA: vive en analytics.v_caja_concepto_por_cuenta, que es lo
            que tambien consume resolverCuentas(). Antes estaba escrita aca Y en TypeScript. */
         SELECT cuenta, concepto, n, total FROM analytics.v_caja_concepto_por_cuenta
       `
    + defVieja.slice(fin);

  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
  await knex.raw(`CREATE MATERIALIZED VIEW ${MV} AS ${defNueva}`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${IDX} ON ${MV} (tenant_id, entidad_code)`);
  await knex.raw(`GRANT SELECT ON ${MV} TO app_runtime`).catch(() => undefined);

  // ⛔ La guarda que GOTCHAS §87.1 pide: una matvista que nace vacía se ve igual que una sana.
  const { rows: [v] } = await knex.raw(`SELECT count(*)::int AS n FROM ${MV}`);
  if (Number(v.n) === 0) {
    throw new Error('[CGA-A.17u] la matvista nació en CERO: app.tenant_id no quedó fijado (GOTCHAS §87.1)');
  }
  const { rows: [reg] } = await knex.raw(
    `SELECT count(*)::int AS n FROM analytics.v_caja_concepto_por_cuenta WHERE tenant_id = ?`, [TENANT]);
  // eslint-disable-next-line no-console
  console.log(`[CGA-A.17u] ${v.n} entidades en la matvista · la regla publica ${reg.n} cuenta(s)`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  // ⛔ NO se recrea la matvista con la regla duplicada: eso sería deshacer la unificación a
  // medias y dejar dos verdades otra vez. Si hay que revertir de verdad, se revierte la
  // migración 20261019135141 entera, que es la dueña de la definición.
  // ⚠️ Por eso este `down` deja la matvista leyendo una vista que ya no existe: es a propósito,
  // para que un revert a ciegas FALLE en vez de restaurar el defecto en silencio.
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_caja_concepto_por_cuenta CASCADE`);
};
