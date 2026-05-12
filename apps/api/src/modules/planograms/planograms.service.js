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
exports.PlanogramsService = void 0;
var common_1 = require("@nestjs/common");
var PlanogramsService = function () {
    var _classDecorators = [(0, common_1.Injectable)()];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var PlanogramsService = _classThis = /** @class */ (function () {
        function PlanogramsService_1(knex) {
            this.knex = knex;
        }
        PlanogramsService_1.prototype.getAll = function () {
            return __awaiter(this, void 0, void 0, function () {
                var brands, products, result;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.knex('brands').orderBy('orden', 'asc')];
                        case 1:
                            brands = _a.sent();
                            return [4 /*yield*/, this.knex('products').orderBy('orden', 'asc')];
                        case 2:
                            products = _a.sent();
                            console.log('[PlanogramsService] Brands:', JSON.stringify(brands, null, 2));
                            console.log('[PlanogramsService] Products:', JSON.stringify(products, null, 2));
                            result = brands.map(function (brand) { return (__assign(__assign({}, brand), { productos: products.filter(function (p) { return p.brand_id === brand.id; }) })); });
                            console.log('[PlanogramsService] Result:', JSON.stringify(result, null, 2));
                            return [2 /*return*/, result];
                    }
                });
            });
        };
        PlanogramsService_1.prototype.getVersion = function () {
            return __awaiter(this, void 0, void 0, function () {
                var _a, brandsResult, productsResult, dates, maxDate;
                return __generator(this, function (_b) {
                    switch (_b.label) {
                        case 0: return [4 /*yield*/, Promise.all([
                                this.knex('brands').max('updated_at as max_updated').first(),
                                this.knex('products').max('updated_at as max_updated').first(),
                            ])];
                        case 1:
                            _a = _b.sent(), brandsResult = _a[0], productsResult = _a[1];
                            dates = [brandsResult === null || brandsResult === void 0 ? void 0 : brandsResult.max_updated, productsResult === null || productsResult === void 0 ? void 0 : productsResult.max_updated].filter(Boolean);
                            maxDate = dates.length > 0
                                ? new Date(Math.max.apply(Math, dates.map(function (d) { return new Date(d).getTime(); }))).toISOString()
                                : null;
                            return [2 /*return*/, { version: maxDate }];
                    }
                });
            });
        };
        PlanogramsService_1.prototype.createBrand = function (data) {
            return __awaiter(this, void 0, void 0, function () {
                var brand;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.knex('brands').insert(__assign(__assign({}, data), { updated_at: this.knex.fn.now() })).returning('*')];
                        case 1:
                            brand = (_a.sent())[0];
                            return [2 /*return*/, brand];
                    }
                });
            });
        };
        PlanogramsService_1.prototype.addProduct = function (brandId, data) {
            return __awaiter(this, void 0, void 0, function () {
                var brand, insertData, product;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            console.log('[PlanogramsService] addProduct - brandId:', brandId);
                            console.log('[PlanogramsService] addProduct - data:', JSON.stringify(data, null, 2));
                            return [4 /*yield*/, this.knex('brands').where({ id: brandId }).first()];
                        case 1:
                            brand = _a.sent();
                            if (!brand)
                                throw new Error('Brand not found');
                            insertData = __assign(__assign({}, data), { brand_id: brandId });
                            console.log('[PlanogramsService] addProduct - insertData:', JSON.stringify(insertData, null, 2));
                            return [4 /*yield*/, this.knex('products')
                                    .insert(__assign(__assign({}, insertData), { updated_at: this.knex.fn.now() }))
                                    .returning('*')];
                        case 2:
                            product = (_a.sent())[0];
                            console.log('[PlanogramsService] addProduct - inserted product:', JSON.stringify(product, null, 2));
                            // Asegurar que el producto tiene todos los campos necesarios
                            if (!product.nombre && data.nombre) {
                                product.nombre = data.nombre;
                                console.log('[PlanogramsService] addProduct - added nombre from data:', data.nombre);
                            }
                            // Bump brand's updated_at
                            return [4 /*yield*/, this.knex('brands').where({ id: brandId }).update({ updated_at: this.knex.fn.now() })];
                        case 3:
                            // Bump brand's updated_at
                            _a.sent();
                            return [2 /*return*/, product];
                    }
                });
            });
        };
        PlanogramsService_1.prototype.getProduct = function (id) {
            return __awaiter(this, void 0, void 0, function () {
                var product;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.knex('products').where({ id: id }).first()];
                        case 1:
                            product = _a.sent();
                            if (!product)
                                throw new Error('Product not found');
                            return [2 /*return*/, product];
                    }
                });
            });
        };
        PlanogramsService_1.prototype.updateBrand = function (id, data) {
            return __awaiter(this, void 0, void 0, function () {
                var brand;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.knex('brands')
                                .where({ id: id })
                                .update(__assign(__assign({}, data), { updated_at: this.knex.fn.now() }))
                                .returning('*')];
                        case 1:
                            brand = (_a.sent())[0];
                            return [2 /*return*/, brand];
                    }
                });
            });
        };
        PlanogramsService_1.prototype.updateProduct = function (id, data) {
            return __awaiter(this, void 0, void 0, function () {
                var product;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.knex('products')
                                .where({ id: id })
                                .update(__assign(__assign({}, data), { updated_at: this.knex.fn.now() }))
                                .returning('*')];
                        case 1:
                            product = (_a.sent())[0];
                            return [2 /*return*/, product];
                    }
                });
            });
        };
        PlanogramsService_1.prototype.deleteProduct = function (id) {
            return __awaiter(this, void 0, void 0, function () {
                var deleted;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.knex('products').where({ id: id }).update({ updated_at: this.knex.fn.now() })];
                        case 1:
                            _a.sent();
                            return [4 /*yield*/, this.knex('products').where({ id: id }).del()];
                        case 2:
                            deleted = _a.sent();
                            return [2 /*return*/, { deleted: deleted }];
                    }
                });
            });
        };
        PlanogramsService_1.prototype.deleteBrand = function (id) {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.knex('products').where({ brand_id: id }).update({ updated_at: this.knex.fn.now() })];
                        case 1:
                            _a.sent();
                            return [4 /*yield*/, this.knex('brands').where({ id: id }).update({ updated_at: this.knex.fn.now() })];
                        case 2:
                            _a.sent();
                            return [4 /*yield*/, this.knex('brands').where({ id: id }).del()];
                        case 3:
                            _a.sent();
                            return [2 /*return*/, { success: true }];
                    }
                });
            });
        };
        return PlanogramsService_1;
    }());
    __setFunctionName(_classThis, "PlanogramsService");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        PlanogramsService = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return PlanogramsService = _classThis;
}();
exports.PlanogramsService = PlanogramsService;
