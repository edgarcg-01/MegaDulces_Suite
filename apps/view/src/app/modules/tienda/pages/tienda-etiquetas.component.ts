import { ChangeDetectionStrategy, Component, ViewEncapsulation, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject, catchError, debounceTime, distinctUntilChanged, of, switchMap } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MultiSelectModule } from 'primeng/multiselect';
import { LabelComponent, LabelModel, LabelSections } from '../components/label.component';
import { EtiquetasService, SearchHit } from '../etiquetas.service';

interface QueueItem { model: LabelModel; copies: number; }

/**
 * Etiquetera (proyecto Tienda). Arma una cola de etiquetas (buscar en catálogo o pegar lista
 * de códigos) e imprime en la térmica a color, tamaño físico 100×40 mm.
 *
 * Impresión: se renderiza la hoja fuera de pantalla (para que auto-ajuste el nombre y dibuje
 * los barcodes), luego se clona a un IFRAME aislado con su propio `@page` de 100×40mm y color
 * forzado. Chrome no respeta `@page` de estilos inyectados por Angular en runtime; el iframe sí.
 */
@Component({
  selector: 'app-tienda-etiquetas',
  standalone: true,
  imports: [CommonModule, FormsModule, MultiSelectModule, LabelComponent],
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
    .etqp-msg{ padding:.6rem .8rem; border-radius:8px; background:#fff4e5; border:1px solid #f0c891; color:#8a4b00; font-size:.85rem; }
    .etqp-grid{ display:grid; grid-template-columns:repeat(auto-fill, 220px); gap:1.4rem 1rem; }
    .etqp-card{ display:flex; flex-direction:column; gap:.4rem; }
    .etqp-scale{ width:200px; height:71px; overflow:hidden; border:1px solid var(--border,#eee); border-radius:6px; }
    .etqp-scale app-label{ display:block; transform:scale(0.46); transform-origin:top left; }
    .etqp-row{ display:flex; align-items:center; gap:.5rem; font-size:.8rem; }
    .etqp-row .nm{ flex:1; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .etqp-step{ display:flex; align-items:center; gap:.3rem; }
    .etqp-step button{ width:24px; height:24px; border:1px solid var(--border,#ddd); background:#fff; border-radius:6px; cursor:pointer; font-weight:700; }
    .etqp-x{ border:0; background:transparent; color:#c00; cursor:pointer; font-size:1rem; }

    /* Hoja fuente: fuera de pantalla PERO con layout (para auto-fit del nombre + barcodes).
       No se imprime desde aquí; se clona a un iframe aislado. */
    .etqp-print{ position:fixed; left:-100000px; top:0; width:115mm; }
  `],
  template: `
    <div class="etqp-screen">
      <div class="etqp-head">
        <h1>Etiquetas de anaquel</h1>
        <p-multiSelect [options]="sectionOptions" [ngModel]="sections()" (ngModelChange)="sections.set($event)"
          optionLabel="label" optionValue="value" [showToggleAll]="true" [filter]="false"
          placeholder="Secciones a mostrar" selectedItemsLabel="{0} secciones" styleClass="etqp-ms"
          [style]="{ minWidth: '15rem' }"></p-multiSelect>
        <button class="etqp-btn" [disabled]="!totalLabels() || printing()" (click)="print()">
          <i class="pi" [class.pi-print]="!printing()" [class.pi-spin]="printing()" [class.pi-spinner]="printing()"></i>
          {{ printing() ? 'Preparando…' : 'Imprimir ' + totalLabels() + ' etiqueta' + (totalLabels() === 1 ? '' : 's') }}
        </button>
      </div>

      @if (msg()) { <div class="etqp-msg">{{ msg() }}</div> }

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
              <div class="etqp-scale"><app-label [model]="it.model" [show]="showMap()"></app-label></div>
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

    <!-- Hoja fuente (fuera de pantalla): se renderiza aquí y se clona al iframe de impresión. -->
    <div class="etqp-print" #printSheet>
      @for (m of printLabels(); track $index) {
        <app-label [model]="m" [show]="showMap()"></app-label>
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
  msg = signal<string>('');
  printLabels = signal<LabelModel[]>([]);
  printing = signal(false);

  totalLabels = computed(() => this.queue().reduce((s, it) => s + (it.copies || 0), 0));

  // Secciones visibles de la etiqueta (multiselect). Default: todas.
  sectionOptions = [
    { label: 'Mayoreo por pieza', value: 'mayoreoPza' },
    { label: 'Paquete', value: 'paquete' },
    { label: 'Mayoreo por paquete', value: 'mayoreoPaq' },
    { label: 'Caja', value: 'caja' },
    { label: 'Código de barras', value: 'barcode' },
  ];
  sections = signal<string[]>(['mayoreoPza', 'paquete', 'mayoreoPaq', 'caja', 'barcode']);
  showMap = computed<LabelSections>(() => {
    const s = this.sections();
    return {
      mayoreoPza: s.includes('mayoreoPza'),
      paquete: s.includes('paquete'),
      mayoreoPaq: s.includes('mayoreoPaq'),
      caja: s.includes('caja'),
      barcode: s.includes('barcode'),
    };
  });

  private search$ = new Subject<string>();

  constructor() {
    this.search$
      .pipe(
        debounceTime(250),
        distinctUntilChanged(),
        switchMap((q) => this.svc.search(q).pipe(catchError((e) => { this.msg.set(this.httpMsg('Búsqueda', e)); return of([] as SearchHit[]); }))),
        takeUntilDestroyed(),
      )
      .subscribe((hits) => this.results.set(hits || []));
  }

  private httpMsg(what: string, e: any): string {
    const s = e?.status;
    if (s === 404) return `${what}: el endpoint /store/labels no existe en el servidor (¿API sin reiniciar/desplegar?).`;
    if (s === 401 || s === 403) return `${what}: sin permiso (STORE_LIVE_VER) o sesión vencida.`;
    return `${what}: error ${s || ''} — ${e?.error?.message || e?.message || 'desconocido'}`;
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
    this.msg.set('');
    const code = h.sku || h.barcode;
    if (!code) { this.msg.set('El producto no tiene SKU ni código de barras.'); return; }
    this.svc.resolve([code]).subscribe({
      next: (r) => {
        this.pushLabels(r.labels);
        if (!r.labels.length) this.msg.set(`No se pudo agregar "${h.name}" (sin datos de etiqueta).`);
      },
      error: (e) => this.msg.set(this.httpMsg('Agregar', e)),
    });
  }

  addBulk(): void {
    const codes = this.bulk().split(/[\s,;]+/).map((c) => c.trim()).filter(Boolean);
    if (!codes.length) return;
    this.loading.set(true);
    this.msg.set('');
    this.svc.resolve(codes).subscribe({
      next: (r) => {
        this.pushLabels(r.labels);
        this.notFound.set(r.not_found || []);
        this.msg.set(`Agregados ${r.labels.length} · no encontrados ${r.not_found?.length || 0}`);
        this.bulk.set('');
        this.loading.set(false);
      },
      error: (e) => { this.msg.set(this.httpMsg('Carga masiva', e)); this.loading.set(false); },
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

  /** Expande la cola a una etiqueta por copia. */
  private expanded(): LabelModel[] {
    const out: LabelModel[] = [];
    for (const it of this.queue()) for (let i = 0; i < it.copies; i++) out.push(it.model);
    return out;
  }

  /** Renderiza la hoja fuera de pantalla, luego imprime en un iframe aislado (100×40 mm). */
  print(): void {
    const all = this.expanded();
    if (!all.length || this.printing()) return;
    this.msg.set('');
    this.printing.set(true);
    this.printLabels.set(all);
    // Espera a que Angular renderice, se auto-ajusten los nombres y se dibujen los barcodes.
    setTimeout(() => this.printIsolated(), 500);
  }

  private printIsolated(): void {
    const sheet = document.querySelector('.etqp-print') as HTMLElement | null;
    if (!sheet || !sheet.innerHTML.trim()) { this.finishPrint(); return; }

    // Clona TODOS los estilos del documento (incluye los estilos del componente etiqueta + fuente Baloo).
    const styles = Array.from(document.querySelectorAll('head style, head link[rel="stylesheet"]'))
      .map((n) => n.outerHTML).join('\n');

    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) { iframe.remove(); this.finishPrint(); return; }

    doc.open();
    doc.write(`<!doctype html><html><head><meta charset="utf-8">${styles}
      <style>
        @page { size:letter; margin:8mm; }
        html,body{ margin:0; padding:0; background:#fff; }
        *{ -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important; }
        /* Etiquetas 115×40mm en columna sobre hoja Carta; se paginan solas y no se parten. */
        app-label{ display:block; break-inside:avoid; page-break-inside:avoid; margin:0 auto 4mm; }
      </style></head><body>${sheet.innerHTML}</body></html>`);
    doc.close();

    let done = false;
    const finish = () => { if (done) return; done = true; iframe.remove(); this.finishPrint(); };
    win.addEventListener('afterprint', finish);
    const fire = () => { try { win.focus(); win.print(); } catch { finish(); } };
    const fonts = (doc as any).fonts;
    if (fonts?.ready) fonts.ready.then(() => setTimeout(fire, 150)).catch(() => setTimeout(fire, 300));
    else setTimeout(fire, 450);
    // Fallback de limpieza si nunca llega afterprint (ej. usuario deja el diálogo abierto).
    setTimeout(finish, 120000);
  }

  private finishPrint(): void {
    this.printing.set(false);
    this.printLabels.set([]);
  }
}
