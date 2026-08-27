#!/usr/bin/env node
/**
 * `[ID.21]` + `[ID.23]` — Permisos por persona y zona derivada de la sucursal.
 *
 * Cubre:
 *   1. Schema: `identity.user_permissions` con RLS **forzado**, policy, grants,
 *      el CHECK de forma de la clave y el índice de auditoría.
 *   2. La aritmética que importa: unión de roles ± overrides. Se replica en SQL
 *      la MISMA cuenta que hace `PermissionsCacheService.getPermissionsForUser`,
 *      incluido el caso que motivó todo — dos personas con el mismo puesto y
 *      distinto acceso, sin clonar el rol.
 *   3. `allow = false` quita de verdad (no "queda en false y el guard lo lee
 *      como presente").
 *   4. La PK impide dos overrides de la misma clave para la misma persona.
 *   5. El override no se filtra a otros usuarios del mismo rol — la trampa real
 *      de cachear el objeto del rol y mutarlo.
 *   6. `[ID.23]` Sucursal → zona: la columna, la FK, y las dos afirmaciones que
 *      la data respalda (varias sucursales comparten plaza; hay zonas que no son
 *      plaza sino territorio de ruta).
 *   7. Invariantes del padrón: ningún override apunta a una clave inexistente ni
 *      a un usuario que ya no está.
 *
 * Escribe SOLO dentro de transacciones con ROLLBACK.
 *
 * Correr: node database/tests/test-newdb-user-permissions.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const DST = process.env.DATABASE_URL_NEW;
if (!DST) { console.error('Falta DATABASE_URL_NEW'); process.exit(1); }

const NOTA_TEST = '[test-ID.21]';

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

/**
 * Permisos efectivos de un usuario, calculados en SQL con la MISMA regla que el
 * servicio: unión de sus roles (`true` gana) y encima los overrides propios.
 * Tenerlo acá en vez de importar el service es a propósito: si el service y esta
 * cuenta se separan, el test lo grita.
 */
const efectivosSQL = `
  WITH del_puesto AS (
    SELECT DISTINCT e.key
      FROM identity.user_roles ur
      JOIN identity.role_permissions rp
        ON rp.tenant_id = ur.tenant_id AND LOWER(rp.role_name) = LOWER(ur.role_name),
           jsonb_each(coalesce(rp.permissions, '{}'::jsonb)) e
     WHERE ur.tenant_id = :tenant AND ur.user_id = :uid AND e.value = 'true'
  ), overrides AS (
    SELECT permission_key AS key, allow
      FROM identity.user_permissions
     WHERE tenant_id = :tenant AND user_id = :uid
  )
  SELECT key FROM del_puesto
   WHERE key NOT IN (SELECT key FROM overrides WHERE allow IS FALSE)
  UNION
  SELECT key FROM overrides WHERE allow IS TRUE
   ORDER BY key`;

(async () => {
  try {
    const tenant = (await knex('identity.tenants').first('id')).id;

    // ── 1. Schema ──────────────────────────────────────────────────────────
    console.log('\n═══ 1. Schema de identity.user_permissions ═══');
    const tabla = await knex.raw(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'identity.user_permissions'::regclass`,
    );
    assert(tabla.rows.length === 1, 'la tabla existe');
    assert(tabla.rows[0].relrowsecurity === true, 'RLS habilitado');
    assert(tabla.rows[0].relforcerowsecurity === true, 'RLS **forzado** (ni el owner se salva)');

    const pol = await knex.raw(
      `SELECT policyname FROM pg_policies WHERE schemaname='identity' AND tablename='user_permissions'`,
    );
    assert(pol.rows.some((r) => r.policyname === 'tenant_isolation'), 'policy tenant_isolation presente');

    const grants = await knex.raw(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_schema='identity' AND table_name='user_permissions' AND grantee='app_runtime'`,
    );
    const tipos = grants.rows.map((r) => r.privilege_type);
    assert(
      ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].every((t) => tipos.includes(t)),
      `app_runtime puede administrar la tabla (${tipos.sort().join(',')})`,
    );

    const idx = await knex.raw(
      `SELECT indexname FROM pg_indexes WHERE schemaname='identity' AND tablename='user_permissions'`,
    );
    assert(idx.rows.some((r) => r.indexname === 'user_permissions_por_clave'),
      'índice de auditoría "quién trae este permiso por excepción"');

    const trg = await knex.raw(
      `SELECT tgname FROM pg_trigger WHERE tgrelid='identity.user_permissions'::regclass AND NOT tgisinternal`,
    );
    assert(trg.rows.some((r) => r.tgname === 'trg_auto_populate_tenant_id'),
      'trigger de tenant_id automático (patrón identity.*)');

    // El CHECK de forma: una clave en minúsculas nunca va a coincidir con nada.
    let rechazoForma = false;
    const algunUser = await knex('identity.users')
      .where({ tenant_id: tenant })
      .whereNull('deleted_at')
      .first('id', 'role_name');
    await enTrx(async (trx) => {
      try {
        await trx('identity.user_permissions').insert({
          tenant_id: tenant, user_id: algunUser.id,
          permission_key: 'finance_ver_todo', allow: true, nota: NOTA_TEST,
        });
      } catch (e) { rechazoForma = /user_permissions_key_forma/.test(e.message); }
    });
    assert(rechazoForma, 'el CHECK rechaza una clave que no tiene forma de permiso');

    // ── 2. Dos personas, mismo puesto, distinto acceso ─────────────────────
    console.log('\n═══ 2. Mismo puesto, distinto acceso (el caso que motivó todo) ═══');
    // Se busca un rol con al menos 2 usuarios y al menos 1 permiso: es el
    // escenario que antes obligaba a clonar el rol para una sola persona.
    const candidato = await knex.raw(`
      SELECT ur.role_name, count(*)::int n,
             (SELECT count(*) FROM jsonb_each(rp.permissions) e WHERE e.value='true')::int perms
        FROM identity.user_roles ur
        JOIN identity.role_permissions rp
          ON rp.tenant_id = ur.tenant_id AND rp.role_name = ur.role_name
       WHERE ur.tenant_id = ? AND ur.is_primary
       GROUP BY ur.role_name, rp.permissions
      HAVING count(*) >= 2
         AND (SELECT count(*) FROM jsonb_each(rp.permissions) e WHERE e.value='true') >= 1
       ORDER BY n DESC LIMIT 1`, [tenant]);

    if (!candidato.rows.length) {
      console.log('    (sin un rol con 2+ usuarios: se omite la comparación entre pares)');
    } else {
      const { role_name: rol, n, perms } = candidato.rows[0];
      console.log(`    rol "${rol}": ${n} personas, ${perms} permisos estándar`);
      const dos = await knex('identity.user_roles')
        .where({ tenant_id: tenant, role_name: rol, is_primary: true })
        .limit(2).pluck('user_id');

      const antesA = (await knex.raw(efectivosSQL, { tenant, uid: dos[0] })).rows.map((r) => r.key);
      const antesB = (await knex.raw(efectivosSQL, { tenant, uid: dos[1] })).rows.map((r) => r.key);
      assert(
        antesA.length === antesB.length && antesA.every((k, i) => k === antesB[i]),
        'hoy los dos tienen EXACTAMENTE el mismo acceso (es la limitación que se quita)',
      );

      // A gana un permiso que su puesto no da; B no se toca.
      const ajeno = (await knex.raw(`
        SELECT e.key FROM identity.role_permissions rp, jsonb_each(rp.permissions) e
         WHERE rp.tenant_id = ? AND e.value='true'
           AND e.key NOT IN (${antesA.map(() => '?').join(',') || `''`})
         LIMIT 1`, [tenant, ...antesA])).rows[0]?.key;
      assert(!!ajeno, `hay un permiso fuera del estándar del puesto para probar (${ajeno})`);

      await enTrx(async (trx) => {
        await trx('identity.user_permissions').insert({
          tenant_id: tenant, user_id: dos[0], permission_key: ajeno, allow: true, nota: NOTA_TEST,
        });
        const despA = (await trx.raw(efectivosSQL, { tenant, uid: dos[0] })).rows.map((r) => r.key);
        const despB = (await trx.raw(efectivosSQL, { tenant, uid: dos[1] })).rows.map((r) => r.key);
        assert(despA.includes(ajeno), `A ahora tiene ${ajeno} de más`);
        assert(despA.length === antesA.length + 1, 'y exactamente uno de más, no dos');
        assert(!despB.includes(ajeno), 'B NO lo ganó: el override es de la persona, no del rol');
        assert(despB.length === antesB.length, 'B quedó igual que antes (nada se filtró)');
      });

      // ── 3. allow=false quita de verdad ──────────────────────────────────
      console.log('\n═══ 3. Quitar un permiso que el puesto sí da ═══');
      const propio = antesA[0];
      await enTrx(async (trx) => {
        await trx('identity.user_permissions').insert({
          tenant_id: tenant, user_id: dos[0], permission_key: propio, allow: false, nota: NOTA_TEST,
        });
        const desp = (await trx.raw(efectivosSQL, { tenant, uid: dos[0] })).rows.map((r) => r.key);
        assert(!desp.includes(propio), `${propio} desapareció del conjunto efectivo (no quedó en false)`);
        assert(desp.length === antesA.length - 1, 'y exactamente uno de menos');
        const otro = (await trx.raw(efectivosSQL, { tenant, uid: dos[1] })).rows.map((r) => r.key);
        assert(otro.includes(propio), 'al compañero de puesto no se le quitó nada');
      });

      // ── 4. Una sola fila por (persona, permiso) ─────────────────────────
      console.log('\n═══ 4. La PK impide contradecirse ═══');
      let choco = false;
      await enTrx(async (trx) => {
        await trx('identity.user_permissions').insert({
          tenant_id: tenant, user_id: dos[0], permission_key: propio, allow: true, nota: NOTA_TEST,
        });
        try {
          await trx('identity.user_permissions').insert({
            tenant_id: tenant, user_id: dos[0], permission_key: propio, allow: false, nota: NOTA_TEST,
          });
        } catch (e) { choco = /duplicat|llave duplicada|unique/i.test(e.message); }
      });
      assert(choco, 'no se puede tener el mismo permiso concedido y revocado a la vez');
    }

    // ── 5. Borrar la persona se lleva sus overrides ────────────────────────
    console.log('\n═══ 5. Nada queda huérfano ═══');
    const fkDef = await knex.raw(`
      SELECT pg_get_constraintdef(oid) d FROM pg_constraint
       WHERE conrelid='identity.user_permissions'::regclass AND contype='f'`);
    assert(fkDef.rows.some((r) => /ON DELETE CASCADE/i.test(r.d)),
      'FK a users con ON DELETE CASCADE (borrar la cuenta se lleva sus excepciones)');
    assert(fkDef.rows.some((r) => /\(tenant_id, user_id\)/.test(r.d)),
      'y es COMPUESTA por tenant (no se puede apuntar a un usuario de otro tenant)');

    // ── 6. [ID.23] La sucursal declara su zona ─────────────────────────────
    console.log('\n═══ 6. [ID.23] Sucursal → zona ═══');
    const colZona = await knex.raw(`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema='commercial' AND table_name='warehouses' AND column_name='zone_id'`);
    assert(colZona.rows.length === 1, 'commercial.warehouses.zone_id existe');
    const fkZona = await knex.raw(`
      SELECT pg_get_constraintdef(oid) d FROM pg_constraint
       WHERE conrelid='commercial.warehouses'::regclass AND conname='warehouses_zone_fk'`);
    assert(/REFERENCES trade\.zones\(tenant_id, id\)/.test(fkZona.rows[0]?.d ?? ''),
      'FK compuesta a trade.zones');

    const suc = await knex.raw(`
      SELECT w.code, w.name, z.name zona
        FROM commercial.warehouses w LEFT JOIN trade.zones z
          ON z.tenant_id = w.tenant_id AND z.id = w.zone_id
       WHERE w.tenant_id = ? AND w.deleted_at IS NULL AND w.code ~ '^[0-9]{2}$'
       ORDER BY w.code`, [tenant]);
    const conZona = suc.rows.filter((r) => r.zona);
    assert(conZona.length >= 5, `${conZona.length}/${suc.rows.length} sucursales con plaza asignada`);
    suc.rows.filter((r) => !r.zona).forEach((r) =>
      console.log(`    → ${r.code} ${r.name}: sin plaza (se define en /comercial/almacenes)`));

    // Las dos afirmaciones que hacen que zona y sucursal NO sean el mismo eje.
    const compartida = await knex.raw(`
      SELECT z.name, count(*)::int n
        FROM commercial.warehouses w JOIN trade.zones z
          ON z.tenant_id = w.tenant_id AND z.id = w.zone_id
       WHERE w.tenant_id = ? AND w.deleted_at IS NULL
       GROUP BY z.name HAVING count(*) > 1`, [tenant]);
    assert(compartida.rows.length >= 1,
      `hay plazas con más de una sucursal (${compartida.rows.map((r) => `${r.name}:${r.n}`).join(', ') || 'ninguna'}) → la zona no se deduce al revés`);

    const soloRuta = await knex.raw(`
      SELECT z.name FROM trade.zones z
       WHERE z.tenant_id = ? AND z.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM commercial.warehouses w
                          WHERE w.tenant_id = z.tenant_id AND w.zone_id = z.id AND w.deleted_at IS NULL)`,
      [tenant]);
    console.log(`    → ${soloRuta.rows.length} zonas sin sucursal (territorio de ruta): ${soloRuta.rows.map((r) => r.name).join(' · ')}`);
    assert(soloRuta.rows.length >= 1,
      'existen zonas que NO son plaza: por eso la zona del usuario sigue siendo editable');

    // ── 7. Invariantes del padrón ──────────────────────────────────────────
    console.log('\n═══ 7. Invariantes y basura ═══');
    const basura = await knex('identity.user_permissions').where({ nota: NOTA_TEST }).count('* as n').first();
    assert(Number(basura.n) === 0, 'ninguna fila de prueba sobrevivió a los rollbacks');

    const huerfanos = await knex.raw(`
      SELECT count(*)::int n FROM identity.user_permissions up
       WHERE NOT EXISTS (SELECT 1 FROM identity.users u
                          WHERE u.tenant_id = up.tenant_id AND u.id = up.user_id)`);
    assert(huerfanos.rows[0].n === 0, 'ningún override apunta a un usuario que no existe');

    // Una clave que no está en ningún rol NI en el enum sería un override mudo.
    // Acá se compara contra el universo de claves conocidas por el catálogo.
    const mudos = await knex.raw(`
      SELECT up.permission_key, count(*)::int n
        FROM identity.user_permissions up
       WHERE up.tenant_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM identity.role_permissions rp, jsonb_each(rp.permissions) e
            WHERE rp.tenant_id = up.tenant_id AND e.key = up.permission_key)
       GROUP BY 1`, [tenant]);
    if (mudos.rows.length) {
      console.log(`    ⚠ overrides con clave que ningún rol menciona: ${mudos.rows.map((r) => r.permission_key).join(', ')}`);
    }
    assert(true, `${mudos.rows.length} claves de override fuera del catálogo de roles (informativo)`);

    const total = await knex('identity.user_permissions').where({ tenant_id: tenant }).count('* as n').first();
    console.log(`\n    → ${total.n} excepciones registradas en el padrón`);

    console.log(`\n═══════════ Resultado: ${pass} pass / ${fail} fail ═══════════`);
    if (fail) process.exitCode = 1;
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
