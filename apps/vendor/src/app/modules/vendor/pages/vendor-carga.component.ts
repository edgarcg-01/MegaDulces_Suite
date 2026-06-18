import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { SkeletonModule } from 'primeng/skeleton';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of } from 'rxjs';
import { map, catchError } from 'rxjs/operators';
import { VendorService, VendorOrder, SetCargaLoadStatus } from '../vendor.service';
import { OrderLine } from '../../portal/portal.service';

interface CargaOrder extends VendorOrder {
  lines: OrderLine[];
}
interface ProductAgg {
  product_id: string;
  product_name: string;
  total: number;
  orders: number;
}
/** Decisión de carga por línea. Ausencia en el mapa = 'pending'. */
interface LineStatus {
  state: 'loaded' | 'not_loaded';
  reason?: string;
}

const NOT_LOADED_REASONS: { key: string; label: string }[] = [
  { key: 'sin_stock', label: 'Sin stock' },
  { key: 'danado', label: 'Dañado' },
  { key: 'no_cabe', label: 'No cabe' },
  { key: 'otro', label: 'Otro' },
];

/**
 * Apartado "Carga": pedidos confirmados que el vendedor debe subir al camión
 * para el próximo día hábil. Por cada línea marca **sí cargamos / no cargamos /
 * pendiente** (tri-estado) y, si no se carga, un motivo. El estado vive local
 * (localStorage por fecha, offline-safe) y se **registra en el backend**
 * (commercial.carga_load_items) para que la oficina vea qué no se cargó.
 */
@Component({
  selector: 'app-vendor-carga',
  standalone: true,
  imports: [CommonModule, SkeletonModule],
  template: `
    <div class="page-head">
      <div>
        <h1 class="page-title">Carga</h1>
        <p class="subtitle" *ngIf="!loading()">Para entregar {{ deliveryLabel }}</p>
      </div>
      <button
        type="button"
        class="refresh"
        *ngIf="!loading()"
        [class.spinning]="refreshing()"
        [disabled]="refreshing()"
        (click)="refresh()"
        aria-label="Actualizar carga"
      >
        <i class="pi pi-refresh"></i>
      </button>
    </div>

    <p-skeleton *ngIf="loading()" height="420px"></p-skeleton>

    <ng-container *ngIf="!loading()">
      <div *ngIf="loadError() && orders().length === 0" class="empty">
        <i class="pi pi-cloud"></i>
        <p>No se pudo cargar.</p>
        <span class="hint">Revisá tu conexión e intentá de nuevo.</span>
        <button type="button" class="retry-btn" (click)="load()"><i class="pi pi-refresh"></i> Reintentar</button>
      </div>

      <div *ngIf="!loadError() && orders().length === 0" class="empty">
        <i class="pi pi-truck"></i>
        <p>Nada para cargar {{ deliveryLabel }}.</p>
        <span class="hint">Aparecen acá los pedidos confirmados de tu cartera.</span>
      </div>

      <ng-container *ngIf="orders().length > 0">
        <!-- Banner: resumen de la carga -->
        <div class="cbanner" [class.done]="allResolved()">
          <span class="cic"><i class="pi" [ngClass]="allResolved() ? 'pi-check-circle' : 'pi-box'"></i></span>
          <div class="ct">
            <b *ngIf="!allResolved()">Resolvé la carga · {{ pendingLines() }} {{ pendingLines() === 1 ? 'línea' : 'líneas' }} pendientes</b>
            <b *ngIf="allResolved()">Carga resuelta · {{ orders().length }} {{ orders().length === 1 ? 'pedido' : 'pedidos' }}</b>
            <span>
              <i class="pi pi-check dot ok"></i> {{ loadedUnits() }} cargados
              · <i class="pi pi-times dot no"></i> {{ notLoadedUnits() }} no se cargan
              <ng-container *ngIf="!allResolved()"> · {{ pendingUnits() }} pendientes</ng-container>
            </span>
          </div>
        </div>

        <!-- Toggle de vista -->
        <div class="seg" role="tablist" aria-label="Vista de carga">
          <button type="button" role="tab" [attr.aria-selected]="view() === 'orders'" [class.on]="view() === 'orders'" (click)="view.set('orders')">
            <i class="pi pi-list"></i> Por pedido
          </button>
          <button type="button" role="tab" [attr.aria-selected]="view() === 'products'" [class.on]="view() === 'products'" (click)="view.set('products')">
            <i class="pi pi-box"></i> Productos
          </button>
        </div>

        <!-- POR PEDIDO -->
        <div *ngIf="view() === 'orders'" class="list">
          <div class="ocard" *ngFor="let o of orders()" [class.done]="orderResolved(o)">
            <div class="ohead">
              <span class="oinfo">
                <span class="nm">{{ o.customer_name || '—' }}</span>
                <span class="sub">{{ o.folio || o.code }} · {{ orderLoaded(o) }}✓ / {{ orderNotLoaded(o) }}✗ de {{ o.lines.length }}</span>
              </span>
              <button type="button" class="loadall" (click)="markOrderAllLoaded(o)">
                {{ orderAllLoaded(o) ? 'Quitar todo' : 'Cargar todo' }}
              </button>
            </div>
            <ul class="olines">
              <li *ngFor="let l of o.lines" [class.loaded]="lineState(o.id, l.product_id) === 'loaded'" [class.noload]="lineState(o.id, l.product_id) === 'not_loaded'">
                <div class="lmain">
                  <span class="qty">{{ num(l.quantity) }}×</span>
                  <span class="lname">{{ l.product_name || l.product_id }}</span>
                  <span class="lacts">
                    <button type="button" class="act ok" [class.on]="lineState(o.id, l.product_id) === 'loaded'" (click)="markLine(o, l, 'loaded')" [attr.aria-label]="'Sí cargamos ' + (l.product_name || '')" aria-pressed="false"><i class="pi pi-check"></i></button>
                    <button type="button" class="act no" [class.on]="lineState(o.id, l.product_id) === 'not_loaded'" (click)="markLine(o, l, 'not_loaded')" [attr.aria-label]="'No cargamos ' + (l.product_name || '')"><i class="pi pi-times"></i></button>
                  </span>
                </div>
                <div class="reasons-row" *ngIf="lineState(o.id, l.product_id) === 'not_loaded'">
                  <span class="rlabel">Motivo:</span>
                  <button type="button" *ngFor="let r of notLoadedReasons" class="rchip" [class.on]="lineReason(o.id, l.product_id) === r.key" (click)="setLineReason(o, l, r.key)">{{ r.label }}</button>
                </div>
              </li>
            </ul>
          </div>
        </div>

        <!-- PRODUCTOS EN TOTAL -->
        <div *ngIf="view() === 'products'" class="list">
          <div class="prow" *ngFor="let p of productTotals()" [class.loaded]="productState(p) === 'loaded'" [class.noload]="productState(p) === 'not_loaded'">
            <span class="pinfo">
              <span class="nm">{{ p.product_name }}</span>
              <span class="sub">{{ p.orders }} {{ p.orders === 1 ? 'pedido' : 'pedidos' }} · {{ p.total }} u</span>
            </span>
            <span class="lacts">
              <button type="button" class="act ok" [class.on]="productState(p) === 'loaded'" (click)="markProduct(p, 'loaded')" [attr.aria-label]="'Sí cargamos ' + p.product_name"><i class="pi pi-check"></i></button>
              <button type="button" class="act no" [class.on]="productState(p) === 'not_loaded'" (click)="markProduct(p, 'not_loaded')" [attr.aria-label]="'No cargamos ' + p.product_name"><i class="pi pi-times"></i></button>
            </span>
          </div>
        </div>
      </ng-container>
    </ng-container>
  `,
  styles: [
    `
      :host { display: block; }
      .page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem; }
      .page-title { margin: 0 0 0.2rem; font-size: 1.5rem; font-weight: 800; letter-spacing: -0.02em; color: var(--text-main); }
      .subtitle { margin: 0 0 1rem; color: var(--text-muted); font-size: 0.875rem; text-transform: capitalize; }
      .refresh { flex-shrink: 0; width: 2.1rem; height: 2.1rem; border-radius: 50%; border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-muted); display: grid; place-items: center; cursor: pointer; transition: transform 0.08s var(--ease, ease); }
      .refresh:active { transform: scale(0.92); } .refresh:disabled { opacity: 0.6; }
      .refresh i { font-size: 0.9rem; }
      .refresh.spinning i { animation: carga-spin 0.8s linear infinite; }
      @keyframes carga-spin { to { transform: rotate(360deg); } }
      .empty { text-align: center; padding: 2.5rem 1rem; color: var(--text-muted); }
      .empty i { font-size: 2.5rem; display: block; margin-bottom: 0.5rem; color: var(--text-faint); }
      .empty p { margin: 0 0 0.35rem; }
      .empty .hint { font-size: 0.8rem; }
      .retry-btn { margin-top: 0.9rem; display: inline-flex; align-items: center; gap: 0.4rem; border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-main); border-radius: var(--r-pill, 999px); padding: 0.45rem 0.9rem; font-weight: 700; font-size: 0.82rem; cursor: pointer; }

      /* Banner */
      .cbanner { display: flex; align-items: center; gap: 0.75rem; padding: 0.8rem 0.9rem; margin-bottom: 0.9rem; border-radius: var(--r-lg, 16px); background: var(--card-bg); border: 1px solid var(--warn-border, var(--border-color)); }
      .cbanner.done { border-color: var(--ok-border, var(--border-color)); }
      .cbanner .cic { width: 2.4rem; height: 2.4rem; border-radius: 14px; display: grid; place-items: center; flex-shrink: 0; font-size: 1.1rem; background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
      .cbanner.done .cic { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
      .ct { min-width: 0; }
      .ct b { display: block; font-size: 0.9rem; color: var(--text-main); }
      .ct span { font-size: 0.78rem; color: var(--text-muted); }
      .ct .dot { font-size: 0.7rem; }
      .ct .dot.ok { color: var(--ok-fg, #16a34a); }
      .ct .dot.no { color: var(--bad-fg, #dc2626); }

      /* Segmented toggle */
      .seg { display: flex; gap: 4px; padding: 4px; background: var(--stone-100, #f0ece6); border-radius: var(--r-pill, 999px); margin-bottom: 0.9rem; }
      .seg button { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; border: none; background: none; cursor: pointer; padding: 0.5rem 0.5rem; border-radius: var(--r-pill, 999px); font-family: var(--font-body); font-weight: 700; font-size: 0.85rem; color: var(--text-muted); transition: color 0.15s ease; }
      .seg button i { font-size: 0.8rem; }
      .seg button.on { background: var(--card-bg); color: var(--text-main); box-shadow: 0 1px 3px rgba(16,13,9,0.1); }

      .list { display: flex; flex-direction: column; gap: 0.5rem; }

      /* Por pedido */
      .ocard { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-lg, 16px); overflow: hidden; box-shadow: 0 1px 2px rgba(16,13,9,0.05); transition: border-color 0.2s ease; }
      .ocard.done { border-color: var(--ok-border, var(--ok-fg)); }
      .ohead { display: flex; align-items: center; gap: 0.75rem; padding: 0.8rem 0.9rem; }
      .oinfo { flex: 1; min-width: 0; }
      .oinfo .nm { display: block; font-weight: 700; font-size: 0.95rem; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .oinfo .sub { font-size: 0.75rem; color: var(--text-muted); font-family: var(--font-mono); }
      .loadall { flex-shrink: 0; border: 1px solid var(--border-color); background: var(--surface-ground, transparent); color: var(--text-main); border-radius: var(--r-pill, 999px); padding: 0.4rem 0.8rem; font-weight: 700; font-size: 0.78rem; cursor: pointer; }
      .loadall:active { transform: scale(0.96); }
      .olines { list-style: none; margin: 0; padding: 0 0.9rem 0.5rem; }
      .olines li { border-top: 1px solid var(--border-color); padding: 0.5rem 0; }
      .lmain { display: flex; align-items: center; gap: 0.7rem; }
      .olines li .qty { font-family: var(--font-mono); font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text-main); font-size: 0.85rem; min-width: 2.2rem; }
      .olines li .lname { flex: 1; min-width: 0; font-size: 0.85rem; color: var(--text-main); }
      .olines li.loaded .lname, .olines li.loaded .qty { color: var(--text-muted); text-decoration: line-through; text-decoration-color: var(--stone-300); }
      .olines li.noload .lname { color: var(--bad-fg, #dc2626); }

      /* Acciones tri-estado (✓ / ✗) */
      .lacts { display: inline-flex; gap: 0.4rem; flex-shrink: 0; }
      .act { width: 1.9rem; height: 1.9rem; border-radius: 50%; display: grid; place-items: center; border: 2px solid var(--stone-300, #d8d2c8); background: transparent; color: var(--text-faint); cursor: pointer; transition: transform 0.08s var(--ease, ease); }
      .act i { font-size: 0.8rem; }
      .act:active { transform: scale(0.9); }
      .act.ok.on { background: var(--ok-fg, #16a34a); border-color: var(--ok-fg, #16a34a); color: #fff; }
      .act.no.on { background: var(--bad-fg, #dc2626); border-color: var(--bad-fg, #dc2626); color: #fff; }

      /* Motivo (chips) */
      .reasons-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; padding: 0.5rem 0 0.1rem 2.9rem; }
      .reasons-row .rlabel { font-size: 0.72rem; color: var(--text-muted); margin-right: 0.1rem; }
      .rchip { border: 1px solid var(--border-color); background: var(--surface-ground, transparent); color: var(--text-muted); border-radius: var(--r-pill, 999px); padding: 0.28rem 0.65rem; font-size: 0.76rem; font-weight: 600; cursor: pointer; }
      .rchip.on { border-color: var(--bad-fg, #dc2626); background: var(--bad-soft-bg, #fde8e8); color: var(--bad-fg, #dc2626); }

      /* Productos */
      .prow { display: flex; align-items: center; gap: 0.75rem; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-lg, 16px); padding: 0.8rem 0.9rem; box-shadow: 0 1px 2px rgba(16,13,9,0.05); transition: border-color 0.2s ease; }
      .prow.loaded { border-color: var(--ok-border, var(--ok-fg)); }
      .prow.noload { border-color: var(--bad-border, var(--bad-fg)); }
      .pinfo { flex: 1; min-width: 0; }
      .pinfo .nm { display: block; font-weight: 700; font-size: 0.92rem; color: var(--text-main); line-height: 1.2; }
      .prow.loaded .pinfo .nm { text-decoration: line-through; text-decoration-color: var(--stone-300); color: var(--text-muted); }
      .prow.noload .pinfo .nm { color: var(--bad-fg, #dc2626); }
      .pinfo .sub { font-size: 0.74rem; color: var(--text-muted); font-family: var(--font-mono); }

      @media (prefers-reduced-motion: reduce) {
        .act, .seg button, .loadall { transition: none; }
        .refresh.spinning i { animation: none; }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorCargaComponent implements OnInit {
  private readonly api = inject(VendorService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly loadError = signal(false);
  readonly refreshing = signal(false);
  readonly orders = signal<CargaOrder[]>([]);
  readonly view = signal<'orders' | 'products'>('orders');
  /** lineKey → decisión. Ausencia = pendiente. */
  readonly statuses = signal<Map<string, LineStatus>>(new Map());
  readonly notLoadedReasons = NOT_LOADED_REASONS;

  private readonly money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

  private readonly deliveryDate = this.computeNextBusinessDay();
  private readonly deliveryIso = this.toIso(this.deliveryDate);
  readonly deliveryLabel = this.computeLabel(this.deliveryDate);
  private readonly storeKey = `vendor_carga2_${this.deliveryIso}`;

  readonly productTotals = computed<ProductAgg[]>(() => {
    const agg = new Map<string, ProductAgg>();
    for (const o of this.orders()) {
      for (const l of o.lines) {
        const id = l.product_id;
        const cur = agg.get(id) || { product_id: id, product_name: l.product_name || id, total: 0, orders: 0 };
        cur.total += this.num(l.quantity);
        cur.orders += 1;
        agg.set(id, cur);
      }
    }
    return [...agg.values()].sort((a, b) => b.total - a.total);
  });

  readonly totalUnits = computed(() =>
    this.orders().reduce((s, o) => s + o.lines.reduce((ls, l) => ls + this.num(l.quantity), 0), 0),
  );

  /** Suma de unidades por estado (recorre las líneas reales, no el mapa). */
  private readonly unitsByState = computed(() => {
    const map = this.statuses();
    let loaded = 0, notLoaded = 0, pending = 0, pendingLines = 0;
    for (const o of this.orders()) {
      for (const l of o.lines) {
        const st = map.get(this.lineKey(o.id, l.product_id))?.state;
        const q = this.num(l.quantity);
        if (st === 'loaded') loaded += q;
        else if (st === 'not_loaded') notLoaded += q;
        else { pending += q; pendingLines += 1; }
      }
    }
    return { loaded, notLoaded, pending, pendingLines };
  });
  readonly loadedUnits = computed(() => this.unitsByState().loaded);
  readonly notLoadedUnits = computed(() => this.unitsByState().notLoaded);
  readonly pendingUnits = computed(() => this.unitsByState().pending);
  readonly pendingLines = computed(() => this.unitsByState().pendingLines);
  readonly allResolved = computed(() => this.totalUnits() > 0 && this.pendingLines() === 0);

  ngOnInit(): void {
    this.pruneOldChecklists();
    this.restore();
    this.load();
  }

  load(silent = false): void {
    if (silent) this.refreshing.set(true);
    else this.loading.set(true);
    this.loadError.set(false);
    this.api
      .cargaOrders()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (all) => {
          const due = all.filter((o) => this.isForDelivery(o));
          if (!due.length) {
            this.orders.set([]);
            this.loading.set(false);
            this.refreshing.set(false);
            return;
          }
          forkJoin(
            due.map((o) =>
              this.api.orderById(o.id).pipe(
                map((full) => ({ ...o, lines: (full?.lines || []) as OrderLine[] }) as CargaOrder),
                catchError(() => of({ ...o, lines: [] as OrderLine[] } as CargaOrder)),
              ),
            ),
          )
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
              next: (withLines) => {
                const orders = withLines.filter((o) => o.lines.length > 0);
                this.orders.set(orders);
                this.loading.set(false);
                this.refreshing.set(false);
                this.syncStatuses(orders.map((o) => o.id));
              },
              error: () => this.onLoadError(),
            });
        },
        error: () => this.onLoadError(),
      });
  }

  private onLoadError(): void {
    this.loading.set(false);
    this.refreshing.set(false);
    this.loadError.set(true);
  }

  refresh(): void {
    if (this.refreshing()) return;
    this.load(true);
  }

  private isForDelivery(o: VendorOrder): boolean {
    const d = o.requested_delivery_date;
    if (!d) return true;
    return d.slice(0, 10) === this.deliveryIso;
  }

  // ─── tri-estado por línea ───
  lineKey(orderId: string, productId: string): string {
    return `${orderId}::${productId}`;
  }
  lineState(orderId: string, productId: string): 'loaded' | 'not_loaded' | 'pending' {
    return this.statuses().get(this.lineKey(orderId, productId))?.state ?? 'pending';
  }
  lineReason(orderId: string, productId: string): string | null {
    return this.statuses().get(this.lineKey(orderId, productId))?.reason ?? null;
  }

  /** Tap en ✓/✗: si ya estaba en ese estado, vuelve a pendiente (borra). */
  markLine(o: CargaOrder, l: OrderLine, state: 'loaded' | 'not_loaded'): void {
    const key = this.lineKey(o.id, l.product_id);
    const cur = this.statuses().get(key)?.state;
    const next: 'loaded' | 'not_loaded' | 'pending' = cur === state ? 'pending' : state;
    this.applyLocal([{ key, state: next }]);
    this.pushOne(o, l, next, next === 'not_loaded' ? this.lineReason(o.id, l.product_id) : null);
  }

  setLineReason(o: CargaOrder, l: OrderLine, reasonKey: string): void {
    const key = this.lineKey(o.id, l.product_id);
    const cur = this.statuses().get(key);
    if (cur?.state !== 'not_loaded') return;
    const reason = cur.reason === reasonKey ? undefined : reasonKey;
    const m = new Map(this.statuses());
    m.set(key, { state: 'not_loaded', reason });
    this.statuses.set(m);
    this.persist(m);
    this.pushOne(o, l, 'not_loaded', reason ?? null);
  }

  /** "Cargar todo" / "Quitar todo" el pedido (bulk). */
  markOrderAllLoaded(o: CargaOrder): void {
    const target: 'loaded' | 'pending' = this.orderAllLoaded(o) ? 'pending' : 'loaded';
    const changes = o.lines.map((l) => ({ key: this.lineKey(o.id, l.product_id), state: target }));
    this.applyLocal(changes);
    this.pushBulk(
      o.lines.map((l) => this.dto(o, l, target, null)),
    );
  }

  /** Productos view: marca todas las instancias del producto. */
  markProduct(p: ProductAgg, state: 'loaded' | 'not_loaded'): void {
    const target: 'loaded' | 'not_loaded' | 'pending' = this.productState(p) === state ? 'pending' : state;
    const changes: { key: string; state: 'loaded' | 'not_loaded' | 'pending' }[] = [];
    const dtos: SetCargaLoadStatus[] = [];
    for (const o of this.orders()) {
      for (const l of o.lines) {
        if (l.product_id !== p.product_id) continue;
        changes.push({ key: this.lineKey(o.id, l.product_id), state: target });
        dtos.push(this.dto(o, l, target, null));
      }
    }
    this.applyLocal(changes);
    this.pushBulk(dtos);
  }

  // ─── agregados por pedido / producto (para el template) ───
  private readonly orderCounts = computed(() => {
    const map = this.statuses();
    const m = new Map<string, { loaded: number; notLoaded: number }>();
    for (const o of this.orders()) {
      let loaded = 0, notLoaded = 0;
      for (const l of o.lines) {
        const st = map.get(this.lineKey(o.id, l.product_id))?.state;
        if (st === 'loaded') loaded++;
        else if (st === 'not_loaded') notLoaded++;
      }
      m.set(o.id, { loaded, notLoaded });
    }
    return m;
  });
  orderLoaded(o: CargaOrder): number {
    return this.orderCounts().get(o.id)?.loaded ?? 0;
  }
  orderNotLoaded(o: CargaOrder): number {
    return this.orderCounts().get(o.id)?.notLoaded ?? 0;
  }
  orderAllLoaded(o: CargaOrder): boolean {
    return o.lines.length > 0 && this.orderLoaded(o) === o.lines.length;
  }
  orderResolved(o: CargaOrder): boolean {
    const c = this.orderCounts().get(o.id);
    return o.lines.length > 0 && !!c && c.loaded + c.notLoaded === o.lines.length;
  }

  private readonly productStateMap = computed(() => {
    const map = this.statuses();
    const acc = new Map<string, { total: number; loaded: number; notLoaded: number }>();
    for (const o of this.orders()) {
      for (const l of o.lines) {
        const cur = acc.get(l.product_id) || { total: 0, loaded: 0, notLoaded: 0 };
        cur.total++;
        const st = map.get(this.lineKey(o.id, l.product_id))?.state;
        if (st === 'loaded') cur.loaded++;
        else if (st === 'not_loaded') cur.notLoaded++;
        acc.set(l.product_id, cur);
      }
    }
    return acc;
  });
  productState(p: ProductAgg): 'loaded' | 'not_loaded' | 'pending' {
    const c = this.productStateMap().get(p.product_id);
    if (!c || c.total === 0) return 'pending';
    if (c.loaded === c.total) return 'loaded';
    if (c.notLoaded === c.total) return 'not_loaded';
    return 'pending';
  }

  // ─── persistencia (local) + sync (backend) ───
  private applyLocal(changes: { key: string; state: 'loaded' | 'not_loaded' | 'pending' }[]): void {
    const m = new Map(this.statuses());
    for (const c of changes) {
      if (c.state === 'pending') m.delete(c.key);
      else {
        const prev = m.get(c.key);
        m.set(c.key, { state: c.state, reason: c.state === 'not_loaded' ? prev?.reason : undefined });
      }
    }
    this.statuses.set(m);
    this.persist(m);
  }

  private dto(o: CargaOrder, l: OrderLine, state: 'loaded' | 'not_loaded' | 'pending', reason: string | null): SetCargaLoadStatus {
    return {
      order_id: o.id,
      product_id: l.product_id,
      status: state,
      reason,
      quantity: this.num(l.quantity),
      product_name: l.product_name || null,
      delivery_date: this.deliveryIso,
    };
  }
  private pushOne(o: CargaOrder, l: OrderLine, state: 'loaded' | 'not_loaded' | 'pending', reason: string | null): void {
    this.api
      .setCargaLoadStatus(this.dto(o, l, state, reason))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: () => void 0, error: () => void 0 }); // offline: queda en localStorage, catch-up al volver
  }
  private pushBulk(items: SetCargaLoadStatus[]): void {
    if (!items.length) return;
    this.api
      .setCargaLoadStatusBulk(items)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: () => void 0, error: () => void 0 });
  }

  /** Trae el estado del backend (autoritativo) y re-empuja lo que solo está local (offline catch-up). */
  private syncStatuses(orderIds: string[]): void {
    if (!orderIds.length) return;
    this.api
      .cargaLoadStatuses(orderIds)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (rows) => {
          const local = this.statuses();
          const server = new Map<string, LineStatus>();
          for (const r of rows) {
            server.set(this.lineKey(r.order_id, r.product_id), {
              state: r.status,
              reason: r.reason || undefined,
            });
          }
          // merge: server autoritativo + entradas solo-locales (cambios offline)
          const merged = new Map(server);
          const catchUp: SetCargaLoadStatus[] = [];
          for (const [k, v] of local) {
            if (!server.has(k)) {
              merged.set(k, v);
              const [orderId, productId] = k.split('::');
              const o = this.orders().find((x) => x.id === orderId);
              const l = o?.lines.find((x) => x.product_id === productId);
              catchUp.push({
                order_id: orderId,
                product_id: productId,
                status: v.state,
                reason: v.reason ?? null,
                quantity: l ? this.num(l.quantity) : null,
                product_name: l?.product_name || null,
                delivery_date: this.deliveryIso,
              });
            }
          }
          this.statuses.set(merged);
          this.persist(merged);
          if (catchUp.length) this.pushBulk(catchUp);
        },
        error: () => void 0, // offline: nos quedamos con lo local
      });
  }

  private persist(m: Map<string, LineStatus>): void {
    try {
      localStorage.setItem(this.storeKey, JSON.stringify([...m.entries()]));
    } catch {
      /* localStorage no disponible: vive en memoria */
    }
  }
  private restore(): void {
    try {
      const raw = localStorage.getItem(this.storeKey);
      if (raw) this.statuses.set(new Map(JSON.parse(raw) as [string, LineStatus][]));
    } catch {
      /* ignore */
    }
  }
  private pruneOldChecklists(): void {
    try {
      const stale: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith('vendor_carga_') || k.startsWith('vendor_carga2_')) && k !== this.storeKey) stale.push(k);
      }
      stale.forEach((k) => localStorage.removeItem(k));
    } catch {
      /* ignore */
    }
  }

  // ─── fechas: próximo día hábil (domingo no hay reparto → sáb pasa a lun) ───
  private computeNextBusinessDay(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 1);
    if (d.getDay() === 0) d.setDate(d.getDate() + 1);
    return d;
  }
  private toIso(d: Date): string {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }
  private computeLabel(d: Date): string {
    const tomorrow = new Date();
    tomorrow.setHours(0, 0, 0, 0);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const fmt = d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'short' });
    return this.toIso(d) === this.toIso(tomorrow) ? `mañana · ${fmt}` : `el ${fmt}`;
  }

  fmtMoney(v: number | string | null | undefined): string {
    return this.money.format(this.num(v));
  }
  num(v: number | string | null | undefined): number {
    return Number(v) || 0;
  }
}
