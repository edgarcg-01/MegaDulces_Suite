import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ButtonModule } from 'primeng/button';

/**
 * `[PQ.3.20]` Dónde viven los manuales de capacitación: un HTML por pantalla en `apps/view/src/assets/manuales/`,
 * versionado con el código y servido con la app (nginx lo da con `no-cache`, la CSP ya admite su script en línea y
 * sus fuentes, y el service worker no lo intercepta porque lleva extensión).
 *
 * Se abre en OTRA pestaña y no en un marco: la Suite no se deja enmarcar ni a sí misma (`X-Frame-Options: DENY` y
 * `frame-ancestors 'none'` en `nginx.conf`, decisión abierta `[AU.33]`), y otra pestaña además conserva la pantalla
 * de trabajo donde estaba.
 */
export const CARPETA_MANUALES = 'assets/manuales';

/** La dirección del manual `slug`, relativa a `<base href="/">`. */
export function direccionDelManual(slug: string): string {
  return `${CARPETA_MANUALES}/${slug}.html`;
}

/**
 * El botón «Manual» del encabezado de una pantalla. Terciario a propósito: no compite con la respuesta ni con la
 * acción principal. El nombre accesible dice qué manual es y que se abre en otra pestaña.
 */
@Component({
  selector: 'app-manual-link',
  standalone: true,
  imports: [ButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a pButton class="p-button-sm p-button-text p-button-secondary ml-a" [href]="href()" target="_blank" rel="noopener"
       [attr.aria-label]="'Abrir el manual «' + titulo() + '» en otra pestaña'">
      <i class="pi pi-book" aria-hidden="true"></i><span class="p-button-label">Manual</span>
    </a>
  `,
  styles: [`
    :host { display: inline-flex; }
    .ml-a { gap: var(--sp-2); }
    @media (pointer: coarse) { .ml-a { min-height: var(--tap-min, 44px); } }
  `],
})
export class ManualLinkComponent {
  /** El nombre del archivo, sin extensión: `calendario-compras` → `assets/manuales/calendario-compras.html`. */
  readonly manual = input.required<string>();
  /** El nombre de la pantalla, para el nombre accesible: «Calendario de compras». */
  readonly titulo = input.required<string>();
  readonly href = computed(() => direccionDelManual(this.manual()));
}
