"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Permission = void 0;
var Permission;
(function (Permission) {
    // Módulo: Usuarios
    Permission["USUARIOS_VER"] = "USUARIOS_VER";
    Permission["USUARIOS_GESTIONAR"] = "USUARIOS_GESTIONAR";
    Permission["USUARIOS_PASSWORDS"] = "USUARIOS_PASSWORDS";
    Permission["USUARIOS_ASIGNAR_RUTA"] = "USUARIOS_ASIGNAR_RUTA";
    // Módulo: Reportes y KPI
    Permission["REPORTES_VER_PROPIO"] = "REPORTES_VER_PROPIO";
    Permission["REPORTES_VER_EQUIPO"] = "REPORTES_VER_EQUIPO";
    Permission["REPORTES_VER_GLOBAL"] = "REPORTES_VER_GLOBAL";
    Permission["REPORTES_EXPORTAR"] = "REPORTES_EXPORTAR";
    Permission["REPORTES_GESTIONAR"] = "REPORTES_GESTIONAR";
    // Módulo: Operación en Campo (Auditoría)
    Permission["VISITAS_REGISTRAR"] = "VISITAS_REGISTRAR";
    Permission["VISITAS_VER"] = "VISITAS_VER";
    Permission["VISITAS_AUDITAR"] = "VISITAS_AUDITAR";
    // Módulo: Administración (Catálogos y Sistema)
    Permission["CATALOGO_GESTIONAR"] = "CATALOGO_GESTIONAR";
    Permission["PLANOGRAMAS_GESTIONAR"] = "PLANOGRAMAS_GESTIONAR";
    Permission["TIENDAS_VER"] = "TIENDAS_VER";
    Permission["ROLES_CONFIGURAR"] = "ROLES_CONFIGURAR";
    Permission["SCORING_CONFIG_VER"] = "SCORING_CONFIG_VER";
    Permission["SCORING_CONFIG_GESTIONAR"] = "SCORING_CONFIG_GESTIONAR";
    // Módulo: Seguimiento
    Permission["VER_SEGUIMIENTO"] = "VER_SEGUIMIENTO";
})(Permission || (exports.Permission = Permission = {}));
