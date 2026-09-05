import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';

/**
 * DESIGN §9 (datos añejos) — píldora de frescura.
 *
 * ── [VP.0.2] POR QUÉ HAY QUE DECLARAR QUÉ SE MIDE ────────────────────────────────────────
 * Esta píldora no tenía un bug: tenía una palabra. Decía **"actualizado hace 2 min"** a partir de
 * un timestamp que en 21 de sus 24 usos era `Date.now()` del navegador — el momento en que la
 * pantalla pidió los datos. El lector entiende "el dato está actualizado"; lo que se midió es "la
 * página se cargó". Son cosas distintas y la diferencia importa exactamente cuando importa: el
 * 2026-08-27 el carril de catálogos del ODS llevaba seis días parado y cualquiera de estas
 * pantallas habría dicho "actualizado hace 2 min" con total aplomo.
 *
 * El caso más caro era `tienda-arqueo`, que pasaba `label="Kepler"` sobre un `new Date()` local:
 * se leía como "los datos de Kepler tienen 3 minutos" y era la hora del navegador.
 *
 * Por eso `measures` es **requerido**. Con `strictTemplates` un call-site que no lo declare no
 * compila: la decisión se toma una vez, a la vista, en vez de heredarse por descuido.
 *
 *   · `measures="data"`  → el `since` viene del SERVIDOR y describe el DATO (`dato_al`,
 *                          `checked_at`, `max(imported_at)`). Dice "datos hace N".
 *   · `measures="fetch"` → el `since` es hora del navegador: cuándo se pidió. Dice "cargado hace N",
 *                          que es verdad y no promete nada sobre la edad del dato.
 *
 * Cuando exista un `Freshness` del servidor para esa pantalla (VP.2), el call-site pasa de `fetch`
 * a `data` — y ahí sí la píldora habla del dato. Mientras tanto no miente.
 *
 * Se auto-actualiza cada 15s (timer limpiado en DestroyRef). Display-only: el refresh lo dispara la
 * pantalla que la consume.
 */
@Component({
  selector: 'app-freshness-pill',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (ts() != null) {
      <span class="fp" [class.warn]="stale()" [class.is-fetch]="measures() === 'fetch'"
            [attr.title]="titleText()" aria-live="polite">
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
    /* [VP.0.2] La de carga NO lleva punto verde: el verde afirma salud del dato, y ésta no la midió.
       Queda un aro hueco — se ve que es otra cosa sin gritar. */
    .fp.is-fetch .dot { background: transparent; box-shadow: inset 0 0 0 1px var(--text-faint); }
    .fp.is-fetch.warn .dot { box-shadow: inset 0 0 0 1px var(--warn-fg); }
  `],
})
export class FreshnessPillComponent {
  /**
   * Qué mide `since`. REQUERIDO a propósito — ver el encabezado.
   * `data` = edad del dato (timestamp del servidor) · `fetch` = cuándo cargó la pantalla.
   */
  readonly measures = input.required<'data' | 'fetch'>();

  /** El timestamp a medir (Date | epoch ms | ISO string). null = oculta. */
  readonly since = input<Date | string | number | null>(null);

  /** Sobrescribe la palabra. Vacío = la que corresponde a `measures`. */
  readonly label = input<string | null>(null);

  readonly staleAfterSec = input(600);

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

  readonly text = computed(() => {
    const a = this.ageSec();
    if (a == null) return '';
    const w = this.label() ?? (this.measures() === 'data' ? 'datos' : 'cargado');
    return `${w} ${this.rel(a)}`;
  });

  /**
   * El tooltip dice sin rodeos qué se midió. Es donde el usuario que duda encuentra la respuesta,
   * y donde queda claro que una píldora de carga NO habla de la edad del dato.
   */
  readonly titleText = computed(() => {
    const t = this.ts();
    if (t == null) return '';
    const cuando = new Date(t).toLocaleString('es-MX');
    return this.measures() === 'data'
      ? `Fecha del dato: ${cuando}`
      : `Esta pantalla pidió los datos el ${cuando}. No dice qué tan actual es el dato en sí.`;
  });

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
