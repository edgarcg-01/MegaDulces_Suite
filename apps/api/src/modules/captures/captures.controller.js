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
exports.CapturesController = void 0;
var common_1 = require("@nestjs/common");
var require_auth_guard_1 = require("../../shared/guards/require-auth.guard");
var roles_guard_1 = require("../../shared/guards/roles.guard");
var permissions_decorator_1 = require("../../shared/decorators/permissions.decorator");
var permissions_1 = require("../../shared/constants/permissions");
var swagger_1 = require("@nestjs/swagger");
var CapturesController = function () {
    var _classDecorators = [(0, swagger_1.ApiTags)('captures'), (0, swagger_1.ApiBearerAuth)(), (0, common_1.UseGuards)(require_auth_guard_1.RequireAuthGuard), (0, common_1.Controller)('captures')];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var _instanceExtraInitializers = [];
    var _create_decorators;
    var _findAll_decorators;
    var _findOne_decorators;
    var _remove_decorators;
    var CapturesController = _classThis = /** @class */ (function () {
        function CapturesController_1(capturesService) {
            this.capturesService = (__runInitializers(this, _instanceExtraInitializers), capturesService);
        }
        CapturesController_1.prototype.create = function (createCaptureDto, user) {
            return this.capturesService.create(createCaptureDto, user.sub, user.username, user.zona);
        };
        CapturesController_1.prototype.findAll = function (zona, ejecutivo, fecha_inicio, fecha_fin) {
            return this.capturesService.findAll(zona, ejecutivo, fecha_inicio, fecha_fin);
        };
        CapturesController_1.prototype.findOne = function (id) {
            return this.capturesService.findOne(id);
        };
        CapturesController_1.prototype.remove = function (id) {
            return this.capturesService.remove(id);
        };
        return CapturesController_1;
    }());
    __setFunctionName(_classThis, "CapturesController");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        _create_decorators = [(0, common_1.Post)(), (0, common_1.UseGuards)(roles_guard_1.RolesGuard), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.VISITAS_REGISTRAR), (0, swagger_1.ApiOperation)({
                summary: 'Crear nueva captura',
            })];
        _findAll_decorators = [(0, common_1.Get)(), (0, common_1.UseGuards)(roles_guard_1.RolesGuard), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.VISITAS_VER), (0, swagger_1.ApiOperation)({
                summary: 'Consultar capturas',
            }), (0, swagger_1.ApiQuery)({ name: 'zona', required: false }), (0, swagger_1.ApiQuery)({ name: 'ejecutivo', required: false }), (0, swagger_1.ApiQuery)({ name: 'fecha_inicio', required: false }), (0, swagger_1.ApiQuery)({ name: 'fecha_fin', required: false })];
        _findOne_decorators = [(0, common_1.Get)(':id'), (0, swagger_1.ApiOperation)({ summary: 'Obtener captura por ID' })];
        _remove_decorators = [(0, common_1.Delete)(':id'), (0, common_1.UseGuards)(roles_guard_1.RolesGuard), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.REPORTES_GESTIONAR), (0, swagger_1.ApiOperation)({
                summary: 'Eliminar una captura por ID',
            })];
        __esDecorate(_classThis, null, _create_decorators, { kind: "method", name: "create", static: false, private: false, access: { has: function (obj) { return "create" in obj; }, get: function (obj) { return obj.create; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _findAll_decorators, { kind: "method", name: "findAll", static: false, private: false, access: { has: function (obj) { return "findAll" in obj; }, get: function (obj) { return obj.findAll; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _findOne_decorators, { kind: "method", name: "findOne", static: false, private: false, access: { has: function (obj) { return "findOne" in obj; }, get: function (obj) { return obj.findOne; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _remove_decorators, { kind: "method", name: "remove", static: false, private: false, access: { has: function (obj) { return "remove" in obj; }, get: function (obj) { return obj.remove; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        CapturesController = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return CapturesController = _classThis;
}();
exports.CapturesController = CapturesController;
