import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';

export interface PageTab {
  label: string;
  route: string;
  icon?: string;
  /** Si se especifica, el tab solo se muestra si el user tiene ese permiso. */
  permission?: Permission;
  /** routerLinkActiveOptions.exact (default true). */
  exact?: boolean;
}

/**
 * Tab-bar por ruta reutilizable para Operations. Cada tab es un routerLink a una
 * página hermana; el activo se resalta con underline. Filtra tabs por permiso
 * (fallback legacy del JWT, igual que el nav). Se esconde si queda 1 tab visible.
 *
 * Uso:
 *   readonly tabs: PageTab[] = [{ label: 'Existencias', route: '/comercial/inventory' }, ...];
 *   <app-page-tabs [tabs]="tabs" />
 */
@Component({
  selector: 'app-page-tabs',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visibleTabs().length > 1) {
      <nav class="ptabs" role="tablist">
        @for (t of visibleTabs(); track t.route) {
          <a
            class="ptab"
            [routerLink]="t.route"
            routerLinkActive="is-active"
            [routerLinkActiveOptions]="{ exact: t.exact ?? true }"
          >
            @if (t.icon) {
              <i [class]="t.icon" aria-hidden="true"></i>
            }
            <span>{{ t.label }}</span>
          </a>
        }
      </nav>
    }
  `,
  styles: [
    `
      .ptabs {
        display: flex;
        gap: 2px;
        border-bottom: 1px solid var(--border-color);
        margin-bottom: 1rem;
        overflow-x: auto;
        scrollbar-width: none;
      }
      .ptabs::-webkit-scrollbar {
        display: none;
      }
      .ptab {
        display: inline-flex;
        align-items: center;
        gap: 0.45rem;
        padding: 0.6rem 0.95rem;
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--text-muted);
        text-decoration: none;
        white-space: nowrap;
        border-bottom: 2px solid transparent;
        margin-bottom: -1px;
        transition: color 0.15s ease, border-color 0.15s ease;
      }
      .ptab:hover {
        color: var(--text-main);
      }
      .ptab.is-active {
        color: var(--text-main);
        border-bottom-color: var(--action);
      }
      .ptab i {
        font-size: 0.9rem;
      }
    `,
  ],
})
export class PageTabsComponent {
  private readonly auth = inject(AuthService);
  readonly tabs = input.required<PageTab[]>();
  readonly visibleTabs = computed(() =>
    this.tabs().filter(
      (t) => !t.permission || this.auth.user()?.permissions?.[t.permission] === true,
    ),
  );
}
