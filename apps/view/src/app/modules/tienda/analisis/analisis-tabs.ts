import { PageTab } from '../../../shared/components/page-tabs/page-tabs.component';

/**
 * `[TDA.A1]` Las 4 secciones de **Análisis de ventas** (`/tienda/analisis-semanal/*`).
 *
 * Son cuatro preguntas distintas sobre el MISMO recorte (rango + sucursal), no cuatro
 * módulos: por eso van como pestañas dentro de una pantalla y no como entradas sueltas
 * del menú. El filtro vive en el shell y se conserva al saltar de una a otra.
 *
 * Sin `permission` a propósito: las cuatro cuelgan de la misma ruta, que ya está
 * guardada con `STORE_ANALYTICS_VER`. Repetirlo acá no agrega gate y sí agrega un lugar
 * más donde olvidarse de actualizarlo.
 */
export const ANALISIS_TABS: PageTab[] = [
  { label: 'Tráfico', route: '/tienda/analisis-semanal', icon: 'pi pi-chart-line' },
  // `[TDA.A3]` Se parten en dos porque son dos preguntas: «¿cómo viene cada proveedor?»
  // (una tabla de 302 líneas) y «¿qué productos no puedo perder de vista?» (Pareto sobre
  // 5,744 SKUs, con Tipo y Grupo). Mezcladas, la segunda vivía al pie de la primera y
  // nadie llegaba a ella.
  { label: 'Proveedores y productos', route: '/tienda/analisis-semanal/productos', icon: 'pi pi-truck' },
  { label: 'Productos TOP', route: '/tienda/analisis-semanal/top', icon: 'pi pi-box' },
  { label: 'Clientes', route: '/tienda/analisis-semanal/clientes', icon: 'pi pi-users' },
  { label: 'Promociones', route: '/tienda/analisis-semanal/promociones', icon: 'pi pi-percentage' },
];
