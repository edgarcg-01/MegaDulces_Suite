import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TooltipModule } from 'primeng/tooltip';
import {
  PERMISSION_CATEGORY_ORDER,
  PERMISSION_META,
  TOTAL_PERMISSIONS,
} from '../../../core/constants/permission-meta';

interface RoleInput {
  id: string;
  value: string; // role_name
  is_system?: boolean;
  permissions?: Record<string, boolean>;
  user_count?: number;
  updated_at?: string | null;
}

interface ModuleCoverage {
  name: string;
  enabled: number;
  total: number;
}

interface RoleCard extends RoleInput {
  enabledCount: number;
  total: number;
  pct: number;
  fullAccess: boolean;
  modules: ModuleCoverage[];
  shownModules: ModuleCoverage[];
  extraModules: number;
}

interface BreakdownItem {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
}

interface BreakdownGroup {
  name: string;
  items: BreakdownItem[];
  enabled: number;
  total: number;
}

const MAX_CHIPS = 4;

/**
 * Roles de plataforma con god-mode (`manage:all`) en el backend. El acceso total
 * se deriva del NOMBRE del rol (ver ability.factory `isPlatformAdminRole`), NO de
 * un permiso de negocio. Antes el grid usaba `REPORTES_VER_GLOBAL` como proxy: un
 * rol custom con ese flag mostraba "Acceso total" siendo falso, y admin/superadmin
 * lo mostraban en NO. Mantener sincronizado con el backend.
 */
const PLATFORM_ADMIN_ROLES: readonly string[] = ['superadmin', 'admin'];

@Component({
  selector: 'app-admin-roles-grid',
  standalone: true,
  imports: [CommonModule, TooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (cards().length === 0) {
      <div class="bg-surface-card border border-divider rounded-xl py-12 px-4 flex flex-col items-center gap-2 text-content-muted">
        <i class="pi pi-shield text-3xl text-content-faint" aria-hidden="true"></i>
        <p class="text-sm">No se encontraron roles.</p>
      </div>
    } @else {
      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        @for (card of cards(); track card.id) {
          <div
            class="group bg-surface-card border border-divider rounded-xl p-4 shadow-sm flex flex-col gap-3 cursor-pointer hover:border-brand/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-safe:transition-all"
            role="button"
            tabindex="0"
            [attr.aria-label]="'Ver desglose de ' + card.value"
            (click)="openDrawer(card)"
            (keydown.enter)="openDrawer(card)"
            (keydown.space)="$event.preventDefault(); openDrawer(card)"
          >
            <!-- Header -->
            <div class="flex items-start justify-between gap-2">
              <div class="flex items-center gap-2.5 min-w-0">
                <span class="w-9 h-9 shrink-0 rounded-lg bg-surface-layout border border-divider flex items-center justify-center text-brand">
                  <i class="pi pi-shield text-sm"></i>
                </span>
                <div class="min-w-0">
                  <h3 class="font-bold text-content-main text-sm truncate">{{ card.value }}</h3>
                  <span class="text-[11px] text-content-faint flex items-center gap-1">
                    <i class="pi pi-users text-[10px]"></i>{{ card.user_count || 0 }} usuario{{ card.user_count === 1 ? '' : 's' }}
                  </span>
                </div>
              </div>
              @if (card.is_system) {
                <span class="shrink-0 text-[10px] uppercase tracking-wider text-content-faint border border-divider rounded px-1.5 py-0.5" pTooltip="Rol del sistema, protegido">Sistema</span>
              }
            </div>

            <!-- Cobertura -->
            <div class="flex flex-col gap-1.5">
              <div class="flex items-center justify-between text-[11px]">
                @if (card.fullAccess) {
                  <span class="font-semibold text-brand flex items-center gap-1"><i class="pi pi-verified text-[10px]"></i>Acceso total</span>
                } @else {
                  <span class="text-content-muted">Cobertura de permisos</span>
                }
                <span class="font-mono text-content-muted">{{ card.enabledCount }}/{{ card.total }}</span>
              </div>
              <div class="h-1.5 rounded-full bg-surface-layout overflow-hidden">
                <div
                  class="h-full rounded-full motion-safe:transition-all"
                  [class.bg-brand]="!card.fullAccess"
                  [class.bg-ok-fg]="card.fullAccess"
                  [style.width.%]="card.pct"
                ></div>
              </div>
            </div>

            <!-- Módulos -->
            <div class="flex flex-wrap gap-1.5 min-h-[1.5rem]">
              @for (m of card.shownModules; track m.name) {
                <span class="text-[10px] px-1.5 py-0.5 rounded bg-surface-layout text-content-muted border border-divider" [pTooltip]="m.enabled + '/' + m.total + ' permisos'">{{ m.name }}</span>
              }
              @if (card.extraModules > 0) {
                <span class="text-[10px] px-1.5 py-0.5 rounded text-content-faint">+{{ card.extraModules }}</span>
              }
              @if (card.modules.length === 0) {
                <span class="text-[11px] text-content-faint italic">Sin permisos asignados</span>
              }
            </div>

            <!-- Acciones -->
            <div class="flex items-center justify-between pt-1 mt-auto border-t border-divider">
              <button
                type="button"
                class="text-xs font-medium text-brand hover:underline flex items-center gap-1"
                (click)="$event.stopPropagation(); editPermissions.emit(card.value)"
                [attr.aria-label]="'Editar permisos de ' + card.value"
              >
                <i class="pi pi-sliders-h text-xs"></i> Editar permisos
              </button>
              @if (canManage() && !card.is_system) {
                <div class="flex gap-1">
                  <button type="button" class="icon-btn-ghost icon-btn-ghost-info" (click)="$event.stopPropagation(); renameRole.emit(card)" pTooltip="Renombrar" aria-label="Renombrar rol"><i class="pi pi-pencil text-sm"></i></button>
                  <button type="button" class="icon-btn-ghost icon-btn-ghost-bad" (click)="$event.stopPropagation(); deleteRole.emit(card)" pTooltip="Eliminar" aria-label="Eliminar rol"><i class="pi pi-trash text-sm"></i></button>
                </div>
              }
            </div>
          </div>
        }
      </div>
    }

    <!-- Drawer de desglose -->
    @if (selected(); as role) {
      <div class="fixed inset-0 z-[1100] flex justify-end" role="dialog" aria-modal="true" [attr.aria-label]="'Desglose de permisos de ' + role.value">
        <div class="absolute inset-0 bg-black/40 motion-safe:animate-[fadeIn_.15s_ease-out]" (click)="closeDrawer()"></div>
        <div class="relative w-full max-w-md h-full bg-surface-card border-l border-divider shadow-xl flex flex-col motion-safe:animate-[slideInRight_.2s_ease-out]">
          <!-- Header drawer -->
          <div class="flex items-start justify-between gap-3 p-4 border-b border-divider">
            <div class="flex items-center gap-3 min-w-0">
              <span class="w-10 h-10 shrink-0 rounded-lg bg-surface-layout border border-divider flex items-center justify-center text-brand">
                <i class="pi pi-shield"></i>
              </span>
              <div class="min-w-0">
                <h2 class="font-bold text-content-main truncate flex items-center gap-2">
                  {{ role.value }}
                  @if (role.is_system) {
                    <span class="text-[10px] uppercase tracking-wider text-content-faint border border-divider rounded px-1.5 py-0.5">Sistema</span>
                  }
                </h2>
                <p class="text-xs text-content-muted">
                  {{ role.enabledCount }}/{{ role.total }} permisos · {{ role.user_count || 0 }} usuario{{ role.user_count === 1 ? '' : 's' }}
                </p>
              </div>
            </div>
            <button type="button" class="icon-btn-ghost" (click)="closeDrawer()" aria-label="Cerrar"><i class="pi pi-times"></i></button>
          </div>

          <!-- Body: desglose por módulo -->
          <div class="flex-1 overflow-y-auto p-4 space-y-4">
            @for (group of breakdown(); track group.name) {
              <div>
                <div class="flex items-center justify-between mb-2">
                  <span class="font-black text-[10px] uppercase text-brand tracking-widest">{{ group.name }}</span>
                  <span class="text-[10px] font-mono text-content-faint">{{ group.enabled }}/{{ group.total }}</span>
                </div>
                <div class="space-y-1">
                  @for (item of group.items; track item.key) {
                    <div class="flex items-center gap-2 text-sm" [class.opacity-40]="!item.enabled">
                      <i class="pi text-xs" [class.pi-check-circle]="item.enabled" [class.text-ok-fg]="item.enabled" [class.pi-circle]="!item.enabled" [class.text-content-faint]="!item.enabled"></i>
                      <span [class.text-content-main]="item.enabled" [class.text-content-muted]="!item.enabled" [pTooltip]="item.description" tooltipPosition="left">{{ item.label }}</span>
                    </div>
                  }
                </div>
              </div>
            }
          </div>

          <!-- Footer drawer -->
          <div class="p-4 border-t border-divider flex items-center justify-between gap-2">
            @if (role.updated_at) {
              <span class="text-[11px] text-content-faint flex items-center gap-1">
                <i class="pi pi-history"></i>{{ role.updated_at | date: 'shortDate' }}
              </span>
            } @else {
              <span></span>
            }
            <button
              type="button"
              class="btn-ghost btn-ghost-brand text-sm"
              (click)="editPermissions.emit(role.value); closeDrawer()"
            >
              <i class="pi pi-sliders-h"></i> Editar permisos
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
      @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
      @keyframes slideInRight { from { transform: translateX(100%); } to { transform: translateX(0); } }
    `,
  ],
})
export class AdminRolesGridComponent {
  roles = input<RoleInput[]>([]);
  canManage = input<boolean>(false);

  editPermissions = output<string>();
  renameRole = output<RoleInput>();
  deleteRole = output<RoleInput>();

  private selectedId = signal<string | null>(null);

  readonly cards = computed<RoleCard[]>(() =>
    this.roles().map((r) => this.summarize(r)),
  );

  readonly selected = computed<RoleCard | null>(() => {
    const id = this.selectedId();
    return id ? this.cards().find((c) => c.id === id) ?? null : null;
  });

  readonly breakdown = computed<BreakdownGroup[]>(() => {
    const role = this.selected();
    if (!role) return [];
    const perms = role.permissions || {};
    const groups = new Map<string, BreakdownItem[]>();
    for (const [key, meta] of Object.entries(PERMISSION_META)) {
      const list = groups.get(meta.category) ?? [];
      list.push({
        key,
        label: meta.label,
        description: meta.description,
        enabled: perms[key] === true,
      });
      groups.set(meta.category, list);
    }
    return PERMISSION_CATEGORY_ORDER.filter((c) => groups.has(c)).map((c) => {
      const items = groups.get(c)!;
      return {
        name: c,
        items,
        enabled: items.filter((i) => i.enabled).length,
        total: items.length,
      };
    });
  });

  openDrawer(card: RoleCard): void {
    this.selectedId.set(card.id);
  }

  closeDrawer(): void {
    this.selectedId.set(null);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.selectedId()) this.closeDrawer();
  }

  private summarize(role: RoleInput): RoleCard {
    const perms = role.permissions || {};
    const moduleMap = new Map<string, ModuleCoverage>();
    let enabledCount = 0;

    for (const [key, meta] of Object.entries(PERMISSION_META)) {
      const m = moduleMap.get(meta.category) ?? {
        name: meta.category,
        enabled: 0,
        total: 0,
      };
      m.total++;
      if (perms[key] === true) {
        enabledCount++;
        m.enabled++;
      }
      moduleMap.set(meta.category, m);
    }

    const modules = PERMISSION_CATEGORY_ORDER.map((c) => moduleMap.get(c)).filter(
      (m): m is ModuleCoverage => !!m && m.enabled > 0,
    );

    const total = TOTAL_PERMISSIONS;
    const isPlatformAdmin = PLATFORM_ADMIN_ROLES.includes(
      (role.value || '').toLowerCase(),
    );
    return {
      ...role,
      enabledCount: isPlatformAdmin ? total : enabledCount,
      total,
      pct: isPlatformAdmin
        ? 100
        : total
          ? Math.round((enabledCount / total) * 100)
          : 0,
      fullAccess: isPlatformAdmin,
      modules,
      shownModules: modules.slice(0, MAX_CHIPS),
      extraModules: Math.max(0, modules.length - MAX_CHIPS),
    };
  }
}
