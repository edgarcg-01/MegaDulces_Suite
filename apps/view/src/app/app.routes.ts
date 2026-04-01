import { Routes } from '@angular/router';
import { LoginComponent } from './modules/auth/login/login.component';
import { ProjectsComponent } from './modules/projects/projects/projects.component';
import { LayoutComponent } from './modules/dashboard/layout/layout.component';
import { HomeComponent } from './modules/dashboard/home/home.component';
import { CapturesComponent } from './modules/dashboard/captures/captures.component';
import { ReportsComponent } from './modules/dashboard/reports/reports.component';
import { StoresComponent } from './modules/dashboard/stores/stores.component';
import { VisitsComponent } from './modules/dashboard/visits/visits.component';
import { ExhibitionsComponent } from './modules/dashboard/exhibitions/exhibitions.component';
import { AdminUsersComponent } from './modules/dashboard/admin-users/admin-users.component';
import { AdminCatalogsComponent } from './modules/dashboard/admin-catalogs/admin-catalogs.component';
import { AdminPlanogramaComponent } from './modules/dashboard/admin-planograma/admin-planograma.component';
import { AdminScoringComponent } from './modules/dashboard/admin-scoring/admin-scoring.component';
import { authGuard } from './core/guards/auth.guard';

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
    canActivate: [authGuard],
    component: LayoutComponent,
    children: [
      { path: '', component: HomeComponent },
      { path: 'captures', component: CapturesComponent },
      { path: 'reports', component: ReportsComponent },
      { path: 'stores', component: StoresComponent },
      { path: 'visits', component: VisitsComponent },
      { path: 'exhibitions', component: ExhibitionsComponent },
      { path: 'admin/users', component: AdminUsersComponent },
      { path: 'admin/catalogs/:type', component: AdminCatalogsComponent },
      { path: 'admin/planograma', component: AdminPlanogramaComponent },
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
