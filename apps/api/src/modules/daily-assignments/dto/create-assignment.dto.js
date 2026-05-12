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
exports.CreateAssignmentDto = void 0;
var swagger_1 = require("@nestjs/swagger");
var CreateAssignmentDto = function () {
    var _a;
    var _user_id_decorators;
    var _user_id_initializers = [];
    var _user_id_extraInitializers = [];
    var _route_id_decorators;
    var _route_id_initializers = [];
    var _route_id_extraInitializers = [];
    var _day_of_week_decorators;
    var _day_of_week_initializers = [];
    var _day_of_week_extraInitializers = [];
    var _assigned_by_decorators;
    var _assigned_by_initializers = [];
    var _assigned_by_extraInitializers = [];
    var _status_decorators;
    var _status_initializers = [];
    var _status_extraInitializers = [];
    return _a = /** @class */ (function () {
            function CreateAssignmentDto() {
                this.user_id = __runInitializers(this, _user_id_initializers, void 0);
                this.route_id = (__runInitializers(this, _user_id_extraInitializers), __runInitializers(this, _route_id_initializers, void 0));
                this.day_of_week = (__runInitializers(this, _route_id_extraInitializers), __runInitializers(this, _day_of_week_initializers, void 0));
                this.assigned_by = (__runInitializers(this, _day_of_week_extraInitializers), __runInitializers(this, _assigned_by_initializers, void 0));
                this.status = (__runInitializers(this, _assigned_by_extraInitializers), __runInitializers(this, _status_initializers, void 0));
                __runInitializers(this, _status_extraInitializers);
            }
            return CreateAssignmentDto;
        }()),
        (function () {
            var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            _user_id_decorators = [(0, swagger_1.ApiProperty)({ description: 'ID del colaborador' })];
            _route_id_decorators = [(0, swagger_1.ApiProperty)({ description: 'ID de la ruta (catálogo)' })];
            _day_of_week_decorators = [(0, swagger_1.ApiProperty)({ description: 'Día de la semana (1-7, donde 1=Lunes)' })];
            _assigned_by_decorators = [(0, swagger_1.ApiProperty)({ description: 'ID del supervisor que asigna', required: false })];
            _status_decorators = [(0, swagger_1.ApiProperty)({ description: 'Estado de la asignación', required: false, default: 'pendiente' })];
            __esDecorate(null, null, _user_id_decorators, { kind: "field", name: "user_id", static: false, private: false, access: { has: function (obj) { return "user_id" in obj; }, get: function (obj) { return obj.user_id; }, set: function (obj, value) { obj.user_id = value; } }, metadata: _metadata }, _user_id_initializers, _user_id_extraInitializers);
            __esDecorate(null, null, _route_id_decorators, { kind: "field", name: "route_id", static: false, private: false, access: { has: function (obj) { return "route_id" in obj; }, get: function (obj) { return obj.route_id; }, set: function (obj, value) { obj.route_id = value; } }, metadata: _metadata }, _route_id_initializers, _route_id_extraInitializers);
            __esDecorate(null, null, _day_of_week_decorators, { kind: "field", name: "day_of_week", static: false, private: false, access: { has: function (obj) { return "day_of_week" in obj; }, get: function (obj) { return obj.day_of_week; }, set: function (obj, value) { obj.day_of_week = value; } }, metadata: _metadata }, _day_of_week_initializers, _day_of_week_extraInitializers);
            __esDecorate(null, null, _assigned_by_decorators, { kind: "field", name: "assigned_by", static: false, private: false, access: { has: function (obj) { return "assigned_by" in obj; }, get: function (obj) { return obj.assigned_by; }, set: function (obj, value) { obj.assigned_by = value; } }, metadata: _metadata }, _assigned_by_initializers, _assigned_by_extraInitializers);
            __esDecorate(null, null, _status_decorators, { kind: "field", name: "status", static: false, private: false, access: { has: function (obj) { return "status" in obj; }, get: function (obj) { return obj.status; }, set: function (obj, value) { obj.status = value; } }, metadata: _metadata }, _status_initializers, _status_extraInitializers);
            if (_metadata) Object.defineProperty(_a, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        })(),
        _a;
}();
exports.CreateAssignmentDto = CreateAssignmentDto;
