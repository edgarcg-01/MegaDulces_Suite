import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { TagModule } from 'primeng/tag';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { CONTABILIDAD_TABS } from '../contabilidad-tabs';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { CredencialesService, CredStatus } from '../credenciales.service';

/**
 * FISCAL.2 — Bóveda de credenciales SAT / e.firma (Operations). Estado no sensible
 * (vigencia, días para vencer) + alta cifrada (.cer/.key/contraseña). El material
 * se cifra AES-256-GCM en reposo y jamás se devuelve por API. Muy sensible.
 */
@Component({
  selector: 'app-contabilidad-credenciales',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule, DialogModule, InputTextModule, TagModule, ConfirmDialogModule, PageTabsComponent, FreshnessPillComponent, ContextHelpComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService, ConfirmationService],
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <p-confirmDialog></p-confirmDialog>
      <app-page-tabs [tabs]="tabs" />

      <header class="surf-page-head cr-head">
        <div class="surf-page-head-text">
          <h1 class="cr-h1">Credenciales SAT (e.firma) <app-context-help topic="credenciales" /></h1>
          <p class="surf-page-sub">e.firma del contribuyente para la descarga masiva. Se cifra en reposo (AES-256-GCM); el material privado nunca se devuelve.</p>
        </div>
        <div class="cr-head-actions">
          @if (loadedAt()) { <app-freshness-pill [since]="loadedAt()" /> }
          <button pButton type="button" label="Refrescar" icon="pi pi-refresh" class="p-button-sm p-button-text" [loading]="loading()" (click)="reload()"></button>
          @if (canManage) { <button pButton type="button" label="Cargar e.firma" icon="pi pi-upload" class="p-button-sm" (click)="showNew=true"></button> }
        </div>
      </header>

      @if (vaultOff()) {
        <div class="cr-warn"><i class="pi pi-exclamation-triangle"></i> La bóveda no está configurada en el servidor (falta <code>FISCAL_CRYPTO_KEY</code>). No se pueden guardar credenciales hasta configurarla.</div>
      }

      <div class="card-premium card-flat">
        <p-table [value]="rows()" styleClass="p-datatable-sm cr-table" [rowHover]="true" [loading]="loading()">
          <ng-template pTemplate="header">
            <tr><th>RFC</th><th>Razón social</th><th style="width:9rem">Vigencia cert.</th><th class="ta-r" style="width:8rem">Días</th><th style="width:7rem">Estado</th><th style="width:5rem"></th></tr>
          </ng-template>
          <ng-template pTemplate="body" let-c>
            <tr>
              <td class="mono strong">{{ c.rfc }}</td>
              <td>{{ c.razon_social || '—' }}</td>
              <td class="mono">{{ c.cer_valid_to ? (c.cer_valid_to | date:'dd/MM/yyyy') : '—' }}</td>
              <td class="ta-r mono" [class.bad]="c.dias_para_vencer != null && c.dias_para_vencer < 30">{{ c.dias_para_vencer != null ? (c.dias_para_vencer | number) : '—' }}</td>
              <td><p-tag [value]="c.vigente ? 'Vigente' : 'Vencida'" [severity]="c.vigente ? 'success' : 'danger'" styleClass="cr-chip" /></td>
              <td>@if (canManage) { <button pButton type="button" icon="pi pi-trash" class="p-button-sm p-button-text p-button-danger" [attr.aria-label]="'Eliminar ' + c.rfc" (click)="confirmDelete(c)"></button> }</td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage"><tr><td colspan="6" class="cr-empty">
            @if (loading()) { Cargando… }
            @else if (errored()) { <i class="pi pi-exclamation-triangle"></i> No se pudo cargar el estado. <button pButton type="button" label="Reintentar" class="p-button-sm p-button-text" (click)="reload()"></button> }
            @else { <i class="pi pi-key"></i> Sin e.firma cargada. @if (canManage) { Carga una con "Cargar e.firma" para habilitar la descarga masiva. } @else { Requiere permiso de gestión. } }
          </td></tr></ng-template>
        </p-table>
      </div>

      <p-dialog [visible]="showNew" (visibleChange)="showNew=$event" [modal]="true" [style]="{ width: '30rem' }" header="Cargar e.firma" [draggable]="false" [closable]="false" [closeOnEscape]="false">
        <div class="cr-form">
          <label class="cr-f"><span>RFC *</span><input type="text" pInputText [(ngModel)]="form.rfc" maxlength="13" placeholder="XAXX010101000" style="text-transform:uppercase" /></label>
          <label class="cr-f"><span>Razón social</span><input type="text" pInputText [(ngModel)]="form.razon_social" /></label>
          <label class="cr-f"><span>Certificado (.cer) *</span><input type="file" accept=".cer" (change)="onFile($event, 'cer')" /></label>
          <label class="cr-f"><span>Llave privada (.key) *</span><input type="file" accept=".key" (change)="onFile($event, 'key')" /></label>
          <label class="cr-f"><span>Contraseña de la llave *</span><input type="password" pInputText [(ngModel)]="form.password" autocomplete="off" /></label>
          <label class="cr-f"><span>CIEC (opcional)</span><input type="password" pInputText [(ngModel)]="form.ciec" autocomplete="off" /></label>
          <p class="cr-note"><i class="pi pi-lock"></i> El .key y la contraseña se cifran en reposo y solo se descifran efímeramente al firmar ante el SAT.</p>
        </div>
        <ng-template pTemplate="footer">
          <button pButton type="button" label="Cancelar" class="p-button-text p-button-sm" (click)="tryCloseNew()"></button>
          <button pButton type="button" label="Guardar" icon="pi pi-check" class="p-button-sm" [loading]="saving()" [disabled]="!formValid()" (click)="save()"></button>
        </ng-template>
      </p-dialog>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cr-head { display: flex; align-items: flex-start; gap: 1rem; }
    .cr-h1 { display: inline-flex; align-items: center; gap: .3rem; }
    .cr-head-actions { margin-left: auto; display: flex; gap: .4rem; align-items: center; }
    .cr-warn { display: flex; gap: .5rem; align-items: center; font-size: .82rem; color: var(--warn-soft-fg); background: color-mix(in srgb, var(--warn-fg) 10%, transparent); border: 1px solid color-mix(in srgb, var(--warn-fg) 30%, var(--border-color)); border-radius: var(--r-md); padding: .6rem .9rem; margin-bottom: 1rem; }
    .cr-warn code { font-family: var(--font-mono, monospace); }
    .cr-table { font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; } .strong { font-weight: 700; } .bad { color: var(--bad-fg); }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .85em; }
    :host ::ng-deep .cr-chip .p-tag { font-size: .66rem; font-weight: 700; padding: .1rem .5rem; }
    .cr-empty { padding: 2.5rem 1rem; text-align: center; color: var(--text-muted); }
    .cr-empty .pi { display: block; font-size: 1.5rem; margin-bottom: .5rem; opacity: .6; }
    .cr-form { display: flex; flex-direction: column; gap: .7rem; padding-top: .5rem; }
    .cr-f { display: flex; flex-direction: column; gap: .25rem; font-size: .72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
    .cr-f input[type=text], .cr-f input[type=password] { border: 1px solid var(--border-color); border-radius: var(--r-sm); padding: .45rem .6rem; background: var(--card-bg); color: var(--text-main); }
    .cr-note { font-size: .75rem; color: var(--text-muted); background: var(--surface-hover-bg); border-radius: var(--r-sm); padding: .5rem .7rem; margin: 0; display: flex; gap: .4rem; }
  `],
})
export class ContabilidadCredencialesComponent implements OnInit {
  readonly tabs = CONTABILIDAD_TABS;
  private readonly svc = inject(CredencialesService);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  readonly canManage = this.auth.user()?.permissions?.[Permission.FISCAL_CREDENCIALES_GESTIONAR] === true;
  readonly rows = signal<CredStatus[]>([]);
  readonly loading = signal(false);
  readonly errored = signal(false);
  readonly saving = signal(false);
  readonly vaultOff = signal(false);
  readonly loadedAt = signal<number | null>(null);

  showNew = false;
  form: { rfc: string; razon_social: string; cer_b64: string; key_b64: string; password: string; ciec: string } =
    { rfc: '', razon_social: '', cer_b64: '', key_b64: '', password: '', ciec: '' };

  ngOnInit() { this.reload(); }

  reload() {
    this.loading.set(true); this.errored.set(false);
    this.svc.status().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.rows.set(r); this.vaultOff.set(r.length > 0 && r.every((x) => !x.vault_ok)); this.loading.set(false); this.loadedAt.set(Date.now()); },
      error: () => { this.loading.set(false); this.errored.set(true); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el estado de credenciales.' }); },
    });
  }

  onFile(ev: Event, which: 'cer' | 'key') {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || '');
      const b64 = res.includes(',') ? res.split(',')[1] : res; // strip data: prefix
      if (which === 'cer') this.form.cer_b64 = b64; else this.form.key_b64 = b64;
    };
    reader.readAsDataURL(file);
  }

  formValid(): boolean {
    return /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/.test((this.form.rfc || '').toUpperCase()) && !!this.form.cer_b64 && !!this.form.key_b64 && !!this.form.password;
  }

  // §8 — el diálogo carga material sensible (RFC, .cer/.key, contraseña): no descartar sin confirmar.
  private credDirty(): boolean {
    const f = this.form;
    return !!(f.rfc || f.razon_social || f.cer_b64 || f.key_b64 || f.password || f.ciec);
  }
  private resetForm() { this.form = { rfc: '', razon_social: '', cer_b64: '', key_b64: '', password: '', ciec: '' }; }
  tryCloseNew() {
    if (!this.credDirty()) { this.showNew = false; return; }
    this.confirm.confirm({
      header: 'Descartar carga', message: '¿Descartar los datos de la e.firma capturados?',
      icon: 'pi pi-exclamation-triangle', acceptLabel: 'Descartar', rejectLabel: 'Seguir editando',
      acceptButtonStyleClass: 'p-button-sm p-button-danger', rejectButtonStyleClass: 'p-button-text p-button-sm',
      accept: () => { this.resetForm(); this.showNew = false; },
    });
  }

  save() {
    if (!this.formValid()) return;
    this.saving.set(true);
    this.svc.upsert({
      rfc: this.form.rfc.toUpperCase(), razon_social: this.form.razon_social || undefined,
      cer_b64: this.form.cer_b64, key_b64: this.form.key_b64, password: this.form.password, ciec: this.form.ciec || undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.saving.set(false); this.showNew = false; this.form = { rfc: '', razon_social: '', cer_b64: '', key_b64: '', password: '', ciec: '' }; this.toast.add({ severity: 'success', summary: 'e.firma guardada', detail: `${r.rfc} — vence ${r.cer_valid_to ?? '?'}.` }); this.reload(); },
      error: (e) => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo guardar (revisa .cer/.key/contraseña).' }); },
    });
  }

  confirmDelete(c: CredStatus) {
    this.confirm.confirm({
      message: `¿Eliminar la e.firma de ${c.rfc}? La descarga masiva de ese RFC dejará de funcionar.`,
      header: 'Eliminar e.firma', icon: 'pi pi-exclamation-triangle', acceptLabel: 'Eliminar', rejectLabel: 'Cancelar', acceptButtonStyleClass: 'p-button-danger p-button-sm', rejectButtonStyleClass: 'p-button-text p-button-sm',
      accept: () => {
        this.svc.remove(c.rfc).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
          next: () => { this.toast.add({ severity: 'success', summary: 'Eliminada', detail: `e.firma de ${c.rfc} eliminada.` }); this.reload(); },
          error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo eliminar.' }),
        });
      },
    });
  }
}
