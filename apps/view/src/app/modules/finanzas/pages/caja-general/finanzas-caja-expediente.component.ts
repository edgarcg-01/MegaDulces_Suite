import { ChangeDetectionStrategy, Component, DestroyRef, NgZone, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
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
import { forkJoin } from 'rxjs';
import { CashLedgerService, type FondoSugerido, type SaldoResponse } from '../../cash-ledger.service';
import { CajaSocketService } from '../../caja-socket.service';
import { CaosSocketService } from '../../caos-socket.service';
import { encuestarVisible } from '../../../../core/utils/poll-visible';

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
  /** `[CGA-A.47]` La nota del conteo del corte (p. ej. «CORTE 19/10/2026» en una recaptura). */
  corte_observaciones?: string | null;
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
      <!-- [CGA-A.43] DESIGN Q.1 — la pregunta que trae quien abre esto a medio dia no es «cuanto se
           conto ayer» sino «cuanto hay AHORA». Sin corte abierto el libro dice «sin medir»; aca se
           compone lo que veria quien lo abriera: el cierre anterior + lo de hoy, DECLARADO como
           provisional, y al lado el ultimo conteo de Control para que una discrepancia se vea. -->
      <section class="cx-ahora" aria-labelledby="cx-h-ahora">
        <div class="cx-ahora-cab">
          <h2 id="cx-h-ahora" class="cx-ahora-h">¿Cuánto hay en el cajón ahora?</h2>
          <!-- DESIGN §9 — la cifra es DERIVADA al pedirla: la edad que importa es cuándo se calculó.
               Se recalcula con cada aviso del libro o de CAOS y cada 60 s. -->
          <app-freshness-pill measures="fetch" [since]="cajonAl()" [staleAfterSec]="180" label="calculado"></app-freshness-pill>
        </div>
        <app-load-state [loading]="cajonCargando() && !cajonSaldo()" [error]="cajonError()" [isEmpty]="false"
                        [skeletonRows]="1" errorTitle="No se pudo calcular el cajón" (retry)="cargarCajon()">
          <app-metric-strip [items]="cajonKpis()" ariaLabel="El cajón ahora"></app-metric-strip>
          @if (cajonNota(); as nota) { <p class="cx-ahora-nota">{{ nota }}</p> }
        </app-load-state>
      </section>
      <!-- [CGA-A.47] El ultimo corte, COMPACTO. Medido en vivo el 2026-10-20 (nivel A): el bloque
           anterior eran tres niveles de cajas, 430 px, ~150 px vacios bajo dos columnas, y a 1366 px
           ocupaba toda la primera pantalla. Y afirmaba de mas: «la caja se conto el 20/10» sobre un
           cierre del 19/10 recapturado, «Tarjeta» bajo «no es efectivo», y dolares y papeles como
           si se contaran. -->
      @if (ultimo(); as u) {
        <section class="cx-corte" aria-labelledby="cx-h-ver">
          <div class="cx-corte-cab">
            <h2 id="cx-h-ver" class="cx-h2">
              @if (u.tiene_corte) { Último corte: {{ corteDe(u) }} }
              @else { El {{ dmy(u.fecha) }} nadie contó la caja }
            </h2>
            @if (u.tiene_corte) {
              <p-tag [value]="u.corte_cuadra_ticket ? 'El ticket cuadra' : 'El ticket NO cuadra'"
                     [severity]="u.corte_cuadra_ticket ? 'success' : 'danger'" styleClass="cx-tag" />
              <span class="cx-ver-meta">{{ u.corte_folio }} · capturado el {{ dmy(u.fecha) }} a las {{ hhmm(u.corte_hora) }}</span>
            } @else {
              <p-tag value="Sin conteo" severity="warn" styleClass="cx-tag" />
              <span class="cx-ver-meta">{{ u.movimientos }} movimiento(s) ese día — no es cero: no se midió</span>
            }
          </div>
          @if (u.tiene_corte) {
            <app-metric-strip [items]="corteKpis()" ariaLabel="Lo que registró el último corte" />
            @for (n of corteNotas(); track n) { <p class="cx-nota">{{ n }}</p> }
          }
        </section>
      }

      <section class="cx-block dt-scope" aria-labelledby="cx-h-hist">
        <div class="cx-bh">
          <h2 id="cx-h-hist" class="cx-h2">Historial de cortes</h2>
          <span class="cx-hint">{{ resumenHistorial() }}</span>
        </div>

        <app-load-state [loading]="cargando() && !dias().length" [error]="error()"
                        [isEmpty]="!cargando() && !error() && !dias().length"
                        emptyTitle="Sin cortes en el periodo"
                        emptyHint="El historial sale del Access Control. Si está vacío, el carril de ese dato dejó de llegar."
                        (retry)="recargar()" />

        @if (dias().length) {
          <!-- [CG.127] Paginada: un renglon por DIA; 30 por pagina es un mes. -->
          <!-- [CGA-A.47] De 11 columnas a 8: USD, «≈ pesos» y Papeles tuvieron 1, 1 y 2 valores
               distintos en 80 cortes (medido) — 240 celdas con la misma cifra. Su valor se dice UNA
               vez arriba, declarado como arrastrado. -->
          <p-table [value]="dias()" size="small" dataKey="fecha" [rowHover]="true"
                   class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first dt-stack"
                   [paginator]="dias().length > 30" [rows]="30"
                   [rowsPerPageOptions]="[30, 60, 90]"
                   [showCurrentPageReport]="true"
                   currentPageReportTemplate="{first}–{last} de {totalRecords} días"
                   selectionMode="single" [selection]="diaSel()" (selectionChange)="abrir($event)">
            <ng-template #header>
              <tr>
                <th scope="col">Día</th>
                <th scope="col">Corte</th>
                <th scope="col" class="comm-num">Efectivo en el cajón</th>
                <th scope="col" class="comm-num">Cheques</th>
                <th scope="col" class="comm-num">Tarjeta (Control)</th>
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
                    @if (d.corte_observaciones) { <span class="cx-dim"> · «{{ d.corte_observaciones }}»</span> }
                  } @else { <span class="cx-dim">sin conteo</span> }
                </td>
                <td role="cell" data-label="Efectivo en el cajón" class="comm-num cx-strong">
                  @if (d.tiene_corte) { {{ mx(d.total_efectivo) }} } @else { <span class="cx-dim">—</span> }
                </td>
                <td role="cell" data-label="Cheques" class="comm-num">
                  @if (d.tiene_corte) { {{ mx(d.total_cheques) }} } @else { <span class="cx-dim">—</span> }
                </td>
                <td role="cell" data-label="Tarjeta (Control)" class="comm-num">
                  @if (d.tiene_corte) { {{ mx(d.total_tarjeta) }} } @else { <span class="cx-dim">—</span> }
                </td>
                <td role="cell" data-label="Total declarado" class="comm-num cx-dim">
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

    .cx-ahora { margin-block:var(--sp-4) var(--sp-2); }
    .cx-ahora-cab { display:flex; flex-wrap:wrap; align-items:center; gap:var(--sp-3); margin:0 0 var(--sp-2); }
    .cx-ahora-h { font-size:var(--fs-h3); font-weight:600; margin:0; }
    .cx-ahora-nota { font-size:var(--fs-sm); color:var(--text-muted); margin:var(--sp-2) 0 0; max-width:60rem; }
    /* [CGA-A.47] El ultimo corte, compacto: una cabecera de una linea y una tira de cifras, sin
       paneles anidados. La jerarquia la lleva el peso (DESIGN Q.5), no mas cajas. */
    .cx-corte { margin-block:var(--sp-4); padding-block:var(--sp-3); border-block:1px solid var(--border-color); }
    .cx-corte-cab { display:flex; align-items:center; gap:var(--sp-3); flex-wrap:wrap; margin-bottom:var(--sp-2); }
    .cx-h2 { margin:0; font-size:var(--fs-h3); font-weight:600; }
    .cx-ver-meta { color:var(--text-muted); font-size:var(--fs-sm); }
    .cx-nota { margin:var(--sp-1) 0 0; font-size:var(--fs-sm); color:var(--text-muted); max-width:64rem; }

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
export class FinanzasCajaExpedienteComponent implements OnInit, OnDestroy {
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

  /**
   * ⛔ `[CGA-A.47]` **Qué cierre es, de verdad.** La vista agrupa por la fecha en que Control
   * CAPTURÓ el conteo, y a veces recaptura un cierre al día siguiente: el 2026-10-20 la pantalla
   * decía «La caja se contó el 20/10/26» sobre A23678, cuya nota dice «CORTE 19/10/2026». Si la
   * nota nombra otro día, se dice ese día y que se recapturó; si no, la fecha de captura.
   */
  corteDe(u: CorteDia): string {
    const m = /CORTE\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i.exec(u.corte_observaciones ?? '');
    if (m) {
      const dia = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      if (dia !== String(u.fecha).slice(0, 10)) return `cierre del ${this.dmy(dia)}, recapturado`;
      return `cierre del ${this.dmy(dia)}`;
    }
    return `se contó el ${this.dmy(u.fecha)}`;
  }

  /**
   * `[CGA-A.47]` Lo que registró el último corte, en UNA tira. Sólo lo que cambia de un corte a
   * otro: dólares y papeles se dicen aparte (`corteNotas`) porque se arrastran.
   */
  readonly corteKpis = computed<MetricStripItem[]>(() => {
    const u = this.ultimo();
    if (!u?.tiene_corte) return [];
    return [
      { label: 'Efectivo en el cajón', value: this.mx(u.total_efectivo),
        sub: `${this.mx(u.total_billetes)} en billetes · ${this.mx(u.total_monedas)} en monedas` },
      { label: 'Cheques', value: this.mx(u.total_cheques) },
      { label: 'Tarjeta (Control)', value: this.mx(u.total_tarjeta),
        sub: 'ver la nota de abajo' },
    ];
  });

  /**
   * `[CGA-A.47]` Lo que el corte afirma SIN haberlo medido, con su número. Estándar 1.3: lo que no
   * se midió se declara. Medido el 2026-10-20 sobre 80 cortes: USD con 1 valor distinto (×80) y
   * papeles con 2 (uno ×79) — se arrastran (VERDAD §28.4), y antes salían en tarjetas propias
   * como «En custodia» y «Papeles por pagar».
   */
  readonly corteNotas = computed<string[]>(() => {
    const u = this.ultimo();
    const d = this.dias().filter((x) => x.tiene_corte);
    if (!u?.tiene_corte || !d.length) return [];
    const igual = (k: keyof CorteDia) => d.filter((x) => String(x[k]) === String(u[k])).length;
    const notas: string[] = [];
    const usd = Number(u.dolares_usd ?? 0);
    const pap = Number(u.total_papeles ?? 0);
    const partes: string[] = [];
    if (usd) partes.push(`${this.usd(u.dolares_usd)} USD`
      + (u.tipo_cambio ? ` (≈ ${this.mx(u.total_dolares)} al tipo de cambio ${u.tipo_cambio})` : '')
      + ` — el mismo valor en ${igual('dolares_usd')} de ${d.length} cortes`);
    if (pap) partes.push(`papeles por pagar ${this.mx(u.total_papeles)} — el mismo valor en ${igual('total_papeles')} de ${d.length}`);
    if (partes.length) notas.push(`Sin recontar (se arrastran de un corte a otro): ${partes.join('; ')}.`);
    /**
     * ⚠️ «Tarjeta» de Control: en los cortes del 19 y 20-oct-2026 coincidió AL PESO con el saldo
     * de la caja fuerte ($360,020), medido con el replay de CAOS ya validado. Es probable que el
     * cajero anote ahí la caja fuerte; NO está confirmado con operación, y los días anteriores no
     * se pudieron verificar. Se dice con su fecha para que no se lea como regla.
     */
    if (Number(u.total_tarjeta ?? 0)) {
      notas.push('«Tarjeta» es lo que anotó Control en ese campo. En los cortes del 19 y 20-oct-2026 coincidió al peso '
        + 'con el saldo de la caja fuerte: probablemente el cajero anota ahí la caja fuerte (falta confirmarlo con operación).');
    }
    notas.push(`Total declarado por Control: ${this.mx(u.total_declarado)} — suma efectivo, dólares, papeles, cheques y tarjeta; no es lo que hay en el cajón.`);
    return notas;
  });

  /** `[CGA-A.47]` Lo que antes era una tira de 4 KPI (dos repetían cifras de arriba), en una línea. */
  readonly resumenHistorial = computed<string>(() => {
    const d = this.dias();
    if (!d.length) return 'Elige un día para ver su expediente';
    const sinConteo = d.filter((x) => !x.tiene_corte).length;
    const sinCuadrar = d.reduce((a, x) => a + Number(x.tickets_que_no_cuadran || 0), 0);
    return `${d.length} días · ${sinConteo} sin conteo · ${sinCuadrar} ticket(s) sin cuadrar · elige un día para ver su expediente`;
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

  // ── `[CGA-A.43]` El cajón AHORA ──────────────────────────────────────────────────────────
  //
  // ⚠️ La caja de oficinas es la sucursal `00` (la misma que usa Captura para CAOS y el corte).
  private readonly cajas = inject(CashLedgerService);
  readonly cajonFondo = signal<FondoSugerido | null>(null);
  readonly cajonSaldo = signal<SaldoResponse | null>(null);
  readonly cajonCargando = signal(false);
  readonly cajonError = signal<string | null>(null);

  /** Cuándo se calculó el cajón por última vez (hora del navegador: la cifra es DERIVADA al pedirla). */
  readonly cajonAl = signal<string | null>(null);

  cargarCajon(): void {
    this.cajonCargando.set(true);
    forkJoin({ f: this.cajas.fondoSugerido('00'), s: this.cajas.saldo('00') }).subscribe({
      next: ({ f, s }) => {
        this.cajonFondo.set(f); this.cajonSaldo.set(s);
        this.cajonError.set(null); this.cajonCargando.set(false);
        this.cajonAl.set(new Date().toISOString());
      },
      error: () => { this.cajonError.set('No se pudo leer el saldo del libro de Caja General.'); this.cajonCargando.set(false); },
    });
  }

  /**
   * ⭐ `[CGA-A.43]` Tres cifras, y cada una dice con qué se calculó:
   *
   *  · **corte abierto** → el esperado del corte (fondo + lo capturado). Derivado, no contado.
   *  · **sin corte** → el cierre anterior + el efecto de los movimientos de hoy (el `esperado` del
   *    motor con fondo `null` ES ese efecto: `(fondo ?? 0) + ingresos − gastos − depósitos +
   *    dispensado − depositado`). Es exactamente lo que vería quien abriera el corte ahora, sin
   *    fórmula nueva. Se marca **provisional**: nadie lo contó hoy.
   *  · **arqueo ciego** → a quien no autoriza el servidor no le manda el esperado, y aquí se dice
   *    en vez de dibujar un cero.
   *
   * La tercera es el último conteo de Control, como CONTRASTE: el 2026-10-20 el cierre del 19-oct
   * existía en dos versiones ($88,272.50 en la suite, $288,972.50 recapturado en Control) y un
   * provisional que callara la otra afirmaría una certeza que nadie tiene.
   */
  readonly cajonKpis = computed<MetricStripItem[]>(() => {
    const f = this.cajonFondo();
    const s = this.cajonSaldo();
    const items: MetricStripItem[] = [];
    const efecto = s && !s.saldo_oculto && s.totales?.esperado != null ? Number(s.totales.esperado) : null;
    let base: number | null = null;

    if (!s) {
      items.push({ label: 'En el cajón ahora', value: 'sin medir', state: 'no_medido', stateNote: 'Todavía no se leyó el libro.' });
    } else if (s.saldo_oculto) {
      items.push({ label: 'En el cajón ahora', value: 'oculto', state: 'no_medido',
        stateNote: 'Arqueo ciego: el esperado sólo lo ve quien autoriza el corte.' });
    } else if (s.corte_abierto && s.saldo != null) {
      base = Number(s.saldo);
      items.push({ label: 'En el cajón ahora', value: money(base), state: 'derivado',
        method: `fondo del corte ${s.corte_abierto.folio} + lo capturado; no es un conteo`,
        sub: `según el corte abierto ${s.corte_abierto.folio}` });
    } else if (f?.monto != null && efecto != null) {
      base = Number(f.monto) + efecto;
      items.push({ label: 'En el cajón ahora', value: money(base), state: 'derivado', tone: 'warn',
        method: `cierre anterior (${f.procedencia ?? 'su conteo'}) + ${s.totales.movimientos} movimiento(s) de hoy`,
        sub: 'provisional · nadie ha abierto ni contado el corte de hoy' });
    } else {
      items.push({ label: 'En el cajón ahora', value: 'sin medir', state: 'no_medido',
        stateNote: 'No hay cierre anterior medido del que partir.' });
    }

    if (efecto != null && s && !s.corte_abierto) {
      const disp = Number(s.cajero?.dispensado ?? 0);
      items.push({ label: 'Lo de hoy', value: `${efecto < 0 ? '−' : '+'}${money(Math.abs(efecto))}`,
        sub: `${s.totales.movimientos} capturado(s)` + (disp ? ` · CAOS dispensó ${money(disp)}` : '') });
    }

    // `[CGA-A.47]` El último conteo de Control ya NO va en esta tira: la sección «Último corte»,
    // justo abajo, publica la misma cifra. La discrepancia contra el cierre del que parte el
    // provisional se sigue diciendo, con sus dos montos, en `cajonNota`.
    return items;
  });

  /** Lo que el provisional NO sabe, dicho en una línea — y la discrepancia, si la hay. */
  readonly cajonNota = computed<string | null>(() => {
    const f = this.cajonFondo();
    const s = this.cajonSaldo();
    const u = this.ultimo();
    const partes: string[] = [];
    if (u?.tiene_corte && f?.monto != null) {
      const dif = Math.round((Number(u.total_efectivo ?? 0) - Number(f.monto)) * 100) / 100;
      if (Math.abs(dif) > 0.005) {
        partes.push(`El cierre del que parte (${money(Number(f.monto))}) y el último conteo de Control ${u.corte_folio} `
          + `(${money(Number(u.total_efectivo ?? 0))}) difieren ${money(Math.abs(dif))}: uno de los dos está mal o falta registrar algo. `
          + 'Sólo un conteo lo resuelve.');
      }
    }
    if (s && !s.corte_abierto && !s.saldo_oculto) {
      partes.push('Para que deje de ser provisional: Captura → «Abrir corte» y contar.');
      const ant = s.sueltos_fuera?.anteriores;
      if (ant?.movimientos) partes.push(`No incluye ${ant.movimientos} movimiento(s) sueltos de días anteriores (neto ${money(ant.neto)}).`);
    }
    return partes.length ? partes.join(' ') : null;
  });

  private readonly sockCaja = inject(CajaSocketService);
  private readonly sockCaos = inject(CaosSocketService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly zone = inject(NgZone);

  ngOnInit(): void {
    this.recargar();
    this.enVivo();
  }

  ngOnDestroy(): void {
    this.sockCaja.disconnect();
    this.sockCaos.disconnect();
  }

  /**
   * `[CGA-A.43]` **El cajón se recalcula solo.** Antes cargaba al abrir y al apretar
   * «Actualizar»: con la pantalla abierta, los movimientos seguían entrando y la cifra se quedaba
   * vieja sin decirlo. Tres disparadores, cada uno por una razón:
   *
   *  · aviso del LIBRO (`/caja`): alguien capturó algo → el efecto del día cambió;
   *  · aviso de CAOS (`/caos`): la máquina dispensó o recibió billetes → el cajón cambió aunque
   *    nadie capture nada (en el corte, lo dispensado está en el cajón hasta que se registre);
   *  · repaso de 60 s con la pestaña visible: un conteo nuevo de Control llega por réplica y NO
   *    avisa; y un aviso perdido no deja rastro. Medido 2026-10-20: cajón ~100 ms, historial de
   *    Control ~300 ms.
   *
   * Los avisos sólo recalculan el CAJÓN (barato); el historial entra con el repaso.
   */
  private enVivo(): void {
    try {
      this.sockCaja.connect();
      this.sockCaja.change$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.cargarCajon());
      this.sockCaos.connect();
      this.sockCaos.change$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.cargarCajon());
    } catch (e) {
      console.warn('[expediente] sin avisos en vivo; queda el repaso:', e);
    }
    encuestarVisible(60000, () => this.recargar(true), { destroyRef: this.destroyRef, zone: this.zone });
  }

  /**
   * @param silencioso `[CGA-A.43]` El repaso de 60 s NO vuelve a pintar el esqueleto sobre una tabla
   *   que ya tiene datos (parpadearía cada minuto), y un fallo de ese repaso no borra lo que se ve:
   *   se declara en `error` sólo si no había nada que mostrar.
   */
  recargar(silencioso = false): void {
    this.cargarCajon();
    const conDatos = this.dias().length > 0;
    if (!(silencioso && conDatos)) { this.cargando.set(true); this.error.set(null); }
    this.http.get<{ rows: CorteDia[]; frescura?: Freshness }>(`${this.base}/cortes?limit=90`).subscribe({
      next: (r) => { this.dias.set(r?.rows ?? []); this.frescura.set(r?.frescura ?? null); this.cargando.set(false); this.error.set(null); },
      error: () => {
        if (!(silencioso && conDatos)) this.error.set('No se pudo traer el historial de cortes.');
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
