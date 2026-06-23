import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { SparklineComponent } from '../charts/sparkline.component';
import { RingGaugeComponent } from '../charts/ring-gauge.component';
import { MiniBarsComponent } from '../charts/mini-bars.component';

export type MetricVariant = 'plain' | 'sparkline' | 'gauge' | 'bars' | 'progress' | 'ember';
export type MetricFormat = 'currency' | 'number' | 'percent' | 'plain' | 'text';
export type MetricTone = 'default' | 'ok' | 'warn' | 'bad' | 'brand' | 'ember';
export type DeltaDir = 'up' | 'down' | 'flat' | 'auto';

const MXN = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * MetricCard — tarjeta KPI rica con micro-gráfica + count-up animado.
 * Reemplaza a `metric-tile`. Variantes: plain · sparkline · gauge · bars · progress · ember.
 * Degrada a `plain` si la variante necesita `series`/`goal` y no hay datos.
 * Count-up del valor (easeOutCubic ~700ms) respetando `prefers-reduced-motion`.
 */
@Component({
  selector: 'app-metric-card',
  standalone: true,
  imports: [CommonModule, SparklineComponent, RingGaugeComponent, MiniBarsComponent],
  template: `
    <article #card class="mc" [class]="'tone-' + tone()" [class.is-ember]="effVariant() === 'ember'" [class.is-interactive]="interactive()" [class.is-large]="large()" [class.has-accent]="!!accent()" [style.--mc-accent]="accentGraph()" (pointermove)="spot($event, card)">
      <header class="mc-head">
        <span class="mc-label">{{ label() }}</span>
        <span class="mc-delta" *ngIf="delta() !== null && delta() !== undefined" [class]="'is-' + dir()">
          <i class="pi" [class.pi-arrow-up-right]="dir()==='up'" [class.pi-arrow-down-right]="dir()==='down'" [class.pi-minus]="dir()==='flat'" aria-hidden="true"></i>
          {{ deltaText() }}
        </span>
      </header>

      <!-- GAUGE: anillo + valor/sub al lado -->
      <ng-container *ngIf="effVariant() === 'gauge'; else stdValue">
        <div class="mc-gauge-row">
          <app-ring-gauge [value]="value()" [max]="gaugeMax()" [size]="68" [color]="accentGraph()"></app-ring-gauge>
          <div class="mc-gauge-meta">
            <span class="mc-sub" *ngIf="sub()">{{ sub() }}</span>
          </div>
        </div>
      </ng-container>

      <ng-template #stdValue>
        <div class="mc-value">{{ displayValue() }}</div>

        <!-- SPARKLINE / EMBER -->
        <app-sparkline
          *ngIf="(effVariant() === 'sparkline' || effVariant() === 'ember')"
          [data]="series()" [area]="true" [format]="sparkFormat()"
          [color]="effVariant() === 'ember' ? '#FFFFFF' : accentGraph()"
        ></app-sparkline>

        <!-- BARS -->
        <app-mini-bars
          *ngIf="effVariant() === 'bars'"
          [data]="series()"
          [color]="accentSoft()" [highlightColor]="accentGraph()"
        ></app-mini-bars>

        <!-- PROGRESS -->
        <div class="mc-progress" *ngIf="effVariant() === 'progress'">
          <div class="mc-progress-track"><div class="mc-progress-fill" [style.width.%]="goalPct()"></div></div>
          <span class="mc-progress-meta">{{ goalText() }} · {{ goalPct() }}%</span>
        </div>

        <span class="mc-sub" *ngIf="sub() && effVariant() !== 'progress'">{{ sub() }}</span>
      </ng-template>
    </article>
  `,
  styles: [`
    :host { display:block; min-width:0; }
    .mc {
      position:relative; display:flex; flex-direction:column; gap:.4rem;
      background: var(--card-bg); border:1px solid var(--border-color);
      border-radius: 12px; padding: 1rem 1.125rem; min-height: 132px; overflow:hidden;
      transition: border-color 150ms var(--ease-standard), box-shadow 200ms var(--ease-standard), transform 180ms var(--ease-standard);
    }
    .mc::before {
      content:''; position:absolute; left:0; top:0; bottom:0; width:3px; background: var(--neutral-300, var(--border-color)); z-index:1;
    }
    /* Spotlight que sigue el cursor (Design Spell: Luma). Sutil, opacity-only. */
    .mc::after {
      content:''; position:absolute; inset:0; pointer-events:none; opacity:0; transition: opacity .2s var(--ease-standard);
      background: radial-gradient(180px circle at var(--mx, 50%) var(--my, 50%),
                  color-mix(in srgb, var(--mc-accent, var(--action)) 13%, transparent), transparent 70%);
    }
    .mc:hover::after { opacity:1; }
    .mc.is-ember::after { display:none; }
    .mc > * { position: relative; z-index: 1; }
    @media (prefers-reduced-motion: reduce) { .mc::after { transition:none; } }
    .mc.tone-ok::before   { background: var(--ok-fg); }
    .mc.tone-warn::before { background: var(--warn-fg); }
    .mc.tone-bad::before  { background: var(--bad-fg); }
    .mc.tone-brand::before{ background: var(--action); }
    .mc.tone-default::before { background: var(--neutral-300, var(--border-color)); }

    /* Color por tarjeta: stripe + fondo tenue (accent gana sobre tone). */
    .mc.has-accent::before { background: var(--mc-accent); }
    .mc.has-accent { background: color-mix(in srgb, var(--mc-accent) 5%, var(--card-bg)); }
    .mc.has-accent .mc-progress-fill { background: var(--mc-accent); }

    .mc.is-interactive { cursor:pointer; }
    .mc.is-interactive:hover { border-color: var(--neutral-300); box-shadow: 0 8px 18px -10px rgba(0,0,0,.14); transform: translateY(-2px); }

    /* EMBER — superficie IA gradiente */
    .mc.is-ember { background: var(--ember-grad, linear-gradient(135deg,#F8B400,#F05A28)); border-color: transparent; color:#fff; }
    .mc.is-ember::before { display:none; }
    .mc.is-ember .mc-label, .mc.is-ember .mc-sub { color: rgba(255,255,255,.85); }
    .mc.is-ember .mc-value { color:#fff; }
    .mc.is-ember .mc-delta.is-up { color:#fff; background: rgba(255,255,255,.18); }

    .mc-head { display:flex; align-items:center; justify-content:space-between; gap:.5rem; }
    .mc-label {
      font-size: var(--fs-micro, .6875rem); font-weight: var(--fw-bold, 700); text-transform:uppercase;
      letter-spacing:.08em; color: var(--c-text-2, var(--text-muted)); line-height:1.2; white-space:nowrap;
      overflow:hidden; text-overflow:ellipsis;
    }
    .mc-delta {
      display:inline-flex; align-items:center; gap:.2rem; flex-shrink:0;
      font-size: var(--fs-micro, .6875rem); font-weight: var(--fw-bold, 700);
      font-variant-numeric: tabular-nums; padding:.1rem .4rem; border-radius:999px;
    }
    .mc-delta i { font-size: .65rem; }
    .mc-delta.is-up   { color: var(--ok-fg);  background: var(--ok-soft-bg); }
    .mc-delta.is-down { color: var(--bad-fg); background: var(--bad-soft-bg); }
    .mc-delta.is-flat { color: var(--c-text-3, var(--text-faint)); background: var(--c-surface-2, var(--neutral-100)); }

    .mc-value {
      font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: 1.875rem; font-weight: var(--fw-black, 800); letter-spacing:-.025em;
      color: var(--c-text-1, var(--text-main)); line-height:1.05;
    }
    .mc-sub { font-size: var(--fs-xs, .75rem); color: var(--c-text-2, var(--text-muted)); line-height:1.35; font-variant-numeric: tabular-nums; }

    /* Micro-gráficas: altura por defecto + override en jerarquía large */
    app-sparkline, app-mini-bars { display:block; margin-top:.5rem; --spk-h:42px; --mb-h:42px; }

    /* Jerarquía: tarjeta "hero" — número y gráfica más grandes + más aire */
    .mc.is-large { min-height: 172px; gap:.5rem; padding: 1.125rem 1.25rem; }
    .mc.is-large .mc-value { font-size: 2.625rem; }
    .mc.is-large app-sparkline { --spk-h:64px; }
    .mc.is-large app-mini-bars { --mb-h:64px; }
    .mc.is-large .mc-label { font-size: var(--fs-xs, .75rem); }

    .mc-gauge-row { display:flex; align-items:center; gap:1rem; }
    .mc-gauge-meta { display:flex; flex-direction:column; gap:.2rem; min-width:0; }

    .mc-progress { display:flex; flex-direction:column; gap:.4rem; margin-top:.5rem; }
    .mc-progress-track { height:8px; border-radius:999px; background: var(--c-surface-2, var(--neutral-100)); overflow:hidden; }
    .mc-progress-fill { height:100%; border-radius:999px; background: var(--action); transition: width .6s var(--ease-out, cubic-bezier(.23,1,.32,1)); }
    .mc-progress-meta { font-size: var(--fs-xs, .75rem); color: var(--c-text-2, var(--text-muted)); font-variant-numeric: tabular-nums; }

    @media (prefers-reduced-motion: reduce) {
      .mc, .mc-progress-fill { transition:none; }
      .mc.is-interactive:hover { transform:none; }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MetricCardComponent {
  readonly label = input<string>('');
  readonly value = input<number>(0);
  readonly valueText = input<string>('');
  readonly format = input<MetricFormat>('plain');
  readonly decimals = input<number>(0);

  readonly delta = input<number | null>(null);
  readonly deltaDir = input<DeltaDir>('auto');

  readonly sub = input<string>('');
  readonly variant = input<MetricVariant>('plain');
  readonly series = input<number[]>([]);
  readonly goal = input<number>(0);
  readonly gaugeMax = input<number>(100);
  readonly tone = input<MetricTone>('default');
  readonly interactive = input<boolean>(false);
  readonly animate = input<boolean>(true);
  /** Jerarquía visual: tarjeta "hero" (número + gráfica más grandes). El ancho lo da el caller con `panel-col-*`. */
  readonly large = input<boolean>(false);
  /** Color de la tarjeta (token de paleta, ej. `var(--chart-2)`). Tiñe stripe + gráfica + fondo suave. Vacío = sunset. */
  readonly accent = input<string>('');

  /** Color efectivo para gráficas (accent o sunset por default). */
  readonly accentGraph = computed(() => this.accent() || 'var(--action)');
  /** Variante translúcida para barras de fondo. */
  readonly accentSoft = computed(() => `color-mix(in srgb, ${this.accentGraph()} 32%, transparent)`);
  /** Formato del tooltip de la sparkline (deriva del formato del valor). */
  readonly sparkFormat = computed<'currency' | 'number' | 'plain'>(() => this.format() === 'currency' ? 'currency' : 'number');

  /** Spotlight: posición del cursor relativa a la card → CSS vars --mx/--my (sin CD). */
  spot(ev: PointerEvent, card: HTMLElement): void {
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${((ev.clientX - r.left) / r.width) * 100}%`);
    card.style.setProperty('--my', `${((ev.clientY - r.top) / r.height) * 100}%`);
  }

  /** Valor animado para el count-up. */
  private readonly animated = signal(0);

  /** Variante efectiva: degrada a 'plain' si faltan datos. */
  readonly effVariant = computed<MetricVariant>(() => {
    const v = this.variant();
    if ((v === 'sparkline' || v === 'bars' || v === 'ember') && (this.series()?.length ?? 0) < 2) return 'plain';
    if (v === 'progress' && !this.goal()) return 'plain';
    return v;
  });

  readonly dir = computed<'up' | 'down' | 'flat'>(() => {
    const d = this.deltaDir();
    if (d !== 'auto') return d === 'up' ? 'up' : d === 'down' ? 'down' : 'flat';
    const val = this.delta() ?? 0;
    return val > 0 ? 'up' : val < 0 ? 'down' : 'flat';
  });
  readonly deltaText = computed(() => {
    const d = this.delta();
    if (d === null || d === undefined) return '';
    const sign = d > 0 ? '+' : '';
    return `${sign}${d}%`;
  });

  readonly displayValue = computed(() => {
    if (this.format() === 'text') return this.valueText();
    const v = this.animated();
    switch (this.format()) {
      case 'currency': return MXN.format(v);
      case 'percent': return `${Math.round(v)}%`;
      case 'number': return new Intl.NumberFormat('es-MX', { maximumFractionDigits: this.decimals() }).format(v);
      default: return new Intl.NumberFormat('es-MX', { maximumFractionDigits: this.decimals() }).format(Math.round(v));
    }
  });

  readonly goalPct = computed(() => {
    const g = this.goal() || 0;
    if (!g) return 0;
    return Math.max(0, Math.min(100, Math.round((this.value() / g) * 100)));
  });
  readonly goalText = computed(() => {
    const fmt = (n: number) => new Intl.NumberFormat('es-MX', { maximumFractionDigits: this.decimals() }).format(n);
    return `${fmt(this.value())} / ${fmt(this.goal())}`;
  });

  constructor() {
    effect((onCleanup) => {
      const target = Number(this.value() ?? 0);
      if (this.format() === 'text') return;
      const reduce = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduce || !this.animate() || typeof requestAnimationFrame === 'undefined') {
        this.animated.set(target);
        return;
      }
      const from = this.animated();
      if (from === target) return;
      const start = performance.now();
      const dur = 700;
      let raf = 0;
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / dur);
        const eased = 1 - Math.pow(1 - t, 3);
        this.animated.set(from + (target - from) * eased);
        if (t < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      onCleanup(() => cancelAnimationFrame(raf));
    });
  }
}
