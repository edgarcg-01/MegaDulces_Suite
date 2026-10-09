import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TagModule } from 'primeng/tag';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import {
  ComercialService, RouteProfit, RouteProfitPeriodo, RouteProfitRuta, RouteProfitPlaza,
} from '../comercial.service';

/**
 * `[RD.57]` — **Rentabilidad de Ruta Directa: ¿la ruta gana dinero?**
 *
 * No es la pregunta de `/comercial/comisiones`, que responde *cuánto cobra cada persona*. El
 * libro `INDICADORES RD 2026` tiene los dos números en hojas separadas y nadie los pone uno al
 * lado del otro — ésa es toda la tesis de esta pantalla.
 *
 * ── Lo que da que el Excel no puede dar ──────────────────────────────────────────────────
 * Medido en la quincena 20 de 2026 contra prod:
 *   · La **501 gana 25.45%** contra 16-18% de todas las demás: ocho puntos que nadie veía.
 *   · La **28 recorrió 1,165 km — la que más — para vender lo menos**: rinde **$150.90 por
 *     kilómetro** contra $246.79 de la 23, un 64% de diferencia.
 * Los kilómetros salen del **odómetro del GPS**, no de una celda tecleada al cerrar la quincena.
 *
 * ── Tres bloques que NO se suman entre sí, y por qué ─────────────────────────────────────
 *
 * **1. La ruta.** Venta, costo, utilidad bruta, su comisión y sus kilómetros.
 * ⭐ El margen se calcula sobre el **subtotal sin IVA**, que es la base del costo; sobre `venta`
 * saldría ~16 puntos más alto sin que nada se viera raro.
 *
 * **2. La plaza.** El gasto del departamento. ⛔ **No se prorratea a la ruta**: la contabilidad
 * llega al departamento y el comentario de las líneas de combustible dice literalmente
 * "combustible rd". Repartirlo por venta o por kilómetros sería inventarlo (ADR-056).
 *
 * **3. El contraste de la comisión.** ⛔ **No se resta dos veces**: el gasto del departamento
 * ya incluye `COMISIONES DE VENTAS`. Va al lado, y lo que publica es un hueco — el libro paga
 * más de lo que la contabilidad registra, todas las quincenas.
 *
 * ── Lo que esta pantalla no puede decir, y lo dice ───────────────────────────────────────
 * No hay litros en ninguna fuente, así que **no hay `$/litro` ni `km/l`**. Las camionetas de
 * Canindo no tienen rastreador: su kilometraje sale `sin medir`, nunca cero. Y la historia de
 * posiciones arranca el 2026-07-27.
 *
 * Sólo lee. El costo se arregla en Kepler, el gasto en la contabilidad y la comisión en su
 * propia pantalla: un botón acá sería una puerta a editar la cifra en vez de la causa.
 */
@Component({
  selector: 'app-comercial-ruta-directa-rentabilidad',
  standalone: true,
  imports: [TagModule, LoadStateComponent, MetricStripComponent, SegmentedComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rp">
      <header class="rp-head">
        <div>
          <h1>Rentabilidad de Ruta Directa</h1>
          <p class="rp-sub">
            Qué queda después del costo de la mercancía, de la comisión y del gasto del
            departamento. Los kilómetros salen del odómetro del GPS.
          </p>
        </div>
        @if (data(); as d) {
          <div class="rp-period">
            <label for="rp-sel">Quincena</label>
            <select id="rp-sel" [value]="periodId() ?? d.periodo.id"
                    (change)="elegir($any($event.target).value)">
              @for (p of periodos(); track p.id) {
                <option [value]="p.id">
                  Q{{ p.period_no }} · {{ dia(p.date_from) }} al {{ dia(p.date_to) }}
                </option>
              }
            </select>
          </div>
        }
      </header>

      <app-load-state
        [loading]="cargando()" [isEmpty]="!data()" [skeletonRows]="8"
        emptyIcon="pi-chart-line" emptyTitle="Sin quincenas con renglones"
        emptyHint="Ninguna corrida de comisión tiene renglones todavía.">

        @if (data(); as d) {
          <app-metric-strip [items]="kpis(d)" ariaLabel="Resultado de la quincena" />

          <p class="rp-proc">
            Gasto recalculado <b>{{ cuando(d.procedencia.gasto_calculado_at) }}</b>
            · kilómetros desde <b>{{ d.procedencia.km_desde ? dia(d.procedencia.km_desde) : 'sin medir' }}</b>
            · {{ d.periodo.cerrado ? 'quincena cerrada' : 'quincena en curso' }}
          </p>

          <!-- ⭐ Los huecos van ARRIBA, no al pie: son la razón de que media tabla diga
               «sin medir», y abajo nadie los lee. -->
          @if (d.huecos.length) {
            <section class="rp-gaps" aria-label="Lo que no se pudo medir">
              <h2>Lo que esta pantalla no puede decir</h2>
              <ul>
                @for (h of d.huecos; track h.clave) {
                  <li><b>{{ etiquetaHueco(h.clave) }}</b> — {{ h.detalle }}</li>
                }
              </ul>
            </section>
          }

          <app-segmented [options]="pestanas" [value]="tab()" (valueChange)="tab.set($event)"
                         ariaLabel="Qué se está viendo" />

          @if (tab() === 'rutas') {
            <!-- Caso A de DESIGN_TABLES: las columnas son CAMPOS de un registro, así que en
                 estrecho la fila se apila. Sin dt-scope en el contenedor el CSS es inerte. -->
            <div class="rp-wrap dt-scope">
              <table class="rp-table dt-stack">
                <caption class="sr-only">Resultado por ruta en la quincena</caption>
                <thead>
                  <tr>
                    <th scope="col">Ruta</th>
                    <th scope="col">Chofer</th>
                    <th scope="col" class="num">Venta sin IVA</th>
                    <th scope="col" class="num">Costo</th>
                    <th scope="col" class="num">Utilidad bruta</th>
                    <th scope="col" class="num">Margen</th>
                    <th scope="col" class="num">Su comisión</th>
                    <th scope="col" class="num">Le queda</th>
                    <th scope="col" class="num">Kilómetros</th>
                    <th scope="col" class="num">Venta por km</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of rutasOrdenadas(); track r.route_code) {
                    <tr [class.rp-flag]="esDestacada(r)">
                      <td role="cell" data-label="Ruta" class="mono dt-id">{{ r.route_code }}</td>
                      <td role="cell" data-label="Chofer">
                        {{ r.chofer || '—' }}
                        @if (r.motivo_no_pago) {
                          <p-tag severity="warn" [value]="motivo(r.motivo_no_pago)" styleClass="rp-tag" />
                        }
                      </td>
                      <td role="cell" data-label="Venta sin IVA" class="num dt-num mono">{{ dinero(r.subtotal) }}</td>
                      <td role="cell" data-label="Costo" class="num dt-num mono dim">{{ dinero(r.costo) }}</td>
                      <td role="cell" data-label="Utilidad bruta" class="num dt-num mono fuerte">{{ dinero(r.utilidad_bruta) }}</td>
                      <td role="cell" data-label="Margen" class="num dt-num mono"
                          [class.rp-alto]="margenAlto(r)" [class.rp-bajo]="margenBajo(r)">
                        {{ r.margen_pct !== null ? r.margen_pct + '%' : '—' }}
                      </td>
                      <td role="cell" data-label="Su comisión" class="num dt-num mono dim">{{ dinero(r.comision) }}</td>
                      <td role="cell" data-label="Le queda" class="num dt-num mono">{{ dinero(r.despues_de_su_comision) }}</td>
                      <td role="cell" data-label="Kilómetros" class="num dt-num mono">
                        <!-- ⛔ Sin `title`: en táctil no hay hover, así que lo que explica la
                             cifra va como texto visible (DESIGN_TABLES §"además del ancho"). -->
                        @if (r.km_veredicto === 'sin_gps') {
                          <span class="rp-nd">sin rastreador</span>
                        } @else {
                          {{ entero(r.km) }}
                          @if (r.km_veredicto === 'parcial') {
                            <span class="rp-nd">{{ r.dias_medidos }} de {{ r.dias_con_senal }} días</span>
                          }
                        }
                      </td>
                      <td role="cell" data-label="Venta por km" class="num dt-num mono" [class.rp-bajo]="kmBajo(r)">
                        {{ r.venta_por_km !== null ? dinero(r.venta_por_km) : '—' }}
                      </td>
                    </tr>
                  }
                </tbody>
                <tfoot>
                  <tr>
                    <td colspan="2">{{ d.rutas.length }} rutas</td>
                    <td class="num mono">{{ dinero(d.totales.subtotal) }}</td>
                    <td class="num mono">{{ dinero(d.totales.costo) }}</td>
                    <td class="num mono fuerte">{{ dinero(d.totales.utilidad_bruta) }}</td>
                    <td class="num mono">{{ d.totales.margen_pct !== null ? d.totales.margen_pct + '%' : '—' }}</td>
                    <td class="num mono">{{ dinero(d.totales.comision) }}</td>
                    <td class="num"></td>
                    <td class="num mono">{{ d.totales.km ? entero(d.totales.km) : '—' }}</td>
                    <td class="num"></td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p class="rp-note">
              El margen se calcula sobre la <b>venta sin IVA</b>, que es la base del costo.
              <b>«Le queda»</b> descuenta sólo la comisión de esa ruta — el gasto de la flota no
              baja al camión y vive en la pestaña de al lado.
            </p>
          }

          @if (tab() === 'plazas') {
            <div class="rp-plazas">
              @for (p of d.plazas; track p.dpto) {
                <article class="rp-card">
                  <header>
                    <div>
                      <h3>{{ p.plaza || p.dpto_norm }}</h3>
                      <p class="mono rp-dpto">{{ p.dpto }}</p>
                    </div>
                    @if (p.veredicto_plaza !== 'ok') {
                      <p-tag severity="warn" value="sin rutas" styleClass="rp-tag" />
                    }
                  </header>

                  <dl class="rp-dl">
                    <dt>Utilidad bruta de sus rutas</dt>
                    <dd class="mono">{{ p.rutas ? dinero(p.utilidad_bruta) : 'sin medir' }}</dd>
                    <dt>Gasto del departamento</dt>
                    <dd class="mono">{{ dinero(p.gasto) }}</dd>
                    <dt class="fuerte">Resultado</dt>
                    <dd class="mono fuerte" [class.rp-neg]="(p.resultado ?? 0) < 0">
                      {{ p.resultado !== null ? dinero(p.resultado) : 'sin medir' }}
                    </dd>
                  </dl>

                  <ul class="rp-fam">
                    @for (f of p.gasto_por_familia; track f.familia) {
                      <li>
                        <span>{{ familia(f.familia) }}</span>
                        <span class="mono">{{ dinero(f.importe) }}</span>
                        <span class="rp-bar" [style.width.%]="anchoFamilia(f.importe, p.gasto)"></span>
                      </li>
                    }
                  </ul>

                  @if (p.rutas === 0) {
                    <p class="rp-mini">
                      Este departamento gasta pero no tiene ninguna ruta en el resolvedor de
                      identidad, así que su resultado no se puede calcular.
                    </p>
                  }
                </article>
              }
            </div>
          }

          @if (tab() === 'comision') {
            <section class="rp-contraste">
              <div class="rp-cmp">
                <div>
                  <p class="rp-cmp-l">Lo que el libro paga</p>
                  <p class="rp-cmp-v mono">{{ dinero(d.contraste_comision.libro) }}</p>
                  <p class="rp-mini">Comisión más bonos de esta quincena, de la corrida de nómina.</p>
                </div>
                <div>
                  <p class="rp-cmp-l">Lo que la contabilidad registra</p>
                  <p class="rp-cmp-v mono">{{ dinero(d.contraste_comision.contabilidad) }}</p>
                  <p class="rp-mini">Concepto «comisiones» en los tres departamentos de Ruta Directa.</p>
                </div>
                <div>
                  <p class="rp-cmp-l">Diferencia</p>
                  <p class="rp-cmp-v mono" [class.rp-neg]="d.contraste_comision.delta < 0">
                    {{ dinero(d.contraste_comision.delta) }}
                  </p>
                  <p class="rp-mini">
                    Pasa en todas las quincenas medidas, sin una sola excepción. La hipótesis de
                    que se contabilice en la quincena siguiente se probó y no lo explica.
                  </p>
                </div>
              </div>

              <h3 class="rp-h3">El gasto, concepto por concepto</h3>
              <div class="rp-wrap dt-scope">
                <table class="rp-table dt-stack">
                  <caption class="sr-only">Gasto del departamento por concepto</caption>
                  <thead>
                    <tr>
                      <th scope="col">Departamento</th>
                      <th scope="col">Concepto</th>
                      <th scope="col">Familia</th>
                      <th scope="col" class="num">Renglones</th>
                      <th scope="col" class="num">Importe</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (c of d.gasto_por_concepto; track c.dpto + c.concepto) {
                      <tr>
                        <td role="cell" data-label="Departamento" class="dt-id">{{ c.dpto_norm }}</td>
                        <td role="cell" data-label="Concepto">{{ c.concepto_norm || '—' }}</td>
                        <td role="cell" data-label="Familia" class="dim">{{ familia(c.familia) }}</td>
                        <td role="cell" data-label="Renglones" class="num dt-num mono dim">{{ c.lineas }}</td>
                        <td role="cell" data-label="Importe" class="num dt-num mono">{{ dinero(c.importe) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
          }
        }
      </app-load-state>
    </div>
  `,
  styles: [`
    .rp { padding: 16px; display: flex; flex-direction: column; gap: 14px; }
    .rp-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
    .rp-head h1 { margin: 0; font-size: var(--fs-h2); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .rp-sub { margin: 4px 0 0; font-size: var(--fs-sm); color: var(--c-text-3); max-width: 72ch; line-height: 1.5; }
    .rp-period { display: flex; align-items: center; gap: 8px; }
    .rp-period label { font-size: var(--fs-micro); color: var(--c-text-3); text-transform: uppercase; letter-spacing: .06em; }
    .rp-period select {
      padding: 6px 10px; border: 1px solid var(--border-color); border-radius: 6px;
      background: var(--card-bg); color: var(--c-text-1); font-size: var(--fs-sm);
    }
    .rp-proc { margin: 0; font-size: var(--fs-micro); color: var(--c-text-3); }

    .rp-gaps {
      border: 1px solid var(--border-color); border-left: 3px solid var(--c-warn);
      border-radius: 8px; padding: 12px 14px; background: var(--card-bg);
    }
    .rp-gaps h2 { margin: 0; font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .rp-gaps ul { margin: 8px 0 0; padding-left: 18px; }
    .rp-gaps li { font-size: var(--fs-sm); color: var(--c-text-2); line-height: 1.6; }

    .rp-wrap { overflow-x: auto; border: 1px solid var(--border-color); border-radius: 8px; }
    .rp-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .rp-table th {
      text-align: left; padding: 9px 11px; font-weight: var(--fw-medium);
      color: var(--c-text-3); font-size: var(--fs-micro);
      border-bottom: 1px solid var(--border-color); white-space: nowrap;
    }
    .rp-table td { padding: 9px 11px; border-bottom: 1px solid var(--border-color); color: var(--c-text-2); }
    .rp-table tfoot td { border-bottom: none; border-top: 1px solid var(--border-color); color: var(--c-text-1); font-weight: var(--fw-medium); }
    .rp-table .num { text-align: right; }
    .mono { font-variant-numeric: tabular-nums; }
    .dim { color: var(--c-text-3); }
    .fuerte { color: var(--c-text-1); font-weight: var(--fw-medium); }
    .rp-flag { background: var(--overlay-hover); }
    .rp-alto { color: var(--c-ok); font-weight: var(--fw-medium); }
    .rp-bajo { color: var(--warn-fg); }
    .rp-neg { color: var(--bad-fg); }
    .rp-nd { color: var(--c-text-3); font-size: var(--fs-micro); margin-left: 4px; }
    .rp-note { margin: 0; font-size: var(--fs-micro); color: var(--c-text-3); line-height: 1.6; }

    .rp-plazas { display: flex; gap: 14px; flex-wrap: wrap; }
    .rp-card {
      flex: 1 1 320px; border: 1px solid var(--border-color); border-radius: 8px;
      padding: 14px 16px; background: var(--card-bg);
    }
    .rp-card header { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
    .rp-card h3 { margin: 0; font-size: var(--fs-body); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .rp-dpto { margin: 2px 0 0; font-size: var(--fs-micro); color: var(--c-text-3); }
    .rp-dl { margin: 12px 0 0; display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; font-size: var(--fs-sm); }
    .rp-dl dt { color: var(--c-text-3); }
    .rp-dl dd { margin: 0; text-align: right; color: var(--c-text-2); }
    .rp-fam { margin: 12px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 7px; }
    .rp-fam li {
      display: grid; grid-template-columns: 1fr auto; gap: 2px 8px;
      font-size: var(--fs-micro); color: var(--c-text-3);
    }
    .rp-bar { grid-column: 1 / -1; height: 3px; border-radius: 999px; background: var(--action); }
    .rp-mini { margin: 8px 0 0; font-size: var(--fs-micro); color: var(--c-text-3); line-height: 1.55; }

    .rp-contraste { display: flex; flex-direction: column; gap: 14px; }
    .rp-cmp { display: flex; gap: 14px; flex-wrap: wrap; }
    .rp-cmp > div {
      flex: 1 1 260px; border: 1px solid var(--border-color); border-radius: 8px;
      padding: 14px 16px; background: var(--card-bg);
    }
    .rp-cmp-l { margin: 0; font-size: var(--fs-micro); color: var(--c-text-3); text-transform: uppercase; letter-spacing: .06em; }
    .rp-cmp-v { margin: 5px 0 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .rp-h3 { margin: 0; font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--c-text-1); }

    .sr-only {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
    }
  `],
})
export class ComercialRutaDirectaRentabilidadComponent {
  private readonly svc = inject(ComercialService);

  readonly cargando = signal(true);
  readonly data = signal<RouteProfit | null>(null);
  readonly periodos = signal<RouteProfitPeriodo[]>([]);
  readonly periodId = signal<string | null>(null);
  readonly tab = signal('rutas');

  readonly pestanas: SegOption[] = [
    { label: 'Por ruta', value: 'rutas' },
    { label: 'Por plaza', value: 'plazas' },
    { label: 'La comisión', value: 'comision' },
  ];

  /** Ordenadas por margen: lo que más se sale de lo normal queda arriba y abajo. */
  readonly rutasOrdenadas = computed(() => {
    const rs = this.data()?.rutas ?? [];
    return [...rs].sort((a, b) => Number(b.margen_pct ?? 0) - Number(a.margen_pct ?? 0));
  });

  /** El margen de la mediana, para decidir qué es «alto» sin clavar un número. */
  private readonly margenMediano = computed(() => {
    const v = (this.data()?.rutas ?? [])
      .map((r) => Number(r.margen_pct))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    if (!v.length) return null;
    return v[Math.floor(v.length / 2)];
  });

  private readonly kmMediano = computed(() => {
    const v = (this.data()?.rutas ?? [])
      .map((r) => Number(r.venta_por_km))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    if (!v.length) return null;
    return v[Math.floor(v.length / 2)];
  });

  constructor() {
    this.svc.routeProfitPeriodos().subscribe({
      next: (p) => this.periodos.set(p),
      error: () => this.periodos.set([]),
    });
    this.cargar();
  }

  elegir(id: string): void {
    this.periodId.set(id);
    this.cargar();
  }

  private cargar(): void {
    this.cargando.set(true);
    this.svc.routeProfit(this.periodId() ?? undefined).subscribe({
      next: (d) => { this.data.set(d); this.cargando.set(false); },
      error: () => { this.data.set(null); this.cargando.set(false); },
    });
  }

  kpis(d: RouteProfit): MetricStripItem[] {
    const resultado = d.totales.utilidad_bruta - d.totales.gasto_departamento;
    return [
      { label: 'Venta sin IVA', value: d.totales.subtotal, format: 'currency-short',
        sub: `${d.rutas.length} rutas` },
      { label: 'Utilidad bruta', value: d.totales.utilidad_bruta, format: 'currency-short',
        sub: d.totales.margen_pct !== null ? `${d.totales.margen_pct}% sobre la venta` : 'sin medir',
        tone: 'brand' },
      { label: 'Gasto del departamento', value: d.totales.gasto_departamento, format: 'currency-short',
        sub: 'no baja a la camioneta' },
      { label: 'Resultado', value: resultado, format: 'currency-short',
        tone: resultado < 0 ? 'bad' : 'ok',
        sub: 'utilidad bruta menos gasto' },
      { label: 'Kilómetros', value: d.totales.km || 0, format: 'number',
        sub: this.kmSub(d), tone: this.kmSub(d).startsWith('sólo') ? 'muted' : 'default' },
    ];
  }

  /** ⛔ Declara cuántas rutas NO tienen kilometraje: el total engaña si no se dice. */
  private kmSub(d: RouteProfit): string {
    const sin = d.rutas.filter((r) => r.km_veredicto === 'sin_gps').length;
    if (!sin) return 'las ' + d.rutas.length + ' rutas';
    return `sólo ${d.rutas.length - sin} de ${d.rutas.length} rutas`;
  }

  /** Una ruta se destaca cuando su margen se separa de la mediana por 3 puntos o más. */
  esDestacada(r: RouteProfitRuta): boolean {
    return this.margenAlto(r) || this.margenBajo(r);
  }
  margenAlto(r: RouteProfitRuta): boolean {
    const m = this.margenMediano();
    return m !== null && r.margen_pct !== null && Number(r.margen_pct) - m >= 3;
  }
  margenBajo(r: RouteProfitRuta): boolean {
    const m = this.margenMediano();
    return m !== null && r.margen_pct !== null && m - Number(r.margen_pct) >= 3;
  }
  /** Rinde poco por kilómetro: 20% bajo la mediana de las rutas que sí se midieron. */
  kmBajo(r: RouteProfitRuta): boolean {
    const m = this.kmMediano();
    return m !== null && r.venta_por_km !== null && Number(r.venta_por_km) < m * 0.8;
  }

  anchoFamilia(importe: number, total: number): number {
    if (!total) return 0;
    return Math.max(2, Math.round(Math.abs(importe) / Math.abs(total) * 100));
  }

  familia(f: string): string {
    const m: Record<string, string> = {
      combustible: 'Combustible', personal: 'Personal y comisiones', vehiculo: 'Vehículo',
      viaje: 'Viaje y casetas', valores: 'Traslado de valores', local: 'Local y servicios',
      tecnologia: 'Tecnología', otros: 'Otros',
    };
    return m[f] ?? f;
  }

  motivo(m: string): string {
    const t: Record<string, string> = {
      bajo_umbral: 'no alcanzó el tramo',
      sin_fuente: 'sin fuente de venta',
    };
    return t[m] ?? m;
  }

  etiquetaHueco(c: string): string {
    const t: Record<string, string> = {
      rutas_sin_gps: 'Kilómetros que no existen',
      km_antes_del_historial: 'Kilómetros incompletos',
      gasto_no_baja_a_la_ruta: 'El gasto llega al departamento',
      sin_litros: 'Sin litros',
      comision_libro_vs_contabilidad: 'La comisión no cuadra',
    };
    return t[c] ?? c;
  }

  dinero(v: string | number | null): string {
    if (v === null || v === undefined || v === '') return '—';
    return Number(v).toLocaleString('es-MX', {
      style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  }

  entero(v: string | number | null): string {
    if (v === null || v === undefined || v === '') return '—';
    return Number(v).toLocaleString('es-MX', { maximumFractionDigits: 0 });
  }

  /** La fecha llega ya como texto YYYY-MM-DD desde el servidor, sin pasar por Date. */
  dia(iso: string): string {
    const [a, m, d] = iso.slice(0, 10).split('-');
    return `${d}/${m}/${a}`;
  }

  cuando(iso: string | null): string {
    if (!iso) return 'sin medir';
    const d = new Date(iso);
    return d.toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
  }
}
