import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';

/**
 * DESIGN §9 (datos añejos) — píldora de frescura. Muestra "actualizado hace N min"
 * a partir de un timestamp de última carga, y se pone en tono warn cuando el dato
 * pasa el umbral (`staleAfterSec`). Se auto-actualiza cada 15s (timer limpiado en
 * DestroyRef). Display-only: el refresh lo dispara la pantalla que la consume.
 */
@Component({
  selector: 'app-freshness-pill',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (ts() != null) {
      <span class="fp" [class.warn]="stale()" [attr.title]="titleText()" aria-live="polite">
        <span class="dot"></span>{{ text() }}
      </span>
    }
  `,
  styles: [`
    :host { display: inline-flex; }
    .fp { display: inline-flex; align-items: center; gap: .35rem; font-size: .68rem; color: var(--text-faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .fp .dot { width: 6px; height: 6px; border-radius: var(--r-pill, 999px); background: var(--ok-fg); flex: none; }
    .fp.warn { color: var(--warn-fg); }
    .fp.warn .dot { background: var(--warn-fg); }
  `],
})
export class FreshnessPillComponent {
  /** Momento de la última carga exitosa (Date | epoch ms | ISO string). null = oculta. */
  readonly since = input<Date | string | number | null>(null);
  readonly label = input('actualizado');
  readonly staleAfterSec = input(600); // 10 min

  private readonly now = signal(Date.now());

  readonly ts = computed(() => {
    const v = this.since();
    if (v == null) return null;
    return v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
  });
  readonly ageSec = computed(() => {
    const t = this.ts();
    return t == null ? null : Math.max(0, Math.floor((this.now() - t) / 1000));
  });
  readonly stale = computed(() => { const a = this.ageSec(); return a != null && a >= this.staleAfterSec(); });
  readonly text = computed(() => { const a = this.ageSec(); return a == null ? '' : `${this.label()} ${this.rel(a)}`; });
  readonly titleText = computed(() => { const t = this.ts(); return t == null ? '' : new Date(t).toLocaleString('es-MX'); });

  constructor() {
    const id = setInterval(() => this.now.set(Date.now()), 15000);
    inject(DestroyRef).onDestroy(() => clearInterval(id));
  }

  private rel(s: number): string {
    if (s < 10) return 'ahora';
    if (s < 60) return `hace ${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `hace ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `hace ${h} h`;
    return `hace ${Math.floor(h / 24)} d`;
  }
}
