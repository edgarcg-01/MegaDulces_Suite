import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient, HttpParams } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import type { ConceptoPago, PagoViaje } from '@megadulces/contracts';
import { CONCEPTO_KEPLER } from '@megadulces/contracts';
import { environment } from '../../../../environments/environment';

interface Corte { desde: string; hasta: string; pago: string }
interface ResumenPersona {
  driver_id: string; persona: string; roles: string[]; viajes: number; cargas: number;
  liberado: Record<ConceptoPago, number>; liberado_total: number;
  retenido_total: number; retenidos: number; en_vale_total: number; vales: string[];
}
interface CorteDeLogistica { corte: Corte; personas: ResumenPersona[]; totales: { liberado: number; retenido: number; en_vale: number } }
interface DetallePersona { corte: Corte; driver_id: string; persona: string; pagables: PagoViaje[]; retenidos: PagoViaje[]; en_vale: PagoViaje[] }
interface ValeCreado { id: string; importe: number; renglones: number; persona: string }

const DIA = 86_400_000;
const mover = (iso: string, dias: number) => new Date(Date.parse(iso + 'T00:00:00Z') + dias * DIA).toISOString().slice(0, 10);

/**
 * `[EMB.29]` — Comisiones y viáticos de logística por corte de 14 días (ADR-091).
 *
 * Una fila por persona: lo LIBERADO (viajes cerrados y cargas en Kepler) que todavía no está en
 * un vale, lo RETENIDO (viajes abiertos o guías incompletas, con su motivo) y lo que ya está en
 * un vale. «Armar vale» crea el vale de Gastos con la hoja de viajes; lo aprueba otra persona
 * en «Aprobación de gastos». Ningún monto se teclea aquí.
 */
@Component({
  selector: 'app-finanzas-comisiones-logistica',
  standalone: true,
  imports: [CommonModule, RouterLink, ButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in cl">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Comisiones de logística</h1>
          <p class="surf-page-sub">Un vale por persona con los viajes cerrados y las cargas registradas en Kepler. Lo que no se cerró pasa al siguiente corte.</p>
        </div>
        <div class="cl-corte" role="group" aria-label="Corte">
          <button pButton type="button" [text]="true" aria-label="Corte anterior" (click)="moverCorte(-14)"><span class="p-button-icon pi pi-chevron-left" aria-hidden="true"></span></button>
          <span class="cl-corte-txt">
            @if (data(); as d) { {{ d.corte.desde | date:'d MMM':'UTC':'es-MX' }} – {{ d.corte.hasta | date:'d MMM yyyy':'UTC':'es-MX' }} · pago {{ d.corte.pago | date:'EEE d MMM':'UTC':'es-MX' }} }
            @else { Corte }
          </span>
          <button pButton type="button" [text]="true" aria-label="Corte siguiente" (click)="moverCorte(14)"><span class="p-button-icon pi pi-chevron-right" aria-hidden="true"></span></button>
        </div>
      </header>

      @if (aviso(); as a) { <div class="cl-msg" [class.cl-msg-ok]="a.ok" role="status">{{ a.texto }} @if (a.ok) { <a routerLink="/finanzas/aprobacion-gastos">Ir a Aprobación de gastos</a> }</div> }
      @if (error()) { <div class="cl-msg cl-msg-bad" role="alert">{{ error() }}</div> }

      @if (data(); as d) {
        <div class="cl-kpis">
          <div class="cl-kpi"><span>Liberado sin vale</span><strong>{{ d.totales.liberado | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong></div>
          <div class="cl-kpi"><span>Ya en vale</span><strong>{{ d.totales.en_vale | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong></div>
          <div class="cl-kpi cl-kpi-warn"><span>Retenido (pasa al siguiente corte)</span><strong>{{ d.totales.retenido | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong></div>
          <div class="cl-kpi"><span>Personas</span><strong>{{ d.personas.length }}</strong></div>
        </div>

        <div class="cl-scroll">
          <table class="cl-table">
            <thead>
              <tr>
                <th scope="col">Persona</th><th scope="col">Papel</th><th scope="col" class="num">Viajes</th><th scope="col" class="num">Cargas</th>
                <th scope="col" class="num">075 Comisión</th><th scope="col" class="num">128 Viáticos</th><th scope="col" class="num">186 Maniobra</th>
                <th scope="col" class="num">A pagar</th><th scope="col" class="num">Retenido</th><th scope="col">Vale</th>
              </tr>
            </thead>
            <tbody>
              @for (p of d.personas; track p.driver_id) {
                <tr class="cl-row" [class.cl-sel]="sel() === p.driver_id" tabindex="0" (click)="abrir(p)" (keydown.enter)="abrir(p)">
                  <td><strong>{{ p.persona }}</strong></td>
                  <td>{{ p.roles.join(', ') }}</td>
                  <td class="num">{{ p.viajes || '—' }}</td>
                  <td class="num">{{ p.cargas || '—' }}</td>
                  <td class="num">{{ p.liberado.comision ? (p.liberado.comision | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</td>
                  <td class="num">{{ p.liberado.viatico ? (p.liberado.viatico | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</td>
                  <td class="num">{{ p.liberado.maniobra_carga ? (p.liberado.maniobra_carga | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</td>
                  <td class="num"><strong>{{ p.liberado_total | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong></td>
                  <td class="num">@if (p.retenido_total) { <span class="cl-pill cl-pill-warn">{{ p.retenido_total | currency:'MXN':'symbol-narrow':'1.2-2' }}</span> } @else { — }</td>
                  <td>
                    @if (p.vales.length) { <span class="cl-pill cl-pill-info">{{ p.vales.length }} vale{{ p.vales.length === 1 ? '' : 's' }}</span> }
                    @else if (p.liberado_total > 0) { <span class="cl-pill">Por armar</span> }
                    @else { — }
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="10" class="cl-empty">No hay viajes ni cargas de logística en este corte.</td></tr>
              }
            </tbody>
          </table>
        </div>
      } @else if (!error()) {
        <div class="cl-empty">Cargando el corte…</div>
      }

      @if (detalle(); as det) {
        <section class="cl-detail" aria-label="Detalle de la persona">
          <header class="cl-detail-head">
            <div>
              <h2>{{ det.persona }}</h2>
              <span class="cl-sub">Corte {{ det.corte.desde }} a {{ det.corte.hasta }}</span>
            </div>
            <button pButton type="button" [disabled]="!det.pagables.length" [loading]="creando()" (click)="armarVale(det)"><span class="p-button-icon p-button-icon-left pi pi-file-plus" aria-hidden="true"></span><span class="p-button-label">Armar vale por {{ totalPagable() | currency:'MXN':'symbol-narrow':'1.2-2' }}</span></button>
          </header>

          <h3>Viajes y cargas que se pagan</h3>
          <ng-container *ngTemplateOutlet="tabla; context: { $implicit: det.pagables, vacio: 'No hay nada liberado sin vale.' }"></ng-container>

          @if (det.retenidos.length) {
            <h3 class="cl-warn">No se paga todavía</h3>
            <ng-container *ngTemplateOutlet="tabla; context: { $implicit: det.retenidos, vacio: '' }"></ng-container>
          }
          @if (det.en_vale.length) {
            <h3>Ya en un vale</h3>
            <ng-container *ngTemplateOutlet="tabla; context: { $implicit: det.en_vale, vacio: '' }"></ng-container>
          }
        </section>
      }

      <ng-template #tabla let-items let-vacio="vacio">
        <div class="cl-scroll">
          <table class="cl-table">
            <thead><tr><th scope="col">Fecha</th><th scope="col">Embarque</th><th scope="col">Papel</th><th scope="col">Concepto</th><th scope="col">Estado</th><th scope="col" class="num">Importe</th></tr></thead>
            <tbody>
              @for (i of items; track i.source_id + i.concept) {
                <tr>
                  <td>{{ i.shipment_date | date:'EEE d MMM':'UTC':'es-MX' }}</td>
                  <td><code>{{ i.shipment_folio }}</code>@if (i.kepler_guia) { <span class="cl-sub">guía Kepler {{ i.kepler_sucursal }}-{{ i.kepler_guia }}</span> }</td>
                  <td>{{ i.rol }}</td>
                  <td>{{ concepto(i.concept) }}</td>
                  <td>{{ i.motivo }}@if (i.vale_status) { <span class="cl-sub">Vale: {{ i.vale_status }}</span> }</td>
                  <td class="num">{{ i.amount | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                </tr>
              } @empty {
                @if (vacio) { <tr><td colspan="6" class="cl-empty">{{ vacio }}</td></tr> }
              }
            </tbody>
          </table>
        </div>
      </ng-template>
    </div>
  `,
  styles: [`
    .cl .surf-page-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .75rem; align-items: flex-end; }
    .cl-corte { display: flex; align-items: center; gap: .25rem; }
    .cl-corte-txt { font-size: var(--fs-sm); font-variant-numeric: tabular-nums; min-width: 15rem; text-align: center; }
    .cl-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: .75rem; margin: 1rem 0; }
    .cl-kpi { border: 1px solid var(--border-color); border-radius: 10px; padding: .75rem 1rem; background: var(--card-bg); display: flex; flex-direction: column; gap: .2rem; }
    .cl-kpi span { font-size: var(--fs-xs); color: var(--text-muted); }
    .cl-kpi strong { font-size: 1.35rem; font-variant-numeric: tabular-nums; }
    .cl-kpi-warn { border-color: var(--warn-border); background: var(--warn-soft-bg); }
    .cl-kpi-warn span, .cl-kpi-warn strong { color: var(--warn-soft-fg); }
    .cl-scroll { overflow-x: auto; border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-bg); }
    .cl-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .cl-table th { text-align: left; font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); padding: .55rem .7rem; border-bottom: 1px solid var(--border-color); background: var(--hover-bg); white-space: nowrap; }
    .cl-table td { padding: .55rem .7rem; border-bottom: 1px solid var(--hover-bg); vertical-align: top; }
    .cl-table .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .cl-table code { font-family: var(--font-mono); font-size: var(--fs-xs); }
    .cl-row { cursor: pointer; }
    .cl-row:hover td { background: var(--hover-bg); }
    .cl-row:focus-visible { outline: 2px solid var(--action); outline-offset: -2px; }
    .cl-sel td { background: var(--hover-bg); }
    .cl-sub { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
    .cl-pill { display: inline-block; padding: .1rem .55rem; border-radius: 999px; font-size: var(--fs-xs); background: var(--hover-bg); white-space: nowrap; }
    .cl-pill-warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .cl-pill-info { background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .cl-empty { padding: 1rem; color: var(--text-muted); font-size: var(--fs-sm); }
    .cl-detail { margin-top: 1.25rem; }
    .cl-detail-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .75rem; align-items: center; margin-bottom: .5rem; }
    .cl-detail h2 { margin: 0; font-size: 1.15rem; }
    .cl-detail h3 { font-size: var(--fs-sm); margin: 1rem 0 .4rem; }
    .cl-warn { color: var(--warn-soft-fg); }
    .cl-msg { padding: .6rem .8rem; border-radius: 8px; font-size: var(--fs-sm); margin: .75rem 0; background: var(--hover-bg); }
    .cl-msg-ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .cl-msg-bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
  `],
})
export class FinanzasComisionesLogisticaComponent {
  private readonly http = inject(HttpClient);
  private readonly api = `${environment.apiUrl}/finance/trip-pay`;

  readonly data = signal<CorteDeLogistica | null>(null);
  readonly detalle = signal<DetallePersona | null>(null);
  readonly sel = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly aviso = signal<{ ok: boolean; texto: string } | null>(null);
  readonly creando = signal(false);
  private corte: { desde: string; hasta: string } | null = null;

  readonly totalPagable = computed(() =>
    Math.round((this.detalle()?.pagables ?? []).reduce((s, i) => s + i.amount, 0) * 100) / 100,
  );

  constructor() { this.cargar(); }

  private params(): HttpParams {
    let p = new HttpParams();
    if (this.corte) p = p.set('desde', this.corte.desde).set('hasta', this.corte.hasta);
    return p;
  }

  cargar() {
    this.error.set(null);
    this.http.get<CorteDeLogistica>(`${this.api}/corte`, { params: this.params() }).subscribe({
      next: (d) => {
        this.data.set(d);
        this.corte = { desde: d.corte.desde, hasta: d.corte.hasta };
        const s = this.sel();
        if (s) this.cargarPersona(s);
      },
      error: (e) => this.error.set(e?.error?.message ?? 'No se pudo leer el corte.'),
    });
  }

  moverCorte(dias: number) {
    const d = this.data();
    if (!d) return;
    this.corte = { desde: mover(d.corte.desde, dias), hasta: mover(d.corte.hasta, dias) };
    this.sel.set(null);
    this.detalle.set(null);
    this.aviso.set(null);
    this.cargar();
  }

  abrir(p: ResumenPersona) {
    this.sel.set(p.driver_id);
    this.aviso.set(null);
    this.cargarPersona(p.driver_id);
  }

  private cargarPersona(id: string) {
    this.http.get<DetallePersona>(`${this.api}/personas/${id}`, { params: this.params() }).subscribe({
      next: (d) => this.detalle.set(d),
      error: (e) => this.error.set(e?.error?.message ?? 'No se pudo leer el detalle.'),
    });
  }

  armarVale(det: DetallePersona) {
    this.creando.set(true);
    this.http.post<ValeCreado>(`${this.api}/vales`, { driver_id: det.driver_id, desde: det.corte.desde, hasta: det.corte.hasta }).subscribe({
      next: (v) => {
        this.creando.set(false);
        this.aviso.set({ ok: true, texto: `Vale de ${v.persona} por $${v.importe.toFixed(2)} (${v.renglones} renglones) listo para aprobación.` });
        this.cargar();
      },
      error: (e) => { this.creando.set(false); this.error.set(e?.error?.message ?? 'No se pudo armar el vale.'); },
    });
  }

  concepto(c: ConceptoPago) { return `${CONCEPTO_KEPLER[c].codigo} ${CONCEPTO_KEPLER[c].nombre}`; }
}
