import { Routes } from '@angular/router';
import { LoginComponent } from './modules/auth/login/login.component';
import { ProjectsComponent } from './modules/projects/projects/projects.component';
import { LayoutComponent } from './modules/dashboard/layout/layout.component';
import { authGuard } from './core/guards/auth.guard';
import { permissionGuard, colaboradorGuard } from './core/guards/permission.guard';
import { Permission } from './core/constants/permissions';

export const routes: Routes = [
  {
    path: 'login',
    component: LoginComponent
  },
  {
    path: 'projects',
    canActivate: [authGuard],
    component: ProjectsComponent
  },
  {
    path: 'dashboard',
    canActivate: [authGuard, colaboradorGuard],
    component: LayoutComponent,
    children: [
      { path: '', loadComponent: () => import('./modules/dashboard/home/home.component').then(m => m.HomeComponent) },
      { path: 'dashboard', loadComponent: () => import('./modules/dashboard/reports/graphics/dashboard.component').then(m => m.DashboardComponent) },
      { path: 'captures', loadComponent: () => import('./modules/dashboard/captures/captures.component').then(m => m.CapturesComponent) },
      { path: 'reports', loadComponent: () => import('./modules/dashboard/reports/reports.component').then(m => m.ReportsComponent) },
      { path: 'seguimiento', loadComponent: () => import('./modules/dashboard/seguimiento/seguimiento.component').then(m => m.SeguimientoComponent), canActivate: [permissionGuard(Permission.VER_SEGUIMIENTO)] },
      { path: 'stores', loadComponent: () => import('./modules/dashboard/stores/stores.component').then(m => m.StoresComponent), canActivate: [permissionGuard(Permission.TIENDAS_VER)] },
      { path: 'visits', loadComponent: () => import('./modules/dashboard/visits/visits.component').then(m => m.VisitsComponent) },
      { path: 'exhibitions', loadComponent: () => import('./modules/dashboard/exhibitions/exhibitions.component').then(m => m.ExhibitionsComponent) },
      { 
        path: 'admin/users', 
        loadComponent: () => import('./modules/dashboard/admin-users/admin-users.component').then(m => m.AdminUsersComponent),
        canActivate: [permissionGuard(Permission.USUARIOS_GESTIONAR)]
      },
      { 
        path: 'admin/catalogs/roles', 
        loadComponent: () => import('./modules/dashboard/admin-catalogs/admin-catalogs.component').then(m => m.AdminCatalogsComponent),
        canActivate: [permissionGuard(Permission.ROLES_CONFIGURAR)]
      },
      { 
        path: 'admin/catalogs/:type', 
        loadComponent: () => import('./modules/dashboard/admin-catalogs/admin-catalogs.component').then(m => m.AdminCatalogsComponent),
        canActivate: [permissionGuard(Permission.CATALOGO_GESTIONAR)]
      },
      { 
        path: 'admin/roles/:role_name/permissions', 
        loadComponent: () => import('./modules/dashboard/admin-roles/admin-roles-permissions.component').then(m => m.AdminRolesPermissionsComponent),
        canActivate: [permissionGuard(Permission.ROLES_CONFIGURAR)]
      },
      { 
        path: 'admin/planograma', 
        loadComponent: () => import('./modules/dashboard/admin-planograma/admin-planograma.component').then(m => m.AdminPlanogramaComponent),
        canActivate: [permissionGuard(Permission.PLANOGRAMAS_GESTIONAR)]
      },
      { 
        path: 'daily-assignments', 
        loadComponent: () => import('./modules/dashboard/daily-assignments/daily-assignments.component').then(m => m.DailyAssignmentsComponent),
        canActivate: [permissionGuard(Permission.USUARIOS_ASIGNAR_RUTA)]
      },
    ]
  },
  {
    path: '',
    redirectTo: '/projects',
    pathMatch: 'full'
  },
  {
    path: '**',
    redirectTo: '/login'
  }
];
