import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { UsersService } from '../admin-users/users.service';
import { AdminCatalogsService } from '../admin-catalogs/admin-catalogs.service';
import { HttpClient, HttpParams } from '@angular/common/http';
import { environment } from '../../../../environments/environment';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';

@Component({
  selector: 'app-daily-assignments',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TableModule,
    ButtonModule,
    SelectModule,
    TagModule,
    InputTextModule,
    ToastModule,
  ],
  providers: [MessageService],
  templateUrl: './daily-assignments.component.html',
  styleUrls: ['./daily-assignments.component.css']
})
export class DailyAssignmentsComponent implements OnInit {
  private usersService = inject(UsersService);
  private adminCatalogsService = inject(AdminCatalogsService);
  private authService = inject(AuthService);
  private http = inject(HttpClient);
  private messageService = inject(MessageService);
  private router = inject(Router);

  // State
  loading = signal<boolean>(false);
  team = signal<any[]>([]);
  routes = signal<any[]>([]);
  selectedMember = signal<any | null>(null);
  searchQuery = signal<string>('');
  
  // Fixed 7-Day Week
  days = [
    { id: 1, label: 'Lunes' },
    { id: 2, label: 'Martes' },
    { id: 3, label: 'Miércoles' },
    { id: 4, label: 'Jueves' },
    { id: 5, label: 'Viernes' },
    { id: 6, label: 'Sábado' },
    { id: 7, label: 'Domingo' }
  ];

  // Map: dayNumber -> routeId
  weeklyAssignments = signal<Record<number, string>>({});

  // Computed property for filtered team
  filteredTeam = computed(() => {
    const query = this.searchQuery().toLowerCase().trim();
    if (!query) return this.team();
    
    return this.team().filter(member => 
      (member.nombre || member.username || '').toLowerCase().includes(query) ||
      member.username.toLowerCase().includes(query) ||
      (member.zona || '').toLowerCase().includes(query)
    );
  });

  ngOnInit(): void {
    // Verificar permisos antes de cargar datos
    if (!this.authService.hasPermission(Permission.USUARIOS_ASIGNAR_RUTA)) {
      const user = this.authService.user();
      if (user?.role_name === 'colaborador') {
        this.router.navigate(['/dashboard/captures']);
      } else {
        this.router.navigate(['/dashboard']);
      }
      return;
    }
    
    this.loadTeamAndRoutes();
  }

  loadTeamAndRoutes() {
    this.loading.set(true);
    const userValue = this.authService.user();
    if (!userValue) return;

    console.log('[DailyAssignments] Current user:', userValue);
    console.log('[DailyAssignments] User zone:', userValue.zona);

    // 1. Load team and include supervisor
    this.usersService.getTeam(userValue.sub).subscribe((data: any[]) => {
      console.log('[DailyAssignments] Team loaded:', data);
      
      // Check for Paty Chavarria specifically
      const patyMember = data.find(m => 
        m.username?.toLowerCase().includes('paty') || 
        m.nombre?.toLowerCase().includes('paty') ||
        m.username?.toLowerCase().includes('chavarria') || 
        m.nombre?.toLowerCase().includes('chavarria')
      );
      
      if (patyMember) {
        console.log('[DailyAssignments] Paty Chavarria found:', patyMember);
        console.log('[DailyAssignments] Paty Chavarria zone:', patyMember.zona);
      }
      
      // Add supervisor to the team list so they can assign routes to themselves
      const supervisorAsMember = {
        id: userValue.sub,
        username: userValue.username,
        nombre: userValue.username, // JwtPayload doesn't have 'name' property
        zona: userValue.zona,
        role_name: userValue.role_name,
        isSupervisor: true
      };
      
      const allMembers = [supervisorAsMember, ...data];
      this.team.set(allMembers);
      if (allMembers.length > 0) {
        this.selectMember(allMembers[0]);
      }
      this.loading.set(false);
    });

    // 2. Load zones first, then load routes for the specific zone
    this.adminCatalogsService.getCatalog('zonas').subscribe((zonas: any[]) => {
      console.log('[DailyAssignments] User zone:', userValue.zona);
      console.log('[DailyAssignments] Available zones:', zonas);
      console.log('[DailyAssignments] AVAILABLE ZONES FOR ROUTES:', zonas.map(z => z.name || z.value).join(', '));
      
      // Check for specific zones mentioned by user
      const laPiedadRD = zonas.find(z => (z.name && z.name.includes('LA PIEDAD RD')) || (z.value && z.value.includes('LA PIEDAD RD')));
      const laPiedadVecinal = zonas.find(z => (z.name && z.name.includes('LA PIEDAD VECINAL')) || (z.value && z.value.includes('LA PIEDAD VECINAL')));
      const laPiedadNormal = zonas.find(z => z.name === 'LA PIEDAD' || z.value === 'LA PIEDAD');
      
      console.log('[DailyAssignments] LA PIEDAD RD found:', laPiedadRD);
      console.log('[DailyAssignments] LA PIEDAD VECINAL found:', laPiedadVecinal);
      console.log('[DailyAssignments] LA PIEDAD (normal) found:', laPiedadNormal);
      
      // Show all zones containing "LA PIEDAD"
      const allLaPiedadZones = zonas.filter(z => (z.name && z.name.includes('LA PIEDAD')) || (z.value && z.value.includes('LA PIEDAD')));
      console.log('[DailyAssignments] ALL LA PIEDAD ZONES:', allLaPiedadZones.map(z => ({ id: z.id, name: z.name, value: z.value })));
      
      // Find the user's zone
      console.log('[DailyAssignments] Available zones with details:', zonas.map(z => ({ id: z.id, name: z.name, value: z.value })));
      const myZone = zonas.find(z => {
        const match = z.value === userValue.zona || z.name === userValue.zona;
        console.log('[DailyAssignments] Checking zone:', { name: z.name, value: z.value, userZone: userValue.zona, match });
        if (match) {
          console.log('[DailyAssignments] Found matching zone:', z, 'for user zone:', userValue.zona);
        }
        return match;
      });
      
      console.log('[DailyAssignments] Final matched zone:', myZone);
      
      if (myZone) {
        // Load routes specifically for this zone using backend filtering
        let params = new HttpParams().set('parent', myZone.id);
        console.log('[DailyAssignments] Loading routes for zone:', myZone.id, '(', myZone.name, ')');
        
        this.http.get<any[]>(`${environment.apiUrl}/catalogs/rutas`, { params }).subscribe((zoneRoutes: any[]) => {
          console.log('[DailyAssignments] Zone-specific routes from backend:', zoneRoutes);
          console.log('[DailyAssignments] Routes count:', zoneRoutes.length);
          console.log('[DailyAssignments] Routes with details:', zoneRoutes.map(r => ({ id: r.id, value: r.value, parent_id: r.parent_id })));
          
          if (zoneRoutes.length > 0) {
            this.routes.set(zoneRoutes.map(r => ({ label: r.value, value: r.id })));
            console.log('[DailyAssignments] Set zone routes:', zoneRoutes.map(r => r.value));
          } else {
            console.warn('[DailyAssignments] No routes found for zone', myZone.name);
            this.routes.set([]);
            this.messageService.add({
              severity: 'warn',
              summary: 'Sin Rutas',
              detail: `No hay rutas configuradas para la zona ${myZone.name}`
            });
          }
        }, (error) => {
          console.error('[DailyAssignments] Error loading zone routes:', error);
          this.routes.set([]);
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: 'No se pudieron cargar las rutas'
          });
        });
      } else {
        console.warn('[DailyAssignments] No zone matched for user zone:', userValue.zona);
        this.routes.set([]);
        this.messageService.add({
          severity: 'warn',
          summary: 'Zona No Encontrada',
          detail: `No se encontró la zona "${userValue.zona}" para el usuario`
        });
      }
    });
  }

  selectMember(member: any) {
    this.selectedMember.set(member);
    this.loadWeeklyAssignments();
  }

  loadWeeklyAssignments() {
    const member = this.selectedMember();
    if (!member) return;

    let params = new HttpParams().set('user_id', member.id);

    this.http.get<any[]>(`${environment.apiUrl}/daily-assignments`, { params })
      .subscribe((data: any[]) => {
        const map: Record<number, string> = {};
        data.forEach(asgn => {
          map[asgn.day_of_week] = asgn.route_id;
        });
        this.weeklyAssignments.set(map);
      });
  }

  saveAssignment(dayId: number, routeId: string) {
    const member = this.selectedMember();
    if (!member || !routeId) return;

    const supervisor = this.authService.user();

    const payload = {
      user_id: member.id,
      route_id: routeId,
      day_of_week: dayId,
      assigned_by: supervisor?.sub,
      status: 'pendiente'
    };

    this.http.post(`${environment.apiUrl}/daily-assignments`, payload).subscribe({
      next: () => {
        this.weeklyAssignments.update(prev => ({ ...prev, [dayId]: routeId }));
        this.messageService.add({
          severity: 'success',
          summary: 'Asignación guardada',
          detail: `Ruta asignada para ${this.days.find(d => d.id === dayId)?.label}`,
        });
      },
      error: (err) => {
        console.error('Error saving assignment', err);
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: 'No se pudo guardar la asignación',
        });
      }
    });
  }

  // Get route name from route ID
  getRouteName(routeId: string): string {
    if (!routeId) return '';
    const route = this.routes().find(r => r.value === routeId);
    return route ? route.label : '';
  }

  getTodayNumber(): number {
    const day = new Date().getDay(); // 0 is Sun, 1 is Mon...
    return day === 0 ? 7 : day;
  }
}
