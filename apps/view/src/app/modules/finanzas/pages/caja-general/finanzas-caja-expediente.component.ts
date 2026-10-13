import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { environment } from '../../../../../environments/environment';
import { LoadStateComponent } from '../../../../shared/components/load-state/load-state.component';
import { SidePeekComponent } from '../../../../shared/components/side-peek/side-peek.component';
import { MetricStripComponent, MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../../shared/components/freshness-pill/freshness-pill.component';
import type { Freshness } from '@megadulces/contracts';
import { FINANZAS_SHARED_STYLES } from '../finanzas-shared.styles';
import { money, dmy } from '../finanzas-format';

/** Un renglón del historial: un día, con el corte de ese día. */
export interface CorteDia {
  fecha: string;
  movimientos: number;
  conteos: number;
  tickets_que_no_cuadran: number;
  efectivo_movido: number | string;
  primera_hora: string | null;
  ultima_hora: string | null;
  tiene_corte: boolean;
  corte_folio: string | null;
  corte_hora: string | null;
  corte_capturo: string | null;
  corte_cuadra_ticket: boolean | null;
  total_billetes: number | string | null;
  total_monedas: number | string | null;
  total_efectivo: number | string | null;
  total_cheques: number | string | null;
  total_tarjeta: number | string | null;
  total_papeles: number | string | null;
  dolares_usd: number | string | null;
  tipo_cambio: number | string | null;
  total_dolares: number | string | null;
  total_declarado: number | string | null;
  [k: string]: unknown;
}

/** Un movimiento del expediente, con su ticket por denominación. */
export interface MovimientoExpediente {
  folio: string;
  hora: string;
  capturo: string | null;
  observaciones: string | null;
  cancelado: boolean;
  naturaleza: 'conteo' | 'movimiento';
  cuadra_ticket: boolean;
  total_efectivo: number | string;
  total_cheques: number | string;
  total_tarjeta: number | string;
  total_papeles: number | string;
  dolares_usd: number | string;
  tipo_cambio: number | string | null;
  total_dolares: number | string;
  total_declarado: number | string;
  [k: string]: unknown;
}

interface Expediente {
  fecha: string;
  rows: MovimientoExpediente[];
  resumen: {
    movimientos: number; cancelados: number; conteos: number;
    efectivo_movido: number; tickets_que_no_cuadran: number;
  };
  corte: MovimientoExpediente | null;
}

/** Las piezas del ticket, en el orden en que se cuentan. `k` es la columna de la vista. */
const DENOMINACIONES: ReadonlyArray<{ k: string; etiqueta: string; valor: number; moneda: boolean }> = [
  { k: 'b1000', etiqueta: '$1,000', valor: 1000, moneda: false },
  { k: 'b500', etiqueta: '$500', valor: 500, moneda: false },
  { k: 'b200', etiqueta: '$200', valor: 200, moneda: false },
  { k: 'b100', etiqueta: '$100', valor: 100, moneda: false },
  { k: 'b50', etiqueta: '$50', valor: 50, moneda: false },
  { k: 'b20', etiqueta: '$20', valor: 20, moneda: false },
  { k: 'm100', etiqueta: '$100', valor: 100, moneda: true },
  { k: 'm20', etiqueta: '$20', valor: 20, moneda: true },
  { k: 'm10', etiqueta: '$10', valor: 10, moneda: true },
  { k: 'm5', etiqueta: '$5', valor: 5, moneda: true },
  { k: 'm2', etiqueta: '$2', valor: 2, moneda: true },
  { k: 'm1', etiqueta: '$1', valor: 1, moneda: true },
  { k: 'm50c', etiqueta: '50¢', valor: 0.5, moneda: true },
  { k: 'm20c', etiqueta: '20¢', valor: 0.2, moneda: true },
  { k: 'm10c', etiqueta: '10¢', valor: 0.1, moneda: true },
  { k: 'm5c', etiqueta: '5¢', valor: 0.05, moneda: true },
  { k: 'centavos', etiqueta: '1¢', valor: 0.01, moneda: true },
];

const n = (v: unknown): number => Number(v ?? 0) || 0;

/**
 * `[CG.105]` **Corte diario de Caja General: el historial y el expediente del día.**
 *
 * Edgar, 2026-10-13: *"necesito que generes un historial de cortes diario, y un expediente de
 * movimientos diario donde se muestre el ticket"* · *"lo revisan todas las mañanas que el corte
 * sí coincida con lo que existe en la caja"*.
 *
 * Esa frase define la pantalla: **answer-first es la pregunta de la mañana**, no un resumen
 * bonito. Arriba va el veredicto del último día —si alguien contó la caja, si el ticket cuadra
 * consigo mismo y qué hay en cada apartado—; la rejilla viene después.
 *
 * ── Lo que esta pantalla NO hace, y por qué ─────────────────────────────────────────────────
 *
 * ⛔ **No edita nada.** Lo que se ve lo captura el Access `Control`, y corregirlo se corrige allá
 * (mismo criterio que ADR-040 con ContPAQi). Una pantalla que deja editar el espejo fabrica una
 * segunda verdad y después nadie sabe cuál manda.
 *
 * ⛔ **No suma dólares, cheques, tarjeta ni papeles por día.** Medido en prod: los dólares toman
 * 9 valores en todo 2026 y el actual —12,059 USD a 19.101— se repite 205 veces del 2-abr al
 * 10-oct; los papeles valen $20,782.00 exactos 383 veces desde el 2025-10-06. Son saldos PARADOS
 * que se vuelven a declarar en cada conteo: sumarlos por día publica dinero que no existe. Se
 * muestran como lo que son, el saldo del último conteo del día.
 *
 * ⛔ **Un día sin conteo se DICE, no se dibuja en cero** (ADR-056). Medido: el 12-oct y el 9-oct
 * tienen movimientos y cero conteos — y eso es justo lo que la revisión de la mañana busca.
 */
@Component({
  selector: 'app-finanzas-caja-expediente',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, ButtonModule, TableModule, TagModule,
    LoadStateComponent, SidePeekComponent, MetricStripComponent, FreshnessPillComponent],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Corte diario de Caja General</h1>
          <p class="surf-page-sub">
            Un renglón por día con el corte de ese día, y el expediente de cada movimiento con su
            ticket por denominación. Sólo lectura: lo captura Control.
          </p>
        </div>
        <div class="cx-actions">
          <!-- §9 La edad del dato se DECLARA. Sin esto la pantalla se lee como al dia aunque el
               carril lleve dias parado, que es el defecto que midio la Fase OBS. -->
          <app-freshness-pill measures="data" [freshness]="frescura()" label="Arqueos de Control" />
          <button pButton type="button" class="p-button-sm p-button-outlined"
                  [loading]="cargando()" (click)="recargar()">
            <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
            <span class="p-button-label">Actualizar</span>
          </button>
        </div>
      </header>

      <!-- Q.1 answer-first: la pregunta de la mañana, antes de la rejilla. -->
      @if (ultimo(); as u) {
        <section class="cx-veredicto" [class.cx-veredicto-bad]="!u.tiene_corte"
                 aria-labelledby="cx-h-ver">
          <div class="cx-ver-head">
            <h2 id="cx-h-ver">
              @if (u.tiene_corte) { La caja se contó el {{ dmy(u.fecha) }} }
              @else { El {{ dmy(u.fecha) }} nadie contó la caja }
            </h2>
            @if (u.tiene_corte) {
              <p-tag [value]="u.corte_cuadra_ticket ? 'El ticket cuadra' : 'El ticket NO cuadra'"
                     [severity]="u.corte_cuadra_ticket ? 'success' : 'danger'" styleClass="cx-tag" />
              <span class="cx-ver-meta">{{ u.corte_folio }} · {{ hhmm(u.corte_hora) }}</span>
            } @else {
              <p-tag value="Sin conteo" severity="warn" styleClass="cx-tag" />
              <span class="cx-ver-meta">{{ u.movimientos }} movimiento(s) ese día</span>
            }
          </div>
          @if (u.tiene_corte) {
            <div class="cx-apartados">
              <div class="cx-ap cx-ap-fuerte">
                <span class="cx-ap-lbl">Efectivo en el cajón</span>
                <strong class="comm-num">{{ mx(u.total_efectivo) }}</strong>
                <small>{{ mx(u.total_billetes) }} en billetes · {{ mx(u.total_monedas) }} en monedas</small>
              </div>
              <div class="cx-ap">
                <span class="cx-ap-lbl">Dólares</span>
                <strong class="comm-num">{{ mx(u.total_dolares) }}</strong>
                <small>{{ usd(u.dolares_usd) }} USD al tipo de cambio {{ u.tipo_cambio ?? '—' }}</small>
              </div>
              <div class="cx-ap">
                <span class="cx-ap-lbl">Papeles por pagar</span>
                <strong class="comm-num">{{ mx(u.total_papeles) }}</strong>
                <small>no es efectivo: es un saldo en custodia</small>
              </div>
              <div class="cx-ap">
                <span class="cx-ap-lbl">Cheques</span>
                <strong class="comm-num">{{ mx(u.total_cheques) }}</strong>
              </div>
              <div class="cx-ap">
                <span class="cx-ap-lbl">Tarjeta</span>
                <strong class="comm-num">{{ mx(u.total_tarjeta) }}</strong>
              </div>
              <div class="cx-ap cx-ap-total">
                <span class="cx-ap-lbl">Total declarado</span>
                <strong class="comm-num">{{ mx(u.total_declarado) }}</strong>
                <small>efectivo + dólares + papeles + cheques + tarjeta</small>
              </div>
            </div>
          } @else {
            <p class="cx-ver-hint">
              Ese día hubo movimientos pero nadie dejó un conteo de la caja completa, así que
              no hay con qué comparar lo que hay físicamente. No es cero: es que no se midió.
            </p>
          }
        </section>
      }

      <app-metric-strip [items]="kpis()" ariaLabel="Resumen del historial de cortes" />

      <section class="cx-block dt-scope" aria-labelledby="cx-h-hist">
        <div class="cx-bh">
          <h2 id="cx-h-hist">Historial de cortes</h2>
          <span class="cx-hint">Elige un día para ver su expediente</span>
        </div>

        <app-load-state [loading]="cargando() && !dias().length" [error]="error()"
                        [isEmpty]="!cargando() && !error() && !dias().length"
                        emptyTitle="Sin cortes en el periodo"
                        emptyHint="El historial sale del Access Control. Si está vacío, el carril de ese dato dejó de llegar."
                        (retry)="recargar()" />

        @if (dias().length) {
          <p-table [value]="dias()" size="small" dataKey="fecha" [rowHover]="true"
                   class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first dt-stack"
                   selectionMode="single" [selection]="diaSel()" (selectionChange)="abrir($event)">
            <ng-template #header>
              <tr>
                <th scope="col">Día</th>
                <th scope="col">Corte</th>
                <th scope="col" class="comm-num">Efectivo</th>
                <th scope="col" class="comm-num">Dólares</th>
                <th scope="col" class="comm-num">Papeles</th>
                <th scope="col" class="comm-num">Cheques</th>
                <th scope="col" class="comm-num">Tarjeta</th>
                <th scope="col" class="comm-num">Total declarado</th>
                <th scope="col" class="comm-num">Movimientos</th>
                <th scope="col">Revisar</th>
              </tr>
            </ng-template>
            <ng-template #body let-d>
              <tr [pSelectableRow]="d">
                <td role="cell" data-label="Día"><b>{{ dmy(d.fecha) }}</b></td>
                <td role="cell" data-label="Corte">
                  @if (d.tiene_corte) {
                    <span class="cx-mono">{{ d.corte_folio }}</span>
                    <span class="cx-dim"> · {{ hhmm(d.corte_hora) }}</span>
                  } @else { <span class="cx-dim">sin conteo</span> }
                </td>
                <td role="cell" data-label="Efectivo" class="comm-num">
                  @if (d.tiene_corte) { {{ mx(d.total_efectivo) }} } @else { <span class="cx-dim">—</span> }
                </td>
                <td role="cell" data-label="Dólares" class="comm-num">
                  @if (d.tiene_corte) { {{ mx(d.total_dolares) }} } @else { <span class="cx-dim">—</span> }
                </td>
                <td role="cell" data-label="Papeles" class="comm-num">
                  @if (d.tiene_corte) { {{ mx(d.total_papeles) }} } @else { <span class="cx-dim">—</span> }
                </td>
                <td role="cell" data-label="Cheques" class="comm-num">
                  @if (d.tiene_corte) { {{ mx(d.total_cheques) }} } @else { <span class="cx-dim">—</span> }
                </td>
                <td role="cell" data-label="Tarjeta" class="comm-num">
                  @if (d.tiene_corte) { {{ mx(d.total_tarjeta) }} } @else { <span class="cx-dim">—</span> }
                </td>
                <td role="cell" data-label="Total declarado" class="comm-num cx-strong">
                  @if (d.tiene_corte) { {{ mx(d.total_declarado) }} } @else { <span class="cx-dim">—</span> }
                </td>
                <td role="cell" data-label="Movimientos" class="comm-num">{{ d.movimientos }}</td>
                <td role="cell" data-label="Revisar">
                  @if (!d.tiene_corte) { <p-tag value="Sin conteo" severity="warn" styleClass="cx-tag" /> }
                  @if (d.tickets_que_no_cuadran) {
                    <p-tag [value]="d.tickets_que_no_cuadran + ' ticket(s) sin cuadrar'" severity="danger" styleClass="cx-tag" />
                  }
                  @if (d.conteos > 1) { <p-tag [value]="d.conteos + ' conteos'" severity="info" styleClass="cx-tag" /> }
                  @if (d.tiene_corte && !d.tickets_que_no_cuadran && d.conteos <= 1) { <span class="cx-dim">—</span> }
                </td>
              </tr>
            </ng-template>
          </p-table>
        }
      </section>

      <app-side-peek [(open)]="peek" mode="window" [width]="1040"
                     [title]="'Expediente del ' + (diaSel()?.fecha ? dmy(diaSel()!.fecha) : '')"
                     [subtitle]="subtituloPeek()">
        @if (cargandoExp()) {
          <app-load-state [loading]="true" [skeletonRows]="8" />
        } @else if (exp(); as e) {
          <div class="cx-exp">
            @for (m of e.rows; track m.folio) {
              <article class="cx-mov" [class.cx-mov-cancel]="m.cancelado"
                       [class.cx-mov-conteo]="m.naturaleza === 'conteo'">
                <header class="cx-mov-head">
                  <span class="cx-mono">{{ m.folio }}</span>
                  <span class="cx-dim">{{ hhmm(m.hora) }}</span>
                  @if (m.naturaleza === 'conteo') {
                    <p-tag value="Conteo de la caja" severity="info" styleClass="cx-tag" />
                  }
                  @if (m.cancelado) { <p-tag value="Cancelado" severity="danger" styleClass="cx-tag" /> }
                  @if (!m.cuadra_ticket) { <p-tag value="El ticket no cuadra" severity="danger" styleClass="cx-tag" /> }
                  <span class="cx-mov-sp"></span>
                  <strong class="comm-num">{{ mx(m.total_declarado) }}</strong>
                </header>
                @if (m.observaciones) { <p class="cx-mov-obs">{{ m.observaciones }}</p> }

                <!-- EL TICKET: las piezas tal como se contaron. -->
                @if (piezas(m).length) {
                  <table class="cx-ticket">
                    <caption class="cx-ticket-cap">Ticket · {{ mx(m.total_efectivo) }} en efectivo</caption>
                    <thead>
                      <tr><th scope="col">Pieza</th><th scope="col" class="comm-num">Cantidad</th><th scope="col" class="comm-num">Importe</th></tr>
                    </thead>
                    <tbody>
                      @for (p of piezas(m); track p.k) {
                        <tr>
                          <td>{{ p.etiqueta }} <span class="cx-dim">{{ p.moneda ? 'moneda' : 'billete' }}</span></td>
                          <td class="comm-num">{{ p.piezas }}</td>
                          <td class="comm-num">{{ mx(p.importe) }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                } @else {
                  <p class="cx-dim cx-mov-obs">Sin desglose de efectivo en este movimiento.</p>
                }

                @if (tieneCustodia(m)) {
                  <ul class="cx-cust">
                    @if (n(m.total_dolares)) { <li><span>Dólares</span><b class="comm-num">{{ mx(m.total_dolares) }}</b><small>{{ usd(m.dolares_usd) }} USD · TC {{ m.tipo_cambio ?? '—' }}</small></li> }
                    @if (n(m.total_papeles)) { <li><span>Papeles por pagar</span><b class="comm-num">{{ mx(m.total_papeles) }}</b></li> }
                    @if (n(m.total_cheques)) { <li><span>Cheques</span><b class="comm-num">{{ mx(m.total_cheques) }}</b></li> }
                    @if (n(m.total_tarjeta)) { <li><span>Tarjeta</span><b class="comm-num">{{ mx(m.total_tarjeta) }}</b></li> }
                  </ul>
                }
              </article>
            }
          </div>
        }
      </app-side-peek>
    </div>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    :host { display: block; }

    .cx-actions { display:flex; gap:var(--sp-2); align-items:center; }

    .cx-veredicto {
      border:1px solid var(--border-color); border-radius:var(--r-lg);
      padding:var(--sp-4); margin-block:var(--sp-4);
      background:var(--overlay-hover);
    }
    .cx-veredicto-bad { border-color:var(--warn-fg); }
    .cx-ver-head { display:flex; align-items:center; gap:var(--sp-3); flex-wrap:wrap; }
    .cx-ver-head h2 { margin:0; font-size:var(--fs-h3); }
    .cx-ver-meta { color:var(--text-muted); font-size:var(--fs-sm); }
    .cx-ver-hint { margin:var(--sp-3) 0 0; color:var(--text-muted); max-width:52rem; }

    .cx-apartados {
      display:grid; gap:var(--sp-3); margin-top:var(--sp-4);
      grid-template-columns:repeat(auto-fit, minmax(13rem, 1fr));
    }
    .cx-ap {
      display:flex; flex-direction:column; gap:var(--sp-1);
      padding:var(--sp-3); border:1px solid var(--border-color); border-radius:var(--r-md);
      background:var(--surface-card);
    }
    .cx-ap-lbl { color:var(--text-muted); font-size:var(--fs-sm); }
    .cx-ap strong { font-size:var(--fs-lg); }
    .cx-ap small { color:var(--text-faint); font-size:var(--fs-micro); }
    .cx-ap-fuerte { border-color:var(--action); }
    .cx-ap-total strong { color:var(--text-main); }

    .cx-block { margin-top:var(--sp-5); }
    .cx-bh { display:flex; align-items:baseline; gap:var(--sp-3); margin-bottom:var(--sp-2); }
    .cx-bh h2 { margin:0; font-size:var(--fs-lg); }
    .cx-hint { color:var(--text-muted); font-size:var(--fs-sm); }
    .cx-dim { color:var(--text-faint); }
    .cx-strong { font-weight:var(--fw-bold, 700); }
    .cx-mono { font-family:var(--font-mono); font-size:var(--fs-sm); }

    .cx-exp { display:flex; flex-direction:column; gap:var(--sp-4); }
    .cx-mov { border:1px solid var(--border-color); border-radius:var(--r-md); padding:var(--sp-3); }
    .cx-mov-conteo { border-color:var(--action); }
    .cx-mov-cancel { opacity:.55; }
    .cx-mov-head { display:flex; align-items:center; gap:var(--sp-2); flex-wrap:wrap; }
    .cx-mov-sp { flex:1 1 auto; }
    .cx-mov-obs { margin:var(--sp-2) 0 0; color:var(--text-muted); font-size:var(--fs-sm); }

    .cx-ticket { width:100%; border-collapse:collapse; margin-top:var(--sp-3); }
    .cx-ticket-cap { text-align:left; color:var(--text-muted); font-size:var(--fs-sm); padding-bottom:var(--sp-1); }
    .cx-ticket th, .cx-ticket td {
      padding:var(--sp-1) var(--sp-2); border-bottom:1px solid var(--border-color);
      font-size:var(--fs-sm); text-align:left;
    }
    .cx-ticket th { color:var(--text-muted); font-weight:var(--fw-medium, 500); }
    .cx-ticket .comm-num { text-align:right; font-variant-numeric:tabular-nums; }

    .cx-cust { list-style:none; margin:var(--sp-3) 0 0; padding:0; display:grid; gap:var(--sp-2);
      grid-template-columns:repeat(auto-fit, minmax(11rem, 1fr)); }
    .cx-cust li { display:flex; flex-direction:column; gap:2px;
      padding:var(--sp-2); border:1px dashed var(--border-color); border-radius:var(--r-sm); }
    .cx-cust span { color:var(--text-muted); font-size:var(--fs-micro); }
    .cx-cust small { color:var(--text-faint); font-size:var(--fs-micro); }
  `],
})
export class FinanzasCajaExpedienteComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/caja-control`;

  readonly dias = signal<CorteDia[]>([]);
  readonly cargando = signal(false);
  /** `[CG.105]` La edad del dato, tal como la reporta el carril. `null` = no se pudo medir. */
  readonly frescura = signal<Freshness | null>(null);
  readonly error = signal<string | null>(null);

  readonly diaSel = signal<CorteDia | null>(null);
  readonly peek = signal(false);
  readonly exp = signal<Expediente | null>(null);
  readonly cargandoExp = signal(false);

  /**
   * ⛔ Dinero SIEMPRE por acá. Los `numeric` de Postgres llegan como **string** en el JSON, y
   * `String.prototype.toLocaleString` ignora las opciones de moneda: sin este `Number()` el
   * importe sale sin $ y sin comas. El compilador de Angular lo atrapó como error de tipos;
   * el defecto de fondo era de formato, no de tipos.
   */
  protected readonly mx = (v: unknown): string => money(Number(v ?? 0) || 0);
  protected readonly dmy = dmy;
  protected readonly n = n;

  /** El día más reciente: es el que se revisa en la mañana. */
  readonly ultimo = computed<CorteDia | null>(() => this.dias()[0] ?? null);

  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.dias();
    if (!d.length) return [];
    const sinConteo = d.filter((x) => !x.tiene_corte).length;
    const sinCuadrar = d.reduce((a, x) => a + Number(x.tickets_que_no_cuadran || 0), 0);
    const u = d[0];
    return [
      { label: 'Días en el historial', value: d.length, format: 'number' },
      {
        label: 'Días sin conteo', value: sinConteo, format: 'number',
        tone: sinConteo ? 'warn' : 'ok',
        sub: sinConteo ? 'nadie contó la caja esos días' : 'todos los días tienen su conteo',
      },
      {
        label: 'Tickets que no cuadran', value: sinCuadrar, format: 'number',
        tone: sinCuadrar ? 'bad' : 'ok',
        sub: 'las piezas no dan el efectivo declarado',
      },
      {
        label: 'Efectivo del último corte',
        value: u.tiene_corte ? Number(u.total_efectivo ?? 0) : 0,
        format: 'currency2',
        state: u.tiene_corte ? 'medido' : 'no_medido',
        stateNote: u.tiene_corte ? undefined : 'ese día nadie contó la caja',
      },
    ];
  });

  readonly subtituloPeek = computed<string | null>(() => {
    const e = this.exp();
    if (!e) return null;
    const r = e.resumen;
    const partes = [`${r.movimientos} movimiento(s)`, `${r.conteos} conteo(s)`];
    if (r.cancelados) partes.push(`${r.cancelados} cancelado(s)`);
    if (r.tickets_que_no_cuadran) partes.push(`${r.tickets_que_no_cuadran} ticket(s) sin cuadrar`);
    return partes.join(' · ');
  });

  ngOnInit(): void { this.recargar(); }

  recargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.http.get<{ rows: CorteDia[]; frescura?: Freshness }>(`${this.base}/cortes?limit=90`).subscribe({
      next: (r) => { this.dias.set(r?.rows ?? []); this.frescura.set(r?.frescura ?? null); this.cargando.set(false); },
      error: () => {
        this.error.set('No se pudo traer el historial de cortes.');
        this.cargando.set(false);
      },
    });
  }

  abrir(d: CorteDia | null): void {
    if (!d) return;
    this.diaSel.set(d);
    this.exp.set(null);
    this.peek.set(true);
    this.cargandoExp.set(true);
    this.http.get<Expediente>(`${this.base}/expediente/${d.fecha.slice(0, 10)}`).subscribe({
      next: (e) => { this.exp.set(e); this.cargandoExp.set(false); },
      error: () => { this.cargandoExp.set(false); },
    });
  }

  /** `1899-12-30T14:18:58` o `14:18:58` → `14:18`. Control guarda la hora con fecha centinela. */
  hhmm(v: string | null | undefined): string {
    const s = String(v ?? '');
    const m = s.match(/(\d{2}):(\d{2})/);
    return m ? `${m[1]}:${m[2]}` : '—';
  }

  usd(v: unknown): string {
    return (Number(v ?? 0) || 0).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  /** Las piezas que de verdad se contaron: las que vienen en cero no se pintan. */
  piezas(m: Record<string, unknown>): Array<{ k: string; etiqueta: string; moneda: boolean; piezas: number; importe: number }> {
    const out: Array<{ k: string; etiqueta: string; moneda: boolean; piezas: number; importe: number }> = [];
    for (const d of DENOMINACIONES) {
      const p = n(m[d.k]);
      if (p > 0) out.push({ k: d.k, etiqueta: d.etiqueta, moneda: d.moneda, piezas: p, importe: p * d.valor });
    }
    return out;
  }

  tieneCustodia(m: MovimientoExpediente): boolean {
    return n(m.total_dolares) + n(m.total_papeles) + n(m.total_cheques) + n(m.total_tarjeta) > 0;
  }
}
