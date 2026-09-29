import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { CheckboxModule } from 'primeng/checkbox';
import { DialogModule } from 'primeng/dialog';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import type {
  CreatePurchaseDeliveryDto, DeliveryDateBasis, DeliveryRecipient, PendingReceiptRow, PendingReceiptsResponse,
  PurchaseDeliveryDetail,
} from '@megadulces/contracts';
import { environment } from '../../../../environments/environment';
import { Permission } from '../../../core/constants/permissions';
import { PermissionsService } from '../../../core/services/permissions.service';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { money } from '../../../shared/util/money.util';
import { agruparPorSucursal, dia, evidenciaLabel, nombreSucursal, periodoPorDefecto, receiptKey, sumar } from '../compras-entrega';

/**
 * `[RE.32]` — **Por entregar a Finanzas.** El auxiliar de compras ve lo recibido por fecha (de
 * recepción o de factura), con brinco por sucursal y proveedor A-Z, marca lo que tiene en físico y
 * validado, y genera la entrega con folio y la persona de Finanzas que recibe. Al generarla se
 * descarga el PDF para firmas.
 *
 * El check es CONSTANCIA del auxiliar: el estado de la foto en `/compras/entradas` sólo informa.
 */
@Component({
  selector: 'app-compras-entrega-pendientes',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, InputTextModule, CheckboxModule, DialogModule, SelectModule, TagModule,
    ToastModule, SegmentedComponent, LoadStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <p-toast></p-toast>
    <div class="ep-bar">
      <app-segmented [options]="basisOpts" [value]="basis()" (valueChange)="setBasis($event)" ariaLabel="Fecha para filtrar" />
      <label class="ep-date">Desde <input pInputText type="date" [ngModel]="from()" (ngModelChange)="from.set($event)" /></label>
      <label class="ep-date">Hasta <input pInputText type="date" [ngModel]="to()" (ngModelChange)="to.set($event)" /></label>
      <button pButton type="button" class="p-button-sm" (click)="load()" [disabled]="loading()">
        <span class="p-button-icon p-button-icon-left pi pi-search" aria-hidden="true"></span><span class="p-button-label">Buscar</span>
      </button>
    </div>

    @if (meta(); as m) {
      @if (!m.schema_ready) {
        <div class="ep-gap ep-warn" role="status"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <p><b>Faltan las migraciones de entregas.</b> La lista se puede consultar, pero todavía no se puede generar una entrega.
            @if (m.date_basis === 'factura' && basis() === 'recepcion') { Mientras tanto se filtra por <b>fecha de factura</b>. }</p>
        </div>
      }
      @if (m.excluded_without_reception_date || m.excluded_internal) {
        <p class="ep-note">
          @if (m.excluded_internal) { No se muestran {{ m.excluded_internal }} entradas de proveedores internos (traspasos). }
          @if (m.excluded_without_reception_date) { {{ m.excluded_without_reception_date }} entradas de Wincaja no tienen fecha de recepción: búscalas por fecha de factura. }
        </p>
      }
    }

    <app-load-state [loading]="loading()" [error]="error()" [isEmpty]="!loading() && !error() && !rows().length"
                    emptyTitle="Nada pendiente de entregar" emptyHint="Cambia las fechas o la base de fecha." (retry)="load()">
      <p-table [value]="rows()" size="small" class="surf-table ep-table" rowGroupMode="subheader" groupRowsBy="sucursal" dataKey="key"
               [scrollable]="true" scrollHeight="flex">
        <ng-template #header>
          <tr>
            <th style="width:2.5rem"><span class="sr-only">Entregar</span></th>
            <th>Recepción</th>
            <th>Factura</th>
            <th>Proveedor</th>
            <th>Folio Kepler</th>
            <th>OC</th>
            <th>Evidencia</th>
            <th class="ta-r" title="Días desde la recepción">Días</th>
            <th class="ta-r">Importe</th>
          </tr>
        </ng-template>
        <ng-template #groupheader let-r>
          <tr class="ep-group">
            <td>
              @if (canDeliver()) {
                <p-checkbox [binary]="true" [ngModel]="grupoCompleto(r.sucursal)" (onChange)="toggleGrupo(r.sucursal, $event.checked)"
                            [ariaLabel]="'Marcar todas las de ' + nombre(r.sucursal)" />
              }
            </td>
            <td colspan="7"><b>{{ nombre(r.sucursal) }}</b> · {{ grupo(r.sucursal)?.rows?.length }} entradas</td>
            <td class="ta-r mono"><b>{{ money(grupo(r.sucursal)?.total ?? 0) }}</b></td>
          </tr>
        </ng-template>
        <ng-template #body let-r>
          <tr [class.ep-sel]="sel().has(r.key)">
            <td>
              @if (canDeliver()) {
                <p-checkbox [binary]="true" [ngModel]="sel().has(r.key)" (onChange)="toggle(r.key)" [ariaLabel]="'Entregar ' + r.folio" />
              }
            </td>
            <td class="mono">{{ dia(r.reception_date) }}</td>
            <td class="mono ep-muted">{{ dia(r.invoice_date) }}</td>
            <td>{{ r.supplier_name || r.supplier_code || '—' }}
              @if (r.times_rejected) { <p-tag severity="warn" [value]="'Rechazada ' + r.times_rejected + '×'" styleClass="ep-tag" [title]="r.last_rejection_reason || ''" /> }
            </td>
            <td class="mono">{{ r.folio }}</td>
            <td class="mono ep-muted">{{ r.oc_folio || '—' }}</td>
            <td><span class="ep-ev" [class.ep-ev-none]="r.evidence_status === 'sin_evidencia'">{{ evidencia(r.evidence_status) }}</span></td>
            <td class="ta-r mono ep-muted">{{ r.days_waiting ?? '—' }}</td>
            <td class="ta-r mono">{{ money(r.amount) }}</td>
          </tr>
        </ng-template>
      </p-table>
    </app-load-state>

    @if (canDeliver() && rows().length) {
      <div class="ep-foot" role="region" aria-label="Selección para entregar">
        <span><b class="mono">{{ selRows().length }}</b> de {{ rows().length }} marcadas · <b class="mono">{{ money(selTotal()) }}</b></span>
        <button pButton type="button" class="p-button-sm p-button-text" (click)="clearSel()" [disabled]="!selRows().length">Limpiar</button>
        <button pButton type="button" class="p-button-sm" (click)="openDeliver()" [disabled]="!selRows().length">
          <span class="p-button-icon p-button-icon-left pi pi-send" aria-hidden="true"></span><span class="p-button-label">Generar entrega</span>
        </button>
      </div>
    }

    <p-dialog [visible]="dlg()" (visibleChange)="dlg.set($event)" [modal]="true" header="Generar entrega a Finanzas" [style]="{ width: '34rem' }">
      <p class="ep-sum"><b>{{ selRows().length }}</b> órdenes de entrada · <b class="mono">{{ money(selTotal()) }}</b> · {{ selGrupos().length }} sucursal(es)</p>
      <ul class="ep-sum-list">
        @for (g of selGrupos(); track g.sucursal) { <li>{{ g.nombre }}: {{ g.rows.length }} · <span class="mono">{{ money(g.total) }}</span></li> }
      </ul>
      <label class="ep-lbl" for="ep-rec">Recibe (Finanzas)</label>
      <div class="ep-select">
        <p-select inputId="ep-rec" [options]="recipients()" optionLabel="name" optionValue="username" [ngModel]="recipient()"
                  (ngModelChange)="recipient.set($event)" placeholder="Elige quién recibe" [filter]="true" filterBy="name" appendTo="body" />
      </div>
      <label class="ep-lbl" for="ep-notes">Notas (opcional)</label>
      <input pInputText id="ep-notes" type="text" class="ep-full" [ngModel]="notes()" (ngModelChange)="notes.set($event)" />
      <p class="ep-hint">Al generarla se asigna el folio, se descarga el PDF para firmas y estas entradas salen de pendientes. Finanzas la confirma y puede regresar renglones.</p>
      <ng-template #footer>
        <button pButton type="button" class="p-button-text" (click)="dlg.set(false)">Cancelar</button>
        <button pButton type="button" (click)="deliver()" [disabled]="!recipient() || saving()" [loading]="saving()">Generar folio y PDF</button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display:block; }
    .ep-bar { display:flex; gap:.6rem; align-items:center; flex-wrap:wrap; margin: .8rem 0 .6rem; }
    .ep-date { display:flex; gap:.35rem; align-items:center; font-size:.78rem; color: var(--text-muted); }
    .ep-date input { width: 9.5rem; }
    .ep-gap { display:flex; gap: var(--sp-2); align-items:flex-start; padding: var(--sp-2) var(--sp-3); margin: .4rem 0;
      border-left: 3px solid var(--info-fg); background: var(--info-soft-bg); font-size:.8rem; }
    .ep-gap p { margin:0; }
    .ep-warn { border-left-color: var(--warn-fg); background: var(--warn-soft-bg); }
    .ep-note { margin: .2rem 0 .6rem; font-size:.76rem; color: var(--text-muted); }
    .ep-table { font-size:.84rem; }
    .ta-r { text-align:right; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .ep-muted { color: var(--text-muted); }
    .ep-group td { background: var(--card-bg); }
    .ep-sel td { background: color-mix(in srgb, var(--action) 8%, transparent); }
    .ep-ev { font-size:.74rem; }
    .ep-ev-none { color: var(--text-faint); }
    :host ::ng-deep .ep-tag { font-size:.62rem; margin-left:.3rem; }
    .ep-foot { position: sticky; bottom: 0; display:flex; gap:.6rem; align-items:center; justify-content:flex-end;
      padding: .5rem .75rem; background: var(--surface-bg, var(--card-bg)); border-top: 1px solid var(--border-color); font-size:.84rem; }
    .ep-foot > span { margin-right:auto; }
    .ep-sum { margin: 0 0 .3rem; }
    .ep-sum-list { margin: 0 0 .6rem 1rem; padding: 0; font-size:.8rem; color: var(--text-muted); }
    .ep-lbl { display:block; font-size:.76rem; color: var(--text-muted); margin: .7rem 0 .25rem; }
    .ep-full { width:100%; }
    .ep-select p-select { display:block; width:100%; }
    .ep-hint { margin:.6rem 0 0; font-size:.76rem; color: var(--text-muted); }
  `],
})
export class ComprasEntregaPendientesComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly perms = inject(PermissionsService);
  private readonly api = `${environment.apiUrl}/commercial/purchase-deliveries`;

  /** Avisa al contenedor que se generó una entrega (para refrescar la pestaña de entregas). */
  readonly entregada = output<PurchaseDeliveryDetail>();

  readonly money = money;
  readonly dia = dia;
  readonly evidencia = evidenciaLabel;
  readonly nombre = nombreSucursal;

  readonly basisOpts: SegOption[] = [
    { label: 'Fecha de recepción', value: 'recepcion' },
    { label: 'Fecha de factura', value: 'factura' },
  ];
  readonly basis = signal<DeliveryDateBasis>('recepcion');
  readonly from = signal(periodoPorDefecto(new Date()).from);
  readonly to = signal(periodoPorDefecto(new Date()).to);

  readonly rows = signal<(PendingReceiptRow & { key: string })[]>([]);
  readonly meta = signal<Omit<PendingReceiptsResponse, 'rows'> | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly sel = signal<Set<string>>(new Set());
  readonly grupos = computed(() => agruparPorSucursal(this.rows()));
  readonly selRows = computed(() => { const s = this.sel(); return this.rows().filter((r) => s.has(r.key)); });
  readonly selTotal = computed(() => sumar(this.selRows()));
  readonly selGrupos = computed(() => agruparPorSucursal(this.selRows()));

  readonly dlg = signal(false);
  readonly recipients = signal<DeliveryRecipient[]>([]);
  readonly recipient = signal<string | null>(null);
  readonly notes = signal('');
  readonly saving = signal(false);

  ngOnInit(): void { this.load(); }

  canDeliver(): boolean {
    return this.meta()?.schema_ready === true && this.perms.has(Permission.COMPRAS_OBLIGACIONES_GESTIONAR);
  }

  setBasis(v: string): void { this.basis.set(v === 'factura' ? 'factura' : 'recepcion'); this.load(); }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    const params: Record<string, string> = { date_basis: this.basis() };
    if (this.from()) params['from'] = this.from();
    if (this.to()) params['to'] = this.to();
    this.http.get<PendingReceiptsResponse>(`${this.api}/pending`, { params }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        const { rows, ...meta } = r;
        this.rows.set(rows.map((x) => ({ ...x, key: receiptKey(x) })));
        this.meta.set(meta);
        // Lo marcado que ya no aparece (otro lo entregó, o cambió el filtro) se suelta.
        const vivos = new Set(rows.map(receiptKey));
        this.sel.set(new Set([...this.sel()].filter((k) => vivos.has(k))));
        this.loading.set(false);
      },
      error: (e) => { this.loading.set(false); this.error.set(e?.error?.message || 'No se pudieron cargar las entradas pendientes.'); },
    });
  }

  grupo(suc: string) { return this.grupos().find((g) => g.sucursal === suc); }
  grupoCompleto(suc: string): boolean { const g = this.grupo(suc); const s = this.sel(); return !!g && g.rows.every((r) => s.has(r.key)); }

  toggle(key: string): void {
    const s = new Set(this.sel());
    if (s.has(key)) s.delete(key); else s.add(key);
    this.sel.set(s);
  }

  toggleGrupo(suc: string, on: boolean): void {
    const s = new Set(this.sel());
    for (const r of this.grupo(suc)?.rows ?? []) { if (on) s.add(r.key); else s.delete(r.key); }
    this.sel.set(s);
  }

  clearSel(): void { this.sel.set(new Set()); }

  openDeliver(): void {
    this.recipient.set(null);
    this.notes.set('');
    this.dlg.set(true);
    if (!this.recipients().length) {
      this.http.get<DeliveryRecipient[]>(`${this.api}/recipients`).pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (r) => this.recipients.set(r), error: (e) => this.toast.add({ severity: 'error', summary: 'Sin lista de Finanzas', detail: e?.error?.message || 'No se pudo cargar quién recibe.' }) });
    }
  }

  deliver(): void {
    const recipient = this.recipient();
    if (!recipient || !this.selRows().length) return;
    const body: CreatePurchaseDeliveryDto = {
      recipient_username: recipient,
      date_basis: this.basis(),
      period_from: this.from() || null,
      period_to: this.to() || null,
      items: this.selRows().map((r) => ({ sucursal: r.sucursal, doc_prefix: r.doc_prefix, folio: r.folio })),
      notes: this.notes().trim() || null,
    };
    this.saving.set(true);
    this.http.post<PurchaseDeliveryDetail>(this.api, body).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: async (d) => {
        this.saving.set(false);
        this.dlg.set(false);
        this.sel.set(new Set());
        this.toast.add({ severity: 'success', summary: `Entrega ${d.code}`, detail: `${d.line_count} entradas para ${d.recipient_name || d.recipient_username}. Descargando PDF…` });
        this.entregada.emit(d);
        this.load();
        try {
          const { generarEntregaPdf } = await import('../compras-entrega-pdf');
          await generarEntregaPdf(d, new Date());
        } catch {
          this.toast.add({ severity: 'warn', summary: 'PDF', detail: `La entrega ${d.code} quedó registrada, pero el PDF no se generó. Descárgalo desde "Entregas".` });
        }
      },
      error: (e) => {
        this.saving.set(false);
        this.toast.add({ severity: 'error', summary: 'No se generó la entrega', detail: e?.error?.message || 'Error al generar la entrega.' });
        if (e?.status === 409) this.load();
      },
    });
  }
}
