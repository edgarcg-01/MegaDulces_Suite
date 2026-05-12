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
exports.TasksService = void 0;
var common_1 = require("@nestjs/common");
var schedule_1 = require("@nestjs/schedule");
var TasksService = function () {
    var _classDecorators = [(0, common_1.Injectable)()];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var _instanceExtraInitializers = [];
    var _cleanOldCaptures_decorators;
    var TasksService = _classThis = /** @class */ (function () {
        function TasksService_1(knex, cloudinaryService) {
            this.knex = (__runInitializers(this, _instanceExtraInitializers), knex);
            this.cloudinaryService = cloudinaryService;
            this.logger = new common_1.Logger(TasksService.name);
        }
        // Método faltante agregado para el controlador
        TasksService_1.prototype.manualCleanup = function () {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            this.logger.log('Ejecución manual de limpieza iniciada.');
                            return [4 /*yield*/, this.cleanOldCaptures()];
                        case 1:
                            _a.sent();
                            return [2 /*return*/];
                    }
                });
            });
        };
        // Se ejecuta todos los días a las 2:00 AM
        TasksService_1.prototype.cleanOldCaptures = function () {
            return __awaiter(this, void 0, void 0, function () {
                var cutoffDate, oldPhotos, _i, oldPhotos_1, photo, err_1, ids, oldDailyCaptures, _a, oldDailyCaptures_1, dc, exhibiciones, _b, exhibiciones_1, ex, err_2, ids;
                return __generator(this, function (_c) {
                    switch (_c.label) {
                        case 0:
                            // Paréntesis de cierre restaurado aquí
                            this.logger.log('Iniciando limpieza de registros con una antigüedad mayor a 30 días...');
                            cutoffDate = new Date();
                            cutoffDate.setDate(cutoffDate.getDate() - 30);
                            return [4 /*yield*/, this.knex('exhibition_photos')
                                    .where('created_at', '<', cutoffDate)
                                    .select('id', 'photo_public_id')];
                        case 1:
                            oldPhotos = _c.sent();
                            _i = 0, oldPhotos_1 = oldPhotos;
                            _c.label = 2;
                        case 2:
                            if (!(_i < oldPhotos_1.length)) return [3 /*break*/, 7];
                            photo = oldPhotos_1[_i];
                            if (!photo.photo_public_id) return [3 /*break*/, 6];
                            _c.label = 3;
                        case 3:
                            _c.trys.push([3, 5, , 6]);
                            return [4 /*yield*/, this.cloudinaryService.deleteImage(photo.photo_public_id)];
                        case 4:
                            _c.sent();
                            this.logger.log("Cloudinary public_id: ".concat(photo.photo_public_id, " borrado permanentemente."));
                            return [3 /*break*/, 6];
                        case 5:
                            err_1 = _c.sent();
                            this.logger.error("Omitiendo error de borrado por Cloudinary publicId: ".concat(photo.photo_public_id));
                            return [3 /*break*/, 6];
                        case 6:
                            _i++;
                            return [3 /*break*/, 2];
                        case 7:
                            if (!(oldPhotos.length > 0)) return [3 /*break*/, 9];
                            ids = oldPhotos.map(function (p) { return p.id; });
                            return [4 /*yield*/, this.knex('exhibition_photos').whereIn('id', ids).delete()];
                        case 8:
                            _c.sent();
                            this.logger.log("Registros de fotos en exhibition_photos limpiados: ".concat(ids.length));
                            _c.label = 9;
                        case 9: return [4 /*yield*/, this.knex('daily_captures')
                                .where('created_at', '<', cutoffDate)
                                .select('id', 'exhibiciones')];
                        case 10:
                            oldDailyCaptures = _c.sent();
                            _a = 0, oldDailyCaptures_1 = oldDailyCaptures;
                            _c.label = 11;
                        case 11:
                            if (!(_a < oldDailyCaptures_1.length)) return [3 /*break*/, 18];
                            dc = oldDailyCaptures_1[_a];
                            if (!dc.exhibiciones) return [3 /*break*/, 17];
                            exhibiciones = [];
                            try {
                                exhibiciones =
                                    typeof dc.exhibiciones === 'string'
                                        ? JSON.parse(dc.exhibiciones)
                                        : dc.exhibiciones;
                            }
                            catch (e) { }
                            _b = 0, exhibiciones_1 = exhibiciones;
                            _c.label = 12;
                        case 12:
                            if (!(_b < exhibiciones_1.length)) return [3 /*break*/, 17];
                            ex = exhibiciones_1[_b];
                            if (!ex.fotoPublicId) return [3 /*break*/, 16];
                            _c.label = 13;
                        case 13:
                            _c.trys.push([13, 15, , 16]);
                            return [4 /*yield*/, this.cloudinaryService.deleteImage(ex.fotoPublicId)];
                        case 14:
                            _c.sent();
                            this.logger.log("Cloudinary public_id: ".concat(ex.fotoPublicId, " borrado."));
                            return [3 /*break*/, 16];
                        case 15:
                            err_2 = _c.sent();
                            this.logger.error("Error de Cloudinary al borrar daily capture img: ".concat(ex.fotoPublicId));
                            return [3 /*break*/, 16];
                        case 16:
                            _b++;
                            return [3 /*break*/, 12];
                        case 17:
                            _a++;
                            return [3 /*break*/, 11];
                        case 18:
                            if (!(oldDailyCaptures.length > 0)) return [3 /*break*/, 20];
                            ids = oldDailyCaptures.map(function (dc) { return dc.id; });
                            return [4 /*yield*/, this.knex('daily_captures').whereIn('id', ids).delete()];
                        case 19:
                            _c.sent();
                            this.logger.log("Fueron purgadas ".concat(ids.length, " capturas diarias muy antiguas."));
                            _c.label = 20;
                        case 20:
                            this.logger.log('Limpieza 30-días finalizada.');
                            return [2 /*return*/];
                    }
                });
            });
        };
        return TasksService_1;
    }());
    __setFunctionName(_classThis, "TasksService");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        _cleanOldCaptures_decorators = [(0, schedule_1.Cron)('0 2 * * *')];
        __esDecorate(_classThis, null, _cleanOldCaptures_decorators, { kind: "method", name: "cleanOldCaptures", static: false, private: false, access: { has: function (obj) { return "cleanOldCaptures" in obj; }, get: function (obj) { return obj.cleanOldCaptures; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        TasksService = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return TasksService = _classThis;
}();
exports.TasksService = TasksService;
