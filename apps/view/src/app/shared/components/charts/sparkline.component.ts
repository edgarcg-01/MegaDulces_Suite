import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

let _spkSeq = 0;

const MXN = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
const NUM = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 });

/**
 * Sparkline SVG inline — línea + área degradada, draw-in animado + **hover interactivo**
 * (Design Spell: gráficas que muestran el valor del punto). Al pasar el cursor marca el
 * punto más cercano y muestra un tooltip con el valor (formato configurable).
 * 0 KB extra (sin chart lib), tokenizable.
 */
@Component({
  selector: 'app-sparkline',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="spk-wrap" #wrap
         (pointermove)="onMove($event, wrap)" (pointerleave)="active.set(-1)">
      <svg class="spk" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient [attr.id]="gid" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" [attr.stop-color]="color()" stop-opacity="0.22" />
            <stop offset="100%" [attr.stop-color]="color()" stop-opacity="0" />
          </linearGradient>
        </defs>
        <path *ngIf="area() && areaPath()" [attr.d]="areaPath()" [attr.fill]="'url(#' + gid + ')'" stroke="none"></path>
        <path
          class="spk-line"
          [attr.d]="linePath()"
          [attr.stroke]="color()"
          fill="none" stroke-width="2" vector-effect="non-scaling-stroke"
          pathLength="100" stroke-linecap="round" stroke-linejoin="round"
        ></path>
        <line *ngIf="activePt() as p" class="spk-guide" [attr.x1]="p.x" [attr.x2]="p.x" y1="0" y2="40" vector-effect="non-scaling-stroke"></line>
        <circle *ngIf="activePt() as p" class="spk-dot" [attr.cx]="p.x" [attr.cy]="p.y" r="3"
                [attr.fill]="color()" vector-effect="non-scaling-stroke"></circle>
      </svg>
      <div *ngIf="activePt() as p" class="spk-tip" [style.left.%]="p.x" [style.top.%]="(p.y / 40) * 100">
        {{ activeLabel() }}
      </div>
    </div>
  `,
  styles: [`
    :host { display:block; width:100%; }
    .spk-wrap { position:relative; width:100%; height: var(--spk-h, 40px); }
    .spk { display:block; width:100%; height:100%; overflow:visible; }
    .spk-line { stroke-dasharray:100; animation: spkDraw .8s var(--ease-out, cubic-bezier(.23,1,.32,1)) both; }
    @keyframes spkDraw { from { stroke-dashoffset:100; } to { stroke-dashoffset:0; } }
    .spk-guide { stroke: var(--c-divider, var(--border-color)); stroke-width:1; }
    .spk-dot { stroke: var(--card-bg, #fff); stroke-width:2; }
    .spk-tip {
      position:absolute; transform: translate(-50%, -130%); transform-origin:center bottom;
      background: var(--c-text-1, var(--text-main)); color: var(--card-bg, #fff);
      font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: .6875rem; font-weight: 700; padding: .1rem .4rem; border-radius: 6px;
      white-space:nowrap; pointer-events:none; z-index:2; box-shadow: 0 2px 8px rgba(0,0,0,.18);
    }
    @media (prefers-reduced-motion: reduce) { .spk-line { animation:none; } }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SparklineComponent {
  readonly data = input<number[]>([]);
  readonly color = input<string>('var(--action)');
  readonly area = input<boolean>(true);
  /** Formato del tooltip del punto activo. */
  readonly format = input<'currency' | 'number' | 'plain'>('number');
  /** Etiquetas opcionales por punto (ej. fechas) — se anteponen al valor en el tooltip. */
  readonly labels = input<string[]>([]);

  readonly gid = `spk-grad-${_spkSeq++}`;
  readonly active = signal<number>(-1);

  private readonly points = computed<{ x: number; y: number }[]>(() => {
    const d = this.data() || [];
    if (d.length === 0) return [];
    if (d.length === 1) return [{ x: 0, y: 20 }, { x: 100, y: 20 }];
    const min = Math.min(...d);
    const max = Math.max(...d);
    const span = max - min || 1;
    const n = d.length - 1;
    return d.map((v, i) => ({ x: (i / n) * 100, y: 39 - ((v - min) / span) * 38 }));
  });

  readonly linePath = computed(() => {
    const p = this.points();
    if (!p.length) return '';
    return p.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(2)},${pt.y.toFixed(2)}`).join(' ');
  });
  readonly areaPath = computed(() => {
    const p = this.points();
    if (!p.length) return '';
    const line = p.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(2)},${pt.y.toFixed(2)}`).join(' ');
    return `${line} L100,40 L0,40 Z`;
  });

  readonly activePt = computed(() => {
    const i = this.active();
    const p = this.points();
    if (i < 0 || i >= p.length) return null;
    return p[i];
  });
  readonly activeLabel = computed(() => {
    const i = this.active();
    const d = this.data() || [];
    if (i < 0 || i >= d.length) return '';
    const v = d[i];
    const val = this.format() === 'currency' ? MXN.format(v) : NUM.format(v);
    const lab = this.labels()[i];
    return lab ? `${lab} · ${val}` : val;
  });

  onMove(ev: PointerEvent, wrap: HTMLElement): void {
    const n = (this.data() || []).length;
    if (n < 2) return;
    const rect = wrap.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    this.active.set(Math.round(ratio * (n - 1)));
  }
}
