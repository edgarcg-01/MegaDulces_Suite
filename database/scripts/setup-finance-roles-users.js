/* eslint-disable no-console */
/**
 * Ops — Normaliza los roles de Finanzas creados el 2026-07-25 y da de alta a las
 * 7 personas del equipo. Idempotente y seguro:
 *   - Renombra `gestor de egresos` → `gestor_egresos` (snake_case).
 *   - Soft-delete del duplicado `auxiliar finanzas` (con espacio) — se conserva
 *     `auxiliar_finanzas`.
 *   - Crea los usuarios que falten (bcryptjs cost 10, igual que el app), ligados a
 *     su rol. Omite los que ya existan (no pisa contraseñas).
 *
 * NO hardcodea credenciales: lee la conexión de DATABASE_URL_NEW del entorno.
 * Dry-run por defecto; --apply confirma. Todos con contraseña temporal (cámbienla
 * al primer ingreso desde /admin o el perfil).
 *
 *   DATABASE_URL_NEW=... node database/scripts/setup-finance-roles-users.js          # dry-run
 *   DATABASE_URL_NEW=... node database/scripts/setup-finance-roles-users.js --apply  # commit
 */
const { Client } = require('pg');
const bcrypt = require('bcryptjs');

const M = '00000000-0000-0000-0000-00000000d01c';
const TEMP = process.env.TEMP_PASSWORD || '123456';
const URL = process.env.DATABASE_URL_NEW;
const APPLY = process.argv.includes('--apply');

const PEOPLE = [
  { nombre: 'Ivonne Cruz Oceguera',            username: 'ivonne_cruz',     role: 'control_depositos_pagos' },
  { nombre: 'María del Carmen Rodríguez Vera',  username: 'maria_rodriguez',  role: 'gestor_egresos' },
  { nombre: 'Julio César Torres Torres',        username: 'julio_torres',     role: 'auxiliar_finanzas' },
  { nombre: 'Perla del Rosario García Pérez',   username: 'perla_garcia',     role: 'analista_credito_cobranza' },
  { nombre: 'María de la Paz Gutiérrez Guzmán', username: 'maria_gutierrez',  role: 'gestor_tesoreria' },
  { nombre: 'Gloria Anzbeth Vera Sánchez',      username: 'gloria_vera',      role: 'credito_cobranza' },
  { nombre: 'Mayra Laura Gutiérrez Castillo',   username: 'mayra_gutierrez',  role: 'auxiliar_finanzas' },
];

(async () => {
  if (!URL) { console.error('Falta DATABASE_URL_NEW'); process.exit(1); }
  const db = new Client({ connectionString: URL, ssl: URL.includes('rlwy') ? { rejectUnauthorized: false } : false });
  await db.connect();
  await db.query(`SET app.tenant_id = '${M}'`);
  console.log(`\n=== Roles + usuarios de Finanzas (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
  try {
    await db.query('BEGIN');

    // 1) Normalizar roles
    const dst = (await db.query(`SELECT 1 FROM role_permissions WHERE role_name='gestor_egresos'`)).rowCount;
    if (!dst) {
      const r = await db.query(`UPDATE role_permissions SET role_name='gestor_egresos', updated_at=now() WHERE role_name='gestor de egresos'`);
      console.log(`rename 'gestor de egresos' → 'gestor_egresos': ${r.rowCount}`);
    } else { console.log(`'gestor_egresos' ya existe — no renombro`); }
    await db.query(`UPDATE users SET role_name='gestor_egresos' WHERE role_name='gestor de egresos'`);
    // `activo` es GENERATED (deleted_at IS NULL) → soft-delete solo toca deleted_at.
    const d = await db.query(`UPDATE role_permissions SET deleted_at=now() WHERE role_name='auxiliar finanzas' AND deleted_at IS NULL`);
    console.log(`soft-delete duplicado 'auxiliar finanzas': ${d.rowCount}`);

    // 2) Crear usuarios faltantes
    const hash = await bcrypt.hash(TEMP, 10);
    const out = [];
    for (const p of PEOPLE) {
      const exists = (await db.query('SELECT 1 FROM users WHERE username=$1', [p.username])).rowCount;
      if (exists) { out.push([p.username, p.role, 'YA EXISTE (omitido)']); continue; }
      const roleOk = (await db.query('SELECT 1 FROM role_permissions WHERE role_name=$1 AND activo=true', [p.role])).rowCount;
      if (!roleOk) { out.push([p.username, p.role, '⚠ ROL NO EXISTE (omitido)']); continue; }
      await db.query(
        'INSERT INTO users (tenant_id, username, password_hash, nombre, role_name, activo) VALUES ($1,$2,$3,$4,$5,true)',
        [M, p.username, hash, p.nombre, p.role],
      );
      out.push([p.username, p.role, 'CREADO']);
    }

    console.log('\nusuario            | rol                        | estado');
    for (const o of out) console.log('  ' + o[0].padEnd(16) + ' | ' + o[1].padEnd(26) + ' | ' + o[2]);
    console.log(`\nContraseña temporal (todos): ${TEMP}  → cámbienla al primer ingreso.`);

    if (!APPLY) { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — nada cambió. Corré con --apply para confirmar.'); return; }
    await db.query('COMMIT');
    console.log('\n[APPLY] COMMIT. Requiere re-login (permisos en el JWT).');
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally { await db.end(); }
})();
