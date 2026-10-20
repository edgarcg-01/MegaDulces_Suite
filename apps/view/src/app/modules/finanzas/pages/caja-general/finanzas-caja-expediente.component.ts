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
import { MetricCardComponent, type MetricChip } from '../../../../shared/components/metric-card/metric-card.component';
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
    LoadStateComponent, SidePeekComponent, MetricStripComponent, MetricCardComponent, FreshnessPillComponent, SegmentedComponent,
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
            <!-- [CGA-A.47] Tarjetas compactas (propuesta aprobada por Edgar, 2026-10-20): cada una dice
                 CON QUE se midio -- borde solido = contado, punteado = se arrastra sin recontar, chip
                 «por confirmar» = interpretacion sin validar -- y trae su linea de 14 dias, donde un
                 dia sin conteo es un HUECO, no un cero. -->
            <div class="cx-cards">
              <app-metric-card class="cx-card-principal" label="Efectivo en el cajón" format="text" [valueText]="mx(u.total_efectivo)"
                               [compact]="true" [large]="true" tone="brand" variant="sparkline"
                               [series]="serie('total_efectivo')" [seriesLabels]="serieFechas()"
                               [deltaLabel]="deltaDe('total_efectivo').texto" [deltaDir]="deltaDe('total_efectivo').dir"
                               [chips]="[{ texto: 'contado', tono: 'mute' }]">
                @if (denoms().length) {
                  <div class="cx-denoms" role="img" [attr.aria-label]="'Por denominación: ' + denomsTexto()">
                    @for (s of denoms(); track s.etiqueta) {
                      <span [style.width.%]="s.pct" [style.background]="s.color" [attr.title]="s.etiqueta + ' = ' + mx(s.monto)"></span>
                    }
                  </div>
                  <div class="cx-leyenda">
                    @for (s of denoms(); track s.etiqueta) { <span><i [style.background]="s.color"></i>{{ s.etiqueta }}</span> }
                  </div>
                }
              </app-metric-card>
              <app-metric-card label="Cheques" format="text" [valueText]="mx(u.total_cheques)" [compact]="true" variant="sparkline"
                               [series]="serie('total_cheques')" [seriesLabels]="serieFechas()" [accent]="'var(--text-faint)'"
                               [deltaLabel]="deltaDe('total_cheques').texto" [deltaDir]="deltaDe('total_cheques').dir" />
              <app-metric-card label="Tarjeta" format="text" [valueText]="mx(u.total_tarjeta)" [compact]="true" variant="sparkline"
                               [series]="serie('total_tarjeta')" [seriesLabels]="serieFechas()" [accent]="'var(--text-faint)'"
                               [deltaLabel]="deltaDe('total_tarjeta').texto" [deltaDir]="deltaDe('total_tarjeta').dir"
                               [chips]="chipsTarjeta" />
              <app-metric-card label="Dólares" format="text" [valueText]="usd(u.dolares_usd) + ' USD'" [compact]="true" medicion="arrastre"
                               [sub]="u.tipo_cambio ? '≈ ' + mx(u.total_dolares) + ' · tipo de cambio ' + u.tipo_cambio : 'sin tipo de cambio declarado'"
                               [chips]="[{ texto: 'sin recontar', tono: 'mute', icono: 'pi-replay' }]">
                <div class="cx-repite"><span class="cx-repite-barra"><b [style.width.%]="repite('dolares_usd').pct"></b></span>igual en {{ repite('dolares_usd').n }} de {{ repite('dolares_usd').de }} cortes</div>
              </app-metric-card>
              <app-metric-card label="Papeles" format="text" [valueText]="mx(u.total_papeles)" [compact]="true" medicion="arrastre" sub="por pagar"
                               [chips]="[{ texto: 'sin recontar', tono: 'mute', icono: 'pi-replay' }]">
                <div class="cx-repite"><span class="cx-repite-barra"><b [style.width.%]="repite('total_papeles').pct"></b></span>igual en {{ repite('total_papeles').n }} de {{ repite('total_papeles').de }} cortes</div>
              </app-metric-card>
            </div>
            <!-- El total que declaro Control, como COMPOSICION: se ve de que esta hecho y que no es el cajon. -->
            <div class="cx-total">
              <div class="cx-total-t">Total declarado por Control<strong class="comm-num">{{ mx(u.total_declarado) }}</strong>no es lo que hay en el cajón</div>
              <div class="cx-total-g">
                <div class="cx-comp" role="img" [attr.aria-label]="'De qué está hecho el total: ' + composicionTexto()">
                  @for (p of composicion(); track p.nombre) {
                    <span [style.width.%]="p.pct" [style.background]="p.color" [attr.title]="p.nombre + ' ' + mx(p.monto)"></span>
                  }
                </div>
                <div class="cx-leyenda">
                  @for (p of composicion(); track p.nombre) { <span><i [style.background]="p.color"></i>{{ p.nombre }} {{ p.pctTexto }}</span> }
                </div>
              </div>
            </div>
            <p class="cx-codigo">
              <span><i class="cx-mini"></i>borde sólido: se contó</span>
              <span><i class="cx-mini cx-mini-d"></i>punteado: se arrastra, nadie lo recontó</span>
              <span>la línea: últimos 14 días · una marca abajo = día sin conteo</span>
            </p>
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
    /* Tarjetas: llenan el ancho; la del efectivo ocupa dos columnas (es la que se cuadra). */
    .cx-cards { display:grid; gap:var(--sp-2); grid-template-columns:repeat(auto-fit, minmax(13rem, 1fr)); }
    .cx-card-principal { grid-column:span 2; }
    .cx-denoms { display:flex; height:8px; border-radius:999px; overflow:hidden; background:var(--overlay-hover); margin-top:var(--sp-1); }
    .cx-denoms span { height:100%; }
    .cx-leyenda { display:flex; flex-wrap:wrap; gap:var(--sp-1) var(--sp-3); font-size:var(--fs-micro); color:var(--text-muted); }
    .cx-leyenda i { display:inline-block; width:8px; height:8px; border-radius:2px; margin-right:var(--sp-1); }
    .cx-repite { display:flex; align-items:center; gap:var(--sp-2); font-size:var(--fs-xs); color:var(--text-muted); }
    .cx-repite-barra { flex:1; height:4px; border-radius:999px; background:var(--overlay-hover); overflow:hidden; }
    .cx-repite-barra b { display:block; height:100%; background:var(--text-faint); }
    .cx-total { display:grid; grid-template-columns:auto 1fr; gap:var(--sp-2) var(--sp-4); align-items:center; margin-top:var(--sp-2);
                padding:var(--sp-3) var(--sp-4); border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); }
    .cx-total-t { font-size:var(--fs-xs); color:var(--text-muted); }
    .cx-total-t strong { display:block; font-size:var(--fs-lg); color:var(--text-main); }
    .cx-total-g { display:flex; flex-direction:column; gap:var(--sp-2); min-width:0; }
    .cx-comp { display:flex; height:10px; border-radius:999px; overflow:hidden; }
    .cx-comp span { height:100%; }
    .cx-comp span + span { box-shadow:inset 1px 0 0 var(--card-bg); }
    .cx-codigo { display:flex; flex-wrap:wrap; gap:var(--sp-2) var(--sp-4); margin:var(--sp-2) 0 0; font-size:var(--fs-xs); color:var(--text-muted); }
    .cx-codigo span { display:inline-flex; align-items:center; gap:var(--sp-2); }
    .cx-mini { display:inline-block; width:18px; height:12px; border-radius:3px; border:1.5px solid var(--text-faint); }
    .cx-mini-d { border-style:dashed; }
    @container (max-width: 44rem) { .cx-card-principal { grid-column:auto; } .cx-total { grid-template-columns:1fr; } }

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

  // ── `[CGA-A.47]` Las tarjetas del último corte ────────────────────────────────────────────

  /** Los últimos 14 días, del más viejo al más nuevo (así se lee una línea de tiempo). */
  private readonly ultimos14 = computed<CorteDia[]>(() => this.dias().slice(0, 14).reverse());
  readonly serieFechas = computed<string[]>(() => this.ultimos14().map((d) => this.dmy(d.fecha)));

  /** La serie de una columna: `null` el día que nadie contó — la sparkline lo pinta como hueco, no como cero. */
  serie(k: keyof CorteDia): (number | null)[] {
    return this.ultimos14().map((d) => (d.tiene_corte && d[k] != null ? Number(d[k]) : null));
  }

  /** Contra el corte ANTERIOR que sí se contó: flecha + texto, no sólo color (estándar 2.3). */
  deltaDe(k: keyof CorteDia): { texto: string; dir: 'up' | 'down' | 'flat' } {
    const contados = this.dias().filter((d) => d.tiene_corte && d[k] != null);
    if (contados.length < 2) return { texto: '', dir: 'flat' };
    const a = Number(contados[0][k]);
    const b = Number(contados[1][k]);
    const dif = Math.round((a - b) * 100) / 100;
    const cuando = this.dmy(contados[1].fecha).slice(0, 5);
    if (Math.abs(dif) < 0.005) return { texto: `igual que el ${cuando}`, dir: 'flat' };
    return { texto: `${this.mx(Math.abs(dif))} vs ${cuando}`, dir: dif > 0 ? 'up' : 'down' };
  }

  /** Cuántos cortes repiten el valor del último: lo que NO cambia no se está contando. */
  repite(k: keyof CorteDia): { n: number; de: number; pct: number } {
    const u = this.ultimo();
    const d = this.dias().filter((x) => x.tiene_corte);
    if (!u?.tiene_corte || !d.length) return { n: 0, de: 0, pct: 0 };
    const n = d.filter((x) => String(x[k]) === String(u[k])).length;
    return { n, de: d.length, pct: Math.round((n / d.length) * 100) };
  }

  /**
   * ⚠️ «Tarjeta» de Control: en los cortes del 19 y 20-oct-2026 coincidió AL PESO con el saldo de
   * la caja fuerte ($360,020), medido con el replay de CAOS ya validado. Probablemente el cajero
   * anota ahí la caja fuerte; NO está confirmado con operación. Va como chip «por confirmar», con
   * la fecha en el title para que no se lea como regla.
   */
  readonly chipsTarjeta: MetricChip[] = [
    { texto: 'según Control', tono: 'mute' },
    { texto: '¿caja fuerte? · por confirmar', tono: 'info', icono: 'pi-info-circle',
      title: 'En los cortes del 19 y 20-oct-2026 coincidió al peso con el saldo de la caja fuerte (CAOS). Falta confirmarlo con operación.' },
  ];

  /** Barra por denominación del efectivo contado. Escala TONAL del color de acción: sin arcoíris. */
  readonly denoms = computed<{ etiqueta: string; monto: number; pct: number; color: string }[]>(() => {
    const u = this.ultimo();
    if (!u?.tiene_corte) return [];
    const total = Number(u.total_efectivo ?? 0);
    if (!total) return [];
    const tono = (p: number) => `color-mix(in srgb, var(--action) ${p}%, var(--border-color))`;
    const filas: { d: number; k: string; color: string }[] = [
      { d: 1000, k: 'b1000', color: 'var(--text-muted)' }, { d: 500, k: 'b500', color: 'var(--action)' },
      { d: 200, k: 'b200', color: tono(70) }, { d: 100, k: 'b100', color: tono(48) },
      { d: 50, k: 'b50', color: tono(32) }, { d: 20, k: 'b20', color: tono(20) },
    ];
    const out = filas
      .map((f) => ({ q: Number(u[f.k] ?? 0), ...f }))
      .filter((f) => f.q > 0)
      .map((f) => ({ etiqueta: `$${f.d} ×${f.q}`, monto: f.d * f.q, pct: ((f.d * f.q) / total) * 100, color: f.color }));
    const mon = Number(u.total_monedas ?? 0);
    if (mon > 0) out.push({ etiqueta: `monedas ${this.mx(mon)}`, monto: mon, pct: Math.max((mon / total) * 100, 0.6), color: 'var(--text-faint)' });
    return out;
  });
  readonly denomsTexto = computed(() => this.denoms().map((s) => s.etiqueta).join(', '));

  /** El total que declaró Control, como composición: se ve de qué está hecho. */
  readonly composicion = computed<{ nombre: string; monto: number; pct: number; pctTexto: string; color: string }[]>(() => {
    const u = this.ultimo();
    if (!u?.tiene_corte) return [];
    const partes = [
      { nombre: 'Efectivo', monto: Number(u.total_efectivo ?? 0), color: 'var(--action)' },
      { nombre: 'Tarjeta', monto: Number(u.total_tarjeta ?? 0), color: 'var(--chart-2)' },
      { nombre: 'Dólares', monto: Number(u.total_dolares ?? 0), color: 'var(--chart-8)' },
      { nombre: 'Papeles', monto: Number(u.total_papeles ?? 0), color: 'color-mix(in srgb, var(--chart-8) 45%, transparent)' },
      { nombre: 'Cheques', monto: Number(u.total_cheques ?? 0), color: 'var(--chart-7)' },
    ].filter((p) => p.monto > 0);
    const t = partes.reduce((a, p) => a + p.monto, 0) || 1;
    return partes.map((p) => ({ ...p, pct: (p.monto / t) * 100, pctTexto: `${Math.round((p.monto / t) * 100)}%` }));
  });
  readonly composicionTexto = computed(() => this.composicion().map((p) => `${p.nombre} ${p.pctTexto}`).join(', '));

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
