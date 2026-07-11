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
import { AUTHZ_TREE, AuthzApp, AuthzModule } from '../../../core/constants/authz-tree';
import { AREA_PRESETS, resolveAreaPresetMap } from '../../../core/constants/role-presets';
import { MessageService, ConfirmationService } from 'primeng/api';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { CheckboxModule } from 'primeng/checkbox';
import { SelectModule } from 'primeng/select';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { TooltipModule } from 'primeng/tooltip';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

type TriState = 'all' | 'some' | 'none';

/**
 * Permisos que dan acceso elevado. El backend también los enforce: solo pueden
 * otorgarse si el editor ya los tiene (anti-escalation).
 */
const ELEVATED_PERMISSIONS: readonly string[] = [
  Permission.REPORTES_VER_GLOBAL,
  Permission.ROLES_CONFIGURAR,
];

/** Permisos críticos que disparan confirm dialog al guardar. */
const CRITICAL_PERMISSIONS: readonly string[] = [
  ...ELEVATED_PERMISSIONS,
  Permission.USUARIOS_GESTIONAR,
  Permission.REPORTES_GESTIONAR,
];

/**
 * Editor de permisos de un rol como ÁRBOL jerárquico (Fase AZ):
 * App → Proyecto → Módulo → acción (Ver/Gestionar). Marcar un nodo padre
 * cascadea a sus hojas; el estado tri (todo/parcial/nada) se deriva de las hojas.
 * Es sólo presentación: al guardar todo se colapsa al mismo `Record<string,boolean>`
 * atómico que consume `PUT /catalogs/permissions/:role`. Guards backend intactos.
 */
@Component({
  selector: 'app-admin-roles-permissions',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    CheckboxModule,
    SelectModule,
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
            Asigna el acceso por app, proyecto o módulo. Marca un grupo para otorgar todo su contenido, o abre el módulo para afinar Ver / Gestionar.
          </p>
        </div>
        <div class="flex gap-2 items-center">
          <p-select
            [options]="presets" optionLabel="label" optionValue="role"
            [(ngModel)]="presetSel" (onChange)="applyPreset($event.value)"
            placeholder="Aplicar plantilla…" appendTo="body" [showClear]="false"
            ariaLabel="Aplicar plantilla de área"
            pTooltip="Rellena el árbol con los permisos típicos de un área (podés ajustar antes de guardar)"
          ></p-select>
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

      <div class="space-y-4">
        @for (app of tree; track app.id) {
          <section class="bg-surface-card border border-divider shadow-sm rounded-xl overflow-hidden">
            <!-- App header -->
            <header class="flex items-center gap-3 px-4 py-3 bg-surface-layout/50 border-b border-divider">
              <button type="button" class="tri" [class.tri-on]="appState(app)==='all'" [class.tri-partial]="appState(app)==='some'"
                      (click)="toggleGroup(appPerms(app))" [attr.aria-label]="'Alternar ' + app.label">
                <i class="pi" [class.pi-check-square]="appState(app)==='all'" [class.pi-minus-square]="appState(app)==='some'" [class.pi-stop]="appState(app)==='none'"></i>
              </button>
              <i [class]="app.icon + ' text-content-dim'"></i>
              <span class="font-bold text-content-main">{{ app.label }}</span>
              <span class="text-[10px] uppercase tracking-wider text-content-faint">{{ app.kind === 'access' ? 'Acceso general' : 'Workspace' }}</span>
              <span class="ml-auto text-xs text-content-faint">{{ countOn(appPerms(app)) }}/{{ appPerms(app).length }}</span>
            </header>

            <!-- Access-only app (Vendedor / Portal): un solo toggle -->
            @if (accessPermOf(app); as ap) {
              <div class="px-4 py-3 flex items-center gap-3">
                <p-checkbox [ngModel]="values()[ap]" [binary]="true"
                            (ngModelChange)="setLeaf(ap, $event)"
                            [disabled]="isLeafDisabled(ap)"></p-checkbox>
                <div class="flex flex-col">
                  <span class="text-sm text-content-main">{{ metaLabel(ap) }}</span>
                  <span class="text-[10px] font-mono text-content-faint">{{ ap }}</span>
                </div>
                @if (isLeafDisabled(ap)) { <span class="tag-locked">Bloqueado</span> }
              </div>
            }

            <!-- Workspace app: proyectos → módulos → acciones -->
            @for (project of app.projects; track project.id) {
              <div class="border-b border-divider/60 last:border-0">
                <button type="button" class="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-surface-layout/30 text-left"
                        (click)="toggleCollapse(project.id)">
                  <span class="tri" (click)="$event.stopPropagation(); toggleGroup(projectPerms(project))"
                        [class.tri-on]="projectState(project)==='all'" [class.tri-partial]="projectState(project)==='some'">
                    <i class="pi" [class.pi-check-square]="projectState(project)==='all'" [class.pi-minus-square]="projectState(project)==='some'" [class.pi-stop]="projectState(project)==='none'"></i>
                  </span>
                  <i [class]="'pi ' + (isCollapsed(project.id) ? 'pi-chevron-right' : 'pi-chevron-down') + ' text-[10px] text-content-faint'"></i>
                  <span class="font-semibold text-sm text-content-main">{{ project.label }}</span>
                  <span class="ml-auto text-xs text-content-faint">{{ countOn(projectPerms(project)) }}/{{ projectPerms(project).length }}</span>
                </button>

                @if (!isCollapsed(project.id)) {
                  <div class="pb-2">
                    @for (mod of project.modules; track mod.id) {
                      <div class="pl-10 pr-4 py-1.5">
                        <div class="flex items-center gap-2">
                          <span class="tri tri-sm" (click)="toggleGroup(modulePerms(mod))"
                                [class.tri-on]="moduleState(mod)==='all'" [class.tri-partial]="moduleState(mod)==='some'">
                            <i class="pi text-xs" [class.pi-check-square]="moduleState(mod)==='all'" [class.pi-minus-square]="moduleState(mod)==='some'" [class.pi-stop]="moduleState(mod)==='none'"></i>
                          </span>
                          <span class="text-sm text-content-main">{{ mod.label }}</span>
                          @if (mod.route) { <span class="text-[10px] font-mono text-content-faint">{{ mod.route }}</span> }
                        </div>
                        <!-- acciones del módulo -->
                        <div class="flex flex-wrap gap-x-5 gap-y-1 pl-6 mt-1">
                          @for (key of modulePerms(mod); track key) {
                            <label class="inline-flex items-center gap-1.5 cursor-pointer"
                                   [class.bg-bad-soft-bg]="isCritical(key)">
                              <p-checkbox [ngModel]="values()[key]" [binary]="true"
                                          (ngModelChange)="setLeaf(key, $event)"
                                          [disabled]="isLeafDisabled(key)"></p-checkbox>
                              <span class="text-xs text-content-dim" [pTooltip]="metaDescription(key)">
                                <span class="text-[9px] uppercase tracking-wide" [class.text-brand]="mod.manage.includes(key)" [class.text-content-faint]="!mod.manage.includes(key)">{{ mod.manage.includes(key) ? '' : 'ver ' }}</span>{{ metaLabel(key) }}
                              </span>
                              @if (isCritical(key)) { <span class="status-chip status-bad" pTooltip="Permiso de alto impacto">Crítico</span> }
                              @if (isLeafDisabled(key)) { <span class="tag-locked" pTooltip="Tu rol no tiene este permiso, no puedes otorgarlo">Bloqueado</span> }
                            </label>
                          }
                        </div>
                      </div>
                    }
                  </div>
                }
              </div>
            }
          </section>
        }
      </div>
    </div>
  `,
  styles: [`
    .tri { display:inline-flex; align-items:center; justify-content:center; width:1.5rem; height:1.5rem; border-radius:.375rem; cursor:pointer; color: var(--text-faint); }
    .tri:hover { background: var(--hover-bg); }
    .tri-on { color: var(--action); }
    .tri-partial { color: var(--text-muted); }
    .tri-sm { width:1.25rem; height:1.25rem; }
    .tri:focus-visible { outline:2px solid var(--action-ring); outline-offset:1px; }
    .tag-locked { font-size:9px; text-transform:uppercase; letter-spacing:.05em; color: var(--text-faint); border:1px solid var(--border-color); border-radius:.25rem; padding:0 .375rem; }
  `],
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

  readonly tree: readonly AuthzApp[] = AUTHZ_TREE;
  readonly presets = AREA_PRESETS;

  /**
   * Rellena el árbol con la plantilla de un área. Respeta anti-escalation: solo
   * toca hojas que el editor puede otorgar; las bloqueadas quedan como están.
   * No guarda — deja el estado dirty para que el admin revise y confirme.
   */
  applyPreset(role: string): void {
    const preset = this.presets.find((p) => p.role === role);
    // Es una acción, no una selección persistente: reset para que el placeholder vuelva.
    this.presetSel = null;
    if (!preset) return;
    const map = resolveAreaPresetMap(preset);
    this.values.update((v) => {
      const next = { ...v };
      for (const key of Object.values(Permission)) {
        if (!this.canGrant(key)) continue; // bloqueado: no se toca
        next[key] = map[key] === true;
      }
      return next;
    });
    this.messageService.add({
      severity: 'info',
      summary: 'Plantilla aplicada',
      detail: `"${preset.label}" — revisá los permisos y guardá para aplicar.`,
    });
  }

  presetSel: string | null = null;
  roleName = signal<string>('');
  saving = signal<boolean>(false);
  values = signal<Record<string, boolean>>({});
  private original = signal<Record<string, boolean>>({});
  private collapsed = signal<Set<string>>(new Set());

  auditInfo = signal<{ updatedAt: string | null; updatedBy: string | null }>({
    updatedAt: null,
    updatedBy: null,
  });

  readonly isDirty = computed(() => {
    const o = this.original();
    const v = this.values();
    return Object.values(Permission).some((k) => (v[k] ?? false) !== (o[k] ?? false));
  });

  ngOnInit(): void {
    if (!this.perms.can('manage', 'roles_config')) {
      if (this.perms.can('read', 'reports_team') || this.perms.can('read', 'reports_global')) {
        this.router.navigate(['/dashboard']);
      } else {
        this.router.navigate(['/dashboard/captures']);
      }
      return;
    }
    this.route.params.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((p) => {
      const name = p['role_name'];
      if (name) {
        this.roleName.set(name);
        this.loadPermissions(name);
      }
    });
  }

  // ── Helpers de árbol ──────────────────────────────────────────────────
  appPerms(app: AuthzApp): Permission[] {
    if (app.kind === 'access') return app.accessPermission ? [app.accessPermission] : [];
    return app.projects.flatMap((pr) => pr.modules.flatMap((m) => [...m.view, ...m.manage]));
  }
  /** Permiso de acceso de una app 'access' (null si es workspace). Para narrowing en el template. */
  accessPermOf(app: AuthzApp): Permission | null {
    return app.kind === 'access' ? app.accessPermission ?? null : null;
  }
  projectPerms(project: AuthzApp['projects'][number]): Permission[] {
    return project.modules.flatMap((m) => [...m.view, ...m.manage]);
  }
  modulePerms(mod: AuthzModule): Permission[] {
    return [...mod.view, ...mod.manage];
  }
  countOn(keys: Permission[]): number {
    const v = this.values();
    return keys.filter((k) => v[k] === true).length;
  }
  private state(keys: Permission[]): TriState {
    if (!keys.length) return 'none';
    const on = this.countOn(keys);
    return on === 0 ? 'none' : on === keys.length ? 'all' : 'some';
  }
  appState(app: AuthzApp): TriState { return this.state(this.appPerms(app)); }
  projectState(project: AuthzApp['projects'][number]): TriState { return this.state(this.projectPerms(project)); }
  moduleState(mod: AuthzModule): TriState { return this.state(this.modulePerms(mod)); }

  isCollapsed(id: string): boolean { return this.collapsed().has(id); }
  toggleCollapse(id: string): void {
    this.collapsed.update((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // ── Anti-escalation (espejo del backend) ──────────────────────────────
  private isSuperEditor(): boolean { return this.perms.can('manage', 'all'); }
  private canGrant(key: string): boolean {
    if (this.isSuperEditor()) return true;
    return this.authService.user()?.permissions?.[key] === true;
  }
  /** Deshabilitado: no otorgado aún Y el editor no puede otorgarlo. Quitar siempre se permite. */
  isLeafDisabled(key: string): boolean {
    return this.values()[key] !== true && !this.canGrant(key);
  }
  isCritical(key: string): boolean { return CRITICAL_PERMISSIONS.includes(key); }
  metaLabel(key: string): string { return PERMISSION_META[key]?.label || key; }
  metaDescription(key: string): string { return PERMISSION_META[key]?.description || ''; }

  // ── Mutaciones ────────────────────────────────────────────────────────
  setLeaf(key: string, value: boolean): void {
    if (value && this.isLeafDisabled(key)) return; // no puede otorgar
    this.values.update((v) => ({ ...v, [key]: value }));
  }
  /** Marca/desmarca todas las hojas del grupo (respeta anti-escalation al otorgar). */
  toggleGroup(keys: Permission[]): void {
    const target = this.state(keys) !== 'all';
    this.values.update((v) => {
      const next = { ...v };
      for (const k of keys) {
        if (!target) next[k] = false;
        else if (this.canGrant(k)) next[k] = true;
      }
      return next;
    });
  }

  goBack(): void {
    if (this.isDirty()) {
      this.confirmationService.confirm({
        message: 'Hay cambios sin guardar. ¿Salir y descartarlos?',
        header: 'Cambios sin guardar',
        icon: 'pi pi-exclamation-triangle',
        acceptLabel: 'Salir sin guardar',
        rejectLabel: 'Cancelar',
        acceptButtonStyleClass: 'p-button-danger',
        accept: () => this.router.navigate(['/admin/roles']),
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
          const current: Record<string, boolean> = roleData.permissions || {};
          const values: Record<string, boolean> = {};
          for (const key of Object.values(Permission)) {
            values[key] = current[key] === true;
          }
          this.values.set(values);
          this.original.set({ ...values });
          this.auditInfo.set({
            updatedAt: roleData.updated_at ?? null,
            updatedBy: roleData.updated_by_username ?? roleData.updated_by ?? null,
          });
        },
        error: (err: any) => {
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: err?.error?.message || 'No se pudieron cargar los permisos.',
          });
        },
      });
  }

  /** Si se otorgan permisos críticos nuevos, pedir confirmación adicional. */
  confirmSave(): void {
    if (this.saving() || !this.isDirty()) return;
    const o = this.original();
    const v = this.values();
    const newlyCritical = Object.values(Permission)
      .filter((k) => this.isCritical(k) && v[k] === true && (o[k] ?? false) === false)
      .map((k) => this.metaLabel(k));

    if (newlyCritical.length > 0) {
      this.confirmationService.confirm({
        header: 'Otorgar permisos críticos',
        icon: 'pi pi-exclamation-triangle',
        message: `Estás a punto de otorgar permisos críticos a "${this.roleName()}":\n• ${newlyCritical.join('\n• ')}\n\n¿Continuar?`,
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
    // Colapsa el árbol al Record atómico completo (misma forma que consume el backend).
    const newPerms: Record<string, boolean> = {};
    for (const key of Object.values(Permission)) {
      newPerms[key] = this.values()[key] === true;
    }
    this.catalogsService
      .updateRolePermissions(this.roleName(), newPerms)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.original.set({ ...newPerms });
          this.saving.set(false);
          this.messageService.add({
            severity: 'success',
            summary: 'Éxito',
            detail: 'Funciones actualizadas. El cambio aplica en segundos, sin re-iniciar sesión.',
          });
        },
        error: (err: any) => {
          this.saving.set(false);
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: err?.error?.message || 'No se pudo guardar la configuración.',
          });
        },
      });
  }
}
