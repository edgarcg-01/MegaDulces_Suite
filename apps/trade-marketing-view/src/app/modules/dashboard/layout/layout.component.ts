// layout.component.ts
import {
  Component,
  inject,
  signal,
  computed,
  effect,
  Renderer2,
  HostListener,
  OnInit,
  OnDestroy,
} from '@angular/core';
import { CommonModule, DOCUMENT } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { ThemeService } from '../../../core/services/theme.service';
import { DataUpdateService } from '../../../core/services/data-update.service';
import { Permission } from '../../../core/constants/permissions';

@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './layout.component.html',
  styleUrls: ['./layout.component.css'],
})
export class LayoutComponent implements OnInit, OnDestroy {
  private authService = inject(AuthService);
  private perms       = inject(PermissionsService);
  private router      = inject(Router);
  themeService        = inject(ThemeService);
  private renderer    = inject(Renderer2);
  private document    = inject(DOCUMENT);
  private dataUpdateService = inject(DataUpdateService);

  // ── Auth ──────────────────────────────────────────────────────────
  user = this.authService.user;

  // ── UI state ─────────────────────────────────────────────────────
  sidebarCollapsed = signal(false);
  sidebarOpen      = signal(false);
  loading          = signal(false);
  scrollProgress   = signal(0);
  showScrollTop    = signal(false);
  isMobile         = signal(window.innerWidth < 1024);

  // ── Data Update ──────────────────────────────────────────────────
  hasPendingUpdate = this.dataUpdateService.hasPendingUpdate;
  isPwaInstalled = this.dataUpdateService.isPwaInstalled;

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
    // Iniciar polling para detectar actualizaciones cada 5 minutos
    this.dataUpdateService.startPolling(5);
    
    console.log('[LayoutComponent] Inicializado con polling de actualizaciones');
  }

  ngOnDestroy(): void {
    // Detener polling al destruir el componente
    this.dataUpdateService.stopPolling();
  }

  // ── Data Update Methods ────────────────────────────────────────────
  refreshData(): void {
    this.dataUpdateService.refreshData();
  }

  forceCheckUpdates(): void {
    this.dataUpdateService.forceCheckUpdates();
  }

  // ── Listeners ────────────────────────────────────────────────────
  @HostListener('window:resize')
  onResize(): void {
    this.isMobile.set(window.innerWidth < 1024);
  }

  @HostListener('window:scroll')
  onMainScroll(): void {
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const docHeight = document.documentElement.scrollHeight - document.documentElement.clientHeight;
    const progress  = docHeight > 0 ? (scrollTop / docHeight) * 100 : 0;
    this.scrollProgress.set(Math.min(100, Math.max(0, progress)));
    this.showScrollTop.set(scrollTop > 300);
  }

  scrollToTop(): void {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ── Sidebar ───────────────────────────────────────────────────────
  toggleSidebar(): void {
    if (this.isMobile()) {
      this.sidebarOpen.update(v => !v);
    } else {
      this.sidebarCollapsed.update(v => !v);
    }
  }

  openSidebar():  void { this.sidebarOpen.set(true);  }
  closeSidebar(): void { this.sidebarOpen.set(false); }

  isRestricted = computed(() => {
    return !this.perms.can('read', 'reports_team');
  });

  // ── Nav items (reactivos al user signal) ──────────────────────────
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

  private rawNavItems = [
    { label: 'Dashboard',        icon: 'pi pi-th-large',      route: '/dashboard',                       permission: Permission.REPORTES_VER_PROPIO  },
    { label: 'Captura Diaria',   icon: 'pi pi-pencil',        route: '/dashboard/captures',              permission: Permission.VISITAS_REGISTRAR    },
    { label: 'Reportes',         icon: 'pi pi-chart-bar',     route: '/dashboard/reports',               permission: Permission.REPORTES_VER_PROPIO  },
    { label: 'Seguimiento',      icon: 'pi pi-chart-line',    route: '/dashboard/seguimiento',           permission: Permission.VER_SEGUIMIENTO      },
    { label: 'Asignación Diaria',icon: 'pi pi-calendar-plus', route: '/dashboard/daily-assignments',     permission: Permission.USUARIOS_ASIGNAR_RUTA},
    { label: 'Tiendas',         icon: 'pi pi-building',      route: '/dashboard/stores',                 permission: Permission.TIENDAS_VER  },
  ];

  private rawAdminItems = [
    { label: 'Usuarios',    icon: 'pi pi-users',   route: '/dashboard/admin/users',                permission: Permission.USUARIOS_GESTIONAR  },
    { label: 'Conceptos',   icon: 'pi pi-box',     route: '/dashboard/admin/catalogs/conceptos',   permission: Permission.CATALOGO_GESTIONAR  },
    { label: 'Ubicaciones', icon: 'pi pi-map-marker', route: '/dashboard/admin/catalogs/ubicaciones', permission: Permission.CATALOGO_GESTIONAR  },
    { label: 'Niveles',     icon: 'pi pi-bolt',    route: '/dashboard/admin/catalogs/niveles',     permission: Permission.CATALOGO_GESTIONAR  },
    { label: 'Planograma',  icon: 'pi pi-list',    route: '/dashboard/admin/planograma',           permission: Permission.PLANOGRAMAS_GESTIONAR},
    { label: 'Zonas',       icon: 'pi pi-globe',   route: '/dashboard/admin/catalogs/zonas',       permission: Permission.CATALOGO_GESTIONAR  },
    { label: 'Roles',       icon: 'pi pi-shield',  route: '/dashboard/admin/catalogs/roles',       permission: Permission.ROLES_CONFIGURAR    },
  ];

  navItems = computed(() => {
    const user = this.user();
    if (!user) return [];
    return this.rawNavItems.filter(item => this.perms.can('read', this.permToSubject[item.permission] as any));
  });

  adminItems = computed(() => {
    const user = this.user();
    if (!user) return [];
    return this.rawAdminItems.filter(item => this.perms.can('read', this.permToSubject[item.permission] as any));
  });

  // ── Routing ───────────────────────────────────────────────────────
  navigateTo(route: string): void {
    this.router.navigate([route]);
    if (this.isMobile()) this.closeSidebar();
  }

  isActive(route: string): boolean {
    return this.router.url === route;
  }

  getCurrentPageTitle(): string {
    const all  = [...this.navItems(), ...this.adminItems()];
    const item = all.find(i => i.route === this.router.url);
    return item?.label ?? 'Página Actual';
  }

  logout(): void {
    this.authService.logout();
    this.router.navigate(['/login']);
  }

  goToProjects(): void {
    this.router.navigate(['/projects']);
  }
}