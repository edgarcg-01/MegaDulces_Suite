import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { PresaleSellerOrder, PresaleSellerStatusResponse } from '@megadulces/contracts';
import { PresaleStatusService } from '../presale-status.service';

/** Cada cuánto se vuelve a pedir mientras la pantalla se está viendo. */
const REFRESCO_MS = 30_000;

type Paso = { titulo: string; detalle: string; estado: 'hecho' | 'aviso' | 'ahora' | 'pendiente' };

const pesos = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const hora = new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * `[MCP.8]` **Mis pedidos**: la vendedora ve por pedido si ya lo tomó el surtidor (con su nombre
 * y la hora en que empezó), si se surtió completo o con faltantes (y el reporte: lo que se quitó
 * y el nuevo total), si Kepler ya lo cobró y si se entregó.
 *
 * «Cobrado» viene de la liga confirmada o de una DETECCIÓN (un solo ticket del cliente, posterior
 * al surtido, con los mismos productos). Las dos se distinguen en pantalla: la detección no es la
 * liga (D2/D6 de la Fase MCP), así que no se presenta como hecho confirmado.
 */
@Component({
  selector: 'app-vendor-mis-pedidos',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="mp">
      <header class="mp-head">
        <div>
          <h1>Mis pedidos</h1>
          <span class="mp-sub">Se actualiza solo{{ cargadoEn() ? ' · ' + horaDe(cargadoEn()!) : '' }}</span>
        </div>
        <button type="button" class="mp-ref" (click)="cargar()" [disabled]="cargando()" aria-label="Actualizar">
          <i class="pi pi-refresh" [class.pi-spin]="cargando()" aria-hidden="true"></i>
        </button>
      </header>

      @if (error()) {
        <div class="mp-err" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>{{ error() }}</span>
          <button type="button" (click)="cargar()">Reintentar</button>
        </div>
      } @else if (cargando() && !datos()) {
        <p class="mp-vacio">Cargando…</p>
      } @else if (!pedidos().length) {
        <div class="mp-vacio">
          <i class="pi pi-inbox" aria-hidden="true"></i>
          <p>Todavía no tienes pedidos de preventa abiertos.</p>
        </div>
      } @else {
        <ul class="mp-lista">
          @for (p of pedidos(); track p.order_id) {
            <li class="mp-card" [class.mp-card-nuevo]="p.report_unseen">
              <button type="button" class="mp-card-h" (click)="alternar(p.order_id)" [attr.aria-expanded]="abierto() === p.order_id">
                <span class="mp-r1">
                  <strong>{{ p.customer_name || p.code }}</strong>
                  <span class="chip" [class]="'chip ' + estado(p).clase">{{ estado(p).texto }}</span>
                </span>
                <span class="mp-r2">
                  <span class="mp-folio">{{ p.code }}</span>
                  <span>entrega {{ fechaCorta(p.requested_delivery_date) }}</span>
                  <span class="mp-total">{{ dinero(p.total) }}</span>
                </span>
              </button>
              @if (abierto() === p.order_id) {
                <ol class="mp-tl">
                  @for (s of pasos(p); track s.titulo) {
                    <li class="mp-st" [class]="'mp-st mp-st-' + s.estado">
                      <span class="mp-dot" aria-hidden="true">
                        @if (s.estado === 'hecho' || s.estado === 'aviso') { <i class="pi pi-check"></i> }
                      </span>
                      <span><b>{{ s.titulo }}</b>@if (s.detalle) {<span class="mp-st-d">{{ s.detalle }}</span>}</span>
                    </li>
                  }
                </ol>
                @if (p.report; as r) {
                  <div class="mp-rep">
                    <b>Reporte de surtido</b>
                    @if (r.removed.length) {
                      <span>Se quitó del pedido (no hubo):</span>
                      <ul>@for (l of r.removed; track l.product_name) { <li>{{ l.product_name }} · {{ l.ordered }} {{ l.unit }}</li> }</ul>
                    }
                    @if (r.adjusted.length) {
                      <span>Se ajustó a lo que hubo:</span>
                      <ul>@for (l of r.adjusted; track l.product_name) { <li>{{ l.product_name }} · {{ l.ordered }} → {{ l.picked }} {{ l.unit }}</li> }</ul>
                    }
                    <span>Total del pedido: <s>{{ dinero(r.total_before) }}</s> → <b>{{ dinero(r.total_after) }}</b></span>
                  </div>
                }
                @if (p.charge; as c) {
                  <div class="mp-cobro" [class.mp-cobro-det]="c.source === 'detectado'">
                    <b>{{ c.source === 'liga' ? 'Kepler cobró este pedido' : 'Parece que Kepler ya lo cobró' }}</b>
                    <span>Ticket {{ c.folio_digital }}{{ c.total !== null ? ' · ' + dinero(c.total) : '' }}</span>
                    <span>{{ c.shared_products }} de {{ c.order_products }} productos coinciden.</span>
                    @if (c.source === 'detectado') {
                      <span class="mp-nota">Lo confirma quien entrega al elegir el ticket.</span>
                    }
                  </div>
                }
              }
            </li>
          }
        </ul>
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .mp { padding: var(--sp-4) var(--sp-4) var(--sp-8); }
    .mp-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); margin-bottom: var(--sp-3); }
    .mp-head h1 { margin: 0; font-size: var(--fs-h2); font-weight: 800; }
    .mp-sub { font-size: var(--fs-xs); color: var(--text-muted); }
    .mp-ref { width: var(--tap-min); height: var(--tap-min); border-radius: var(--r-md); border: 1px solid var(--border-color);
      background: var(--card-bg); color: var(--text-main); cursor: pointer; }
    .mp-ref:focus-visible, .mp-card-h:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .mp-err { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-3); border: 1px solid var(--bad-border);
      border-radius: var(--r-md); color: var(--bad-fg); }
    .mp-err button { margin-left: auto; min-height: var(--tap-min); border-radius: var(--r-md); border: 1px solid var(--border-color);
      background: var(--card-bg); color: var(--text-main); padding: 0 var(--sp-3); cursor: pointer; }
    .mp-vacio { text-align: center; color: var(--text-muted); padding: var(--sp-8) var(--sp-4); }
    .mp-vacio i { font-size: var(--fs-display); color: var(--text-faint); }
    .mp-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    .mp-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-lg); overflow: hidden; }
    .mp-card-nuevo { border-left: 4px solid var(--warn-fg); }
    .mp-card-h { display: flex; flex-direction: column; gap: var(--sp-1); width: 100%; text-align: left; padding: var(--sp-3);
      border: 0; background: transparent; color: var(--text-main); cursor: pointer; min-height: var(--tap-min); }
    .mp-r1 { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
    .mp-r1 strong { font-size: var(--fs-body); }
    .mp-r2 { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); }
    .mp-folio { font-family: var(--font-mono); }
    .mp-total { margin-left: auto; font-family: var(--font-mono); font-weight: 700; color: var(--text-main); font-variant-numeric: tabular-nums; }
    .chip { font-size: var(--fs-xs); font-weight: 700; padding: var(--sp-1) var(--sp-2); border-radius: var(--r-pill); white-space: nowrap; }
    .chip.ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .chip.info { background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .chip.warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .mp-tl { list-style: none; margin: 0; padding: 0 var(--sp-3) var(--sp-3); display: flex; flex-direction: column; gap: var(--sp-3); }
    .mp-st { display: grid; grid-template-columns: 1.5rem 1fr; gap: var(--sp-2); align-items: start; font-size: var(--fs-body); }
    .mp-dot { width: 1.5rem; height: 1.5rem; border-radius: 50%; border: 2px solid var(--border-color); display: grid; place-items: center;
      font-size: var(--fs-xs); background: var(--card-bg); }
    .mp-st-hecho .mp-dot { background: var(--ok-fg); border-color: var(--ok-fg); color: var(--card-bg); }
    .mp-st-aviso .mp-dot { background: var(--warn-fg); border-color: var(--warn-fg); color: var(--card-bg); }
    .mp-st-ahora .mp-dot { border-color: var(--action); }
    .mp-st-pendiente b { color: var(--text-muted); }
    .mp-st-d { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
    .mp-rep, .mp-cobro { margin: 0 var(--sp-3) var(--sp-3); padding: var(--sp-3); border-radius: var(--r-md); display: flex;
      flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); }
    .mp-rep { background: var(--warn-soft-bg); border: 1px solid var(--warn-border); }
    .mp-rep ul { margin: 0; padding-left: 1.1rem; }
    .mp-cobro { background: var(--ok-soft-bg); border: 1px solid var(--ok-border); }
    .mp-cobro-det { background: var(--info-soft-bg); border-color: var(--info-border); }
    .mp-nota { color: var(--text-muted); font-size: var(--fs-xs); }
  `],
})
export class VendorMisPedidosComponent implements OnInit {
  private readonly api = inject(PresaleStatusService);
  private readonly destroyRef = inject(DestroyRef);

  readonly datos = signal<PresaleSellerStatusResponse | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly cargadoEn = signal<string | null>(null);
  readonly abierto = signal<string | null>(null);
  readonly pedidos = computed<PresaleSellerOrder[]>(() => this.datos()?.data ?? []);

  ngOnInit(): void {
    this.cargar();
    // Sólo mientras la pantalla se ve: en un celular con la pantalla apagada no se gasta red.
    const t = setInterval(() => { if (document.visibilityState === 'visible') this.cargar(true); }, REFRESCO_MS);
    const alVolver = () => { if (document.visibilityState === 'visible') this.cargar(true); };
    document.addEventListener('visibilitychange', alVolver);
    this.destroyRef.onDestroy(() => { clearInterval(t); document.removeEventListener('visibilitychange', alVolver); });
  }

  cargar(silencioso = false): void {
    if (!silencioso) this.cargando.set(true);
    this.api.status().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.datos.set(d);
        this.cargando.set(false);
        this.error.set(null);
        this.cargadoEn.set(new Date().toISOString());
        // Abrir el primero con reporte nuevo: es lo que vino a ver si llegó por el aviso.
        const nuevo = d.data.find((p) => p.report_unseen);
        if (nuevo && !this.abierto()) this.abierto.set(nuevo.order_id);
        if (d.unseen_reports > 0) this.api.markSeen().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ error: () => void 0 });
      },
      error: (e) => {
        this.cargando.set(false);
        this.error.set((e as { error?: { message?: string } })?.error?.message || 'No se pudieron cargar tus pedidos.');
      },
    });
  }

  alternar(id: string): void { this.abierto.set(this.abierto() === id ? null : id); }

  estado(p: PresaleSellerOrder): { texto: string; clase: string } {
    if (p.delivered_at) return { texto: 'Entregado', clase: 'ok' };
    if (p.charge?.source === 'liga') return { texto: 'Cobrado', clase: 'ok' };
    if (p.charge) return { texto: 'Cobrado (por confirmar)', clase: 'info' };
    if (p.finished) return p.finished.outcome === 'con_faltantes' ? { texto: 'Surtido con faltantes', clase: 'warn' } : { texto: 'Surtido completo', clase: 'ok' };
    if (p.started) return { texto: 'Surtiendo', clase: 'warn' };
    return { texto: 'Agendado', clase: 'info' };
  }

  pasos(p: PresaleSellerOrder): Paso[] {
    const tomado = !!p.started;
    const surtido = !!p.finished;
    const cobrado = !!p.charge;
    return [
      { titulo: 'Agendado', detalle: p.scheduled_at ? `${this.horaDe(p.scheduled_at)} · llegó a ${p.warehouse_name || 'la sucursal'}` : '', estado: 'hecho' },
      {
        titulo: 'Lo tomó el surtidor',
        detalle: p.started ? `${p.started.name} · empezó ${this.horaDe(p.started.at)}` : 'Esperando a que el surtidor empiece',
        estado: tomado ? 'hecho' : 'ahora',
      },
      {
        titulo: p.finished?.outcome === 'con_faltantes' ? 'Surtido con faltantes' : 'Surtido',
        detalle: p.finished ? `${p.finished.name} · terminó ${this.horaDe(p.finished.at)}${p.finished.outcome === 'con_faltantes' ? ' · lo que faltó se quitó del pedido' : ' · hubo todo'}` : '',
        estado: surtido ? (p.finished?.outcome === 'con_faltantes' ? 'aviso' : 'hecho') : tomado ? 'ahora' : 'pendiente',
      },
      {
        titulo: 'Cobrado en Kepler',
        detalle: p.charge ? `Ticket ${p.charge.folio_digital}${p.charge.source === 'detectado' ? ' · por confirmar' : ''}` : 'Se detecta cuando la caja cierre el ticket',
        estado: cobrado ? 'hecho' : surtido ? 'ahora' : 'pendiente',
      },
      { titulo: 'Entregado', detalle: p.delivered_at ? this.horaDe(p.delivered_at) : '', estado: p.delivered_at ? 'hecho' : 'pendiente' },
    ];
  }

  dinero(n: number | string | null | undefined): string { return pesos.format(Number(n) || 0); }
  horaDe(iso: string): string { return hora.format(new Date(iso)); }
  fechaCorta(f: string): string {
    const [y, m, d] = f.split('-').map(Number);
    return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
  }
}
