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
 *   5. Coherencia de la materialización. OJO con el matiz: "todo usuario sin
 *      sucursal tiene un `all` explícito" NO es un invariante — es una foto del
 *      padrón que existía cuando corrió `[ID.3]`. Un usuario que llegue después
 *      (alta nueva, restore, sync desde otro ambiente con `created_at` viejo)
 *      cae al default del rol, que es `own`, y sin sucursal asignada eso es
 *      "no ve nada". **Eso es el fail-closed funcionando, no una regresión.**
 *      Así que acá se afirma lo que sí es invariante — que lo materializado es
 *      coherente y que nadie con sucursal recibió un `all` de regalo — y los
 *      usuarios sin cobertura se REPORTAN como pendientes, no se tratan como
 *      falla. Quien vigila que nadie pierda acceso es `snapshot-user-scope.js`.
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

    // ── 5. Coherencia de la materialización ────────────────────────────────
    console.log('\n═══ 5. Coherencia de la materialización ═══');
    for (const [dim, col] of [['warehouse', 'warehouse_code'], ['zone', 'zona_id']]) {
      // Invariante REAL: lo que `[ID.3]` escribió como `all` corresponde a
      // usuarios que efectivamente no tenían el dato.
      const incoherentes = await knex.raw(
        `SELECT u.username FROM identity.users u
           JOIN identity.user_scopes us
             ON us.tenant_id = u.tenant_id AND us.user_id = u.id AND us.dimension = ?
          WHERE u.deleted_at IS NULL AND us.nota LIKE '[ID.3]%' AND us.mode = 'all'
            AND u.${col} IS NOT NULL
          ORDER BY 1 LIMIT 5`,
        [dim],
      );
      assert(
        incoherentes.rows.length === 0,
        `ningún '${dim}=all' de [ID.3] cayó sobre alguien que SÍ tenía ${col}` +
          (incoherentes.rows.length ? ` — ${incoherentes.rows.map((r) => r.username).join(', ')}` : ''),
      );

      // Sin cobertura se REPORTA, no falla: es la pila de "asignale sucursal",
      // que es exactamente lo que el fail-closed vuelve visible.
      const sinCobertura = await knex.raw(
        `SELECT u.username FROM identity.users u
          WHERE u.deleted_at IS NULL
            AND u.${col} IS NULL
            AND lower(u.role_name) NOT IN (?, ?)
            AND NOT EXISTS (
              SELECT 1 FROM identity.user_scopes us
               WHERE us.tenant_id = u.tenant_id AND us.user_id = u.id AND us.dimension = ?)
          ORDER BY 1`,
        [...GOD, dim],
      );
      const n = sinCobertura.rows.length;
      console.log(
        n
          ? `  · ${n} usuario(s) sin ${col} y sin regla de ${dim} → caen al default del rol (fail-closed). ` +
            `Pendientes: ${sinCobertura.rows.slice(0, 5).map((r) => r.username).join(', ')}${n > 5 ? '…' : ''}`
          : `  · todos los usuarios sin ${col} tienen regla explícita de ${dim}`,
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
