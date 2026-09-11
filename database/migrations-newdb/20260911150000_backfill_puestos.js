'use strict';
/**
 * `[OR.1c]` — Cada persona con su puesto, derivado, no tecleado.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 * Le pone `position_code` a toda persona que tenga **un único puesto candidato**: el puesto de su
 * mismo departamento cuyo `default_role` es exactamente su `role_name`. Un solo candidato = no hay
 * nada que elegir, y por eso se puede hacer sin preguntar. Con dos o más, no se toca.
 *
 * Antes de `[OR.0]` eran 14 derivables de 41 sin puesto. Después de crear los 11 puestos de oficina
 * y corregir `auxiliar_mkt`, son **38 de 41**.
 *
 * ── ⚠️ Por qué NO lleva una lista de usernames ──────────────────────────────────────────────
 * Durante la medición de esta misma fase, «personas con puesto» pasó de **58 a 59 entre dos
 * consultas separadas por diez minutos**: hay otras sesiones editando el padrón en vivo. Una lista
 * fija escrita hoy estaría vieja al aplicarse — le pondría el puesto a quien ya lo tiene, o se
 * saltaría a quien entró después. Así que **la condición se evalúa dentro del UPDATE**, contra el
 * estado del momento. La corrida imprime a quién tocó, que es lo que había que auditar.
 *
 * ── La bitácora, que hasta hoy miraba para otro lado ─────────────────────────────────────────
 * `identity.user_events` tiene 97 filas: 72 de alcance, 20 de la fusión de cuentas de `[ID.36]`,
 * 3 de permisos, 2 de roles. **Cero de alta, de puesto y de jefe.** Este backfill estrena
 * `puesto_asignado`, con de dónde salió la derivación, para que dentro de seis meses se pueda
 * contestar por qué Fulano quedó en ese puesto.
 *
 * `actor_user_id` va NULL a propósito: no lo hizo una persona, lo hizo esta migración. Inventar un
 * actor humano sería falsificar la auditoría que la tabla existe para dar.
 *
 * ── Lo que NO toca ──────────────────────────────────────────────────────────────────────────
 *  · A quien ya tiene puesto. Sólo `position_code IS NULL`.
 *  · A los ambiguos y a los sin candidato: se imprimen, no se adivinan.
 *  · `role_name`, alcance, permisos, `supervisor_id`. El jefe sale del puesto al leerlo
 *    (`positions.reports_to_position_code`), no se copia a la ficha.
 *  · `kind` distinto de `interno` (dispositivos, clientes, servicio).
 *
 * Idempotente: correrla dos veces no cambia nada la segunda vez.
 *
 * @param { import("knex").Knex } knex
 */

/** Personas sin puesto, con cuántos candidatos tiene cada una, AHORA. */
const SQL_CANDIDATOS = `
  SELECT u.id, u.username, u.role_name, u.department_code,
         (SELECT count(*)::int FROM identity.positions p
           WHERE p.tenant_id = u.tenant_id AND p.deleted_at IS NULL
             AND p.department_code IS NOT DISTINCT FROM u.department_code
             AND p.default_role = u.role_name) AS cand,
         (SELECT min(p.code) FROM identity.positions p
           WHERE p.tenant_id = u.tenant_id AND p.deleted_at IS NULL
             AND p.department_code IS NOT DISTINCT FROM u.department_code
             AND p.default_role = u.role_name) AS unico,
         (SELECT string_agg(p.code, ' | ' ORDER BY p.code) FROM identity.positions p
           WHERE p.tenant_id = u.tenant_id AND p.deleted_at IS NULL
             AND p.department_code IS NOT DISTINCT FROM u.department_code
             AND p.default_role = u.role_name) AS cuales
    FROM identity.users u
   WHERE u.tenant_id = ? AND u.activo AND u.deleted_at IS NULL
     AND u.kind = 'interno' AND u.position_code IS NULL
   ORDER BY cand, u.department_code, u.username`;

exports.up = async function up(knex) {
  const tenants = await knex('identity.tenants').where({ activo: true }).pluck('id');

  for (const tenant of tenants) {
    const antes = await knex.raw(SQL_CANDIDATOS, [tenant]);
    const derivables = antes.rows.filter((x) => x.cand === 1);
    const ambiguos = antes.rows.filter((x) => x.cand > 1);
    const sinSalida = antes.rows.filter((x) => x.cand === 0);

    console.log(
      `\n  [OR.1c] tenant ${tenant}: ${antes.rows.length} sin puesto — ` +
        `${derivables.length} derivables · ${ambiguos.length} ambiguos · ${sinSalida.length} sin candidato`,
    );

    let asignados = 0;
    for (const p of derivables) {
      // La condición se re-evalúa acá: si otra sesión le puso puesto mientras
      // corríamos, el WHERE no matchea y no se pisa nada.
      const n = await knex('identity.users')
        .where({ tenant_id: tenant, id: p.id })
        .whereNull('position_code')
        .whereNull('deleted_at')
        .update({ position_code: p.unico, updated_at: knex.fn.now() });
      if (!n) {
        console.log(`     ~ ${p.username}: otra sesión le puso puesto mientras corría — se respeta`);
        continue;
      }
      await knex('identity.user_events').insert({
        tenant_id: tenant,
        user_id: p.id,
        event: 'puesto_asignado',
        detalle: JSON.stringify({
          position_code: p.unico,
          origen: 'backfill [OR.1c]',
          derivado_de: { role_name: p.role_name, department_code: p.department_code },
          criterio: 'unico puesto del departamento cuyo default_role coincide con el rol',
        }),
        actor_user_id: null,
        actor_username: 'migracion [OR.1c]',
      });
      asignados++;
      console.log(`     + ${String(p.username).padEnd(20)} -> ${p.unico}`);
    }
    console.log(`  [OR.1c] ${asignados} puesto/s asignado/s (con su evento en user_events)`);

    // ── Lo que queda, declarado ───────────────────────────────────────────
    if (ambiguos.length) {
      console.log(`\n  [OR.1c] ${ambiguos.length} AMBIGUO/S — necesitan decisión humana, no se tocan:`);
      ambiguos.forEach((x) =>
        console.log(`     · ${String(x.username).padEnd(20)} rol=${String(x.role_name).padEnd(16)} candidatos: ${x.cuales}`),
      );
    }
    if (sinSalida.length) {
      console.log(`\n  [OR.1c] ${sinSalida.length} SIN CANDIDATO — ningún puesto de su departamento propone su rol:`);
      sinSalida.forEach((x) =>
        console.log(`     · ${String(x.username).padEnd(20)} rol=${String(x.role_name).padEnd(16)} depto=${x.department_code || '(sin depto)'}`),
      );
    }

    // ── La foto final, que es la que se audita ────────────────────────────
    const fin = await knex.raw(
      `SELECT count(*)::int total, count(position_code)::int con_puesto,
              count(*) FILTER (WHERE position_code IS NULL)::int sin_puesto
         FROM identity.users
        WHERE tenant_id = ? AND activo AND deleted_at IS NULL AND kind = 'interno'`,
      [tenant],
    );
    const f = fin.rows[0];
    console.log(
      `\n  [OR.1c] PADRÓN: ${f.con_puesto}/${f.total} con puesto · ${f.sin_puesto} sin puesto (declarados arriba)`,
    );

    // Cuántos heredan jefe del puesto, que es lo que [OR.1a] vino a habilitar.
    const jefe = await knex.raw(
      `SELECT count(*)::int n FROM identity.users u
         JOIN identity.positions p ON p.tenant_id = u.tenant_id AND p.code = u.position_code
        WHERE u.tenant_id = ? AND u.activo AND u.deleted_at IS NULL AND u.kind = 'interno'
          AND p.reports_to_position_code IS NOT NULL`,
      [tenant],
    );
    console.log(
      `  [OR.1c] heredan jefe de su PUESTO: ${jefe.rows[0].n} · lo tienen por supervisor_id (excepción): ` +
        `${(await knex('identity.users').where({ tenant_id: tenant, kind: 'interno', activo: true }).whereNull('deleted_at').whereNotNull('supervisor_id').count('* as n').first()).n}`,
    );
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  // Se revierte SÓLO lo que esta migración asignó, leyéndolo de su propia bitácora.
  const ev = await knex('identity.user_events')
    .where({ event: 'puesto_asignado', actor_username: 'migracion [OR.1c]' })
    .select('tenant_id', 'user_id');
  for (const e of ev) {
    await knex('identity.users').where({ tenant_id: e.tenant_id, id: e.user_id }).update({ position_code: null });
  }
  console.log(`  [OR.1c] down: ${ev.length} puesto/s revertido/s. user_events es append-only y se conserva.`);
};
