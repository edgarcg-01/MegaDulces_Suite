"use strict";
var _a, _b;
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAbility = buildAbility;
var ability_1 = require("@casl/ability");
var permissions_1 = require("../constants/permissions");
var permissionToSubject = (_a = {},
    _a[permissions_1.Permission.USUARIOS_VER] = 'users',
    _a[permissions_1.Permission.USUARIOS_GESTIONAR] = 'users',
    _a[permissions_1.Permission.USUARIOS_PASSWORDS] = 'users_passwords',
    _a[permissions_1.Permission.USUARIOS_ASIGNAR_RUTA] = 'users_assign_route',
    _a[permissions_1.Permission.REPORTES_VER_PROPIO] = 'reports_own',
    _a[permissions_1.Permission.REPORTES_VER_EQUIPO] = 'reports_team',
    _a[permissions_1.Permission.REPORTES_VER_GLOBAL] = 'reports_global',
    _a[permissions_1.Permission.REPORTES_EXPORTAR] = 'reports_export',
    _a[permissions_1.Permission.REPORTES_GESTIONAR] = 'reports_manage',
    _a[permissions_1.Permission.VISITAS_REGISTRAR] = 'visits',
    _a[permissions_1.Permission.VISITAS_VER] = 'visits',
    _a[permissions_1.Permission.VISITAS_AUDITAR] = 'visits_audit',
    _a[permissions_1.Permission.CATALOGO_GESTIONAR] = 'catalogs',
    _a[permissions_1.Permission.TIENDAS_VER] = 'stores',
    _a[permissions_1.Permission.PLANOGRAMAS_GESTIONAR] = 'planograms',
    _a[permissions_1.Permission.ROLES_CONFIGURAR] = 'roles_config',
    _a[permissions_1.Permission.SCORING_CONFIG_VER] = 'scoring_config',
    _a[permissions_1.Permission.SCORING_CONFIG_GESTIONAR] = 'scoring_config',
    _a[permissions_1.Permission.VER_SEGUIMIENTO] = 'seguimiento',
    _a);
var permissionToAction = (_b = {},
    _b[permissions_1.Permission.USUARIOS_VER] = 'read',
    _b[permissions_1.Permission.USUARIOS_GESTIONAR] = ['read', 'create', 'update', 'delete'],
    _b[permissions_1.Permission.USUARIOS_PASSWORDS] = ['read', 'update'],
    _b[permissions_1.Permission.USUARIOS_ASIGNAR_RUTA] = ['read', 'update'],
    _b[permissions_1.Permission.REPORTES_VER_PROPIO] = 'read',
    _b[permissions_1.Permission.REPORTES_VER_EQUIPO] = 'read',
    _b[permissions_1.Permission.REPORTES_VER_GLOBAL] = 'read',
    _b[permissions_1.Permission.REPORTES_EXPORTAR] = 'read',
    _b[permissions_1.Permission.REPORTES_GESTIONAR] = ['read', 'delete'],
    _b[permissions_1.Permission.VISITAS_REGISTRAR] = 'create',
    _b[permissions_1.Permission.VISITAS_VER] = 'read',
    _b[permissions_1.Permission.VISITAS_AUDITAR] = ['read', 'update'],
    _b[permissions_1.Permission.CATALOGO_GESTIONAR] = ['read', 'create', 'update', 'delete'],
    _b[permissions_1.Permission.TIENDAS_VER] = 'read',
    _b[permissions_1.Permission.PLANOGRAMAS_GESTIONAR] = ['read', 'create', 'update', 'delete'],
    _b[permissions_1.Permission.ROLES_CONFIGURAR] = 'manage',
    _b[permissions_1.Permission.SCORING_CONFIG_VER] = 'read',
    _b[permissions_1.Permission.SCORING_CONFIG_GESTIONAR] = ['read', 'create', 'update', 'delete'],
    _b[permissions_1.Permission.VER_SEGUIMIENTO] = 'read',
    _b);
function buildAbility(permissions) {
    var _a = new ability_1.AbilityBuilder(ability_1.createMongoAbility), can = _a.can, build = _a.build;
    for (var _i = 0, _b = Object.entries(permissions); _i < _b.length; _i++) {
        var _c = _b[_i], permKey = _c[0], allowed = _c[1];
        if (!allowed)
            continue;
        var subject = permissionToSubject[permKey];
        var actions = permissionToAction[permKey];
        if (!subject || !actions)
            continue;
        can(actions, subject);
    }
    if (permissions[permissions_1.Permission.REPORTES_VER_EQUIPO] || permissions[permissions_1.Permission.REPORTES_VER_GLOBAL]) {
        can('manage', 'team_management');
        can('manage', 'kpi_goals');
    }
    if (permissions[permissions_1.Permission.REPORTES_VER_GLOBAL]) {
        can('manage', 'all');
    }
    return build();
}
