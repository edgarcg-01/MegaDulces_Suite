import { ChangeDetectionStrategy, Component, computed, input, signal, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CountUpDirective } from '../../directives/count-up.directive';
import { SparklineComponent } from '../charts/sparkline.component';
import { RingGaugeComponent } from '../charts/ring-gauge.component';

export type MetricStripMode = 'strip' | 'spark' | 'ring' | 'bullet' | 'composition';
export type MetricTone = 'default' | 'ok' | 'warn' | 'bad' | 'brand';
export type MetricFormat = 'number' | 'decimal1' | 'currency' | 'currency-short' | 'percent' | 'text';

export interface MetricStripItem {
  label: string;
  value: number | string;
  format?: MetricFormat;
  tone?: MetricTone;
  sub?: string;
  /** delta % vs periodo anterior → ▲/▼ + número (flecha, no solo color). */
  delta?: number | null;
  /** punto pulsante "en vivo" junto a la etiqueta. */
  live?: boolean;
  /** serie para el modo spark (nº con sparkline de fondo) y ring/bullet no la usan. */
  series?: number[];
  /** 0..100 para ring / bullet (progreso). Si falta en composition, se usa `value`. */
  pct?: number;
  /** 0..100 marca de objetivo para bullet. */
  target?: number;
}

/**
 * MetricStrip — KPIs SIN caja (patrón "KPI Strip" de Operations, quiet-luxury).
 * Reemplaza las cajitas `.kpi`/`rk-card` ad-hoc: nada de bg/borde/radio por métrica,
 * separación por hairline. Cifras en Geist Mono tabular con count-up on-view (una vez),
 * color por token (flipa en dark), delta multimodal, `prefers-reduced-motion` respetado.
 *
 * Modos (por forma del dato):
 *  - strip        valor único en fila (default) — el 80% de los casos.
 *  - spark        número con sparkline de fondo (serie temporal).
 *  - ring         anillo de progreso por métrica (ratio/%).
 *  - bullet       barra medida vs meta.
 *  - composition  una sola barra segmentada (partes que suman a un total) + leyenda.
 */
@Component({
  selector: 'app-metric-strip',
  standalone: true,
  imports: [CommonModule, CountUpDirective, SparklineComponent, RingGaugeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ms" [class]="'ms--' + mode()" role="group" [attr.aria-label]="ariaLabel() || null">
      @if (mode() === 'composition') {
        <div class="ms-band">
          <div class="ms-bar" role="img" [attr.aria-label]="ariaLabel() || null">
            @for (it of items(); track it.label) {
              <span class="ms-seg" [class]="'tone-' + (it.tone || 'brand')"
                    [style.width.%]="mounted() ? segPct(it) : 0" [attr.title]="it.label"></span>
            }
          </div>
          <div class="ms-leg">
            @for (it of items(); track it.label) {
              <span><i [class]="'tone-' + (it.tone || 'brand')"></i>{{ it.label }}
                <b [appCountUp]="num(it)" [countUpFormat]="cu(it)"></b></span>
            }
          </div>
        </div>
      } @else {
        @for (it of items(); track it.label) {
          <div class="ms-item" [class]="'tone-' + (it.tone || 'default')">
            <span class="ms-l">{{ it.label }}<span class="ms-live" *ngIf="it.live" title="En vivo" aria-hidden="true"></span></span>

            @if (mode() === 'ring') {
              <div class="ms-ring-row">
                <app-ring-gauge [value]="it.pct ?? num(it)" [max]="100" [size]="46" [color]="toneColor(it)"></app-ring-gauge>
                <b class="ms-v" [appCountUp]="num(it)" [countUpFormat]="cu(it)"></b>
              </div>
            } @else {
              <div class="ms-row">
                @if (it.format === 'text') { <b class="ms-v is-text">{{ it.value }}</b> }
                @else { <b class="ms-v" [appCountUp]="num(it)" [countUpFormat]="cu(it)"></b> }
                @if (it.delta !== null && it.delta !== undefined) {
                  <span class="ms-delta" [class.up]="it.delta! > 0" [class.down]="it.delta! < 0">
                    {{ it.delta! > 0 ? '▲' : it.delta! < 0 ? '▼' : '' }} {{ absDelta(it.delta!) }}%
                  </span>
                }
              </div>
            }

            @if (mode() === 'bullet') {
              <div class="ms-bullet">
                <span class="ms-bfill" [class]="'tone-' + (it.tone || 'brand')" [style.width.%]="mounted() ? (it.pct ?? 0) : 0"></span>
                @if (it.target != null) { <span class="ms-btarget" [style.left.%]="it.target"></span> }
              </div>
            }
            @if (mode() === 'spark' && (it.series?.length ?? 0) > 1) {
              <app-sparkline class="ms-spark" [data]="it.series!" [area]="true" [color]="toneColor(it)"></app-sparkline>
            }

            <span class="ms-sub" *ngIf="it.sub">{{ it.sub }}</span>
          </div>
        }
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    /* ── fila de métricas sin caja ── */
    .ms { display:flex; flex-wrap:wrap; }
    .ms-item { display:flex; flex-direction:column; justify-content:center; gap:.2rem; padding:.15rem 1.4rem; position:relative; }
    .ms-item:first-child { padding-left:.15rem; }
    .ms-item:not(:first-child)::before { content:''; position:absolute; left:0; top:.3rem; bottom:.3rem; width:1px; background:var(--border-color); }
    .ms-l { display:flex; align-items:center; gap:.4rem; font-size:.68rem; font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:.05em; }
    .ms-row { display:flex; align-items:baseline; gap:.5rem; }
    .ms-v { font-family:var(--font-mono); font-size:1.55rem; font-weight:600; line-height:1.1; font-variant-numeric:tabular-nums; color:var(--text-main); }
    /* valores de texto (nombres/fechas): no mono, más chico, para que no griten. */
    .ms-v.is-text { font-family:var(--font-body,inherit); font-size:1.05rem; font-weight:700; letter-spacing:-.01em; }
    .ms-item.tone-ok .ms-v { color:var(--ok-fg); }
    .ms-item.tone-warn .ms-v { color:var(--warn-fg); }
    .ms-item.tone-bad .ms-v { color:var(--bad-fg); }
    .ms-item.tone-brand .ms-v { color:var(--action); }
    .ms-sub { font-size:.7rem; color:var(--text-faint); font-variant-numeric:tabular-nums; }
    /* delta multimodal */
    .ms-delta { font-family:var(--font-mono); font-size:.72rem; font-weight:600; color:var(--text-faint); }
    .ms-delta.up { color:var(--ok-fg); } .ms-delta.down { color:var(--bad-fg); }
    /* live */
    .ms-live { width:6px; height:6px; border-radius:50%; background:var(--warn-fg); position:relative; }
    .ms-live::after { content:''; position:absolute; inset:0; border-radius:50%; background:var(--warn-fg); animation:ms-pulse 1.8s ease-out infinite; }
    @keyframes ms-pulse { 0%{transform:scale(1);opacity:.6;} 100%{transform:scale(3);opacity:0;} }
    /* ring */
    .ms-ring-row { display:flex; align-items:center; gap:.6rem; }
    /* spark */
    .ms-spark { display:block; margin-top:.35rem; --spk-h:34px; }
    /* bullet */
    .ms-bullet { position:relative; height:8px; margin-top:.5rem; background:var(--track,color-mix(in srgb,var(--border-color) 60%,transparent)); border-radius:999px; }
    .ms-bfill { position:absolute; inset:0 auto 0 0; height:100%; border-radius:999px; background:var(--action); transition:width 900ms var(--ease-standard,cubic-bezier(.2,0,0,1)); }
    .ms-bfill.tone-ok { background:var(--ok-fg); } .ms-bfill.tone-warn { background:var(--warn-fg); } .ms-bfill.tone-bad { background:var(--bad-fg); }
    .ms-btarget { position:absolute; top:-3px; bottom:-3px; width:2px; background:var(--text-main); border-radius:2px; }
    /* ── composición: una barra segmentada + leyenda ── */
    .ms-band { width:100%; }
    .ms-bar { display:flex; height:14px; border-radius:999px; overflow:hidden; background:var(--track,color-mix(in srgb,var(--border-color) 60%,transparent)); }
    .ms-seg { transition:width 900ms var(--ease-standard,cubic-bezier(.2,0,0,1)); }
    .ms-seg.tone-ok { background:var(--ok-fg); } .ms-seg.tone-warn { background:var(--warn-fg); } .ms-seg.tone-bad { background:var(--bad-fg); } .ms-seg.tone-brand { background:var(--action); } .ms-seg.tone-default { background:var(--text-faint); }
    .ms-leg { display:flex; flex-wrap:wrap; gap:1.3rem; margin-top:.85rem; }
    .ms-leg span { display:inline-flex; align-items:center; gap:.4rem; font-size:.8rem; color:var(--text-muted); }
    .ms-leg i { width:9px; height:9px; border-radius:3px; }
    .ms-leg i.tone-ok { background:var(--ok-fg); } .ms-leg i.tone-warn { background:var(--warn-fg); } .ms-leg i.tone-bad { background:var(--bad-fg); } .ms-leg i.tone-brand { background:var(--action); } .ms-leg i.tone-default { background:var(--text-faint); }
    .ms-leg b { font-family:var(--font-mono); font-weight:600; color:var(--text-main); font-variant-numeric:tabular-nums; }
    /* móvil: grid 2 columnas con un divisor central por fila */
    @media (max-width:560px) {
      .ms:not(.ms--composition) { display:grid; grid-template-columns:1fr 1fr; row-gap:.85rem; }
      .ms-item { padding:.1rem 1rem; }
      .ms-item:not(:first-child)::before { display:none; }
      .ms-item:nth-child(even)::before { display:block; }
    }
    @media (prefers-reduced-motion: reduce) {
      .ms-live::after { animation:none; }
      .ms-seg, .ms-bfill { transition:none; }
    }
  `],
})
export class MetricStripComponent implements AfterViewInit {
  readonly items = input<MetricStripItem[]>([]);
  readonly mode = input<MetricStripMode>('strip');
  readonly ariaLabel = input<string>('');
  /** total para composición (default = suma de valores). */
  readonly total = input<number | null>(null);

  /** dispara la animación de anchos (barra/bullet) tras montar. */
  readonly mounted = signal(false);
  ngAfterViewInit(): void { queueMicrotask(() => this.mounted.set(true)); }

  private readonly sum = computed(() =>
    this.items().reduce((s, it) => s + (Number(it.value) || 0), 0));

  num(it: MetricStripItem): number { return Number(it.value) || 0; }

  cu(it: MetricStripItem): 'int' | 'decimal1' | 'percent1' | 'money' | 'money-short' {
    switch (it.format) {
      case 'currency': return 'money';
      case 'currency-short': return 'money-short';
      case 'percent': return 'percent1';
      case 'decimal1': return 'decimal1';
      default: return 'int';
    }
  }

  absDelta(d: number): number { return Math.abs(d); }

  segPct(it: MetricStripItem): number {
    const t = this.total() ?? this.sum();
    if (!t) return 0;
    const v = it.pct != null ? it.pct : Number(it.value) || 0;
    return Math.max(0, Math.min(100, (v / t) * 100));
  }

  toneColor(it: MetricStripItem): string {
    switch (it.tone) {
      case 'ok': return 'var(--ok-fg)';
      case 'warn': return 'var(--warn-fg)';
      case 'bad': return 'var(--bad-fg)';
      case 'brand': return 'var(--action)';
      default: return 'var(--action)';
    }
  }
}
