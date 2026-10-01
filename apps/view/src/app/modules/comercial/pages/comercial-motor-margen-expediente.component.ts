import {
  ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DialogModule } from 'primeng/dialog';
import { ButtonModule } from 'primeng/button';
import { ChartModule } from 'primeng/chart';
import { InputNumberModule } from 'primeng/inputnumber';
import { SkeletonModule } from 'primeng/skeleton';
import { getChartTokens } from '../../../shared/theme/chart-theme';
import {
  MotorMargenService, type Expediente, type Simulacion, type RespuestaPrecio,
} from '../motor-margen.service';

/**
 * `[PR.X5]` — **El expediente del SKU: la ventana.**
 *
 * ── Lo que responde ───────────────────────────────────────────────────────────────────────
 * 1. **La historia** — costo, precio y volumen de 12 meses, con los cambios de precio marcados.
 * 2. ⭐⭐ **Qué pasó las veces anteriores** — y **por qué casi nunca se puede leer**.
 * 3. **El simulador** — aritmética pura, sin predecir nada.
 * 4. **El SKU en las 9 plazas**.
 * 5. **La demanda perdida**, con su fecha de caducidad.
 *
 * ── ⛔⛔ Por qué NO hay una curva de elasticidad ──────────────────────────────────────────
 * Porque no existe. La región medida es **[−1.415, −0.045]** -factor 31× de ancho- y por SKU el
 * error estándar es **0.94**, o sea ruido. `DESIGN.md` lo dice con todas las letras: *"nunca
 * inventar una serie/chart si no hay dato real"*.
 *
 * ⭐ En su lugar, dos cosas que **sí** son ciertas:
 * · **El umbral de equilibrio** — cuánto volumen habría que perder para que el cambio salga mal.
 *   Aritmética, no predicción. Convierte el hueco en un instrumento.
 * · **Qué pasó las veces anteriores**, con **su placebo al lado**. Medido sobre todo el universo
 *   la pre-tendencia media es **+0.26** contra un efecto de −0.01, y una BAJA de precio produce
 *   el mismo movimiento negativo que un ALZA (−0.39 y −0.64). **Ninguna curva de demanda hace
 *   eso** — es reversión a la media. Así que la mayoría de las filas se marcan *no comparable*,
 *   y eso **es** el resultado: es el argumento para correr el experimento.
 *
 * ── El contrato de diseño ─────────────────────────────────────────────────────────────────
 * `p-dialog` con `<ng-template #footer>` -⛔ **nunca `pTemplate`**, que PrimeNG 22 ignora en
 * silencio y hay gate con tolerancia cero-. Overlay: **sombra + borde** (al revés que in-page).
 * Gráficas con `@defer (on viewport)` y tokens de `getChartTokens()`, porque Chart.js no lee
 * `var()`. Cero `font-size` literal. `tabular-nums` en toda cifra. Tres glifos de ausencia.
 */
@Component({
  selector: 'app-motor-margen-expediente',
  standalone: true,
  imports: [CommonModule, FormsModule, DialogModule, ButtonModule, ChartModule,
    InputNumberModule, SkeletonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
<p-dialog [visible]="abierto()" (visibleChange)="cerrarSi($event)" [modal]="true"
          [draggable]="false" [dismissableMask]="true"
          [style]="{ width: '76rem', maxWidth: '96vw' }" styleClass="mx-dlg"
          [header]="(exp()?.accion?.nombre) || 'Expediente del producto'">

  @if (cargando()) {
    <div class="mx-skel">@for (i of [1,2,3,4,5]; track i) { <p-skeleton height="2.4rem" /> }</div>
  } @else if (error(); as e) {
    <div class="mx-err" role="alert">
      <span>{{ e }}</span>
      <p-button label="Reintentar" severity="secondary" size="small" (onClick)="recargar()" />
    </div>
  } @else if (exp(); as d) {

    <!-- ══ CABECERA · dónde está parado ═══════════════════════════════════════════════ -->
    <header class="mx-head">
      <div class="mx-head-ids">
        <span class="mx-mono">{{ d.accion.sucursal }} · SKU {{ d.accion.sku }}</span>
        @if (d.accion.g2_clase_abc) { <span class="mx-tag">clase {{ d.accion.g2_clase_abc }}</span> }
        @if (d.accion.e3_estado_inventario) {
          <span class="mx-tag">{{ d.accion.e3_estado_inventario }}</span>
        }
      </div>
      <dl class="mx-cifras">
        <div><dt>Precio hoy</dt><dd class="comm-num">{{ d.accion.precio_actual | currency:'MXN':'symbol-narrow':'1.2-2' }}</dd></div>
        <div><dt>Costo</dt><dd class="comm-num">{{ num(d.accion.a1_costo_hoy, '1.2-2') }}</dd></div>
        <div><dt>Margen real</dt><dd class="comm-num">{{ pct(d.accion.margen_realizado_pct) }}</dd></div>
        <div><dt>Meta de ficha</dt><dd class="comm-num">{{ pct(d.accion.meta_margen_pct) }}</dd></div>
        <div><dt>Venta 30 d</dt><dd class="comm-num">{{ d.accion.venta_30d | currency:'MXN':'symbol-narrow':'1.0-0' }}</dd></div>
      </dl>
    </header>

    <!-- ══ 1 · LA HISTORIA ════════════════════════════════════════════════════════════ -->
    <section class="mx-sec">
      <h3 class="mx-h3">Costo, precio y volumen &middot; 12 meses</h3>
      @if (d.historia.length >= 3) {
        @defer (on viewport) {
          <p-chart type="bar" [data]="datosHistoria()" [options]="opcionesHistoria()"
                   height="260px" />
        } @placeholder { <p-skeleton height="260px" /> }
        <p class="mx-nota">
          El costo y el precio salen de los <strong>mismos renglones costeados</strong> del ERP.
          @if (mesesParciales() > 0) {
            ⚠️ {{ mesesParciales() }} de {{ d.historia.length }} meses tienen cobertura de costo
            parcial &mdash; ahí la línea de costo describe sólo una parte de la venta.
          }
        </p>
      } @else {
        <p class="mx-vacio">
          <span class="mx-nd">n/d</span> &mdash; este par tiene {{ d.historia.length }} mes(es)
          con venta. Con menos de tres no se dibuja: una línea de dos puntos sugiere una
          tendencia que no se midió.
        </p>
      }
    </section>

    <!-- ══ 2 · ⭐⭐ QUÉ PASÓ LAS VECES ANTERIORES ═════════════════════════════════════ -->
    <section class="mx-sec">
      <h3 class="mx-h3">Qué pasó las veces anteriores que este precio se movió</h3>
      @if (medibles().length > 0) {
        @defer (on viewport) {
          <p-chart type="bar" [data]="datosRespuesta()" [options]="opcionesRespuesta()"
                   height="220px" />
        } @placeholder { <p-skeleton height="220px" /> }

        <!-- ⭐⭐ El veredicto de comparabilidad, ANTES que el número. -->
        <p class="mx-ver" [class.is-no]="comparables() === 0">
          @if (comparables() === 0) {
            ⛔ <strong>Ninguno de estos {{ medibles().length }} cambios es comparable.</strong>
            En todos, el volumen ya se estaba moviendo <em>antes</em> de tocar el precio
            (la barra clara), así que lo de después no se le puede atribuir al precio.
          } @else {
            {{ comparables() }} de {{ medibles().length }} cambios tienen la ventana previa plana
            y se pueden leer. En el resto el volumen ya venía moviéndose solo.
          }
        </p>
        <p class="mx-nota">
          ⛔ <strong>No hay una curva de elasticidad y no se va a dibujar una.</strong> Medida
          sobre todo el catálogo, la región es <span class="mx-mono">[−1.415, −0.045]</span> &mdash;
          un factor 31&times; de ancho. Y una <em>baja</em> de precio produce el mismo movimiento
          negativo que un <em>alza</em>, que es imposible si lo causara el precio: es reversión a
          la media, el precio se toca justo después de un pico de ventas.
        </p>
      } @else {
        <p class="mx-vacio">
          <span class="mx-nd">n/d</span> &mdash; este par no tiene ningún cambio de precio con
          línea base de venta a los dos lados. {{ motivoSinRespuesta() }}
        </p>
      }
    </section>

    <!-- ══ 3 · ⭐ EL SIMULADOR ════════════════════════════════════════════════════════ -->
    <section class="mx-sec mx-sim">
      <h3 class="mx-h3">Simular un precio</h3>
      <div class="mx-sim-row">
        <!-- ⚠️ PrimeNG 22 retiro [showButtons] y [min] de p-inputNumber: cualquiera de los dos
             rompe el build. El piso se valida del lado del servidor, que es donde importa. -->
        <p-inputNumber [(ngModel)]="precioSim" mode="currency" currency="MXN"
                       locale="es-MX"
                       inputStyleClass="comm-num" placeholder="Precio nuevo"
                       (onKeyDown)="alTeclear($event)" />
        <p-button label="Calcular" icon="pi pi-calculator" size="small"
                  [disabled]="!precioSim" [loading]="simulando()" (onClick)="simular()" />
        @if (sim()?.cambio_pct !== null && sim(); as s) {
          <span class="mx-sim-delta comm-num" [class.is-up]="(s.cambio_pct ?? 0) > 0">
            {{ (s.cambio_pct ?? 0) > 0 ? '+' : '' }}{{ s.cambio_pct }}%
          </span>
        }
      </div>

      @if (sim(); as s) {
        @if (s.error) {
          <p class="mx-vacio">{{ s.error }}</p>
        } @else {
          <dl class="mx-sim-out">
            <div>
              <dt>Margen que queda</dt>
              <dd class="comm-num">{{ s.margen_nuevo_pct !== null ? s.margen_nuevo_pct + '%' : 'n/d' }}</dd>
            </div>
            <div>
              <dt>Aterriza en</dt>
              <dd class="comm-num">{{ num(s.aterrizajes.p99, '1.2-2') }}</dd>
            </div>
            <div>
              <dt>¿Se nota?</dt>
              <dd>
                @if (s.se_percibe === null) { <span class="mx-nd">n/d</span> }
                @else if (s.se_percibe) { sí, cruza el umbral de {{ s.umbral_percepcion_pct }}% }
                @else { no &mdash; queda bajo el umbral de {{ s.umbral_percepcion_pct }}% }
              </dd>
            </div>
          </dl>

          <!-- ⭐⭐ EL NÚMERO QUE IMPORTA -->
          @if (s.umbral_equilibrio_pct !== null) {
            <p class="mx-umbral">
              @if (+s.umbral_equilibrio_pct > 0) {
                Tendrías que perder más del
                <strong class="comm-num">{{ s.umbral_equilibrio_pct }}%</strong>
                del volumen para quedar peor que como estás.
              } @else {
                ⚠️ Es una <strong>baja</strong>: tendrías que <strong>ganar</strong>
                <strong class="comm-num">{{ -(+s.umbral_equilibrio_pct) | number:'1.0-2' }}%</strong>
                de volumen sólo para empatar.
              }
            </p>
          } @else {
            <p class="mx-vacio">
              <span class="mx-nd">n/d</span> &mdash; sin costo, o el precio queda bajo el costo.
              Un umbral sin costo sería un invento.
            </p>
          }
          <p class="mx-nota">⛔ Lo que esto <strong>no</strong> dice: {{ s.no_sabe }}</p>
        }
      } @else {
        <p class="mx-nota">
          Todo lo que calcula es aritmética del propio ERP. <strong>No escribe ningún precio</strong>
          &mdash; la captura sigue siendo en Kepler.
        </p>
      }
    </section>

    <!-- ══ 4 · EL SKU EN LAS PLAZAS ═══════════════════════════════════════════════════ -->
    <section class="mx-sec">
      <h3 class="mx-h3">El mismo producto en las demás plazas</h3>
      <table class="mx-tab">
        <thead>
          <tr>
            <th scope="col">Plaza</th>
            <th scope="col" class="comm-num">Precio</th>
            <th scope="col" class="comm-num">Costo</th>
            <th scope="col" class="comm-num">Margen real</th>
            <th scope="col">Qué hacer</th>
          </tr>
        </thead>
        <tbody>
          @for (p of d.plazas; track p.sucursal) {
            <tr [class.is-esta]="p.es_esta">
              <td class="mx-mono">{{ p.sucursal }}</td>
              <td class="comm-num">{{ num(p.precio_actual, '1.2-2') }}</td>
              <td class="comm-num">{{ num(p.a1_costo_hoy, '1.2-2') }}</td>
              <td class="comm-num">{{ pct(p.margen_realizado_pct) }}</td>
              <td class="mx-min">{{ p.accion }}</td>
            </tr>
          }
        </tbody>
      </table>
      @if (spreadMargen() !== null) {
        <p class="mx-nota">
          El margen realizado va de <strong class="comm-num">{{ margenMin() }}%</strong> a
          <strong class="comm-num">{{ margenMax() }}%</strong> &mdash;
          <strong class="comm-num">{{ spreadMargen() }} pp</strong> de diferencia por el mismo
          producto.
        </p>
      }
    </section>

    <!-- ══ 5 · LA DEMANDA PERDIDA ═════════════════════════════════════════════════════ -->
    <section class="mx-sec">
      <h3 class="mx-h3">Lo que se pidió y no se pudo surtir</h3>
      @if (d.perdida.length > 0) {
        <table class="mx-tab">
          <thead>
            <tr>
              <th scope="col">Mes</th><th scope="col">Plaza</th>
              <th scope="col" class="comm-num">Unidades</th>
              <th scope="col" class="comm-num">Importe</th>
              <th scope="col" class="comm-num">Clientes</th>
            </tr>
          </thead>
          <tbody>
            @for (x of d.perdida; track x.mes + x.sucursal) {
              <tr>
                <td class="mx-mono">{{ x.mes }}</td>
                <td class="mx-mono">{{ x.sucursal }}</td>
                <td class="comm-num">{{ x.unidades_perdidas | number:'1.0-0' }}</td>
                <td class="comm-num">{{ x.importe_perdido | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                <td class="comm-num">{{ x.clientes }}</td>
              </tr>
            }
          </tbody>
        </table>
        <!-- ⛔ La fecha de caducidad, antes de que alguien lo lea como actual. -->
        @if (atrasoMax() > 45) {
          <p class="mx-nota mx-warn">
            ⚠️ El dato más reciente tiene <strong>{{ atrasoMax() }} días</strong>. Lo registraba
            Wincaja y dejó de hacerlo el día que esta plaza pasó a Kepler &mdash; no es que hayan
            dejado de faltar productos.
          </p>
        }
      } @else {
        <p class="mx-vacio">
          <span class="mx-nd">n/d</span> &mdash; sin registros de faltante para este producto.
          ⚠️ No significa que no haya faltado: sólo las plazas que todavía corrían Wincaja lo
          registraban.
        </p>
      }
      <p class="mx-nota">
        ⛔ Esto mide <strong>cuánto se perdió</strong> valuado a nuestro precio, no contra qué
        precio se perdió. <strong>No existe ninguna fuente de precio de competencia.</strong>
      </p>
    </section>
  }

  <ng-template #footer>
    <p-button label="Cerrar" severity="secondary" size="small" (onClick)="cerrar()" />
  </ng-template>
</p-dialog>
  `,
  styles: [`
    :host ::ng-deep .mx-dlg .p-dialog-content { padding-top: var(--sp-2); }

    .mx-skel { display: flex; flex-direction: column; gap: var(--sp-2); }
    .mx-err {
      display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3);
      border: 1px solid var(--bad-fg); border-radius: var(--r-md);
      padding: var(--sp-2) var(--sp-3); font-size: var(--fs-sm); color: var(--bad-soft-fg);
    }

    .mx-head {
      display: flex; flex-direction: column; gap: var(--sp-2);
      padding-bottom: var(--sp-3); border-bottom: 1px solid var(--border-color);
    }
    .mx-head-ids { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .mx-mono { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--fg-3); }
    .mx-tag {
      font-size: var(--fs-nano); text-transform: uppercase; letter-spacing: .05em;
      padding: 1px var(--sp-2); border: 1px solid var(--border-color);
      border-radius: var(--r-pill); color: var(--fg-2);
    }

    /* Las cifras de cabecera: jerarquía por tipo y contraste, sin cajas. */
    .mx-cifras { display: flex; gap: var(--sp-5); margin: 0; flex-wrap: wrap; }
    .mx-cifras div { display: flex; flex-direction: column; gap: 1px; }
    .mx-cifras dt {
      font-size: var(--fs-nano); text-transform: uppercase; letter-spacing: .06em;
      color: var(--fg-3);
    }
    .mx-cifras dd {
      margin: 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); color: var(--fg-1);
      font-variant-numeric: tabular-nums;
    }

    .mx-sec {
      padding: var(--sp-4) 0; border-bottom: 1px solid var(--border-color);
      display: flex; flex-direction: column; gap: var(--sp-2);
    }
    .mx-sec:last-of-type { border-bottom: none; }
    .mx-h3 {
      margin: 0; font-size: var(--fs-micro); font-weight: var(--fw-bold);
      letter-spacing: .08em; text-transform: uppercase; color: var(--fg-3);
    }
    .mx-nota { margin: 0; font-size: var(--fs-xs); color: var(--fg-3); line-height: 1.55; }
    .mx-warn { color: var(--warn-soft-fg); }
    .mx-vacio { margin: 0; font-size: var(--fs-sm); color: var(--fg-3); line-height: 1.6; }
    /* Tres glifos, tres significados. n/d = no se pudo medir. */
    .mx-nd { color: var(--fg-3); font-style: italic; }

    /* ⭐ El veredicto de comparabilidad pesa más que el número que lo sigue. */
    .mx-ver {
      margin: 0; font-size: var(--fs-sm); color: var(--fg-1); line-height: 1.55;
      padding-left: var(--sp-3); border-left: 2px solid var(--border-color);
    }
    .mx-ver.is-no { border-left-color: var(--warn-soft-fg); }

    .mx-sim-row { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
    .mx-sim-delta { font-size: var(--fs-h3); font-weight: var(--fw-bold); color: var(--fg-3); }
    .mx-sim-delta.is-up { color: var(--fg-1); }
    .mx-sim-out { display: flex; gap: var(--sp-5); margin: 0; flex-wrap: wrap; }
    .mx-sim-out div { display: flex; flex-direction: column; gap: 1px; }
    .mx-sim-out dt {
      font-size: var(--fs-nano); text-transform: uppercase; letter-spacing: .06em;
      color: var(--fg-3);
    }
    .mx-sim-out dd {
      margin: 0; font-size: var(--fs-base); font-weight: var(--fw-medium); color: var(--fg-1);
      font-variant-numeric: tabular-nums;
    }
    /* ⭐⭐ El umbral de equilibrio es la respuesta a la elasticidad: va con peso de titular. */
    .mx-umbral {
      margin: 0; font-size: var(--fs-base); color: var(--fg-1); line-height: 1.5;
      padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border-color);
      border-radius: var(--r-md);
    }
    .mx-umbral strong { font-weight: var(--fw-bold); }

    .mx-tab { width: 100%; border-collapse: collapse; font-size: var(--fs-xs); }
    .mx-tab th {
      text-align: left; font-size: var(--fs-nano); font-weight: var(--fw-bold);
      letter-spacing: .05em; text-transform: uppercase; color: var(--fg-3);
      padding-bottom: var(--sp-1); border-bottom: 1px solid var(--border-color);
    }
    .mx-tab th.comm-num { text-align: right; }
    .mx-tab td { padding: var(--sp-1) 0; border-bottom: 1px solid var(--border-color); }
    .mx-tab tbody tr:last-child td { border-bottom: none; }
    /* La plaza que se está mirando se distingue por PESO, no por color de fondo. */
    .mx-tab tr.is-esta td { font-weight: var(--fw-bold); color: var(--fg-1); }
    .mx-min { font-size: var(--fs-nano); color: var(--fg-3); }
  `],
})
export class ComercialMotorMargenExpedienteComponent {
  private readonly api = inject(MotorMargenService);
  private readonly destroyRef = inject(DestroyRef);

  readonly sucursal = input<string | null>(null);
  readonly sku = input<string | null>(null);
  readonly cerrado = output<void>();

  readonly exp = signal<Expediente | null>(null);
  readonly sim = signal<Simulacion | null>(null);
  readonly cargando = signal(false);
  readonly simulando = signal(false);
  readonly error = signal<string | null>(null);
  readonly abierto = computed(() => !!this.sucursal() && !!this.sku());
  precioSim: number | null = null;

  constructor() {
    effect(() => {
      const s = this.sucursal(); const k = this.sku();
      if (s && k) this.traer(s, k); else { this.exp.set(null); this.sim.set(null); }
    });
  }

  private traer(s: string, k: string): void {
    this.cargando.set(true); this.error.set(null);
    this.sim.set(null); this.precioSim = null;
    this.api.expediente(s, k).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.exp.set(d); this.cargando.set(false); },
      error: (e) => { this.error.set(this.msg(e)); this.cargando.set(false); },
    });
  }

  recargar(): void {
    const s = this.sucursal(); const k = this.sku();
    if (s && k) this.traer(s, k);
  }

  simular(): void {
    const s = this.sucursal(); const k = this.sku();
    if (!s || !k || !this.precioSim) return;
    this.simulando.set(true);
    this.api.simular(s, k, this.precioSim).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.sim.set(r); this.simulando.set(false); },
      error: (e) => { this.error.set(this.msg(e)); this.simulando.set(false); },
    });
  }

  /** Enter calcula: quien teclea un precio espera resultado sin buscar el boton. */
  alTeclear(e: Event): void {
    if ((e as KeyboardEvent).key === 'Enter') this.simular();
  }

  cerrar(): void { this.cerrado.emit(); }
  cerrarSi(v: boolean): void { if (!v) this.cerrado.emit(); }

  // ── Gráfica 1 · costo, precio y volumen ───────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly datosHistoria = computed<any>(() => {
    const h = this.exp()?.historia ?? [];
    const t = getChartTokens();
    return {
      labels: h.map((x) => x.mes),
      datasets: [
        {
          type: 'bar', label: 'Unidades', yAxisID: 'y2',
          data: h.map((x) => Number(x.unidades_total ?? 0)),
          backgroundColor: t.chartFillLow, borderWidth: 0, order: 3,
        },
        {
          type: 'line', label: 'Precio', yAxisID: 'y1',
          data: h.map((x) => (x.precio_unitario === null ? null : Number(x.precio_unitario))),
          borderColor: t.chart1, backgroundColor: t.chart1,
          tension: 0.2, pointRadius: 2, borderWidth: 2, order: 1, spanGaps: false,
        },
        {
          type: 'line', label: 'Costo', yAxisID: 'y1',
          data: h.map((x) => (x.costo_unitario === null ? null : Number(x.costo_unitario))),
          borderColor: t.chart2, backgroundColor: t.chart2,
          tension: 0.2, pointRadius: 2, borderWidth: 2, borderDash: [4, 3], order: 2,
          spanGaps: false,
        },
      ],
    };
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly opcionesHistoria = computed<any>(() => {
    const t = getChartTokens();
    const h = this.exp()?.historia ?? [];
    return {
      maintainAspectRatio: false, responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: t.textMuted, boxWidth: 10, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            // ⭐ La cobertura del costo va en el tooltip: un mes al 60 % no dice lo mismo.
            afterBody: (items: { dataIndex: number }[]) => {
              const m = h[items[0]?.dataIndex ?? 0];
              if (!m) return '';
              const cob = m.cobertura_costo_pct === null ? null : Number(m.cobertura_costo_pct);
              const partes = [`${m.dias_con_venta} día(s) con venta`];
              if (cob !== null && cob < 100) partes.push(`cobertura de costo ${cob}%`);
              if (m.margen_pct !== null) partes.push(`margen ${m.margen_pct}%`);
              return partes.join(' · ');
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: t.chartAxis, font: { size: 10 } } },
        y1: {
          position: 'left', grid: { color: t.chartGrid },
          ticks: { color: t.chartAxis, font: { size: 10 } },
        },
        y2: {
          position: 'right', grid: { display: false },
          ticks: { color: t.textFaint, font: { size: 10 } },
        },
      },
    };
  });

  // ── Gráfica 2 · el event-study, con su placebo ────────────────────────────────────
  readonly medibles = computed<RespuestaPrecio[]>(
    () => (this.exp()?.respuesta ?? []).filter((r) => r.lr_post !== null));

  /** ⭐⭐ Comparable = la ventana PREVIA estaba plana. Sin eso, el efecto no se puede leer. */
  readonly comparables = computed(
    () => this.medibles().filter((r) => r.lr_pre !== null && Math.abs(Number(r.lr_pre)) < 0.1).length);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly datosRespuesta = computed<any>(() => {
    const r = this.medibles(); const t = getChartTokens();
    return {
      labels: r.map((x) => `${x.fecha} (${x.cambio_pct}%)`),
      datasets: [
        {
          label: 'Antes de tocar el precio (placebo)',
          data: r.map((x) => (x.lr_pre === null ? 0 : Number(x.lr_pre))),
          backgroundColor: t.chartFillLow, borderWidth: 0,
        },
        {
          label: 'Después del cambio',
          data: r.map((x) => Number(x.lr_post)),
          backgroundColor: t.chart1, borderWidth: 0,
        },
      ],
    };
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly opcionesRespuesta = computed<any>(() => {
    const t = getChartTokens();
    return {
      maintainAspectRatio: false, responsive: true, indexAxis: 'y',
      plugins: {
        legend: { labels: { color: t.textMuted, boxWidth: 10, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: (c: { dataset: { label: string }; parsed: { x: number } }) => {
              const v = c.parsed.x;
              const pct = ((Math.exp(v) - 1) * 100).toFixed(1);
              return `${c.dataset.label}: ${v > 0 ? '+' : ''}${pct}% de volumen`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { color: t.chartGrid },
          ticks: { color: t.chartAxis, font: { size: 10 } },
          title: { display: true, text: 'cambio de volumen (log)', color: t.textFaint },
        },
        y: { grid: { display: false }, ticks: { color: t.chartAxis, font: { size: 10 } } },
      },
    };
  });

  readonly motivoSinRespuesta = computed(() => {
    const r = this.exp()?.respuesta ?? [];
    if (!r.length) return 'No hubo cambios de precio de 2 % o más en la ventana medible.';
    return r[0].motivo ?? '';
  });

  readonly mesesParciales = computed(
    () => (this.exp()?.historia ?? []).filter(
      (m) => m.cobertura_costo_pct !== null && Number(m.cobertura_costo_pct) < 100).length);

  readonly atrasoMax = computed(
    () => Math.max(0, ...(this.exp()?.perdida ?? []).map((x) => x.dias_de_atraso)));

  private margenes = computed(() => (this.exp()?.plazas ?? [])
    .map((p) => p.margen_realizado_pct).filter((x): x is string => x !== null).map(Number));

  readonly margenMin = computed(() => {
    const m = this.margenes(); return m.length ? Math.min(...m).toFixed(2) : null;
  });

  readonly margenMax = computed(() => {
    const m = this.margenes(); return m.length ? Math.max(...m).toFixed(2) : null;
  });

  readonly spreadMargen = computed(() => {
    const m = this.margenes();
    return m.length >= 2 ? (Math.max(...m) - Math.min(...m)).toFixed(2) : null;
  });

  num(v: string | number | null | undefined, _f = '1.2-2'): string {
    if (v === null || v === undefined) return '—';
    return `$${Number(v).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  pct(v: string | number | null | undefined): string {
    if (v === null || v === undefined) return '—';
    return `${Number(v).toFixed(2)}%`;
  }

  private msg(e: unknown): string {
    const err = e as { error?: { message?: string }; message?: string };
    return err?.error?.message ?? err?.message ?? 'No se pudo leer el expediente.';
  }
}
