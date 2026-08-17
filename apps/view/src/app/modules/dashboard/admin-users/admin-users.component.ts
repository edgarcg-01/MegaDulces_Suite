import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';

import { DecimalPipe } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import {
  FormBuilder,
  FormGroup,
  FormsModule,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { ToastModule } from 'primeng/toast';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import {
  rxResource,
  takeUntilDestroyed,
  toObservable,
  toSignal,
} from '@angular/core/rxjs-interop';
import { debounceTime, distinctUntilChanged } from 'rxjs';
import {
  UsersService,
  User,
  UserCreatePayload,
  UserUpdatePayload,
  SupervisorOption as SupervisorRow,
  ZoneOption as ZoneRow,
  FinanceAreaOption,
} from './users.service';
import { AdminCatalogsService } from '../admin-catalogs/admin-catalogs.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { STORE_BRANCHES } from '../../../core/constants/store-branches';
import { AREAS, AreaMeta, roleAreaSlug } from '../../../core/constants/role-presets';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';

/** Departamento con su conteo y su higiene de accesos (lo que decide a dónde entrar). */
export interface DeptRow {
  area: AreaMeta;
  total: number;
  activos: number;
  /** Activos que NUNCA entraron. */
  nunca: number;
  /** Activos sin entrar hace más de 90 días. */
  dormidos: number;
  /** Roles distintos conviviendo en el departamento (delata desorden de permisos). */
  roles: number;
}

interface RoleOption {
  label: string;
  value: string;
}

interface SupervisorOption {
  label: string;
  value: string;
}

interface ZoneOption {
  label: string;
  value: string;
  id: string;
}

@Component({
  selector: 'app-admin-users',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    TableModule,
    ButtonModule,
    TagModule,
    InputTextModule,
    SelectModule,
    MultiSelectModule,
    ToggleSwitchModule,
    ToastModule,
    ConfirmDialogModule,
    IconFieldModule,
    InputIconModule,
    FormsModule,
    SidePeekComponent,
    DecimalPipe,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './admin-users.component.html',
  styleUrls: ['./admin-users.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminUsersComponent implements OnInit {
  private usersService = inject(UsersService);
  private catalogsService = inject(AdminCatalogsService);
  private fb = inject(FormBuilder);
  private messageService = inject(MessageService);
  private confirmationService = inject(ConfirmationService);
  private authService = inject(AuthService);
  private perms = inject(PermissionsService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private destroyRef = inject(DestroyRef);

  // Lectura reactiva: búsqueda client-side (filteredUsers) → el padrón se carga entero
  // una vez; recarga por tick tras alta/edición/baja.
  private readonly usersTick = signal(0);
  private readonly usersRes = rxResource({
    params: () => this.usersTick(),
    stream: () => this.usersService.findAll(),
  });
  readonly users = computed<User[]>(() => this.usersRes.value() ?? []);
  readonly loading = computed(() => this.usersRes.isLoading());
  displayDialog = signal<boolean>(false);
  isEditing = signal<boolean>(false);
  currentUserId = signal<string | null>(null);
  searchText = signal<string>('');
  saving = signal<boolean>(false);

  // Permisos para gating de botones de write
  readonly canManageUsers = this.perms.can$('manage', 'users');

  // Búsqueda debounceada (250 ms) para no recomputar `filteredUsers` en cada
  // keystroke cuando el padrón crece.
  private debouncedSearch = toSignal(
    toObservable(this.searchText).pipe(
      debounceTime(250),
      distinctUntilChanged(),
    ),
    { initialValue: '' },
  );

  filteredUsers = computed(() => {
    const query = this.debouncedSearch().toLowerCase().trim();
    if (!query) return this.users();
    return this.users().filter((user) => {
      return (
        (user.username ?? '').toLowerCase().includes(query) ||
        (user.nombre ?? '').toLowerCase().includes(query) ||
        (user.role_name ?? '').toLowerCase().includes(query) ||
        (user.zona ?? '').toLowerCase().includes(query)
      );
    });
  });

  // ── Master-detail por departamento ─────────────────────────────────────────
  // El "departamento" NO es un campo: se deriva del rol con `roleAreaSlug` sobre
  // las 15 áreas de role-presets. Por eso el rediseño no necesitó migración.
  // '' = todos.
  readonly selectedDept = signal<string>('');

  /** Días sin entrar. `null` = nunca entró. */
  private daysSinceLogin(u: User): number | null {
    if (!u.last_login_at) return null;
    return (Date.now() - new Date(u.last_login_at).getTime()) / 864e5;
  }

  /**
   * Departamentos con conteo + higiene de accesos. Se calcula sobre el padrón
   * COMPLETO, no sobre el filtrado: el aside es un índice estable, no debe
   * bailar mientras escribís en el buscador.
   */
  readonly departments = computed<DeptRow[]>(() => {
    const all = this.users();
    return AREAS.map((area) => {
      const list = all.filter((u) => roleAreaSlug(u.role_name) === area.slug);
      const activos = list.filter((u) => u.activo);
      let nunca = 0, dormidos = 0;
      for (const u of activos) {
        const d = this.daysSinceLogin(u);
        if (d === null) nunca++;
        else if (d > 90) dormidos++;
      }
      return {
        area,
        total: list.length,
        activos: activos.length,
        nunca,
        dormidos,
        roles: new Set(list.map((u) => u.role_name).filter(Boolean)).size,
      };
    }).filter((d) => d.total > 0);
  });

  /** Total de cuentas con alerta de acceso, para el resumen del encabezado. */
  readonly alertTotal = computed(() =>
    this.departments().reduce((a, d) => a + d.nunca + d.dormidos, 0));

  /** Filtro "sólo con alerta de acceso": el contador del resumen es accionable. */
  readonly onlyAlerts = signal(false);
  toggleAlerts(): void { this.onlyAlerts.update((v) => !v); }

  /** ¿Esta cuenta activa nunca entró o lleva +90 días sin entrar? */
  hasAccessAlert(u: User): boolean {
    if (!u.activo) return false;
    const d = this.daysSinceLogin(u);
    return d === null || d > 90;
  }

  /** Usuarios del departamento elegido, ya pasados por el buscador. */
  readonly deptUsers = computed<User[]>(() => {
    const slug = this.selectedDept();
    let list = this.filteredUsers();
    if (slug) list = list.filter((u) => roleAreaSlug(u.role_name) === slug);
    if (this.onlyAlerts()) list = list.filter((u) => this.hasAccessAlert(u));
    return list;
  });

  /** Fila del departamento activo (null = "Todos"). */
  readonly currentDept = computed<DeptRow | null>(() =>
    this.departments().find((d) => d.area.slug === this.selectedDept()) ?? null);

  /**
   * Elegir departamento deja rastro en la URL (DESIGN §9: el estado de la vista
   * vive en la URL). Así F5 no pierde el contexto y se puede compartir
   * "los usuarios de Compras" como liga.
   */
  selectDept(slug: string): void {
    this.selectedDept.set(slug);
    this.closeEditor();
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { dept: slug || null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /** Etiqueta de alerta del departamento; '' cuando no hay nada que señalar. */
  deptAlert(d: DeptRow): string {
    const bits: string[] = [];
    if (d.dormidos) bits.push(`${d.dormidos} sin entrar +90d`);
    if (d.nunca) bits.push(`${d.nunca} nunca`);
    return bits.join(' · ');
  }

  /** Color de avatar hash-seeded sobre la escala --avatar-1..8 (AA ≥ 4.5 sobre texto blanco). */
  avatarColorFor(seed: string): string {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
    return `var(--avatar-${(Math.abs(h) % 8) + 1})`;
  }

  getInitials(name?: string | null): string {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  /** Color del dot de actividad. Inactivo > stale > recent > nunca. */
  activityDotColor(user: User): string {
    if (!user.activo) return 'var(--bad-fg)';
    if (!user.last_login_at) return 'var(--text-faint)';
    const days = (Date.now() - new Date(user.last_login_at).getTime()) / 864e5;
    if (days < 7) return 'var(--ok-fg)';
    return 'var(--warn-fg)';
  }

  userForm: FormGroup;

  roles = signal<RoleOption[]>([]);
  supervisors = signal<SupervisorOption[]>([]);
  zones = signal<ZoneOption[]>([]);
  // GX.8 — áreas de gasto visibles asignables al usuario (dimensión canónica).
  financeAreas = signal<FinanceAreaOption[]>([]);
  // Opciones de sucursal para el monitor Tienda (null = ve todas / rol global).
  readonly branchOptions = STORE_BRANCHES.map((b) => ({ label: `${b.code} · ${b.name}`, value: b.code }));

  // Roles que el usuario actual puede asignar (oculta superadmin si no lo es).
  readonly assignableRoles = computed(() => {
    const isSuperadmin = this.authService.user()?.role_name === 'superadmin';
    return this.roles().filter(
      (r) => isSuperadmin || r.value.toLowerCase() !== 'superadmin',
    );
  });

  constructor() {
    this.userForm = this.fb.group({
      username: ['', Validators.required],
      password: [''],
      nombre: [''],
      zona: [''],
      zona_id: [''],
      role_name: ['', Validators.required],
      supervisor_id: [null],
      warehouse_code: [null],
      finance_expense_area_ids: [[] as string[]],
      activo: [true],
    });

    // Toast en error de la carga del padrón (equivale al catch del subscribe viejo).
    effect(() => { if (this.usersRes.error()) this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el padrón.' }); });

    this.userForm
      .get('role_name')
      ?.valueChanges.pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((role) => {
        const supervisorControl = this.userForm.get('supervisor_id');
        // El supervisor se RECOMIENDA para roles supervisados pero NO bloquea el
        // guardado: requerirlo dejaba el form inválido y saveUser() abortaba en
        // silencio cuando el supervisor aún no estaba asignado (o el dropdown venía vacío).
        if (!this.isSupervisedRole(role)) {
          supervisorControl?.setValue(null);
        }
        supervisorControl?.updateValueAndValidity();
      });

    // Al cambiar la zona por nombre, resolver y guardar zona_id.
    this.userForm
      .get('zona')
      ?.valueChanges.pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((zonaName) => {
        if (zonaName) {
          const selectedZone = this.zones().find((z) => z.value === zonaName);
          this.userForm
            .get('zona_id')
            ?.setValue(selectedZone ? selectedZone.id : null);
        } else {
          this.userForm.get('zona_id')?.setValue(null);
        }
      });
  }

  ngOnInit(): void {
    if (!this.perms.can('read', 'users')) {
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

    this.loadRoles();
    this.loadSupervisors();
    this.loadZones();
    this.loadFinanceAreas();

    // Estado de la vista en la URL (DESIGN §9): ?dept=compras vuelve al mismo
    // departamento tras F5 y se puede compartir como liga.
    const dept = this.route.snapshot.queryParamMap.get('dept');
    if (dept) this.selectedDept.set(dept);
  }

  /** Catálogo de áreas de gasto (GX.8) para el selector de "áreas visibles". Best-effort. */
  loadFinanceAreas(): void {
    this.usersService
      .financeAreas()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (data) => this.financeAreas.set(data || []), error: () => this.financeAreas.set([]) });
  }

  onSearchChange(value: string): void {
    this.searchText.set(value);
  }

  loadZones(): void {
    this.usersService
      .getZones()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data: ZoneRow[]) => {
          this.zones.set(
            data.map((z) => ({ label: z.value, value: z.value, id: z.id })),
          );
        },
        error: () => this.zones.set([]),
      });
  }

  loadRoles(): void {
    this.catalogsService
      .getCatalog('roles')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data: { value: string }[]) => {
          this.roles.set(
            data.map((item) => ({
              label: item.value.charAt(0).toUpperCase() + item.value.slice(1),
              value: item.value,
            })),
          );
        },
        error: () => this.roles.set([]),
      });
  }

  loadSupervisors(): void {
    this.usersService
      .getSupervisors()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data: SupervisorRow[]) => {
          this.supervisors.set(
            data.map((s) => ({
              label: s.nombre || s.username,
              value: s.id,
            })),
          );
        },
        error: () => this.supervisors.set([]),
      });
  }

  /** Re-fetch silencioso de los catálogos que alimentan el form de usuario. */
  private refreshLookups(): void {
    this.loadRoles();
    this.loadSupervisors();
    this.loadZones();
  }

  loadUsers(): void {
    this.usersTick.update((t) => t + 1);
  }

  openNewDialog(): void {
    this.isEditing.set(false);
    this.currentUserId.set(null);
    this.userForm.reset({ activo: true, role_name: '', finance_expense_area_ids: [] });
    this.userForm.get('username')?.enable();
    this.userForm
      .get('password')
      ?.setValidators([Validators.required, Validators.minLength(6)]);
    this.userForm.get('password')?.updateValueAndValidity();
    this.refreshLookups();
    this.displayDialog.set(true);
  }

  openEditDialog(user: User): void {
    this.isEditing.set(true);
    this.currentUserId.set(user.id);
    this.userForm.get('username')?.enable();
    this.userForm.get('password')?.clearValidators();
    this.userForm.get('password')?.setValidators([Validators.minLength(6)]);
    this.userForm.get('password')?.updateValueAndValidity();

    this.userForm.patchValue({
      username: user.username,
      password: '',
      nombre: user.nombre,
      zona: user.zona,
      zona_id: user.zona_id,
      role_name: user.role_name,
      supervisor_id: user.supervisor_id,
      warehouse_code: user.warehouse_code ?? null,
      finance_expense_area_ids: user.finance_expense_area_ids ?? [],
      activo: user.activo,
    });

    this.refreshLookups();
    this.displayDialog.set(true);
  }

  closeDialog(): void {
    this.displayDialog.set(false);
  }

  /** Cierra el side-peek de edición (mismo estado, nombre del organismo nuevo). */
  closeEditor(): void {
    this.displayDialog.set(false);
  }

  saveUser(): void {
    if (this.saving()) return;
    // Nunca fallar en silencio: si el form es inválido, marcar y avisar el motivo.
    if (this.userForm.invalid) {
      this.userForm.markAllAsTouched();
      this.messageService.add({
        severity: 'warn',
        summary: 'Revisa el formulario',
        detail: 'Faltan campos obligatorios (usuario y rol son requeridos).',
      });
      return;
    }
    const formData = this.userForm.getRawValue();

    if (formData.role_name) {
      formData.role_name = formData.role_name.toLowerCase();
    }

    this.saving.set(true);

    if (this.isEditing() && this.currentUserId()) {
      const updateData: UserUpdatePayload = { ...formData };
      if (!updateData.password || updateData.password.trim() === '') {
        delete updateData.password;
      }
      this.usersService
        .update(this.currentUserId()!, updateData)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: () => {
            this.saving.set(false);
            this.displayDialog.set(false);
            this.loadUsers();
            this.refreshLookups();
            this.messageService.add({
              severity: 'success',
              summary: 'Éxito',
              detail: 'Usuario actualizado correctamente.',
            });
          },
          error: (err: { error?: { message?: string } }) => {
            this.saving.set(false);
            this.messageService.add({
              severity: 'error',
              summary: 'Error',
              detail: err?.error?.message || 'Error al actualizar usuario.',
            });
          },
        });
    } else {
      const createData: UserCreatePayload = { ...formData };
      this.usersService
        .create(createData)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: () => {
            this.saving.set(false);
            this.displayDialog.set(false);
            this.loadUsers();
            this.refreshLookups();
            this.messageService.add({
              severity: 'success',
              summary: 'Éxito',
              detail: 'Usuario creado correctamente.',
            });
          },
          error: (err: { error?: { message?: string } }) => {
            this.saving.set(false);
            this.messageService.add({
              severity: 'error',
              summary: 'Error',
              detail: err?.error?.message || 'Error al crear usuario.',
            });
          },
        });
    }
  }

  deleteUser(user: User): void {
    if (!user.id) return;

    const userName = user.nombre || user.username;
    this.confirmationService.confirm({
      message: `¿Estás seguro de eliminar el usuario "${userName}"? Esta acción desactivará el usuario.`,
      header: 'Confirmar Eliminación',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, eliminar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => this.executeDelete(user.id),
    });
  }

  private executeDelete(id: string): void {
    this.usersService
      .remove(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.loadUsers();
          this.refreshLookups();
          this.messageService.add({
            severity: 'success',
            summary: 'Eliminado',
            detail: 'Usuario desactivado correctamente.',
          });
        },
        error: (err: { error?: { message?: string } }) => {
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: err?.error?.message || 'No se pudo eliminar el usuario.',
          });
        },
      });
  }

  /**
   * Roles de campo/ventas que reportan a un supervisor de ventas. Para ellos se
   * muestra (y exige) el selector de supervisor; el resto no lo lleva. Antes
   * solo aplicaba a `colaborador`, por eso vendedor/ejecutivo no podían tener
   * supervisor y no aparecían en la asignación diaria de su supervisor.
   */
  private readonly supervisedRoles = ['colaborador', 'ejecutivo', 'vendedor'];

  isSupervisedRole(role?: string | null): boolean {
    return !!role && this.supervisedRoles.includes(role.toLowerCase());
  }

  getSupervisorName(id: string | undefined): string {
    if (!id) return 'N/A';
    const s = this.supervisors().find((x) => x.value === id);
    return s ? s.label : 'N/A';
  }

  /**
   * Format relativo (ej. "Hace 5 min", "Hace 2 h", "Hace 3 días", "Hace 2 meses").
   * `null` / `undefined` → "Nunca". Útil para feed de actividad de usuarios.
   */
  formatLastLogin(iso?: string | null): string {
    if (!iso) return 'Nunca';
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return '—';
    const diff = Date.now() - t;
    if (diff < 0) return 'Ahora';
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return 'Hace unos segundos';
    const min = Math.floor(sec / 60);
    if (min < 60) return `Hace ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `Hace ${h} h`;
    const d = Math.floor(h / 24);
    if (d < 30) return `Hace ${d} ${d === 1 ? 'día' : 'días'}`;
    const months = Math.floor(d / 30);
    if (months < 12) return `Hace ${months} ${months === 1 ? 'mes' : 'meses'}`;
    const years = Math.floor(months / 12);
    return `Hace ${years} ${years === 1 ? 'año' : 'años'}`;
  }

  /** Severidad PrimeNG según antigüedad: success <24h, info <7d, warn <30d, danger >30d / nunca. */
  lastLoginSeverity(iso?: string | null): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    if (!iso) return 'danger';
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return 'secondary';
    const days = (Date.now() - t) / (1000 * 60 * 60 * 24);
    if (days < 1) return 'success';
    if (days < 7) return 'info';
    if (days < 30) return 'warn';
    return 'danger';
  }

  /** Date+hora absoluta para el `title=` (tooltip nativo). */
  formatLastLoginAbs(iso?: string | null): string {
    if (!iso) return 'Sin actividad registrada';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('es-MX', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}
