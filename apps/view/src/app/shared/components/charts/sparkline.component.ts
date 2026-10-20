import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';


let _spkSeq = 0;

const MXN = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
const NUM = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 });

/**
 * `[CGA-A.47]` El trazo, puro, para poder probarlo. **Aditivo:** sin `null` en los datos produce
 * EXACTAMENTE la línea y el área de antes (lo prueba `sparkline.component.spec.ts`). Con `null` —un
 * día que no se midió— la línea se CORTA ahí en vez de inventar un valor: dibujarlo como 0 afirmaría
 * que no hubo, que es lo contrario de «no se sabe» (ADR-056).
 */
export interface TrazoSparkline {
  puntos: ({ x: number; y: number } | null)[];
  linea: string;
  area: string;
  /** x de cada punto sin dato, para marcar el hueco. */
  huecos: number[];
}
export function trazoSparkline(d: readonly (number | null)[]): TrazoSparkline {
  if (!d.length) return { puntos: [], linea: '', area: '', huecos: [] };
  const vals = d.filter((v): v is number => v != null);
  const xDe = (i: number) => (d.length === 1 ? 0 : (i / (d.length - 1)) * 100);
  if (!vals.length) return { puntos: d.map(() => null), linea: '', area: '', huecos: d.map((_, i) => xDe(i)) };
  if (d.length === 1) {
    const linea = 'M0.00,20.00 L100.00,20.00';
    return { puntos: [{ x: 0, y: 20 }, { x: 100, y: 20 }], linea, area: `${linea} L100,40 L0,40 Z`, huecos: [] };
  }
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const n = d.length - 1;
  const puntos = d.map((v, i) => (v == null ? null : { x: (i / n) * 100, y: 39 - ((v - min) / span) * 38 }));
  const huecos = d.map((v, i) => (v == null ? xDe(i) : -1)).filter((x) => x >= 0);
  // Tramos continuos: cada `null` levanta el lápiz.
  const tramos: { x: number; y: number }[][] = [];
  let actual: { x: number; y: number }[] = [];
  for (const p of puntos) {
    if (p) actual.push(p);
    else if (actual.length) { tramos.push(actual); actual = []; }
  }
  if (actual.length) tramos.push(actual);
  const trazo = (t: { x: number; y: number }[]) =>
    t.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(2)},${pt.y.toFixed(2)}`).join(' ');
  const linea = tramos.map(trazo).join(' ');
  // Sin huecos, el área es la de siempre; con huecos, una por tramo (no se rellena lo que no se midió).
  const area = !huecos.length
    ? `${linea} L100,40 L0,40 Z`
    : tramos.filter((t) => t.length > 1)
        .map((t) => `${trazo(t)} L${t[t.length - 1].x.toFixed(2)},40 L${t[0].x.toFixed(2)},40 Z`).join(' ');
  return { puntos, linea, area, huecos };
}

/**
 * Sparkline SVG inline — línea + área degradada, draw-in animado + **hover interactivo**
 * (Design Spell: gráficas que muestran el valor del punto). Al pasar el cursor marca el
 * punto más cercano y muestra un tooltip con el valor (formato configurable).
 * 0 KB extra (sin chart lib), tokenizable.
 */
@Component({
  selector: 'app-sparkline',
  standalone: true,
  imports: [],
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
        @if (area() && areaPath()) {
          <path [attr.d]="areaPath()" [attr.fill]="'url(#' + gid + ')'" stroke="none"></path>
        }
        <path
          class="spk-line"
          [attr.d]="linePath()"
          [attr.stroke]="color()"
          fill="none" stroke-width="2" vector-effect="non-scaling-stroke"
          pathLength="100" stroke-linecap="round" stroke-linejoin="round"
        ></path>
        @for (x of trazo().huecos; track x) {
          <line class="spk-hueco" [attr.x1]="x" [attr.x2]="x" y1="34" y2="40" vector-effect="non-scaling-stroke"></line>
        }
        @if (activePt(); as p) {
          <line class="spk-guide" [attr.x1]="p.x" [attr.x2]="p.x" y1="0" y2="40" vector-effect="non-scaling-stroke"></line>
        }
        @if (activePt(); as p) {
          <circle class="spk-dot" [attr.cx]="p.x" [attr.cy]="p.y" r="3"
          [attr.fill]="color()" vector-effect="non-scaling-stroke"></circle>
        }
      </svg>
      @if (activePt(); as p) {
        <div class="spk-tip" [style.left.%]="p.x" [style.top.%]="(p.y / 40) * 100">
          {{ activeLabel() }}
        </div>
      }
    </div>
    `,
  styles: [`
    :host { display:block; width:100%; }
    .spk-wrap { position:relative; width:100%; height: var(--spk-h, 40px); }
    .spk { display:block; width:100%; height:100%; overflow:visible; }
    .spk-line { stroke-dasharray:100; animation: spkDraw var(--dur-max, 350ms) var(--ease-out, cubic-bezier(.23,1,.32,1)) both; }
    @keyframes spkDraw { from { stroke-dashoffset:100; } to { stroke-dashoffset:0; } }
    .spk-guide { stroke: var(--c-divider, var(--border-color)); stroke-width:1; }
    .spk-dot { stroke: var(--card-bg, #fff); stroke-width:2; }
    /* Un día sin dato: una marca corta abajo, nunca un punto en cero. */
    .spk-hueco { stroke: var(--text-faint); stroke-width:1.5; stroke-dasharray:2 2; }
    .spk-tip {
      position:absolute; transform: translate(-50%, -130%); transform-origin:center bottom;
      background: var(--c-text-1, var(--text-main)); color: var(--card-bg, #fff);
      font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-micro); font-weight: 700; padding: .1rem .4rem; border-radius: 6px;
      white-space:nowrap; pointer-events:none; z-index:2; box-shadow: 0 2px 8px rgba(0,0,0,.18);
    }
    @media (prefers-reduced-motion: reduce) { .spk-line { animation:none; } }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SparklineComponent {
  /** `null` = ese punto no se midió: la línea se corta y se marca el hueco (aditivo). */
  readonly data = input<readonly (number | null)[]>([]);
  readonly color = input<string>('var(--action)');
  readonly area = input<boolean>(true);
  /** Formato del tooltip del punto activo. */
  readonly format = input<'currency' | 'number' | 'plain'>('number');
  /** Etiquetas opcionales por punto (ej. fechas) — se anteponen al valor en el tooltip. */
  readonly labels = input<string[]>([]);

  readonly gid = `spk-grad-${_spkSeq++}`;
  readonly active = signal<number>(-1);

  readonly trazo = computed(() => trazoSparkline(this.data() || []));
  readonly linePath = computed(() => this.trazo().linea);
  readonly areaPath = computed(() => this.trazo().area);

  readonly activePt = computed(() => {
    const i = this.active();
    const p = this.trazo().puntos;
    if (i < 0 || i >= p.length) return null;
    // Un punto sin dato se señala en la base, con su leyenda «sin dato»: no se inventa altura.
    return p[i] ?? { x: p.length > 1 ? (i / (p.length - 1)) * 100 : 0, y: 39 };
  });
  readonly activeLabel = computed(() => {
    const i = this.active();
    const d = this.data() || [];
    if (i < 0 || i >= d.length) return '';
    const v = d[i];
    const val = v == null ? 'sin dato' : this.format() === 'currency' ? MXN.format(v) : NUM.format(v);
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
