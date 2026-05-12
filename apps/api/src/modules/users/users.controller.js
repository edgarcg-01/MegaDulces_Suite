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
exports.UsersController = void 0;
var common_1 = require("@nestjs/common");
var require_auth_guard_1 = require("../../shared/guards/require-auth.guard");
var roles_guard_1 = require("../../shared/guards/roles.guard");
var permissions_decorator_1 = require("../../shared/decorators/permissions.decorator");
var permissions_1 = require("../../shared/constants/permissions");
var swagger_1 = require("@nestjs/swagger");
var UsersController = function () {
    var _classDecorators = [(0, swagger_1.ApiTags)('users'), (0, swagger_1.ApiBearerAuth)(), (0, common_1.UseGuards)(require_auth_guard_1.RequireAuthGuard, roles_guard_1.RolesGuard), (0, common_1.Controller)('users')];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var _instanceExtraInitializers = [];
    var _create_decorators;
    var _findAll_decorators;
    var _getRoles_decorators;
    var _getSupervisors_decorators;
    var _getSellers_decorators;
    var _getTeamBySupervisor_decorators;
    var _getZones_decorators;
    var _findOne_decorators;
    var _update_decorators;
    var _remove_decorators;
    var UsersController = _classThis = /** @class */ (function () {
        function UsersController_1(usersService) {
            this.usersService = (__runInitializers(this, _instanceExtraInitializers), usersService);
        }
        UsersController_1.prototype.create = function (createUserDto) {
            return this.usersService.create(createUserDto);
        };
        UsersController_1.prototype.findAll = function (zona, activo) {
            return this.usersService.findAll(zona, activo);
        };
        UsersController_1.prototype.getRoles = function () {
            return this.usersService.getRoles();
        };
        UsersController_1.prototype.getSupervisors = function (zona) {
            console.log('[UsersController] GET /users/supervisors, zona:', zona);
            return this.usersService.findSupervisors(zona);
        };
        UsersController_1.prototype.getSellers = function (zona, supervisorId) {
            console.log('[UsersController] GET /users/sellers, zona:', zona, 'supervisor_id:', supervisorId);
            return this.usersService.findSellers(zona, supervisorId);
        };
        UsersController_1.prototype.getTeamBySupervisor = function (id) {
            console.log('[UsersController] GET /users/supervisor/:id/team, id:', id);
            return this.usersService.findBySupervisor(id);
        };
        UsersController_1.prototype.getZones = function () {
            console.log('[UsersController] GET /users/zones');
            return this.usersService.getZones();
        };
        UsersController_1.prototype.findOne = function (id) {
            return this.usersService.findOne(id);
        };
        UsersController_1.prototype.update = function (id, updateUserDto) {
            return this.usersService.update(id, updateUserDto);
        };
        UsersController_1.prototype.remove = function (id) {
            return this.usersService.remove(id);
        };
        return UsersController_1;
    }());
    __setFunctionName(_classThis, "UsersController");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        _create_decorators = [(0, common_1.Post)(), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.USUARIOS_GESTIONAR)];
        _findAll_decorators = [(0, common_1.Get)(), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.USUARIOS_VER), (0, swagger_1.ApiQuery)({ name: 'zona', required: false }), (0, swagger_1.ApiQuery)({ name: 'activo', required: false, enum: ['true', 'false'] })];
        _getRoles_decorators = [(0, common_1.Get)('roles')];
        _getSupervisors_decorators = [(0, common_1.Get)('supervisors'), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.USUARIOS_VER), (0, swagger_1.ApiQuery)({ name: 'zona', required: false })];
        _getSellers_decorators = [(0, common_1.Get)('sellers'), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.USUARIOS_VER), (0, swagger_1.ApiQuery)({ name: 'zona', required: false }), (0, swagger_1.ApiQuery)({ name: 'supervisor_id', required: false }), (0, swagger_1.ApiOperation)({ summary: 'Obtener vendedores/ejecutivos activos' })];
        _getTeamBySupervisor_decorators = [(0, common_1.Get)('supervisor/:id/team'), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.USUARIOS_VER)];
        _getZones_decorators = [(0, common_1.Get)('zones'), (0, swagger_1.ApiOperation)({ summary: 'Obtener zonas únicas de usuarios activos' })];
        _findOne_decorators = [(0, common_1.Get)(':id'), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.USUARIOS_VER)];
        _update_decorators = [(0, common_1.Put)(':id'), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.USUARIOS_GESTIONAR)];
        _remove_decorators = [(0, common_1.Delete)(':id'), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.USUARIOS_GESTIONAR)];
        __esDecorate(_classThis, null, _create_decorators, { kind: "method", name: "create", static: false, private: false, access: { has: function (obj) { return "create" in obj; }, get: function (obj) { return obj.create; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _findAll_decorators, { kind: "method", name: "findAll", static: false, private: false, access: { has: function (obj) { return "findAll" in obj; }, get: function (obj) { return obj.findAll; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _getRoles_decorators, { kind: "method", name: "getRoles", static: false, private: false, access: { has: function (obj) { return "getRoles" in obj; }, get: function (obj) { return obj.getRoles; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _getSupervisors_decorators, { kind: "method", name: "getSupervisors", static: false, private: false, access: { has: function (obj) { return "getSupervisors" in obj; }, get: function (obj) { return obj.getSupervisors; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _getSellers_decorators, { kind: "method", name: "getSellers", static: false, private: false, access: { has: function (obj) { return "getSellers" in obj; }, get: function (obj) { return obj.getSellers; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _getTeamBySupervisor_decorators, { kind: "method", name: "getTeamBySupervisor", static: false, private: false, access: { has: function (obj) { return "getTeamBySupervisor" in obj; }, get: function (obj) { return obj.getTeamBySupervisor; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _getZones_decorators, { kind: "method", name: "getZones", static: false, private: false, access: { has: function (obj) { return "getZones" in obj; }, get: function (obj) { return obj.getZones; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _findOne_decorators, { kind: "method", name: "findOne", static: false, private: false, access: { has: function (obj) { return "findOne" in obj; }, get: function (obj) { return obj.findOne; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _update_decorators, { kind: "method", name: "update", static: false, private: false, access: { has: function (obj) { return "update" in obj; }, get: function (obj) { return obj.update; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _remove_decorators, { kind: "method", name: "remove", static: false, private: false, access: { has: function (obj) { return "remove" in obj; }, get: function (obj) { return obj.remove; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        UsersController = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return UsersController = _classThis;
}();
exports.UsersController = UsersController;
