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
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScoringV2Service = void 0;
var common_1 = require("@nestjs/common");
var ScoringV2Service = function () {
    var _classDecorators = [(0, common_1.Injectable)()];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var ScoringV2Service = _classThis = /** @class */ (function () {
        function ScoringV2Service_1(knex) {
            this.knex = knex;
        }
        /**
         * Obtiene la versión de configuración vigente
         */
        ScoringV2Service_1.prototype.getActiveVersion = function () {
            return __awaiter(this, void 0, void 0, function () {
                var version;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.knex('scoring_config_versions')
                                .whereNull('fecha_fin')
                                .orderBy('fecha_inicio', 'desc')
                                .first()];
                        case 1:
                            version = _a.sent();
                            return [2 /*return*/, version];
                    }
                });
            });
        };
        /**
         * Recalcula el score_maximo para una versión específica
         * Se debe llamar cuando cambian los valores del catálogo
         */
        ScoringV2Service_1.prototype.recalcularScoreMaximo = function (configVersionId) {
            return __awaiter(this, void 0, void 0, function () {
                var pesos, posicionValues, exhibicionValues, ejecucionValues, maxPosicion, maxExhibicion, maxEjecucion, scoreMaximo;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.knex('scoring_pesos')
                                .where({ config_version_id: configVersionId })
                                .select('*')];
                        case 1:
                            pesos = _a.sent();
                            posicionValues = pesos
                                .filter(function (p) { return p.tipo === 'posicion'; })
                                .map(function (p) { return Number(p.valor); });
                            exhibicionValues = pesos
                                .filter(function (p) { return p.tipo === 'exhibicion'; })
                                .map(function (p) { return Number(p.valor); });
                            ejecucionValues = pesos
                                .filter(function (p) { return p.tipo === 'ejecucion'; })
                                .map(function (p) { return Number(p.valor); });
                            maxPosicion = posicionValues.length > 0 ? Math.max.apply(Math, posicionValues) : 0;
                            maxExhibicion = exhibicionValues.length > 0 ? Math.max.apply(Math, exhibicionValues) : 0;
                            maxEjecucion = ejecucionValues.length > 0 ? Math.max.apply(Math, ejecucionValues) : 0;
                            scoreMaximo = maxPosicion * maxExhibicion * maxEjecucion;
                            // Actualizar la versión con el nuevo score_maximo
                            return [4 /*yield*/, this.knex('scoring_config_versions')
                                    .where({ id: configVersionId })
                                    .orWhere({ version: configVersionId })
                                    .update({
                                    score_maximo: scoreMaximo,
                                    score_maximo_calculado_at: this.knex.fn.now()
                                })];
                        case 2:
                            // Actualizar la versión con el nuevo score_maximo
                            _a.sent();
                            return [2 /*return*/, scoreMaximo];
                    }
                });
            });
        };
        /**
         * Obtiene los pesos de una versión de configuración
         */
        ScoringV2Service_1.prototype.getPesosByVersion = function (configVersionId) {
            return __awaiter(this, void 0, void 0, function () {
                var pesos, result;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.knex('scoring_pesos')
                                .where({ config_version_id: configVersionId })
                                .select('*')];
                        case 1:
                            pesos = _a.sent();
                            result = {
                                posicion: {},
                                exhibicion: {},
                                ejecucion: {}
                            };
                            pesos.forEach(function (p) {
                                result[p.tipo][p.nombre] = Number(p.valor);
                            });
                            return [2 /*return*/, result];
                    }
                });
            });
        };
        /**
         * CAPA 1: Calcula el score de una exhibición individual de forma síncrona
         * Puntos = puntuacion_base * factor_posicion * factor_nivel * factor_evidencia
         */
        ScoringV2Service_1.prototype.calcularScoreExhibicionSync = function (dto, pesos, catalogMap) {
            var nombrePosicion = catalogMap.get(dto.posicion_id);
            var nombreExhibicion = catalogMap.get(dto.exhibicion_id);
            var nombreNivel = catalogMap.get(dto.nivel_ejecucion_id);
            if (!nombrePosicion || !nombreExhibicion || !nombreNivel) {
                throw new common_1.BadRequestException("Uno o m\u00E1s elementos del cat\u00E1logo no existen: pos=".concat(dto.posicion_id, ", exh=").concat(dto.exhibicion_id, ", niv=").concat(dto.nivel_ejecucion_id));
            }
            // Obtener parámetros desde la configuración versionada
            var pesoPosicionRaw = pesos.posicion[nombrePosicion];
            var factorPosicion = pesoPosicionRaw ? Number(pesoPosicionRaw) : 0;
            var nivelRaw = pesos.ejecucion[nombreNivel];
            var factorNivel = nivelRaw ? Math.min(Number(nivelRaw), 1) : 1;
            if (nivelRaw > 1) {
                console.warn("[ScoringV2] Factor nivel \"".concat(nombreNivel, "\" > 1: ").concat(nivelRaw, ". Revisar scoring_pesos."));
            }
            var puntuacionBase = pesos.exhibicion[nombreExhibicion] ? Number(pesos.exhibicion[nombreExhibicion]) : 0;
            // Calcular puntos: "concepto" * "ubicacion" * "nivel_de_ejecucion"
            var puntos = puntuacionBase * factorPosicion * factorNivel;
            return {
                puntos: Number(puntos.toFixed(2)),
                puntuacionBase: puntuacionBase,
                factorPosicion: factorPosicion,
                factorNivel: factorNivel
            };
        };
        /**
         * Obtiene el score máximo posible por exhibición
         * Usa el valor guardado en scoring_config_versions
         */
        ScoringV2Service_1.prototype.getMaxScorePerExhibicion = function (configVersionId) {
            return __awaiter(this, void 0, void 0, function () {
                var version;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.knex('scoring_config_versions')
                                .where({ id: configVersionId })
                                .orWhere({ version: configVersionId })
                                .first()];
                        case 1:
                            version = _a.sent();
                            if (version && version.score_maximo) {
                                return [2 /*return*/, Number(version.score_maximo)];
                            }
                            return [4 /*yield*/, this.recalcularScoreMaximo(configVersionId)];
                        case 2: 
                        // Si no existe score_maximo, recalcularlo
                        return [2 /*return*/, _a.sent()];
                    }
                });
            });
        };
        /**
         * CAPA 2: Calcula los PUNTOS totales acumulados de una visita.
         * La visita ya no devuelve porcentaje. Solo devuelve la suma de capas 1.
         */
        ScoringV2Service_1.prototype.calculateVisitScore = function (dto) {
            return __awaiter(this, void 0, void 0, function () {
                var pesos, allCatalogIds, catalogRows, catalogMap, exhibicionesScores, puntosTotales;
                var _this = this;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.getPesosByVersion(dto.config_version_id)];
                        case 1:
                            pesos = _a.sent();
                            allCatalogIds = __spreadArray(__spreadArray(__spreadArray([], dto.exhibiciones.map(function (e) { return e.posicion_id; }), true), dto.exhibiciones.map(function (e) { return e.exhibicion_id; }), true), dto.exhibiciones.map(function (e) { return e.nivel_ejecucion_id; }), true);
                            return [4 /*yield*/, this.knex('catalogs')
                                    .whereIn('id', __spreadArray([], new Set(allCatalogIds), true))
                                    .select('id', 'value')];
                        case 2:
                            catalogRows = _a.sent();
                            catalogMap = new Map(catalogRows.map(function (r) { return [r.id, r.value]; }));
                            exhibicionesScores = dto.exhibiciones.map(function (ex) {
                                return _this.calcularScoreExhibicionSync(ex, pesos, catalogMap);
                            });
                            puntosTotales = exhibicionesScores.reduce(function (sum, ex) { return sum + ex.puntos; }, 0);
                            return [2 /*return*/, {
                                    puntos_obtenidos: Number(puntosTotales.toFixed(2)),
                                    exhibiciones_scores: exhibicionesScores
                                }];
                    }
                });
            });
        };
        /**
         * CAPA 3: Score del Colaborador
         * Suma de todos sus puntos históricos vs su meta personal
         */
        ScoringV2Service_1.prototype.calculateColaboradorScore = function (userId) {
            return __awaiter(this, void 0, void 0, function () {
                var user, metaPuntos, captures, totalPuntos, _i, captures_1, cap, stats;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.knex('users').where({ id: userId }).first()];
                        case 1:
                            user = _a.sent();
                            metaPuntos = (user === null || user === void 0 ? void 0 : user.meta_puntos) || 5000;
                            return [4 /*yield*/, this.knex('daily_captures').where({ user_id: userId })];
                        case 2:
                            captures = _a.sent();
                            totalPuntos = 0;
                            for (_i = 0, captures_1 = captures; _i < captures_1.length; _i++) {
                                cap = captures_1[_i];
                                stats = typeof cap.stats === 'string' ? JSON.parse(cap.stats) : cap.stats;
                                if (stats && typeof stats.puntuacionTotal === 'number') {
                                    totalPuntos += stats.puntuacionTotal;
                                }
                            }
                            return [2 /*return*/, {
                                    user_id: userId,
                                    meta_puntos: metaPuntos,
                                    puntos_acumulados: totalPuntos
                                }];
                    }
                });
            });
        };
        /**
         * Valida si una combinación posición × exhibición es válida
         */
        ScoringV2Service_1.prototype.validarCombinacion = function (configVersionId, posicionId, exhibicionId) {
            return __awaiter(this, void 0, void 0, function () {
                var combinacion;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.knex('combinaciones_validas')
                                .where({
                                config_version_id: configVersionId,
                                posicion_id: posicionId,
                                exhibicion_id: exhibicionId,
                                activo: true
                            })
                                .first()];
                        case 1:
                            combinacion = _a.sent();
                            return [2 /*return*/, !!combinacion];
                    }
                });
            });
        };
        return ScoringV2Service_1;
    }());
    __setFunctionName(_classThis, "ScoringV2Service");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        ScoringV2Service = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return ScoringV2Service = _classThis;
}();
exports.ScoringV2Service = ScoringV2Service;
