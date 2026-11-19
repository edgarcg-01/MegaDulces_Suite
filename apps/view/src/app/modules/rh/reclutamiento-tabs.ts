import type { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

const VER = [Permission.HR_RECRUITMENT_VER, Permission.HR_RECRUITMENT_GESTIONAR];

/**
 * Fase RH · `[RH.17.1]` — las pestañas de Reclutamiento, en UN lugar. Las leen el marco de las pantallas
 * (`RhReclutamientoMarcoComponent`) y el menú lateral (`tabs` del item «Reclutamiento»): el menú lleva a la PRIMERA
 * que la persona ve —«Hoy», lo que RH viene a hacer— y se queda marcado en cualquiera de ellas.
 *
 * Todas leen con VER o GESTIONAR, igual que sus endpoints: ningún permiso aterriza en una pestaña que rebota.
 */
export const RECLUTAMIENTO_TABS: readonly PageTab[] = [
  // [RH.17.1] Lo que hay que hacer hoy, en pendientes con verbo (validado con RH en el prototipo del 19-nov).
  { label: 'Hoy', route: '/rh/reclutamiento/hoy', anyOf: VER },
  // [RH.8.1] Cuántos en cada etapa, de qué ciudad, y quién va fuera de meta.
  { label: 'Resumen', route: '/rh/reclutamiento/resumen', anyOf: VER },
  { label: 'Candidatos', route: '/rh/reclutamiento', anyOf: VER },
  { label: 'Vacantes', route: '/rh/reclutamiento/vacantes', anyOf: VER },
  { label: 'Revisiones', route: '/rh/reclutamiento/revisiones', anyOf: VER },
];
