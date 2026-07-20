import { ChangeDetectionStrategy, Component, ElementRef, ViewChild, ViewEncapsulation, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';
import { MultiSelectModule } from 'primeng/multiselect';
import { AutoCompleteModule, AutoCompleteCompleteEvent, AutoCompleteSelectEvent } from 'primeng/autocomplete';
import { InputNumberModule } from 'primeng/inputnumber';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { LabelComponent, LabelModel, LabelSections, HeroKey } from '../components/label.component';
import { EtiquetasService, SearchHit } from '../etiquetas.service';

interface QueueItem { model: LabelModel; copies: number; hero: HeroKey; }
interface SheetLabel { model: LabelModel; hero: HeroKey; }
type Msg = { text: string; kind: 'info' | 'ok' | 'error' | 'warn' };

/**
 * Etiquetera (proyecto Tienda). Arma una cola de etiquetas (buscar en catálogo o pegar lista
 * de códigos) e imprime en la térmica a color, tamaño físico 100×40 mm.
 *
 * Impresión: se renderiza la hoja fuera de pantalla (para que auto-ajuste el nombre y dibuje
 * los barcodes), luego se clona a un IFRAME aislado con su propio `@page` de 100×40mm y color
 * forzado. Chrome no respeta `@page` de estilos inyectados por Angular en runtime; el iframe sí.
 *
 * UI sobre el design system "Mercado" (surface Operations): PrimeNG + tokens, quiet-luxury.
 * `ViewEncapsulation.None` es intencional — el clon de estilos al iframe necesita los estilos
 * globales del `<app-label>`; las clases van con prefijo `.etqp-*` para evitar colisiones.
 */
@Component({
  selector: 'app-tienda-etiquetas',
  standalone: true,
  imports: [CommonModule, FormsModule, MultiSelectModule, AutoCompleteModule, InputNumberModule, ButtonModule, TableModule, SelectModule, LabelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styles: [`
    app-tienda-etiquetas { display: block; }

    .etqp-screen{ padding: var(--sp-5) var(--sp-6); display:flex; flex-direction:column; gap: var(--sp-5);
      color: var(--text-main); }

    /* ── Page head ─────────────────────────────────────────── */
    .etqp-head{ display:flex; align-items:center; gap: var(--sp-4); flex-wrap:wrap; }
    .etqp-title{ margin:0; margin-right:auto; }
    .etqp-title h1{ margin:0; font-size:1.125rem; font-weight:700; letter-spacing:-0.01em; line-height:1.2; }
    .etqp-title p{ margin:.1rem 0 0; font-size: var(--fs-xs,.72rem); color: var(--text-faint); }
    .etqp-head .p-multiselect{ min-width: 15rem; }

    /* ── Mensaje / banner ──────────────────────────────────── */
    .etqp-msg{ display:flex; align-items:center; gap:.6rem; padding:.6rem .75rem; border-radius: var(--r-sm);
      font-size: var(--fs-sm,.85rem); border:1px solid var(--info-soft-bg); background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .etqp-msg.is-ok{ border-color: var(--ok-soft-bg); background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .etqp-msg.is-warn{ border-color: var(--warn-soft-bg); background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .etqp-msg.is-error{ border-color: var(--bad-soft-bg); background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .etqp-msg > span{ flex:1; }
    .etqp-msg-x{ border:0; background:transparent; color:inherit; opacity:.6; cursor:pointer; padding:.15rem; border-radius: var(--r-sm);
      display:inline-flex; transition: opacity .12s ease; }
    .etqp-msg-x:hover{ opacity:1; }

    /* ── Escaneo rápido (pistola): auto-agrega al Enter ────── */
    .etqp-scanbar{ display:flex; align-items:center; gap:.6rem; padding:.5rem .75rem; border:1px solid var(--border-color);
      border-radius: var(--r-md); background: var(--card-bg); transition: border-color .12s ease, box-shadow .12s ease; }
    .etqp-scanbar:focus-within{ border-color: var(--action); box-shadow: 0 0 0 3px var(--action-ring); }
    .etqp-scanbar > i{ color: var(--action); font-size:1.1rem; }
    .etqp-scan-input{ flex:1; min-width:0; border:0; background:transparent; color: var(--text-main);
      font-family: var(--font-mono); font-size: var(--fs-md,.9375rem); padding:.35rem .1rem; }
    .etqp-scan-input:focus{ outline:none; }
    .etqp-scan-hint{ font-size: var(--fs-xs,.72rem); color: var(--text-faint); white-space:nowrap; }
    @media (max-width: 640px){ .etqp-scan-hint{ display:none; } }

    /* ── Entrada (dos formas de agregar, hermanas) ─────────── */
    .etqp-inputs{ display:grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: var(--sp-4); }
    .etqp-card{ border:1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); padding: var(--sp-4); }
    .etqp-card > label{ display:block; font-size: var(--fs-xs,.72rem); font-weight:500; text-transform:uppercase; letter-spacing:.06em;
      color: var(--text-faint); margin-bottom:.5rem; }
    .etqp-ac{ display:block; width:100%; }
    .etqp-hit{ display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:.1rem 0; }
    .etqp-hit .nm{ font-size: var(--fs-sm,.85rem); color: var(--text-main); }
    .etqp-hit .sku{ font-family: var(--font-mono); font-size: var(--fs-xs,.72rem); color: var(--text-faint); }
    .etqp-empty-hit{ padding:.5rem .25rem; color: var(--text-muted); font-size: var(--fs-sm,.85rem); }

    .etqp-ta{ width:100%; min-height:84px; resize:vertical; padding:.55rem .7rem; border:1px solid var(--border-color);
      border-radius: var(--r-sm); background: var(--card-bg); color: var(--text-main);
      font-family: var(--font-mono); font-size: var(--fs-sm,.85rem); transition: border-color .12s ease, box-shadow .12s ease; }
    .etqp-ta:focus{ outline:none; border-color: var(--action); box-shadow: 0 0 0 3px var(--action-ring); }
    .etqp-bulk-actions{ margin-top:.6rem; display:flex; gap:.6rem; align-items:center; flex-wrap:wrap; }
    .etqp-warn{ color: var(--warn-soft-fg); font-size: var(--fs-xs,.72rem); }

    /* ── Workspace: cola (tabla) + preview sticky ──────────── */
    .etqp-work{ display:grid; grid-template-columns: minmax(0,1fr) auto; gap: var(--sp-5); align-items:start; }
    @media (max-width: 900px){ .etqp-work{ grid-template-columns: 1fr; } }

    .etqp-tablewrap{ min-width:0; }
    .etqp-tcap{ display:flex; align-items:center; gap:.6rem; }
    .etqp-tcap .lbl{ font-size: var(--fs-sm,.85rem); font-weight:600; color: var(--text-main); }
    .etqp-tcap .count{ font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-xs,.72rem);
      color: var(--text-faint); margin-right:auto; }
    .etqp-qname{ display:flex; flex-direction:column; gap:.1rem; min-width:0; }
    .etqp-qname .nm{ font-size: var(--fs-sm,.85rem); color: var(--text-main); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .etqp-qname .sku{ font-family: var(--font-mono); font-size: var(--fs-xs,.72rem); color: var(--text-faint); }
    .etqp-num{ font-variant-numeric: tabular-nums; }
    /* Selector de precio grande por ticket (hero dinámico) — p-select. */
    .etqp-hero-sel{ width:100%; max-width: 12rem; }
    td.etqp-cnum, th.etqp-cnum{ text-align:right; white-space:nowrap; }
    td.etqp-cact, th.etqp-cact{ text-align:right; width:2.5rem; }
    .etqp-del{ border:0; background:transparent; color: var(--text-faint); cursor:pointer; width:28px; height:28px;
      border-radius: var(--r-sm); display:inline-flex; align-items:center; justify-content:center;
      transition: color .12s ease, background-color .12s ease; }
    .etqp-del:hover{ color: var(--bad-soft-fg); background: var(--bad-soft-bg); }
    .etqp-del:focus-visible{ outline:2px solid var(--focus-ring, var(--action-ring)); outline-offset:1px; }

    /* Simulación de hoja Carta con líneas de recorte por etiqueta */
    .etqp-sheetpanel{ position:sticky; top: var(--sp-4); display:flex; flex-direction:column; gap:.5rem; }
    .etqp-sheethead{ font-size: var(--fs-xs,.72rem); font-weight:600; text-transform:uppercase; letter-spacing:.06em;
      color: var(--text-faint); font-variant-numeric: tabular-nums; }
    .etqp-cuthint{ font-size: var(--fs-xs,.72rem); color: var(--text-faint); }
    .etqp-sheetbox{ width:500px; max-width:100%; height:387px; overflow:hidden; border:1px solid var(--border-color);
      border-radius: var(--r-sm); background:#fff; }
    .etqp-sheet{ width:279mm; height:216mm; padding:8mm; box-sizing:border-box; background:#fff;
      transform:scale(0.474); transform-origin:top left; text-align:center; font-size:0; }
    .etqp-sheet app-label{ display:inline-block; vertical-align:top; margin:2.5mm; }
    .etqp-sheet app-label .etq-label{ border-radius:0 !important; outline:.3mm dashed #888; }

    /* ── Empty state (Operations) ──────────────────────────── */
    .etqp-empty{ display:flex; flex-direction:column; align-items:center; text-align:center; gap:.4rem;
      padding: var(--sp-8) var(--sp-6); border:1px dashed var(--border-color); border-radius: var(--r-md); color: var(--text-muted); }
    .etqp-empty i{ font-size:1.75rem; color: var(--text-faint); margin-bottom:.25rem; }
    .etqp-empty h2{ margin:0; font-size: var(--fs-md,.9375rem); font-weight:600; color: var(--text-main); }
    .etqp-empty p{ margin:0; font-size: var(--fs-sm,.85rem); max-width:42ch; }

    /* Hoja fuente: fuera de pantalla PERO con layout (para auto-fit del nombre + barcodes).
       No se imprime desde aquí; se clona a un iframe aislado. */
    .etqp-print{ position:fixed; left:-100000px; top:0; width:115mm; }

    @media (prefers-reduced-motion: reduce){
      .etqp-msg-x, .etqp-ta, .etqp-del{ transition:none; }
    }
  `],
  template: `
    <div class="etqp-screen">
      <div class="etqp-head">
        <div class="etqp-title">
          <h1>Etiquetas de anaquel</h1>
          <p>Arma la cola e imprime en hoja Carta · etiqueta 100×40&nbsp;mm</p>
        </div>
        <p-multiSelect [options]="sectionOptions" [ngModel]="sections()" (ngModelChange)="sections.set($event)"
          optionLabel="label" optionValue="value" [showToggleAll]="true" [filter]="false"
          placeholder="Secciones a mostrar" selectedItemsLabel="{0} secciones"
          ariaLabel="Secciones visibles de la etiqueta" [style]="{ minWidth: '15rem' }"></p-multiSelect>
        <p-button [label]="printBtnLabel()" icon="pi pi-print" [loading]="printing()"
          [disabled]="!totalLabels()" (onClick)="print()"></p-button>
      </div>

      @if (msg(); as m) {
        <div class="etqp-msg" role="alert"
             [class.is-ok]="m.kind === 'ok'" [class.is-warn]="m.kind === 'warn'" [class.is-error]="m.kind === 'error'">
          <i class="pi" [ngClass]="msgIcon(m.kind)"></i>
          <span>{{ m.text }}</span>
          <button class="etqp-msg-x" type="button" (click)="msg.set(null)" aria-label="Cerrar aviso"><i class="pi pi-times"></i></button>
        </div>
      }

      <div class="etqp-scanbar">
        <i class="pi pi-qrcode"></i>
        <input #scanInput type="text" inputmode="numeric" autocomplete="off" autofocus
          class="etqp-scan-input" aria-label="Escanear o teclear código de producto"
          placeholder="Escanea con la pistola o teclea el código y Enter…"
          (keyup.enter)="onScan(scanInput.value); scanInput.value=''" />
        <span class="etqp-scan-hint">5 díg = SKU · 8/12/13 = código de barras · se agrega solo</span>
      </div>

      <div class="etqp-inputs">
        <div class="etqp-card">
          <label for="etqp-search">Buscar en catálogo</label>
          <p-autoComplete inputId="etqp-search" styleClass="etqp-ac" [(ngModel)]="acSelected"
            [suggestions]="results()" (completeMethod)="searchAc($event)" (onSelect)="onPick($event)"
            optionLabel="name" [delay]="250" [minLength]="2" [showClear]="true" appendTo="body"
            placeholder="Nombre, SKU o código de barras…">
            <ng-template let-h pTemplate="item">
              <div class="etqp-hit"><span class="nm">{{ h.name }}</span><span class="sku">{{ h.sku }}</span></div>
            </ng-template>
            <ng-template pTemplate="empty"><div class="etqp-empty-hit">Sin coincidencias</div></ng-template>
          </p-autoComplete>
        </div>

        <div class="etqp-card">
          <label for="etqp-bulk">Carga masiva — un código por línea (SKU o código de barras)</label>
          <textarea id="etqp-bulk" class="etqp-ta" [ngModel]="bulk()" (ngModelChange)="bulk.set($event)"
            placeholder="20186&#10;20187&#10;018804701641"></textarea>
          <div class="etqp-bulk-actions">
            <p-button label="Agregar lista" icon="pi pi-plus" [text]="true" [loading]="loading()"
              [disabled]="!bulk().trim()" (onClick)="addBulk()"></p-button>
            @if (notFound().length) { <span class="etqp-warn">No encontrados: {{ notFound().join(', ') }}</span> }
          </div>
        </div>
      </div>

      @if (queue().length) {
        <div class="etqp-work">
          <div class="etqp-tablewrap">
            <p-table [value]="queue()" styleClass="p-datatable-sm" [scrollable]="true" scrollHeight="440px" dataKey="model.product_id">
              <ng-template pTemplate="caption">
                <div class="etqp-tcap">
                  <span class="lbl">Cola</span>
                  <span class="count">{{ queue().length }} producto{{ queue().length === 1 ? '' : 's' }} · {{ totalLabels() }} etiqueta{{ totalLabels() === 1 ? '' : 's' }}</span>
                  <p-button label="Vaciar" icon="pi pi-trash" [text]="true" severity="secondary" size="small" (onClick)="clearQueue()"></p-button>
                </div>
              </ng-template>
              <ng-template pTemplate="header">
                <tr>
                  <th>Producto</th>
                  <th>Precio grande</th>
                  <th class="etqp-cnum">Copias</th>
                  <th class="etqp-cact"></th>
                </tr>
              </ng-template>
              <ng-template pTemplate="body" let-it let-i="rowIndex">
                <tr>
                  <td>
                    <div class="etqp-qname">
                      <span class="nm" [title]="it.model.name">{{ it.model.name }}</span>
                      <span class="sku">{{ it.model.sku }}</span>
                    </div>
                  </td>
                  <td>
                    <p-select [options]="heroOptions(it.model)" [ngModel]="it.hero" (onChange)="setHero(i, $event.value)"
                      optionLabel="label" optionValue="value" appendTo="body" styleClass="etqp-hero-sel"
                      [ariaLabel]="'Precio grande de ' + it.model.name"></p-select>
                  </td>
                  <td class="etqp-cnum">
                    <p-inputNumber styleClass="etqp-num" [ngModel]="it.copies" (ngModelChange)="setCopies(i, $event)"
                      [showButtons]="true" buttonLayout="horizontal" [min]="1" [step]="1" [inputStyle]="{ width: '3rem', textAlign: 'center' }"
                      incrementButtonIcon="pi pi-plus" decrementButtonIcon="pi pi-minus"
                      [ariaLabel]="'Copias de ' + it.model.name"></p-inputNumber>
                  </td>
                  <td class="etqp-cact">
                    <button class="etqp-del" type="button" (click)="remove(i)" [attr.aria-label]="'Quitar ' + it.model.name">
                      <i class="pi pi-times"></i>
                    </button>
                  </td>
                </tr>
              </ng-template>
            </p-table>
          </div>

          <div class="etqp-sheetpanel">
            <div class="etqp-sheethead">Vista de hoja (Carta) · Hoja 1 de {{ totalSheets() }} · {{ totalLabels() }} etiqueta{{ totalLabels() === 1 ? '' : 's' }}</div>
            <div class="etqp-sheetbox">
              <div class="etqp-sheet">
                @for (m of sheetLabels(); track $index) {
                  <app-label [model]="m.model" [hero]="m.hero" [show]="showMap()"></app-label>
                }
              </div>
            </div>
            <div class="etqp-cuthint">– – – línea de recorte por etiqueta (así saldrá impreso)</div>
          </div>
        </div>
      } @else {
        <div class="etqp-empty">
          <i class="pi pi-tags"></i>
          <h2>Sin etiquetas en la cola</h2>
          <p>Busca un producto en el catálogo o pega una lista de códigos para empezar a armar la hoja.</p>
        </div>
      }
    </div>

    <!-- Hoja fuente (fuera de pantalla): se renderiza aquí y se clona al iframe de impresión. -->
    <div class="etqp-print" #printSheet>
      @for (m of printLabels(); track $index) {
        <app-label [model]="m.model" [hero]="m.hero" [show]="showMap()"></app-label>
      }
    </div>
  `,
})
export class TiendaEtiquetasComponent {
  private readonly svc = inject(EtiquetasService);

  @ViewChild('scanInput') scanInput?: ElementRef<HTMLInputElement>;

  results = signal<SearchHit[]>([]);
  acSelected: SearchHit | string | null = null;
  bulk = signal('');
  queue = signal<QueueItem[]>([]);
  notFound = signal<string[]>([]);
  loading = signal(false);
  msg = signal<Msg | null>(null);
  printLabels = signal<SheetLabel[]>([]);
  printing = signal(false);

  totalLabels = computed(() => this.queue().reduce((s, it) => s + (it.copies || 0), 0));
  printBtnLabel = computed(() => {
    if (this.printing()) return 'Preparando…';
    const n = this.totalLabels();
    return `Imprimir ${n} etiqueta${n === 1 ? '' : 's'}`;
  });

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

  // Carta horizontal (263×200mm útil): 2 columnas × 4 filas ≈ 8 etiquetas por hoja.
  private readonly PER_SHEET = 8;
  totalSheets = computed(() => Math.max(1, Math.ceil(this.totalLabels() / this.PER_SHEET)));
  sheetLabels = computed<SheetLabel[]>(() => {
    const out: SheetLabel[] = [];
    for (const it of this.queue()) {
      for (let i = 0; i < it.copies; i++) { out.push({ model: it.model, hero: it.hero }); if (out.length >= this.PER_SHEET) return out; }
    }
    return out;
  });

  msgIcon(kind: Msg['kind']): string {
    return kind === 'error' ? 'pi-exclamation-triangle'
      : kind === 'warn' ? 'pi-exclamation-circle'
      : kind === 'ok' ? 'pi-check-circle'
      : 'pi-info-circle';
  }

  private httpMsg(what: string, e: any): string {
    const s = e?.status;
    if (s === 404) return `${what}: el endpoint /store/labels no existe en el servidor (¿API sin reiniciar/desplegar?).`;
    if (s === 401 || s === 403) return `${what}: sin permiso (STORE_LIVE_VER) o sesión vencida.`;
    return `${what}: error ${s || ''} — ${e?.error?.message || e?.message || 'desconocido'}`;
  }

  searchAc(e: AutoCompleteCompleteEvent): void {
    this.svc.search(e.query)
      .pipe(catchError((err) => { this.msg.set({ text: this.httpMsg('Búsqueda', err), kind: 'error' }); return of([] as SearchHit[]); }))
      .subscribe((hits) => this.results.set(hits || []));
  }

  onPick(e: AutoCompleteSelectEvent): void {
    const h = e.value as SearchHit;
    this.acSelected = null;
    this.results.set([]);
    this.msg.set(null);
    const code = h.sku || h.barcode;
    if (!code) { this.msg.set({ text: 'El producto no tiene SKU ni código de barras.', kind: 'warn' }); return; }
    this.svc.resolve([code]).subscribe({
      next: (r) => {
        const { added, skipped } = this.pushLabels(r.labels);
        if (!added) {
          this.msg.set({
            text: skipped.length
              ? `"${h.name}" no tiene precio en Kepler → no se puede etiquetar.`
              : `No se pudo agregar "${h.name}" (sin datos de etiqueta).`,
            kind: 'warn',
          });
        }
      },
      error: (err) => this.msg.set({ text: this.httpMsg('Agregar', err), kind: 'error' }),
    });
  }

  /**
   * F-Scan — escáner/pistola: al Enter (terminador del escáner) resuelve el código y lo agrega
   * automáticamente, sin clic. `resolve` acepta SKU (5 díg) o código de barras (8/12/13) indistinto,
   * así que no hace falta ramificar por longitud. Limpia y re-enfoca para el siguiente escaneo.
   */
  onScan(raw: string): void {
    const code = (raw || '').trim();
    if (!code) { this.focusScan(); return; }
    this.msg.set(null);
    this.svc.resolve([code]).subscribe({
      next: (r) => {
        const { added, skipped } = this.pushLabels(r.labels);
        if (added) {
          this.msg.set({ text: `Agregado: ${r.labels.find((l) => this.usable(l))?.name ?? code}`, kind: 'ok' });
        } else if (skipped.length) {
          this.msg.set({ text: `${skipped[0]}: sin precio en Kepler → no se puede etiquetar.`, kind: 'warn' });
        } else {
          this.msg.set({ text: `No encontrado: ${code}`, kind: 'warn' });
        }
        this.focusScan();
      },
      error: (e) => { this.msg.set({ text: this.httpMsg('Escaneo', e), kind: 'error' }); this.focusScan(); },
    });
  }

  private focusScan(): void {
    setTimeout(() => this.scanInput?.nativeElement.focus(), 0);
  }

  addBulk(): void {
    const codes = this.bulk().split(/[\s,;]+/).map((c) => c.trim()).filter(Boolean);
    if (!codes.length) return;
    this.loading.set(true);
    this.msg.set(null);
    this.svc.resolve(codes).subscribe({
      next: (r) => {
        const { added, skipped } = this.pushLabels(r.labels);
        this.notFound.set(r.not_found || []);
        const nf = r.not_found?.length || 0;
        let text = `Agregados ${added}`;
        if (skipped.length) text += ` · sin precio ${skipped.length}`;
        if (nf) text += ` · no encontrados ${nf}`;
        this.msg.set({ text, kind: (skipped.length || nf) ? 'warn' : 'ok' });
        this.bulk.set('');
        this.loading.set(false);
      },
      error: (e) => { this.msg.set({ text: this.httpMsg('Carga masiva', e), kind: 'error' }); this.loading.set(false); },
    });
  }

  /**
   * Agrega a la cola SOLO productos con dato de precio usable. Los que no tienen (ej. SKU-less
   * sin fila en Kepler, como "OJILOCOS…") se omiten y se devuelven en `skipped` para avisar —
   * antes se agregaba una etiqueta vacía ($0, sin código, sin tiers) = "no muestra info".
   */
  private pushLabels(labels: LabelModel[]): { added: number; skipped: string[] } {
    const q = [...this.queue()];
    const skipped: string[] = [];
    let added = 0;
    for (const m of labels) {
      if (!this.usable(m)) { skipped.push(m.name); continue; }
      const existing = q.find((it) => it.model.product_id === m.product_id);
      if (existing) existing.copies += 1;
      else q.push({ model: m, copies: 1, hero: this.defaultHero(m) });
      added++;
    }
    this.queue.set(q);
    return { added, skipped };
  }

  // ── Precio grande dinámico por ticket ──────────────────────────────
  private n(v: number | null | undefined): number { return typeof v === 'number' && isFinite(v) ? v : 0; }

  /** Un producto es "usable" para etiqueta si tiene AL MENOS un precio (pieza/paquete/caja). */
  private usable(m: LabelModel): boolean {
    return this.n(m.piece_price) > 0 || this.n(m.pack_price) > 0 || this.n(m.box_price) > 0;
  }

  /** Hero por default: granel → por kg (se vende por kilo); si no, pieza / primero disponible. */
  private defaultHero(m: LabelModel): HeroKey {
    if (this.granelGrams(m) > 0 && this.n(m.piece_price) > 0) return 'kg';
    if (this.n(m.piece_price) > 0) return 'pieza';
    if (this.n(m.pack_price) > 0) return 'paquete';
    if (this.n(m.box_price) > 0) return 'caja';
    return 'pieza';
  }

  /** Granel: gramos de la porción base (KG=1000, "500"/"250"/…). 0 = no granel. */
  private granelGrams(m: LabelModel): number {
    const ub = (m.unit_base || '').toUpperCase();
    if (ub === 'KG') return 1000;
    return /^\d+$/.test(ub) ? parseInt(ub, 10) : 0;
  }

  /** Opciones de precio grande para el selector del ticket — solo las que tienen precio. */
  heroOptions(m: LabelModel): { value: HeroKey; label: string }[] {
    const opts: { value: HeroKey; label: string }[] = [];
    const fmt = (v: number) => '$' + v.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const g = this.granelGrams(m);
    const piece = this.n(m.piece_price);
    if (piece > 0) {
      if (g > 0 && g < 1000) {
        // Granel de porción < 1 kg → ofrece AMBAS: la porción y el kilo.
        opts.push({ value: 'pieza', label: `${g} g ${fmt(piece)}` });
        opts.push({ value: 'kg', label: `1 kg ${fmt(piece * 1000 / g)}` });
      } else if (g >= 1000) {
        opts.push({ value: 'kg', label: `1 kg ${fmt(piece)}` });
      } else {
        opts.push({ value: 'pieza', label: `Pieza ${fmt(piece)}` });
      }
    }
    if (this.n(m.pack_price) > 0) opts.push({ value: 'paquete', label: `Paquete ${fmt(this.n(m.pack_price))}` });
    if (this.n(m.box_price) > 0) opts.push({ value: 'caja', label: `Caja ${fmt(this.n(m.box_price))}` });
    return opts;
  }

  setHero(i: number, hero: HeroKey): void {
    const q = [...this.queue()];
    q[i] = { ...q[i], hero };
    this.queue.set(q);
  }

  setCopies(i: number, val: number): void {
    const q = [...this.queue()];
    q[i] = { ...q[i], copies: Math.max(1, Math.floor(Number(val) || 1)) };
    this.queue.set(q);
  }
  remove(i: number): void { this.queue.set(this.queue().filter((_, idx) => idx !== i)); }
  clearQueue(): void { this.queue.set([]); this.notFound.set([]); this.msg.set(null); }

  /** Expande la cola a una etiqueta por copia (cargando el hero por ticket). */
  private expanded(): SheetLabel[] {
    const out: SheetLabel[] = [];
    for (const it of this.queue()) for (let i = 0; i < it.copies; i++) out.push({ model: it.model, hero: it.hero });
    return out;
  }

  /** Renderiza la hoja fuera de pantalla, luego imprime en un iframe aislado (100×40 mm). */
  print(): void {
    const all = this.expanded();
    if (!all.length || this.printing()) return;
    this.msg.set(null);
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
        @page { size:letter landscape; margin:8mm; }
        html,body{ margin:0; padding:0; background:#fff; }
        *{ -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important; }
        /* Carta horizontal: 2 etiquetas por fila (aprovecha el ancho); se paginan solas y no se parten. */
        body{ text-align:center; font-size:0; }
        app-label{ display:inline-block; vertical-align:top; break-inside:avoid; page-break-inside:avoid; margin:2.5mm; }
        /* Esquinas rectas + línea de recorte punteada por etiqueta. */
        app-label .etq-label{ border-radius:0 !important; outline:.3mm dashed #888; }
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
