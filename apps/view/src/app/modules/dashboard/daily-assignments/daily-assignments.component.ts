import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { TooltipModule } from 'primeng/tooltip';
import { ConfirmationService, MessageService } from 'primeng/api';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpClient, HttpParams } from '@angular/common/http';
import { UsersService } from '../admin-users/users.service';
import { AdminCatalogsService } from '../admin-catalogs/admin-catalogs.service';
import { environment } from '../../../../environments/environment';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';

interface TeamMember {
  id: string;
  username: string;
  nombre?: string;
  zona?: string;
  role_name?: string;
  isSupervisor?: boolean;
}

interface RouteOption {
  label: string;
  value: string;
}

interface ZoneRow {
  id: string;
  value?: string;
  name?: string;
}

interface RouteRow {
  id: string;
  value: string;
}

interface AssignmentRow {
  id: string;
  user_id: string;
  route_id: string;
  day_of_week: number;
}

interface WeeklyEntry {
  assignmentId: string;
  routeId: string;
}

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
    ConfirmDialogModule,
    TooltipModule,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './daily-assignments.component.html',
  styleUrls: ['./daily-assignments.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DailyAssignmentsComponent implements OnInit {
  private usersService = inject(UsersService);
  private adminCatalogsService = inject(AdminCatalogsService);
  private authService = inject(AuthService);
  private perms = inject(PermissionsService);
  private http = inject(HttpClient);
  private messageService = inject(MessageService);
  private confirmationService = inject(ConfirmationService);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  loadingTeam = signal<boolean>(false);
  savingDay = signal<number | null>(null);
  team = signal<TeamMember[]>([]);
  routes = signal<RouteOption[]>([]);
  selectedMember = signal<TeamMember | null>(null);
  searchQuery = signal<string>('');
  weeklyAssignments = signal<Record<number, WeeklyEntry>>({});

  private zonasCache: ZoneRow[] | null = null;
  private routesByZoneCache = new Map<string, RouteOption[]>();
  private currentZoneId: string | null = null;

  readonly todayNumber = computed(() => {
    const day = new Date().getDay();
    return day === 0 ? 7 : day;
  });

  readonly days = [
    { id: 1, label: 'Lunes' },
    { id: 2, label: 'Martes' },
    { id: 3, label: 'Miércoles' },
    { id: 4, label: 'Jueves' },
    { id: 5, label: 'Viernes' },
    { id: 6, label: 'Sábado' },
    { id: 7, label: 'Domingo' },
  ];

  readonly filteredTeam = computed(() => {
    const query = this.searchQuery().toLowerCase().trim();
    const team = this.team();
    if (!query) return team;

    return team.filter((member) => {
      const nombre = (member.nombre ?? '').toLowerCase();
      const username = (member.username ?? '').toLowerCase();
      const zona = (member.zona ?? '').toLowerCase();
      return (
        nombre.includes(query) ||
        username.includes(query) ||
        zona.includes(query)
      );
    });
  });

  ngOnInit(): void {
    if (!this.perms.can('read', 'users_assign_route')) {
      if (
        this.perms.can('read', 'reports_team') ||
        this.perms.can('read', 'reports_global')
      ) {
        this.router.navigate(['/dashboard']);
      } else {
        this.router.navigate(['/dashboard/captures']);
      }
      return;
    }

    this.loadTeam();
  }

  private loadTeam(): void {
    this.loadingTeam.set(true);
    const userValue = this.authService.user();
    if (!userValue) {
      this.loadingTeam.set(false);
      return;
    }

    this.usersService
      .getTeam(userValue.sub)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data: TeamMember[]) => {
          const alreadyIncluded = data.some((m) => m.id === userValue.sub);
          const supervisorAsMember: TeamMember = {
            id: userValue.sub,
            username: userValue.username,
            nombre: userValue.username,
            zona: userValue.zona,
            role_name: userValue.role_name,
            isSupervisor: true,
          };

          const allMembers: TeamMember[] = alreadyIncluded
            ? data
            : [supervisorAsMember, ...data];

          this.team.set(allMembers);
          this.loadingTeam.set(false);
          if (allMembers.length > 0) {
            this.selectMember(allMembers[0]);
          }
        },
        error: () => {
          this.loadingTeam.set(false);
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: 'No se pudo cargar el equipo.',
          });
        },
      });
  }

  selectMember(member: TeamMember): void {
    this.selectedMember.set(member);
    this.loadWeeklyAssignments(member);
    this.loadRoutesForMember(member);
  }

  onSearchChange(value: string): void {
    this.searchQuery.set(value);
  }

  /**
   * Carga rutas para la zona del miembro. Usa cache por zona para evitar
   * refetch si el siguiente miembro pertenece a la misma zona.
   */
  private loadRoutesForMember(member: TeamMember): void {
    const memberZona = member.zona;
    if (!memberZona) {
      this.routes.set([]);
      this.currentZoneId = null;
      this.messageService.add({
        severity: 'warn',
        summary: 'Sin zona',
        detail: `${member.username} no tiene zona asignada.`,
      });
      return;
    }

    const resolveAndFetch = (zonas: ZoneRow[]) => {
      const memberZone = zonas.find(
        (z) => z.value === memberZona || z.name === memberZona,
      );
      if (!memberZone) {
        this.routes.set([]);
        this.currentZoneId = null;
        this.messageService.add({
          severity: 'warn',
          summary: 'Zona no encontrada',
          detail: `No se encontró la zona "${memberZona}".`,
        });
        return;
      }

      // Cache-hit: misma zona que la del miembro anterior — reusar rutas.
      const cached = this.routesByZoneCache.get(memberZone.id);
      if (cached) {
        this.currentZoneId = memberZone.id;
        this.routes.set(cached);
        return;
      }

      const params = new HttpParams().set('parent', memberZone.id);
      this.http
        .get<RouteRow[]>(`${environment.apiUrl}/catalogs/rutas`, { params })
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (zoneRoutes) => {
            if (this.selectedMember()?.id !== member.id) return;
            const options: RouteOption[] = zoneRoutes.map((r) => ({
              label: r.value,
              value: r.id,
            }));
            this.routesByZoneCache.set(memberZone.id, options);
            this.currentZoneId = memberZone.id;
            this.routes.set(options);
            if (zoneRoutes.length === 0) {
              this.messageService.add({
                severity: 'warn',
                summary: 'Sin rutas',
                detail: `No hay rutas configuradas para ${memberZone.name ?? memberZone.value}.`,
              });
            }
          },
          error: () => {
            if (this.selectedMember()?.id !== member.id) return;
            this.routes.set([]);
            this.currentZoneId = null;
            this.messageService.add({
              severity: 'error',
              summary: 'Error',
              detail: 'No se pudieron cargar las rutas.',
            });
          },
        });
    };

    if (this.zonasCache) {
      resolveAndFetch(this.zonasCache);
      return;
    }

    this.adminCatalogsService
      .getCatalog('zonas')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (zonas: ZoneRow[]) => {
          this.zonasCache = zonas;
          resolveAndFetch(zonas);
        },
        error: () => {
          this.routes.set([]);
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: 'No se pudieron cargar las zonas.',
          });
        },
      });
  }

  private loadWeeklyAssignments(member: TeamMember): void {
    this.weeklyAssignments.set({});

    const params = new HttpParams().set('user_id', member.id);
    this.http
      .get<AssignmentRow[]>(`${environment.apiUrl}/daily-assignments`, {
        params,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data) => {
          if (this.selectedMember()?.id !== member.id) return;
          const map: Record<number, WeeklyEntry> = {};
          data.forEach((asgn) => {
            map[asgn.day_of_week] = {
              assignmentId: asgn.id,
              routeId: asgn.route_id,
            };
          });
          this.weeklyAssignments.set(map);
        },
        error: () => {
          if (this.selectedMember()?.id !== member.id) return;
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: 'No se pudieron cargar las asignaciones.',
          });
        },
      });
  }

  /**
   * Helper para el template — devuelve el route_id de un día (o undefined).
   */
  routeIdForDay(dayId: number): string | undefined {
    return this.weeklyAssignments()[dayId]?.routeId;
  }

  saveAssignment(dayId: number, routeId: string | null): void {
    const member = this.selectedMember();
    if (!member || !routeId) return;

    // Snapshot para rollback si el POST falla.
    const previous = this.weeklyAssignments()[dayId];

    const payload = {
      user_id: member.id,
      route_id: routeId,
      day_of_week: dayId,
      status: 'pendiente',
    };

    this.savingDay.set(dayId);
    this.http
      .post<AssignmentRow>(`${environment.apiUrl}/daily-assignments`, payload)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (created) => {
          if (this.selectedMember()?.id !== member.id) {
            this.savingDay.set(null);
            return;
          }
          this.weeklyAssignments.update((prev) => ({
            ...prev,
            [dayId]: { assignmentId: created.id, routeId: created.route_id },
          }));
          this.savingDay.set(null);
          this.messageService.add({
            severity: 'success',
            summary: 'Asignación guardada',
            detail: `Ruta asignada para ${this.days.find((d) => d.id === dayId)?.label}.`,
          });
        },
        error: (err) => {
          this.savingDay.set(null);
          // Rollback al valor anterior para mantener UI consistente.
          this.weeklyAssignments.update((prev) => {
            const next = { ...prev };
            if (previous) {
              next[dayId] = previous;
            } else {
              delete next[dayId];
            }
            return next;
          });
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail:
              err?.error?.message ?? 'No se pudo guardar la asignación.',
          });
        },
      });
  }

  clearAssignment(dayId: number): void {
    const entry = this.weeklyAssignments()[dayId];
    if (!entry) return;
    const dayLabel = this.days.find((d) => d.id === dayId)?.label ?? '';
    const memberName =
      this.selectedMember()?.nombre || this.selectedMember()?.username || '';

    this.confirmationService.confirm({
      header: 'Quitar ruta',
      message: `¿Quitar la ruta de ${dayLabel} para ${memberName}?`,
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, quitar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        const previous = entry;
        this.savingDay.set(dayId);
        // Optimismo: limpiar primero, revertir si falla.
        this.weeklyAssignments.update((prev) => {
          const next = { ...prev };
          delete next[dayId];
          return next;
        });
        this.http
          .delete(`${environment.apiUrl}/daily-assignments/${entry.assignmentId}`)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            next: () => {
              this.savingDay.set(null);
              this.messageService.add({
                severity: 'success',
                summary: 'Ruta quitada',
                detail: `${dayLabel} sin asignación.`,
              });
            },
            error: (err) => {
              this.savingDay.set(null);
              this.weeklyAssignments.update((prev) => ({
                ...prev,
                [dayId]: previous,
              }));
              this.messageService.add({
                severity: 'error',
                summary: 'Error',
                detail:
                  err?.error?.message ?? 'No se pudo quitar la asignación.',
              });
            },
          });
      },
    });
  }

  getRouteName(routeId: string | undefined): string {
    if (!routeId) return '';
    const route = this.routes().find((r) => r.value === routeId);
    return route ? route.label : '';
  }
}
