'use strict';
/**
 * Snapshot de PRIVILEGIOS EFECTIVOS por usuario — red de seguridad de la
 * normalización de usuarios/roles (Fase UN).
 *
 * El requisito de Edgar es "respetando sus privilegios actuales": este script
 * es el test de aceptación mecánico de eso. Se corre ANTES de normalizar
 * (`--write baseline`), y DESPUÉS (`--compare baseline`). Si el diff no es
 * vacío, la normalización cambió lo que alguien puede hacer → se revierte.
 *
 * "Privilegio efectivo" = el set de keys en true del JSONB del rol del usuario.
 * Es exactamente lo que viaja en el JWT y lo que lee la ability CASL, así que
 * comparar este set es comparar el acceso real, no una aproximación.
 *
 * Uso:
 *   node database/scripts/snapshot-user-privileges.js --write  .tmp-priv-before.json
 *   node database/scripts/snapshot-user-privileges.js --compare .tmp-priv-before.json
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const DST = process.env.DATABASE_URL_NEW;
if (!DST) {
  console.error('Falta DATABASE_URL_NEW en .env');
  process.exit(1);
}

const args = process.argv.slice(2);
const mode = args.includes('--compare') ? 'compare' : 'write';
const file = args[args.indexOf(mode === 'compare' ? '--compare' : '--write') + 1];
if (!file) {
  console.error('Falta la ruta del archivo de snapshot.');
  process.exit(1);
}

async function snapshot(knex) {
  // LEFT JOIN a propósito: un usuario cuyo rol no existe queda con privilegios
  // vacíos y hay que verlo, no perderlo silenciosamente en un INNER JOIN.
  const rows = await knex
    .select('u.id', 'u.username', 'u.tenant_id', 'u.role_name', 'rp.permissions')
    .from('identity.users as u')
    .leftJoin('identity.role_permissions as rp', function () {
      this.on('rp.tenant_id', '=', 'u.tenant_id').andOn('rp.role_name', '=', 'u.role_name');
    })
    .whereNull('u.deleted_at')
    .orderBy('u.tenant_id')
    .orderBy('u.username');

  const out = {};
  for (const r of rows) {
    const granted = Object.entries(r.permissions || {})
      .filter(([, v]) => v === true)
      .map(([k]) => k)
      .sort();
    // Clave = UUID, NO username: la identidad del usuario es su id, y un
    // rename legítimo (ej. bajar `Superuser` a minúsculas para revivir un login
    // muerto) no debe leerse como cambio de privilegios.
    out[`${r.tenant_id}::${r.id}`] = { username: r.username, role_name: r.role_name, permissions: granted };
  }
  return out;
}

(async () => {
  const knex = require('knex')({ client: 'pg', connection: DST, pool: { min: 0, max: 2 } });
  try {
    const now = await snapshot(knex);
    const users = Object.keys(now).length;

    if (mode === 'write') {
      fs.writeFileSync(file, JSON.stringify(now, null, 2));
      const total = Object.values(now).reduce((a, u) => a + u.permissions.length, 0);
      console.log(`baseline escrito: ${file}`);
      console.log(`  ${users} usuarios, ${total} grants efectivos`);
      return;
    }

    const before = JSON.parse(fs.readFileSync(file, 'utf8'));
    const keys = [...new Set([...Object.keys(before), ...Object.keys(now)])].sort();
    let bad = 0;

    for (const k of keys) {
      const b = before[k];
      const a = now[k];
      if (!b) { console.log(`+ USUARIO NUEVO           ${a.username} (rol ${a.role_name})`); bad++; continue; }
      if (!a) { console.log(`- USUARIO DESAPARECIDO    ${b.username} (era ${b.role_name})`); bad++; continue; }

      // Rename de username: se informa pero NO cuenta como drift de privilegios.
      if (b.username !== a.username) console.log(`~ RENAME  ${b.username} -> ${a.username} (privilegios sin cambio si no hay líneas ! abajo)`);

      const B = new Set(b.permissions);
      const A = new Set(a.permissions);
      const lost = b.permissions.filter((p) => !A.has(p));
      const gained = a.permissions.filter((p) => !B.has(p));
      if (!lost.length && !gained.length) continue;

      bad++;
      console.log(`! ${a.username}  rol ${b.role_name} -> ${a.role_name}`);
      if (lost.length) console.log(`    PIERDE (${lost.length}): ${lost.join(', ')}`);
      if (gained.length) console.log(`    GANA   (${gained.length}): ${gained.join(', ')}`);
    }

    if (bad === 0) {
      console.log(`OK — ${users} usuarios, privilegios efectivos IDÉNTICOS al baseline.`);
    } else {
      console.log(`\nFALLA — ${bad} usuario(s) con privilegios distintos al baseline.`);
      process.exitCode = 1;
    }
  } finally {
    await knex.destroy();
  }
})();
