import { Component, OnInit, inject, signal, computed } from '@angular/core';
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
import { environment } from '../../../../environments/environment';
import { AdminCatalogsService } from '../admin-catalogs/admin-catalogs.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';

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
  styleUrls: ['./stores.component.css']
})
export class StoresComponent implements OnInit {
  private adminCatalogsService = inject(AdminCatalogsService);
  private authService = inject(AuthService);
  private perms = inject(PermissionsService);
  private http = inject(HttpClient);
  private messageService = inject(MessageService);
  private confirmationService = inject(ConfirmationService);

  loading = signal(false);
  stores = signal<any[]>([]);
  zones = signal<any[]>([]);
  routes = signal<any[]>([]);
  allRoutes = signal<any[]>([]);
  selectedZone = signal<any | null>(null);
  selectedRoute = signal<any | null>(null);
  searchQuery = signal('');

  editStoreDialog = signal(false);
  editingStore = signal<any | null>(null);
  editZonaId = signal<string | null>(null);
  editRutaId = signal<string | null>(null);

  availableRoutes = computed(() => {
    const zonaId = this.editZonaId();
    if (!zonaId) return [];
    return this.allRoutes().filter(r => r.parent_id === zonaId);
  });

  hasGlobalScope = computed(() =>
    this.perms.can('read', 'reports_global') || this.perms.can('read', 'reports_team')
  );

  userHasZone = computed(() => {
    const zona = this.authService.user()?.zona;
    return !!zona && !this.hasGlobalScope();
  });

  userZoneName = computed(() => this.authService.user()?.zona || '');

  showAllStores = computed(() =>
    !this.selectedZone() && this.hasGlobalScope()
  );

  filteredStores = computed(() => {
    const q = this.searchQuery().toLowerCase().trim();
    if (!q) return this.stores();
    return this.stores().filter(s =>
      (s.nombre || '').toLowerCase().includes(q) ||
      (s.direccion || '').toLowerCase().includes(q)
    );
  });

  private initialized = false;

  ngOnInit(): void {
    this.initialized = false;
    this.loadAllRoutes();
    this.loadZones();
  }

  getRoutesForStore(store: any): any[] {
    return this.allRoutes().filter(r => r.parent_id === store.zona_id);
  }

  private loadAllRoutes() {
    this.http.get<any[]>(`${environment.apiUrl}/catalogs/rutas`).subscribe({
      next: (routes) => {
        this.allRoutes.set(routes.map(r => ({ label: r.value, value: r.id, parent_id: r.parent_id })));
      },
      error: () => {
        this.allRoutes.set([]);
      }
    });
  }

  loadZones() {
    const userZone = this.authService.user()?.zona;
    this.adminCatalogsService.getCatalog('zonas').subscribe(zones => {
      const zoneOptions = zones.map(z => ({ label: z.name || z.value, value: z.id, name: z.name || z.value }));
      this.zones.set(zoneOptions);

      if (userZone && !this.hasGlobalScope()) {
        const match = zoneOptions.find(z =>
          z.name?.toUpperCase() === userZone.toUpperCase() ||
          z.label?.toUpperCase() === userZone.toUpperCase()
        );
        if (match) {
          this.selectedZone.set(match);
          this.selectedRoute.set(null);
          this.loadRoutes(match.value);
          this.loadStores(match.value, undefined);
        } else {
          this.messageService.add({
            severity: 'warn',
            summary: 'Zona No Encontrada',
            detail: `No se encontró la zona "${userZone}" en el catálogo`
          });
        }
      } else if (this.hasGlobalScope()) {
        this.loadAllStores();
      }

      this.initialized = true;
    });
  }

  onZoneChange() {
    if (!this.initialized) return;
    const zone = this.selectedZone();
    if (!zone && this.hasGlobalScope()) {
      this.routes.set([]);
      this.selectedRoute.set(null);
      this.loadAllStores();
      return;
    }
    if (!zone) {
      this.routes.set([]);
      this.selectedRoute.set(null);
      this.stores.set([]);
      return;
    }

    this.selectedRoute.set(null);
    this.loadRoutes(zone.value);
    this.loadStores(zone.value, undefined);
  }

  onRouteChange() {
    const zone = this.selectedZone();
    if (!this.selectedRoute() && this.hasGlobalScope()) {
      this.loadAllStores();
      return;
    }
    if (!zone) return;
    const route = this.selectedRoute();
    this.loadStores(zone.value, route?.value);
  }

  confirmDelete(store: any) {
    this.confirmationService.confirm({
      message: `¿Estás seguro de eliminar la tienda "${store.nombre}"? Esta acción no se puede deshacer.`,
      header: 'Confirmar Eliminación',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, eliminar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.deleteStore(store);
      },
      reject: () => {
        this.messageService.add({
          severity: 'info',
          summary: 'Cancelado',
          detail: 'Eliminación cancelada.',
        });
      }
    });
  }

  private deleteStore(store: any) {
    this.http.delete(`${environment.apiUrl}/stores/${store.id}`).subscribe({
      next: () => {
        this.stores.update(s => s.filter(st => st.id !== store.id));
        this.messageService.add({
          severity: 'success',
          summary: 'Eliminado',
          detail: `Tienda "${store.nombre}" eliminada correctamente.`,
        });
      },
      error: (err) => {
        const errorMsg = err?.error?.message || 'No se pudo eliminar la tienda.';
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: errorMsg,
        });
      }
    });
  }

  openEditDialog(store: any) {
    this.editingStore.set(store);
    this.editZonaId.set(store.zona_id || null);
    this.editRutaId.set(store.ruta_id || null);
    this.editStoreDialog.set(true);
  }

  onEditZoneChange() {
    this.editRutaId.set(null);
  }

  confirmSave() {
    const store = this.editingStore();
    if (!store) return;

    this.confirmationService.confirm({
      message: `¿Guardar los cambios de zona y ruta para "${store.nombre}"?`,
      header: 'Confirmar Cambios',
      icon: 'pi pi-check-circle',
      acceptLabel: 'Sí, guardar',
      rejectLabel: 'Cancelar',
      accept: () => this.saveStore(),
    });
  }

  private saveStore() {
    const store = this.editingStore();
    if (!store) return;

    const newZonaId = this.editZonaId();
    const newRutaId = this.editRutaId();
    const oldZona = store.zona;
    const oldRuta = store.ruta_nombre;

    const zoneMatch = this.zones().find(z => z.value === newZonaId);
    const routeMatch = newRutaId ? this.allRoutes().find(r => r.value === newRutaId) : null;

    store.zona_id = newZonaId;
    store.zona = zoneMatch?.label || null;
    store.ruta_id = newRutaId;
    store.ruta_nombre = routeMatch?.label || null;

    this.http.put(`${environment.apiUrl}/stores/${store.id}`, {
      zona_id: newZonaId,
      ruta_id: newRutaId,
    }).subscribe({
      next: () => {
        this.editStoreDialog.set(false);
        this.messageService.add({
          severity: 'success',
          summary: 'Guardado',
          detail: `Zona y ruta actualizadas para ${store.nombre}`,
        });
      },
      error: () => {
        store.zona = oldZona;
        store.ruta_nombre = oldRuta;
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: `No se pudieron guardar los cambios de ${store.nombre}`,
        });
      }
    });
  }

  private loadAllStores() {
    this.loading.set(true);
    this.http.get<any[]>(`${environment.apiUrl}/stores`).subscribe({
      next: (data) => {
        this.stores.set(data);
        this.loading.set(false);
      },
      error: (err) => {
        console.error('Error loading stores:', err);
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: 'No se pudieron cargar las tiendas'
        });
        this.loading.set(false);
      }
    });
  }

  private loadRoutes(zoneId: string) {
    if (!zoneId) return;
    this.adminCatalogsService.getRoutesByZone(zoneId).subscribe(routes => {
      this.routes.set(routes.map(r => ({ label: r.value, value: r.id })));
    });
  }

  private loadStores(zoneId: string, rutaId?: string) {
    if (!zoneId) return;
    this.loading.set(true);
    let params = new HttpParams().set('zona_id', zoneId);
    if (rutaId) {
      params = params.set('ruta_id', rutaId);
    }
    this.http.get<any[]>(`${environment.apiUrl}/stores`, { params }).subscribe({
      next: (data) => {
        this.stores.set(data);
        this.loading.set(false);
      },
      error: (err) => {
        console.error('Error loading stores:', err);
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: 'No se pudieron cargar las tiendas'
        });
        this.loading.set(false);
      }
    });
  }
}
