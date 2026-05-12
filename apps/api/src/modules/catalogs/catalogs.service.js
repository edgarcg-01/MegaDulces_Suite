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
exports.CatalogsService = void 0;
var common_1 = require("@nestjs/common");
var crypto_1 = require("crypto");
var CatalogsService = function () {
    var _classDecorators = [(0, common_1.Injectable)()];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var CatalogsService = _classThis = /** @class */ (function () {
        function CatalogsService_1(knex, scoringV2Service) {
            this.knex = knex;
            this.scoringV2Service = scoringV2Service;
        }
        CatalogsService_1.prototype.getByType = function (type, parentId) {
            return __awaiter(this, void 0, void 0, function () {
                var query, result;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            console.log('[CatalogsService] getByType called:', { type: type, parentId: parentId });
                            if (type === 'zonas' || type === 'zones') {
                                return [2 /*return*/, this.knex('zones')
                                        .orderBy('orden', 'asc')
                                        .select('id', 'name as value', 'orden')];
                            }
                            query = this.knex('catalogs')
                                .where({ catalog_id: type })
                                .orderBy('orden', 'asc');
                            if (parentId) {
                                console.log('[CatalogsService] Filtering by parent_id:', parentId);
                                query.where({ parent_id: parentId });
                            }
                            return [4 /*yield*/, query];
                        case 1:
                            result = _a.sent();
                            console.log('[CatalogsService] Query result for type:', type, 'parentId:', parentId, 'Count:', result.length);
                            console.log('[CatalogsService] Result details:', result);
                            return [2 /*return*/, result];
                    }
                });
            });
        };
        CatalogsService_1.prototype.create = function (type, data) {
            return __awaiter(this, void 0, void 0, function () {
                var item, puntuacion, insertData, item, error_1;
                var _a, _b, _c;
                return __generator(this, function (_d) {
                    switch (_d.label) {
                        case 0:
                            console.log('[CatalogsService] Creating item:', { type: type, data: data });
                            if (!(type === 'zonas' || type === 'zones')) return [3 /*break*/, 2];
                            console.log('[CatalogsService] Creating zone:', data);
                            return [4 /*yield*/, this.knex('zones')
                                    .insert({
                                    name: data.value,
                                    orden: (_a = data.orden) !== null && _a !== void 0 ? _a : 0,
                                })
                                    .returning(['id', 'name as value', 'orden'])];
                        case 1:
                            item = (_d.sent())[0];
                            console.log('[CatalogsService] Zone created:', item);
                            return [2 /*return*/, item];
                        case 2:
                            puntuacion = (_b = data.puntuacion) !== null && _b !== void 0 ? _b : 0;
                            if (typeof puntuacion === 'string') {
                                puntuacion = parseFloat(puntuacion);
                            }
                            insertData = {
                                catalog_id: type,
                                value: data.value,
                                orden: (_c = data.orden) !== null && _c !== void 0 ? _c : 0,
                                puntuacion: puntuacion,
                                icono: data.icono,
                                parent_id: data.parent_id, // Include parent_id for routes
                            };
                            console.log('[CatalogsService] Inserting into catalogs:', insertData);
                            _d.label = 3;
                        case 3:
                            _d.trys.push([3, 7, , 8]);
                            return [4 /*yield*/, this.knex('catalogs')
                                    .insert(insertData)
                                    .returning('*')];
                        case 4:
                            item = (_d.sent())[0];
                            console.log('[CatalogsService] Item created successfully:', item);
                            if (!['ubicaciones', 'conceptos', 'niveles'].includes(type)) return [3 /*break*/, 6];
                            return [4 /*yield*/, this.recalcularScoreMaximoActivo()];
                        case 5:
                            _d.sent();
                            _d.label = 6;
                        case 6: return [2 /*return*/, item];
                        case 7:
                            error_1 = _d.sent();
                            console.error('[CatalogsService] Error creating item:', error_1);
                            // Handle duplicate key error specifically
                            if (error_1.code === '23505') {
                                throw new Error("Ya existe un elemento con el valor \"".concat(data.value, "\" en este cat\u00E1logo"));
                            }
                            throw error_1;
                        case 8: return [2 /*return*/];
                    }
                });
            });
        };
        CatalogsService_1.prototype.delete = function (type, id) {
            return __awaiter(this, void 0, void 0, function () {
                var deleted_1, deleted;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            if (!(type === 'zonas' || type === 'zones')) return [3 /*break*/, 2];
                            return [4 /*yield*/, this.knex('zones')
                                    .where({ id: id })
                                    .del()];
                        case 1:
                            deleted_1 = _a.sent();
                            if (deleted_1 === 0)
                                throw new common_1.NotFoundException('Zona no encontrada');
                            return [2 /*return*/, { success: true }];
                        case 2: return [4 /*yield*/, this.knex('catalogs')
                                .where({ catalog_id: type, id: id })
                                .del()];
                        case 3:
                            deleted = _a.sent();
                            if (deleted === 0)
                                throw new common_1.NotFoundException('Elemento paramétrico no encontrado');
                            if (!['ubicaciones', 'conceptos', 'niveles'].includes(type)) return [3 /*break*/, 5];
                            return [4 /*yield*/, this.recalcularScoreMaximoActivo()];
                        case 4:
                            _a.sent();
                            _a.label = 5;
                        case 5: return [2 /*return*/, { success: true }];
                    }
                });
            });
        };
        /**
         * Recalcula el score_maximo de la versión activa
         */
        CatalogsService_1.prototype.recalcularScoreMaximoActivo = function () {
            return __awaiter(this, void 0, void 0, function () {
                var activeVersion;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.scoringV2Service.getActiveVersion()];
                        case 1:
                            activeVersion = _a.sent();
                            if (!activeVersion) return [3 /*break*/, 3];
                            return [4 /*yield*/, this.scoringV2Service.recalcularScoreMaximo(activeVersion.id)];
                        case 2:
                            _a.sent();
                            _a.label = 3;
                        case 3: return [2 /*return*/];
                    }
                });
            });
        };
        CatalogsService_1.prototype.update = function (type, id, data) {
            return __awaiter(this, void 0, void 0, function () {
                var updateData_1, item_1, puntuacion, updateData, item;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            if (!(type === 'zonas' || type === 'zones')) return [3 /*break*/, 2];
                            updateData_1 = {};
                            if (data.value !== undefined)
                                updateData_1.name = data.value;
                            if (data.orden !== undefined)
                                updateData_1.orden = data.orden;
                            return [4 /*yield*/, this.knex('zones')
                                    .where({ id: id })
                                    .update(updateData_1)
                                    .returning(['id', 'name as value', 'orden'])];
                        case 1:
                            item_1 = (_a.sent())[0];
                            if (!item_1)
                                throw new common_1.NotFoundException('Zona no encontrada para actualizar');
                            return [2 /*return*/, item_1];
                        case 2:
                            puntuacion = data.puntuacion;
                            if (puntuacion !== undefined && puntuacion !== null) {
                                if (typeof puntuacion === 'string') {
                                    puntuacion = parseFloat(puntuacion);
                                }
                            }
                            updateData = {
                                value: data.value,
                                orden: data.orden,
                                icono: data.icono,
                            };
                            // Only include puntuacion if it was provided
                            if (puntuacion !== undefined && puntuacion !== null) {
                                updateData.puntuacion = puntuacion;
                            }
                            return [4 /*yield*/, this.knex('catalogs')
                                    .where({ catalog_id: type, id: id })
                                    .update(updateData)
                                    .returning('*')];
                        case 3:
                            item = (_a.sent())[0];
                            if (!item)
                                throw new common_1.NotFoundException('Elemento paramétrico no encontrado para actualizar');
                            if (!(['ubicaciones', 'conceptos', 'niveles'].includes(type) && data.puntuacion !== undefined)) return [3 /*break*/, 5];
                            return [4 /*yield*/, this.recalcularScoreMaximoActivo()];
                        case 4:
                            _a.sent();
                            _a.label = 5;
                        case 5: return [2 /*return*/, item];
                    }
                });
            });
        };
        // --- Funciones Dinámicas para Roles ---
        CatalogsService_1.prototype.getRolePermissions = function (roleName) {
            return __awaiter(this, void 0, void 0, function () {
                var role, newRole;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.knex('role_permissions')
                                .where({ role_name: roleName })
                                .first()];
                        case 1:
                            role = _a.sent();
                            if (!!role) return [3 /*break*/, 3];
                            return [4 /*yield*/, this.knex('role_permissions')
                                    .insert({ id: (0, crypto_1.randomUUID)(), role_name: roleName, permissions: {} })
                                    .returning('*')];
                        case 2:
                            newRole = (_a.sent())[0];
                            return [2 /*return*/, newRole];
                        case 3: return [2 /*return*/, role];
                    }
                });
            });
        };
        CatalogsService_1.prototype.updateRolePermissions = function (roleName, permissions) {
            return __awaiter(this, void 0, void 0, function () {
                var role, newRole;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.knex('role_permissions')
                                .where({ role_name: roleName })
                                .update({ permissions: permissions })
                                .returning('*')];
                        case 1:
                            role = (_a.sent())[0];
                            if (!!role) return [3 /*break*/, 3];
                            return [4 /*yield*/, this.knex('role_permissions')
                                    .insert({
                                    id: (0, crypto_1.randomUUID)(),
                                    role_name: roleName,
                                    permissions: permissions,
                                })
                                    .returning('*')];
                        case 2:
                            newRole = (_a.sent())[0];
                            return [2 /*return*/, newRole];
                        case 3: return [2 /*return*/, role];
                    }
                });
            });
        };
        return CatalogsService_1;
    }());
    __setFunctionName(_classThis, "CatalogsService");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        CatalogsService = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return CatalogsService = _classThis;
}();
exports.CatalogsService = CatalogsService;
