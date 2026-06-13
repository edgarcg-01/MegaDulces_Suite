import { Routes } from '@angular/router';
import { LoginComponent } from './modules/auth/login/login.component';
import { ProjectsComponent } from './modules/projects/projects/projects.component';
import { LayoutComponent } from './modules/dashboard/layout/layout.component';
import { authGuard } from './core/guards/auth.guard';
import { permissionGuard, colaboradorGuard } from './core/guards/permission.guard';
import { Permission } from './core/constants/permissions';
import { customerB2bGuard } from './modules/portal/portal.guard';
import { vendorGuard } from './modules/vendor/vendor.guard';
import { televentaGuard } from './modules/televenta/televenta.guard';

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
      {
        // Agregar ticket de ruta (venta/carga/combustible) — reusa el flujo del vendedor.
        path: 'route-tickets',
        loadComponent: () => import('./modules/dashboard/route-tickets/route-tickets.component').then(m => m.DashboardRouteTicketsComponent),
        canActivate: [permissionGuard(Permission.ROUTE_TICKET_CAPTURE)]
      },
      {
        // Movida a /vendor/capture (Modo Vendedor v2). Redirect back-compat para guards y landings.
        path: 'vendor-capture',
        redirectTo: '/vendor/capture',
        pathMatch: 'full',
      },
      { path: 'reports', loadComponent: () => import('./modules/dashboard/reports/reports.component').then(m => m.ReportsComponent) },
      { path: 'seguimiento', loadComponent: () => import('./modules/dashboard/seguimiento/seguimiento.component').then(m => m.SeguimientoComponent), canActivate: [permissionGuard(Permission.VER_SEGUIMIENTO)] },
      { path: 'routes', loadComponent: () => import('./modules/dashboard/routes-analysis/routes-analysis.component').then(m => m.RoutesAnalysisComponent), canActivate: [permissionGuard(Permission.RUTAS_VER)] },
      { path: 'commercial-map', loadComponent: () => import('./modules/dashboard/commercial-map/commercial-map.component').then(m => m.CommercialMapComponent), canActivate: [permissionGuard(Permission.COMMERCIAL_MAP_VER)] },
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
        canActivate: [permissionGuard(Permission.USUARIOS_ASIGNAR_RUTA)]
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
      { path: '', redirectTo: 'command-center', pathMatch: 'full' },
      {
        path: 'command-center',
        loadComponent: () => import('./modules/dashboard/command-center/command-center.component').then(m => m.CommandCenterComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_ORDERS_VER)]
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
        canActivate: [permissionGuard(Permission.USUARIOS_ASIGNAR_RUTA)]
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
      {
        path: 'inventory',
        loadComponent: () => import('./modules/comercial/pages/comercial-inventory.component').then(m => m.ComercialInventoryComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_INVENTORY_VER)]
      },
      {
        path: 'warehouses',
        loadComponent: () => import('./modules/comercial/pages/comercial-warehouses.component').then(m => m.ComercialWarehousesComponent),
        canActivate: [permissionGuard(Permission.COMMERCIAL_WAREHOUSES_VER)]
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
        canActivate: [permissionGuard(Permission.CATALOGO_GESTIONAR)]
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
        canActivate: [permissionGuard(Permission.COMMERCIAL_ORDERS_VER)]
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
        canActivate: [permissionGuard(Permission.ROUTE_CONTROL_VER)]
      },
    ]
  },
  // ── Proyecto Logística (Fase J) ─────────────────────────────────────
  // Embarques, flotilla, costos, liquidaciones. Reusa LayoutComponent.
  {
    path: 'logistica',
    canActivate: [authGuard],
    component: LayoutComponent,
    children: [
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
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
        // Alias en Admin de la cartera de ventas (mismo componente que /comercial/cartera):
        // asignar rutas a vendedores es gestión de personal, vive también acá.
        path: 'cartera',
        loadComponent: () => import('./modules/comercial/pages/comercial-cartera.component').then(m => m.ComercialCarteraComponent),
        canActivate: [permissionGuard(Permission.USUARIOS_ASIGNAR_RUTA)]
      },
      {
        path: 'roles',
        loadComponent: () => import('./modules/dashboard/admin-catalogs/admin-catalogs.component').then(m => m.AdminCatalogsComponent),
        canActivate: [permissionGuard(Permission.ROLES_CONFIGURAR)]
      },
      {
        path: 'roles/:role_name/permissions',
        loadComponent: () => import('./modules/dashboard/admin-roles/admin-roles-permissions.component').then(m => m.AdminRolesPermissionsComponent),
        canActivate: [permissionGuard(Permission.ROLES_CONFIGURAR)]
      },
    ]
  },
  {
    path: 'portal/login',
    loadComponent: () =>
      import('./modules/portal/pages/portal-login.component').then((m) => m.PortalLoginComponent),
  },
  {
    path: 'portal',
    canActivate: [customerB2bGuard],
    loadComponent: () =>
      import('./modules/portal/portal-shell.component').then((m) => m.PortalShellComponent),
    children: [
      { path: '', redirectTo: 'home', pathMatch: 'full' },
      {
        path: 'home',
        loadComponent: () =>
          import('./modules/portal/pages/portal-home.component').then(
            (m) => m.PortalHomeComponent,
          ),
      },
      {
        path: 'catalog',
        loadComponent: () =>
          import('./modules/portal/pages/portal-catalog.component').then(
            (m) => m.PortalCatalogComponent,
          ),
      },
      {
        path: 'cart',
        loadComponent: () =>
          import('./modules/portal/pages/portal-cart.component').then(
            (m) => m.PortalCartComponent,
          ),
      },
      { path: 'ai-order', redirectTo: 'recommendations', pathMatch: 'full' },
      {
        path: 'promotions',
        loadComponent: () =>
          import('./modules/portal/pages/portal-promotions.component').then(
            (m) => m.PortalPromotionsComponent,
          ),
      },
      {
        path: 'recommendations',
        loadComponent: () =>
          import('./modules/portal/pages/portal-recommendations.component').then(
            (m) => m.PortalRecommendationsComponent,
          ),
      },
      {
        path: 'orders',
        loadComponent: () =>
          import('./modules/portal/pages/portal-orders.component').then(
            (m) => m.PortalOrdersComponent,
          ),
      },
      {
        path: 'orders/:id',
        loadComponent: () =>
          import('./modules/portal/pages/portal-order-detail.component').then(
            (m) => m.PortalOrderDetailComponent,
          ),
      },
    ],
  },
  {
    path: 'vendor',
    canActivate: [vendorGuard],
    loadComponent: () =>
      import('./modules/vendor/vendor-shell.component').then((m) => m.VendorShellComponent),
    children: [
      { path: '', redirectTo: 'route-home', pathMatch: 'full' },
      {
        path: 'route-home',
        loadComponent: () =>
          import('./modules/vendor/pages/vendor-route-home.component').then(
            (m) => m.VendorRouteHomeComponent,
          ),
      },
      // Back-compat: el nav viejo / landings apuntaban a 'new-order'.
      { path: 'new-order', redirectTo: 'route-home', pathMatch: 'full' },
      {
        path: 'pending',
        loadComponent: () =>
          import('./modules/vendor/pages/vendor-pending.component').then(
            (m) => m.VendorPendingComponent,
          ),
      },
      {
        path: 'visits',
        loadComponent: () =>
          import('./modules/vendor/pages/vendor-visits.component').then(
            (m) => m.VendorVisitsComponent,
          ),
      },
      {
        path: 'search',
        loadComponent: () =>
          import('./modules/vendor/pages/vendor-customers.component').then(
            (m) => m.VendorCustomersComponent,
          ),
      },
      // Back-compat: el nav viejo apuntaba a 'customers'.
      { path: 'customers', redirectTo: 'search', pathMatch: 'full' },
      {
        path: 'take-order/:id',
        loadComponent: () =>
          import('./modules/vendor/pages/vendor-take-order.component').then(
            (m) => m.VendorTakeOrderComponent,
          ),
      },
      {
        path: 'order-success',
        loadComponent: () =>
          import('./modules/vendor/pages/vendor-order-success.component').then(
            (m) => m.VendorOrderSuccessComponent,
          ),
      },
      {
        path: 'notifications',
        loadComponent: () =>
          import('./modules/vendor/pages/vendor-notifications.component').then(
            (m) => m.VendorNotificationsComponent,
          ),
      },
      {
        path: 'today',
        loadComponent: () =>
          import('./modules/vendor/pages/vendor-today.component').then(
            (m) => m.VendorTodayComponent,
          ),
      },
      {
        path: 'close-route',
        loadComponent: () =>
          import('./modules/vendor/pages/vendor-close-route.component').then(
            (m) => m.VendorCloseRouteComponent,
          ),
      },
      {
        path: 'carga',
        loadComponent: () =>
          import('./modules/vendor/pages/vendor-carga.component').then(
            (m) => m.VendorCargaComponent,
          ),
      },
      {
        // Captura de vendedor (exhibidor + ticket OCR + venta), offline-first.
        // Reusa el componente original; el permiso CAPTURE_TICKET_USE sigue gateando.
        path: 'capture',
        loadComponent: () =>
          import('./modules/dashboard/vendor-capture/vendor-capture.component').then(
            (m) => m.VendorCaptureComponent,
          ),
        canActivate: [permissionGuard(Permission.CAPTURE_TICKET_USE)],
      },
    ],
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
    path: '',
    redirectTo: '/projects',
    pathMatch: 'full'
  },
  {
    path: '**',
    redirectTo: '/login'
  }
];
