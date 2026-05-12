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
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateDailyCaptureDto = void 0;
var swagger_1 = require("@nestjs/swagger");
var CreateDailyCaptureDto = function () {
    var _a;
    var _folio_decorators;
    var _folio_initializers = [];
    var _folio_extraInitializers = [];
    var _fechaCaptura_decorators;
    var _fechaCaptura_initializers = [];
    var _fechaCaptura_extraInitializers = [];
    var _horaInicio_decorators;
    var _horaInicio_initializers = [];
    var _horaInicio_extraInitializers = [];
    var _horaFin_decorators;
    var _horaFin_initializers = [];
    var _horaFin_extraInitializers = [];
    var _exhibiciones_decorators;
    var _exhibiciones_initializers = [];
    var _exhibiciones_extraInitializers = [];
    var _stats_decorators;
    var _stats_initializers = [];
    var _stats_extraInitializers = [];
    var _latitud_decorators;
    var _latitud_initializers = [];
    var _latitud_extraInitializers = [];
    var _longitud_decorators;
    var _longitud_initializers = [];
    var _longitud_extraInitializers = [];
    var _store_id_decorators;
    var _store_id_initializers = [];
    var _store_id_extraInitializers = [];
    return _a = /** @class */ (function () {
            function CreateDailyCaptureDto() {
                this.folio = __runInitializers(this, _folio_initializers, void 0);
                this.fechaCaptura = (__runInitializers(this, _folio_extraInitializers), __runInitializers(this, _fechaCaptura_initializers, void 0));
                this.horaInicio = (__runInitializers(this, _fechaCaptura_extraInitializers), __runInitializers(this, _horaInicio_initializers, void 0));
                this.horaFin = (__runInitializers(this, _horaInicio_extraInitializers), __runInitializers(this, _horaFin_initializers, void 0));
                this.exhibiciones = (__runInitializers(this, _horaFin_extraInitializers), __runInitializers(this, _exhibiciones_initializers, void 0));
                this.stats = (__runInitializers(this, _exhibiciones_extraInitializers), __runInitializers(this, _stats_initializers, void 0));
                this.latitud = (__runInitializers(this, _stats_extraInitializers), __runInitializers(this, _latitud_initializers, void 0));
                this.longitud = (__runInitializers(this, _latitud_extraInitializers), __runInitializers(this, _longitud_initializers, void 0));
                this.store_id = (__runInitializers(this, _longitud_extraInitializers), __runInitializers(this, _store_id_initializers, void 0));
                __runInitializers(this, _store_id_extraInitializers);
            }
            return CreateDailyCaptureDto;
        }()),
        (function () {
            var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            _folio_decorators = [(0, swagger_1.ApiProperty)({ description: 'Identificador único de la captura, ej. J-31-153045' })];
            _fechaCaptura_decorators = [(0, swagger_1.ApiProperty)({ description: 'Fecha de la captura diaria en formato YYYY-MM-DD', example: '2026-03-31' })];
            _horaInicio_decorators = [(0, swagger_1.ApiProperty)({ description: 'Hora de inicio de la auditoría en formato ISO' })];
            _horaFin_decorators = [(0, swagger_1.ApiProperty)({ description: 'Hora de fin de la auditoría en formato ISO' })];
            _exhibiciones_decorators = [(0, swagger_1.ApiProperty)({ description: 'Array de exhibidores reportados con base64 opcional' })];
            _stats_decorators = [(0, swagger_1.ApiProperty)({ description: 'Estructura en formato JSONB con el resumen estadístico de esta captura' })];
            _latitud_decorators = [(0, swagger_1.ApiProperty)({ description: 'Latitud de la captura diaria', required: false })];
            _longitud_decorators = [(0, swagger_1.ApiProperty)({ description: 'Longitud de la captura diaria', required: false })];
            _store_id_decorators = [(0, swagger_1.ApiProperty)({ description: 'ID de la tienda asociada (FK stores)', required: false })];
            __esDecorate(null, null, _folio_decorators, { kind: "field", name: "folio", static: false, private: false, access: { has: function (obj) { return "folio" in obj; }, get: function (obj) { return obj.folio; }, set: function (obj, value) { obj.folio = value; } }, metadata: _metadata }, _folio_initializers, _folio_extraInitializers);
            __esDecorate(null, null, _fechaCaptura_decorators, { kind: "field", name: "fechaCaptura", static: false, private: false, access: { has: function (obj) { return "fechaCaptura" in obj; }, get: function (obj) { return obj.fechaCaptura; }, set: function (obj, value) { obj.fechaCaptura = value; } }, metadata: _metadata }, _fechaCaptura_initializers, _fechaCaptura_extraInitializers);
            __esDecorate(null, null, _horaInicio_decorators, { kind: "field", name: "horaInicio", static: false, private: false, access: { has: function (obj) { return "horaInicio" in obj; }, get: function (obj) { return obj.horaInicio; }, set: function (obj, value) { obj.horaInicio = value; } }, metadata: _metadata }, _horaInicio_initializers, _horaInicio_extraInitializers);
            __esDecorate(null, null, _horaFin_decorators, { kind: "field", name: "horaFin", static: false, private: false, access: { has: function (obj) { return "horaFin" in obj; }, get: function (obj) { return obj.horaFin; }, set: function (obj, value) { obj.horaFin = value; } }, metadata: _metadata }, _horaFin_initializers, _horaFin_extraInitializers);
            __esDecorate(null, null, _exhibiciones_decorators, { kind: "field", name: "exhibiciones", static: false, private: false, access: { has: function (obj) { return "exhibiciones" in obj; }, get: function (obj) { return obj.exhibiciones; }, set: function (obj, value) { obj.exhibiciones = value; } }, metadata: _metadata }, _exhibiciones_initializers, _exhibiciones_extraInitializers);
            __esDecorate(null, null, _stats_decorators, { kind: "field", name: "stats", static: false, private: false, access: { has: function (obj) { return "stats" in obj; }, get: function (obj) { return obj.stats; }, set: function (obj, value) { obj.stats = value; } }, metadata: _metadata }, _stats_initializers, _stats_extraInitializers);
            __esDecorate(null, null, _latitud_decorators, { kind: "field", name: "latitud", static: false, private: false, access: { has: function (obj) { return "latitud" in obj; }, get: function (obj) { return obj.latitud; }, set: function (obj, value) { obj.latitud = value; } }, metadata: _metadata }, _latitud_initializers, _latitud_extraInitializers);
            __esDecorate(null, null, _longitud_decorators, { kind: "field", name: "longitud", static: false, private: false, access: { has: function (obj) { return "longitud" in obj; }, get: function (obj) { return obj.longitud; }, set: function (obj, value) { obj.longitud = value; } }, metadata: _metadata }, _longitud_initializers, _longitud_extraInitializers);
            __esDecorate(null, null, _store_id_decorators, { kind: "field", name: "store_id", static: false, private: false, access: { has: function (obj) { return "store_id" in obj; }, get: function (obj) { return obj.store_id; }, set: function (obj, value) { obj.store_id = value; } }, metadata: _metadata }, _store_id_initializers, _store_id_extraInitializers);
            if (_metadata) Object.defineProperty(_a, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        })(),
        _a;
}();
exports.CreateDailyCaptureDto = CreateDailyCaptureDto;
