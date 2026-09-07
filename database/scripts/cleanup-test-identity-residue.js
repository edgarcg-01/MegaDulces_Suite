'use strict';
/**
 * `[IDG.5]` — Barre el residuo que el suite de tests dejó en el padrón de PROD.
 *
 * El 2026-08-29, entre 16:47 y 17:13 UTC, `database/tests/` se corrió con el
 * `.env` apuntando a producción. Quedaron 5 cuentas y 2 tenants de prueba. Una
 * de ellas, `hacker`, sobrevivió porque el cleanup de su test sólo barre el
 * tenant ajeno y ella nació en el tenant real; cinco días después ya estaba
 * citada en el CHANGELOG (AUTHZ.6.4) como un dato legítimo del padrón.
 *
 * `hacker` además es la ÚNICA fila que viola `fk_users_tenant_role` (su rol
 * `admin_b` no existe), así que hay que sacarla antes de re-encender los
 * triggers de `identity.users` — si no, la FK queda con una violación latente
 * que revienta en el próximo UPDATE de esa fila.
 *
 * Dry-run por default (patrón de `cleanup-invented-data.js` / `-test-warehouses.js`):
 * sin `--apply` abre la transacción, cuenta, imprime y hace ROLLBACK.
 *
 *   node database/scripts/cleanup-test-identity-residue.js            # dry-run
 *   node database/scripts/cleanup-test-identity-residue.js --apply    # ejecuta
 *
 * Guarda INVERTIDA, como `cleanup-future-sales.js`: `--apply` exige que el
 * destino sea prod, porque el residuo está en prod y correrlo por accidente
 * contra la compartida borraría cuentas de prueba que otro dev esté usando.
 *
 * NUNCA imprime la cadena de conexión.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Client } = require('pg');

const APLICAR = process.argv.includes('--apply');
const URL = process.env.FLEET_DB_URL;

if (!URL) {
  console.error('Falta FLEET_DB_URL en .env');
  process.exit(1);
}
if (APLICAR && !/rlwy\.net|railway/i.test(URL)) {
  console.error('ABORT: --apply exige que FLEET_DB_URL apunte a prod. El residuo está en prod.');
  process.exit(3);
}

/** Las 5 cuentas de prueba, por username. Nombres literales: nada de patrones. */
const USUARIOS = [
  'hacker',                   // Test 7 de test-newdb-rls-isolation, rol `admin_b` inexistente
  'cajera_smoke',             // smoke de arqueo
  'supervisor_arqueo_smoke',  // smoke de arqueo
  'isouser',                  // tenant_isolation_test
  'wsisouser',                // ws_iso_test
];

/** Los roles que existen SÓLO para esos smokes. `admin_b` no está: nunca se creó la fila. */
const ROLES = ['cajera_smoke', 'supervisor_arqueo_smoke'];

/** Los tenants de prueba a retirar. */
const TENANTS = ['tenant_isolation_test', 'ws_iso_test'];

(async () => {
  const c = new Client({ connectionString: URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  console.log(`\nModo: ${APLICAR ? 'APLICAR (se escribe)' : 'DRY-RUN (termina en ROLLBACK)'}\n`);

  await c.query('BEGIN');
  try {
    // ── Qué vamos a tocar, antes de tocarlo ────────────────────────────────
    const usuarios = await c.query(
      `SELECT u.id, u.username, u.role_name, u.tenant_id, t.slug AS tenant,
              u.activo, u.last_login_at
         FROM identity.users u
         LEFT JOIN identity.tenants t ON t.id = u.tenant_id
        WHERE u.username = ANY($1) ORDER BY u.username`,
      [USUARIOS],
    );
    console.log('Usuarios encontrados:');
    for (const u of usuarios.rows) {
      console.log(
        `  · ${u.username.padEnd(24)} rol=${String(u.role_name).padEnd(24)} tenant=${u.tenant}` +
          `  ${u.last_login_at ? 'entró ' + u.last_login_at.toISOString().slice(0, 10) : 'nunca entró'}`,
      );
    }
    const faltantes = USUARIOS.filter((n) => !usuarios.rows.some((u) => u.username === n));
    if (faltantes.length) console.log(`  (ya no existen: ${faltantes.join(', ')})`);

    const ids = usuarios.rows.map((u) => u.id);
    const tenantIds = (
      await c.query('SELECT id, slug FROM identity.tenants WHERE slug = ANY($1)', [TENANTS])
    ).rows;
    console.log(`\nTenants a retirar: ${tenantIds.map((t) => t.slug).join(', ') || '(ninguno)'}`);

    // ── 1. Dependencias del usuario, en orden de FK ────────────────────────
    const del = async (etiqueta, sql, params) => {
      const r = await c.query(sql, params);
      console.log(`  ${String(r.rowCount).padStart(4)}  ${etiqueta}`);
      return r.rowCount;
    };

    console.log('\nBorrados:');
    if (ids.length) {
      await del('identity.user_scopes', 'DELETE FROM identity.user_scopes WHERE user_id = ANY($1)', [ids]);
      await del('identity.user_permissions', 'DELETE FROM identity.user_permissions WHERE user_id = ANY($1)', [ids]);
      await del('identity.user_roles', 'DELETE FROM identity.user_roles WHERE user_id = ANY($1)', [ids]);
      await del('identity.user_events', 'DELETE FROM identity.user_events WHERE user_id = ANY($1)', [ids]);
      // `created_by`/`updated_by` de OTRAS filas apuntando a estos ids: se anulan
      // en vez de bloquear. La FK es ON DELETE SET NULL, pero sus triggers están
      // apagados en prod, así que el SET NULL automático NO va a ocurrir: lo
      // hacemos a mano para no dejar referencias colgadas cuando se re-enciendan.
      await del('identity.users.created_by → NULL', 'UPDATE identity.users SET created_by = NULL WHERE created_by = ANY($1)', [ids]);
      await del('identity.users.updated_by → NULL', 'UPDATE identity.users SET updated_by = NULL WHERE updated_by = ANY($1)', [ids]);
      await del('identity.users.deleted_by → NULL', 'UPDATE identity.users SET deleted_by = NULL WHERE deleted_by = ANY($1)', [ids]);
      await del('identity.users.supervisor_id → NULL', 'UPDATE identity.users SET supervisor_id = NULL WHERE supervisor_id = ANY($1)', [ids]);
      await del('identity.users', 'DELETE FROM identity.users WHERE id = ANY($1)', [ids]);
    }

    // ── 2. Los roles de smoke y su alcance ─────────────────────────────────
    await del('identity.role_scopes (roles de smoke)', 'DELETE FROM identity.role_scopes WHERE role_name = ANY($1)', [ROLES]);
    await del('identity.role_permissions (roles de smoke)', 'DELETE FROM identity.role_permissions WHERE role_name = ANY($1)', [ROLES]);

    // ── 3. Los tenants de prueba ───────────────────────────────────────────
    // Se descubre el grafo de tablas con `tenant_id` y se barre en varias
    // pasadas: entre ellas también hay FKs. Igual que el cleanup del test, pero
    // acotado a los 2 tenants declarados arriba y contando lo que borra.
    if (tenantIds.length) {
      const tids = tenantIds.map((t) => t.id);
      const tablas = await c.query(`
        SELECT n.nspname || '.' || c.relname AS t
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0
         WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')`);
      let pendientes = tablas.rows.map((r) => r.t).filter((t) => t !== 'identity.tenants');
      let totalBorrado = 0;
      for (let pasada = 0; pasada < 6 && pendientes.length; pasada++) {
        const bloqueadas = [];
        for (const tbl of pendientes) {
          // SAVEPOINT por intento: en Postgres un DELETE que falla ABORTA la
          // transacción entera (25P02) y desde ahí toda sentencia siguiente
          // truena con "current transaction is aborted". Sin esto, el primer
          // fallo por FK hacía que las ~200 tablas restantes se reportaran como
          // "bloqueadas" y el resumen final nunca corriera. El cleanup del test
          // no lo necesita porque corre en autocommit; acá todo vive en UNA
          // transacción para que el dry-run pueda deshacerse.
          await c.query('SAVEPOINT sp_barrido');
          try {
            const r = await c.query(`DELETE FROM ${tbl} WHERE tenant_id = ANY($1)`, [tids]);
            await c.query('RELEASE SAVEPOINT sp_barrido');
            if (r.rowCount) {
              console.log(`  ${String(r.rowCount).padStart(4)}  ${tbl} (tenants de prueba)`);
              totalBorrado += r.rowCount;
            }
          } catch (e) {
            await c.query('ROLLBACK TO SAVEPOINT sp_barrido');
            bloqueadas.push(tbl); // la referencia otra tabla que aún no vaciamos
          }
        }
        if (bloqueadas.length === pendientes.length) break; // sin progreso
        pendientes = bloqueadas;
      }
      if (pendientes.length) console.log(`  ! no se pudo vaciar: ${pendientes.join(', ')}`);
      await del('identity.tenants', 'DELETE FROM identity.tenants WHERE id = ANY($1)', [tids]);
      console.log(`  (total de filas de los tenants de prueba: ${totalBorrado})`);
    }

    // ── 4. Estado resultante ───────────────────────────────────────────────
    const fin = await c.query(`
      SELECT (SELECT count(*)::int FROM identity.users WHERE activo AND deleted_at IS NULL) usuarios_activos,
             (SELECT count(*)::int FROM identity.tenants) tenants,
             (SELECT count(*)::int FROM identity.users u
               WHERE NOT EXISTS (SELECT 1 FROM identity.role_permissions rp
                                  WHERE rp.tenant_id = u.tenant_id AND rp.role_name = u.role_name)) violaciones_fk_rol`);
    const f = fin.rows[0];
    console.log(
      `\nEstado resultante: ${f.usuarios_activos} usuarios activos · ${f.tenants} tenant(s) · ` +
        `${f.violaciones_fk_rol} violación(es) de la FK de rol`,
    );
    if (f.violaciones_fk_rol > 0) {
      throw new Error(
        `Quedan ${f.violaciones_fk_rol} violaciones de fk_users_tenant_role. ` +
          'No se puede re-encender ENABLE TRIGGER con violaciones pendientes — abortando.',
      );
    }

    if (APLICAR) {
      await c.query('COMMIT');
      console.log('\nCOMMIT — aplicado.');
    } else {
      await c.query('ROLLBACK');
      console.log('\nROLLBACK — nada se escribió. Volvé a correr con --apply para ejecutar.');
    }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error(`\nABORTADO (ROLLBACK): ${e.message}`);
    await c.end();
    process.exit(1);
  }
  await c.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
