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
  DepartmentOption,
  PositionOption,
} from './users.service';
import { AdminCatalogsService } from '../admin-catalogs/admin-catalogs.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { STORE_BRANCHES } from '../../../core/constants/store-branches';
import { AreaMeta } from '../../../core/constants/role-presets';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';

/**
 * Icono por departamento. El catálogo `identity.departments` guarda code/name/
 * orden pero no icono: la presentación vive en el frontend, la taxonomía en DB.
 */
const DEPT_ICON: Record<string, string> = {
  direccion_zona: 'pi pi-sitemap',
  tienda: 'pi pi-shop',
  cajas: 'pi pi-calculator',
  ruta_directa: 'pi pi-truck',
  ruta_vecinal: 'pi pi-directions',
  telemarketing: 'pi pi-headphones',
  mayoreo: 'pi pi-shopping-bag',
  almacen: 'pi pi-box',
  logistica: 'pi pi-send',
  operaciones: 'pi pi-cog',
  administracion: 'pi pi-briefcase',
  sistemas: 'pi pi-desktop',
  externo: 'pi pi-globe',
};
const SIN_DEPT = '__sin__';
/**
 * Los clientes del portal B2B viven en el departamento `externo` y NO tienen
 * puesto del organigrama: no son empleados. Excluirlos del conteo de pendientes
 * evita un "2 sin puesto" que nunca se puede bajar a cero.
 */
const DEPT_SIN_PUESTO = 'externo';

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
  /** Cuentas sin puesto asignado: lo que queda por capturar del organigrama. */
  sinPuesto: number;
}

interface RoleOption {
  label: string;
  value: string;
  /** `[ID.14]` perfil = puesto tipo · complemento = tarea que se suma. */
  kind?: 'perfil' | 'complemento';
  /** Permisos otorgados: hace legible la diferencia entre un perfil y una tarea. */
  permisos?: number;
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
        (user.zona ?? '').toLowerCase().includes(query) ||
        (user.position_name ?? '').toLowerCase().includes(query) ||
        (user.department_name ?? '').toLowerCase().includes(query)
      );
    });
  });

  // ── Master-detail por departamento ─────────────────────────────────────────
  // El departamento ES un campo (`users.department_code`, Fase UN). Antes se
  // derivaba del role_name con `roleAreaSlug`, y salía mal: los 19 colaboradores
  // caían en "Mercadotecnia" cuando son de ruta, y `cajera` no estaba mapeada
  // así que las 28 cajeras caían en "Otros / heredados". '' = todos.
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
    // El catálogo manda el orden y la etiqueta; se agrega al final un cajón
    // "Sin departamento" para las cuentas todavía sin asignar.
    const areas: AreaMeta[] = [
      ...this.departmentOptions().map((d) => ({
        slug: d.code,
        label: d.name,
        icon: DEPT_ICON[d.code] ?? 'pi pi-users',
      })),
      { slug: SIN_DEPT, label: 'Sin departamento', icon: 'pi pi-question-circle' },
    ];
    return areas.map((area) => {
      const list = all.filter((u) => (u.department_code || SIN_DEPT) === area.slug);
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
        sinPuesto:
          area.slug === DEPT_SIN_PUESTO
            ? 0
            : list.filter((u) => !u.position_code).length,
      };
    }).filter((d) => d.total > 0);
  });

  /** Total de cuentas con alerta de acceso, para el resumen del encabezado. */
  readonly alertTotal = computed(() =>
    this.departments().reduce((a, d) => a + d.nunca + d.dormidos, 0));

  /** Filtro "sólo con alerta de acceso": el contador del resumen es accionable. */
  readonly onlyAlerts = signal(false);
  toggleAlerts(): void { this.onlyAlerts.update((v) => !v); }

  /**
   * Total de cuentas sin puesto asignado. Es la lista de pendientes del
   * organigrama: mientras no sea 0, hay gente cuyo puesto no está capturado.
   */
  readonly sinPuestoTotal = computed(() =>
    this.users().filter((u) => this.needsPosition(u)).length);

  /** ¿A esta cuenta le falta capturar el puesto del organigrama? */
  needsPosition(u: User): boolean {
    return !u.position_code && u.department_code !== DEPT_SIN_PUESTO;
  }

  /** Filtro "sólo sin puesto": el contador de pendientes es accionable. */
  readonly onlyNoPosition = signal(false);
  toggleNoPosition(): void { this.onlyNoPosition.update((v) => !v); }

  /**
   * Salida del vacío: limpia TODOS los filtros. Con dos toggles + buscador +
   * departamento, un botón que solo limpiara uno dejaba la tabla vacía y sin
   * explicación de por qué.
   */
  clearFilters(): void {
    this.onSearchChange('');
    this.onlyAlerts.set(false);
    this.onlyNoPosition.set(false);
    this.selectDept('');
  }

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
    if (slug) list = list.filter((u) => (u.department_code || SIN_DEPT) === slug);
    if (this.onlyAlerts()) list = list.filter((u) => this.hasAccessAlert(u));
    if (this.onlyNoPosition()) list = list.filter((u) => this.needsPosition(u));
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
    if (d.sinPuesto) bits.push(`${d.sinPuesto} sin puesto`);
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
  // Ejes organizacionales (Fase UN). `departmentOptions` alimenta además el
  // aside de departamentos, así que se carga aunque el diálogo esté cerrado.
  departmentOptions = signal<DepartmentOption[]>([]);
  positionOptions = signal<PositionOption[]>([]);
  // GX.8 — áreas de gasto visibles asignables al usuario (dimensión canónica).
  financeAreas = signal<FinanceAreaOption[]>([]);
  // Opciones de sucursal para el monitor Tienda (null = ve todas / rol global).
  readonly branchOptions = STORE_BRANCHES.map((b) => ({ label: `${b.code} · ${b.name}`, value: b.code }));

  // Roles que el usuario actual puede asignar (oculta superadmin si no lo es).
  // `[ID.14]` Los COMPLEMENTOS quedan fuera de esta lista: son tareas, no
  // puestos. Ofrecer `captura_gastos` (1 permiso) junto a `encargado_tienda`
  // (63) es lo que llevó a que 22 personas tengan una tarea como perfil base.
  readonly assignableRoles = computed(() => {
    const isSuperadmin = this.authService.user()?.role_name === 'superadmin';
    return this.roles().filter(
      (r) =>
        r.kind !== 'complemento' &&
        (isSuperadmin || r.value.toLowerCase() !== 'superadmin'),
    );
  });

  // ── `[ID.13]` Complementos ────────────────────────────────────────────────
  /** Catálogo de complementos disponibles (tareas que se suman al perfil base). */
  readonly complementoOptions = computed(() =>
    this.roles()
      .filter((r) => r.kind === 'complemento')
      .map((r) => ({
        label: `${r.label} · ${r.permisos ?? 0} permiso${r.permisos === 1 ? '' : 's'}`,
        value: r.value,
      })),
  );
  /** Complementos elegidos en el formulario. */
  readonly complementos = signal<string[]>([]);
  /** Los que tenía al abrir: sirve para no llamar al API si no cambió nada. */
  private readonly complementosPrevios = signal<string[]>([]);
  /**
   * Rol elegido en el form, como signal. No se lee `userForm.get(...).value`
   * dentro de un computed: el valor del form no es reactivo y además un field
   * initializer que toque `this.userForm` explota (TS2729) porque el form se
   * arma en el constructor. Se alimenta desde `valueChanges`.
   */
  private readonly rolePick = signal<string | null>(null);
  /**
   * `[ID.14]` Aviso cuando el perfil base elegido es en realidad una TAREA.
   * Es el caso de los 22 de `captura_gastos`: la pantalla tiene que MOSTRARLO,
   * no esconderlo — si no, el dato se queda viejo para siempre.
   */
  readonly perfilBaseEsTarea = computed(() => {
    const rol = (this.rolePick() ?? '').toLowerCase();
    if (!rol) return false;
    return this.roles().some((r) => r.value.toLowerCase() === rol && r.kind === 'complemento');
  });
  /** `[ID.15]` El puesto elegido no propone perfil: hay que elegirlo a mano. */
  readonly puestoSinPerfil = computed(() => {
    const code = this.positionPick();
    if (!code) return false;
    const p = this.positionOptions().find((x) => x.code === code);
    return !!p && !p.default_role;
  });

  constructor() {
    this.userForm = this.fb.group({
      username: ['', Validators.required],
      password: [''],
      nombre: [''],
      // `[ID.7]` Un solo control de zona. Antes había `zona` (nombre) + `zona_id`
      // (uuid) y una suscripción traduciendo uno en el otro: dos entradas para
      // el mismo hecho = dos formas de quedar en desacuerdo.
      zone_id: [null as string | null],
      role_name: ['', Validators.required],
      supervisor_id: [null],
      warehouse_code: [null],
      department_code: [null],
      position_code: [null],
      finance_expense_area_ids: [[] as string[]],
      activo: [true],
    });

    // Toast en error de la carga del padrón (equivale al catch del subscribe viejo).
    effect(() => { if (this.usersRes.error()) this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el padrón.' }); });

    this.userForm
      .get('role_name')
      ?.valueChanges.pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((role) => {
        this.rolePick.set(role ?? null);
        const supervisorControl = this.userForm.get('supervisor_id');
        // El supervisor se RECOMIENDA para roles supervisados pero NO bloquea el
        // guardado: requerirlo dejaba el form inválido y saveUser() abortaba en
        // silencio cuando el supervisor aún no estaba asignado (o el dropdown venía vacío).
        if (!this.isSupervisedRole(role)) {
          supervisorControl?.setValue(null);
        }
        supervisorControl?.updateValueAndValidity();
      });

    this.userForm
      .get('position_code')
      ?.valueChanges.pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((code: string | null) => {
        this.positionPick.set(code ?? null);
        // `[ID.15]` El puesto PROPONE departamento y perfil base. Sólo rellena
        // lo que está vacío: si el que da de alta ya eligió algo, la propuesta
        // no le pisa la decisión. Es lo que convierte el alta en "persona +
        // puesto + sucursal" en vez de "adivina entre 25 roles".
        if (!code) return;
        const pos = this.positionOptions().find((p) => p.code === code);
        if (!pos) return;
        if (pos.department_code && !this.userForm.get('department_code')?.value) {
          this.userForm.get('department_code')?.setValue(pos.department_code);
        }
        if (pos.default_role && !this.userForm.get('role_name')?.value) {
          this.userForm.get('role_name')?.setValue(pos.default_role);
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

  /**
   * Etiqueta del puesto en el dropdown. Suma las variantes literales del
   * ORGANIGRAMA 2026 (`org_labels`) porque al capturar se lee el PDF impreso,
   * donde el mismo puesto aparece como "ENC. DE SUCURSAL", "ENCARGADO DE
   * SUCURSAL" o "ENCARGADO PADRE HIDALGO".
   */
  readonly positionChoices = computed(() =>
    this.positionOptions().map((p) => {
      const labels = (p.org_labels ?? []).filter(
        (l) => l.toUpperCase() !== p.name.toUpperCase(),
      );
      return {
        code: p.code,
        // `name` es lo que se ve (corto y en español).
        name: p.name,
        // `orgText` NO se muestra en el valor cerrado: existe para que
        // `filterBy` lo alcance y se pueda teclear como dice el PDF.
        orgText: labels.join(' / '),
      };
    }));

  /**
   * Variantes del organigrama del puesto ELEGIDO. Confirma que se escogió el
   * correcto sin meter un template dentro del p-select (el valor cerrado tiene
   * que quedar corto). Se alimenta desde el constructor: un field initializer
   * con `this.userForm` explota porque el form se arma ahí (TS2729).
   */
  private readonly positionPick = signal<string | null>(null);
  readonly selectedPositionOrg = computed(() => {
    const code = this.positionPick();
    if (!code) return '';
    return this.positionChoices().find((p) => p.code === code)?.orgText ?? '';
  });

  loadOrgCatalogs(): void {
    this.usersService
      .getDepartments()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data) => this.departmentOptions.set(data),
        error: () => this.departmentOptions.set([]),
      });
    this.usersService
      .getPositions()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data) => this.positionOptions.set(data),
        error: () => this.positionOptions.set([]),
      });
  }

  loadRoles(): void {
    this.catalogsService
      .getCatalog('roles')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data: { value: string; kind?: 'perfil' | 'complemento'; permissions?: Record<string, boolean> }[]) => {
          this.roles.set(
            data.map((item) => ({
              label: item.value.charAt(0).toUpperCase() + item.value.slice(1),
              value: item.value,
              kind: item.kind ?? 'perfil',
              permisos: Object.values(item.permissions ?? {}).filter((v) => v === true).length,
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
    this.loadOrgCatalogs();
  }

  loadUsers(): void {
    this.usersTick.update((t) => t + 1);
  }

  openNewDialog(): void {
    this.isEditing.set(false);
    this.currentUserId.set(null);
    // `[ID.13]` Un alta nace sin complementos.
    this.complementos.set([]);
    this.complementosPrevios.set([]);
    this.userForm.reset({
      activo: true,
      role_name: '',
      department_code: this.selectedDept() && this.selectedDept() !== SIN_DEPT ? this.selectedDept() : null,
      position_code: null,
      finance_expense_area_ids: [],
    });
    this.userForm.get('username')?.enable();
    this.userForm
      .get('password')
      ?.setValidators([Validators.required, Validators.minLength(6)]);
    this.userForm.get('password')?.updateValueAndValidity();
    // Un usuario nuevo tiene que nacer en un departamento existente: si no, cae
    // en el cajón "Sin departamento" y el padrón se desordena solo.
    this.userForm.get('department_code')?.setValidators([Validators.required]);
    this.userForm.get('department_code')?.updateValueAndValidity();
    this.positionPick.set(this.userForm.get('position_code')?.value ?? null);
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
    // En edición NO se exige: obligarlo bloquearía guardar cualquier cambio en
    // las cuentas heredadas que todavía no tienen departamento.
    this.userForm.get('department_code')?.clearValidators();
    this.userForm.get('department_code')?.updateValueAndValidity();

    this.userForm.patchValue({
      username: user.username,
      password: '',
      nombre: user.nombre,
      zone_id: user.zona_id ?? null,
      role_name: user.role_name,
      supervisor_id: user.supervisor_id,
      warehouse_code: user.warehouse_code ?? null,
      department_code: user.department_code ?? null,
      position_code: user.position_code ?? null,
      finance_expense_area_ids: user.finance_expense_area_ids ?? [],
      activo: user.activo,
    });

    // `[ID.13]` Complementos del usuario. Se cargan aparte del form porque no
    // son un campo de `users` sino filas de `identity.user_roles`.
    this.complementos.set([]);
    this.complementosPrevios.set([]);
    this.usersService
      .getUserRoles(user.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const extras = res.roles.filter((r) => !r.is_primary).map((r) => r.role_name);
          this.complementos.set(extras);
          this.complementosPrevios.set(extras);
        },
        error: () => {
          // Sin la migración `[ID.13]` aplicada el endpoint no existe: el resto
          // del diálogo tiene que seguir funcionando igual.
          this.complementos.set([]);
          this.complementosPrevios.set([]);
        },
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

  /**
   * Motivo legible del error del API. `ValidationPipe` de NestJS devuelve
   * `message` como ARRAY cuando el DTO no valida; mostrarlo tal cual concatena
   * todos los mensajes del campo y tapa el que importa.
   */
  private apiError(err: unknown, fallback: string): string {
    const msg = (err as { error?: { message?: string | string[] } })?.error?.message;
    if (Array.isArray(msg)) return msg[0] || fallback;
    return msg || fallback;
  }

  /**
   * `[ID.13]` Guarda los complementos si cambiaron.
   *
   * Va DESPUÉS del update del usuario y no dentro: son dos escrituras distintas
   * (`users` y `identity.user_roles`) y el complemento no debe hacer fallar el
   * guardado del usuario. Si no cambió nada no se llama al API.
   */
  private persistComplementos(userId: string): void {
    const ahora = [...this.complementos()].sort();
    const antes = [...this.complementosPrevios()].sort();
    if (ahora.join('|') === antes.join('|')) return;

    this.usersService
      .setUserRoles(userId, ahora)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.complementosPrevios.set(ahora);
          const partes = [
            res.agregados.length ? `+${res.agregados.join(', ')}` : '',
            res.quitados.length ? `−${res.quitados.join(', ')}` : '',
          ].filter(Boolean);
          if (partes.length) {
            this.messageService.add({
              severity: 'success',
              summary: 'Complementos actualizados',
              detail: partes.join(' · '),
            });
          }
        },
        error: (err) => {
          this.messageService.add({
            severity: 'error',
            summary: 'Complementos',
            detail: this.apiError(err, 'No se pudieron guardar los complementos.'),
          });
        },
      });
  }

  saveUser(): void {
    if (this.saving()) return;
    // Nunca fallar en silencio: si el form es inválido, marcar y avisar el motivo.
    if (this.userForm.invalid) {
      this.userForm.markAllAsTouched();
      this.messageService.add({
        severity: 'warn',
        summary: 'Revisa el formulario',
        detail: this.isEditing()
          ? 'Faltan campos obligatorios (usuario y rol son requeridos).'
          : 'Faltan campos obligatorios (usuario, rol y departamento son requeridos).',
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
            this.persistComplementos(this.currentUserId()!);
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
              detail: this.apiError(err, 'Error al actualizar usuario.'),
            });
          },
        });
    } else {
      const createData: UserCreatePayload = { ...formData };
      this.usersService
        .create(createData)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (creado) => {
            this.saving.set(false);
            this.displayDialog.set(false);
            // `[ID.13]` Los complementos elegidos en el alta se aplican sobre el
            // usuario recién creado (necesitan su id, que llega en la respuesta).
            if (creado?.id) this.persistComplementos(creado.id);
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
              detail: this.apiError(err, 'Error al crear usuario.'),
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
            detail: this.apiError(err, 'No se pudo eliminar el usuario.'),
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
