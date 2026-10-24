import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * `[EMB.43]` — **Logística › Pagos de viaje, en pestañas.**
 *
 * Pedido de Edgar (2026-10-24): «rediseñemos el frontend y démosle un módulo específico en
 * Logística» al control de comisiones, viáticos y carga por caja. Tres trabajos distintos, tres
 * pestañas (la prueba de la frase: cada una contesta UNA pregunta):
 *
 *  · **Por completar** — ¿a qué viajes de Kepler les falta quién fue, el horario o quién cargó?
 *    Es el trabajo diario: sin eso no hay nada que pagar.
 *  · **Por persona** — ¿cuánto cobra cada quien esta catorcena, y por qué? Es el trabajo de cada
 *    14 días: armar el vale que aprueba Finanzas.
 *  · **Tarifas** — ¿con qué se paga y desde cuándo? Comisión por ruta, viáticos y carga por caja,
 *    con su historial.
 *
 * Esta lista la leen el shell (la barra), el menú lateral (una sola entrada, «Pagos de viaje») y
 * su prueba. Las tres pestañas usan el permiso propio del módulo.
 */
export const PAGOS_VIAJE_TABS: readonly PageTab[] = [
  {
    label: 'Por completar',
    route: '/logistica/pagos/viajes',
    icon: 'pi pi-inbox',
    permission: Permission.LOGISTICS_PAGOS_VER,
  },
  {
    label: 'Por persona',
    route: '/logistica/pagos/personas',
    icon: 'pi pi-users',
    permission: Permission.LOGISTICS_PAGOS_VER,
  },
  {
    label: 'Tarifas',
    route: '/logistica/pagos/tarifas',
    icon: 'pi pi-sliders-h',
    permission: Permission.LOGISTICS_PAGOS_VER,
  },
];
