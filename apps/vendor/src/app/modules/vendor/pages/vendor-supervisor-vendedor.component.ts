import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { SellerDayRecap, VecinalVendorDetail, VisitMonitorRow, VisitMonitorVendor } from '@megadulces/contracts';
import { SupervisorEquipoService } from '../supervisor-equipo.service';
import { RecuentoDiaService } from '../recuento-dia.service';
import { VendorRecuentoDiaComponent } from '../components/recuento-dia.component';
import {
  etiquetaCliente,
  fechaCorta,
  minutosVisita,
  motivoDeError,
  motivoNoVenta,
  ordenarClientes,
  ventaDelCliente,
} from '../supervisor-equipo';
import { todayMx } from '../../../core/utils/mx-date';

const pesos = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const hora = new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false });

/** La venta de un vendedor: el detalle, o por qué no está (no es vecinal, sin permiso, sin red). */
type VentaDetalle = { ok: true; data: VecinalVendorDetail } | { ok: false; motivo: string };

/**
 * `[SUP.2]` Un vendedor de mi equipo, ese día: cada cliente de su ruta (primero las faltas y lo que
 * falta por visitar), a qué hora llegó, cuánto estuvo, por qué no hubo pedido, qué le levantó
 * producto por producto y qué le cobró Kepler.
 *
 * `[MCP.19]` Y su recuento del día, el MISMO que él ve arriba de «Pedidos»: cómo van al surtir sus
 * pedidos y lo que le quedó pendiente (borradores, por aprobar, cancelados). Las visitas y los clientes
 * sin visita no se repiten: ya están arriba y en la lista.
 */
@Component({
  selector: 'app-vendor-supervisor-vendedor',
  standalone: true,
  imports: [CommonModule, RouterLink, VendorRecuentoDiaComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="sv">
      <a class="sv-back" routerLink="/vendor/supervisor/equipo"><i class="pi pi-arrow-left" aria-hidden="true"></i> Mi equipo</a>

      @if (error()) {
        <div class="sv-err" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>{{ error() }}</span>
          <button type="button" (click)="cargar()">Reintentar</button>
        </div>
      } @else if (!vendedor()) {
        <p class="sv-vacio">{{ cargando() ? 'Cargando…' : 'Este vendedor no tiene ruta ese día o no es de tu equipo.' }}</p>
      } @else {
        @if (vendedor(); as v) {
          <header class="sv-head">
            <h1>{{ v.name }}</h1>
            <span class="sv-sub">{{ v.routes.join(' · ') || 'Sin ruta' }} · {{ corta(fecha) }}{{ horario(v) }}</span>
          </header>

          <div class="sv-res" aria-label="Resumen del vendedor">
            <div class="sv-k"><span>Visitados</span><b>{{ v.counts.visitados }} de {{ v.counts.clientes }}</b></div>
            <div class="sv-k"><span>Con pedido</span><b>{{ v.counts.con_pedido }}</b></div>
            <div class="sv-k"><span>Faltas</span><b [class.bad]="v.counts.faltas > 0">{{ v.counts.faltas }}</b></div>
            @if (venta(); as vt) {
              @if (vt.ok) {
                <div class="sv-k"><span>Levantado</span><b>{{ dinero(vt.data.ordered_total) }}</b></div>
                <div class="sv-k sv-k2">
                  <span>Cobrado en Kepler</span>
                  @if (vt.data.charged !== null) {
                    <b>{{ dinero(vt.data.charged) }}</b>
                    @if (vt.data.target !== null) { <span class="sv-ks">meta del día {{ dinero(vt.data.target) }}</span> }
                  } @else {
                    <b class="nm">sin medir</b><span class="sv-ks">{{ vt.data.charged_unmeasured_reason }}</span>
                  }
                </div>
              } @else {
                <div class="sv-k sv-k2"><span>Venta</span><b class="nm">sin dato</b><span class="sv-ks">{{ vt.motivo }}</span></div>
              }
            }
          </div>

          @if (!v.closed && v.counts.pendientes) {
            <p class="sv-nota">Su ruta sigue abierta: lo que no ha visitado se juzga al terminarla.</p>
          }

          <!-- [MCP.19] Su recuento del día: el mismo que él ve en «Pedidos». -->
          <app-vendor-recuento-dia class="sv-rd"
            [recuento]="recuento()" [estado]="recuentoEstado()" [error]="recuentoError()" [cargadoEn]="recuentoEn()"
            [propio]="false" [conVisitas]="false" [conClientes]="false" (reintentar)="cargarRecuento()" />

          <ul class="sv-lista">
            @for (c of clientes(); track c.customer_id) {
              <li class="sv-c">
                <button type="button" class="sv-ch" (click)="alternar(c.customer_id)" [attr.aria-expanded]="abierto() === c.customer_id">
                  <span class="sv-r1">
                    <strong>{{ c.name }}</strong>
                    <span [class]="'chip ' + etiqueta(c).tono">{{ etiqueta(c).texto }}</span>
                  </span>
                  <span class="sv-r2">
                    <span class="mono">{{ c.code }}</span>
                    @if (c.visited_at) { <span>llegó {{ horaDe(c.visited_at) }}</span> }
                    @if (minutos(c) !== null) { <span>{{ minutos(c) }} min</span> }
                    @if (c.far && c.distance_m !== null) { <span class="warn">abrió a {{ c.distance_m }} m</span> }
                    @if (!c.on_route) { <span>fuera de su ruta</span> }
                    @if (ventaDe(c); as vc) { @if (vc.ordered_total) { <span class="sv-tot">{{ dinero(vc.ordered_total) }}</span> } }
                  </span>
                  @if (motivo(c); as m) { <span class="sv-mot">{{ m }}{{ c.notes ? ' · ' + c.notes : '' }}</span> }
                </button>
                @if (abierto() === c.customer_id) {
                  <div class="sv-det">
                    @if (venta(); as vt) {
                      @if (!vt.ok) {
                        <span class="nm">La venta no se pudo leer: {{ vt.motivo }}</span>
                      } @else if (ventaDe(c); as vc) {
                        @for (o of vc.orders; track o.order_id) {
                          <span class="sv-ped">Pedido {{ o.code }} · {{ horaDe(o.created_at) }}</span>
                          <ul class="sv-lin">
                            @for (l of o.lines; track $index) {
                              <li><span>{{ l.product_name }}@if (l.sku) { <span class="mono"> · {{ l.sku }}</span> }</span>
                                <span class="mono">{{ l.quantity }} {{ l.unit }} · {{ dinero(l.line_total) }}</span></li>
                            }
                          </ul>
                        }
                        @if (!vc.orders.length) { <span class="nm">Sin pedido levantado.</span> }
                        <span>Kepler le cobró:
                          @if (vc.charged !== null) { <b>{{ dinero(vc.charged) }}</b> } @else { <b class="nm">sin medir</b> }
                        </span>
                      } @else {
                        <span class="nm">Sin pedido levantado ese día.</span>
                      }
                    } @else {
                      <span class="nm">Cargando la venta…</span>
                    }
                  </div>
                }
              </li>
            }
          </ul>
          @if (venta(); as vt) { @if (vt.ok && vt.data.truncated) { <p class="sv-nota">Se muestran {{ vt.data.visits.length }} de {{ vt.data.total_visits }} visitas con venta.</p> } }
        }
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .sv { padding: var(--sp-4) var(--sp-4) var(--sp-8); display: flex; flex-direction: column; gap: var(--sp-3); }
    .sv-back { display: inline-flex; align-items: center; gap: var(--sp-2); min-height: var(--tap-min); color: var(--text-muted);
      text-decoration: none; font-weight: 700; font-size: var(--fs-sm); align-self: flex-start; }
    .sv-head h1 { margin: 0; font-size: var(--fs-h2); font-weight: 800; }
    .sv-sub, .sv-nota { font-size: var(--fs-xs); color: var(--text-muted); }
    .sv-nota { margin: 0; }
    .sv-rd { margin: var(--sp-3) 0; }
    .sv-err { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-3); border: 1px solid var(--bad-border);
      border-radius: var(--r-md); color: var(--bad-fg); }
    .sv-err button { margin-left: auto; min-height: var(--tap-min); border-radius: var(--r-md); border: 1px solid var(--border-color);
      background: var(--card-bg); color: var(--text-main); padding: 0 var(--sp-3); cursor: pointer; }
    .sv-back:focus-visible, .sv-ch:focus-visible, .sv-err button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .sv-vacio { text-align: center; color: var(--text-muted); padding: var(--sp-8) var(--sp-4); }
    .sv-res { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--sp-2); }
    .sv-k { display: flex; flex-direction: column; gap: 2px; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border-color);
      border-radius: var(--r-md); background: var(--card-bg); font-size: var(--fs-xs); color: var(--text-muted); min-width: 0; }
    .sv-k2 { grid-column: span 2; }
    .sv-k b { font-size: var(--fs-body); color: var(--text-main); font-variant-numeric: tabular-nums; }
    .sv-ks { font-size: var(--fs-xs); }
    b.bad { color: var(--bad-fg); }
    .nm, b.nm { color: var(--text-muted); font-weight: 600; }
    .sv-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    .sv-c { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-lg); overflow: hidden; }
    .sv-ch { display: flex; flex-direction: column; gap: var(--sp-1); width: 100%; text-align: left; padding: var(--sp-3);
      border: 0; background: transparent; color: var(--text-main); cursor: pointer; min-height: var(--tap-min); }
    .sv-r1 { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
    .sv-r1 strong { font-size: var(--fs-body); min-width: 0; overflow-wrap: anywhere; }
    .sv-r2 { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); }
    .sv-r2 .warn { color: var(--warn-fg); font-weight: 700; }
    .sv-tot { margin-left: auto; font-family: var(--font-mono); font-weight: 700; color: var(--text-main); font-variant-numeric: tabular-nums; }
    .sv-mot { font-size: var(--fs-xs); color: var(--text-main); }
    .mono { font-family: var(--font-mono); }
    .sv-det { display: flex; flex-direction: column; gap: var(--sp-1); padding: 0 var(--sp-3) var(--sp-3); font-size: var(--fs-sm); }
    .sv-ped { font-weight: 700; font-size: var(--fs-xs); color: var(--text-muted); }
    .sv-lin { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
    .sv-lin li { display: flex; flex-direction: column; padding: var(--sp-1) 0; border-bottom: 1px solid var(--border-color); }
    .sv-lin li .mono { font-size: var(--fs-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .chip { font-size: var(--fs-xs); font-weight: 700; padding: var(--sp-1) var(--sp-2); border-radius: var(--r-pill); white-space: nowrap; }
    .chip.ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .chip.info { background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .chip.warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .chip.bad { background: var(--bad-soft-bg); color: var(--bad-fg); }
    .chip.muted { background: var(--overlay-hover); color: var(--text-muted); }
  `],
})
export class VendorSupervisorVendedorComponent implements OnInit {
  private readonly api = inject(SupervisorEquipoService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  readonly userId = this.route.snapshot.paramMap.get('userId') ?? '';
  readonly fecha = /^\d{4}-\d{2}-\d{2}$/.test(this.route.snapshot.queryParamMap.get('date') ?? '')
    ? (this.route.snapshot.queryParamMap.get('date') as string)
    : todayMx();

  readonly vendedor = signal<VisitMonitorVendor | null>(null);
  readonly venta = signal<VentaDetalle | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly abierto = signal<string | null>(null);

  readonly clientes = computed<VisitMonitorRow[]>(() => ordenarClientes(this.vendedor()?.rows ?? []));

  ngOnInit(): void { this.cargar(); }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.api.dia(this.fecha, this.userId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.vendedor.set(d.vendors.find((v) => v.user_id === this.userId) ?? null);
        this.cargando.set(false);
      },
      error: (e) => {
        this.cargando.set(false);
        this.error.set(motivoDeError(e, 'No se pudo cargar el día del vendedor.'));
      },
    });
    this.api.ventasDe(this.userId, this.fecha).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (data) => this.venta.set({ ok: true, data }),
      error: (e) => this.venta.set({
        ok: false,
        motivo: (e as { status?: number })?.status === 404 ? 'su ruta de ese día no es vecinal.' : motivoDeError(e, 'no se pudo leer.'),
      }),
    });
    this.cargarRecuento();
  }

  // ─── [MCP.19] Su recuento del día ───
  private readonly recuentoApi = inject(RecuentoDiaService);
  readonly recuento = signal<SellerDayRecap | null>(null);
  readonly recuentoEstado = signal<'cargando' | 'listo' | 'error'>('cargando');
  readonly recuentoError = signal<string | null>(null);
  readonly recuentoEn = signal<string | null>(null);

  cargarRecuento(): void {
    this.recuentoEstado.set('cargando');
    this.recuentoApi.dia(this.fecha, this.userId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.recuento.set(r);
        this.recuentoEstado.set('listo');
        this.recuentoError.set(null);
        this.recuentoEn.set(new Date().toISOString());
      },
      error: (e) => {
        this.recuento.set(null);
        this.recuentoEstado.set('error');
        this.recuentoError.set(motivoDeError(e, 'No se pudo cargar su recuento del día.'));
      },
    });
  }

  alternar(id: string): void { this.abierto.set(this.abierto() === id ? null : id); }

  ventaDe(c: VisitMonitorRow) {
    const v = this.venta();
    return v?.ok ? ventaDelCliente(c.customer_id, v.data.visits) : null;
  }

  etiqueta(c: VisitMonitorRow) { return etiquetaCliente(c.status); }

  motivo(c: VisitMonitorRow): string | null { return motivoNoVenta(c.no_sale_reason); }
  minutos(c: VisitMonitorRow): number | null { return minutosVisita(c); }
  horario(v: VisitMonitorVendor): string {
    const a = v.started_at ? hora.format(new Date(v.started_at)) : null;
    const b = v.finished_at ? hora.format(new Date(v.finished_at)) : null;
    return a && b ? ` · ${a}–${b}` : a ? ` · desde ${a}` : ' · sin iniciar';
  }
  corta(f: string): string { return fechaCorta(f); }
  dinero(n: number | null | undefined): string { return pesos.format(Number(n) || 0); }
  horaDe(iso: string): string { return hora.format(new Date(iso)); }
}
