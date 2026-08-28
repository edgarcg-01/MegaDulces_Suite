import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import { DatePickerModule } from 'primeng/datepicker';
import { ProductSearchComponent, ProductHit } from '../../comercial/components/product-search.component';
import { ReceivingSessionService, ReceivingSession, ReceivingLine, DiscrepancyKind } from '../receiving-session.service';
import { ReceivingAuditorService, ReceivingCapture } from '../receiving-auditor.service';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';

/**
 * Fase WMS-REC (Pieza 1 + 2, ADR-044) — Estación de recepción (handheld). Escaneo
 * caja→pieza contra lo esperado, con "qué falta validar" en vivo + faltantes/sobrantes,
 * y **declaración de lotes por renglón**: un SKU puede desglosarse en N lotes, cada uno
 * con su código y caducidad, y el sistema muestra cuánto de lo recibido sigue sin declarar.
 *
 * El veredicto es POR LOTE (no por renglón): verde/amarillo entran a stock, el rojo queda
 * retenido esperando autorización de un supervisor y bloquea el cierre del vale.
 */
@Component({
  selector: 'app-almacen-recepcion-sesion',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, SelectModule, InputTextModule, ToastModule, ConfirmDialogModule, DatePickerModule, ProductSearchComponent, SidePeekComponent],
  providers: [MessageService, ConfirmationService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <p-confirmdialog></p-confirmdialog>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <button pButton [text]="true" size="small" severity="secondary" (click)="back()"><span class="p-button-icon p-button-icon-left pi pi-arrow-left" aria-hidden="true"></span> Vales</button>
          <h1>{{ session()?.folio || 'Sesión' }}
            @if (session(); as s) { <p-tag [value]="statusLabel(s.status)" [severity]="statusSeverity(s.status)"></p-tag> }
          </h1>
          <p class="surf-page-sub">
            {{ session()?.warehouse_code }} · {{ session()?.warehouse_name }}
            @if (session()?.supplier_code) { · Prov {{ session()?.supplier_code }} }
            @if (session()?.source_ref) { · ERP {{ session()?.source_ref }} }
          </p>
        </div>
        @if (isOpen()) {
          <div class="rsd-head-actions">
            <button pButton size="small" severity="secondary" [outlined]="true" (click)="confirmCancel()"><span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span> Cancelar</button>
            <button pButton size="small" (click)="confirmClose()" [loading]="closing()"><span class="p-button-icon p-button-icon-left pi pi-check-circle" aria-hidden="true"></span> Cerrar sesión</button>
          </div>
        }
      </header>

      @if (session()?.erp; as v) {
        <section class="rsd-vale surf-card">
          <header class="rsd-vale-head">
            <h2>Vale del ERP {{ v.sucursal }} · {{ v.folio }}</h2>
            <p-tag [value]="v.tipo === 'traspaso' ? 'Traspaso' : 'Compra'" [severity]="v.tipo === 'traspaso' ? 'warn' : 'info'"></p-tag>
            <span class="rsd-vale-monto">{{ v.monto | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
          </header>
          <dl class="rsd-vale-grid">
            <div><dt>{{ v.tipo === 'traspaso' ? 'Sucursal origen' : 'Proveedor' }}</dt>
                 <dd>{{ v.proveedor_nombre || v.proveedor_code || '—' }}
                     @if (v.proveedor_code) { <span class="rsd-vale-code">{{ v.proveedor_code }}</span> }</dd></div>
            @if (v.proveedor_rfc) { <div><dt>RFC</dt><dd class="rsd-mono">{{ v.proveedor_rfc }}</dd></div> }
            @if (v.receipt_date) { <div><dt>Fecha</dt><dd>{{ fmtDate(v.receipt_date) }}</dd></div> }
            @if (v.oc_folio) { <div><dt>Orden de compra</dt><dd class="rsd-mono">{{ v.oc_folio }}</dd></div> }
            @if (v.vale_folio) { <div><dt>Vale de entrada</dt><dd class="rsd-mono">{{ v.vale_folio }}</dd></div> }
            @if (v.concepto) { <div><dt>Concepto</dt><dd>{{ v.concepto }}</dd></div> }
          </dl>
          @if (v.services?.length) {
            <p class="rsd-vale-serv">
              <i class="pi pi-info-circle" aria-hidden="true"></i>
              Este vale también trae {{ v.services!.length }} servicio(s) — flete o maniobra. No son mercancía: no se reciben ni se ubican.
            </p>
          }
        </section>
      }

      @if (session()?.progress; as pr) {
        <div class="rsd-kpis">
          <div class="rsd-kpi"><span class="rsd-kpi-n">{{ pr.lines }}</span><span class="rsd-kpi-l">líneas</span></div>
          <div class="rsd-kpi" [class.rsd-warn]="pr.pending > 0"><span class="rsd-kpi-n">{{ pr.pending }}</span><span class="rsd-kpi-l">por validar</span></div>
          <div class="rsd-kpi" [class.rsd-bad]="pr.discrepancies > 0"><span class="rsd-kpi-n">{{ pr.discrepancies }}</span><span class="rsd-kpi-l">discrepancias</span></div>
          <div class="rsd-kpi"><span class="rsd-kpi-n">{{ pr.received_units }}/{{ pr.expected_units }}</span><span class="rsd-kpi-l">unidades</span></div>
          <div class="rsd-kpi" [class.rsd-warn]="(pr.undeclared_units || 0) > 0"><span class="rsd-kpi-n">{{ pr.undeclared_units || 0 }}</span><span class="rsd-kpi-l">sin declarar</span></div>
          <div class="rsd-kpi" [class.rsd-bad]="(pr.holds || 0) > 0"><span class="rsd-kpi-n">{{ pr.held_units || 0 }}</span><span class="rsd-kpi-l">retenidas</span></div>
        </div>
        @if ((pr.sin_catalogo || 0) > 0) {
          <div class="rsd-hold-banner" role="status">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            <span><strong>{{ pr.sin_catalogo }}</strong> renglón(es) recibidos no existen en el catálogo de productos:
              esa mercancía <strong>no entrará a inventario</strong> al cerrar. Hay que darla de alta en el catálogo primero.</span>
          </div>
        }
        @if ((pr.holds || 0) > 0) {
          <div class="rsd-hold-banner" role="status">
            <i class="pi pi-lock" aria-hidden="true"></i>
            <span><strong>{{ pr.holds }}</strong> captura(s) de lote retenidas por caducidad. No entraron a inventario y el vale no se puede cerrar hasta autorizarlas o rechazarlas.</span>
          </div>
        }
      }

      @if (isOpen()) {
        <div class="rsd-scan surf-card">
          <label class="rsd-scan-field">
            <span>Escanear código de barras / SKU</span>
            <div class="rsd-scan-row">
              <input pInputText [(ngModel)]="scanCode" (keyup.enter)="onScan()" placeholder="Escaneá o tecleá y Enter" autofocus [disabled]="scanning()" />
              <input pInputText type="number" min="1" [(ngModel)]="scanQty" class="rsd-qty" title="Cantidad" />
              <button pButton (click)="onScan()" [loading]="scanning()"><span class="p-button-icon pi pi-barcode" aria-hidden="true"></span></button>
            </div>
          </label>
          <div class="rsd-add">
            <app-product-search (productSelected)="addProduct = $event"></app-product-search>
            <input pInputText type="number" min="0" [(ngModel)]="addExpected" class="rsd-qty" placeholder="Esperado" title="Cantidad esperada" />
            <button pButton [text]="true" severity="secondary" size="small" (click)="onAddLine()" [disabled]="!addProduct"><span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span> Agregar línea</button>
          </div>
        </div>
      }

      <p-table [value]="lines()" styleClass="p-datatable-sm surf-table surf-table--zebra" [scrollable]="true" scrollHeight="flex">
        <ng-template #header>
          <tr>
            <th scope="col">SKU</th><th scope="col">Producto</th>
            <th scope="col" class="num">Esperado</th><th scope="col">Unidad</th>
            <th scope="col" class="num">Recibido</th><th scope="col" class="num">Declarado</th>
            <th scope="col">Estado</th><th scope="col"></th>
          </tr>
        </ng-template>
        <ng-template #body let-l>
          <tr [class.rsd-row-disc]="isDiscrepancy(l.discrepancy_kind)">
            <td class="rsd-mono">{{ l.sku || l.expected_sku || '—' }}</td>
            <td class="rsd-name">{{ l.product_name || l.expected_name || l.product_id || '—' }}</td>
            <td class="num">{{ l.expected_qty | number }}</td>
            <td class="rsd-unit" [class.rsd-unit-amb]="l.expected_unit === 'ambigua'">
              @if (l.expected_unit === 'ambigua') {
                <span title="El vale trae este producto con más de una unidad: confirmá cuál corresponde">⚠ ambigua</span>
              } @else { {{ l.expected_unit || '—' }} }
            </td>
            <td class="num rsd-rec">{{ l.received_qty | number }}</td>
            <td class="num rsd-decl" [class.rsd-decl-gap]="undeclared(l) > 0">
              {{ declared(l) | number }}
              @if (undeclared(l) > 0) { <span class="rsd-gap">faltan {{ undeclared(l) | number }}</span> }
              @if (l.holds) { <span class="rsd-held">{{ l.holds }} retenida(s)</span> }
            </td>
            <td><p-tag [value]="discLabel(l.discrepancy_kind)" [severity]="discSeverity(l.discrepancy_kind)"></p-tag></td>
            <td class="rsd-actions">
              @if (isOpen() && l.product_id) {
                <button pButton size="small" [text]="true" [severity]="undeclared(l) > 0 ? 'warn' : 'secondary'" (click)="openLots(l)" title="Declarar lotes y caducidad">
                  <span class="pi pi-calendar-clock" aria-hidden="true"></span>
                </button>
              }
              @if (isOpen()) {
                <button pButton size="small" [text]="true" severity="secondary" (click)="adjust(l, -1)" title="-1"><span class="pi pi-minus" aria-hidden="true"></span></button>
                <button pButton size="small" [text]="true" severity="secondary" (click)="adjust(l, 1)" title="+1"><span class="pi pi-plus" aria-hidden="true"></span></button>
                <p-select [options]="markOptions" [ngModel]="null" (onChange)="mark(l, $event.value)" placeholder="⚑" styleClass="rsd-mark" [showClear]="false"></p-select>
              }
            </td>
          </tr>
        </ng-template>
        <ng-template #emptymessage>
          <tr><td colspan="6" class="comm-empty-cell"><div class="comm-empty"><h3>Sin líneas</h3><p>Escaneá productos o agregá líneas esperadas.</p></div></td></tr>
        </ng-template>
      </p-table>

      <!-- ADR-044 — declaración de lotes del renglón: N lotes por SKU, veredicto por lote -->
      <app-side-peek
        [(open)]="lotsOpen"
        [width]="560"
        [title]="lotLine()?.sku || lotLine()?.expected_sku || 'Lotes'"
        [subtitle]="lotSubtitle()"
      >
        @if (lotLine(); as l) {
          <div class="rlp">
            <div class="rlp-tally" [class.rlp-tally-gap]="undeclared(l) > 0">
              <span>Recibido <strong>{{ l.received_qty | number }}</strong></span>
              <span>Declarado <strong>{{ declared(l) | number }}</strong></span>
              <span class="rlp-pend">Faltan <strong>{{ undeclared(l) | number }}</strong></span>
            </div>

            <section class="rlp-form">
              <h3>Agregar lote</h3>
              <label class="rlp-f">
                <span>Foto de la caducidad <em>(opcional — el OCR propone, vos confirmás)</em></span>
                <!-- El input nativo muestra "Choose File / No file chosen" en el idioma del
                     navegador (no se puede traducir). Se oculta y se dispara desde un label
                     estilado, que además da un target táctil decente en la rampa. -->
                <span class="rlp-file">
                  <input #photoInput type="file" accept="image/*" capture="environment" (change)="onPhoto($event)" [disabled]="ocrBusy()" hidden />
                  <button pButton type="button" [outlined]="true" severity="secondary" size="small" (click)="photoInput.click()" [disabled]="ocrBusy()">
                    <span class="p-button-icon p-button-icon-left pi pi-camera" aria-hidden="true"></span>
                    {{ photoName() ? 'Cambiar foto' : 'Tomar o elegir foto' }}
                  </button>
                  @if (photoName()) { <span class="rlp-file-name">{{ photoName() }}</span> }
                </span>
              </label>
              @if (ocrBusy()) { <p class="rlp-ocr">Leyendo la etiqueta…</p> }
              @if (ocrDone()) {
                <p class="rlp-ocr">
                  OCR: lote <strong>{{ ocrLot() || '—' }}</strong> · caducidad <strong>{{ ocrExpiry() || '—' }}</strong>
                  @if (ocrConfidence() !== null) { · confianza {{ (ocrConfidence()! * 100) | number:'1.0-0' }}% }
                  @if ((ocrConfidence() ?? 0) < 0.7) { <em> — confianza baja, verificá a mano</em> }
                </p>
              }
              <label class="rlp-f">
                <span>Lote del proveedor</span>
                <input pInputText [(ngModel)]="lotCode" placeholder="Ej. L2026A-14 · vacío = NA" />
              </label>
              <label class="rlp-f">
                <span>Caducidad</span>
                <div class="rlp-date">
                  <input pInputText [(ngModel)]="lotExpiryText" placeholder="DD/MM/AAAA o MM/AAAA" inputmode="numeric" (blur)="normalizeExpiry()" />
                  <p-datepicker [(ngModel)]="lotExpiryDate" dateFormat="dd/mm/yy" [showIcon]="true" [iconDisplay]="'input'" appendTo="body" (onSelect)="onPickDate()"></p-datepicker>
                </div>
                <em class="rlp-hint">Sólo mes y año (MM/AAAA) se toma como el último día del mes.</em>
              </label>
              <label class="rlp-f">
                <span>Cantidad de ESTE lote</span>
                <input pInputText type="number" min="1" [(ngModel)]="lotQty" />
              </label>
              <div class="rlp-actions">
                <button pButton (click)="declareLot()" [loading]="declaring()" [disabled]="!canDeclare()">
                  <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span> Declarar lote
                </button>
                <button pButton [text]="true" severity="secondary" (click)="resetLotForm()">Limpiar</button>
              </div>
            </section>

            <section class="rlp-list">
              <h3>Lotes declarados ({{ captures().length }})</h3>
              @if (!captures().length) {
                <p class="rlp-none">Ninguno todavía. Este renglón entró a inventario sin trazabilidad de caducidad.</p>
              }
              @for (c of captures(); track c.id) {
                <article class="rlp-item" [class.rlp-red]="c.verdict === 'red'">
                  <div class="rlp-item-head">
                    <p-tag [value]="verdictLabel(c.verdict)" [severity]="verdictSeverity(c.verdict)"></p-tag>
                    <span class="rlp-item-lot">{{ c.confirmed_lot || 'NA' }}</span>
                    <span class="rlp-item-qty">{{ c.quantity | number }} u</span>
                  </div>
                  <div class="rlp-item-meta">
                    <span>Vence {{ fmtDate(c.confirmed_expiry) }}</span>
                    @if (c.days_of_life !== null && c.days_of_life !== undefined) { <span>{{ c.days_of_life }} d de vida</span> }
                    @if (c.rule_broken) { <span class="rlp-rule">{{ ruleLabel(c.rule_broken) }}</span> }
                  </div>
                  @if (c.status === 'pending_authorization') {
                    <div class="rlp-item-hold">
                      <span>Retenido — no entró a inventario</span>
                      <button pButton size="small" severity="danger" [outlined]="true" (click)="authorize(c)">Autorizar</button>
                      <button pButton size="small" [text]="true" severity="secondary" (click)="reject(c)">Rechazar</button>
                    </div>
                  }
                </article>
              }
            </section>
          </div>
        }
      </app-side-peek>
    </div>
  `,
  styles: [`
    .surf-page-head-text h1 { display: flex; align-items: center; gap: .6rem; }
    .rsd-head-actions { display: flex; gap: .5rem; align-items: center; }
    .surf-card { background: var(--surface-card, var(--surface-0)); border: 1px solid var(--surface-border); border-radius: var(--radius-lg, 12px); padding: 1rem; margin-bottom: 1rem; }
    .rsd-kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: .75rem; margin: 0 0 1rem; }
    .rsd-kpi { background: var(--surface-card, var(--surface-0)); border: 1px solid var(--surface-border); border-radius: 10px; padding: .6rem .8rem; display: flex; flex-direction: column; }
    .rsd-kpi-n { font-size: 1.4rem; font-weight: 800; font-variant-numeric: tabular-nums; }
    .rsd-kpi-l { font-size: .74rem; color: var(--text-color-secondary); text-transform: uppercase; letter-spacing: .04em; }
    .rsd-kpi.rsd-warn .rsd-kpi-n { color: var(--warn-fg, #b45309); }
    .rsd-kpi.rsd-bad .rsd-kpi-n { color: var(--bad-fg, #b91c1c); }
    .rsd-scan-field { display: flex; flex-direction: column; gap: .25rem; }
    .rsd-scan-field > span { font-size: .8rem; color: var(--text-color-secondary); font-weight: 600; }
    .rsd-scan-row { display: flex; gap: .5rem; }
    .rsd-scan-row > input[pInputText]:first-child { flex: 1; font-size: 1.05rem; }
    .rsd-qty { max-width: 90px; }
    .rsd-add { display: flex; gap: .5rem; align-items: center; margin-top: .75rem; flex-wrap: wrap; }
    .rsd-mono { font-family: var(--font-mono, monospace); }
    .rsd-name { max-width: 300px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rsd-rec { font-weight: 700; }
    .rsd-actions { display: flex; gap: .25rem; align-items: center; }
    :host ::ng-deep .rsd-mark { min-width: 64px; }
    .rsd-row-disc { background: var(--warn-soft-bg, #fffbeb); }
    .rsd-unit { font-family: var(--font-mono, monospace); font-size: .8rem; color: var(--text-color-secondary); }
    .rsd-unit-amb { color: var(--warn-fg, #b45309); font-weight: 600; font-family: inherit; }
    .rsd-vale { margin-bottom: 1rem; }
    .rsd-vale-head { display: flex; align-items: center; gap: .6rem; margin-bottom: .6rem; }
    .rsd-vale-head h2 { font-size: .95rem; margin: 0; }
    .rsd-vale-monto { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 800; }
    .rsd-vale-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: .6rem 1rem; margin: 0; }
    .rsd-vale-grid dt { font-size: .68rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-color-secondary); }
    .rsd-vale-grid dd { margin: .1rem 0 0; font-size: .86rem; }
    .rsd-vale-code { font-family: var(--font-mono, monospace); font-size: .72rem; color: var(--text-color-secondary); margin-left: .3rem; }
    .rsd-vale-serv { display: flex; align-items: center; gap: .4rem; margin: .7rem 0 0; font-size: .76rem; color: var(--text-color-secondary); }
    .rsd-kpis { grid-template-columns: repeat(6, minmax(0, 1fr)); }
    @media (max-width: 900px) { .rsd-kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    .rsd-hold-banner { display: flex; align-items: center; gap: .55rem; margin: 0 0 1rem; padding: .6rem .8rem;
      border: 1px solid var(--bad-border, #fecaca); border-radius: 10px; background: var(--bad-soft-bg, #fef2f2);
      font-size: .84rem; color: var(--text-color); }
    .rsd-decl { font-variant-numeric: tabular-nums; }
    .rsd-decl-gap { color: var(--warn-fg, #b45309); font-weight: 700; }
    .rsd-gap, .rsd-held { display: block; font-size: .68rem; font-weight: 600; letter-spacing: .02em; }
    .rsd-gap { color: var(--warn-fg, #b45309); }
    .rsd-held { color: var(--bad-fg, #b91c1c); }
    /* Panel de lotes (side-peek) */
    .rlp { display: flex; flex-direction: column; gap: 1rem; }
    .rlp-tally { display: flex; gap: 1rem; flex-wrap: wrap; padding: .6rem .75rem; border: 1px solid var(--surface-border);
      border-radius: 10px; font-size: .85rem; position: sticky; top: 0; z-index: 1;
      background: var(--surface-card, var(--surface-0)); font-variant-numeric: tabular-nums; }
    .rlp-tally-gap { border-color: var(--warn-border, #fde68a); }
    .rlp-tally-gap .rlp-pend { color: var(--warn-fg, #b45309); }
    .rlp h3 { font-size: .82rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-color-secondary); margin: 0 0 .6rem; }
    .rlp-f { display: flex; flex-direction: column; gap: .25rem; margin-bottom: .7rem; }
    .rlp-f > span { font-size: .8rem; font-weight: 600; }
    .rlp-f em, .rlp-hint { font-weight: 400; font-style: normal; color: var(--text-color-secondary); font-size: .72rem; }
    .rlp-date { display: flex; gap: .5rem; align-items: center; }
    .rlp-date > input { flex: 1; }
    .rlp-ocr { font-size: .78rem; color: var(--text-color-secondary); margin: 0 0 .6rem; }
    .rlp-file { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
    .rlp-file-name { font-size: .74rem; color: var(--text-color-secondary); overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
    .rlp-actions { display: flex; gap: .5rem; margin-top: .3rem; }
    .rlp-item { border: 1px solid var(--surface-border); border-radius: 10px; padding: .55rem .7rem; margin-bottom: .5rem; }
    .rlp-item.rlp-red { border-color: var(--bad-border, #fecaca); }
    .rlp-item-head { display: flex; align-items: center; gap: .5rem; }
    .rlp-item-lot { font-family: var(--font-mono, monospace); font-weight: 700; }
    .rlp-item-qty { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 700; }
    .rlp-item-meta { display: flex; gap: .75rem; flex-wrap: wrap; font-size: .74rem; color: var(--text-color-secondary); margin-top: .25rem; }
    .rlp-rule { color: var(--bad-fg, #b91c1c); }
    .rlp-item-hold { display: flex; align-items: center; gap: .5rem; margin-top: .5rem; font-size: .76rem; color: var(--bad-fg, #b91c1c); flex-wrap: wrap; }
    .rlp-none { font-size: .8rem; color: var(--text-color-secondary); }
    @media (pointer: coarse) {
      .rlp-f input[pInputText] { min-height: 44px; }
      .rlp-actions button { min-height: 44px; }
    }
  `],
})
export class AlmacenRecepcionSesionComponent implements OnInit {
  private readonly svc = inject(ReceivingSessionService);
  private readonly auditor = inject(ReceivingAuditorService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly destroyRef = inject(DestroyRef);

  readonly session = signal<ReceivingSession | null>(null);
  readonly lines = computed<ReceivingLine[]>(() => this.session()?.lines || []);
  readonly scanning = signal(false);
  readonly closing = signal(false);
  scanCode = '';
  scanQty = 1;
  addProduct: ProductHit | null = null;
  addExpected: number | null = null;

  // ── Panel de lotes por renglón (ADR-044) ─────────────────────────────────
  readonly lotsOpen = signal(false);
  readonly lotLine = signal<ReceivingLine | null>(null);
  readonly captures = signal<ReceivingCapture[]>([]);
  readonly declaring = signal(false);
  readonly ocrBusy = signal(false);
  readonly ocrDone = signal(false);
  readonly ocrLot = signal<string | null>(null);
  readonly ocrExpiry = signal<string | null>(null);
  readonly ocrConfidence = signal<number | null>(null);
  readonly photoName = signal<string | null>(null);
  lotCode = '';
  lotExpiryText = '';
  lotExpiryDate: Date | null = null;
  lotQty: number | null = null;
  private photoDataUri: string | null = null;

  readonly lotSubtitle = computed(() => {
    const l = this.lotLine();
    if (!l) return null;
    return `${l.product_name || l.expected_name || ''} · recibido ${Number(l.received_qty) || 0}, declarado ${this.declared(l)}`;
  });

  readonly markOptions = [
    { label: 'Dañado', value: 'dañado' },
    { label: 'Producto incorrecto', value: 'producto_incorrecto' },
  ];

  private sessionId = '';

  ngOnInit(): void {
    this.sessionId = this.route.snapshot.paramMap.get('id') || '';
    if (this.sessionId) this.refresh();
  }

  isOpen(): boolean { return this.session()?.status === 'open'; }

  private refresh(): void {
    this.svc.detail(this.sessionId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => this.session.set(s),
      error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo cargar' }),
    });
  }

  onScan(): void {
    const code = this.scanCode.trim();
    if (!code) return;
    const qty = Number(this.scanQty) > 0 ? Number(this.scanQty) : 1;
    this.scanning.set(true);
    this.svc.scan(this.sessionId, { barcode: code, qty }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => { this.session.set(s); this.scanCode = ''; this.scanQty = 1; this.scanning.set(false); },
      error: (e) => { this.scanning.set(false); this.toast.add({ severity: 'warn', summary: 'Escaneo', detail: e?.error?.message || `Sin producto para '${code}'` }); },
    });
  }

  onAddLine(): void {
    if (!this.addProduct) return;
    this.svc.addLine(this.sessionId, { product_id: this.addProduct.id, expected_qty: this.addExpected ? Number(this.addExpected) : 0 })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (s) => { this.session.set(s); this.addProduct = null; this.addExpected = null; },
        error: (e) => this.toast.add({ severity: 'warn', summary: 'Agregar', detail: e?.error?.message || 'No se pudo agregar' }),
      });
  }

  adjust(line: ReceivingLine, delta: number): void {
    const received = Math.max(0, Number(line.received_qty) + delta);
    this.svc.setLine(this.sessionId, line.id, { received_qty: received }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => this.session.set(s),
      error: (e) => this.toast.add({ severity: 'warn', summary: 'Ajuste', detail: e?.error?.message || 'No se pudo ajustar' }),
    });
  }

  mark(line: ReceivingLine, kind: DiscrepancyKind): void {
    if (!kind) return;
    this.svc.setLine(this.sessionId, line.id, { discrepancy_kind: kind }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => this.session.set(s),
      error: (e) => this.toast.add({ severity: 'warn', summary: 'Marca', detail: e?.error?.message || 'No se pudo marcar' }),
    });
  }

  confirmClose(): void {
    this.confirm.confirm({
      message: '¿Cerrar la sesión? Las líneas esperadas sin recibir quedarán como faltante.',
      header: 'Cerrar sesión', icon: 'pi pi-check-circle',
      accept: () => this.doClose(),
    });
  }
  private doClose(): void {
    this.closing.set(true);
    this.svc.close(this.sessionId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => { this.session.set(s); this.closing.set(false); this.toast.add({ severity: 'success', summary: 'Sesión cerrada' }); },
      error: (e) => { this.closing.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo cerrar' }); },
    });
  }

  confirmCancel(): void {
    this.confirm.confirm({
      message: '¿Cancelar la sesión? No se registrará como recepción.',
      header: 'Cancelar sesión', icon: 'pi pi-exclamation-triangle',
      accept: () => {
        this.svc.cancel(this.sessionId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
          next: (s) => { this.session.set(s); this.toast.add({ severity: 'info', summary: 'Sesión cancelada' }); },
          error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo cancelar' }),
        });
      },
    });
  }

  // ── Declaración de lotes por renglón (ADR-044) ───────────────────────────

  /** Σ declarada del renglón. `numeric` de Postgres llega como string → coercionar. */
  declared(l: ReceivingLine): number { return Number(l.declared_qty ?? 0) || 0; }
  /** Piezas recibidas que todavía no tienen lote+caducidad declarados. */
  undeclared(l: ReceivingLine): number {
    return Math.max(0, (Number(l.received_qty) || 0) - this.declared(l));
  }

  openLots(line: ReceivingLine): void {
    this.lotLine.set(line);
    this.resetLotForm();
    this.lotQty = this.undeclared(line) || null;
    this.captures.set([]);
    this.lotsOpen.set(true);
    this.loadCaptures(line.id);
  }

  private loadCaptures(lineId: string): void {
    this.auditor.listCaptures({ receiving_line_id: lineId }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => this.captures.set(rows),
      error: () => this.captures.set([]),
    });
  }

  resetLotForm(): void {
    this.lotCode = '';
    this.lotExpiryText = '';
    this.lotExpiryDate = null;
    this.lotQty = null;
    this.photoDataUri = null;
    this.photoName.set(null);
    this.ocrDone.set(false);
    this.ocrLot.set(null);
    this.ocrExpiry.set(null);
    this.ocrConfidence.set(null);
  }

  onPhoto(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.photoName.set(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      this.photoDataUri = String(reader.result || '');
      if (!this.photoDataUri) return;
      this.ocrBusy.set(true);
      this.auditor.ocr(this.photoDataUri).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.ocrBusy.set(false);
          this.ocrDone.set(true);
          this.ocrLot.set(r.lot_code ?? null);
          this.ocrExpiry.set(r.expiry_date ?? null);
          this.ocrConfidence.set(r.confidence ?? null);
          // El OCR PROPONE: precarga los campos, la persona confirma (ADR-016).
          if (r.lot_code && !this.lotCode) this.lotCode = r.lot_code;
          if (r.expiry_date && !this.lotExpiryText) {
            this.lotExpiryText = this.toDisplay(r.expiry_date);
            this.lotExpiryDate = new Date(r.expiry_date + 'T00:00:00');
          }
        },
        error: () => {
          this.ocrBusy.set(false);
          this.toast.add({ severity: 'warn', summary: 'OCR', detail: 'No se pudo leer la etiqueta — capturá a mano' });
        },
      });
    };
    reader.readAsDataURL(file);
  }

  onPickDate(): void {
    if (this.lotExpiryDate) this.lotExpiryText = this.toDisplay(this.toIso(this.lotExpiryDate)!);
  }

  /**
   * Normaliza lo tecleado. `MM/AAAA` (frecuente en dulcería) → ÚLTIMO día del mes:
   * lectura conservadora, no acorta vida útil que el proveedor sí entregó (ADR-044).
   */
  normalizeExpiry(): void {
    const raw = (this.lotExpiryText || '').trim();
    if (!raw) { this.lotExpiryDate = null; return; }
    const digits = raw.replace(/[^0-9]/g, '');
    let y: number | null = null;
    let m: number | null = null;
    let d: number | null = null;
    if (digits.length === 6) {
      m = Number(digits.slice(0, 2)); y = Number(digits.slice(2, 6));
    } else if (digits.length === 8) {
      d = Number(digits.slice(0, 2)); m = Number(digits.slice(2, 4)); y = Number(digits.slice(4, 8));
    } else {
      return;
    }
    if (!y || !m || m < 1 || m > 12) return;
    if (d == null) d = new Date(y, m, 0).getDate(); // último día del mes
    const dt = new Date(y, m - 1, d);
    this.lotExpiryDate = dt;
    this.lotExpiryText = this.toDisplay(this.toIso(dt)!);
  }

  private toIso(d: Date | null): string | null {
    if (!d) return null;
    const p = (n: number) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  private toDisplay(iso: string): string {
    const parts = iso.split('-');
    return parts[2] + '/' + parts[1] + '/' + parts[0];
  }

  canDeclare(): boolean {
    return !!this.lotLine() && Number(this.lotQty) > 0 && !this.declaring();
  }

  declareLot(): void {
    const line = this.lotLine();
    const session = this.session();
    if (!line || !line.product_id || !session) return;
    this.normalizeExpiry();
    const qty = Number(this.lotQty);
    if (!(qty > 0)) return;
    this.declaring.set(true);
    this.auditor.evaluate({
      warehouse_id: session.warehouse_id,
      product_id: line.product_id,
      receiving_line_id: line.id,
      supplier_code: session.supplier_code || undefined,
      source_ref: session.folio,
      quantity: qty,
      confirmed_lot: this.lotCode.trim() || undefined,
      confirmed_expiry: this.toIso(this.lotExpiryDate) || undefined,
      ocr_lot: this.ocrLot() || undefined,
      ocr_expiry: this.ocrExpiry() || undefined,
      ocr_confidence: this.ocrConfidence() ?? undefined,
      photo_data_uri: this.photoDataUri || undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (cap) => {
        this.declaring.set(false);
        this.resetLotForm();
        this.toast.add({
          severity: cap.verdict === 'red' ? 'error' : cap.verdict === 'yellow' ? 'warn' : 'success',
          summary: this.verdictToast(cap.verdict),
          detail: cap.verdict === 'red'
            ? 'Retenido: no entró a inventario hasta que un supervisor autorice.'
            : 'Entró a inventario y ya alimenta FEFO.',
        });
        this.afterLotChange(line.id);
      },
      error: (e) => {
        this.declaring.set(false);
        this.toast.add({ severity: 'error', summary: 'No se pudo declarar', detail: e?.error?.message || 'Error' });
      },
    });
  }

  authorize(c: ReceivingCapture): void {
    this.confirm.confirm({
      message: '¿Autorizar el lote ' + (c.confirmed_lot || 'NA') + ' (' + c.quantity + ' u) y darlo de alta en inventario?',
      header: 'Autorizar retenido', icon: 'pi pi-exclamation-triangle',
      accept: () => this.auditor.authorize(c.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => { this.toast.add({ severity: 'success', summary: 'Autorizado' }); this.afterLotChange(this.lotLine()?.id); },
        error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo autorizar' }),
      }),
    });
  }

  reject(c: ReceivingCapture): void {
    this.confirm.confirm({
      message: '¿Rechazar el lote ' + (c.confirmed_lot || 'NA') + ' (' + c.quantity + ' u)? No entra a inventario.',
      header: 'Rechazar mercancía', icon: 'pi pi-times-circle',
      accept: () => this.auditor.reject(c.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => { this.toast.add({ severity: 'info', summary: 'Rechazado' }); this.afterLotChange(this.lotLine()?.id); },
        error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo rechazar' }),
      }),
    });
  }

  /** Tras declarar/autorizar/rechazar: refresca el vale (cuadre) y la lista del renglón. */
  private afterLotChange(lineId?: string): void {
    this.svc.detail(this.sessionId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => {
        this.session.set(s);
        const fresh = (s.lines || []).find((x) => x.id === (lineId || this.lotLine()?.id));
        if (fresh) this.lotLine.set(fresh);
      },
    });
    if (lineId) this.loadCaptures(lineId);
  }

  verdictLabel(v: string): string {
    return v === 'green' ? 'Aceptado' : v === 'yellow' ? 'Con reserva' : 'Retenido';
  }
  private verdictToast(v: string): string {
    return v === 'green' ? 'Lote aceptado' : v === 'yellow' ? 'Lote aceptado con reserva' : 'Lote retenido';
  }

  /**
   * Fecha para mostrar. La API devuelve `date` de Postgres serializado como ISO
   * (`2026-12-03T06:00:00.000Z`): se toma el tramo YYYY-MM-DD **tal cual**, sin
   * `new Date()`, porque re-convertir a la TZ del navegador puede correr el día
   * (DESIGN.md §10 — la TZ ya viene normalizada del backend).
   */
  fmtDate(v: string | null | undefined): string {
    if (!v) return '—';
    const iso = String(v).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return String(v);
    const parts = iso.split('-');
    return parts[2] + '/' + parts[1] + '/' + parts[0];
  }
  verdictSeverity(v: string): 'success' | 'warn' | 'danger' {
    return v === 'green' ? 'success' : v === 'yellow' ? 'warn' : 'danger';
  }
  ruleLabel(r: string): string {
    switch (r) {
      case 'min_shelf_life': return 'Bajo la vida útil mínima';
      case 'older_than_existing': return 'Más viejo que lo existente';
      case 'older_than_existing_allowed': return 'Más viejo (permitido)';
      case 'near_min_shelf_life': return 'Cerca de la mínima';
      default: return r;
    }
  }

  back(): void { this.router.navigate(['/almacen/inventory/recepcion-sesiones']); }

  isDiscrepancy(k: string): boolean { return ['faltante', 'sobrante', 'producto_incorrecto', 'dañado'].includes(k); }
  discLabel(k: string): string {
    switch (k) {
      case 'ok': return 'OK';
      case 'pending': return 'Pendiente';
      case 'faltante': return 'Faltante';
      case 'sobrante': return 'Sobrante';
      case 'dañado': return 'Dañado';
      case 'producto_incorrecto': return 'Prod. incorrecto';
      default: return k;
    }
  }
  discSeverity(k: string): 'success' | 'secondary' | 'warn' | 'danger' {
    if (k === 'ok') return 'success';
    if (k === 'pending') return 'secondary';
    if (k === 'sobrante') return 'warn';
    return 'danger';
  }
  statusLabel(s: string): string {
    return s === 'open' ? 'Abierta' : s === 'closed' ? 'Cerrada' : s === 'validating' ? 'Validando' : 'Cancelada';
  }
  statusSeverity(s: string): 'success' | 'secondary' | 'warn' | 'danger' {
    return s === 'open' ? 'success' : s === 'closed' ? 'secondary' : s === 'validating' ? 'warn' : 'danger';
  }
}
