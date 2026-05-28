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

  isMobile = signal(
    typeof window !== 'undefined' && window.innerWidth < 1024,
  );

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
  }

  ngOnDestroy(): void {
    this.dataUpdateService.destroy();
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
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
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  @HostListener('window:resize')
  onResize(): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.isMobile.set(window.innerWidth < 1024);
    }, 150);
  }

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
  private tradeMkNavItems: NavItem[] = [
    { label: 'Dashboard',         icon: 'pi pi-th-large',      route: '/dashboard',                      permission: Permission.REPORTES_VER_PROPIO,   exact: true },
    { label: 'Captura Diaria',    icon: 'pi pi-pencil',        route: '/dashboard/captures',             permission: Permission.VISITAS_REGISTRAR     },
    { label: 'Reportes',          icon: 'pi pi-chart-bar',     route: '/dashboard/reports',              permission: Permission.REPORTES_VER_PROPIO   },
    { label: 'Seguimiento',       icon: 'pi pi-chart-line',    route: '/dashboard/seguimiento',          permission: Permission.VER_SEGUIMIENTO       },
    { label: 'Asignación Diaria', icon: 'pi pi-calendar-plus', route: '/dashboard/daily-assignments',    permission: Permission.USUARIOS_ASIGNAR_RUTA },
    { label: 'Tiendas',           icon: 'pi pi-building',      route: '/dashboard/stores',               permission: Permission.TIENDAS_VER           },
  ];

  private tradeMkAdminItems: NavItem[] = [
    { label: 'Conceptos',   icon: 'pi pi-box',        route: '/dashboard/admin/catalogs/conceptos',   permission: Permission.CATALOGO_GESTIONAR    },
    { label: 'Ubicaciones', icon: 'pi pi-map-marker', route: '/dashboard/admin/catalogs/ubicaciones', permission: Permission.CATALOGO_GESTIONAR    },
    { label: 'Niveles',     icon: 'pi pi-bolt',       route: '/dashboard/admin/catalogs/niveles',     permission: Permission.CATALOGO_GESTIONAR    },
    { label: 'Planograma',  icon: 'pi pi-list',       route: '/dashboard/admin/planograma',           permission: Permission.PLANOGRAMAS_GESTIONAR },
    { label: 'Zonas',       icon: 'pi pi-globe',      route: '/dashboard/admin/catalogs/zonas',       permission: Permission.CATALOGO_GESTIONAR    },
  ];

  private comercialNavItems: NavItem[] = [
    { label: 'Centro de Control', icon: 'pi pi-compass',        route: '/comercial/command-center', permission: Permission.COMMERCIAL_ORDERS_VER },
    { label: 'Pedidos',           icon: 'pi pi-file-edit',      route: '/comercial/orders',         permission: Permission.COMMERCIAL_ORDERS_VER },
    { label: 'Clientes',          icon: 'pi pi-users',          route: '/comercial/customers',      permission: Permission.COMMERCIAL_CUSTOMERS_VER },
    { label: 'Inventario',        icon: 'pi pi-box',            route: '/comercial/inventory',      permission: Permission.COMMERCIAL_INVENTORY_VER },
    { label: 'Listas de precios', icon: 'pi pi-tag',            route: '/comercial/pricing',        permission: Permission.COMMERCIAL_PRICING_VER },
    { label: 'Promociones',       icon: 'pi pi-gift',           route: '/comercial/promotions',     permission: Permission.COMMERCIAL_PROMOTIONS_VER },
    { label: 'Almacenes',         icon: 'pi pi-warehouse',      route: '/comercial/warehouses',     permission: Permission.COMMERCIAL_WAREHOUSES_VER },
    { label: 'Modo Vendedor',     icon: 'pi pi-briefcase',      route: '/vendor/customers',         permission: Permission.COMMERCIAL_ORDERS_CREAR },
  ];

  private adminNavItems: NavItem[] = [
    { label: 'Usuarios', icon: 'pi pi-users',  route: '/admin/users', permission: Permission.USUARIOS_GESTIONAR },
    { label: 'Roles',    icon: 'pi pi-shield', route: '/admin/roles', permission: Permission.ROLES_CONFIGURAR   },
  ];

  private logisticaNavItems: NavItem[] = [
    { label: 'Dashboard',        icon: 'pi pi-th-large',  route: '/logistica/dashboard', permission: Permission.LOGISTICS_SHIPMENTS_VER },
    { label: 'Embarques',        icon: 'pi pi-truck',     route: '/logistica/shipments', permission: Permission.LOGISTICS_SHIPMENTS_VER },
    { label: 'Mis entregas',     icon: 'pi pi-mobile',    route: '/logistica/my-assignments', permission: Permission.LOGISTICS_SHIPMENTS_VER },
    { label: 'Guías',            icon: 'pi pi-file-edit', route: '/logistica/guides',    permission: Permission.LOGISTICS_GUIDES_VER },
    { label: 'Costos',           icon: 'pi pi-money-bill', route: '/logistica/costs',    permission: Permission.LOGISTICS_EXPENSES_VER },
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
  };

  /**
   * Chequeo combinado: CASL rules (subjectMap) + fallback al record legacy
   * `user.permissions[X] === true`. Necesario porque las perms commercial
   * no están mapeadas a subjects CASL todavía, pero sí se sirven en el JWT
   * legacy permission record.
   */
  private hasPermFor(item: NavItem): boolean {
    const subject = this.permToSubject[item.permission];
    if (subject && this.perms.can('read', subject as any)) return true;
    const legacy = this.user()?.permissions;
    return legacy ? legacy[item.permission] === true : false;
  }

  /**
   * Detecta proyecto activo según prefix del URL. Default = trade marketing.
   * /admin tiene prefix más específico que comercial/dashboard, chequearlo primero.
   */
  private currentProject = computed<'trademk' | 'comercial' | 'admin' | 'logistica'>(() => {
    const url = this.currentUrl();
    if (url.startsWith('/admin')) return 'admin';
    if (url.startsWith('/comercial')) return 'comercial';
    if (url.startsWith('/logistica')) return 'logistica';
    return 'trademk';
  });

  navItems = computed(() => {
    const user = this.user();
    if (!user) return [];
    const project = this.currentProject();
    const items =
      project === 'comercial'
        ? this.comercialNavItems
        : project === 'admin'
        ? this.adminNavItems
        : project === 'logistica'
        ? this.logisticaNavItems
        : this.tradeMkNavItems;
    return items.filter((i) => this.hasPermFor(i));
  });

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
        command: () => this.themeService.toggleMonochrome(),
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
    return this.navItems().length + this.adminItems().length <= 1;
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
    this.authService.logout();
    this.router.navigate(['/login']);
  }

  goToProjects(): void {
    this.router.navigate(['/projects']);
  }
}
