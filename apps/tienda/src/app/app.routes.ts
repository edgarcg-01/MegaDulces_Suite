import { Route } from '@angular/router';

export const appRoutes: Route[] = [
  {
    path: '',
    loadComponent: () => import('./pages/catalog/tienda-catalog.component').then(m => m.TiendaCatalogComponent),
  },
  {
    path: 'producto/:codigo',
    loadComponent: () => import('./pages/product/tienda-producto.component').then(m => m.TiendaProductoComponent),
  },
  {
    path: 'carrito',
    loadComponent: () => import('./pages/cart/tienda-carrito.component').then(m => m.TiendaCarritoComponent),
  },
  {
    path: 'checkout',
    loadComponent: () => import('./pages/checkout/tienda-checkout.component').then(m => m.TiendaCheckoutComponent),
  },
  {
    path: 'pedido/:seguimiento',
    loadComponent: () => import('./pages/order/tienda-pedido.component').then(m => m.TiendaPedidoComponent),
  },
  {
    path: '**',
    loadComponent: () => import('./pages/not-found/not-found.component').then(m => m.NotFoundComponent),
  },
];
