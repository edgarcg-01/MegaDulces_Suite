import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';
import { CheckboxModule } from 'primeng/checkbox';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { environment } from '../../../../environments/environment';

interface SupplierObligation {
  id: string; supplier_id: string; supplier_name: string; supplier_critical: boolean; supplier_critical_reason: string | null;
  invoice_folio: string | null; concept: string | null; original_amount: number; available_amount: number;
  original_due_date: string | null; status: string;
}
interface SupplierOpt { id: string; name: string; code: string; is_critical: boolean; critical_reason: string | null }

/**
 * Fase TP.3 — Compras: Obligaciones a proveedor de mercancía (ADR-064). La "cuenta por pagar"
 * que alimenta el Calendario de Pagos de Finanzas. También permite marcar un proveedor como
 * crítico (con motivo — nunca se infiere del importe).
 */
@Component({
  selector: 'app-compras-obligaciones',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, InputTextModule, SelectModule, DialogModule, CheckboxModule, TagModule, ToastModule],
  providers: [MessageService],
  template: `
    <div class="surf-page in obl-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Obligaciones a proveedor</h1>
          <p class="surf-page-sub">Cuentas por pagar a proveedores de mercancía: saldo pendiente, vencimiento y negociación. Alimenta el <strong>Calendario de pagos</strong> de Finanzas.</p>
        </div>
        <button pButton type="button" (click)="openNew()"><span class="pi pi-plus"></span>&nbsp;Nueva obligación</button>
      </header>

      <div class="obl-filters">
        <input pInputText type="text" [(ngModel)]="search" (keyup.enter)="load()" placeholder="Proveedor / folio / concepto…" class="p-inputtext-sm obl-search" />
        <label class="obl-check"><p-checkbox [(ngModel)]="onlyCritical" [binary]="true" (onChange)="load()" />Solo proveedores críticos</label>
      </div>

      <p-table [value]="rows()" [loading]="loading()" styleClass="p-datatable-sm surf-table obl-table">
        <ng-template #header>
          <tr><th>Proveedor</th><th>Folio</th><th>Concepto</th><th>Vence</th><th class="ta-r">Disponible</th><th>Estado</th><th style="width:3rem"><span class="sr-only">Acciones</span></th></tr>
        </ng-template>
        <ng-template #body let-o>
          <tr [class.obl-row-critical]="o.supplier_critical">
            <td>{{ o.supplier_name }} @if (o.supplier_critical) { <i class="pi pi-flag obl-crit" [title]="o.supplier_critical_reason"></i> }</td>
          <td class="obl-mono">{{ o.invoice_folio || '—' }}</td>
            <td class="obl-muted">{{ o.concept || '—' }}</td>
            <td class="obl-mono">{{ o.original_due_date || '—' }}</td>
            <td class="ta-r obl-mono">{{ money(o.available_amount) }}</td>
            <td><p-tag [value]="o.status" [severity]="o.status === 'paid' ? 'success' : o.status === 'cancelled' ? 'secondary' : 'info'" styleClass="obl-tag" /></td>
            <td>@if (o.status === 'pending') { <button pButton type="button" class="p-button-sm p-button-text p-button-danger" (click)="cancel(o)" title="Cancelar"><span class="pi pi-times"></span></button> }</td>
          </tr>
        </ng-template>
        <ng-template #emptymessage><tr><td colspan="7" class="obl-empty">Sin obligaciones a proveedor.</td></tr></ng-template>
      </p-table>
    </div>

    <p-dialog [(visible)]="newVisible" [modal]="true" header="Nueva obligación a proveedor" [style]="{ width: '30rem' }">
      <label class="obl-lbl">Proveedor</label>
      <input pInputText type="text" [(ngModel)]="supplierSearch" (ngModelChange)="searchSuppliers($event)" placeholder="Buscar proveedor…" class="obl-full" />
      @if (supplierOpts().length) {
        <div class="obl-sup-list">
          @for (s of supplierOpts(); track s.id) {
            <div class="obl-sup-item" [class.obl-sup-sel]="form.supplier_id === s.id" (click)="pickSupplier(s)">
              {{ s.name }} @if (s.is_critical) { <i class="pi pi-flag obl-crit"></i> }
            </div>
          }
        </div>
      }
      @if (form.supplier_id) {
        <label class="obl-check"><p-checkbox [ngModel]="pickedSupplierCritical" [binary]="true" (onChange)="toggleCritical($event)" />Marcar proveedor como crítico</label>
        @if (pickedSupplierCritical) { <input pInputText type="text" [(ngModel)]="pickedSupplierCriticalReason" placeholder="Motivo (obligatorio)" class="obl-full" /> }
      }
      <label class="obl-lbl">Folio de factura</label>
      <input pInputText type="text" [(ngModel)]="form.invoice_folio" class="obl-full" />
      <label class="obl-lbl">Concepto</label>
      <input pInputText type="text" [(ngModel)]="form.concept" class="obl-full" />
      <label class="obl-lbl">Importe</label>
      <input pInputText type="number" [(ngModel)]="form.original_amount" class="obl-full" />
      <label class="obl-lbl">Vencimiento</label>
      <input type="date" [(ngModel)]="form.original_due_date" class="obl-full" />
      <div class="obl-dlg-actions"><button pButton type="button" (click)="confirmNew()" [loading]="saving()">Guardar</button></div>
    </p-dialog>
  `,
  styles: [`
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .obl-filters { display:flex; gap:.6rem; align-items:center; margin:1rem 0 .6rem; }
    .obl-search { min-width:16rem; }
    .obl-check { display:flex; align-items:center; gap:.35rem; font-size:.78rem; color:var(--text-muted); }
    .obl-table { font-size:.84rem; }
    .ta-r { text-align:right; }
    .obl-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
    .obl-muted { color:var(--text-muted); }
    .obl-crit { color:var(--bad-fg); margin-left:.3rem; }
    .obl-row-critical { background:color-mix(in srgb, var(--bad-fg) 5%, transparent); }
    :host ::ng-deep .obl-tag { font-size:.64rem; }
    .obl-empty { text-align:center; color:var(--text-faint); padding:1.2rem; }
    .obl-lbl { display:block; font-size:.76rem; color:var(--text-muted); margin:.4rem 0 .2rem; }
    .obl-full { width:100%; margin-bottom:.3rem; }
    .obl-sup-list { border:1px solid var(--border-color); border-radius:var(--r-md); max-height:8rem; overflow-y:auto; margin-bottom:.4rem; }
    .obl-sup-item { padding:.3rem .6rem; font-size:.82rem; cursor:pointer; }
    .obl-sup-item:hover { background:var(--card-bg); }
    .obl-sup-sel { background:color-mix(in srgb, var(--action) 12%, transparent); font-weight:600; }
    .obl-dlg-actions { margin-top:.8rem; }
  `],
})
export class ComprasObligacionesComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly base = `${environment.apiUrl}/commercial/supplier-obligations`;

  rows = signal<SupplierObligation[]>([]);
  loading = signal(false);
  saving = signal(false);
  search = '';
  onlyCritical = false;

  newVisible = false;
  form: any = {};
  supplierSearch = '';
  supplierOpts = signal<SupplierOpt[]>([]);
  pickedSupplierCritical = false;
  pickedSupplierCriticalReason = '';
  private searchTimer: any;

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading.set(true);
    const p = new URLSearchParams();
    if (this.search.trim()) p.set('search', this.search.trim());
    if (this.onlyCritical) p.set('onlyCritical', 'true');
    this.http.get<SupplierObligation[]>(`${this.base}?${p.toString()}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => { this.rows.set(rows); this.loading.set(false); },
      error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar las obligaciones.' }); },
    });
  }

  openNew(): void { this.form = {}; this.supplierSearch = ''; this.supplierOpts.set([]); this.pickedSupplierCritical = false; this.pickedSupplierCriticalReason = ''; this.newVisible = true; }

  searchSuppliers(term: string): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.http.get<SupplierOpt[]>(`${this.base}/suppliers`, { params: { search: term } }).pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (r) => this.supplierOpts.set(r), error: () => this.supplierOpts.set([]) });
    }, 250);
  }

  pickSupplier(s: SupplierOpt): void {
    this.form.supplier_id = s.id;
    this.supplierSearch = s.name;
    this.supplierOpts.set([]);
    this.pickedSupplierCritical = s.is_critical;
    this.pickedSupplierCriticalReason = s.critical_reason || '';
  }

  toggleCritical(event: { checked?: boolean }): void { this.pickedSupplierCritical = !!event.checked; }

  confirmNew(): void {
    if (!this.form.supplier_id || !(Number(this.form.original_amount) > 0)) {
      this.toast.add({ severity: 'warn', summary: 'Faltan datos', detail: 'Proveedor e importe son requeridos.' }); return;
    }
    this.saving.set(true);
    this.http.post(this.base, this.form).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        const applyCritical = () => {
          this.saving.set(false); this.newVisible = false; this.load();
          this.toast.add({ severity: 'success', summary: 'Guardado', detail: 'Obligación registrada.' });
        };
        if (this.pickedSupplierCritical && this.pickedSupplierCriticalReason.trim()) {
          this.http.post(`${this.base}/suppliers/${this.form.supplier_id}/critico`, { is_critical: true, reason: this.pickedSupplierCriticalReason.trim() })
            .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: applyCritical, error: applyCritical });
        } else applyCritical();
      },
      error: (e) => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo guardar.' }); },
    });
  }

  cancel(o: SupplierObligation): void {
    this.http.post(`${this.base}/${o.id}/cancelar`, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.load(); this.toast.add({ severity: 'info', summary: 'Cancelado', detail: 'La obligación se canceló.' }); },
      error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo cancelar.' }),
    });
  }

  money(n: number | null | undefined): string { return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 }); }
}
