import { Route } from '@angular/router';
import { customerB2bGuard } from './modules/portal/portal.guard';

/**
 * Rutas de la app PORTAL (tienda B2B), desplegada aparte.
 * Se conserva el prefijo `/portal/*` para no romper los routerLink internos
 * hardcodeados de los componentes; la raíz redirige a /portal/home.
 */
export const appRoutes: Route[] = [
  { path: '', redirectTo: 'portal/home', pathMatch: 'full' },
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
          import('./modules/portal/pages/portal-home.component').then((m) => m.PortalHomeComponent),
      },
      {
        path: 'catalog',
        data: { preload: true },
        loadComponent: () =>
          import('./modules/portal/pages/portal-catalog.component').then((m) => m.PortalCatalogComponent),
      },
      {
        path: 'cart',
        data: { preload: true },
        loadComponent: () =>
          import('./modules/portal/pages/portal-cart.component').then((m) => m.PortalCartComponent),
      },
      {
        path: 'promotions',
        loadComponent: () =>
          import('./modules/portal/pages/portal-promotions.component').then((m) => m.PortalPromotionsComponent),
      },
      {
        path: 'recommendations',
        loadComponent: () =>
          import('./modules/portal/pages/portal-recommendations.component').then((m) => m.PortalRecommendationsComponent),
      },
      {
        path: 'orders',
        loadComponent: () =>
          import('./modules/portal/pages/portal-orders.component').then((m) => m.PortalOrdersComponent),
      },
      {
        path: 'orders/:id',
        loadComponent: () =>
          import('./modules/portal/pages/portal-order-detail.component').then((m) => m.PortalOrderDetailComponent),
      },
    ],
  },
  { path: '**', redirectTo: 'portal/home' },
];
