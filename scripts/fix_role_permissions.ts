import { Knex, knex } from 'knex';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(__dirname, '../.env') });

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

const ROLES = [
  {
    name: 'superadmin',
    permissions: {
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
    },
  },
  {
    name: 'admin',
    permissions: {
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
      ROLES_CONFIGURAR: false,
      SCORING_CONFIG_VER: true,
      SCORING_CONFIG_GESTIONAR: true,
    },
  },
  {
    name: 'supervisor',
    permissions: {
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
    },
  },
  {
    name: 'colaborador',
    permissions: {
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
    },
  },
];

async function run() {
  console.log('--- Iniciando corrección de permisos de roles ---');
  try {
    for (const role of ROLES) {
      console.log(`Configurando permisos para: ${role.name}...`);
      const existing = await db('role_permissions').where({ role_name: role.name }).first();
      
      if (existing) {
        await db('role_permissions')
          .where({ role_name: role.name })
          .update({ permissions: JSON.stringify(role.permissions) });
      } else {
        await db('role_permissions').insert({
          id: db.raw('gen_random_uuid()'),
          role_name: role.name,
          permissions: JSON.stringify(role.permissions),
        });
      }
    }
    console.log('✅ Permisos actualizados exitosamente.');
  } catch (error) {
    console.error('❌ Error al actualizar permisos:', error);
  } finally {
    await db.destroy();
  }
}

run();
