import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { CheckboxModule } from 'primeng/checkbox';
import { TooltipModule } from 'primeng/tooltip';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import {
  SalesDocumentsService, SalesDocRow, SalesDocDetail, SalesDocsReport, SalesDocsFiltros,
} from '../sales-documents.service';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { REPORTS_TABS } from '../reports-tabs';

/**
 * AX.2/AX.3 — Documentos de venta al cliente.
 *
 * Surface Operations: tabla densa + side-peek para el detalle (DESIGN.md §7/§14: documento
 * extenso NO va en modal). Los datos vienen de vistas en vivo sobre kepler_ods → lo que se ve
 * aquí tiene la frescura del CDC, sin esperar un feed.
 *
 * Imprimir: el PDF lo arma el backend (AX.4). Se descarga como blob —no se abre la URL— porque
 * el endpoint pide JWT y una pestaña nueva no manda el header; con el blob además se puede
 * mandar a la impresora sin salir de la pantalla.
 */
@Component({
  selector: 'app-comercial-documentos',
  standalone: true,
  imports: [
    CommonModule, FormsModule, TableModule, TagModule, ButtonModule, SelectModule,
    InputTextModule, IconFieldModule, InputIconModule, CheckboxModule, TooltipModule, ToastModule,
    MetricStripComponent, LoadStateComponent, SidePeekComponent, PageTabsComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
  <div class="surf-page">
    <p-toast position="bottom-right" />

    <div class="surf-page-head">
      <div>
        <h1>Documentos de venta</h1>
        <p class="surf-page-sub">
          Facturas de telemarketing y venta a crédito · imprime el detalle desglosado para el cliente
          <span class="live" title="Se leen en vivo del ERP; no dependen de un proceso nocturno.">· en vivo</span>
        </p>
      </div>
    </div>

    <app-page-tabs [tabs]="tabs" />

    <!-- KPIs de LA MISMA selección que la tabla -->
    @if (report(); as r) {
      <app-metric-strip [items]="kpis(r)" />
    }

    <!-- Filtros -->
    <div class="filtros card-premium card-flat">
      <p-iconfield class="f-search">
        <p-inputicon styleClass="pi pi-search" />
        <input pInputText type="text" [(ngModel)]="search" (keyup.enter)="load()" (blur)="queue()"
               placeholder="Cliente, RFC, folio o monto" aria-label="Buscar documentos" />
      </p-iconfield>

      <p-select [(ngModel)]="docTipo" (onChange)="load()" [options]="tipoOpts" optionLabel="label"
                optionValue="value" placeholder="Tipo" [showClear]="true" ariaLabel="Tipo de documento" />

      <p-select [(ngModel)]="vendedor" (onChange)="load()" [options]="vendedorOpts()" optionLabel="label"
                optionValue="value" placeholder="Vendedor" [showClear]="true" [filter]="true" ariaLabel="Vendedor" />

      <div class="f-fecha">
        <input pInputText type="date" [(ngModel)]="desde" (change)="load()" aria-label="Desde" />
        <span class="sep">→</span>
        <input pInputText type="date" [(ngModel)]="hasta" (change)="load()" aria-label="Hasta" />
      </div>

      <label class="f-check">
        <p-checkbox [(ngModel)]="soloVencidas" [binary]="true" (onChange)="load()" inputId="venc" />
        <span>Solo vencidas</span>
      </label>
    </div>

    <!-- Tabla -->
    <div class="card-premium card-flat tabla-wrap">
      <app-load-state
        [loading]="loading()" [error]="error()" [isEmpty]="!loading() && !error() && rows().length === 0"
        emptyIcon="pi-file" emptyTitle="Sin documentos en el periodo"
        emptyHint="Ajusta el rango de fechas o quita filtros para ver facturas."
        (retry)="load()">

        <p-table [value]="rows()" dataKey="folio_digital" [scrollable]="true" scrollHeight="calc(100vh - 25rem)"
                 [rowHover]="true" styleClass="p-datatable-sm tabla-docs"
                 [selection]="sel()" selectionMode="single" (selectionChange)="abrir($event)">
          <ng-template #header>
            <tr>
              <th style="width:9.5rem">Folio</th>
              <th>Cliente</th>
              <th style="width:6.5rem">Fecha</th>
              <th style="width:8.5rem">Vence</th>
              <th style="width:9rem" class="r">Total</th>
              <th style="width:7rem" class="r">Descuento</th>
              <th style="width:6.5rem" class="c">Anexo</th>
            </tr>
          </ng-template>

          <ng-template #body let-d>
            <tr [pSelectableRow]="d">
              <td>
                <span class="mono folio">{{ d.sucursal }} {{ d.doc_prefix }}-{{ d.folio }}</span>
                <span class="sub">{{ d.doc_label }}</span>
              </td>
              <td>
                <span class="nom">{{ d.cliente_nombre }}</span>
                <span class="sub mono">{{ d.cliente_code }}@if (d.vendedor_nombre) { · {{ d.vendedor_nombre }} }</span>
              </td>
              <td class="mono">{{ d.fecha | date: 'dd/MM/yy' }}</td>
              <td>
                <span class="mono">{{ d.vencimiento | date: 'dd/MM/yy' }}</span>
                @if (d.vencida) {
                  <p-tag severity="danger" [value]="d.dias_vencida + 'd vencida'" styleClass="tg" />
                } @else if (d.dias_credito) {
                  <span class="sub">{{ d.dias_credito }} días</span>
                }
              </td>
              <td class="r mono strong">{{ d.total | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</td>
              <td class="r mono save">
                @if (+d.descuento > 0) { −{{ d.descuento | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }} }
                @else { <span class="sub">—</span> }
              </td>
              <td class="c acciones">
                <p-button icon="pi pi-print" [text]="true" size="small" ariaLabel="Imprimir anexo"
                          pTooltip="Imprimir" [loading]="busy() === d.folio_digital"
                          (onClick)="imprimir(d, $event)" />
                <p-button icon="pi pi-file-pdf" [text]="true" size="small" ariaLabel="Ver PDF del anexo"
                          (onClick)="verPdf(d, $event)" />
              </td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>
    </div>

    <!-- Detalle: side-peek, no modal (documento extenso) -->
    <app-side-peek [open]="peek()" (openChange)="peek.set($event)"
                   [title]="det()?.cliente_nombre || 'Documento'"
                   [subtitle]="det() ? det()!.sucursal + ' ' + det()!.doc_prefix + '-' + det()!.folio : null">
      @if (detLoading()) {
        <p class="peek-msg">Cargando detalle…</p>
      } @else if (det(); as x) {
        <div class="peek">
          <div class="peek-acc">
            <p-button icon="pi pi-print" label="Imprimir" size="small" (onClick)="imprimirDet(x)" />
            <span class="peek-hint">Incluye la sección de pagaré</span>
          </div>

          <dl class="peek-kv">
            <dt>Fecha</dt><dd class="mono">{{ x.fecha | date: 'dd/MM/yyyy' }}</dd>
            <dt>Vence</dt><dd class="mono">{{ x.vencimiento | date: 'dd/MM/yyyy' }}@if (x.dias_credito) { ({{ x.dias_credito }} días) }</dd>
            <dt>RFC</dt><dd class="mono">{{ x.cliente_rfc || '—' }}</dd>
            @if (x.vendedor_nombre) { <dt>Vendedor</dt><dd>{{ x.vendedor_nombre }}</dd> }
            @if (x.doc_origen) { <dt>Pedido</dt><dd class="mono">{{ x.doc_origen }}</dd> }
          </dl>

          <table class="peek-lin">
            <thead><tr><th>Producto</th><th class="r">Cant.</th><th class="r">Neto</th></tr></thead>
            <tbody>
              @for (l of x.lineas; track l.linea) {
                <tr>
                  <td><span class="nom">{{ l.descripcion }}</span><span class="sub mono">SKU {{ l.sku }}</span></td>
                  <td class="r mono">{{ l.cantidad }} {{ l.unidad }}
                    @if (l.cajas_equivalentes && l.unidad_bulto) { <span class="sub">= {{ l.cajas_equivalentes }} {{ l.unidad_bulto }}</span> }
                  </td>
                  <td class="r mono">{{ l.neto | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</td>
                </tr>
              }
            </tbody>
            <tfoot>
              <tr><td>Total</td><td></td>
                <td class="r mono strong">{{ x.total | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</td></tr>
            </tfoot>
          </table>
        </div>
      }
    </app-side-peek>
  </div>
  `,
  styles: [`
    :host { display: block; }
    .live { color: var(--ok, var(--text-soft)); font-weight: 600; }

    .filtros { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; padding: .625rem .75rem; margin-bottom: .75rem; }
    .filtros .f-search { flex: 1 1 16rem; min-width: 12rem; }
    .filtros .f-search input { width: 100%; }
    .f-fecha { display: flex; align-items: center; gap: .375rem; }
    .f-fecha .sep { color: var(--text-soft); font-size: var(--fs-sm); }
    .f-check { display: flex; align-items: center; gap: .4rem; font-size: var(--fs-sm); color: var(--text-main); cursor: pointer; }

    .tabla-wrap { padding: 0; overflow: hidden; }
    .tabla-docs th.r, .tabla-docs td.r { text-align: right; }
    .tabla-docs th.c, .tabla-docs td.c { text-align: center; }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-variant-numeric: tabular-nums; }
    .folio { font-weight: 650; display: block; }
    .nom { display: block; font-weight: 600; line-height: 1.25; }
    .sub { display: block; font-size: var(--fs-xs, .75rem); color: var(--text-soft); margin-top: 1px; }
    td .sub { display: inline-block; margin-left: .25rem; }
    .strong { font-weight: 700; }
    .save { color: var(--ok, var(--text-main)); }
    .tg { margin-left: .35rem; }
    .acciones { white-space: nowrap; }

    .peek { display: flex; flex-direction: column; gap: .875rem; }
    .peek-msg { color: var(--text-soft); font-size: var(--fs-sm); }
    .peek-acc { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
    .peek-hint { font-size: var(--fs-xs, .75rem); color: var(--text-soft); }
    .peek-kv { display: grid; grid-template-columns: auto 1fr; gap: .25rem .75rem; margin: 0; font-size: var(--fs-sm); }
    .peek-kv dt { color: var(--text-soft); font-weight: 600; }
    .peek-kv dd { margin: 0; text-align: right; font-weight: 600; }
    .peek-lin { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .peek-lin th { text-align: left; font-size: var(--fs-xs, .75rem); text-transform: uppercase;
      letter-spacing: .05em; color: var(--text-soft); font-weight: 700; padding: .35rem .25rem;
      border-bottom: 1px solid var(--border); }
    .peek-lin td { padding: .4rem .25rem; border-bottom: 1px solid var(--border-soft, var(--border)); vertical-align: top; }
    .peek-lin th.r, .peek-lin td.r { text-align: right; }
    .peek-lin tfoot td { border-bottom: 0; border-top: 1px solid var(--border); font-weight: 700; padding-top: .5rem; }
  `],
})
export class ComercialDocumentosComponent {
  private readonly svc = inject(SalesDocumentsService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly report = signal<SalesDocsReport | null>(null);
  readonly rows = computed(() => this.report()?.rows || []);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly busy = signal<string | null>(null);
  readonly sel = signal<SalesDocRow | null>(null);
  readonly peek = signal(false);
  readonly det = signal<SalesDocDetail | null>(null);
  readonly detLoading = signal(false);
  private readonly filtros = signal<SalesDocsFiltros | null>(null);

  search = '';
  docTipo: string | null = null;
  vendedor: string | null = null;
  soloVencidas = false;
  desde = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  hasta = new Date().toISOString().slice(0, 10);

  readonly tabs = REPORTS_TABS;
  readonly tipoOpts = [
    { label: 'Telemarketing', value: 'telemarketing' },
    { label: 'Venta a crédito', value: 'credito' },
  ];
  readonly vendedorOpts = computed(() =>
    (this.filtros()?.vendedores || []).map((v) => ({ label: v.vendedor_nombre, value: v.vendedor_code })));

  private timer?: ReturnType<typeof setTimeout>;

  constructor() { this.load(); }

  kpis(r: SalesDocsReport): MetricStripItem[] {
    const k = r.kpis;
    return [
      { label: 'Documentos', value: k.documentos, format: 'number' },
      { label: 'Clientes', value: k.clientes, format: 'number' },
      { label: 'Importe', value: Number(k.importe), format: 'currency' },
      { label: 'Descuento', value: Number(k.descuento), format: 'currency', tone: 'ok' },
      { label: 'Vencidas', value: k.vencidas, format: 'number', tone: k.vencidas > 0 ? 'bad' : undefined },
    ];
  }

  /** Debounce del texto libre: no dispara una consulta por tecla. */
  queue(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.load(), 300);
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    const q = {
      from: this.desde, to: this.hasta, search: this.search || undefined,
      doc_tipo: this.docTipo || undefined, vendedor_code: this.vendedor || undefined,
      vencidas: this.soloVencidas ? 'true' : undefined,
    };
    this.svc.list(q).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.report.set(r); this.loading.set(false); },
      error: (e) => { this.error.set(e?.error?.message || 'No se pudieron cargar los documentos.'); this.loading.set(false); },
    });
    // los catálogos siguen la misma ventana; si fallan, los filtros quedan vacíos sin romper la tabla
    this.svc.filtros(q).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (f) => this.filtros.set(f), error: () => undefined });
  }

  abrir(row: SalesDocRow | null): void {
    if (!row) return;
    this.sel.set(row);
    this.det.set(null);
    this.detLoading.set(true);
    this.peek.set(true);
    this.svc.detail(row.folio_digital).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.det.set(d); this.detLoading.set(false); },
      error: () => {
        this.detLoading.set(false);
        this.toast.add({ severity: 'error', summary: 'No se pudo abrir el documento', life: 4000 });
      },
    });
  }

  // ── PDF ────────────────────────────────────────────────────────────────
  // El endpoint exige JWT: hay que traer el blob (el interceptor pone el header). Abrir la URL
  // en una pestaña mandaría la petición sin token y devolvería 401.
  private conBlob(folio: string, pagare: boolean, fn: (url: string) => void): void {
    this.busy.set(folio);
    this.svc.anexoBlob(folio, pagare).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (b) => {
        this.busy.set(null);
        const url = URL.createObjectURL(b);
        fn(url);
        // el objeto vive hasta que el visor/iframe terminó de usarlo
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      },
      error: () => {
        this.busy.set(null);
        this.toast.add({ severity: 'error', summary: 'No se pudo generar el anexo', life: 4000 });
      },
    });
  }

  verPdf(d: SalesDocRow, ev?: Event): void {
    ev?.stopPropagation();
    this.conBlob(d.folio_digital, true, (url) => window.open(url, '_blank'));
  }

  imprimir(d: SalesDocRow, ev?: Event): void {
    ev?.stopPropagation();
    this.imprimirFolio(d.folio_digital, true);
  }

  imprimirDet(d: SalesDocDetail): void {
    this.imprimirFolio(d.folio_digital, true);
  }

  /**
   * Imprime en un iframe aislado. Si el visor de PDF del navegador no expone print()
   * (pasa en Safari/iPadOS y algunos WebView), se cae a abrir el PDF en pestaña nueva
   * para que el usuario imprima desde el visor — nunca se queda sin salida.
   */
  private imprimirFolio(folio: string, pagare: boolean): void {
    this.conBlob(folio, pagare, (url) => {
      const ifr = document.createElement('iframe');
      ifr.style.position = 'fixed';
      ifr.style.right = '0';
      ifr.style.bottom = '0';
      ifr.style.width = '0';
      ifr.style.height = '0';
      ifr.style.border = '0';
      ifr.src = url;
      ifr.onload = () => {
        try {
          const w = ifr.contentWindow;
          if (!w) throw new Error('sin contentWindow');
          w.focus();
          w.print();
          setTimeout(() => ifr.remove(), 60_000);
        } catch {
          ifr.remove();
          window.open(url, '_blank');
          this.toast.add({
            severity: 'info', summary: 'Abrí el PDF en otra pestaña',
            detail: 'Este navegador no permite imprimir directo; usa el botón de imprimir del visor.',
            life: 6000,
          });
        }
      };
      document.body.appendChild(ifr);
    });
  }
}
