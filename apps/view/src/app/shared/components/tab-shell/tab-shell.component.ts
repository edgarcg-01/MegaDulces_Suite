import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterModule } from '@angular/router';

export interface ShellTab {
  label: string;
  path: string;
  icon?: string;
}

/**
 * Shell de superficie con tabs RUTEADAS: lee `data.tabs` de la ruta padre y
 * pinta una barra de tabs (routerLink) + <router-outlet>. Cada tab es una ruta
 * hija que monta su componente existente con su propia `data` (ej. fleet) —
 * consolidación sin regresión: reúne pantallas hermanas bajo una entrada sin
 * tocar la lógica de cada una. La tab activa vive en la URL (deep-link nativo).
 */
@Component({
  selector: 'app-tab-shell',
  standalone: true,
  imports: [RouterModule],
  template: `
    <div class="ts-wrap">
      <nav class="ts-tabs" role="tablist">
        @for (t of tabs(); track t.path) {
          <a role="tab" [routerLink]="[t.path]" routerLinkActive="act" #rla="routerLinkActive" [attr.aria-selected]="rla.isActive">
            @if (t.icon) { <i class="pi {{ t.icon }}" aria-hidden="true"></i>&nbsp; }{{ t.label }}
          </a>
        }
      </nav>
      <div class="ts-view"><router-outlet></router-outlet></div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [`
    :host { display:block; }
    .ts-wrap { display:flex; flex-direction:column; min-height:calc(100vh - var(--app-header-h, 56px)); }
    .ts-tabs { display:flex; gap:.25rem; padding:.5rem .75rem 0; border-bottom:1px solid var(--border-color); background:var(--card-bg,#fff); flex-wrap:wrap; }
    .ts-tabs a { padding:.55rem .9rem; border:0; border-bottom:2px solid transparent; background:transparent; font:600 .85rem 'Hanken Grotesk',sans-serif; color:var(--text-dim,#78716c); cursor:pointer; text-decoration:none; }
    .ts-tabs a:hover { color:var(--text,#1c1917); }
    .ts-tabs a.act { color:var(--action,#F05A28); border-bottom-color:var(--action,#F05A28); }
    .ts-view { flex:1; min-height:0; }
  `],
})
export class TabShellComponent {
  private readonly route = inject(ActivatedRoute);
  readonly tabs = signal<ShellTab[]>(this.route.snapshot.data['tabs'] ?? []);
}
