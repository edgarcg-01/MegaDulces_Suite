'use strict';
/**
 * Da de alta las cuentas del listado de gastos que no existían en el sistema,
 * con el rol de menor privilegio `captura_gastos` (solo FINANCE_EXPENSES_CAPTURAR).
 *
 * Por qué un script y no una migración: cada usuario nace con una contraseña
 * ALEATORIA Y DISTINTA, y esas contraseñas no pueden quedar en un archivo
 * versionado. El script las escribe en un CSV fuera del repo para entregarlas.
 * Contraseña distinta por persona a propósito — hay 10 usuarios en prod que hoy
 * comparten el mismo hash bcrypt (deuda UN.7) y no vamos a agrandar el problema.
 *
 * `department_code` queda NULL: no sé el área de cada uno y adivinarla sería
 * peor. Aparecen en el cajón "Sin departamento" de /admin/usuarios para que
 * Edgar los asigne (para eso se preparó esa pantalla).
 *
 * Uso:
 *   node database/scripts/create-expense-capture-users.js              # dry-run
 *   node database/scripts/create-expense-capture-users.js --apply
 *   DATABASE_URL_NEW=<prod> node database/scripts/create-expense-capture-users.js --apply
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const bcrypt = require('bcryptjs');

const DST = process.env.DATABASE_URL_NEW;
if (!DST) { console.error('Falta DATABASE_URL_NEW'); process.exit(1); }
const APPLY = process.argv.includes('--apply');
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : 'C:/Users/Sistemas/Downloads/CREDENCIALES-captura-gastos.csv';

// [username, nombre tal como vino del Excel]
//
// TERE RD queda FUERA: es `maria_rocha` (MARIA TERESA ROCHA FUENTES, rol
// colaborador) y el rol ya recibe el permiso, así que no hay nada que crear.
// JUAN TLMK CANINDO queda FUERA: hay 4 Juan en prod y no se puede desambiguar
// sin Edgar (jlh_lopez, juan_lopez, juan_elizarraras, jesus_carrillo).
//
// Los 12 del segundo lote se verificaron por NOMBRE DE PILA contra prod, no por
// apellido: los candidatos que había sugerido el matcher eran homónimos de
// apellido (Vázquez pero Ángel, Hernández pero Guillermo, Berber pero María
// Dolores…). Ninguno de los 12 existe.
const NUEVOS = [
  // primer lote
  ['andrea_cardenas', 'Andrea Cardenas'],
  ['jorge_rubio', 'Jorge Rubio'],
  ['julissa_alvarez', 'Julissa Alvarez'],
  ['leo_cazares', 'Leo Cazares'],
  ['lupita_macias', 'Lupita Macias'],
  ['omar_garnica', 'Omar Garnica'],
  ['pili_damaso', 'Pili Damaso'],
  ['rosy_madero', 'Rosy Madero'],
  ['viviana_kepler', 'Viviana (Kepler)'],
  ['yadira_abastos', 'Yadira (Morelia Abastos)'],
  // segundo lote: verificados inexistentes por nombre de pila
  ['alberto_moreno', 'Alberto Moreno'],
  ['edgar_luna', 'Edgar Luna'],
  ['felipe_galvan', 'Felipe Galvan'],
  ['isabel_vera', 'Isabel Vera'],
  ['joana_tafoya', 'Joana Tafoya'],
  ['lesly_berber', 'Lesly Berber'],
  ['lucia_garcia', 'Lucia Garcia'],
  ['luis_vazquez', 'Luis Vazquez'],
  ['patricia_bolanos', 'Patricia Bolaños'],
  ['patricia_hernandez', 'Patricia Hernandez'],
  ['tania_solorio', 'Tania Solorio'],
  ['tono_logistica', 'Toño (Logística)'],
];

const ROLE = 'captura_gastos';
// Sin caracteres ambiguos (0/O, 1/l/I) — se dictan por teléfono o WhatsApp.
const ALFA = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const pass = () => Array.from(crypto.randomBytes(12)).map((b) => ALFA[b % ALFA.length]).join('');

(async () => {
  const knex = require('knex')({
    client: 'pg',
    connection: DST.includes('localhost') || DST.includes('127.0.0.1')
      ? DST
      : { connectionString: DST, ssl: { rejectUnauthorized: false } },
    pool: { min: 0, max: 2 },
  });
  try {
    const tenant = await knex('identity.tenants').where({ slug: 'mega_dulces' }).select('id').first();
    if (!tenant) throw new Error('No existe el tenant mega_dulces');

    const rol = await knex('identity.role_permissions')
      .where({ tenant_id: tenant.id, role_name: ROLE })
      .select('role_name')
      .first();
    if (!rol) throw new Error(`Falta el rol ${ROLE}: corré antes la migración 20260821130000`);

    const existentes = new Set(
      (await knex('identity.users').where({ tenant_id: tenant.id }).select('username'))
        .map((u) => u.username),
    );

    const crear = NUEVOS.filter(([u]) => !existentes.has(u));
    const yaEstaban = NUEVOS.filter(([u]) => existentes.has(u)).map(([u]) => u);
    if (yaEstaban.length) console.log(`ya existían, se omiten: ${yaEstaban.join(', ')}`);

    if (!crear.length) { console.log('nada por crear.'); return; }

    console.log(`${APPLY ? 'CREANDO' : 'DRY-RUN'} ${crear.length} usuario(s) con rol ${ROLE}:`);
    const creds = [['username', 'nombre', 'password_temporal', 'rol']];
    for (const [username, nombre] of crear) {
      const plain = pass();
      console.log(`  ${username.padEnd(20)} ${nombre}`);
      if (APPLY) {
        await knex('identity.users').insert({
          tenant_id: tenant.id,
          username,
          nombre,
          password_hash: await bcrypt.hash(plain, 10),
          role_name: ROLE,
          activo: true,
        });
      }
      creds.push([username, nombre, plain, ROLE]);
    }

    if (APPLY) {
      const csv = creds.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
      fs.writeFileSync(OUT, '\ufeff' + csv, 'utf8');
      console.log(`\ncredenciales escritas en: ${OUT}`);
      console.log('Entregalas y borrá el archivo. Cada usuario tiene contraseña DISTINTA.');
      console.log('Falta asignarles departamento: aparecen en "Sin departamento" en /admin/usuarios.');
    } else {
      console.log('\n(dry-run: no se escribió nada. Volvé a correr con --apply)');
    }
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
