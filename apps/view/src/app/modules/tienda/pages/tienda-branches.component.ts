import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { ButtonModule } from 'primeng/button';
import { MetricCardComponent } from '../../../shared/components/metric-card/metric-card.component';
import { TiendaStateService } from '../tienda-state.service';

/** Proyecto Tienda — detalle por SUCURSAL (KPIs + drill-down al ticker de cada tienda). */
@Component({
  selector: 'app-tienda-branches',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectModule, ButtonModule, MetricCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['../tienda-shared.css'],
  styles: [`
    :host { display:block; }
    .tda-kpis-mc { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:.75rem; margin:1rem 0; }
    .tda-branch { cursor:pointer; transition:border-color .15s, background-color .15s; }
    .tda-branch:hover { border-color:var(--action); }
    .tda-branch.sel { border-color:var(--action); background:color-mix(in srgb, var(--action) 7%, transparent); box-shadow:inset 0 0 0 1px var(--action); }
    .tda-branch:focus-visible { outline:2px solid var(--action-ring); outline-offset:2px; }
    .tda-branch .bx { display:flex; justify-content:space-between; font-size:.7rem; color:var(--text-muted); margin-top:.15rem; }
    .drill-head { display:flex; align-items:baseline; gap:.6rem; }
    .drill-head .muted { color:var(--text-muted); font-size:.8rem; font-weight:600; }
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
          <button pButton type="button" label="Reintentar" class="p-button-text p-button-sm" (click)="s.retry()"></button></div>
      }

      <div class="tda-kpis-mc">
        <app-metric-card label="Venta hoy" [value]="s.ventaHoy()" format="currency" variant="sparkline"
          [series]="hourVenta()" [seriesLabels]="hourLabels()" tone="brand" [live]="s.connected()"></app-metric-card>
        <app-metric-card label="Tickets hoy" [value]="s.ticketsHoy()" format="number"
          [live]="s.connected()" [accent]="'var(--chart-2)'"></app-metric-card>
        <app-metric-card label="Ticket promedio" [value]="s.avgTicket()" format="currency"
          [accent]="'var(--chart-3)'"></app-metric-card>
        <app-metric-card label="Sucursales activas" [value]="s.activeBranches()" format="number"
          [sub]="'de ' + s.branchList.length"></app-metric-card>
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
        <div class="tda-grid">
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
                    <span class="tk-items">{{ t.items.length }} art.</span>
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
          <div class="tda-side">
            <section class="tda-card">
              <h2>Ritmo de {{ s.branchName(selected()) }}</h2>
              <div class="hrs">
                @for (h of selHours(); track h.hora) {
                  <div class="hr" [title]="h.hora + 'h · ' + (h.venta | currency:'MXN')">
                    <div class="bar" [style.height.%]="h.pct"></div><span class="hl">{{ h.hora }}</span>
                  </div>
                }
              </div>
            </section>
          </div>
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
  readonly hourVenta = computed(() => this.s.hourBars().map((h) => h.venta));
  readonly hourLabels = computed(() => this.s.hourBars().map((h) => h.hora + ':00'));
  readonly selected = signal<string>('');
  readonly selTickets = computed(() => (this.selected() ? this.s.ticketsOf(this.selected()) : []));
  readonly selHours = computed(() => (this.selected() ? this.s.hourBarsOf(this.selected()) : []));

  ngOnInit(): void {
    this.s.enter();
    if (this.s.scopedWarehouse) this.selected.set(this.s.scopedWarehouse);
  }
  ngOnDestroy(): void { this.s.leave(); }

  pick(code: string): void { this.selected.update((cur) => (cur === code ? '' : code)); }
}
