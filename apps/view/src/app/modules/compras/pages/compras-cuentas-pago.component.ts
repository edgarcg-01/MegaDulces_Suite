import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { DialogModule } from 'primeng/dialog';
import { CheckboxModule } from 'primeng/checkbox';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { environment } from '../../../../environments/environment';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';

interface SupplierOpt { id: string; name: string; code: string }
interface PaymentAccount { id: string; bank_name: string; account_number: string | null; clabe: string | null; alias: string | null; notes: string | null; attachment_url: string | null; es_favorita: boolean; status: string }
interface ChangeRequest {
  id: string; supplier_id: string; supplier_name: string; account_id: string | null; deactivate: boolean;
  proposed_bank_name: string | null; proposed_account_number: string | null; proposed_clabe: string | null;
  proposed_alias: string | null; proposed_es_favorita: boolean; reason: string; status: string;
  requested_by: string; requested_at: string; decided_by: string | null; decision_notes: string | null;
}

/**
 * Fase TP.7 (ADR-064) — Catálogo de cuentas de pago a proveedor. TODA alta o cambio pasa por una
 * solicitud (control anti-fraude) — se aprueba/rechaza con FINANCE_PAYMENT_CALENDAR_AUTORIZAR,
 * el MISMO permiso que autoriza el Calendario de Pagos (separación real de quien pide el cambio).
 */
@Component({
  selector: 'app-compras-cuentas-pago',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, InputTextModule, DialogModule, CheckboxModule, TagModule, ToastModule],
  providers: [MessageService],
  template: `
    <div class="surf-page in cta-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Cuentas de pago a proveedor</h1>
          <p class="surf-page-sub">Banco/cuenta/CLABE de cada proveedor, con el comprobante de la solicitud de pago adjunto para evitar errores. Toda alta o cambio requiere autorización — no hay edición directa.</p>
        </div>
        <button pButton type="button" (click)="openNewSupplierPick()"><span class="pi pi-plus"></span>&nbsp;Solicitar cuenta</button>
      </header>

      <section class="cta-section">
        <div class="cta-section-head"><h2>Buscar proveedor</h2></div>
        <input pInputText type="text" [(ngModel)]="supplierSearch" (ngModelChange)="searchSuppliers($event)" placeholder="Buscar proveedor…" class="cta-search" />
        @if (supplierOpts().length) {
          <div class="cta-sup-list">
            @for (s of supplierOpts(); track s.id) {
              <div class="cta-sup-item" (click)="pickSupplier(s)">{{ s.name }}</div>
            }
          </div>
        }
        @if (selectedSupplier()) {
          <div class="cta-sup-current">Proveedor seleccionado: <strong>{{ selectedSupplier()!.name }}</strong></div>
          <p-table [value]="accounts()" [loading]="loadingAccounts()" styleClass="p-datatable-sm surf-table cta-table">
            <ng-template #header><tr><th>Banco</th><th>Cuenta</th><th>CLABE</th><th>Alias</th><th>Favorita</th><th>Adjunto</th><th style="width:8rem"></th></tr></ng-template>
            <ng-template #body let-a>
              <tr>
                <td>{{ a.bank_name }}</td><td class="cta-mono">{{ a.account_number || '—' }}</td><td class="cta-mono">{{ a.clabe || '—' }}</td>
                <td>{{ a.alias || '—' }}</td><td>@if (a.es_favorita) { <i class="pi pi-star-fill cta-fav"></i> }</td>
                <td>@if (a.attachment_url) { <span class="pi pi-file cta-att" title="Tiene comprobante adjunto"></span> } @else { <span class="cta-muted">—</span> }</td>
                <td>
                  <button pButton type="button" class="p-button-sm p-button-text" (click)="openChange(a)">Cambiar</button>
                  <button pButton type="button" class="p-button-sm p-button-text p-button-danger" (click)="openDeactivate(a)">Baja</button>
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="7" class="cta-empty">Sin cuentas registradas para este proveedor.</td></tr></ng-template>
          </p-table>
        }
      </section>

      <section class="cta-section">
        <div class="cta-section-head"><h2>Solicitudes pendientes</h2></div>
        <p-table [value]="requests()" [loading]="loadingRequests()" styleClass="p-datatable-sm surf-table cta-table">
          <ng-template #header><tr><th>Proveedor</th><th>Tipo</th><th>Propuesta</th><th>Motivo</th><th>Solicitó</th><th style="width:12rem"></th></tr></ng-template>
          <ng-template #body let-r>
            <tr>
              <td>{{ r.supplier_name }}</td>
              <td><p-tag [value]="tipoLabel(r)" severity="info" styleClass="cta-tag" /></td>
              <td>{{ r.proposed_bank_name || '—' }} @if (r.proposed_clabe) { <span class="cta-muted"> · {{ r.proposed_clabe }}</span> }</td>
              <td class="cta-reason">{{ r.reason }}</td>
              <td class="cta-muted">{{ r.requested_by }}</td>
              <td>
                @if (canAuthorize()) {
                  <button pButton type="button" class="p-button-sm" (click)="approve(r)">Aprobar</button>
                  <button pButton type="button" class="p-button-sm p-button-text p-button-danger" (click)="reject(r)">Rechazar</button>
                } @else { <span class="cta-muted">Requiere autorización</span> }
              </td>
            </tr>
          </ng-template>
          <ng-template #emptymessage><tr><td colspan="6" class="cta-empty">Sin solicitudes pendientes.</td></tr></ng-template>
        </p-table>
      </section>
    </div>

    <p-dialog [(visible)]="requestVisible" [modal]="true" [header]="requestTitle()" [style]="{ width: '30rem' }">
      @if (!requestSupplier()) {
        <input pInputText type="text" [(ngModel)]="dlgSupplierSearch" (ngModelChange)="searchSuppliers($event)" placeholder="Buscar proveedor…" class="cta-full" />
        @if (supplierOpts().length) {
          <div class="cta-sup-list">
            @for (s of supplierOpts(); track s.id) { <div class="cta-sup-item" (click)="requestSupplier.set(s)">{{ s.name }}</div> }
          </div>
        }
      } @else {
        <p class="cta-dlg-p">{{ requestSupplier()!.name }}</p>
      }
      @if (!requestDeactivate) {
        <label class="cta-lbl">Banco</label>
        <input pInputText type="text" [(ngModel)]="form.proposed_bank_name" class="cta-full" />
        <label class="cta-lbl">Número de cuenta</label>
        <input pInputText type="text" [(ngModel)]="form.proposed_account_number" class="cta-full" />
        <label class="cta-lbl">CLABE</label>
        <input pInputText type="text" [(ngModel)]="form.proposed_clabe" class="cta-full" />
        <label class="cta-lbl">Alias</label>
        <input pInputText type="text" [(ngModel)]="form.proposed_alias" class="cta-full" />
        <label class="cta-check"><p-checkbox [(ngModel)]="form.proposed_es_favorita" [binary]="true" />Marcar como favorita</label>
        <label class="cta-lbl">Adjunto — JPG/PDF de la solicitud de pago</label>
        <input type="file" accept="image/*,application/pdf" (change)="onFile($event)" class="cta-full" />
        @if (uploadedUrl()) { <p class="cta-uploaded">✓ Archivo adjuntado</p> }
      }
      <label class="cta-lbl">Motivo (obligatorio)</label>
      <input pInputText type="text" [(ngModel)]="form.reason" placeholder="Por qué se solicita este cambio" class="cta-full" />
      <div class="cta-dlg-actions"><button pButton type="button" (click)="confirmRequest()" [loading]="saving()">Enviar a autorización</button></div>
    </p-dialog>
  `,
  styles: [`
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .cta-section { margin-top:1.4rem; }
    .cta-section h2 { font-size:.95rem; margin:0 0 .5rem; }
    .cta-search, .cta-full { width:100%; margin-bottom:.4rem; }
    .cta-sup-list { border:1px solid var(--border-color); border-radius:var(--r-md); max-height:8rem; overflow-y:auto; margin-bottom:.5rem; }
    .cta-sup-item { padding:.3rem .6rem; font-size:.82rem; cursor:pointer; }
    .cta-sup-item:hover { background:var(--card-bg); }
    .cta-sup-current { font-size:.82rem; color:var(--text-muted); margin:.4rem 0; }
    .cta-table { font-size:.84rem; margin-top:.3rem; }
    .cta-mono { font-family:var(--font-mono); }
    .cta-muted { color:var(--text-muted); }
    .cta-fav { color:#f5a623; }
    .cta-att { color:var(--action); }
    .cta-empty { text-align:center; color:var(--text-faint); padding:1.2rem; }
    .cta-reason { max-width:16rem; white-space:normal; }
    :host ::ng-deep .cta-tag { font-size:.64rem; }
    .cta-lbl { display:block; font-size:.76rem; color:var(--text-muted); margin:.4rem 0 .2rem; }
    .cta-check { display:flex; align-items:center; gap:.4rem; margin:.4rem 0; font-size:.82rem; }
    .cta-dlg-p { font-size:.85rem; font-weight:600; margin:0 0 .4rem; }
    .cta-dlg-actions { margin-top:.8rem; }
    .cta-uploaded { font-size:.78rem; color:var(--ok-fg); margin:.2rem 0; }
  `],
})
export class ComprasCuentasPagoComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly base = `${environment.apiUrl}/commercial/supplier-payment-accounts`;

  readonly canAuthorize = computed(() => this.perms.isAdmin() || this.auth.user()?.permissions?.[Permission.FINANCE_PAYMENT_CALENDAR_AUTORIZAR] === true);

  supplierSearch = '';
  dlgSupplierSearch = '';
  supplierOpts = signal<SupplierOpt[]>([]);
  selectedSupplier = signal<SupplierOpt | null>(null);
  accounts = signal<PaymentAccount[]>([]);
  loadingAccounts = signal(false);
  requests = signal<ChangeRequest[]>([]);
  loadingRequests = signal(false);
  saving = signal(false);
  private searchTimer: any;

  requestVisible = false;
  requestSupplier = signal<SupplierOpt | null>(null);
  requestDeactivate = false;
  requestAccountId: string | null = null;
  uploadedUrl = signal<string | null>(null);
  uploadedKind: 'pdf' | 'image' | null = null;
  form: any = {};

  ngOnInit(): void { this.loadRequests(); }

  requestTitle(): string { return this.requestDeactivate ? 'Solicitar baja de cuenta' : 'Solicitar cuenta de pago'; }

  searchSuppliers(term: string): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.http.get<SupplierOpt[]>(`${environment.apiUrl}/commercial/supplier-obligations/suppliers`, { params: { search: term } })
        .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.supplierOpts.set(r), error: () => this.supplierOpts.set([]) });
    }, 250);
  }

  pickSupplier(s: SupplierOpt): void {
    this.selectedSupplier.set(s); this.supplierOpts.set([]); this.supplierSearch = s.name;
    this.loadAccounts(s.id);
  }
  loadAccounts(supplierId: string): void {
    this.loadingAccounts.set(true);
    this.http.get<PaymentAccount[]>(`${this.base}/by-supplier/${supplierId}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => { this.accounts.set(rows); this.loadingAccounts.set(false); },
      error: () => { this.loadingAccounts.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar las cuentas.' }); },
    });
  }

  loadRequests(): void {
    this.loadingRequests.set(true);
    this.http.get<ChangeRequest[]>(`${this.base}/solicitudes`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => { this.requests.set(rows); this.loadingRequests.set(false); },
      error: () => { this.loadingRequests.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar las solicitudes.' }); },
    });
  }

  tipoLabel(r: ChangeRequest): string { return r.deactivate ? 'Baja' : r.account_id ? 'Cambio' : 'Alta'; }

  openNewSupplierPick(): void {
    this.requestDeactivate = false; this.requestAccountId = null; this.form = { proposed_es_favorita: false, reason: '' };
    this.requestSupplier.set(this.selectedSupplier()); this.dlgSupplierSearch = ''; this.uploadedUrl.set(null); this.uploadedKind = null;
    this.requestVisible = true;
  }
  openChange(a: PaymentAccount): void {
    this.requestDeactivate = false; this.requestAccountId = a.id;
    this.form = { proposed_bank_name: a.bank_name, proposed_account_number: a.account_number, proposed_clabe: a.clabe, proposed_alias: a.alias, proposed_es_favorita: a.es_favorita, reason: '' };
    this.requestSupplier.set(this.selectedSupplier()); this.uploadedUrl.set(null); this.uploadedKind = null;
    this.requestVisible = true;
  }
  openDeactivate(a: PaymentAccount): void {
    this.requestDeactivate = true; this.requestAccountId = a.id; this.form = { reason: '' };
    this.requestSupplier.set(this.selectedSupplier());
    this.requestVisible = true;
  }

  onFile(ev: Event): void {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      this.http.post<{ url: string; kind: 'pdf' | 'image' }>(`${this.base}/adjunto`, { file_base64: reader.result as string })
        .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
          next: (r) => { this.uploadedUrl.set(r.url); this.uploadedKind = r.kind; },
          error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo subir el archivo.' }),
        });
    };
    reader.readAsDataURL(file);
  }

  confirmRequest(): void {
    const supplier = this.requestSupplier();
    if (!supplier) { this.toast.add({ severity: 'warn', summary: 'Falta el proveedor', detail: 'Selecciona un proveedor.' }); return; }
    if (!this.form.reason?.trim()) { this.toast.add({ severity: 'warn', summary: 'Falta el motivo', detail: 'El cambio de cuenta necesita justificación.' }); return; }
    this.saving.set(true);
    this.http.post(`${this.base}/solicitudes`, {
      supplier_id: supplier.id, account_id: this.requestAccountId, deactivate: this.requestDeactivate,
      proposed_bank_name: this.form.proposed_bank_name, proposed_account_number: this.form.proposed_account_number,
      proposed_clabe: this.form.proposed_clabe, proposed_alias: this.form.proposed_alias,
      proposed_es_favorita: !!this.form.proposed_es_favorita, proposed_attachment_url: this.uploadedUrl(),
      proposed_attachment_kind: this.uploadedKind, reason: this.form.reason,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.saving.set(false); this.requestVisible = false; this.loadRequests(); this.toast.add({ severity: 'success', summary: 'Enviado', detail: 'La solicitud quedó pendiente de autorización.' }); },
      error: (e) => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo enviar.' }); },
    });
  }

  approve(r: ChangeRequest): void {
    this.http.post(`${this.base}/solicitudes/${r.id}/aprobar`, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.loadRequests(); if (this.selectedSupplier()) this.loadAccounts(this.selectedSupplier()!.id); this.toast.add({ severity: 'success', summary: 'Aprobado', detail: 'La cuenta se aplicó.' }); },
      error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo aprobar.' }),
    });
  }
  reject(r: ChangeRequest): void {
    this.http.post(`${this.base}/solicitudes/${r.id}/rechazar`, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.loadRequests(); this.toast.add({ severity: 'info', summary: 'Rechazado', detail: 'La solicitud se rechazó.' }); },
      error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo rechazar.' }),
    });
  }
}
