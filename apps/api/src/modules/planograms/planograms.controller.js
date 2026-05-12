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
exports.PlanogramsProductsController = exports.PlanogramsController = void 0;
var common_1 = require("@nestjs/common");
var require_auth_guard_1 = require("../../shared/guards/require-auth.guard");
var permissions_decorator_1 = require("../../shared/decorators/permissions.decorator");
var permissions_1 = require("../../shared/constants/permissions");
var roles_guard_1 = require("../../shared/guards/roles.guard");
var swagger_1 = require("@nestjs/swagger");
var PlanogramsController = function () {
    var _classDecorators = [(0, swagger_1.ApiTags)('planograms'), (0, swagger_1.ApiBearerAuth)(), (0, common_1.UseGuards)(require_auth_guard_1.RequireAuthGuard, roles_guard_1.RolesGuard), (0, common_1.Controller)('planograms/brands')];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var _instanceExtraInitializers = [];
    var _getAll_decorators;
    var _getVersion_decorators;
    var _createBrand_decorators;
    var _addProduct_decorators;
    var _updateBrand_decorators;
    var _deleteBrand_decorators;
    var PlanogramsController = _classThis = /** @class */ (function () {
        function PlanogramsController_1(planogramsService) {
            this.planogramsService = (__runInitializers(this, _instanceExtraInitializers), planogramsService);
        }
        PlanogramsController_1.prototype.getAll = function () {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    return [2 /*return*/, this.planogramsService.getAll()];
                });
            });
        };
        PlanogramsController_1.prototype.getVersion = function () {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    return [2 /*return*/, this.planogramsService.getVersion()];
                });
            });
        };
        PlanogramsController_1.prototype.createBrand = function (body) {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    return [2 /*return*/, this.planogramsService.createBrand(body)];
                });
            });
        };
        PlanogramsController_1.prototype.addProduct = function (id, body) {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    return [2 /*return*/, this.planogramsService.addProduct(id, body)];
                });
            });
        };
        PlanogramsController_1.prototype.updateBrand = function (id, body) {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    return [2 /*return*/, this.planogramsService.updateBrand(id, body)];
                });
            });
        };
        PlanogramsController_1.prototype.deleteBrand = function (id) {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    return [2 /*return*/, this.planogramsService.deleteBrand(id)];
                });
            });
        };
        return PlanogramsController_1;
    }());
    __setFunctionName(_classThis, "PlanogramsController");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        _getAll_decorators = [(0, common_1.Get)(), (0, swagger_1.ApiOperation)({
                summary: 'Obtiene todo el catálogo jerárquico de Marcas y Productos',
            })];
        _getVersion_decorators = [(0, common_1.Get)('version'), (0, swagger_1.ApiOperation)({ summary: 'Obtiene la versión (última actualización) del planograma para cache' })];
        _createBrand_decorators = [(0, common_1.Post)(), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.PLANOGRAMAS_GESTIONAR), (0, swagger_1.ApiOperation)({ summary: 'Crea una nueva marca' })];
        _addProduct_decorators = [(0, common_1.Post)(':id/products'), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.PLANOGRAMAS_GESTIONAR), (0, swagger_1.ApiOperation)({ summary: 'Crea un producto bajo una marca existente' })];
        _updateBrand_decorators = [(0, common_1.Put)(':id'), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.PLANOGRAMAS_GESTIONAR), (0, swagger_1.ApiOperation)({ summary: 'Actualizar datos de una marca' })];
        _deleteBrand_decorators = [(0, common_1.Delete)(':id'), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.PLANOGRAMAS_GESTIONAR), (0, swagger_1.ApiOperation)({ summary: 'Borra una marca' })];
        __esDecorate(_classThis, null, _getAll_decorators, { kind: "method", name: "getAll", static: false, private: false, access: { has: function (obj) { return "getAll" in obj; }, get: function (obj) { return obj.getAll; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _getVersion_decorators, { kind: "method", name: "getVersion", static: false, private: false, access: { has: function (obj) { return "getVersion" in obj; }, get: function (obj) { return obj.getVersion; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _createBrand_decorators, { kind: "method", name: "createBrand", static: false, private: false, access: { has: function (obj) { return "createBrand" in obj; }, get: function (obj) { return obj.createBrand; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _addProduct_decorators, { kind: "method", name: "addProduct", static: false, private: false, access: { has: function (obj) { return "addProduct" in obj; }, get: function (obj) { return obj.addProduct; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _updateBrand_decorators, { kind: "method", name: "updateBrand", static: false, private: false, access: { has: function (obj) { return "updateBrand" in obj; }, get: function (obj) { return obj.updateBrand; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _deleteBrand_decorators, { kind: "method", name: "deleteBrand", static: false, private: false, access: { has: function (obj) { return "deleteBrand" in obj; }, get: function (obj) { return obj.deleteBrand; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        PlanogramsController = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return PlanogramsController = _classThis;
}();
exports.PlanogramsController = PlanogramsController;
var PlanogramsProductsController = function () {
    var _classDecorators = [(0, swagger_1.ApiTags)('planograms'), (0, swagger_1.ApiBearerAuth)(), (0, common_1.UseGuards)(require_auth_guard_1.RequireAuthGuard, roles_guard_1.RolesGuard), (0, common_1.Controller)('planograms/products')];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var _instanceExtraInitializers = [];
    var _getProduct_decorators;
    var _updateProduct_decorators;
    var _deleteProduct_decorators;
    var PlanogramsProductsController = _classThis = /** @class */ (function () {
        function PlanogramsProductsController_1(planogramsService) {
            this.planogramsService = (__runInitializers(this, _instanceExtraInitializers), planogramsService);
        }
        PlanogramsProductsController_1.prototype.getProduct = function (id) {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    return [2 /*return*/, this.planogramsService.getProduct(id)];
                });
            });
        };
        PlanogramsProductsController_1.prototype.updateProduct = function (id, body) {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    return [2 /*return*/, this.planogramsService.updateProduct(id, body)];
                });
            });
        };
        PlanogramsProductsController_1.prototype.deleteProduct = function (id) {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    return [2 /*return*/, this.planogramsService.deleteProduct(id)];
                });
            });
        };
        return PlanogramsProductsController_1;
    }());
    __setFunctionName(_classThis, "PlanogramsProductsController");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        _getProduct_decorators = [(0, common_1.Get)(':id'), (0, swagger_1.ApiOperation)({ summary: 'Obtiene un producto por ID' })];
        _updateProduct_decorators = [(0, common_1.Put)(':id'), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.PLANOGRAMAS_GESTIONAR), (0, swagger_1.ApiOperation)({ summary: 'Actualiza datos de un producto' })];
        _deleteProduct_decorators = [(0, common_1.Delete)(':id'), (0, permissions_decorator_1.RequirePermissions)(permissions_1.Permission.PLANOGRAMAS_GESTIONAR), (0, swagger_1.ApiOperation)({ summary: 'Borra un producto' })];
        __esDecorate(_classThis, null, _getProduct_decorators, { kind: "method", name: "getProduct", static: false, private: false, access: { has: function (obj) { return "getProduct" in obj; }, get: function (obj) { return obj.getProduct; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _updateProduct_decorators, { kind: "method", name: "updateProduct", static: false, private: false, access: { has: function (obj) { return "updateProduct" in obj; }, get: function (obj) { return obj.updateProduct; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _deleteProduct_decorators, { kind: "method", name: "deleteProduct", static: false, private: false, access: { has: function (obj) { return "deleteProduct" in obj; }, get: function (obj) { return obj.deleteProduct; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        PlanogramsProductsController = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return PlanogramsProductsController = _classThis;
}();
exports.PlanogramsProductsController = PlanogramsProductsController;
