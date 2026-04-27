import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AdminCatalogsService } from '../admin-catalogs/admin-catalogs.service';
import { Permission } from '../../../core/constants/permissions';
import { MessageService } from 'primeng/api';
import { TableModule } from 'primeng/table';
import { CheckboxModule } from 'primeng/checkbox';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';

interface PermissionRow {
  key: string;
  label: string;
  description: string;
  category: string;
  enabled: boolean;
}

@Component({
  selector: 'app-admin-roles-permissions',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    TableModule,
    CheckboxModule,
    ButtonModule,
    ToastModule,
  ],
  providers: [MessageService],
  template: `
    <div class="p-6 max-w-4xl mx-auto">
      <p-toast></p-toast>
      <div class="flex justify-between items-center mb-6">
        <div>
          <h2
            class="text-2xl font-black text-content-main tracking-tight uppercase flex items-center gap-3"
          >
            <i class="pi pi-shield text-brand"></i> Permisos de Rol:
            <span class="text-brand">{{ roleName() }}</span>
          </h2>
          <p class="text-xs font-medium text-content-dim tracking-wide">
            Define las funciones y alcances dinámicos para este rol en el sistema.
          </p>
        </div>
        <div class="flex gap-2">
          <p-button
            label="Guardar Cambios"
            icon="pi pi-save"
            (onClick)="savePermissions()"
            styleClass="p-button-brand"
            [loading]="saving()"
          ></p-button>
          <p-button
            label="Regresar"
            icon="pi pi-arrow-left"
            [text]="true"
            routerLink="/dashboard/admin/catalogs/roles"
          ></p-button>
        </div>
      </div>

      <div
        class="bg-surface-card border border-surface-border shadow-sm rounded-xl overflow-hidden"
      >
        <p-table
          [value]="permissionRows()"
          sortField="category"
          rowGroupMode="subheader"
          groupRowsBy="category"
          styleClass="p-datatable-sm"
        >
          <ng-template pTemplate="header">
            <tr>
              <th style="width: 10%">Activo</th>
              <th>Función / Permiso</th>
              <th>Descripción</th>
            </tr>
          </ng-template>
          <ng-template pTemplate="groupheader" let-row>
            <tr pRowGroupHeader class="bg-surface-layout/50">
              <td colspan="3">
                <span
                  class="font-black text-[10px] uppercase text-brand tracking-widest"
                  >{{ row.category }}</span
                >
              </td>
            </tr>
          </ng-template>

          <ng-template pTemplate="body" let-row>
            <tr>
              <td>
                <p-checkbox
                  [(ngModel)]="row.enabled"
                  [binary]="true"
                ></p-checkbox>
              </td>
              <td>
                <div class="flex flex-col">
                  <span class="font-bold text-content-main text-sm">{{ row.label }}</span>
                  <span class="text-[10px] font-mono text-content-faint">{{ row.key }}</span>
                </div>
              </td>
              <td class="text-xs text-content-dim">
                {{ row.description }}
              </td>
            </tr>
          </ng-template>
        </p-table>
      </div>
    </div>
  `,
})
export class AdminRolesPermissionsComponent implements OnInit {
  private catalogsService = inject(AdminCatalogsService);
  private messageService = inject(MessageService);
  private route = inject(ActivatedRoute);

  roleName = signal<string>('');
  permissionRows = signal<PermissionRow[]>([]);
  saving = signal<boolean>(false);

  // Definición maestra de etiquetas y descripciones para el UI
  private permissionMeta: Record<string, { label: string; description: string; category: string }> = {
    [Permission.USUARIOS_VER]: { label: 'Consultar Usuarios', description: 'Permite listar y ver el perfil de otros usuarios.', category: 'Usuarios' },
    [Permission.USUARIOS_GESTIONAR]: { label: 'Gestionar Usuarios', description: 'Alta, baja y edición de usuarios.', category: 'Usuarios' },
    [Permission.USUARIOS_PASSWORDS]: { label: 'Resetear Contraseñas', description: 'Permite cambiar contraseñas de cualquier usuario.', category: 'Usuarios' },
    [Permission.USUARIOS_ASIGNAR_RUTA]: { label: 'Asignar Rutas', description: 'Permite definir la agenda semanal de rutas para el equipo.', category: 'Usuarios' },
    
    [Permission.REPORTES_VER_PROPIO]: { label: 'Ver Reportes Propios', description: 'Acceso básico a sus propios indicadores.', category: 'Reportes' },
    [Permission.REPORTES_VER_EQUIPO]: { label: 'Ver Reportes de Equipo', description: 'Acceso a indicadores de subordinados directos.', category: 'Reportes' },
    [Permission.REPORTES_VER_GLOBAL]: { label: 'Ver Reporte Global', description: 'Acceso total a la data de la compañía.', category: 'Reportes' },
    [Permission.REPORTES_EXPORTAR]: { label: 'Exportar Data (Excel/CSV)', description: 'Permite descargar crudos de información.', category: 'Reportes' },
    
    [Permission.VISITAS_REGISTRAR]: { label: 'Registrar Visitas', description: 'Habilita el formulario de check-in/visto bueno.', category: 'Operación' },
    [Permission.VISITAS_AUDITAR]: { label: 'Auditar Visitas', description: 'Permite validar y cerrar visitas de otros.', category: 'Operación' },
    
    [Permission.CATALOGO_GESTIONAR]: { label: 'Gestionar Catálogos', description: 'Control de conceptos, zonas y ubicaciones.', category: 'Configuración' },
    [Permission.PLANOGRAMAS_GESTIONAR]: { label: 'Gestionar Planogramas', description: 'Creación de marcas y jerarquías de productos.', category: 'Configuración' },
    [Permission.ROLES_CONFIGURAR]: { label: 'Configurar Roles y Funciones', description: 'ACCESO CRÍTICO: Edita este panel de permisos.', category: 'Configuración' },
  };

  ngOnInit() {
    this.route.params.subscribe((p) => {
      const name = p['role_name'];
      if (name) {
        this.roleName.set(name);
        this.loadPermissions(name);
      }
    });
  }

  loadPermissions(roleName: string) {
    this.catalogsService.getRolePermissions(roleName).subscribe({
      next: (roleData) => {
        const currentPerms = roleData.permissions || {};
        // Mapear el enum a filas del UI
        const rows: PermissionRow[] = Object.values(Permission).map((key) => ({
          key,
          label: this.permissionMeta[key]?.label || key,
          description: this.permissionMeta[key]?.description || '',
          category: this.permissionMeta[key]?.category || 'Otros',
          enabled: currentPerms[key] === true
        }));

        this.permissionRows.set(rows);
      },
      error: () => {
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: 'No se pudieron cargar los permisos',
        });
      },
    });
  }

  savePermissions() {
    this.saving.set(true);
    const newPerms: Record<string, boolean> = {};
    this.permissionRows().forEach((row) => {
      newPerms[row.key] = row.enabled;
    });

    this.catalogsService
      .updateRolePermissions(this.roleName(), newPerms)
      .subscribe({
        next: () => {
          this.messageService.add({
            severity: 'success',
            summary: 'Éxito',
            detail:
              'Funciones actualizadas. Los usuarios deben re-iniciar sesión para ver cambios.',
          });
          this.saving.set(false);
        },
        error: () => {
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: 'No se pudo guardar la configuración',
          });
          this.saving.set(false);
        },
      });
  }
}
