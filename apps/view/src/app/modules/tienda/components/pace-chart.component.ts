import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RhythmHourPoint } from '../store-socket.service';

export interface PaceRef {
  k: string;
  label: string;
  color: string;
  data: RhythmHourPoint[] | null;
}

/**
 * Ritmo del día: barras de venta por hora + curvas de referencia superpuestas.
 *
 * Compartido por `/tienda/live` (la red) y `/tienda/branches` (una sucursal) — la
 * misma lectura para dirección y para el encargado, que es lo que hace que puedan
 * hablar del mismo número.
 *
 * SVG a mano, 0 KB: el sistema de diseño prohíbe traer una librería de charts para una
 * micro-viz (`DESIGN.md`, motion de KPI cards §4).
 */
@Component({
  selector: 'app-pace-chart',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display:block; }
    .pace-h { display:flex; align-items:baseline; justify-content:space-between; gap:.8rem; flex-wrap:wrap; }
    .pace-h h2 { margin:0; }
    .pace-lg { display:flex; align-items:center; gap:.7rem; flex-wrap:wrap; }
    .lg-i { display:inline-flex; align-items:center; gap:.3rem; font-size:.68rem; color:var(--text-muted); white-space:nowrap; }
    .lg-i .sw { width:.7rem; height:.7rem; border-radius:2px; flex:none; }
    .lg-i .sw.bar { background:var(--action); opacity:.55; }
    .lg-i .sw.ln { height:0; border-top:2px solid currentColor; border-radius:0; }
    /* La leyenda apaga y prende su curva: con varias referencias encimadas, poder
       quitar una es lo que hace legible la comparación. Botón real, no adorno. */
    .lg-i.btn { appearance:none; border:0; background:transparent; cursor:pointer; font:inherit;
      font-size:.68rem; padding:.15rem .1rem; min-height:1.5rem; }
    .lg-i.btn:hover { color:var(--text-main); }
    .lg-i.btn.off { opacity:.4; text-decoration:line-through; }
    .lg-i.btn:focus-visible { outline:2px solid var(--action-ring,var(--action)); outline-offset:2px; border-radius:3px; }
    .pace-svg { display:block; width:100%; margin-top:.5rem; overflow:visible; }
    .pace-svg .pb { fill:var(--action); opacity:.30; }
    .pace-svg .pb.peak { opacity:.6; }
    /* vector-effect mantiene el grosor real de la línea aunque el viewBox se estire. */
    .pace-svg .pl { fill:none; stroke-width:2; stroke-linejoin:round; stroke-linecap:round;
      vector-effect:non-scaling-stroke; }
    .pace-x { display:flex; margin-top:.15rem; }
    .pace-x span { flex:1; text-align:center; font-size:.6rem; color:var(--text-faint);
      font-variant-numeric:tabular-nums; }
    .pace-none { display:flex; align-items:center; gap:.4rem; margin:.5rem 0 0;
      font-size:.72rem; color:var(--text-muted); }
    .pace-none i { color:var(--text-faint); font-size:.72rem; }
  `],
  template: `
    <header class="pace-h">
      <h2>{{ title() }}</h2>
      <div class="pace-lg">
        <span class="lg-i"><i class="sw bar"></i>Hoy</span>
        @for (r of live(); track r.k) {
          <button type="button" class="lg-i btn" [class.off]="!on()[r.k]"
                  [attr.aria-pressed]="on()[r.k]" (click)="toggle(r.k)">
            <i class="sw ln" [style.background]="r.color"></i>{{ r.label }}
          </button>
        }
      </div>
    </header>

    <svg class="pace-svg" [attr.viewBox]="'0 0 ' + W + ' ' + H()" [style.height.px]="H()"
         preserveAspectRatio="none" role="img" [attr.aria-label]="aria()">
      @for (b of bars(); track b.hora) {
        <rect [attr.x]="b.x" [attr.y]="b.y" [attr.width]="b.w" [attr.height]="b.h"
              class="pb" [class.peak]="b.hora === peak() && b.venta > 0"></rect>
      }
      @for (r of live(); track r.k) {
        @if (on()[r.k] && r.path) {
          <path [attr.d]="r.path" class="pl" [attr.stroke]="r.color"></path>
        }
      }
    </svg>
    <div class="pace-x">
      @for (h of hours(); track h.hora) { <span>{{ h.hora }}</span> }
    </div>
    @if (!live().length) {
      <p class="pace-none"><i class="pi pi-info-circle"></i> {{ emptyText() }}</p>
    }
  `,
})
export class PaceChartComponent {
  readonly title = input<string>('Ritmo de hoy (venta por hora)');
  /** Barras: la venta de HOY por hora. */
  readonly hours = input<{ hora: number; venta: number }[]>([]);
  /** Curvas de referencia. Las que traen `data` nula simplemente no se dibujan. */
  readonly refs = input<PaceRef[]>([]);
  readonly emptyText = input<string>('Sin curva de referencia: ningún ritmo juntó días suficientes.');
  /** Alto del lienzo en px. La sucursal usa uno más bajo que la red. */
  readonly H = input<number>(150);

  /** Ancho en unidades del viewBox; el CSS lo estira al ancho real del contenedor. */
  readonly W = 680;

  readonly on = signal<Record<string, boolean>>({});
  toggle(k: string): void {
    this.on.update((o) => ({ ...o, [k]: o[k] === false ? true : false }));
  }
  /** Sin entrada explícita, una curva arranca encendida. */
  private isOn(k: string): boolean { return this.on()[k] !== false; }

  readonly peak = computed(() => {
    let hora = -1, max = 0;
    for (const h of this.hours()) if (h.venta > max) { max = h.venta; hora = h.hora; }
    return hora;
  });

  /**
   * Escala común de barras y líneas: sale del MÁXIMO de todo lo dibujado. Si cada serie
   * se normalizara por su propio pico, un día flojo se vería igual que uno bueno y la
   * comparación —que es el punto del gráfico— sería decorativa.
   */
  private readonly max = computed(() => {
    let m = 0;
    for (const h of this.hours()) m = Math.max(m, h.venta);
    for (const r of this.refs()) {
      if (!r.data || !this.isOn(r.k)) continue;
      for (const p of r.data) m = Math.max(m, p.venta);
    }
    return m || 1;
  });

  private readonly alto = computed(() => this.H() || 150);

  readonly bars = computed(() => {
    const hs = this.hours();
    const max = this.max();
    const alto = this.alto();
    const paso = this.W / (hs.length || 1);
    const ancho = Math.max(2, paso * 0.62);
    return hs.map((b, i) => {
      const h = Math.max(b.venta > 0 ? 1 : 0, (b.venta / max) * (alto - 2));
      return {
        hora: b.hora, venta: b.venta,
        x: +(i * paso + (paso - ancho) / 2).toFixed(2),
        y: +(alto - h).toFixed(2),
        w: +ancho.toFixed(2), h: +h.toFixed(2),
      };
    });
  });

  /** Sólo las referencias que el servidor pudo construir, ya como `path`. */
  readonly live = computed(() => {
    const hs = this.hours();
    const max = this.max();
    const alto = this.alto();
    const paso = this.W / (hs.length || 1);
    return this.refs()
      .filter((r) => r.data && r.data.length)
      .map((r) => {
        // Se dibuja en el CENTRO de cada barra para que línea y barra de la misma hora
        // queden alineadas y el "vamos arriba/abajo" se lea de un vistazo.
        const pts = hs.map((b, i) => {
          const p = r.data!.find((x) => x.hora === b.hora);
          const v = p ? p.venta : 0;
          return `${(i * paso + paso / 2).toFixed(1)},${(alto - (v / max) * (alto - 2)).toFixed(1)}`;
        });
        return { k: r.k, label: r.label, color: r.color, path: pts.length ? 'M' + pts.join(' L') : '' };
      });
  });

  aria(): string {
    const on = this.live().filter((r) => this.isOn(r.k)).map((r) => r.label);
    return 'Venta por hora de hoy' + (on.length ? `, comparada contra ${on.join(', ')}` : '');
  }
}
