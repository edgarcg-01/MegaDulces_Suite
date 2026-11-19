'use strict';
/**
 * `[MSP.0.2]` — Siembra la cola «Presupuestos y Requerimientos» de la Mesa de Servicio, APAGADA.
 *
 * Sólo CONFIGURACIÓN (ADR-081: sumar un área es una fila), sobre las columnas de `[MSP.0.1]`. Mismo mecanismo que `[MS.8.1]`
 * (Compras) y `[MSH.4]` (RH). Plan y decisiones: `docs/IMPLEMENTACION/FASES/FASE_MSP_PRESUPUESTOS_Y_REQUERIMIENTOS.md`.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-18) ──────────────────────────────────────────────
 *  · Colas: `ti`, `mantenimiento`, `compras`. No hay cola de Presupuestos.
 *  · `ernesto_zarate` (ERNESTO ZARATE PEREZ), puesto `presupuestos_compras_corp`, departamento `finanzas`, activo; no es miembro de
 *    ninguna cola ni tiene `SERVICIO_ATENDER`/`SERVICIO_COORDINAR`.
 *  · Puestos que levantan (D1): `encargado_sucursal` 9, `auxiliar_encargado` 6, `jefe_zona` 3 = 18 personas activas.
 *
 * ── Qué deja ──────────────────────────────────────────────────────────────────────────────────────
 *  · La cola `presupuestos`: departamento `finanzas`; NO confidencial; sin prioridad (`uses_priority=false`) ni SLA (`sla_enabled=false`:
 *    nadie ha fijado el plazo de respuesta y un plazo inventado es un cero dibujado); levantan SÓLO los 3 puestos de D1; exige
 *    descripción y dictamen (D2); manda órdenes de servicio a `mantenimiento` y `ti` (D3).
 *  · 3 categorías (gastos operativos, compra de activos, otros), todas con sucursal (D6).
 *  · Campos obligatorios: `observaciones` (texto) y `evidencia` (foto o PDF: un adjunto).
 *  · `ernesto_zarate`: `SERVICIO_ATENDER` + `SERVICIO_COORDINAR` INDIVIDUALES (no a todo su puesto) y miembro `coordinador`.
 *
 * ⛔ La cola NACE APAGADA y esta migración NUNCA la enciende: se enciende desde Configuración DESPUÉS de desplegar el código que hace
 *    cumplir quién levanta, la descripción y el dictamen (con el código anterior, una cola encendida la vería cualquiera).
 * ⚠️ Ernesto tiene que CERRAR SESIÓN Y VOLVER A ENTRAR: los permisos viajan en el token.
 * ⚠️ Sólo inserta filas: aplicala en prod ANTES de mergear (después de `[MSP.0.1]`).
 *
 * Idempotente: re-correrla no pisa lo que la coordinación ya ajustó, ni un permiso negado a mano.
 *
 * @param { import("knex").Knex } knex
 */

const COLA = {
  code: 'presupuestos',
  name: 'Presupuestos y Requerimientos',
  departamento: 'finanzas',
  orden: 50,
  puestos: ['encargado_sucursal', 'auxiliar_encargado', 'jefe_zona'],
  destinos: ['mantenimiento', 'ti'],
};
const COORDINADORES = ['ernesto_zarate'];
const PERMISOS = ['SERVICIO_ATENDER', 'SERVICIO_COORDINAR'];
const NOTA = '[MSP.0.2] coordinación de la cola de Presupuestos y Requerimientos de la Mesa de Servicio';

/** `[code, nombre, orden]` */
const CATEGORIAS = [
  ['gastos_operativos', 'Gastos operativos', 10],
  ['compra_activos', 'Compra de activos', 20],
  ['otros', 'Otros', 30],
];
/** `[code, pregunta, tipo, orden]` — los dos obligatorios. */
const CAMPOS = [
  ['observaciones', 'Observaciones', 'text', 10],
  ['evidencia', 'Evidencia (foto o PDF de la cotización)', 'photo', 20],
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const tenants = await knex('identity.tenants').pluck('id');
  const cuenta = { colas: 0, cats: 0, campos: 0, permisos: 0, coordinadores: 0, sinUsuario: 0 };
  for (const tenant of tenants) {
    const hayMesa = await knex('servicedesk.queues').where({ tenant_id: tenant, code: 'ti' }).first('id');
    if (!hayMesa) {
      console.log(`  [MSP.0.2] tenant ${tenant}: sin la cola TI — no se siembra Presupuestos`);
      continue;
    }
    const dept = await knex('identity.departments').where({ tenant_id: tenant, code: COLA.departamento }).whereNull('deleted_at').first('code');
    const r = await knex.raw(
      `INSERT INTO servicedesk.queues (tenant_id, code, name, department_code, priority_model, confidential, uses_priority, sla_enabled,
                                      requester_positions, requires_description, requires_decision, work_order_queue_codes, active, sort_order)
       VALUES (?, ?, ?, ?, 'impacto', false, false, false, ?::text[], true, true, ?::text[], false, ?)
       ON CONFLICT (tenant_id, code) DO NOTHING`,
      [tenant, COLA.code, COLA.name, dept ? dept.code : null, COLA.puestos, COLA.destinos, COLA.orden],
    );
    cuenta.colas += r.rowCount ?? 0;
    const cola = await knex('servicedesk.queues').where({ tenant_id: tenant, code: COLA.code }).first('id', 'requires_decision');
    if (!cola.requires_decision) {
      // Una cola `presupuestos` que ya existía SIN dictamen es una decisión de alguien (o un error): no se le cuelga nada encima.
      console.log(`  [MSP.0.2] tenant ${tenant}: ya existe una cola «${COLA.code}» sin dictamen — no se toca`);
      continue;
    }

    for (const [code, name, orden] of CATEGORIAS) {
      const c = await knex.raw(
        `INSERT INTO servicedesk.categories (tenant_id, queue_id, code, name, default_priority, requires_branch, sort_order)
         VALUES (?, ?, ?, ?, 'media', true, ?)
         ON CONFLICT (tenant_id, queue_id, code) DO NOTHING`,
        [tenant, cola.id, code, name, orden],
      );
      cuenta.cats += c.rowCount ?? 0;
    }
    for (const [code, label, type, orden] of CAMPOS) {
      const f = await knex.raw(
        `INSERT INTO servicedesk.queue_fields (tenant_id, queue_id, code, label, type, required, sort_order)
         VALUES (?, ?, ?, ?, ?, true, ?)
         ON CONFLICT (tenant_id, queue_id, code) DO NOTHING`,
        [tenant, cola.id, code, label, type, orden],
      );
      cuenta.campos += f.rowCount ?? 0;
    }

    for (const username of COORDINADORES) {
      const u = await knex('identity.users').where({ tenant_id: tenant, username }).whereNull('deleted_at').first('id');
      if (!u) {
        cuenta.sinUsuario += 1;
        console.log(`  [MSP.0.2] tenant ${tenant}: sin el usuario ${username} — no se agrega`);
        continue;
      }
      for (const key of PERMISOS) {
        // Si ya hay una fila (p. ej. un «deny» puesto a mano) NO se pisa: es una decisión de alguien.
        const g = await knex.raw(
          `INSERT INTO identity.user_permissions (tenant_id, user_id, permission_key, allow, nota, granted_by_username, created_at, updated_at)
           VALUES (?, ?, ?, true, ?, 'migracion', now(), now())
           ON CONFLICT (tenant_id, user_id, permission_key) DO NOTHING`,
          [tenant, u.id, key, NOTA],
        );
        cuenta.permisos += g.rowCount ?? 0;
      }
      const m = await knex.raw(
        `INSERT INTO servicedesk.queue_members (tenant_id, queue_id, user_id, role, active)
         VALUES (?, ?, ?, 'coordinador', true)
         ON CONFLICT (tenant_id, queue_id, user_id) DO NOTHING`,
        [tenant, cola.id, u.id],
      );
      cuenta.coordinadores += m.rowCount ?? 0;
    }
  }
  // eslint-disable-next-line no-console
  console.log(
    `  [MSP.0.2] Presupuestos: ${cuenta.colas} cola(s) nueva(s), APAGADA(s) · ${cuenta.cats} categoría(s) · ${cuenta.campos} campo(s) · ` +
      `${cuenta.permisos} permiso(s) · ${cuenta.coordinadores} coordinador(es)${cuenta.sinUsuario ? ` · ${cuenta.sinUsuario} usuario(s) no encontrado(s)` : ''}`,
  );
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  // Sólo se retira lo que no tiene historia: un ticket ya levantado en la cola es registro y no se borra.
  const colas = await knex('servicedesk.queues').where({ code: COLA.code, requires_decision: true }).select('id', 'tenant_id');
  for (const q of colas) {
    const tickets = await knex('servicedesk.requests').where({ queue_id: q.id }).count({ n: '*' }).first();
    if (Number(tickets.n) > 0) {
      console.log(`  [MSP.0.2] down: la cola de Presupuestos del tenant ${q.tenant_id} tiene ${tickets.n} ticket(s): se conserva`);
      continue;
    }
    await knex('servicedesk.routing_rules').whereIn('category_id', knex('servicedesk.categories').where({ queue_id: q.id }).select('id')).del();
    await knex('servicedesk.queue_members').where({ queue_id: q.id }).del();
    if (await knex.schema.withSchema('servicedesk').hasColumn('sla_policies', 'queue_id')) await knex('servicedesk.sla_policies').where({ queue_id: q.id }).del();
    await knex('servicedesk.queue_fields').where({ queue_id: q.id }).del();
    await knex('servicedesk.categories').where({ queue_id: q.id }).del();
    await knex('servicedesk.queues').where({ id: q.id }).del();
  }
  // Sólo los permisos que puso ESTA migración (por su nota), no uno que alguien haya dado a mano.
  await knex('identity.user_permissions').where({ nota: NOTA }).whereIn('permission_key', PERMISOS).del();
};
