import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * Sub-módulo Arqueo: **una sola sección** en el sidebar con dos vistas del mismo
 * tema, no dos entradas sueltas.
 *
 * Son la misma pregunta desde dos lados: `/tienda/arqueo` es el acto (contar el
 * cajón, sellar el conteo, validarlo) y `/tienda/arqueos` es la persona (cómo
 * viene cada cajera, qué cortes le quedaron sin contar). Separadas en el menú
 * parecían módulos distintos y la encargada tenía que adivinar en cuál mirar;
 * como pestañas, saltar de una a otra es un clic y el contexto no se pierde.
 */
export const ARQUEO_TABS: PageTab[] = [
  // Sin permiso declarado a proposito: la ruta la guarda un anyPermissionGuard
  // (STORE_ARQUEO_VER **o** _CAPTURAR) y PageTab solo acepta uno. Pedirle VER aca
  // le esconderia su propia pantalla a la cajera que solo captura. Si le falta VER,
  // el otro tab se filtra y la barra se oculta sola (queda 1 tab visible).
  { label: 'Arqueo de caja', route: '/tienda/arqueo', icon: 'pi pi-eye-slash' },
  { label: 'Por cajera', route: '/tienda/arqueos', icon: 'pi pi-users', permission: Permission.STORE_ARQUEO_VER },
];
