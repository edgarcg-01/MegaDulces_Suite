'use strict';
/**
 * `[MS.8.1]` — Siembra de la cola «Compras (precios y productos)» de la Mesa de Servicio, con su responsable.
 *
 * Pedido de Sistemas (2026-11-11): un apartado donde las sucursales reporten a Compras los problemas de precio, código de
 * barras, producto no encontrado en Kepler, descripción, IVA, margen e IEPS. Responsable: **Mario Ventura**. Es SÓLO
 * CONFIGURACIÓN (ADR-081: sumar un área es una fila), con el mismo mecanismo que `20261007240000` (Mantenimiento).
 *
 * ── Por qué una migración y no la pantalla ────────────────────────────────────────────────────────
 * `/servicio/configuracion` agrega categorías, preguntas y miembros a una cola que YA existe, pero no tiene botón para crear
 * una cola (la API sí). Y repartir el permiso a una sola persona desde `/admin/personas` es otro paso a mano. Aquí queda todo
 * en un solo cambio revisable y reversible.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-11) ─────────────────────────────────────────────
 *  · Colas: `ti` (activa, 14 miembros) y `mantenimiento` (apagada, 0 miembros). No hay cola de Compras.
 *  · `mario_ventura` existe («MARIO VENTURA», puesto `auxiliar_compras`, departamento `compras`); ni su puesto ni él tienen
 *    `SERVICIO_ATENDER` ni `SERVICIO_COORDINAR` → sin ellos `queue-members.service` rechaza agregarlo.
 *  · El departamento `compras` existe en `identity.departments`.
 *
 * ── Qué deja ──────────────────────────────────────────────────────────────────────────────────────
 *  · La cola `compras`: modelo de prioridad `impacto` (como TI), NO confidencial, sin zona.
 *  · 8 categorías, todas exigen sucursal (un precio o un código es EN una sucursal) y nacen en prioridad `media`.
 *  · 3 preguntas de texto, opcionales: código de barras, clave del producto y observaciones.
 *  · A Mario: `SERVICIO_ATENDER` + `SERVICIO_COORDINAR` como permiso INDIVIDUAL (no a todo el puesto: decisión de Sistemas),
 *    miembro `coordinador` de la cola y su responsable por omisión (todo lo nuevo le cae asignado).
 *  · La cola se ENCIENDE sólo si Mario quedó como coordinador con los dos permisos. Si su usuario no existe (otro tenant, una
 *    base de pruebas) la cola nace APAGADA y sin miembros, como Mantenimiento: encendida y sin nadie, cada ticket caería en
 *    una bandeja que nadie ve.
 *
 * ⚠️ Mario tiene que CERRAR SESIÓN Y VOLVER A ENTRAR: los permisos viajan en el token.
 * ⚠️ Sólo inserta filas (no crea objetos de esquema): la compuerta del despliegue la clasifica NO_MEDIDO y frena a todo el
 *    equipo hasta que alguien la aplique a mano. Aplicala ANTES de mergear.
 *
 * Idempotente: re-correrla no pisa lo que la coordinación ya ajustó (ni vuelve a encender una cola que se apagó).
 *
 * @param { import("knex").Knex } knex
 */

const COLA = { code: 'compras', name: 'Compras (precios y productos)', departamento: 'compras', orden: 30 };
const RESPONSABLE = 'mario_ventura';
const PERMISOS = ['SERVICIO_ATENDER', 'SERVICIO_COORDINAR'];
const NOTA = '[MS.8.1] responsable de la cola Compras de la Mesa de Servicio';

/** `[code, nombre, orden]` — las 8 categorías pedidas por Sistemas el 2026-11-11. */
const CATEGORIAS = [
  ['precio_incorrecto', 'Precio incorrecto', 10],
  ['codigo_barras', 'Código de barras (no lee o no está dado de alta)', 20],
  ['producto_no_encontrado', 'Producto no encontrado en Kepler', 30],
  ['descripcion_producto', 'Descripción del producto incorrecta', 40],
  ['iva', 'IVA', 50],
  ['margen', 'Margen', 60],
  ['ieps', 'IEPS', 70],
  ['otro', 'Otro', 80],
];

/** `[code, etiqueta, orden]` — preguntas de texto, opcionales (a veces quien reporta no tiene el código o la clave). */
const PREGUNTAS = [
  ['codigo_barras', 'Código de barras', 10],
  ['clave_producto', 'Clave del producto', 20],
  ['observaciones', 'Observaciones', 30],
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const tenants = await knex('identity.tenants').pluck('id');
  const cuenta = { colas: 0, cats: 0, preguntas: 0, permisos: 0, miembros: 0, encendidas: 0 };
  for (const tenant of tenants) {
    // Sin la Mesa configurada (no corrió la migración de catálogos) no hay nada que sembrar.
    const hayMesa = await knex('servicedesk.queues').where({ tenant_id: tenant, code: 'ti' }).first('id');
    if (!hayMesa) {
      console.log(`  [MS.8.1] tenant ${tenant}: sin la cola TI — no se siembra Compras`);
      continue;
    }
    const dept = await knex('identity.departments').where({ tenant_id: tenant, code: COLA.departamento }).whereNull('deleted_at').first('code');
    const r = await knex.raw(
      `INSERT INTO servicedesk.queues (tenant_id, code, name, department_code, priority_model, confidential, active, sort_order)
       VALUES (?, ?, ?, ?, 'impacto', false, false, ?)
       ON CONFLICT (tenant_id, code) DO NOTHING`,
      [tenant, COLA.code, COLA.name, dept ? dept.code : null, COLA.orden],
    );
    const colaNueva = (r.rowCount ?? 0) > 0;
    cuenta.colas += r.rowCount ?? 0;
    const cola = await knex('servicedesk.queues').where({ tenant_id: tenant, code: COLA.code }).first('id');

    for (const [code, name, orden] of CATEGORIAS) {
      const c = await knex.raw(
        `INSERT INTO servicedesk.categories (tenant_id, queue_id, code, name, default_priority, requires_branch, sort_order)
         VALUES (?, ?, ?, ?, 'media', true, ?)
         ON CONFLICT (tenant_id, queue_id, code) DO NOTHING`,
        [tenant, cola.id, code, name, orden],
      );
      cuenta.cats += c.rowCount ?? 0;
    }
    for (const [code, label, orden] of PREGUNTAS) {
      const p = await knex.raw(
        `INSERT INTO servicedesk.queue_fields (tenant_id, queue_id, code, label, type, required, options, sort_order, active)
         VALUES (?, ?, ?, ?, 'text', false, '[]'::jsonb, ?, true)
         ON CONFLICT (tenant_id, queue_id, code) DO NOTHING`,
        [tenant, cola.id, code, label, orden],
      );
      cuenta.preguntas += p.rowCount ?? 0;
    }

    // El responsable: sólo si existe en ESTE tenant (no se adivina un usuario).
    const mario = await knex('identity.users').where({ tenant_id: tenant, username: RESPONSABLE }).whereNull('deleted_at').first('id');
    if (!mario) {
      console.log(`  [MS.8.1] tenant ${tenant}: sin el usuario ${RESPONSABLE} — la cola queda APAGADA y sin miembros`);
      continue;
    }
    for (const key of PERMISOS) {
      // Si ya hay una fila (p. ej. un «deny» puesto a mano) NO se pisa: es una decisión de alguien.
      const g = await knex.raw(
        `INSERT INTO identity.user_permissions (tenant_id, user_id, permission_key, allow, nota, granted_by_username, created_at, updated_at)
         VALUES (?, ?, ?, true, ?, 'migracion', now(), now())
         ON CONFLICT (tenant_id, user_id, permission_key) DO NOTHING`,
        [tenant, mario.id, key, NOTA],
      );
      cuenta.permisos += g.rowCount ?? 0;
    }
    const m = await knex.raw(
      `INSERT INTO servicedesk.queue_members (tenant_id, queue_id, user_id, role, active)
       VALUES (?, ?, ?, 'coordinador', true)
       ON CONFLICT (tenant_id, queue_id, user_id) DO NOTHING`,
      [tenant, cola.id, mario.id],
    );
    cuenta.miembros += m.rowCount ?? 0;

    // Encender y asignar SÓLO la cola que nació en esta corrida: si ya existía, su coordinación decide.
    if (colaNueva) {
      const permitidos = await knex('identity.user_permissions')
        .where({ tenant_id: tenant, user_id: mario.id, allow: true })
        .whereIn('permission_key', PERMISOS)
        .count({ n: '*' })
        .first();
      const coordina = await knex('servicedesk.queue_members').where({ tenant_id: tenant, queue_id: cola.id, user_id: mario.id, role: 'coordinador', active: true }).first('id');
      if (Number(permitidos.n) === PERMISOS.length && coordina) {
        await knex('servicedesk.queues').where({ id: cola.id }).update({ active: true, default_assignee_id: mario.id, updated_at: knex.fn.now() });
        cuenta.encendidas += 1;
      } else {
        console.log(`  [MS.8.1] tenant ${tenant}: ${RESPONSABLE} no quedó como coordinador con los dos permisos — la cola queda APAGADA`);
      }
    }
  }
  // eslint-disable-next-line no-console
  console.log(
    `  [MS.8.1] Compras: ${cuenta.colas} cola(s) nueva(s) · ${cuenta.cats} categoría(s) · ${cuenta.preguntas} pregunta(s) · ` +
      `${cuenta.permisos} permiso(s) a ${RESPONSABLE} · ${cuenta.miembros} coordinador(es) · ${cuenta.encendidas} cola(s) encendida(s)`,
  );
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  // Sólo se retira lo que no tiene historia: un ticket ya levantado en la cola es registro y no se borra.
  const colas = await knex('servicedesk.queues').where({ code: COLA.code }).select('id', 'tenant_id');
  for (const q of colas) {
    const tickets = await knex('servicedesk.requests').where({ queue_id: q.id }).count({ n: '*' }).first();
    if (Number(tickets.n) > 0) {
      console.log(`  [MS.8.1] down: la cola de Compras del tenant ${q.tenant_id} tiene ${tickets.n} ticket(s): se conserva`);
      continue;
    }
    await knex('servicedesk.routing_rules').whereIn('category_id', knex('servicedesk.categories').where({ queue_id: q.id }).select('id')).del();
    await knex('servicedesk.queue_members').where({ queue_id: q.id }).del();
    if (await knex.schema.withSchema('servicedesk').hasColumn('sla_policies', 'queue_id')) await knex('servicedesk.sla_policies').where({ queue_id: q.id }).del();
    await knex('servicedesk.queue_fields').where({ queue_id: q.id }).del();
    await knex('servicedesk.categories').where({ queue_id: q.id }).del();
    await knex('servicedesk.queues').where({ id: q.id }).del();
  }
  // Sólo los permisos que puso ESTA migración (por su nota), no uno que alguien le haya dado a mano.
  await knex('identity.user_permissions').where({ nota: NOTA }).whereIn('permission_key', PERMISOS).del();
};
