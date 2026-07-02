import { Routes } from '@angular/router';
import { LoginComponent } from './modules/auth/login/login.component';
import { permissionGuard } from './core/guards/permission.guard';
import { Permission } from './core/constants/permissions';
import { vendorGuard } from './modules/vendor/vendor.guard';

/**
 * App del vendedor (standalone). Rutas mínimas: login + el shell `/vendor/*`
 * (mismo árbol que vivía en apps/view). URLs `/vendor/...` y `/login` se
 * preservan para no tocar los router.navigate de los componentes.
 */
export const appRoutes: Routes = [
  { path: 'login', component: LoginComponent },
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
        path: 'assistant',
        loadComponent: () =>
          import('./modules/vendor/pages/vendor-assistant.component').then(
            (m) => m.VendorAssistantComponent,
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
        path: 'deliveries',
        loadComponent: () =>
          import('./modules/rider/pages/rider-deliveries.component').then(
            (m) => m.RiderDeliveriesComponent,
          ),
      },
      {
        path: 'capture',
        loadComponent: () =>
          import('./modules/dashboard/vendor-capture/vendor-capture.component').then(
            (m) => m.VendorCaptureComponent,
          ),
        canActivate: [permissionGuard(Permission.CAPTURE_TICKET_USE)],
      },
    ],
  },
  { path: '', redirectTo: 'vendor', pathMatch: 'full' },
  { path: '**', redirectTo: 'vendor' },
];
