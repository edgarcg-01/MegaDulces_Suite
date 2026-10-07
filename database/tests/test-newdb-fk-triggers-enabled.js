/* eslint-disable no-console */
/**
 * `[IDG.4]` — Las FK están ENCENDIDAS, no sólo declaradas.
 *
 * El test que faltaba el 2026-08-29. Ese día un smoke afirmó «composite FK
 * cross-tenant rechazado», el INSERT pasó igual, el assert falló, nadie miró el
 * output, y el usuario `hacker` se quedó en el padrón de producción cinco días
 * hasta aparecer citado en el CHANGELOG como un dato legítimo.
 *
 * La causa no era la FK: era que **144 de los 195 triggers de `identity.users`
 * estaban deshabilitados** (`tgenabled='D'`), la única tabla de la DB en ese
 * estado. Muertas por completo las cuatro auto-referencias
 * (`created_by`/`updated_by`/`deleted_by`/`supervisor_id`) y el lado hijo de
 * `fk_users_tenant_role` y `users_tenant_id_foreign`.
 *
 * ⚠️ **`pg_constraint.convalidated` MIENTE.** Decía `true` para
 * `fk_users_tenant_role` mientras la FK no validaba nada. La constraint existe y
 * se cree validada; lo que no dispara son sus triggers internos. Por eso este
 * test NO consulta `convalidated`: mira `pg_trigger.tgenabled` y, sobre todo,
 * **prueba el comportamiento** con un INSERT inválido dentro de un ROLLBACK.
 * Un chequeo de metadata habría dado verde ese día.
 *
 * Es no destructivo: sólo lee catálogos y el INSERT de prueba muere en el
 * ROLLBACK. Se puede (y conviene) correr contra producción.
 *
 * Uso: node database/tests/test-newdb-fk-triggers-enabled.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const { Client } = require('pg');

// Rol `postgres`: para leer los catálogos del sistema y para ver TODAS las filas
// al contar violaciones (con RLS de por medio el conteo saldría corto y verde).
const URL = process.env.DATABASE_URL_NEW;

/** Schemas de negocio que nos importan. `kepler_ods` queda fuera: es staging del CDC. */
const SCHEMAS = ['identity', 'trade', 'commercial', 'catalog', 'finance', 'logistics', 'analytics'];

let pass = 0;
let fail = 0;
const t = (nombre, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${nombre}`);
  } else {
    fail++;
    console.error(`  ✗ ${nombre}${extra ? ` — ${extra}` : ''}`);
  }
};

(async () => {
  if (!URL) {
    console.error('Falta DATABASE_URL_NEW en .env');
    process.exit(2);
  }
  const c = new Client({
    connectionString: URL,
    ssl: /rlwy\.net|railway/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await c.connect();

  try {
    const donde = await c.query('SELECT current_database() db, current_user u');
    console.log(`\nDB: ${donde.rows[0].db} como ${donde.rows[0].u}`);

    // ── 1. Ningún trigger apagado en los schemas de negocio ─────────────────
    console.log('\n═══ 1: triggers habilitados ═══\n');
    const apagados = await c.query(
      `SELECT n.nspname AS schema, c.relname AS tabla,
              count(*) FILTER (WHERE t.tgenabled = 'D') AS apagados,
              count(*) AS total
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1)
        GROUP BY 1, 2
       HAVING count(*) FILTER (WHERE t.tgenabled = 'D') > 0
        ORDER BY 3 DESC`,
      [SCHEMAS],
    );
    t(
      'ninguna tabla de negocio tiene triggers deshabilitados',
      apagados.rowCount === 0,
      apagados.rows.map((r) => `${r.schema}.${r.tabla} ${r.apagados}/${r.total}`).join(' · '),
    );
    if (apagados.rowCount) {
      console.error(
        '    Un trigger apagado en una tabla con FK = integridad referencial APAGADA.\n' +
          '    Se arregla con: ALTER TABLE <tabla> ENABLE TRIGGER ALL;\n' +
          '    OJO: ENABLE no valida lo ya escrito — limpiar primero las filas que violan.',
      );
    }

    // ── 2. Cero violaciones de FK en identity.users ─────────────────────────
    console.log('\n═══ 2: integridad de identity.users ═══\n');
    const violaciones = await c.query(`
      SELECT 'role_name' AS col, count(*)::int AS n
        FROM identity.users u
       WHERE NOT EXISTS (SELECT 1 FROM identity.role_permissions rp
                          WHERE rp.tenant_id = u.tenant_id AND rp.role_name = u.role_name)
      UNION ALL SELECT 'created_by', count(*)::int FROM identity.users u
       WHERE u.created_by IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM identity.users x WHERE x.id = u.created_by)
      UNION ALL SELECT 'updated_by', count(*)::int FROM identity.users u
       WHERE u.updated_by IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM identity.users x WHERE x.id = u.updated_by)
      UNION ALL SELECT 'deleted_by', count(*)::int FROM identity.users u
       WHERE u.deleted_by IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM identity.users x WHERE x.id = u.deleted_by)
      UNION ALL SELECT 'supervisor_id', count(*)::int FROM identity.users u
       WHERE u.supervisor_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM identity.users x WHERE x.id = u.supervisor_id)
      UNION ALL SELECT 'tenant_id', count(*)::int FROM identity.users u
       WHERE NOT EXISTS (SELECT 1 FROM identity.tenants tt WHERE tt.id = u.tenant_id)`);
    for (const r of violaciones.rows) {
      t(`identity.users.${r.col} sin referencias colgadas`, r.n === 0, `${r.n} fila(s)`);
    }

    // ── 3. La prueba que de verdad importa: ¿la FK RECHAZA? ─────────────────
    // Comportamiento, no metadata. Es lo único que distingue "FK declarada" de
    // "FK que funciona", y es exactamente lo que falló sin que nadie lo notara.
    console.log('\n═══ 3: la FK de rol rechaza un rol inexistente ═══\n');
    const tenant = await c.query('SELECT id FROM identity.tenants LIMIT 1');
    if (!tenant.rowCount) {
      t('hay al menos un tenant para probar', false);
    } else {
      const tid = tenant.rows[0].id;
      const ROL_FANTASMA = 'zz_rol_inexistente_smoke';
      const existe = await c.query(
        'SELECT 1 FROM identity.role_permissions WHERE tenant_id = $1 AND role_name = $2',
        [tid, ROL_FANTASMA],
      );
      t('el rol de prueba no existe (premisa)', existe.rowCount === 0);

      await c.query('BEGIN');
      let rechazado = false;
      let detalle = '';
      try {
        await c.query(
          `INSERT INTO identity.users (tenant_id, username, password_hash, role_name)
           VALUES ($1, 'zz_probe_fk_smoke', 'no-es-un-hash', $2)`,
          [tid, ROL_FANTASMA],
        );
        detalle = 'el INSERT pasó: la FK no está enforzando';
      } catch (e) {
        rechazado = e.code === '23503'; // foreign_key_violation
        detalle = `${e.code} ${String(e.message).split('\n')[0]}`;
      }
      await c.query('ROLLBACK');
      t('un usuario con role_name inexistente es rechazado (23503)', rechazado, detalle);

      // Y que el ROLLBACK dejó todo como estaba.
      const resto = await c.query(
        'SELECT count(*)::int n FROM identity.users WHERE username = $1',
        ['zz_probe_fk_smoke'],
      );
      t('el ROLLBACK no dejó residuo', resto.rows[0].n === 0, `${resto.rows[0].n} fila(s)`);
    }

    console.log(`\n═══════════ Resultado: ${pass} pass / ${fail} fail ═══════════\n`);
    await c.end();
    process.exit(fail === 0 ? 0 : 1);
  } catch (err) {
    console.error('\n✗ Excepción inesperada:', err.message);
    await c.query('ROLLBACK').catch(() => {});
    await c.end().catch(() => {});
    process.exit(2);
  }
})();
