import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { TableModule } from 'primeng/table';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import {
  ComercialService,
  type CommissionDesglose,
  type CommissionDesgloseTicket,
  type CommissionLine,
} from '../comercial.service';

/**
 * `[RD.111]` **Por qué este chofer cobra lo que cobra**, del total al renglón del ticket.
 *
 * Edgar, 2026-11-04: *«al darle clic a cada vendedor me pueda desglosar por qué esa comisión,
 * o sea absolutamente de todo: el desglose del desglose del desglose»*.
 *
 * La escalera, en el orden en que la decide el motor:
 *   venta del periodo → escalón del tabulador → % sobre la base → parte del chofer
 *   → bonos (los que cumplió y los que no) → nómina de banco → a pagar
 * y abajo la venta día por día → los tickets del día → los renglones del ticket.
 *
 * ⭐ Nada se recalcula con una regla propia: el escalón sale de los escalones que guardó el
 * motor y la cuenta se COMPRUEBA contra la línea congelada. Si la suma de los días no es la venta
 * de la corrida (llegó venta después de calcular) o la cuenta no da la comisión, se dice en
 * pantalla — un desglose que no suma a lo que explica manda a buscar una diferencia que no existe.
 *
 * Lo que no se puede mostrar se declara: el cliente llega con su clave (el envío desde la
 * camioneta no trae nombre), y el subtotal sin impuestos existe por día, no por renglón.
 */
@Component({
  selector: 'app-comisiones-desglose',
  standalone: true,
  imports: [TableModule, LoadStateComponent, MetricStripComponent, FreshnessPillComponent, ContextHelpComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="dg">
      <!-- Nivel 0: la respuesta -->
      <section class="dg-answer" aria-label="Lo que se paga">
        <app-metric-strip [items]="tira()" ariaLabel="Lo que cobra este chofer" />
        <p class="dg-frase">{{ frase() }}</p>
        <div class="dg-meta">
          <app-freshness-pill measures="data" [since]="ventaMedida()" label="Venta medida" [staleAfterSec]="172800" />
          <app-context-help topic="comisiones-rd" />
        </div>
      </section>

      <app-load-state [loading]="cargando()" [error]="error()" [skeletonRows]="4">
        @if (d(); as d) {
          <!-- Nivel 1: la escalera -->
          <section class="dg-sec" aria-labelledby="dg-escalera">
            <h3 id="dg-escalera" class="dg-h">Cómo se llega a la cifra</h3>
            <table class="surf-table surf-table--plain dg-escalera">
              <tbody>
                <tr>
                  <th scope="row">Venta del periodo</th>
                  <td class="comm-num">{{ money(linea().venta) }}</td>
                  <td class="dg-nota">{{ linea().dias_con_venta ?? '—' }} día(s) con venta de {{ linea().dias_esperados ?? '?' }} esperados · {{ ticketsTotal() }} tickets</td>
                </tr>
                @if (d.escala?.gate_field === 'markup') {
                  <tr>
                    <th scope="row">Markup sobre costo</th>
                    <td class="comm-num">{{ pct(linea().markup_sobre_costo_pct) }}%</td>
                    <td class="dg-nota">el tabulador de esta familia se elige por markup, no por venta</td>
                  </tr>
                }
                <tr>
                  <th scope="row">Escalón del tabulador</th>
                  <td class="comm-num">{{ escalon() ? pct(escalon()!.pct) + '%' : 'ninguno' }}</td>
                  <td class="dg-nota">
                    @if (escalon(); as e) {
                      de {{ cifraGate(e.min_amount) }} a {{ e.max_amount == null ? 'sin tope' : cifraGate(e.max_amount) }}
                    } @else if (d.escala) {
                      no alcanzó el primero, que empieza en {{ cifraGate(d.escala.escalones[0]?.min_amount) }}
                    } @else {
                      sin tabulador vigente para esta familia
                    }
                  </td>
                </tr>
                @if (escalon(); as e) {
                  <tr>
                    <th scope="row">Comisión de la ruta</th>
                    <td class="comm-num">{{ money(comisionRuta()) }}</td>
                    <td class="dg-nota">{{ pct(e.pct) }}% × {{ nombreBase() }} {{ money(base()) }}</td>
                  </tr>
                  <tr>
                    <th scope="row">Parte del chofer</th>
                    <td class="comm-num">{{ money(linea().comision) }}</td>
                    <td class="dg-nota">
                      {{ pct(100 - (d.escala?.share_supervisor_pct ?? 0)) }}% de la comisión; el {{ pct(d.escala?.share_supervisor_pct) }}% es del supervisor
                      @if (!cuadraComision()) { · <strong class="dg-bad">no cuadra con la línea: la cuenta da {{ money(parteChofer()) }}</strong> }
                    </td>
                  </tr>
                }
                @for (b of bonosEval(); track b.nombre) {
                  <tr [class.dg-off]="!b.cumplio">
                    <th scope="row">{{ b.cumplio ? '+' : '' }} Bono «{{ b.nombre }}»</th>
                    <td class="comm-num">{{ b.cumplio ? money(b.monto) : '—' }}</td>
                    <td class="dg-nota">
                      {{ b.cumplio ? 'cumplió' : 'no cumplió' }}: {{ b.metrica }} {{ b.comparador }} {{ b.metrica === 'markup' ? pct(b.umbral) + '%' : money(b.umbral) }}
                      @if (!b.cumplio && b.falta != null) { · le faltaron {{ money(b.falta) }} }
                      @if (b.solo_esta_ruta) { · sólo de esta ruta }
                    </td>
                  </tr>
                }
                @if (linea().nomina_banco) {
                  <tr>
                    <th scope="row">− Nómina de banco</th>
                    <td class="comm-num">−{{ money(linea().nomina_banco) }}</td>
                    <td class="dg-nota">el sueldo que ya se deposita por banco se descuenta de la comisión</td>
                  </tr>
                }
                <tr class="dg-total">
                  <th scope="row">= A pagar</th>
                  <td class="comm-num">{{ linea().motivo_no_pago ? '$0.00' : money(linea().a_pagar) }}</td>
                  <td class="dg-nota">
                    @if (linea().motivo_no_pago) { no paga: {{ motivoTexto() }} }
                    @else if (!cuadraTotal()) { <strong class="dg-bad">la suma de arriba da {{ money(totalEscalera()) }}, no lo de la línea</strong> }
                  </td>
                </tr>
              </tbody>
            </table>
            @if (siguiente(); as s) {
              <p class="dg-nota dg-sig">Para el siguiente escalón ({{ pct(s.pct) }}%) le faltaron {{ cifraGate(s.falta) }}.</p>
            }
          </section>

          <!-- El tabulador completo, con el escalón marcado por texto y no sólo por color -->
          @if (d.escala; as esc) {
            <section class="dg-sec" aria-labelledby="dg-tab">
              <h3 id="dg-tab" class="dg-h">Tabulador {{ esc.code }}</h3>
              @if (esc.origen === 'vigente_al_cierre') {
                <p class="dg-nota">Esta corrida no guardó con qué tabulador se calculó: se muestra el vigente al cierre de la quincena.</p>
              }
              <table class="surf-table surf-table--plain dg-tabulador">
                <thead><tr><th scope="col" class="comm-num">Desde</th><th scope="col" class="comm-num">Hasta</th><th scope="col" class="comm-num">%</th><th scope="col"></th></tr></thead>
                <tbody>
                  @for (t of esc.escalones; track t.min_amount) {
                    <tr [class.dg-sel]="t === escalon()">
                      <td class="comm-num">{{ cifraGate(t.min_amount) }}</td>
                      <td class="comm-num">{{ t.max_amount == null ? 'sin tope' : cifraGate(t.max_amount) }}</td>
                      <td class="comm-num">{{ pct(t.pct) }}</td>
                      <td>{{ t === escalon() ? 'aquí cayó' : '' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </section>
          }

          <!-- Nivel 2 y 3: los días, sus tickets y sus renglones -->
          <section class="dg-sec" aria-labelledby="dg-dias">
            <h3 id="dg-dias" class="dg-h">Venta por día</h3>
            @if (!cuadraDias()) {
              <p class="dg-aviso" role="status">
                La corrida usó {{ money(linea().venta) }} y hoy la fuente suma {{ money(sumaDias()) }}:
                llegó o cambió venta después de calcular. Hay que recalcular antes de aprobar.
              </p>
            }
            <p-table [value]="d.dias" dataKey="dia" size="small" class="surf-table surf-table--plain surf-table--sticky dg-dias">
              <ng-template #header>
                <tr>
                  <th scope="col">Día</th><th scope="col" class="comm-num">Tickets</th>
                  <th scope="col" class="comm-num">Venta</th><th scope="col" class="comm-num">Subtotal</th><th scope="col">Fuente</th>
                </tr>
              </ng-template>
              <ng-template #body let-x>
                  <tr>
                    <td>
                      <button type="button" class="dg-tog" [attr.aria-expanded]="diaAbierto() === x.dia" (click)="toggleDia(x.dia)">
                        <i class="pi" [class.pi-chevron-right]="diaAbierto() !== x.dia" [class.pi-chevron-down]="diaAbierto() === x.dia" aria-hidden="true"></i>
                        {{ diaLargo(x.dia) }}
                      </button>
                    </td>
                    <td class="comm-num">{{ x.tickets ?? '—' }}</td>
                    <td class="comm-num">{{ money(x.venta) }}</td>
                    <td class="comm-num">{{ money(x.subtotal) }}</td>
                    <td class="dg-nota">{{ fuente(x.fuentes_dia) }}</td>
                  </tr>
                  @if (diaAbierto() === x.dia) {
                    <tr class="dg-nested"><td colspan="5">
                      <app-load-state [loading]="cargandoTickets()" [error]="errorTickets()" [skeletonRows]="3"
                                      [isEmpty]="!tickets().length" emptyTitle="Sin tickets ese día">
                        @if (!cuadraTicketsDia(x.venta)) {
                          <p class="dg-aviso" role="status">Los tickets suman {{ money(sumaTickets()) }} y el día {{ money(x.venta) }}.</p>
                        }
                        <table class="surf-table surf-table--plain dg-tickets">
                          <thead><tr>
                            <th scope="col">Folio</th><th scope="col">Cliente</th>
                            <th scope="col" class="comm-num">Renglones</th><th scope="col" class="comm-num">Venta</th>
                          </tr></thead>
                          <tbody>
                            @for (t of tickets(); track t.clave) {
                              <tr>
                                <td>
                                  <button type="button" class="dg-tog" [attr.aria-expanded]="ticketAbierto() === t.clave" (click)="toggleTicket(t.clave)">
                                    <i class="pi" [class.pi-chevron-right]="ticketAbierto() !== t.clave" [class.pi-chevron-down]="ticketAbierto() === t.clave" aria-hidden="true"></i>
                                    <span class="dg-mono">{{ t.consecutivo }}</span>
                                  </button>
                                </td>
                                <td>{{ t.cliente || 'sin clave' }}</td>
                                <td class="comm-num">{{ t.renglones.length }}</td>
                                <td class="comm-num">{{ money(t.venta) }}</td>
                              </tr>
                              @if (ticketAbierto() === t.clave) {
                                <tr class="dg-nested"><td colspan="4">
                                  <table class="surf-table surf-table--plain dg-renglones">
                                    <thead><tr>
                                      <th scope="col">SKU</th><th scope="col">Producto</th><th scope="col">Unidad</th>
                                      <th scope="col" class="comm-num">Cantidad</th><th scope="col" class="comm-num">Precio</th><th scope="col" class="comm-num">Venta</th>
                                    </tr></thead>
                                    <tbody>
                                      @for (r of t.renglones; track $index) {
                                        <tr>
                                          <td class="dg-mono">{{ r.sku }}</td>
                                          <td>{{ r.producto || '—' }}</td>
                                          <td>{{ r.unidad || '—' }}</td>
                                          <td class="comm-num">{{ r.qty }}</td>
                                          <td class="comm-num">{{ money(r.precio_unitario) }}</td>
                                          <td class="comm-num">{{ money(r.venta) }}</td>
                                        </tr>
                                      }
                                    </tbody>
                                  </table>
                                </td></tr>
                              }
                            }
                          </tbody>
                        </table>
                      </app-load-state>
                    </td></tr>
                  }
              </ng-template>
              <ng-template #footer>
                <tr>
                  <td>{{ d.dias.length }} día(s)</td>
                  <td class="comm-num">{{ ticketsTotal() }}</td>
                  <td class="comm-num">{{ money(sumaDias()) }}</td>
                  <td class="comm-num">{{ money(sumaSubtotal()) }}</td>
                  <td class="dg-nota">{{ cuadraDias() ? 'igual a la corrida' : 'distinto de la corrida' }}</td>
                </tr>
              </ng-template>
            </p-table>
            <p class="dg-nota">
              Venta = con IVA e IEPS, la que decide el escalón. Subtotal = sin impuestos, sobre el que se calcula
              el porcentaje; existe por día, no por renglón. El cliente llega con su clave: el envío desde la camioneta no trae el nombre.
            </p>
          </section>
        }
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .dg { display: flex; flex-direction: column; gap: var(--sp-6); }
    .dg-answer { display: flex; flex-direction: column; gap: var(--sp-2); }
    .dg-meta { display: flex; align-items: center; gap: var(--sp-3); }
    .dg-frase { margin: 0; font-size: var(--fs-body); color: var(--fg-2); max-width: 70ch; }
    .dg-sec { display: flex; flex-direction: column; gap: var(--sp-2); }
    .dg-h { margin: 0; font-size: var(--fs-h3); font-weight: 600; color: var(--fg-1); }
    .dg-nota { font-size: var(--fs-sm); color: var(--fg-3); }
    .dg-sig { margin: 0; }
    .dg-escalera th { text-align: left; font-weight: 500; color: var(--fg-2); white-space: nowrap; }
    .dg-escalera .dg-total th, .dg-escalera .dg-total td.comm-num { font-weight: 700; color: var(--fg-1); }
    .dg-off th, .dg-off td { color: var(--fg-3); }
    .dg-sel td { font-weight: 600; color: var(--fg-1); background: var(--overlay-selected); }
    .dg-bad { color: var(--bad-fg); }
    .dg-aviso { margin: 0; font-size: var(--fs-sm); color: var(--warn-fg); }
    .dg-tog { display: inline-flex; align-items: center; gap: var(--sp-2); background: none; border: 0; padding: 0;
      font: inherit; color: var(--fg-1); cursor: pointer; }
    .dg-tog:focus-visible { outline: 2px solid var(--action, currentColor); outline-offset: 2px; }
    .dg-tog .pi { font-size: var(--fs-xs); color: var(--fg-3); }
    .dg-nested > td { padding-left: var(--sp-6); background: var(--surface-ground); }
    .dg-mono { font-variant-numeric: tabular-nums; }
    .dg-dias tfoot td { font-weight: 600; }
  `],
})
export class ComisionesDesgloseComponent {
  private readonly svc = inject(ComercialService);

  readonly linea = input.required<CommissionLine>();
  readonly periodId = input.required<string>();
  /** El texto del motivo de no pago, con el mismo diccionario que la tabla de la que viene. */
  readonly motivoTexto = input('');
  /** Hasta cuándo llegaba la venta con la que se calculó la corrida (`data_as_of`). */
  readonly ventaMedida = input<string | null>(null);

  readonly d = signal<CommissionDesglose | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly diaAbierto = signal<string | null>(null);
  readonly ticketAbierto = signal<string | null>(null);
  readonly tickets = signal<CommissionDesgloseTicket[]>([]);
  readonly cargandoTickets = signal(false);
  readonly errorTickets = signal<string | null>(null);

  constructor() {
    effect(() => {
      const l = this.linea();
      const p = this.periodId();
      this.cargar(l, p);
    });
  }

  private cargar(l: CommissionLine, periodId: string): void {
    this.d.set(null); this.error.set(null); this.cargando.set(true);
    this.diaAbierto.set(null); this.ticketAbierto.set(null); this.tickets.set([]);
    this.svc.commissionDesglose(l.route_code, periodId, l.scale_id).subscribe({
      next: (d) => { this.d.set(d); this.cargando.set(false); },
      error: (e) => { this.error.set(e?.error?.message ?? 'No se pudo cargar el desglose'); this.cargando.set(false); },
    });
  }

  toggleDia(dia: string): void {
    if (this.diaAbierto() === dia) { this.diaAbierto.set(null); return; }
    this.diaAbierto.set(dia); this.ticketAbierto.set(null); this.tickets.set([]);
    this.errorTickets.set(null); this.cargandoTickets.set(true);
    this.svc.commissionDesgloseTickets(this.linea().route_code, dia).subscribe({
      next: (r) => { if (this.diaAbierto() === dia) { this.tickets.set(r.tickets); this.cargandoTickets.set(false); } },
      error: (e) => { this.errorTickets.set(e?.error?.message ?? 'No se pudieron cargar los tickets'); this.cargandoTickets.set(false); },
    });
  }

  toggleTicket(clave: string): void {
    this.ticketAbierto.set(this.ticketAbierto() === clave ? null : clave);
  }

  /** Nivel 0: lo que cobra, primero; después con qué venta y en cuántos días. */
  readonly tira = computed<MetricStripItem[]>(() => {
    const l = this.linea();
    const e = this.escalon();
    const share = Number(this.d()?.escala?.share_supervisor_pct) || 0;
    return [
      { label: 'A pagar', value: l.motivo_no_pago ? 0 : Number(l.a_pagar) || 0, format: 'currency2' },
      { label: 'Venta del periodo', value: Number(l.venta) || 0, format: 'currency2' },
      { label: '% del chofer', value: e ? `${this.pct(e.pct * (1 - share / 100))}%` : '—', format: 'text',
        sub: e ? `de ${this.pct(e.pct)}% del tabulador` : undefined },
      { label: 'Días con venta', value: `${l.dias_con_venta ?? '—'} de ${l.dias_esperados ?? '?'}`, format: 'text' },
    ];
  });

  // ── La escalera ──────────────────────────────────────────────────────────────────────
  /** El valor con el que se elige el escalón: venta en Ruta Directa, markup en la vecinal. */
  readonly valorGate = computed(() => {
    const e = this.d()?.escala;
    const l = this.linea();
    if (!e) return null;
    if (e.gate_field === 'markup') return l.markup_sobre_costo_pct;
    return e.gate_field === 'subtotal' ? l.subtotal : l.venta;
  });

  readonly escalon = computed(() => {
    const e = this.d()?.escala;
    const v = this.valorGate();
    if (!e || v == null) return null;
    return e.escalones.find((t) => v >= t.min_amount && (t.max_amount == null || v < t.max_amount)) ?? null;
  });

  readonly siguiente = computed(() => {
    const e = this.d()?.escala;
    const v = this.valorGate();
    if (!e || v == null) return null;
    const s = e.escalones.find((t) => t.min_amount > v);
    return s ? { pct: s.pct, falta: s.min_amount - v } : null;
  });

  readonly base = computed(() => {
    const l = this.linea();
    return this.d()?.escala?.base_field === 'venta' ? l.venta : l.subtotal;
  });
  readonly comisionRuta = computed(() => (Number(this.base()) || 0) * (Number(this.escalon()?.pct) || 0) / 100);
  readonly parteChofer = computed(() =>
    this.comisionRuta() * (1 - (Number(this.d()?.escala?.share_supervisor_pct) || 0) / 100));
  readonly cuadraComision = computed(() => Math.abs(this.parteChofer() - (Number(this.linea().comision) || 0)) <= 0.05);

  readonly bonosEval = computed(() => {
    const l = this.linea();
    const cumplidos = new Set((l.bonos_detalle ?? []).map((b) => b.nombre));
    return (this.d()?.bonos ?? []).map((b) => {
      const valor = b.metrica === 'markup' ? l.markup_sobre_costo_pct : l.venta;
      const falta = b.metrica === 'venta' && valor != null && valor < b.umbral ? b.umbral - valor : null;
      return { ...b, cumplio: cumplidos.has(b.nombre), falta };
    });
  });

  readonly totalEscalera = computed(() => {
    const l = this.linea();
    return (Number(l.comision) || 0) + (Number(l.bonos) || 0) - (Number(l.nomina_banco) || 0);
  });
  readonly cuadraTotal = computed(() => Math.abs(this.totalEscalera() - (Number(this.linea().a_pagar) || 0)) <= 0.05);

  // ── Los días ─────────────────────────────────────────────────────────────────────────
  readonly sumaDias = computed(() => (this.d()?.dias ?? []).reduce((s, x) => s + x.venta, 0));
  readonly sumaSubtotal = computed(() => (this.d()?.dias ?? []).reduce((s, x) => s + x.subtotal, 0));
  readonly ticketsTotal = computed(() => (this.d()?.dias ?? []).reduce((s, x) => s + (x.tickets ?? 0), 0));
  readonly cuadraDias = computed(() => Math.abs(this.sumaDias() - (Number(this.linea().venta) || 0)) <= 1);
  readonly sumaTickets = computed(() => this.tickets().reduce((s, t) => s + t.venta, 0));
  cuadraTicketsDia(ventaDia: number): boolean { return Math.abs(this.sumaTickets() - ventaDia) <= 0.05; }

  readonly frase = computed(() => {
    const l = this.linea();
    const e = this.escalon();
    if (l.motivo_no_pago) return `No cobra esta quincena: ${this.motivoTexto() || l.motivo_no_pago}.`;
    if (!e) return 'Vendió ' + this.money(l.venta) + '.';
    const bonos = Number(l.bonos) ? `, más ${this.money(l.bonos)} de bonos` : '';
    const nomina = Number(l.nomina_banco) ? `, menos ${this.money(l.nomina_banco)} de nómina de banco` : '';
    return `Vendió ${this.money(l.venta)}: el tabulador le da ${this.pct(e.pct)}% sobre ${this.nombreBase()} y al chofer le tocan `
      + `${this.money(l.comision)}${bonos}${nomina}.`;
  });

  nombreBase(): string { return this.d()?.escala?.base_field === 'venta' ? 'la venta' : 'el subtotal'; }

  cifraGate(n: number | null | undefined): string {
    if (n == null) return '—';
    return this.d()?.escala?.gate_field === 'markup' ? `${this.pct(n)}%` : this.money(n);
  }

  fuente(f: string | null): string {
    if (!f) return '—';
    const nombres: Record<string, string> = {
      push: 'envío desde la camioneta', wincaja: 'Wincaja', kepler_vecinal: 'Kepler (vecinal)',
    };
    return f.split('+').map((x) => nombres[x] ?? x).join(' + ');
  }

  diaLargo(iso: string): string {
    const d = new Date(`${iso}T12:00:00`);
    return new Intl.DateTimeFormat('es-MX', { weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  }

  pct(n: number | null | undefined): string {
    if (n == null) return '—';
    return String(Math.round(Number(n) * 1000) / 1000);
  }

  money(n: number | string | null | undefined): string {
    if (n == null) return '—';
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 }).format(Number(n));
  }
}
