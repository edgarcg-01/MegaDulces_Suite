#!/usr/bin/env node
/**
 * `[ID.14]` — Arnés de aceptación del catálogo de roles.
 *
 * Normalizar el catálogo (renombrar, fusionar, retirar) es la operación que
 * puede quitarle acceso a alguien sin que nadie se entere: los permisos no se
 * ven en ninguna pantalla como "conjunto efectivo por persona". Así que antes y
 * después se saca la MISMA foto y se comparan.
 *
 * Lo que compara no son roles ni nombres, sino el **conjunto de permisos
 * efectivos de cada usuario** — que es lo único que le importa a la persona
 * sentada frente a la pantalla. Incluye la unión de `identity.user_roles`
 * (perfil base + complementos), igual que hace el guard.
 *
 *   node database/scripts/snapshot-user-permissions.js --out antes.json
 *   npx knex migrate:up ... --knexfile database/knexfile-newdb.js
 *   node database/scripts/snapshot-user-permissions.js --out despues.json
 *   node database/scripts/snapshot-user-permissions.js --compare antes.json despues.json
 *
 * El criterio de aceptación es **cero PIERDE**. Las ganancias se listan una por
 * una: una fusión sube a todos al máximo del grupo, y eso hay que poder leerlo,
 * no descubrirlo.
 *
 * Mismo espíritu que `snapshot-user-scope.js` (el arnés del alcance).
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const args = process.argv.slice(2);
const arg = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

/** Compara dos fotos y devuelve el código de salida. */
function comparar(fa, fb) {
  const a = JSON.parse(fs.readFileSync(fa, 'utf8'));
  const b = JSON.parse(fs.readFileSync(fb, 'utf8'));
  let pierden = 0, ganan = 0, iguales = 0;

  const usuarios = Array.from(new Set([...Object.keys(a.users), ...Object.keys(b.users)])).sort();
  console.log(`\nComparando ${path.basename(fa)} → ${path.basename(fb)} · ${usuarios.length} usuarios\n`);

  for (const u of usuarios) {
    const ua = a.users[u], ub = b.users[u];
    if (!ua) { console.log(`  + ${u} — usuario NUEVO (no estaba en la foto anterior)`); continue; }
    if (!ub) { console.log(`  ✗ ${u} — DESAPARECIÓ del padrón`); pierden++; continue; }

    const sa = new Set(ua.permisos), sb = new Set(ub.permisos);
    const perdidos = ua.permisos.filter((p) => !sb.has(p));
    const nuevos = ub.permisos.filter((p) => !sa.has(p));

    if (!perdidos.length && !nuevos.length) { iguales++; continue; }
    const rolTxt = ua.rol === ub.rol ? ua.rol : `${ua.rol} → ${ub.rol}`;
    if (perdidos.length) {
      pierden++;
      console.log(`  ✗ PIERDE  ${u} (${rolTxt}) [-${perdidos.length}]: ${perdidos.join(', ')}`);
    }
    if (nuevos.length) {
      ganan++;
      console.log(`  + GANA    ${u} (${rolTxt}) [+${nuevos.length}]: ${nuevos.join(', ')}`);
    }
  }

  console.log(`\n──────────────────────────────────────────────`);
  console.log(`  idénticos: ${iguales}`);
  console.log(`  ganan:     ${ganan}`);
  console.log(`  PIERDEN:   ${pierden}`);
  console.log(`──────────────────────────────────────────────`);
  if (pierden) {
    console.error('\n⛔ Hay usuarios que perdieron permisos. La normalización NO es aceptable así.');
    return 1;
  }
  console.log('\n✓ Cero pérdidas.');
  return 0;
}

(async () => {
  const cmp = args.indexOf('--compare');
  if (cmp >= 0) {
    process.exitCode = comparar(args[cmp + 1], args[cmp + 2]);
    return;
  }

  const DST = process.env.DATABASE_URL_NEW;
  if (!DST) { console.error('Falta DATABASE_URL_NEW'); process.exit(1); }
  const knex = require('knex')({
    client: 'pg',
    connection: /localhost|127\.0\.0\.1|192\.168/.test(DST)
      ? DST
      : { connectionString: DST, ssl: { rejectUnauthorized: false } },
    pool: { min: 0, max: 3 },
  });

  try {
    // Unión igual que `getPermissionsForUser`: perfil base + complementos.
    // El LEFT JOIN con user_roles y el fallback a users.role_name conviven a
    // propósito: si `[ID.13]` no corrió todavía, la foto sigue siendo válida.
    const filas = await knex.raw(`
      WITH roles_de AS (
        SELECT u.id, u.username, u.role_name AS perfil_base,
               COALESCE(
                 (SELECT array_agg(LOWER(ur.role_name))
                    FROM identity.user_roles ur
                   WHERE ur.tenant_id = u.tenant_id AND ur.user_id = u.id),
                 ARRAY[LOWER(u.role_name)]
               ) AS roles,
               u.tenant_id
          FROM identity.users u
         WHERE u.deleted_at IS NULL
      )
      SELECT r.username, r.perfil_base,
             COALESCE((
               SELECT array_agg(DISTINCT e.key ORDER BY e.key)
                 FROM identity.role_permissions rp, jsonb_each(rp.permissions) e
                WHERE rp.tenant_id = r.tenant_id
                  AND LOWER(rp.role_name) = ANY(r.roles)
                  AND e.value = 'true'
             ), ARRAY[]::text[]) AS permisos
        FROM roles_de r
       ORDER BY r.username`);

    const users = {};
    for (const f of filas.rows) {
      users[f.username] = { rol: f.perfil_base, permisos: f.permisos ?? [] };
    }
    const foto = { generado: new Date().toISOString(), total: Object.keys(users).length, users };

    const out = arg('--out');
    if (out) {
      fs.writeFileSync(out, JSON.stringify(foto, null, 2), 'utf8');
      console.log(`Foto de ${foto.total} usuarios → ${out}`);
    } else {
      console.log(JSON.stringify(foto, null, 2));
    }

    // Resumen legible: cuántos permisos tiene cada rol y cuánta gente.
    const porRol = new Map();
    for (const [, v] of Object.entries(users)) {
      const k = `${v.rol} (${v.permisos.length}p)`;
      porRol.set(k, (porRol.get(k) ?? 0) + 1);
    }
    console.log(`\nPor perfil base (${porRol.size} distintos):`);
    Array.from(porRol.entries())
      .sort((a, b) => b[1] - a[1])
      .forEach(([k, n]) => console.log(`  ${String(n).padStart(3)}  ${k}`));
  } finally {
    await knex.destroy();
  }
})();
