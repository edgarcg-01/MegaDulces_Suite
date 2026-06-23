import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

const NUM = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 });

/**
 * Mini bar-chart (columnas) para tarjetas KPI. CSS puro, animación scaleY escalonada
 * + **hover interactivo** (resalta la barra y muestra su valor). `highlightLast` pinta
 * la última barra (ej. "hoy") con `highlightColor`.
 */
@Component({
  selector: 'app-mini-bars',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="mb" (pointerleave)="active.set(-1)">
      <span
        class="mb-bar"
        *ngFor="let b of bars(); let i = index"
        [class.is-active]="active() === i"
        [style.height.%]="b"
        [style.background]="(highlightLast() && i === bars().length - 1) ? highlightColor() : color()"
        [style.animation-delay.ms]="i * 45"
        (pointerenter)="active.set(i)"
      ></span>
      <div *ngIf="active() >= 0" class="mb-tip" [style.left.%]="tipLeft()">{{ activeLabel() }}</div>
    </div>
  `,
  styles: [`
    :host { display:block; width:100%; }
    .mb { position:relative; display:flex; align-items:flex-end; gap: 3px; height: var(--mb-h, 40px); }
    .mb-bar {
      flex:1; min-width:3px; border-radius: 3px 3px 0 0;
      transform-origin: bottom; transform: scaleY(0);
      animation: mbGrow .5s var(--ease-out, cubic-bezier(.23,1,.32,1)) both;
      transition: filter .12s ease, opacity .12s ease;
    }
    .mb:hover .mb-bar:not(.is-active) { opacity:.5; }
    .mb-bar.is-active { filter: brightness(1.05); }
    @keyframes mbGrow { to { transform: scaleY(1); } }
    .mb-tip {
      position:absolute; top:-4px; transform: translate(-50%, -100%);
      background: var(--c-text-1, var(--text-main)); color: var(--card-bg, #fff);
      font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: .6875rem; font-weight:700; padding: .1rem .4rem; border-radius:6px;
      white-space:nowrap; pointer-events:none; z-index:2; box-shadow:0 2px 8px rgba(0,0,0,.18);
    }
    @media (prefers-reduced-motion: reduce) { .mb-bar { animation:none; transform: scaleY(1); } }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MiniBarsComponent {
  readonly data = input<number[]>([]);
  readonly color = input<string>('color-mix(in srgb, var(--action) 35%, transparent)');
  readonly highlightColor = input<string>('var(--action)');
  readonly highlightLast = input<boolean>(true);
  readonly labels = input<string[]>([]);

  readonly active = signal<number>(-1);

  readonly bars = computed<number[]>(() => {
    const d = this.data() || [];
    if (!d.length) return [];
    const max = Math.max(...d) || 1;
    return d.map((v) => Math.max(6, Math.round((v / max) * 100)));
  });

  readonly tipLeft = computed(() => {
    const n = this.bars().length;
    const i = this.active();
    if (n <= 0 || i < 0) return 0;
    return ((i + 0.5) / n) * 100;
  });
  readonly activeLabel = computed(() => {
    const i = this.active();
    const d = this.data() || [];
    if (i < 0 || i >= d.length) return '';
    const lab = this.labels()[i];
    return lab ? `${lab} · ${NUM.format(d[i])}` : NUM.format(d[i]);
  });
}
