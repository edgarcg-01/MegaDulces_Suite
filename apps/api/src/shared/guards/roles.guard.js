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
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.RolesGuard = void 0;
var common_1 = require("@nestjs/common");
var permissions_decorator_1 = require("../decorators/permissions.decorator");
var ability_1 = require("@casl/ability");
var permissions_1 = require("../constants/permissions");
var subjectMap = (_a = {},
    _a[permissions_1.Permission.USUARIOS_VER] = 'users',
    _a[permissions_1.Permission.USUARIOS_GESTIONAR] = 'users',
    _a[permissions_1.Permission.USUARIOS_PASSWORDS] = 'users_passwords',
    _a[permissions_1.Permission.USUARIOS_ASIGNAR_RUTA] = 'users_assign_route',
    _a[permissions_1.Permission.REPORTES_VER_PROPIO] = 'reports_own',
    _a[permissions_1.Permission.REPORTES_VER_EQUIPO] = 'reports_team',
    _a[permissions_1.Permission.REPORTES_VER_GLOBAL] = 'reports_global',
    _a[permissions_1.Permission.REPORTES_EXPORTAR] = 'reports_export',
    _a[permissions_1.Permission.REPORTES_GESTIONAR] = 'reports_manage',
    _a[permissions_1.Permission.VISITAS_REGISTRAR] = 'visits',
    _a[permissions_1.Permission.VISITAS_VER] = 'visits',
    _a[permissions_1.Permission.VISITAS_AUDITAR] = 'visits_audit',
    _a[permissions_1.Permission.CATALOGO_GESTIONAR] = 'catalogs',
    _a[permissions_1.Permission.PLANOGRAMAS_GESTIONAR] = 'planograms',
    _a[permissions_1.Permission.ROLES_CONFIGURAR] = 'roles_config',
    _a[permissions_1.Permission.SCORING_CONFIG_VER] = 'scoring_config',
    _a[permissions_1.Permission.SCORING_CONFIG_GESTIONAR] = 'scoring_config',
    _a[permissions_1.Permission.VER_SEGUIMIENTO] = 'seguimiento',
    _a);
var RolesGuard = function () {
    var _classDecorators = [(0, common_1.Injectable)()];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var RolesGuard = _classThis = /** @class */ (function () {
        function RolesGuard_1(reflector) {
            this.reflector = reflector;
        }
        RolesGuard_1.prototype.canActivate = function (context) {
            return __awaiter(this, void 0, void 0, function () {
                var request, user, ability, requiredPermissions, allGranted;
                return __generator(this, function (_a) {
                    request = context.switchToHttp().getRequest();
                    user = request.user;
                    if (!user) {
                        throw new common_1.ForbiddenException('Usuario no autenticado.');
                    }
                    ability = (0, ability_1.createMongoAbility)(user.rules || []);
                    if (ability.can('manage', 'all')) {
                        return [2 /*return*/, true];
                    }
                    requiredPermissions = this.reflector.getAllAndOverride(permissions_decorator_1.PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);
                    if (requiredPermissions && requiredPermissions.length > 0) {
                        allGranted = requiredPermissions.every(function (perm) {
                            var subject = subjectMap[perm];
                            if (!subject)
                                return false;
                            return ability.can('read', subject) || ability.can('manage', subject);
                        });
                        if (!allGranted) {
                            console.error(" Bloqueo 403. Usuario: ".concat(user.username, ". Faltan permisos:"), requiredPermissions);
                            throw new common_1.ForbiddenException('No tienes los permisos dinámicos necesarios.');
                        }
                        return [2 /*return*/, true];
                    }
                    return [2 /*return*/, true];
                });
            });
        };
        return RolesGuard_1;
    }());
    __setFunctionName(_classThis, "RolesGuard");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        RolesGuard = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return RolesGuard = _classThis;
}();
exports.RolesGuard = RolesGuard;
