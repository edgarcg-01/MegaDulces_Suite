import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TiendaStateService } from '../tienda-state.service';

/** Proyecto Tienda — detalle por SUCURSAL (KPIs + drill-down al ticker de cada tienda). */
@Component({
  selector: 'app-tienda-branches',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['../tienda-shared.css'],
  styles: [`
    .tda-branch { cursor:pointer; transition:border-color .15s, background .15s; }
    .tda-branch:hover { border-color:var(--action,#b45309); }
    .tda-branch.sel { border-color:var(--action,#b45309); background:var(--action,#b45309)0d; box-shadow:0 0 0 1px var(--action,#b45309); }
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
            <select class="tda-filter" [value]="s.selectedBranch()" (change)="s.changeBranch($any($event.target).value)">
              <option value="">Todas las sucursales</option>
              @for (b of s.branchList; track b.code) { <option [value]="b.code">{{ b.name }}</option> }
            </select>
          }
          <div class="tda-live" [class.on]="s.connected()"><span class="dot"></span>{{ s.connected() ? 'EN VIVO' : 'conectando…' }}</div>
        </div>
      </header>

      <div class="tda-kpis">
        <div class="tda-kpi"><span class="l">Venta hoy</span><span class="v">{{ s.ventaHoy() | currency:'MXN':'symbol-narrow':'1.0-0' }}</span></div>
        <div class="tda-kpi"><span class="l">Tickets hoy</span><span class="v">{{ s.ticketsHoy() | number }}</span></div>
        <div class="tda-kpi"><span class="l">Ticket promedio</span><span class="v">{{ s.avgTicket() | currency:'MXN':'symbol-narrow':'1.0-0' }}</span></div>
        <div class="tda-kpi"><span class="l">Sucursales activas</span><span class="v">{{ s.activeBranches() }}</span></div>
      </div>

      <div class="tda-branches">
        @for (b of s.branches(); track b.warehouse_code) {
          <div class="tda-branch" [class.idle]="s.idleMin(b.last_ts) >= 20" [class.sel]="selected() === b.warehouse_code"
               (click)="pick(b.warehouse_code)">
            <div class="bh"><span class="bn">{{ b.warehouse_name || b.warehouse_code }}</span>
              <span class="bt" [class.warn]="s.idleMin(b.last_ts) >= 20">{{ s.lastLabel(b.last_ts) }}</span></div>
            <div class="bv">{{ b.venta | currency:'MXN':'symbol-narrow':'1.0-0' }}</div>
            <div class="bx"><span>{{ b.tickets | number }} tickets</span>
              <span>{{ (b.tickets ? b.venta / b.tickets : 0) | currency:'MXN':'symbol-narrow':'1.0-0' }} prom</span></div>
          </div>
        }
        @if (!s.branches().length) { <div class="tda-empty">Aún sin ventas hoy…</div> }
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
