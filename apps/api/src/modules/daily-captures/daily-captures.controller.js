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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __setFunctionName = (this && this.__setFunctionName) || function (f, name, prefix) {
    if (typeof name === "symbol") name = name.description ? "[".concat(name.description, "]") : "";
    return Object.defineProperty(f, "name", { configurable: true, value: prefix ? "".concat(prefix, " ", name) : name });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DailyCapturesController = void 0;
var common_1 = require("@nestjs/common");
var require_auth_guard_1 = require("../../shared/guards/require-auth.guard");
var roles_guard_1 = require("../../shared/guards/roles.guard");
var permissions_decorator_1 = require("../../shared/decorators/permissions.decorator");
var permissions_1 = require("../../shared/constants/permissions");
var swagger_1 = require("@nestjs/swagger");
var DailyCapturesController = function () {
    var _classDecorators = [(0, swagger_1.ApiTags)('daily-captures'), (0, swagger_1.ApiBearerAuth)(), (0, common_1.UseGuards)(require_auth_guard_1.RequireAuthGuard, roles_guard_1.RolesGuard), (0, common_1.Controller)('daily-captures')];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var _instanceExtraInitializers = [];
    var _create_decorators;
    var _findAll_decorators;
    var _findOne_decorators;
    var _cleanup_decorators;
    var DailyCapturesController = _classThis = /** @class */ (function () {
        function DailyCapturesController_1(dailyCapturesService) {
            this.dailyCapturesService = (__runInitializers(this, _instanceExtraInitializers), dailyCapturesService);
        }
        DailyCapturesController_1.prototype.create = function (createDailyCaptureDto, user) {
            return this.dailyCapturesService.create(createDailyCaptureDto, user.sub, user.username, user.zona);
        };
        DailyCapturesController_1.prototype.findAll = function (fecha, zona, ejecutivo, user) {
            var _a;
            // Protección de datos: un colaborador con permiso VISITAS_VER pero sin permisos globales
            // sólo debe ver sus propios registros si su rol es 'colaborador' o 'ejecutivo'
            var userIdFilter = ((_a = user === null || user === void 0 ? void 0 : user.permissions) === null || _a === void 0 ? void 0 : _a[permissions_1.Permission.REPORTES_VER_GLOBAL])
                ? undefined
                : user.sub;
            return this.dailyCapturesService.findAll(fecha, zona, ejecutivo, userIdFilter);
        };
        DailyCapturesController_1.prototype.findOne = function (id) {
            return this.dailyCapturesService.findOne(id);
        };
        DailyCapturesController_1.prototype.cleanup = function () {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    return [2 /*return*/, this.dailyCapturesService.cleanup()];
                });
            });
        };
        return DailyCapturesController_1;
    }());
    __setFunctionName(_classThis, "DailyCapturesController");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        _create_decorators = [(0, common_1.Post)(), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.VISITAS_REGISTRAR), (0, swagger_1.ApiOperation)({ summary: 'Registrar una auditoría completada en un PDV' })];
        _findAll_decorators = [(0, common_1.Get)(), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.VISITAS_VER), (0, swagger_1.ApiOperation)({ summary: 'Consultar Cierres de Auditoría/Visitas' }), (0, swagger_1.ApiQuery)({ name: 'fecha', required: false }), (0, swagger_1.ApiQuery)({ name: 'zona', required: false }), (0, swagger_1.ApiQuery)({ name: 'ejecutivo', required: false })];
        _findOne_decorators = [(0, common_1.Get)(':id'), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.VISITAS_VER), (0, swagger_1.ApiOperation)({ summary: 'Obtener visita por Folio o ID' })];
        _cleanup_decorators = [(0, common_1.Delete)('cleanup'), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.REPORTES_VER_GLOBAL), (0, swagger_1.ApiOperation)({ summary: 'Eliminar todos los registros de visitas (solo superadmin)' })];
        __esDecorate(_classThis, null, _create_decorators, { kind: "method", name: "create", static: false, private: false, access: { has: function (obj) { return "create" in obj; }, get: function (obj) { return obj.create; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _findAll_decorators, { kind: "method", name: "findAll", static: false, private: false, access: { has: function (obj) { return "findAll" in obj; }, get: function (obj) { return obj.findAll; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _findOne_decorators, { kind: "method", name: "findOne", static: false, private: false, access: { has: function (obj) { return "findOne" in obj; }, get: function (obj) { return obj.findOne; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _cleanup_decorators, { kind: "method", name: "cleanup", static: false, private: false, access: { has: function (obj) { return "cleanup" in obj; }, get: function (obj) { return obj.cleanup; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        DailyCapturesController = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return DailyCapturesController = _classThis;
}();
exports.DailyCapturesController = DailyCapturesController;
