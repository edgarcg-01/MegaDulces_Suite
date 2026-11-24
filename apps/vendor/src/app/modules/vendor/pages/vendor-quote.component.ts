import { ChangeDetectionStrategy, Component, DestroyRef, Injector, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MessageService } from 'primeng/api';
import { forkJoin, of, switchMap } from 'rxjs';
import { VendorService, type VendorCustomer } from '../vendor.service';
import { VendorQuoteService } from '../vendor-quote.service';
import type { PriceRow } from '../../portal/portal.service';
import {
  type CotizacionDetalle,
  type RenglonCotizado,
  existenciaParaCotizar,
  fechaCorta,
  linkWhatsApp,
  mensajeWhatsApp,
  numeroWhatsApp,
  renglonDe,
  rungDeUnidad,
} from '../cotizacion';
import { normalizarBusqueda, tokensDeBusqueda } from '@megadulces/ui-web';
import type { PasoAVenta } from '@megadulces/contracts';
import { DictarBusquedaComponent } from '../components/dictar-busqueda.component';
import { ChecadorPreciosService } from '../checador-precios.service';
import { CodigoTecleado } from '../codigo-tecleado';

const pesos = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
/** Sin buscar se muestran los más vendidos; buscando, hasta 60 resultados. */
const TOPE = 60;

/**
 * `[MCP.12]` **Cotizar** en la app del vendedor: darle precios al cliente y que tenga una muestra de lo
 * que compraría, sin levantar pedido (decisión de David, 2026-11-03; maqueta aprobada).
 *
 * Reutiliza lo que ya existe: el servidor de cotizaciones de telemarketing (`commercial/quotes`, el
 * precio lo calcula él con Kepler; `origin = route_visit`) y el cliente, la sucursal y el catálogo de la
 * toma de pedido. Una cotización NO aparta mercancía ni llega al surtidor. Al final: el documento para
 * el cliente (WhatsApp o PDF) y `[MCP.34]` «Pasar a venta» (el servidor arma y confirma el pedido con precios de hoy).
 */
@Component({
  selector: 'app-vendor-quote',
  standalone: true,
  imports: [CommonModule, DictarBusquedaComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cq">
      <header class="cq-top">
        <button type="button" class="cq-back" (click)="volver()" aria-label="Volver"><i class="pi pi-arrow-left" aria-hidden="true"></i></button>
        <div class="cq-top-t">
          <b>{{ vista() === 'doc' ? 'Cotización lista' : 'Cotización' }} · {{ cliente()?.name || 'Cliente' }}</b>
          <small>{{ sucursal()?.name ? 'Precios de ' + sucursal()!.name : 'Sin sucursal' }}{{ cot() ? ' · ' + cot()!.code : '' }}</small>
        </div>
        <span class="cq-pill">Cotización</span>
      </header>

      @if (error()) {
        <p class="cq-err" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ error() }}</p>
      }

      @if (cargando()) {
        <p class="cq-note"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Cargando el catálogo…</p>
      } @else if (vista() === 'armar') {
        <p class="cq-note">No es un pedido: no aparta mercancía ni llega al surtidor. Los precios los calcula el sistema con Kepler.</p>
        <div class="cq-search">
          <i class="pi pi-search" aria-hidden="true"></i>
          <input type="search" [placeholder]="voz.escuchando() ? 'Escuchando… di el producto' : 'Buscar producto o código'" [value]="busqueda()" (input)="alBuscar($any($event.target).value)" (keydown.enter)="codigoTecleado.alConfirmar(busqueda())"
            inputmode="search" enterkeyhint="search" autocapitalize="none" autocorrect="off" spellcheck="false" aria-label="Buscar producto" />
          <!-- [MCP.26] Buscar dictando. -->
          <app-dictar-busqueda #voz (texto)="alBuscar($event)" />
        </div>
        @if (voz.error(); as ve) { <p class="cq-err" role="alert">{{ ve }}</p> }
        <!-- [BU.4.1] Qué pasó con el código de barras tecleado o de pistola. -->
        @if (avisoCodigo(); as a) { <p [class]="a.warn ? 'cq-err' : 'cq-note'" role="status" aria-live="polite">{{ a.texto }}</p> }
        <div class="cq-lh"><b>{{ busqueda().trim() ? visibles().length + (topada() ? '+' : '') + ' resultado' + (visibles().length === 1 ? '' : 's') : 'Catálogo · más vendidos' }}</b><span>toca + para cotizar</span></div>
        <div class="cq-lista">
          @for (p of visibles(); track p.product_id) {
            <div class="cq-prod" [class.in]="cantidadDe(p) > 0">
              <div class="cq-pb">
                <div class="cq-pn">{{ p.product_name }}</div>
                @if (p.sku) { <div class="cq-sku">SKU {{ p.sku }}</div> }
                <div class="cq-pm">
                  @if (precioRenglon(p); as pr) { <span class="cq-pr">{{ pr }}</span> }
                  @else { <span class="cq-pr cq-pr-lista">{{ dinero(precioLista(p)) }} c/u</span> }
                  @if (unidades(p).length > 1) {
                    <span class="cq-us" role="group" aria-label="Unidad">
                      @for (u of unidades(p); track u) {
                        <button type="button" [class.on]="unidadDe(p) === u" [attr.aria-pressed]="unidadDe(p) === u"
                          [disabled]="ocupado() === p.product_id" (click)="elegirUnidad(p, u)">{{ u }}</button>
                      }
                    </span>
                  }
                </div>
                <!-- [MCP.35] Lo que hay en la sucursal, en la unidad que se cotiza: la misma lectura que «Tomar pedido». -->
                @if (existencia(p); as ex) { <div class="cq-stk" [ngClass]="'cq-stk-' + ex.tono">{{ ex.texto }}</div> }
              </div>
              <div class="cq-step" role="group" [attr.aria-label]="'Cantidad de ' + p.product_name">
                <button type="button" (click)="mover(p, -1)" [disabled]="ocupado() === p.product_id || cantidadDe(p) === 0" [attr.aria-label]="'Menos ' + p.product_name">−</button>
                <span>
                  @if (ocupado() === p.product_id) { <i class="pi pi-spin pi-spinner" aria-hidden="true"></i> }
                  @else { {{ cantidadDe(p) }} }
                </span>
                <button type="button" (click)="mover(p, 1)" [disabled]="ocupado() === p.product_id || !p.sku" [attr.aria-label]="'Más ' + p.product_name">+</button>
              </div>
            </div>
          }
          @if (!visibles().length) { <p class="cq-note">Sin productos con esa búsqueda.</p> }
        </div>
        <div class="cq-foot">
          <div class="cq-foot-h"><span>{{ propios().length }} {{ propios().length === 1 ? 'producto' : 'productos' }}</span><b>{{ dinero(cot()?.total) }}</b></div>
          <button type="button" class="cq-btn cq-btn-go" [disabled]="!propios().length" (click)="vista.set('doc')">Ver cotización</button>
        </div>
      } @else {
        <!-- El documento: lo que el cliente ve (y lo que se imprime como PDF). -->
        <article class="cq-doc" id="cq-doc">
          <div class="cq-doc-h"><b>Mega Dulces · Cotización</b><span class="cq-folio">{{ cot()?.code }}<br>{{ hoy }}</span></div>
          <div class="cq-meta">
            <span>Para: <b>{{ cot()?.recipient_name || cliente()?.name }}</b></span>
            @if (cot()?.created_by_name) { <span>Te atiende: {{ cot()?.created_by_name }}</span> }
          </div>
          <table>
            <thead><tr><th>Producto</th><th class="n">Cant.</th><th class="n">Importe</th></tr></thead>
            <tbody>
              @for (l of cot()?.lines ?? []; track l.id) {
                <tr>
                  <td>{{ l.product_name || l.requested_text }}@if (l.product_sku) {<div class="cq-sku">SKU {{ l.product_sku }}{{ l.parent_line_number == null ? ' · ' + dinero(l.unit_price) + ' c/u' : '' }}</div>}</td>
                  <td class="n">{{ num(l.quantity) }} {{ l.qty_unit || 'PZA' }}</td>
                  <td class="n">{{ l.parent_line_number != null ? 'Regalo' : dinero(l.line_total) }}</td>
                </tr>
              }
            </tbody>
          </table>
          <div class="cq-tot"><span>Total</span><span>{{ dinero(cot()?.total) }}</span></div>
          <p class="cq-vig">Precios de {{ sucursal()?.name || 'tu sucursal' }}{{ cot()?.valid_until ? ', válidos hasta el ' + fecha(cot()!.valid_until) : '' }}. La existencia se confirma al levantar el pedido.</p>
        </article>
        <!-- [MCP.34] Pasar a venta: un toque, el día, y el pedido llega al surtidor. -->
        @if (cot()?.order_id) {
          <p class="cq-venta-hecha" role="status"><i class="pi pi-check-circle" aria-hidden="true"></i>
            Ya es venta: pedido <b>{{ cot()?.order_code || 'registrado' }}</b>.</p>
        } @else if (venta(); as v) {
          <section class="cq-venta" aria-label="Pasar a venta">
            <label class="cq-venta-l" for="cq-dia">¿Qué día se entrega?</label>
            <input id="cq-dia" class="cq-venta-dia" type="date" [min]="hoyIso" [value]="v.fecha" (change)="elegirDia($any($event.target).value)" />
            @if (v.estado === 'calculando') {
              <p class="cq-note"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Calculando con los precios de hoy…</p>
            } @else if (v.estado === 'error') {
              <p class="cq-err" role="alert">{{ v.error }}</p>
            } @else if (v.previa; as pv) {
              <div class="cq-venta-tot">
                <span>Cotizaste <b>{{ dinero(pv.quote_total) }}</b></span>
                <span>Con los precios de hoy: <b>{{ dinero(pv.order_total) }}</b></span>
                @if (diferencia(pv); as d) { <span class="cq-venta-dif">{{ d }}</span> }
              </div>
              @if (pv.sin_producto.length) {
                <p class="cq-err">No pasan al pedido (no están en el catálogo): {{ pv.sin_producto.join(', ') }}.</p>
              }
            }
            <button type="button" class="cq-btn cq-btn-go" [disabled]="v.estado !== 'lista' || pasando()" (click)="confirmarVenta()">
              @if (pasando()) { <i class="pi pi-spin pi-spinner" aria-hidden="true"></i> } Confirmar venta · {{ diaLargo(v.fecha) }}
            </button>
            <button type="button" class="cq-btn cq-btn-link" [disabled]="pasando()" (click)="venta.set(null)">Cancelar</button>
          </section>
        }
        <div class="cq-acts">
          @if (!cot()?.order_id && !venta()) {
            <button type="button" class="cq-btn cq-btn-go" (click)="abrirVenta()"><i class="pi pi-shopping-cart" aria-hidden="true"></i> Pasar a venta</button>
          }
          <a class="cq-btn cq-btn-ok" [href]="linkWa()" target="_blank" rel="noopener"><i class="pi pi-whatsapp" aria-hidden="true"></i> Enviar por WhatsApp</a>
          <button type="button" class="cq-btn cq-btn-ghost" (click)="imprimir()"><i class="pi pi-file-pdf" aria-hidden="true"></i> Guardar PDF / imprimir</button>
          @if (!cot()?.order_id) {
            <button type="button" class="cq-btn cq-btn-link" (click)="vista.set('armar')">Seguir cotizando</button>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cq { display: flex; flex-direction: column; gap: 0.75rem; padding-bottom: 6rem; }
    .cq-top { display: flex; align-items: center; gap: 0.6rem; }
    .cq-back { width: 2.5rem; height: 2.5rem; border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); background: var(--card-bg); color: var(--text-main); cursor: pointer; }
    .cq-top-t { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .cq-top-t b { font-size: 1rem; font-weight: 800; }
    .cq-top-t small { font-size: 0.76rem; color: var(--text-muted); }
    .cq-pill { font-size: 0.68rem; font-weight: 800; border-radius: var(--r-pill, 999px); padding: 0.15rem 0.6rem; background: var(--ember-soft); color: var(--brand-900); white-space: nowrap; }
    .cq-note { margin: 0; font-size: 0.8rem; color: var(--text-muted); }
    .cq-err { margin: 0; padding: 0.6rem 0.75rem; border-radius: var(--r-md, 12px); border: 1px solid var(--bad-border); background: var(--bad-soft-bg); color: var(--bad-soft-fg); font-size: 0.85rem; }
    .cq-search { display: flex; align-items: center; gap: 0.6rem; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-pill, 999px); padding: 0.1rem 0.95rem; }
    .cq-search i { color: var(--text-muted); }
    /* [VTK.14] Como los demás buscadores: sin color al enfocar; el contorno del input lo apaga styles.css y la barra oscurece su borde. */
    .cq-search:focus-within { border-color: var(--text-muted); }
    .cq-search input { flex: 1; min-width: 0; border: none; background: none; height: 2.7rem; font-family: var(--font-body); font-size: 0.95rem; color: var(--text-main); }
    .cq-lh { display: flex; justify-content: space-between; align-items: baseline; font-size: 0.82rem; }
    .cq-lh span { color: var(--text-faint); font-size: 0.74rem; }
    .cq-lista { display: flex; flex-direction: column; gap: 0.5rem; }
    .cq-prod { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.5rem; align-items: center; padding: 0.6rem 0.75rem;
      background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); }
    .cq-prod.in { border-color: var(--action); }
    .cq-pn { font-size: 0.9rem; font-weight: 700; line-height: 1.25; }
    .cq-sku { font-family: var(--font-mono); font-size: 0.72rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .cq-pm { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; margin-top: 0.2rem; font-size: 0.8rem; color: var(--text-muted); }
    .cq-pr { font-family: var(--font-mono); font-weight: 700; color: var(--action); font-variant-numeric: tabular-nums; }
    .cq-pr-lista { color: var(--text-muted); font-weight: 600; }
    .cq-us { display: inline-flex; border: 1px solid var(--border-color); border-radius: var(--r-pill, 999px); overflow: hidden; }
    .cq-us button { border: 0; background: transparent; color: var(--text-muted); font: inherit; font-size: 0.7rem; font-weight: 800; padding: 0.15rem 0.55rem; cursor: pointer; }
    .cq-us button.on { background: var(--text-main); color: var(--card-bg); }
    .cq-step { display: inline-flex; align-items: center; border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); overflow: hidden; }
    .cq-step button { width: 2.5rem; height: 2.5rem; border: 0; background: transparent; color: var(--text-main); font-size: 1.15rem; cursor: pointer; }
    .cq-step button:disabled { color: var(--text-faint); cursor: not-allowed; }
    .cq-step span { min-width: 1.8rem; text-align: center; font-family: var(--font-mono); font-weight: 700; }
    .cq-foot { position: sticky; bottom: 0; display: flex; flex-direction: column; gap: 0.5rem; padding: 0.6rem 0 calc(0.6rem + env(safe-area-inset-bottom));
      background: var(--surface-ground); border-top: 1px solid var(--border-color); }
    .cq-foot-h { display: flex; justify-content: space-between; font-size: 0.85rem; color: var(--text-muted); }
    .cq-foot-h b { color: var(--text-main); font-family: var(--font-mono); font-size: 1rem; }
    .cq-btn { display: flex; align-items: center; justify-content: center; gap: 0.5rem; width: 100%; min-height: 3rem; border-radius: var(--r-lg, 16px);
      border: 0; font: inherit; font-weight: 800; font-size: 0.95rem; cursor: pointer; text-decoration: none; }
    .cq-btn:disabled { opacity: 0.55; cursor: not-allowed; }
    .cq-btn-go { background: var(--action); color: #fff; }
    .cq-btn-ok { background: var(--ok-fg); color: var(--card-bg); }
    .cq-btn-ghost { background: var(--card-bg); color: var(--text-main); border: 1.5px solid var(--border-color); }
    .cq-btn-link { background: transparent; color: var(--text-muted); min-height: 2.5rem; }
    .cq-back:focus-visible, .cq-btn:focus-visible, .cq-step button:focus-visible, .cq-us button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .cq-doc { display: flex; flex-direction: column; gap: 0.6rem; padding: 0.9rem; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-lg, 16px); }
    .cq-doc-h { display: flex; justify-content: space-between; gap: 0.5rem; }
    .cq-folio { font-family: var(--font-mono); font-size: 0.74rem; color: var(--text-muted); text-align: right; }
    .cq-meta { display: flex; flex-direction: column; gap: 0.1rem; font-size: 0.8rem; color: var(--text-muted); }
    .cq-meta b { color: var(--text-main); }
    .cq-doc table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
    .cq-doc th { text-align: left; color: var(--text-muted); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.25rem 0; border-bottom: 1px solid var(--border-color); }
    .cq-doc td { padding: 0.4rem 0; border-bottom: 1px solid var(--border-color); vertical-align: top; }
    .cq-doc .n { text-align: right; font-family: var(--font-mono); white-space: nowrap; padding-left: 0.4rem; }
    .cq-tot { display: flex; justify-content: space-between; font-weight: 800; }
    .cq-tot span:last-child { font-family: var(--font-mono); }
    .cq-vig { margin: 0; font-size: 0.76rem; color: var(--brand-900); background: var(--ember-soft); border-radius: var(--r-sm, 8px); padding: 0.4rem 0.55rem; }
    .cq-acts { display: flex; flex-direction: column; gap: 0.5rem; }
    /* [MCP.35] existencia: verde/ámbar/rojo como en «Tomar pedido»; sin dato en gris, nunca en verde. */
    .cq-stk { margin-top: 0.15rem; font-size: 0.76rem; font-weight: 600; }
    .cq-stk-ok { color: var(--ok-fg); } .cq-stk-warn { color: var(--warn-fg); } .cq-stk-bad { color: var(--bad-fg); }
    .cq-stk-nd { color: var(--text-muted); font-weight: 500; }
    /* [MCP.34] pasar a venta */
    .cq-venta { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.8rem; border: 1.5px solid var(--action); border-radius: var(--r-lg, 16px); background: var(--card-bg); }
    .cq-venta-l { font-size: 0.9rem; font-weight: 800; }
    .cq-venta-dia { min-height: 3rem; padding: 0 0.75rem; border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); background: var(--card-bg); color: var(--text-main); font: inherit; font-size: 1rem; }
    .cq-venta-tot { display: flex; flex-direction: column; gap: 0.15rem; font-size: 0.88rem; }
    .cq-venta-tot b { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .cq-venta-dif { font-weight: 700; color: var(--warn-fg); }
    .cq-venta-hecha { margin: 0; display: flex; align-items: center; gap: 0.5rem; padding: 0.6rem 0.75rem; border-radius: var(--r-md, 12px); background: var(--ok-soft-bg); color: var(--ok-soft-fg); font-size: 0.9rem; }
    @media print {
      .cq-top, .cq-acts, .cq-err, .cq-note, .cq-venta, .cq-venta-hecha { display: none !important; }
      .cq-doc { border: 0; padding: 0; }
    }
  `],
})
export class VendorQuoteComponent implements OnInit {
  private readonly api = inject(VendorService);
  private readonly quotes = inject(VendorQuoteService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly cliente = signal<VendorCustomer | null>(null);
  readonly sucursal = signal<{ id: string; code: string; name: string } | null>(null);
  readonly prices = signal<PriceRow[]>([]);
  readonly cot = signal<CotizacionDetalle | null>(null);
  readonly cargando = signal(true);
  readonly error = signal<string | null>(null);
  readonly busqueda = signal('');
  /** `[BU.4.1]` Qué pasó con el último código de barras tecleado, pegado o de pistola. */
  readonly avisoCodigo = signal<{ texto: string; warn: boolean } | null>(null);
  private readonly injector = inject(Injector);
  /** Cada código tiene su número: una resolución lenta no pisa lo que se tecleó después. */
  private codigoSeq = 0;
  /**
   * `[BU.4.1]` El catálogo se filtra por nombre y SKU; un código de barras se traduce antes a su clave
   * con el mismo traductor que la cámara de Tomar pedido (`[VTK.18]`): la copia de precios del
   * teléfono, también sin señal, y si no, en línea. Si no se puede, se dice; no se inventa un producto.
   */
  readonly codigoTecleado = new CodigoTecleado((codigo) => void this.buscarCodigo(codigo));
  private readonly _cancelaCodigoTecleado = inject(DestroyRef).onDestroy(() => this.codigoTecleado.cancelar());
  readonly vista = signal<'armar' | 'doc'>('armar');
  /** El producto cuyo renglón se está guardando (un toque a la vez por producto). */
  readonly ocupado = signal<string | null>(null);
  /** `[MCP.34]` El panel de «Pasar a venta»: el día elegido y la vista previa del servidor. */
  readonly venta = signal<{ fecha: string; estado: 'calculando' | 'lista' | 'error'; previa: PasoAVenta | null; error: string | null } | null>(null);
  readonly pasando = signal(false);
  /** Hoy en México: el calendario no deja elegir antes. */
  readonly hoyIso = diaMx(0);
  /** Unidad elegida por producto (sin elegir = la del renglón cotizado, o la base). */
  private readonly unidadElegida = signal<Record<string, string>>({});
  readonly hoy = new Intl.DateTimeFormat('es-MX', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date());

  private customerId = '';
  /** `[MCP.16]` De dónde se abrió: desde «Mis cotizaciones» la flecha regresa ahí, no a «Tomar pedido». */
  private desde: string | null = null;

  readonly propios = computed<RenglonCotizado[]>(() => (this.cot()?.lines ?? []).filter((l) => l.parent_line_number == null));
  /**
   * `[MCP.26]` Lo cotizable, con su texto de búsqueda ya normalizado (una vez por catálogo, no por
   * tecla). Antes se buscaba la frase entera pegada: «coca 600» no encontraba «COCA COLA 600 ML».
   */
  private readonly indice = computed(() =>
    this.prices()
      .filter((p) => p.price != null && Number(p.price) > 0)
      .map((p) => ({ p, hay: normalizarBusqueda(`${p.product_name} ${p.sku ?? ''}`) })),
  );
  readonly visibles = computed<PriceRow[]>(() => {
    const tokens = tokensDeBusqueda(this.busqueda());
    const con = this.indice();
    if (!tokens.length) {
      // Lo ya cotizado primero, para que se vea y se corrija sin buscarlo.
      const en = new Set(this.propios().map((l) => l.product_id));
      return [...con.filter((x) => en.has(x.p.product_id)), ...con.filter((x) => !en.has(x.p.product_id))].slice(0, TOPE).map((x) => x.p);
    }
    // Cada palabra, en cualquier orden y en nombre o SKU (la misma regla de toda la suite).
    const out: PriceRow[] = [];
    for (const x of con) {
      if (tokens.every((t) => x.hay.includes(t))) {
        out.push(x.p);
        if (out.length >= TOPE) break;
      }
    }
    return out;
  });
  /** `[MCP.26]` ¿La búsqueda llegó al tope? Entonces hay más de los que se ven y se dice («60+»). */
  readonly topada = computed(() => tokensDeBusqueda(this.busqueda()).length > 0 && this.visibles().length >= TOPE);
  readonly linkWa = computed(() => {
    const c = this.cot();
    if (!c) return '#';
    const cli = this.cliente();
    return linkWhatsApp(mensajeWhatsApp(c, c.recipient_name || cli?.name || 'Cliente', this.sucursal()?.name || 'tu sucursal'), numeroWhatsApp(cli?.whatsapp, cli?.phone));
  });

  /** Teclear en el buscador: el aviso del último código ya no aplica. */
  alBuscar(v: string): void {
    this.codigoSeq++;
    this.busqueda.set(v);
    if (this.avisoCodigo()) this.avisoCodigo.set(null);
    this.codigoTecleado.alTeclear(v);
  }

  async buscarCodigo(codigo: string): Promise<void> {
    const seq = ++this.codigoSeq;
    this.avisoCodigo.set({ texto: `Buscando el producto del código ${codigo}…`, warn: false });
    const suc = this.sucursal()?.code;
    const sucursal = suc && /^[0-9]{2}$/.test(suc) ? suc : null;
    const r = await this.injector.get(ChecadorPreciosService).claveDeCodigo(codigo, sucursal)
      .catch(() => ({ estado: 'no_se_pudo' as const }));
    if (seq !== this.codigoSeq) return;
    if (r.estado !== 'hallado') {
      this.avisoCodigo.set({
        texto: r.estado === 'no_esta'
          ? `El código ${codigo} no está en el catálogo de Kepler.`
          : `No se pudo confirmar de qué producto es ${codigo}: el servidor no contestó y no está en la copia de precios del teléfono.`,
        warn: true,
      });
      return;
    }
    this.busqueda.set(r.clave);
    this.avisoCodigo.set({
      texto: r.ambiguo
        ? `El código ${codigo} está en más de un producto; se busca la clave ${r.clave} (${r.nombre}). Confirma que sea el que tienes en la mano.`
        : `Código ${codigo}: ${r.nombre} (clave ${r.clave}).`,
      warn: r.ambiguo,
    });
  }

  ngOnInit(): void {
    this.customerId = this.route.snapshot.paramMap.get('id') ?? '';
    const cotId = this.route.snapshot.queryParamMap.get('cot');
    this.desde = this.route.snapshot.queryParamMap.get('desde');
    forkJoin({ c: this.api.getCustomer(this.customerId), f: this.api.myStockSources() })
      .pipe(
        switchMap(({ c, f }) => {
          this.cliente.set(c);
          this.sucursal.set(f.sucursal ? { id: f.sucursal.id, code: f.sucursal.code, name: f.sucursal.name } : null);
          return forkJoin({ cat: this.api.catalogInstant(c, f.sucursal?.id), q: cotId ? this.quotes.get(cotId) : of(null) });
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: ({ cat, q }) => {
          this.prices.set(cat.prices);
          if (q) this.cot.set(q);
          this.cargando.set(false);
        },
        error: (e) => { this.cargando.set(false); this.error.set(mensaje(e, 'No se pudo abrir la cotización.')); },
      });
  }

  unidades(p: PriceRow): string[] {
    const us = (p.rungs ?? []).map((r) => r.unit).filter(Boolean);
    return us.length ? [...new Set(us)] : ['PZA'];
  }
  unidadDe(p: PriceRow): string {
    const elegida = this.unidadElegida()[p.product_id];
    if (elegida) return elegida;
    const l = renglonDe(this.cot()?.lines ?? [], p.product_id);
    return l?.qty_unit || this.unidades(p)[0];
  }
  cantidadDe(p: PriceRow): number {
    const l = renglonDe(this.cot()?.lines ?? [], p.product_id);
    return l ? Number(l.quantity) || 0 : 0;
  }
  /** El precio de lista de la unidad elegida (sólo para orientar: el que vale es el que calcula el servidor). */
  precioLista(p: PriceRow): number {
    const r = (p.rungs ?? []).find((x) => x.unit === this.unidadDe(p));
    return Number(r?.price ?? p.price) || 0;
  }
  /** Ya cotizado: lo que calculó el servidor («$41.82 c/u · $125.46»). */
  precioRenglon(p: PriceRow): string | null {
    const l = renglonDe(this.cot()?.lines ?? [], p.product_id);
    if (!l) return null;
    return `${this.dinero(l.unit_price)} c/u · ${this.dinero(l.line_total)}`;
  }

  elegirUnidad(p: PriceRow, u: string): void {
    this.unidadElegida.update((m) => ({ ...m, [p.product_id]: u }));
    const l = renglonDe(this.cot()?.lines ?? [], p.product_id);
    // Cambiar la unidad de algo ya cotizado lo vuelve a cotizar en esa unidad (misma cantidad).
    if (l) this.guardar(p, Number(l.quantity) || 1);
  }

  mover(p: PriceRow, d: number): void {
    this.guardar(p, Math.max(0, this.cantidadDe(p) + d));
  }

  private guardar(p: PriceRow, cantidad: number): void {
    const s = this.sucursal();
    if (!p.sku) return;
    if (!s) { this.error.set('Tu ruta no tiene sucursal de surtido: pide a tu supervisor que te la asigne para poder cotizar.'); return; }
    this.ocupado.set(p.product_id);
    this.error.set(null);
    const rung = rungDeUnidad(p, this.unidadDe(p));
    const actual = this.cot();
    const l = actual ? renglonDe(actual.lines, p.product_id) : undefined;
    const id$ = actual
      ? of(actual.id)
      : this.quotes.create({ customer_id: this.customerId, source_branch: s.code, warehouse_id: s.id, contact_phone: this.cliente()?.phone || undefined }).pipe(
          switchMap((c) => {
            // La cotización se puede retomar: su id va en la URL.
            // [MCP.16] merge: conserva «desde» si se abrió desde «Mis cotizaciones».
            this.router.navigate([], { relativeTo: this.route, queryParams: { cot: c.id }, queryParamsHandling: 'merge', replaceUrl: true });
            return of(c.id);
          }),
        );
    id$
      .pipe(
        switchMap((id) => {
          const op$ = !l
            ? (cantidad > 0 ? this.quotes.addLine(id, { sku: p.sku as string, quantity: cantidad, rung }) : of(null))
            : cantidad > 0
              ? this.quotes.updateLine(id, l.id, { quantity: cantidad, rung })
              : this.quotes.removeLine(id, l.id);
          return op$.pipe(switchMap(() => this.quotes.get(id)));
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (q) => { this.cot.set(q); this.ocupado.set(null); },
        error: (e) => { this.ocupado.set(null); this.error.set(mensaje(e, 'No se pudo cotizar ese producto.')); },
      });
  }

  imprimir(): void {
    try { window.print(); } catch { this.toast.add({ severity: 'warn', summary: 'Este teléfono no permite imprimir desde la app: usa «Enviar por WhatsApp».', life: 6000 }); }
  }

  /** `[MCP.35]` La existencia del producto en la unidad que se está cotizando. */
  existencia(p: PriceRow): { texto: string; tono: 'ok' | 'warn' | 'bad' | 'nd' } {
    return existenciaParaCotizar(p, this.unidadDe(p));
  }

  /**
   * `[MCP.34]` Pasar a venta (decisión de David, 2026-11-24): un toque abre el día de entrega (mañana por
   * omisión; libre hacia adelante, domingos incluidos, nunca al pasado) y la VISTA PREVIA del servidor
   * (`dry_run`): el total con los precios de HOY contra lo cotizado. «Confirmar venta» arma el pedido, lo
   * manda al surtidor y liga la cotización, todo en el servidor y en un paso (un segundo toque no duplica).
   */
  abrirVenta(): void {
    if (!this.cot()) return;
    this.venta.set({ fecha: diaMx(1), estado: 'calculando', previa: null, error: null });
    this.calcularVenta();
  }

  elegirDia(fecha: string): void {
    const v = this.venta();
    if (!v || !fecha || fecha === v.fecha) return;
    this.venta.set({ ...v, fecha, estado: 'calculando', error: null });
    this.calcularVenta();
  }

  private calcularVenta(): void {
    const c = this.cot();
    const v = this.venta();
    if (!c || !v) return;
    const pedida = v.fecha;
    this.quotes.pasarAVenta(c.id, { requested_delivery_date: pedida, dry_run: true })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (pv) => {
          if (this.venta()?.fecha !== pedida) return; // ya eligió otro día: manda la respuesta de ése
          if (pv.ya_existia) { this.cot.update((x) => (x ? { ...x, order_id: pv.order_id, order_code: pv.order_code } : x)); this.venta.set(null); return; }
          this.venta.set({ fecha: pedida, estado: 'lista', previa: pv, error: null });
        },
        error: (e) => {
          if (this.venta()?.fecha !== pedida) return;
          this.venta.set({ fecha: pedida, estado: 'error', previa: null, error: errorDeVenta(e) });
        },
      });
  }

  confirmarVenta(): void {
    const c = this.cot();
    const v = this.venta();
    if (!c || !v || v.estado !== 'lista' || this.pasando()) return;
    this.pasando.set(true);
    this.quotes.pasarAVenta(c.id, { requested_delivery_date: v.fecha })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.pasando.set(false);
          this.venta.set(null);
          this.cot.update((x) => (x ? { ...x, status: 'accepted', order_id: r.order_id, order_code: r.order_code } : x));
          this.toast.add({
            severity: 'success',
            summary: r.ya_existia ? `Esta cotización ya era el pedido ${r.order_code ?? ''}.` : `Venta lista: pedido ${r.order_code ?? ''} para el ${this.diaLargo(r.requested_delivery_date ?? v.fecha)}.`,
            life: 6000,
          });
          if (r.sin_producto.length) this.toast.add({ severity: 'warn', summary: `No pasaron al pedido: ${r.sin_producto.join(', ')}`, life: 8000 });
        },
        error: (e) => {
          this.pasando.set(false);
          this.venta.set({ ...v, estado: 'error', error: errorDeVenta(e) });
        },
      });
  }

  /** «Sube $12.40» / «Baja $3.00»; nada si es igual (al centavo). */
  diferencia(pv: PasoAVenta): string | null {
    const d = Math.round(((pv.order_total ?? 0) - pv.quote_total) * 100) / 100;
    if (!d) return null;
    return `${d > 0 ? 'Sube' : 'Baja'} ${this.dinero(Math.abs(d))} desde que cotizaste`;
  }

  diaLargo(f: string | null | undefined): string {
    if (!f || !/^\d{4}-\d{2}-\d{2}$/.test(f)) return f ?? '';
    return new Intl.DateTimeFormat('es-MX', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${f}T12:00:00Z`));
  }

  volver(): void {
    if (this.vista() === 'doc') { this.vista.set('armar'); return; }
    if (this.desde === 'cotizaciones') { this.router.navigate(['/vendor/mis-pedidos'], { queryParams: { ver: 'cotizaciones' } }); return; }
    this.router.navigate(['/vendor/take-order', this.customerId]);
  }

  dinero(n: number | string | null | undefined): string { return pesos.format(Number(n) || 0); }
  num(n: number | string | null | undefined): string { const v = Number(n) || 0; return Number.isInteger(v) ? String(v) : String(+v.toFixed(3)); }
  fecha(f: string | null | undefined): string { return fechaCorta(f); }
}

function mensaje(e: unknown, def: string): string {
  const m = (e as { error?: { message?: string | string[] } })?.error?.message;
  return Array.isArray(m) ? m.join(' · ') : m || def;
}

/** `[MCP.34]` Sin señal se dice así (status 0); lo demás, el mensaje del servidor. */
function errorDeVenta(e: unknown): string {
  if ((e as { status?: number })?.status === 0) return 'Sin señal: pasar a venta necesita conexión. Inténtalo cuando tengas señal.';
  return mensaje(e, 'No se pudo pasar a venta.');
}

/** El día de México dentro de `d` días, `YYYY-MM-DD`. */
function diaMx(d: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date(Date.now() + d * 86_400_000));
}
