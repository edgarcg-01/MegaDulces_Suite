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
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.StoresService = void 0;
var common_1 = require("@nestjs/common");
var StoresService = function () {
    var _classDecorators = [(0, common_1.Injectable)()];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var StoresService = _classThis = /** @class */ (function () {
        function StoresService_1(knex) {
            this.knex = knex;
        }
        StoresService_1.prototype.haversine = function (lat1, lon1, lat2, lon2) {
            var R = 6371000;
            var φ1 = lat1 * Math.PI / 180;
            var φ2 = lat2 * Math.PI / 180;
            var Δφ = (lat2 - lat1) * Math.PI / 180;
            var Δλ = (lon2 - lon1) * Math.PI / 180;
            var a = Math.pow(Math.sin(Δφ / 2), 2) +
                Math.cos(φ1) * Math.cos(φ2) * Math.pow(Math.sin(Δλ / 2), 2);
            return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        };
        StoresService_1.prototype.findNearby = function (lat_1, lng_1) {
            return __awaiter(this, arguments, void 0, function (lat, lng, radiusMeters) {
                var stores;
                var _this = this;
                if (radiusMeters === void 0) { radiusMeters = 50; }
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.knex('stores')
                                .where({ activo: true })
                                .whereNotNull('latitud')
                                .whereNotNull('longitud')
                                .where('latitud', '!=', 0)
                                .where('longitud', '!=', 0)
                                .select('*')];
                        case 1:
                            stores = _a.sent();
                            return [2 /*return*/, stores
                                    .map(function (store) { return ({
                                    id: store.id,
                                    nombre: store.nombre,
                                    direccion: store.direccion,
                                    latitud: store.latitud,
                                    longitud: store.longitud,
                                    distance: Math.round(_this.haversine(lat, lng, Number(store.latitud), Number(store.longitud))),
                                }); })
                                    .filter(function (s) { return s.distance <= radiusMeters; })
                                    .sort(function (a, b) { return a.distance - b.distance; })];
                    }
                });
            });
        };
        StoresService_1.prototype.resolveZonaId = function (zonaName) {
            return __awaiter(this, void 0, void 0, function () {
                var zone;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            if (!zonaName)
                                return [2 /*return*/, null];
                            return [4 /*yield*/, this.knex('zones')
                                    .where({ name: zonaName })
                                    .select('id')
                                    .first()];
                        case 1:
                            zone = _a.sent();
                            return [2 /*return*/, zone ? zone.id : null];
                    }
                });
            });
        };
        StoresService_1.prototype.findAll = function (zona_id, ruta_id) {
            return __awaiter(this, void 0, void 0, function () {
                var query;
                return __generator(this, function (_a) {
                    query = this.knex('stores as s')
                        .leftJoin('zones as z', 's.zona_id', 'z.id')
                        .leftJoin('catalogs as c', 's.ruta_id', 'c.id')
                        .where({ 's.activo': true })
                        .select('s.id', 's.nombre', 's.direccion', 's.latitud', 's.longitud', 's.activo', 's.zona_id', 's.ruta_id', 's.created_at', 'z.name as zona', 'c.value as ruta_nombre')
                        .orderBy('s.nombre', 'asc');
                    if (zona_id) {
                        query.where('s.zona_id', zona_id);
                    }
                    if (ruta_id) {
                        query.where('s.ruta_id', ruta_id);
                    }
                    return [2 /*return*/, query];
                });
            });
        };
        StoresService_1.prototype.create = function (data) {
            return __awaiter(this, void 0, void 0, function () {
                var zona, ruta_id, rest, zona_id, store;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            zona = data.zona, ruta_id = data.ruta_id, rest = __rest(data, ["zona", "ruta_id"]);
                            return [4 /*yield*/, this.resolveZonaId(zona)];
                        case 1:
                            zona_id = _a.sent();
                            return [4 /*yield*/, this.knex('stores')
                                    .insert(__assign(__assign({}, rest), { zona_id: zona_id }))
                                    .returning('*')];
                        case 2:
                            store = (_a.sent())[0];
                            return [2 /*return*/, __assign(__assign({}, store), { zona: zona })];
                    }
                });
            });
        };
        StoresService_1.prototype.remove = function (id) {
            return __awaiter(this, void 0, void 0, function () {
                var store;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.knex('stores').where({ id: id }).del().returning('*')];
                        case 1:
                            store = (_a.sent())[0];
                            if (!store)
                                throw new common_1.NotFoundException('Requerimiento fallido: Tienda o Punto de Venta no encontrado.');
                            return [2 /*return*/, store];
                    }
                });
            });
        };
        StoresService_1.prototype.update = function (id, data) {
            return __awaiter(this, void 0, void 0, function () {
                var zona, rest, updateData, _a, store, zoneName, _b, routeName, _c;
                var _d, _e;
                return __generator(this, function (_f) {
                    switch (_f.label) {
                        case 0:
                            zona = data.zona, rest = __rest(data, ["zona"]);
                            updateData = __assign({}, rest);
                            if (!(zona !== undefined)) return [3 /*break*/, 2];
                            _a = updateData;
                            return [4 /*yield*/, this.resolveZonaId(zona)];
                        case 1:
                            _a.zona_id = _f.sent();
                            _f.label = 2;
                        case 2: return [4 /*yield*/, this.knex('stores')
                                .where({ id: id })
                                .update(__assign(__assign({}, updateData), { activo: data.activo !== undefined ? data.activo : true }))
                                .returning('*')];
                        case 3:
                            store = (_f.sent())[0];
                            if (!store)
                                throw new common_1.NotFoundException('Requerimiento fallido: Tienda o Punto de Venta no encontrado.');
                            if (!(zona !== undefined)) return [3 /*break*/, 4];
                            _b = zona;
                            return [3 /*break*/, 6];
                        case 4: return [4 /*yield*/, this.knex('zones')
                                .where({ id: store.zona_id })
                                .select('name')
                                .first()];
                        case 5:
                            _b = (_d = (_f.sent())) === null || _d === void 0 ? void 0 : _d.name;
                            _f.label = 6;
                        case 6:
                            zoneName = _b;
                            if (!store.ruta_id) return [3 /*break*/, 8];
                            return [4 /*yield*/, this.knex('catalogs').where({ id: store.ruta_id }).select('value').first()];
                        case 7:
                            _c = (_e = (_f.sent())) === null || _e === void 0 ? void 0 : _e.value;
                            return [3 /*break*/, 9];
                        case 8:
                            _c = null;
                            _f.label = 9;
                        case 9:
                            routeName = _c;
                            return [2 /*return*/, __assign(__assign({}, store), { zona: zoneName, ruta_nombre: routeName })];
                    }
                });
            });
        };
        return StoresService_1;
    }());
    __setFunctionName(_classThis, "StoresService");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        StoresService = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return StoresService = _classThis;
}();
exports.StoresService = StoresService;
