import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { SelectButtonModule } from 'primeng/selectbutton';
import { DialogModule } from 'primeng/dialog';
import { TableModule } from 'primeng/table';
import { MessageService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { CONTABILIDAD_TABS } from '../contabilidad-tabs';
import { MaterialidadService, MaterialidadDossier, MaterialidadChain, MatReconcileRow, MatProvider } from '../materialidad.service';
import { CfdiService } from '../cfdi.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';

/**
 * FISCAL.10.1 — Expediente de materialidad de un proveedor (Operations). Se busca
 * por RFC y arma el dossier de defensa: listas SAT + CFDIs + cadena de suministro
 * (la recepción física es la evidencia) + veredicto. Clave si el proveedor es EFOS.
 */
@Component({
  selector: 'app-contabilidad-materialidad',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, ToastModule, InputTextModule, IconFieldModule, InputIconModule, SelectButtonModule, DialogModule, TableModule, PageTabsComponent, MetricStripComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="tabs" />

      <header class="surf-page-head mt-head">
        <div class="surf-page-head-text">
          <h1>Expediente de materialidad</h1>
          <p class="surf-page-sub">Defensa por proveedor: listas negras + CFDIs + cadena de suministro (orden → recepción → factura → pago). La recepción física es la evidencia más fuerte.</p>
        </div>
      </header>

      <div class="mt-search">
        <span class="p-input-icon-left">
          <i class="pi pi-search"></i>
          <input type="text" pInputText placeholder="RFC del proveedor (p.ej. DRO020122GZ9)" [(ngModel)]="rfc" (keyup.enter)="buscar()" maxlength="13" style="text-transform:uppercase;min-width:280px" aria-label="RFC del proveedor" />
        </span>
        <button pButton type="button" label="Armar expediente" icon="pi pi-folder-open" class="p-button-sm" [loading]="loading()" [disabled]="!rfcValid()" (click)="buscar()"></button>
        @if (dossier() || searched()) { <button pButton type="button" label="Ver proveedores" icon="pi pi-arrow-left" class="p-button-sm p-button-text" (click)="backToList()"></button> }
      </div>

      @if (loading()) {
        <div class="mt-skel card-premium card-flat">Armando expediente…</div>
      } @else if (dossier()) {
        @if (dossier(); as d) {
        <div class="mt-veredicto" [ngClass]="'v-' + d.veredicto.nivel">
          <div class="mt-v-badge">{{ veredictoLabel(d.veredicto.nivel) }}</div>
          <div class="mt-v-body">
            <div class="mt-v-title">{{ d.beneficiario || d.rfc }} <span class="mono muted">{{ d.rfc }}</span></div>
            <div class="mt-v-msg">{{ d.veredicto.mensaje }}</div>
          </div>
        </div>

        <app-metric-strip [items]="kpiItems(d)" ariaLabel="Resumen de materialidad" />


        <div class="mt-grid">
          <div class="card-premium card-flat mt-block">
            <div class="mt-block-head">
              <h3 class="mt-block-title">Cadena de suministro</h3>
              <button pButton type="button" label="Ver documentos" icon="pi pi-list" class="p-button-sm p-button-text"
                      [disabled]="d.cadena_suministro.cadenas === 0" (click)="openChains()"></button>
            </div>
            <div class="mt-chain" [class.clickable]="d.cadena_suministro.cadenas > 0"
                 [attr.role]="d.cadena_suministro.cadenas > 0 ? 'button' : null"
                 [attr.tabindex]="d.cadena_suministro.cadenas > 0 ? 0 : null"
                 [attr.aria-label]="d.cadena_suministro.cadenas > 0 ? ('Desglosar ' + d.cadena_suministro.cadenas + ' cadenas de documentos') : null"
                 (click)="openChains()" (keyup.enter)="openChains()">
              <div class="mt-chain-step" [class.on]="d.cadena_suministro.con_orden > 0"><span class="mt-chain-n">{{ d.cadena_suministro.con_orden | number }}</span><span>Orden</span></div>
              <i class="pi pi-arrow-right"></i>
              <div class="mt-chain-step" [class.on]="d.cadena_suministro.con_recepcion > 0"><span class="mt-chain-n">{{ d.cadena_suministro.con_recepcion | number }}</span><span>Recepción</span></div>
              <i class="pi pi-arrow-right"></i>
              <div class="mt-chain-step on"><span class="mt-chain-n">{{ d.cadena_suministro.cadenas | number }}</span><span>Factura</span></div>
              <i class="pi pi-arrow-right"></i>
              <div class="mt-chain-step" [class.on]="d.cadena_suministro.con_pago > 0"><span class="mt-chain-n">{{ d.cadena_suministro.con_pago | number }}</span><span>Pago</span></div>
            </div>
            @if (d.cadena_suministro.cadenas > 0) {
              <p class="mt-chain-hint"><i class="pi pi-hand-pointer"></i> Clic para desglosar los documentos de cada compra.</p>
            }
          </div>

          <div class="card-premium card-flat mt-block">
            <h3 class="mt-block-title">Listas negras del SAT</h3>
            @if (d.listas_negras.length) {
              <ul class="mt-listas">
                @for (l of d.listas_negras; track l.lista + l.situacion) {
                  <li><span class="mt-lista-tag" [class.risk]="true">{{ listaLabel(l.lista) }}</span> <span class="mt-lista-sit">{{ l.situacion }}</span> <span class="muted">· {{ l.doc_count | number }} doc · {{ money(l.importe_total) }}</span></li>
                }
              </ul>
            } @else {
              <div class="mt-clean"><i class="pi pi-check-circle"></i> No aparece en EFOS 69-B ni Art. 69.</div>
            }
            <div class="mt-cfdi-line">CFDIs recibidos: <strong class="mono">{{ d.cfdis.total | number }}</strong> · monto <strong class="mono">{{ money(d.cfdis.monto) }}</strong></div>
          </div>
        </div>
        }
      } @else {
        <div class="card-premium card-flat mt-disc">
          <div class="mt-disc-head">
            <div>
              <h3 class="mt-disc-title">Proveedores</h3>
              <p class="mt-disc-sub">Explorá por riesgo (lista negra → baja recepción → monto) o busca por nombre. Clic en uno arma su expediente — no necesitas teclear el RFC.</p>
            </div>
            <div class="mt-disc-filters">
              <p-iconfield iconPosition="left" styleClass="mt-disc-search">
                <p-inputicon styleClass="pi pi-search" />
                <input type="text" pInputText placeholder="Buscar RFC o proveedor…" [ngModel]="provSearch()" (ngModelChange)="onProvSearch($event)" aria-label="Buscar proveedor" />
              </p-iconfield>
              <p-selectButton [options]="riesgoOpts" [ngModel]="provRiesgo()" (ngModelChange)="setProvRiesgo($event)" optionLabel="label" optionValue="value" [allowEmpty]="false" ariaLabel="Filtrar por riesgo" />
            </div>
          </div>
          @if (searched() && !dossier()) { <div class="mt-warn"><i class="pi pi-exclamation-triangle"></i> No se pudo armar el expediente de {{ rfc }}. Elegí uno de la lista.</div> }
          <p-table [value]="providers()" styleClass="p-datatable-sm mt-disc-table" [rowHover]="true" [loading]="provLoading()" [scrollable]="true" scrollHeight="480px" [paginator]="providers().length > 50" [rows]="50">
            <ng-template pTemplate="header">
              <tr>
                <th>Proveedor</th>
                <th class="ta-r" style="width:5rem">Ops</th>
                <th class="ta-r" style="width:10rem">Monto</th>
                <th class="ta-r" style="width:7rem">Recepción</th>
                <th style="width:9rem">Riesgo</th>
                <th style="width:3rem"></th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-p>
              <tr class="mt-disc-row" tabindex="0" [attr.aria-label]="'Armar expediente de ' + (p.beneficiario || p.rfc)" (click)="pickProvider(p.rfc)" (keyup.enter)="pickProvider(p.rfc)">
                <td><div class="mt-p-name">{{ p.beneficiario || p.rfc }}</div><div class="mt-p-rfc mono">{{ p.rfc }}</div></td>
                <td class="ta-r mono">{{ p.ops | number }}</td>
                <td class="ta-r strong mono">{{ money(p.monto) }}</td>
                <td class="ta-r mono">{{ p.recepcion_pct != null ? p.recepcion_pct + '%' : '—' }}</td>
                <td>
                  @if (p.en_riesgo) { <span class="mt-r-tag risk">Lista · riesgo</span> }
                  @else if (p.en_lista) { <span class="mt-r-tag warn">En lista</span> }
                  @else if (p.recepcion_pct != null && p.recepcion_pct < 50) { <span class="mt-r-tag warn">Baja recep.</span> }
                  @else { <span class="muted">—</span> }
                </td>
                <td class="ta-r"><i class="pi pi-chevron-right muted"></i></td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage"><tr><td colspan="6" class="mt-empty2">
              @if (provLoading()) { Cargando… }
              @else if (provSearch() || provRiesgo() !== 'all') { <i class="pi pi-filter-slash"></i> Sin proveedores para este filtro. }
              @else { <i class="pi pi-inbox"></i> Sin proveedores con egresos cargados. }
            </td></tr></ng-template>
          </p-table>
        </div>
      }

      <p-dialog [(visible)]="chainsOpen" [modal]="true" [draggable]="false" [dismissableMask]="true"
                [style]="{ width: 'min(940px, 95vw)' }" [breakpoints]="{ '640px': '100vw' }" styleClass="mt-dialog">
        <ng-template pTemplate="header">
          <div class="mt-dlg-head">
            <span class="mt-dlg-title">Documentos de la cadena de suministro</span>
            @if (dossier(); as d) { <span class="mono muted">{{ d.beneficiario || d.rfc }} · {{ d.rfc }}</span> }
          </div>
        </ng-template>

        @if (dossier(); as d) {
        <div class="mt-dlg-tabs" role="tablist">
          <button type="button" role="tab" [attr.aria-selected]="dlgTab()==='oper'" [class.active]="dlgTab()==='oper'" (click)="setDlgTab('oper')"><i class="pi pi-sitemap"></i> Operación <span class="mt-tab-n">{{ d.cadena_suministro.cadenas }}</span></button>
          <button type="button" role="tab" [attr.aria-selected]="dlgTab()==='fiscal'" [class.active]="dlgTab()==='fiscal'" (click)="setDlgTab('fiscal')"><i class="pi pi-file"></i> Fiscal · CFDIs <span class="mt-tab-n">{{ d.cfdis.total }}</span></button>
        </div>
        }

        @if (dlgTab() === 'oper') {
        <p class="mt-dlg-legend">Cada fila es una <strong>compra</strong>. Ábrela para ver sus documentos operativos: <b>Orden</b> → <b>Recepción</b> (entrada a almacén — la evidencia más fuerte) → <b>Factura</b> → <b>Pago</b>.</p>

        @if (chainsLoading()) {
          <div class="mt-dlg-skel">Cargando documentos…</div>
        } @else {
          <p-table [value]="chains() || []" dataKey="key" styleClass="p-datatable-sm mt-ctable" [rowHover]="true"
                   [scrollable]="true" scrollHeight="52vh" [paginator]="(chains()?.length || 0) > 25" [rows]="25">
            <ng-template pTemplate="header">
              <tr>
                <th style="width:2.5rem"></th>
                <th>Factura</th>
                <th style="width:5rem">Suc.</th>
                <th class="ta-r" style="width:9rem">Total</th>
                <th style="width:8rem">Cadena</th>
                <th style="width:6.5rem">Enlace</th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-c let-expanded="expanded">
              <tr>
                <td><button type="button" pButton [pRowToggler]="c" class="p-button-text p-button-sm mt-tog" [icon]="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" [attr.aria-label]="expanded ? 'Ocultar documentos' : 'Ver documentos'"></button></td>
                <td><div class="strong mono">{{ c.factura_folio }}</div><div class="muted mono cf-sub">{{ c.factura_fecha ? (c.factura_fecha | date:'dd/MM/yy') : '—' }}</div></td>
                <td class="mono">{{ c.sucursal }}</td>
                <td class="ta-r strong mono">{{ money(c.total) }}</td>
                <td>
                  <span class="mt-dots" [attr.aria-label]="'Orden ' + (c.orden_folio ? 'sí' : 'no') + ', Recepción ' + (c.recepcion_folio ? 'sí' : 'no') + ', Pago ' + (c.pago_folio ? 'sí' : 'no')">
                    <span class="mt-dot" [class.on]="!!c.orden_folio" title="Orden">O</span>
                    <span class="mt-dot" [class.on]="!!c.recepcion_folio" title="Recepción">R</span>
                    <span class="mt-dot on" title="Factura">F</span>
                    <span class="mt-dot" [class.on]="!!c.pago_folio" title="Pago">P</span>
                  </span>
                </td>
                <td><span class="mt-conf" [ngClass]="'c-' + (c.match_confidence || 'na')">{{ confLabel(c.match_confidence) }}</span></td>
              </tr>
            </ng-template>
            <ng-template pTemplate="rowexpansion" let-c>
              <tr class="mt-exp-row">
                <td colspan="6">
                  <div class="mt-timeline">
                    <div class="mt-tl-step" [class.off]="!c.orden_folio">
                      <div class="mt-tl-ico"><i class="pi pi-file-edit"></i></div>
                      <div class="mt-tl-b"><span class="mt-tl-lbl">Orden de compra</span>
                        @if (c.orden_folio) { <span class="mono strong">{{ c.orden_folio }}</span><span class="muted mono">{{ c.orden_fecha ? (c.orden_fecha | date:'dd/MM/yy') : '' }}</span> }
                        @else { <span class="muted">Sin orden registrada</span> }
                      </div>
                    </div>
                    <i class="pi pi-arrow-right mt-tl-sep"></i>
                    <div class="mt-tl-step" [class.off]="!c.recepcion_folio">
                      <div class="mt-tl-ico"><i class="pi pi-inbox"></i></div>
                      <div class="mt-tl-b"><span class="mt-tl-lbl">Recepción</span>
                        @if (c.recepcion_folio) { <span class="mono strong">{{ c.recepcion_folio }}</span><span class="muted mono">{{ c.recepcion_fecha ? (c.recepcion_fecha | date:'dd/MM/yy') : '' }}</span> }
                        @else { <span class="warn">Sin recepción — evidencia débil</span> }
                      </div>
                    </div>
                    <i class="pi pi-arrow-right mt-tl-sep"></i>
                    <div class="mt-tl-step">
                      <div class="mt-tl-ico on"><i class="pi pi-file"></i></div>
                      <div class="mt-tl-b"><span class="mt-tl-lbl">Factura</span><span class="mono strong">{{ c.factura_folio }}</span><span class="muted mono">{{ c.factura_fecha ? (c.factura_fecha | date:'dd/MM/yy') : '' }}</span></div>
                    </div>
                    <i class="pi pi-arrow-right mt-tl-sep"></i>
                    <div class="mt-tl-step" [class.off]="!c.pago_folio">
                      <div class="mt-tl-ico"><i class="pi pi-wallet"></i></div>
                      <div class="mt-tl-b"><span class="mt-tl-lbl">Pago</span>
                        @if (c.pago_folio) { <span class="mono strong">{{ c.pago_folio }}</span><span class="muted mono">{{ c.pago_fecha ? (c.pago_fecha | date:'dd/MM/yy') : '' }}</span> }
                        @else { <span class="muted">Sin pago programado</span> }
                      </div>
                    </div>
                  </div>
                  @if (c.lead_days != null || c.pago_days != null) {
                    <div class="mt-tl-meta">
                      @if (c.lead_days != null) { <span>Orden → factura: <strong class="mono">{{ c.lead_days }}</strong> d</span> }
                      @if (c.pago_days != null) { <span>Factura → pago: <strong class="mono">{{ c.pago_days }}</strong> d</span> }
                    </div>
                  }
                </td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage"><tr><td colspan="6" class="mt-dlg-empty">
              <i class="pi pi-inbox"></i> Sin cadenas de documentos reconstruidas para este RFC.
            </td></tr></ng-template>
          </p-table>
        }
        } @else {
        <p class="mt-dlg-legend">CFDIs que <strong>emitió este proveedor</strong> hacia ti, con la operación que los respalda. Kepler no guarda el UUID → el motor <strong>sugiere</strong> el enlace (mismo RFC, importe ±$1, fecha ±5 días) y tú lo <strong>confirmas</strong>. La asignación confirmada es la evidencia de materialidad.</p>
        @if (reconSummary(); as rs) {
          <div class="mt-recon-sum">
            <span class="mt-rs ok">✓ {{ rs.confirmed }} asignadas</span>
            <span class="mt-rs warn">◐ {{ rs.suggested }} sugeridas</span>
            <span class="mt-rs muted">○ {{ rs.unmatched }} sin operación</span>
            <button pButton type="button" label="Descargar ZIP" icon="pi pi-download" class="p-button-sm p-button-outlined mt-dl-btn"
                    [loading]="exporting()" [disabled]="rs.total === 0" (click)="downloadExpediente()"></button>
          </div>
        }

        @if (reconLoading() && !recon()) {
          <div class="mt-dlg-skel">Cargando conciliación…</div>
        } @else {
          <p-table [value]="recon() || []" styleClass="p-datatable-sm mt-ctable" [rowHover]="true"
                   [scrollable]="true" scrollHeight="48vh" [paginator]="(recon()?.length || 0) > 25" [rows]="25">
            <ng-template pTemplate="header">
              <tr>
                <th style="width:3rem">Tipo</th>
                <th>CFDI</th>
                <th class="ta-r" style="width:8.5rem">Total</th>
                <th style="width:19rem">Operación que lo respalda</th>
                <th style="width:2.5rem"></th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-c>
              <tr [class.mt-row-busy]="busy() === c.cfdi_id">
                <td><span class="mt-conf">{{ c.tipo_comprobante || '—' }}</span></td>
                <td><div class="strong mono">{{ c.serie }}{{ c.folio || '' }} <span class="muted">· {{ c.fecha ? (c.fecha | date:'dd/MM/yy') : '—' }}</span></div><div class="muted mono cf-sub">{{ c.uuid }}</div></td>
                <td class="ta-r strong mono">{{ money(c.total) }}</td>
                <td>
                  @switch (c.status) {
                    @case ('confirmed') {
                      <div class="mt-asg">
                        <span class="mt-est e-vigente" title="Asignada por {{ c.assignment?.by || '—' }}"><i class="pi pi-check"></i> {{ c.assignment?.doc_folio }}</span>
                        <span class="muted cf-sub">{{ c.assignment?.sucursal }} · Δ {{ money(c.assignment?.diff_importe) }}@if (c.assignment?.diff_days != null) { · {{ c.assignment?.diff_days }}d }</span>
                        @if (canManage) { <button pButton type="button" label="Quitar" class="p-button-text p-button-sm mt-asg-x" [disabled]="busy() === c.cfdi_id" (click)="unassignRow(c)"></button> }
                      </div>
                    }
                    @case ('suggested') {
                      <div class="mt-asg">
                        @if (c.suggestion?.strength === 'weak') {
                          <span class="mt-conf c-weak" title="Match débil: la operación no tiene RFC; cruzada solo por importe+fecha. Valida el nombre antes de confirmar."><i class="pi pi-exclamation-triangle"></i> {{ c.suggestion?.doc_folio }}</span>
                        } @else {
                          <span class="mt-conf c-inferred" title="Sugerida por RFC + importe + fecha"><i class="pi pi-sparkles"></i> {{ c.suggestion?.doc_folio }}</span>
                        }
                        <span class="muted cf-sub">{{ c.suggestion?.sucursal }} · Δ {{ money(c.suggestion?.diff_importe) }}@if (c.suggestion?.diff_days != null) { · {{ c.suggestion?.diff_days }}d }@if (c.suggestion?.strength === 'weak') { · <b class="warn">sin RFC</b> }</span>
                        @if (c.suggestion?.strength === 'weak' && c.suggestion?.beneficiario) {
                          <span class="mt-asg-benef" title="Nombre en la operación — verifica que coincida con el proveedor"><i class="pi pi-user"></i> {{ c.suggestion?.beneficiario }}</span>
                        }
                        @if (canManage) {
                          <span class="mt-asg-acts">
                            <button pButton type="button" icon="pi pi-check" class="p-button-sm p-button-success mt-ico-btn" title="Confirmar asignación" aria-label="Confirmar" [disabled]="busy() === c.cfdi_id" (click)="confirmSuggestion(c)"></button>
                            <button pButton type="button" icon="pi pi-times" class="p-button-text p-button-sm p-button-secondary mt-ico-btn" title="Descartar sugerencia" aria-label="Descartar" [disabled]="busy() === c.cfdi_id" (click)="rejectSuggestion(c)"></button>
                          </span>
                        }
                      </div>
                    }
                    @default { <span class="muted cf-sub"><i class="pi pi-minus-circle"></i> Sin operación en ±$1 / ±5 días</span> }
                  }
                </td>
                <td class="ta-r">@if (c.has_xml) { <button pButton type="button" icon="pi pi-download" class="p-button-text p-button-sm" title="Descargar XML" aria-label="Descargar XML" (click)="downloadXml(c)"></button> }</td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage"><tr><td colspan="5" class="mt-dlg-empty">
              <i class="pi pi-inbox"></i> Sin CFDIs recibidos de este RFC. Corre la <strong>descarga masiva</strong> del SAT para poblarlos.
            </td></tr></ng-template>
          </p-table>
        }
        }
      </p-dialog>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .mt-search { display: flex; gap: .6rem; align-items: center; margin-bottom: 1rem; }
    .mt-skel, .mt-empty { padding: 2.5rem 1rem; text-align: center; color: var(--text-muted); }
    .mt-empty .pi { display: block; font-size: 1.6rem; margin-bottom: .5rem; opacity: .6; }
    .mt-veredicto { display: flex; gap: 1rem; align-items: center; border: 1px solid var(--border-color); border-radius: var(--r-lg, 14px); padding: 1rem 1.2rem; margin-bottom: 1rem; background: var(--card-bg); }
    .mt-veredicto.v-solida { border-color: color-mix(in srgb, var(--ok-fg, #16a34a) 45%, var(--border-color)); }
    .mt-veredicto.v-critico { border-color: color-mix(in srgb, var(--bad-fg, #dc2626) 50%, var(--border-color)); }
    .mt-veredicto.v-revisar { border-color: color-mix(in srgb, var(--warn-fg, #d97706) 50%, var(--border-color)); }
    .mt-v-badge { font-size: .72rem; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; padding: .3rem .7rem; border-radius: var(--r-pill, 999px); background: var(--surface-hover-bg, #f5f5f4); color: var(--text-muted); white-space: nowrap; }
    .v-solida .mt-v-badge { background: color-mix(in srgb, var(--ok-fg, #16a34a) 16%, transparent); color: var(--ok-fg, #16a34a); }
    .v-critico .mt-v-badge { background: color-mix(in srgb, var(--bad-fg, #dc2626) 16%, transparent); color: var(--bad-fg, #dc2626); }
    .v-revisar .mt-v-badge { background: color-mix(in srgb, var(--warn-fg, #d97706) 18%, transparent); color: var(--warn-soft-fg, #b45309); }
    .mt-v-title { font-size: .95rem; font-weight: 700; color: var(--text-main); }
    .mt-v-msg { font-size: .82rem; color: var(--text-muted); margin-top: .2rem; }
    app-metric-strip { display:block; margin-bottom: 1rem; }
    .mt-grid { display: grid; grid-template-columns: 1.3fr 1fr; gap: 1rem; }
    @media (max-width: 800px) { .mt-grid { grid-template-columns: 1fr; } }
    .mt-block { padding: 1rem; }
    .mt-block-title { margin: 0 0 .7rem; font-size: .85rem; font-weight: 700; color: var(--text-main); }
    .mt-chain { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
    .mt-chain .pi { color: var(--text-faint, #a8a29e); font-size: .8rem; }
    .mt-chain-step { display: flex; flex-direction: column; align-items: center; gap: .1rem; border: 1px solid var(--border-color); border-radius: var(--r-md, 10px); padding: .5rem .7rem; min-width: 4.5rem; opacity: .5; }
    .mt-chain-step.on { opacity: 1; border-color: color-mix(in srgb, var(--action) 30%, var(--border-color)); }
    .mt-chain-n { font-size: 1.05rem; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--text-main); font-family: var(--font-mono, monospace); }
    .mt-chain-step span:last-child { font-size: .68rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
    .mt-listas { list-style: none; margin: 0 0 .7rem; padding: 0; display: flex; flex-direction: column; gap: .35rem; }
    .mt-listas li { font-size: .82rem; color: var(--text-main); }
    .mt-lista-tag { display: inline-block; padding: .08rem .5rem; border-radius: var(--r-pill, 999px); font-size: .68rem; font-weight: 700; }
    .mt-lista-tag.risk { background: color-mix(in srgb, var(--bad-fg, #dc2626) 15%, transparent); color: var(--bad-fg, #dc2626); }
    .mt-lista-sit { font-weight: 600; text-transform: capitalize; }
    .mt-clean { font-size: .85rem; color: var(--ok-fg, #16a34a); display: flex; gap: .4rem; align-items: center; margin-bottom: .7rem; }
    .mt-cfdi-line { font-size: .8rem; color: var(--text-muted); border-top: 1px solid var(--border-color); padding-top: .6rem; }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .85em; } .muted { color: var(--text-muted); }
    /* MAT.2 — desglose de documentos */
    .mt-block-head { display: flex; align-items: center; justify-content: space-between; gap: .5rem; margin-bottom: .7rem; }
    .mt-block-head .mt-block-title { margin: 0; }
    .mt-chain.clickable { cursor: pointer; border-radius: var(--r-md, 10px); transition: background .15s ease; outline: none; padding: .3rem; margin: -.3rem; }
    .mt-chain.clickable:hover { background: var(--surface-hover-bg, #f5f5f4); }
    .mt-chain.clickable:focus-visible { box-shadow: 0 0 0 2px color-mix(in srgb, var(--action) 45%, transparent); }
    .mt-chain-hint { margin: .6rem 0 0; font-size: .72rem; color: var(--text-muted); display: flex; align-items: center; gap: .35rem; }
    .mt-chain-hint .pi { font-size: .8rem; }
    .ta-r { text-align: right; } .strong { font-weight: 700; color: var(--text-main); } .warn { color: var(--warn-soft-fg, #b45309); font-weight: 600; }
    .mt-dlg-head { display: flex; flex-direction: column; gap: .1rem; }
    .mt-dlg-title { font-size: .95rem; font-weight: 700; color: var(--text-main); }
    .mt-dlg-legend { font-size: .8rem; color: var(--text-muted); margin: 0 0 .8rem; line-height: 1.4; }
    .mt-dlg-skel, .mt-dlg-empty { padding: 2.2rem 1rem; text-align: center; color: var(--text-muted); }
    .mt-dlg-empty .pi { display: block; font-size: 1.4rem; margin-bottom: .4rem; opacity: .6; }
    .mt-ctable { font-variant-numeric: tabular-nums; }
    .cf-sub { font-size: .72rem; margin-top: .05rem; }
    .mt-tog { width: 2rem; height: 2rem; }
    .mt-dots { display: inline-flex; gap: .2rem; }
    .mt-dot { display: inline-flex; align-items: center; justify-content: center; width: 1.25rem; height: 1.25rem; border-radius: var(--r-sm, 6px); font-size: .62rem; font-weight: 800; background: var(--surface-hover-bg, #f5f5f4); color: var(--text-faint, #a8a29e); }
    .mt-dot.on { background: color-mix(in srgb, var(--ok-fg, #16a34a) 14%, transparent); color: var(--ok-fg, #16a34a); }
    .mt-conf { display: inline-block; padding: .1rem .5rem; border-radius: var(--r-pill, 999px); font-size: .66rem; font-weight: 700; background: var(--surface-hover-bg, #f5f5f4); color: var(--text-muted); }
    .mt-conf.c-exact { background: color-mix(in srgb, var(--ok-fg, #16a34a) 14%, transparent); color: var(--ok-fg, #16a34a); }
    .mt-conf.c-inferred { background: color-mix(in srgb, var(--warn-fg, #d97706) 16%, transparent); color: var(--warn-soft-fg, #b45309); }
    .mt-conf.c-weak { background: color-mix(in srgb, var(--warn-fg, #d97706) 10%, transparent); color: var(--warn-soft-fg, #b45309); border: 1px dashed color-mix(in srgb, var(--warn-fg, #d97706) 45%, transparent); }
    .mt-asg-benef { font-size: .7rem; color: var(--text-muted); display: inline-flex; align-items: center; gap: .25rem; max-width: 22ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mt-asg-benef .pi { font-size: .8em; }
    .mt-dlg-tabs { display: inline-flex; border: 1px solid var(--border-color); border-radius: var(--r-pill, 999px); overflow: hidden; margin-bottom: .8rem; }
    .mt-dlg-tabs button { border: none; background: var(--card-bg); padding: .4rem .9rem; font-size: .8rem; cursor: pointer; color: var(--text-muted); display: inline-flex; align-items: center; gap: .4rem; }
    .mt-dlg-tabs button + button { border-left: 1px solid var(--border-color); }
    .mt-dlg-tabs button.active { background: var(--action); color: var(--action-ink, #fff); font-weight: 600; }
    .mt-tab-n { font-variant-numeric: tabular-nums; font-size: .72rem; opacity: .85; }
    .mt-est { display: inline-block; padding: .1rem .5rem; border-radius: var(--r-pill, 999px); font-size: .66rem; font-weight: 700; }
    .mt-est.e-vigente { background: color-mix(in srgb, var(--ok-fg, #16a34a) 14%, transparent); color: var(--ok-fg, #16a34a); }
    .mt-est.e-cancelado { background: color-mix(in srgb, var(--bad-fg, #dc2626) 15%, transparent); color: var(--bad-fg, #dc2626); }
    .mt-est.e-desconocido { background: var(--surface-hover-bg, #f5f5f4); color: var(--text-muted); }
    .mt-recon-sum { display: flex; gap: .9rem; flex-wrap: wrap; align-items: center; margin-bottom: .7rem; font-size: .74rem; font-weight: 600; }
    .mt-dl-btn { margin-left: auto; }
    .mt-rs.ok { color: var(--ok-fg, #16a34a); } .mt-rs.warn { color: var(--warn-soft-fg, #b45309); } .mt-rs.muted { color: var(--text-muted); }
    .mt-asg { display: flex; align-items: center; gap: .45rem; flex-wrap: wrap; }
    .mt-asg-acts { display: inline-flex; gap: .2rem; }
    .mt-asg .mt-conf .pi, .mt-est .pi { font-size: .82em; }
    .mt-ico-btn { width: 1.9rem; height: 1.9rem; }
    .mt-row-busy { opacity: .5; }
    .mt-exp-row > td { background: var(--surface-hover-bg, #faf9f8); }
    .mt-timeline { display: flex; align-items: stretch; gap: .5rem; flex-wrap: wrap; padding: .3rem 0; }
    .mt-tl-step { display: flex; align-items: center; gap: .5rem; border: 1px solid var(--border-color); border-radius: var(--r-md, 10px); padding: .5rem .7rem; background: var(--card-bg); min-width: 12rem; flex: 1; }
    .mt-tl-step.off { opacity: .55; border-style: dashed; }
    .mt-tl-ico { display: inline-flex; align-items: center; justify-content: center; width: 1.9rem; height: 1.9rem; border-radius: var(--r-sm, 8px); background: var(--surface-hover-bg, #f5f5f4); color: var(--text-muted); flex-shrink: 0; }
    .mt-tl-ico.on { background: color-mix(in srgb, var(--action) 14%, transparent); color: var(--action); }
    .mt-tl-b { display: flex; flex-direction: column; gap: .05rem; min-width: 0; }
    .mt-tl-lbl { font-size: .66rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted); font-weight: 600; }
    .mt-tl-sep { color: var(--text-faint, #a8a29e); font-size: .75rem; align-self: center; }
    .mt-tl-meta { display: flex; gap: 1.2rem; margin-top: .5rem; font-size: .74rem; color: var(--text-muted); }
    @media (max-width: 640px) { .mt-tl-sep { display: none; } .mt-tl-step { min-width: 100%; } }
    /* MAT — descubrimiento de proveedores */
    .mt-disc { padding: 1rem 1.2rem 0; }
    .mt-disc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: .8rem; }
    .mt-disc-title { margin: 0; font-size: .95rem; font-weight: 700; color: var(--text-main); }
    .mt-disc-sub { margin: .15rem 0 0; font-size: .78rem; color: var(--text-muted); max-width: 62ch; }
    .mt-disc-filters { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
    .mt-disc-search input { min-width: 220px; }
    .mt-disc-table { font-variant-numeric: tabular-nums; }
    .mt-disc-row { cursor: pointer; }
    .mt-p-name { font-weight: 600; color: var(--text-main); max-width: 40ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mt-p-rfc { color: var(--text-muted); margin-top: .05rem; }
    .mt-r-tag { display: inline-block; padding: .1rem .5rem; border-radius: var(--r-pill, 999px); font-size: .66rem; font-weight: 700; }
    .mt-r-tag.risk { background: color-mix(in srgb, var(--bad-fg, #dc2626) 15%, transparent); color: var(--bad-fg, #dc2626); }
    .mt-r-tag.warn { background: color-mix(in srgb, var(--warn-fg, #d97706) 16%, transparent); color: var(--warn-soft-fg, #b45309); }
    .mt-warn { display: flex; align-items: center; gap: .4rem; font-size: .8rem; color: var(--warn-soft-fg, #b45309); background: color-mix(in srgb, var(--warn-fg, #d97706) 8%, transparent); border-radius: var(--r-sm, 8px); padding: .5rem .7rem; margin-bottom: .7rem; }
    .mt-empty2 { padding: 2.5rem 1rem; text-align: center; color: var(--text-muted); }
    .mt-empty2 .pi { display: block; font-size: 1.5rem; margin-bottom: .5rem; opacity: .6; }
  `],
})
export class ContabilidadMaterialidadComponent {
  readonly tabs = CONTABILIDAD_TABS;
  private readonly svc = inject(MaterialidadService);
  private readonly cfdiSvc = inject(CfdiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  /** Solo con permiso de gestión se puede confirmar/descartar asignaciones. */
  readonly canManage = this.auth.user()?.permissions?.[Permission.FISCAL_MATERIALIDAD_GESTIONAR] === true;

  rfc = '';
  readonly dossier = signal<MaterialidadDossier | null>(null);

  /** MAT — descubrimiento de proveedores: índice rankeado por riesgo para explorar sin teclear el RFC. */
  readonly providers = signal<MatProvider[]>([]);
  readonly provLoading = signal(false);
  readonly provSearch = signal('');
  readonly provRiesgo = signal<'all' | 'lista' | 'sin_recepcion'>('all');
  readonly riesgoOpts = [{ label: 'Todos', value: 'all' }, { label: 'En lista', value: 'lista' }, { label: 'Sin recepción', value: 'sin_recepcion' }];
  private provSearchT: ReturnType<typeof setTimeout> | null = null;

  /** MAT.2 — desglose de documentos de la cadena de suministro (diálogo). */
  readonly chainsOpen = signal(false);
  readonly chains = signal<MaterialidadChain[] | null>(null);
  readonly chainsLoading = signal(false);
  private chainsRfc = '';

  /** MAT.1 — tab fiscal: conciliación CFDI↔operación (asignación confirmada o sugerida). */
  readonly dlgTab = signal<'oper' | 'fiscal'>('oper');
  readonly recon = signal<MatReconcileRow[] | null>(null);
  readonly reconLoading = signal(false);
  readonly busy = signal<string | null>(null); // cfdi_id en curso (confirmar/descartar)
  readonly exporting = signal(false);
  private reconRfc = '';
  readonly reconSummary = computed(() => {
    const rows = this.recon() || [];
    return {
      total: rows.length,
      confirmed: rows.filter((r) => r.status === 'confirmed').length,
      suggested: rows.filter((r) => r.status === 'suggested').length,
      unmatched: rows.filter((r) => r.status === 'unmatched').length,
    };
  });

  /** KPIs de materialidad vía MetricStrip (sin caja). */
  kpiItems(d: MaterialidadDossier): MetricStripItem[] {
    const rec = d.cadena_suministro.recepcion_pct;
    return [
      { label: 'Operaciones', value: d.operaciones },
      { label: 'Monto total', value: d.monto_total, format: 'currency' },
      { label: 'Con recepción física', value: rec, format: 'percent', tone: rec >= 80 ? 'ok' : rec < 50 ? 'warn' : 'default' },
      { label: 'CFDI cancelados', value: d.cfdis.cancelados, tone: d.cfdis.cancelados > 0 ? 'bad' : 'default' },
    ];
  }
  readonly loading = signal(false);
  readonly searched = signal(false);

  constructor() {
    this.loadProviders();
    this.destroyRef.onDestroy(() => { if (this.provSearchT) clearTimeout(this.provSearchT); });
  }

  /** MAT — carga el índice de proveedores con el search + riesgo actuales. */
  loadProviders() {
    this.provLoading.set(true);
    this.svc.providers({ search: this.provSearch().trim() || undefined, riesgo: this.provRiesgo() === 'all' ? undefined : this.provRiesgo(), limit: 200 })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => { this.providers.set(r); this.provLoading.set(false); },
        error: () => { this.provLoading.set(false); },
      });
  }
  onProvSearch(v: string) { this.provSearch.set(v); if (this.provSearchT) clearTimeout(this.provSearchT); this.provSearchT = setTimeout(() => this.loadProviders(), 300); }
  setProvRiesgo(r: 'all' | 'lista' | 'sin_recepcion') { this.provRiesgo.set(r); this.loadProviders(); }
  pickProvider(rfc: string) { this.rfc = rfc; this.buscar(); }
  backToList() { this.dossier.set(null); this.searched.set(false); this.rfc = ''; this.loadProviders(); }

  rfcValid(): boolean { return /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/.test((this.rfc || '').toUpperCase()); }

  buscar() {
    if (!this.rfcValid()) { this.toast.add({ severity: 'warn', summary: 'RFC inválido', detail: 'Revisa el formato del RFC.' }); return; }
    this.loading.set(true); this.searched.set(true); this.dossier.set(null);
    this.chains.set(null); this.chainsRfc = ''; this.chainsOpen.set(false);
    this.recon.set(null); this.reconRfc = ''; this.dlgTab.set('oper'); this.busy.set(null);
    this.svc.dossier(this.rfc.toUpperCase()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.dossier.set(d); this.loading.set(false); },
      error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo armar el expediente.' }); },
    });
  }

  /** Abre el desglose de documentos; carga las cadenas del RFC (con cache por RFC). */
  openChains() {
    const d = this.dossier();
    if (!d || d.cadena_suministro.cadenas === 0) return;
    this.dlgTab.set('oper');
    this.chainsOpen.set(true);
    if (this.chains() && this.chainsRfc === d.rfc) return;
    this.chainsLoading.set(true); this.chainsRfc = d.rfc;
    this.svc.chains(d.rfc).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => { this.chains.set(rows); this.chainsLoading.set(false); },
      error: () => { this.chainsLoading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar los documentos.' }); },
    });
  }

  /** Cambia de tab; carga la conciliación del proveedor la 1a vez (cache por RFC). */
  setDlgTab(t: 'oper' | 'fiscal') {
    this.dlgTab.set(t);
    const d = this.dossier();
    if (t !== 'fiscal' || !d) return;
    if (this.recon() && this.reconRfc === d.rfc) return;
    this.loadRecon(d.rfc);
  }

  private loadRecon(rfc: string) {
    this.reconLoading.set(true); this.reconRfc = rfc;
    this.svc.reconcile(rfc).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => { this.recon.set(rows); this.reconLoading.set(false); },
      error: () => { this.reconLoading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar la conciliación.' }); },
    });
  }
  private reloadRecon() { const d = this.dossier(); if (d) this.loadRecon(d.rfc); }

  /** Confirma la operación sugerida como evidencia del CFDI. */
  confirmSuggestion(row: MatReconcileRow) {
    if (!this.canManage || !row.suggestion) return;
    const s = row.suggestion;
    this.busy.set(row.cfdi_id);
    this.svc.confirmAssign({ cfdi_id: row.cfdi_id, sucursal: s.sucursal, doc_tipo: s.doc_tipo, doc_folio: s.doc_folio })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => { this.busy.set(null); this.toast.add({ severity: 'success', summary: 'Asignada', detail: `CFDI ligado a ${s.doc_folio}.` }); this.reloadRecon(); },
        error: (e: any) => { this.busy.set(null); this.toast.add({ severity: 'error', summary: 'No se pudo asignar', detail: e?.error?.message || 'Intenta de nuevo.' }); },
      });
  }

  /** Descarta la sugerencia para que no vuelva a proponerse. */
  rejectSuggestion(row: MatReconcileRow) {
    if (!this.canManage || !row.suggestion) return;
    const s = row.suggestion;
    this.busy.set(row.cfdi_id);
    this.svc.rejectAssign({ cfdi_id: row.cfdi_id, sucursal: s.sucursal, doc_tipo: s.doc_tipo, doc_folio: s.doc_folio })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => { this.busy.set(null); this.reloadRecon(); },
        error: () => { this.busy.set(null); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo descartar.' }); },
      });
  }

  /** Revierte una asignación confirmada. */
  unassignRow(row: MatReconcileRow) {
    if (!this.canManage || !row.assignment) return;
    this.busy.set(row.cfdi_id);
    this.svc.unassign(row.assignment.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.busy.set(null); this.reloadRecon(); },
      error: () => { this.busy.set(null); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo revertir.' }); },
    });
  }

  /** Descarga el XML del CFDI (persistido en MAT.0). */
  downloadXml(row: MatReconcileRow) {
    this.cfdiSvc.xml(row.cfdi_id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (xml) => {
        const blob = new Blob([xml], { type: 'application/xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `${row.uuid || row.cfdi_id}.xml`; a.click();
        URL.revokeObjectURL(url);
      },
      error: () => this.toast.add({ severity: 'warn', summary: 'Sin documento', detail: 'Este CFDI no tiene XML guardado. Re-descarga el periodo.' }),
    });
  }

  /** MAT — descarga el expediente del proveedor: ZIP con los XML en carpeta por RFC. */
  downloadExpediente() {
    const d = this.dossier();
    if (!d) return;
    this.exporting.set(true);
    this.cfdiSvc.exportZip({ emisor_rfc: d.rfc, rol: 'recibidas' }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (blob) => {
        this.exporting.set(false);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `expediente-cfdi-${d.rfc}.zip`; a.click();
        URL.revokeObjectURL(url);
      },
      error: () => { this.exporting.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo generar el ZIP.' }); },
    });
  }

  confLabel(c: string | null): string { return c === 'exact' ? 'Directa' : c === 'inferred' ? 'Inferida' : c === 'partial' ? 'Parcial' : '—'; }
  estatusLabel(e: string): string { return e === 'vigente' ? 'Vigente' : e === 'cancelado' ? 'Cancelado' : 'Sin verificar'; }

  veredictoLabel(n: string): string { return n === 'solida' ? 'Sólida' : n === 'critico' ? 'Crítico' : n === 'revisar' ? 'Revisar' : 'Parcial'; }
  listaLabel(l: string): string { return l === '69B' ? 'EFOS 69-B' : l === '69' ? 'Art. 69' : l; }
  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
