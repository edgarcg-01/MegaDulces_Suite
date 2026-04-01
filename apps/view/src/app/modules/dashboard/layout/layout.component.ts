import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { ThemeService } from '../../../core/services/theme.service';

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
  styleUrls: ['./layout.component.css']
})
export class LayoutComponent {
  private authService = inject(AuthService);
  private router = inject(Router);
  themeService = inject(ThemeService);

  user = this.authService.user;
  sidebarCollapsed = signal(false);

  navItems: NavItem[] = [
    { label: 'Dashboard', icon: 'pi pi-th-large', route: '/dashboard' },
    { label: 'Captura Diaria', icon: 'pi pi-pencil', route: '/dashboard/captures' },
    { label: 'Reportes', icon: 'pi pi-chart-bar', route: '/dashboard/reports' },
    { label: 'Tiendas / PDV', icon: 'pi pi-building', route: '/dashboard/stores' },
    { label: 'Visitas', icon: 'pi pi-map-marker', route: '/dashboard/visits' },
    { label: 'Exhibiciones', icon: 'pi pi-images', route: '/dashboard/exhibitions' },
  ];

  adminItems: NavItem[] = [
    { label: 'Usuarios', icon: 'pi pi-users', route: '/dashboard/admin/users' },
    { label: 'Conceptos', icon: 'pi pi-box', route: '/dashboard/admin/catalogs/conceptos' },
    { label: 'Ubicaciones', icon: 'pi pi-map-pin', route: '/dashboard/admin/catalogs/ubicaciones' },
    { label: 'Niveles', icon: 'pi pi-bolt', route: '/dashboard/admin/catalogs/niveles' },
    { label: 'Planograma', icon: 'pi pi-list', route: '/dashboard/admin/planograma' },
    { label: 'Zonas', icon: 'pi pi-globe', route: '/dashboard/admin/catalogs/zonas' },
    { label: 'Roles', icon: 'pi pi-shield', route: '/dashboard/admin/catalogs/roles' },
  ];

  toggleSidebar(): void {
    this.sidebarCollapsed.update(v => !v);
  }

  navigateTo(route: string): void {
    this.router.navigate([route]);
  }

  isActive(route: string): boolean {
    return this.router.url === route;
  }

  logout(): void {
    this.authService.logout();
    this.router.navigate(['/login']);
  }

  goToProjects(): void {
    this.router.navigate(['/projects']);
  }
}
