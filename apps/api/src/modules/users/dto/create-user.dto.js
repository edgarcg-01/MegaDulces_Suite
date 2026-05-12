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
exports.CreateUserDto = void 0;
var swagger_1 = require("@nestjs/swagger");
var CreateUserDto = function () {
    var _a;
    var _username_decorators;
    var _username_initializers = [];
    var _username_extraInitializers = [];
    var _password_decorators;
    var _password_initializers = [];
    var _password_extraInitializers = [];
    var _nombre_decorators;
    var _nombre_initializers = [];
    var _nombre_extraInitializers = [];
    var _zona_decorators;
    var _zona_initializers = [];
    var _zona_extraInitializers = [];
    var _zona_id_decorators;
    var _zona_id_initializers = [];
    var _zona_id_extraInitializers = [];
    var _role_name_decorators;
    var _role_name_initializers = [];
    var _role_name_extraInitializers = [];
    var _supervisor_id_decorators;
    var _supervisor_id_initializers = [];
    var _supervisor_id_extraInitializers = [];
    return _a = /** @class */ (function () {
            function CreateUserDto() {
                this.username = __runInitializers(this, _username_initializers, void 0);
                this.password = (__runInitializers(this, _username_extraInitializers), __runInitializers(this, _password_initializers, void 0));
                this.nombre = (__runInitializers(this, _password_extraInitializers), __runInitializers(this, _nombre_initializers, void 0));
                this.zona = (__runInitializers(this, _nombre_extraInitializers), __runInitializers(this, _zona_initializers, void 0));
                this.zona_id = (__runInitializers(this, _zona_extraInitializers), __runInitializers(this, _zona_id_initializers, void 0));
                this.role_name = (__runInitializers(this, _zona_id_extraInitializers), __runInitializers(this, _role_name_initializers, void 0));
                this.supervisor_id = (__runInitializers(this, _role_name_extraInitializers), __runInitializers(this, _supervisor_id_initializers, void 0));
                __runInitializers(this, _supervisor_id_extraInitializers);
            }
            return CreateUserDto;
        }()),
        (function () {
            var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            _username_decorators = [(0, swagger_1.ApiProperty)({ description: 'Nombre de usuario único' })];
            _password_decorators = [(0, swagger_1.ApiProperty)({ description: 'Contraseña en texto plano' })];
            _nombre_decorators = [(0, swagger_1.ApiProperty)({ description: 'Nombre completo' })];
            _zona_decorators = [(0, swagger_1.ApiProperty)({ description: 'Zona asignada (ej. Norte)' })];
            _zona_id_decorators = [(0, swagger_1.ApiProperty)({ description: 'ID de zona asignada (UUID)' })];
            _role_name_decorators = [(0, swagger_1.ApiProperty)({ description: 'Rol del sistema (superadmin, supervisor_v, colaborador)' })];
            _supervisor_id_decorators = [(0, swagger_1.ApiProperty)({ description: 'ID del supervisor (opcional)', required: false })];
            __esDecorate(null, null, _username_decorators, { kind: "field", name: "username", static: false, private: false, access: { has: function (obj) { return "username" in obj; }, get: function (obj) { return obj.username; }, set: function (obj, value) { obj.username = value; } }, metadata: _metadata }, _username_initializers, _username_extraInitializers);
            __esDecorate(null, null, _password_decorators, { kind: "field", name: "password", static: false, private: false, access: { has: function (obj) { return "password" in obj; }, get: function (obj) { return obj.password; }, set: function (obj, value) { obj.password = value; } }, metadata: _metadata }, _password_initializers, _password_extraInitializers);
            __esDecorate(null, null, _nombre_decorators, { kind: "field", name: "nombre", static: false, private: false, access: { has: function (obj) { return "nombre" in obj; }, get: function (obj) { return obj.nombre; }, set: function (obj, value) { obj.nombre = value; } }, metadata: _metadata }, _nombre_initializers, _nombre_extraInitializers);
            __esDecorate(null, null, _zona_decorators, { kind: "field", name: "zona", static: false, private: false, access: { has: function (obj) { return "zona" in obj; }, get: function (obj) { return obj.zona; }, set: function (obj, value) { obj.zona = value; } }, metadata: _metadata }, _zona_initializers, _zona_extraInitializers);
            __esDecorate(null, null, _zona_id_decorators, { kind: "field", name: "zona_id", static: false, private: false, access: { has: function (obj) { return "zona_id" in obj; }, get: function (obj) { return obj.zona_id; }, set: function (obj, value) { obj.zona_id = value; } }, metadata: _metadata }, _zona_id_initializers, _zona_id_extraInitializers);
            __esDecorate(null, null, _role_name_decorators, { kind: "field", name: "role_name", static: false, private: false, access: { has: function (obj) { return "role_name" in obj; }, get: function (obj) { return obj.role_name; }, set: function (obj, value) { obj.role_name = value; } }, metadata: _metadata }, _role_name_initializers, _role_name_extraInitializers);
            __esDecorate(null, null, _supervisor_id_decorators, { kind: "field", name: "supervisor_id", static: false, private: false, access: { has: function (obj) { return "supervisor_id" in obj; }, get: function (obj) { return obj.supervisor_id; }, set: function (obj, value) { obj.supervisor_id = value; } }, metadata: _metadata }, _supervisor_id_initializers, _supervisor_id_extraInitializers);
            if (_metadata) Object.defineProperty(_a, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        })(),
        _a;
}();
exports.CreateUserDto = CreateUserDto;
