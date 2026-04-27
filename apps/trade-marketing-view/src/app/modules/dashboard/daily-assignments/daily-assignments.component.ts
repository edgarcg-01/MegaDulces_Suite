import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
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

  // State
  loading = signal<boolean>(false);
  team = signal<any[]>([]);
  routes = signal<any[]>([]);
  selectedMember = signal<any | null>(null);
  
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

  ngOnInit(): void {
    this.loadTeamAndRoutes();
  }

  loadTeamAndRoutes() {
    this.loading.set(true);
    const userValue = this.authService.user();
    if (!userValue) return;

    // 1. Load team
    this.usersService.getTeam(userValue.sub).subscribe((data: any[]) => {
      this.team.set(data);
      if (data.length > 0) {
        this.selectMember(data[0]);
      }
      this.loading.set(false);
    });

    // 2. Load routes for the supervisor's zone
    this.adminCatalogsService.getCatalog('zonas').subscribe((zonas: any[]) => {
      const myZone = zonas.find(z => z.value === userValue.zona);
      if (myZone) {
        let params = new HttpParams().set('parent', myZone.id);
        this.http.get<any[]>(`${environment.apiUrl}/catalogs/rutas`, { params }).subscribe((rutas: any[]) => {
          this.routes.set(rutas.map(r => ({ label: r.value, value: r.id })));
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

  getTodayNumber(): number {
    const day = new Date().getDay(); // 0 is Sun, 1 is Mon...
    return day === 0 ? 7 : day;
  }
}
