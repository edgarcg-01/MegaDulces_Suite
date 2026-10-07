'use strict';
/**
 * `[MS.7.14]` — Siembra de la cola «Mantenimiento». `FASE_MS7_MANTENIMIENTO.md`.
 *
 * Es SÓLO CONFIGURACIÓN (la regla 1 de la fase: sumar un área es una fila, no código): una cola y sus 11 categorías, con
 * el mismo mecanismo con que `20261002100000` sembró TI.
 *
 * ── ⛔ La cola nace APAGADA, a propósito ──────────────────────────────────────────────────────────
 * Una cola encendida sin nadie que la atienda es el peor estado posible: el catálogo ofrecería sus categorías a toda la
 * empresa y cada ticket nacería en una bandeja que **nadie ve** (desde `[MS.7.6]` la clave sola no abre ninguna cola; sólo
 * la ven sus miembros y el god-mode). Por eso se siembra `active = false` —y el catálogo ya esconde las categorías de una
 * cola apagada— y se enciende **desde la pantalla** (`/servicio/configuracion`) cuando ya tiene coordinación:
 *   1. un administrador agrega a quien coordina (Ubaldo Barajas Valencia) como `coordinador` de la cola;
 *   2. esa persona agrega a su gente y **enciende la cola**.
 * Esta migración NO agrega a nadie: ni la persona está confirmada en producción ni se puede adivinar su usuario.
 *
 * ── Lo que NO trae todavía (y por qué no se finge) ───────────────────────────────────────────────
 * · **SLA propio** (horario hábil, decidido por Sistemas): hoy los plazos son por prioridad y GLOBALES; los de Mantenimiento
 *   llegan con `MS.7.2` (SLA por cola). Mientras tanto sus tickets heredan los generales.
 * · **Prioridad por riesgo × operación** (`priority_model = 'riesgo_operacion'`): la columna existe, la lógica es `MS.7.7`.
 *   Se deja el valor por omisión (`impacto`) para que la cola nunca CLAME una matriz que el código todavía no aplica.
 * · **Zonas y los dos campos de riesgo** (`MS.7.3`, `MS.7.4`). La ubicación sí: «Oficinas Corporativas» y «Estacionamiento
 *   CEDIS» ya son ubicaciones (`SD_UBICACIONES_EXTRA`).
 *
 * ── Dos valores por validar con Frank (se editan desde la pantalla, no con código) ───────────────
 * · Todas las categorías nacen con prioridad por defecto `media`: el plan no fija ninguna y no se inventa una regla de negocio.
 * · Todas **exigen ubicación** (`requires_branch`): una falla de mantenimiento siempre es EN un sitio.
 *
 * Aditiva, idempotente (`ON CONFLICT DO NOTHING`: re-correrla no pisa lo que la coordinación ya ajustó) y reversible.
 *
 * @param { import("knex").Knex } knex
 */

const COLA = { code: 'mantenimiento', name: 'Mantenimiento', departamento: 'mantenimiento', orden: 20 };

/** `[code, nombre, orden]` — las 11 categorías del plan de Mantenimiento. */
const CATEGORIAS = [
  ['electrico_iluminacion', 'Eléctrico e iluminación', 10],
  ['climatizacion_refrigeracion', 'Climatización y refrigeración', 20],
  ['plomeria', 'Plomería', 30],
  ['obra_civil_pintura', 'Obra civil y pintura', 40],
  ['herreria_puertas_cortinas', 'Herrería, puertas y cortinas', 50],
  ['mobiliario_anaqueles', 'Mobiliario y anaqueles', 60],
  ['equipo_almacen', 'Equipo de almacén', 70],
  ['seguridad_proteccion_civil', 'Seguridad y protección civil', 80],
  ['plagas_limpieza', 'Plagas y limpieza', 90],
  ['fachada_rotulacion', 'Fachada y rotulación', 100],
  ['estacionamiento', 'Estacionamiento', 110],
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);
  const tenants = await knex('identity.tenants').pluck('id');
  let colas = 0;
  let cats = 0;
  for (const tenant of tenants) {
    // Sin la Mesa configurada (no corrió la migración de catálogos) no hay nada que sembrar.
    const hayMesa = await knex('servicedesk.queues').where({ tenant_id: tenant, code: 'ti' }).first('id');
    if (!hayMesa) {
      console.log(`  [MS.7.14] tenant ${tenant}: sin la cola TI — no se siembra Mantenimiento`);
      continue;
    }
    // El departamento es opcional: hoy el catálogo de áreas no tiene «Mantenimiento» y NO se inventa uno desde aquí.
    const dept = await knex('identity.departments').where({ tenant_id: tenant, code: COLA.departamento }).whereNull('deleted_at').first('code');
    const r = await knex.raw(
      `INSERT INTO servicedesk.queues (tenant_id, code, name, department_code, active, sort_order)
       VALUES (?, ?, ?, ?, false, ?)
       ON CONFLICT (tenant_id, code) DO NOTHING`,
      [tenant, COLA.code, COLA.name, dept ? dept.code : null, COLA.orden],
    );
    colas += r.rowCount ?? 0;
    const cola = await knex('servicedesk.queues').where({ tenant_id: tenant, code: COLA.code }).first('id');
    for (const [code, name, orden] of CATEGORIAS) {
      const c = await knex.raw(
        `INSERT INTO servicedesk.categories (tenant_id, queue_id, code, name, default_priority, requires_branch, sort_order)
         VALUES (?, ?, ?, ?, 'media', true, ?)
         ON CONFLICT (tenant_id, queue_id, code) DO NOTHING`,
        [tenant, cola.id, code, name, orden],
      );
      cats += c.rowCount ?? 0;
    }
  }
  // eslint-disable-next-line no-console
  console.log(`  [MS.7.14] Mantenimiento: ${colas} cola(s) nueva(s) (APAGADA, sin miembros) · ${cats} categoría(s) nueva(s)`);
};

exports.down = async function down(knex) {
  // Sólo se retira lo que no tiene historia: un ticket ya levantado en la cola es registro y no se borra.
  const colas = await knex('servicedesk.queues').where({ code: COLA.code }).select('id', 'tenant_id');
  for (const q of colas) {
    const tickets = await knex('servicedesk.requests').where({ queue_id: q.id }).count({ n: '*' }).first();
    if (Number(tickets.n) > 0) {
      console.log(`  [MS.7.14] down: la cola de Mantenimiento del tenant ${q.tenant_id} tiene ${tickets.n} ticket(s): se conserva`);
      continue;
    }
    await knex('servicedesk.routing_rules').whereIn('category_id', knex('servicedesk.categories').where({ queue_id: q.id }).select('id')).del();
    await knex('servicedesk.queue_members').where({ queue_id: q.id }).del();
    await knex('servicedesk.categories').where({ queue_id: q.id }).del();
    await knex('servicedesk.queues').where({ id: q.id }).del();
  }
};
