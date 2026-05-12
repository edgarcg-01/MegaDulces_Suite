"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
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
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
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
exports.DailyCapturesService = void 0;
var common_1 = require("@nestjs/common");
var DailyCapturesService = function () {
    var _classDecorators = [(0, common_1.Injectable)()];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var DailyCapturesService = _classThis = /** @class */ (function () {
        function DailyCapturesService_1(knex, cloudinaryService, scoringV2Service) {
            this.knex = knex;
            this.cloudinaryService = cloudinaryService;
            this.scoringV2Service = scoringV2Service;
        }
        DailyCapturesService_1.prototype.create = function (dto, userId, username, zona) {
            return __awaiter(this, void 0, void 0, function () {
                var latitud, longitud, fotosSubidas, fotosFallidas, processedExhibiciones, activeVersion, configVersionId, puntosBackendTotales, scoringDto, backendScore, error_1, ventaAdicional, ventaTotalActual, ventaTotalFinal, statsWithPct, fecha, dailyCapture;
                var _this = this;
                var _a;
                return __generator(this, function (_b) {
                    switch (_b.label) {
                        case 0:
                            console.log('[DailyCapturesService] 📥 Recibiendo datos del frontend:');
                            console.log('  - folio:', dto.folio);
                            console.log('  - userId:', userId);
                            console.log('  - username:', username);
                            console.log('  - zona:', zona);
                            console.log('  - GPS recibido:', { latitud: dto.latitud, longitud: dto.longitud });
                            console.log('  - stats:', dto.stats);
                            console.log('  - exhibiciones count:', (_a = dto.exhibiciones) === null || _a === void 0 ? void 0 : _a.length);
                            latitud = Number(dto.latitud);
                            longitud = Number(dto.longitud);
                            if (!latitud || !longitud || latitud === 0 || longitud === 0) {
                                console.warn('[DailyCapturesService] ⚠️ GPS inválido o no proporcionado:', { latitud: latitud, longitud: longitud });
                            }
                            else {
                                console.log('[DailyCapturesService] ✅ GPS válido recibido:', { latitud: latitud, longitud: longitud });
                            }
                            // Procesar fotos Base64 subiéndolas a Cloudinary y guardando URL + Public ID
                            console.log('[DailyCapturesService] 📸 Procesando fotos de exhibiciones...');
                            fotosSubidas = 0;
                            fotosFallidas = 0;
                            return [4 /*yield*/, Promise.all(dto.exhibiciones.map(function (ex, index) { return __awaiter(_this, void 0, void 0, function () {
                                    var cloudinaryResult, error_2;
                                    return __generator(this, function (_a) {
                                        switch (_a.label) {
                                            case 0:
                                                if (!ex.fotoBase64) return [3 /*break*/, 5];
                                                console.log("[DailyCapturesService] \uD83D\uDCE4 Subiendo foto ".concat(index + 1, " a Cloudinary..."));
                                                _a.label = 1;
                                            case 1:
                                                _a.trys.push([1, 3, , 4]);
                                                return [4 /*yield*/, this.cloudinaryService.uploadImageBase64(ex.fotoBase64, "daily-captures/".concat(dto.folio))];
                                            case 2:
                                                cloudinaryResult = _a.sent();
                                                ex.fotoUrl = cloudinaryResult.secure_url;
                                                ex.fotoPublicId = cloudinaryResult.public_id;
                                                fotosSubidas++;
                                                console.log("[DailyCapturesService] \u2705 Foto ".concat(index + 1, " subida exitosamente:"), cloudinaryResult.secure_url);
                                                return [3 /*break*/, 4];
                                            case 3:
                                                error_2 = _a.sent();
                                                fotosFallidas++;
                                                console.error("[DailyCapturesService] \u274C Error subiendo foto ".concat(index + 1, " a Cloudinary:"), error_2.message || error_2);
                                                // En caso de error, dejar sin foto pero continuar el proceso
                                                ex.fotoUrl = null;
                                                ex.fotoPublicId = null;
                                                return [3 /*break*/, 4];
                                            case 4:
                                                // Remove heavy payload before persisting
                                                delete ex.fotoBase64;
                                                _a.label = 5;
                                            case 5: return [2 /*return*/, ex];
                                        }
                                    });
                                }); }))];
                        case 1:
                            processedExhibiciones = _b.sent();
                            console.log("[DailyCapturesService] \uD83D\uDCCA Resumen de fotos: ".concat(fotosSubidas, " subidas, ").concat(fotosFallidas, " fallidas"));
                            console.log('[DailyCapturesService] 💾 Insertando en daily_captures...');
                            console.log('  - stats a insertar:', dto.stats);
                            console.log('  - coordenadas a guardar:', { latitud: latitud, longitud: longitud });
                            return [4 /*yield*/, this.scoringV2Service.getActiveVersion()];
                        case 2:
                            activeVersion = _b.sent();
                            configVersionId = activeVersion === null || activeVersion === void 0 ? void 0 : activeVersion.id;
                            puntosBackendTotales = dto.stats.puntuacionTotal || 0;
                            if (!(configVersionId && processedExhibiciones.length > 0)) return [3 /*break*/, 6];
                            _b.label = 3;
                        case 3:
                            _b.trys.push([3, 5, , 6]);
                            scoringDto = {
                                config_version_id: configVersionId,
                                exhibiciones: processedExhibiciones.map(function (ex) { return ({
                                    posicion_id: ex.ubicacionId,
                                    exhibicion_id: ex.conceptoId,
                                    nivel_ejecucion_id: ex.nivelEjecucionId || ex.nivel_ejecucion_id, // Asegurar mapeo según Frontend
                                }); })
                            };
                            return [4 /*yield*/, this.scoringV2Service.calculateVisitScore(scoringDto)];
                        case 4:
                            backendScore = _b.sent();
                            puntosBackendTotales = backendScore.puntos_obtenidos;
                            console.log('[DailyCapturesService] 🧮 Puntos recalculados por Backend Engine:', puntosBackendTotales);
                            return [3 /*break*/, 6];
                        case 5:
                            error_1 = _b.sent();
                            console.warn('[DailyCapturesService] ⚠️ Fallo al recalcular scores, se usará valor del frontend. Error:', error_1.message);
                            return [3 /*break*/, 6];
                        case 6:
                            ventaAdicional = dto.stats.ventaAdicional || 0;
                            ventaTotalActual = dto.stats.ventaTotal || 0;
                            ventaTotalFinal = ventaTotalActual > 0 ? ventaTotalActual : ventaAdicional;
                            statsWithPct = __assign(__assign({}, dto.stats), { ventaTotal: ventaTotalFinal, puntuacionTotal: puntosBackendTotales });
                            console.log('[DailyCapturesService] 💾 Stats normalizados a insertar:', {
                                ventaTotalRecibido: ventaTotalActual,
                                ventaAdicional: ventaAdicional,
                                ventaTotalFinal: ventaTotalFinal,
                            });
                            fecha = dto.horaInicio
                                ? new Date(dto.horaInicio).toISOString().split('T')[0]
                                : new Date().toISOString().split('T')[0];
                            return [4 /*yield*/, this.knex('daily_captures')
                                    .insert({
                                    folio: dto.folio,
                                    user_id: userId,
                                    captured_by_username: username,
                                    zona_captura: zona || 'No Asignada',
                                    fecha: fecha,
                                    hora_inicio: dto.horaInicio,
                                    hora_fin: dto.horaFin,
                                    exhibiciones: JSON.stringify(processedExhibiciones),
                                    stats: JSON.stringify(statsWithPct),
                                    latitud: latitud || 0,
                                    longitud: longitud || 0,
                                    store_id: dto.store_id || null,
                                })
                                    .returning('*')];
                        case 7:
                            dailyCapture = (_b.sent())[0];
                            console.log('[DailyCapturesService] ✅ Insert exitoso. Datos guardados:');
                            console.log('  - id:', dailyCapture.id);
                            console.log('  - folio:', dailyCapture.folio);
                            console.log('  - GPS guardado:', { latitud: dailyCapture.latitud, longitud: dailyCapture.longitud });
                            console.log('  - fecha/hora:', { fecha: dailyCapture.fecha, hora_inicio: dailyCapture.hora_inicio });
                            console.log('  - stats:', dailyCapture.stats);
                            return [2 /*return*/, dailyCapture];
                    }
                });
            });
        };
        DailyCapturesService_1.prototype.findAll = function (fecha, zona, ejecutivo, userId) {
            return __awaiter(this, void 0, void 0, function () {
                var query;
                return __generator(this, function (_a) {
                    query = this.knex('daily_captures').select('*');
                    if (fecha) {
                        // Usar hora_inicio en lugar de fecha para evitar problemas de timezone
                        query.whereRaw("DATE(hora_inicio) = ?", [fecha]);
                    }
                    if (zona)
                        query.where({ zona_captura: zona });
                    if (ejecutivo)
                        query.where({ captured_by_username: ejecutivo });
                    if (userId)
                        query.where({ user_id: userId });
                    query.orderBy('created_at', 'desc');
                    return [2 /*return*/, query];
                });
            });
        };
        DailyCapturesService_1.prototype.findOne = function (id) {
            return __awaiter(this, void 0, void 0, function () {
                var dailyCapture, fallback;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.knex('daily_captures').where({ id: id }).first()];
                        case 1:
                            dailyCapture = _a.sent();
                            if (!!dailyCapture) return [3 /*break*/, 3];
                            return [4 /*yield*/, this.knex('daily_captures').where({ folio: id }).first()];
                        case 2:
                            fallback = _a.sent();
                            if (fallback)
                                return [2 /*return*/, fallback];
                            throw new common_1.NotFoundException("Validaci\u00F3n fallida: Captura con identificador ".concat(id, " no encontrada"));
                        case 3: return [2 /*return*/, dailyCapture];
                    }
                });
            });
        };
        DailyCapturesService_1.prototype.cleanup = function () {
            return __awaiter(this, void 0, void 0, function () {
                var count;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.knex('daily_captures').delete()];
                        case 1:
                            count = _a.sent();
                            return [2 /*return*/, { message: "Eliminados ".concat(count, " registros de visitas") }];
                    }
                });
            });
        };
        return DailyCapturesService_1;
    }());
    __setFunctionName(_classThis, "DailyCapturesService");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        DailyCapturesService = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return DailyCapturesService = _classThis;
}();
exports.DailyCapturesService = DailyCapturesService;
