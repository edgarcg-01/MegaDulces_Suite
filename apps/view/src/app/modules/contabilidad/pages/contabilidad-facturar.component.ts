import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { TooltipModule } from 'primeng/tooltip';
import { ConfirmationService, MessageService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { CONTABILIDAD_TABS } from '../contabilidad-tabs';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { FacturasService, EmittedInvoice, IssuerConfig, InvoiceReconciliation } from '../facturas.service';

interface ConceptoRow { descripcion: string; cantidad: number; valor_unitario: number; }

/**
 * FE — Facturación (emisión/timbrado CFDI 4.0 vía PAC SW/Conectia). Operations.
 * Bandeja de emitidas + alta (factura global mostrador o nominativa) + config del emisor.
 */
@Component({
  selector: 'app-contabilidad-facturar',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule, DialogModule, InputTextModule, ConfirmDialogModule, TooltipModule, PageTabsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService, ConfirmationService],
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <p-confirmDialog></p-confirmDialog>
      <app-page-tabs [tabs]="tabs" />

      <header class="surf-page-head fa-head">
        <div class="surf-page-head-text">
          <h1>Facturación</h1>
          <p class="surf-page-sub">Emisión y timbrado de CFDI 4.0 (factura global de mostrador o nominativa). El PAC sella y timbra ante el SAT.</p>
        </div>
        <div class="fa-head-actions">
          <button pButton type="button" label="Refrescar" icon="pi pi-refresh" class="p-button-sm p-button-text" [loading]="loading()" (click)="reload()"></button>
          <button pButton type="button" label="Pendientes" icon="pi pi-inbox" class="p-button-sm p-button-text" pTooltip="Pedidos entregados sin factura (contingencia)" (click)="openContingencia()"></button>
          @if (canManage) {
            <button pButton type="button" label="Emisor" icon="pi pi-id-card" class="p-button-sm p-button-text" (click)="openIssuer()"></button>
            <button pButton type="button" label="Nueva factura" icon="pi pi-plus" class="p-button-sm" [disabled]="!hasIssuer()" (click)="openEmit()"></button>
            <button pButton type="button" label="Global del día" icon="pi pi-calendar" class="p-button-sm p-button-text" [disabled]="!hasIssuer()" (click)="globalDia()"></button>
          }
        </div>
      </header>

      @if (canManage && !hasIssuer() && !loading()) {
        <div class="fa-banner">
          <i class="pi pi-info-circle"></i>
          <span>Antes de facturar, configura los datos fiscales del <strong>emisor</strong> (RFC, razón social, régimen, CP).</span>
          <button pButton type="button" label="Configurar emisor" icon="pi pi-id-card" class="p-button-sm" (click)="openIssuer()"></button>
        </div>
      }

      <div class="card-premium card-flat">
        <p-table [value]="rows()" styleClass="p-datatable-sm fa-table" [rowHover]="true" [loading]="loading()"
                 [scrollable]="true" scrollHeight="560px" [paginator]="rows().length > 50" [rows]="50">
          <ng-template pTemplate="header">
            <tr>
              <th style="width:8rem">Folio</th>
              <th style="width:9rem">Fecha</th>
              <th>Receptor</th>
              <th class="ta-r" style="width:8rem">Subtotal</th>
              <th class="ta-r" style="width:6rem">IVA</th>
              <th class="ta-r" style="width:8rem">Total</th>
              <th style="width:6rem">Estatus</th>
              <th style="width:6rem"></th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-r>
            <tr>
              <td class="mono">{{ r.serie }}{{ r.folio }}@if (r.tipo_comprobante === 'E') {<span class="fa-nc" pTooltip="Nota de crédito (Egreso)">NC</span>}</td>
              <td class="mono">{{ r.fecha_timbrado || r.fecha | date:'dd/MM/yy HH:mm' }}</td>
              <td><div class="fa-recep">{{ r.receptor_nombre || '—' }}</div><div class="mono fa-sub">{{ r.receptor_rfc }}</div></td>
              <td class="ta-r mono">{{ mzn(r.subtotal) }}</td>
              <td class="ta-r mono">{{ mzn(r.total_trasladados) }}</td>
              <td class="ta-r mono fa-tot">{{ mzn(r.total) }}</td>
              <td><span class="fa-est" [ngClass]="'e-' + estatusClass(r.estatus_sat)">{{ estatusLabel(r.estatus_sat) }}</span></td>
              <td class="ta-r">
                <button pButton type="button" icon="pi pi-download" class="p-button-text p-button-sm" aria-label="Descargar XML" (click)="downloadXml(r)"></button>
                <button pButton type="button" icon="pi pi-file-pdf" class="p-button-text p-button-sm" aria-label="Descargar PDF" (click)="downloadPdf(r)"></button>
                @if (canManage && r.estatus_sat === 'vigente' && r.tipo_comprobante !== 'E') {
                  <button pButton type="button" icon="pi pi-minus-circle" class="p-button-text p-button-sm" aria-label="Nota de crédito" pTooltip="Nota de crédito" (click)="openNc(r)"></button>
                }
                @if (canManage && r.estatus_sat === 'vigente') {
                  <button pButton type="button" icon="pi pi-times" class="p-button-text p-button-sm p-button-danger" aria-label="Cancelar" (click)="openCancel(r)"></button>
                }
                @if (r.estatus_sat === 'en_proceso_cancelacion') {
                  <button pButton type="button" icon="pi pi-sync" class="p-button-text p-button-sm" [loading]="statusChecking()===r.uuid" aria-label="Consultar estatus SAT" pTooltip="Consultar estatus en el SAT" (click)="consultarEstatus(r)"></button>
                }
                @if (r.estatus_sat === 'cancelado' || r.estatus_sat === 'en_proceso_cancelacion') {
                  <button pButton type="button" icon="pi pi-file-o" class="p-button-text p-button-sm" aria-label="Acuse de cancelación" pTooltip="Descargar acuse de cancelación" (click)="downloadAcuse(r)"></button>
                }
              </td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage"><tr><td colspan="8" class="fa-empty">
            @if (loading()) { Cargando… }
            @else if (errored()) { <i class="pi pi-exclamation-triangle"></i> No se pudo cargar. <button pButton type="button" label="Reintentar" class="p-button-sm p-button-text" (click)="reload()"></button> }
            @else { <i class="pi pi-file-edit"></i> Sin facturas emitidas. @if (canManage && hasIssuer()) { Crea una con "Nueva factura". } }
          </td></tr></ng-template>
        </p-table>
      </div>

      <!-- Emitir -->
      <p-dialog [(visible)]="showEmit" [modal]="true" [style]="{ width: '46rem' }" header="Nueva factura" [draggable]="false">
        <div class="fa-form">
          <label class="fa-f"><span>Tipo *</span>
            <div class="fa-seg">
              <button type="button" [class.active]="form.tipo==='global'" (click)="form.tipo='global'">Global (mostrador)</button>
              <button type="button" [class.active]="form.tipo==='nominativa'" (click)="form.tipo='nominativa'">Nominativa</button>
            </div>
          </label>

          @if (form.tipo === 'nominativa') {
            <div class="fa-grid2">
              <label class="fa-f"><span>RFC receptor *</span><input pInputText [(ngModel)]="form.receptor.rfc" maxlength="13" style="text-transform:uppercase" placeholder="XAXX010101000" /></label>
              <label class="fa-f"><span>Razón social * (exacta SAT)</span><input pInputText [(ngModel)]="form.receptor.nombre" placeholder="EMPRESA SA DE CV" /></label>
              <label class="fa-f"><span>Régimen fiscal *</span><input pInputText [(ngModel)]="form.receptor.regimen_fiscal" placeholder="601" maxlength="3" /></label>
              <label class="fa-f"><span>CP domicilio *</span><input pInputText [(ngModel)]="form.receptor.domicilio_cp" placeholder="59300" maxlength="5" /></label>
              <label class="fa-f"><span>Uso CFDI *</span><input pInputText [(ngModel)]="form.receptor.uso_cfdi" placeholder="G03" maxlength="4" /></label>
            </div>
          } @else {
            <p class="fa-note"><i class="pi pi-info-circle"></i> Factura global a <strong>PÚBLICO EN GENERAL</strong> (XAXX010101000). Se agrega el nodo Información Global (periodicidad diaria).</p>
          }

          <div class="fa-concept-head"><span>Conceptos *</span><button pButton type="button" label="Agregar" icon="pi pi-plus" class="p-button-text p-button-sm" (click)="addConcepto()"></button></div>
          <table class="fa-concepts">
            <thead><tr><th>Descripción</th><th style="width:5rem">Cant.</th><th style="width:8rem">P. Unit.</th><th class="ta-r" style="width:7rem">Importe</th><th style="width:2rem"></th></tr></thead>
            <tbody>
              @for (c of conceptos(); track $index) {
                <tr>
                  <td><input pInputText [(ngModel)]="c.descripcion" placeholder="Dulces surtidos" /></td>
                  <td><input pInputText type="number" min="0" step="1" [(ngModel)]="c.cantidad" /></td>
                  <td><input pInputText type="number" min="0" step="0.01" [(ngModel)]="c.valor_unitario" /></td>
                  <td class="ta-r mono">{{ mzn((c.cantidad||0) * (c.valor_unitario||0)) }}</td>
                  <td>@if (conceptos().length > 1) { <button pButton type="button" icon="pi pi-trash" class="p-button-text p-button-sm p-button-danger" aria-label="Quitar" (click)="removeConcepto($index)"></button> }</td>
                </tr>
              }
            </tbody>
          </table>

          <div class="fa-grid3">
            <label class="fa-f"><span>Forma de pago</span>
              <select [(ngModel)]="form.forma_pago"><option value="01">01 Efectivo</option><option value="03">03 Transferencia</option><option value="04">04 Tarjeta crédito</option><option value="28">28 Tarjeta débito</option><option value="99">99 Por definir</option></select>
            </label>
            <label class="fa-f"><span>Método de pago</span>
              <select [(ngModel)]="form.metodo_pago"><option value="PUE">PUE (una exhibición)</option><option value="PPD">PPD (parcialidades)</option></select>
            </label>
            <label class="fa-f"><span>Serie</span><input pInputText [(ngModel)]="form.serie" placeholder="(default emisor)" maxlength="10" style="text-transform:uppercase" /></label>
          </div>

          <div class="fa-totals">
            <span>Subtotal <strong class="mono">{{ mzn(totals().subtotal) }}</strong></span>
            <span>IVA 16% <strong class="mono">{{ mzn(totals().iva) }}</strong></span>
            <span class="fa-grand">Total <strong class="mono">{{ mzn(totals().total) }}</strong></span>
          </div>
        </div>
        <ng-template pTemplate="footer">
          <button pButton type="button" label="Cancelar" class="p-button-text p-button-sm" (click)="showEmit=false"></button>
          <button pButton type="button" label="Emitir y timbrar" icon="pi pi-check" class="p-button-sm" [loading]="emitting()" [disabled]="!emitValid()" (click)="emit()"></button>
        </ng-template>
      </p-dialog>

      <!-- Emisor -->
      <p-dialog [(visible)]="showIssuer" [modal]="true" [style]="{ width: '32rem' }" header="Datos fiscales del emisor" [draggable]="false">
        <div class="fa-form">
          <div class="fa-grid2">
            <label class="fa-f"><span>RFC *</span><input pInputText [(ngModel)]="issuerForm.rfc" maxlength="13" style="text-transform:uppercase" placeholder="LOGL851014AQ5" /></label>
            <label class="fa-f"><span>CP (lugar exp.) *</span><input pInputText [(ngModel)]="issuerForm.cp" maxlength="5" placeholder="59300" /></label>
            <label class="fa-f fa-f-wide"><span>Razón social * (exacta SAT)</span><input pInputText [(ngModel)]="issuerForm.tax_name" placeholder="LUIS FRANCISCO LOPEZ GUTIERREZ" /></label>
            <label class="fa-f"><span>Régimen fiscal *</span><input pInputText [(ngModel)]="issuerForm.regimen_fiscal" maxlength="3" placeholder="612" /></label>
            <label class="fa-f"><span>Serie por defecto</span><input pInputText [(ngModel)]="issuerForm.serie" maxlength="10" placeholder="A" style="text-transform:uppercase" /></label>
          </div>
          <label class="fa-check"><input type="checkbox" [(ngModel)]="issuerForm.is_default" /> <span>Emisor por defecto</span></label>
          <p class="fa-note"><i class="pi pi-info-circle"></i> El CSD (sello) vive en la cuenta del PAC (Conectia/SW); aquí solo van los datos del comprobante. Deben coincidir <strong>exacto</strong> con tu Constancia de Situación Fiscal.</p>
        </div>
        <ng-template pTemplate="footer">
          <button pButton type="button" label="Cancelar" class="p-button-text p-button-sm" (click)="showIssuer=false"></button>
          <button pButton type="button" label="Guardar" icon="pi pi-check" class="p-button-sm" [loading]="savingIssuer()" [disabled]="!issuerValid()" (click)="saveIssuer()"></button>
        </ng-template>
      </p-dialog>

      <!-- FE.10 — Cancelar (motivo SAT + sustitución) -->
      <p-dialog [(visible)]="showCancel" [modal]="true" [style]="{ width: '34rem' }" header="Cancelar factura ante el SAT" [draggable]="false">
        @if (cancelRow(); as r) {
          <div class="fa-form">
            <p class="fa-note fa-note-warn"><i class="pi pi-exclamation-triangle"></i> Vas a cancelar <strong>{{ r.serie }}{{ r.folio }}</strong> ({{ r.receptor_nombre || 'Público general' }}, {{ mzn(r.total) }}). Si el CFDI requiere aceptación del receptor, queda <strong>en proceso</strong> hasta que la acepte (72h).</p>
            <label class="fa-f"><span>Motivo de cancelación *</span>
              <select [(ngModel)]="cancelForm.motivo">
                <option value="02">02 — Comprobante emitido con errores sin relación</option>
                <option value="01">01 — Comprobante emitido con errores con relación</option>
                <option value="03">03 — No se llevó a cabo la operación</option>
                <option value="04">04 — Operación nominativa en factura global</option>
              </select>
            </label>
            @if (cancelForm.motivo === '01') {
              <label class="fa-f"><span>UUID que sustituye * (folioSustitución)</span>
                <input pInputText [(ngModel)]="cancelForm.folioSustitucion" maxlength="36" placeholder="F1234567-89AB-..." style="text-transform:uppercase" />
              </label>
            }
            <label class="fa-f"><span>Nota interna (opcional)</span>
              <input pInputText [(ngModel)]="cancelForm.reason" placeholder="Motivo/observación para auditoría" />
            </label>
          </div>
          <ng-template pTemplate="footer">
            <button pButton type="button" label="Volver" class="p-button-text p-button-sm" (click)="showCancel=false"></button>
            <button pButton type="button" label="Cancelar factura" icon="pi pi-times" class="p-button-sm p-button-danger" [loading]="cancelling()" [disabled]="cancelForm.motivo==='01' && !isUuid(cancelForm.folioSustitucion)" (click)="confirmCancel()"></button>
          </ng-template>
        }
      </p-dialog>

      <!-- FE.12 — Nota de crédito (Egreso) -->
      <p-dialog [(visible)]="showNc" [modal]="true" [style]="{ width: '44rem' }" header="Nota de crédito" [draggable]="false">
        @if (ncRow(); as r) {
          <div class="fa-form">
            <p class="fa-note"><i class="pi pi-info-circle"></i> CFDI de <strong>Egreso</strong> relacionado (01) a <strong>{{ r.serie }}{{ r.folio }}</strong> · {{ r.receptor_nombre || 'Público general' }} ({{ r.receptor_rfc }}). Captura lo que se devuelve/bonifica.</p>
            <div class="fa-concept-head"><span>Conceptos *</span><button pButton type="button" label="Agregar" icon="pi pi-plus" class="p-button-text p-button-sm" (click)="addNcConcepto()"></button></div>
            <table class="fa-concepts">
              <thead><tr><th>Descripción</th><th style="width:5rem">Cant.</th><th style="width:8rem">P. Unit.</th><th class="ta-r" style="width:7rem">Importe</th><th style="width:2rem"></th></tr></thead>
              <tbody>
                @for (c of ncConceptos(); track $index) {
                  <tr>
                    <td><input pInputText [(ngModel)]="c.descripcion" placeholder="Devolución de mercancía" /></td>
                    <td><input pInputText type="number" min="0" step="1" [(ngModel)]="c.cantidad" /></td>
                    <td><input pInputText type="number" min="0" step="0.01" [(ngModel)]="c.valor_unitario" /></td>
                    <td class="ta-r mono">{{ mzn((c.cantidad||0) * (c.valor_unitario||0)) }}</td>
                    <td>@if (ncConceptos().length > 1) { <button pButton type="button" icon="pi pi-trash" class="p-button-text p-button-sm p-button-danger" aria-label="Quitar" (click)="removeNcConcepto($index)"></button> }</td>
                  </tr>
                }
              </tbody>
            </table>
            <div class="fa-totals">
              <span>Subtotal <strong class="mono">{{ mzn(ncTotals().subtotal) }}</strong></span>
              <span>IVA 16% <strong class="mono">{{ mzn(ncTotals().iva) }}</strong></span>
              <span class="fa-grand">Total NC <strong class="mono">{{ mzn(ncTotals().total) }}</strong></span>
            </div>
          </div>
          <ng-template pTemplate="footer">
            <button pButton type="button" label="Volver" class="p-button-text p-button-sm" (click)="showNc=false"></button>
            <button pButton type="button" label="Emitir nota de crédito" icon="pi pi-check" class="p-button-sm" [loading]="ncEmitting()" [disabled]="!ncValid()" (click)="emitNc()"></button>
          </ng-template>
        }
      </p-dialog>

      <!-- FE.13 — Contingencia: pedidos entregados sin CFDI -->
      <p-dialog [(visible)]="showContingencia" [modal]="true" [style]="{ width: '52rem' }" header="Pedidos entregados sin factura" [draggable]="false">
        <div class="fa-form">
          @if (loadingContingencia()) {
            <p class="fa-note"><i class="pi pi-spin pi-spinner"></i> Cargando pendientes…</p>
          } @else if (contingencia()) {
            @if (contingencia(); as rec) {
            <!-- Nominativa: gap real -->
            <div class="fa-cont-sec">
              <div class="fa-cont-head">
                <span><strong>Facturas nominativa pendientes</strong> ({{ rec.counts.nominativa }})</span>
                @if (canManage && rec.counts.nominativa > 0) {
                  <button pButton type="button" label="Reintentar todos" icon="pi pi-replay" class="p-button-sm" [loading]="retrying()" (click)="retryPending()"></button>
                }
              </div>
              @if (rec.pending_nominativa.length === 0) {
                <p class="fa-note fa-note-ok"><i class="pi pi-check-circle"></i> Sin pendientes: todos los pedidos con datos fiscales fueron facturados.</p>
              } @else {
                <table class="fa-cont-table">
                  <thead><tr><th>Pedido</th><th>Cliente</th><th class="ta-r">Total</th><th class="ta-r">Int.</th><th>Último error</th></tr></thead>
                  <tbody>
                    @for (o of rec.pending_nominativa; track o.id) {
                      <tr>
                        <td class="mono">{{ o.code }}</td>
                        <td>{{ o.customer_name || o.customer_id }}</td>
                        <td class="ta-r mono">{{ mzn(o.total) }}</td>
                        <td class="ta-r mono">{{ o.cfdi_attempts || 0 }}</td>
                        <td class="fa-cont-err">{{ o.cfdi_error || '—' }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              }
            </div>

            <!-- Mostrador pendiente de global, por día -->
            <div class="fa-cont-sec">
              <div class="fa-cont-head"><span><strong>Mostrador pendiente de global</strong> ({{ rec.counts.global_days }} día(s))</span></div>
              @if (rec.pending_global_by_day.length === 0) {
                <p class="fa-note fa-note-ok"><i class="pi pi-check-circle"></i> Sin mostrador pendiente de factura global.</p>
              } @else {
                <table class="fa-cont-table">
                  <thead><tr><th>Día</th><th class="ta-r">Pedidos</th><th class="ta-r">Total</th><th></th></tr></thead>
                  <tbody>
                    @for (d of rec.pending_global_by_day; track d.day) {
                      <tr>
                        <td class="mono">{{ d.day | date:'dd/MM/yy' }}</td>
                        <td class="ta-r mono">{{ d.orders }}</td>
                        <td class="ta-r mono">{{ mzn(d.total) }}</td>
                        <td class="ta-r">@if (canManage) { <button pButton type="button" label="Facturar global" icon="pi pi-calendar" class="p-button-text p-button-sm" [loading]="globalDay()===d.day" (click)="globalForDay(d.day)"></button> }</td>
                      </tr>
                    }
                  </tbody>
                </table>
              }
            </div>
            <p class="fa-note"><i class="pi pi-info-circle"></i> Ventana: últimos {{ rec.days }} días. El reintento es idempotente y solo aplica a pedidos con datos fiscales completos.</p>
            }
          } @else {
            <p class="fa-note fa-note-warn"><i class="pi pi-exclamation-triangle"></i> No se pudo cargar el reporte.</p>
          }
        </div>
        <ng-template pTemplate="footer">
          <button pButton type="button" label="Cerrar" class="p-button-text p-button-sm" (click)="showContingencia=false"></button>
        </ng-template>
      </p-dialog>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .fa-head { display: flex; align-items: flex-start; gap: 1rem; }
    .fa-head-actions { margin-left: auto; display: flex; gap: .4rem; align-items: center; }
    .fa-banner { display: flex; align-items: center; gap: .6rem; background: color-mix(in srgb, var(--action) 8%, var(--card-bg)); border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); padding: .7rem 1rem; margin-bottom: 1rem; font-size: .85rem; color: var(--text-main); }
    .fa-banner button { margin-left: auto; }
    .fa-table { font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .85em; }
    .fa-recep { color: var(--text-main); }
    .fa-sub { color: var(--text-muted); font-size: .72rem; }
    .fa-tot { font-weight: 700; }
    .fa-nc { display: inline-block; margin-left: .4rem; padding: 0 .35rem; border-radius: var(--r-sm, 4px); background: color-mix(in srgb, var(--bad-fg, #b91c1c) 14%, transparent); color: var(--bad-fg, #b91c1c); font-size: .6rem; font-weight: 800; letter-spacing: .04em; vertical-align: middle; }
    .fa-est { display: inline-block; padding: .1rem .5rem; border-radius: var(--r-pill, 999px); font-size: .66rem; font-weight: 700; text-transform: capitalize; }
    .e-ok { background: color-mix(in srgb, var(--ok-fg, #16a34a) 14%, transparent); color: var(--ok-fg, #16a34a); }
    .e-bad { background: color-mix(in srgb, var(--bad-fg, #dc2626) 15%, transparent); color: var(--bad-fg, #dc2626); }
    .e-neutral { background: var(--surface-hover-bg, #f5f5f4); color: var(--text-muted); }
    .fa-empty { padding: 2.5rem 1rem; text-align: center; color: var(--text-muted); }
    .fa-empty .pi { display: block; font-size: 1.5rem; margin-bottom: .5rem; opacity: .6; }
    .fa-form { display: flex; flex-direction: column; gap: .8rem; padding-top: .5rem; }
    .fa-f { display: flex; flex-direction: column; gap: .25rem; font-size: .72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
    .fa-f input, .fa-f select, .fa-concepts input { border: 1px solid var(--border-color); border-radius: var(--r-sm, 8px); padding: .45rem .6rem; background: var(--card-bg); color: var(--text-main); font-family: inherit; font-size: .85rem; width: 100%; }
    .fa-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
    .fa-grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: .6rem; }
    .fa-f-wide { grid-column: 1 / -1; }
    .fa-concept-head { display: flex; align-items: center; justify-content: space-between; font-size: .72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; margin-top: .2rem; }
    .fa-concepts { width: 100%; border-collapse: collapse; }
    .fa-concepts th { text-align: left; font-size: .64rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted); padding: .2rem .35rem; border-bottom: 1px solid var(--border-color); }
    .fa-concepts td { padding: .2rem .35rem; vertical-align: middle; }
    .fa-concepts .ta-r { text-align: right; }
    .fa-seg { display: inline-flex; border: 1px solid var(--border-color); border-radius: var(--r-pill, 999px); overflow: hidden; width: fit-content; }
    .fa-seg button { border: none; background: var(--card-bg); padding: .35rem .9rem; font-size: .8rem; cursor: pointer; color: var(--text-muted); }
    .fa-seg button.active { background: var(--action); color: var(--action-ink, #fff); font-weight: 600; }
    .fa-check { display: flex; align-items: center; gap: .45rem; font-size: .82rem; color: var(--text-main); text-transform: none; letter-spacing: 0; }
    .fa-totals { display: flex; gap: 1.4rem; justify-content: flex-end; align-items: baseline; border-top: 1px solid var(--border-color); padding-top: .7rem; font-size: .82rem; color: var(--text-muted); }
    .fa-totals strong { color: var(--text-main); margin-left: .3rem; }
    .fa-grand strong { font-size: 1.05rem; color: var(--action); }
    .fa-note { font-size: .75rem; color: var(--text-muted); background: var(--surface-hover-bg, #f7f7f6); border-radius: var(--r-sm, 8px); padding: .5rem .7rem; margin: 0; display: flex; gap: .4rem; align-items: baseline; }
    .fa-note-ok { color: var(--ok-fg, #15803d); background: color-mix(in srgb, var(--ok-fg, #15803d) 8%, transparent); }
    .fa-note-warn { color: var(--warn-fg, #b45309); background: color-mix(in srgb, var(--warn-fg, #b45309) 10%, transparent); }
    /* FE.13 contingencia */
    .fa-cont-sec { margin-bottom: 1.1rem; }
    .fa-cont-head { display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-bottom: .5rem; font-size: .85rem; }
    .fa-cont-table { width: 100%; border-collapse: collapse; font-size: .78rem; font-variant-numeric: tabular-nums; }
    .fa-cont-table th { text-align: left; color: var(--text-muted); font-weight: 600; padding: .3rem .5rem; border-bottom: 1px solid var(--border-color); }
    .fa-cont-table td { padding: .3rem .5rem; border-bottom: 1px solid var(--border-color); color: var(--text-main); }
    .fa-cont-err { color: var(--bad-fg, #b91c1c); max-width: 16rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .72rem; }
  `],
})
export class ContabilidadFacturarComponent implements OnInit {
  readonly tabs = CONTABILIDAD_TABS;
  private readonly svc = inject(FacturasService);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  readonly canManage = this.auth.user()?.permissions?.[Permission.FISCAL_FACTURAR_GESTIONAR] === true;
  readonly rows = signal<EmittedInvoice[]>([]);
  readonly issuers = signal<IssuerConfig[]>([]);
  readonly hasIssuer = computed(() => this.issuers().length > 0);
  readonly loading = signal(false);
  readonly errored = signal(false);
  readonly emitting = signal(false);
  readonly savingIssuer = signal(false);
  readonly cancelling = signal(false);
  readonly statusChecking = signal<string | null>(null);

  showEmit = false;
  showIssuer = false;
  // FE.10 — cancelación
  showCancel = false;
  readonly cancelRow = signal<EmittedInvoice | null>(null);
  cancelForm = { motivo: '02', folioSustitucion: '', reason: '' };
  // FE.12 — nota de crédito
  showNc = false;
  readonly ncRow = signal<EmittedInvoice | null>(null);
  readonly ncConceptos = signal<ConceptoRow[]>([{ descripcion: '', cantidad: 1, valor_unitario: 0 }]);
  readonly ncEmitting = signal(false);
  // FE.13 — contingencia
  showContingencia = false;
  readonly contingencia = signal<InvoiceReconciliation | null>(null);
  readonly loadingContingencia = signal(false);
  readonly retrying = signal(false);
  readonly globalDay = signal<string | null>(null);
  readonly conceptos = signal<ConceptoRow[]>([{ descripcion: '', cantidad: 1, valor_unitario: 0 }]);
  form = {
    tipo: 'global' as 'global' | 'nominativa',
    serie: '', forma_pago: '01', metodo_pago: 'PUE',
    receptor: { rfc: '', nombre: '', regimen_fiscal: '601', domicilio_cp: '', uso_cfdi: 'G03' },
  };
  issuerForm: IssuerConfig = { rfc: '', tax_name: '', regimen_fiscal: '612', cp: '', serie: 'A', is_default: true };

  ngOnInit() { this.reload(); this.loadIssuers(); }

  reload() {
    this.loading.set(true); this.errored.set(false);
    this.svc.list().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.rows.set(r.rows); this.loading.set(false); },
      error: () => { this.loading.set(false); this.errored.set(true); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar la bandeja.' }); },
    });
  }
  loadIssuers() {
    this.svc.issuers().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (i) => this.issuers.set(i), error: () => {} });
  }

  globalDia() {
    this.confirm.confirm({
      header: 'Factura global de mostrador',
      message: 'Emite UN CFDI global con los pedidos entregados HOY cuyo cliente no tiene datos fiscales completos. ¿Continuar?',
      icon: 'pi pi-calendar', acceptLabel: 'Emitir global', rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-sm', rejectButtonStyleClass: 'p-button-text p-button-sm',
      accept: () => {
        this.svc.globalInvoice().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
          next: (r) => {
            this.toast.add(r.issued
              ? { severity: 'success', summary: 'Global emitida', detail: `${r.count} pedidos · ${this.mzn(r.total)} · UUID ${r.uuid?.slice(0, 8)}…`, life: 7000 }
              : { severity: 'info', summary: 'Sin pedidos', detail: 'No hay ventas de mostrador sin facturar hoy.' });
            this.reload();
          },
          error: (e) => this.toast.add({ severity: 'error', summary: 'No se pudo emitir la global', detail: e?.error?.message || 'Error.', life: 8000 }),
        });
      },
    });
  }

  // ── Emitir ────────────────────────────────────────────────────────────────
  openEmit() {
    this.conceptos.set([{ descripcion: '', cantidad: 1, valor_unitario: 0 }]);
    this.form = { tipo: 'global', serie: '', forma_pago: '01', metodo_pago: 'PUE', receptor: { rfc: '', nombre: '', regimen_fiscal: '601', domicilio_cp: '', uso_cfdi: 'G03' } };
    this.showEmit = true;
  }
  addConcepto() { this.conceptos.update((v) => [...v, { descripcion: '', cantidad: 1, valor_unitario: 0 }]); }
  removeConcepto(i: number) { this.conceptos.update((v) => v.filter((_, idx) => idx !== i)); }

  private r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  totals() {
    const subtotal = this.r2(this.conceptos().reduce((s, c) => s + (Number(c.cantidad) || 0) * (Number(c.valor_unitario) || 0), 0));
    const iva = this.r2(subtotal * 0.16);
    return { subtotal, iva, total: this.r2(subtotal + iva) };
  }
  private validConceptos() {
    return this.conceptos().filter((c) => c.descripcion.trim() && Number(c.cantidad) > 0 && Number(c.valor_unitario) >= 0);
  }
  emitValid(): boolean {
    if (!this.validConceptos().length) return false;
    if (this.form.tipo === 'nominativa') {
      const r = this.form.receptor;
      return /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/.test((r.rfc || '').toUpperCase()) && !!r.nombre.trim() && !!r.regimen_fiscal.trim() && /^[0-9]{5}$/.test(r.domicilio_cp) && !!r.uso_cfdi.trim();
    }
    return true;
  }
  emit() {
    if (!this.emitValid()) return;
    const conceptos = this.validConceptos().map((c) => ({ descripcion: c.descripcion.trim(), cantidad: Number(c.cantidad), valor_unitario: Number(c.valor_unitario) }));
    const body = {
      tipo: this.form.tipo,
      serie: this.form.serie?.trim().toUpperCase() || undefined,
      forma_pago: this.form.forma_pago, metodo_pago: this.form.metodo_pago,
      periodicidad: this.form.tipo === 'global' ? '01' : undefined,
      receptor: this.form.tipo === 'nominativa' ? { ...this.form.receptor, rfc: this.form.receptor.rfc.toUpperCase() } : undefined,
      conceptos,
    };
    this.emitting.set(true);
    this.svc.emitir(body).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.emitting.set(false); this.showEmit = false; this.toast.add({ severity: 'success', summary: 'Factura timbrada', detail: `${r.serie}${r.folio} · UUID ${r.uuid?.slice(0, 8)}… · ${this.mzn(r.total)}`, life: 6000 }); this.reload(); },
      error: (e) => { this.emitting.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo timbrar', detail: e?.error?.message || 'El PAC rechazó el comprobante.', life: 8000 }); },
    });
  }

  // ── Emisor ────────────────────────────────────────────────────────────────
  openIssuer() {
    const d = this.issuers().find((i) => i.is_default) || this.issuers()[0];
    this.issuerForm = d ? { ...d } : { rfc: '', tax_name: '', regimen_fiscal: '612', cp: '', serie: 'A', is_default: true };
    this.showIssuer = true;
  }
  issuerValid(): boolean {
    const f = this.issuerForm;
    return /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/.test((f.rfc || '').toUpperCase()) && !!f.tax_name?.trim() && !!f.regimen_fiscal?.trim() && /^[0-9]{5}$/.test(f.cp || '');
  }
  saveIssuer() {
    if (!this.issuerValid()) return;
    this.savingIssuer.set(true);
    this.svc.saveIssuer({ ...this.issuerForm, rfc: this.issuerForm.rfc.toUpperCase() }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.savingIssuer.set(false); this.showIssuer = false; this.toast.add({ severity: 'success', summary: 'Emisor guardado' }); this.loadIssuers(); },
      error: () => { this.savingIssuer.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo guardar el emisor.' }); },
    });
  }

  // ── Acciones de fila ────────────────────────────────────────────────────────
  downloadXml(r: EmittedInvoice) {
    this.svc.getXml(r.uuid).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (xml) => {
        const blob = new Blob([xml], { type: 'application/xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `${r.serie || ''}${r.folio || r.uuid}.xml`; a.click();
        URL.revokeObjectURL(url);
      },
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo descargar el XML.' }),
    });
  }
  downloadPdf(r: EmittedInvoice) {
    this.svc.getPdf(r.uuid).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: ({ pdf_base64 }) => {
        const bytes = Uint8Array.from(atob(pdf_base64), (ch) => ch.charCodeAt(0));
        const blob = new Blob([bytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `${r.serie || ''}${r.folio || r.uuid}.pdf`; a.click();
        URL.revokeObjectURL(url);
      },
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo generar el PDF.' }),
    });
  }
  // ── FE.10 cancelación ──
  isUuid = (s: string) => /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test((s || '').trim());

  openCancel(r: EmittedInvoice) {
    this.cancelRow.set(r);
    this.cancelForm = { motivo: '02', folioSustitucion: '', reason: '' };
    this.showCancel = true;
  }

  confirmCancel() {
    const r = this.cancelRow();
    if (!r) return;
    const f = this.cancelForm;
    if (f.motivo === '01' && !this.isUuid(f.folioSustitucion)) {
      this.toast.add({ severity: 'warn', summary: 'Falta el UUID de sustitución', detail: 'El motivo 01 requiere el UUID del CFDI que sustituye.' });
      return;
    }
    this.cancelling.set(true);
    this.svc.cancelar(r.uuid, f.motivo, f.motivo === '01' ? f.folioSustitucion.trim().toUpperCase() : undefined, f.reason || undefined)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (res) => {
          this.cancelling.set(false);
          this.showCancel = false;
          const msg = res.estatus_sat === 'cancelado' ? 'Factura cancelada'
            : res.estatus_sat === 'en_proceso_cancelacion' ? 'Cancelación en proceso (espera aceptación del receptor)'
            : 'Solicitud de cancelación enviada';
          this.toast.add({ severity: 'success', summary: msg, life: 6000 });
          this.reload();
        },
        error: (e) => {
          this.cancelling.set(false);
          this.toast.add({ severity: 'error', summary: 'No se pudo cancelar', detail: e?.error?.message || 'El PAC rechazó la cancelación.' });
        },
      });
  }

  consultarEstatus(r: EmittedInvoice) {
    this.statusChecking.set(r.uuid);
    this.svc.consultarEstatus(r.uuid).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.statusChecking.set(null);
        this.toast.add({ severity: 'info', summary: 'Estatus SAT', detail: this.estatusLabel(res.estatus_sat), life: 4000 });
        this.reload();
      },
      error: (e) => { this.statusChecking.set(null); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo consultar el estatus.' }); },
    });
  }

  downloadAcuse(r: EmittedInvoice) {
    this.svc.getAcuse(r.uuid).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: ({ acuse }) => {
        // El acuse puede venir como XML crudo o base64; si es base64 lo decodificamos.
        const isXml = acuse.trimStart().startsWith('<');
        const content = isXml ? acuse : (() => { try { return atob(acuse); } catch { return acuse; } })();
        const blob = new Blob([content], { type: 'application/xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `acuse_${r.serie || ''}${r.folio || r.uuid}.xml`; a.click();
        URL.revokeObjectURL(url);
      },
      error: () => this.toast.add({ severity: 'warn', summary: 'Sin acuse', detail: 'Aún no hay acuse de cancelación para esta factura.' }),
    });
  }

  // ── FE.12 nota de crédito ──
  openNc(r: EmittedInvoice) {
    this.ncRow.set(r);
    this.ncConceptos.set([{ descripcion: `Devolución/descuento s/ ${r.serie || ''}${r.folio || ''}`.trim(), cantidad: 1, valor_unitario: 0 }]);
    this.showNc = true;
  }
  addNcConcepto() { this.ncConceptos.update((v) => [...v, { descripcion: '', cantidad: 1, valor_unitario: 0 }]); }
  removeNcConcepto(i: number) { this.ncConceptos.update((v) => v.filter((_, idx) => idx !== i)); }
  ncTotals() {
    const subtotal = this.r2(this.ncConceptos().reduce((s, c) => s + (Number(c.cantidad) || 0) * (Number(c.valor_unitario) || 0), 0));
    const iva = this.r2(subtotal * 0.16);
    return { subtotal, iva, total: this.r2(subtotal + iva) };
  }
  private ncValidConceptos() {
    return this.ncConceptos().filter((c) => c.descripcion.trim() && Number(c.cantidad) > 0 && Number(c.valor_unitario) > 0);
  }
  ncValid(): boolean { return this.ncValidConceptos().length > 0; }
  emitNc() {
    const r = this.ncRow();
    if (!r || !this.ncValid()) return;
    const conceptos = this.ncValidConceptos().map((c) => ({ descripcion: c.descripcion.trim(), cantidad: Number(c.cantidad), valor_unitario: Number(c.valor_unitario) }));
    this.ncEmitting.set(true);
    this.svc.notaCredito(r.uuid, { conceptos }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.ncEmitting.set(false);
        this.showNc = false;
        this.toast.add({ severity: 'success', summary: 'Nota de crédito timbrada', detail: `${res.serie}${res.folio} · ${this.mzn(res.total)}`, life: 6000 });
        this.reload();
      },
      error: (e) => { this.ncEmitting.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo emitir la NC', detail: e?.error?.message || 'El PAC rechazó la nota de crédito.' }); },
    });
  }

  // ── FE.13 contingencia ──
  openContingencia() { this.showContingencia = true; this.loadReconciliation(); }
  loadReconciliation() {
    this.loadingContingencia.set(true);
    this.svc.invoiceReconciliation(30).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rec) => { this.contingencia.set(rec); this.loadingContingencia.set(false); },
      error: () => { this.contingencia.set(null); this.loadingContingencia.set(false); },
    });
  }
  retryPending() {
    this.retrying.set(true);
    this.svc.retryInvoices({}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.retrying.set(false);
        this.toast.add({ severity: r.invoiced > 0 ? 'success' : 'info', summary: `Reintento: ${r.invoiced}/${r.attempted} facturados`, detail: r.failed ? `${r.failed} siguen pendientes (ver error)` : undefined, life: 6000 });
        this.loadReconciliation(); this.reload();
      },
      error: (e) => { this.retrying.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo reintentar.' }); },
    });
  }
  globalForDay(day: string) {
    this.globalDay.set(day);
    this.svc.globalInvoice(day).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.globalDay.set(null);
        this.toast.add({ severity: r.issued ? 'success' : 'info', summary: r.issued ? `Global ${day}: ${this.mzn(r.total)} (${r.count} pedidos)` : 'Sin pedidos para facturar ese día', life: 6000 });
        this.loadReconciliation(); this.reload();
      },
      error: (e) => { this.globalDay.set(null); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo emitir la global.' }); },
    });
  }

  estatusClass(e: string): string { return e === 'vigente' ? 'ok' : e === 'cancelado' ? 'bad' : 'neutral'; }
  estatusLabel(e: string): string {
    return e === 'vigente' ? 'Vigente' : e === 'cancelado' ? 'Cancelado' : e === 'en_proceso_cancelacion' ? 'En proceso' : (e || '—');
  }
  mzn = (n: unknown) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(n) || 0);
}
