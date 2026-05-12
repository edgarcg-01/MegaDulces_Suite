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
exports.ScoringController = void 0;
var common_1 = require("@nestjs/common");
var require_auth_guard_1 = require("../../shared/guards/require-auth.guard");
var roles_guard_1 = require("../../shared/guards/roles.guard");
var permissions_decorator_1 = require("../../shared/decorators/permissions.decorator");
var permissions_1 = require("../../shared/constants/permissions");
var swagger_1 = require("@nestjs/swagger");
var ScoringController = function () {
    var _classDecorators = [(0, swagger_1.ApiTags)('scoring'), (0, swagger_1.ApiBearerAuth)(), (0, common_1.UseGuards)(require_auth_guard_1.RequireAuthGuard, roles_guard_1.RolesGuard), (0, common_1.Controller)('scoring')];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var _instanceExtraInitializers = [];
    var _getConfig_decorators;
    var _setConfig_decorators;
    var _calculate_decorators;
    var ScoringController = _classThis = /** @class */ (function () {
        function ScoringController_1(scoringService) {
            this.scoringService = (__runInitializers(this, _instanceExtraInitializers), scoringService);
        }
        ScoringController_1.prototype.getConfig = function () {
            return this.scoringService.getConfig();
        };
        ScoringController_1.prototype.setConfig = function (body) {
            return this.scoringService.setConfig(body);
        };
        ScoringController_1.prototype.calculate = function (query) {
            return this.scoringService.calculateScore(query);
        };
        return ScoringController_1;
    }());
    __setFunctionName(_classThis, "ScoringController");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        _getConfig_decorators = [(0, common_1.Get)('config'), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.SCORING_CONFIG_VER), (0, swagger_1.ApiOperation)({ summary: 'Obtener configuración del motor de JSONB' })];
        _setConfig_decorators = [(0, common_1.Put)('config'), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.SCORING_CONFIG_GESTIONAR), (0, swagger_1.ApiOperation)({ summary: 'Re-setear los pesos de la fórmula paramétrica' })];
        _calculate_decorators = [(0, common_1.Get)('calculate'), (0, swagger_1.ApiOperation)({
                summary: 'Calculadora dinámica de simulación de Exhibiciones. IMPORTANTE: Exige URL Foto',
            })];
        __esDecorate(_classThis, null, _getConfig_decorators, { kind: "method", name: "getConfig", static: false, private: false, access: { has: function (obj) { return "getConfig" in obj; }, get: function (obj) { return obj.getConfig; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _setConfig_decorators, { kind: "method", name: "setConfig", static: false, private: false, access: { has: function (obj) { return "setConfig" in obj; }, get: function (obj) { return obj.setConfig; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _calculate_decorators, { kind: "method", name: "calculate", static: false, private: false, access: { has: function (obj) { return "calculate" in obj; }, get: function (obj) { return obj.calculate; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        ScoringController = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return ScoringController = _classThis;
}();
exports.ScoringController = ScoringController;
