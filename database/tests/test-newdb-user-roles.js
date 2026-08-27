#!/usr/bin/env node
/**
 * `[ID.13]` — Un usuario, varios roles (Fase ID / esquema CRM-ERP).
 *
 * Cubre:
 *   1. Schema: `identity.user_roles` con RLS **forzado**, policy de tenant,
 *      grants a `app_runtime` y el índice parcial de un-solo-perfil-base.
 *   2. `users.kind` (CHECK del vocabulario) y `users.expires_at`.
 *   3. Backfill: cada usuario vivo con rol del catálogo tiene EXACTAMENTE un
 *      perfil base, y ese perfil coincide con `users.role_name`.
 *   4. Trigger `users.role_name` → perfil base. Y el matiz que importa: el
 *      perfil base anterior se **degrada a complemento**, no se borra. Quitarle
 *      un permiso a alguien tiene que ser una decisión explícita.
 *   5. Trigger inverso: escribir un perfil base en `user_roles` actualiza
 *      `users.role_name` (y no entra en recursión).
 *   6. El índice parcial rechaza un segundo perfil base.
 *   7. Semántica de la unión: `true` gana y un complemento sólo puede sumar.
 *      Se replica en SQL la misma cuenta que hace `getPermissionsForUser`.
 *   8. El caso real que motivó todo: la encargada de sucursal que además cobra
 *      en caja resuelto con UNA cuenta (hoy son 2, una con username de terminal).
 *
 * Escribe SOLO dentro de transacciones con ROLLBACK. Al final verifica que no
 * quedó basura.
 *
 * Correr: node database/tests/test-newdb-user-roles.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const DST = process.env.DATABASE_URL_NEW;
if (!DST) { console.error('Falta DATABASE_URL_NEW'); process.exit(1); }

const KINDS = ['interno', 'cliente', 'proveedor', 'externo', 'servicio'];
const NOTA_TEST = '[test-ID.13]';

let pass = 0, fail = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.error(`  ✗ ${msg}`); fail++; }
};

const knex = require('knex')({
  client: 'pg',
  connection: /localhost|127\.0\.0\.1|192\.168/.test(DST)
    ? DST
    : { connectionString: DST, ssl: { rejectUnauthorized: false } },
  pool: { min: 0, max: 3 },
});

/** Corre un bloque dentro de una trx y siempre revierte. */
const enTrx = async (fn) => {
  await knex
    .transaction(async (trx) => {
      await fn(trx);
      throw new Error('__rollback__');
    })
    .catch((e) => {
      if (!/__rollback__/.test(e.message)) throw e;
    });
};

(async () => {
  try {
    const tenant = (await knex('identity.tenants').first('id')).id;

    // ── 1. Schema ──────────────────────────────────────────────────────────
    console.log('\n═══ 1. Schema de identity.user_roles ═══');
    const tabla = await knex.raw(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'identity.user_roles'::regclass`,
    );
    assert(tabla.rows.length === 1, 'la tabla existe');
    assert(tabla.rows[0].relrowsecurity === true, 'RLS habilitado');
    assert(tabla.rows[0].relforcerowsecurity === true, 'RLS **forzado** (ni el owner se salva)');

    const pol = await knex.raw(
      `SELECT policyname FROM pg_policies WHERE schemaname='identity' AND tablename='user_roles'`,
    );
    assert(pol.rows.some((r) => r.policyname === 'tenant_isolation'), 'policy tenant_isolation presente');

    const grants = await knex.raw(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_schema='identity' AND table_name='user_roles' AND grantee='app_runtime'`,
    );
    const tipos = grants.rows.map((r) => r.privilege_type);
    assert(
      ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].every((t) => tipos.includes(t)),
      `app_runtime puede administrar la tabla (${tipos.sort().join(',')})`,
    );

    const idx = await knex.raw(
      `SELECT indexdef FROM pg_indexes WHERE schemaname='identity' AND indexname='user_roles_un_primario'`,
    );
    assert(idx.rows.length === 1, 'existe el índice de un-solo-perfil-base');
    assert(/UNIQUE/i.test(idx.rows[0]?.indexdef ?? '') && /is_primary/i.test(idx.rows[0]?.indexdef ?? ''),
      'y es UNIQUE parcial sobre is_primary (los complementos no compiten)');

    // ── 2. users.kind / users.expires_at ───────────────────────────────────
    console.log('\n═══ 2. Naturaleza de la cuenta y vencimiento ═══');
    const cols = await knex.raw(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='identity' AND table_name='users' AND column_name IN ('kind','expires_at')`,
    );
    const nombres = cols.rows.map((r) => r.column_name);
    assert(nombres.includes('kind'), 'users.kind existe');
    assert(nombres.includes('expires_at'), 'users.expires_at existe (cuentas con vencimiento)');

    const porKind = await knex('identity.users')
      .whereNull('deleted_at')
      .groupBy('kind')
      .select('kind')
      .count('* as n');
    const mapa = new Map(porKind.map((r) => [r.kind, Number(r.n)]));
    assert(
      Array.from(mapa.keys()).every((k) => KINDS.includes(k)),
      `todos los kind son del vocabulario (${Array.from(mapa.entries()).map(([k, v]) => `${k}:${v}`).join(' ')})`,
    );
    const b2b = await knex('identity.users')
      .whereNull('deleted_at')
      .whereRaw(`(customer_id IS NOT NULL OR LOWER(role_name) = 'customer_b2b')`)
      .whereNot({ kind: 'cliente' })
      .count('* as n')
      .first();
    assert(Number(b2b.n) === 0, 'ningún cliente del portal quedó marcado como interno');

    await enTrx(async (trx) => {
      const u = await trx('identity.users').whereNull('deleted_at').first('id');
      let rechazado = false;
      try {
        await trx('identity.users').where({ id: u.id }).update({ kind: 'lo_que_sea' });
      } catch { rechazado = true; }
      assert(rechazado, 'el CHECK rechaza un kind fuera del vocabulario');
    });

    // ── 3. Backfill ────────────────────────────────────────────────────────
    console.log('\n═══ 3. Backfill del perfil base ═══');
    const sinBase = await knex.raw(`
      SELECT u.username, u.role_name
        FROM identity.users u
       WHERE u.deleted_at IS NULL AND u.role_name IS NOT NULL
         AND EXISTS (SELECT 1 FROM identity.role_permissions rp
                      WHERE rp.tenant_id = u.tenant_id AND LOWER(rp.role_name) = LOWER(u.role_name))
         AND NOT EXISTS (SELECT 1 FROM identity.user_roles ur
                          WHERE ur.tenant_id = u.tenant_id AND ur.user_id = u.id AND ur.is_primary)`);
    assert(
      sinBase.rows.length === 0,
      `todo usuario con rol del catálogo tiene perfil base${sinBase.rows.length ? ` — faltan ${sinBase.rows.map((r) => r.username).join(', ')}` : ''}`,
    );

    const desalineado = await knex.raw(`
      SELECT u.username, u.role_name, ur.role_name AS base
        FROM identity.users u
        JOIN identity.user_roles ur ON ur.tenant_id = u.tenant_id AND ur.user_id = u.id AND ur.is_primary
       WHERE u.deleted_at IS NULL AND LOWER(ur.role_name) <> LOWER(u.role_name)`);
    assert(
      desalineado.rows.length === 0,
      `el perfil base coincide con users.role_name${desalineado.rows.length ? ` — ${desalineado.rows.map((r) => `${r.username}: ${r.role_name}≠${r.base}`).join('; ')}` : ''}`,
    );

    const conteo = await knex.raw(`
      SELECT count(*) FILTER (WHERE is_primary) base, count(*) FILTER (WHERE NOT is_primary) comp
        FROM identity.user_roles WHERE tenant_id = ?`, [tenant]);
    console.log(`    → ${conteo.rows[0].base} perfiles base · ${conteo.rows[0].comp} complementos`);
    assert(Number(conteo.rows[0].base) > 0, 'hay perfiles base cargados');

    // ── 4. Trigger users.role_name → perfil base ───────────────────────────
    console.log('\n═══ 4. Cambiar el rol del usuario mueve el perfil base ═══');
    await enTrx(async (trx) => {
      // Un usuario no-god y dos roles distintos del catálogo.
      const u = await trx('identity.users')
        .whereNull('deleted_at')
        .whereNotIn(knex.raw('lower(role_name)'), ['superadmin', 'admin'])
        .first('id', 'username', 'role_name', 'tenant_id');
      const otro = await trx('identity.role_permissions')
        .where({ tenant_id: u.tenant_id })
        .whereNull('deleted_at')
        .whereRaw('LOWER(role_name) <> ?', [String(u.role_name).toLowerCase()])
        .first('role_name');

      await trx('identity.users').where({ id: u.id }).update({ role_name: otro.role_name });

      const filas = await trx('identity.user_roles')
        .where({ tenant_id: u.tenant_id, user_id: u.id })
        .select('role_name', 'is_primary');
      const base = filas.filter((f) => f.is_primary);
      assert(base.length === 1 && base[0].role_name === otro.role_name,
        `el perfil base pasó a "${otro.role_name}"`);
      assert(
        filas.some((f) => !f.is_primary && f.role_name.toLowerCase() === String(u.role_name).toLowerCase()),
        `el rol anterior ("${u.role_name}") quedó como complemento, no se borró`,
      );
    });

    // ── 5. Trigger inverso ─────────────────────────────────────────────────
    console.log('\n═══ 5. Escribir el perfil base actualiza users.role_name ═══');
    await enTrx(async (trx) => {
      const u = await trx('identity.users')
        .whereNull('deleted_at')
        .whereNotIn(knex.raw('lower(role_name)'), ['superadmin', 'admin'])
        .first('id', 'role_name', 'tenant_id');
      const otro = await trx('identity.role_permissions')
        .where({ tenant_id: u.tenant_id })
        .whereNull('deleted_at')
        .whereRaw('LOWER(role_name) <> ?', [String(u.role_name).toLowerCase()])
        .first('role_name');

      await trx('identity.user_roles')
        .insert({ tenant_id: u.tenant_id, user_id: u.id, role_name: otro.role_name, is_primary: true, nota: NOTA_TEST })
        .onConflict(['tenant_id', 'user_id', 'role_name'])
        .merge({ is_primary: true });

      const tras = await trx('identity.users').where({ id: u.id }).first('role_name');
      assert(tras.role_name === otro.role_name, `users.role_name siguió al perfil base ("${otro.role_name}")`);
      const bases = await trx('identity.user_roles')
        .where({ tenant_id: u.tenant_id, user_id: u.id, is_primary: true })
        .count('* as n')
        .first();
      assert(Number(bases.n) === 1, 'sigue habiendo exactamente un perfil base (sin recursión ni duplicados)');
    });

    // ── 6. Nunca hay dos perfiles base ─────────────────────────────────────
    // El primer intento de este test esperaba un error de llave duplicada, y
    // eso era el bug: promover un rol reventaba en vez de degradar al anterior.
    // Ahora un BEFORE trigger degrada primero, así que "cambiale el perfil base"
    // es una sola operación idempotente. El índice queda como red de seguridad.
    console.log('\n═══ 6. Promover un rol degrada al perfil base anterior ═══');
    await enTrx(async (trx) => {
      const u = await trx('identity.users')
        .whereNull('deleted_at')
        .whereNotIn(knex.raw('lower(role_name)'), ['superadmin', 'admin'])
        .first('id', 'role_name', 'tenant_id');
      const otro = await trx('identity.role_permissions')
        .where({ tenant_id: u.tenant_id })
        .whereNull('deleted_at')
        .whereRaw('LOWER(role_name) <> ?', [String(u.role_name).toLowerCase()])
        .first('role_name');

      await trx('identity.user_roles').insert({
        tenant_id: u.tenant_id, user_id: u.id, role_name: otro.role_name, is_primary: false, nota: NOTA_TEST,
      });
      await trx.raw(
        `UPDATE identity.user_roles SET is_primary = TRUE
          WHERE tenant_id = ? AND user_id = ? AND role_name = ?`,
        [u.tenant_id, u.id, otro.role_name],
      );

      const bases = await trx('identity.user_roles')
        .where({ tenant_id: u.tenant_id, user_id: u.id, is_primary: true })
        .select('role_name');
      assert(bases.length === 1, `sigue habiendo exactamente un perfil base (hay ${bases.length})`);
      assert(bases[0].role_name === otro.role_name, `y es el recién promovido ("${otro.role_name}")`);
      const viejo = await trx('identity.user_roles')
        .where({ tenant_id: u.tenant_id, user_id: u.id, is_primary: false })
        .pluck('role_name');
      assert(
        viejo.map((r) => r.toLowerCase()).includes(String(u.role_name).toLowerCase()),
        `el anterior ("${u.role_name}") quedó como complemento`,
      );
    });

    // ── 7. La unión: un complemento sólo suma ──────────────────────────────
    console.log('\n═══ 7. Permisos efectivos = unión (true gana) ═══');
    await enTrx(async (trx) => {
      // Un usuario con perfil base chico y un complemento que aporta algo que
      // el base no tiene. `captura_gastos` es el caso real: 1 permiso.
      const u = await trx('identity.users')
        .whereNull('deleted_at')
        .whereNotIn(knex.raw('lower(role_name)'), ['superadmin', 'admin'])
        .whereNotNull('role_name')
        .first('id', 'role_name', 'tenant_id');

      const cuenta = async (roles) => {
        const r = await trx.raw(`
          SELECT count(DISTINCT e.key)::int n
            FROM identity.role_permissions rp, jsonb_each(rp.permissions) e
           WHERE rp.tenant_id = ? AND LOWER(rp.role_name) = ANY(?) AND e.value = 'true'`,
          [u.tenant_id, roles.map((x) => String(x).toLowerCase())]);
        return r.rows[0].n;
      };

      // Se elige como complemento un rol que aporte permisos que el base NO tiene.
      const cand = await trx.raw(`
        SELECT rp.role_name,
               (SELECT count(*) FROM jsonb_each(rp.permissions) e
                 WHERE e.value = 'true'
                   AND NOT EXISTS (
                     SELECT 1 FROM identity.role_permissions b, jsonb_each(b.permissions) be
                      WHERE b.tenant_id = rp.tenant_id AND LOWER(b.role_name) = LOWER(?)
                        AND be.key = e.key AND be.value = 'true'))::int aporta
          FROM identity.role_permissions rp
         WHERE rp.tenant_id = ? AND rp.deleted_at IS NULL AND LOWER(rp.role_name) <> LOWER(?)
         ORDER BY aporta ASC`, [u.role_name, u.tenant_id, u.role_name]);
      const complemento = cand.rows.find((r) => r.aporta > 0);
      assert(!!complemento, `hay un rol que puede funcionar de complemento (aporta ${complemento?.aporta} permisos nuevos)`);

      const soloBase = await cuenta([u.role_name]);
      const conComp = await cuenta([u.role_name, complemento.role_name]);
      assert(conComp === soloBase + complemento.aporta,
        `la unión suma exacto: ${soloBase} + ${complemento.aporta} = ${conComp}`);
      assert(conComp > soloBase, 'el complemento SUMA permisos, nunca resta');

      await trx('identity.user_roles').insert({
        tenant_id: u.tenant_id, user_id: u.id, role_name: complemento.role_name, is_primary: false, nota: NOTA_TEST,
      });
      const tras = await trx('identity.users').where({ id: u.id }).first('role_name');
      assert(tras.role_name === u.role_name, 'agregar un complemento NO cambia el perfil base');
    });

    // ── 8. El caso real: encargada de sucursal que además cobra en caja ────
    console.log('\n═══ 8. El caso que motivó el cambio ═══');
    const dobles = await knex.raw(`
      SELECT lower(trim(nombre)) persona, count(*) cuentas, string_agg(username || ':' || role_name, ' | ') detalle
        FROM identity.users
       WHERE deleted_at IS NULL AND nombre IS NOT NULL
       GROUP BY 1 HAVING count(*) > 1 ORDER BY 2 DESC`);
    console.log(`    → ${dobles.rows.length} persona(s) con más de una cuenta hoy:`);
    dobles.rows.slice(0, 8).forEach((r) => console.log(`       ${r.persona}: ${r.detalle}`));

    await enTrx(async (trx) => {
      const enc = await trx('identity.users')
        .whereNull('deleted_at')
        .whereRaw(`LOWER(role_name) = 'encargado_sucursal'`)
        .first('id', 'username', 'role_name', 'tenant_id');
      const cajera = await trx('identity.role_permissions')
        .where({ tenant_id: tenant })
        .whereRaw(`LOWER(role_name) = 'cajera'`)
        .first('role_name');
      if (!enc || !cajera) {
        console.log('    — sin encargado_sucursal o rol cajera en este ambiente: se omite');
        return;
      }
      await trx('identity.user_roles').insert({
        tenant_id: enc.tenant_id, user_id: enc.id, role_name: cajera.role_name, is_primary: false, nota: NOTA_TEST,
      });
      const roles = await trx('identity.user_roles')
        .where({ tenant_id: enc.tenant_id, user_id: enc.id })
        .orderBy('is_primary', 'desc')
        .select('role_name', 'is_primary');
      assert(
        roles.length >= 2 && roles[0].is_primary === true,
        `${enc.username} es encargado_sucursal Y cajera con UNA cuenta (${roles.map((r) => r.role_name).join(' + ')})`,
      );
    });

    // ── 9. Sin basura ──────────────────────────────────────────────────────
    console.log('\n═══ 9. Los rollbacks no dejaron nada ═══');
    const basura = await knex('identity.user_roles').where({ nota: NOTA_TEST }).count('* as n').first();
    assert(Number(basura.n) === 0, 'ninguna fila de prueba sobrevivió');
    const huerfanos = await knex.raw(`
      SELECT count(*)::int n FROM identity.user_roles ur
       WHERE NOT EXISTS (SELECT 1 FROM identity.users u
                          WHERE u.tenant_id = ur.tenant_id AND u.id = ur.user_id)`);
    assert(huerfanos.rows[0].n === 0, 'ningún user_roles apunta a un usuario que no existe');

    console.log(`\n═══════════ Resultado: ${pass} pass / ${fail} fail ═══════════`);
    if (fail) process.exitCode = 1;
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
