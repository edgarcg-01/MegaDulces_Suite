import { Component, computed, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { ButtonModule } from 'primeng/button';

interface ProjectCard {
  id: string;
  name: string;
  description: string;
  icon: string;
  route: string;
  status: string;
  /** Si el usuario tiene CUALQUIERA de estas perms, ve el proyecto. */
  anyOf: Permission[];
  /** Si está set, además del anyOf el rol debe estar en esta lista. */
  roleOnly?: string[];
  /** Si está set, el rol NO debe estar en esta lista para ver el proyecto. */
  hideForRoles?: string[];
}

@Component({
  selector: 'app-projects',
  standalone: true,
  imports: [CommonModule, ButtonModule],
  templateUrl: './projects.component.html',
  styleUrls: ['./projects.component.css'],
})
export class ProjectsComponent implements OnInit {
  private router = inject(Router);
  private authService = inject(AuthService);
  private perms = inject(PermissionsService);

  user = this.authService.user;

  private readonly allProjects: ProjectCard[] = [
    {
      id: 'trade-marketing',
      name: 'Auditoría en Ruta',
      description: 'Auditoría de ejecución en ruta: captura diaria, exhibiciones, scoring y reportes operativos.',
      icon: 'pi pi-chart-bar',
      route: '/dashboard',
      status: 'Activo',
      anyOf: [
        Permission.VISITAS_REGISTRAR,
        Permission.REPORTES_VER_PROPIO,
        Permission.REPORTES_VER_EQUIPO,
        Permission.REPORTES_VER_GLOBAL,
        Permission.TIENDAS_VER,
        Permission.VER_SEGUIMIENTO,
        Permission.PLANOGRAMAS_GESTIONAR,
        Permission.CATALOGO_GESTIONAR,
        Permission.USUARIOS_ASIGNAR_RUTA,
      ],
    },
    {
      id: 'comercial',
      name: 'Ventas',
      description: 'Back-office de venta B2B: pedidos, clientes, almacenes, pricing, inventario y analytics.',
      icon: 'pi pi-shopping-cart',
      route: '/comercial',
      status: 'Activo',
      anyOf: [
        Permission.COMMERCIAL_ORDERS_VER,
        Permission.COMMERCIAL_ORDERS_CREAR,
        Permission.COMMERCIAL_CUSTOMERS_VER,
        Permission.COMMERCIAL_CUSTOMERS_GESTIONAR,
        Permission.COMMERCIAL_WAREHOUSES_VER,
        Permission.COMMERCIAL_PRICING_VER,
        Permission.COMMERCIAL_INVENTORY_VER,
      ],
      // Vendedor tiene COMMERCIAL_ORDERS_* pero no debe ver el admin de
      // Comercial (mostraría pedidos de toda la tenant) — tiene su propio
      // proyecto "Modo Vendedor" abajo.
      hideForRoles: ['vendedor'],
    },
    {
      id: 'televenta',
      name: 'Televenta',
      description: 'Call center B2B: cola priorizada de clientes, perfil + recomendaciones, pedidos a su nombre y registro de llamadas.',
      icon: 'pi pi-headphones',
      route: '/televenta',
      status: 'Activo',
      anyOf: [
        Permission.COMMERCIAL_TELEVENTA_OPERATE,
        Permission.COMMERCIAL_TELEVENTA_VER,
      ],
    },
    {
      id: 'logistica',
      name: 'Logística',
      description: 'Embarques, flotilla, costos operativos y liquidaciones por catorcena.',
      icon: 'pi pi-truck',
      route: '/logistica',
      status: 'Activo',
      anyOf: [
        Permission.LOGISTICS_SHIPMENTS_VER,
        Permission.LOGISTICS_FLEET_VER,
        Permission.LOGISTICS_PAYROLL_VER,
        Permission.LOGISTICS_EXPENSES_VER,
      ],
    },
    {
      id: 'admin',
      name: 'Administración',
      description: 'Gestión de usuarios, roles y permisos del sistema.',
      icon: 'pi pi-cog',
      route: '/admin',
      status: 'Activo',
      anyOf: [Permission.USUARIOS_GESTIONAR, Permission.ROLES_CONFIGURAR],
    },
  ];

  /**
   * Proyectos visibles: filtrados por permisos del usuario actual.
   * Usa el JWT legacy permissions record (más completo que CASL para perms commercial).
   */
  readonly projects = computed(() => {
    const u = this.user();
    const legacyPerms = u?.permissions || {};
    const role = u?.role_name;
    return this.allProjects.filter((p) => {
      if (p.roleOnly && (!role || !p.roleOnly.includes(role))) return false;
      if (p.hideForRoles && role && p.hideForRoles.includes(role)) return false;
      return p.anyOf.some((perm) => legacyPerms[perm] === true);
    });
  });

  ngOnInit(): void {
    const visible = this.projects();
    // Sin proyectos: el usuario está mal configurado. Mandamos a captures como fallback histórico.
    if (visible.length === 0) {
      this.router.navigate(['/dashboard/captures']);
      return;
    }
    // 1 solo proyecto: skip selector, entrar directo.
    if (visible.length === 1) {
      this.router.navigate([visible[0].route]);
    }
  }

  navigateTo(route: string): void {
    this.router.navigate([route]);
  }

  logout(): void {
    this.authService.logout();
    this.router.navigate(['/login']);
  }
}
