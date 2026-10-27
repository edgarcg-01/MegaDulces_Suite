import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * Navegación de la analítica COMERCIAL (venta real Kepler + IA). Solo lo que es
 * analítica de ventas/clientes. Las analíticas de inventario (Stock muerto, Salud)
 * viven en INVENTORY_TABS; Curaduría (ML-ops) queda gateada a admin.
 *
 * `[NAV.8]` «En vivo» va PRIMERO: es el Centro de Control, que era además un renglón suelto del
 * sidebar —la misma pantalla en dos lugares— y la más abierta de este conjunto (36 visitas en 30
 * días contra 3 de las otras juntas, telemetría 2026-10-27). La entrada «Analítica comercial» lleva
 * a la primera pestaña visible, así que quien abría el Centro de Control sigue llegando ahí.
 * «Razonamiento (Thot)» se pliega acá desde su renglón suelto (2 visitas).
 */
/** ⛔ `[AUD-A5]` El conjunto no se llama como ninguna de sus pestañas: la migaja toma este nombre. */
export const ANALYTICS_LABEL = 'Analítica comercial';

export const ANALYTICS_TABS: PageTab[] = [
  { label: 'En vivo', route: '/comercial/command-center', icon: 'pi pi-bolt', permission: Permission.COMMERCIAL_ORDERS_VER },
  { label: 'Pregúntale a Thot', route: '/comercial/thot-chat', icon: 'pi pi-comments', permission: Permission.COMMERCIAL_ORDERS_VER },
  { label: 'Razonamiento (Thot)', route: '/comercial/razonamiento', icon: 'pi pi-lightbulb', permission: Permission.COMMERCIAL_THOT_VER },
  // `[NAV.8.2]` Empuje dirigido: le dice a Thot qué productos empujar. Era renglón suelto de
  // «Precios y promociones» (0 visitas en 30 días); va con las otras pantallas de Thot.
  { label: 'Empuje (Thot)', route: '/comercial/empuje', icon: 'pi pi-bolt', permission: Permission.COMMERCIAL_PROMOTIONS_GESTIONAR },
  { label: 'Histórico ERP', route: '/comercial/historical', icon: 'pi pi-database', permission: Permission.COMMERCIAL_ORDERS_VER },
  // Curaduría cura ESTE chat (ML-ops); solo admin, va al final.
  { label: 'Curaduría Thot', route: '/comercial/thot-curation', icon: 'pi pi-book', permission: Permission.COMMERCIAL_CUSTOMERS_GESTIONAR },
];
