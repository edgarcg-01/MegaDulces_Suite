import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { DialogModule } from 'primeng/dialog';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { environment } from '../../../../environments/environment';
import { Permission } from '../../../core/constants/permissions';
import { PermissionsService } from '../../../core/services/permissions.service';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { money, moneyShort } from '../../../shared/util/money.util';
import type {
  CreditTermBase, CreditTermsStatus, SupplierCreditTermsHistoryRow, SupplierCreditTermsResponse,
  SupplierCreditTermsRow, SupplierCreditTermsSummary, UpdateSupplierCreditTermsDto,
} from '@megadulces/contracts';

type Status = CreditTermsStatus;
type Base = CreditTermBase;
type Mode = 'credito' | 'contado' | 'interno';
type TermsRow = SupplierCreditTermsRow;

const STATUS_LABEL: Record<Status, string> = {
  sin_plazo: 'Sin plazo', sin_confirmar: 'Sin confirmar', confirmado: 'Confirmado', interno: 'Interno',
};

/**
 * `[RE.30]` — **Plazos de pago a proveedor.** Lista de trabajo del analista de catálogo.
 *
 * El vencimiento de lo que Compras entrega a Finanzas depende de dos datos del PROVEEDOR: cuántos
 * días exactos da y desde cuándo corren (fecha de factura o fecha de recepción). Kepler no los tiene
 * bien — sale "de contado" en el 68% de las recepciones porque nunca se capturó — así que aquí se
 * confirman, y lo que dice Kepler queda al lado sólo para comparar.
 *
 * Ordenada por lo recibido en 12 meses: capturar los primeros ~50 cubre el 80% del dinero pendiente.
 */
@Component({
  selector: 'app-compras-plazos-pago',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, InputTextModule, InputNumberModule, IconFieldModule, InputIconModule,
    DialogModule, TagModule, ToastModule, MetricStripComponent, SegmentedComponent, LoadStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="pp-page" [class.surf-page]="!embedded()" [class.in]="!embedded()">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          @if (!embedded()) { <h1>Plazos de pago a proveedor</h1> }
          <p class="surf-page-sub">Cuántos días de crédito da cada proveedor y desde cuándo corren. De aquí sale el vencimiento de lo que Compras le entrega a Finanzas.</p>
        </div>
        <button pButton type="button" class="p-button-sm p-button-text" [disabled]="loading()" (click)="load()">
          <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
          <span class="p-button-label">Actualizar</span>
        </button>
      </header>

      @if (summary(); as s) {
        <p class="pp-verdict">
          @if (s.sin_plazo + s.sin_confirmar > 0) {
            Faltan <b>{{ s.sin_plazo + s.sin_confirmar }}</b> de {{ s.suppliers }} proveedores por confirmar.
            Con los primeros <b>{{ s.pending_suppliers_for_80pct }}</b> de la lista se cubre el 80% de lo recibido sin plazo
            (<b>{{ moneyShort(s.pending_amount) }}</b> en 12 meses).
          } @else {
            Los {{ s.suppliers }} proveedores con recepciones en 12 meses tienen su plazo confirmado.
          }
        </p>
        <app-metric-strip [items]="kpis()" ariaLabel="Estado de los plazos de pago" />
        <div class="pp-gap">
          <i class="pi pi-info-circle" aria-hidden="true"></i>
          <p>La condición de Kepler sale <b>"de contado"</b> en la mayoría de las recepciones porque el plazo nunca se capturó allá: no la tomes como dato. Sólo aparecen proveedores de <b>Kepler</b>; los de Wincaja usan otros códigos y todavía no se pueden ligar.</p>
        </div>
      }

      <div class="pp-filters">
        <app-segmented [options]="filterOpts" [value]="filter()" (valueChange)="setFilter($event)" ariaLabel="Filtrar por estado" />
        <div class="pp-search"><p-iconfield>
          <p-inputicon styleClass="pi pi-search" />
          <input pInputText type="text" [(ngModel)]="search" (keyup.enter)="load()" placeholder="Proveedor o código…" aria-label="Buscar proveedor" />
        </p-iconfield></div>
      </div>

      <app-load-state [loading]="loading()" [error]="error()" [isEmpty]="!loading() && !error() && !rows().length"
                      emptyTitle="Nada en este filtro" emptyHint="Cambia el filtro o la búsqueda." (retry)="load()">
        <p-table [value]="rows()" [scrollable]="true" scrollHeight="flex" [paginator]="rows().length > 100" [rows]="100"
                 size="small" class="surf-table pp-table">
          <ng-template #header>
            <tr>
              <th>Proveedor</th>
              <th class="ta-r" title="Total con IVA de las órdenes de entrada de los últimos 12 meses">Recibido 12m</th>
              <th class="ta-r">Recep.</th>
              <th title="Condición de pago más frecuente en Kepler — sólo referencia">Kepler dice</th>
              <th>Plazo</th>
              <th>Estado</th>
              <th>Confirmó</th>
              <th style="width:3rem"><span class="sr-only">Acciones</span></th>
            </tr>
          </ng-template>
          <ng-template #body let-r>
            <tr>
              <td>
                <div class="pp-name">{{ r.name }}</div>
                <div class="pp-code">{{ r.code }}</div>
              </td>
              <td class="ta-r mono">{{ money(r.received_amount) }}</td>
              <td class="ta-r mono">{{ r.received_count }}</td>
              <td class="pp-muted">
                {{ r.kepler_condition || '—' }}
                @if (r.kepler_variants > 1) { <span class="pp-variants" [title]="'Kepler tiene ' + r.kepler_variants + ' condiciones distintas para este proveedor'">{{ r.kepler_variants }} variantes</span> }
              </td>
              <td>{{ termLabel(r) }}</td>
              <td>
                <p-tag [value]="statusLabel(r.status)" [severity]="statusSeverity(r.status)" styleClass="pp-tag" />
                @if (r.differs_from_kepler) { <p-tag value="Difiere de Kepler" severity="warn" styleClass="pp-tag" /> }
              </td>
              <td class="pp-muted">
                @if (r.credit_terms_updated_by) { {{ r.credit_terms_updated_by }} · {{ r.credit_terms_updated_at | date: 'dd/MM/yy' }} }
                @else if (r.credit_days != null && !r.is_internal) { Excel del programa de pagos }
                @else { — }
              </td>
              <td>
                @if (canEdit()) {
                  <button pButton type="button" class="p-button-sm p-button-text" (click)="openEdit(r)" [attr.aria-label]="'Editar plazo de ' + r.name">
                    <span class="pi pi-pencil" aria-hidden="true"></span>
                  </button>
                }
              </td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>
    </div>

    <p-dialog [visible]="editVisible()" (visibleChange)="editVisible.set($event)" [modal]="true" [style]="{ width: '32rem' }"
              [header]="editing()?.name || 'Plazo de pago'">
      @if (editing(); as r) {
        <p class="pp-ref">Kepler dice: <b>{{ r.kepler_condition || 'sin dato' }}</b> · {{ r.received_count }} recepciones · {{ money(r.received_amount) }} en 12 meses</p>

        <app-segmented [options]="modeOpts" [value]="mode()" (valueChange)="mode.set($any($event))" ariaLabel="Tipo de plazo" />

        @if (mode() === 'credito') {
          <label class="pp-lbl" for="pp-days">Días de crédito (exactos)</label>
          <p-inputnumber inputId="pp-days" [ngModel]="days()" (ngModelChange)="days.set($event)" [min]="1" [max]="365" [useGrouping]="false" />
          <label class="pp-lbl">El plazo corre desde</label>
          <app-segmented [options]="baseOpts" [value]="base() || ''" (valueChange)="base.set($any($event))" ariaLabel="Desde cuándo corre el plazo" />
          @if (base() === 'recepcion') { <p class="pp-hint">El vencimiento será la fecha de llegada física que capture la zona + {{ days() || 'N' }} días.</p> }
          @if (base() === 'factura') { <p class="pp-hint">El vencimiento será la fecha de la factura (la de Kepler) + {{ days() || 'N' }} días.</p> }
        }
        @if (mode() === 'contado') { <p class="pp-hint">Se paga el mismo día de la factura.</p> }
        @if (mode() === 'interno') {
          <p class="pp-hint">Entidad propia (CEDIS, sucursal, dueño): sus entradas son traspasos y no generan deuda con proveedor.</p>
          <label class="pp-lbl" for="pp-reason">Motivo</label>
          <input pInputText id="pp-reason" type="text" [ngModel]="reason()" (ngModelChange)="reason.set($event)" class="pp-full" />
        }

        <label class="pp-lbl" for="pp-note">Nota (opcional)</label>
        <input pInputText id="pp-note" type="text" [ngModel]="note()" (ngModelChange)="note.set($event)" placeholder="Ej. confirmado con el proveedor por correo" class="pp-full" />

        @if (history().length) {
          <div class="pp-hist">
            <div class="pp-lbl">Cambios anteriores</div>
            @for (h of history(); track h.id) {
              <div class="pp-hist-row">
                <span class="mono">{{ h.created_at | date: 'dd/MM/yy HH:mm' }}</span> · {{ h.created_by }} ·
                {{ histLabel(h.old_credit_days, h.old_credit_term_base, h.old_is_internal) }} → <b>{{ histLabel(h.new_credit_days, h.new_credit_term_base, h.new_is_internal) }}</b>
                @if (h.note) { <span class="pp-muted"> — {{ h.note }}</span> }
              </div>
            }
          </div>
        }
      }
      <ng-template #footer>
        @if (blockReason(); as why) { <span class="pp-block">{{ why }}</span> }
        <button pButton type="button" class="p-button-text" (click)="editVisible.set(false)">Cancelar</button>
        <button pButton type="button" (click)="save()" [disabled]="!!blockReason()" [loading]="saving()">Guardar</button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .pp-verdict { margin: .6rem 0; font-size: var(--fs-body); line-height:1.55; color: var(--text-main); }
    .pp-verdict b { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .pp-gap { display:flex; gap: var(--sp-2); align-items:flex-start; padding: var(--sp-2) var(--sp-3); margin: .6rem 0;
      border-left: 3px solid var(--info-fg); background: var(--info-soft-bg); font-size:.8rem; }
    .pp-gap p { margin:0; }
    .pp-filters { display:flex; gap:.6rem; align-items:center; flex-wrap:wrap; margin: .8rem 0 .6rem; }
    /* GOTCHAS §41: PrimeNG 22 ignora styleClass en p-inputnumber → se apunta al ELEMENTO. */
    .pp-search input { min-width: 16rem; }
    :host ::ng-deep p-inputnumber, :host ::ng-deep p-inputnumber input { width: 100%; }
    .pp-table { font-size:.84rem; }
    .ta-r { text-align:right; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .pp-name { font-weight:600; }
    .pp-code { font-family: var(--font-mono); font-size:.72rem; color: var(--text-faint); }
    .pp-muted { color: var(--text-muted); }
    .pp-variants { margin-left:.35rem; font-size:.68rem; color: var(--warn-fg); white-space:nowrap; }
    :host ::ng-deep .pp-tag { font-size:.64rem; margin-right:.25rem; }
    .pp-ref { margin: 0 0 .7rem; font-size:.8rem; color: var(--text-muted); }
    .pp-lbl { display:block; font-size:.76rem; color: var(--text-muted); margin: .7rem 0 .25rem; }
    .pp-full { width:100%; }
    .pp-hint { margin: .4rem 0 0; font-size:.78rem; color: var(--text-muted); }
    .pp-hist { margin-top: .8rem; border-top: 1px solid var(--border-color); padding-top: .4rem; max-height: 9rem; overflow-y:auto; }
    .pp-hist-row { font-size:.75rem; padding: .15rem 0; }
    .pp-block { font-size:.75rem; color: var(--text-muted); margin-right: auto; }
  `],
})
export class ComprasPlazosPagoComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly perms = inject(PermissionsService);
  private readonly api = `${environment.apiUrl}/commercial/supplier-credit-terms`;

  /** Dentro de la pestaña de Obligaciones: sin título propio (la página ya tiene uno). */
  readonly embedded = input(false);

  readonly money = money;
  readonly moneyShort = moneyShort;

  readonly rows = signal<TermsRow[]>([]);
  readonly summary = signal<SupplierCreditTermsSummary | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly filter = signal<string>('pendientes');
  search = '';

  /** Fijar el plazo pactado es del comprador o dirección (COMPRAS_PLAZOS_AUTORIZAR), no de quien opera. */
  canEdit(): boolean { return this.perms.has(Permission.COMPRAS_PLAZOS_AUTORIZAR); }

  readonly filterOpts: SegOption[] = [
    { label: 'Pendientes', value: 'pendientes' },
    { label: 'Sin plazo', value: 'sin_plazo' },
    { label: 'Sin confirmar', value: 'sin_confirmar' },
    { label: 'Confirmados', value: 'confirmado' },
    { label: 'Difieren de Kepler', value: 'difiere' },
    { label: 'Internos', value: 'interno' },
    { label: 'Todos', value: 'todos' },
  ];
  readonly modeOpts: SegOption[] = [
    { label: 'Crédito', value: 'credito' },
    { label: 'Contado', value: 'contado' },
    { label: 'Interno (traspaso)', value: 'interno' },
  ];
  readonly baseOpts: SegOption[] = [
    { label: 'Fecha de factura', value: 'factura' },
    { label: 'Fecha de recepción', value: 'recepcion' },
  ];

  readonly kpis = computed<MetricStripItem[]>(() => {
    const s = this.summary();
    if (!s) return [];
    return [
      { label: 'Proveedores (12m)', value: s.suppliers, format: 'number', sub: moneyShort(s.received_amount) + ' recibido' },
      { label: 'Sin plazo', value: s.sin_plazo, format: 'number', tone: s.sin_plazo ? 'bad' : 'default' },
      { label: 'Sin confirmar', value: s.sin_confirmar, format: 'number', tone: s.sin_confirmar ? 'warn' : 'default', sub: 'vienen del Excel' },
      { label: 'Confirmados', value: s.confirmado, format: 'number' },
      { label: 'Difieren de Kepler', value: s.differs_from_kepler, format: 'number', tone: s.differs_from_kepler ? 'warn' : 'default' },
      { label: 'Internos', value: s.interno, format: 'number' },
    ];
  });

  // Diálogo — todo en signals: un computed sobre campos planos se queda congelado (lección CG.22).
  readonly editVisible = signal(false);
  readonly editing = signal<TermsRow | null>(null);
  readonly mode = signal<Mode>('credito');
  readonly days = signal<number | null>(null);
  readonly base = signal<Base | null>(null);
  readonly reason = signal('');
  readonly note = signal('');
  readonly saving = signal(false);
  readonly history = signal<SupplierCreditTermsHistoryRow[]>([]);

  readonly blockReason = computed<string | null>(() => {
    const m = this.mode();
    if (m === 'credito') {
      const d = this.days();
      if (d == null || !Number.isInteger(d) || d < 1 || d > 365) return 'Captura los días (1 a 365).';
      if (!this.base()) return 'Elige desde cuándo corre el plazo.';
    }
    if (m === 'interno' && !this.reason().trim()) return 'Escribe el motivo.';
    return null;
  });

  ngOnInit(): void { this.load(); }

  setFilter(v: string): void { this.filter.set(v); this.load(); }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    const params: Record<string, string> = { filter: this.filter() };
    if (this.search.trim()) params['search'] = this.search.trim();
    this.http.get<SupplierCreditTermsResponse>(this.api, { params })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.summary.set(r.summary); this.rows.set(r.rows); this.loading.set(false); },
        error: (e) => { this.loading.set(false); this.error.set(e?.error?.message || 'No se pudieron cargar los plazos.'); },
      });
  }

  openEdit(r: TermsRow): void {
    this.editing.set(r);
    this.mode.set(r.is_internal ? 'interno' : r.credit_days === 0 ? 'contado' : 'credito');
    this.days.set(r.credit_days && r.credit_days > 0 ? r.credit_days : null);
    this.base.set(r.credit_term_base);
    this.reason.set(r.internal_reason || '');
    this.note.set('');
    this.history.set([]);
    this.editVisible.set(true);
    this.http.get<SupplierCreditTermsHistoryRow[]>(`${this.api}/${r.id}/history`).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (h) => this.history.set(h), error: () => this.history.set([]) });
  }

  save(): void {
    const r = this.editing();
    if (!r || this.blockReason()) return;
    const m = this.mode();
    const body: UpdateSupplierCreditTermsDto = {
      credit_days: m === 'credito' ? this.days() : m === 'contado' ? 0 : null,
      credit_term_base: m === 'credito' ? this.base() : null,
      is_internal: m === 'interno',
      internal_reason: m === 'interno' ? this.reason().trim() : null,
      note: this.note().trim() || null,
    };
    this.saving.set(true);
    this.http.put(`${this.api}/${r.id}`, body).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.saving.set(false);
        this.editVisible.set(false);
        this.toast.add({ severity: 'success', summary: 'Plazo guardado', detail: r.name });
        this.load();
      },
      error: (e) => {
        this.saving.set(false);
        this.toast.add({ severity: 'error', summary: 'No se guardó', detail: e?.error?.message || 'Error al guardar el plazo.' });
      },
    });
  }

  termLabel(r: TermsRow): string {
    if (r.is_internal) return 'Traspaso interno';
    return this.histLabel(r.credit_days, r.credit_term_base, false);
  }

  histLabel(days: number | null, base: Base | null, internal: boolean | null): string {
    if (internal) return 'Interno';
    if (days == null) return '—';
    if (days === 0) return 'Contado';
    return `${days} d desde ${base === 'recepcion' ? 'recepción' : base === 'factura' ? 'factura' : '¿?'}`;
  }

  statusLabel(s: Status): string { return STATUS_LABEL[s]; }
  statusSeverity(s: Status): 'danger' | 'warn' | 'success' | 'secondary' {
    return s === 'sin_plazo' ? 'danger' : s === 'sin_confirmar' ? 'warn' : s === 'confirmado' ? 'success' : 'secondary';
  }
}
