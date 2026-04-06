const knex = require('knex');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const db = knex({
  client: 'pg',
  connection: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'trade_marketing',
  },
});

const P_SUPERADMIN = {
  USUARIOS_VER: true,
  USUARIOS_GESTIONAR: true,
  USUARIOS_PASSWORDS: true,
  USUARIOS_ASIGNAR_RUTA: true,
  REPORTES_VER_PROPIO: true,
  REPORTES_VER_EQUIPO: true,
  REPORTES_VER_GLOBAL: true,
  REPORTES_EXPORTAR: true,
  VISITAS_REGISTRAR: true,
  VISITAS_VER: true,
  VISITAS_AUDITAR: true,
  CATALOGO_GESTIONAR: true,
  PLANOGRAMAS_GESTIONAR: true,
  ROLES_CONFIGURAR: true,
  SCORING_CONFIG_VER: true,
  SCORING_CONFIG_GESTIONAR: true,
};

const P_SUPERVISOR = {
  USUARIOS_VER: true,
  USUARIOS_GESTIONAR: false,
  USUARIOS_PASSWORDS: false,
  USUARIOS_ASIGNAR_RUTA: true,
  REPORTES_VER_PROPIO: true,
  REPORTES_VER_EQUIPO: true,
  REPORTES_VER_GLOBAL: false,
  REPORTES_EXPORTAR: true,
  VISITAS_REGISTRAR: true,
  VISITAS_VER: true,
  VISITAS_AUDITAR: true,
  CATALOGO_GESTIONAR: false,
  PLANOGRAMAS_GESTIONAR: false,
  ROLES_CONFIGURAR: false,
  SCORING_CONFIG_VER: true,
  SCORING_CONFIG_GESTIONAR: false,
};

const P_COLABORADOR = {
  USUARIOS_VER: false,
  USUARIOS_GESTIONAR: false,
  USUARIOS_PASSWORDS: false,
  USUARIOS_ASIGNAR_RUTA: false,
  REPORTES_VER_PROPIO: true,
  REPORTES_VER_EQUIPO: false,
  REPORTES_VER_GLOBAL: false,
  REPORTES_EXPORTAR: false,
  VISITAS_REGISTRAR: true,
  VISITAS_VER: true,
  VISITAS_AUDITAR: false,
  CATALOGO_GESTIONAR: false,
  PLANOGRAMAS_GESTIONAR: false,
  ROLES_CONFIGURAR: false,
  SCORING_CONFIG_VER: true,
  SCORING_CONFIG_GESTIONAR: false,
};

const ROLES_TO_SYNC = [
  { name: 'superadmin', p: P_SUPERADMIN },
  { name: 'admin', p: P_SUPERADMIN },
  { name: 'supervisor', p: P_SUPERVISOR },
  { name: 'supervisor_v', p: P_SUPERVISOR },
  { name: 'Jefe_M', p: P_SUPERVISOR },
  { name: 'colaborador', p: P_COLABORADOR },
  { name: 'ejecutivo', p: P_COLABORADOR },
];

async function run() {
  console.log('--- Sincronización extendida de roles ---');
  try {
    for (const role of ROLES_TO_SYNC) {
      console.log(`Actualizando role_name: ${role.name}...`);
      const existing = await db('role_permissions').where({ role_name: role.name }).first();
      const pJson = JSON.stringify(role.p);

      if (existing) {
        await db('role_permissions').where({ role_name: role.name }).update({ permissions: pJson });
      } else {
        await db('role_permissions').insert({
          id: db.raw('gen_random_uuid()'),
          role_name: role.name,
          permissions: pJson,
        });
      }
    }
    console.log('✅ Todos los roles sincronizados.');
  } catch (error) {
    console.error('❌ Error en sincronización:', error);
  } finally {
    await db.destroy();
  }
}

run();
