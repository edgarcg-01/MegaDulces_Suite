"use strict";
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
exports.VisitasSyncService = void 0;
var common_1 = require("@nestjs/common");
var VisitasSyncService = function () {
    var _classDecorators = [(0, common_1.Injectable)()];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var VisitasSyncService = _classThis = /** @class */ (function () {
        function VisitasSyncService_1(knex) {
            this.knex = knex;
        }
        /**
         * Sincroniza una visita desde el cliente con idempotencia
         */
        VisitasSyncService_1.prototype.sincronizarVisita = function (visitaDto) {
            return __awaiter(this, void 0, void 0, function () {
                var visitaExistente, validacionGeo, tienda, usuario, folio, nuevaVisita, error_1;
                var _a;
                return __generator(this, function (_b) {
                    switch (_b.label) {
                        case 0:
                            _b.trys.push([0, 10, , 12]);
                            return [4 /*yield*/, this.knex('daily_captures')
                                    .where({ sync_uuid: visitaDto.id })
                                    .first()];
                        case 1:
                            visitaExistente = _b.sent();
                            if (!visitaExistente) return [3 /*break*/, 3];
                            console.log("[VisitasSync] Visita duplicada detectada: ".concat(visitaDto.id));
                            _a = {
                                id: visitaExistente.id,
                                folio: visitaExistente.folio,
                                estado: 'duplicada'
                            };
                            return [4 /*yield*/, this.validarGeolocalizacion(visitaDto)];
                        case 2: return [2 /*return*/, (_a.validacion_geolocalizacion = _b.sent(),
                                _a.mensaje = 'Visita ya registrada previamente',
                                _a)];
                        case 3: return [4 /*yield*/, this.validarGeolocalizacion(visitaDto)];
                        case 4:
                            validacionGeo = _b.sent();
                            return [4 /*yield*/, this.knex('tiendas')
                                    .where({ id: visitaDto.tienda_id })
                                    .first()];
                        case 5:
                            tienda = _b.sent();
                            if (!tienda) {
                                throw new common_1.BadRequestException('Tienda no encontrada');
                            }
                            return [4 /*yield*/, this.knex('users')
                                    .where({ id: visitaDto.user_id })
                                    .first()];
                        case 6:
                            usuario = _b.sent();
                            if (!usuario) {
                                throw new common_1.BadRequestException('Usuario no encontrado');
                            }
                            return [4 /*yield*/, this.generarFolioUnico(usuario.username)];
                        case 7:
                            folio = _b.sent();
                            return [4 /*yield*/, this.knex('daily_captures')
                                    .insert({
                                    folio: folio,
                                    user_id: visitaDto.user_id,
                                    tienda_id: visitaDto.tienda_id,
                                    fecha: visitaDto.fecha,
                                    hora_inicio: visitaDto.hora_inicio,
                                    hora_fin: visitaDto.hora_fin,
                                    latitud: visitaDto.latitud,
                                    longitud: visitaDto.longitud,
                                    precision_gps: visitaDto.precision_gps,
                                    exhibiciones: JSON.stringify(visitaDto.exhibiciones),
                                    stats: JSON.stringify(visitaDto.stats),
                                    sync_uuid: visitaDto.id, // UUID para idempotencia
                                    flag_fraude_frontend: visitaDto.flag_fraude || false,
                                    flag_fraude_backend: validacionGeo.flag_fraude_backend,
                                    distancia_tienda: validacionGeo.distancia_tienda,
                                    confianza_ubicacion: validacionGeo.confianza_ubicacion,
                                    intentos_sincronizacion: visitaDto.intentos_sincronizacion,
                                    fecha_creacion_dispositivo: visitaDto.fecha_creacion,
                                    fecha_sincronizacion: this.knex.fn.now(),
                                    created_at: this.knex.fn.now(),
                                    updated_at: this.knex.fn.now()
                                })
                                    .returning('*')];
                        case 8:
                            nuevaVisita = (_b.sent())[0];
                            // 7. Log de sincronización
                            return [4 /*yield*/, this.registrarLogSincronizacion({
                                    visita_id: nuevaVisita.id,
                                    sync_uuid: visitaDto.id,
                                    user_id: visitaDto.user_id,
                                    estado: 'exitoso',
                                    detalles: {
                                        intentos: visitaDto.intentos_sincronizacion,
                                        validacion_geo: validacionGeo,
                                        folio_generado: folio
                                    }
                                })];
                        case 9:
                            // 7. Log de sincronización
                            _b.sent();
                            console.log("[VisitasSync] Visita sincronizada exitosamente: ".concat(nuevaVisita.id, " (").concat(folio, ")"));
                            return [2 /*return*/, {
                                    id: nuevaVisita.id,
                                    folio: nuevaVisita.folio,
                                    estado: 'creada',
                                    validacion_geolocalizacion: validacionGeo,
                                    mensaje: 'Visita registrada exitosamente'
                                }];
                        case 10:
                            error_1 = _b.sent();
                            // Registrar log de error
                            return [4 /*yield*/, this.registrarLogSincronizacion({
                                    visita_id: null,
                                    sync_uuid: visitaDto.id,
                                    user_id: visitaDto.user_id,
                                    estado: 'error',
                                    detalles: {
                                        error: error_1.message,
                                        intentos: visitaDto.intentos_sincronizacion
                                    }
                                })];
                        case 11:
                            // Registrar log de error
                            _b.sent();
                            throw error_1;
                        case 12: return [2 /*return*/];
                    }
                });
            });
        };
        /**
         * Valida la geolocalización en el backend para prevenir fraudes
         */
        VisitasSyncService_1.prototype.validarGeolocalizacion = function (visitaDto) {
            return __awaiter(this, void 0, void 0, function () {
                var tienda, distancia, confianza, UMBRAL_DISTANCIA_METROS, flagFraude, error_2;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            _a.trys.push([0, 2, , 3]);
                            return [4 /*yield*/, this.knex('tiendas')
                                    .where({ id: visitaDto.tienda_id })
                                    .first()];
                        case 1:
                            tienda = _a.sent();
                            if (!tienda || !tienda.latitud || !tienda.longitud) {
                                return [2 /*return*/, {
                                        distancia_tienda: 0,
                                        coordenadas_tienda: { lat: 0, lng: 0 },
                                        flag_fraude_backend: true,
                                        confianza_ubicacion: 'baja'
                                    }];
                            }
                            distancia = this.calcularDistanciaHaversine({ lat: visitaDto.latitud, lng: visitaDto.longitud }, { lat: tienda.latitud, lng: tienda.longitud });
                            confianza = void 0;
                            if (visitaDto.precision_gps <= 10) {
                                confianza = 'alta';
                            }
                            else if (visitaDto.precision_gps <= 30) {
                                confianza = 'media';
                            }
                            else {
                                confianza = 'baja';
                            }
                            UMBRAL_DISTANCIA_METROS = 100;
                            flagFraude = distancia > UMBRAL_DISTANCIA_METROS || confianza === 'baja';
                            return [2 /*return*/, {
                                    distancia_tienda: Math.round(distancia),
                                    coordenadas_tienda: { lat: tienda.latitud, lng: tienda.longitud },
                                    flag_fraude_backend: flagFraude,
                                    confianza_ubicacion: confianza
                                }];
                        case 2:
                            error_2 = _a.sent();
                            console.error('[VisitasSync] Error validando geolocalización:', error_2);
                            return [2 /*return*/, {
                                    distancia_tienda: 0,
                                    coordenadas_tienda: { lat: 0, lng: 0 },
                                    flag_fraude_backend: true,
                                    confianza_ubicacion: 'baja'
                                }];
                        case 3: return [2 /*return*/];
                    }
                });
            });
        };
        /**
         * Calcula distancia entre dos puntos usando fórmula de Haversine
         */
        VisitasSyncService_1.prototype.calcularDistanciaHaversine = function (punto1, punto2) {
            var R = 6371e3; // Radio de la Tierra en metros
            var φ1 = this.toRadians(punto1.lat);
            var φ2 = this.toRadians(punto2.lat);
            var Δφ = this.toRadians(punto2.lat - punto1.lat);
            var Δλ = this.toRadians(punto2.lng - punto1.lng);
            var a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
                Math.cos(φ1) * Math.cos(φ2) *
                    Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
            var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            return R * c; // Distancia en metros
        };
        /**
         * Genera folio único basado en username y timestamp
         */
        VisitasSyncService_1.prototype.generarFolioUnico = function (username) {
            return __awaiter(this, void 0, void 0, function () {
                var timestamp, baseFolio, folio, contador;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            timestamp = new Date().toISOString().replace(/[-:T]/g, '').split('.')[0].substring(8, 14);
                            baseFolio = "".concat(username.charAt(0).toUpperCase(), "-").concat(timestamp);
                            folio = baseFolio;
                            contador = 1;
                            _a.label = 1;
                        case 1: return [4 /*yield*/, this.knex('daily_captures').where({ folio: folio }).first()];
                        case 2:
                            if (!_a.sent()) return [3 /*break*/, 3];
                            folio = "".concat(baseFolio, "-").concat(contador);
                            contador++;
                            return [3 /*break*/, 1];
                        case 3: return [2 /*return*/, folio];
                    }
                });
            });
        };
        /**
         * Registra log de sincronización para auditoría
         */
        VisitasSyncService_1.prototype.registrarLogSincronizacion = function (log) {
            return __awaiter(this, void 0, void 0, function () {
                var error_3;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            _a.trys.push([0, 2, , 3]);
                            return [4 /*yield*/, this.knex('sync_logs').insert({
                                    visita_id: log.visita_id,
                                    sync_uuid: log.sync_uuid,
                                    user_id: log.user_id,
                                    estado: log.estado,
                                    detalles: JSON.stringify(log.detalles),
                                    fecha: this.knex.fn.now()
                                })];
                        case 1:
                            _a.sent();
                            return [3 /*break*/, 3];
                        case 2:
                            error_3 = _a.sent();
                            console.error('[VisitasSync] Error registrando log de sincronización:', error_3);
                            return [3 /*break*/, 3];
                        case 3: return [2 /*return*/];
                    }
                });
            });
        };
        /**
         * Obtiene estadísticas de sincronización
         */
        VisitasSyncService_1.prototype.getEstadisticasSincronizacion = function (filtros) {
            return __awaiter(this, void 0, void 0, function () {
                var query, estadisticas, erroresQuery, erroresCount;
                var _a;
                return __generator(this, function (_b) {
                    switch (_b.label) {
                        case 0:
                            query = this.knex('daily_captures');
                            if (filtros) {
                                if (filtros.fecha_inicio) {
                                    query = query.where('fecha', '>=', filtros.fecha_inicio);
                                }
                                if (filtros.fecha_fin) {
                                    query = query.where('fecha', '<=', filtros.fecha_fin);
                                }
                                if (filtros.user_id) {
                                    query = query.where('user_id', filtros.user_id);
                                }
                            }
                            return [4 /*yield*/, query
                                    .select(this.knex.raw('COUNT(*) as total_visitas'), this.knex.raw('COUNT(CASE WHEN sync_uuid IS NOT NULL THEN 1 END) as visitas_sincronizadas'), this.knex.raw('COUNT(CASE WHEN flag_fraude_backend = true OR flag_fraude_frontend = true THEN 1 END) as visitas_con_fraude'), this.knex.raw('AVG(distancia_tienda) as distancia_promedio'), this.knex.raw('AVG(precision_gps) as precision_promedio'))
                                    .first()];
                        case 1:
                            estadisticas = _b.sent();
                            erroresQuery = this.knex('sync_logs').where({ estado: 'error' });
                            if (filtros === null || filtros === void 0 ? void 0 : filtros.fecha_inicio) {
                                erroresQuery.where('fecha', '>=', filtros.fecha_inicio);
                            }
                            if (filtros === null || filtros === void 0 ? void 0 : filtros.fecha_fin) {
                                erroresQuery.where('fecha', '<=', filtros.fecha_fin);
                            }
                            if (filtros === null || filtros === void 0 ? void 0 : filtros.user_id) {
                                erroresQuery.where('user_id', filtros.user_id);
                            }
                            return [4 /*yield*/, erroresQuery.count().first()];
                        case 2:
                            erroresCount = _b.sent();
                            return [2 /*return*/, {
                                    total_visitas: parseInt(estadisticas.total_visitas) || 0,
                                    visitas_sincronizadas: parseInt(estadisticas.visitas_sincronizadas) || 0,
                                    visitas_con_fraude: parseInt(estadisticas.visitas_con_fraude) || 0,
                                    distancia_promedio: Math.round(parseFloat(estadisticas.distancia_promedio) || 0),
                                    precision_promedio: Math.round(parseFloat(estadisticas.precision_promedio) || 0),
                                    errores_sincronizacion: parseInt(((_a = erroresCount === null || erroresCount === void 0 ? void 0 : erroresCount.count) !== null && _a !== void 0 ? _a : '0').toString()) || 0
                                }];
                    }
                });
            });
        };
        /**
         * Obtiene visitas con posible fraude para revisión
         */
        VisitasSyncService_1.prototype.getVisitasConFraude = function () {
            return __awaiter(this, arguments, void 0, function (limit) {
                if (limit === void 0) { limit = 50; }
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.knex('daily_captures')
                                .where('flag_fraude_backend', true)
                                .orWhere('flag_fraude_frontend', true)
                                .orderBy('created_at', 'desc')
                                .limit(limit)
                                .select('*')];
                        case 1: return [2 /*return*/, _a.sent()];
                    }
                });
            });
        };
        /**
         * Marca una visita como revisada (para auditoría)
         */
        VisitasSyncService_1.prototype.marcarVisitaRevisada = function (visitaId, notasAuditor) {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.knex('daily_captures')
                                .where({ id: visitaId })
                                .update({
                                flag_revisado_auditoria: true,
                                fecha_revision_auditoria: this.knex.fn.now(),
                                notas_auditoria: notasAuditor
                            })];
                        case 1:
                            _a.sent();
                            return [2 /*return*/];
                    }
                });
            });
        };
        /**
         * Utilidad para convertir grados a radianes
         */
        VisitasSyncService_1.prototype.toRadians = function (grados) {
            return grados * (Math.PI / 180);
        };
        return VisitasSyncService_1;
    }());
    __setFunctionName(_classThis, "VisitasSyncService");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        VisitasSyncService = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return VisitasSyncService = _classThis;
}();
exports.VisitasSyncService = VisitasSyncService;
