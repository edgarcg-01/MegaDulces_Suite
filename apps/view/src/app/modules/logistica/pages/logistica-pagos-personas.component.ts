import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CurrencyPipe, NgTemplateOutlet } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import type { ConceptoPago, CorteDeLogistica, DetallePersona, ResumenPersona } from '@megadulces/contracts';
// Por subruta, no por el barrel: ver tsconfig.base.json (bundle inicial).
import { CONCEPTO_KEPLER, corteVecino } from '@megadulces/contracts/http/cierre-viaje';
import { coincideBusqueda } from '@megadulces/ui-web';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { LogisticaService } from '../logistica.service';

/**
 * `[EMB.43]` — **Por persona: lo que cobra cada quien en la catorcena** (antes `[EMB.29]`
 * «Comisiones de logística», que vivía sólo en Finanzas y a mano). Es la MISMA pantalla en los dos
 * lugares: Logística › Pagos de viaje y Finanzas › Gastos › Comisiones de logística.
 *
 * La pregunta que contesta: ¿cuánto se le paga a cada persona esta catorcena, y por qué? Lo
 * LIBERADO (viajes cerrados y cargas en Kepler) que no está en un vale se paga; lo RETENIDO pasa al
 * siguiente corte con su motivo; lo que ya está en un vale no se vuelve a pagar. «Armar vale» crea
 * el vale de Gastos con la hoja de viajes; lo aprueba otra persona. Ningún monto se teclea aquí.
 *
 * Jerarquía: primario = lo que hay por pagar sin vale; secundario = la fila por persona;
 * terciario = viaje por viaje, en el panel.
 */
@Component({
  selector: 'app-logistica-pagos-personas',
  standalone: true,
  imports: [
    CurrencyPipe, NgTemplateOutlet, RouterLink, TableModule, ButtonModule, TagModule, LoadStateComponent,
    MetricStripComponent, FreshnessPillComponent, SidePeekComponent, SucursalPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page pp">
      @if (titulo) {
        <header class="surf-page-head">
          <div class="surf-page-head-text">
            <h1>{{ titulo }}</h1>
            <p class="surf-page-sub">Un vale por persona con los viajes cerrados y las cargas registradas en Kepler. Lo que no se cerró pasa al siguiente corte.</p>
          </div>
        </header>
      }
      <div class="pp-cabeza">
        <div class="pp-corte" role="group" aria-label="Catorcena">
          <button pButton type="button" [text]="true" size="small" (click)="mover(-1)"
                  [disabled]="!data()" aria-label="Catorcena anterior"><span class="p-button-icon pi pi-chevron-left" aria-hidden="true"></span></button>
          <span class="pp-corte-txt">
            @if (data(); as d) { Catorcena {{ fechaCorta(d.corte.desde) }} – {{ fechaCorta(d.corte.hasta) }} · se paga el {{ fechaCorta(d.corte.pago) }} }
            @else { Catorcena }
          </span>
          <button pButton type="button" [text]="true" size="small" (click)="mover(1)"
                  [disabled]="!data()" aria-label="Catorcena siguiente"><span class="p-button-icon pi pi-chevron-right" aria-hidden="true"></span></button>
        </div>
        @if (leidoAt(); as t) { <app-freshness-pill measures="fetch" [since]="t" label="pagos de viaje" /> }
      </div>

      @if (aviso(); as a) {
        <div class="pp-msg pp-msg-ok" role="status">{{ a }} <a routerLink="/finanzas/aprobacion-gastos">Ir a Aprobación de gastos</a></div>
      }

      @if (data(); as d) {
        <p class="pp-titular">{{ titular() }}</p>
        <app-metric-strip [items]="kpis()" mode="strip" density="compact" ariaLabel="Pagos de la catorcena" />
      }

      <app-load-state [loading]="cargando() && !data()" [error]="error()" [isEmpty]="!!data() && !data()!.personas.length"
                      emptyIcon="pi-users" emptyTitle="Nadie cobra en esta catorcena"
                      emptyHint="Aparece quien tenga un viaje con la guía completa o una carga registrada. Complétalos en «Por completar»."
                      (retry)="cargar()">
        <section class="pp-barra" aria-label="Filtros">
          <label class="pp-buscar">
            <span class="sr-only">Buscar persona</span>
            <input type="search" [value]="busqueda()" (input)="busqueda.set($any($event.target).value)"
                   placeholder="Nombre" autocomplete="off" spellcheck="false" />
          </label>
          <span class="pp-cuenta">{{ filtradas().length }} de {{ data()?.personas?.length ?? 0 }} personas</span>
        </section>
        <div class="dt-scope">
          <p-table [value]="filtradas()" dataKey="driver_id" selectionMode="single" [selection]="seleccion()"
                   (onRowSelect)="abrir($event.data)"
                   size="small" class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first dt-stack"
                   [tableStyle]="{ 'min-width': '60rem' }">
            <ng-template #header>
              <tr>
                <th scope="col">Persona</th>
                <th scope="col" class="comm-num">Viajes</th>
                <th scope="col" class="comm-num">Cargas</th>
                <th scope="col" class="comm-num">{{ concepto('comision') }}</th>
                <th scope="col" class="comm-num">{{ concepto('viatico') }}</th>
                <th scope="col" class="comm-num">{{ concepto('maniobra_carga') }}</th>
                <th scope="col" class="comm-num">A pagar</th>
                <th scope="col" class="comm-num">Retenido</th>
                <th scope="col">Vale</th>
              </tr>
            </ng-template>
            <ng-template #body let-p>
              <tr [pSelectableRow]="p" [attr.aria-label]="'Ver el detalle de ' + p.persona">
                <td data-label="Persona"><strong>{{ p.persona }}</strong><span class="pp-sub">{{ p.roles.join(' · ') }}</span></td>
                <td data-label="Viajes" class="comm-num">{{ p.viajes || '—' }}</td>
                <td data-label="Cargas" class="comm-num">{{ p.cargas || '—' }}</td>
                <td data-label="Comisión" class="comm-num">{{ p.liberado.comision ? (p.liberado.comision | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</td>
                <td data-label="Viáticos" class="comm-num">{{ p.liberado.viatico ? (p.liberado.viatico | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</td>
                <td data-label="Carga" class="comm-num">{{ p.liberado.maniobra_carga ? (p.liberado.maniobra_carga | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</td>
                <td data-label="A pagar" class="comm-num"><strong>{{ p.liberado_total | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong></td>
                <td data-label="Retenido" class="comm-num">
                  @if (p.retenido_total) { <p-tag [value]="(p.retenido_total | currency:'MXN':'symbol-narrow':'1.2-2') ?? ''" severity="warn" /> } @else { — }
                </td>
                <td data-label="Vale">
                  @if (p.vales.length) { <p-tag [value]="p.vales.length + (p.vales.length === 1 ? ' vale' : ' vales')" severity="info" /> }
                  @else if (p.liberado_total > 0) { <p-tag value="Por armar" severity="secondary" /> }
                  @else { — }
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="9" class="pp-vacio">Nadie con ese nombre.</td></tr>
            </ng-template>
          </p-table>
        </div>
      </app-load-state>

      <app-side-peek [open]="!!sel()" (openChange)="!$event && cerrar()" width="44rem"
                     [title]="detalle()?.persona ?? personaSel()?.persona ?? ''"
                     [subtitle]="data() ? 'Catorcena ' + fechaCorta(data()!.corte.desde) + ' – ' + fechaCorta(data()!.corte.hasta) : null">
        <app-load-state [loading]="!detalle() && !errorDetalle()" [error]="errorDetalle()" [isEmpty]="false" [skeletonRows]="4"
                        (retry)="cargarPersona(sel()!)">
          @if (detalle(); as det) {
            <div class="pp-peek">
              <div class="pp-peek-head">
                <div>
                  <span class="pp-sub">Por pagar en este vale</span>
                  <strong class="pp-total">{{ totalPagable() | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong>
                </div>
                @if (puedeArmar()) {
                  <button pButton type="button" [loading]="creando()"
                          [disabled]="!det.pagables.length || creando()" (click)="armarVale(det)"><span class="p-button-icon p-button-icon-left pi pi-file-plus" aria-hidden="true"></span><span class="p-button-label">Armar vale</span></button>
                }
              </div>
              @if (errorVale(); as e) { <div class="pp-msg pp-msg-bad" role="alert">{{ e }}</div> }
              @if (!puedeArmar()) { <p class="pp-sub">Armar el vale lo hace quien gestiona Pagos de viaje; aquí sólo se consulta.</p> }

              <h3>Lo que se paga</h3>
              <ng-container *ngTemplateOutlet="renglones; context: { $implicit: det.pagables, vacio: 'No hay nada liberado sin vale.' }"></ng-container>
              @if (det.retenidos.length) {
                <h3 class="pp-warn">No se paga todavía (pasa al siguiente corte)</h3>
                <ng-container *ngTemplateOutlet="renglones; context: { $implicit: det.retenidos, vacio: '' }"></ng-container>
              }
              @if (det.en_vale.length) {
                <h3>Ya en un vale</h3>
                <ng-container *ngTemplateOutlet="renglones; context: { $implicit: det.en_vale, vacio: '' }"></ng-container>
              }
            </div>
          }
        </app-load-state>
      </app-side-peek>

      <ng-template #renglones let-items let-vacio="vacio">
        <div class="dt-scope">
          <p-table [value]="items" size="small" class="surf-table surf-table--plain dt-stack">
            <ng-template #header>
              <tr>
                <th scope="col">Fecha</th><th scope="col">Viaje</th><th scope="col">Papel</th>
                <th scope="col">Concepto</th><th scope="col">Estado</th><th scope="col" class="comm-num">Importe</th>
              </tr>
            </ng-template>
            <ng-template #body let-i>
              <tr>
                <td data-label="Fecha">{{ fechaCorta(i.shipment_date) }}</td>
                <td data-label="Viaje">
                  <span class="pp-folio">{{ i.shipment_folio }}</span>
                  @if (i.kepler_guia) { <span class="pp-sub">{{ i.kepler_sucursal | sucursal }} · guía {{ i.kepler_guia }}</span> }
                </td>
                <td data-label="Papel">{{ i.rol }}</td>
                <td data-label="Concepto">{{ concepto(i.concept) }}</td>
                <td data-label="Estado">{{ i.motivo }}@if (i.vale_status) { <span class="pp-sub">Vale: {{ i.vale_status }}</span> }</td>
                <td data-label="Importe" class="comm-num">{{ i.amount | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              @if (vacio) { <tr><td colspan="6" class="pp-vacio">{{ vacio }}</td></tr> }
            </ng-template>
          </p-table>
        </div>
      </ng-template>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .pp { display: flex; flex-direction: column; gap: var(--sp-3); padding-top: var(--sp-4); }
    .pp-cabeza { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: var(--sp-2); }
    .pp-corte { display: flex; align-items: center; gap: var(--sp-1); }
    .pp-corte-txt { font-weight: var(--fw-medium); font-variant-numeric: tabular-nums; }
    .pp-titular { margin: 0; font-size: var(--fs-lg); font-weight: var(--fw-bold); color: var(--fg-1); }
    .pp-barra { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-2); }
    .pp-buscar input { min-width: 16rem; padding: var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-md); background: transparent; color: inherit; font: inherit; }
    .pp-buscar input:focus-visible { outline: 2px solid var(--action); outline-offset: 1px; }
    .pp-cuenta { margin-left: auto; font-size: var(--fs-sm); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .pp-sub { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
    .pp-folio { font-family: var(--font-mono); font-size: var(--fs-xs); }
    .pp-vacio { padding: var(--sp-4); color: var(--text-muted); }
    .pp-peek { display: flex; flex-direction: column; gap: var(--sp-2); }
    .pp-peek-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: var(--sp-3); }
    .pp-total { display: block; font-size: var(--fs-h2); font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; }
    .pp-peek h3 { margin: var(--sp-3) 0 var(--sp-1); font-size: var(--fs-sm); font-weight: var(--fw-bold); }
    .pp-warn { color: var(--warn-soft-fg); }
    .pp-msg { padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md); font-size: var(--fs-sm); }
    .pp-msg-ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .pp-msg-bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    @container (max-width: 40rem) { .pp-cuenta { margin-left: 0; } }
  `],
})
export class LogisticaPagosPersonasComponent {
  private readonly api = inject(LogisticaService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  /** Dentro de Logística › Pagos de viaje el título lo pone el shell; desde Finanzas, la ruta. */
  readonly titulo: string | null = inject(ActivatedRoute).snapshot.data?.['titulo'] ?? null;

  readonly data = signal<CorteDeLogistica | null>(null);
  readonly leidoAt = signal<string | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly busqueda = signal('');
  readonly sel = signal<string | null>(null);
  readonly detalle = signal<DetallePersona | null>(null);
  readonly errorDetalle = signal<string | null>(null);
  readonly aviso = signal<string | null>(null);
  readonly errorVale = signal<string | null>(null);
  readonly creando = signal(false);

  /** Armar el vale ESCRIBE: lo mismo que pide el servidor (`POST /finance/trip-pay/vales`). */
  readonly puedeArmar = computed(() => {
    if (this.perms.isAdmin()) return true;
    const p = this.auth.user()?.permissions ?? {};
    return p[Permission.LOGISTICS_PAGOS_GESTIONAR] === true || p[Permission.FINANCE_EXPENSES_COMPROBAR] === true
      || p[Permission.LOGISTICS_SHIPMENTS_GESTIONAR] === true;
  });

  readonly filtradas = computed(() => {
    const q = this.busqueda();
    return (this.data()?.personas ?? []).filter((p) => coincideBusqueda(q, p.persona, p.roles.join(' ')));
  });
  readonly personaSel = computed(() => (this.data()?.personas ?? []).find((p) => p.driver_id === this.sel()) ?? null);
  readonly seleccion = computed(() => this.personaSel());

  readonly totalPagable = computed(() =>
    Math.round((this.detalle()?.pagables ?? []).reduce((s, i) => s + Number(i.amount || 0), 0) * 100) / 100,
  );

  readonly titular = computed(() => {
    const d = this.data();
    if (!d) return '';
    const porArmar = d.personas.filter((p) => p.liberado_total > 0 && !p.vales.length).length;
    if (!d.personas.length) return 'Nadie cobra en esta catorcena.';
    return d.totales.liberado > 0
      ? `Hay ${this.dinero(d.totales.liberado)} por pagar sin vale` + (porArmar ? ` (${porArmar} persona${porArmar === 1 ? '' : 's'} con vale por armar).` : '.')
      : 'No queda nada liberado sin vale en esta catorcena.';
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.data();
    if (!d) return [];
    return [
      { label: 'Por pagar sin vale', value: d.totales.liberado, format: 'currency2', tone: d.totales.liberado > 0 ? 'brand' : 'muted' },
      { label: 'Ya en vale', value: d.totales.en_vale, format: 'currency2' },
      { label: 'Retenido', value: d.totales.retenido, format: 'currency2', tone: d.totales.retenido > 0 ? 'warn' : 'muted', sub: 'pasa al siguiente corte' },
      { label: 'Personas', value: d.personas.length, format: 'number' },
    ];
  });

  constructor() {
    this.cargar();
  }

  cargar(corte?: { desde: string; hasta: string }): void {
    this.cargando.set(true);
    this.error.set(null);
    const d = this.data();
    const pedido = corte ?? (d ? { desde: d.corte.desde, hasta: d.corte.hasta } : undefined);
    this.api.getCortePagos(pedido).subscribe({
      next: (r) => {
        this.data.set(r);
        this.leidoAt.set(new Date().toISOString());
        this.cargando.set(false);
        const s = this.sel();
        if (s) this.cargarPersona(s);
      },
      error: (e) => { this.cargando.set(false); this.error.set(e?.error?.message ?? 'No se pudo leer la catorcena.'); },
    });
  }

  mover(paso: -1 | 1): void {
    const d = this.data();
    if (!d) return;
    const c = corteVecino(d.corte, paso);
    this.cerrar();
    this.aviso.set(null);
    this.data.set(null);
    this.cargar({ desde: c.desde, hasta: c.hasta });
  }

  abrir(p: ResumenPersona): void {
    this.sel.set(p.driver_id);
    this.errorVale.set(null);
    this.cargarPersona(p.driver_id);
  }

  cerrar(): void {
    this.sel.set(null);
    this.detalle.set(null);
    this.errorDetalle.set(null);
  }

  cargarPersona(id: string): void {
    const d = this.data();
    if (!d) return;
    this.detalle.set(null);
    this.errorDetalle.set(null);
    this.api.getPersonaPagos(id, d.corte).subscribe({
      next: (r) => this.detalle.set(r),
      error: (e) => this.errorDetalle.set(e?.error?.message ?? 'No se pudo leer el detalle.'),
    });
  }

  armarVale(det: DetallePersona): void {
    if (this.creando() || !det.pagables.length) return;
    this.creando.set(true);
    this.errorVale.set(null);
    this.api.armarValePagos(det.driver_id, det.corte).subscribe({
      next: (v) => {
        this.creando.set(false);
        this.aviso.set(`Vale de ${v.persona} por ${this.dinero(v.importe)} (${v.renglones} renglones) listo para aprobación.`);
        this.cargar();
      },
      error: (e) => { this.creando.set(false); this.errorVale.set(e?.error?.message ?? 'No se pudo armar el vale.'); },
    });
  }

  concepto(c: ConceptoPago): string {
    return `${CONCEPTO_KEPLER[c].codigo} ${CONCEPTO_KEPLER[c].nombre}`;
  }
  fechaCorta(iso: string): string {
    const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
  }
  private dinero(n: number): string {
    return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }
}

