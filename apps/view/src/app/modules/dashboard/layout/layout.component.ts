import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  OnDestroy,
  OnInit,
  Renderer2,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { CommonModule, DOCUMENT } from '@angular/common';
import { NavigationEnd, Router, RouterModule } from '@angular/router';
import { MenuModule } from 'primeng/menu';
import type { MenuItem } from 'primeng/api';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map, startWith } from 'rxjs/operators';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { ThemeService } from '../../../core/services/theme.service';
import { DataUpdateService } from '../../../core/services/data-update.service';
import { WebSocketService } from '../../../core/services/websocket.service';
import { HapticService } from '../../../core/services/haptic.service';
import { CountFocusService } from '../../../core/services/count-focus.service';
import { Permission } from '../../../core/constants/permissions';

interface NavItem {
  label: string;
  icon: string;
  route: string;
  permission: Permission;
  /**
   * Si es `true`, `routerLinkActive` solo matchea cuando la URL es
   * exactamente `route` (no sub-rutas). Necesario para `/dashboard`, que
   * como root sería prefix de TODAS las otras rutas.
   */
  exact?: boolean;
}

@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [CommonModule, RouterModule, MenuModule],
  templateUrl: './layout.component.html',
  styleUrls: ['./layout.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LayoutComponent implements OnInit, OnDestroy {
  private authService = inject(AuthService);
  private perms = inject(PermissionsService);
  private router = inject(Router);
  themeService = inject(ThemeService);
  private renderer = inject(Renderer2);
  private document = inject(DOCUMENT);
  private dataUpdateService = inject(DataUpdateService);
  private wsService = inject(WebSocketService);
  private haptic = inject(HapticService);
  private countFocus = inject(CountFocusService);

  // Modo foco del conteo físico: oculta todo el chrome de navegación.
  countFocusActive = this.countFocus.active;

  // ── Auth ──────────────────────────────────────────────────────────
  user = this.authService.user;

  // ── UI state ─────────────────────────────────────────────────────
  /** Drawer móvil abierto (overlay). En desktop no aplica. */
  sidebarOpen = signal(false);

  /**
   * Estado de hover/focus del sidebar en desktop. Conjuntamente con
   * `sidebarFocused` componen `sidebarExpanded`. Tener dos signals separados
   * evita que el sidebar se colapse mientras el usuario navega con Tab
   * (focus dentro) aunque haya salido del hover físico del mouse.
   */
  sidebarHover = signal(false);
  sidebarFocused = signal(false);

  /**
   * Modalidad del último input del usuario (teclado vs pointer). Necesario
   * para emular `:focus-visible` en TS: cuando el usuario CLICKEA un nav-item,
   * el `<a>` retiene focus tras la navegación y nuestro `(focusin)` disparaba
   * `sidebarFocused = true`, dejando el sidebar pegado expandido aunque
   * sacaras el mouse. Con esta flag, solo expandimos por focus si el focus
   * vino de Tab/Shift+Tab (teclado real).
   */
  private keyboardFocus = false;

  /** Menú del avatar de usuario en el topbar (sincronizado con onShow/onHide). */
  userMenuOpen = signal(false);

  private readonly mobileMql =
    typeof window !== 'undefined'
      ? window.matchMedia('(max-width: 1023.98px)')
      : null;

  isMobile = signal(this.mobileMql?.matches ?? false);

  private readonly mobileMqlListener = (e: MediaQueryListEvent): void => {
    this.isMobile.set(e.matches);
  };

  /**
   * "Expandido" = se muestran labels + secciones completas.
   * - Mobile: lo controla el drawer (`sidebarOpen`)
   * - Desktop: hover sobre el sidebar O focus de teclado dentro
   * Patrón VS Code/Discord: el sidebar mantiene su rail de iconos siempre
   * visible y se expande SOBRE el contenido (no empuja).
   */
  sidebarExpanded = computed(() => {
    if (this.isMobile()) return this.sidebarOpen();
    return this.sidebarHover() || this.sidebarFocused();
  });

  // ── Data Update / WS ──────────────────────────────────────────────
  hasPendingUpdate = this.dataUpdateService.hasPendingUpdate;
  wsConnected = this.wsService.connected;

  // ── Router-aware signal — alimenta `currentPageTitle` y permite
  // resaltado del item activo con `routerLinkActive` en el template.
  private currentUrl = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );

  // ── Effects ──────────────────────────────────────────────────────
  constructor() {
    effect(() => {
      if (this.themeService.isMonochrome()) {
        this.renderer.addClass(this.document.body, 'theme-monochrome');
      } else {
        this.renderer.removeClass(this.document.body, 'theme-monochrome');
      }
    });
  }

  ngOnInit(): void {
    this.dataUpdateService.init();
    this.mobileMql?.addEventListener('change', this.mobileMqlListener);
  }

  ngOnDestroy(): void {
    this.dataUpdateService.destroy();
    this.mobileMql?.removeEventListener('change', this.mobileMqlListener);
  }

  // ── Data Update Methods ────────────────────────────────────────────
  /**
   * El botón "refresh" del topbar marca el indicador de actualización como
   * visto. No recarga datos: cada módulo se suscribe al WS y se actualiza
   * por su cuenta.
   */
  dismissPendingUpdate(): void {
    this.dataUpdateService.dismissUpdate();
  }

  // ── Listeners ────────────────────────────────────────────────────
  /**
   * Escape listener: short-circuit en el primer check, evita procesar la
   * tecla cuando el sidebar mobile no está abierto. Esto importa porque
   * Angular registra UN listener por instancia del component a nivel del
   * `document` — sin el short-circuit, cada tecla del usuario en un form
   * pasa por la lógica de modo/sidebar inútilmente.
   */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (!this.sidebarOpen() || !this.isMobile()) return;
    this.closeSidebar();
  }

  /**
   * Trackers de modalidad del input. Cualquier keydown de Tab marca al
   * usuario como "navegando con teclado"; cualquier pointerdown lo desmarca
   * (y además colapsa el sidebar si estaba abierto por focus, para que el
   * hover sea quien decida desde ese momento).
   */
  @HostListener('document:keydown', ['$event'])
  onAnyKeydown(e: KeyboardEvent): void {
    if (e.key === 'Tab') this.keyboardFocus = true;
  }

  @HostListener('document:pointerdown')
  onAnyPointerDown(): void {
    this.keyboardFocus = false;
    // Si veníamos con sidebarFocused (Tab previo) y ahora el usuario tomó
    // el mouse, devolvemos el control al hover — sin esto, el sidebar
    // quedaba pegado abierto al alternar entre teclado y mouse.
    if (this.sidebarFocused()) this.sidebarFocused.set(false);
  }

  // ── Sidebar ───────────────────────────────────────────────────────
  /** Solo aplica en mobile (drawer). En desktop el hover decide. */
  openSidebar(): void {
    this.sidebarOpen.set(true);
  }
  closeSidebar(): void {
    this.sidebarOpen.set(false);
  }

  /**
   * Hover handlers — solo activan en desktop. En mobile el sidebar es
   * drawer controlado por sidebarOpen, así que ignoramos el hover ahí.
   *
   * `onSidebarFocusIn` se gatea por `keyboardFocus`: si el focus vino de
   * un click (pointerdown previo bajó la flag a false), NO mantenemos el
   * sidebar expandido — solo el hover decide. Esto soluciona el bug en
   * que clickear un nav-item dejaba el `<a>` con focus y el sidebar pegado
   * abierto aunque el mouse saliera.
   */
  onSidebarEnter(): void {
    if (!this.isMobile()) this.sidebarHover.set(true);
  }
  onSidebarLeave(): void {
    if (!this.isMobile()) this.sidebarHover.set(false);
  }
  onSidebarFocusIn(): void {
    if (!this.isMobile() && this.keyboardFocus) this.sidebarFocused.set(true);
  }
  onSidebarFocusOut(): void {
    if (!this.isMobile()) this.sidebarFocused.set(false);
  }

  // ── Nav items por proyecto ────────────────────────────────────────
  // Cada proyecto tiene su propio set. El shell elige cuál mostrar según
  // el URL prefix actual (/dashboard, /comercial, /admin).
  // Sección "Trade": auditoría de ejecución en ruta (exhibiciones, scoring, reportes).
  private tradeMkNavItems: NavItem[] = [
    { label: 'Dashboard',         icon: 'pi pi-th-large',      route: '/dashboard',                      permission: Permission.REPORTES_VER_PROPIO,   exact: true },
    { label: 'Captura Diaria',    icon: 'pi pi-pencil',        route: '/dashboard/captures',             permission: Permission.VISITAS_REGISTRAR     },
    { label: 'Reportes',          icon: 'pi pi-chart-bar',     route: '/dashboard/reports',              permission: Permission.REPORTES_VER_PROPIO   },
    { label: 'Seguimiento',       icon: 'pi pi-chart-line',    route: '/dashboard/seguimiento',          permission: Permission.VER_SEGUIMIENTO       },
    { label: 'Mapa en Vivo',      icon: 'pi pi-compass',       route: '/dashboard/live-map',             permission: Permission.RUTAS_VER             },
    { label: 'Mapa de Campo',     icon: 'pi pi-map',           route: '/dashboard/field-map',            permission: Permission.RUTAS_VER             },
    { label: 'Mapa Comercial',    icon: 'pi pi-map-marker',    route: '/dashboard/commercial-map',       permission: Permission.COMMERCIAL_MAP_VER    },
    { label: 'Supervisor IA',     icon: 'pi pi-sparkles',      route: '/dashboard/supervisor-ai',        permission: Permission.SUPERVISOR_AI_VER     },
    { label: 'Asignación Diaria', icon: 'pi pi-calendar-plus', route: '/dashboard/daily-assignments',    permission: Permission.USUARIOS_ASIGNAR_RUTA },
    { label: 'Tiendas',           icon: 'pi pi-building',      route: '/dashboard/stores',               permission: Permission.TIENDAS_VER           },
  ];

  private tradeMkAdminItems: NavItem[] = [
    { label: 'Catálogos',   icon: 'pi pi-sliders-h',  route: '/dashboard/admin/catalogs/conceptos',   permission: Permission.CATALOGO_GESTIONAR    },
    { label: 'Planograma',  icon: 'pi pi-list',       route: '/dashboard/admin/planograma',           permission: Permission.PLANOGRAMAS_GESTIONAR },
  ];

  // Comercial agrupado por dominio (el shell renderiza una sección por grupo).
  private comercialNavGroups: { title: string; items: NavItem[] }[] = [
    {
      title: 'Ventas',
      items: [
        { label: 'Centro de Control', icon: 'pi pi-compass',   route: '/comercial/command-center', permission: Permission.COMMERCIAL_ORDERS_VER },
        { label: 'Pedidos',           icon: 'pi pi-file-edit',  route: '/comercial/orders',         permission: Permission.COMMERCIAL_ORDERS_VER },
        { label: 'Clientes',          icon: 'pi pi-users',      route: '/comercial/customers',      permission: Permission.COMMERCIAL_CUSTOMERS_VER },
      ],
    },
    {
      title: 'Catálogo',
      items: [
        { label: 'Catálogo',          icon: 'pi pi-shopping-bag', route: '/comercial/products',   permission: Permission.CATALOGO_GESTIONAR },
        { label: 'Listas de precios', icon: 'pi pi-tag',          route: '/comercial/pricing',    permission: Permission.COMMERCIAL_PRICING_VER },
        { label: 'Promociones',       icon: 'pi pi-gift',         route: '/comercial/promotions', permission: Permission.COMMERCIAL_PROMOTIONS_VER },
        { label: 'Empuje (Thot)',     icon: 'pi pi-bolt',         route: '/comercial/empuje',     permission: Permission.COMMERCIAL_PROMOTIONS_GESTIONAR },
      ],
    },
    {
      title: 'Ruta y vendedores',
      items: [
        { label: 'Cartera de ventas',  icon: 'pi pi-sitemap',    route: '/comercial/cartera',       permission: Permission.USUARIOS_ASIGNAR_RUTA },
        { label: 'Cierre de ruta',     icon: 'pi pi-receipt',    route: '/comercial/route-tickets', permission: Permission.ROUTE_CONTROL_VER },
        { label: 'Ventas de vendedor', icon: 'pi pi-money-bill', route: '/comercial/vendor-sales',  permission: Permission.COMMERCIAL_VENDOR_SALES_VER },
      ],
    },
    {
      title: 'Reportes',
      items: [
        { label: 'Sell-Out por empresa', icon: 'pi pi-file-excel', route: '/comercial/sell-out', permission: Permission.COMMERCIAL_SELLOUT_VER },
        { label: 'Salidas por producto', icon: 'pi pi-box', route: '/comercial/salidas', permission: Permission.COMMERCIAL_SALIDAS_VER },
        { label: 'Ventas por ruta', icon: 'pi pi-directions', route: '/comercial/ventas-por-ruta', permission: Permission.COMMERCIAL_ROUTE_SALES_VER },
        { label: 'Sucursales Wincaja', icon: 'pi pi-building', route: '/comercial/wincaja', permission: Permission.COMMERCIAL_ANALYTICS_VER },
      ],
    },
  ];

  private adminNavItems: NavItem[] = [
    { label: 'Usuarios', icon: 'pi pi-users',  route: '/admin/users', permission: Permission.USUARIOS_GESTIONAR },
    { label: 'Roles',    icon: 'pi pi-shield', route: '/admin/roles', permission: Permission.ROLES_CONFIGURAR  },
  ];

  private logisticaNavItems: NavItem[] = [
    { label: 'Dashboard',        icon: 'pi pi-th-large',  route: '/logistica/dashboard', permission: Permission.LOGISTICS_SHIPMENTS_VER },
    { label: 'Embarques',        icon: 'pi pi-truck',     route: '/logistica/shipments', permission: Permission.LOGISTICS_SHIPMENTS_VER },
    { label: 'Flota en vivo',    icon: 'pi pi-map-marker', route: '/logistica/live',     permission: Permission.LOGISTICS_FLEET_VER },
    { label: 'Planeador',        icon: 'pi pi-compass',   route: '/logistica/planner',   permission: Permission.LOGISTICS_SHIPMENTS_VER },
    { label: 'Mis entregas',     icon: 'pi pi-mobile',    route: '/logistica/my-assignments', permission: Permission.LOGISTICS_SHIPMENTS_VER },
    { label: 'Guías',            icon: 'pi pi-file-edit', route: '/logistica/guides',    permission: Permission.LOGISTICS_GUIDES_VER },
    { label: 'Costos',           icon: 'pi pi-money-bill', route: '/logistica/costs',    permission: Permission.LOGISTICS_EXPENSES_VER },
    { label: 'Traspasos',        icon: 'pi pi-sync',      route: '/logistica/traspasos', permission: Permission.LOGISTICS_TRANSFERS_VER },
    { label: 'Reportes',         icon: 'pi pi-chart-bar', route: '/logistica/reports',   permission: Permission.LOGISTICS_SHIPMENTS_VER },
    { label: 'Flotilla',         icon: 'pi pi-car',       route: '/logistica/fleet',     permission: Permission.LOGISTICS_FLEET_VER     },
    { label: 'Personal',         icon: 'pi pi-users',     route: '/logistica/staff',     permission: Permission.LOGISTICS_FLEET_VER },
    { label: 'Liquidaciones',    icon: 'pi pi-wallet',    route: '/logistica/payroll',   permission: Permission.LOGISTICS_PAYROLL_VER   },
    { label: 'Configuración',    icon: 'pi pi-cog',       route: '/logistica/config',    permission: Permission.LOGISTICS_CONFIG_GESTIONAR },
  ];

  private permToSubject: Record<string, string> = {
    [Permission.REPORTES_VER_PROPIO]: 'reports_own',
    [Permission.VISITAS_REGISTRAR]: 'visits',
    [Permission.USUARIOS_ASIGNAR_RUTA]: 'users_assign_route',
    [Permission.USUARIOS_GESTIONAR]: 'users',
    [Permission.CATALOGO_GESTIONAR]: 'catalogs',
    [Permission.TIENDAS_VER]: 'stores',
    [Permission.PLANOGRAMAS_GESTIONAR]: 'planograms',
    [Permission.ROLES_CONFIGURAR]: 'roles_config',
    [Permission.SCORING_CONFIG_GESTIONAR]: 'scoring_config',
    [Permission.VER_SEGUIMIENTO]: 'seguimiento',
    [Permission.RUTAS_VER]: 'routes_analytics',
    [Permission.COMMERCIAL_MAP_VER]: 'commercial_map',
  };

  /**
   * Chequeo combinado: god-mode (manage:all) + CASL rules (subjectMap) +
   * fallback al record legacy `user.permissions[X] === true`.
   *
   * El god-mode va PRIMERO: un superadmin debe ver TODO el nav sin depender de
   * que cada permiso nuevo esté mapeado en `permToSubject` ni backfilleado como
   * clave literal en su JSONB (+ re-login). Sin esto, cada item nuevo (ej.
   * Etiquetas / STORE_LABELS_VER) quedaba invisible para el superadmin hasta
   * backfillear la clave — el mismo trap que ya resuelven `permissionGuard` y
   * `projects.component`. Las perms commercial siguen sin subject CASL, por eso
   * el fallback al record legacy se mantiene.
   */
  private hasPermFor(item: NavItem): boolean {
    if (this.perms.can('manage', 'all')) return true;
    const subject = this.permToSubject[item.permission];
    if (subject && this.perms.can('read', subject as any)) return true;
    const legacy = this.user()?.permissions;
    return legacy ? legacy[item.permission] === true : false;
  }

  /**
   * Detecta proyecto activo según prefix del URL. Default = trade marketing.
   * /admin tiene prefix más específico que comercial/dashboard, chequearlo primero.
   */
  private currentProject = computed<'trademk' | 'comercial' | 'admin' | 'logistica' | 'tienda' | 'reparto' | 'finanzas' | 'almacen' | 'compras'>(() => {
    const url = this.currentUrl();
    if (url.startsWith('/admin')) return 'admin';
    if (url.startsWith('/comercial')) return 'comercial';
    if (url.startsWith('/logistica')) return 'logistica';
    if (url.startsWith('/tienda')) return 'tienda';
    if (url.startsWith('/reparto')) return 'reparto';
    if (url.startsWith('/finanzas')) return 'finanzas';
    if (url.startsWith('/almacen')) return 'almacen';
    if (url.startsWith('/compras')) return 'compras';
    return 'trademk';
  });

  projectLabel = computed(() => {
    switch (this.currentProject()) {
      case 'comercial':  return 'Comercial';
      case 'logistica':  return 'Logística';
      case 'tienda':     return 'Tienda';
      case 'reparto':    return 'Reparto';
      case 'finanzas':   return 'Finanzas';
      case 'almacen':    return 'Almacén';
      case 'compras':    return 'Compras';
      case 'admin':      return 'Administración';
      default:           return 'Trade Marketing';
    }
  });

  private tiendaNavItems: NavItem[] = [
    { label: 'Monitor en vivo', icon: 'pi pi-bolt', route: '/tienda/live', permission: Permission.STORE_LIVE_VER },
    { label: 'Sucursales', icon: 'pi pi-building', route: '/tienda/branches', permission: Permission.STORE_LIVE_VER },
    { label: 'Ritmo del día', icon: 'pi pi-chart-line', route: '/tienda/pace', permission: Permission.STORE_LIVE_VER },
    { label: 'Análisis semanal', icon: 'pi pi-calendar', route: '/tienda/analisis-semanal', permission: Permission.STORE_ANALYTICS_VER },
    { label: 'Arqueo de caja', icon: 'pi pi-eye-slash', route: '/tienda/arqueo', permission: Permission.STORE_ARQUEO_CAPTURAR },
    { label: 'Etiquetas', icon: 'pi pi-tag', route: '/tienda/etiquetas', permission: Permission.STORE_LABELS_VER },
  ];

  // Finanzas (egresos contables, CxP). Crece aquí lo contable — no en Ventas.
  private finanzasNavItems: NavItem[] = [
    { label: 'Egresos contables', icon: 'pi pi-wallet', route: '/finanzas/egresos', permission: Permission.FINANCE_EXPENSES_VER },
    { label: 'Solicitudes de gasto', icon: 'pi pi-file-edit', route: '/finanzas/solicitudes', permission: Permission.FINANCE_EXPENSES_VER },
    { label: 'Hallazgos', icon: 'pi pi-flag', route: '/finanzas/hallazgos', permission: Permission.FINANCE_AI_CHAT },
    { label: 'Pregúntale a Maat', icon: 'pi pi-sparkles', route: '/finanzas/maat', permission: Permission.FINANCE_AI_CHAT },
  ];

  // Compras / Reabastecimiento (Fase RA — ADR-030). Existencia crítica → sugerido →
  // requisición (HITL). Proyecto propio; nav gateado por COMPRAS_VER.
  private comprasNavItems: NavItem[] = [
    { label: 'Existencia crítica', icon: 'pi pi-exclamation-triangle', route: '/compras/existencia-critica', permission: Permission.COMPRAS_VER },
    { label: 'Requisiciones',      icon: 'pi pi-file-edit',            route: '/compras/requisiciones',      permission: Permission.COMPRAS_VER },
    { label: 'Órdenes de compra',  icon: 'pi pi-shopping-cart',        route: '/compras/ordenes',            permission: Permission.COMPRAS_VER },
    { label: 'Hallazgos',          icon: 'pi pi-flag',                 route: '/compras/hallazgos',          permission: Permission.COMPRAS_VER },
    { label: 'Proveedores',        icon: 'pi pi-truck',                route: '/compras/proveedores',        permission: Permission.COMPRAS_VER },
    { label: 'Red de abasto',      icon: 'pi pi-sitemap',              route: '/compras/red',                permission: Permission.COMPRAS_VER },
  ];

  // Almacén: existencias, conteo físico, FEFO, ABC/cíclico, pasillos. Operación
  // de almacén — salió de Ventas. Reusa permisos COMMERCIAL_INVENTORY_*.
  private almacenNavItems: NavItem[] = [
    { label: 'Existencias',     icon: 'pi pi-box',            route: '/almacen/inventory',          permission: Permission.COMMERCIAL_INVENTORY_VER, exact: true },
    { label: 'Almacenes',       icon: 'pi pi-warehouse',      route: '/almacen/warehouses',         permission: Permission.COMMERCIAL_WAREHOUSES_VER },
    { label: 'Conteo físico',   icon: 'pi pi-qrcode',         route: '/almacen/inventory/count',    permission: Permission.COMMERCIAL_INVENTORY_CONTAR, exact: true },
    { label: 'Folios',          icon: 'pi pi-clipboard',      route: '/almacen/inventory/sessions', permission: Permission.COMMERCIAL_INVENTORY_SUPERVISAR },
    { label: 'Cíclico (ABC)',   icon: 'pi pi-sync',           route: '/almacen/inventory/abc',      permission: Permission.COMMERCIAL_INVENTORY_SUPERVISAR },
    { label: 'Pasillos',        icon: 'pi pi-th-large',       route: '/almacen/inventory/aisles',   permission: Permission.COMMERCIAL_INVENTORY_ASIGNAR },
    { label: 'Exactitud (IRA)', icon: 'pi pi-verified',       route: '/almacen/inventory/ira',      permission: Permission.COMMERCIAL_INVENTORY_SUPERVISAR },
    { label: 'Por vencer',      icon: 'pi pi-calendar-times', route: '/almacen/inventory/expiring', permission: Permission.COMMERCIAL_INVENTORY_VER, exact: true },
    { label: 'Stock muerto',    icon: 'pi pi-exclamation-triangle', route: '/almacen/dead-stock',   permission: Permission.COMMERCIAL_DEADSTOCK_VER },
    { label: 'Salud inv.',      icon: 'pi pi-heart',          route: '/almacen/inventory-health',   permission: Permission.COMMERCIAL_INVHEALTH_VER },
    { label: 'Cuadre',          icon: 'pi pi-check-square',   route: '/almacen/cuadre',             permission: Permission.RECONCILIATION_VER },
    { label: 'Movimientos',     icon: 'pi pi-arrow-right-arrow-left', route: '/almacen/movimientos', permission: Permission.COMMERCIAL_INVENTORY_VER },
  ];

  // Reparto (entrega a domicilio, personal de tienda). El repartoGuard ya controla
  // el acceso a la superficie, por eso el nav no se re-filtra por permiso.
  private repartoNavItems: NavItem[] = [
    { label: 'Asignar pedido', icon: 'pi pi-send',       route: '/reparto/asignar',     permission: Permission.LOGISTICS_HOME_DISPATCH },
    { label: 'Seguimiento',    icon: 'pi pi-map-marker', route: '/reparto/seguimiento', permission: Permission.LOGISTICS_HOME_DISPATCH },
    { label: 'Cortes de caja', icon: 'pi pi-wallet',     route: '/reparto/cortes',      permission: Permission.LOGISTICS_HOME_DISPATCH },
  ];

  /** Título de la primera sección. En Trade se llama "Trade"; resto, "Operaciones". */
  mainSectionTitle = computed(() =>
    this.currentProject() === 'trademk' ? 'Trade' : 'Operaciones',
  );

  navItems = computed(() => {
    const user = this.user();
    if (!user) return [];
    // Reparto: superficie de personal de tienda; nav propio, sin depender del dashboard completo.
    if (this.currentProject() === 'reparto') {
      return this.dedupeByRoute(this.repartoNavItems);
    }
    // Finanzas: superficie contable con nav propio, sin depender del dashboard completo
    // (un usuario de finanzas puede no tener REPORTES_VER_*). El route-guard ya gatea acceso.
    if (this.currentProject() === 'finanzas') {
      return this.dedupeByRoute(this.finanzasNavItems);
    }
    // Compras: superficie propia con nav propio (un comprador puede no tener REPORTES_VER_*).
    if (this.currentProject() === 'compras') {
      return this.dedupeByRoute(this.comprasNavItems);
    }
    // Tienda: superficie de sucursal (cajeras/encargados). Un rol `sucursal` no tiene
    // REPORTES_VER_* → sin este early-return el nav de tienda no renderizaría. Cada item
    // se filtra por su permiso (STORE_LIVE_VER / STORE_ARQUEO_CAPTURAR / STORE_LABELS_VER).
    if (this.currentProject() === 'tienda') {
      return this.dedupeByRoute(this.tiendaNavItems.filter((i) => this.hasPermFor(i)));
    }
    // Almacén / Logística: superficies operativas con nav propio. Un rol operativo
    // (p.ej. `compras`, encargado de almacén) NO tiene REPORTES_VER_EQUIPO/GLOBAL,
    // así que sin este early-return caía en el gate `!fullDashboard` de abajo y el
    // sidebar quedaba vacío. Cada item se filtra por su permiso (COMMERCIAL_INVENTORY_*, etc.).
    if (this.currentProject() === 'almacen') {
      return this.dedupeByRoute(this.almacenNavItems.filter((i) => this.hasPermFor(i)));
    }
    if (this.currentProject() === 'logistica') {
      return this.dedupeByRoute(this.logisticaNavItems.filter((i) => this.hasPermFor(i)));
    }
    // Colaborador restringido (sin reportes de equipo/global): solo captura diaria.
    const legacy = user.permissions;
    const fullDashboard =
      legacy?.[Permission.REPORTES_VER_EQUIPO] === true ||
      legacy?.[Permission.REPORTES_VER_GLOBAL] === true;
    if (!fullDashboard) {
      // El vendedor (CAPTURE_TICKET_USE) usa su app dedicada (/vendor), no Trade:
      // acá no se le muestra "Captura Diaria". El colaborador sin esa capacidad sí.
      const isVendor = legacy?.[Permission.CAPTURE_TICKET_USE] === true;
      return this.dedupeByRoute(
        this.tradeMkNavItems.filter(
          (i) => i.route === '/dashboard/captures' && !isVendor && this.hasPermFor(i),
        ),
      );
    }
    const project = this.currentProject();
    const items =
      project === 'comercial'
        ? this.comercialNavGroups.flatMap((g) => g.items)
        : project === 'admin'
        ? this.adminNavItems
        : project === 'logistica'
        ? this.logisticaNavItems
        : project === 'tienda'
        ? this.tiendaNavItems
        : project === 'finanzas'
        ? this.finanzasNavItems
        : project === 'almacen'
        ? this.almacenNavItems
        : this.tradeMkNavItems;
    return this.dedupeByRoute(items.filter((i) => this.hasPermFor(i)));
  });

  /**
   * Secciones del sidebar. Comercial se agrupa por dominio (Ventas, Inventario,
   * Catálogo, Ruta); el resto de proyectos conserva su estructura previa
   * (Trade: principal + Captura Vendedor + Administración; admin/logística: una
   * sola sección). Grupos vacíos (sin items con permiso) se descartan.
   */
  navGroups = computed<{ title: string; items: NavItem[] }[]>(() => {
    const user = this.user();
    if (!user) return [];
    if (this.currentProject() === 'reparto') {
      return [{ title: 'Reparto', items: this.dedupeByRoute(this.repartoNavItems) }];
    }
    if (this.currentProject() === 'finanzas') {
      return [{ title: 'Finanzas', items: this.dedupeByRoute(this.finanzasNavItems) }];
    }
    if (this.currentProject() === 'compras') {
      return [{ title: 'Compras', items: this.dedupeByRoute(this.comprasNavItems) }];
    }
    if (this.currentProject() === 'almacen') {
      return [{ title: 'Almacén', items: this.dedupeByRoute(this.almacenNavItems.filter((i) => this.hasPermFor(i))) }]
        .filter((g) => g.items.length > 0);
    }
    if (this.currentProject() === 'logistica') {
      return [{ title: 'Logística', items: this.dedupeByRoute(this.logisticaNavItems.filter((i) => this.hasPermFor(i))) }]
        .filter((g) => g.items.length > 0);
    }
    if (this.currentProject() === 'comercial') {
      return this.comercialNavGroups
        .map((g) => ({
          title: g.title,
          items: this.dedupeByRoute(g.items.filter((i) => this.hasPermFor(i))),
        }))
        .filter((g) => g.items.length > 0);
    }
    const groups: { title: string; items: NavItem[] }[] = [];
    // Agrupar las 3 superficies de mapa bajo una sección "Mapas" (hermanas).
    const MAP_ROUTES = new Set(['/dashboard/live-map', '/dashboard/field-map', '/dashboard/commercial-map']);
    const all = this.navItems();
    const mapItems = all.filter((i) => MAP_ROUTES.has(i.route));
    const mainItems = all.filter((i) => !MAP_ROUTES.has(i.route));
    if (mainItems.length) groups.push({ title: this.mainSectionTitle(), items: mainItems });
    if (mapItems.length) groups.push({ title: 'Mapas', items: mapItems });
    if (this.adminItems().length) groups.push({ title: 'Administración', items: this.adminItems() });
    return groups;
  });

  /**
   * Dedupe por route preservando el primero que pasó el filtro de permisos.
   * Evita dos items al mismo destino (ej. "Captura Diaria" y "Captura de
   * vendedor" → /dashboard/captures): el usuario full ve "Captura Diaria",
   * el vendedor sin VISITAS_REGISTRAR ve "Captura de vendedor".
   */
  private dedupeByRoute(items: NavItem[]): NavItem[] {
    const seen = new Set<string>();
    return items.filter((i) => {
      if (seen.has(i.route)) return false;
      seen.add(i.route);
      return true;
    });
  }

  adminItems = computed(() => {
    const user = this.user();
    if (!user) return [];
    // Solo Trade Marketing tiene sección admin separada (catálogos + planograma).
    // En /comercial y /admin no hay sub-sección admin.
    if (this.currentProject() !== 'trademk') return [];
    return this.tradeMkAdminItems.filter((i) => this.hasPermFor(i));
  });

  /**
   * Items del menú que abre el avatar/nombre del usuario en el topbar.
   * Reactivo al theme actual (cambia el copy/icono del toggle) y al user
   * (oculta "Proyectos" si no aplica). Reemplaza la dependencia exclusiva
   * de los botones del footer del sidebar — útil cuando el usuario está
   * restringido (sin sidebar) o en mobile con el menú cerrado.
   */
  userMenu = computed<MenuItem[]>(() => {
    const isDark = this.themeService.isMonochrome();
    return [
      {
        label: isDark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro',
        icon: isDark ? 'pi pi-sun' : 'pi pi-moon',
        command: () => this.toggleTheme(),
      },
      {
        label: 'Proyectos',
        icon: 'pi pi-arrow-right-arrow-left',
        command: () => this.goToProjects(),
      },
      { separator: true },
      {
        label: 'Cerrar sesión',
        icon: 'pi pi-sign-out',
        styleClass: 'text-content-main',
        command: () => this.logout(),
      },
    ];
  });

  /**
   * "Restringido" = el usuario tiene como máximo una vista accesible.
   * En ese caso ocultamos el sidebar y dejamos solo el topbar con logout.
   * Antes esto se basaba en `reports_team`, lo que dejaba sin sidebar a
   * usuarios con permisos válidos (p.ej. VER_SEGUIMIENTO).
   */
  isRestricted = computed(() => {
    // Modo "kiosco" (oculta el chrome) SOLO para el colaborador de Trade con acceso
    // a una sola pantalla (Captura). Las superficies dedicadas (finanzas, reparto,
    // tienda, etc.) tienen su propio nav aunque sea de 1 item → nunca se restringen.
    if (this.currentProject() !== 'trademk') return false;
    return this.navItems().length + this.adminItems().length <= 1;
  });

  /**
   * Bottom nav activo cuando: mobile + no restringido. Trae los primeros 4
   * items del proyecto activo. Si hay más, el slot #5 es "Más" → abre drawer.
   * Patrón FB / Instagram / Twitter / Slack mobile.
   */
  useBottomNav = computed(() => this.isMobile() && !this.isRestricted() && !this.countFocusActive());

  bottomNavItems = computed(() => {
    if (!this.useBottomNav()) return [];
    return [...this.navItems()].slice(0, 4);
  });

  hasOverflowItems = computed(() => {
    if (!this.useBottomNav()) return false;
    // Siempre ofrecer "Más" en móvil: abre el drawer con TODAS las secciones y el
    // footer (Proyectos / Tema / Cerrar sesión). Sin esto, proyectos con ≤4 items
    // (ej. Finanzas) quedaban sin hamburguesa NI "Más" → el menú lateral no se abría.
    return true;
  });

  // ── Page title (reactivo a NavigationEnd) ──────────────────────────
  currentPageTitle = computed(() => {
    const url = this.currentUrl();
    const all = [...this.navItems(), ...this.adminItems()];
    // Match más laxo que ===: cubre query params, hijos y trailing slashes.
    const item =
      all.find((i) => url === i.route) ||
      all.find((i) => url.startsWith(i.route + '/')) ||
      all.find((i) => url.startsWith(i.route + '?'));
    return item?.label ?? 'Página Actual';
  });

  // ── Routing ───────────────────────────────────────────────────────
  /** En mobile el sidebar se cierra al tocar un link de navegación. */
  onNavClick(): void {
    if (this.isMobile()) this.closeSidebar();
  }

  logout(): void {
    this.haptic.impact('medium');
    this.authService.logout();
    this.router.navigate(['/login']);
  }

  goToProjects(): void {
    this.haptic.impact('light');
    this.router.navigate(['/projects']);
  }

  /** Wrapper: theme toggle + haptic. Usar este en lugar de llamar al service directo. */
  toggleTheme(): void {
    this.haptic.selection();
    this.themeService.toggleMonochrome();
  }
}
