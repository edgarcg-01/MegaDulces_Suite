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
exports.StoresController = void 0;
var common_1 = require("@nestjs/common");
var require_auth_guard_1 = require("../../shared/guards/require-auth.guard");
var roles_guard_1 = require("../../shared/guards/roles.guard");
var permissions_decorator_1 = require("../../shared/decorators/permissions.decorator");
var permissions_1 = require("../../shared/constants/permissions");
var swagger_1 = require("@nestjs/swagger");
var StoresController = function () {
    var _classDecorators = [(0, swagger_1.ApiTags)('stores'), (0, swagger_1.ApiBearerAuth)(), (0, common_1.UseGuards)(require_auth_guard_1.RequireAuthGuard), (0, common_1.Controller)('stores')];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var _instanceExtraInitializers = [];
    var _findNearby_decorators;
    var _findAll_decorators;
    var _create_decorators;
    var _remove_decorators;
    var _update_decorators;
    var StoresController = _classThis = /** @class */ (function () {
        function StoresController_1(storesService) {
            this.storesService = (__runInitializers(this, _instanceExtraInitializers), storesService);
        }
        StoresController_1.prototype.findNearby = function (lat, lng, radius) {
            return this.storesService.findNearby(parseFloat(lat), parseFloat(lng), radius ? parseFloat(radius) : 50);
        };
        StoresController_1.prototype.findAll = function (zona_id, ruta_id) {
            return this.storesService.findAll(zona_id, ruta_id);
        };
        StoresController_1.prototype.create = function (body) {
            return this.storesService.create(body);
        };
        StoresController_1.prototype.remove = function (id) {
            return this.storesService.remove(id);
        };
        StoresController_1.prototype.update = function (id, body) {
            return this.storesService.update(id, body);
        };
        return StoresController_1;
    }());
    __setFunctionName(_classThis, "StoresController");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        _findNearby_decorators = [(0, common_1.Get)('nearby'), (0, swagger_1.ApiOperation)({ summary: 'Buscar tiendas cercanas por GPS' })];
        _findAll_decorators = [(0, common_1.Get)(), (0, swagger_1.ApiOperation)({
                summary: 'Lista completa de todos los PDV activos para el dispositivo móvil',
            })];
        _create_decorators = [(0, common_1.Post)(), (0, common_1.UseGuards)(roles_guard_1.RolesGuard), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.CATALOGO_GESTIONAR), (0, swagger_1.ApiOperation)({ summary: 'Crear nueva tienda o supermercado' })];
        _remove_decorators = [(0, common_1.Delete)(':id'), (0, common_1.UseGuards)(roles_guard_1.RolesGuard), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.CATALOGO_GESTIONAR), (0, swagger_1.ApiOperation)({ summary: 'Eliminar tienda o punto de venta' })];
        _update_decorators = [(0, common_1.Put)(':id'), (0, common_1.UseGuards)(roles_guard_1.RolesGuard), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.CATALOGO_GESTIONAR), (0, swagger_1.ApiOperation)({ summary: 'Actualizar metadata física del Local' })];
        __esDecorate(_classThis, null, _findNearby_decorators, { kind: "method", name: "findNearby", static: false, private: false, access: { has: function (obj) { return "findNearby" in obj; }, get: function (obj) { return obj.findNearby; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _findAll_decorators, { kind: "method", name: "findAll", static: false, private: false, access: { has: function (obj) { return "findAll" in obj; }, get: function (obj) { return obj.findAll; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _create_decorators, { kind: "method", name: "create", static: false, private: false, access: { has: function (obj) { return "create" in obj; }, get: function (obj) { return obj.create; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _remove_decorators, { kind: "method", name: "remove", static: false, private: false, access: { has: function (obj) { return "remove" in obj; }, get: function (obj) { return obj.remove; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _update_decorators, { kind: "method", name: "update", static: false, private: false, access: { has: function (obj) { return "update" in obj; }, get: function (obj) { return obj.update; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        StoresController = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return StoresController = _classThis;
}();
exports.StoresController = StoresController;
