import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * `[EMB.43]` `[EMB.47]` — **Logística › Pagos de viaje, en pestañas.**
 *
 * Pedido de Edgar (2026-10-24): «rediseñemos el frontend y démosle un módulo específico en
 * Logística» al control de comisiones, viáticos y carga por caja. Tres trabajos distintos, tres
 * pestañas (la prueba de la frase: cada una contesta UNA pregunta):
 *
 *  · **Operaciones** — de cada traspaso o entrega a cliente, ¿quién fue y cuánto le toca a cada
 *    quien? Es el trabajo diario: Kepler sabe la operación y sus cajas, aquí se agrega a la gente.
 *  · **Por persona** — ¿cuánto pide cada quien esta catorcena, y con qué renglones? Es el reporte
 *    de cada 14 días (PDF y Excel) con el que se hace la solicitud de gasto en Kepler.
 *  · **Tarifas** — ¿con qué se paga y desde cuándo? Comisión por ruta, viáticos y carga por caja,
 *    con su historial.
 *
 * Esta lista la leen el shell (la barra), el menú lateral (una sola entrada, «Pagos de viaje») y
 * su prueba. Las tres pestañas usan el permiso propio del módulo.
 */
export const PAGOS_VIAJE_TABS: readonly PageTab[] = [
  {
    label: 'Operaciones',
    route: '/logistica/pagos/viajes',
    icon: 'pi pi-truck',
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
