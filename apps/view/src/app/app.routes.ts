import { Routes } from '@angular/router';
import { LoginComponent } from './modules/auth/login/login.component';
import { ProjectsComponent } from './modules/projects/projects/projects.component';
import { LayoutComponent } from './modules/dashboard/layout/layout.component';
import { authGuard } from './core/guards/auth.guard';
import { permissionGuard, anyPermissionGuard, colaboradorGuard, comercialHomeGuard, almacenHomeGuard, logisticaHomeGuard, comprasHomeGuard } from './core/guards/permission.guard';
import { Permission } from './core/constants/permissions';
import { televentaGuard } from './modules/televenta/televenta.guard';
import { repartoGuard } from './modules/reparto/reparto.guard';
import { storeEntryRedirect } from './modules/tienda/tienda.guards';
import { countFocusGuard } from './core/guards/count-focus.guard';
import { unsavedChangesGuard } from './core/guards/unsaved-changes.guard';

export const routes: Routes = [
  {
    path: 'login',
    component: LoginComponent
  },
  {
    path: 'projects',
    canActivate: [authGuard],
    component: ProjectsComponent
  },
  // Diagnostico de un cuelgue en un clic. Sin permiso propio a proposito: cuando algo se
  // traba hay que poder pedirselo a quien lo esta sufriendo, sea quien sea.
  {
    path: 'diagnostico',
    canActivate: [authGuard],
    loadComponent: () => import('./core/errors/diagnostico.component').then(m => m.DiagnosticoComponent),
  },
  // ── Proyecto Trade Marketing / Exhibidores ──────────────────────────
  // Captura PdV, scoring, reportes, seguimiento, planograma, catálogos.
  {
    path: 'dashboard',
    canActivate: [authGuard, colaboradorGuard],
    component: LayoutComponent,
    children: [
      { path: '', loadComponent: () => import('./modules/dashboard/home/home.component').then(m => m.HomeComponent) },
      { path: 'dashboard', loadComponent: () => import('./modules/dashboard/reports/graphics/dashboard.component').then(m => m.DashboardComponent) },
      { path: 'captures', loadComponent: () => import('./modules/dashboard/captures/captures.component').then(m => m.CapturesComponent) },
      { path: 'reports', loadComponent: () => import('./modules/dashboard/reports/reports.component').then(m => m.ReportsComponent) },
      { path: 'seguimiento', loadComponent: () => import('./modules/dashboard/seguimiento/seguimiento.component').then(m => m.SeguimientoComponent), canActivate: [permissionGuard(Permission.VER_SEGUIMIENTO)] },
      { path: 'routes', loadComponent: () => import('./modules/dashboard/routes-analysis/routes-analysis.component').then(m => m.RoutesAnalysisComponent), canActivate: [permissionGuard(Permission.RUTAS_VER)] },
      { path: 'live-map', loadComponent: () => import('./modules/dashboard/live-map/live-map.component').then(m => m.LiveMapComponent), canActivate: [permissionGuard(Permission.RUTAS_VER)] },
      // LTV — Flota de RUTA (camionetas R-NN + vendedor). Dominio Auditoría en Ruta, separado de Logística.
      { path: 'route-tracking', data: { fleet: 'route' }, loadComponent: () => import('../app/modules/logistica/pages/logistica-rastreo.component').then(m => m.LogisticaRastreoComponent), canActivate: [permissionGuard(Permission.RUTAS_VER)] },
      { path: 'route-activity', data: { fleet: 'route' }, loadComponent: () => import('../app/modules/logistica/pages/logistica-actividad.component').then(m => m.LogisticaActividadComponent), canActivate: [permissionGuard(Permission.RUTAS_VER)] },
      { path: 'route-compliance', loadComponent: () => import('../app/modules/logistica/pages/logistica-auditoria-ruta.component').then(m => m.LogisticaAuditoriaRutaComponent), canActivate: [permissionGuard(Permission.RUTAS_VER)] },
      // Hub "Auditoría de ruta" (camionetas de ruta): Cumplimiento + Rastreo + Actividad en tabs ruteadas.
      {
        path: 'route-audit',
        loadComponent: () => import('./shared/components/tab-shell/tab-shell.component').then(m => m.TabShellComponent),
        canActivate: [permissionGuard(Permission.RUTAS_VER)],
        data: { tabs: [
          { label: 'Cumplimiento', path: 'cumplimiento', icon: 'pi-check-circle' },
          { label: 'Rastreo en vivo', path: 'rastreo', icon: 'pi-map-marker' },
          { label: 'Actividad', path: 'actividad', icon: 'pi-chart-bar' },
        ] },
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'cumplimiento' },
          { path: 'cumplimiento', loadComponent: () => import('../app/modules/logistica/pages/logistica-auditoria-ruta.component').then(m => m.LogisticaAuditoriaRutaComponent) },
          { path: 'rastreo', data: { fleet: 'route' }, loadComponent: () => import('../app/modules/logistica/pages/logistica-rastreo.component').then(m => m.LogisticaRastreoComponent) },
          { path: 'actividad', data: { fleet: 'route' }, loadComponent: () => import('../app/modules/logistica/pages/logistica-actividad.component').then(m => m.LogisticaActividadComponent) },
        ],
      },
      { path: 'field-map', loadComponent: () => import('./modules/dashboard/field-map/field-map.component').then(m => m.FieldMapComponent), canActivate: [permissionGuard(Permission.RUTAS_VER)] },
      { path: 'vendor-history', loadComponent: () => import('./modules/dashboard/vendor-history/vendor-history.component').then(m => m.VendorHistoryComponent), canActivate: [permissionGuard(Permission.RUTAS_VER)] },
      { path: 'commercial-map', loadComponent: () => import('./modules/dashboard/commercial-map/commercial-map.component').then(m => m.CommercialMapComponent), canActivate: [permissionGuard(Permission.COMMERCIAL_MAP_VER)] },
      { path: 'supervisor-ai', loadComponent: () => import('./modules/dashboard/supervisor-ai/supervisor-ai.component').then(m => m.SupervisorAiComponent), canActivate: [permissionGuard(Permission.SUPERVISOR_AI_VER)] },
      { path: 'supervisor-ai/chat', loadComponent: () => import('./modules/dashboard/supervisor-ai/supervisor-ai-chat.component').then(m => m.SupervisorAiChatComponent), canActivate: [permissionGuard(Permission.SUPERVISOR_AI_VER)] },
      { path: 'supervisor-ai/route-optimization', loadComponent: () => import('./modules/dashboard/supervisor-ai/route-optimization.component').then(m => m.RouteOptimizationComponent), canActivate: [permissionGuard(Permission.SUPERVISOR_AI_VER)] },
      { path: 'supervisor-ai/route-balance', loadComponent: () => import('./modules/dashboard/supervisor-ai/route-balance.component').then(m => m.RouteBalanceComponent), canActivate: [permissionGuard(Permission.SUPERVISOR_AI_VER)] },
      { path: 'stores', loadComponent: () => import('./modules/dashboard/stores/stores.component').then(m => m.StoresComponent), canActivate: [permissionGuard(Permission.TIENDAS_VER)] },
      { path: 'visits', loadComponent: () => import('./modules/dashboard/visits/visits.component').then(m => m.VisitsComponent) },
      { path: 'exhibitions', loadComponent: () => import('./modules/dashboard/exhibitions/exhibitions.component').then(m => m.ExhibitionsComponent) },
      {
        // Catálogos de captura (conceptos, ubicaciones, niveles, zonas) — siguen en Trade Marketing.
        path: 'admin/catalogs/:type',
        loadComponent: () => import('./modules/dashboard/admin-catalogs/admin-catalogs.component').then(m => m.AdminCatalogsComponent),
        canActivate: [permissionGuard(Permission.CATALOGO_GESTIONAR)]
      },
      {
        path: 'admin/scoring',
        loadComponent: () => import('./modules/dashboard/admin-scoring/admin-scoring.component').then(m => m.AdminScoringComponent),
        canActivate: [permissionGuard(Permission.SCORING_CONFIG_VER)]
      },
      {
        path: 'admin/planograma',
        loadComponent: () => import('./modules/dashboard/admin-planograma/admin-planograma.component').then(m => m.AdminPlanogramaComponent),
        canActivate: [permissionGuard(Permission.PLANOGRAMAS_GESTIONAR)]
      },
      {
        path: 'daily-assignments',
        loadComponent: () => import('./modules/dashboard/daily-assignments/daily-assignments.component').then(m => m.DailyAssignmentsComponent),
        canActivate: [permissionGuard(Permission.TRADE_ROUTE_PLAN_VER)]
      },
    ]
  },
  // ── Proyecto Comercial / Venta ──────────────────────────────────────
  // B2B, pedidos, clientes, almacenes, pricing, inventario, analytics commercial.
  // Reusa LayoutComponent (mismo shell) — el nav se ajusta vía URL prefix.
  {
    path: 'comercial',
    canActivate: [authGuard],
    component: LayoutComponent,
    children: [
      // Landing dinámico: comercialHomeGuard devuelve un UrlTree a la primera
      // superficie accesible del rol (command-center, orders, …, sell-out). El
      // loadComponent nunca corre porque el guard siempre redirige.
      {
        path: '',
        pathMatch: 'full',
        canActivate: [comercialHomeGuard],
        loadComponent: () => import('./modules/dashboard/command-center/command-center.component').then(m => m.CommandCenterComponent),
      },
      {
        path: 'command-center',
        loadComponent: () => import('./modules/dashboard/command-center/command-center.component').then(m => m.CommandCenterComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_ANALYTICS_VER)]
      },
      {
        path: 'customers',
        loadComponent: () => import('./modules/comercial/pages/comercial-customers.component').then(m => m.ComercialCustomersComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_CUSTOMERS_VER)]
      },
      {
        // V.0 — cartera de ventas: supervisor asigna rutas a vendedores + orden de visita.
        path: 'cartera',
        loadComponent: () => import('./modules/comercial/pages/comercial-cartera.component').then(m => m.ComercialCarteraComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_CARTERA_VER)]
      },
      {
        path: 'orders',
        loadComponent: () => import('./modules/comercial/pages/comercial-orders.component').then(m => m.ComercialOrdersComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_ORDERS_VER)],
        data: { mode: 'pending' }
      },
      {
        path: 'orders/history',
        loadComponent: () => import('./modules/comercial/pages/comercial-orders.component').then(m => m.ComercialOrdersComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_ORDERS_VER)],
        data: { mode: 'history' }
      },
      {
        path: 'orders/:id',
        loadComponent: () => import('./modules/comercial/pages/comercial-order-detail.component').then(m => m.ComercialOrderDetailComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_ORDERS_VER)]
      },
      // Inventario/almacén vive ahora en el proyecto Almacén (/almacen/*).
      // Redirects prefix: /comercial/inventory/** → /almacen/inventory/** (deep-links viejos siguen).
      { path: 'inventory', redirectTo: '/almacen/inventory' },
      { path: 'warehouses', redirectTo: '/almacen/warehouses' },
      { path: 'dead-stock', redirectTo: '/almacen/dead-stock' },
      { path: 'inventory-health', redirectTo: '/almacen/inventory-health' },
      {
        path: 'customers-360',
        loadComponent: () => import('./modules/comercial/pages/comercial-customers-360.component').then(m => m.ComercialCustomers360Component),
        canActivate: [permissionGuard(Permission.COMMERCIAL_CUSTOMERS360_VER)]
      },
      {
        path: 'erp-promos',
        loadComponent: () => import('./modules/comercial/pages/comercial-erp-promos.component').then(m => m.ComercialErpPromosComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_ERP_PROMOS_VER)]
      },
      {
        path: 'sell-out',
        loadComponent: () => import('./modules/comercial/pages/comercial-sell-out.component').then(m => m.ComercialSellOutComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_SELLOUT_VER)]
      },
      {
        path: 'salidas',
        loadComponent: () => import('./modules/comercial/pages/comercial-salidas.component').then(m => m.ComercialSalidasComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_SALIDAS_VER)]
      },
      {
        // Fase VG — Ventas Generales: tablero de venta global por (métrica × dimensión × rango).
        path: 'ventas-generales',
        loadComponent: () => import('./modules/comercial/pages/ventas-generales.component').then(m => m.VentasGeneralesComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_ANALYTICS_VER)]
      },
      {
        path: 'wincaja',
        loadComponent: () => import('./modules/comercial/pages/comercial-wincaja.component').then(m => m.ComercialWincajaComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_ANALYTICS_VER)]
      },
      {
        path: 'ventas-por-ruta',
        loadComponent: () => import('./modules/comercial/pages/comercial-ventas-por-ruta.component').then(m => m.ComercialVentasPorRutaComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_ROUTE_SALES_VER)]
      },
      {
        // AX.2 — facturas de venta (vistas en vivo sobre kepler_ods) + anexo imprimible
        path: 'documentos',
        loadComponent: () => import('./modules/comercial/pages/comercial-documentos.component').then(m => m.ComercialDocumentosComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_SALES_DOCS_VER)]
      },
      // Egresos vive ahora en el proyecto Finanzas (deep-links viejos siguen funcionando).
      { path: 'egresos', redirectTo: '/finanzas/egresos' },
      { path: 'egresos/detalle', redirectTo: '/finanzas/egresos/detalle' },
      {
        path: 'thot-chat',
        loadComponent: () => import('./modules/comercial/pages/comercial-thot-chat.component').then(m => m.ComercialThotChatComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_THOT_VER)]
      },
      {
        path: 'thot-curation',
        loadComponent: () => import('./modules/comercial/pages/comercial-thot-curation.component').then(m => m.ComercialThotCurationComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_THOT_GESTIONAR)]
      },
      {
        path: 'razonamiento',
        loadComponent: () => import('./modules/comercial/pages/comercial-razonamiento.component').then(m => m.ComercialRazonamientoComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_THOT_VER)]
      },
      {
        // Fase MR — Motor de Rentabilidad: cascada de margen sobre venta real.
        path: 'rentabilidad',
        loadComponent: () => import('./modules/comercial/pages/comercial-rentabilidad.component').then(m => m.ComercialRentabilidadComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_ANALYTICS_VER)]
      },
      {
        path: 'pricing',
        loadComponent: () => import('./modules/comercial/pages/comercial-pricing.component').then(m => m.ComercialPricingComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_PRICING_VER)]
      },
      {
        // Sprint M.7 — catálogo de productos admin (data Mega_Dulces enriquecida)
        path: 'products',
        loadComponent: () => import('./modules/comercial/pages/comercial-products.component').then(m => m.ComercialProductsComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_PRODUCTS_VER)]
      },
      {
        path: 'promotions',
        loadComponent: () => import('./modules/comercial/pages/comercial-promotions.component').then(m => m.ComercialPromotionsComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_PROMOTIONS_VER)]
      },
      {
        // Thot T.2 — empuje dirigido (marca foco): el negocio decide qué empujar.
        path: 'empuje',
        loadComponent: () => import('./modules/comercial/pages/comercial-thot-directives.component').then(m => m.ComercialThotDirectivesComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_PROMOTIONS_GESTIONAR)]
      },
      {
        // Sprint M.3: ventas históricas del ERP Mega_Dulces vía FDW (read-only).
        path: 'historical',
        loadComponent: () => import('./modules/dashboard/historical-analytics/historical-analytics.component').then(m => m.HistoricalAnalyticsComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_HISTORICAL_VER)]
      },
      {
        // Cierre de ruta: control de tickets venta/carga/combustible de vendedores.
        path: 'route-tickets',
        loadComponent: () => import('./modules/comercial/pages/comercial-route-tickets.component').then(m => m.ComercialRouteTicketsComponent),
        canActivate: [permissionGuard(Permission.ROUTE_CONTROL_VER)]
      },
      {
        // Ventas de vendedor: parte comercial del ticket OCR de la captura.
        path: 'vendor-sales',
        loadComponent: () => import('./modules/comercial/pages/comercial-vendor-sales.component').then(m => m.ComercialVendorSalesComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_VENDOR_SALES_VER)]
      },
    ]
  },
  // ── Proyecto Logística (Fase J) ─────────────────────────────────────
  // Embarques, flotilla, costos, liquidaciones. Reusa LayoutComponent.
  // ── Proyecto Finanzas ───────────────────────────────────────────────
  // Egresos contables (pólizas 5xx/6xx), documentos y CxP. Separado de Ventas:
  // un rol contable no arrastra permisos comerciales. Reusa LayoutComponent.
  {
    path: 'finanzas',
    canActivate: [authGuard],
    component: LayoutComponent,
    children: [
      { path: '', redirectTo: 'egresos', pathMatch: 'full' },
      {
        path: 'egresos',
        loadComponent: () => import('./modules/comercial/pages/comercial-egresos.component').then(m => m.ComercialEgresosComponent),
        canActivate: [permissionGuard(Permission.FINANCE_EXPENSES_VER)]
      },
      {
        path: 'egresos/detalle',
        loadComponent: () => import('./modules/comercial/pages/comercial-egreso-detalle.component').then(m => m.ComercialEgresoDetalleComponent),
        canActivate: [permissionGuard(Permission.FINANCE_EXPENSES_VER)]
      },
      {
        path: 'bancos',
        loadComponent: () => import('./modules/finanzas/pages/finanzas-bancos.component').then(m => m.FinanzasBancosComponent),
        canActivate: [permissionGuard(Permission.FINANCE_BANK_VER)]
      },
      {
        path: 'solicitudes',
        loadComponent: () => import('./modules/finanzas/pages/finanzas-solicitudes.component').then(m => m.FinanzasSolicitudesComponent),
        canActivate: [permissionGuard(Permission.FINANCE_EXPENSES_VER)]
      },
      {
        // GX.8 — Captura (capturista): solo folio + subir comprobante. Sin bandeja de revisión.
        // Las bandejas "Reembolsos" y "Comprobación de gastos" se retiraron el 2026-08-21:
        // sólo servían para re-capturar datos que Kepler ya tiene. El tablero del autorizador
        // es /finanzas/solicitudes, con el expediente y la captura como organismos encima.
        path: 'capturar-gasto',
        loadComponent: () => import('./modules/finanzas/pages/finanzas-capturar-gasto.component').then(m => m.FinanzasCapturarGastoComponent),
        canActivate: [permissionGuard(Permission.FINANCE_EXPENSES_CAPTURAR)]
      },
      {
        path: 'cobranza',
        loadComponent: () => import('./modules/finanzas/pages/finanzas-cobranza.component').then(m => m.FinanzasCobranzaComponent),
        canActivate: [permissionGuard(Permission.FINANCE_COLLECTIONS_VER)]
      },
      {
        // LC — el trámite del libro de compras: se arma aquí y a ContPAQi solo va el TXT.
        path: 'libro-de-compras',
        loadComponent: () => import('./modules/finanzas/pages/libro-compras/libro-compras.component').then(m => m.LibroComprasComponent),
        canActivate: [permissionGuard(Permission.FINANCE_PURCHASE_BOOK_VER)]
      },
      {
        path: 'cartera',
        loadComponent: () => import('./modules/finanzas/pages/finanzas-cartera.component').then(m => m.FinanzasCarteraComponent),
        canActivate: [permissionGuard(Permission.FINANCE_RECEIVABLES_VER)]
      },
      {
        path: 'pagos-comprobantes',
        loadComponent: () => import('./modules/finanzas/pages/finanzas-pagos-comprobantes.component').then(m => m.FinanzasPagosComprobantesComponent),
        canActivate: [permissionGuard(Permission.FINANCE_PAYMENTS_VER)]
      },
      {
        // CXP.7 — Cuadre y deuda por proveedor (CxP/Tesorería): estado de cuenta 201 Kepler +
        // deuda real ContPAQi 2120. Vive en Finanzas (el componente sigue en modules/compras
        // porque consume ComprasService). Antes en /compras/cuadre-proveedor (redirect abajo).
        path: 'cuadre-proveedor',
        loadComponent: () => import('./modules/compras/pages/compras-cuadre-proveedor.component').then(m => m.ComprasCuadreProveedorComponent),
        canActivate: [permissionGuard(Permission.FINANCE_PAYMENTS_VER)]
      },
      {
        // PP.3 — Programa de Pagos (Tesorería): espejo del Excel de pagos.
        path: 'programa-pagos',
        loadComponent: () => import('./modules/finanzas/pages/finanzas-programa-pagos.component').then(m => m.FinanzasProgramaPagosComponent),
        canActivate: [permissionGuard(Permission.FINANCE_PAYMENTS_VER)]
      },
      {
        // CG.4 — Caja General (Tesorería): venta diaria → depósito + arqueo + conciliación CB.
        path: 'caja',
        loadComponent: () => import('./modules/finanzas/pages/finanzas-caja.component').then(m => m.FinanzasCajaComponent),
        canActivate: [permissionGuard(Permission.FINANCE_BANK_VER)]
      },
      {
        path: 'maat',
        loadComponent: () => import('./modules/finanzas/pages/finanzas-maat-chat.component').then(m => m.FinanzasMaatChatComponent),
        canActivate: [permissionGuard(Permission.FINANCE_AI_CHAT)]
      },
      {
        path: 'hallazgos',
        loadComponent: () => import('./modules/finanzas/pages/finanzas-hallazgos.component').then(m => m.FinanzasHallazgosComponent),
        canActivate: [permissionGuard(Permission.FINANCE_AI_CHAT)]
      },
      {
        path: 'pagos-control',
        loadComponent: () => import('./modules/finanzas/pages/finanzas-pagos-control.component').then(m => m.FinanzasPagosControlComponent),
        canActivate: [permissionGuard(Permission.FINANCE_AI_CHAT)]
      },
      {
        path: 'tareas',
        loadComponent: () => import('./modules/finanzas/pages/finanzas-tareas.component').then(m => m.FinanzasTareasComponent),
        canActivate: [permissionGuard(Permission.FINANCE_BANK_VER)]
      },
    ]
  },
  // ── Proyecto Contabilidad (Fase FISCAL) ─────────────────────────────
  // Cumplimiento SAT / CFDI: listas negras, almacén CFDI, conciliación, DIOT,
  // descarga masiva, materialidad, contabilidad electrónica, impuestos, e.firma.
  // Separado de Finanzas. Reusa LayoutComponent; nav por URL prefix.
  {
    path: 'contabilidad',
    canActivate: [authGuard],
    component: LayoutComponent,
    children: [
      { path: '', redirectTo: 'listas-sat', pathMatch: 'full' },
      {
        path: 'listas-sat',
        loadComponent: () => import('./modules/contabilidad/pages/contabilidad-listas-sat.component').then(m => m.ContabilidadListasSatComponent),
        canActivate: [permissionGuard(Permission.FISCAL_LISTAS_VER)]
      },
      {
        path: 'cfdi',
        loadComponent: () => import('./modules/contabilidad/pages/contabilidad-cfdi.component').then(m => m.ContabilidadCfdiComponent),
        canActivate: [permissionGuard(Permission.FISCAL_CFDI_VER)]
      },
      {
        path: 'facturar',
        loadComponent: () => import('./modules/contabilidad/pages/contabilidad-facturar.component').then(m => m.ContabilidadFacturarComponent),
        canActivate: [permissionGuard(Permission.FISCAL_FACTURAR_VER)]
      },
      {
        path: 'diagnostico',
        loadComponent: () => import('./modules/contabilidad/pages/contabilidad-diagnostico.component').then(m => m.ContabilidadDiagnosticoComponent),
        canActivate: [permissionGuard(Permission.FISCAL_FACTURAR_VER)]
      },
      {
        path: 'conciliacion',
        loadComponent: () => import('./modules/contabilidad/pages/contabilidad-conciliacion.component').then(m => m.ContabilidadConciliacionComponent),
        canActivate: [permissionGuard(Permission.FISCAL_CONCILIACION_VER)]
      },
      {
        path: 'diot',
        loadComponent: () => import('./modules/contabilidad/pages/contabilidad-diot.component').then(m => m.ContabilidadDiotComponent),
        canActivate: [permissionGuard(Permission.FISCAL_DIOT_VER)]
      },
      {
        path: 'descarga',
        loadComponent: () => import('./modules/contabilidad/pages/contabilidad-descarga.component').then(m => m.ContabilidadDescargaComponent),
        canActivate: [permissionGuard(Permission.FISCAL_DESCARGA_VER)]
      },
      {
        path: 'materialidad',
        loadComponent: () => import('./modules/contabilidad/pages/contabilidad-materialidad.component').then(m => m.ContabilidadMaterialidadComponent),
        canActivate: [permissionGuard(Permission.FISCAL_LISTAS_VER)]
      },
      {
        path: 'contabilidad',
        loadComponent: () => import('./modules/contabilidad/pages/contabilidad-contabilidad.component').then(m => m.ContabilidadContabilidadComponent),
        canActivate: [permissionGuard(Permission.FISCAL_CONTAB_VER)]
      },
      {
        path: 'contpaqi',
        loadComponent: () => import('./modules/contabilidad/pages/contabilidad-contpaqi.component').then(m => m.ContabilidadContpaqiComponent),
        canActivate: [permissionGuard(Permission.FISCAL_CONTAB_VER)]
      },
      {
        path: 'polizas',
        loadComponent: () => import('./modules/contabilidad/pages/contabilidad-polizas.component').then(m => m.ContabilidadPolizasComponent),
        canActivate: [permissionGuard(Permission.FISCAL_CONTAB_VER)]
      },
      {
        path: 'impuestos',
        loadComponent: () => import('./modules/contabilidad/pages/contabilidad-impuestos.component').then(m => m.ContabilidadImpuestosComponent),
        canActivate: [permissionGuard(Permission.FISCAL_DIOT_VER)]
      },
      {
        path: 'credenciales',
        loadComponent: () => import('./modules/contabilidad/pages/contabilidad-credenciales.component').then(m => m.ContabilidadCredencialesComponent),
        canActivate: [permissionGuard(Permission.FISCAL_CREDENCIALES_GESTIONAR)]
      },
    ]
  },
  // ── Proyecto Compras (Fase RA — ADR-030) ────────────────────────────
  // Reabastecimiento: existencia crítica, punto de reorden, sugerido de compra
  // y requisiciones (HITL). Reusa LayoutComponent; nav por URL prefix.
  {
    path: 'compras',
    canActivate: [authGuard],
    component: LayoutComponent,
    children: [
      // Landing dinámico: aterriza en la primera vista accesible del rol (no fijo a Pedido).
      {
        path: '',
        pathMatch: 'full',
        canActivate: [comprasHomeGuard],
        loadComponent: () => import('./modules/compras/pages/compras-pedido-real.component').then(m => m.ComprasPedidoRealComponent),
      },
      {
        // RA-PRO.17 — Pedido UNIFICADO (demand-driven + requisición + export + stock muerto).
        // Fusiona las 3 vistas previas: pedido(que-toca) + compra-sugerida + existencia-critica.
        path: 'pedido',
        loadComponent: () => import('./modules/compras/pages/compras-pedido-real.component').then(m => m.ComprasPedidoRealComponent),
        canActivate: [permissionGuard(Permission.COMPRAS_PEDIDO_VER)],
        canDeactivate: [unsavedChangesGuard]
      },
      { path: 'que-toca', redirectTo: 'pedido', pathMatch: 'full' },
      { path: 'pedido-real', redirectTo: 'pedido', pathMatch: 'full' },        // fusionada en Pedido
      { path: 'existencia-critica', redirectTo: 'pedido', pathMatch: 'full' }, // fusionada en Pedido
      {
        path: 'asistente',
        loadComponent: () => import('./modules/compras/pages/compras-asistente.component').then(m => m.ComprasAsistenteComponent),
        canActivate: [permissionGuard(Permission.COMPRAS_PEDIDO_GESTIONAR)]
      },
      {
        path: 'requisiciones',
        loadComponent: () => import('./modules/compras/pages/compras-requisiciones.component').then(m => m.ComprasRequisicionesComponent),
        canActivate: [permissionGuard(Permission.COMPRAS_REQUISICIONES_VER)]
      },
      {
        path: 'hallazgos',
        loadComponent: () => import('./modules/compras/pages/compras-hallazgos.component').then(m => m.ComprasHallazgosComponent),
        canActivate: [permissionGuard(Permission.COMPRAS_HALLAZGOS_VER)]
      },
      {
        // RA-PRO.45 — la vista inversa del "En camino" del Pedido: las OCs de Kepler que quedaron
        // abiertas. Mismo permiso que Pedido porque es la otra cara del mismo dato.
        path: 'oc-abiertas',
        loadComponent: () => import('./modules/compras/pages/compras-oc-abiertas.component').then(m => m.ComprasOcAbiertasComponent),
        canActivate: [permissionGuard(Permission.COMPRAS_PEDIDO_VER)]
      },
      {
        path: 'proveedores',
        loadComponent: () => import('./modules/compras/pages/compras-proveedores.component').then(m => m.ComprasProveedoresComponent),
        canActivate: [permissionGuard(Permission.COMPRAS_PROVEEDORES_VER)]
      },
      {
        path: 'red',
        loadComponent: () => import('./modules/compras/pages/compras-red.component').then(m => m.ComprasRedComponent),
        canActivate: [permissionGuard(Permission.COMPRAS_RED_VER)]
      },
      {
        // RE.13.1 — "Mis pendientes": la worklist del capturista de sucursal (scopeada por
        // alcance, lo más viejo primero, con cámara). Es la puerta del proceso.
        //
        // RE.16.9 — pide GESTIONAR, no VER: acá TODO lo que se puede hacer (OCR, adjuntar,
        // lote) exige GESTIONAR en el backend. Con VER a secas la pantalla se abría entera y
        // el 403 llegaba recién al soltar el PDF. `direccion` ya está en ese caso hoy
        // (VER sí, GESTIONAR no). El que sólo observa entra por el Centro de control.
        path: 'entradas',
        loadComponent: () => import('./modules/compras/pages/compras-entradas-pendientes.component').then(m => m.ComprasEntradasPendientesComponent),
        canActivate: [permissionGuard(Permission.COMPRAS_ENTRADAS_GESTIONAR)],
        // RE.17.2 — la bandeja de PDFs ya leídos por OCR no vive en el servidor hasta que se
        // envía: salir sin avisar tira el trabajo (y las llamadas de visión ya pagadas).
        canDeactivate: [unsavedChangesGuard]
      },
      {
        // RE.13.2 — bandeja de revisión: la cola del revisor (central o local, lo resuelve el
        // alcance). Permiso propio: VALIDAR no lo tiene el capturista.
        path: 'entradas/revision',
        loadComponent: () => import('./modules/compras/pages/compras-entradas-revision.component').then(m => m.ComprasEntradasRevisionComponent),
        canActivate: [permissionGuard(Permission.COMPRAS_ENTRADAS_VALIDAR)]
      },

      {
        // RE.3 — el calendario de pago. Permiso de LECTURA de entradas: es una vista derivada
        // del vencimiento que ya trae la orden, no una operación sobre dinero.
        path: 'vencimientos',
        loadComponent: () => import('./modules/compras/pages/compras-vencimientos.component').then(m => m.ComprasVencimientosComponent),
        canActivate: [permissionGuard(Permission.COMPRAS_ENTRADAS_VER)]
      },

      // ── RE.16 — Centro de control: lo que el administrador OBSERVA, en 4 pestañas ────────
      // Antes eran items de sidebar sueltos y se leían como módulos distintos. Las rutas
      // viejas quedan como redirect: hay links pegados en chats y en Compras 360.
      {
        // RE.16.2 — cobertura por sucursal + quién tiene permiso de subir en cada una.
        path: 'entradas/control',
        loadComponent: () => import('./modules/compras/pages/compras-entradas-control.component').then(m => m.ComprasEntradasControlComponent),
        canActivate: [permissionGuard(Permission.COMPRAS_ENTRADAS_VER)]
      },
      {
        // CC ext — la vista completa (auditoría por línea + conciliación + validación). Es el
        // único camino "tengo el papel y no sé de qué entrada es", por eso sigue viva.
        path: 'entradas/control/ordenes',
        loadComponent: () => import('./modules/compras/pages/compras-entradas.component').then(m => m.ComprasEntradasComponent),
        canActivate: [permissionGuard(Permission.COMPRAS_ENTRADAS_VER)]
      },
      {
        // RE.20.1 — la MISMA pantalla con el otro lente. `Compras 360` era un componente aparte
        // (1,059 líneas), con su propio endpoint, su propio detalle y su propia paginación
        // **sobre la misma entidad**: una fila por orden de entrada. No era solape de datos —
        // era la misma fila con dos preguntas, y nadie sabía cuál de las dos abrir. Tanto que
        // la otra ya se había construido adentro un lente de "cumplimiento".
        //
        // Absorbe ÉSTA y no al revés por dos razones medidas (2026-08-29):
        //   1. `COMPRAS_360_VER` ⊂ `COMPRAS_ENTRADAS_VER` — todo rol con 360 tiene ENT_VER, y
        //      `auxiliar_tienda` (4 personas) tiene ENT_VER SIN 360. Fusionar hacia 360 los
        //      dejaba afuera; hacia acá no pierde nadie.
        //   2. Acá viven las escrituras (adjuntar/validar/devolver/descartar, 3 permisos), el
        //      alcance, el carril y la conciliación por línea RE.11. Mover columnas hacia
        //      adentro es aditivo; mover escrituras hacia afuera es riesgoso.
        //
        // Ruta propia y no un `?lente=` a secas para que el sidebar no marque dos items a la vez.
        path: 'costo-por-compra',
        loadComponent: () => import('./modules/compras/pages/compras-entradas.component').then(m => m.ComprasEntradasComponent),
        data: { lente: 'dinero' },
        canActivate: [permissionGuard(Permission.COMPRAS_ENTRADAS_VER)]
      },
      // El nombre viejo sigue vivo como redirect: hay links pegados en chats y en el detalle de
      // otras pantallas. Misma regla que los redirects de RE.16.
      { path: 'compras-360', redirectTo: 'costo-por-compra', pathMatch: 'full' },
      {
        // RE.14 — la misma recepción capturada dos veces (sucursal + oficinas 9.95). Ver el par y
        // dictaminar los dudosos. Se entra con VER; los botones piden VALIDAR (mueve el conteo).
        path: 'entradas/control/gemelas',
        loadComponent: () => import('./modules/compras/pages/compras-entradas-gemelas.component').then(m => m.ComprasEntradasGemelasComponent),
        canActivate: [permissionGuard(Permission.COMPRAS_ENTRADAS_VER)]
      },
      {
        // RE.16.3 — parámetros del proceso (arranque, tolerancia, los dos SLA, tope de lote).
        // VALIDAR y no VER: mover la fecha de arranque cambia el tablero de toda la red.
        path: 'entradas/control/ajustes',
        loadComponent: () => import('./modules/compras/pages/compras-entradas-ajustes.component').then(m => m.ComprasEntradasAjustesComponent),
        canActivate: [permissionGuard(Permission.COMPRAS_ENTRADAS_VALIDAR)],
        // RE.17.2 — mover el arranque o el SLA recalcula el tablero de las 9 sucursales; la
        // pantalla ya decía "hay cambios sin guardar" y después te dejaba salir en silencio.
        canDeactivate: [unsavedChangesGuard]
      },

      // Rutas viejas → su lugar nuevo. `lote` desaparece como pantalla: soltar N PDFs en la
      // tabla de pendientes ES el lote (una pantalla menos que aprender).
      { path: 'entradas/lote', redirectTo: 'entradas', pathMatch: 'full' },
      { path: 'entradas/todas', redirectTo: 'entradas/control/ordenes', pathMatch: 'full' },
      { path: 'entradas/gemelas', redirectTo: 'entradas/control/gemelas', pathMatch: 'full' },
      {
        // RE.10 — descuentos/apoyos + facturas duplicadas (ajustes de compra X-D-40/55).
        path: 'descuentos',
        loadComponent: () => import('./modules/compras/pages/compras-descuentos.component').then(m => m.ComprasDescuentosComponent),
        canActivate: [permissionGuard(Permission.COMPRAS_DESCUENTOS_VER)]
      },
      {
        // CXP.4 — Costo neto (landed cost) por proveedor: compras − descuento efectivo.
        path: 'costo-neto',
        loadComponent: () => import('./modules/compras/pages/compras-costo-neto.component').then(m => m.ComprasCostoNetoComponent),
        canActivate: [permissionGuard(Permission.COMPRAS_COSTO_NETO_VER)]
      },
      {
        // CXP.7 — "Cuadre y deuda por proveedor" SE MUDÓ a Finanzas (CxP/Tesorería). Redirects
        // para bookmarks/links viejos de Compras.
        path: 'cuadre-proveedor',
        redirectTo: '/finanzas/cuadre-proveedor',
        pathMatch: 'full',
      },
      {
        path: 'deuda-contpaqi',
        redirectTo: '/finanzas/cuadre-proveedor',
        pathMatch: 'full',
      },
      {
        path: 'categorias',
        loadComponent: () => import('./modules/compras/pages/compras-categorias.component').then(m => m.ComprasCategoriasComponent),
        canActivate: [permissionGuard(Permission.COMPRAS_CATEGORIAS_VER)]
      },
      {
        path: 'requisiciones/:id',
        loadComponent: () => import('./modules/compras/pages/compras-requisicion-detalle.component').then(m => m.ComprasRequisicionDetalleComponent),
        canActivate: [permissionGuard(Permission.COMPRAS_REQUISICIONES_VER)]
      },
      {
        path: 'ordenes',
        loadComponent: () => import('./modules/compras/pages/compras-ordenes.component').then(m => m.ComprasOrdenesComponent),
        canActivate: [permissionGuard(Permission.COMPRAS_ORDENES_VER)]
      },
      {
        path: 'ordenes/:id',
        loadComponent: () => import('./modules/compras/pages/compras-orden-detalle.component').then(m => m.ComprasOrdenDetalleComponent),
        canActivate: [permissionGuard(Permission.COMPRAS_ORDENES_VER)]
      },
    ]
  },
  // ── Proyecto Almacén ────────────────────────────────────────────────
  // Existencias, conteo físico (ciego/doble), FEFO, ABC/cíclico, pasillos.
  // Operación de almacén, no de venta. Reusa permisos COMMERCIAL_INVENTORY_*.
  {
    path: 'almacen',
    canActivate: [authGuard],
    component: LayoutComponent,
    children: [
      // Landing dinámico: primera superficie accesible del rol (guard → UrlTree).
      {
        path: '',
        pathMatch: 'full',
        canActivate: [almacenHomeGuard],
        loadComponent: () => import('./modules/comercial/pages/comercial-inventory.component').then(m => m.ComercialInventoryComponent),
      },
      // ── Pantallas de FOCO (handheld) — Fase WMS.1 ─────────────────────
      // Cuelgan FUERA del shell de área a propósito: NO llevan barra de tabs.
      // Una barra acá invita al operario a irse a otra pantalla a media tarima
      // (el conteo además tiene `countFocusGuard` en canDeactivate). Van ANTES
      // del shell porque el router matchea en orden y el shell tiene path ''.
      {
        // Fase I.2 — página del contador (handheld, conteo ciego)
        path: 'inventory/count',
        loadComponent: () => import('./modules/comercial/pages/comercial-inventory-count.component').then(m => m.ComercialInventoryCountComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_INVENTORY_CONTAR)],
        canDeactivate: [countFocusGuard]
      },
      {
        // WMS-REC Pieza 1 — estación handheld de una sesión (escaneo + líneas + cierre)
        path: 'inventory/recepcion-sesiones/:id',
        loadComponent: () => import('./modules/almacen/pages/almacen-recepcion-sesion.component').then(m => m.AlmacenRecepcionSesionComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_INVENTORY_RECIBIR)]
      },
      {
        // DM — Diario de movimientos (mejora del reporte Kepler): entradas/salidas agregadas + drill por folio.
        // También es superficie de auditoría/prevención → accesible con RECONCILIATION_VER.
        //
        // ⛔ INTOCABLE (decisión del equipo, 2026-08-31): queda como estaba —
        // item propio de sidebar, FUERA del shell de áreas y por lo tanto SIN
        // barra de tabs. No moverlo a un área en refactors futuros.
        path: 'movimientos',
        loadComponent: () => import('./modules/almacen/pages/almacen-movimientos.component').then(m => m.AlmacenMovimientosComponent),
        canActivate: [anyPermissionGuard(Permission.COMMERCIAL_MOVEMENTS_VER, Permission.RECONCILIATION_VER)]
      },
      {
        // WMS-REC — **Andén de Entrada**: las dos puertas (cotejo+acceso, y
        // fechado+acomodo) en una sola pasada junto al camión. Reemplaza el
        // recorrido de 4 pantallas: 79 toques por vale de 5 líneas → 24.
        // Pantalla de foco: se entra escaneando el folio del papel, no eligiendo
        // de una lista, así que no lleva barra de tabs.
        path: 'anden',
        loadComponent: () => import('./modules/almacen/anden/anden.component').then(m => m.AndenComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_INVENTORY_RECIBIR)]
      },
      // ── Áreas con barra de tabs — Fase WMS.1 ──────────────────────────
      // Padre con `path: ''`: las URLs de los hijos NO cambian, así que los
      // deep-links y los redirects viejos (`/comercial/inventory/**`) siguen
      // valiendo. La barra `liquid` se pinta UNA sola vez en el shell, en vez
      // de repetir `<app-page-tabs>` en los ~19 componentes. El mapa
      // área → tabs vive en `modules/almacen/almacen-tabs.ts`.
      // Va AL FINAL: un padre con path vacío matchea cualquier URL restante.
      {
        path: '',
        loadComponent: () => import('./modules/almacen/almacen-area-shell.component').then(m => m.AlmacenAreaShellComponent),
        children: [
      {
        path: 'inventory',
        loadComponent: () => import('./modules/comercial/pages/comercial-inventory.component').then(m => m.ComercialInventoryComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_INVENTORY_VER)]
      },
      {
        // Fase I.3 — supervisor: lista + apertura de folios
        path: 'inventory/sessions',
        loadComponent: () => import('./modules/comercial/pages/comercial-inventory-sessions.component').then(m => m.ComercialInventorySessionsComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)]
      },
      {
        // Fase I.3 — supervisor: detalle del folio + reconciliación
        path: 'inventory/sessions/:id',
        loadComponent: () => import('./modules/comercial/pages/comercial-inventory-session-detail.component').then(m => m.ComercialInventorySessionDetailComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)]
      },
      {
        // Fase I.5 — KPI de exactitud de inventario (IRA)
        path: 'inventory/ira',
        loadComponent: () => import('./modules/comercial/pages/comercial-inventory-ira.component').then(m => m.ComercialInventoryIraComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)]
      },
      {
        // P2.2c — lotes por vencer / vencidos (FEFO)
        path: 'inventory/expiring',
        loadComponent: () => import('./modules/comercial/pages/comercial-inventory-expiring.component').then(m => m.ComercialInventoryExpiringComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_INVENTORY_VER)]
      },
      {
        // WMS-REC (ADR-044) — Auditor de recepción por caducidad (foto+OCR+semáforo 🟢🟡🔴)
        path: 'inventory/recepcion',
        loadComponent: () => import('./modules/almacen/pages/almacen-recepcion-auditor.component').then(m => m.AlmacenRecepcionAuditorComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_INVENTORY_RECIBIR)]
      },
      {
        // WMS-REC Pieza 1 (ADR-044) — Vales de entrada (sesiones de recepción por escaneo)
        path: 'inventory/recepcion-sesiones',
        loadComponent: () => import('./modules/almacen/pages/almacen-recepcion-sesiones.component').then(m => m.AlmacenRecepcionSesionesComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_INVENTORY_RECIBIR)]
      },
      {
        // WMS-REC Pieza 3 (ADR-044) — Ubicaciones bin-level (auxiliar + put-away + FEFO)
        path: 'inventory/ubicaciones',
        loadComponent: () => import('./modules/almacen/pages/almacen-ubicaciones.component').then(m => m.AlmacenUbicacionesComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_INVENTORY_VER)]
      },
      {
        // WMS-REC (ADR-044, Opción A) — Caducidades · Por fechar: la cola del bodeguero.
        // Ruta hermana de 'inventory/caducidades' (hojas de anaquel), no su reemplazo:
        // son dos trabajos distintos y los dos siguen existiendo.
        path: 'inventory/por-fechar',
        loadComponent: () => import('./modules/almacen/pages/almacen-caducidades-por-fechar.component').then(m => m.AlmacenCaducidadesPorFecharComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_EXPIRY_CAPTURAR)]
      },
      {
        // P2.6 — Control de Caducidades: lista de hojas de inspección de anaquel
        path: 'inventory/caducidades',
        loadComponent: () => import('./modules/comercial/pages/comercial-expiry-reviews.component').then(m => m.ComercialExpiryReviewsComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_EXPIRY_VER)]
      },
      {
        // P2.6 — Control de Caducidades: detalle/captura de una hoja
        path: 'inventory/caducidades/:id',
        loadComponent: () => import('./modules/comercial/pages/comercial-expiry-review-detail.component').then(m => m.ComercialExpiryReviewDetailComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_EXPIRY_VER)]
      },
      {
        // ABC.3b — conteo cíclico (clasificación ABC + agenda)
        path: 'inventory/abc',
        loadComponent: () => import('./modules/comercial/pages/comercial-inventory-abc.component').then(m => m.ComercialInventoryAbcComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)]
      },
      {
        // PA.1b — editor 2D de pasillos (layout + mapeo bulk SKU→pasillo)
        path: 'inventory/aisles',
        loadComponent: () => import('./modules/comercial/pages/comercial-inventory-aisles.component').then(m => m.ComercialInventoryAislesComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_INVENTORY_ASIGNAR)]
      },
      {
        // PA.3 — tablero de equipos por folio (staffing por pasillo)
        path: 'inventory/sessions/:id/teams',
        loadComponent: () => import('./modules/comercial/pages/comercial-inventory-teams.component').then(m => m.ComercialInventoryTeamsComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_INVENTORY_ASIGNAR)]
      },
      {
        path: 'warehouses',
        loadComponent: () => import('./modules/comercial/pages/comercial-warehouses.component').then(m => m.ComercialWarehousesComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_WAREHOUSES_VER)]
      },
      {
        path: 'dead-stock',
        loadComponent: () => import('./modules/comercial/pages/comercial-dead-stock.component').then(m => m.ComercialDeadStockComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_DEADSTOCK_VER)]
      },
      {
        path: 'inventory-health',
        loadComponent: () => import('./modules/comercial/pages/comercial-inventory-health.component').then(m => m.ComercialInventoryHealthComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_INVHEALTH_VER)]
      },
      {
        // PREV.1 — Prevención de Inventarios: expediente de investigación de diferencias + timeline SKU
        path: 'prevencion',
        loadComponent: () => import('./modules/almacen/pages/almacen-prevencion.component').then(m => m.AlmacenPrevencionComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_PREVENTION_VER)]
      },
      {
        // PREV.2 — Monitoreo intensivo + ventanas de pérdida
        path: 'monitoreo',
        loadComponent: () => import('./modules/almacen/pages/almacen-monitoreo.component').then(m => m.AlmacenMonitoreoComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_PREVENTION_VER)]
      },
      {
        // PREV.3 — Índice de riesgo de inventario (prioridad de Prevención)
        path: 'riesgo',
        loadComponent: () => import('./modules/almacen/pages/almacen-riesgo.component').then(m => m.AlmacenRiesgoComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_PREVENTION_VER)]
      },
      {
        // SM.4 — Supervisor de Movimientos: bandeja de descuadres (caja/inventario/cruce)
        path: 'cuadre',
        loadComponent: () => import('./modules/almacen/pages/almacen-cuadre.component').then(m => m.AlmacenCuadreComponent),
        canActivate: [permissionGuard(Permission.RECONCILIATION_VER)]
      },
        ]
      },
    ]
  },
  // ── Proyecto Tienda ─────────────────────────────────────────────────
  // Monitor de tickets de venta EN VIVO por sucursal (WebSocket /store).
  {
    path: 'tienda',
    canActivate: [authGuard],
    component: LayoutComponent,
    children: [
      // Redirect condicional (determinista): monitor en vivo si tiene STORE_LIVE_VER /
      // manage:all; si solo tiene etiquetas (rol etiquetas_tienda), cae en /tienda/etiquetas.
      { path: '', pathMatch: 'full', redirectTo: storeEntryRedirect },
      {
        path: 'live',
        loadComponent: () => import('./modules/tienda/pages/tienda-live.component').then(m => m.TiendaLiveComponent),
        canActivate: [permissionGuard(Permission.STORE_LIVE_VER)]
      },
      {
        path: 'branches',
        loadComponent: () => import('./modules/tienda/pages/tienda-branches.component').then(m => m.TiendaBranchesComponent),
        canActivate: [permissionGuard(Permission.STORE_LIVE_VER)]
      },
      {
        path: 'pace',
        loadComponent: () => import('./modules/tienda/pages/tienda-pace.component').then(m => m.TiendaPaceComponent),
        canActivate: [permissionGuard(Permission.STORE_LIVE_VER)]
      },
      {
        path: 'etiquetas',
        loadComponent: () => import('./modules/tienda/pages/tienda-etiquetas.component').then(m => m.TiendaEtiquetasComponent),
        canActivate: [permissionGuard(Permission.STORE_LABELS_VER)]
      },
      {
        path: 'cajas',
        loadComponent: () => import('./modules/tienda/pages/tienda-cajas.component').then(m => m.TiendaCajasComponent),
        canActivate: [permissionGuard(Permission.STORE_LIVE_VER)]
      },
      {
        path: 'arqueo',
        loadComponent: () => import('./modules/tienda/pages/tienda-arqueo.component').then(m => m.TiendaArqueoComponent),
        canActivate: [anyPermissionGuard(Permission.STORE_ARQUEO_VER, Permission.STORE_ARQUEO_CAPTURAR)],
        canDeactivate: [unsavedChangesGuard]
      },
      {
        path: 'arqueos',
        loadComponent: () => import('./modules/tienda/pages/tienda-arqueo-historial.component').then(m => m.TiendaArqueoHistorialComponent),
        canActivate: [permissionGuard(Permission.STORE_ARQUEO_VER)]
      },
      {
        path: 'analisis-semanal',
        loadComponent: () => import('./modules/tienda/pages/tienda-weekly.component').then(m => m.TiendaWeeklyComponent),
        canActivate: [permissionGuard(Permission.STORE_ANALYTICS_VER)]
      },
      {
        // P2.6 — Control de Caducidades desde el módulo de tienda (mismo componente que /almacen)
        path: 'caducidades',
        loadComponent: () => import('./modules/comercial/pages/comercial-expiry-reviews.component').then(m => m.ComercialExpiryReviewsComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_EXPIRY_VER)]
      },
      {
        path: 'caducidades/:id',
        loadComponent: () => import('./modules/comercial/pages/comercial-expiry-review-detail.component').then(m => m.ComercialExpiryReviewDetailComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_EXPIRY_VER)]
      },
    ]
  },
  {
    path: 'logistica',
    canActivate: [authGuard],
    component: LayoutComponent,
    children: [
      // Landing dinámico: primera superficie accesible del rol (guard → UrlTree).
      {
        path: '',
        pathMatch: 'full',
        canActivate: [logisticaHomeGuard],
        loadComponent: () => import('./modules/logistica/pages/logistica-dashboard.component').then(m => m.LogisticaDashboardComponent),
      },
      {
        path: 'dashboard',
        loadComponent: () => import('./modules/logistica/pages/logistica-dashboard.component').then(m => m.LogisticaDashboardComponent),
        canActivate: [permissionGuard(Permission.LOGISTICS_SHIPMENTS_VER)]
      },
      {
        path: 'shipments',
        loadComponent: () => import('./modules/logistica/pages/logistica-shipments.component').then(m => m.LogisticaShipmentsComponent),
        canActivate: [permissionGuard(Permission.LOGISTICS_SHIPMENTS_VER)]
      },
      {
        path: 'guides',
        loadComponent: () => import('./modules/logistica/pages/logistica-guides.component').then(m => m.LogisticaGuidesComponent),
        canActivate: [permissionGuard(Permission.LOGISTICS_GUIDES_VER)]
      },
      {
        path: 'staff',
        loadComponent: () => import('./modules/logistica/pages/logistica-staff.component').then(m => m.LogisticaStaffComponent),
        canActivate: [permissionGuard(Permission.LOGISTICS_FLEET_VER)]
      },
      {
        path: 'costs',
        loadComponent: () => import('./modules/logistica/pages/logistica-costs.component').then(m => m.LogisticaCostsComponent),
        canActivate: [permissionGuard(Permission.LOGISTICS_EXPENSES_VER)]
      },
      {
        // Fase T — Traspasos (movimientos que NO son venta): consolidación UD06, recepción UA50, traspasos.
        path: 'traspasos',
        loadComponent: () => import('./modules/logistica/pages/logistica-traspasos.component').then(m => m.LogisticaTraspasosComponent),
        canActivate: [permissionGuard(Permission.LOGISTICS_TRANSFERS_VER)]
      },
      {
        path: 'shipments/:id',
        loadComponent: () => import('./modules/logistica/pages/logistica-shipment-detail.component').then(m => m.LogisticaShipmentDetailComponent),
        canActivate: [permissionGuard(Permission.LOGISTICS_SHIPMENTS_VER)]
      },
      // J.8 — checklists, fotos, reports
      {
        path: 'shipments/:shipmentId/checklists',
        loadComponent: () => import('./modules/logistica/pages/logistica-checklist.component').then(m => m.LogisticaChecklistComponent),
        canActivate: [permissionGuard(Permission.LOGISTICS_SHIPMENTS_VER)]
      },
      {
        path: 'shipments/:shipmentId/photos',
        loadComponent: () => import('./modules/logistica/pages/logistica-photos.component').then(m => m.LogisticaPhotosComponent),
        canActivate: [permissionGuard(Permission.LOGISTICS_SHIPMENTS_VER)]
      },
      {
        path: 'reports',
        loadComponent: () => import('./modules/logistica/pages/logistica-reports.component').then(m => m.LogisticaReportsComponent),
        canActivate: [permissionGuard(Permission.LOGISTICS_SHIPMENTS_VER)]
      },
      // J.9.7 — Driver Assignments (mobile-first "mis entregas" del chofer)
      {
        path: 'my-assignments',
        loadComponent: () => import('./modules/logistica/pages/logistica-driver-assignments.component').then(m => m.LogisticaDriverAssignmentsComponent),
        canActivate: [permissionGuard(Permission.LOGISTICS_SHIPMENTS_VER)]
      },
      {
        path: 'fleet',
        loadComponent: () => import('./modules/logistica/pages/logistica-fleet.component').then(m => m.LogisticaFleetComponent),
        canActivate: [permissionGuard(Permission.LOGISTICS_FLEET_VER)]
      },
      // J12.1 — Flota en vivo (rastreo web del chofer)
      {
        path: 'live',
        loadComponent: () => import('./modules/logistica/pages/logistica-live.component').then(m => m.LogisticaLiveComponent),
        canActivate: [permissionGuard(Permission.LOGISTICS_FLEET_VER)]
      },
      // LT — Rastreo de flota logística (foráneas/embarques/motos). Solo route_number IS NULL.
      {
        path: 'rastreo',
        data: { fleet: 'logistics' },
        loadComponent: () => import('./modules/logistica/pages/logistica-rastreo.component').then(m => m.LogisticaRastreoComponent),
        canActivate: [permissionGuard(Permission.LOGISTICS_FLEET_VER)]
      },
      // LTV.0 + LTV.5 — Actividad de la flota logística
      {
        path: 'actividad',
        data: { fleet: 'logistics' },
        loadComponent: () => import('./modules/logistica/pages/logistica-actividad.component').then(m => m.LogisticaActividadComponent),
        canActivate: [permissionGuard(Permission.LOGISTICS_FLEET_VER)]
      },
      // Hub "Rastreo" (flota logística): Flota en vivo + Rastreo GPS + Actividad en tabs ruteadas.
      {
        path: 'tracking',
        loadComponent: () => import('./shared/components/tab-shell/tab-shell.component').then(m => m.TabShellComponent),
        canActivate: [permissionGuard(Permission.LOGISTICS_FLEET_VER)],
        data: { tabs: [
          { label: 'Flota en vivo', path: 'live', icon: 'pi-map-marker' },
          { label: 'Rastreo GPS', path: 'gps', icon: 'pi-map' },
          { label: 'Actividad', path: 'actividad', icon: 'pi-chart-bar' },
        ] },
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'live' },
          { path: 'live', loadComponent: () => import('./modules/logistica/pages/logistica-live.component').then(m => m.LogisticaLiveComponent) },
          { path: 'gps', data: { fleet: 'logistics' }, loadComponent: () => import('./modules/logistica/pages/logistica-rastreo.component').then(m => m.LogisticaRastreoComponent) },
          { path: 'actividad', data: { fleet: 'logistics' }, loadComponent: () => import('./modules/logistica/pages/logistica-actividad.component').then(m => m.LogisticaActividadComponent) },
        ],
      },
      // J12.3 — Planeador de ruta (mapa + optimización)
      {
        path: 'planner',
        loadComponent: () => import('./modules/logistica/pages/logistica-planner.component').then(m => m.LogisticaPlannerComponent),
        canActivate: [permissionGuard(Permission.LOGISTICS_SHIPMENTS_VER)]
      },
      {
        path: 'payroll',
        loadComponent: () => import('./modules/logistica/pages/logistica-payroll.component').then(m => m.LogisticaPayrollComponent),
        canActivate: [permissionGuard(Permission.LOGISTICS_PAYROLL_VER)]
      },
      {
        path: 'config',
        loadComponent: () => import('./modules/logistica/pages/logistica-config.component').then(m => m.LogisticaConfigComponent),
        canActivate: [permissionGuard(Permission.LOGISTICS_CONFIG_GESTIONAR)]
      },
    ]
  },
  // ── Proyecto Administración (cross-cutting) ─────────────────────────
  // Gestión de usuarios + roles + permisos. No pertenece a un proyecto operativo.
  {
    path: 'admin',
    canActivate: [authGuard],
    component: LayoutComponent,
    children: [
      { path: '', redirectTo: 'users', pathMatch: 'full' },
      {
        path: 'users',
        loadComponent: () => import('./modules/dashboard/admin-users/admin-users.component').then(m => m.AdminUsersComponent),
        canActivate: [permissionGuard(Permission.USUARIOS_GESTIONAR)]
      },
      {
        // P2.6 — asignar marcas a promotores (scoping del Control de Caducidades)
        path: 'promotores',
        loadComponent: () => import('./modules/dashboard/admin-promoters/admin-promoters.component').then(m => m.AdminPromotersComponent),
        canActivate: [permissionGuard(Permission.USUARIOS_GESTIONAR)]
      },
      {
        // La cartera de ventas vive en /comercial/cartera (dominio comercial).
        // Redirect para no romper enlaces viejos a /admin/cartera.
        path: 'cartera',
        redirectTo: '/comercial/cartera',
        pathMatch: 'full',
      },
      {
        path: 'roles',
        loadComponent: () => import('./modules/dashboard/admin-catalogs/admin-catalogs.component').then(m => m.AdminCatalogsComponent),
        canActivate: [permissionGuard(Permission.ROLES_VER)]
      },
      {
        path: 'db-health',
        loadComponent: () => import('./modules/dashboard/admin-db-health/admin-db-health.component').then(m => m.AdminDbHealthComponent),
        canActivate: [permissionGuard(Permission.USUARIOS_GESTIONAR)]
      },
      {
        path: 'roles/:role_name/permissions',
        loadComponent: () => import('./modules/dashboard/admin-roles/admin-roles-permissions.component').then(m => m.AdminRolesPermissionsComponent),
        canActivate: [permissionGuard(Permission.ROLES_CONFIGURAR)]
      },
    ]
  },
  {
    path: 'televenta',
    canActivate: [televentaGuard],
    loadComponent: () =>
      import('./modules/televenta/televenta-shell.component').then((m) => m.TeleventaShellComponent),
    children: [
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
      // E.4 — Dashboard métricas
      {
        path: 'dashboard',
        loadComponent: () =>
          import('./modules/televenta/pages/televenta-dashboard.component').then(
            (m) => m.TeleventaDashboardComponent,
          ),
      },
      {
        path: 'queue',
        loadComponent: () =>
          import('./modules/televenta/pages/televenta-queue.component').then(
            (m) => m.TeleventaQueueComponent,
          ),
      },
      {
        path: 'my',
        // Reusa el mismo queue component (muestra Mis reservas activas arriba).
        loadComponent: () =>
          import('./modules/televenta/pages/televenta-queue.component').then(
            (m) => m.TeleventaQueueComponent,
          ),
      },
      {
        path: 'lead/:customer_id',
        loadComponent: () =>
          import('./modules/televenta/pages/televenta-lead.component').then(
            (m) => m.TeleventaLeadComponent,
          ),
      },
      {
        path: 'lead/:customer_id/take-order',
        loadComponent: () =>
          import('./modules/televenta/pages/televenta-take-order.component').then(
            (m) => m.TeleventaTakeOrderComponent,
          ),
      },
    ],
  },
  {
    // Módulo Reparto — personal de tienda: asignar pedidos a domicilio + cortes de caja.
    path: 'reparto',
    canActivate: [repartoGuard],
    component: LayoutComponent,
    children: [
      { path: '', redirectTo: 'asignar', pathMatch: 'full' },
      {
        path: 'asignar',
        loadComponent: () =>
          import('./modules/reparto/pages/home-delivery-dispatch.component').then((m) => m.HomeDeliveryDispatchComponent),
      },
      {
        path: 'pedidos-whatsapp',
        loadComponent: () =>
          import('./modules/reparto/pages/whatsapp-orders.component').then((m) => m.WhatsAppOrdersComponent),
      },
      {
        path: 'seguimiento',
        loadComponent: () =>
          import('./modules/reparto/pages/home-delivery-tracking.component').then((m) => m.HomeDeliveryTrackingComponent),
      },
      {
        path: 'cortes',
        loadComponent: () =>
          import('./modules/reparto/pages/rider-liquidation.component').then((m) => m.RiderLiquidationComponent),
      },
    ],
  },
  {
    path: '',
    redirectTo: '/projects',
    pathMatch: 'full'
  },
  {
    // 403. Dentro del layout, igual que el 404: el sidebar es la salida.
    // Recibe ?from= (ruta vedada) y ?perm= (permiso que faltó) del guard.
    path: 'sin-acceso',
    canActivate: [authGuard],
    component: LayoutComponent,
    children: [
      {
        path: '',
        loadComponent: () =>
          import('./modules/errors/forbidden.component').then((m) => m.ForbiddenComponent),
      },
    ],
  },
  {
    // 404. Va DENTRO del layout: el sidebar es la salida más rápida, y como el
    // layout deduce el proyecto leyendo la URL, un 404 bajo /comercial/… sale con
    // el menú de Comercial al lado. Antes esto redirigía a /login, que con la
    // sesión viva se leía como "se te cayó la sesión" por un dedazo en la URL.
    // Sin sesión, authGuard sigue mandando a /login, que es lo correcto.
    path: '**',
    canActivate: [authGuard],
    component: LayoutComponent,
    children: [
      {
        path: '',
        loadComponent: () =>
          import('./modules/errors/not-found.component').then((m) => m.NotFoundComponent),
      },
    ],
  }
];
