import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * Sub-módulo Promociones: las promos de la app + las vigentes en el ERP Kepler.
 *
 * ⛔ El permiso de cada pestaña es EL MISMO que el guard de su ruta (`app.routes.ts`, bloque
 * `mkt`). `[MKT.7]` (2026-11-11): «Acuerdos» y «Resultado» sólo pedían
 * `MKT_AGREEMENT_EVIDENCE_SUBIR`, y los roles `marketing` y `jefe_marketing` (4 personas en prod)
 * tienen `MKT_AGREEMENTS_VER` sin esa clave: el guard los dejaba entrar y la pestaña se les
 * escondía — Mercadotecnia no veía las dos pestañas de Mercadotecnia. Lo fija `promos-tabs.spec`.
 */
export const PROMOS_TABS: PageTab[] = [
  { label: 'Promociones', route: '/mkt/promotions', icon: 'pi pi-gift', permission: Permission.COMMERCIAL_PROMOTIONS_VER },
  { label: 'Promos ERP', route: '/mkt/erp-promos', icon: 'pi pi-percentage', permission: Permission.COMMERCIAL_ERP_PROMOS_VER },
  // `[MKT.1]` La pestaña la ven las DOS audiencias: Mercadotecnia (ver/gestionar) y la gente de
  // plaza que sube su evidencia. El recorte de QUÉ plazas ve lo hace el alcance en el servidor.
  {
    label: 'Acuerdos', route: '/mkt/acuerdos', icon: 'pi pi-file-edit',
    anyOf: [Permission.MKT_AGREEMENTS_VER, Permission.MKT_AGREEMENTS_GESTIONAR, Permission.MKT_AGREEMENT_EVIDENCE_SUBIR],
  },
  // `[MKT.6]` El resultado. Mismas dos audiencias: la plaza que sube la evidencia tiene derecho a
  // ver si su exhibición vendió.
  {
    label: 'Resultado', route: '/mkt/resultado', icon: 'pi pi-chart-line',
    anyOf: [Permission.MKT_AGREEMENTS_VER, Permission.MKT_AGREEMENT_EVIDENCE_SUBIR],
  },
];
