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
exports.UsersService = void 0;
var common_1 = require("@nestjs/common");
var bcrypt = require("bcryptjs");
var UsersService = function () {
    var _classDecorators = [(0, common_1.Injectable)()];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var UsersService = _classThis = /** @class */ (function () {
        function UsersService_1(knex) {
            this.knex = knex;
        }
        UsersService_1.prototype.resolveZonaId = function (zonaName) {
            return __awaiter(this, void 0, void 0, function () {
                var zone;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            if (!zonaName)
                                return [2 /*return*/, null];
                            return [4 /*yield*/, this.knex('zones').where({ name: zonaName }).select('id').first()];
                        case 1:
                            zone = _a.sent();
                            return [2 /*return*/, zone ? zone.id : null];
                    }
                });
            });
        };
        UsersService_1.prototype.create = function (createUserDto) {
            return __awaiter(this, void 0, void 0, function () {
                var password, zona, dtoZonaId, role_name, rest, password_hash, zona_id, _a, normalizedRoleName, user;
                return __generator(this, function (_b) {
                    switch (_b.label) {
                        case 0:
                            password = createUserDto.password, zona = createUserDto.zona, dtoZonaId = createUserDto.zona_id, role_name = createUserDto.role_name, rest = __rest(createUserDto, ["password", "zona", "zona_id", "role_name"]);
                            return [4 /*yield*/, bcrypt.hash(password, 10)];
                        case 1:
                            password_hash = _b.sent();
                            _a = dtoZonaId;
                            if (_a) return [3 /*break*/, 3];
                            return [4 /*yield*/, this.resolveZonaId(zona)];
                        case 2:
                            _a = (_b.sent());
                            _b.label = 3;
                        case 3:
                            zona_id = _a;
                            console.log('[UsersService] Creating user with zona_id:', zona_id, 'zona:', zona);
                            normalizedRoleName = role_name ? role_name.toLowerCase() : role_name;
                            return [4 /*yield*/, this.knex('users')
                                    .insert(__assign(__assign({}, rest), { zona_id: zona_id, password_hash: password_hash, role_name: normalizedRoleName }))
                                    .returning([
                                    'id',
                                    'username',
                                    'nombre',
                                    'zona_id',
                                    'role_name',
                                    'activo',
                                    'supervisor_id',
                                    'created_at',
                                ])];
                        case 4:
                            user = (_b.sent())[0];
                            // Return with zona name for compatibility
                            return [2 /*return*/, __assign(__assign({}, user), { zona: zona })];
                    }
                });
            });
        };
        UsersService_1.prototype.findAll = function (zona, activo) {
            return __awaiter(this, void 0, void 0, function () {
                var query;
                return __generator(this, function (_a) {
                    query = this.knex('users as u')
                        .leftJoin('zones as z', 'u.zona_id', 'z.id')
                        .select('u.id', 'u.username', 'u.nombre', 'z.name as zona', 'u.role_name', 'u.activo', 'u.supervisor_id', 'u.created_at');
                    if (zona)
                        query.where('z.name', zona);
                    if (activo)
                        query.where('u.activo', activo === 'true');
                    return [2 /*return*/, query];
                });
            });
        };
        UsersService_1.prototype.findOne = function (id) {
            return __awaiter(this, void 0, void 0, function () {
                var user;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.knex('users as u')
                                .leftJoin('zones as z', 'u.zona_id', 'z.id')
                                .where('u.id', id)
                                .select('u.id', 'u.username', 'u.nombre', 'z.name as zona', 'u.role_name', 'u.activo', 'u.supervisor_id', 'u.created_at')
                                .first()];
                        case 1:
                            user = _a.sent();
                            if (!user) {
                                throw new common_1.NotFoundException("Usuario con ID ".concat(id, " no encontrado"));
                            }
                            return [2 /*return*/, user];
                    }
                });
            });
        };
        UsersService_1.prototype.update = function (id, updateUserDto) {
            return __awaiter(this, void 0, void 0, function () {
                var password, zona, dtoZonaId, role_name, rest, updateData, _a, _b, user, zoneName, _c;
                var _d;
                return __generator(this, function (_e) {
                    switch (_e.label) {
                        case 0:
                            password = updateUserDto.password, zona = updateUserDto.zona, dtoZonaId = updateUserDto.zona_id, role_name = updateUserDto.role_name, rest = __rest(updateUserDto, ["password", "zona", "zona_id", "role_name"]);
                            updateData = __assign({}, rest);
                            if (!password) return [3 /*break*/, 2];
                            _a = updateData;
                            return [4 /*yield*/, bcrypt.hash(password, 10)];
                        case 1:
                            _a.password_hash = _e.sent();
                            _e.label = 2;
                        case 2:
                            if (!(dtoZonaId !== undefined)) return [3 /*break*/, 3];
                            updateData.zona_id = dtoZonaId;
                            console.log('[UsersService] Updating user with zona_id from DTO:', dtoZonaId);
                            return [3 /*break*/, 5];
                        case 3:
                            if (!(zona !== undefined)) return [3 /*break*/, 5];
                            _b = updateData;
                            return [4 /*yield*/, this.resolveZonaId(zona)];
                        case 4:
                            _b.zona_id = _e.sent();
                            console.log('[UsersService] Updating user with resolved zona_id:', updateData.zona_id);
                            _e.label = 5;
                        case 5:
                            // Normalize role_name to lowercase to match role_permissions
                            if (role_name) {
                                updateData.role_name = role_name.toLowerCase();
                            }
                            return [4 /*yield*/, this.knex('users')
                                    .where({ id: id })
                                    .update(updateData)
                                    .returning([
                                    'id',
                                    'username',
                                    'nombre',
                                    'zona_id',
                                    'role_name',
                                    'activo',
                                    'supervisor_id',
                                    'created_at',
                                ])];
                        case 6:
                            user = (_e.sent())[0];
                            if (!user) {
                                throw new common_1.NotFoundException("Usuario con ID ".concat(id, " no encontrado"));
                            }
                            if (!(zona !== undefined)) return [3 /*break*/, 7];
                            _c = zona;
                            return [3 /*break*/, 9];
                        case 7: return [4 /*yield*/, this.knex('zones').where({ id: user.zona_id }).select('name').first()];
                        case 8:
                            _c = (_d = (_e.sent())) === null || _d === void 0 ? void 0 : _d.name;
                            _e.label = 9;
                        case 9:
                            zoneName = _c;
                            return [2 /*return*/, __assign(__assign({}, user), { zona: zoneName })];
                    }
                });
            });
        };
        UsersService_1.prototype.remove = function (id) {
            return __awaiter(this, void 0, void 0, function () {
                var count;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.knex('users')
                                .where({ id: id })
                                .update({ activo: false })];
                        case 1:
                            count = _a.sent();
                            if (count === 0) {
                                throw new common_1.NotFoundException("Usuario con ID ".concat(id, " no encontrado"));
                            }
                            return [2 /*return*/, { message: 'El usuario ha sido desactivado (soft delete)' }];
                    }
                });
            });
        };
        UsersService_1.prototype.getRoles = function () {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.knex('role_permissions').select('role_name')];
                        case 1: return [2 /*return*/, _a.sent()];
                    }
                });
            });
        };
        UsersService_1.prototype.findSupervisors = function (zona) {
            return __awaiter(this, void 0, void 0, function () {
                var query, result;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            console.log('[findSupervisors] Buscando supervisores, zona:', zona);
                            query = this.knex('users as u')
                                .leftJoin('zones as z', 'u.zona_id', 'z.id')
                                .where('u.role_name', 'like', '%supervisor%')
                                .where({ 'u.activo': true })
                                .select('u.id', 'u.nombre', 'u.username', 'z.name as zona');
                            if (zona) {
                                query.where('z.name', zona);
                            }
                            return [4 /*yield*/, query];
                        case 1:
                            result = _a.sent();
                            console.log('[findSupervisors] Encontrados:', result.length);
                            return [2 /*return*/, result];
                    }
                });
            });
        };
        UsersService_1.prototype.findSellers = function (zona, supervisorId) {
            return __awaiter(this, void 0, void 0, function () {
                var query, result;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            console.log('[findSellers] Buscando vendedodores, zona:', zona, 'supervisorId:', supervisorId);
                            query = this.knex('users as u')
                                .leftJoin('zones as z', 'u.zona_id', 'z.id')
                                .whereNotIn('u.role_name', ['supervisor_v', 'admin', 'superadmin'])
                                .where({ 'u.activo': true })
                                .select('u.id', 'u.nombre', 'u.username', 'z.name as zona', 'u.role_name', 'u.supervisor_id');
                            if (zona) {
                                query.where('z.name', zona);
                            }
                            if (supervisorId) {
                                query.where({ 'u.supervisor_id': supervisorId });
                            }
                            return [4 /*yield*/, query];
                        case 1:
                            result = _a.sent();
                            console.log('[findSellers] Encontrados:', result.length);
                            return [2 /*return*/, result];
                    }
                });
            });
        };
        UsersService_1.prototype.findBySupervisor = function (supervisorId) {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    return [2 /*return*/, this.knex('users as u')
                            .leftJoin('zones as z', 'u.zona_id', 'z.id')
                            .where({ 'u.supervisor_id': supervisorId, 'u.activo': true })
                            .select('u.id', 'u.nombre', 'u.username', 'z.name as zona', 'u.role_name')];
                });
            });
        };
        UsersService_1.prototype.getZones = function () {
            return __awaiter(this, void 0, void 0, function () {
                var rows, error_1;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            _a.trys.push([0, 2, , 3]);
                            console.log('[getZones] Obteniendo zonas de la tabla zones...');
                            return [4 /*yield*/, this.knex('zones')
                                    .orderBy('orden', 'asc')
                                    .select('id', 'name as value', 'orden')];
                        case 1:
                            rows = _a.sent();
                            console.log('[getZones] Zonas encontradas:', rows);
                            return [2 /*return*/, rows];
                        case 2:
                            error_1 = _a.sent();
                            console.error('[getZones] Error:', error_1);
                            return [2 /*return*/, []];
                        case 3: return [2 /*return*/];
                    }
                });
            });
        };
        return UsersService_1;
    }());
    __setFunctionName(_classThis, "UsersService");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        UsersService = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return UsersService = _classThis;
}();
exports.UsersService = UsersService;
