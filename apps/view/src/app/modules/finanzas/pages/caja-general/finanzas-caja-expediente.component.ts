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
import { SegmentedComponent, type SegOption } from '../../../../shared/components/segmented/segmented.component';
import type { Freshness } from '@megadulces/contracts';
import { FINANZAS_SHARED_STYLES } from '../finanzas-shared.styles';
import { CajaTabsComponent } from '../../caja-tabs.component';
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
    LoadStateComponent, SidePeekComponent, MetricStripComponent, FreshnessPillComponent, SegmentedComponent,
    CajaTabsComponent],
  template: `
    <!-- [CG.121] Captura / Expediente / Caja Fuerte son UN area, no tres reportes sueltos. -->
    <app-caja-tabs />
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

      <!-- ⭐ [CG.106] El selector de arriba. Edgar: una pantalla, dos trabajos distintos, y la
           persona que revisa en la mañana no tiene que pasar por el otro para llegar al suyo.
           Arranca en Corte historico: ESE es el trabajo de la mañana. -->
      <app-segmented [options]="VISTAS" [value]="vista()" (valueChange)="cambiarVista($event)"
                     ariaLabel="Qué quieres revisar" />

      @if (vista() === 'corte') {
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
              <!-- 1) EFECTIVO EN PESOS. Lo UNICO que se cuadra contra lo que hay en el cajon. -->
              <section class="cx-grupo cx-grupo-efe" aria-labelledby="cx-g-efe">
                <h3 id="cx-g-efe" class="cx-grupo-h">
                  <i class="pi pi-wallet" aria-hidden="true"></i> Efectivo en pesos
                  <span class="cx-grupo-sub">esto es lo que se cuenta y lo que tiene que cuadrar</span>
                </h3>
                <div class="cx-grupo-body">
                  <div class="cx-ap cx-ap-fuerte">
                    <span class="cx-ap-lbl">En el cajón</span>
                    <strong class="comm-num">{{ mx(u.total_efectivo) }}</strong>
                    <small>{{ mx(u.total_billetes) }} en billetes · {{ mx(u.total_monedas) }} en monedas</small>
                  </div>
                </div>
              </section>

              <!-- 2) DOLARES. Moneda distinta: el peso que muestra depende de un tipo de cambio
                   que alguien tecleo, asi que se dice en USD Y en pesos, nunca solo en pesos. -->
              <section class="cx-grupo cx-grupo-usd" aria-labelledby="cx-g-usd">
                <h3 id="cx-g-usd" class="cx-grupo-h">
                  <i class="pi pi-dollar" aria-hidden="true"></i> Dólares
                  <span class="cx-grupo-sub">otra moneda — no entra al cuadre en pesos</span>
                </h3>
                <div class="cx-grupo-body">
                  <div class="cx-ap">
                    <span class="cx-ap-lbl">En custodia</span>
                    <strong class="comm-num">{{ usd(u.dolares_usd) }} USD</strong>
                    <small>
                      @if (u.tipo_cambio) {
                        ≈ {{ mx(u.total_dolares) }} al tipo de cambio {{ u.tipo_cambio }}
                      } @else {
                        sin tipo de cambio declarado: el valor en pesos no se puede publicar
                      }
                    </small>
                  </div>
                </div>
              </section>

              <!-- 3) CREDITO Y DEMAS PAPEL. No es dinero todavia: es una promesa. -->
              <section class="cx-grupo cx-grupo-cre" aria-labelledby="cx-g-cre">
                <h3 id="cx-g-cre" class="cx-grupo-h">
                  <i class="pi pi-file-edit" aria-hidden="true"></i> Crédito y papel
                  <span class="cx-grupo-sub">no es efectivo: es lo que alguien debe o todavía no se cobra</span>
                </h3>
                <div class="cx-grupo-body">
                  <div class="cx-ap">
                    <span class="cx-ap-lbl">Papeles por pagar</span>
                    <strong class="comm-num">{{ mx(u.total_papeles) }}</strong>
                  </div>
                  <div class="cx-ap">
                    <span class="cx-ap-lbl">Cheques</span>
                    <strong class="comm-num">{{ mx(u.total_cheques) }}</strong>
                  </div>
                  <div class="cx-ap">
                    <span class="cx-ap-lbl">Tarjeta</span>
                    <strong class="comm-num">{{ mx(u.total_tarjeta) }}</strong>
                  </div>
                </div>
              </section>
            </div>

            <p class="cx-ver-total">
              Suma de los tres: <strong class="comm-num">{{ mx(u.total_declarado) }}</strong>
              <span class="cx-dim"> — es el total que declaró Control, no lo que hay en el cajón.</span>
            </p>
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
          <!-- [CG.127] Paginada: es un renglon por DIA, asi que su largo lo fija el rango que
               elija quien revisa -- un trimestre son ~90 renglones. 30 por pagina es un mes,
               que es la unidad con la que se revisa un corte diario. -->
          <p-table [value]="dias()" size="small" dataKey="fecha" [rowHover]="true"
                   class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first dt-stack"
                   [paginator]="dias().length > 30" [rows]="30"
                   [rowsPerPageOptions]="[30, 60, 90]"
                   [showCurrentPageReport]="true"
                   currentPageReportTemplate="{first}–{last} de {totalRecords} días"
                   selectionMode="single" [selection]="diaSel()" (selectionChange)="abrir($event)">
            <ng-template #header>
              <!-- Las tres familias, rotuladas. Sin esta fila, efectivo, dolares y credito se
                   leen como una sola cifra corrida y el que revisa en la mañana suma lo que no
                   se suma: solo la primera columna cuadra contra lo que hay en el cajon. -->
              <tr class="cx-grp-row">
                <th scope="colgroup" colspan="2"></th>
                <th scope="colgroup" class="cx-grp cx-grp-efe">Efectivo en pesos</th>
                <th scope="colgroup" class="cx-grp cx-grp-usd" colspan="2">Dólares</th>
                <th scope="colgroup" class="cx-grp cx-grp-cre" colspan="3">Crédito y papel</th>
                <th scope="colgroup" colspan="3"></th>
              </tr>
              <tr>
                <th scope="col">Día</th>
                <th scope="col">Corte</th>
                <th scope="col" class="comm-num cx-grp-efe">En el cajón</th>
                <th scope="col" class="comm-num cx-grp-usd">USD</th>
                <th scope="col" class="comm-num cx-grp-usd">≈ pesos</th>
                <th scope="col" class="comm-num cx-grp-cre">Papeles</th>
                <th scope="col" class="comm-num cx-grp-cre">Cheques</th>
                <th scope="col" class="comm-num cx-grp-cre">Tarjeta</th>
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
                <td role="cell" data-label="Efectivo en el cajón" class="comm-num cx-grp-efe cx-strong">
                  @if (d.tiene_corte) { {{ mx(d.total_efectivo) }} } @else { <span class="cx-dim">—</span> }
                </td>
                <td role="cell" data-label="Dólares (USD)" class="comm-num cx-grp-usd">
                  @if (d.tiene_corte) { {{ usd(d.dolares_usd) }} } @else { <span class="cx-dim">—</span> }
                </td>
                <td role="cell" data-label="Dólares en pesos" class="comm-num cx-grp-usd">
                  @if (d.tiene_corte && d.tipo_cambio) { {{ mx(d.total_dolares) }} }
                  <!-- El texto va VISIBLE, no en un title: un title solo existe para quien
                       tiene mouse, y esta pantalla se revisa tambien desde el telefono. -->
                  @else if (d.tiene_corte) { <span class="cx-dim">sin tipo de cambio</span> }
                  @else { <span class="cx-dim">—</span> }
                </td>
                <td role="cell" data-label="Papeles" class="comm-num cx-grp-cre">
                  @if (d.tiene_corte) { {{ mx(d.total_papeles) }} } @else { <span class="cx-dim">—</span> }
                </td>
                <td role="cell" data-label="Cheques" class="comm-num cx-grp-cre">
                  @if (d.tiene_corte) { {{ mx(d.total_cheques) }} } @else { <span class="cx-dim">—</span> }
                </td>
                <td role="cell" data-label="Tarjeta" class="comm-num cx-grp-cre">
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
      }

      @if (vista() === 'expediente') {
        <section class="cx-block" aria-labelledby="cx-h-exp">
          <div class="cx-bh">
            <h2 id="cx-h-exp">Expediente del día</h2>
            <span class="cx-hint">Cada movimiento con su ticket, tal como se contó</span>
          </div>

          <div class="cx-dias" role="group" aria-label="Elegir el día">
            @for (d of diasRecientes(); track d.fecha) {
              <button type="button" class="cx-dia" [class.cx-dia-on]="esDiaElegido(d)"
                      [attr.aria-pressed]="esDiaElegido(d)" (click)="abrirInline(d)">
                <span class="cx-dia-f">{{ dmy(d.fecha) }}</span>
                <span class="cx-dia-n">{{ d.movimientos }} mov.</span>
                @if (!d.tiene_corte) { <span class="cx-dia-sc">sin conteo</span> }
              </button>
            }
          </div>

          <app-load-state [loading]="cargandoExp()" [skeletonRows]="6"
                          [isEmpty]="!cargandoExp() && !!exp() && !exp()!.rows.length"
                          emptyTitle="Ese día no tuvo movimientos" />
          @if (!cargandoExp() && exp(); as e) {
            <ng-container *ngTemplateOutlet="listaMovs; context: { $implicit: e }"></ng-container>
          }
        </section>
      }

      <app-side-peek [(open)]="peek" mode="window" [width]="1040"
                     [title]="'Expediente del ' + (diaSel()?.fecha ? dmy(diaSel()!.fecha) : '')"
                     [subtitle]="subtituloPeek()">
        @if (cargandoExp()) {
          <app-load-state [loading]="true" [skeletonRows]="8" />
        } @else if (exp(); as e) {
          <ng-container *ngTemplateOutlet="listaMovs; context: { $implicit: e }"></ng-container>
        }
      </app-side-peek>

      <!-- ⚠️ UNA sola definición de la lista de movimientos, usada por la vista Expediente y por
           el cajón del Corte histórico. Duplicarla era el camino corto y el de siempre: la de
           abajo se queda vieja y nadie lo nota hasta que los dos lugares dicen cosas distintas
           del mismo movimiento. -->
      <ng-template #listaMovs let-e>
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
      </ng-template>
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
      grid-template-columns:repeat(auto-fit, minmax(16rem, 1fr));
      align-items:start;
    }

    /* [CG.107] Las TRES familias separadas. Edgar: "separemos dls, efectivo y credito".
       No es cosmetico: solo la primera cuadra contra lo que hay en el cajon, la segunda esta
       en otra moneda y la tercera todavia no es dinero. Verlas corridas invita a sumarlas. */
    .cx-grupo {
      border:1px solid var(--border-color); border-radius:var(--r-md);
      padding:var(--sp-3); background:var(--surface-card);
      border-top-width:3px;
    }
    .cx-grupo-efe { border-top-color:var(--action); }
    .cx-grupo-usd { border-top-color:var(--text-muted); }
    .cx-grupo-cre { border-top-color:var(--warn-fg); }
    .cx-grupo-h {
      margin:0 0 var(--sp-3); font-size:var(--fs-sm); display:flex; flex-wrap:wrap;
      align-items:baseline; gap:var(--sp-2);
    }
    .cx-grupo-h i { color:var(--text-muted); }
    .cx-grupo-sub { flex:1 1 100%; font-weight:400; color:var(--text-faint); font-size:var(--fs-micro); }
    .cx-grupo-body { display:flex; flex-direction:column; gap:var(--sp-2); }
    .cx-ver-total { margin:var(--sp-3) 0 0; font-size:var(--fs-sm); }

    /* En la tabla las familias se rotulan con una fila de grupo. El tinte es AYUDA, no la
       señal: la señal es el texto del encabezado, que sobrevive a Alto Contraste. */
    .cx-grp { font-size:var(--fs-micro); color:var(--text-muted); text-align:center; font-weight:400; }
    .cx-grp-row th { border-bottom:none; padding-bottom:0; }
    .cx-grp-efe { background:color-mix(in srgb, var(--action) 7%, transparent); }
    .cx-grp-usd { background:var(--overlay-hover); }
    .cx-grp-cre { background:color-mix(in srgb, var(--warn-fg) 7%, transparent); }
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

    /* [CG.106] Los dias como atajo del Expediente. Botones de verdad, no divs con click:
       asi llegan por teclado y el lector de pantalla dice cual esta elegido (aria-pressed). */
    .cx-dias {
      display:flex; gap:var(--sp-2); flex-wrap:wrap; margin-bottom:var(--sp-4);
    }
    .cx-dia {
      display:flex; flex-direction:column; gap:2px; align-items:flex-start;
      padding:var(--sp-2) var(--sp-3); border:1px solid var(--border-color);
      border-radius:var(--r-md); background:transparent; color:var(--text-main);
      cursor:pointer; font:inherit;
    }
    .cx-dia:hover { background:var(--overlay-hover); }
    .cx-dia:focus-visible { outline:2px solid var(--action); outline-offset:2px; }
    /* El elegido se marca con BORDE y peso, no solo con color: en Alto Contraste de Windows
       el fondo se reemplaza y un estado que solo vive en el color desaparece. */
    .cx-dia-on { border-color:var(--action); border-width:2px; font-weight:var(--fw-bold, 700); }
    .cx-dia-f { font-size:var(--fs-sm); }
    .cx-dia-n { font-size:var(--fs-micro); color:var(--text-muted); }
    .cx-dia-sc { font-size:var(--fs-micro); color:var(--warn-fg); }

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

  /**
   * ⭐ `[CG.106]` **Las dos mitades de la pantalla, y cuál abre primero.**
   *
   * Edgar: *"para la persona que revisa todas las mañanas que el saldo cuadre con lo que existe
   * en caja"*. Esa persona entra a UNA cosa: el corte. Por eso `corte` es el valor inicial —
   * abrir en el expediente la obligaría a cambiar de pestaña todos los días para llegar a su
   * trabajo, que es el defecto que el selector viene a quitar, no a crear.
   */
  readonly VISTAS: SegOption[] = [
    { label: 'Corte histórico', value: 'corte' },
    { label: 'Expediente del día', value: 'expediente' },
  ];
  readonly vista = signal<'corte' | 'expediente'>('corte');

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

  /** Los días que se ofrecen como atajo en el Expediente. 14 entran sin hacer scroll. */
  readonly diasRecientes = computed<CorteDia[]>(() => this.dias().slice(0, 14));

  esDiaElegido(d: CorteDia): boolean {
    return String(this.diaSel()?.fecha ?? '').slice(0, 10) === String(d.fecha).slice(0, 10);
  }

  /**
   * `[CG.106]` Cambiar de mitad. Al entrar al Expediente **sin día elegido** se abre el más
   * reciente: una pantalla que arranca vacía obliga a un clic que no decide nada.
   */
  cambiarVista(v: string): void {
    const x = v === 'expediente' ? 'expediente' : 'corte';
    this.vista.set(x);
    if (x === 'expediente' && !this.exp() && this.dias().length) {
      this.abrirInline(this.dias()[0]);
    }
  }

  /** Elegir día DENTRO del expediente: carga en la página, sin abrir el cajón. */
  abrirInline(d: CorteDia): void {
    this.diaSel.set(d);
    this.cargarExpediente(d);
  }

  abrir(d: CorteDia | null): void {
    if (!d) return;
    this.diaSel.set(d);
    this.peek.set(true);
    this.cargarExpediente(d);
  }

  /**
   * ⚠️ `exp` se limpia ANTES de pedir: si no, mientras carga el día nuevo la pantalla sigue
   * mostrando los movimientos del anterior con el título ya cambiado — un expediente que dice
   * ser de un día y enseña otro.
   */
  private cargarExpediente(d: CorteDia): void {
    this.exp.set(null);
    this.cargandoExp.set(true);
    this.http.get<Expediente>(`${this.base}/expediente/${String(d.fecha).slice(0, 10)}`).subscribe({
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
