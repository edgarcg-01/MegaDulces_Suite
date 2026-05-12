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
exports.VisitasSyncController = void 0;
var common_1 = require("@nestjs/common");
var VisitasSyncController = function () {
    var _classDecorators = [(0, common_1.Controller)('visitas')];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var _instanceExtraInitializers = [];
    var _sincronizarVisita_decorators;
    var _getEstadisticasSincronizacion_decorators;
    var _getVisitasConFraude_decorators;
    var _marcarVisitaRevisada_decorators;
    var VisitasSyncController = _classThis = /** @class */ (function () {
        function VisitasSyncController_1(visitasSyncService) {
            this.visitasSyncService = (__runInitializers(this, _instanceExtraInitializers), visitasSyncService);
        }
        /**
         * Endpoint principal para sincronización de visitas desde clientes offline
         */
        VisitasSyncController_1.prototype.sincronizarVisita = function (visitaDto) {
            return __awaiter(this, void 0, void 0, function () {
                var resultado, error_1;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            _a.trys.push([0, 2, , 3]);
                            return [4 /*yield*/, this.visitasSyncService.sincronizarVisita(visitaDto)];
                        case 1:
                            resultado = _a.sent();
                            return [2 /*return*/, {
                                    success: true,
                                    data: resultado,
                                    message: resultado.mensaje
                                }];
                        case 2:
                            error_1 = _a.sent();
                            console.error('[VisitasSyncController] Error en sincronización:', error_1);
                            return [2 /*return*/, {
                                    success: false,
                                    error: error_1.message,
                                    message: 'Error al sincronizar visita'
                                }];
                        case 3: return [2 /*return*/];
                    }
                });
            });
        };
        /**
         * Obtiene estadísticas de sincronización para dashboard administrativo
         */
        VisitasSyncController_1.prototype.getEstadisticasSincronizacion = function (fechaInicio, fechaFin, userId) {
            return __awaiter(this, void 0, void 0, function () {
                var estadisticas, error_2;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            _a.trys.push([0, 2, , 3]);
                            return [4 /*yield*/, this.visitasSyncService.getEstadisticasSincronizacion({
                                    fecha_inicio: fechaInicio,
                                    fecha_fin: fechaFin,
                                    user_id: userId
                                })];
                        case 1:
                            estadisticas = _a.sent();
                            return [2 /*return*/, {
                                    success: true,
                                    data: estadisticas
                                }];
                        case 2:
                            error_2 = _a.sent();
                            console.error('[VisitasSyncController] Error obteniendo estadísticas:', error_2);
                            return [2 /*return*/, {
                                    success: false,
                                    error: error_2.message
                                }];
                        case 3: return [2 /*return*/];
                    }
                });
            });
        };
        /**
         * Obtiene visitas con posible fraude para revisión de auditoría
         */
        VisitasSyncController_1.prototype.getVisitasConFraude = function (limit) {
            return __awaiter(this, void 0, void 0, function () {
                var limite, visitas, error_3;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            _a.trys.push([0, 2, , 3]);
                            limite = limit ? parseInt(limit) : 50;
                            return [4 /*yield*/, this.visitasSyncService.getVisitasConFraude(limite)];
                        case 1:
                            visitas = _a.sent();
                            return [2 /*return*/, {
                                    success: true,
                                    data: visitas,
                                    count: visitas.length
                                }];
                        case 2:
                            error_3 = _a.sent();
                            console.error('[VisitasSyncController] Error obteniendo visitas con fraude:', error_3);
                            return [2 /*return*/, {
                                    success: false,
                                    error: error_3.message
                                }];
                        case 3: return [2 /*return*/];
                    }
                });
            });
        };
        /**
         * Marca una visita como revisada (endpoint para auditoría)
         */
        VisitasSyncController_1.prototype.marcarVisitaRevisada = function (visitaId, body) {
            return __awaiter(this, void 0, void 0, function () {
                var error_4;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            _a.trys.push([0, 2, , 3]);
                            return [4 /*yield*/, this.visitasSyncService.marcarVisitaRevisada(visitaId, body.notas_auditor)];
                        case 1:
                            _a.sent();
                            return [2 /*return*/, {
                                    success: true,
                                    message: 'Visita marcada como revisada exitosamente'
                                }];
                        case 2:
                            error_4 = _a.sent();
                            console.error('[VisitasSyncController] Error marcando visita como revisada:', error_4);
                            return [2 /*return*/, {
                                    success: false,
                                    error: error_4.message
                                }];
                        case 3: return [2 /*return*/];
                    }
                });
            });
        };
        return VisitasSyncController_1;
    }());
    __setFunctionName(_classThis, "VisitasSyncController");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        _sincronizarVisita_decorators = [(0, common_1.Post)('sincronizar'), (0, common_1.HttpCode)(common_1.HttpStatus.OK)];
        _getEstadisticasSincronizacion_decorators = [(0, common_1.Get)('estadisticas-sincronizacion')];
        _getVisitasConFraude_decorators = [(0, common_1.Get)('con-fraude')];
        _marcarVisitaRevisada_decorators = [(0, common_1.Post)(':id/marcar-revisada'), (0, common_1.HttpCode)(common_1.HttpStatus.OK)];
        __esDecorate(_classThis, null, _sincronizarVisita_decorators, { kind: "method", name: "sincronizarVisita", static: false, private: false, access: { has: function (obj) { return "sincronizarVisita" in obj; }, get: function (obj) { return obj.sincronizarVisita; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _getEstadisticasSincronizacion_decorators, { kind: "method", name: "getEstadisticasSincronizacion", static: false, private: false, access: { has: function (obj) { return "getEstadisticasSincronizacion" in obj; }, get: function (obj) { return obj.getEstadisticasSincronizacion; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _getVisitasConFraude_decorators, { kind: "method", name: "getVisitasConFraude", static: false, private: false, access: { has: function (obj) { return "getVisitasConFraude" in obj; }, get: function (obj) { return obj.getVisitasConFraude; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _marcarVisitaRevisada_decorators, { kind: "method", name: "marcarVisitaRevisada", static: false, private: false, access: { has: function (obj) { return "marcarVisitaRevisada" in obj; }, get: function (obj) { return obj.marcarVisitaRevisada; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        VisitasSyncController = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return VisitasSyncController = _classThis;
}();
exports.VisitasSyncController = VisitasSyncController;
