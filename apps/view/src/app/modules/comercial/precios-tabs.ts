import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * `[PR.V2]` — Las dos pestañas de **Control de margen**, en un solo lugar.
 *
 * Eran dos renglones hermanos del sidebar que responden la misma pregunta en dos tiempos: el
 * motor dice **qué precio conviene mover**, y el experimento es **lo único que puede convertir
 * esa acción de «efecto no medido» a medida**. Separados, quien abría el motor no se enteraba
 * de que el experimento existía.
 *
 * ⭐ `PageTabsComponent` con `variant="liquid"` ya ES el selector segmentado estilo iOS, ya
 * navega por ruta y ya **filtra las pestañas por permiso**. No se construyó uno nuevo. Y como
 * se esconde solo cuando queda una sola pestaña visible, los roles que ven una sola pantalla
 * no reciben un selector de un botón que no selecciona nada.
 *
 * ⚠️ **No hay componente shell.** Almacén tiene uno porque monta la barra para ~19 páginas;
 * acá son dos, y un padre anidado además rompería el parser de `landing-guards.spec`, que sólo
 * lee rutas hijas a un nivel. Dos importaciones cuestan menos que esa deuda.
 *
 * ⚠️ `anyOf` en experimentos, no `permission`: hay roles con GESTIONAR y sin VER, y con un
 * permiso único perderían la pestaña aunque el guard de la ruta los dejara entrar.
 */
export const PRECIOS_TABS: PageTab[] = [
  {
    label: 'Motor',
    icon: 'pi pi-sliders-h',
    route: '/comercial/precios/motor',
    permission: Permission.COMMERCIAL_MARGIN_ENGINE_VER,
  },
  {
    // `[PR.M3]`+`[PR.M6]` — ⭐ Va en MEDIO, y no al final, porque responde la pregunta que
    // alguien se hace ENTRE ver qué mover y decidir medirlo: «¿y la competencia qué está
    // haciendo?». Mismo permiso que el motor: es la misma lectura, no un módulo aparte.
    label: 'Competencia',
    icon: 'pi pi-users',
    route: '/comercial/precios/competencia',
    permission: Permission.COMMERCIAL_MARGIN_ENGINE_VER,
  },
  {
    label: 'Experimentos',
    icon: 'pi pi-chart-scatter',
    route: '/comercial/precios/experimentos',
    anyOf: [
      Permission.COMMERCIAL_PRICE_EXPERIMENT_VER,
      Permission.COMMERCIAL_PRICE_EXPERIMENT_GESTIONAR,
    ],
  },
];
