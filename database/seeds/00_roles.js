exports.seed = async function(knex) {
  // Limpiar usuarios que dependan de role_permissions primero
  await knex("users").del();
  // Limpiar rol_permissions antes de insertar
  await knex("role_permissions").del();
  
  await knex("role_permissions").insert([
    { 
      role_name: "superadmin", 
      permissions: {
        USUARIOS_VER: true,
        USUARIOS_GESTIONAR: true,
        USUARIOS_PASSWORDS: true,
        REPORTES_VER_PROPIO: true,
        REPORTES_VER_EQUIPO: true,
        REPORTES_VER_GLOBAL: true,
        REPORTES_EXPORTAR: true,
        VISITAS_REGISTRAR: true,
        VISITAS_AUDITAR: true,
        CATALOGO_GESTIONAR: true,
        PLANOGRAMAS_GESTIONAR: true,
        ROLES_CONFIGURAR: true
      } 
    },
    { 
      role_name: "supervisor_v", 
      permissions: {
        USUARIOS_VER: true,
        USUARIOS_GESTIONAR: false,
        USUARIOS_PASSWORDS: false,
        REPORTES_VER_PROPIO: true,
        REPORTES_VER_EQUIPO: true,
        REPORTES_VER_GLOBAL: false,
        REPORTES_EXPORTAR: true,
        VISITAS_REGISTRAR: true,
        VISITAS_AUDITAR: true,
        CATALOGO_GESTIONAR: true,
        PLANOGRAMAS_GESTIONAR: true,
        ROLES_CONFIGURAR: false
      } 
    },
    { 
      role_name: "colaborador", 
      permissions: {
        USUARIOS_VER: false,
        USUARIOS_GESTIONAR: false,
        USUARIOS_PASSWORDS: false,
        REPORTES_VER_PROPIO: true,
        REPORTES_VER_EQUIPO: false,
        REPORTES_VER_GLOBAL: false,
        REPORTES_EXPORTAR: false,
        VISITAS_REGISTRAR: true,
        VISITAS_AUDITAR: false,
        CATALOGO_GESTIONAR: false,
        PLANOGRAMAS_GESTIONAR: false,
        ROLES_CONFIGURAR: false
      } 
    },
  ]);
};