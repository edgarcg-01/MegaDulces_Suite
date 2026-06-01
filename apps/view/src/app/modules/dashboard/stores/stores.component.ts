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
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { InputTextModule } from 'primeng/inputtext';
import { TooltipModule } from 'primeng/tooltip';
import { DialogModule } from 'primeng/dialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import { HttpClient, HttpParams } from '@angular/common/http';
import {
  takeUntilDestroyed,
  toObservable,
  toSignal,
} from '@angular/core/rxjs-interop';
import { debounceTime, distinctUntilChanged } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { AdminCatalogsService } from '../admin-catalogs/admin-catalogs.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';

interface ZoneOption {
  label: string;
  value: string;
  name: string;
}

interface RouteOption {
  label: string;
  value: string;
  parent_id?: string;
}

interface Store {
  id: string;
  nombre: string;
  direccion?: string | null;
  latitud?: number | null;
  longitud?: number | null;
  activo: boolean;
  zona_id?: string | null;
  zona?: string | null;
  ruta_id?: string | null;
  ruta_nombre?: string | null;
  created_at?: string;
}

interface ZoneRow {
  id: string;
  value?: string;
  name?: string;
}

interface RouteRow {
  id: string;
  value: string;
  parent_id?: string;
}

@Component({
  selector: 'app-stores',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TableModule,
    ButtonModule,
    SelectModule,
    TagModule,
    ToastModule,
    ConfirmDialogModule,
    InputTextModule,
    TooltipModule,
    DialogModule,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './stores.component.html',
  styleUrls: ['./stores.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StoresComponent implements OnInit {
  private adminCatalogsService = inject(AdminCatalogsService);
  private authService = inject(AuthService);
  private perms = inject(PermissionsService);
  private http = inject(HttpClient);
  private messageService = inject(MessageService);
  private confirmationService = inject(ConfirmationService);
  private destroyRef = inject(DestroyRef);

  loading = signal(false);
  deletingId = signal<string | null>(null);
  promotingId = signal<string | null>(null);
  saving = signal(false);
  stores = signal<Store[]>([]);
  zones = signal<ZoneOption[]>([]);
  routes = signal<RouteOption[]>([]);
  allRoutes = signal<RouteOption[]>([]);
  selectedZoneId = signal<string | null>(null);
  selectedRouteId = signal<string | null>(null);
  searchQuery = signal<string>('');

  editDialogVisible = signal(false);
  editingStore = signal<Store | null>(null);
  editZonaId = signal<string | null>(null);
  editRutaId = signal<string | null>(null);

  private debouncedSearch = toSignal(
    toObservable(this.searchQuery).pipe(
      debounceTime(250),
      distinctUntilChanged(),
    ),
    { initialValue: '' },
  );

  readonly availableEditRoutes = computed(() => {
    const zonaId = this.editZonaId();
    if (!zonaId) return [];
    return this.allRoutes().filter((r) => r.parent_id === zonaId);
  });

  /**
   * J.6.2 — botón "Promover a cliente B2B" visible solo si user tiene
   * COMMERCIAL_CUSTOMERS_GESTIONAR (puede crear customers).
   */
  readonly canPromoteToCustomer = computed(() => {
    const perms = this.authService.user()?.permissions || {};
    return perms[Permission.COMMERCIAL_CUSTOMERS_GESTIONAR] === true;
  });

  readonly canSeeAllZones = computed(
    () =>
      this.perms.can('read', 'reports_global') ||
      this.perms.can('read', 'reports_team'),
  );

  readonly userHasFixedZone = computed(() => {
    const zona = this.authService.user()?.zona;
    return !!zona && !this.canSeeAllZones();
  });

  readonly showAllStoresTag = computed(
    () => !this.selectedZoneId() && this.canSeeAllZones(),
  );

  readonly filteredStores = computed(() => {
    const q = this.debouncedSearch().toLowerCase().trim();
    const list = this.stores();
    if (!q) return list;
    return list.filter(
      (s) =>
        (s.nombre || '').toLowerCase().includes(q) ||
        (s.direccion || '').toLowerCase().includes(q) ||
        (s.zona || '').toLowerCase().includes(q) ||
        (s.ruta_nombre || '').toLowerCase().includes(q),
    );
  });

  private initialized = false;

  ngOnInit(): void {
    this.initialized = false;
    this.loadAllRoutes();
    this.loadZones();
  }

  getRoutesForStore(store: Store): RouteOption[] {
    return this.allRoutes().filter((r) => r.parent_id === store.zona_id);
  }

  private loadAllRoutes(): void {
    this.http
      .get<RouteRow[]>(`${environment.apiUrl}/catalogs/rutas`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (routes) => {
          this.allRoutes.set(
            routes.map((r) => ({
              label: r.value,
              value: r.id,
              parent_id: r.parent_id,
            })),
          );
        },
        error: () => this.allRoutes.set([]),
      });
  }

  private loadZones(): void {
    const userZone = this.authService.user()?.zona;
    this.adminCatalogsService
      .getCatalog('zonas')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (zones: ZoneRow[]) => {
          const zoneOptions: ZoneOption[] = zones.map((z) => ({
            label: z.name || z.value || '',
            value: z.id,
            name: z.name || z.value || '',
          }));
          this.zones.set(zoneOptions);

          if (userZone && !this.canSeeAllZones()) {
            const match = zoneOptions.find(
              (z) =>
                z.name?.toUpperCase() === userZone.toUpperCase() ||
                z.label?.toUpperCase() === userZone.toUpperCase(),
            );
            if (match) {
              this.selectedZoneId.set(match.value);
              this.selectedRouteId.set(null);
              this.loadRoutes(match.value);
              this.loadStores(match.value);
            } else {
              this.messageService.add({
                severity: 'warn',
                summary: 'Zona no encontrada',
                detail: `No se encontró la zona "${userZone}" en el catálogo.`,
              });
            }
          } else if (this.canSeeAllZones()) {
            this.loadAllStores();
          }

          this.initialized = true;
        },
        error: () => {
          this.initialized = true;
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: 'No se pudieron cargar las zonas.',
          });
        },
      });
  }

  onZoneChange(zoneId: string | null): void {
    this.selectedZoneId.set(zoneId);
    if (!this.initialized) return;

    if (!zoneId && this.canSeeAllZones()) {
      this.routes.set([]);
      this.selectedRouteId.set(null);
      this.loadAllStores();
      return;
    }
    if (!zoneId) {
      this.routes.set([]);
      this.selectedRouteId.set(null);
      this.stores.set([]);
      return;
    }

    this.selectedRouteId.set(null);
    this.loadRoutes(zoneId);
    this.loadStores(zoneId);
  }

  onRouteChange(routeId: string | null): void {
    this.selectedRouteId.set(routeId);
    const zoneId = this.selectedZoneId();

    if (!zoneId) {
      if (this.canSeeAllZones()) this.loadAllStores();
      return;
    }

    this.loadStores(zoneId, routeId ?? undefined);
  }

  onSearchChange(value: string): void {
    this.searchQuery.set(value);
  }

  confirmDelete(store: Store): void {
    if (this.deletingId() === store.id) return;
    this.confirmationService.confirm({
      message: `¿Estás seguro de eliminar la tienda "${store.nombre}"? Se ocultará del listado pero se mantendrá el historial de visitas.`,
      header: 'Confirmar Eliminación',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, eliminar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => this.deleteStore(store),
    });
  }

  private deleteStore(store: Store): void {
    this.deletingId.set(store.id);
    this.http
      .delete(`${environment.apiUrl}/stores/${store.id}`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.stores.update((s) => s.filter((st) => st.id !== store.id));
          this.deletingId.set(null);
          this.messageService.add({
            severity: 'success',
            summary: 'Eliminado',
            detail: `Tienda "${store.nombre}" eliminada correctamente.`,
          });
        },
        error: (err) => {
          this.deletingId.set(null);
          const detail =
            err?.error?.message || 'No se pudo eliminar la tienda.';
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail,
          });
        },
      });
  }

  /**
   * J.6.2 — Promueve la tienda a cliente comercial (commercial.customers).
   * Llama al endpoint idempotente POST /commercial/customers/from-store.
   * Si el customer ya existía, lo informa amigablemente.
   */
  promoteToCustomer(store: Store): void {
    if (this.promotingId() === store.id) return;
    this.confirmationService.confirm({
      message: `¿Habilitar la tienda "${store.nombre}" como cliente B2B? Podrá recibir pedidos del Portal y aparecer en /comercial/customers.`,
      header: 'Promover a cliente comercial',
      icon: 'pi pi-shopping-cart',
      acceptLabel: 'Sí, habilitar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-success',
      accept: () => {
        this.promotingId.set(store.id);
        this.http
          .post<{ customer: any; created: boolean; message: string }>(
            `${environment.apiUrl}/commercial/customers/from-store`,
            { store_id: store.id },
          )
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            next: (res) => {
              this.promotingId.set(null);
              this.messageService.add({
                severity: res.created ? 'success' : 'info',
                summary: res.created ? 'Cliente B2B creado' : 'Ya era cliente B2B',
                detail: `${res.customer.code} — ${res.customer.name}`,
                life: 5000,
              });
            },
            error: (err) => {
              this.promotingId.set(null);
              const detail =
                err?.error?.message ||
                'No se pudo promover. Verificá que exista una lista de precios default en /comercial/pricing.';
              this.messageService.add({
                severity: 'error',
                summary: 'Error al promover',
                detail,
                life: 8000,
              });
            },
          });
      },
    });
  }

  openEditDialog(store: Store): void {
    this.editingStore.set(store);
    this.editZonaId.set(store.zona_id || null);
    this.editRutaId.set(store.ruta_id || null);
    this.editDialogVisible.set(true);
  }

  closeEditDialog(): void {
    this.editDialogVisible.set(false);
  }

  onEditZoneChange(zonaId: string | null): void {
    this.editZonaId.set(zonaId);
    this.editRutaId.set(null);
  }

  saveStore(): void {
    const store = this.editingStore();
    if (!store) return;

    const newZonaId = this.editZonaId();
    const newRutaId = this.editRutaId();

    // No-op detection: si nada cambió, cerrar el dialog sin tocar el backend.
    if (
      (store.zona_id ?? null) === newZonaId &&
      (store.ruta_id ?? null) === newRutaId
    ) {
      this.editDialogVisible.set(false);
      return;
    }

    this.saving.set(true);
    this.http
      .put<Store>(`${environment.apiUrl}/stores/${store.id}`, {
        zona_id: newZonaId,
        ruta_id: newRutaId,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (updated) => {
          // Usar la respuesta del backend como fuente de verdad — incluye
          // zona resuelta y ruta_nombre actualizados.
          this.stores.update((list) =>
            list.map((s) => (s.id === store.id ? { ...s, ...updated } : s)),
          );
          this.saving.set(false);
          this.editDialogVisible.set(false);
          this.messageService.add({
            severity: 'success',
            summary: 'Guardado',
            detail: `Zona y ruta actualizadas para ${store.nombre}.`,
          });
        },
        error: (err) => {
          this.saving.set(false);
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail:
              err?.error?.message ??
              `No se pudieron guardar los cambios de ${store.nombre}.`,
          });
        },
      });
  }

  private loadAllStores(): void {
    this.loading.set(true);
    this.http
      .get<Store[]>(`${environment.apiUrl}/stores`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data) => {
          this.stores.set(data);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: 'No se pudieron cargar las tiendas.',
          });
        },
      });
  }

  private loadRoutes(zoneId: string): void {
    if (!zoneId) return;
    this.adminCatalogsService
      .getRoutesByZone(zoneId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (routes: RouteRow[]) => {
          this.routes.set(
            routes.map((r) => ({ label: r.value, value: r.id })),
          );
        },
        error: () => this.routes.set([]),
      });
  }

  private loadStores(zoneId: string, rutaId?: string): void {
    if (!zoneId) return;
    this.loading.set(true);
    // Query params en inglés (canonical post 2026-06-01). Backend acepta
    // `zona_id`/`ruta_id` como alias por compat, pero código nuevo usa EN.
    let params = new HttpParams().set('zone_id', zoneId);
    if (rutaId) params = params.set('route_id', rutaId);

    this.http
      .get<Store[]>(`${environment.apiUrl}/stores`, { params })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data) => {
          this.stores.set(data);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: 'No se pudieron cargar las tiendas.',
          });
        },
      });
  }
}
