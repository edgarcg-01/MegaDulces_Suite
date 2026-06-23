import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * Anillo de progreso (gauge) SVG inline. Arco que crece animando `stroke-dashoffset`.
 * Reusa el lenguaje de `.rk-gauge` de styles.css pero como componente reusable.
 */
@Component({
  selector: 'app-ring-gauge',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="rg" [style.width.px]="size()" [style.height.px]="size()" [style.--rg-size.px]="size()">
      <svg viewBox="0 0 48 48" class="rg-svg" aria-hidden="true">
        <circle class="rg-track" cx="24" cy="24" r="20" fill="none" stroke-width="5"></circle>
        <circle
          class="rg-arc" cx="24" cy="24" r="20" fill="none" stroke-width="5"
          [attr.stroke]="color()" stroke-linecap="round"
          [attr.stroke-dasharray]="circ"
          [style.stroke-dashoffset]="offset()"
          transform="rotate(-90 24 24)"
        ></circle>
      </svg>
      <span class="rg-pct">{{ display() }}<small *ngIf="showSymbol()">%</small></span>
    </div>
  `,
  styles: [`
    :host { display:inline-block; }
    .rg { position:relative; }
    .rg-svg { width:100%; height:100%; display:block; }
    .rg-track { stroke: var(--c-divider, var(--border-color)); }
    .rg-arc { transition: stroke-dashoffset .7s var(--ease-out, cubic-bezier(.23,1,.32,1)); }
    .rg-pct {
      position:absolute; inset:0; display:grid; place-items:center;
      font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-weight: var(--fw-bold, 700); color: var(--c-text-1, var(--text-main));
      font-size: calc(var(--rg-size, 64px) * 0.26);
    }
    .rg-pct small { font-size: .7em; opacity:.7; }
    @media (prefers-reduced-motion: reduce) { .rg-arc { transition:none; } }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RingGaugeComponent {
  readonly value = input<number>(0);
  readonly max = input<number>(100);
  readonly size = input<number>(64);
  readonly color = input<string>('var(--action)');
  readonly showSymbol = input<boolean>(true);

  readonly circ = 2 * Math.PI * 20; // r=20

  readonly pct = computed(() => {
    const m = this.max() || 1;
    return Math.max(0, Math.min(100, (this.value() / m) * 100));
  });
  readonly offset = computed(() => this.circ * (1 - this.pct() / 100));
  readonly display = computed(() => Math.round(this.pct()));
}
