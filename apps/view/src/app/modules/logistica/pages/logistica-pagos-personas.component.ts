import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import type { ReporteDePagos, RolDelReparto, SolicitudDePersona } from '@megadulces/contracts';
// Por subruta, no por el barrel: ver tsconfig.base.json (bundle inicial).
import { corteVecino, ROL_LABEL, solicitudesDelReporte } from '@megadulces/contracts/http/cierre-viaje';
import { coincideBusqueda } from '@megadulces/ui-web';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { LogisticaService } from '../logistica.service';
import { descargarCsvSolicitudes, descargarPdfSolicitudes } from '../pagos-viaje-documentos';

/**
 * `[EMB.47]` — **Por persona: la solicitud de gasto de cada quien en la catorcena.**
 *
 * La pregunta que contesta: ¿cuánto pide cada persona y con qué renglones lo captura en Kepler?
 * Sale de las mismas operaciones que «Operaciones» (`solicitudesDelReporte`, una sola regla): cada
 * renglón es concepto × destino, sumado en la catorcena, que es como se captura el X-A-15. El PDF
 * lleva una hoja por persona para firmar; el Excel, los renglones para trabajarlos.
 *
 * Es la MISMA pantalla en Logística › Pagos de viaje y en Finanzas › Gastos › Comisiones de
 * logística (allá con su título). Aquí no se escribe nada: la captura está en «Operaciones».
 *
 * Jerarquía: primario = el total a pedir y cuántas operaciones quedan sin repartir; secundario = la
 * fila por persona; terciario = sus renglones y de dónde sale cada peso, en el panel.
 */
@Component({
  selector: 'app-logistica-pagos-personas',
  standalone: true,
  imports: [
    CurrencyPipe, RouterLink, TableModule, ButtonModule, LoadStateComponent, MetricStripComponent, FreshnessPillComponent,
    SidePeekComponent, SucursalPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page pp">
      @if (titulo) {
        <header class="surf-page-head">
          <div class="surf-page-head-text">
            <h1>{{ titulo }}</h1>
            <p class="surf-page-sub">Lo que pide cada persona de Logística en la catorcena, con los renglones tal como se capturan en Kepler.</p>
          </div>
        </header>
      }
      <div class="pp-cabeza">
        <div class="pp-corte" role="group" aria-label="Catorcena">
          <button pButton type="button" [text]="true" size="small" (click)="mover(-1)"
                  [disabled]="!data()" aria-label="Catorcena anterior"><span class="p-button-icon pi pi-chevron-left" aria-hidden="true"></span></button>
          <span class="pp-corte-txt">
            @if (data(); as d) { Catorcena {{ fechaCorta(d.corte.desde) }} a {{ fechaCorta(d.corte.hasta) }} · se paga el {{ fechaCorta(d.corte.pago) }} }
            @else { Catorcena }
          </span>
          <button pButton type="button" [text]="true" size="small" (click)="mover(1)"
                  [disabled]="!data()" aria-label="Catorcena siguiente"><span class="p-button-icon pi pi-chevron-right" aria-hidden="true"></span></button>
        </div>
        <div class="pp-acciones">
          @if (data(); as d) { <app-freshness-pill measures="fetch" [since]="d.leido_at" label="operaciones de Kepler" /> }
          <button pButton type="button" size="small" [outlined]="true" [disabled]="!solicitudes().length || generando()"
                  (click)="pdf(solicitudes())"><span class="p-button-icon p-button-icon-left pi pi-file-pdf" aria-hidden="true"></span><span class="p-button-label">PDF de todos</span></button>
          <button pButton type="button" size="small" [outlined]="true" [disabled]="!solicitudes().length"
                  (click)="excel(solicitudes())"><span class="p-button-icon p-button-icon-left pi pi-file-excel" aria-hidden="true"></span><span class="p-button-label">Excel</span></button>
        </div>
      </div>

      @if (data(); as d) {
        <p class="pp-titular">{{ titular() }}</p>
        @if (pendientes(); as p) {
          @if (p.operaciones) {
            <p class="pp-aviso">
              {{ p.operaciones }} operaci{{ p.operaciones === 1 ? 'ón' : 'ones' }} todavía sin quién fue: lo suyo no aparece aquí hasta capturarlo.
              @if (!titulo) { <a routerLink="/logistica/pagos/viajes">Ir a Operaciones</a> }
            </p>
          }
        }
        <app-metric-strip [items]="kpis()" mode="strip" density="compact" ariaLabel="Solicitudes de la catorcena" />
      }

      <app-load-state [loading]="cargando() && !data()" [error]="error()" [isEmpty]="!!data() && !solicitudes().length"
                      emptyIcon="pi-users" emptyTitle="Nadie tiene nada que pedir en esta catorcena"
                      emptyHint="Las solicitudes salen de las operaciones con chofer, ayudantes o cargadores capturados."
                      (retry)="cargar()">
        <section class="pp-barra" aria-label="Filtros">
          <label class="pp-buscar">
            <span class="sr-only">Buscar persona</span>
            <input type="search" [value]="busqueda()" (input)="busqueda.set($any($event.target).value)"
                   placeholder="Nombre de la persona" autocomplete="off" spellcheck="false" />
          </label>
          <span class="pp-cuenta">{{ filtradas().length }} de {{ solicitudes().length }} personas</span>
        </section>

        <div class="dt-scope">
          <p-table [value]="filtradas()" dataKey="persona_id" selectionMode="single" [selection]="seleccion()"
                   (onRowSelect)="alSeleccionar($event.data)" size="small"
                   class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first dt-stack" [tableStyle]="{ 'min-width': '44rem' }">
            <ng-template #header>
              <tr>
                <th scope="col">Persona</th>
                <th scope="col" class="comm-num">Operaciones</th>
                <th scope="col" class="comm-num">Comisión</th>
                <th scope="col" class="comm-num">Viático</th>
                <th scope="col" class="comm-num">Carga</th>
                <th scope="col" class="comm-num">Total a pedir</th>
              </tr>
            </ng-template>
            <ng-template #body let-s>
              <tr [pSelectableRow]="s" [attr.aria-label]="'Abrir la solicitud de ' + s.persona">
                <td data-label="Persona">{{ s.persona }}<span class="pp-sub">{{ roles(s.roles) }}</span></td>
                <td data-label="Operaciones" class="comm-num">{{ s.operaciones }}</td>
                <td data-label="Comisión" class="comm-num">{{ s.por_concepto.comision | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td data-label="Viático" class="comm-num">{{ s.por_concepto.viatico | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td data-label="Carga" class="comm-num">{{ s.por_concepto.carga | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td data-label="Total a pedir" class="comm-num pp-fuerte">{{ s.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              </tr>
            </ng-template>
            <ng-template #footer>
              <tr>
                <td>Total</td><td></td><td></td><td></td><td></td>
                <td class="comm-num pp-fuerte">{{ total() | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="6" class="pp-vacio">Nadie con ese nombre.</td></tr>
            </ng-template>
          </p-table>
        </div>
      </app-load-state>

      <app-side-peek [open]="!!sel()" (openChange)="!$event && cerrar()" [width]="704"
                     [title]="sel()?.persona ?? ''" [subtitle]="sel() ? roles(sel()!.roles) : null">
        @if (sel(); as s) {
          <div class="pp-peek">
            <div class="pp-peek-head">
              <div>
                <span class="pp-sub">Total a pedir</span>
                <span class="pp-total">{{ s.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
              </div>
              <div class="pp-acciones">
                <button pButton type="button" size="small" [disabled]="generando()" (click)="pdf([s])"><span class="p-button-icon p-button-icon-left pi pi-file-pdf" aria-hidden="true"></span><span class="p-button-label">PDF de la solicitud</span></button>
                <button pButton type="button" size="small" [outlined]="true" (click)="excel([s])"><span class="p-button-icon p-button-icon-left pi pi-file-excel" aria-hidden="true"></span><span class="p-button-label">Excel</span></button>
              </div>
            </div>

            <h3>Para capturar en Kepler</h3>
            <div class="dt-scope">
              <p-table [value]="s.renglones" size="small" class="surf-table surf-table--plain dt-stack">
                <ng-template #header>
                  <tr><th scope="col">Concepto</th><th scope="col">Destino</th><th scope="col" class="comm-num">Operaciones</th><th scope="col" class="comm-num">Importe</th></tr>
                </ng-template>
                <ng-template #body let-r>
                  <tr>
                    <td data-label="Concepto"><span class="pp-codigo">{{ r.codigo }}</span><span class="pp-sub">{{ r.nombre_concepto }}</span></td>
                    <td data-label="Destino">{{ r.destino }}</td>
                    <td data-label="Operaciones" class="comm-num">{{ r.operaciones }}</td>
                    <td data-label="Importe" class="comm-num">{{ r.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  </tr>
                </ng-template>
              </p-table>
            </div>

            <h3>De dónde sale</h3>
            <div class="dt-scope">
              <p-table [value]="s.detalle" size="small" class="surf-table surf-table--plain dt-stack">
                <ng-template #header>
                  <tr><th scope="col">Fecha</th><th scope="col">Guía</th><th scope="col">Destino</th><th scope="col">Papel</th><th scope="col">Concepto</th><th scope="col" class="comm-num">Importe</th></tr>
                </ng-template>
                <ng-template #body let-d>
                  <tr>
                    <td data-label="Fecha">{{ fechaCorta(d.fecha) }}</td>
                    <td data-label="Guía"><span class="pp-codigo">{{ d.guia }}</span><span class="pp-sub">{{ d.sucursal | sucursal }}</span></td>
                    <td data-label="Destino">{{ d.destino }}</td>
                    <td data-label="Papel">{{ rol(d.rol) }}@if (d.fuente === 'kepler') { <span class="pp-sub">de Kepler</span> }</td>
                    <td data-label="Concepto">{{ d.codigo }}</td>
                    <td data-label="Importe" class="comm-num">{{ d.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  </tr>
                </ng-template>
              </p-table>
            </div>
          </div>
        }
      </app-side-peek>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .pp { display: flex; flex-direction: column; gap: var(--sp-3); padding-top: var(--sp-4); }
    .pp-cabeza { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: var(--sp-2); }
    .pp-corte { display: flex; align-items: center; gap: var(--sp-1); }
    .pp-corte-txt { font-weight: var(--fw-medium); font-variant-numeric: tabular-nums; }
    .pp-acciones { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
    .pp-titular { margin: 0; font-size: var(--fs-lg); font-weight: var(--fw-bold); color: var(--fg-1); }
    .pp-aviso { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md); font-size: var(--fs-sm); background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .pp-barra { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-2); }
    .pp-buscar input { min-width: 16rem; padding: var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-md); background: transparent; color: inherit; font: inherit; }
    .pp-buscar input:focus-visible { outline: 2px solid var(--action); outline-offset: 1px; }
    .pp-cuenta { margin-left: auto; font-size: var(--fs-sm); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .pp-sub { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
    .pp-codigo { font-family: var(--font-mono); font-weight: var(--fw-medium); }
    .pp-fuerte { font-weight: var(--fw-bold); }
    .pp-vacio { padding: var(--sp-4); color: var(--text-muted); }
    .pp-peek { display: flex; flex-direction: column; gap: var(--sp-2); }
    .pp-peek-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: var(--sp-3); }
    .pp-total { display: block; font-size: var(--fs-h2); font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; }
    .pp-peek h3 { margin: var(--sp-3) 0 var(--sp-1); font-size: var(--fs-sm); font-weight: var(--fw-bold); }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    @container (max-width: 40rem) { .pp-cuenta { margin-left: 0; } }
  `],
})
export class LogisticaPagosPersonasComponent {
  private readonly api = inject(LogisticaService);
  /** Dentro de Logística › Pagos de viaje el título lo pone el shell; desde Finanzas, la ruta. */
  readonly titulo: string | null = inject(ActivatedRoute).snapshot.data?.['titulo'] ?? null;

  readonly data = signal<ReporteDePagos | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly busqueda = signal('');
  private readonly selId = signal<string | null>(null);
  readonly generando = signal(false);

  /** Una sola regla con «Operaciones»: las solicitudes salen de los renglones de las operaciones. */
  readonly solicitudes = computed<SolicitudDePersona[]>(() => solicitudesDelReporte(this.data()?.operaciones ?? []));
  readonly filtradas = computed(() => {
    const q = this.busqueda();
    return this.solicitudes().filter((s) => coincideBusqueda(q, s.persona));
  });
  readonly sel = computed(() => this.solicitudes().find((s) => s.persona_id === this.selId()) ?? null);
  readonly seleccion = computed(() => this.sel());
  readonly total = computed(() => Math.round(this.solicitudes().reduce((a, s) => a + s.total, 0) * 100) / 100);

  /** Lo que todavía no se puede pedir porque nadie dijo quién fue (se declara, no se esconde). */
  readonly pendientes = computed(() => {
    const os = this.data()?.operaciones ?? [];
    return { operaciones: os.filter((o) => o.faltan.length > 0).length };
  });

  readonly titular = computed(() => {
    const n = this.solicitudes().length;
    if (!n) return 'Todavía nadie tiene nada que pedir en esta catorcena.';
    return `${n} persona${n === 1 ? '' : 's'} pide${n === 1 ? '' : 'n'} ${this.dinero(this.total())} en total esta catorcena.`;
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const ss = this.solicitudes();
    const por = (k: 'comision' | 'viatico' | 'carga') => Math.round(ss.reduce((a, s) => a + s.por_concepto[k], 0) * 100) / 100;
    return [
      { label: 'Total a pedir', value: this.total(), format: 'currency2', tone: 'brand', sub: `${ss.length} personas` },
      { label: 'Comisión', value: por('comision'), format: 'currency2' },
      { label: 'Viático', value: por('viatico'), format: 'currency2' },
      { label: 'Carga', value: por('carga'), format: 'currency2' },
      { label: 'Operaciones sin repartir', value: this.pendientes().operaciones, format: 'number', tone: this.pendientes().operaciones ? 'warn' : 'muted', sub: 'falta quién fue' },
    ];
  });

  constructor() {
    this.cargar();
  }

  cargar(corte?: { desde: string; hasta: string }): void {
    this.cargando.set(true);
    this.error.set(null);
    const d = this.data();
    this.api.getReportePagos(corte ?? (d ? { desde: d.corte.desde, hasta: d.corte.hasta } : undefined)).subscribe({
      next: (r) => { this.data.set(r); this.cargando.set(false); },
      error: (e) => { this.cargando.set(false); this.error.set(e?.error?.message ?? 'No se pudo leer la catorcena.'); },
    });
  }

  mover(paso: -1 | 1): void {
    const d = this.data();
    if (!d) return;
    const c = corteVecino(d.corte, paso);
    this.cerrar();
    this.data.set(null);
    this.cargar({ desde: c.desde, hasta: c.hasta });
  }

  /** La tabla entrega una fila, varias o ninguna: aquí la selección es de UNA fila. */
  alSeleccionar(s: SolicitudDePersona | SolicitudDePersona[] | undefined): void {
    if (s && !Array.isArray(s)) this.selId.set(s.persona_id);
  }

  cerrar(): void {
    this.selId.set(null);
  }

  async pdf(ss: SolicitudDePersona[]): Promise<void> {
    const d = this.data();
    if (!d || !ss.length || this.generando()) return;
    this.generando.set(true);
    try {
      await descargarPdfSolicitudes(ss, d.corte, d.leido_at);
    } finally {
      this.generando.set(false);
    }
  }

  excel(ss: SolicitudDePersona[]): void {
    const d = this.data();
    if (d && ss.length) descargarCsvSolicitudes(ss, d.corte);
  }

  roles(rs: RolDelReparto[]): string {
    return rs.map((r) => ROL_LABEL[r]).join(' · ');
  }
  rol(r: RolDelReparto): string {
    return ROL_LABEL[r];
  }
  fechaCorta(iso: string): string {
    const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
  }
  private dinero(n: number): string {
    return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }
}
