import { ChangeDetectionStrategy, Component, ViewEncapsulation, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject, debounceTime, distinctUntilChanged, switchMap } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LabelComponent, LabelModel } from '../components/label.component';
import { EtiquetasService, SearchHit } from '../etiquetas.service';

interface QueueItem { model: LabelModel; copies: number; }

/**
 * Etiquetera (proyecto Tienda). Arma una cola de etiquetas (buscar en catálogo o pegar lista
 * de códigos) e imprime en la térmica a color, tamaño físico 100×40 mm.
 */
@Component({
  selector: 'app-tienda-etiquetas',
  standalone: true,
  imports: [CommonModule, FormsModule, LabelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styles: [`
    .etqp-screen{ padding:1rem 1.25rem; display:flex; flex-direction:column; gap:1rem; }
    .etqp-tools{ display:flex; gap:1.5rem; flex-wrap:wrap; align-items:flex-start; }
    .etqp-tool{ flex:1; min-width:280px; }
    .etqp-tool h3{ font-size:.8rem; font-weight:700; margin:0 0 .4rem; color:var(--text-muted,#666); text-transform:uppercase; letter-spacing:.3px; }
    .etqp-search{ position:relative; }
    .etqp-search input, .etqp-bulk textarea{ width:100%; padding:.55rem .7rem; border:1px solid var(--border,#ddd); border-radius:8px; font:inherit; }
    .etqp-bulk textarea{ min-height:84px; resize:vertical; font-family:ui-monospace,monospace; font-size:.85rem; }
    .etqp-results{ position:absolute; z-index:20; left:0; right:0; background:#fff; border:1px solid var(--border,#ddd);
      border-radius:8px; margin-top:4px; max-height:280px; overflow:auto; box-shadow:0 8px 24px rgba(0,0,0,.12); }
    .etqp-hit{ padding:.5rem .7rem; cursor:pointer; display:flex; justify-content:space-between; gap:1rem; }
    .etqp-hit:hover{ background:var(--action,#b45309); color:#fff; }
    .etqp-hit .sku{ font-family:ui-monospace,monospace; font-size:.78rem; opacity:.7; }
    .etqp-btn{ padding:.5rem .9rem; border:0; border-radius:8px; background:var(--action,#b45309); color:#fff; font:inherit; font-weight:700; cursor:pointer; }
    .etqp-btn:disabled{ opacity:.5; cursor:not-allowed; }
    .etqp-btn.ghost{ background:transparent; color:var(--text,#333); border:1px solid var(--border,#ddd); }
    .etqp-head{ display:flex; align-items:baseline; justify-content:space-between; gap:1rem; flex-wrap:wrap; }
    .etqp-head h1{ margin:0; font-size:1.25rem; font-weight:800; }
    .etqp-warn{ color:#b45309; font-size:.82rem; }
    .etqp-empty{ color:var(--text-muted,#888); padding:2rem; text-align:center; border:1px dashed var(--border,#ddd); border-radius:10px; }
    .etqp-grid{ display:grid; grid-template-columns:repeat(auto-fill, 220px); gap:1.4rem 1rem; }
    .etqp-card{ display:flex; flex-direction:column; gap:.4rem; }
    .etqp-scale{ width:200px; height:80px; overflow:hidden; border:1px solid var(--border,#eee); border-radius:6px; }
    .etqp-scale app-label{ display:block; transform:scale(0.5305); transform-origin:top left; }
    .etqp-row{ display:flex; align-items:center; gap:.5rem; font-size:.8rem; }
    .etqp-row .nm{ flex:1; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .etqp-step{ display:flex; align-items:center; gap:.3rem; }
    .etqp-step button{ width:24px; height:24px; border:1px solid var(--border,#ddd); background:#fff; border-radius:6px; cursor:pointer; font-weight:700; }
    .etqp-x{ border:0; background:transparent; color:#c00; cursor:pointer; font-size:1rem; }

    /* Hoja de impresión: solo visible al imprimir, tamaño físico exacto. */
    .etqp-print{ display:none; }
    @media print {
      @page { size:100mm 40mm; margin:0; }
      body { visibility:hidden; }
      .etqp-print, .etqp-print * { visibility:visible; }
      .etqp-print{ display:block; position:absolute; left:0; top:0; }
      .etqp-print app-label{ display:block; break-after:page; page-break-after:always; }
    }
  `],
  template: `
    <div class="etqp-screen">
      <div class="etqp-head">
        <h1>Etiquetas de anaquel</h1>
        <button class="etqp-btn" [disabled]="!totalLabels()" (click)="print()">
          <i class="pi pi-print"></i> Imprimir {{ totalLabels() }} etiqueta{{ totalLabels() === 1 ? '' : 's' }}
        </button>
      </div>

      <div class="etqp-tools">
        <div class="etqp-tool">
          <h3>Buscar en catálogo</h3>
          <div class="etqp-search">
            <input type="text" placeholder="Nombre, SKU o código de barras…" [ngModel]="query()"
                   (ngModelChange)="onQuery($event)" (blur)="closeSoon()">
            @if (results().length) {
              <div class="etqp-results">
                @for (h of results(); track h.product_id) {
                  <div class="etqp-hit" (mousedown)="addFromSearch(h)">
                    <span>{{ h.name }}</span><span class="sku">{{ h.sku }}</span>
                  </div>
                }
              </div>
            }
          </div>
        </div>
        <div class="etqp-tool etqp-bulk">
          <h3>Carga masiva (SKU o código de barras, uno por línea)</h3>
          <textarea [ngModel]="bulk()" (ngModelChange)="bulk.set($event)" placeholder="20186&#10;20187&#10;018804701641"></textarea>
          <div style="margin-top:.5rem; display:flex; gap:.6rem; align-items:center;">
            <button class="etqp-btn ghost" [disabled]="loading()" (click)="addBulk()">Agregar lista</button>
            @if (notFound().length) { <span class="etqp-warn">No encontrados: {{ notFound().join(', ') }}</span> }
          </div>
        </div>
      </div>

      @if (queue().length) {
        <div class="etqp-grid">
          @for (it of queue(); track it.model.product_id; let i = $index) {
            <div class="etqp-card">
              <div class="etqp-scale"><app-label [model]="it.model"></app-label></div>
              <div class="etqp-row">
                <span class="nm" [title]="it.model.name">{{ it.model.name }}</span>
                <button class="etqp-x" (click)="remove(i)" title="Quitar">✕</button>
              </div>
              <div class="etqp-row">
                <span class="sku" style="opacity:.6">{{ it.model.sku }}</span>
                <div class="etqp-step">
                  <button (click)="setCopies(i, it.copies - 1)">−</button>
                  <input type="number" min="1" style="width:44px; text-align:center" [ngModel]="it.copies" (ngModelChange)="setCopies(i, $event)">
                  <button (click)="setCopies(i, it.copies + 1)">+</button>
                </div>
              </div>
            </div>
          }
        </div>
      } @else {
        <div class="etqp-empty">Busca un producto o pega una lista de códigos para armar las etiquetas.</div>
      }
    </div>

    <!-- Hoja de impresión (tamaño físico, 1 etiqueta por página × copias) -->
    <div class="etqp-print">
      @for (it of queue(); track it.model.product_id) {
        @for (c of copiesArray(it.copies); track c) {
          <app-label [model]="it.model"></app-label>
        }
      }
    </div>
  `,
})
export class TiendaEtiquetasComponent {
  private readonly svc = inject(EtiquetasService);

  query = signal('');
  results = signal<SearchHit[]>([]);
  bulk = signal('');
  queue = signal<QueueItem[]>([]);
  notFound = signal<string[]>([]);
  loading = signal(false);

  totalLabels = computed(() => this.queue().reduce((s, it) => s + (it.copies || 0), 0));

  private search$ = new Subject<string>();

  constructor() {
    this.search$
      .pipe(debounceTime(250), distinctUntilChanged(), switchMap((q) => this.svc.search(q)), takeUntilDestroyed())
      .subscribe((hits) => this.results.set(hits || []));
  }

  onQuery(q: string): void {
    this.query.set(q);
    if (q.trim().length >= 2) this.search$.next(q.trim());
    else this.results.set([]);
  }
  closeSoon(): void { setTimeout(() => this.results.set([]), 150); }

  addFromSearch(h: SearchHit): void {
    this.results.set([]);
    this.query.set('');
    const code = h.sku || h.barcode;
    if (!code) return;
    this.svc.resolve([code]).subscribe((r) => this.pushLabels(r.labels));
  }

  addBulk(): void {
    const codes = this.bulk().split(/[\s,;]+/).map((c) => c.trim()).filter(Boolean);
    if (!codes.length) return;
    this.loading.set(true);
    this.svc.resolve(codes).subscribe({
      next: (r) => { this.pushLabels(r.labels); this.notFound.set(r.not_found || []); this.bulk.set(''); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  private pushLabels(labels: LabelModel[]): void {
    const q = [...this.queue()];
    for (const m of labels) {
      const existing = q.find((it) => it.model.product_id === m.product_id);
      if (existing) existing.copies += 1;
      else q.push({ model: m, copies: 1 });
    }
    this.queue.set(q);
  }

  setCopies(i: number, val: number): void {
    const q = [...this.queue()];
    q[i] = { ...q[i], copies: Math.max(1, Math.floor(Number(val) || 1)) };
    this.queue.set(q);
  }
  remove(i: number): void { this.queue.set(this.queue().filter((_, idx) => idx !== i)); }
  copiesArray(n: number): number[] { return Array.from({ length: Math.max(1, n) }, (_, i) => i); }

  print(): void { setTimeout(() => window.print(), 50); }
}
