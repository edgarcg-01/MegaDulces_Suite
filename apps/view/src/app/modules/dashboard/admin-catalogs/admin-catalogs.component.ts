import { Component, inject, signal, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import { AdminCatalogsService } from './admin-catalogs.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService, AppSubject } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { environment } from '../../../../environments/environment';

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
    SelectModule,
    DialogModule,
    ToastModule,
    ConfirmDialogModule,
    TooltipModule,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './admin-catalogs.component.html',
  styleUrls: ['./admin-catalogs.component.css'],
})
export class AdminCatalogsComponent implements OnInit {
  private catalogsService = inject(AdminCatalogsService);
  private messageService = inject(MessageService);
  private confirmationService = inject(ConfirmationService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private authService = inject(AuthService);
  private perms = inject(PermissionsService);
  private http = inject(HttpClient);

  selectedType = signal<string>('conceptos');
  title = signal<string>('Catálogos');
  items = signal<any[]>([]);
  loading = signal<boolean>(false);

  showAddDialog = false;
  showRouteDialog = false;
  isEditMode = signal<boolean>(false);
  currentEditingId = signal<string | null>(null);
  currentZoneId = signal<string | null>(null);
  isRouteMode = signal<boolean>(false);

  newItemValue = '';
  newItemOrder = 0;
  newItemScore = 0;
  newItemIcon = '';

  // Zonas expandibles y sus rutas
  expandedZones: { [key: string]: boolean } = {};
  zoneRoutes: { [key: string]: any[] } = {};

  constructor() {
    // Listen to route param changes to switch catalog type
    this.route.params.subscribe((p) => {
      let type = p['type'];
      
      // Si el parámetro no viene (como en /admin/catalogs/roles), 
      // verificamos si la URL termina en /roles
      if (!type && this.router.url.endsWith('/roles')) {
        type = 'roles';
      } else if (!type) {
        type = 'conceptos';
      }

      this.selectedType.set(type);
      this.updateTitle(type);
      this.loadCatalog(type);
    });

    // Make fix method available globally for debugging
    (window as any).fixPruebaRoute = () => {
      this.fixRouteWithNullParentId('prueba', 'cc7738f3-5a7b-441c-9258-9d53935f9d38');
    };

    // Fix Paty Chavarria's zona_id
    (window as any).fixPatyZone = () => {
      const LA_PIEDAD_VECINAL_ID = 'cc7738f3-5a7b-441c-9258-9d53935f9d38';
      const patyUserId = 'Paty.chavarria';
      
      console.log('[AdminCatalogs] Fixing Paty Chavarria zona_id to:', LA_PIEDAD_VECINAL_ID);
      
      this.http.patch(`${environment.apiUrl}/users/${patyUserId}`, {
        zona_id: LA_PIEDAD_VECINAL_ID,
        zona: 'LA PIEDAD VECINAL'
      }).subscribe({
        next: (result) => {
          console.log('[AdminCatalogs] Paty Chavarria zona_id fixed:', result);
          this.messageService.add({ 
            severity: 'success', 
            summary: 'Corregido', 
            detail: 'Zona de Paty Chavarria actualizada correctamente' 
          });
        },
        error: (err) => {
          console.error('[AdminCatalogs] Error fixing Paty zona_id:', err);
          this.messageService.add({ 
            severity: 'error', 
            summary: 'Error', 
            detail: 'No se pudo corregir la zona de Paty' 
          });
        }
      });
    };

    // Debug zones and Paty assignment
    (window as any).debugZonesAndPaty = () => {
      console.log('=== DEBUGGING ZONES AND PATY CHAVARRIA ===');
      
      // Load all zones
      this.catalogsService.getCatalog('zonas').subscribe((zones: any[]) => {
        console.log('All zones:', zones);
        
        const laPiedadZones = zones.filter(z => 
          (z.name && z.name.toLowerCase().includes('la piedad')) || 
          (z.value && z.value.toLowerCase().includes('la piedad'))
        );
        console.log('LA PIEDAD zones:', laPiedadZones);
        
        // Load all users to find Paty
        this.http.get<any[]>(`${environment.apiUrl}/users`).subscribe((users: any[]) => {
          const patyUsers = users.filter(u => 
            u.username?.toLowerCase().includes('paty') || 
            u.nombre?.toLowerCase().includes('paty') ||
            u.username?.toLowerCase().includes('chavarria') || 
            u.nombre?.toLowerCase().includes('chavarria')
          );
          console.log('Paty users found:', patyUsers);
          
          patyUsers.forEach(paty => {
            console.log(`Paty ${paty.nombre}: zone_id=${paty.zona_id}, zone_name=${paty.zona}`);
          });
        });
      });
    };
  }

  ngOnInit(): void {
    let type = this.route.snapshot.params['type'];
    
    // Soporte para ruta estática /admin/catalogs/roles
    if (!type && this.router.url.endsWith('/roles')) {
      type = 'roles';
    } else if (!type) {
      type = 'conceptos';
    }

    let subject: AppSubject = 'catalogs';
    if (type === 'roles') subject = 'roles_config';
    else if (['conceptos', 'ubicaciones', 'niveles'].includes(type)) subject = 'scoring_config';

    
    if (!this.perms.can('read', subject)) {
      if (this.perms.can('read', 'reports_team') || this.perms.can('read', 'reports_global')) {
        this.router.navigate(['/dashboard']);
      } else {
        this.router.navigate(['/dashboard/captures']);
      }
      return;
    }
    
    this.selectedType.set(type);
    this.updateTitle(type);
    this.loadCatalog(type);
  }

  updateTitle(type: string) {
    const titles: any = {
      conceptos: 'Gestión de Conceptos',
      ubicaciones: 'Ubicaciones en Tienda',
      niveles: 'Niveles de Ejecución',
      zonas: 'Zonas Geográficas',
      roles: 'Roles de Sistema',
    };
    this.title.set(titles[type] || 'Catálogos');
  }

  onTypeChange(event: any) {
    // Ya no se usa por el sidebar, pero mantenemos lógica si fuera necesario
  }

  loadCatalog(type: string) {
    this.loading.set(true);
    this.catalogsService.getCatalog(type).subscribe({
      next: (data) => {
        this.items.set(data);
        console.log(`[AdminCatalogs] Loaded ${type}:`, data);
        
        // Si es zonas, mostrar detalles de todas las zonas La Piedad
        if (type === 'zonas') {
          const laPiedadZones = data.filter((z: any) => 
            (z.name && z.name.toLowerCase().includes('la piedad')) || 
            (z.value && z.value.toLowerCase().includes('la piedad'))
          );
          console.log('[AdminCatalogs] All LA PIEDAD zones found:', laPiedadZones);
          
          this.loadRoutesForExpandedZones();
        }
        this.loading.set(false);
      },
      error: (err) => {
        this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el catálogo' });
        this.loading.set(false);
      },
    });
  }

  // --- Funciones para Zonas y Rutas ---

  toggleZoneExpansion(zone: any) {
    const zoneId = zone.id;
    this.expandedZones[zoneId] = !this.expandedZones[zoneId];

    if (this.expandedZones[zoneId] && !this.zoneRoutes[zoneId]) {
      this.loadRoutesForZone(zoneId);
    }
  }

  isZoneExpanded(zoneId: string): boolean {
    return this.expandedZones[zoneId] || false;
  }

  loadRoutesForZone(zoneId: string) {
    console.log('[AdminCatalogs] Loading routes for zone:', zoneId);
    console.log('[AdminCatalogs] Full API URL:', `${environment.apiUrl}/catalogs/rutas?parent=${zoneId}`);
    
    // Also load all routes to debug
    this.http.get<any[]>(`${environment.apiUrl}/catalogs/rutas`).subscribe({
      next: (allRoutes) => {
        console.log('[AdminCatalogs] ALL routes in database:', allRoutes);
        console.log('[AdminCatalogs] Looking for zone ID:', zoneId);
        console.log('[AdminCatalogs] Routes with parent_id details:');
        allRoutes.forEach(route => {
          console.log(`  - Route: ${route.value}, parent_id: ${route.parent_id}`);
        });
        console.log('[AdminCatalogs] Routes with parent_id matching zone:', allRoutes.filter(r => r.parent_id === zoneId));
      },
      error: (err) => {
        console.error('[AdminCatalogs] Error loading all routes:', err);
      }
    });
    
    this.http.get<any[]>(`${environment.apiUrl}/catalogs/rutas?parent=${zoneId}`).subscribe({
      next: (routes) => {
        console.log('[AdminCatalogs] Routes loaded for zone:', zoneId, 'Count:', routes.length);
        console.log('[AdminCatalogs] Routes details:', routes);
        this.zoneRoutes[zoneId] = routes;
        
        if (routes.length === 0) {
          console.warn('[AdminCatalogs] No routes found for zone:', zoneId);
        }
      },
      error: (err) => {
        console.error('[AdminCatalogs] Error loading routes for zone:', zoneId, err);
        this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar las rutas' });
      }
    });
  }

  loadRoutesForExpandedZones() {
    Object.keys(this.expandedZones).forEach(zoneId => {
      if (this.expandedZones[zoneId]) {
        this.loadRoutesForZone(zoneId);
      }
    });
  }

  // --- Diálogos para Rutas ---

  openAddRouteDialog(zone: any) {
    console.log('[AdminCatalogs] Opening route dialog for zone:', zone);
    this.isRouteMode.set(true);
    this.currentZoneId.set(zone.id);
    this.isEditMode.set(false);
    this.currentEditingId.set(null);
    this.newItemValue = '';
    this.newItemOrder = (this.zoneRoutes[zone.id]?.length || 0) + 1;
    this.newItemScore = 0;
    this.newItemIcon = '';
    this.showRouteDialog = true;
    console.log('[AdminCatalogs] Current zone ID set to:', zone.id);
  }

  openEditRouteDialog(route: any, zone: any) {
    this.isRouteMode.set(true);
    this.currentZoneId.set(zone.id);
    this.isEditMode.set(true);
    this.currentEditingId.set(route.id);
    this.newItemValue = route.value;
    this.newItemOrder = route.orden;
    this.newItemScore = route.puntuacion || 0;
    this.newItemIcon = route.icono || '';
    this.showRouteDialog = true;
  }

  saveRoute() {
    if (!this.newItemValue.trim()) return;

    const data = {
      value: this.newItemValue,
      orden: this.newItemOrder,
      puntuacion: this.newItemScore,
      icono: this.newItemIcon,
      parent_id: this.currentZoneId() || undefined
    };

    if (this.isEditMode()) {
      this.catalogsService.updateItem('rutas', this.currentEditingId()!, data).subscribe({
        next: () => {
          this.messageService.add({ severity: 'success', summary: 'Éxito', detail: 'Ruta actualizada correctamente' });
          this.loadRoutesForZone(this.currentZoneId()!);
          this.showRouteDialog = false;
        },
        error: (err) => {
          this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo actualizar la ruta' });
        }
      });
    } else {
      // Add parent_id for routes
      const currentZoneId = this.currentZoneId();
      console.log('[AdminCatalogs] Creating route with zone ID:', currentZoneId);
      console.log('[AdminCatalogs] Route data:', data);
      
      if (!currentZoneId) {
        console.error('[AdminCatalogs] No zone ID selected for route creation');
        this.messageService.add({ 
          severity: 'error', 
          summary: 'Error', 
          detail: 'No se ha seleccionado una zona para agregar la ruta' 
        });
        return;
      }
      
      const routeData = {
        ...data,
        parent_id: currentZoneId
      };
      console.log('[AdminCatalogs] Final route data:', routeData);
      
      this.catalogsService.addItem('rutas', routeData).subscribe({
        next: () => {
          this.messageService.add({ severity: 'success', summary: 'Éxito', detail: 'Ruta agregada correctamente' });
          this.loadRoutesForZone(this.currentZoneId()!);
          this.showRouteDialog = false;
        },
        error: (err) => {
          console.error('[AdminCatalogs] Error adding route:', err);
          
          // Handle duplicate route name error
          if (err.error?.code === '23505' || err.status === 409) {
            this.messageService.add({ 
              severity: 'warn', 
              summary: 'Ruta Duplicada', 
              detail: `Ya existe una ruta con el nombre "${data.value}" en esta zona. Por favor, usa un nombre diferente.` 
            });
          } else {
            this.messageService.add({ 
              severity: 'error', 
              summary: 'Error', 
              detail: 'No se pudo agregar la ruta. Inténtalo nuevamente.' 
            });
          }
        }
      });
    }
  }

  deleteRoute(routeId: string, zoneId: string) {
    this.confirmationService.confirm({
      message: '¿Estás seguro de eliminar esta ruta? Esta acción no se puede deshacer.',
      header: 'Confirmar Eliminación',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, eliminar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.executeDeleteRoute(routeId, zoneId);
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

  private executeDeleteRoute(routeId: string, zoneId: string) {
    this.catalogsService.deleteItem('rutas', routeId).subscribe({
      next: () => {
        this.messageService.add({ severity: 'success', summary: 'Éxito', detail: 'Ruta eliminada correctamente' });
        this.loadRoutesForZone(zoneId);
      },
      error: (err) => {
        this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo eliminar la ruta' });
      }
    });
  }

  // Fix routes with null parent_id
  fixRouteWithNullParentId(routeName: string, zoneId: string) {
    console.log(`[AdminCatalogs] Fixing route "${routeName}" with null parent_id to zone: ${zoneId}`);
    
    // First find the route with null parent_id
    this.http.get<any[]>(`${environment.apiUrl}/catalogs/rutas`).subscribe({
      next: (allRoutes) => {
        const routeToFix = allRoutes.find(r => r.value === routeName && r.parent_id === null);
        
        if (routeToFix) {
          console.log(`[AdminCatalogs] Found route to fix:`, routeToFix);
          
          // Update the route with correct parent_id
          const updateData = {
            value: routeToFix.value,
            orden: routeToFix.orden,
            puntuacion: routeToFix.puntuacion || 0,
            icono: routeToFix.icono || '',
            parent_id: zoneId
          };
          
          this.catalogsService.updateItem('rutas', routeToFix.id, updateData).subscribe({
            next: () => {
              console.log(`[AdminCatalogs] Route "${routeName}" fixed successfully`);
              this.messageService.add({ 
                severity: 'success', 
                summary: 'Ruta Corregida', 
                detail: `La ruta "${routeName}" ahora está asociada a la zona correctamente` 
              });
              this.loadRoutesForZone(zoneId);
            },
            error: (err) => {
              console.error(`[AdminCatalogs] Error fixing route:`, err);
              this.messageService.add({ 
                severity: 'error', 
                summary: 'Error', 
                detail: 'No se pudo corregir la ruta' 
              });
            }
          });
        } else {
          console.warn(`[AdminCatalogs] Route "${routeName}" with null parent_id not found`);
          this.messageService.add({ 
            severity: 'warn', 
            summary: 'Ruta No Encontrada', 
            detail: `No se encontró la ruta "${routeName}" con parent_id null` 
          });
        }
      },
      error: (err) => {
        console.error('[AdminCatalogs] Error loading routes to fix:', err);
      }
    });
  }

  openAddDialog() {
    this.isEditMode.set(false);
    this.currentEditingId.set(null);
    this.newItemValue = '';
    this.newItemOrder = this.items().length + 1;
    this.newItemScore = 0;
    this.newItemIcon = '';
    this.showAddDialog = true;
  }

  openEditDialog(item: any) {
    this.isEditMode.set(true);
    this.currentEditingId.set(item.id);
    this.newItemValue = item.value;
    this.newItemOrder = item.orden;
    this.newItemScore = item.puntuacion || 0;
    this.newItemIcon = item.icono || '';
    this.showAddDialog = true;
  }

  saveItem() {
    if (!this.newItemValue.trim()) return;

    const data = {
      value: this.newItemValue,
      orden: this.newItemOrder,
      puntuacion: this.newItemScore,
      icono: this.newItemIcon
    };

    if (this.isEditMode()) {
      this.catalogsService.updateItem(this.selectedType(), this.currentEditingId()!, data).subscribe({
        next: () => {
          this.messageService.add({ severity: 'success', summary: 'Éxito', detail: 'Ítem actualizado correctamente' });
          this.loadCatalog(this.selectedType());
          this.showAddDialog = false;
        },
        error: (err) => {
          this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo actualizar el ítem' });
        }
      });
    } else {
      this.catalogsService.addItem(this.selectedType(), data).subscribe({
        next: () => {
          this.messageService.add({ severity: 'success', summary: 'Éxito', detail: 'Ítem agregado correctamente' });
          this.loadCatalog(this.selectedType());
          this.showAddDialog = false;
        },
        error: (err) => {
          this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo agregar el ítem' });
        }
      });
    }
  }

  deleteItem(id: string, itemName?: string) {
    // Confirmation dialog for all catalog types
    const typeLabel = this.getTypeLabel(this.selectedType());
    this.confirmationService.confirm({
      message: `¿Estás seguro de eliminar ${typeLabel} "${itemName || 'seleccionado'}"? Esta acción no se puede deshacer.`,
      header: 'Confirmar Eliminación',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, eliminar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.executeDelete(id);
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

  private getTypeLabel(type: string): string {
    const labels: Record<string, string> = {
      'roles': 'el rol',
      'zonas': 'la zona',
      'rutas': 'la ruta',
      'conceptos': 'el concepto',
      'ubicaciones': 'la ubicación',
      'niveles': 'el nivel',
      'periodos': 'el periodo',
      'semanas': 'la semana',
    };
    return labels[type] || 'el elemento';
  }

  private executeDelete(id: string) {
    this.catalogsService.deleteItem(this.selectedType(), id).subscribe({
      next: () => {
        this.items.update((items) => items.filter((i) => i.id !== id));
        const typeLabel = this.getTypeLabel(this.selectedType()).charAt(0).toUpperCase() + this.getTypeLabel(this.selectedType()).slice(1);
        this.messageService.add({
          severity: 'success',
          summary: 'Eliminado',
          detail: `${typeLabel} eliminado correctamente.`,
        });
      },
      error: (err: any) => {
        const errorMsg = err?.error?.message || 'No se pudo eliminar el elemento.';
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: errorMsg,
        });
      },
    });
  }

  goToPermissions(roleName: string) {
    this.router.navigate(['/dashboard/admin/roles', roleName, 'permissions']);
  }
}
