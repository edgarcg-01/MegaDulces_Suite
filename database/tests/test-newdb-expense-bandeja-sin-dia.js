/* eslint-disable no-console */
/**
 * `[GX.67]` — Smoke DB-directo de **la bandeja de aprobación sin acotar por día**.
 *
 * ## Qué defecto vigila
 * La pantalla de Aprobación mostraba **sólo los vales levantados hoy**, y se limitaba a
 * *avisar* cuántos habían quedado afuera — sin ninguna forma de llegar a ellos, porque la
 * barra de días se había retirado el 2026-09-25.
 *
 * Medido en la base local el 2026-10-05, antes de tocar nada: **78 expedientes esperando
 * firma repartidos en ~25 días, el más viejo del 1-jul, y CERO levantados hoy** — o sea la
 * bandeja salía vacía mientras esos 78 esperaban su autorización.
 *
 * ## ⛔ Por qué este smoke existe además del spec del componente
 * El spec de `finanzas-aprobacion-gastos.component.spec.ts` responde el HTTP con un mock:
 * comprueba que la pantalla **pinta** lo que el servidor manda, y se quedaría verde aunque
 * el `WHERE` del servicio volviera a acotar por día. Lo que decide si el vale viejo existe
 * o no es el SQL, y el SQL sólo se prueba contra una base.
 *
 * Verifica:
 *   1. El predicado nuevo trae lo que espera decisión **de cualquier fecha**.
 *   2. ⛔ NEGATIVA: el predicado viejo (acotado al día) **no lo trae** — el defecto, reproducido.
 *   3. Lo ya decidido NO se cuela en la bandeja aunque sea del día.
 *   4. El CHECK de la tabla y el repartidor no se separan (ver abajo).
 *   5. El COUNT de «otros días» cuadra con las filas que trae la consulta.
 *
 * ## ⚠️ Lo que esta corrida enseñó, y cambió la prueba
 * El primer intento insertaba un expediente con un estado inventado para comprobar la «red»
 * de `sin_etapa`. **La base lo rechaza**: `expense_proofs_status_check` admite exactamente
 * cinco estados. O sea que `sin_etapa` no es un camino vivo sino defensa en profundidad —
 * cubre el día que alguien agregue un estado al CHECK y se olvide del mapa.
 *
 * Así que la prueba útil no es meter basura: es **vigilar el CHECK**. Si mañana aparece un
 * sexto estado, esta suite se pone roja y obliga a decidir de qué lado de la bandeja cae,
 * que es justo la decisión que si se toma sola hace desaparecer trabajo.
 *
 * ⚠️ La lista de estados ya decididos se escribe acá como literal **a propósito**: este
 * archivo prueba el PREDICADO de la base, no el mapa de TypeScript. Que el literal y el mapa
 * no se separen lo cuida `etapas-del-dia.spec.ts`, que deriva la lista en vez de copiarla.
 * Todo corre dentro de una transacción con rollback: la base queda como estaba.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

/** Los que YA tienen decisión. Ver la nota de arriba sobre por qué va literal. */
const DECIDIDOS = ['aprobada', 'revision', 'validada', 'rechazada'];

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

(async () => {
  try {
    const reg = await knex.raw(`SELECT to_regclass('finance.expense_proofs') t`);
    ok(!!reg.rows[0].t, 'finance.expense_proofs existe');

    await knex.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);

      // El día de México como rango, igual que el servicio: [00:00, 00:00 del siguiente).
      const hoy = (await trx.raw(
        `SELECT to_char(now() AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD') d`)).rows[0].d;
      const desde = trx.raw(`(?::date)::timestamp AT TIME ZONE 'America/Mexico_City'`, [hoy]);
      const hasta = trx.raw(`((?::date) + interval '1 day')::timestamp AT TIME ZONE 'America/Mexico_City'`, [hoy]);

      // ── Cuatro expedientes de prueba ─────────────────────────────────────
      const base = {
        tenant_id: T, sucursal: '00', departamento: 'SMOKE-GX67',
        importe: 100, created_by: 'smoke_gx67',
        // NOT NULL en la tabla: se llenan con algo reconocible, no con vacio.
        solicitante: 'SMOKE GX67', proveedor: 'PROVEEDOR SMOKE',
      };
      const mk = async (sufijo, status, createdAt) => {
        const [r] = await trx('finance.expense_proofs')
          .insert({ ...base, folio_solicitud: `GX67-${sufijo}`, status, created_at: trx.raw(createdAt) })
          .returning('id');
        return typeof r === 'object' ? r.id : r;
      };
      const VIEJO = `now() - interval '90 days'`;
      const idHoy = await mk('HOY', 'recibida', 'now()');
      const idViejo = await mk('VIEJO', 'recibida', VIEJO);
      const idViejoCerrado = await mk('CERRADO', 'validada', VIEJO);
      const idHoyCerrado = await mk('HOYCERR', 'aprobada', 'now()');

      const soloMios = (q) => q.where({ tenant_id: T }).whereLike('folio_solicitud', 'GX67-%');

      // ── 1. El predicado NUEVO: lo que espera decisión, de cualquier fecha ─
      const bandeja = await soloMios(trx('finance.expense_proofs'))
        .whereNotIn('status', DECIDIDOS)
        .select('id', 'folio_solicitud');
      const ids = bandeja.map((r) => r.id);
      ok(ids.includes(idViejo), 'el vale de hace 90 días ENTRA a la bandeja');
      ok(ids.includes(idHoy), 'el vale de hoy sigue entrando');

      // ── 2. ⛔ NEGATIVA: el predicado VIEJO lo escondía ────────────────────
      const viejoPredicado = await soloMios(trx('finance.expense_proofs'))
        .where('status', 'recibida')
        .where('created_at', '>=', desde)
        .where('created_at', '<', hasta)
        .select('id');
      const idsViejoPred = viejoPredicado.map((r) => r.id);
      ok(!idsViejoPred.includes(idViejo),
        '⛔ NEGATIVA: con el predicado viejo el vale de 90 días NO aparecía (el defecto, reproducido)');
      ok(idsViejoPred.includes(idHoy), 'y el de hoy sí — por eso nadie notaba que faltaban los demás');

      // ── 3. Lo ya decidido no se cuela, sea del día o no ───────────────────
      ok(!ids.includes(idViejoCerrado), 'un vale VIEJO ya validado no vuelve a la bandeja');
      ok(!ids.includes(idHoyCerrado), 'un vale de HOY ya aprobado tampoco');

      // ── 4. El CHECK de la tabla y el repartidor no se pueden separar ──────
      const { rows: [c] } = await trx.raw(
        `SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='expense_proofs_status_check'`);
      ok(!!c, 'la tabla tiene CHECK sobre `status`');
      const permitidos = (c.d.match(/'([a-z_]+)'::text/g) || []).map((x) => x.split("'")[1]).sort();
      // La bandeja = lo permitido MENOS lo decidido. Si no cuadra, hay un estado que nadie
      // repartió: o se cuela en la bandeja, o —peor— desaparece de ella.
      const esperaDecision = permitidos.filter((e) => !DECIDIDOS.includes(e));
      ok(JSON.stringify(permitidos) === JSON.stringify(
        ['aprobada', 'rechazada', 'recibida', 'revision', 'validada']),
        `el CHECK admite exactamente los 5 estados conocidos (${permitidos.join(', ')})`);
      ok(JSON.stringify(esperaDecision) === JSON.stringify(['recibida']),
        'el único estado que espera decisión es `recibida` — todo lo demás ya se decidió');

      // ── 5. El COUNT de «otros días» cuadra con las filas ──────────────────
      const deOtrosDias = await soloMios(trx('finance.expense_proofs'))
        .whereNotIn('status', DECIDIDOS)
        .where((w) => w.where('created_at', '<', desde).orWhere('created_at', '>=', hasta))
        .select('id');
      const [cnt] = await soloMios(trx('finance.expense_proofs'))
        .whereNotIn('status', DECIDIDOS)
        .where((w) => w.where('created_at', '<', desde).orWhere('created_at', '>=', hasta))
        .count('* as n');
      ok(Number(cnt.n) === deOtrosDias.length,
        `el contador de otros días (${cnt.n}) cuadra con las filas traídas (${deOtrosDias.length})`);
      ok(Number(cnt.n) === 1, 'es exactamente 1: el único pendiente viejo que se sembró');

      // ⛔ Nada de esto se queda en la base.
      throw new Error('ROLLBACK_SMOKE');
    }).catch((e) => { if (e.message !== 'ROLLBACK_SMOKE') throw e; });

    const [quedo] = await knex('finance.expense_proofs')
      .where({ tenant_id: T }).whereLike('folio_solicitud', 'GX67-%').count('* as n');
    ok(Number(quedo.n) === 0, 'el rollback dejó la base como estaba (0 filas de prueba)');
  } catch (e) {
    fail++; console.log('  ✗ excepción:', e.message);
  } finally {
    await knex.destroy();
    console.log(`\n[GX.67] bandeja sin acotar por día — ${pass} ✓ / ${fail} ✗`);
    process.exit(fail ? 1 : 0);
  }
})();
