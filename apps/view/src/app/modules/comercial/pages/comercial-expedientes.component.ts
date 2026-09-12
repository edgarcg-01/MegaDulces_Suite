import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { TooltipModule } from 'primeng/tooltip';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { SalesDocumentsService, ExpedienteGuia, SalesDocsFiltros } from '../sales-documents.service';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { TELEMARKETING_TABS } from '../telemarketing-tabs';

/**
 * GT.12 — Expedientes: el historial de Guías de Cobranza emitidas, por vendedor.
 *
 * No se genera nada acá. La guía se arma en **Facturación TM** (se palomean facturas y se
 * imprime al instante); esta pantalla es el archivo: qué salió a cobrar, de quién, cuándo,
 * por cuánto y quién lo emitió.
 *
 * La reimpresión sale del **snapshot** guardado, no de la cartera de hoy: la copia tiene que
 * decir exactamente lo que decía el papel que se firmó, aunque el cliente ya haya pagado.
 */
@Component({
  selector: 'app-comercial-expedientes',
  standalone: true,
  imports: [
    CommonModule, FormsModule, TableModule, TagModule, ButtonModule, SelectModule,
    InputTextModule, TooltipModule, ToastModule, LoadStateComponent, PageTabsComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
  <div class="surf-page">
    <p-toast position="bottom-right" />

    <div class="surf-page-head">
      <div>
        <h1>Expedientes</h1>
        <p class="surf-page-sub">
          Historial de Guías de Cobranza emitidas · lo que salió a cobrar, por vendedor
        </p>
      </div>
    </div>

    <app-page-tabs [tabs]="tabs" />

    <div class="filtros card-premium card-flat">
      <p-select [(ngModel)]="vendedor" (ngModelChange)="load()" [options]="vendedorOpts()"
                optionLabel="label" optionValue="value" placeholder="Vendedor"
                [showClear]="true" [filter]="true" styleClass="ex-sel" ariaLabel="Vendedor" />
      <div class="f-fecha">
        <input pInputText type="date" [(ngModel)]="desde" (change)="load()" aria-label="Desde" />
        <span class="sep" aria-hidden="true">→</span>
        <input pInputText type="date" [(ngModel)]="hasta" (change)="load()" aria-label="Hasta" />
      </div>
      <span class="sp"></span>
      @if (rows().length) {
        <span class="resumen">
          <b class="mono">{{ rows().length }}</b> guía{{ rows().length === 1 ? '' : 's' }} ·
          <b class="mono">{{ totalPeriodo() | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</b>
        </span>
      }
    </div>

    <div class="card-premium card-flat tabla-wrap">
      <app-load-state
        [loading]="loading()" [error]="error()" [isEmpty]="!loading() && !error() && rows().length === 0"
        emptyIcon="pi-folder-open" emptyTitle="Sin guías emitidas en el periodo"
        emptyHint="Las guías se generan en Facturación TM: palomea facturas y presiona Generar e imprimir."
        (retry)="load()">

        <p-table [value]="rows()" dataKey="id" [scrollable]="true" scrollHeight="calc(100vh - 22rem)"
                 [rowHover]="true" size="small"
                 class="surf-table surf-table--sticky surf-table--frozen-first tabla-exp"
                 [tableStyle]="{ 'min-width': '54rem' }">
          <ng-template #header>
            <tr>
              <th scope="col" style="width:11rem">Expediente</th>
              <th scope="col" style="min-width:15rem">Vendedor</th>
              <th scope="col" style="width:11rem">Responsable</th>
              <th scope="col" style="width:8rem">Emitida</th>
              <th scope="col" style="width:6rem" class="r">Facturas</th>
              <th scope="col" style="width:6rem" class="r">Clientes</th>
              <th scope="col" style="width:9.5rem" class="r">Total</th>
              <th scope="col" style="width:7rem" class="c">Reimprimir</th>
            </tr>
          </ng-template>

          <ng-template #body let-e>
            <tr>
              <td>
                <span class="mono folio">{{ e.folio }}</span>
                <span class="sub">{{ e.created_by_username || '—' }}</span>
              </td>
              <td>
                @if (e.vendedor_nombre) {
                  <span class="nom">{{ e.vendedor_nombre }}</span>
                  <span class="sub mono">{{ e.vendedor_code }}</span>
                } @else {
                  <!-- Se archiva igual y se rotula: el papel existió, aunque el ERP no diga de quién -->
                  <p-tag severity="secondary" value="Sin vendedor en el ERP" styleClass="tg" />
                }
              </td>
              <td>{{ e.responsable || '—' }}</td>
              <td class="mono">{{ e.created_at | date: 'dd/MM/yy HH:mm' }}</td>
              <td class="r mono">{{ e.documentos }}</td>
              <td class="r mono">{{ e.clientes }}</td>
              <td class="r mono strong">{{ e.total | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</td>
              <td class="c">
                <p-button icon="pi pi-print" [text]="true" size="small" ariaLabel="Reimprimir la guía"
                          pTooltip="Reimprime lo que se firmó, no la cartera de hoy"
                          [loading]="busy() === e.id" (onClick)="reimprimir(e)" />
                <p-button icon="pi pi-file-pdf" [text]="true" size="small" ariaLabel="Ver PDF de la guía"
                          (onClick)="verPdf(e)" />
              </td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>
    </div>
  </div>
  `,
  styles: [`
    :host { display: block; min-width: 0; }
    .filtros {
      display: flex; align-items: center; gap: .5rem;
      padding: .5rem .625rem; margin-bottom: .75rem; flex-wrap: wrap;
    }
    .filtros p-select { flex: 0 1 13rem; min-width: 9rem; }
    :host ::ng-deep .ex-sel { width: 100%; font-size: var(--fs-sm); }
    .f-fecha { display: flex; align-items: center; gap: .3rem; }
    .f-fecha input { width: 8.5rem; min-width: 7rem; font-size: var(--fs-sm); }
    .f-fecha .sep { color: var(--text-soft); font-size: var(--fs-sm); }
    .sp { flex: 1 1 auto; min-width: 0; }
    .resumen { font-size: var(--fs-sm); color: var(--text-soft); white-space: nowrap; }
    .resumen b { color: var(--text-main); }

    .tabla-wrap { padding: 0; overflow: hidden; min-width: 0; }
    .tabla-exp th.r, .tabla-exp td.r { text-align: right; }
    .tabla-exp th.c, .tabla-exp td.c { text-align: center; }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-variant-numeric: tabular-nums; }
    .folio { font-weight: 650; display: block; }
    .nom { display: block; font-weight: 600; line-height: 1.25; }
    .sub { display: block; font-size: var(--fs-xs, .75rem); color: var(--text-soft); margin-top: 1px; }
    .strong { font-weight: 700; }
    .tg { margin-left: 0; }

    /* Mismo motivo que en Facturación TM: la regla global de móvil esconde de la 4a columna en
       adelante y pega la ultima a la derecha, lo que aca encimaria Reimprimir sobre Vendedor. */
    @media (max-width: 60rem) {
      :host ::ng-deep .tabla-exp .p-datatable-thead > tr > th,
      :host ::ng-deep .tabla-exp .p-datatable-tbody > tr > td { display: table-cell !important; }
      :host ::ng-deep .tabla-exp .p-datatable-thead > tr > th:last-child,
      :host ::ng-deep .tabla-exp .p-datatable-tbody > tr > td:last-child {
        position: static !important; right: auto !important;
        box-shadow: none !important; min-width: 0 !important;
      }
    }
    @media (max-width: 48rem) {
      :host ::ng-deep .tabla-exp .p-datatable-table-container { max-height: none !important; }
    }
  `],
})
export class ComercialExpedientesComponent {
  private readonly svc = inject(SalesDocumentsService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly tabs = TELEMARKETING_TABS;
  readonly rows = signal<ExpedienteGuia[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly busy = signal<string | null>(null);
  private readonly catalogos = signal<SalesDocsFiltros | null>(null);

  vendedor: string | null = null;
  /** Ventana de trabajo: el mes corriente. El archivo entero se alcanza moviendo la fecha. */
  desde = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  hasta = new Date().toISOString().slice(0, 10);

  readonly vendedorOpts = computed(() =>
    (this.catalogos()?.vendedores || []).map((v) => ({ label: v.vendedor_nombre, value: v.vendedor_code })));
  readonly totalPeriodo = computed(() =>
    this.rows().reduce((a, e) => a + (Number(e.total) || 0), 0));

  private peticion = 0;

  constructor() {
    this.load();
    // El catálogo de vendedores sale de la misma ventana de facturas (ya recortado por alcance).
    this.svc.filtros({ from: this.desde, to: this.hasta }).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (c) => this.catalogos.set(c), error: () => undefined });
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    const mia = ++this.peticion;
    this.svc.expedientes({
      vendedor_code: this.vendedor || undefined, from: this.desde, to: this.hasta,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        if (mia !== this.peticion) return;
        this.rows.set(r);
        this.loading.set(false);
      },
      error: (e) => {
        if (mia !== this.peticion) return;
        this.error.set(e?.error?.message || 'No se pudieron cargar los expedientes.');
        this.loading.set(false);
      },
    });
  }

  reimprimir(e: ExpedienteGuia): void {
    this.conPdf(e, (url) => this.imprimirPdf(url));
  }

  verPdf(e: ExpedienteGuia): void {
    this.conPdf(e, (url) => window.open(url, '_blank'));
  }

  private conPdf(e: ExpedienteGuia, fn: (url: string) => void): void {
    this.busy.set(e.id);
    this.svc.expedienteBlob(e.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (b) => {
        this.busy.set(null);
        const url = URL.createObjectURL(b);
        fn(url);
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      },
      error: () => {
        this.busy.set(null);
        this.toast.add({ severity: 'error', summary: 'No se pudo reimprimir la guía', life: 5000 });
      },
    });
  }

  /**
   * Imprime en una PESTAÑA, no en un iframe oculto: `iframe.contentWindow.print()` sobre el
   * visor de PDF de Chrome manda a la impresora el documento que lo CONTIENE — la pantalla.
   */
  private imprimirPdf(url: string): void {
    const win = window.open(url, '_blank');
    if (!win) {
      this.toast.add({
        severity: 'warn', summary: 'El navegador bloqueó la ventana',
        detail: 'Permite las ventanas emergentes para imprimir directo, o usa "Ver PDF".',
        life: 7000,
      });
      return;
    }
    let lanzado = false;
    const lanzar = () => {
      if (lanzado) return;
      lanzado = true;
      try { win.focus(); win.print(); } catch { /* el visor tiene su propio botón */ }
    };
    try { win.addEventListener('load', lanzar); } catch { /* queda el timer */ }
    setTimeout(lanzar, 1200);
  }
}
