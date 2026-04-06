import {
  Component,
  inject,
  signal,
  computed,
  effect,
  Renderer2,
} from '@angular/core';
import { CommonModule, DOCUMENT } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { ThemeService } from '../../../core/services/theme.service';
import { Permission } from '../../../core/constants/permissions';

interface NavItem {
  label: string;
  icon: string;
  route: string;
}

@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './layout.component.html',
  styleUrls: ['./layout.component.css'],
})
export class LayoutComponent {
  private authService = inject(AuthService);
  private router = inject(Router);
  themeService = inject(ThemeService);
  private renderer = inject(Renderer2);
  private document = inject(DOCUMENT);

  user = this.authService.user;
  sidebarCollapsed = signal(false);
  sidebarOpen = signal(false);
  loading = signal(false);

  constructor() {
    effect(() => {
      if (this.themeService.isMonochrome()) {
        this.renderer.addClass(this.document.body, 'theme-monochrome');
      } else {
        this.renderer.removeClass(this.document.body, 'theme-monochrome');
      }
    });
  }

  isMobile(): boolean {
    return window.innerWidth < 1024;
  }

  toggleSidebar(): void {
    if (this.isMobile()) {
      this.sidebarOpen.set(!this.sidebarOpen());
    } else {
      this.sidebarCollapsed.set(!this.sidebarCollapsed());
    }
  }

  closeSidebar(): void {
    this.sidebarOpen.set(false);
  }

  openSidebar(): void {
    this.sidebarOpen.set(true);
  }

  // Mapeo de items con permisos requeridos
  private rawNavItems = [
    {
      label: 'Dashboard',
      icon: 'pi pi-th-large',
      route: '/dashboard',
      permission: Permission.REPORTES_VER_PROPIO,
    },
    {
      label: 'Captura Diaria',
      icon: 'pi pi-pencil',
      route: '/dashboard/captures',
      permission: Permission.VISITAS_REGISTRAR,
    },
    {
      label: 'Reportes',
      icon: 'pi pi-chart-bar',
      route: '/dashboard/reports',
      permission: Permission.REPORTES_VER_PROPIO,
    },
    {
      label: 'Tiendas / PDV',
      icon: 'pi pi-building',
      route: '/dashboard/stores',
      permission: Permission.CATALOGO_GESTIONAR,
    },
    {
      label: 'Exhibiciones',
      icon: 'pi pi-images',
      route: '/dashboard/exhibitions',
      permission: Permission.REPORTES_VER_PROPIO,
    },
    {
      label: 'Asignación Diaria',
      icon: 'pi pi-calendar-plus',
      route: '/dashboard/daily-assignments',
      permission: Permission.USUARIOS_ASIGNAR_RUTA,
    },
  ];

  private rawAdminItems = [
    {
      label: 'Usuarios',
      icon: 'pi pi-users',
      route: '/dashboard/admin/users',
      permission: Permission.USUARIOS_GESTIONAR,
    },
    {
      label: 'Conceptos',
      icon: 'pi pi-box',
      route: '/dashboard/admin/catalogs/conceptos',
      permission: Permission.CATALOGO_GESTIONAR,
    },
    {
      label: 'Ubicaciones',
      icon: 'pi pi-map-pin',
      route: '/dashboard/admin/catalogs/ubicaciones',
      permission: Permission.CATALOGO_GESTIONAR,
    },
    {
      label: 'Niveles',
      icon: 'pi pi-bolt',
      route: '/dashboard/admin/catalogs/niveles',
      permission: Permission.CATALOGO_GESTIONAR,
    },
    {
      label: 'Planograma',
      icon: 'pi pi-list',
      route: '/dashboard/admin/planograma',
      permission: Permission.PLANOGRAMAS_GESTIONAR,
    },
    {
      label: 'Zonas',
      icon: 'pi pi-globe',
      route: '/dashboard/admin/catalogs/zonas',
      permission: Permission.CATALOGO_GESTIONAR,
    },
    {
      label: 'Roles',
      icon: 'pi pi-shield',
      route: '/dashboard/admin/catalogs/roles',
      permission: Permission.ROLES_CONFIGURAR,
    },
  ];

  // Filtrado reactivo por permisos
  navItems = computed(() =>
    this.rawNavItems.filter((item) =>
      this.authService.hasPermission(item.permission),
    ),
  );

  adminItems = computed(() =>
    this.rawAdminItems.filter((item) =>
      this.authService.hasPermission(item.permission),
    ),
  );

  navigateTo(route: string): void {
    this.router.navigate([route]);
  }

  isActive(route: string): boolean {
    return this.router.url === route;
  }

  getCurrentPageTitle(): string {
    const currentRoute = this.router.url;
    const item = [...this.navItems(), ...this.adminItems()].find(
      (i) => i.route === currentRoute,
    );
    return item ? item.label : 'Página Actual';
  }

  logout(): void {
    this.authService.logout();
    this.router.navigate(['/login']);
  }

  goToProjects(): void {
    this.router.navigate(['/projects']);
  }
}
