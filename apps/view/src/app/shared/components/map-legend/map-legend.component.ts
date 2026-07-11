import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface LegendLayer {
  id: string;
  label: string;
  /** color del swatch (token o hex). */
  color?: string;
  /** conteo opcional a mostrar junto a la etiqueta. */
  count?: number;
  visible: boolean;
}

/**
 * Leyenda + toggles de capa reutilizable (MapKit). Reemplaza las leyendas/
 * contadores ad-hoc de live-map, commercial-map y logística. Conmutar una capa
 * emite `toggle`; el padre actualiza el estado de visibilidad de sus capas.
 */
@Component({
  selector: 'app-map-legend',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="legend">
      @for (l of layers(); track l.id) {
        <button
          type="button"
          class="chip"
          [class.off]="!l.visible"
          (click)="toggle.emit(l.id)"
          [attr.aria-pressed]="l.visible"
        >
          <span class="sw" [style.background]="l.color || 'var(--action, #F05A28)'"></span>
          <span class="lbl">{{ l.label }}</span>
          @if (l.count != null) { <span class="cnt">{{ l.count }}</span> }
        </button>
      }
    </div>
  `,
  styles: [`
    .legend { display:flex; align-items:center; gap:.4rem; flex-wrap:wrap; }
    .chip { display:inline-flex; align-items:center; gap:.4rem; padding:.25rem .6rem; border:1px solid var(--border-color); border-radius:999px; background:var(--card-bg,#fff); cursor:pointer; font:600 .74rem 'Hanken Grotesk',sans-serif; color:var(--text,#1c1917); }
    .chip.off { opacity:.45; }
    .chip:hover { border-color:var(--action,#F05A28); }
    .sw { width:10px; height:10px; border-radius:3px; flex:0 0 auto; }
    .cnt { font-variant-numeric:tabular-nums; color:var(--text-dim,#78716c); }
  `],
})
export class MapLegendComponent {
  readonly layers = input<LegendLayer[]>([]);
  readonly toggle = output<string>();
}
