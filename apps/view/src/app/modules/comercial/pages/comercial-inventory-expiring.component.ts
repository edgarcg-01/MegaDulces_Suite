import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Subscription, forkJoin } from 'rxjs';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { ComercialService, ExpiringLot, Warehouse } from '../comercial.service';
import { Permission } from '../../../core/constants/permissions';
import { MetricCardComponent } from '../../../shared/components/metric-card/metric-card.component';
import { ProductSearchComponent, ProductHit } from '../components/product-search.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import { LOTE_TEXTO, LoteCaducidad, ProductosFlujoService } from '../../compras/productos-flujo.service';
import {
  ESTADO_SEVERIDAD, juicioPorLote, proponeMover, resumenConfianza, tandasDeProductos, textoConfianza, textoMover,
} from './por-vencer-vista';

/**
 * P2.2c — POR VENCER: lotes con caducidad próxima o ya vencida (FEFO), con valor
 * en riesgo al costo. Accionable para rotar primero / retirar lo vencido.
 *
 * `[CE.1.4]` Cada renglón declara si su cantidad puede estar ya vendida (hay existencia SIN fecha
 * del mismo producto en el mismo almacén y la venta la descuenta primero): nunca se dibuja como cierta.
 * `[CE.3.1]` Cada renglón dice QUÉ HACER con el juicio de `juzgarLotes` (el mismo del flujo del
 * producto, pedido en una sola pasada) y, si propone mover, lleva a Pedido con el producto buscado.
 */
@Component({
  selector: 'app-comercial-inventory-expiring',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, ButtonModule, TableModule, TagModule, SelectModule, ToastModule, MetricCardComponent, ProductSearchComponent, SucursalPipe],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
    
    
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Por vencer</h1>
          <p class="surf-page-sub">Lotes con caducidad próxima o vencida — rotar primero (FEFO)</p>
        </div>
        <div class="ex-head-actions">
          <p-select [options]="dayOptions" [(ngModel)]="days" optionLabel="label" optionValue="value"
          (onChange)="load()" styleClass="ex-days"></p-select>
          <p-select [options]="warehouseOptions()" [(ngModel)]="warehouseFilter" optionLabel="label" optionValue="value"
          (onChange)="load()" styleClass="ex-wh"></p-select>
          <app-product-search (productSelected)="prodFilter.set($event)"></app-product-search>
          <button pButton [text]="true" severity="secondary" size="small" (click)="load()" [loading]="loading()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span></button>
        </div>
      </header>
    
      @if (lots().length > 0) {
        <div class="surf-grid ex-bento">
          <app-metric-card class="panel-col-6" [large]="true"
            label="Valor en riesgo (costo)" [value]="totalValue()" format="currency"
            accent="var(--bad-fg)"
            [variant]="risk().buckets.length > 1 ? 'bars' : 'plain'"
            [series]="risk().buckets" [seriesLabels]="risk().labels" [highlightLast]="false"
          [sub]="'al costo · ' + lots().length + (lots().length === 1 ? ' lote' : ' lotes')"></app-metric-card>
          <app-metric-card class="panel-col-3"
            label="Lotes en ventana" [value]="lots().length" format="number"
          accent="var(--chart-2)" [sub]="loteSub()"></app-metric-card>
          <app-metric-card class="panel-col-3" variant="progress"
            label="Ya vencidos" [value]="expiredCount()" [goal]="lots().length" format="number"
          accent="var(--bad-fg)" sub="retirar de inventario"></app-metric-card>
        </div>

        <!-- [CE.1.4] La declaración de la lista: cuántos lotes no se pueden dar por ciertos y por qué. -->
        @if (confianza().vendido + confianza().sinDato > 0) {
          <p class="ex-decl" role="note">
            <i class="pi pi-exclamation-circle" aria-hidden="true"></i>
            <span>
              @if (confianza().vendido > 0) {
                <strong>{{ confianza().vendido }} de {{ confianza().total }} lotes pueden estar ya vendidos:</strong>
                su producto tiene existencia sin fecha en el mismo almacén y la venta descuenta primero lo sin fecha, así que el lote fechado no baja.
              }
              @if (confianza().sinDato > 0) {
                {{ confianza().sinDato }} {{ confianza().sinDato === 1 ? 'lote no se pudo comprobar' : 'lotes no se pudieron comprobar' }}.
              }
              Confirmarlos en el anaquel antes de moverlos o rematarlos;
              {{ confianza().valorIncierto | currency:'MXN':'symbol-narrow':'1.0-0' }} del valor en riesgo no es seguro.
            </span>
          </p>
        }
      }

      <p-table [value]="filteredLots()" [loading]="loading()" styleClass="p-datatable-sm surf-table"
        [scrollable]="true" scrollHeight="flex" [paginator]="true" [rows]="25" [rowsPerPageOptions]="[25, 50, 100, 200]">
        <ng-template #header>
          <tr>
            <th scope="col">Almacén</th><th scope="col">SKU</th><th scope="col">Producto</th><th scope="col">Lote</th><th scope="col">Caduca</th>
            <th scope="col" class="num">Días</th><th scope="col" class="num">Cantidad</th><th scope="col" class="num">Valor en riesgo</th>
            <th scope="col">Qué hacer</th>
          </tr>
        </ng-template>
        <ng-template #body let-it>
          <tr [class.ex-row-expired]="+it.days_to_expiry < 0">
            <td>{{ it.warehouse_code | sucursal }}</td>
            <td class="ex-mono">{{ it.sku || '—' }}</td>
            <td class="ex-name">{{ it.product_name || '—' }}</td>
            <td class="ex-mono">{{ it.lot_code }}</td>
            <td class="ex-mono">{{ it.expiry_date }}</td>
            <td class="num">
              <p-tag [value]="dayLabel(+it.days_to_expiry)" [severity]="daySeverity(+it.days_to_expiry)"></p-tag>
            </td>
            <td class="num">
              {{ it.quantity }}
              @if (it.dated_may_be_stale !== false) { <span class="ex-sub ex-warn">sin confirmar</span> }
            </td>
            <td class="num ex-cap">{{ it.value_at_cost | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
            <td class="ex-que">
              @if (juicioDe(it.id); as j) {
                <p-tag [value]="loteTexto[j.estado]" [severity]="severidad[j.estado]"></p-tag>
                <span class="ex-sub">{{ j.accion }}</span>
                @if (textoMover(j); as mv) { <span class="ex-sub ex-mover">{{ mv }}</span> }
                @if (proponeMover(j) && puedePedido() && it.sku) {
                  <a class="ex-ir" routerLink="/compras/pedido" [queryParams]="{ search: it.sku }">
                    Armar el traspaso en Pedido <i class="pi pi-arrow-right" aria-hidden="true"></i>
                  </a>
                }
              } @else {
                <span class="ex-sub">{{ sinJuicio() }}</span>
              }
              @if (textoConfianza(it); as t) { <span class="ex-sub ex-warn"><i class="pi pi-exclamation-circle" aria-hidden="true"></i> {{ t }}</span> }
            </td>
          </tr>
        </ng-template>
        <ng-template #emptymessage>
          <tr><td colspan="9" class="comm-empty-cell"><div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-calendar-times" aria-hidden="true"></i></div><h3>Sin lotes por vencer</h3><p>No hay lotes por vencer en esta ventana. Captura caducidad al recibir mercancía para verlos aquí.</p></div></td></tr>
        </ng-template>
      </p-table>
    </div>
    `,
  styles: [`
    .ex-head-actions { display: flex; gap: .5rem; align-items: center; }
    :host ::ng-deep .ex-wh { min-width: 220px; }
    :host ::ng-deep .ex-days { min-width: 150px; }
    .ex-bento { margin-bottom: 1rem; }
    .ex-mono { font-family: var(--font-mono,monospace); }
    .ex-name { max-width: 280px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ex-cap { font-weight: 700; }
    .ex-row-expired { background: var(--bad-soft-bg); }
    .ex-decl { display: flex; gap: var(--sp-2); align-items: flex-start; margin: 0 0 var(--sp-3); font-size: var(--fs-sm); color: var(--text-main); }
    .ex-decl .pi { color: var(--warn-fg); margin-top: 2px; }
    .ex-que { min-width: 260px; max-width: 380px; white-space: normal; }
    .ex-que p-tag { display: inline-block; margin-bottom: var(--sp-1); }
    .ex-sub { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
    .ex-mover { color: var(--text-main); }
    .ex-warn { color: var(--warn-fg); }
    .ex-ir { display: inline-flex; gap: var(--sp-1); align-items: center; font-size: var(--fs-xs); margin-top: var(--sp-1); }
    .ex-ir:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
  `],
})
export class ComercialInventoryExpiringComponent {

  readonly dayOptions = [
    { label: 'Próx. 7 días', value: 7 },
    { label: 'Próx. 15 días', value: 15 },
    { label: 'Próx. 30 días', value: 30 },
    { label: 'Próx. 60 días', value: 60 },
    { label: 'Próx. 90 días', value: 90 },
  ];

  private readonly svc = inject(ComercialService);
  private readonly flujo = inject(ProductosFlujoService);
  private readonly permisos = inject(PermissionsService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  // [CE.3.1] El juicio de juzgarLotes, por id de lote. Llega después de la lista (es más caro) y se declara.
  readonly loteTexto = LOTE_TEXTO;
  readonly severidad = ESTADO_SEVERIDAD;
  readonly textoMover = textoMover;
  readonly proponeMover = proponeMover;
  readonly textoConfianza = textoConfianza;
  readonly juicio = signal<Map<string, LoteCaducidad>>(new Map());
  readonly juicioEstado = signal<'cargando' | 'listo' | 'error'>('listo');
  private juicioSub: Subscription | null = null;
  /** Mover se arma en Pedido (Compras decide el traspaso): la liga sólo para quien puede entrar. */
  readonly puedePedido = computed(() => this.permisos.has(Permission.COMPRAS_PEDIDO_VER));
  juicioDe(lotId: string): LoteCaducidad | null { return this.juicio().get(lotId) ?? null; }
  /** Por qué un renglón no trae juicio: se dice, no se deja la celda vacía. */
  readonly sinJuicio = computed(() => {
    switch (this.juicioEstado()) {
      case 'cargando': return 'Calculando si alcanza a venderse…';
      case 'error': return 'No se pudo calcular qué hacer (reintentar con Actualizar)';
      default: return 'Sin juicio: el producto no tiene código de Kepler o su almacén no es una sucursal de Kepler';
    }
  });

  // [CE.1.4] Cuántos lotes no se pueden dar por ciertos.
  readonly confianza = computed(() => resumenConfianza(this.lots()));
  readonly loteSub = computed(() => {
    const c = this.confianza();
    return c.vendido > 0 ? `${c.vendido} pueden estar ya vendidos` : 'con caducidad capturada';
  });

  readonly ALL = '__all__';
  lots = signal<ExpiringLot[]>([]);
  loading = signal(false);
  days = 30;
  warehouseFilter = this.ALL;
  warehouses = signal<{ label: string; value: string }[]>([]);
  warehouseOptions = computed(() => [{ label: 'Todos los almacenes', value: this.ALL }, ...this.warehouses()]);
  isSpecific(): boolean { return this.warehouseFilter !== this.ALL; }
  private whParam(): string | undefined { return this.isSpecific() ? this.warehouseFilter : undefined; }

  /** Filtro de producto (client-side por SKU). */
  prodFilter = signal<ProductHit | null>(null);
  filteredLots = computed(() => {
    const all = this.lots();
    const f = this.prodFilter();
    if (!f) return all;
    return all.filter((r) => (f.sku ? r.sku === f.sku : r.product_name === f.label));
  });

  totalValue = computed(() => this.lots().reduce((s, l) => s + Number(l.value_at_cost || 0), 0));
  expiredCount = computed(() => this.lots().filter((l) => Number(l.days_to_expiry) < 0).length);

  /** Valor en riesgo por urgencia (costo) → barras del hero. */
  readonly risk = computed(() => {
    const buckets = [0, 0, 0, 0, 0]; // vencido · ≤7 · ≤15 · ≤30 · >30
    for (const l of this.lots()) {
      const d = Number(l.days_to_expiry);
      const v = Number(l.value_at_cost || 0);
      if (d < 0) buckets[0] += v;
      else if (d <= 7) buckets[1] += v;
      else if (d <= 15) buckets[2] += v;
      else if (d <= 30) buckets[3] += v;
      else buckets[4] += v;
    }
    return { buckets: buckets.map((n) => Math.round(n)), labels: ['Vencido', '≤7d', '≤15d', '≤30d', '>30d'] };
  });

  constructor() {
    this.svc.listWarehouses()
      .pipe(takeUntilDestroyed(this.destroyRef))
      // Por nombre, jamás por código (PM, 2026-10-22).
      .subscribe({ next: (ws: Warehouse[]) => this.warehouses.set(ws.map((w) => ({ label: w.name, value: w.id }))) });
    this.load();
  }

  load() {
    this.loading.set(true);
    this.svc.listExpiringLots({ days: this.days, warehouse_id: this.whParam() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (rows) => { this.lots.set(rows || []); this.loading.set(false); this.cargarJuicio(rows || []); },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error al cargar lotes por vencer' }); },
      });
  }

  /** `[CE.3.1]` El juicio de los productos listados, en tandas de 200, en UNA vuelta. */
  private cargarJuicio(rows: ExpiringLot[]) {
    this.juicioSub?.unsubscribe();
    const tandas = tandasDeProductos(rows);
    if (!tandas.length) { this.juicio.set(new Map()); this.juicioEstado.set('listo'); return; }
    this.juicioEstado.set('cargando');
    this.juicioSub = forkJoin(tandas.map((ids) => this.flujo.juicioLotes(ids)))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (rs) => { this.juicio.set(juicioPorLote(rs)); this.juicioEstado.set('listo'); },
        error: () => { this.juicio.set(new Map()); this.juicioEstado.set('error'); },
      });
  }

  dayLabel(d: number): string {
    if (d < 0) return `Vencido ${Math.abs(d)}d`;
    if (d === 0) return 'Hoy';
    return `${d} d`;
  }

  daySeverity(d: number): 'danger' | 'warn' | 'secondary' {
    if (d <= 7) return 'danger';
    if (d <= 15) return 'warn';
    return 'secondary';
  }
}
