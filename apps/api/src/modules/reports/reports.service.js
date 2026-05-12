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
exports.ReportsService = void 0;
var common_1 = require("@nestjs/common");
var data_scope_1 = require("../../shared/ability/data-scope");
var ReportsService = function () {
    var _classDecorators = [(0, common_1.Injectable)()];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var ReportsService = _classThis = /** @class */ (function () {
        function ReportsService_1(knex) {
            this.knex = knex;
        }
        ReportsService_1.prototype.getSummary = function () {
            return __awaiter(this, arguments, void 0, function (filters, user) {
                var dcQuery, sQuery, scope, teamIds, zone, teamIds, today, todayQuery, totalDailyToday, totalDaily, totalTiendas, metaDiaria, stats, topPerformer, conceptos, conceptoMap, rows, totalPhotos, furnitureCounts;
                if (filters === void 0) { filters = {}; }
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            dcQuery = this.knex('daily_captures');
                            sQuery = this.knex('stores');
                            scope = (0, data_scope_1.getDataScope)(user);
                            if (!(scope.type === 'own')) return [3 /*break*/, 1];
                            dcQuery = dcQuery.where('user_id', scope.userId);
                            return [3 /*break*/, 3];
                        case 1:
                            if (!(scope.type === 'team')) return [3 /*break*/, 3];
                            if (!(scope.userId && scope.userId !== 'null' && scope.userId !== 'undefined')) return [3 /*break*/, 3];
                            return [4 /*yield*/, this.getTeamIds(scope.userId)];
                        case 2:
                            teamIds = _a.sent();
                            dcQuery = dcQuery.whereIn('user_id', teamIds);
                            _a.label = 3;
                        case 3:
                            if (filters.startDate)
                                dcQuery.whereRaw("DATE(hora_inicio) >= ?", [filters.startDate]);
                            if (filters.endDate)
                                dcQuery.whereRaw("DATE(hora_inicio) <= ?", [filters.endDate]);
                            if (!(filters.zone && filters.zone !== 'null' && filters.zone !== 'undefined')) return [3 /*break*/, 5];
                            return [4 /*yield*/, this.knex('zones').where({ id: filters.zone }).first()];
                        case 4:
                            zone = _a.sent();
                            if (zone && zone.name) {
                                dcQuery.where('zona_captura', String(zone.name));
                            }
                            _a.label = 5;
                        case 5:
                            if (!(filters.supervisorId && filters.supervisorId !== 'null' && filters.supervisorId !== 'undefined')) return [3 /*break*/, 7];
                            return [4 /*yield*/, this.getTeamIds(filters.supervisorId)];
                        case 6:
                            teamIds = _a.sent();
                            dcQuery.whereIn('user_id', teamIds);
                            return [3 /*break*/, 8];
                        case 7:
                            if (filters.userIds && filters.userIds.length > 0 && Array.isArray(filters.userIds)) {
                                dcQuery.whereIn('user_id', filters.userIds);
                            }
                            _a.label = 8;
                        case 8:
                            today = new Date().toISOString().split('T')[0];
                            todayQuery = dcQuery.clone().whereRaw("DATE(hora_inicio) = ?", [today]);
                            return [4 /*yield*/, todayQuery.count('id as count')];
                        case 9:
                            totalDailyToday = (_a.sent())[0];
                            return [4 /*yield*/, dcQuery.clone().count('id as count')];
                        case 10:
                            totalDaily = (_a.sent())[0];
                            return [4 /*yield*/, sQuery.count('id as count')];
                        case 11:
                            totalTiendas = (_a.sent())[0];
                            metaDiaria = 5;
                            return [4 /*yield*/, dcQuery
                                    .clone()
                                    .select(this.knex.raw("SUM((stats->>'totalExhibiciones')::int) as visitas"), this.knex.raw("AVG((stats->>'puntuacionTotal')::float) as avg_score"), this.knex.raw("SUM(COALESCE(NULLIF((stats->>'ventaTotal')::float, 0), (stats->>'ventaAdicional')::float)) as ventas"), this.knex.raw('AVG(EXTRACT(EPOCH FROM (hora_fin - hora_inicio)) / 60) as avg_duration_min'))];
                        case 12:
                            stats = (_a.sent())[0];
                            return [4 /*yield*/, dcQuery
                                    .clone()
                                    .select('captured_by_username')
                                    .select(this.knex.raw("AVG((stats->>'puntuacionTotal')::float) as avg_score"))
                                    .groupBy('captured_by_username')
                                    .orderBy('avg_score', 'desc')
                                    .limit(1)];
                        case 13:
                            topPerformer = (_a.sent())[0];
                            return [4 /*yield*/, this.knex('catalogs')
                                    .where({ catalog_id: 'conceptos' })
                                    .select('id', 'value')];
                        case 14:
                            conceptos = _a.sent();
                            conceptoMap = {};
                            conceptos.forEach(function (c) {
                                conceptoMap[c.id] = c.value.toLowerCase();
                            });
                            return [4 /*yield*/, dcQuery.clone().select('exhibiciones')];
                        case 15:
                            rows = _a.sent();
                            totalPhotos = 0;
                            furnitureCounts = {
                                vitrina: 0,
                                exhibidor: 0,
                                vitroleros: 0,
                                paleteros: 0,
                                tiras: 0,
                                otros: 0,
                            };
                            rows.forEach(function (r) {
                                var exArray = typeof r.exhibiciones === 'string'
                                    ? JSON.parse(r.exhibiciones)
                                    : r.exhibiciones || [];
                                exArray.forEach(function (ex) {
                                    // Get concept name from catalog using conceptoId
                                    var conceptName = conceptoMap[ex.conceptoId] || '';
                                    // Count furniture by concept name
                                    if (conceptName.includes('vitrina'))
                                        furnitureCounts['vitrina']++;
                                    else if (conceptName.includes('exhibidor'))
                                        furnitureCounts['exhibidor']++;
                                    else if (conceptName.includes('vitrolero'))
                                        furnitureCounts['vitroleros']++;
                                    else if (conceptName.includes('paletero'))
                                        furnitureCounts['paleteros']++;
                                    else if (conceptName.includes('tira'))
                                        furnitureCounts['tiras']++;
                                    else
                                        furnitureCounts['otros']++;
                                    // Count photos
                                    if (ex.fotoUrl || ex.foto_url) {
                                        totalPhotos++;
                                    }
                                });
                            });
                            return [2 /*return*/, {
                                    status: 'Calculado Exitosamente',
                                    metricas_globales: {
                                        total_tiendas: Number((totalTiendas === null || totalTiendas === void 0 ? void 0 : totalTiendas.count) || 0),
                                        cierres_diarios_registrados: Number((totalDaily === null || totalDaily === void 0 ? void 0 : totalDaily.count) || 0),
                                        cierres_hoy: Number((totalDailyToday === null || totalDailyToday === void 0 ? void 0 : totalDailyToday.count) || 0),
                                        meta_diaria: metaDiaria,
                                        visitas_totales: Number((stats === null || stats === void 0 ? void 0 : stats.visitas) || 0),
                                        puntuacion_promedio: Math.round(Number((stats === null || stats === void 0 ? void 0 : stats.avg_score) || 0)),
                                        ventas_totales: Number((stats === null || stats === void 0 ? void 0 : stats.ventas) || 0),
                                        avg_duration_min: Number((stats === null || stats === void 0 ? void 0 : stats.avg_duration_min) || 0).toFixed(1),
                                        total_fotos: totalPhotos,
                                        mejor_ejecutivo: (topPerformer === null || topPerformer === void 0 ? void 0 : topPerformer.captured_by_username) || 'N/A',
                                        desglose_muebles: furnitureCounts,
                                    },
                                    generado_el: new Date().toISOString(),
                                }];
                    }
                });
            });
        };
        ReportsService_1.prototype.getDailyCompliance = function (filters, user) {
            return __awaiter(this, void 0, void 0, function () {
                var dcQuery, sQuery, scope, teamIds, zone, teamIds, totalDaily, totalTiendas, stats, conceptos, conceptoMap, rows, totalPhotos, furnitureCounts;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            dcQuery = this.knex('daily_captures');
                            sQuery = this.knex('stores');
                            scope = (0, data_scope_1.getDataScope)(user);
                            if (!(scope.type === 'own')) return [3 /*break*/, 1];
                            dcQuery = dcQuery.where('user_id', scope.userId);
                            return [3 /*break*/, 3];
                        case 1:
                            if (!(scope.type === 'team')) return [3 /*break*/, 3];
                            if (!(scope.userId && scope.userId !== 'null' && scope.userId !== 'undefined')) return [3 /*break*/, 3];
                            return [4 /*yield*/, this.getTeamIds(scope.userId)];
                        case 2:
                            teamIds = _a.sent();
                            dcQuery = dcQuery.whereIn('user_id', teamIds);
                            _a.label = 3;
                        case 3:
                            if (filters.startDate)
                                dcQuery.whereRaw("DATE(hora_inicio) >= ?", [filters.startDate]);
                            if (filters.endDate)
                                dcQuery.whereRaw("DATE(hora_inicio) <= ?", [filters.endDate]);
                            if (!(filters.zone && filters.zone !== 'null' && filters.zone !== 'undefined')) return [3 /*break*/, 5];
                            return [4 /*yield*/, this.knex('zones').where({ id: filters.zone }).first()];
                        case 4:
                            zone = _a.sent();
                            if (zone && zone.name) {
                                dcQuery.where('zona_captura', String(zone.name));
                            }
                            _a.label = 5;
                        case 5:
                            if (!(filters.supervisorId && filters.supervisorId !== 'null' && filters.supervisorId !== 'undefined')) return [3 /*break*/, 7];
                            return [4 /*yield*/, this.getTeamIds(filters.supervisorId)];
                        case 6:
                            teamIds = _a.sent();
                            dcQuery.whereIn('user_id', teamIds);
                            return [3 /*break*/, 8];
                        case 7:
                            if (filters.userIds && filters.userIds.length > 0 && Array.isArray(filters.userIds)) {
                                dcQuery.whereIn('user_id', filters.userIds);
                            }
                            _a.label = 8;
                        case 8: return [4 /*yield*/, dcQuery.clone().count('id as count')];
                        case 9:
                            totalDaily = (_a.sent())[0];
                            return [4 /*yield*/, sQuery.count('id as count')];
                        case 10:
                            totalTiendas = (_a.sent())[0];
                            return [4 /*yield*/, dcQuery.clone().select(this.knex.raw("SUM((stats->>'totalExhibiciones')::int) as visitas"), this.knex.raw("AVG((stats->>'puntuacionTotal')::float) as avg_score"), this.knex.raw("SUM(COALESCE(NULLIF((stats->>'ventaTotal')::float, 0), (stats->>'ventaAdicional')::float)) as ventas"), this.knex.raw('AVG(EXTRACT(EPOCH FROM (hora_fin - hora_inicio)) / 60) as avg_duration_min'))];
                        case 11:
                            stats = (_a.sent())[0];
                            return [4 /*yield*/, this.knex('catalogs')
                                    .where({ catalog_id: 'conceptos' })
                                    .select('id', 'value')];
                        case 12:
                            conceptos = _a.sent();
                            conceptoMap = {};
                            conceptos.forEach(function (c) { conceptoMap[c.id] = c.value.toLowerCase(); });
                            return [4 /*yield*/, dcQuery.clone().select('exhibiciones')];
                        case 13:
                            rows = _a.sent();
                            totalPhotos = 0;
                            furnitureCounts = {
                                vitrina: 0, exhibidor: 0, vitroleros: 0, paleteros: 0, tiras: 0, otros: 0,
                            };
                            rows.forEach(function (r) {
                                var exArray = typeof r.exhibiciones === 'string' ? JSON.parse(r.exhibiciones) : r.exhibiciones || [];
                                exArray.forEach(function (ex) {
                                    var conceptName = conceptoMap[ex.conceptoId] || '';
                                    if (conceptName.includes('vitrina'))
                                        furnitureCounts['vitrina']++;
                                    else if (conceptName.includes('exhibidor'))
                                        furnitureCounts['exhibidor']++;
                                    else if (conceptName.includes('vitrolero'))
                                        furnitureCounts['vitroleros']++;
                                    else if (conceptName.includes('paletero'))
                                        furnitureCounts['paleteros']++;
                                    else if (conceptName.includes('tira'))
                                        furnitureCounts['tiras']++;
                                    else
                                        furnitureCounts['otros']++;
                                    if (ex.fotoUrl || ex.foto_url)
                                        totalPhotos++;
                                });
                            });
                            return [2 /*return*/, {
                                    metricas_diarias: {
                                        cierres_diarios: Number((totalDaily === null || totalDaily === void 0 ? void 0 : totalDaily.count) || 0),
                                        total_tiendas: Number((totalTiendas === null || totalTiendas === void 0 ? void 0 : totalTiendas.count) || 0),
                                        visitas_totales: Number((stats === null || stats === void 0 ? void 0 : stats.visitas) || 0),
                                        puntuacion_promedio: Math.round(Number((stats === null || stats === void 0 ? void 0 : stats.avg_score) || 0)),
                                        ventas_totales: Number((stats === null || stats === void 0 ? void 0 : stats.ventas) || 0),
                                        avg_duration_min: Number((stats === null || stats === void 0 ? void 0 : stats.avg_duration_min) || 0).toFixed(1),
                                        total_fotos: totalPhotos,
                                        desglose_muebles: furnitureCounts,
                                    },
                                    generado_el: new Date().toISOString(),
                                }];
                    }
                });
            });
        };
        ReportsService_1.prototype.getFilteredData = function (filters, user) {
            return __awaiter(this, void 0, void 0, function () {
                var query, scope, teamIds, teamIds, zone, zoneValue, rows, conceptos, conceptoMap, products, brands, productMap, brandMap, normalizedRows, totalVisitas, totalScore, totalVentas, dailyTrend, productStats, exhibidoresHealth, sellerProductStats, allPIDsInExhibiciones, allPIDsInStats, missingPIDs, missingProducts, stillMissing, totalUniqueProducts, avgProductsPerVisit, totalExhibiciones, totalExhibidores, healthRate, metrics, trendData;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            console.log('[ReportsService] getFilteredData called with filters:', filters);
                            console.log('[ReportsService] user role:', user.role_name, 'user sub:', user.sub);
                            query = this.knex('daily_captures as dc')
                                .leftJoin('stores as s', 's.id', 'dc.store_id')
                                .select('dc.*', 's.nombre as cliente_nombre', 's.direccion as cliente_direccion');
                            scope = (0, data_scope_1.getDataScope)(user);
                            if (!(scope.type === 'own')) return [3 /*break*/, 1];
                            query.where('user_id', scope.userId);
                            return [3 /*break*/, 3];
                        case 1:
                            if (!(scope.type === 'team')) return [3 /*break*/, 3];
                            if (!(scope.userId && scope.userId !== 'null' && scope.userId !== 'undefined')) return [3 /*break*/, 3];
                            return [4 /*yield*/, this.getTeamIds(scope.userId)];
                        case 2:
                            teamIds = _a.sent();
                            query.whereIn('user_id', teamIds);
                            _a.label = 3;
                        case 3:
                            if (filters.startDate)
                                query.whereRaw("DATE(hora_inicio) >= ?", [filters.startDate]);
                            if (filters.endDate)
                                query.whereRaw("DATE(hora_inicio) <= ?", [filters.endDate]);
                            if (filters.userId)
                                query.where('user_id', filters.userId);
                            if (!(filters.supervisorId && filters.supervisorId !== 'null' && filters.supervisorId !== 'undefined')) return [3 /*break*/, 5];
                            return [4 /*yield*/, this.getTeamIds(filters.supervisorId)];
                        case 4:
                            teamIds = _a.sent();
                            query.whereIn('user_id', teamIds);
                            return [3 /*break*/, 6];
                        case 5:
                            if (filters.userIds && filters.userIds.length > 0 && Array.isArray(filters.userIds)) {
                                query.whereIn('user_id', filters.userIds);
                            }
                            _a.label = 6;
                        case 6:
                            if (!(filters.zone && filters.zone !== 'null' && filters.zone !== 'undefined')) return [3 /*break*/, 8];
                            return [4 /*yield*/, this.knex('zones').where({ id: filters.zone }).first()];
                        case 7:
                            zone = _a.sent();
                            if (zone && zone.name) {
                                zoneValue = String(zone.name);
                                query.where('zona_captura', zoneValue);
                            }
                            else {
                                // Si no se encuentra la zona, no aplicar filtro
                                console.log('[ReportsService] Zone not found for ID:', filters.zone);
                            }
                            _a.label = 8;
                        case 8:
                            console.log('[ReportsService] SQL Query:', query.toSQL());
                            return [4 /*yield*/, query.orderBy('hora_inicio', 'desc')];
                        case 9:
                            rows = _a.sent();
                            console.log('[ReportsService] Number of rows returned:', rows.length);
                            console.log('[ReportsService] zona_captura values:', rows.map(function (r) { return r.zona_captura; }));
                            return [4 /*yield*/, this.knex('catalogs')
                                    .where({ catalog_id: 'conceptos' })
                                    .select('id', 'value')];
                        case 10:
                            conceptos = _a.sent();
                            conceptoMap = {};
                            conceptos.forEach(function (c) {
                                conceptoMap[c.id] = c.value; // Guardamos el nombre original para display
                            });
                            return [4 /*yield*/, this.knex('products').select('id', 'nombre', 'brand_id')];
                        case 11:
                            products = _a.sent();
                            return [4 /*yield*/, this.knex('brands').select('id', 'nombre')];
                        case 12:
                            brands = _a.sent();
                            productMap = {};
                            brandMap = {};
                            brands.forEach(function (b) { return brandMap[b.id] = b.nombre; });
                            products.forEach(function (p) {
                                productMap[p.id] = {
                                    name: p.nombre,
                                    brandName: brandMap[p.brand_id] || 'Otras'
                                };
                            });
                            // Log productMap for debugging
                            console.log('[ReportsService] productMap keys:', Object.keys(productMap));
                            console.log('[ReportsService] productMap sample:', Object.keys(productMap).slice(0, 5));
                            console.log('[ReportsService] productMap sample with names:', Object.entries(productMap).slice(0, 5).map(function (_a) {
                                var k = _a[0], v = _a[1];
                                return ({ id: k, name: v.name });
                            }));
                            normalizedRows = rows.map(function (row) {
                                var rawStats = typeof row.stats === 'string' ? JSON.parse(row.stats) : row.stats || {};
                                var normalizedStats = __assign(__assign({}, rawStats), { ventaTotal: (rawStats.ventaTotal || 0) > 0 ? rawStats.ventaTotal : (rawStats.ventaAdicional || 0) });
                                return __assign(__assign({}, row), { stats: normalizedStats, exhibiciones: typeof row.exhibiciones === 'string' ? JSON.parse(row.exhibiciones) : row.exhibiciones || [] });
                            });
                            totalVisitas = 0;
                            totalScore = 0;
                            totalVentas = 0;
                            dailyTrend = {};
                            productStats = {};
                            exhibidoresHealth = { optimo: 0, regular: 0, critico: 0 };
                            sellerProductStats = {};
                            allPIDsInExhibiciones = new Set();
                            normalizedRows.forEach(function (row) {
                                var stats = row.stats;
                                var numVisitas = stats.totalExhibiciones || 1;
                                var score = stats.puntuacionTotal || 0;
                                var ventas = stats.ventaTotal || 0;
                                var exhibiciones = row.exhibiciones;
                                totalVisitas += numVisitas;
                                totalScore += score;
                                totalVentas += ventas;
                                var dateKey = row.fecha || (row.hora_inicio instanceof Date
                                    ? row.hora_inicio.toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })
                                    : typeof row.hora_inicio === 'string'
                                        ? row.hora_inicio.split('T')[0]
                                        : '');
                                if (!dailyTrend[dateKey]) {
                                    dailyTrend[dateKey] = { visits: 0, score: 0, count: 0 };
                                }
                                dailyTrend[dateKey].visits += numVisitas;
                                dailyTrend[dateKey].score += score;
                                dailyTrend[dateKey].count += 1;
                                // Product Analysis Aggregation
                                exhibiciones.forEach(function (ex) {
                                    var conceptoId = ex.conceptoId || 'otros';
                                    var conceptoName = conceptoMap[conceptoId] || conceptoId;
                                    var productosMarcados = ex.productosMarcados || [];
                                    var val = ex.nivelEjecucion;
                                    var isOptimo = val === 'excelente' || val === 'optimo' || (typeof val === 'number' && val >= 80);
                                    var isRegular = val === 'medio' || val === 'regular' || (typeof val === 'number' && val >= 50);
                                    if (isOptimo)
                                        exhibidoresHealth.optimo++;
                                    else if (isRegular)
                                        exhibidoresHealth.regular++;
                                    else
                                        exhibidoresHealth.critico++;
                                    productosMarcados.forEach(function (pid) {
                                        if (!productStats[pid]) {
                                            productStats[pid] = { total: 0, exhibidores: {} };
                                        }
                                        productStats[pid].total += 1;
                                        if (!productStats[pid].exhibidores[conceptoName]) {
                                            productStats[pid].exhibidores[conceptoName] = 0;
                                        }
                                        productStats[pid].exhibidores[conceptoName] += 1;
                                        // Collect PID for later mapping
                                        allPIDsInExhibiciones.add(pid);
                                        // Agregar productos por usuario
                                        var userId = row.user_id || row.captured_by;
                                        if (!sellerProductStats[userId]) {
                                            sellerProductStats[userId] = {};
                                        }
                                        if (!sellerProductStats[userId][pid]) {
                                            sellerProductStats[userId][pid] = 0;
                                        }
                                        sellerProductStats[userId][pid] += 1;
                                    });
                                });
                            });
                            allPIDsInStats = Object.keys(productStats);
                            missingPIDs = allPIDsInStats.filter(function (pid) { return !productMap[pid]; });
                            console.log('[ReportsService] PIDs in productStats not in productMap (deleted products):', missingPIDs);
                            console.log('[ReportsService] Total products in productMap:', Object.keys(productMap).length);
                            console.log('[ReportsService] Total PIDs in productStats before filtering:', allPIDsInStats.length);
                            if (!(missingPIDs.length > 0)) return [3 /*break*/, 14];
                            return [4 /*yield*/, this.knex('products')
                                    .whereIn('id', missingPIDs)
                                    .select('id', 'nombre', 'brand_id')];
                        case 13:
                            missingProducts = _a.sent();
                            console.log('[ReportsService] Found missing products in DB:', missingProducts.length);
                            // Add the found products to productMap
                            missingProducts.forEach(function (p) {
                                productMap[p.id] = {
                                    name: p.nombre,
                                    brandName: brandMap[p.brand_id] || 'Otras'
                                };
                                console.log('[ReportsService] Added to productMap:', p.id, '->', p.nombre);
                            });
                            stillMissing = missingPIDs.filter(function (pid) { return !productMap[pid]; });
                            stillMissing.forEach(function (pid) {
                                delete productStats[pid];
                                console.warn('[ReportsService] Removed deleted product from productStats:', pid);
                            });
                            console.log('[ReportsService] Summary: Found', missingProducts.length, 'of', missingPIDs.length, 'missing products');
                            console.log('[ReportsService] Removed', stillMissing.length, 'deleted products from productStats');
                            console.log('[ReportsService] Total PIDs in productStats after filtering:', Object.keys(productStats).length);
                            _a.label = 14;
                        case 14:
                            totalUniqueProducts = Object.keys(productStats).length;
                            avgProductsPerVisit = totalVisitas > 0 ? (totalUniqueProducts / totalVisitas).toFixed(2) : 0;
                            totalExhibiciones = Object.values(productStats).reduce(function (sum, p) { return sum + p.total; }, 0);
                            totalExhibidores = exhibidoresHealth.optimo + exhibidoresHealth.regular + exhibidoresHealth.critico;
                            healthRate = totalExhibidores > 0 ? ((exhibidoresHealth.optimo / totalExhibidores) * 100).toFixed(2) : 0;
                            metrics = {
                                totalVisitas: totalVisitas,
                                avgScore: normalizedRows.length > 0 ? Math.round(totalScore / normalizedRows.length) : 0,
                                totalVentas: totalVentas,
                                avgVentaPorVisita: totalVisitas > 0 ? (totalVentas / totalVisitas).toFixed(2) : 0,
                                count: normalizedRows.length,
                                totalExhibiciones: totalExhibiciones,
                                stockoutRate: avgProductsPerVisit,
                                healthRate: healthRate,
                                uniqueProducts: totalUniqueProducts,
                            };
                            trendData = Object.keys(dailyTrend)
                                .filter(function (date) { return new Date(date + 'T12:00:00Z').getUTCDay() !== 0; })
                                .sort()
                                .map(function (date) { return ({
                                date: date,
                                visits: dailyTrend[date].visits,
                                avgScore: Math.round(dailyTrend[date].score / dailyTrend[date].count),
                            }); });
                            return [2 /*return*/, {
                                    metrics: metrics,
                                    trendData: trendData,
                                    productStats: productStats,
                                    productMap: productMap,
                                    exhibidoresHealth: exhibidoresHealth,
                                    sellerProductStats: sellerProductStats,
                                    rows: normalizedRows,
                                }];
                    }
                });
            });
        };
        ReportsService_1.prototype.exportCsvInBuffer = function (filters, user) {
            return __awaiter(this, void 0, void 0, function () {
                var query, scope, teamIds, teamIds, zone, zoneValue, data, csvString, _i, data_1, row, stats, ventaTotal, fecha;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            query = this.knex('daily_captures').select('*');
                            scope = (0, data_scope_1.getDataScope)(user);
                            if (!(scope.type === 'own')) return [3 /*break*/, 1];
                            query.where('user_id', scope.userId);
                            return [3 /*break*/, 3];
                        case 1:
                            if (!(scope.type === 'team')) return [3 /*break*/, 3];
                            if (!(scope.userId && scope.userId !== 'null' && scope.userId !== 'undefined')) return [3 /*break*/, 3];
                            return [4 /*yield*/, this.getTeamIds(scope.userId)];
                        case 2:
                            teamIds = _a.sent();
                            query.whereIn('user_id', teamIds);
                            _a.label = 3;
                        case 3:
                            if (filters.startDate)
                                query.whereRaw("DATE(hora_inicio) >= ?", [filters.startDate]);
                            if (filters.endDate)
                                query.whereRaw("DATE(hora_inicio) <= ?", [filters.endDate]);
                            if (filters.userId)
                                query.where('user_id', filters.userId);
                            if (!(filters.supervisorId && filters.supervisorId !== 'null' && filters.supervisorId !== 'undefined')) return [3 /*break*/, 5];
                            return [4 /*yield*/, this.getTeamIds(filters.supervisorId)];
                        case 4:
                            teamIds = _a.sent();
                            query.whereIn('user_id', teamIds);
                            return [3 /*break*/, 6];
                        case 5:
                            if (filters.userIds && filters.userIds.length > 0 && Array.isArray(filters.userIds)) {
                                query.whereIn('user_id', filters.userIds);
                            }
                            _a.label = 6;
                        case 6:
                            if (!(filters.zone && filters.zone !== 'null' && filters.zone !== 'undefined')) return [3 /*break*/, 8];
                            return [4 /*yield*/, this.knex('zones').where({ id: filters.zone }).first()];
                        case 7:
                            zone = _a.sent();
                            if (zone && zone.name) {
                                zoneValue = String(zone.name);
                                query.where('zona_captura', zoneValue);
                            }
                            else {
                                // Si no se encuentra la zona, no aplicar filtro
                                console.log('[ReportsService] Zone not found for ID:', filters.zone);
                            }
                            _a.label = 8;
                        case 8: return [4 /*yield*/, query.orderBy('fecha', 'desc')];
                        case 9:
                            data = _a.sent();
                            csvString = 'FOLIO,EJECUTIVO,ZONA,FECHA,VISITAS,SCORE,VENTA\n';
                            for (_i = 0, data_1 = data; _i < data_1.length; _i++) {
                                row = data_1[_i];
                                stats = typeof row.stats === 'string' ? JSON.parse(row.stats) : row.stats || {};
                                ventaTotal = (stats.ventaTotal || 0) > 0 ? stats.ventaTotal : (stats.ventaAdicional || 0);
                                fecha = row.fecha instanceof Date
                                    ? row.fecha.toISOString().split('T')[0]
                                    : row.fecha;
                                csvString += "".concat(row.folio, ",").concat(row.captured_by_username, ",").concat(row.zona_captura, ",").concat(fecha, ",").concat(stats.totalExhibiciones || 0, ",").concat(stats.puntuacionTotal || 0, ",").concat(ventaTotal, "\n");
                            }
                            return [2 /*return*/, csvString];
                    }
                });
            });
        };
        ReportsService_1.prototype.deleteReport = function (id, user) {
            return __awaiter(this, void 0, void 0, function () {
                var report;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.knex('daily_captures').where({ id: id }).first()];
                        case 1:
                            report = _a.sent();
                            if (!report) {
                                throw new Error('Reporte no encontrado');
                            }
                            // Role check: Only superadmin or Permission allowed (controller handles Permission)
                            // Here we just perform the deletion.
                            console.log("[ReportsService] Deleting report ".concat(id, " by user ").concat(user.username));
                            return [4 /*yield*/, this.knex('daily_captures').where({ id: id }).del()];
                        case 2:
                            _a.sent();
                            return [2 /*return*/, { success: true, message: 'Reporte eliminado correctamente' }];
                    }
                });
            });
        };
        ReportsService_1.prototype.getDailyScoresPerUser = function (filters, user) {
            return __awaiter(this, void 0, void 0, function () {
                var dcQuery, scope, teamIds, scopeErr_1, zone, zErr_1, teamIds, tErr_1, ids, validIds, rows, metaDiaria, userMap, _i, rows_1, row, fechaStr, error_1;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            _a.trys.push([0, 18, , 19]);
                            console.log('[ReportsService] START getDailyScoresPerUser', { filters: filters, userSub: user === null || user === void 0 ? void 0 : user.sub });
                            dcQuery = this.knex('daily_captures');
                            // Select with explicit COALESCE to avoid nulls in calculations
                            dcQuery.select('user_id', 'captured_by_username', this.knex.raw("DATE(hora_inicio) as fecha"), this.knex.raw("AVG(COALESCE((stats->>'puntuacionTotal')::float, 0)) as puntuacion"));
                            _a.label = 1;
                        case 1:
                            _a.trys.push([1, 5, , 6]);
                            scope = (0, data_scope_1.getDataScope)(user || { sub: '' });
                            if (!(scope.type === 'own')) return [3 /*break*/, 2];
                            dcQuery.where('user_id', scope.userId || '');
                            return [3 /*break*/, 4];
                        case 2:
                            if (!(scope.type === 'team')) return [3 /*break*/, 4];
                            if (!(scope.userId && scope.userId !== 'null' && scope.userId !== 'undefined' && scope.userId.length > 5)) return [3 /*break*/, 4];
                            return [4 /*yield*/, this.getTeamIds(scope.userId)];
                        case 3:
                            teamIds = _a.sent();
                            if (teamIds.length > 0)
                                dcQuery.whereIn('user_id', teamIds);
                            _a.label = 4;
                        case 4: return [3 /*break*/, 6];
                        case 5:
                            scopeErr_1 = _a.sent();
                            console.error('[ReportsService] Scope check failed:', scopeErr_1.message);
                            return [3 /*break*/, 6];
                        case 6:
                            // Date filtering
                            if (filters.startDate && filters.startDate !== 'null' && filters.startDate !== 'undefined') {
                                dcQuery.whereRaw("DATE(hora_inicio) >= ?", [filters.startDate]);
                            }
                            if (filters.endDate && filters.endDate !== 'null' && filters.endDate !== 'undefined') {
                                dcQuery.whereRaw("DATE(hora_inicio) <= ?", [filters.endDate]);
                            }
                            if (!(filters.zone && filters.zone !== 'null' && filters.zone !== 'undefined' && filters.zone.length > 5)) return [3 /*break*/, 10];
                            _a.label = 7;
                        case 7:
                            _a.trys.push([7, 9, , 10]);
                            return [4 /*yield*/, this.knex('zones').where({ id: filters.zone }).first()];
                        case 8:
                            zone = _a.sent();
                            if (zone && zone.name) {
                                dcQuery.where('zona_captura', String(zone.name));
                            }
                            return [3 /*break*/, 10];
                        case 9:
                            zErr_1 = _a.sent();
                            console.error('[ReportsService] Zone query failed:', zErr_1.message);
                            return [3 /*break*/, 10];
                        case 10:
                            if (!(filters.supervisorId && filters.supervisorId !== 'null' && filters.supervisorId !== 'undefined' && filters.supervisorId.length > 5)) return [3 /*break*/, 15];
                            _a.label = 11;
                        case 11:
                            _a.trys.push([11, 13, , 14]);
                            return [4 /*yield*/, this.getTeamIds(filters.supervisorId)];
                        case 12:
                            teamIds = _a.sent();
                            if (teamIds.length > 0)
                                dcQuery.whereIn('user_id', teamIds);
                            return [3 /*break*/, 14];
                        case 13:
                            tErr_1 = _a.sent();
                            console.error('[ReportsService] Team query failed:', tErr_1.message);
                            return [3 /*break*/, 14];
                        case 14: return [3 /*break*/, 16];
                        case 15:
                            if (filters.userIds && filters.userIds.length > 0) {
                                ids = Array.isArray(filters.userIds) ? filters.userIds : [filters.userIds];
                                validIds = ids.filter(function (id) { return id && id !== 'null' && id !== 'undefined' && id.length > 5; });
                                if (validIds.length > 0)
                                    dcQuery.whereIn('user_id', validIds);
                            }
                            _a.label = 16;
                        case 16:
                            dcQuery.groupBy('user_id', 'captured_by_username', this.knex.raw("DATE(hora_inicio)"));
                            dcQuery.orderBy('captured_by_username', 'asc');
                            dcQuery.orderByRaw("DATE(hora_inicio) asc");
                            console.log('[ReportsService] Executing SQL for Daily Scores');
                            return [4 /*yield*/, dcQuery];
                        case 17:
                            rows = _a.sent();
                            console.log('[ReportsService] Rows fetched:', rows.length);
                            metaDiaria = 5;
                            userMap = new Map();
                            for (_i = 0, rows_1 = rows; _i < rows_1.length; _i++) {
                                row = rows_1[_i];
                                if (!userMap.has(row.user_id)) {
                                    userMap.set(row.user_id, { nombre: row.captured_by_username, scores: [], metaDiaria: metaDiaria });
                                }
                                fechaStr = 'n/a';
                                if (row.fecha) {
                                    fechaStr = row.fecha instanceof Date ? row.fecha.toISOString().split('T')[0] : String(row.fecha);
                                    if (fechaStr.includes('T'))
                                        fechaStr = fechaStr.split('T')[0];
                                }
                                userMap.get(row.user_id).scores.push({
                                    fecha: fechaStr,
                                    puntuacion: Math.round(Number(row.puntuacion) || 0),
                                });
                            }
                            return [2 /*return*/, { users: Array.from(userMap.values()) }];
                        case 18:
                            error_1 = _a.sent();
                            console.error('[ReportsService] Critical error in getDailyScoresPerUser:', error_1);
                            // Return empty to avoid 500 and allow frontend to show "No hay datos"
                            return [2 /*return*/, { users: [] }];
                        case 19: return [2 /*return*/];
                    }
                });
            });
        };
        ReportsService_1.prototype.getTeamIds = function (supervisorId) {
            return __awaiter(this, void 0, void 0, function () {
                var isUuid, team;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            if (!supervisorId || supervisorId === 'null' || supervisorId === 'undefined') {
                                return [2 /*return*/, []];
                            }
                            isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(supervisorId);
                            if (!isUuid)
                                return [2 /*return*/, []];
                            return [4 /*yield*/, this.knex('users')
                                    .select('id')
                                    .where('supervisor_id', supervisorId)
                                    .orWhere('id', supervisorId)];
                        case 1:
                            team = _a.sent();
                            return [2 /*return*/, team.map(function (u) { return u.id; })];
                    }
                });
            });
        };
        ReportsService_1.prototype.getStoresData = function (filters, user) {
            return __awaiter(this, void 0, void 0, function () {
                var query, scope, teamIds, conceptos, conceptoMap, products, brands, brandMap, productMap, rows_3, store, totalScore_1, totalVentas_1, healthCount_1, productStats_1, scoreEvolucion_1, ultimasVisitas_1, visitDates_1, rankedProducts, totalExhibidores, ultimaFecha, diasSinVisita, rows, storeMap, _loop_1, _i, rows_2, row, storesList, oportunidades, scoreSumGlobal, stockoutSumGlobal, tiendasSinVisita7d, _a, _b, s, score, totalExh, healthRate, diasSinVisita, stockoutPct, storeData, storeCount;
                return __generator(this, function (_c) {
                    switch (_c.label) {
                        case 0:
                            console.log('[ReportsService] getStoresData called with filters:', filters);
                            query = this.knex('daily_captures as dc')
                                .join('stores as s', 's.id', 'dc.store_id')
                                .leftJoin('zones as z', 'z.id', 's.zona_id')
                                .whereNotNull('dc.store_id');
                            scope = (0, data_scope_1.getDataScope)(user);
                            if (!(scope.type === 'own')) return [3 /*break*/, 1];
                            query.where('dc.user_id', scope.userId);
                            return [3 /*break*/, 3];
                        case 1:
                            if (!(scope.type === 'team')) return [3 /*break*/, 3];
                            if (!(scope.userId && scope.userId !== 'null' && scope.userId !== 'undefined')) return [3 /*break*/, 3];
                            return [4 /*yield*/, this.getTeamIds(scope.userId)];
                        case 2:
                            teamIds = _c.sent();
                            query.whereIn('dc.user_id', teamIds);
                            _c.label = 3;
                        case 3:
                            if (filters.startDate)
                                query.whereRaw("DATE(dc.hora_inicio) >= ?", [filters.startDate]);
                            if (filters.endDate)
                                query.whereRaw("DATE(dc.hora_inicio) <= ?", [filters.endDate]);
                            if (filters.zone && filters.zone !== 'null' && filters.zone !== 'undefined') {
                                query.where('s.zona_id', filters.zone);
                            }
                            return [4 /*yield*/, this.knex('catalogs')
                                    .where({ catalog_id: 'conceptos' })
                                    .select('id', 'value')];
                        case 4:
                            conceptos = _c.sent();
                            conceptoMap = {};
                            conceptos.forEach(function (c) { conceptoMap[c.id] = c.value; });
                            return [4 /*yield*/, this.knex('products').select('id', 'nombre', 'brand_id')];
                        case 5:
                            products = _c.sent();
                            return [4 /*yield*/, this.knex('brands').select('id', 'nombre')];
                        case 6:
                            brands = _c.sent();
                            brandMap = {};
                            brands.forEach(function (b) { return brandMap[b.id] = b.nombre; });
                            productMap = {};
                            products.forEach(function (p) {
                                productMap[p.id] = { name: p.nombre, brandName: brandMap[p.brand_id] || 'Otras' };
                            });
                            if (!filters.storeId) return [3 /*break*/, 9];
                            // ---- DETAIL VIEW for a single store ----
                            query.where('dc.store_id', filters.storeId);
                            return [4 /*yield*/, query.orderBy('dc.hora_inicio', 'desc')];
                        case 7:
                            rows_3 = _c.sent();
                            return [4 /*yield*/, this.knex('stores as s')
                                    .leftJoin('zones as z', 'z.id', 's.zona_id')
                                    .where('s.id', filters.storeId)
                                    .select('s.id', 's.nombre', 's.direccion', 'z.name as zona', 's.zona_id')
                                    .first()];
                        case 8:
                            store = _c.sent();
                            totalScore_1 = 0;
                            totalVentas_1 = 0;
                            healthCount_1 = { optimo: 0, regular: 0, critico: 0 };
                            productStats_1 = {};
                            scoreEvolucion_1 = {};
                            ultimasVisitas_1 = [];
                            rows_3.forEach(function (row) {
                                var stats = typeof row.stats === 'string' ? JSON.parse(row.stats) : row.stats || {};
                                var score = stats.puntuacionTotal || 0;
                                var ventas = stats.ventaTotal || (stats.ventaAdicional || 0);
                                totalScore_1 += score;
                                totalVentas_1 += ventas;
                                var exhibiciones = typeof row.exhibiciones === 'string'
                                    ? JSON.parse(row.exhibiciones) : row.exhibiciones || [];
                                exhibiciones.forEach(function (ex) {
                                    var val = ex.nivelEjecucion;
                                    if (val === 'excelente' || val === 'optimo' || (typeof val === 'number' && val >= 80))
                                        healthCount_1.optimo++;
                                    else if (val === 'medio' || val === 'regular' || (typeof val === 'number' && val >= 50))
                                        healthCount_1.regular++;
                                    else
                                        healthCount_1.critico++;
                                    (ex.productosMarcados || []).forEach(function (pid) {
                                        if (!productStats_1[pid])
                                            productStats_1[pid] = { total: 0 };
                                        productStats_1[pid].total++;
                                    });
                                });
                                var dateKey = row.hora_inicio instanceof Date
                                    ? row.hora_inicio.toISOString().split('T')[0]
                                    : String(row.hora_inicio).split('T')[0];
                                if (!scoreEvolucion_1[dateKey])
                                    scoreEvolucion_1[dateKey] = { sum: 0, count: 0 };
                                scoreEvolucion_1[dateKey].sum += score;
                                scoreEvolucion_1[dateKey].count++;
                            });
                            visitDates_1 = new Set();
                            rows_3.forEach(function (row) {
                                var dateKey = row.hora_inicio instanceof Date
                                    ? row.hora_inicio.toISOString().split('T')[0]
                                    : String(row.hora_inicio).split('T')[0];
                                if (!visitDates_1.has(dateKey)) {
                                    visitDates_1.add(dateKey);
                                    var stats = typeof row.stats === 'string' ? JSON.parse(row.stats) : row.stats || {};
                                    ultimasVisitas_1.push({
                                        fecha: dateKey,
                                        usuario: row.captured_by_username,
                                        score: stats.puntuacionTotal || 0,
                                    });
                                }
                            });
                            rankedProducts = Object.entries(productStats_1)
                                .map(function (_a) {
                                var _b, _c;
                                var pid = _a[0], st = _a[1];
                                return ({
                                    id: pid,
                                    nombre: ((_b = productMap[pid]) === null || _b === void 0 ? void 0 : _b.name) || 'Producto',
                                    marca: ((_c = productMap[pid]) === null || _c === void 0 ? void 0 : _c.brandName) || '',
                                    presencia: st.total,
                                });
                            })
                                .sort(function (a, b) { return b.presencia - a.presencia; });
                            totalExhibidores = healthCount_1.optimo + healthCount_1.regular + healthCount_1.critico;
                            ultimaFecha = rows_3.length > 0
                                ? (rows_3[0].hora_inicio instanceof Date ? rows_3[0].hora_inicio.toISOString().split('T')[0] : String(rows_3[0].hora_inicio).split('T')[0])
                                : null;
                            diasSinVisita = ultimaFecha
                                ? Math.floor((Date.now() - new Date(ultimaFecha).getTime()) / (1000 * 60 * 60 * 24))
                                : null;
                            return [2 /*return*/, {
                                    store: {
                                        id: store === null || store === void 0 ? void 0 : store.id,
                                        nombre: store === null || store === void 0 ? void 0 : store.nombre,
                                        zona: store === null || store === void 0 ? void 0 : store.zona,
                                        score: rows_3.length > 0 ? Math.round(totalScore_1 / rows_3.length) : 0,
                                        totalVisitas: rows_3.length,
                                        ventaTotal: totalVentas_1,
                                        ultimaVisita: ultimaFecha,
                                        diasSinVisita: diasSinVisita,
                                        healthRate: totalExhibidores > 0 ? {
                                            optimo: +((healthCount_1.optimo / totalExhibidores) * 100).toFixed(1),
                                            regular: +((healthCount_1.regular / totalExhibidores) * 100).toFixed(1),
                                            critico: +((healthCount_1.critico / totalExhibidores) * 100).toFixed(1),
                                        } : { optimo: 0, regular: 0, critico: 0 },
                                        productos: {
                                            top: rankedProducts.slice(0, 5),
                                            bottom: rankedProducts.slice(-5).reverse(),
                                        },
                                        evolucionScore: Object.entries(scoreEvolucion_1)
                                            .sort(function (_a, _b) {
                                            var a = _a[0];
                                            var b = _b[0];
                                            return a.localeCompare(b);
                                        })
                                            .map(function (_a) {
                                            var fecha = _a[0], data = _a[1];
                                            return ({
                                                fecha: fecha,
                                                score: +(data.sum / data.count).toFixed(2),
                                            });
                                        }),
                                        ultimasVisitas: ultimasVisitas_1.slice(0, 10),
                                    },
                                }];
                        case 9: return [4 /*yield*/, query
                                .select('dc.store_id', 's.nombre as store_nombre', 's.zona_id', 'z.name as zona_nombre', 'dc.stats', 'dc.exhibiciones', 'dc.hora_inicio', 'dc.captured_by_username')
                                .orderBy('dc.hora_inicio', 'desc')];
                        case 10:
                            rows = _c.sent();
                            storeMap = new Map();
                            _loop_1 = function (row) {
                                var sid = row.store_id;
                                if (!storeMap.has(sid)) {
                                    storeMap.set(sid, {
                                        id: sid,
                                        nombre: row.store_nombre,
                                        zona: row.zona_nombre,
                                        scoreSum: 0,
                                        scoreCount: 0,
                                        ventaTotal: 0,
                                        visitas: 0,
                                        ultimaVisita: null,
                                        healthCount: { optimo: 0, regular: 0, critico: 0 },
                                        productCount: 0,
                                    });
                                }
                                var s = storeMap.get(sid);
                                var stats = typeof row.stats === 'string' ? JSON.parse(row.stats) : row.stats || {};
                                var score = stats.puntuacionTotal || 0;
                                s.scoreSum += score;
                                s.scoreCount++;
                                s.ventaTotal += stats.ventaTotal || (stats.ventaAdicional || 0);
                                s.visitas++;
                                var fecha = row.hora_inicio instanceof Date
                                    ? row.hora_inicio.toISOString().split('T')[0]
                                    : String(row.hora_inicio).split('T')[0];
                                if (!s.ultimaVisita || fecha > s.ultimaVisita)
                                    s.ultimaVisita = fecha;
                                var exhibiciones = typeof row.exhibiciones === 'string'
                                    ? JSON.parse(row.exhibiciones) : row.exhibiciones || [];
                                exhibiciones.forEach(function (ex) {
                                    var val = ex.nivelEjecucion;
                                    if (val === 'excelente' || val === 'optimo' || (typeof val === 'number' && val >= 80))
                                        s.healthCount.optimo++;
                                    else if (val === 'medio' || val === 'regular' || (typeof val === 'number' && val >= 50))
                                        s.healthCount.regular++;
                                    else
                                        s.healthCount.critico++;
                                    s.productCount += (ex.productosMarcados || []).length;
                                });
                            };
                            for (_i = 0, rows_2 = rows; _i < rows_2.length; _i++) {
                                row = rows_2[_i];
                                _loop_1(row);
                            }
                            storesList = [];
                            oportunidades = [];
                            scoreSumGlobal = 0;
                            stockoutSumGlobal = 0;
                            tiendasSinVisita7d = 0;
                            for (_a = 0, _b = storeMap.values(); _a < _b.length; _a++) {
                                s = _b[_a];
                                score = s.scoreCount > 0 ? Math.round(s.scoreSum / s.scoreCount) : 0;
                                totalExh = s.healthCount.optimo + s.healthCount.regular + s.healthCount.critico;
                                healthRate = totalExh > 0 ? {
                                    optimo: +((s.healthCount.optimo / totalExh) * 100).toFixed(1),
                                    regular: +((s.healthCount.regular / totalExh) * 100).toFixed(1),
                                    critico: +((s.healthCount.critico / totalExh) * 100).toFixed(1),
                                } : { optimo: 0, regular: 0, critico: 0 };
                                diasSinVisita = s.ultimaVisita
                                    ? Math.floor((Date.now() - new Date(s.ultimaVisita).getTime()) / (1000 * 60 * 60 * 24))
                                    : null;
                                stockoutPct = s.visitas > 0
                                    ? +((1 - s.productCount / (s.visitas * 10)) * 100).toFixed(1) // approximate: expected ~10 products per visit
                                    : 0;
                                storeData = {
                                    id: s.id,
                                    nombre: s.nombre,
                                    zona: s.zona,
                                    score: score,
                                    totalVisitas: s.visitas,
                                    ventaTotal: s.ventaTotal,
                                    ultimaVisita: s.ultimaVisita,
                                    diasSinVisita: diasSinVisita,
                                    stockoutRate: Math.min(100, Math.max(0, stockoutPct)),
                                    healthRate: healthRate,
                                };
                                storesList.push(storeData);
                                scoreSumGlobal += score;
                                stockoutSumGlobal += stockoutPct;
                                if (diasSinVisita !== null && diasSinVisita > 7)
                                    tiendasSinVisita7d++;
                                // Detect opportunity stores
                                if (score < 60 || stockoutPct > 30 || (diasSinVisita !== null && diasSinVisita > 7)) {
                                    oportunidades.push(storeData);
                                }
                            }
                            storeCount = storesList.length;
                            return [2 /*return*/, {
                                    stores: storesList,
                                    oportunidades: oportunidades,
                                    kpiGlobales: {
                                        scorePromedio: storeCount > 0 ? Math.round(scoreSumGlobal / storeCount) : 0,
                                        stockoutPromedio: storeCount > 0 ? +(stockoutSumGlobal / storeCount).toFixed(1) : 0,
                                        tiendasSinVisita7d: tiendasSinVisita7d,
                                        totalTiendas: storeCount,
                                    },
                                }];
                    }
                });
            });
        };
        return ReportsService_1;
    }());
    __setFunctionName(_classThis, "ReportsService");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        ReportsService = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return ReportsService = _classThis;
}();
exports.ReportsService = ReportsService;
