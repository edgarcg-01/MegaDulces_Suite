import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * `[ETQ-CAMBIOS.1]` Sub-módulo Etiquetas: **una sola sección** en el sidebar con dos vistas del
 * mismo trabajo, no dos entradas sueltas. Calca a `ARQUEO_TABS`, que ya resolvió este caso.
 *
 * Son la misma tarea desde dos lados: `/tienda/etiquetas` es el acto deliberado (buscar, escanear,
 * armar la cola, imprimir) y `/tienda/etiquetas/cambios` es el disparador (el ERP movió un precio,
 * estas etiquetas quedaron viejas en el anaquel). Separadas en el menú parecerían módulos
 * distintos y la encargada tendría que adivinar en cuál mirar; como pestañas, ir de "qué cambió"
 * a "imprimir" es un clic y la cola no se pierde.
 *
 * Los dos tabs piden el MISMO permiso (`STORE_LABELS_VER`): quien puede imprimir una etiqueta
 * puede ver cuáles quedaron viejas — es la misma decisión. Con un permiso distinto en cada uno,
 * la barra se le ocultaría sola a quien tiene los dos, que es todo el mundo.
 */
export const ETIQUETAS_TABS: PageTab[] = [
  { label: 'Etiquetas', route: '/tienda/etiquetas', icon: 'pi pi-tag', permission: Permission.STORE_LABELS_VER },
  { label: 'Cambios de precio', route: '/tienda/etiquetas/cambios', icon: 'pi pi-arrow-right-arrow-left', permission: Permission.STORE_LABELS_VER },
];
