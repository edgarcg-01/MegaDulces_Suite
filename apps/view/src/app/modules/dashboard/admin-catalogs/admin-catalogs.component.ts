import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { DialogModule } from 'primeng/dialog';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AdminCatalogsService } from './admin-catalogs.service';
import {
  AppSubject,
  PermissionsService,
} from '../../../core/services/permissions.service';

type CatalogType =
  | 'conceptos'
  | 'ubicaciones'
  | 'niveles'
  | 'zonas'
  | 'roles'
  | 'rutas'
  | 'periodos'
  | 'semanas';

const SCORING_TYPES: CatalogType[] = ['conceptos', 'ubicaciones', 'niveles'];

@Component({
  selector: 'app-admin-catalogs',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TableModule,
    ButtonModule,
    InputTextModule,
    InputNumberModule,
    DialogModule,
    ToastModule,
    ConfirmDialogModule,
    TooltipModule,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './admin-catalogs.component.html',
  styleUrls: ['./admin-catalogs.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminCatalogsComponent implements OnInit {
  private catalogsService = inject(AdminCatalogsService);
  private messageService = inject(MessageService);
  private confirmationService = inject(ConfirmationService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private perms = inject(PermissionsService);
  private destroyRef = inject(DestroyRef);

  // Signals — estado UI
  selectedType = signal<string>('conceptos');
  title = signal<string>('Catálogos');
  items = signal<any[]>([]);
  loading = signal<boolean>(false);
  saving = signal<boolean>(false);
  showInactive = signal<boolean>(false);
  searchQuery = signal<string>('');

  /** Catálogos navegables vía selector inline. El sidebar sigue siendo
   *  válido pero el usuario puede saltar entre tipos sin abandonar la página. */
  private readonly ALL_CATALOG_TYPES: { type: CatalogType; label: string; icon: string; subject: AppSubject }[] = [
    { type: 'conceptos',   label: 'Conceptos',   icon: 'pi pi-box',         subject: 'scoring_config' },
    { type: 'ubicaciones', label: 'Ubicaciones', icon: 'pi pi-map-marker',  subject: 'scoring_config' },
    { type: 'niveles',     label: 'Niveles',     icon: 'pi pi-chart-bar',   subject: 'scoring_config' },
    { type: 'zonas',       label: 'Zonas',       icon: 'pi pi-globe',       subject: 'catalogs' },
    { type: 'roles',       label: 'Roles',       icon: 'pi pi-shield',      subject: 'roles_config' },
  ];

  readonly availableCatalogTypes = computed(() =>
    this.ALL_CATALOG_TYPES.filter(c => this.perms.can('read', c.subject)),
  );

  readonly filteredItems = computed(() => {
    const q = this.searchQuery().trim().toLowerCase();
    if (!q) return this.items();
    const norm = (s: string) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const nq = norm(q);
    return this.items().filter(item => norm(item.value).includes(nq));
  });

  readonly activeCountInfo = computed(() => {
    const total = this.items().length;
    const inactive = this.items().filter(i => i.activo === false).length;
    return { total, inactive, active: total - inactive };
  });

  showAddDialog = signal<boolean>(false);
  showRouteDialog = signal<boolean>(false);
  isEditMode = signal<boolean>(false);
  currentEditingId = signal<string | null>(null);
  currentZoneId = signal<string | null>(null);

  // Zonas expandibles y sus rutas — signals para que OnPush detecte cambios.
  expandedZones = signal<Record<string, boolean>>({});
  zoneRoutes = signal<Record<string, any[]>>({});

  // Form fields (no signals: solo se leen al guardar).
  newItemValue = '';
  newItemOrder = 0;
  newItemScore = 0;
  newItemIcon = '';

  /**
   * Permiso de gestión según el tipo activo. El backend valida igual; este
   * computed solo gobierna la visibilidad de los botones de write.
   */
  readonly canManageCurrent = computed(() => {
    const type = this.selectedType();
    if (type === 'roles') return this.perms.can('manage', 'roles_config');
    if (SCORING_TYPES.includes(type as CatalogType)) {
      return this.perms.can('manage', 'scoring_config');
    }
    return this.perms.can('manage', 'catalogs');
  });

  readonly hasScoring = computed(() =>
    SCORING_TYPES.includes(this.selectedType() as CatalogType),
  );

  /**
   * Tipos con soporte de `activo` (soft-delete + toggle "Mostrar inactivos"
   * + acción "Reactivar"). Tras la migración de audit, también incluye zonas.
   */
  readonly supportsInactive = computed(() => {
    const t = this.selectedType();
    return (
      SCORING_TYPES.includes(t as CatalogType) || t === 'zonas' || t === 'zones'
    );
  });

  readonly hasIcon = computed(() => {
    const t = this.selectedType();
    return t === 'conceptos' || t === 'niveles';
  });

  ngOnInit(): void {
    // Una sola suscripción a params; cubre tanto el primer pintado como
    // navegaciones laterales del sidebar (/admin/catalogs/{type}).
    this.route.params
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((p) => {
        let type = p['type'];
        if (!type && this.router.url.endsWith('/roles')) {
          type = 'roles';
        } else if (!type) {
          type = 'conceptos';
        }

        const subject = this.subjectForType(type);
        if (!this.perms.can('read', subject)) {
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

        this.selectedType.set(type);
        this.updateTitle(type);
        // Reset estado dependiente al cambiar de tipo.
        this.expandedZones.set({});
        this.zoneRoutes.set({});
        this.loadCatalog(type);
      });
  }

  private subjectForType(type: string): AppSubject {
    if (type === 'roles') return 'roles_config';
    if (SCORING_TYPES.includes(type as CatalogType)) return 'scoring_config';
    return 'catalogs';
  }

  private updateTitle(type: string): void {
    const titles: Record<string, string> = {
      conceptos: 'Gestión de Conceptos',
      ubicaciones: 'Ubicaciones en Tienda',
      niveles: 'Niveles de Ejecución',
      zonas: 'Zonas Geográficas',
      roles: 'Roles de Sistema',
    };
    this.title.set(titles[type] || 'Catálogos');
  }

  selectCatalogType(type: CatalogType): void {
    if (type === this.selectedType()) return;
    this.searchQuery.set('');
    this.router.navigate(['/dashboard/admin/catalogs', type]);
  }

  onSearchChange(value: string): void {
    this.searchQuery.set(value);
  }

  clearSearch(): void {
    this.searchQuery.set('');
  }

  private loadCatalog(type: string): void {
    this.loading.set(true);
    this.catalogsService
      .getCatalog(type, undefined, this.showInactive())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data) => {
          this.items.set(data);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: 'No se pudo cargar el catálogo.',
          });
        },
      });
  }

  toggleShowInactive(value: boolean): void {
    this.showInactive.set(value);
    this.loadCatalog(this.selectedType());
  }

  reactivateItem(item: any): void {
    this.catalogsService
      .updateItem(this.selectedType(), item.id, { activo: true })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.messageService.add({
            severity: 'success',
            summary: 'Reactivado',
            detail: `"${item.value}" volvió a estar activo.`,
          });
          this.loadCatalog(this.selectedType());
        },
        error: (err: any) => {
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail:
              err?.error?.message || 'No se pudo reactivar el ítem.',
          });
        },
      });
  }

  // --- Zonas y Rutas ---

  toggleZoneExpansion(zone: any): void {
    const zoneId = zone.id;
    const expanded = { ...this.expandedZones() };
    expanded[zoneId] = !expanded[zoneId];
    this.expandedZones.set(expanded);

    if (expanded[zoneId] && !this.zoneRoutes()[zoneId]) {
      this.loadRoutesForZone(zoneId);
    }
  }

  isZoneExpanded(zoneId: string): boolean {
    return this.expandedZones()[zoneId] || false;
  }

  getRoutesOf(zoneId: string): any[] {
    return this.zoneRoutes()[zoneId] || [];
  }

  private loadRoutesForZone(zoneId: string): void {
    this.catalogsService
      .getRoutesByZone(zoneId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (routes) => {
          this.zoneRoutes.update((current) => ({
            ...current,
            [zoneId]: routes,
          }));
        },
        error: () => {
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: 'No se pudieron cargar las rutas.',
          });
        },
      });
  }

  // --- Diálogos para Rutas ---

  openAddRouteDialog(zone: any): void {
    this.currentZoneId.set(zone.id);
    this.isEditMode.set(false);
    this.currentEditingId.set(null);
    this.newItemValue = '';
    this.newItemOrder = (this.getRoutesOf(zone.id).length || 0) + 1;
    this.newItemScore = 0;
    this.newItemIcon = '';
    this.showRouteDialog.set(true);
  }

  openEditRouteDialog(route: any, zone: any): void {
    this.currentZoneId.set(zone.id);
    this.isEditMode.set(true);
    this.currentEditingId.set(route.id);
    this.newItemValue = route.value;
    this.newItemOrder = route.orden;
    this.newItemScore = route.puntuacion || 0;
    this.newItemIcon = route.icono || '';
    this.showRouteDialog.set(true);
  }

  closeRouteDialog(): void {
    this.showRouteDialog.set(false);
  }

  saveRoute(): void {
    if (this.saving() || !this.newItemValue.trim()) return;
    const zoneId = this.currentZoneId();
    if (!zoneId) {
      this.messageService.add({
        severity: 'error',
        summary: 'Error',
        detail: 'No se ha seleccionado una zona para la ruta.',
      });
      return;
    }

    const data = {
      value: this.newItemValue.trim(),
      orden: this.newItemOrder,
      puntuacion: this.newItemScore,
      icono: this.newItemIcon,
      parent_id: zoneId,
    };

    this.saving.set(true);

    const obs = this.isEditMode()
      ? this.catalogsService.updateItem('rutas', this.currentEditingId()!, data)
      : this.catalogsService.addItem('rutas', data);

    obs.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.saving.set(false);
        this.messageService.add({
          severity: 'success',
          summary: 'Éxito',
          detail: this.isEditMode()
            ? 'Ruta actualizada correctamente.'
            : 'Ruta agregada correctamente.',
        });
        this.loadRoutesForZone(zoneId);
        this.showRouteDialog.set(false);
      },
      error: (err: any) => {
        this.saving.set(false);
        const detail =
          err?.error?.message ||
          'No se pudo guardar la ruta. Inténtalo nuevamente.';
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail,
        });
      },
    });
  }

  deleteRoute(routeId: string, zoneId: string): void {
    this.confirmationService.confirm({
      message:
        '¿Estás seguro de eliminar esta ruta? Esta acción no se puede deshacer.',
      header: 'Confirmar Eliminación',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, eliminar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => this.executeDeleteRoute(routeId, zoneId),
    });
  }

  private executeDeleteRoute(routeId: string, zoneId: string): void {
    this.catalogsService
      .deleteItem('rutas', routeId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.messageService.add({
            severity: 'success',
            summary: 'Éxito',
            detail: 'Ruta eliminada correctamente.',
          });
          this.loadRoutesForZone(zoneId);
        },
        error: (err: any) => {
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: err?.error?.message || 'No se pudo eliminar la ruta.',
          });
        },
      });
  }

  // --- Diálogos para Ítem genérico ---

  openAddDialog(): void {
    this.isEditMode.set(false);
    this.currentEditingId.set(null);
    this.newItemValue = '';
    this.newItemOrder = this.items().length + 1;
    this.newItemScore = 0;
    this.newItemIcon = '';
    this.showAddDialog.set(true);
  }

  openEditDialog(item: any): void {
    this.isEditMode.set(true);
    this.currentEditingId.set(item.id);
    this.newItemValue = item.value;
    this.newItemOrder = item.orden;
    this.newItemScore = item.puntuacion || 0;
    this.newItemIcon = item.icono || '';
    this.showAddDialog.set(true);
  }

  closeAddDialog(): void {
    this.showAddDialog.set(false);
  }

  saveItem(): void {
    if (this.saving() || !this.newItemValue.trim()) return;

    const data: {
      value: string;
      orden: number;
      puntuacion?: number;
      icono?: string;
    } = {
      value: this.newItemValue.trim(),
      orden: this.newItemOrder,
    };
    if (this.hasScoring()) data.puntuacion = this.newItemScore;
    if (this.hasIcon()) data.icono = this.newItemIcon;

    this.saving.set(true);

    const obs = this.isEditMode()
      ? this.catalogsService.updateItem(
          this.selectedType(),
          this.currentEditingId()!,
          data,
        )
      : this.catalogsService.addItem(this.selectedType(), data);

    obs.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.saving.set(false);
        this.messageService.add({
          severity: 'success',
          summary: 'Éxito',
          detail: this.isEditMode()
            ? 'Ítem actualizado correctamente.'
            : 'Ítem agregado correctamente.',
        });
        this.loadCatalog(this.selectedType());
        this.showAddDialog.set(false);
      },
      error: (err: any) => {
        this.saving.set(false);
        const detail =
          err?.error?.message ||
          (this.isEditMode()
            ? 'No se pudo actualizar el ítem.'
            : 'No se pudo agregar el ítem.');
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail,
        });
      },
    });
  }

  deleteItem(id: string, itemName?: string): void {
    const typeLabel = this.getTypeLabel(this.selectedType());
    this.confirmationService.confirm({
      message: `¿Estás seguro de eliminar ${typeLabel} "${
        itemName || 'seleccionado'
      }"? Esta acción no se puede deshacer.`,
      header: 'Confirmar Eliminación',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, eliminar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => this.executeDelete(id),
    });
  }

  private getTypeLabel(type: string): string {
    const labels: Record<string, string> = {
      roles: 'el rol',
      zonas: 'la zona',
      rutas: 'la ruta',
      conceptos: 'el concepto',
      ubicaciones: 'la ubicación',
      niveles: 'el nivel',
      periodos: 'el periodo',
      semanas: 'la semana',
    };
    return labels[type] || 'el elemento';
  }

  private executeDelete(id: string): void {
    this.catalogsService
      .deleteItem(this.selectedType(), id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response: any) => {
          const typeLabel = this.getTypeLabel(this.selectedType());
          const formatted =
            typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1);

          // Limpiar estado expandido/cache de rutas si era una zona
          // borrada (evita zombie state).
          if (this.selectedType() === 'zonas') {
            this.expandedZones.update((current) => {
              const next = { ...current };
              delete next[id];
              return next;
            });
            this.zoneRoutes.update((current) => {
              const next = { ...current };
              delete next[id];
              return next;
            });
          }

          if (response?.soft_deleted) {
            // Marcado como inactivo: refrescar listado para reflejar el estado.
            this.loadCatalog(this.selectedType());
            this.messageService.add({
              severity: 'info',
              summary: 'Marcado como inactivo',
              detail:
                response.message ||
                `${formatted} está referenciado por capturas históricas; se mantiene en el sistema pero ya no estará disponible para nuevas capturas.`,
              life: 6000,
            });
          } else {
            this.items.update((items) => items.filter((i) => i.id !== id));
            this.messageService.add({
              severity: 'success',
              summary: 'Eliminado',
              detail: `${formatted} eliminado correctamente.`,
            });
          }
        },
        error: (err: any) => {
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: err?.error?.message || 'No se pudo eliminar el elemento.',
          });
        },
      });
  }

  goToPermissions(roleName: string): void {
    this.router.navigate(['/admin/roles', roleName, 'permissions']);
  }
}
