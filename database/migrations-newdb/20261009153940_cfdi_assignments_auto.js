'use strict';
/**
 * `[MAT.5]` — **El casamiento que propone la máquina NO es evidencia, y la base lo distingue.**
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-10-09) ────────────────────────────────────────
 *
 * ⛔ **`fiscal.cfdi_assignments` tiene CERO filas.** La tabla, su servicio, su heurística y su
 * pantalla están en producción desde el 2026-07-17 y **nunca se usó ni una vez**. No es un hueco
 * de datos: es trabajo terminado que no entró a la operación.
 *
 * ⭐ **Y se entiende por qué.** `reconcile()` recibe UN RFC a la vez y propone candidatos para que
 * una persona confirme factura por factura. Con **399 proveedores** y **14,891 CFDIs recibidos** en
 * 365 días, nadie iba a hacerlo nunca. El sugeridor es bueno; lo que falta es la pasada masiva.
 *
 * Medido con la MISMA heurística que ya usa `reconcile` (RFC + importe ±$1 + fecha ±5 d):
 *
 * | | CFDIs | |
 * |---|---:|---|
 * | recibidos en 365 d | 14,891 | |
 * | con al menos un candidato fuerte | 2,297 | |
 * | con **un solo** candidato | 2,016 | |
 * | **pares estrictamente 1:1** (ni el CFDI ni la operación tienen otro) | **1,900** | **$99,961,324** |
 *
 * ── La decisión que obliga esta migración ───────────────────────────────────────────────────
 *
 * El `CHECK` sólo admitía `confirmed` y `rejected`. ⛔ **Escribir el casamiento automático como
 * `confirmed` sería una mentira con consecuencia fiscal**: esta tabla es la evidencia de
 * materialidad que consume `MAT.3`, y un cruce por importe y fecha es una **pista fuerte, no la
 * prueba de que la operación existió**. Presentado como confirmado queda indistinguible de lo que
 * una persona verificó — y ésa es justo la diferencia que importa en una auditoría.
 *
 * ⇒ Se agrega el estado **`auto`**: lo propuso la máquina, **todavía no es evidencia**. Los
 * consumidores que filtran `status = 'confirmed'` siguen viendo exactamente lo mismo que antes
 * (ninguno hereda evidencia que nadie miró), y la persona pasa de *buscar* los pares a *aprobarlos*.
 *
 * ── Los dos índices únicos ──────────────────────────────────────────────────────────────────
 *
 * ⭐ La tabla está **VACÍA**, así que es el único momento en que estas restricciones no pueden
 * fallar al crearse. Hacen estructural lo que hoy es una promesa del servicio ("1:1 en ambos
 * sentidos", dice su comentario): un CFDI no puede tener dos asignaciones vivas, y una operación
 * no puede estar reclamada por dos CFDIs. `rejected` queda fuera del índice a propósito — se puede
 * descartar el mismo par muchas veces y eso no es una asignación.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ⚠️ Pre-vuelo: si alguien pobló la tabla entre la medición y esta corrida, los índices únicos
  // podrían fallar. Se DECLARA en el log en vez de asumir que sigue vacía.
  const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM fiscal.cfdi_assignments`);
  if (rows[0].n > 0) {
    // eslint-disable-next-line no-console
    console.log(`[MAT.5] ⚠️ la tabla ya trae ${rows[0].n} fila(s): los índices únicos van a medirlas.`);
  }

  await knex.raw(`ALTER TABLE fiscal.cfdi_assignments DROP CONSTRAINT IF EXISTS fiscal_cfdi_assign_status_check`);
  await knex.raw(`
    ALTER TABLE fiscal.cfdi_assignments
      ADD CONSTRAINT fiscal_cfdi_assign_status_check
      CHECK (status IN ('confirmed', 'rejected', 'auto'))`);

  // Un CFDI, una asignación viva. 'rejected' fuera: descartar el mismo par N veces no es asignar.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS fiscal_cfdi_assign_cfdi_viva
      ON fiscal.cfdi_assignments (tenant_id, cfdi_id)
      WHERE status IN ('confirmed', 'auto')`);

  // Y una operación de Kepler no puede estar reclamada por dos CFDIs.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS fiscal_cfdi_assign_op_viva
      ON fiscal.cfdi_assignments (tenant_id, sucursal, doc_tipo, doc_folio)
      WHERE status IN ('confirmed', 'auto')`);

  await knex.raw(`
    COMMENT ON COLUMN fiscal.cfdi_assignments.status IS
      'confirmed = lo verifico una persona (evidencia de materialidad) · auto = lo propuso la '
      'maquina por RFC+importe+fecha y TODAVIA NO es evidencia · rejected = se descarto ese par. '
      'MAT.3 consume solo confirmed: un cruce por importe no prueba que la operacion existio.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP INDEX IF EXISTS fiscal.fiscal_cfdi_assign_op_viva`);
  await knex.raw(`DROP INDEX IF EXISTS fiscal.fiscal_cfdi_assign_cfdi_viva`);
  // ⚠️ Volver al CHECK viejo exige que no queden filas 'auto', o el ALTER falla. Se borran SÓLO
  // las que esta fase pudo crear (status='auto'): nunca se toca lo que confirmó una persona.
  await knex.raw(`DELETE FROM fiscal.cfdi_assignments WHERE status = 'auto'`);
  await knex.raw(`ALTER TABLE fiscal.cfdi_assignments DROP CONSTRAINT IF EXISTS fiscal_cfdi_assign_status_check`);
  await knex.raw(`
    ALTER TABLE fiscal.cfdi_assignments
      ADD CONSTRAINT fiscal_cfdi_assign_status_check
      CHECK (status IN ('confirmed', 'rejected'))`);
};
