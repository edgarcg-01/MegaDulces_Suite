#!/usr/bin/env node
/**
 * `[ID.1-3]` — Alcance de datos (Fase ID / ADR-050).
 *
 * Cubre:
 *   1. Catálogo de 6 dimensiones.
 *   2. CHECKs de dominio: `mode` válido y `listed` sin valores rechazado
 *      (la trampa clásica: se lee "restringido" y funciona como "no ve nada").
 *   3. RLS habilitado + FORZADO en las dos tablas.
 *   4. Orden de resolución: override de usuario GANA sobre default de rol.
 *   5. Cobertura de la materialización: TODO usuario no-god sin sucursal/zona
 *      asignada tiene su fila `all` explícita. Esto es lo que verifica que
 *      nadie se queda sin acceso el día que `[ID.4]` prenda el resolver, y se
 *      comprueba con `NOT EXISTS` en vez de con conjuntos, así corre igual en
 *      local (que no tiene sucursales de 2 dígitos) y en prod.
 *   6. `public.users` expone `warehouse_id` (la vista se había quedado atrás).
 *   7. Todo rol no-god tiene sus 6 defaults.
 *   8. Ningún `own` en dimensiones que no lo soportan (`supports_own = false`),
 *      que resolvería a lista vacía = usuario ciego sin que nadie lo note.
 *
 * Corre como postgres (bypassa RLS) salvo el bloque 3, que usa `app_runtime`.
 * NO deja basura: el bloque 4 trabaja dentro de una trx con ROLLBACK.
 *
 * Correr: node database/tests/test-newdb-identity-scopes.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const DST = process.env.DATABASE_URL_NEW;
if (!DST) { console.error('Falta DATABASE_URL_NEW'); process.exit(1); }

const GOD = ['superadmin', 'admin'];
const DIMS = ['warehouse', 'zone', 'route', 'brand', 'expense_area', 'customer'];

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

(async () => {
  try {
    // ── 1. Catálogo ────────────────────────────────────────────────────────
    console.log('\n═══ 1. Catálogo de dimensiones ═══');
    const dims = (await knex('identity.scope_dimensions').select('code', 'supports_own').orderBy('orden')).map((r) => r.code);
    assert(dims.length === 6, `6 dimensiones (hay ${dims.length})`);
    for (const d of DIMS) assert(dims.includes(d), `existe la dimensión ${d}`);

    // ── 2. CHECKs ──────────────────────────────────────────────────────────
    console.log('\n═══ 2. CHECKs de dominio ═══');
    const tenant = (await knex('identity.tenants').where({ slug: 'mega_dulces' }).first('id')).id;
    const algúnRol = (await knex('identity.role_permissions').where({ tenant_id: tenant }).first('role_name')).role_name;

    const rechaza = async (fila, msg) => {
      try {
        await knex.transaction(async (trx) => {
          await trx('identity.role_scopes').insert({ tenant_id: tenant, role_name: algúnRol, ...fila });
          throw new Error('__no_falló__');
        });
        assert(false, msg);
      } catch (e) {
        assert(!/__no_falló__/.test(e.message), `${msg} (${e.message.split('\n')[0].slice(0, 60)})`);
      }
    };
    await rechaza({ dimension: 'warehouse', mode: 'inventado' }, 'rechaza mode inválido');
    await rechaza({ dimension: 'warehouse', mode: 'listed' }, 'rechaza listed sin valores');
    await rechaza({ dimension: 'warehouse', mode: 'listed', values: [] }, 'rechaza listed con array vacío');
    await rechaza({ dimension: 'no_existe', mode: 'all' }, 'rechaza dimensión fuera del catálogo');

    // ── 3. RLS ─────────────────────────────────────────────────────────────
    console.log('\n═══ 3. RLS ═══');
    for (const t of ['role_scopes', 'user_scopes']) {
      const r = (await knex.raw(
        `SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE oid = ?::regclass`,
        [`identity.${t}`],
      )).rows[0];
      assert(r.r && r.f, `identity.${t}: RLS habilitado Y forzado`);
      const p = await knex.raw(
        `SELECT 1 FROM pg_policies WHERE schemaname='identity' AND tablename=? AND policyname='tenant_isolation'`, [t]);
      assert(p.rows.length === 1, `identity.${t}: policy tenant_isolation`);
    }

    // ── 4. Orden de resolución ─────────────────────────────────────────────
    console.log('\n═══ 4. user_scopes gana sobre role_scopes ═══');
    await knex.transaction(async (trx) => {
      const u = await trx('identity.users')
        .where({ tenant_id: tenant })
        .whereNotIn(knex.raw('lower(role_name)'), GOD)
        .whereNull('deleted_at')
        .first('id', 'role_name');
      assert(!!u, 'hay un usuario no-god para probar');
      if (u) {
        const rolMode = (await trx('identity.role_scopes')
          .where({ tenant_id: tenant, dimension: 'warehouse' })
          .whereRaw('lower(role_name) = ?', [u.role_name.toLowerCase()])
          .first('mode'))?.mode;
        assert(!!rolMode, `su rol tiene default de warehouse (${rolMode})`);

        await trx('identity.user_scopes')
          .insert({ tenant_id: tenant, user_id: u.id, dimension: 'warehouse', mode: 'listed', values: ['99'], nota: 'test' })
          .onConflict(['tenant_id', 'user_id', 'dimension'])
          .merge();
        const efectivo = (await trx.raw(
          `SELECT COALESCE(us.mode, rs.mode) AS mode, COALESCE(us.values, rs.values) AS values
             FROM identity.users u
             LEFT JOIN identity.user_scopes us
                    ON us.tenant_id = u.tenant_id AND us.user_id = u.id AND us.dimension = 'warehouse'
             LEFT JOIN identity.role_scopes rs
                    ON rs.tenant_id = u.tenant_id AND lower(rs.role_name) = lower(u.role_name) AND rs.dimension = 'warehouse'
            WHERE u.id = ?`, [u.id])).rows[0];
        assert(efectivo.mode === 'listed', `override gana: mode efectivo = ${efectivo.mode}`);
        assert(Array.isArray(efectivo.values) && efectivo.values[0] === '99', 'y trae sus valores');
      }
      throw new Error('__rollback__'); // no deja rastro
    }).catch((e) => {
      if (!/__rollback__/.test(e.message)) throw e;
    });
    const sucio = await knex('identity.user_scopes').where({ nota: 'test' }).count('* as n').first();
    assert(Number(sucio.n) === 0, 'el rollback no dejó basura');

    // ── 5. Cobertura de la materialización ─────────────────────────────────
    console.log('\n═══ 5. Cobertura: nadie pierde acceso ═══');
    for (const [dim, col] of [['warehouse', 'warehouse_code'], ['zone', 'zona_id']]) {
      const huecos = await knex.raw(
        `SELECT u.username FROM identity.users u
          WHERE u.deleted_at IS NULL
            AND u.${col} IS NULL
            AND lower(u.role_name) NOT IN (?, ?)
            AND NOT EXISTS (
              SELECT 1 FROM identity.user_scopes us
               WHERE us.tenant_id = u.tenant_id AND us.user_id = u.id
                 AND us.dimension = ? AND us.mode = 'all')
          ORDER BY 1 LIMIT 5`,
        [...GOD, dim],
      );
      assert(
        huecos.rows.length === 0,
        `todo usuario sin ${col} tiene ${dim}=all explícito` +
          (huecos.rows.length ? ` — faltan: ${huecos.rows.map((r) => r.username).join(', ')}` : ''),
      );
    }
    // Y el complemento: quien SÍ tiene sucursal no debe tener un `all` regalado.
    const regalados = await knex.raw(
      `SELECT u.username FROM identity.users u
         JOIN identity.user_scopes us
           ON us.tenant_id = u.tenant_id AND us.user_id = u.id AND us.dimension = 'warehouse'
        WHERE u.deleted_at IS NULL AND u.warehouse_code IS NOT NULL AND us.mode = 'all'
          AND us.nota LIKE '[ID.3]%'
        ORDER BY 1 LIMIT 5`,
    );
    assert(
      regalados.rows.length === 0,
      'la materialización NO le dio "all" a nadie que ya tuviera sucursal' +
        (regalados.rows.length ? ` — ${regalados.rows.map((r) => r.username).join(', ')}` : ''),
    );

    // ── 6. La vista ────────────────────────────────────────────────────────
    console.log('\n═══ 6. public.users ═══');
    const v = await knex.raw(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='users' AND column_name='warehouse_id'`);
    assert(v.rows.length === 1, 'public.users expone warehouse_id');

    // ── 7. Defaults por rol ────────────────────────────────────────────────
    console.log('\n═══ 7. Defaults por rol ═══');
    const sinDefault = await knex.raw(
      `SELECT rp.role_name, 6 - count(rs.dimension) faltan
         FROM identity.role_permissions rp
         LEFT JOIN identity.role_scopes rs
                ON rs.tenant_id = rp.tenant_id AND rs.role_name = rp.role_name
        WHERE rp.deleted_at IS NULL AND lower(rp.role_name) NOT IN (?, ?)
        GROUP BY 1 HAVING count(rs.dimension) < 6
        ORDER BY 1 LIMIT 5`,
      GOD,
    );
    assert(
      sinDefault.rows.length === 0,
      'todo rol no-god tiene sus 6 dimensiones' +
        (sinDefault.rows.length ? ` — ${sinDefault.rows.map((r) => `${r.role_name}(-${r.faltan})`).join(', ')}` : ''),
    );

    // ── 8. `own` solo donde tiene sentido ──────────────────────────────────
    console.log('\n═══ 8. `own` coherente con supports_own ═══');
    const ownMal = await knex.raw(
      `SELECT t.tabla, t.dimension FROM (
         SELECT 'role_scopes' tabla, dimension, mode, mode_write FROM identity.role_scopes
         UNION ALL
         SELECT 'user_scopes', dimension, mode, mode_write FROM identity.user_scopes
       ) t
       JOIN identity.scope_dimensions d ON d.code = t.dimension
      WHERE d.supports_own IS FALSE AND ('own' IN (t.mode, t.mode_write))
      GROUP BY 1,2`,
    );
    assert(
      ownMal.rows.length === 0,
      "no hay mode='own' en dimensiones sin columna propia" +
        (ownMal.rows.length ? ` — ${ownMal.rows.map((r) => `${r.tabla}.${r.dimension}`).join(', ')}` : ''),
    );

    console.log(`\n═══════════ Resultado: ${pass} pass / ${fail} fail ═══════════`);
    if (fail) process.exitCode = 1;
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
