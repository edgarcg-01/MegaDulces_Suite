import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MessageService } from 'primeng/api';
import { concatMap, forkJoin, from, last, of, switchMap } from 'rxjs';
import { VendorService, type VendorCustomer } from '../vendor.service';
import { VendorQuoteService } from '../vendor-quote.service';
import type { PriceRow } from '../../portal/portal.service';
import {
  type CotizacionDetalle,
  type RenglonCotizado,
  fechaCorta,
  linkWhatsApp,
  mensajeWhatsApp,
  numeroWhatsApp,
  paraPedido,
  renglonDe,
  rungDeUnidad,
} from '../cotizacion';

const pesos = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
/** Sin buscar se muestran los más vendidos; buscando, hasta 60 resultados. */
const TOPE = 60;

/**
 * `[MCP.12]` **Cotizar** en la app del vendedor: darle precios al cliente y que tenga una muestra de lo
 * que compraría, sin levantar pedido (decisión de David, 2026-11-03; maqueta aprobada).
 *
 * Reutiliza lo que ya existe: el servidor de cotizaciones de telemarketing (`commercial/quotes`, el
 * precio lo calcula él con Kepler; `origin = route_visit`) y el cliente, la sucursal y el catálogo de la
 * toma de pedido. Una cotización NO aparta mercancía ni llega al surtidor. Al final: el documento para
 * el cliente (WhatsApp o PDF) y «Convertir en pedido» (abre la toma de pedido con esos productos).
 */
@Component({
  selector: 'app-vendor-quote',
  standalone: true,
  imports: [CommonModule],
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
          <input type="search" placeholder="Buscar producto o código" [value]="busqueda()" (input)="busqueda.set($any($event.target).value)"
            inputmode="search" enterkeyhint="search" autocapitalize="none" autocorrect="off" spellcheck="false" aria-label="Buscar producto" />
        </div>
        <div class="cq-lh"><b>{{ busqueda().trim() ? visibles().length + ' resultado' + (visibles().length === 1 ? '' : 's') : 'Catálogo · más vendidos' }}</b><span>toca + para cotizar</span></div>
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
        <div class="cq-acts">
          <a class="cq-btn cq-btn-ok" [href]="linkWa()" target="_blank" rel="noopener"><i class="pi pi-whatsapp" aria-hidden="true"></i> Enviar por WhatsApp</a>
          <button type="button" class="cq-btn cq-btn-ghost" (click)="imprimir()"><i class="pi pi-file-pdf" aria-hidden="true"></i> Guardar PDF / imprimir</button>
          <button type="button" class="cq-btn cq-btn-ghost" [disabled]="convirtiendo()" (click)="convertir()">
            @if (convirtiendo()) { <i class="pi pi-spin pi-spinner" aria-hidden="true"></i> } Convertir en pedido
          </button>
          <button type="button" class="cq-btn cq-btn-link" (click)="vista.set('armar')">Seguir cotizando</button>
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
    @media print {
      .cq-top, .cq-acts, .cq-err, .cq-note { display: none !important; }
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
  readonly vista = signal<'armar' | 'doc'>('armar');
  /** El producto cuyo renglón se está guardando (un toque a la vez por producto). */
  readonly ocupado = signal<string | null>(null);
  readonly convirtiendo = signal(false);
  /** Unidad elegida por producto (sin elegir = la del renglón cotizado, o la base). */
  private readonly unidadElegida = signal<Record<string, string>>({});
  readonly hoy = new Intl.DateTimeFormat('es-MX', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date());

  private customerId = '';

  readonly propios = computed<RenglonCotizado[]>(() => (this.cot()?.lines ?? []).filter((l) => l.parent_line_number == null));
  readonly visibles = computed<PriceRow[]>(() => {
    const q = fold(this.busqueda().trim());
    const con = this.prices().filter((p) => p.price != null && Number(p.price) > 0);
    if (!q) {
      // Lo ya cotizado primero, para que se vea y se corrija sin buscarlo.
      const en = new Set(this.propios().map((l) => l.product_id));
      return [...con.filter((p) => en.has(p.product_id)), ...con.filter((p) => !en.has(p.product_id))].slice(0, TOPE);
    }
    return con.filter((p) => fold(`${p.product_name} ${p.sku ?? ''}`).includes(q)).slice(0, TOPE);
  });
  readonly linkWa = computed(() => {
    const c = this.cot();
    if (!c) return '#';
    const cli = this.cliente();
    return linkWhatsApp(mensajeWhatsApp(c, c.recipient_name || cli?.name || 'Cliente', this.sucursal()?.name || 'tu sucursal'), numeroWhatsApp(cli?.whatsapp, cli?.phone));
  });

  ngOnInit(): void {
    this.customerId = this.route.snapshot.paramMap.get('id') ?? '';
    const cotId = this.route.snapshot.queryParamMap.get('cot');
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
            this.router.navigate([], { relativeTo: this.route, queryParams: { cot: c.id }, replaceUrl: true });
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

  /**
   * Convertir en pedido: abre el borrador del cliente (el mismo de «Tomar pedido») y le agrega los
   * productos en la unidad cotizada. ⚠️ El pedido toma los precios DEL DÍA (los de la toma de pedido),
   * no los de la cotización; los regalos los recalcula el pedido. Luego abre «Tomar pedido».
   */
  convertir(): void {
    const s = this.sucursal();
    const c = this.cot();
    if (!s || !c) return;
    const { renglones, sinProducto } = paraPedido(c.lines);
    if (!renglones.length) { this.toast.add({ severity: 'warn', summary: 'La cotización no tiene productos que se puedan pedir.', life: 5000 }); return; }
    this.convirtiendo.set(true);
    this.api.ensureDraftForCustomer(this.customerId, s.id, 'route')
      .pipe(
        switchMap((draft) => from(renglones).pipe(
          concatMap((r) => this.api.addLine(draft.id, r.product_id, r.quantity, r.sello)),
          last(),
        )),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.convirtiendo.set(false);
          if (sinProducto.length) this.toast.add({ severity: 'warn', summary: `No se pasaron al pedido: ${sinProducto.join(', ')}`, life: 7000 });
          this.router.navigate(['/vendor/take-order', this.customerId]);
        },
        error: (e) => { this.convirtiendo.set(false); this.toast.add({ severity: 'error', summary: mensaje(e, 'No se pudo pasar a pedido.'), life: 7000 }); },
      });
  }

  volver(): void {
    if (this.vista() === 'doc') { this.vista.set('armar'); return; }
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
