import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { BankService, SideBySide, SideExcelRow, SideKeplerRow, MovementFlow } from '../../bank.service';
import { dmy, dmShort, groupLabel, money0 } from './bancos-shared';

/** Un renglón del comparador: Excel y/o Kepler alineados por match_key. */
interface Pair { key: string; excel: SideExcelRow | null; kepler: SideKeplerRow | null; fecha: string; monto: number; }

/**
 * CB.16 — Comparador Excel ↔ Kepler alineado. UNA tabla, dos grupos de columnas
 * (Excel banco | Kepler 102), un renglón por par (unidos por match_key) → ambos lados
 * SIEMPRE en el mismo orden y en la misma fila. Hover resalta los dos lados juntos
 * (es un solo renglón). Clic → desglose abajo (fechas/montos/estado + de dónde viene).
 * Los sin contraparte muestran el lado vacío atenuado. Presentacional: data del shell.
 */
@Component({
  selector: 'bancos-side-by-side',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, ButtonModule, SelectModule, InputTextModule, IconFieldModule, InputIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fb-sbs-bar">
      <p-select [options]="filterOpts" optionLabel="label" optionValue="value"
                [ngModel]="fEstado()" (ngModelChange)="fEstado.set($event); resetSel()"
                appendTo="body" styleClass="fb-sel sel-liquid" ariaLabel="Estado de conciliación"></p-select>
      <p-select [options]="ladoOpts" optionLabel="label" optionValue="value"
                [ngModel]="fLado()" (ngModelChange)="fLado.set($event); resetSel()"
                appendTo="body" styleClass="fb-sel sel-liquid" ariaLabel="Tipo de movimiento"></p-select>
      <p-iconfield iconPosition="left" class="fb-sbs-search">
        <p-inputicon styleClass="pi pi-search" />
        <input pInputText type="text" [ngModel]="fSearch()" (ngModelChange)="fSearch.set($event); resetSel()"
               placeholder="Buscar concepto / beneficiario / folio…" aria-label="Buscar" />
      </p-iconfield>
      <span class="fb-sbs-count muted">{{ pairs().length | number }} renglones · {{ concCount() }} conciliados</span>
    </div>

    <div class="card-premium card-flat fb-sbs-tablewrap">
      <p-table [value]="pairs()" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="60vh"
               [paginator]="pairs().length > 50" [rows]="50" [rowsPerPageOptions]="[50, 100, 200]">
        <ng-template pTemplate="header">
          <tr class="fb-grp-row">
            <th colspan="4" class="fb-grp fb-grp-excel">Excel (banco)</th>
            <th class="fb-grp-sep" aria-hidden="true"></th>
            <th colspan="4" class="fb-grp fb-grp-kepler">Kepler (102)</th>
          </tr>
          <tr>
            <th class="col-w6">Fecha</th><th>Concepto</th><th class="ta-r col-w9">Monto</th><th class="ta-c col-w25"></th>
            <th class="fb-grp-sep" aria-hidden="true"></th>
            <th class="col-w6">Fecha</th><th class="col-w7">Doc</th><th>Beneficiario</th><th class="ta-r col-w9">Importe</th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-p>
          <tr class="fb-row-click" [class.fb-sel-row]="isSel(p)" [class.fb-nomatch]="!p.excel || !p.kepler"
              (click)="pick(p)" tabindex="0" role="button" (keyup.enter)="pick(p)">
            <!-- Excel -->
            @if (p.excel; as e) {
              <td class="mono">{{ dm(e.fecha) }}</td>
              <td class="fb-concept" [title]="e.concepto">{{ e.concepto || '—' }}</td>
              <td class="ta-r mono">{{ (e.sale > 0 ? e.sale : e.entra) | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="ta-c">
                @if (e.recon_status === 'matched') { <i class="pi pi-link ok" title="Conciliado"></i> }
                @else { <i class="pi pi-minus-circle fb-faint" title="Sin conciliar"></i> }
              </td>
            } @else {
              <td colspan="4" class="fb-empty-side">— sin movimiento en el banco</td>
            }
            <td class="fb-grp-sep" aria-hidden="true"></td>
            <!-- Kepler -->
            @if (p.kepler; as k) {
              <td class="mono">{{ dm(k.fecha) }}</td>
              <td class="mono muted">{{ k.doc_tipo }} {{ k.folio }}</td>
              <td class="fb-concept" [title]="k.contraparte">{{ k.contraparte || '—' }}</td>
              <td class="ta-r mono">{{ k.importe | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
            } @else {
              <td colspan="4" class="fb-empty-side">— sin póliza en Kepler (cuadra por total)</td>
            }
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage"><tr><td colspan="9"><div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin movimientos con estos filtros.</p></div></td></tr></ng-template>
      </p-table>
    </div>

    <!-- ── DESGLOSE del renglón seleccionado ── -->
    @if (sel(); as p) {
      <div class="card-premium card-flat fb-sbs-detail">
        <div class="fb-sbs-detail-head">
          <h3 class="fb-sbs-h">Desglose</h3>
          <button pButton type="button" icon="pi pi-times" class="p-button-sm p-button-text" (click)="resetSel()" aria-label="Cerrar desglose"></button>
        </div>
        <div class="fb-sbs-pair">
          <div class="fb-sbs-side">
            <span class="fb-sbs-side-t">Excel (banco)</span>
            @if (p.excel; as e) {
              <dl class="fb-dl">
                <div class="fb-dl-row"><dt>Fecha</dt><dd class="mono">{{ dm(e.fecha) }}</dd></div>
                <div class="fb-dl-row"><dt>Cuenta</dt><dd>{{ e.cuenta }}</dd></div>
                <div class="fb-dl-row"><dt>Concepto</dt><dd>{{ e.concepto || '—' }}</dd></div>
                <div class="fb-dl-row"><dt>Categoría</dt><dd>{{ e.categoria || 'sin clasificar' }} <span class="muted">· {{ e.grupo ? gl(e.grupo) : '—' }}</span></dd></div>
                <div class="fb-dl-row"><dt>{{ e.sale > 0 ? 'Retiro' : 'Depósito' }}</dt><dd class="mono">{{ m0(e.sale > 0 ? e.sale : e.entra) }}</dd></div>
              </dl>
            } @else { <p class="muted fb-sbs-none">Sin movimiento espejo en el banco.</p> }
          </div>
          <div class="fb-sbs-link"><i class="pi" [class.pi-arrows-h]="p.excel && p.kepler" [class.pi-minus]="!p.excel || !p.kepler"></i></div>
          <div class="fb-sbs-side">
            <span class="fb-sbs-side-t">Kepler (102)</span>
            @if (p.kepler; as k) {
              <dl class="fb-dl">
                <div class="fb-dl-row"><dt>Fecha</dt><dd class="mono">{{ dm(k.fecha) }}</dd></div>
                <div class="fb-dl-row"><dt>Documento</dt><dd class="mono">{{ k.doc_tipo }} {{ k.folio }}</dd></div>
                <div class="fb-dl-row"><dt>Beneficiario</dt><dd>{{ k.contraparte || '—' }}</dd></div>
                <div class="fb-dl-row"><dt>Naturaleza</dt><dd>{{ k.cargo_abono === 'A' ? 'Abono (sale)' : 'Cargo (entra)' }}</dd></div>
                <div class="fb-dl-row"><dt>Importe</dt><dd class="mono">{{ m0(k.importe) }}</dd></div>
              </dl>
            } @else { <p class="muted fb-sbs-none">Sin póliza espejo en Kepler (se cuadra por total, no 1 a 1).</p> }
          </div>
        </div>

        <div class="fb-sbs-flow">
          @if (!flow() && !flowLoading() && flowId()) {
            <button pButton type="button" label="Ver de dónde viene" icon="pi pi-sitemap" class="p-button-sm p-button-outlined" (click)="loadFlow()"></button>
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
                <div class="fb-sbs-tablewrap">
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
              </div>
            }
            @if (fl.cobranza && fl.cobranza.kepler_movs) {
              <p class="fb-flow-cob">Este cobrador tiene <b>{{ fl.cobranza.kepler_movs }}</b> pólizas de cobranza en el mes (suman <b class="mono">{{ fl.cobranza.kepler_suma | currency:'MXN':'symbol-narrow':'1.0-0' }}</b>). El banco lo depositó junto; Kepler lo tiene por venta.</p>
            }
            <p class="fb-dl-note muted"><i class="pi pi-info-circle"></i> {{ fl.nota }}</p>
          }
        </div>
      </div>
    } @else {
      <p class="fb-sbs-cta muted"><i class="pi pi-hand-point-up"></i> Pasa el mouse para ver el par alineado; haz clic en un renglón para desglosarlo.</p>
    }
  `,
  styles: [`
    :host { display: block; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; } .ta-c { text-align: center; }
    .muted { color: var(--text-muted); }
    .ok { color: var(--ok-fg); } .warn { color: var(--warn-fg); }
    .fb-faint { color: var(--text-faint); font-size: .7rem; }
    .col-w25 { width: 2.5rem; } .col-w6 { width: 6rem; } .col-w7 { width: 7rem; } .col-w9 { width: 9rem; }
    .fb-sbs-bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-3); }
    .fb-sbs-search { min-width: 16rem; flex: 1; }
    :host ::ng-deep .fb-sbs-search .p-inputtext { width: 100%; font-size: var(--fs-sm); }
    .fb-sbs-count { margin-left: auto; font-size: var(--fs-xs); }
    .fb-sbs-tablewrap { padding: 0; overflow: hidden; }
    .fb-concept { max-width: 16rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* grupos de columnas (Excel | Kepler) */
    .fb-grp { text-align: left; font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .05em; font-weight: 700; }
    .fb-grp-excel { color: var(--text-main); }
    .fb-grp-kepler { color: var(--text-main); }
    .fb-grp-sep { width: 2px; padding: 0 !important; background: var(--border-color); }
    td.fb-grp-sep { background: var(--border-color); }
    .fb-empty-side { color: var(--text-faint); font-size: var(--fs-xs); font-style: italic; }
    .fb-row-click { cursor: pointer; }
    .fb-row-click:focus-visible { outline: 2px solid var(--action-ring); outline-offset: -2px; }
    /* Sin contraparte: renglón atenuado (un lado vacío). */
    .fb-nomatch { background: color-mix(in srgb, var(--warn-fg) 4%, transparent); }
    /* Renglón seleccionado. */
    .fb-sel-row > td { background: color-mix(in srgb, var(--action) 12%, transparent) !important; }
    .fb-sel-row > td:first-child { box-shadow: inset 3px 0 0 var(--action); }
    .fb-sbs-detail { margin-top: var(--sp-3); padding: var(--sp-4); }
    .fb-sbs-detail-head { display: flex; align-items: center; justify-content: space-between; }
    .fb-sbs-h { font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); margin: 0; }
    .fb-sbs-pair { display: grid; grid-template-columns: 1fr auto 1fr; gap: var(--sp-3); align-items: center; margin: var(--sp-2) 0 var(--sp-3); }
    @media (max-width: 48rem) { .fb-sbs-pair { grid-template-columns: 1fr; } .fb-sbs-link { display: none; } }
    .fb-sbs-side { border: 1px solid var(--border-color); border-radius: var(--r-md); padding: var(--sp-3); }
    .fb-sbs-side-t { display: block; font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); font-weight: 700; margin-bottom: var(--sp-2); }
    .fb-sbs-none { font-size: var(--fs-sm); margin: 0; }
    .fb-sbs-link { color: var(--text-faint); font-size: 1.1rem; text-align: center; }
    .fb-dl { margin: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
    .fb-dl-row { display: grid; grid-template-columns: 7rem 1fr; gap: var(--sp-2); align-items: baseline; }
    .fb-dl-row dt { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); font-weight: 700; }
    .fb-dl-row dd { margin: 0; font-size: var(--fs-sm); color: var(--text-main); }
    .fb-dl-note { font-size: var(--fs-xs); margin: var(--sp-3) 0 0; display: flex; align-items: baseline; gap: var(--sp-1); }
    .fb-sbs-flow { border-top: 1px solid var(--border-color); padding-top: var(--sp-3); }
    .fb-flow-loading { font-size: var(--fs-sm); display: flex; align-items: center; gap: var(--sp-2); }
    .fb-flow-cuadre { display: flex; flex-direction: column; gap: 2px; margin-bottom: var(--sp-3); }
    .fb-flow-prov { font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); }
    .fb-flow-nums { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-muted); }
    .fb-flow-nums b { color: var(--text-main); font-weight: 600; }
    .fb-flow-h { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); font-weight: 700; margin-bottom: var(--sp-1); }
    .fb-flow-chain { margin-top: var(--sp-2); }
    .fb-sbs-tablewrap-inner, .fb-sbs-flow .fb-sbs-tablewrap { overflow-x: auto; }
    table.fb-flow-table { width: 100%; border-collapse: collapse; font-size: var(--fs-xs); }
    table.fb-flow-table th { text-align: left; font-weight: 600; color: var(--text-muted); padding: 3px var(--sp-2); border-bottom: 1px solid var(--border-color); white-space: nowrap; }
    table.fb-flow-table td { padding: 3px var(--sp-2); border-bottom: 1px solid var(--border-color); }
    .fb-flow-cob { font-size: var(--fs-sm); color: var(--text-main); margin: var(--sp-2) 0 0; line-height: 1.4; }
    .fb-sbs-cta { margin-top: var(--sp-4); font-size: var(--fs-sm); display: flex; align-items: center; gap: var(--sp-2); }
    .surf-empty { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2); padding: var(--sp-6); color: var(--text-muted); }
    .surf-empty i { font-size: 1.5rem; }
  `],
})
export class BancosSideBySideComponent {
  private readonly api = inject(BankService);
  private readonly destroyRef = inject(DestroyRef);

  readonly data = input.required<SideBySide>();

  readonly fEstado = signal<'all' | 'matched' | 'unmatched'>('all');
  readonly fLado = signal<'all' | 'egreso' | 'ingreso'>('all');
  readonly fSearch = signal('');
  readonly filterOpts = [
    { label: 'Todos', value: 'all' },
    { label: 'Conciliados', value: 'matched' },
    { label: 'Sin conciliar', value: 'unmatched' },
  ];
  readonly ladoOpts = [
    { label: 'Pagos y cobros', value: 'all' },
    { label: 'Solo pagos (salidas)', value: 'egreso' },
    { label: 'Solo cobros (entradas)', value: 'ingreso' },
  ];

  readonly sel = signal<Pair | null>(null);
  readonly flow = signal<MovementFlow | null>(null);
  readonly flowLoading = signal(false);

  dm(v: any): string { return dmy(v); }
  ds(v: any): string { return dmShort(v); }
  gl(g: string): string { return groupLabel(g); }
  m0(v: number): string { return money0(v); }

  /** Une Excel y Kepler por match_key en renglones alineados, ordenados igual (fecha, monto desc). */
  readonly allPairs = computed<Pair[]>(() => {
    const d = this.data();
    const kByKey = new Map<string, SideKeplerRow>();
    for (const k of d.kepler) kByKey.set(k.match_key, k);
    const usedK = new Set<string>();
    const pairs: Pair[] = [];
    for (const e of d.excel) {
      const k = e.match_key ? kByKey.get(e.match_key) || null : null;
      if (k) usedK.add(k.match_key);
      const monto = e.sale > 0 ? e.sale : e.entra;
      pairs.push({ key: e.id, excel: e, kepler: k, fecha: String(e.fecha || ''), monto });
    }
    // Pólizas de Kepler sin movimiento espejo en el banco.
    for (const k of d.kepler) {
      if (usedK.has(k.match_key)) continue;
      pairs.push({ key: `k:${k.match_key}`, excel: null, kepler: k, fecha: String(k.fecha || ''), monto: k.importe });
    }
    // Mismo orden para todo: por fecha, luego por monto desc.
    pairs.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : b.monto - a.monto));
    return pairs;
  });

  private hit(s: string, ...vals: (string | null | undefined)[]): boolean {
    if (!s) return true;
    const q = s.trim().toLowerCase();
    return vals.some((v) => (v || '').toLowerCase().includes(q));
  }
  readonly pairs = computed<Pair[]>(() => {
    const est = this.fEstado(); const lado = this.fLado(); const s = this.fSearch();
    return this.allPairs().filter((p) => {
      const matched = !!p.excel && !!p.kepler;
      if (est === 'matched' && !matched) return false;
      if (est === 'unmatched' && matched) return false;
      if (lado !== 'all') {
        const esEgreso = p.excel ? p.excel.sale > 0 : p.kepler?.cargo_abono === 'A';
        if (lado === 'egreso' && !esEgreso) return false;
        if (lado === 'ingreso' && esEgreso) return false;
      }
      return this.hit(s, p.excel?.concepto, p.excel?.categoria, p.kepler?.contraparte, p.kepler?.folio, p.kepler?.doc_tipo);
    });
  });
  readonly concCount = computed(() => this.allPairs().filter((p) => p.excel && p.kepler).length);

  isSel(p: Pair): boolean { return this.sel()?.key === p.key; }
  pick(p: Pair): void { this.sel.set(p); this.resetFlow(); }
  resetSel(): void { this.sel.set(null); this.resetFlow(); }
  private resetFlow(): void { this.flow.set(null); this.flowLoading.set(false); }

  readonly flowId = computed<string | null>(() => {
    const p = this.sel(); if (!p) return null;
    return p.excel?.id || p.kepler?.bank_movement_id || null;
  });
  loadFlow(): void {
    const id = this.flowId();
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
}
