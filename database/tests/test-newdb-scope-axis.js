#!/usr/bin/env node
/**
 * `[ID.24]` — El eje de alcance: la columna que divide poblaciones.
 *
 * Este smoke no verifica que el código corra: verifica que **las afirmaciones
 * sobre las que se construyó el diseño sigan siendo ciertas**. Si mañana una
 * ruta empieza a cruzar de zona, la derivación automática se vuelve mentira y
 * hay que enterarse acá, no por un vendedor que ve las tiendas de otro.
 *
 * Cubre:
 *   1. Schema: `scope_axis` en departamentos y puestos, con CHECK de vocabulario.
 *   2. **ruta → zona es una FUNCIÓN**: ninguna ruta con tiendas cruza de zona.
 *      Es la afirmación que sostiene "la zona se deriva de la ruta".
 *   3. **sucursal → zona es una FUNCIÓN**, y varias sucursales comparten plaza
 *      (o sea: al revés NO es función, y por eso la columna vive en la sucursal).
 *   4. Cobertura del eje: cuánta gente queda con eje resuelto (puesto → depto).
 *   5. La evidencia que motivó todo: cada población llena UN campo y deja el
 *      otro vacío (ruta: zona sí / sucursal no · cajas: al revés).
 *   6. `users.route_id` con FK compuesta, y que sólo apunte a rutas de verdad.
 *   7. El gate que impide romper a 28 personas: **no se puede poner
 *      `route: own` mientras haya gente de eje ruta sin ruta asignada**.
 *
 * Correr: node database/tests/test-newdb-scope-axis.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const DST = process.env.DATABASE_URL_NEW;
if (!DST) { console.error('Falta DATABASE_URL_NEW'); process.exit(1); }

const EJES = ['ruta', 'zona', 'sucursal', 'red', 'cartera', 'cliente'];

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
    const tenant = (await knex('identity.tenants').first('id')).id;

    // ── 1. Schema ──────────────────────────────────────────────────────────
    console.log('\n═══ 1. La columna que divide ═══');
    for (const tabla of ['departments', 'positions']) {
      const col = await knex.raw(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='identity' AND table_name=? AND column_name='scope_axis'`,
        [tabla],
      );
      assert(col.rows.length === 1, `identity.${tabla}.scope_axis existe`);
      const chk = await knex.raw(
        `SELECT pg_get_constraintdef(oid) d FROM pg_constraint
          WHERE conrelid=('identity.' || ?)::regclass AND conname = ? `,
        [tabla, `${tabla}_scope_axis_check`],
      );
      const def = chk.rows[0]?.d ?? '';
      assert(
        EJES.every((e) => def.includes(`'${e}'`)),
        `y su CHECK acepta exactamente el vocabulario (${EJES.join('|')})`,
      );
    }

    // ── 2. ruta → zona ES una función ──────────────────────────────────────
    console.log('\n═══ 2. ruta → zona: la afirmación que sostiene la derivación ═══');
    const cruzan = await knex.raw(
      `SELECT c.value ruta, count(DISTINCT s.zona_id)::int zonas,
              string_agg(DISTINCT z.name, ' | ') nombres
         FROM trade.stores s
         JOIN trade.catalogs c ON c.tenant_id = s.tenant_id AND c.id = s.ruta_id
         LEFT JOIN trade.zones z ON z.tenant_id = s.tenant_id AND z.id = s.zona_id
        WHERE s.tenant_id = ? AND s.deleted_at IS NULL AND s.zona_id IS NOT NULL
        GROUP BY c.value HAVING count(DISTINCT s.zona_id) > 1`,
      [tenant],
    );
    cruzan.rows.forEach((r) => console.error(`    ✗ "${r.ruta}" está en ${r.zonas} zonas: ${r.nombres}`));
    assert(
      cruzan.rows.length === 0,
      'ninguna ruta cruza de zona → la zona SE PUEDE derivar de la ruta',
    );
    const conTiendas = await knex.raw(
      `SELECT count(DISTINCT s.ruta_id)::int n FROM trade.stores s
        WHERE s.tenant_id = ? AND s.deleted_at IS NULL AND s.ruta_id IS NOT NULL`,
      [tenant],
    );
    console.log(`    (medido sobre ${conTiendas.rows[0].n} rutas con tiendas cargadas)`);
    const sinTiendas = await knex.raw(
      `SELECT c.value FROM trade.catalogs c
        WHERE c.tenant_id = ? AND c.catalog_id='rutas' AND c.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM trade.stores s
                           WHERE s.tenant_id=c.tenant_id AND s.ruta_id=c.id AND s.deleted_at IS NULL)`,
      [tenant],
    );
    console.log(`    → ${sinTiendas.rows.length} rutas sin tiendas: NO derivan zona (${sinTiendas.rows.map((r) => r.value).join(', ')})`);

    // ── 3. sucursal → zona, y la asimetría ─────────────────────────────────
    console.log('\n═══ 3. sucursal → zona, pero NO al revés ═══');
    const compartida = await knex.raw(
      `SELECT z.name, count(*)::int n, string_agg(w.code, ',' ORDER BY w.code) codigos
         FROM commercial.warehouses w
         JOIN trade.zones z ON z.tenant_id = w.tenant_id AND z.id = w.zone_id
        WHERE w.tenant_id = ? AND w.deleted_at IS NULL
        GROUP BY z.name HAVING count(*) > 1`,
      [tenant],
    );
    assert(
      compartida.rows.length >= 1,
      `hay plazas con varias sucursales (${compartida.rows.map((r) => `${r.name}: ${r.codigos}`).join(' · ') || 'ninguna'}) → zona→sucursal NO es función`,
    );

    // ── 4. Cobertura del eje ───────────────────────────────────────────────
    console.log('\n═══ 4. Cuánta gente queda con eje resuelto ═══');
    const cob = await knex.raw(
      `SELECT coalesce(p.scope_axis, d.scope_axis) eje, count(*)::int n
         FROM identity.users u
         LEFT JOIN identity.positions p ON p.tenant_id=u.tenant_id AND p.code=u.position_code
         LEFT JOIN identity.departments d ON d.tenant_id=u.tenant_id AND d.code=u.department_code
        WHERE u.tenant_id = ? AND u.deleted_at IS NULL
        GROUP BY 1 ORDER BY 2 DESC`,
      [tenant],
    );
    cob.rows.forEach((r) => console.log(`    ${String(r.n).padStart(4)}  ${r.eje ?? '(sin eje)'}`));
    const total = cob.rows.reduce((a, r) => a + r.n, 0);
    const sinEje = cob.rows.find((r) => r.eje === null)?.n ?? 0;
    assert(
      total > 0 && sinEje / total < 0.1,
      `menos del 10% queda sin eje (${sinEje}/${total})`,
    );
    const deptSinEje = await knex('identity.departments')
      .where({ tenant_id: tenant })
      .whereNull('deleted_at')
      .whereNull('scope_axis')
      .pluck('code');
    assert(deptSinEje.length === 0, `todos los departamentos declaran eje${deptSinEje.length ? ` (faltan: ${deptSinEje.join(', ')})` : ''}`);

    // ── 5. La evidencia: cada población llena UN campo ─────────────────────
    console.log('\n═══ 5. Cada población ya llenaba un solo campo ═══');
    const pob = await knex.raw(
      `SELECT coalesce(p.scope_axis, d.scope_axis) eje, count(*)::int n,
              count(u.zona_id)::int con_zona, count(u.warehouse_code)::int con_suc,
              count(u.route_id)::int con_ruta
         FROM identity.users u
         LEFT JOIN identity.positions p ON p.tenant_id=u.tenant_id AND p.code=u.position_code
         LEFT JOIN identity.departments d ON d.tenant_id=u.tenant_id AND d.code=u.department_code
        WHERE u.tenant_id = ? AND u.deleted_at IS NULL
        GROUP BY 1`,
      [tenant],
    );
    const ruta = pob.rows.find((r) => r.eje === 'ruta');
    const suc = pob.rows.find((r) => r.eje === 'sucursal');
    pob.rows.forEach((r) =>
      console.log(`    ${String(r.eje ?? '(sin eje)').padEnd(10)} n=${String(r.n).padStart(3)} zona=${String(r.con_zona).padStart(3)} sucursal=${String(r.con_suc).padStart(3)} ruta=${String(r.con_ruta).padStart(3)}`));
    if (ruta) {
      assert(ruta.con_zona > 0 && ruta.con_suc === 0,
        `la gente de eje RUTA tiene zona (${ruta.con_zona}/${ruta.n}) y NINGUNA sucursal`);
    }
    if (suc) {
      assert(suc.con_suc > 0, `la gente de eje SUCURSAL sí tiene sucursal (${suc.con_suc}/${suc.n})`);
    }

    // ── 6. users.route_id ──────────────────────────────────────────────────
    console.log('\n═══ 6. La ruta de la persona ═══');
    const fk = await knex.raw(
      `SELECT pg_get_constraintdef(oid) d FROM pg_constraint
        WHERE conrelid='identity.users'::regclass AND conname='users_route_fk'`,
    );
    assert(/\(tenant_id, route_id\)/.test(fk.rows[0]?.d ?? ''), 'FK compuesta por tenant a trade.catalogs');
    const malas = await knex.raw(
      `SELECT count(*)::int n FROM identity.users u
         JOIN trade.catalogs c ON c.tenant_id = u.tenant_id AND c.id = u.route_id
        WHERE u.tenant_id = ? AND u.route_id IS NOT NULL AND c.catalog_id <> 'rutas'`,
      [tenant],
    );
    assert(malas.rows[0].n === 0,
      'ningún usuario apunta a un catálogo que no sea de rutas (la FK sola no lo impide)');

    // ── 6b. `[ID.24.2]` Nadie de oficina puede quedar ciego ────────────────
    console.log('\n═══ 6b. El fail-closed silencioso: "own" sin valor propio ═══');
    const ciegos = await knex.raw(
      `WITH eje AS (
         SELECT u.id, u.role_name, u.warehouse_code, u.zona_id, u.route_id,
                coalesce(ps.scope_axis, d.scope_axis) axis
           FROM identity.users u
           LEFT JOIN identity.positions ps ON ps.tenant_id=u.tenant_id AND ps.code=u.position_code
           LEFT JOIN identity.departments d ON d.tenant_id=u.tenant_id AND d.code=u.department_code
          WHERE u.tenant_id = ? AND u.deleted_at IS NULL
       )
       SELECT e.axis, rs.dimension, count(*)::int n
         FROM eje e
         JOIN identity.role_scopes rs
           ON rs.tenant_id = ? AND lower(rs.role_name)=lower(e.role_name) AND rs.mode='own'
        WHERE (rs.dimension='warehouse' AND e.warehouse_code IS NULL)
           OR (rs.dimension='zone'      AND e.zona_id IS NULL)
        GROUP BY 1,2 ORDER BY 3 DESC`,
      [tenant, tenant],
    );
    ciegos.rows.forEach((r) =>
      console.log(`    eje ${String(r.axis ?? '—').padEnd(9)} ${String(r.dimension).padEnd(10)} ${r.n} personas`));
    const redCiegos = ciegos.rows.filter((r) => r.axis === 'red').reduce((a, r) => a + r.n, 0);
    assert(
      redCiegos === 0,
      'nadie de eje RED queda ciego: su alcance es la red, no "own" sin valor',
    );

    // ── 7. El gate que evita romper a la gente de ruta ─────────────────────
    console.log('\n═══ 7. Gate: no activar route=own antes de tener las rutas ═══');
    const sinRuta = await knex.raw(
      `SELECT count(*)::int n FROM identity.users u
         LEFT JOIN identity.positions p ON p.tenant_id=u.tenant_id AND p.code=u.position_code
         LEFT JOIN identity.departments d ON d.tenant_id=u.tenant_id AND d.code=u.department_code
        WHERE u.tenant_id = ? AND u.deleted_at IS NULL AND u.route_id IS NULL
          AND coalesce(p.scope_axis, d.scope_axis) = 'ruta'`,
      [tenant],
    );
    const ownRoute = await knex('identity.role_scopes')
      .where({ tenant_id: tenant, dimension: 'route', mode: 'own' })
      .pluck('role_name');
    const pendientes = sinRuta.rows[0].n;
    console.log(`    ${pendientes} personas de eje ruta sin ruta asignada · ${ownRoute.length} roles con route=own`);
    assert(
      pendientes === 0 || ownRoute.length === 0,
      pendientes === 0
        ? 'todas las personas de ruta tienen ruta: ya se puede pasar a route=own'
        : `NADIE tiene route=own todavía — activarlo con ${pendientes} personas sin ruta las dejaría sin ver nada`,
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
