import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { SellerDayOrder, SellerDayRecap } from '@megadulces/contracts';
import {
  type FilaSurtido,
  dinero,
  estadoCliente,
  filasSurtido,
  fraseLevantado,
  fraseResultadoVisitas,
  fraseVisitas,
  hayPendiente,
  pedidosDeFila,
  resumenSurtido,
  tituloDelDia,
} from '../recuento-dia';

/** Qué grupo está abierto: una fila del surtido o una de lo pendiente. */
type Abierto = FilaSurtido['clave'] | 'borradores' | 'por_aprobar' | 'sin_visita' | 'cancelados' | null;

const hora = new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * `[MCP.19]` **Recuento del día**: cómo le fue, qué pasó con lo que levantó, y qué le quedó pendiente.
 * Lo usan el vendedor (arriba de «Pedidos») y su supervisor («Equipo › vendedor») con la MISMA
 * respuesta del servidor. Cada número abre los pedidos que cuenta (el desglose, sin salir).
 *
 * Primero la respuesta (cuánto levantó), después cómo va eso, y al final lo que falta. Lo que no se
 * pudo leer se dice con su motivo: nunca se pinta un cero que no se midió.
 */
@Component({
  selector: 'app-vendor-recuento-dia',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="rd" aria-labelledby="rd-titulo">
      @if (estado() === 'error') {
        <div class="rd-err" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>{{ error() || 'No se pudo cargar el recuento del día.' }}</span>
          <button type="button" (click)="reintentar.emit()">Reintentar</button>
        </div>
      } @else if (!recuento()) {
        <p class="rd-nota" id="rd-titulo">Cargando el recuento del día…</p>
      } @else if (recuento(); as r) {
        @if (compacto()) {
          <!-- [MCP.21] Compacto: el día ya lo dice el chip de arriba, y la hora, el encabezado de la pantalla. -->
          <h2 id="rd-titulo" class="rd-oculto">{{ titulo() }}</h2>
        } @else {
          <header class="rd-h">
            <h2 id="rd-titulo">{{ titulo() }}</h2>
            @if (cargadoEn()) { <span class="rd-nota">al {{ horaDe(cargadoEn()!) }}</span> }
          </header>
        }

        <p class="rd-lev">
          <span>{{ levantado() }}</span>
          @if (r.orders.count) { <b class="rd-monto">{{ dinero(r.orders.total) }}</b> }
        </p>

        @if (compacto()) {
          <!-- [MCP.21] Tres renglones: cuánto, cómo va el surtido y a quién visitó. Lo demás, en «Ver detalle». -->
          @if (r.orders.count) {
            @if (r.picking) { <p class="rd-vis">{{ resumen() }}</p> } @else { <p class="rd-nota">{{ r.picking_unmeasured_reason }}</p> }
          }
          @if (conVisitas()) {
            <p class="rd-nota">{{ r.visits ? visitas() : 'Visitas: ' + r.visits_unmeasured_reason }}</p>
          }
          @if (r.pending.drafts.length) {
            <!-- Lo único que pide algo de la vendedora: un borrador no le llega al surtidor. -->
            <button type="button" class="rd-alerta" (click)="abrirDetalle('borradores')">
              <i class="pi pi-file-edit" aria-hidden="true"></i>
              <span>{{ alertaBorradores() }}<small>el surtidor no lo ve hasta que lo mandes</small></span>
              <i class="pi pi-angle-right" aria-hidden="true"></i>
            </button>
          }
          <button type="button" class="rd-mas" (click)="detalle.set(!detalle())" [attr.aria-expanded]="detalle()">
            {{ detalle() ? 'Ocultar detalle' : 'Ver detalle' }}
            <i class="pi" [class.pi-angle-down]="!detalle()" [class.pi-angle-up]="detalle()" aria-hidden="true"></i>
          </button>
        } @else if (conVisitas()) {
          @if (r.visits; as v) {
            <p class="rd-vis">{{ visitas() }}</p>
            <p class="rd-nota">{{ resultadoVisitas() }}</p>
          } @else {
            <p class="rd-nota">Visitas: {{ r.visits_unmeasured_reason }}</p>
          }
        }

        @if (!compacto() || detalle()) {
        @if (compacto() && r.visits) { <p class="rd-nota">{{ resultadoVisitas() }}</p> }
        @if (r.orders.count) {
          <h3 class="rd-sec">Cómo van al surtir</h3>
          @if (!r.picking) {
            <p class="rd-nota">{{ r.picking_unmeasured_reason }}</p>
          } @else {
            <ul class="rd-filas">
              @for (f of filas(); track f.clave) {
                <li>
                  <button type="button" class="rd-fila" (click)="alternar(f.clave)" [attr.aria-expanded]="abierto() === f.clave">
                    <i [class]="'pi ' + f.icono + ' rd-i rd-' + f.tono" aria-hidden="true"></i>
                    <span class="rd-t">{{ f.texto }}@if (f.detalle) {<small>{{ f.detalle }}</small>}</span>
                    <b class="rd-n">{{ f.n }}</b>
                    <i class="pi rd-chev" [class.pi-angle-down]="abierto() !== f.clave" [class.pi-angle-up]="abierto() === f.clave" aria-hidden="true"></i>
                  </button>
                  @if (abierto() === f.clave) {
                    <ul class="rd-peds">
                      @for (o of pedidosDe(f.clave); track o.order_id) {
                        <li>
                          @if (pedidosAbribles()) {
                            <button type="button" class="rd-ped" (click)="abrirPedido.emit(o.order_id)">
                              <span>{{ o.customer_name || 'Sin nombre' }}<small class="mono">{{ o.code }}</small></span>
                              <span class="mono">{{ montoDe(o, f.clave) }}</span>
                            </button>
                          } @else {
                            <div class="rd-ped">
                              <span>{{ o.customer_name || 'Sin nombre' }}<small class="mono">{{ o.code }}</small></span>
                              <span class="mono">{{ montoDe(o, f.clave) }}</span>
                            </div>
                          }
                        </li>
                      }
                    </ul>
                  }
                </li>
              }
            </ul>
          }
        }

        <h3 class="rd-sec">Pendiente</h3>
        @if (!pendiente()) {
          <p class="rd-nota">Nada pendiente{{ propio() ? ' de tu día' : '' }}.</p>
        } @else {
          <ul class="rd-filas">
            @if (r.pending.drafts.length) {
              <li>
                <button type="button" class="rd-fila" (click)="alternar('borradores')" [attr.aria-expanded]="abierto() === 'borradores'">
                  <i class="pi pi-file-edit rd-i rd-warn" aria-hidden="true"></i>
                  <span class="rd-t">Borradores sin mandar<small>{{ propio() ? 'no le llegan al surtidor hasta que los mandes' : 'no le llegan al surtidor' }}</small></span>
                  <b class="rd-n">{{ r.pending.drafts.length }}</b>
                  <i class="pi rd-chev" [class.pi-angle-down]="abierto() !== 'borradores'" [class.pi-angle-up]="abierto() === 'borradores'" aria-hidden="true"></i>
                </button>
                @if (abierto() === 'borradores') {
                  <ul class="rd-peds">
                    @for (o of r.pending.drafts; track o.order_id) {
                      <li>
                        @if (propio() && o.customer_id) {
                          <button type="button" class="rd-ped" (click)="abrirBorrador.emit(o.customer_id)">
                            <span>{{ o.customer_name || 'Sin nombre' }}<small>Abrir para mandarlo</small></span>
                            <span class="mono">{{ dinero(o.total) }}</span>
                          </button>
                        } @else {
                          <div class="rd-ped"><span>{{ o.customer_name || 'Sin nombre' }}<small class="mono">{{ o.code }}</small></span><span class="mono">{{ dinero(o.total) }}</span></div>
                        }
                      </li>
                    }
                  </ul>
                }
              </li>
            }
            @if (r.pending.awaiting_approval.length) {
              <li>
                <button type="button" class="rd-fila" (click)="alternar('por_aprobar')" [attr.aria-expanded]="abierto() === 'por_aprobar'">
                  <i class="pi pi-hourglass rd-i rd-info" aria-hidden="true"></i>
                  <span class="rd-t">Por aprobar</span>
                  <b class="rd-n">{{ r.pending.awaiting_approval.length }}</b>
                  <i class="pi rd-chev" [class.pi-angle-down]="abierto() !== 'por_aprobar'" [class.pi-angle-up]="abierto() === 'por_aprobar'" aria-hidden="true"></i>
                </button>
                @if (abierto() === 'por_aprobar') {
                  <ul class="rd-peds">
                    @for (o of r.pending.awaiting_approval; track o.order_id) {
                      <li><div class="rd-ped"><span>{{ o.customer_name || 'Sin nombre' }}<small class="mono">{{ o.code }}</small></span><span class="mono">{{ dinero(o.total) }}</span></div></li>
                    }
                  </ul>
                }
              </li>
            }
            @if (conClientes() && r.visits?.not_visited?.length) {
              <li>
                <button type="button" class="rd-fila" (click)="alternar('sin_visita')" [attr.aria-expanded]="abierto() === 'sin_visita'">
                  <i class="pi pi-map-marker rd-i" [class.rd-warn]="r.visits!.missed > 0" [class.rd-muted]="!r.visits!.missed" aria-hidden="true"></i>
                  <span class="rd-t">Clientes de {{ propio() ? 'tu' : 'su' }} ruta sin visita@if (!r.visits!.closed) {<small>{{ propio() ? 'tu' : 'su' }} ruta sigue abierta</small>}</span>
                  <b class="rd-n">{{ r.visits!.not_visited.length }}</b>
                  <i class="pi rd-chev" [class.pi-angle-down]="abierto() !== 'sin_visita'" [class.pi-angle-up]="abierto() === 'sin_visita'" aria-hidden="true"></i>
                </button>
                @if (abierto() === 'sin_visita') {
                  <ul class="rd-peds">
                    @for (c of r.visits!.not_visited; track c.customer_id) {
                      <li><div class="rd-ped"><span>{{ c.name }}<small class="mono">{{ c.code }}</small></span><span class="rd-est">{{ estadoCliente(c, propio()) }}</span></div></li>
                    }
                  </ul>
                }
              </li>
            }
            @if (r.cancelled.length) {
              <li>
                <button type="button" class="rd-fila" (click)="alternar('cancelados')" [attr.aria-expanded]="abierto() === 'cancelados'">
                  <i class="pi pi-ban rd-i rd-muted" aria-hidden="true"></i>
                  <span class="rd-t">Cancelados</span>
                  <b class="rd-n">{{ r.cancelled.length }}</b>
                  <i class="pi rd-chev" [class.pi-angle-down]="abierto() !== 'cancelados'" [class.pi-angle-up]="abierto() === 'cancelados'" aria-hidden="true"></i>
                </button>
                @if (abierto() === 'cancelados') {
                  <ul class="rd-peds">
                    @for (o of r.cancelled; track o.order_id) {
                      <li><div class="rd-ped rd-ped-col">
                        <span>{{ o.customer_name || 'Sin nombre' }}<small class="mono">{{ o.code }} · {{ dinero(o.total) }}</small></span>
                        <small [class.rd-sin]="!o.reason">Motivo: {{ o.reason || 'sin motivo registrado' }}</small>
                      </div></li>
                    }
                  </ul>
                }
              </li>
            }
          </ul>
        }
        @if (compacto() && cargadoEn()) { <p class="rd-nota">Recuento al {{ horaDe(cargadoEn()!) }}</p> }
        }
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .rd { display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-3); border: 1px solid var(--border-color);
      border-radius: var(--r-lg); background: var(--card-bg); }
    .rd-h { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-2); }
    .rd-h h2 { margin: 0; font-size: var(--fs-lg); font-weight: 800; }
    .rd-lev { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: var(--sp-1) var(--sp-3);
      margin: 0; font-size: var(--fs-body); font-weight: 700; }
    .rd-monto { font-family: var(--font-mono); font-size: var(--fs-h2); font-weight: 800; font-variant-numeric: tabular-nums; }
    .rd-vis { margin: 0; font-size: var(--fs-sm); color: var(--text-main); }
    .rd-nota { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .rd-sec { margin: var(--sp-3) 0 0; font-size: var(--fs-xs); font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); }
    .rd-filas, .rd-peds { list-style: none; margin: 0; padding: 0; }
    .rd-filas > li { border-bottom: 1px solid var(--border-color); }
    .rd-filas > li:last-child { border-bottom: 0; }
    .rd-fila { display: grid; grid-template-columns: 1.5rem 1fr auto 1rem; align-items: center; gap: var(--sp-2); width: 100%;
      min-height: var(--tap-min); padding: var(--sp-2) 0; border: 0; background: transparent; color: var(--text-main);
      font-family: inherit; font-size: var(--fs-body); text-align: left; cursor: pointer; }
    .rd-fila:focus-visible, .rd-ped:focus-visible, .rd-err button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .rd-t { display: flex; flex-direction: column; min-width: 0; }
    .rd-t small { font-size: var(--fs-xs); color: var(--text-muted); }
    .rd-n { font-family: var(--font-mono); font-size: var(--fs-lg); font-variant-numeric: tabular-nums; }
    .rd-chev { color: var(--text-faint); font-size: var(--fs-sm); }
    .rd-i { font-size: var(--fs-lg); }
    .rd-ok { color: var(--ok-fg); }
    .rd-warn { color: var(--warn-fg); }
    .rd-info { color: var(--info-fg); }
    .rd-muted { color: var(--text-muted); }
    .rd-peds { display: flex; flex-direction: column; padding: 0 0 var(--sp-2) calc(1.5rem + var(--sp-2)); }
    .rd-ped { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); width: 100%; min-height: var(--tap-min);
      padding: var(--sp-1) 0; border: 0; border-top: 1px solid var(--border-color); background: transparent; color: var(--text-main);
      font-family: inherit; font-size: var(--fs-sm); text-align: left; }
    button.rd-ped { cursor: pointer; }
    .rd-ped > span:first-child { display: flex; flex-direction: column; min-width: 0; }
    .rd-ped small { font-size: var(--fs-xs); color: var(--text-muted); }
    .rd-ped-col { flex-direction: column; align-items: flex-start; }
    .rd-est { font-size: var(--fs-xs); color: var(--text-muted); text-align: right; }
    .rd-sin { font-style: italic; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    /* [MCP.21] Compacto: oculto a la vista, no al lector de pantalla. */
    .rd-oculto { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    .rd-alerta { display: flex; align-items: center; gap: var(--sp-2); width: 100%; min-height: var(--tap-min); margin-top: var(--sp-1);
      padding: var(--sp-2) var(--sp-3); border: 0; border-radius: var(--r-md); background: var(--warn-soft-bg); color: var(--warn-soft-fg);
      font-family: inherit; font-size: var(--fs-sm); font-weight: 700; text-align: left; cursor: pointer; }
    .rd-alerta span { flex: 1; display: flex; flex-direction: column; }
    .rd-alerta small { font-weight: 500; font-size: var(--fs-xs); }
    .rd-mas { align-self: flex-start; display: inline-flex; align-items: center; gap: var(--sp-1); min-height: var(--tap-min);
      padding: 0; border: 0; background: transparent; color: var(--text-muted); font-family: inherit; font-size: var(--fs-sm);
      font-weight: 600; cursor: pointer; }
    .rd-alerta:focus-visible, .rd-mas:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .rd-err { display: flex; align-items: center; gap: var(--sp-2); color: var(--bad-fg); font-size: var(--fs-sm); }
    .rd-err button { margin-left: auto; min-height: var(--tap-min); border-radius: var(--r-md); border: 1px solid var(--border-color);
      background: var(--card-bg); color: var(--text-main); padding: 0 var(--sp-3); font-family: inherit; cursor: pointer; }
  `],
})
export class VendorRecuentoDiaComponent {
  /** La respuesta del servidor; `null` mientras carga. */
  readonly recuento = input<SellerDayRecap | null>(null);
  readonly estado = input<'cargando' | 'listo' | 'error'>('cargando');
  readonly error = input<string | null>(null);
  /** ISO de cuándo se leyó (la edad del dato). */
  readonly cargadoEn = input<string | null>(null);
  /** `true` = lo lee el vendedor de sí mismo; `false` = su supervisor. */
  readonly propio = input(true);
  /** La línea de visitas. El supervisor ya la tiene arriba en su pantalla. */
  readonly conVisitas = input(true);
  /** Los clientes de la ruta sin visita. El supervisor ya los ve en su lista. */
  readonly conClientes = input(true);
  /** Si tocar un pedido del desglose lo abre (en «Pedidos» sí; donde no hay lista de pedidos, no). */
  readonly pedidosAbribles = input(false);
  /**
   * `[MCP.21]` Tres renglones y el detalle a un toque (la vendedora, en «Pedidos»: la lista de abajo ya trae el estado
   * de cada pedido y «Mi ruta» el de cada cliente). El supervisor lo sigue viendo completo.
   */
  readonly compacto = input(false);
  /** En compacto: si el detalle está abierto. */
  readonly detalle = signal(false);

  readonly reintentar = output<void>();
  readonly abrirPedido = output<string>();
  /** El cliente del borrador, para abrir «Tomar pedido» y mandarlo. */
  readonly abrirBorrador = output<string>();

  readonly abierto = signal<Abierto>(null);
  readonly titulo = computed(() => { const r = this.recuento(); return r ? tituloDelDia(r) : ''; });
  readonly levantado = computed(() => { const r = this.recuento(); return r ? fraseLevantado(r, this.propio()) : ''; });
  readonly visitas = computed(() => { const v = this.recuento()?.visits; return v ? fraseVisitas(v, this.propio()) : ''; });
  readonly resultadoVisitas = computed(() => { const v = this.recuento()?.visits; return v ? fraseResultadoVisitas(v) : ''; });
  readonly filas = computed(() => { const r = this.recuento(); return r ? filasSurtido(r) : []; });
  readonly resumen = computed(() => { const r = this.recuento(); return r ? resumenSurtido(r) : ''; });
  readonly alertaBorradores = computed(() => {
    const n = this.recuento()?.pending.drafts.length ?? 0;
    return n === 1 ? '1 borrador sin mandar' : `${n} borradores sin mandar`;
  });
  readonly pendiente = computed(() => { const r = this.recuento(); return r ? hayPendiente(r, this.conClientes()) : false; });

  readonly dinero = dinero;
  readonly estadoCliente = estadoCliente;

  /** Desde el aviso: abre el detalle con ese grupo ya desplegado. */
  abrirDetalle(k: Exclude<Abierto, null>): void {
    this.detalle.set(true);
    this.abierto.set(k);
  }

  alternar(k: Exclude<Abierto, null>): void {
    this.abierto.set(this.abierto() === k ? null : k);
  }

  pedidosDe(k: FilaSurtido['clave']): SellerDayOrder[] {
    const r = this.recuento();
    return r ? pedidosDeFila(r, k) : [];
  }

  /** En «con faltantes» se ve cuánto bajó; en lo demás, con cuánto se levantó. */
  montoDe(o: SellerDayOrder, k: FilaSurtido['clave']): string {
    return k === 'con_faltantes' && o.removed_total > 0 ? `${dinero(o.total)} · −${dinero(o.removed_total)}` : dinero(o.total);
  }

  horaDe(iso: string): string { return hora.format(new Date(iso)); }
}
