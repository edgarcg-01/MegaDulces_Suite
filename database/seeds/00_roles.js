/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function(knex) {
  // Deletes ALL existing entries
  await knex("role_permissions").del();

  // Inserts seed entries
  await knex("role_permissions").insert([
  {
    "id": "67515dde-792c-4a79-aa29-69589003b5df",
    "role_name": "superadmin",
    "permissions": {
      "VISITAS_VER": true,
      "USUARIOS_VER": true,
      "VISITAS_AUDITAR": true,
      "ROLES_CONFIGURAR": true,
      "REPORTES_EXPORTAR": true,
      "VISITAS_REGISTRAR": true,
      "CATALOGO_GESTIONAR": true,
      "SCORING_CONFIG_VER": true,
      "USUARIOS_GESTIONAR": true,
      "USUARIOS_PASSWORDS": true,
      "REPORTES_VER_EQUIPO": true,
      "REPORTES_VER_GLOBAL": true,
      "REPORTES_VER_PROPIO": true,
      "PLANOGRAMAS_GESTIONAR": true,
      "USUARIOS_ASIGNAR_RUTA": true,
      "SCORING_CONFIG_GESTIONAR": true
    }
  },
  {
    "id": "7d3a6972-0d01-476d-a6f7-1f11a6313188",
    "role_name": "admin",
    "permissions": {
      "VISITAS_VER": true,
      "USUARIOS_VER": true,
      "VISITAS_AUDITAR": true,
      "ROLES_CONFIGURAR": true,
      "REPORTES_EXPORTAR": true,
      "VISITAS_REGISTRAR": true,
      "CATALOGO_GESTIONAR": true,
      "SCORING_CONFIG_VER": true,
      "USUARIOS_GESTIONAR": true,
      "USUARIOS_PASSWORDS": true,
      "REPORTES_VER_EQUIPO": true,
      "REPORTES_VER_GLOBAL": true,
      "REPORTES_VER_PROPIO": true,
      "PLANOGRAMAS_GESTIONAR": true,
      "USUARIOS_ASIGNAR_RUTA": true,
      "SCORING_CONFIG_GESTIONAR": true
    }
  },
  {
    "id": "f39b3209-99c5-4afa-b611-92ae7edc3a82",
    "role_name": "supervisor",
    "permissions": {
      "VISITAS_VER": true,
      "USUARIOS_VER": true,
      "VISITAS_AUDITAR": true,
      "ROLES_CONFIGURAR": false,
      "REPORTES_EXPORTAR": true,
      "VISITAS_REGISTRAR": true,
      "CATALOGO_GESTIONAR": false,
      "SCORING_CONFIG_VER": true,
      "USUARIOS_GESTIONAR": false,
      "USUARIOS_PASSWORDS": false,
      "REPORTES_VER_EQUIPO": true,
      "REPORTES_VER_GLOBAL": false,
      "REPORTES_VER_PROPIO": true,
      "PLANOGRAMAS_GESTIONAR": false,
      "USUARIOS_ASIGNAR_RUTA": true,
      "SCORING_CONFIG_GESTIONAR": false
    }
  },
  {
    "id": "fe1928f8-2311-43c1-82c8-84a33e22af2d",
    "role_name": "supervisor_v",
    "permissions": {
      "VISITAS_VER": true,
      "USUARIOS_VER": true,
      "VISITAS_AUDITAR": true,
      "ROLES_CONFIGURAR": false,
      "REPORTES_EXPORTAR": true,
      "VISITAS_REGISTRAR": true,
      "CATALOGO_GESTIONAR": false,
      "SCORING_CONFIG_VER": true,
      "USUARIOS_GESTIONAR": false,
      "USUARIOS_PASSWORDS": false,
      "REPORTES_VER_EQUIPO": true,
      "REPORTES_VER_GLOBAL": false,
      "REPORTES_VER_PROPIO": true,
      "PLANOGRAMAS_GESTIONAR": false,
      "USUARIOS_ASIGNAR_RUTA": true,
      "SCORING_CONFIG_GESTIONAR": false
    }
  },
  {
    "id": "62836db5-759e-4e91-87ec-6be63e076fcb",
    "role_name": "Jefe_M",
    "permissions": {
      "VISITAS_VER": true,
      "USUARIOS_VER": true,
      "VISITAS_AUDITAR": true,
      "ROLES_CONFIGURAR": false,
      "REPORTES_EXPORTAR": true,
      "VISITAS_REGISTRAR": true,
      "CATALOGO_GESTIONAR": false,
      "SCORING_CONFIG_VER": true,
      "USUARIOS_GESTIONAR": false,
      "USUARIOS_PASSWORDS": false,
      "REPORTES_VER_EQUIPO": true,
      "REPORTES_VER_GLOBAL": false,
      "REPORTES_VER_PROPIO": true,
      "PLANOGRAMAS_GESTIONAR": false,
      "USUARIOS_ASIGNAR_RUTA": true,
      "SCORING_CONFIG_GESTIONAR": false
    }
  },
  {
    "id": "3ebb520b-0ed7-4f3e-8318-9bd154c67016",
    "role_name": "colaborador",
    "permissions": {
      "VISITAS_VER": true,
      "USUARIOS_VER": false,
      "VISITAS_AUDITAR": false,
      "ROLES_CONFIGURAR": false,
      "REPORTES_EXPORTAR": false,
      "VISITAS_REGISTRAR": true,
      "CATALOGO_GESTIONAR": false,
      "SCORING_CONFIG_VER": true,
      "USUARIOS_GESTIONAR": false,
      "USUARIOS_PASSWORDS": false,
      "REPORTES_VER_EQUIPO": false,
      "REPORTES_VER_GLOBAL": false,
      "REPORTES_VER_PROPIO": true,
      "PLANOGRAMAS_GESTIONAR": false,
      "USUARIOS_ASIGNAR_RUTA": false,
      "SCORING_CONFIG_GESTIONAR": false
    }
  },
  {
    "id": "4ba46777-93be-432f-8bff-8a7552cc4933",
    "role_name": "ejecutivo",
    "permissions": {
      "VISITAS_VER": true,
      "USUARIOS_VER": false,
      "VISITAS_AUDITAR": false,
      "ROLES_CONFIGURAR": false,
      "REPORTES_EXPORTAR": false,
      "VISITAS_REGISTRAR": true,
      "CATALOGO_GESTIONAR": false,
      "SCORING_CONFIG_VER": true,
      "USUARIOS_GESTIONAR": false,
      "USUARIOS_PASSWORDS": false,
      "REPORTES_VER_EQUIPO": false,
      "REPORTES_VER_GLOBAL": false,
      "REPORTES_VER_PROPIO": true,
      "PLANOGRAMAS_GESTIONAR": false,
      "USUARIOS_ASIGNAR_RUTA": false,
      "SCORING_CONFIG_GESTIONAR": false
    }
  }
]);
};
