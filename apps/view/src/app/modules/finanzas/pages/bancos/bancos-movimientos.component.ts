import { ChangeDetectionStrategy, Component, DestroyRef, EventEmitter, Output, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { CheckboxModule } from 'primeng/checkbox';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { DialogModule } from 'primeng/dialog';
import { ButtonModule } from 'primeng/button';
import { BankService, BankMovement, MovementFlow } from '../../bank.service';
import { GROUP_ORDER, groupLabel, groupColorVar, dmy, dmShort, money0 } from './bancos-shared';

/**
 * CB.14 — Vista MOVIMIENTOS (tabla filtrable read-only). El shell posee los filtros
 * que disparan recarga del backend (para respetar el cambio de periodo); el hijo los
 * refleja y emite `filter`/`searchChange`. "Color por grupo" es estado local (view).
 */
@Component({
  selector: 'bancos-movimientos',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, SelectModule, CheckboxModule, InputTextModule, IconFieldModule, InputIconModule, DialogModule, ButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fb-filters">
      <p-select [options]="accountOpts()" optionLabel="label" optionValue="value" [filter]="true"
                [ngModel]="fAccount()" (ngModelChange)="filter.emit({ field: 'account', value: $event })"
                appendTo="body" styleClass="fb-sel sel-liquid" ariaLabel="Cuenta"></p-select>
      <p-select [options]="groupOpts()" optionLabel="label" optionValue="value"
                [ngModel]="fGroup()" (ngModelChange)="filter.emit({ field: 'group', value: $event })"
                appendTo="body" styleClass="fb-sel sel-liquid" ariaLabel="Grupo"></p-select>
      <p-select [options]="reconOpts()" optionLabel="label" optionValue="value"
                [ngModel]="fRecon()" (ngModelChange)="filter.emit({ field: 'recon', value: $event })"
                appendTo="body" styleClass="fb-sel sel-liquid" ariaLabel="Estado de conciliación"></p-select>
      <span class="fb-check">
        <p-checkbox [ngModel]="fUncat()" [binary]="true" inputId="fUncat" (onChange)="filter.emit({ field: 'uncat', value: $event.checked })"></p-checkbox>
        <label for="fUncat">Solo sin clasificar</label>
      </span>
      <span class="fb-check">
        <p-checkbox [ngModel]="colorByGroup()" [binary]="true" inputId="fColor" (onChange)="colorByGroup.set($event.checked)"></p-checkbox>
        <label for="fColor">Color por grupo</label>
      </span>
      <p-iconfield iconPosition="left" class="fb-search">
        <p-inputicon styleClass="pi pi-search" />
        <input pInputText type="text" [ngModel]="fSearch()" (ngModelChange)="searchChange.emit($event)"
               placeholder="Buscar concepto / código…" aria-label="Buscar" />
      </p-iconfield>
      <span class="fb-count muted">
        @if (movTotal() > movements().length) { Mostrando {{ movements().length | number }} de {{ movTotal() | number }} }
        @else { {{ movTotal() | number }} movimientos }
      </span>
    </div>
    @if (colorByGroup()) {
      <div class="fb-legend" aria-label="Colores por grupo — clic para filtrar">
        @for (g of GROUP_ORDER; track g) {
          <button type="button" class="fb-legend-item" [class.active]="fGroup() === g" [style.--g]="color(g)"
                  (click)="filter.emit({ field: 'group', value: fGroup() === g ? '' : g })" [attr.aria-pressed]="fGroup() === g">
            <span class="fb-legend-dot"></span>{{ label(g) }}
          </button>
        }
      </div>
    }
    <div class="card-premium card-flat fb-tablewrap">
      <p-table [value]="movements()" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="58vh"
               [paginator]="movements().length > 50" [rows]="50" [rowsPerPageOptions]="[50, 100, 200]">
        <ng-template pTemplate="header">
          <tr>
            <th class="col-w6" pSortableColumn="movement_date">Fecha <p-sortIcon field="movement_date" /></th>
            <th class="col-w7">Cuenta</th>
            <th>Concepto</th>
            <th class="col-w11">Categoría</th>
            <th class="ta-r col-w8" pSortableColumn="amount_in">Depósito <p-sortIcon field="amount_in" /></th>
            <th class="ta-r col-w8" pSortableColumn="amount_out">Retiro <p-sortIcon field="amount_out" /></th>
            <th class="col-w25" title="Conciliación"></th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-m>
          <tr class="fb-mov-row fb-row-click" [class.fb-colored]="colorByGroup()"
              [style.--g]="colorByGroup() ? color(m.group_key) : null"
              [class.fb-uncat]="!m.category_id && !colorByGroup()"
              (click)="openMov(m)" tabindex="0" role="button" (keyup.enter)="openMov(m)">
            <td class="mono">{{ dm(m.movement_date) }}</td>
            <td class="muted">{{ m.account_label }}</td>
            <td class="fb-concept" [title]="m.concept">{{ m.concept || '—' }}</td>
            <td>
              @if (m.category_name) { <span class="fb-cat-chip">{{ m.category_name }}</span> }
              @else { <span class="fb-cat-chip fb-cat-none">sin clasificar</span> }
            </td>
            <td class="ta-r mono">{{ m.amount_in ? (m.amount_in | currency:'MXN':'symbol-narrow':'1.2-2') : '' }}</td>
            <td class="ta-r mono">{{ m.amount_out ? (m.amount_out | currency:'MXN':'symbol-narrow':'1.2-2') : '' }}</td>
            <td class="ta-c">
              @if (m.recon_status === 'matched') { <i class="pi pi-check-circle fb-rec-ok" title="Conciliado con Kepler"></i> }
              @else if (m.recon_status === 'unmatched') { <i class="pi pi-circle fb-rec-no" title="Sin conciliar"></i> }
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="7"><div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin movimientos con estos filtros.</p></div></td></tr>
        </ng-template>
      </p-table>
    </div>

    <!-- Detalle del movimiento (clic en fila): a qué se atribuye + estado + flujo. -->
    <p-dialog [visible]="!!detail()" (visibleChange)="closeDetail()" [modal]="true" [dismissableMask]="true"
              [header]="detail()?.title || 'Movimiento'" [style]="{ width: '36rem' }">
      @if (detail(); as d) {
        <dl class="fb-dl">
          @for (f of d.fields; track f.k) { <div class="fb-dl-row"><dt>{{ f.k }}</dt><dd [class.mono]="f.mono">{{ f.v }}</dd></div> }
        </dl>
        <p class="fb-dl-note muted"><i class="pi pi-info-circle"></i> {{ d.note }}</p>

        <!-- CB.15.2 — de dónde viene: cadena del proveedor (pago) o cómo Kepler tiene la cobranza (depósito) -->
        <div class="fb-flow-sec">
          @if (!flow() && !flowLoading()) {
            <button pButton type="button" label="Ver de dónde viene" icon="pi pi-sitemap"
                    class="p-button-sm p-button-outlined" (click)="loadFlow()"></button>
          }
          @if (flowLoading()) { <p class="muted fb-flow-loading"><i class="pi pi-spin pi-spinner"></i> Rastreando el flujo…</p> }
          @if (flow(); as fl) {
            @if (fl.proveedor && (fl.proveedor.banco_movs || fl.proveedor.kepler_movs)) {
              <div class="fb-flow-cuadre">
                <span class="fb-flow-prov">{{ fl.proveedor.nombre }}</span>
                <div class="fb-flow-nums">
                  <span><b class="mono">{{ fl.proveedor.banco_total_mes | currency:'MXN':'symbol-narrow':'1.0-0' }}</b> banco ({{ fl.proveedor.banco_movs }})</span>
                  <span class="muted">vs</span>
                  <span><b class="mono">{{ fl.proveedor.kepler_total_mes | currency:'MXN':'symbol-narrow':'1.0-0' }}</b> Kepler 102 ({{ fl.proveedor.kepler_movs }})</span>
                  @if (provCuadra(fl)) { <i class="pi pi-check-circle ok" title="Cuadra en el mes"></i> }
                  @else { <i class="pi pi-exclamation-triangle warn" title="Difieren en el mes"></i> }
                </div>
              </div>
            }
            @if (fl.cadena.length) {
              <div class="fb-flow-chain">
                <div class="fb-flow-h">Compras del proveedor en el mes (orden → recepción → factura → pago)</div>
                <table class="fb-flow-table">
                  <thead><tr><th>Factura</th><th>Orden</th><th>Recepción</th><th>Pago</th><th class="ta-r">Total</th></tr></thead>
                  <tbody>
                    @for (r of fl.cadena; track r.factura_folio) {
                      <tr>
                        <td class="mono">{{ r.factura_folio || '—' }} <span class="muted">{{ ds(r.factura_fecha) }}</span></td>
                        <td class="mono muted">{{ r.orden_folio || '—' }}</td>
                        <td class="mono muted">{{ r.recepcion_folio || '—' }}</td>
                        <td class="mono muted">{{ r.pago_folio || '—' }} {{ ds(r.pago_fecha) }}</td>
                        <td class="ta-r mono">{{ r.total | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
            @if (fl.cobranza && fl.cobranza.kepler_movs) {
              <div class="fb-flow-chain">
                <div class="fb-flow-h">Cómo lo tiene Kepler</div>
                <p class="fb-flow-cob">Este cobrador tiene <b>{{ fl.cobranza.kepler_movs }}</b> pólizas de cobranza en el mes (suman <b class="mono">{{ fl.cobranza.kepler_suma | currency:'MXN':'symbol-narrow':'1.0-0' }}</b>). El banco lo depositó junto; Kepler lo tiene por venta.</p>
              </div>
            }
            <p class="fb-dl-note muted"><i class="pi pi-info-circle"></i> {{ fl.nota }}</p>
          }
        </div>
      }
    </p-dialog>
  `,
  styles: [`
    :host { display: block; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; } .ta-c { text-align: center; }
    .muted { color: var(--text-muted); }
    .col-w6 { width: 6rem; } .col-w7 { width: 7rem; } .col-w8 { width: 8rem; } .col-w11 { width: 11rem; } .col-w25 { width: 2.5rem; }
    .fb-tablewrap { padding: 0; overflow: hidden; }
    .fb-filters { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-3); }
    .fb-search { min-width: 16rem; flex: 1; }
    .fb-check { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-sm); color: var(--text-muted); }
    .fb-count { margin-left: auto; font-size: var(--fs-xs); }
    .fb-concept { max-width: 28rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fb-cat-chip { display: inline-block; font-size: var(--fs-xs); color: var(--text-muted); }
    .fb-cat-chip.fb-cat-none { color: var(--warn-fg); }
    .fb-uncat { background: color-mix(in srgb, var(--warn-fg) 5%, transparent); }
    .fb-colored > td { background: color-mix(in srgb, var(--g, transparent) 8%, transparent); }
    .fb-colored > td:first-child { box-shadow: inset 3px 0 0 var(--g, transparent); }
    .fb-legend { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-2); margin-bottom: var(--sp-2); }
    .fb-legend-item { display: inline-flex; align-items: center; gap: var(--sp-1); font: inherit; font-size: var(--fs-xs);
      color: var(--text-muted); background: none; border: 1px solid transparent; border-radius: var(--r-pill);
      padding: 2px var(--sp-2); cursor: pointer; transition: background-color 120ms ease, border-color 120ms ease; }
    .fb-legend-item:hover { background: var(--hover-bg); }
    .fb-legend-item.active { border-color: var(--g); color: var(--text-main); background: color-mix(in srgb, var(--g) 8%, transparent); }
    .fb-legend-item:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 1px; }
    .fb-legend-dot { width: 10px; height: 10px; border-radius: 3px; background: var(--g, var(--text-faint)); flex: none; }
    .fb-rec-ok { color: var(--ok-fg); font-size: 0.85rem; }
    .fb-rec-no { color: var(--text-faint); font-size: 0.7rem; }
    .surf-empty { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2); padding: var(--sp-8); color: var(--text-muted); }
    .surf-empty i { font-size: 1.5rem; }
    .fb-row-click { cursor: pointer; }
    .fb-row-click:focus-visible { outline: 2px solid var(--action-ring); outline-offset: -2px; }
    .fb-dl { margin: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    .fb-dl-row { display: grid; grid-template-columns: 9rem 1fr; gap: var(--sp-2); align-items: baseline; }
    .fb-dl-row dt { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); font-weight: 700; }
    .fb-dl-row dd { margin: 0; font-size: var(--fs-sm); color: var(--text-main); }
    .fb-dl-note { font-size: var(--fs-xs); margin: var(--sp-4) 0 0; display: flex; align-items: baseline; gap: var(--sp-1); }
    .ok { color: var(--ok-fg); } .warn { color: var(--warn-fg); }
    /* CB.15.2 — flujo "de dónde viene" */
    .fb-flow-sec { margin-top: var(--sp-4); padding-top: var(--sp-3); border-top: 1px solid var(--border-color); }
    .fb-flow-loading { font-size: var(--fs-sm); display: flex; align-items: center; gap: var(--sp-2); }
    .fb-flow-cuadre { display: flex; flex-direction: column; gap: 2px; margin-bottom: var(--sp-3); }
    .fb-flow-prov { font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); }
    .fb-flow-nums { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-muted); }
    .fb-flow-nums b { color: var(--text-main); font-weight: 600; }
    .fb-flow-h { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); font-weight: 700; margin-bottom: var(--sp-1); }
    .fb-flow-chain { margin-top: var(--sp-2); }
    table.fb-flow-table { width: 100%; border-collapse: collapse; font-size: var(--fs-xs); }
    table.fb-flow-table th { text-align: left; font-weight: 600; color: var(--text-muted); padding: 3px var(--sp-2); border-bottom: 1px solid var(--border-color); white-space: nowrap; }
    table.fb-flow-table td { padding: 3px var(--sp-2); border-bottom: 1px solid var(--border-color); }
    .fb-flow-cob { font-size: var(--fs-sm); color: var(--text-main); margin: 0; line-height: 1.4; }
  `],
})
export class BancosMovimientosComponent {
  readonly movements = input.required<BankMovement[]>();
  readonly movTotal = input.required<number>();
  readonly accountOpts = input.required<{ label: string; value: string }[]>();
  readonly groupOpts = input.required<{ label: string; value: string }[]>();
  readonly reconOpts = input.required<{ label: string; value: string }[]>();
  readonly fAccount = input<string>('');
  readonly fGroup = input<string>('');
  readonly fRecon = input<string>('');
  readonly fUncat = input<boolean>(false);
  readonly fSearch = input<string>('');
  @Output() filter = new EventEmitter<{ field: string; value: any }>();
  @Output() searchChange = new EventEmitter<string>();

  private readonly api = inject(BankService);
  private readonly destroyRef = inject(DestroyRef);

  readonly GROUP_ORDER = GROUP_ORDER;
  readonly colorByGroup = signal(true);
  label(g: string): string { return groupLabel(g); }
  color(g?: string | null): string { return groupColorVar(g); }
  dm(v: any): string { return dmy(v); }
  ds(v: any): string { return dmShort(v); }

  /** Detalle del movimiento (clic en fila): a qué se atribuye + estado de conciliación. */
  readonly detail = signal<{ title: string; fields: { k: string; v: string; mono?: boolean }[]; note: string } | null>(null);
  private readonly currentId = signal<string | null>(null);
  readonly flow = signal<MovementFlow | null>(null);
  readonly flowLoading = signal(false);

  closeDetail(): void { this.detail.set(null); this.flow.set(null); this.currentId.set(null); }

  /** CB.15.2 — rastrea de dónde viene el movimiento (cadena del proveedor / cobranza Kepler). */
  loadFlow(): void {
    const id = this.currentId();
    if (!id || this.flowLoading()) return;
    this.flowLoading.set(true);
    this.api.movementFlow(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (fl) => { this.flow.set(fl); this.flowLoading.set(false); },
      error: () => { this.flowLoading.set(false); },
    });
  }
  provCuadra(fl: MovementFlow): boolean {
    if (!fl.proveedor) return false;
    return Math.abs(fl.proveedor.banco_total_mes - fl.proveedor.kepler_total_mes) < 1000;
  }

  openMov(m: BankMovement): void {
    this.flow.set(null);
    this.currentId.set(m.id);
    const esRetiro = (m.amount_out || 0) > 0;
    const conciliado = m.recon_status === 'matched';
    const folio = conciliado && m.kepler_doc_folio ? `${m.kepler_doc_tipo || ''} ${m.kepler_doc_folio}`.trim() : null;
    const fields = [
      { k: 'Fecha', v: dmy(m.movement_date), mono: true },
      { k: 'Cuenta', v: `${m.bank} ${m.account_label}` },
      { k: 'Concepto', v: m.concept || '—' },
      { k: 'Tipo (Excel)', v: m.raw_type || '—', mono: true },
      { k: 'Código (Excel)', v: m.raw_code || '—', mono: true },
      { k: 'Categoría', v: m.category_name || 'sin clasificar' },
      { k: 'Grupo', v: m.group_key ? groupLabel(m.group_key) : '—' },
      // "Regla contable": es a qué cuenta DEBERÍA ir según la categoría — NO es un cruce
      // verificado contra Kepler. El cruce real (si existe) es la póliza de abajo.
      { k: 'Regla contable', v: m.kepler_account ? `${m.kepler_account} (regla, sin verificar)` : '—', mono: true },
      { k: esRetiro ? 'Retiro' : 'Depósito', v: money0(esRetiro ? m.amount_out : m.amount_in), mono: true },
      { k: 'Conciliación', v: conciliado ? 'Conciliado con Kepler' : m.recon_status === 'unmatched' ? 'Sin conciliar' : '—' },
      // Solo cuando SÍ hay cruce real: el folio de la póliza del 102 de Kepler (verificado).
      ...(folio ? [{ k: 'Póliza Kepler', v: folio, mono: true }] : []),
    ];
    let note: string;
    if (m.group_key === 'ingreso' && esRetiro) {
      note = 'Ojo: está clasificado como ingreso (cobranza) pero es un RETIRO (salida). Se ve como posible misclasificación — revisa el tipo/código del Excel; si es un cargo real, debe reclasificarse en el origen.';
    } else if (!esRetiro) {
      note = 'Es un depósito (cobranza). Los depósitos NO se concilian 1 a 1 contra el 102: el banco los registra como un depósito único y Kepler los tiene partidos por venta. Se cuadran por total, no por línea. La "regla contable" de arriba es solo a qué cuenta corresponde, no un cruce verificado.';
    } else if (conciliado) {
      note = folio
        ? `Conciliado: este pago casó con la póliza ${folio} del 102 en Kepler (mismo monto y fecha). Ese folio SÍ es un cruce verificado — la "regla contable" de arriba no lo es.`
        : 'Conciliado: este pago ya tiene su equivalente en el 102 de Kepler.';
    } else {
      note = 'Sin conciliar: no se encontró su pago en el 102. Si es factoraje o nómina/comisión agrupada, no requiere acción; si es compra/gasto, captúralo o reclasifícalo en Kepler (auxiliar del 102, por beneficiario + monto + fecha).';
    }
    this.detail.set({ title: 'Detalle del movimiento', fields, note });
  }
}
