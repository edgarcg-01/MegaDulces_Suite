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
import { VendorService, VendorOrder } from '../vendor.service';
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

/**
 * Apartado "Carga": pedidos confirmados que el vendedor debe subir al camión
 * para el próximo día hábil (sáb→lun; domingo no hay reparto). Dos vistas:
 *  - Por pedido: cada pedido con sus líneas y check por línea/pedido.
 *  - Productos: total agregado por producto a cargar (suma de todos los pedidos).
 * El vendedor verifica lo cargado con checks; la verificación se guarda local
 * (localStorage por fecha de carga). Banner avisa qué falta.
 */
@Component({
  selector: 'app-vendor-carga',
  standalone: true,
  imports: [CommonModule, SkeletonModule],
  template: `
    <h1 class="page-title">Carga</h1>
    <p class="subtitle" *ngIf="!loading()">Para entregar {{ deliveryLabel }}</p>

    <p-skeleton *ngIf="loading()" height="420px"></p-skeleton>

    <ng-container *ngIf="!loading()">
      <div *ngIf="orders().length === 0" class="empty">
        <i class="pi pi-truck"></i>
        <p>Nada para cargar {{ deliveryLabel }}.</p>
        <span class="hint">Aparecen acá los pedidos confirmados de tu cartera.</span>
      </div>

      <ng-container *ngIf="orders().length > 0">
        <!-- Banner de carga / faltante -->
        <div class="cbanner" [class.done]="allLoaded()">
          <span class="cic"><i class="pi" [ngClass]="allLoaded() ? 'pi-check-circle' : 'pi-box'"></i></span>
          <div class="ct">
            <b *ngIf="!allLoaded()">Cargá {{ orders().length }} {{ orders().length === 1 ? 'pedido' : 'pedidos' }} · {{ totalUnits() }} productos</b>
            <b *ngIf="allLoaded()">Todo cargado · {{ orders().length }} {{ orders().length === 1 ? 'pedido' : 'pedidos' }}</b>
            <span *ngIf="!allLoaded()">Te faltan {{ missingUnits() }} de {{ totalUnits() }} productos</span>
            <span *ngIf="allLoaded()">Listo para salir a entregar {{ deliveryLabel }}</span>
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
          <div class="ocard" *ngFor="let o of orders()" [class.done]="orderDone(o)">
            <button type="button" class="ohead" (click)="toggleOrder(o)" [attr.aria-pressed]="orderDone(o)">
              <span class="check" [class.on]="orderDone(o)"><i class="pi pi-check"></i></span>
              <span class="oinfo">
                <span class="nm">{{ o.customer_name || '—' }}</span>
                <span class="sub">{{ o.folio || o.code }} · {{ orderLoaded(o) }}/{{ o.lines.length }} cargado</span>
              </span>
              <span class="tot">{{ fmtMoney(o.total) }}</span>
            </button>
            <ul class="olines">
              <li *ngFor="let l of o.lines" [class.on]="isChecked(o.id, l.product_id)" (click)="toggleLine(o.id, l.product_id)">
                <span class="check sm" [class.on]="isChecked(o.id, l.product_id)"><i class="pi pi-check"></i></span>
                <span class="qty">{{ num(l.quantity) }}×</span>
                <span class="lname">{{ l.product_name || l.product_id }}</span>
              </li>
            </ul>
          </div>
        </div>

        <!-- PRODUCTOS EN TOTAL -->
        <div *ngIf="view() === 'products'" class="list">
          <button type="button" class="prow" *ngFor="let p of productTotals()" [class.done]="productDone(p)" (click)="toggleProduct(p)" [attr.aria-pressed]="productDone(p)">
            <span class="check" [class.on]="productDone(p)"><i class="pi pi-check"></i></span>
            <span class="pinfo">
              <span class="nm">{{ p.product_name }}</span>
              <span class="sub">{{ p.orders }} {{ p.orders === 1 ? 'pedido' : 'pedidos' }}</span>
            </span>
            <span class="pqty"><b [class.full]="productDone(p)">{{ productLoadedUnits(p) }}</b><span>/{{ p.total }}</span></span>
          </button>
        </div>
      </ng-container>
    </ng-container>
  `,
  styles: [
    `
      :host { display: block; }
      .page-title { margin: 0 0 0.2rem; font-size: 1.5rem; font-weight: 800; letter-spacing: -0.02em; color: var(--text-main); }
      .subtitle { margin: 0 0 1rem; color: var(--text-muted); font-size: 0.875rem; text-transform: capitalize; }
      .empty { text-align: center; padding: 2.5rem 1rem; color: var(--text-muted); }
      .empty i { font-size: 2.5rem; display: block; margin-bottom: 0.5rem; color: var(--text-faint); }
      .empty p { margin: 0 0 0.35rem; }
      .empty .hint { font-size: 0.8rem; }

      /* Banner */
      .cbanner {
        display: flex; align-items: center; gap: 0.75rem; padding: 0.8rem 0.9rem; margin-bottom: 0.9rem;
        border-radius: var(--r-lg, 16px); background: var(--card-bg); border: 1px solid var(--warn-border, var(--border-color));
      }
      .cbanner.done { border-color: var(--ok-border, var(--border-color)); }
      .cbanner .cic { width: 2.4rem; height: 2.4rem; border-radius: 14px; display: grid; place-items: center; flex-shrink: 0; font-size: 1.1rem; background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
      .cbanner.done .cic { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
      .ct { min-width: 0; }
      .ct b { display: block; font-size: 0.9rem; color: var(--text-main); }
      .ct span { font-size: 0.78rem; color: var(--text-muted); }

      /* Segmented toggle */
      .seg { display: flex; gap: 4px; padding: 4px; background: var(--stone-100, #f0ece6); border-radius: var(--r-pill, 999px); margin-bottom: 0.9rem; }
      .seg button {
        flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem;
        border: none; background: none; cursor: pointer; padding: 0.5rem 0.5rem; border-radius: var(--r-pill, 999px);
        font-family: var(--font-body); font-weight: 700; font-size: 0.85rem; color: var(--text-muted);
        transition: color 0.15s ease;
      }
      .seg button i { font-size: 0.8rem; }
      .seg button.on { background: var(--card-bg); color: var(--text-main); box-shadow: 0 1px 3px rgba(16,13,9,0.1); }

      .list { display: flex; flex-direction: column; gap: 0.5rem; }

      /* Check circle (compartido) */
      .check {
        flex-shrink: 0; width: 1.7rem; height: 1.7rem; border-radius: 50%; display: grid; place-items: center;
        border: 2px solid var(--stone-300, #d8d2c8); background: transparent; color: transparent; transition: transform 0.08s var(--ease, ease);
      }
      .check i { font-size: 0.8rem; }
      .check.sm { width: 1.4rem; height: 1.4rem; }
      .check.sm i { font-size: 0.7rem; }
      .check.on { background: var(--ok-fg, #16a34a); border-color: var(--ok-fg, #16a34a); color: #fff; }

      /* Por pedido */
      .ocard { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-lg, 16px); overflow: hidden; box-shadow: 0 1px 2px rgba(16,13,9,0.05); transition: border-color 0.2s ease; }
      .ocard.done { border-color: var(--ok-border, var(--ok-fg)); }
      .ohead { display: flex; align-items: center; gap: 0.75rem; width: 100%; text-align: left; border: none; background: none; cursor: pointer; padding: 0.8rem 0.9rem; transition: transform 0.07s var(--ease, ease); }
      .ohead:active { transform: scale(0.99); }
      .oinfo { flex: 1; min-width: 0; }
      .oinfo .nm { display: block; font-weight: 700; font-size: 0.95rem; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .oinfo .sub { font-size: 0.75rem; color: var(--text-muted); font-family: var(--font-mono); }
      .tot { font-family: var(--font-mono); font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text-main); font-size: 0.9rem; flex-shrink: 0; }
      .olines { list-style: none; margin: 0; padding: 0 0.9rem 0.4rem; }
      .olines li { display: flex; align-items: center; gap: 0.7rem; padding: 0.5rem 0; border-top: 1px solid var(--border-color); cursor: pointer; }
      .olines li .qty { font-family: var(--font-mono); font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text-main); font-size: 0.85rem; min-width: 2.2rem; }
      .olines li .lname { flex: 1; min-width: 0; font-size: 0.85rem; color: var(--text-main); }
      .olines li.on .lname, .olines li.on .qty { color: var(--text-muted); text-decoration: line-through; text-decoration-color: var(--stone-300); }

      /* Productos */
      .prow { display: flex; align-items: center; gap: 0.75rem; width: 100%; text-align: left; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-lg, 16px); padding: 0.8rem 0.9rem; cursor: pointer; box-shadow: 0 1px 2px rgba(16,13,9,0.05); transition: transform 0.07s var(--ease, ease), border-color 0.2s ease; }
      .prow:active { transform: scale(0.99); }
      .prow.done { border-color: var(--ok-border, var(--ok-fg)); }
      .pinfo { flex: 1; min-width: 0; }
      .pinfo .nm { display: block; font-weight: 700; font-size: 0.92rem; color: var(--text-main); line-height: 1.2; }
      .pinfo .sub { font-size: 0.74rem; color: var(--text-muted); }
      .pqty { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 0.95rem; color: var(--text-muted); flex-shrink: 0; }
      .pqty b { color: var(--text-main); font-weight: 700; }
      .pqty b.full { color: var(--ok-fg); }

      @media (prefers-reduced-motion: reduce) {
        .check, .ohead, .prow, .seg button { transition: none; }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorCargaComponent implements OnInit {
  private readonly api = inject(VendorService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly orders = signal<CargaOrder[]>([]);
  readonly view = signal<'orders' | 'products'>('orders');
  readonly checked = signal<Set<string>>(new Set());

  private readonly deliveryDate = this.computeNextBusinessDay();
  private readonly deliveryIso = this.toIso(this.deliveryDate);
  readonly deliveryLabel = this.computeLabel(this.deliveryDate);
  private readonly storeKey = `vendor_carga_${this.deliveryIso}`;

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
  readonly loadedUnits = computed(() => {
    const set = this.checked();
    let n = 0;
    for (const o of this.orders())
      for (const l of o.lines) if (set.has(this.lineKey(o.id, l.product_id))) n += this.num(l.quantity);
    return n;
  });
  readonly missingUnits = computed(() => this.totalUnits() - this.loadedUnits());
  readonly allLoaded = computed(() => this.totalUnits() > 0 && this.missingUnits() === 0);

  ngOnInit(): void {
    this.restore();
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.api
      .cargaOrders()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (all) => {
          const due = all.filter((o) => this.isForDelivery(o));
          if (!due.length) {
            this.orders.set([]);
            this.loading.set(false);
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
                this.orders.set(withLines.filter((o) => o.lines.length > 0));
                this.loading.set(false);
              },
              error: () => this.loading.set(false),
            });
        },
        error: () => this.loading.set(false),
      });
  }

  /** Incluye si la entrega es el próximo día hábil o si no tiene fecha agendada. */
  private isForDelivery(o: VendorOrder): boolean {
    const d = o.requested_delivery_date;
    if (!d) return true;
    return d.slice(0, 10) === this.deliveryIso;
  }

  // ─── checklist (local por fecha) ───
  lineKey(orderId: string, productId: string): string {
    return `${orderId}::${productId}`;
  }
  isChecked(orderId: string, productId: string): boolean {
    return this.checked().has(this.lineKey(orderId, productId));
  }
  toggleLine(orderId: string, productId: string): void {
    const s = new Set(this.checked());
    const k = this.lineKey(orderId, productId);
    s.has(k) ? s.delete(k) : s.add(k);
    this.commit(s);
  }
  toggleOrder(o: CargaOrder): void {
    const s = new Set(this.checked());
    const target = !this.orderDone(o);
    for (const l of o.lines) {
      const k = this.lineKey(o.id, l.product_id);
      target ? s.add(k) : s.delete(k);
    }
    this.commit(s);
  }
  toggleProduct(p: ProductAgg): void {
    const s = new Set(this.checked());
    const target = !this.productDone(p);
    for (const o of this.orders())
      for (const l of o.lines)
        if (l.product_id === p.product_id) {
          const k = this.lineKey(o.id, l.product_id);
          target ? s.add(k) : s.delete(k);
        }
    this.commit(s);
  }
  orderLoaded(o: CargaOrder): number {
    return o.lines.filter((l) => this.isChecked(o.id, l.product_id)).length;
  }
  orderDone(o: CargaOrder): boolean {
    return o.lines.length > 0 && this.orderLoaded(o) === o.lines.length;
  }
  productLoadedUnits(p: ProductAgg): number {
    let n = 0;
    for (const o of this.orders())
      for (const l of o.lines)
        if (l.product_id === p.product_id && this.isChecked(o.id, l.product_id)) n += this.num(l.quantity);
    return n;
  }
  productDone(p: ProductAgg): boolean {
    return p.total > 0 && this.productLoadedUnits(p) === p.total;
  }

  private commit(s: Set<string>): void {
    this.checked.set(s);
    try {
      localStorage.setItem(this.storeKey, JSON.stringify([...s]));
    } catch {
      /* localStorage no disponible: el check vive solo en memoria */
    }
  }
  private restore(): void {
    try {
      const raw = localStorage.getItem(this.storeKey);
      if (raw) this.checked.set(new Set(JSON.parse(raw) as string[]));
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
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(this.num(v));
  }
  num(v: number | string | null | undefined): number {
    return Number(v) || 0;
  }
}
