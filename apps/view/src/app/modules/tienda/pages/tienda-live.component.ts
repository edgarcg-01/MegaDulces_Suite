import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { ButtonModule } from 'primeng/button';
import { MetricCardComponent } from '../../../shared/components/metric-card/metric-card.component';
import { PaceChartComponent, PaceRef } from '../components/pace-chart.component';
import { TiendaStateService } from '../tienda-state.service';

/** Proyecto Tienda — monitor de tickets de venta EN VIVO (WebSocket /store). */
@Component({
  selector: 'app-tienda-live',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectModule, ButtonModule, MetricCardComponent, PaceChartComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['../tienda-shared.css'],
  styles: [`
    :host { display:block; }
    /* El selector .tda-vs vive en tienda-shared.css (lo usan las dos pantallas). */

    /* Rejilla 3×2: columna = el ticket · la cantidad · el valor de esa cantidad.
       Fija en 3 (no auto-fit) porque la posición ES el significado: la fila de arriba
       multiplica a la venta y la de abajo al ticket promedio. Breakpoints en rem. */
    .tda-kpis-mc { display:grid; grid-template-columns:repeat(3,minmax(0,1fr));
      gap:.75rem; margin:1rem 0 .3rem; }
    @media (max-width:60rem) { .tda-kpis-mc { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    @media (max-width:38rem) { .tda-kpis-mc { grid-template-columns:1fr; } }
    .tda-band-cap { margin:0 0 1rem; font-size:.72rem; color:var(--text-faint); }
    .tda-band-cap b { color:var(--text-main); font-weight:700; }

    /* Columna izquierda: el listado de tickets. */
    .tda-main { display:flex; flex-direction:column; gap:1rem; min-width:0; }

    /* El gráfico vive en app-pace-chart (compartido con /tienda/branches).
       Sin acentos graves acá: styles es un template literal y un backtick lo cierra. */
    .tda-pace { margin-bottom:1rem; }
    /* Una columna más que el original (renglones y artículos van separados para que
       se puedan comparar de un vistazo entre filas, en vez de leerse como texto). */
    .tk-row { grid-template-columns:3.2rem 1fr auto auto auto; }
    .tk-items { font-variant-numeric:tabular-nums; white-space:nowrap; }

    /* Coaching por tienda: la misma matriz 3×2 de la red + "qué subir".
       La base sube a 300px porque 3 columnas de chips no caben en 210. */
    .tda-branch { flex-basis:300px; }
    .levers { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:.3rem; margin-top:.55rem; }
    .lever { display:flex; flex-direction:column; gap:.1rem; padding:.3rem .4rem; border-radius:var(--r-sm,8px);
      background:color-mix(in srgb, var(--text-main) 4%, transparent); min-width:0; }
    .lever .lv-k { font-size:.56rem; text-transform:uppercase; letter-spacing:.04em; color:var(--text-faint); white-space:nowrap; }
    /* El número manda: color neutro, mono tabular (regla de datos densos). */
    .lever .lv-i { font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-size:.74rem; font-weight:700; color:var(--text-main); }
    /* Lo que no se pudo medir se ve apagado — para no leerlo como un valor bajo. */
    .lever.dim .lv-i { color:var(--text-faint); font-weight:600; }
    .coach { display:flex; align-items:center; gap:.35rem; margin-top:.45rem; font-size:.72rem; color:var(--action); font-weight:600; }
    .coach i { font-size:.7rem; } .coach .g { margin-left:auto; color:var(--text-muted); font-weight:700; font-variant-numeric:tabular-nums; }
    .tda-offline { display:flex; align-items:center; gap:.5rem; background:var(--bad-soft-bg); color:var(--bad-soft-fg);
      border:1px solid var(--bad-border); border-radius:var(--r-sm,8px); padding:.55rem .8rem; margin:.5rem 0; font-size:.84rem; }
    .tda-offline i { color:var(--bad-fg); } .tda-offline b { font-weight:700; }
  `],
  template: `
    <div class="surf-page in tda">
      <header class="surf-page-head tda-head">
        <div class="surf-page-head-text">
          <h1>Tienda — en vivo</h1>
          <p class="surf-page-sub">Tickets de venta de cada sucursal al instante · KPIs del día · ritmo por hora</p>
        </div>
        <div class="tda-head-right">
          @if (s.scopedWarehouse) {
            <span class="tda-scope"><i class="pi pi-map-marker"></i>{{ s.branchName(s.scopedWarehouse) }}</span>
          } @else {
            <p-select [ngModel]="s.selectedBranch() || null" (ngModelChange)="s.changeBranch($event || '')"
                      [options]="s.branchList" optionLabel="name" optionValue="code"
                      placeholder="Todas las sucursales" [showClear]="true" appendTo="body"
                      styleClass="tda-filter-sel" />
          }
          <div class="tda-live" [class.on]="s.connected()">
            <span class="dot"></span>{{ s.connected() ? 'EN VIVO' : 'conectando…' }}
          </div>
        </div>
      </header>

      @if (s.error()) {
        <div class="tda-banner" role="alert"><i class="pi pi-exclamation-triangle"></i> No se pudo cargar la venta del día.
          <button pButton type="button" class="p-button-text p-button-sm" (click)="s.retry()"><span class="p-button-label">Reintentar</span></button></div>
      }

      @if (s.disconnectedBranches(); as off) {
        @if (off.length) {
          <div class="tda-banner tda-offline" role="alert">
            <i class="pi pi-exclamation-triangle"></i>
            <span><b>Sin conexión al POS:</b>
              @for (d of off; track d.code) {{{ d.name }} ({{ offlineLabel(d) }})@if (!$last) {<span>, </span>}}
              — la sucursal dejó de reportar ventas; revisar equipo/red.</span>
          </div>
        }
      }

      <!--
        Rejilla 3×2. Se lee en las dos direcciones y las dos son identidades exactas:
          fila 1 →  Tickets × Partidas/ticket × Valor/partida = Venta del día
          fila 2 →  Ticket promedio = Unidades/ticket × Valor unitario
        Columnas: el ticket · la CANTIDAD que lleva · el VALOR de esa cantidad.

        La fila de abajo NO lleva punto "en vivo": el peldaño pieza/paquete sólo se
        resuelve en el servidor, así que esos dos números son del último corte. Marcarlos
        como vivos sería exactamente la mentira que VP.0 salió a matar.
      -->
      <!-- Contra qué se compara el día. El delta de cada tarjeta cambia con esto. -->
      <div class="tda-vs">
        <span class="vs-lbl">Comparar contra</span>
        <div class="vs-seg" role="group" aria-label="Ritmo de referencia">
          @for (o of baselineOpts(); track o.k) {
            <button type="button" class="vs-btn" [class.on]="s.baseline() === o.k"
                    [attr.aria-pressed]="s.baseline() === o.k" (click)="s.baseline.set(o.k)">{{ o.t }}</button>
          }
        </div>
        @if (s.baselineOk()) {
          <span class="vs-meta">{{ baselineMeta() }}</span>
        } @else {
          <span class="vs-meta warn"><i class="pi pi-exclamation-triangle"></i> {{ s.baselineWhy() }}</span>
        }
      </div>

      <div class="tda-kpis-mc">
        <app-metric-card label="Tickets del día" [value]="s.ticketsHoy()" format="number" variant="sparkline"
          [series]="hourTickets()" [seriesLabels]="hourLabels()" tone="brand" [live]="s.connected()"
          [delta]="s.deltas().tickets" sub="cuántas veces se cobró"></app-metric-card>
        <app-metric-card label="Partidas por ticket" [value]="s.partidasPorTicket()" format="number" [decimals]="2"
          variant="bars" [series]="branchLines()" [seriesLabels]="branchNames()" [highlightLast]="false"
          [live]="s.connected()" [delta]="s.deltas().lines"
          [accent]="'var(--chart-2)'" sub="renglones distintos por venta"></app-metric-card>
        <app-metric-card label="Valor por partida" [value]="s.valorPorPartida()" format="currency"
          [live]="s.connected()" [delta]="s.deltas().amountLine"
          [accent]="'var(--chart-3)'" sub="cuánto deja cada renglón"></app-metric-card>

        <app-metric-card label="Ticket promedio" [value]="s.avgTicket()" format="currency"
          [live]="s.connected()" [delta]="s.deltas().ticket"
          [accent]="'var(--chart-4)'" sub="partidas × valor por partida"></app-metric-card>
        @if (s.unidadesMedidas()) {
          <app-metric-card label="Unidades por ticket" [value]="s.unidadesPorTicket() || 0" format="number" [decimals]="1"
            variant="bars" [series]="branchUnits()" [seriesLabels]="branchUnitNames()" [highlightLast]="false"
            [delta]="s.deltas().units" [accent]="'var(--chart-5)'" [sub]="unitsSub()"></app-metric-card>
          <app-metric-card label="Valor unitario promedio" [value]="s.valorUnitario() || 0" format="currency"
            [delta]="s.deltas().unit" [accent]="'var(--chart-6)'" [sub]="unitsSub()"></app-metric-card>
        } @else {
          <!-- Sin peldaño resuelto no se publica un cero: se dice qué falta. -->
          <app-metric-card label="Unidades por ticket" format="text" valueText="—"
            [accent]="'var(--chart-5)'" [sub]="unitsWhy()"></app-metric-card>
          <app-metric-card label="Valor unitario promedio" format="text" valueText="—"
            [accent]="'var(--chart-6)'" [sub]="unitsWhy()"></app-metric-card>
        }
      </div>

      <p class="tda-band-cap">Venta del día <b class="num">{{ s.ventaHoy() | currency:'MXN':'symbol-narrow':'1.0-0' }}</b>
        — arriba: <b>Tickets × Partidas × Valor por partida</b>. Abajo, el mismo ticket visto por unidad.
        Cada palanca se sube por separado; las barras comparan sucursal contra sucursal.</p>

      <div class="tda-branches">
        @for (c of coached(); track c.b.warehouse_code) {
          <div class="tda-branch" [class.idle]="s.idleMin(c.b.last_ts) >= 20">
            <div class="bh"><span class="bn">{{ c.b.warehouse_name || c.b.warehouse_code }}</span>
              <span class="bt" [class.warn]="s.idleMin(c.b.last_ts) >= 20">{{ s.lastLabel(c.b.last_ts) }}</span></div>
            <div class="bv">{{ c.b.venta | currency:'MXN':'symbol-narrow':'1.0-0' }}</div>
            <div class="bk">{{ c.b.tickets | number }} tickets</div>
            <!-- Misma matriz 3×2 que los KPIs de arriba, para que la sucursal se lea
                 igual que la red: fila 1 = lo que multiplica a la venta, fila 2 = el
                 mismo ticket visto por unidad. -->
            <div class="levers" role="group" aria-label="Palancas de la sucursal">
              @for (lv of chipsOf(c.lev); track lv.k) {
                <div class="lever" [class.dim]="lv.dim">
                  <span class="lv-k">{{ lv.k }}</span>
                  <span class="lv-i">{{ lv.v }}</span>
                </div>
              }
            </div>
            <div class="coach"><i class="pi pi-arrow-up"></i> Subir: <b>{{ c.lev.weakest.label }}</b></div>
          </div>
        }
        @if (!coached().length && !s.error()) { <div class="tda-empty">Aún sin ventas hoy…</div> }
      </div>

      <!--
        Ritmo del día, a todo el ancho y entre las sucursales y el listado: es el puente
        entre "cómo va cada tienda" y "qué se está vendiendo ahora mismo".
        Barras = hoy. Líneas = lo normal a esa hora. SVG a mano (0 KB): el sistema de
        diseño prohíbe traer una librería de charts para una micro-viz.
      -->
      <section class="tda-card tda-pace">
        <app-pace-chart [hours]="s.hourBars()" [refs]="paceRefs()" />
      </section>

      <div class="tda-grid">
        <div class="tda-main">
        <section class="tda-card tda-ticker">
          <h2>Tickets del día <span class="tk-count">{{ s.ticker().length | number }}</span></h2>
          <div class="tk-list">
            @for (t of s.ticker(); track t.warehouse_code + t.serie + t.folio) {
              <div class="tk" [class.flash]="t === s.ticker()[0]" (click)="s.toggle(t)">
                <div class="tk-row">
                  <span class="tk-time">{{ s.hora(t.ticket_ts) }}</span>
                  <span class="tk-suc">{{ t.warehouse_name || t.warehouse_code }}</span>
                  <!-- Mismo vocabulario que las tarjetas de arriba: PARTIDAS (renglones
                       del ticket) y UNIDADES (suma de cantidades). items.length son las
                       partidas, no las unidades — es la confusión que este rótulo tenía.
                       Sin acentos graves acá: este template es un template literal y un
                       backtick lo cierra — GOTCHAS.md 34. -->
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
            @if (!s.ticker().length) { <div class="tda-empty">Esperando el próximo ticket…</div> }
          </div>
        </section>

        </div>

        <div class="tda-side">
          <section class="tda-card">
            <h2>Alertas</h2>
            <div class="al-list">
              @for (a of s.alerts(); track a.emitted_at) {
                <div class="al" [class]="'sev-' + a.severity">
                  <span class="al-t">{{ a.title }}</span><span class="al-m">{{ a.message }}</span>
                </div>
              }
              @if (!s.alerts().length) { <div class="tda-empty">Sin alertas.</div> }
            </div>
          </section>
        </div>
      </div>
    </div>
  `,
})
export class TiendaLiveComponent implements OnInit, OnDestroy {
  readonly s = inject(TiendaStateService);

  readonly hourTickets = computed(() => this.s.hourBars().map((h) => h.tickets));
  readonly hourLabels = computed(() => this.s.hourBars().map((h) => h.hora + ':00'));
  readonly peakHour = computed(() => {
    let hora = -1, max = 0;
    for (const h of this.s.hourBars()) if (h.venta > max) { max = h.venta; hora = h.hora; }
    return hora;
  });

  /** Curvas de referencia de la RED. El dibujo lo hace `app-pace-chart`. */
  readonly paceRefs = computed((): PaceRef[] => {
    const hy = this.s.rhythm()?.hourly;
    if (!hy) return [];
    return [
      { k: 'dow', label: this.s.dowLabel(), color: 'var(--chart-2)', data: hy.dow ?? null },
      { k: 'week', label: '7 días', color: 'var(--chart-4)', data: hy.week ?? null },
      { k: 'month', label: '30 días', color: 'var(--chart-6)', data: hy.month ?? null },
    ];
  });

  // Solo tiendas que vendieron hoy tienen tarjeta de coaching; las caídas van al banner "sin conexión".
  readonly coached = computed(() => this.s.branches().filter((b) => b.tickets > 0).map((b) => ({ b, lev: this.s.leversOf(b.warehouse_code) })));

  /**
   * Barras de "Partidas por ticket": una por sucursal que vendió hoy. Es un RANKING,
   * no una serie temporal — por eso `highlightLast=false` en la tarjeta.
   */
  readonly branchLines = computed(() => this.coached().map((c) => +c.lev.linesPerTicket.toFixed(2)));
  readonly branchNames = computed(() => this.coached().map((c) => c.b.warehouse_name || c.b.warehouse_code));

  /**
   * Unidades por ticket, por sucursal — barras de la tarjeta. Sólo entran las
   * sucursales cuyo peldaño SÍ se resolvió: una barra en cero diría "no vendió
   * unidades", cuando lo cierto es "no lo pude medir".
   */
  private readonly branchUnitPairs = computed(() =>
    this.coached()
      .map((c) => ({ name: c.b.warehouse_name || c.b.warehouse_code, v: this.s.unitsPerTicketOf(c.b.warehouse_code) }))
      .filter((x): x is { name: string; v: number } => x.v != null),
  );
  readonly branchUnits = computed(() => this.branchUnitPairs().map((x) => +x.v.toFixed(2)));
  readonly branchUnitNames = computed(() => this.branchUnitPairs().map((x) => x.name));

  // `arts()` y `plural()` viven en TiendaStateService: los usan las dos pantallas.

  /**
   * El día de la semana va primero: es la comparación que menos engaña en retail.
   *
   * Dicen "Últimos N días" y no "semana/mes en curso" porque eso es exactamente lo que
   * se calcula — una ventana MÓVIL sobre los días anteriores a hoy. El periodo
   * calendario sería un blanco móvil: un lunes, "semana en curso" tendría un solo día
   * de evidencia y el mismo desempeño daría un delta distinto según el día del mes.
   */
  readonly baselineOpts = computed(() => [
    { k: 'dow' as const, t: this.s.dowLabel() },
    { k: 'week' as const, t: 'Últimos 7 días' },
    { k: 'month' as const, t: 'Últimos 30 días' },
  ]);

  /** Con qué se construyó el ritmo — días usados, no sólo "últimos 30". */
  baselineMeta(): string {
    const b = this.s.baselineWin();
    if (!b) return '';
    const falt = b.days_missing || b.days_partial
      ? ` · ${b.days_missing + b.days_partial} sin usar`
      : '';
    const que = this.s.baseline() === 'dow'
      ? `promedio de los últimos ${b.days_used} ${this.s.dowLabel().toLowerCase()}s`
      : `promedio de ${b.days_used} días`;
    return `${que}${falt} · misma franja horaria`;
  }

  /** Pie de las dos tarjetas de unidad: con qué se midieron y de qué corte son. */
  unitsSub(): string {
    const cob = this.s.unidadesCobertura();
    const hora = this.leversHora();
    const base = `peldaño por precio · ${cob.toFixed(1)}% de renglones`;
    return hora ? `${base} · corte ${hora}` : base;
  }

  /** Por qué no hay lente de unidades — el motivo exacto, no un cero silencioso. */
  unitsWhy(): string {
    switch (this.s.levers()?.method) {
      case 'sin_datos': return 'Todavía no hay renglones vendidos hoy.';
      case 'no_medido': return 'Ningún renglón de hoy pudo ubicarse en la escalera de precios del ERP, así que las unidades no se publican.';
      case 'escalera_no_disponible': return 'La escalera de unidades del ERP no está disponible en este entorno — las unidades no se pueden medir.';
      case 'sin_alcance': return 'Tu alcance de sucursales no incluye ninguna tienda.';
      default: return 'Las unidades por ticket las calcula el servidor; este backend todavía no las manda.';
    }
  }

  /** Hora del corte que produjo las unidades — del servidor, no del reloj del navegador. */
  leversHora(): string {
    const at = this.s.leversAt();
    if (!at) return '';
    const d = new Date(at);
    return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  }

  /**
   * Los 6 chips de una sucursal, en el MISMO orden que la rejilla de arriba:
   *   Tickets   · Partidas/tkt · $/partida
   *   $/ticket  · Unidades/tkt · $/unidad
   * `dim` marca lo que no se pudo medir — se pinta apagado y dice "—", nunca 0.
   */
  chipsOf(lev: {
    tickets: number; ticketProm: number; linesPerTicket: number; amountPerLine: number;
    unitsPerTicket: number | null; amountPerUnit: number | null;
  }) {
    const mx = (n: number) => Math.round(n).toLocaleString('es-MX');
    return [
      { k: 'Tickets',   v: mx(lev.tickets),                 dim: false },
      { k: 'Part/tkt',  v: lev.linesPerTicket.toFixed(2),   dim: false },
      { k: '$/part.',   v: '$' + mx(lev.amountPerLine),     dim: false },
      { k: '$/tkt',     v: '$' + mx(lev.ticketProm),        dim: false },
      { k: 'Unid/tkt',  v: lev.unitsPerTicket != null ? lev.unitsPerTicket.toFixed(1) : '—', dim: lev.unitsPerTicket == null },
      { k: '$/unidad',  v: lev.amountPerUnit  != null ? '$' + lev.amountPerUnit.toFixed(2) : '—', dim: lev.amountPerUnit == null },
    ];
  }

  /** Etiqueta de antigüedad para el banner de sin-conexión. */
  offlineLabel(d: { last_ts: string; idle: number }): string {
    if (d.idle >= 9999 || !d.last_ts) return 'sin ventas hoy';
    if (d.idle < 60) return `hace ${d.idle} min`;
    const h = Math.floor(d.idle / 60);
    return h < 24 ? `hace ${h} h` : `hace ${Math.floor(h / 24)} d`;
  }

  ngOnInit(): void { this.s.enter(); }
  ngOnDestroy(): void { this.s.leave(); }
}
