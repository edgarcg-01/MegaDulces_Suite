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
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AdminCatalogsService } from '../admin-catalogs/admin-catalogs.service';
import { Permission } from '../../../core/constants/permissions';
import { PERMISSION_META } from '../../../core/constants/permission-meta';
import { MessageService, ConfirmationService } from 'primeng/api';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { TableModule } from 'primeng/table';
import { CheckboxModule } from 'primeng/checkbox';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { TooltipModule } from 'primeng/tooltip';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

interface PermissionRow {
  key: string;
  label: string;
  description: string;
  category: string;
  enabled: boolean;
  critical?: boolean;
}

/**
 * Permisos que dan acceso elevado. El backend también los enforce: solo
 * pueden otorgarse si el editor ya los tiene (anti-escalation).
 */
const ELEVATED_PERMISSIONS: readonly string[] = [
  Permission.REPORTES_VER_GLOBAL,
  Permission.ROLES_CONFIGURAR,
];

/**
 * Permisos críticos que disparan confirm dialog al guardar (acciones de
 * alto impacto: gestión de usuarios, exports, acceso global).
 */
const CRITICAL_PERMISSIONS: readonly string[] = [
  ...ELEVATED_PERMISSIONS,
  Permission.USUARIOS_GESTIONAR,
  Permission.REPORTES_GESTIONAR,
];

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
    ConfirmDialogModule,
    TooltipModule,
  ],
  providers: [MessageService, ConfirmationService],
  template: `
    <div class="p-6 max-w-4xl mx-auto">
      <p-toast></p-toast>
      <p-confirmDialog></p-confirmDialog>

      <div class="flex justify-between items-center mb-6">
        <div>
          <h1 class="text-3xl font-bold tracking-tight text-content-main flex items-center gap-3">
            <i class="pi pi-shield text-content-main"></i> Permisos de Rol:
            <span class="text-brand">{{ roleName() }}</span>
            @if (isDirty()) {
              <span class="ml-2 text-[10px] uppercase tracking-wider text-warn-fg border border-warn-border rounded px-1.5 py-0.5">Sin guardar</span>
            }
          </h1>
          <p class="text-sm text-content-dim">
            Define las funciones y alcances dinámicos para este rol en el sistema.
          </p>
        </div>
        <div class="flex gap-2">
          <p-button
            label="Guardar Cambios"
            icon="pi pi-save"
            (onClick)="confirmSave()"
            styleClass="p-button-brand"
            [loading]="saving()"
            [disabled]="saving() || !isDirty()"
          ></p-button>
          <p-button
            label="Regresar"
            icon="pi pi-arrow-left"
            severity="secondary"
            [text]="true"
            (onClick)="goBack()"
          ></p-button>
        </div>
      </div>

      @if (auditInfo().updatedAt) {
        <div class="mb-4 px-4 py-2 bg-surface-layout/40 border border-divider rounded-lg text-xs text-content-muted flex items-center gap-2">
          <i class="pi pi-history text-content-faint"></i>
          Última modificación: <span class="font-medium text-content-main">{{ auditInfo().updatedAt | date:'medium' }}</span>
          @if (auditInfo().updatedBy) {
            <span class="text-content-faint">·</span>
            <span class="font-mono text-[10px]">{{ auditInfo().updatedBy }}</span>
          }
        </div>
      }

      <div class="bg-surface-card border border-divider shadow-sm rounded-xl overflow-hidden">
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
                <span class="font-black text-[10px] uppercase text-brand tracking-widest">{{ row.category }}</span>
              </td>
            </tr>
          </ng-template>

          <ng-template pTemplate="body" let-row>
            <tr [class.bg-bad-soft-bg]="row.critical">
              <td>
                <p-checkbox
                  [ngModel]="row.enabled"
                  (ngModelChange)="togglePermission(row.key, $event)"
                  [binary]="true"
                  [disabled]="isPermissionLocked(row.key, row.enabled)"
                ></p-checkbox>
              </td>
              <td>
                <div class="flex flex-col">
                  <span class="font-bold text-content-main text-sm flex items-center gap-2">
                    {{ row.label }}
                    @if (row.critical) {
                      <span class="status-chip status-bad" pTooltip="Permiso de alto impacto">Crítico</span>
                    }
                    @if (isPermissionLocked(row.key, row.enabled)) {
                      <span class="text-[9px] uppercase tracking-wider text-content-faint border border-divider rounded px-1.5 py-0.5" pTooltip="No puedes otorgar este permiso porque tu rol no lo tiene">Bloqueado</span>
                    }
                  </span>
                  <span class="text-[10px] font-mono text-content-faint">{{ row.key }}</span>
                </div>
              </td>
              <td class="text-xs text-content-dim">{{ row.description }}</td>
            </tr>
          </ng-template>
        </p-table>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminRolesPermissionsComponent implements OnInit {
  private catalogsService = inject(AdminCatalogsService);
  private messageService = inject(MessageService);
  private confirmationService = inject(ConfirmationService);
  private route = inject(ActivatedRoute);
  private authService = inject(AuthService);
  private router = inject(Router);
  private perms = inject(PermissionsService);
  private destroyRef = inject(DestroyRef);

  roleName = signal<string>('');
  permissionRows = signal<PermissionRow[]>([]);
  saving = signal<boolean>(false);

  // Audit metadata del backend (updated_at, updated_by).
  auditInfo = signal<{ updatedAt: string | null; updatedBy: string | null }>({
    updatedAt: null,
    updatedBy: null,
  });

  // Snapshot del estado inicial para detectar cambios sin guardar.
  private originalPerms = signal<Record<string, boolean>>({});

  readonly isDirty = computed(() => {
    const orig = this.originalPerms();
    return this.permissionRows().some(
      (row) => row.enabled !== (orig[row.key] ?? false),
    );
  });

  // Labels / descripciones / categorías: fuente única compartida con la vista
  // de roles (core/constants/permission-meta.ts).
  private permissionMeta = PERMISSION_META;

  ngOnInit(): void {
    if (!this.perms.can('manage', 'roles_config')) {
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

    this.route.params
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((p) => {
        const name = p['role_name'];
        if (name) {
          this.roleName.set(name);
          this.loadPermissions(name);
        }
      });
  }

  /**
   * El editor con `manage:all` (superadmin / reporte global) puede otorgar
   * cualquier permiso — no aplica anti-escalation.
   */
  private isSuperEditor(): boolean {
    return this.perms.can('manage', 'all');
  }

  /**
   * Anti-escalation (espejo del backend): el editor solo puede OTORGAR
   * permisos que él mismo posee. Si el permiso ya está habilitado, siempre se
   * puede quitar. Sirve tanto para deshabilitar el checkbox como para el badge
   * "Bloqueado".
   */
  isPermissionLocked(key: string, enabled: boolean): boolean {
    if (enabled) return false;
    if (this.isSuperEditor()) return false;
    const editorPerms = this.authService.user()?.permissions ?? {};
    return !editorPerms[key];
  }

  togglePermission(key: string, enabled: boolean): void {
    this.permissionRows.update((rows) =>
      rows.map((r) => (r.key === key ? { ...r, enabled } : r)),
    );
  }

  goBack(): void {
    if (this.isDirty()) {
      this.confirmationService.confirm({
        message:
          'Hay cambios sin guardar. ¿Salir y descartarlos?',
        header: 'Cambios sin guardar',
        icon: 'pi pi-exclamation-triangle',
        acceptLabel: 'Salir sin guardar',
        rejectLabel: 'Cancelar',
        acceptButtonStyleClass: 'p-button-danger',
        accept: () =>
          this.router.navigate(['/admin/roles']),
      });
    } else {
      this.router.navigate(['/admin/roles']);
    }
  }

  loadPermissions(roleName: string): void {
    this.catalogsService
      .getRolePermissions(roleName)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (roleData) => {
          const currentPerms: Record<string, boolean> =
            roleData.permissions || {};

          const rows: PermissionRow[] = Object.values(Permission).map((key) => {
            const meta = this.permissionMeta[key];
            return {
              key,
              label: meta?.label || key,
              description: meta?.description || '',
              category: meta?.category || 'Otros',
              enabled: currentPerms[key] === true,
              critical: CRITICAL_PERMISSIONS.includes(key),
            };
          });

          this.permissionRows.set(rows);

          // Snapshot del estado inicial para dirty tracking.
          const snapshot: Record<string, boolean> = {};
          for (const row of rows) snapshot[row.key] = row.enabled;
          this.originalPerms.set(snapshot);

          // Audit info para mostrar "Última modificación". Preferimos el
          // username legible; caemos al UUID solo si el join no resolvió.
          this.auditInfo.set({
            updatedAt: roleData.updated_at ?? null,
            updatedBy:
              roleData.updated_by_username ?? roleData.updated_by ?? null,
          });
        },
        error: (err: any) => {
          const detail =
            err?.error?.message || 'No se pudieron cargar los permisos.';
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail,
          });
        },
      });
  }

  /**
   * Si se están otorgando permisos críticos, pedir confirmación adicional.
   * En el resto de casos, guardar directamente.
   */
  confirmSave(): void {
    if (this.saving() || !this.isDirty()) return;

    const orig = this.originalPerms();
    const newlyGrantedCritical = this.permissionRows()
      .filter(
        (r) =>
          r.critical && r.enabled === true && (orig[r.key] ?? false) === false,
      )
      .map((r) => r.label || r.key);

    if (newlyGrantedCritical.length > 0) {
      this.confirmationService.confirm({
        header: 'Otorgar permisos críticos',
        icon: 'pi pi-exclamation-triangle',
        message: `Estás a punto de otorgar permisos críticos a "${this.roleName()}":\n• ${newlyGrantedCritical.join('\n• ')}\n\n¿Continuar?`,
        acceptLabel: 'Sí, otorgar',
        rejectLabel: 'Cancelar',
        acceptButtonStyleClass: 'p-button-danger',
        accept: () => this.savePermissions(),
      });
      return;
    }

    this.savePermissions();
  }

  private savePermissions(): void {
    this.saving.set(true);
    const newPerms: Record<string, boolean> = {};
    this.permissionRows().forEach((row) => {
      newPerms[row.key] = row.enabled;
    });

    this.catalogsService
      .updateRolePermissions(this.roleName(), newPerms)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          // Refrescar snapshot para que isDirty vuelva a false.
          this.originalPerms.set({ ...newPerms });
          this.saving.set(false);
          this.messageService.add({
            severity: 'success',
            summary: 'Éxito',
            detail:
              'Funciones actualizadas. El cambio aplica en segundos, sin re-iniciar sesión.',
          });
        },
        error: (err: any) => {
          this.saving.set(false);
          const detail =
            err?.error?.message || 'No se pudo guardar la configuración.';
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail,
          });
        },
      });
  }
}
