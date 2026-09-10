import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { ButtonModule } from 'primeng/button';
import { MetricCardComponent } from '../../../shared/components/metric-card/metric-card.component';
import { PaceChartComponent, PaceRef } from '../components/pace-chart.component';
import { TiendaStateService } from '../tienda-state.service';

/**
 * Proyecto Tienda — pantalla del ENCARGADO de sucursal (y de quien audita tienda por
 * tienda). Mismas seis cifras y mismo gráfico que el tablero de dirección, pero de UNA
 * tienda: quien tiene alcance a una sola la ve fijada por su login; quien tiene alcance
 * global elige en las tarjetas.
 */
@Component({
  selector: 'app-tienda-branches',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectModule, ButtonModule, MetricCardComponent, PaceChartComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['../tienda-shared.css'],
  styles: [`
    :host { display:block; }
    /* 3 columnas fijas: la posición ES el significado (fila 1 multiplica a la venta,
       fila 2 al ticket promedio), igual que en /tienda/live. Breakpoints en rem. */
    .tda-kpis-mc { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:.75rem; margin:.4rem 0 1rem; }
    @media (max-width:60rem) { .tda-kpis-mc { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    @media (max-width:38rem) { .tda-kpis-mc { grid-template-columns:1fr; } }
    .bk-scope { display:flex; align-items:center; gap:.4rem; flex-wrap:wrap;
      margin:1rem 0 0; font-size:.74rem; color:var(--text-muted); }
    .bk-scope i { color:var(--text-faint); font-size:.74rem; }
    .bk-scope b { color:var(--text-main); font-weight:700; }
    .bk-vs { color:var(--text-faint); font-variant-numeric:tabular-nums; }
    .tda-branch { cursor:pointer; transition:border-color .15s, background-color .15s; }
    .tda-branch:hover { border-color:var(--action); }
    .tda-branch.sel { border-color:var(--action); background:color-mix(in srgb, var(--action) 7%, transparent); box-shadow:inset 0 0 0 1px var(--action); }
    .tda-branch:focus-visible { outline:2px solid var(--action-ring); outline-offset:2px; }
    .tda-branch .bx { display:flex; justify-content:space-between; font-size:.7rem; color:var(--text-muted); margin-top:.15rem; }
    .drill-head { display:flex; align-items:baseline; gap:.6rem; }
    .drill-head .muted { color:var(--text-muted); font-size:.8rem; font-weight:600; }
    /* El drill-down es una pila a todo el ancho: ritmo arriba, tickets abajo. Ya no hay
       columna lateral — con 4 series el gráfico no entraba en el ancho angosto. */
    .tda-pace { margin-bottom:1rem; }
    .tda-stack { display:flex; flex-direction:column; gap:1rem; min-width:0; }
    /* Una columna más que el original: partidas y unidades separadas para poder
       compararlas verticalmente entre folios. */
    .tk-row { grid-template-columns:3.2rem 1fr auto auto auto; }
    .tk-items { font-variant-numeric:tabular-nums; white-space:nowrap; }
  `],
  template: `
    <div class="surf-page in tda">
      <header class="surf-page-head tda-head">
        <div class="surf-page-head-text">
          <h1>Tienda — sucursales</h1>
          <p class="surf-page-sub">Desempeño del día por tienda · tocá una sucursal para ver su detalle</p>
        </div>
        <div class="tda-head-right">
          @if (s.scopedWarehouse) {
            <span class="tda-scope"><i class="pi pi-map-marker"></i>{{ s.branchName(s.scopedWarehouse) }}</span>
          } @else {
            <p-select [options]="branchOptions" [ngModel]="s.selectedBranch()" (onChange)="s.changeBranch($event.value)"
              optionLabel="label" optionValue="value" styleClass="tda-filter-sel" [style]="{ minWidth: '12rem' }"
              appendTo="body" ariaLabel="Filtrar por sucursal"></p-select>
          }
          <div class="tda-live" [class.on]="s.connected()" role="status"
               [attr.aria-label]="s.connected() ? 'Conexión en vivo activa' : 'Conectando'">
            <span class="dot"></span>{{ s.connected() ? 'EN VIVO' : 'conectando…' }}
          </div>
        </div>
      </header>

      @if (s.error()) {
        <div class="tda-banner" role="alert"><i class="pi pi-exclamation-triangle"></i> No se pudo cargar el desempeño por sucursal.
          <button pButton type="button" class="p-button-text p-button-sm" (click)="s.retry()"><span class="p-button-label">Reintentar</span></button></div>
      }

      <!--
        Misma matriz 3×2 que el tablero de dirección, pero de la tienda ELEGIDA (o de la
        que el encargado tiene asignada). Que las dos pantallas muestren las mismas seis
        cifras es lo que permite que gerencia y sucursal hablen del mismo número.
          fila 1 →  Tickets × Partidas/ticket × Valor/partida = Venta
          fila 2 →  Ticket promedio = Unidades/ticket × Valor unitario
      -->
      <p class="bk-scope">
        <i class="pi pi-chart-bar"></i>
        @if (focus()) { Desempeño de <b>{{ s.branchName(focus()) }}</b> hoy }
        @else { Desempeño de <b>toda la red</b> hoy — elegí una sucursal para ver la suya }
      </p>

      <!-- Mismo selector que el tablero de dirección, pero el ritmo que compara es el de
           ESTA tienda. Va arriba de las tarjetas porque manda sobre todos sus deltas. -->
      <div class="tda-vs">
        <span class="vs-lbl">Comparar contra</span>
        <div class="vs-seg" role="group" [attr.aria-label]="'Ritmo de referencia de ' + (focus() ? s.branchName(focus()) : 'la red')">
          @for (o of baselineOpts(); track o.k) {
            <button type="button" class="vs-btn" [class.on]="s.baseline() === o.k"
                    [attr.aria-pressed]="s.baseline() === o.k" (click)="s.baseline.set(o.k)">{{ o.t }}</button>
          }
        </div>
        @if (bOk()) {
          <span class="vs-meta">{{ bMeta() }}</span>
        } @else {
          <span class="vs-meta warn"><i class="pi pi-exclamation-triangle"></i> {{ bWhy() }}</span>
        }
      </div>
      <div class="tda-kpis-mc">
        <app-metric-card label="Tickets del día" [value]="k().tickets" format="number" variant="sparkline"
          [series]="focusHourVenta()" [seriesLabels]="hourLabels()" tone="brand" [live]="s.connected()"
          [delta]="focusDelta().tickets" sub="cuántas veces se cobró"></app-metric-card>
        <app-metric-card label="Partidas por ticket" [value]="k().linesPerTicket" format="number" [decimals]="2"
          [live]="s.connected()" [delta]="focusDelta().lines"
          [accent]="'var(--chart-2)'" sub="renglones distintos por venta"></app-metric-card>
        <app-metric-card label="Valor por partida" [value]="k().amountPerLine" format="currency"
          [live]="s.connected()" [delta]="focusDelta().amountLine"
          [accent]="'var(--chart-3)'" sub="cuánto deja cada renglón"></app-metric-card>

        <app-metric-card label="Ticket promedio" [value]="k().ticketProm" format="currency"
          [live]="s.connected()" [delta]="focusDelta().ticket"
          [accent]="'var(--chart-4)'" sub="partidas × valor por partida"></app-metric-card>
        @if (k().unitsPerTicket != null) {
          <app-metric-card label="Unidades por ticket" [value]="k().unitsPerTicket || 0" format="number" [decimals]="1"
            [delta]="focusDelta().units" [accent]="'var(--chart-5)'" [sub]="unitsSub()"></app-metric-card>
          <app-metric-card label="Valor unitario promedio" [value]="k().amountPerUnit || 0" format="currency"
            [delta]="focusDelta().unit" [accent]="'var(--chart-6)'" [sub]="unitsSub()"></app-metric-card>
        } @else {
          <!-- Sin peldaño resuelto no se publica un cero: un cero diría "no vendió". -->
          <app-metric-card label="Unidades por ticket" format="text" valueText="—"
            [accent]="'var(--chart-5)'" sub="no se pudo resolver la unidad de estos renglones"></app-metric-card>
          <app-metric-card label="Valor unitario promedio" format="text" valueText="—"
            [accent]="'var(--chart-6)'" sub="no se pudo resolver la unidad de estos renglones"></app-metric-card>
        }
      </div>

      <div class="tda-branches">
        @for (b of s.branches(); track b.warehouse_code) {
          <div class="tda-branch" [class.idle]="s.idleMin(b.last_ts) >= 20" [class.sel]="selected() === b.warehouse_code"
               role="button" tabindex="0" [attr.aria-pressed]="selected() === b.warehouse_code"
               [attr.aria-label]="'Ver detalle de ' + (b.warehouse_name || b.warehouse_code)"
               (click)="pick(b.warehouse_code)" (keydown.enter)="pick(b.warehouse_code)"
               (keydown.space)="pick(b.warehouse_code); $event.preventDefault()">
            <div class="bh"><span class="bn">{{ b.warehouse_name || b.warehouse_code }}</span>
              <span class="bt" [class.warn]="s.idleMin(b.last_ts) >= 20">{{ s.lastLabel(b.last_ts) }}</span></div>
            <div class="bv">{{ b.venta | currency:'MXN':'symbol-narrow':'1.0-0' }}</div>
            <div class="bx"><span>{{ b.tickets | number }} tickets</span>
              <span>{{ (b.tickets ? b.venta / b.tickets : 0) | currency:'MXN':'symbol-narrow':'1.0-0' }} prom</span></div>
          </div>
        }
        @if (!s.branches().length && !s.error()) { <div class="tda-empty">Aún sin ventas hoy…</div> }
      </div>

      @if (selected()) {
        <!-- El ritmo va a todo el ancho y ARRIBA del listado: con 4 series encimadas,
             la columna angosta no daba para leerlo. -->
        <section class="tda-card tda-pace">
          <app-pace-chart [hours]="selHours()" [refs]="branchRefs()" [H]="140"
            [title]="'Ritmo de ' + s.branchName(selected())"
            emptyText="Esta sucursal no juntó días completos suficientes para tener curva de referencia." />
        </section>

        <div class="tda-stack">
          <section class="tda-card tda-ticker">
            <div class="drill-head">
              <h2 style="margin:0">{{ s.branchName(selected()) }}</h2>
              <span class="muted">{{ selTickets().length | number }} tickets</span>
            </div>
            <div class="tk-list" style="margin-top:.7rem">
              @for (t of selTickets(); track t.warehouse_code + t.serie + t.folio) {
                <div class="tk" [class.flash]="t === selTickets()[0]" (click)="s.toggle(t)">
                  <div class="tk-row">
                    <span class="tk-time">{{ s.hora(t.ticket_ts) }}</span>
                    <span class="tk-suc">Folio {{ t.folio }}</span>
                    <!-- items.length son PARTIDAS (antes se rotulaba "art."); las
                         unidades son la suma de cantidades del folio. -->
                    <span class="tk-items">{{ s.plural(t.items.length, 'partida', 'partidas') }}</span>
                    <span class="tk-items">{{ s.plural(s.arts(t), 'unidad', 'unidades') }}</span>
                    <span class="tk-total">{{ t.total | currency:'MXN':'symbol-narrow':'1.0-2' }}</span>
                  </div>
                  @if (s.isOpen(t)) {
                    <div class="tk-detail">
                      @for (it of t.items; track it.sku) {
                        <div class="tk-item"><span class="q">{{ it.cant }}×</span> {{ it.nombre }} <span class="im">{{ it.importe | currency:'MXN':'symbol-narrow':'1.0-2' }}</span></div>
                      }
                    </div>
                  }
                </div>
              }
              @if (!selTickets().length) { <div class="tda-empty">Sin tickets de esta sucursal hoy.</div> }
            </div>
          </section>
        </div>
      } @else {
        <div class="tda-empty">Seleccioná una sucursal para ver sus tickets y su ritmo.</div>
      }
    </div>
  `,
})
export class TiendaBranchesComponent implements OnInit, OnDestroy {
  readonly s = inject(TiendaStateService);
  readonly branchOptions = [
    { label: 'Todas las sucursales', value: '' },
    ...this.s.branchList.map((b) => ({ label: b.name, value: b.code })),
  ];
  readonly hourLabels = computed(() => this.s.hourBars().map((h) => h.hora + ':00'));
  readonly selected = signal<string>('');
  readonly selTickets = computed(() => (this.selected() ? this.s.ticketsOf(this.selected()) : []));
  readonly selHours = computed(() => (this.selected() ? this.s.hourBarsOf(this.selected()) : []));

  /**
   * La tienda "en foco": la elegida en las tarjetas, o la que el login le fijó al
   * encargado. Vacío = el usuario ve la red entera y todavía no eligió ninguna.
   */
  readonly focus = computed(() => this.selected() || this.s.scopedWarehouse || '');
  readonly focusHourVenta = computed(() =>
    (this.focus() ? this.s.hourBarsOf(this.focus()) : this.s.hourBars()).map((h) => h.venta));

  /** Las 6 cifras del día, de la tienda en foco (o de la red si no hay ninguna). */
  readonly k = computed(() => {
    const code = this.focus();
    if (!code) {
      return {
        tickets: this.s.ticketsHoy(),
        ticketProm: this.s.avgTicket(),
        linesPerTicket: this.s.partidasPorTicket(),
        amountPerLine: this.s.valorPorPartida(),
        unitsPerTicket: this.s.unidadesPorTicket(),
        amountPerUnit: this.s.valorUnitario(),
      };
    }
    const lev = this.s.leversOf(code);
    return {
      tickets: lev.tickets,
      ticketProm: lev.ticketProm,
      linesPerTicket: lev.linesPerTicket,
      amountPerLine: lev.amountPerLine,
      unitsPerTicket: lev.unitsPerTicket,
      amountPerUnit: lev.amountPerUnit,
    };
  });

  readonly baselineOpts = computed(() => [
    { k: 'dow' as const, t: this.s.dowLabel() },
    { k: 'week' as const, t: 'Últimos 7 días' },
    { k: 'month' as const, t: 'Últimos 30 días' },
  ]);

  /**
   * La ventana de referencia de la tienda en foco, según el botón elegido. Se usa el
   * ritmo de ESTA tienda —no el de la red— porque los perfiles son muy distintos entre
   * sucursales: medir a Yurécuaro (2.4 partidas por ticket) con la vara de Canindo
   * (5.7) la dejaría siempre en rojo por tamaño, no por desempeño.
   */
  readonly bWin = computed(() => {
    const code = this.focus();
    const rh = code ? this.s.branchRhythm(code) : this.s.rhythm();
    return rh ? (rh as any)[this.s.baseline()] : null;
  });
  readonly bOk = computed(() => this.bWin()?.method === 'ods_u_d_10');

  bMeta(): string {
    const b = this.bWin();
    if (!b) return '';
    const falt = b.days_missing || b.days_partial ? ` · ${b.days_missing + b.days_partial} sin usar` : '';
    const que = this.s.baseline() === 'dow'
      ? `promedio de los últimos ${b.days_used} ${this.s.dowLabel().toLowerCase()}s`
      : `promedio de ${b.days_used} días`;
    return `${que}${falt} · misma franja horaria`;
  }

  /** Por qué esta tienda no tiene comparación — el motivo, no un delta inventado. */
  bWhy(): string {
    const b = this.bWin();
    const quien = this.focus() ? this.s.branchName(this.focus()) : 'la red';
    if (!b) return 'Cargando el ritmo…';
    const k = this.s.baseline();
    const cual = k === 'week' ? 'los últimos 7 días'
      : k === 'month' ? 'los últimos 30 días'
      : `los ${this.s.dowLabel().toLowerCase()}s anteriores`;
    if (b.method === 'ventana_incompleta') {
      return `${quien} no tiene días completos suficientes en ${cual}`
        + ` (${b.days_used} utilizables${b.days_missing ? `, faltan ${b.days_missing}` : ''}).`;
    }
    if (b.method === 'sin_datos') return `El ERP no registra ventas de ${quien} en ${cual}.`;
    return 'El histórico del ERP no está disponible en este entorno.';
  }

  /** Deltas de hoy contra la ventana elegida, para las 6 tarjetas. */
  readonly focusDelta = computed(() => {
    const b = this.bWin();
    const vacio = { base: false, tickets: null, lines: null, amountLine: null, ticket: null, units: null, unit: null };
    if (!b || b.method !== 'ods_u_d_10') return vacio;
    const kk = this.k();
    const pct = (hoy: number | null | undefined, base: number | null | undefined): number | null =>
      hoy != null && base != null && base > 0 ? +(((hoy / base) - 1) * 100).toFixed(1) : null;
    return {
      base: true,
      tickets: pct(kk.tickets, b.tickets_per_day),
      lines: pct(kk.linesPerTicket, b.lines_per_ticket),
      amountLine: pct(kk.amountPerLine, b.amount_per_line),
      ticket: pct(kk.ticketProm, b.amount_per_ticket),
      units: pct(kk.unitsPerTicket, b.units_per_ticket),
      unit: pct(kk.amountPerUnit, b.amount_per_unit),
    };
  });

  /** Curvas de referencia de la tienda seleccionada (las tres ventanas). */
  readonly branchRefs = computed((): PaceRef[] => {
    const code = this.selected();
    const hy = (code ? this.s.branchRhythm(code) : this.s.rhythm())?.hourly;
    if (!hy) return [];
    return [
      { k: 'dow', label: this.s.dowLabel(), color: 'var(--chart-2)', data: hy.dow ?? null },
      { k: 'week', label: '7 días', color: 'var(--chart-4)', data: hy.week ?? null },
      { k: 'month', label: '30 días', color: 'var(--chart-6)', data: hy.month ?? null },
    ];
  });

  unitsSub(): string {
    const code = this.focus();
    const lv = code ? this.s.leversOf(code) : null;
    return lv ? 'peldaño resuelto por precio' : `peldaño por precio · ${this.s.unidadesCobertura().toFixed(1)}% de renglones`;
  }

  ngOnInit(): void {
    this.s.enter();
    if (this.s.scopedWarehouse) this.selected.set(this.s.scopedWarehouse);
  }
  ngOnDestroy(): void { this.s.leave(); }

  pick(code: string): void { this.selected.update((cur) => (cur === code ? '' : code)); }
}
