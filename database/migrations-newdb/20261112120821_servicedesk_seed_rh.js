'use strict';
/**
 * `[MSH.4]` — Siembra de la cola confidencial «Recursos Humanos» de la Mesa de Servicio, APAGADA.
 *
 * Es SÓLO CONFIGURACIÓN (ADR-081: sumar un área es una fila), con el mismo mecanismo que `[MS.8.1]` (Compras). La lógica de
 * la confidencialidad ya está en producción (MSH.1 base, MSH.2 lógica, MSH.3 pantalla, PRV.2 consentimiento): aquí sólo se
 * crea la cola que la usa. Plan: `docs/IMPLEMENTACION/FASES/FASE_MSH_MESA_DE_SERVICIO_HUMANOS.md` §5.
 *
 * ── Por qué una migración y no la pantalla ────────────────────────────────────────────────────────
 * Desde `[MS.8.2]` la pantalla NO deja crear una cola confidencial sin coordinación (el god-mode no queda como miembro de lo
 * que crea, y una confidencial sin coordinación queda trabada: lo vivido con Mantenimiento el 2026-11-10). Aquí la cola nace
 * con sus dos coordinadoras en el mismo cambio.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-12) ─────────────────────────────────────────────
 *  · Colas: `ti`, `mantenimiento`, `compras`. No hay cola `rh`. `privacy_notices`: 0 avisos.
 *  · El departamento `rh` («Recursos Humanos») existe en `identity.departments`.
 *  · `lesly_berber` (puesto `reclutamiento_onboarding`) y `tania_solorio` (`auxiliar_rh`), departamento `rh`, activas; sin
 *    `SERVICIO_ATENDER` ni `SERVICIO_COORDINAR` (sólo reportan, como todo `administrativo`).
 *
 * ── Qué deja ──────────────────────────────────────────────────────────────────────────────────────
 *  · La cola `rh` CONFIDENCIAL (R1: la marca vive en la cola y el ticket la copia), sin prioridad ni SLA (R5: se declara «—»,
 *    nunca 0), mínimo de 5 casos en reportes (R4, confirmado 2026-11-12), sin responsable por omisión (R6: lo ven las dos) y
 *    ligada al aviso de privacidad `rh` (PRV.2: sin aviso VIGENTE el servidor rechaza el ticket con 409, fail-closed).
 *  · Las 10 categorías de §3.3 (R7), ninguna exige sucursal; prioridad interna `media` (valor neutro: la API no la publica).
 *  · A Lesly y Tania: `SERVICIO_ATENDER` + `SERVICIO_COORDINAR` INDIVIDUALES (no a todo su puesto) y miembros `coordinador`.
 *
 * ⛔ La cola NACE APAGADA y esta migración NUNCA la enciende: abrir RH espera a Legal (PRV.0 decisiones, PRV.1 aviso aprobado y
 *    cargado como `vigente`, PRV.3 procedimiento). El aviso NO se siembra aquí: el borrador tiene datos por llenar `[…]` y un
 *    texto con huecos no debe vivir en la tabla de evidencia. Encenderla = coordinación de RH desde la pantalla, con el aviso ya
 *    vigente.
 * ⚠️ Lesly y Tania tienen que CERRAR SESIÓN Y VOLVER A ENTRAR: los permisos viajan en el token.
 * ⚠️ Sólo inserta filas: aplicala en prod ANTES de mergear (como `[MS.8.1]`).
 *
 * Idempotente: re-correrla no pisa lo que la coordinación ya ajustó, ni un permiso negado a mano.
 *
 * @param { import("knex").Knex } knex
 */

const COLA = { code: 'rh', name: 'Recursos Humanos', departamento: 'rh', orden: 40, aviso: 'rh', minimoCasos: 5 };
const COORDINADORAS = ['lesly_berber', 'tania_solorio'];
const PERMISOS = ['SERVICIO_ATENDER', 'SERVICIO_COORDINAR'];
const NOTA = '[MSH.4] coordinadora de la cola confidencial de RH de la Mesa de Servicio';

/** `[code, nombre, orden]` — las 10 categorías de §3.3 (resueltas por Sistemas el 2026-10-06). */
const CATEGORIAS = [
  ['nomina', 'Nómina', 10],
  ['vacaciones_permisos', 'Vacaciones y permisos', 20],
  ['incapacidades', 'Incapacidades', 30],
  ['altas_bajas', 'Altas y bajas', 40],
  ['constancias_documentos', 'Constancias y documentos', 50],
  ['credenciales_uniformes', 'Credenciales y uniformes', 60],
  ['capacitacion', 'Capacitación', 70],
  ['conflicto_laboral', 'Conflicto laboral', 80],
  ['prestaciones_prestamos', 'Prestaciones y préstamos', 90],
  ['datos_personales_expediente', 'Datos personales y expediente', 100],
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const tenants = await knex('identity.tenants').pluck('id');
  const cuenta = { colas: 0, cats: 0, permisos: 0, coordinadoras: 0, sinUsuario: 0 };
  for (const tenant of tenants) {
    // Sin la Mesa configurada (no corrió la migración de catálogos) no hay nada que sembrar.
    const hayMesa = await knex('servicedesk.queues').where({ tenant_id: tenant, code: 'ti' }).first('id');
    if (!hayMesa) {
      console.log(`  [MSH.4] tenant ${tenant}: sin la cola TI — no se siembra RH`);
      continue;
    }
    const dept = await knex('identity.departments').where({ tenant_id: tenant, code: COLA.departamento }).whereNull('deleted_at').first('code');
    const r = await knex.raw(
      `INSERT INTO servicedesk.queues (tenant_id, code, name, department_code, priority_model, confidential, uses_priority,
                                      sla_enabled, report_min_cases, privacy_notice_code, active, sort_order)
       VALUES (?, ?, ?, ?, 'impacto', true, false, false, ?, ?, false, ?)
       ON CONFLICT (tenant_id, code) DO NOTHING`,
      [tenant, COLA.code, COLA.name, dept ? dept.code : null, COLA.minimoCasos, COLA.aviso, COLA.orden],
    );
    cuenta.colas += r.rowCount ?? 0;
    const cola = await knex('servicedesk.queues').where({ tenant_id: tenant, code: COLA.code }).first('id', 'confidential');
    if (!cola.confidential) {
      // Una cola `rh` que ya existía NO confidencial es una decisión de alguien (o un error): no se le cuelgan coordinadoras ni
      // categorías de RH encima. Se avisa y se sigue con el siguiente tenant.
      console.log(`  [MSH.4] tenant ${tenant}: ya existe una cola «${COLA.code}» NO confidencial — no se toca`);
      continue;
    }

    for (const [code, name, orden] of CATEGORIAS) {
      const c = await knex.raw(
        `INSERT INTO servicedesk.categories (tenant_id, queue_id, code, name, default_priority, requires_branch, sort_order)
         VALUES (?, ?, ?, ?, 'media', false, ?)
         ON CONFLICT (tenant_id, queue_id, code) DO NOTHING`,
        [tenant, cola.id, code, name, orden],
      );
      cuenta.cats += c.rowCount ?? 0;
    }

    // Las coordinadoras: sólo las que existen en ESTE tenant (no se adivina un usuario).
    for (const username of COORDINADORAS) {
      const u = await knex('identity.users').where({ tenant_id: tenant, username }).whereNull('deleted_at').first('id');
      if (!u) {
        cuenta.sinUsuario += 1;
        console.log(`  [MSH.4] tenant ${tenant}: sin el usuario ${username} — no se agrega`);
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
      cuenta.coordinadoras += m.rowCount ?? 0;
    }
  }
  // eslint-disable-next-line no-console
  console.log(
    `  [MSH.4] RH: ${cuenta.colas} cola(s) nueva(s), APAGADA(s) · ${cuenta.cats} categoría(s) · ${cuenta.permisos} permiso(s) · ` +
      `${cuenta.coordinadoras} coordinadora(s)${cuenta.sinUsuario ? ` · ${cuenta.sinUsuario} usuaria(s) no encontrada(s)` : ''}`,
  );
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  // Sólo se retira lo que no tiene historia: un ticket ya levantado en la cola es registro y no se borra.
  const colas = await knex('servicedesk.queues').where({ code: COLA.code, confidential: true }).select('id', 'tenant_id');
  for (const q of colas) {
    const tickets = await knex('servicedesk.requests').where({ queue_id: q.id }).count({ n: '*' }).first();
    if (Number(tickets.n) > 0) {
      console.log(`  [MSH.4] down: la cola de RH del tenant ${q.tenant_id} tiene ${tickets.n} ticket(s): se conserva`);
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
