import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { ButtonModule } from 'primeng/button';

@Component({
  selector: 'app-projects',
  standalone: true,
  imports: [CommonModule, ButtonModule],
  templateUrl: './projects.component.html',
  styleUrls: ['./projects.component.css'],
})
export class ProjectsComponent {
  private router = inject(Router);
  private authService = inject(AuthService);

  user = this.authService.user;

  projects = [
    {
      id: 'trade-marketing',
      name: 'Proyecto Trade Marketing',
      description: 'Gestión de operaciones en campo, captura diaria de KPIs, exhibiciones y reportes de ejecución en punto de venta.',
      icon: 'pi pi-chart-bar',
      route: '/dashboard',
      status: 'Activo'
    }
  ];

  navigateTo(route: string): void {
    if (route === '/dashboard') {
      const user = this.authService.user();
      if (user && user.role_name === 'colaborador') {
        this.router.navigate(['/dashboard/captures']);
        return;
      }
    }
    this.router.navigate([route]);
  }

  logout(): void {
    this.authService.logout();
    this.router.navigate(['/login']);
  }
}
