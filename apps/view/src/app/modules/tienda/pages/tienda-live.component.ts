import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TiendaStateService } from '../tienda-state.service';

/** Proyecto Tienda — monitor de tickets de venta EN VIVO (WebSocket /store). */
@Component({
  selector: 'app-tienda-live',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['../tienda-shared.css'],
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
            <select class="tda-filter" [value]="s.selectedBranch()" (change)="s.changeBranch($any($event.target).value)">
              <option value="">Todas las sucursales</option>
              @for (b of s.branchList; track b.code) { <option [value]="b.code">{{ b.name }}</option> }
            </select>
          }
          <div class="tda-live" [class.on]="s.connected()">
            <span class="dot"></span>{{ s.connected() ? 'EN VIVO' : 'conectando…' }}
          </div>
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
          <div class="tda-branch" [class.idle]="s.idleMin(b.last_ts) >= 20">
            <div class="bh"><span class="bn">{{ b.warehouse_name || b.warehouse_code }}</span>
              <span class="bt" [class.warn]="s.idleMin(b.last_ts) >= 20">{{ s.lastLabel(b.last_ts) }}</span></div>
            <div class="bv">{{ b.venta | currency:'MXN':'symbol-narrow':'1.0-0' }}</div>
            <div class="bk">{{ b.tickets | number }} tickets</div>
          </div>
        }
        @if (!s.branches().length) { <div class="tda-empty">Aún sin ventas hoy…</div> }
      </div>

      <div class="tda-grid">
        <section class="tda-card tda-ticker">
          <h2>Tickets del día <span class="tk-count">{{ s.ticker().length | number }}</span></h2>
          <div class="tk-list">
            @for (t of s.ticker(); track t.warehouse_code + t.serie + t.folio) {
              <div class="tk" [class.flash]="t === s.ticker()[0]" (click)="s.toggle(t)">
                <div class="tk-row">
                  <span class="tk-time">{{ s.hora(t.ticket_ts) }}</span>
                  <span class="tk-suc">{{ t.warehouse_name || t.warehouse_code }}</span>
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
            @if (!s.ticker().length) { <div class="tda-empty">Esperando el próximo ticket…</div> }
          </div>
        </section>

        <div class="tda-side">
          <section class="tda-card">
            <h2>Ritmo de hoy (venta por hora)</h2>
            <div class="hrs">
              @for (h of s.hourBars(); track h.hora) {
                <div class="hr" [title]="h.hora + 'h · ' + (h.venta | currency:'MXN')">
                  <div class="bar" [style.height.%]="h.pct"></div>
                  <span class="hl">{{ h.hora }}</span>
                </div>
              }
            </div>
          </section>

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
  ngOnInit(): void { this.s.enter(); }
  ngOnDestroy(): void { this.s.leave(); }
}
