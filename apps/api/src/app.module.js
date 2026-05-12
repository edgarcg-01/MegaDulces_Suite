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
var __setFunctionName = (this && this.__setFunctionName) || function (f, name, prefix) {
    if (typeof name === "symbol") name = name.description ? "[".concat(name.description, "]") : "";
    return Object.defineProperty(f, "name", { configurable: true, value: prefix ? "".concat(prefix, " ", name) : name });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
var common_1 = require("@nestjs/common");
var config_1 = require("@nestjs/config");
var serve_static_1 = require("@nestjs/serve-static");
var path_1 = require("path");
var app_controller_1 = require("./app.controller");
var app_service_1 = require("./app.service");
var auth_module_1 = require("./modules/auth/auth.module");
var database_module_1 = require("./shared/database/database.module");
var users_module_1 = require("./modules/users/users.module");
var captures_module_1 = require("./modules/captures/captures.module");
var daily_captures_module_1 = require("./modules/daily-captures/daily-captures.module");
var planograms_module_1 = require("./modules/planograms/planograms.module");
var catalogs_module_1 = require("./modules/catalogs/catalogs.module");
var scoring_module_1 = require("./modules/scoring/scoring.module");
var scoring_v2_module_1 = require("./modules/scoring/scoring-v2.module");
var reports_module_1 = require("./modules/reports/reports.module");
var stores_module_1 = require("./modules/stores/stores.module");
var visits_module_1 = require("./modules/visits/visits.module");
var exhibitions_module_1 = require("./modules/exhibitions/exhibitions.module");
var daily_assignments_module_1 = require("./modules/daily-assignments/daily-assignments.module");
var cron_module_1 = require("./modules/cron/cron.module");
var visitas_sync_module_1 = require("./modules/visitas/visitas-sync.module");
var data_module_1 = require("./modules/data/data.module");
var schedule_1 = require("@nestjs/schedule");
var AppModule = function () {
    var _classDecorators = [(0, common_1.Module)({
            imports: [
                config_1.ConfigModule.forRoot({
                    isGlobal: true,
                }),
                serve_static_1.ServeStaticModule.forRoot({
                    rootPath: (0, path_1.join)(__dirname, '..', 'view'),
                    exclude: ['/api/{*path}'],
                }),
                database_module_1.DatabaseModule,
                auth_module_1.AuthModule,
                users_module_1.UsersModule,
                captures_module_1.CapturesModule,
                daily_captures_module_1.DailyCapturesModule,
                planograms_module_1.PlanogramsModule,
                catalogs_module_1.CatalogsModule,
                scoring_module_1.ScoringModule,
                scoring_v2_module_1.ScoringV2Module,
                reports_module_1.ReportsModule,
                stores_module_1.StoresModule,
                visits_module_1.VisitsModule,
                exhibitions_module_1.ExhibitionsModule,
                daily_assignments_module_1.DailyAssignmentsModule,
                cron_module_1.CronModule,
                visitas_sync_module_1.VisitasSyncModule,
                data_module_1.DataModule,
                schedule_1.ScheduleModule.forRoot(),
            ],
            controllers: [app_controller_1.AppController],
            providers: [app_service_1.AppService],
        })];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var AppModule = _classThis = /** @class */ (function () {
        function AppModule_1() {
        }
        return AppModule_1;
    }());
    __setFunctionName(_classThis, "AppModule");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        AppModule = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return AppModule = _classThis;
}();
exports.AppModule = AppModule;
