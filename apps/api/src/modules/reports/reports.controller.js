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
exports.ReportsController = void 0;
var common_1 = require("@nestjs/common");
var require_auth_guard_1 = require("../../shared/guards/require-auth.guard");
var roles_guard_1 = require("../../shared/guards/roles.guard");
var permissions_decorator_1 = require("../../shared/decorators/permissions.decorator");
var permissions_1 = require("../../shared/constants/permissions");
var swagger_1 = require("@nestjs/swagger");
var ReportsController = function () {
    var _classDecorators = [(0, swagger_1.ApiTags)('reports'), (0, swagger_1.ApiBearerAuth)(), (0, common_1.UseGuards)(require_auth_guard_1.RequireAuthGuard, roles_guard_1.RolesGuard), (0, common_1.Controller)('reports')];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var _instanceExtraInitializers = [];
    var _getSummary_decorators;
    var _getDailyCompliance_decorators;
    var _getDailyScoresPerUser_decorators;
    var _getData_decorators;
    var _getStoresData_decorators;
    var _exportCsv_decorators;
    var _deleteReport_decorators;
    var ReportsController = _classThis = /** @class */ (function () {
        function ReportsController_1(reportsService) {
            this.reportsService = (__runInitializers(this, _instanceExtraInitializers), reportsService);
        }
        ReportsController_1.prototype.getSummary = function (user, startDate, endDate, zone, supervisorId, userIds) {
            return this.reportsService.getSummary({ startDate: startDate, endDate: endDate, zone: zone, supervisorId: supervisorId, userIds: userIds }, user);
        };
        ReportsController_1.prototype.getDailyCompliance = function (user, startDate, endDate, zone, supervisorId, userIds) {
            return this.reportsService.getDailyCompliance({ startDate: startDate, endDate: endDate, zone: zone, supervisorId: supervisorId, userIds: userIds }, user);
        };
        ReportsController_1.prototype.getDailyScoresPerUser = function (user, startDate, endDate, zone, supervisorId, userIds) {
            return __awaiter(this, void 0, void 0, function () {
                var result, error_1;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            _a.trys.push([0, 2, , 3]);
                            console.log('[ReportsController] Calling getDailyScoresPerUser');
                            return [4 /*yield*/, this.reportsService.getDailyScoresPerUser({ startDate: startDate, endDate: endDate, zone: zone, supervisorId: supervisorId, userIds: userIds }, user)];
                        case 1:
                            result = _a.sent();
                            return [2 /*return*/, result];
                        case 2:
                            error_1 = _a.sent();
                            console.error('[ReportsController] Error in getDailyScoresPerUser:', error_1);
                            throw error_1;
                        case 3: return [2 /*return*/];
                    }
                });
            });
        };
        ReportsController_1.prototype.getData = function (user, startDate, endDate, userId, userIds, zone, supervisorId) {
            console.log('[ReportsController] GET /reports/data', {
                startDate: startDate,
                endDate: endDate,
                userId: userId,
                userIds: userIds,
                zone: zone,
                supervisorId: supervisorId,
            });
            return this.reportsService.getFilteredData({ startDate: startDate, endDate: endDate, userId: userId, userIds: userIds, zone: zone, supervisorId: supervisorId }, user);
        };
        ReportsController_1.prototype.getStoresData = function (user, startDate, endDate, storeId, zone) {
            return this.reportsService.getStoresData({ startDate: startDate, endDate: endDate, storeId: storeId, zone: zone }, user);
        };
        ReportsController_1.prototype.exportCsv = function (user, res, startDate, endDate, userId, userIds, zone, supervisorId) {
            return __awaiter(this, void 0, void 0, function () {
                var csvBuffer;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.reportsService.exportCsvInBuffer({ startDate: startDate, endDate: endDate, userId: userId, userIds: userIds, zone: zone, supervisorId: supervisorId }, user)];
                        case 1:
                            csvBuffer = _a.sent();
                            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                            res.setHeader('Content-Disposition', 'attachment; filename="reporte_ejecutivos_trade.csv"');
                            // Disparar
                            res.send(csvBuffer);
                            return [2 /*return*/];
                    }
                });
            });
        };
        ReportsController_1.prototype.deleteReport = function (id, user) {
            return this.reportsService.deleteReport(id, user);
        };
        return ReportsController_1;
    }());
    __setFunctionName(_classThis, "ReportsController");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        _getSummary_decorators = [(0, common_1.Get)('summary'), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.REPORTES_VER_PROPIO), (0, swagger_1.ApiOperation)({
                summary: 'Genera un payload con el KPI global de toda la plataforma',
            })];
        _getDailyCompliance_decorators = [(0, common_1.Get)('daily-compliance'), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.REPORTES_VER_PROPIO), (0, swagger_1.ApiOperation)({
                summary: 'Obtiene métricas de cumplimiento diario filtradas por fecha',
            })];
        _getDailyScoresPerUser_decorators = [(0, common_1.Get)('daily-scores/per-user'), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.VER_SEGUIMIENTO), (0, swagger_1.ApiOperation)({
                summary: 'Obtiene puntuaciones diarias por usuario para el módulo de Seguimiento',
            })];
        _getData_decorators = [(0, common_1.Get)('data'), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.REPORTES_VER_PROPIO), (0, swagger_1.ApiOperation)({
                summary: 'Obtiene datos filtrados y agregados para el dashboard',
            })];
        _getStoresData_decorators = [(0, common_1.Get)('stores'), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.REPORTES_VER_PROPIO), (0, swagger_1.ApiOperation)({
                summary: 'Obtiene métricas por tienda para el tab de Tiendas',
            })];
        _exportCsv_decorators = [(0, common_1.Get)('export'), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.REPORTES_EXPORTAR), (0, swagger_1.ApiOperation)({
                summary: 'Descarga el histórico en un formato CSV ultra-ligero con filtros',
            })];
        _deleteReport_decorators = [(0, common_1.Delete)(':id'), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.REPORTES_GESTIONAR), (0, swagger_1.ApiOperation)({
                summary: 'Elimina un reporte (captura diaria) permanentemente',
            })];
        __esDecorate(_classThis, null, _getSummary_decorators, { kind: "method", name: "getSummary", static: false, private: false, access: { has: function (obj) { return "getSummary" in obj; }, get: function (obj) { return obj.getSummary; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _getDailyCompliance_decorators, { kind: "method", name: "getDailyCompliance", static: false, private: false, access: { has: function (obj) { return "getDailyCompliance" in obj; }, get: function (obj) { return obj.getDailyCompliance; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _getDailyScoresPerUser_decorators, { kind: "method", name: "getDailyScoresPerUser", static: false, private: false, access: { has: function (obj) { return "getDailyScoresPerUser" in obj; }, get: function (obj) { return obj.getDailyScoresPerUser; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _getData_decorators, { kind: "method", name: "getData", static: false, private: false, access: { has: function (obj) { return "getData" in obj; }, get: function (obj) { return obj.getData; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _getStoresData_decorators, { kind: "method", name: "getStoresData", static: false, private: false, access: { has: function (obj) { return "getStoresData" in obj; }, get: function (obj) { return obj.getStoresData; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _exportCsv_decorators, { kind: "method", name: "exportCsv", static: false, private: false, access: { has: function (obj) { return "exportCsv" in obj; }, get: function (obj) { return obj.exportCsv; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _deleteReport_decorators, { kind: "method", name: "deleteReport", static: false, private: false, access: { has: function (obj) { return "deleteReport" in obj; }, get: function (obj) { return obj.deleteReport; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        ReportsController = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return ReportsController = _classThis;
}();
exports.ReportsController = ReportsController;
