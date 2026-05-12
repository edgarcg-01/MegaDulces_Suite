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
exports.ScoringService = void 0;
var common_1 = require("@nestjs/common");
var ScoringService = function () {
    var _classDecorators = [(0, common_1.Injectable)()];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var ScoringService = _classThis = /** @class */ (function () {
        function ScoringService_1(knex) {
            this.knex = knex;
        }
        ScoringService_1.prototype.getConfig = function () {
            return __awaiter(this, void 0, void 0, function () {
                var record;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.knex('scoring_config')
                                .orderBy('updated_at', 'desc')
                                .first()];
                        case 1:
                            record = _a.sent();
                            if (!record)
                                return [2 /*return*/, {}];
                            return [2 /*return*/, typeof record.config === 'string'
                                    ? JSON.parse(record.config)
                                    : record.config];
                    }
                });
            });
        };
        ScoringService_1.prototype.setConfig = function (configData) {
            return __awaiter(this, void 0, void 0, function () {
                var records, updated, inserted;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.knex('scoring_config').limit(1)];
                        case 1:
                            records = _a.sent();
                            if (!(records.length > 0)) return [3 /*break*/, 3];
                            return [4 /*yield*/, this.knex('scoring_config')
                                    .where({ id: records[0].id })
                                    .update({
                                    config: JSON.stringify(configData),
                                    updated_at: this.knex.fn.now(),
                                })
                                    .returning('*')];
                        case 2:
                            updated = _a.sent();
                            return [2 /*return*/, updated[0]];
                        case 3: return [4 /*yield*/, this.knex('scoring_config')
                                .insert({ config: JSON.stringify(configData) })
                                .returning('*')];
                        case 4:
                            inserted = (_a.sent())[0];
                            return [2 /*return*/, inserted];
                    }
                });
            });
        };
        ScoringService_1.prototype.calculateScore = function (dto) {
            return __awaiter(this, void 0, void 0, function () {
                var config, pesoPosicion, factorTipo, multiplicador, scoreVal;
                var _a, _b, _c, _d, _e, _f, _g, _h, _j;
                return __generator(this, function (_k) {
                    switch (_k.label) {
                        case 0:
                            // REGLA ABSOLUTA DEL DUEÑO:
                            // "No, tiene que subir explícitamente la foto para dar un scoring"
                            if (!dto.photo_url || dto.photo_url.trim() === '') {
                                return [2 /*return*/, {
                                        score: 0,
                                        reason: 'Ausencia de Evidencia Fotográfica anula la puntuación.',
                                    }];
                            }
                            return [4 /*yield*/, this.getConfig()];
                        case 1:
                            config = _k.sent();
                            pesoPosicion = (_c = (_a = config.pesos_posicion) === null || _a === void 0 ? void 0 : _a[(_b = dto.posicion) === null || _b === void 0 ? void 0 : _b.toLowerCase()]) !== null && _c !== void 0 ? _c : 0;
                            factorTipo = (_f = (_d = config.tipos_exhibicion) === null || _d === void 0 ? void 0 : _d[(_e = dto.tipo) === null || _e === void 0 ? void 0 : _e.toLowerCase()]) !== null && _f !== void 0 ? _f : 0;
                            multiplicador = (_j = (_g = config.niveles_ejecucion) === null || _g === void 0 ? void 0 : _g[(_h = dto.nivel_ejecucion) === null || _h === void 0 ? void 0 : _h.toLowerCase()]) !== null && _j !== void 0 ? _j : 0;
                            scoreVal = pesoPosicion * factorTipo * multiplicador;
                            return [2 /*return*/, { score: Number(scoreVal.toFixed(2)) }];
                    }
                });
            });
        };
        return ScoringService_1;
    }());
    __setFunctionName(_classThis, "ScoringService");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        ScoringService = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return ScoringService = _classThis;
}();
exports.ScoringService = ScoringService;
