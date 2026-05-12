"use strict";
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
var __setFunctionName = (this && this.__setFunctionName) || function (f, name, prefix) {
    if (typeof name === "symbol") name = name.description ? "[".concat(name.description, "]") : "";
    return Object.defineProperty(f, "name", { configurable: true, value: prefix ? "".concat(prefix, " ", name) : name });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CatalogsController = void 0;
var common_1 = require("@nestjs/common");
var require_auth_guard_1 = require("../../shared/guards/require-auth.guard");
var roles_guard_1 = require("../../shared/guards/roles.guard");
var permissions_decorator_1 = require("../../shared/decorators/permissions.decorator");
var permissions_1 = require("../../shared/constants/permissions");
var swagger_1 = require("@nestjs/swagger");
var ability_1 = require("@casl/ability");
var CatalogsController = function () {
    var _classDecorators = [(0, swagger_1.ApiTags)('catalogs'), (0, swagger_1.ApiBearerAuth)(), (0, common_1.UseGuards)(require_auth_guard_1.RequireAuthGuard, roles_guard_1.RolesGuard), (0, common_1.Controller)('catalogs')];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var _instanceExtraInitializers = [];
    var _getRolePermissions_decorators;
    var _updateRolePermissions_decorators;
    var _getByType_decorators;
    var _create_decorators;
    var _deleteItem_decorators;
    var _updateItem_decorators;
    var CatalogsController = _classThis = /** @class */ (function () {
        function CatalogsController_1(catalogsService) {
            this.catalogsService = (__runInitializers(this, _instanceExtraInitializers), catalogsService);
        }
        CatalogsController_1.prototype.checkCatalogManageAccess = function (req, type) {
            var ability = (0, ability_1.createMongoAbility)(req.user.rules || []);
            if (ability.can('manage', 'all'))
                return;
            if (['conceptos', 'ubicaciones', 'niveles'].includes(type)) {
                if (!ability.can('manage', 'scoring_config')) {
                    throw new common_1.ForbiddenException('No tienes permisos suficientes para gestionar parámetros del scoring.');
                }
            }
            else {
                if (!ability.can('manage', 'catalogs')) {
                    throw new common_1.ForbiddenException('No tienes permisos para gestionar catálogos maestros.');
                }
            }
        };
        CatalogsController_1.prototype.getRolePermissions = function (roleName) {
            return this.catalogsService.getRolePermissions(roleName);
        };
        CatalogsController_1.prototype.updateRolePermissions = function (roleName, body) {
            return this.catalogsService.updateRolePermissions(roleName, body);
        };
        CatalogsController_1.prototype.getByType = function (type, parentId) {
            return this.catalogsService.getByType(type, parentId);
        };
        CatalogsController_1.prototype.create = function (type, body, req) {
            this.checkCatalogManageAccess(req, type);
            return this.catalogsService.create(type, body);
        };
        CatalogsController_1.prototype.deleteItem = function (type, id, req) {
            this.checkCatalogManageAccess(req, type);
            return this.catalogsService.delete(type, id);
        };
        CatalogsController_1.prototype.updateItem = function (type, id, body, req) {
            this.checkCatalogManageAccess(req, type);
            return this.catalogsService.update(type, id, body);
        };
        return CatalogsController_1;
    }());
    __setFunctionName(_classThis, "CatalogsController");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        _getRolePermissions_decorators = [(0, common_1.Get)('permissions/:role_name'), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.ROLES_CONFIGURAR), (0, swagger_1.ApiOperation)({
                summary: 'Obtener los permisos dinámicos (JSONB) de un rol específico',
            })];
        _updateRolePermissions_decorators = [(0, common_1.Put)('permissions/:role_name'), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.ROLES_CONFIGURAR), (0, swagger_1.ApiOperation)({
                summary: 'Actualizar los permisos dinámicos (JSONB) de un rol específico',
            })];
        _getByType_decorators = [(0, common_1.Get)(':type'), (0, swagger_1.ApiOperation)({
                summary: 'Obtener un catálogo estructurado (ej. zonas, periodos, semanas, roles)',
            }), (0, swagger_1.ApiParam)({ name: 'type', description: 'El catálogo que deseas consumir' }), (0, swagger_1.ApiQuery)({
                name: 'parent',
                required: false,
                description: 'Filtrar por ID del padre (ej. zona para obtener rutas)',
            })];
        _create_decorators = [(0, common_1.Post)(':type'), (0, swagger_1.ApiOperation)({
                summary: 'Añadir un ítem dinámico nuevo al tipo de catálogo definido',
            })];
        _deleteItem_decorators = [(0, common_1.Delete)(':type/:id'), (0, swagger_1.ApiOperation)({
                summary: 'Eliminar el nodo de un catálogo usando su ID primario UUID',
            })];
        _updateItem_decorators = [(0, common_1.Put)(':type/:id'), (0, swagger_1.ApiOperation)({ summary: 'Actualizar la información de un ítem de catálogo' })];
        __esDecorate(_classThis, null, _getRolePermissions_decorators, { kind: "method", name: "getRolePermissions", static: false, private: false, access: { has: function (obj) { return "getRolePermissions" in obj; }, get: function (obj) { return obj.getRolePermissions; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _updateRolePermissions_decorators, { kind: "method", name: "updateRolePermissions", static: false, private: false, access: { has: function (obj) { return "updateRolePermissions" in obj; }, get: function (obj) { return obj.updateRolePermissions; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _getByType_decorators, { kind: "method", name: "getByType", static: false, private: false, access: { has: function (obj) { return "getByType" in obj; }, get: function (obj) { return obj.getByType; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _create_decorators, { kind: "method", name: "create", static: false, private: false, access: { has: function (obj) { return "create" in obj; }, get: function (obj) { return obj.create; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _deleteItem_decorators, { kind: "method", name: "deleteItem", static: false, private: false, access: { has: function (obj) { return "deleteItem" in obj; }, get: function (obj) { return obj.deleteItem; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _updateItem_decorators, { kind: "method", name: "updateItem", static: false, private: false, access: { has: function (obj) { return "updateItem" in obj; }, get: function (obj) { return obj.updateItem; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        CatalogsController = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return CatalogsController = _classThis;
}();
exports.CatalogsController = CatalogsController;
