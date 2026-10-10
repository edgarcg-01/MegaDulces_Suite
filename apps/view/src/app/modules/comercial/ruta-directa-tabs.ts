import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * Las pantallas del sub-módulo **Ruta Directa**, que cuelgan de «Ventas por ruta».
 *
 * ⛔ **Por qué viven en su propio archivo.** Estaban sueltas dentro de `REPORTS_TABS`, mezcladas
 * con Sell-Out, Análisis y Salidas, que son reportes de venta general. Al derivar el sidebar de
 * esa lista (`[SN.31]`) las siete cayeron aplanadas en el grupo «Reportes» — y no son reportes
 * sueltos: son **un sub-módulo**, la misma operación mirada por siete lados (lo que vendió, lo
 * que cargó, lo que cobra el chofer, su objetivo, su resultado, su gasto y su camioneta).
 * Aplanarlas las escondía entre cosas que no tienen que ver.
 *
 * ⭐ `REPORTS_TABS` las sigue incluyendo en el MISMO orden, así que la tira de pestañas no
 * cambia. Lo que cambia es que ahora hay un nombre para el conjunto, y el sidebar puede
 * agruparlas como lo que son sin que nadie tenga que mantener una segunda lista.
 */
export const RUTA_DIRECTA_TABS: PageTab[] = [
  {
    label: 'Ventas por ruta',
    route: '/comercial/ventas-por-ruta',
    icon: 'pi pi-directions',
    permission: Permission.COMMERCIAL_ROUTE_SALES_VER,
  },
  {
    // RD.13 — la misma operacion del otro lado: lo que se le cargo al camion contra lo que
    // vendio. Mismo permiso que Ventas por ruta; no es nomina.
    label: 'Inventario de ruta',
    route: '/comercial/inventario-ruta',
    icon: 'pi pi-truck',
    permission: Permission.COMMERCIAL_ROUTE_SALES_VER,
  },
  {
    // RD.6 — la comision quincenal de Ruta Directa. Al lado de Ventas por ruta porque es la
    // misma venta, pero con permiso PROPIO: ver cuanto vendio una ruta y ver cuanto cobra su
    // chofer son cosas distintas, y lo segundo es nomina.
    label: 'Comisiones RD',
    route: '/comercial/comisiones',
    icon: 'pi pi-percentage',
    permission: Permission.COMMERCIAL_COMMISSIONS_VER,
  },
  {
    // `[RD.59]` — el bono por objetivo mensual. Tab propio y no una pestaña dentro de
    // Comisiones: configurar un bono y verificar una corrida de nómina son dos trabajos
    // distintos. Mismo permiso de lectura; editar exige GESTIONAR, que gatea el servidor.
    label: 'Objetivo RD',
    route: '/comercial/comisiones/objetivo',
    icon: 'pi pi-flag',
    permission: Permission.COMMERCIAL_COMMISSIONS_VER,
  },
  {
    // `[RD.57]` — la misma operacion mirada por el resultado: utilidad bruta, kilometros del
    // GPS y gasto del departamento. Permiso PROPIO y mas estrecho que Comisiones: publica el
    // gasto del area completo (nomina, SUA, comisiones), no lo que cobra cada persona.
    label: 'Rentabilidad RD',
    route: '/comercial/ruta-directa/rentabilidad',
    icon: 'pi pi-chart-line',
    permission: Permission.COMMERCIAL_ROUTE_PROFIT_VER,
  },
  {
    // [RD.60] el gasto renglon por renglon. Mismo permiso: es la misma superficie.
    label: 'Gasto RD',
    route: '/comercial/ruta-directa/gastos',
    icon: 'pi pi-receipt',
    permission: Permission.COMMERCIAL_ROUTE_PROFIT_VER,
  },
  {
    // [RD.60] la ficha de cada camioneta, con lo que falta capturar declarado.
    label: 'Flota RD',
    route: '/comercial/ruta-directa/flota',
    icon: 'pi pi-truck',
    permission: Permission.COMMERCIAL_ROUTE_PROFIT_VER,
  },
];
