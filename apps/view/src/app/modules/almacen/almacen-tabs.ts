import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * Fase WMS.1 — el Almacén como un solo producto.
 *
 * **Jerarquía, sin repetir nada:**
 *  - **Sidebar = área** = un *trabajo* que alguien hace en un turno (Entrada,
 *    Inventario, Conteo, Control). Cuatro, no diecinueve.
 *  - **Tabs = las pantallas de ese trabajo.** Ninguna etiqueta de tab repite el
 *    nombre de su área — si la repite, el usuario ve el mismo texto dos veces y
 *    los dos menús parecen el mismo menú.
 *
 * **El corte es por trabajo, no por tema.** El primer intento agrupó por tema
 * ("Caducidades") y partió un mismo flujo en dos áreas: *Por fechar* es la cola
 * que deja el cierre del vale (el cierre da de alta en lote `NA` y alguien le
 * pone la fecha después), así que vive en **Entrada**, al lado de los Vales —
 * no en una isla temática. Lo mismo *Ubicaciones*: ubicar es el último paso de
 * recibir.
 *
 * El control es `app-page-tabs` con `variant="liquid"` (segmentado iOS,
 * **route-based**): cada tab es un `routerLink` a una ruta hermana, así que los
 * deep-links y el lazy-loading siguen intactos. Se descartó `.fb-viewseg` de
 * Finanzas por ser state-based (un `signal` + un componente gigante).
 *
 * **Las rutas NO cambian.** La barra se monta en `AlmacenAreaShellComponent`,
 * que envuelve las rutas existentes sin tocar sus paths.
 * Ver `docs/IMPLEMENTACION/FASES/FASE_WMS.md` §1.
 */
export interface AlmacenArea {
  /** Clave interna del área (iconos del sidebar / debug / tests). */
  key: string;
  /** Nombre del área — es la etiqueta del sidebar. */
  label: string;
  /**
   * Prefijos de URL que pertenecen al área. La resolución es por **prefijo más
   * largo**, así que `/almacen/inventory` (Inventario) puede convivir con
   * `/almacen/inventory/sessions` (Conteo) sin ambigüedad.
   */
  match: string[];
  /** Pantallas del área — esto es la barra de tabs. */
  tabs: PageTab[];
  /**
   * Pantallas de **foco** del área: handheld, sin barra de tabs (cuelgan fuera
   * del shell de ruta). **NO son tabs**: si lo fueran, al hacer clic la barra
   * desaparecería y el operario quedaría sin salida visible. Se llega a ellas
   * desde dentro del área (un botón en la pantalla que las precede).
   *
   * Sí cuentan como **candidatas a aterrizaje**: un contador que solo tiene
   * `CONTAR` no alcanza ningún tab de Conteo, y sin esto el área no se le
   * pintaría en el sidebar.
   */
  focusEntries?: PageTab[];
}

export const ALMACEN_AREAS: AlmacenArea[] = [
  {
    key: 'entrada',
    label: 'Entrada',
    // Ojo: 'recepcion-sesiones' NO es hijo de 'recepcion' (no hay `/` entre
    // medio), por eso van los dos prefijos explícitos. El detalle handheld
    // `/recepcion-sesiones/:id` cae por prefijo → el sidebar sigue en Entrada.
    match: [
      '/almacen/inventory/recepcion',
      '/almacen/inventory/recepcion-sesiones',
      '/almacen/inventory/por-fechar',
      '/almacen/inventory/ubicaciones',
    ],
    tabs: [
      { label: 'Vales', icon: 'pi pi-list', route: '/almacen/inventory/recepcion-sesiones', permission: Permission.COMMERCIAL_INVENTORY_RECIBIR, exact: true },
      { label: 'Caducidad', icon: 'pi pi-camera', route: '/almacen/inventory/recepcion', permission: Permission.COMMERCIAL_INVENTORY_RECIBIR, exact: true },
      { label: 'Por fechar', icon: 'pi pi-clock', route: '/almacen/inventory/por-fechar', permission: Permission.COMMERCIAL_EXPIRY_CAPTURAR, exact: true },
      { label: 'Ubicaciones', icon: 'pi pi-map-marker', route: '/almacen/inventory/ubicaciones', permission: Permission.COMMERCIAL_INVENTORY_VER, exact: true },
    ],
  },
  {
    key: 'inventario',
    label: 'Inventario',
    // '/almacen/inventory' cubre por prefijo a expiring y caducidades; las
    // sub-rutas de Entrada y Conteo ganan porque su prefijo es más largo.
    match: ['/almacen/inventory', '/almacen/warehouses', '/almacen/dead-stock', '/almacen/inventory-health'],
    tabs: [
      { label: 'Existencias', icon: 'pi pi-box', route: '/almacen/inventory', permission: Permission.COMMERCIAL_INVENTORY_VER, exact: true },
      { label: 'Por vencer', icon: 'pi pi-calendar-times', route: '/almacen/inventory/expiring', permission: Permission.COMMERCIAL_INVENTORY_VER, exact: true },
      // exact:false a propósito — el tab sigue activo en el detalle `/:id`.
      { label: 'Hojas de anaquel', icon: 'pi pi-clipboard', route: '/almacen/inventory/caducidades', permission: Permission.COMMERCIAL_EXPIRY_VER, exact: false },
      { label: 'Stock muerto', icon: 'pi pi-exclamation-triangle', route: '/almacen/dead-stock', permission: Permission.COMMERCIAL_DEADSTOCK_VER, exact: false },
      { label: 'Salud inv.', icon: 'pi pi-heart', route: '/almacen/inventory-health', permission: Permission.COMMERCIAL_INVHEALTH_VER, exact: false },
      { label: 'Almacenes', icon: 'pi pi-warehouse', route: '/almacen/warehouses', permission: Permission.COMMERCIAL_WAREHOUSES_VER, exact: false },
    ],
  },
  {
    key: 'conteo',
    label: 'Conteo',
    match: [
      '/almacen/inventory/sessions',
      '/almacen/inventory/abc',
      '/almacen/inventory/aisles',
      '/almacen/inventory/ira',
      '/almacen/inventory/count',
    ],
    tabs: [
      // exact:false — el tab sigue activo en el detalle del folio y en Equipos.
      { label: 'Folios', icon: 'pi pi-clipboard', route: '/almacen/inventory/sessions', permission: Permission.COMMERCIAL_INVENTORY_SUPERVISAR, exact: false },
      { label: 'Cíclico (ABC)', icon: 'pi pi-sync', route: '/almacen/inventory/abc', permission: Permission.COMMERCIAL_INVENTORY_SUPERVISAR, exact: true },
      { label: 'Pasillos', icon: 'pi pi-th-large', route: '/almacen/inventory/aisles', permission: Permission.COMMERCIAL_INVENTORY_ASIGNAR, exact: true },
      { label: 'Exactitud (IRA)', icon: 'pi pi-verified', route: '/almacen/inventory/ira', permission: Permission.COMMERCIAL_INVENTORY_SUPERVISAR, exact: true },
    ],
    focusEntries: [
      // Pantalla del contador: handheld, con `countFocusGuard` en canDeactivate.
      { label: 'Contar', icon: 'pi pi-qrcode', route: '/almacen/inventory/count', permission: Permission.COMMERCIAL_INVENTORY_CONTAR, exact: true },
    ],
  },
  {
    key: 'anden',
    label: 'Andén',
    // El Andén es pantalla de FOCO: no tiene tabs propios. Se declara como área
    // para que el sidebar lo resalte y para que el resolvedor no lo tire dentro
    // de Entrada, que sí tiene barra.
    match: ['/almacen/anden'],
    tabs: [],
    focusEntries: [
      { label: 'Andén', icon: 'pi pi-truck', route: '/almacen/anden', permission: Permission.COMMERCIAL_INVENTORY_RECIBIR, exact: true },
    ],
  },
  {
    key: 'control',
    label: 'Control',
    // `/almacen/movimientos` NO está acá a propósito: el **Diario de
    // Movimientos** queda intacto por decisión del equipo (2026-08-31) — item
    // propio de sidebar, su ruta cuelga fuera del shell y no lleva barra de
    // tabs. No moverlo a un área.
    match: ['/almacen/cuadre', '/almacen/prevencion', '/almacen/monitoreo', '/almacen/riesgo'],
    tabs: [
      { label: 'Cuadre', icon: 'pi pi-check-square', route: '/almacen/cuadre', permission: Permission.RECONCILIATION_VER, exact: true },
      { label: 'Prevención', icon: 'pi pi-shield', route: '/almacen/prevencion', permission: Permission.COMMERCIAL_PREVENTION_VER, exact: true },
      { label: 'Monitoreo', icon: 'pi pi-eye', route: '/almacen/monitoreo', permission: Permission.COMMERCIAL_PREVENTION_VER, exact: true },
      { label: 'Riesgo', icon: 'pi pi-chart-bar', route: '/almacen/riesgo', permission: Permission.COMMERCIAL_PREVENTION_VER, exact: true },
    ],
  },
];

/** Quita query string y fragmento — `routerLinkActive` compara sin ellos. */
function cleanUrl(url: string): string {
  return url.split('?')[0].split('#')[0];
}

/**
 * Resuelve el área por **prefijo más largo**. Sin esa regla,
 * `/almacen/inventory` (Inventario) se tragaría todas las sub-rutas de Entrada
 * y Conteo, que viven bajo el mismo path.
 */
export function resolveAlmacenArea(url: string): AlmacenArea | null {
  const path = cleanUrl(url);
  let best: AlmacenArea | null = null;
  let bestLen = -1;
  for (const area of ALMACEN_AREAS) {
    for (const prefix of area.match) {
      const hit = path === prefix || path.startsWith(prefix + '/');
      if (hit && prefix.length > bestLen) {
        best = area;
        bestLen = prefix.length;
      }
    }
  }
  return best;
}

/**
 * Tabs del área a la que pertenece la URL. Vacío en las pantallas de **foco**
 * (`focusEntries`): ahí la barra no se pinta a propósito.
 */
export function almacenTabsForUrl(url: string): PageTab[] {
  const area = resolveAlmacenArea(url);
  if (!area) return [];
  const path = cleanUrl(url);
  const isFocus = (area.focusEntries ?? []).some(
    (f) => path === f.route || path.startsWith(f.route + '/'),
  );
  return isFocus ? [] : area.tabs;
}

/**
 * Candidatas a aterrizaje del área, en orden de preferencia: primero los tabs
 * (el trabajo normal), después las pantallas de foco. Un contador con solo
 * `CONTAR` no alcanza ningún tab de Conteo y aterriza en *Contar*.
 */
export function almacenLandingCandidates(area: AlmacenArea): PageTab[] {
  return [...area.tabs, ...(area.focusEntries ?? [])];
}
