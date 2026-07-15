import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { MessageService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { CONTABILIDAD_TABS } from '../contabilidad-tabs';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { DescargaService, DownloadRequest, DownloadPackage } from '../descarga.service';

/**
 * FISCAL.4 — Bandeja de descarga masiva de CFDI (Operations). Lista de solicitudes
 * con su estado (1-6 del SAT) + paquetes; alta de solicitud (dispara el pipeline
 * con la e.firma de la bóveda). Requiere e.firma cargada (Credenciales).
 */
@Component({
  selector: 'app-contabilidad-descarga',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule, DialogModule, InputTextModule, PageTabsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="tabs" />

      <header class="surf-page-head dz-head">
        <div class="surf-page-head-text">
          <h1>Descarga masiva CFDI</h1>
          <p class="surf-page-sub">Solicitudes de descarga ante el SAT. El pipeline (solicitud → verificación → paquete) corre en segundo plano firmando con la e.firma.</p>
        </div>
        <div class="dz-head-actions">
          <button pButton type="button" label="Refrescar" icon="pi pi-refresh" class="p-button-sm p-button-text" [loading]="loading()" (click)="reload()"></button>
          @if (canManage) {
            <button pButton type="button" label="Nueva descarga" icon="pi pi-plus" class="p-button-sm" (click)="openNew()"></button>
          }
        </div>
      </header>

      <div class="card-premium card-flat">
        <p-table [value]="rows()" styleClass="p-datatable-sm dz-table" [rowHover]="true" [loading]="loading()"
                 dataKey="id" [expandedRowKeys]="expanded()" [scrollable]="true" scrollHeight="560px" [paginator]="rows().length > 50" [rows]="50">
          <ng-template pTemplate="header">
            <tr>
              <th style="width:2.5rem"></th>
              <th style="width:7rem">Estado</th>
              <th style="width:8rem">RFC</th>
              <th style="width:6rem">Rol</th>
              <th>Rango</th>
              <th class="ta-r" style="width:6rem">CFDI</th>
              <th class="ta-r" style="width:7rem">Paquetes</th>
              <th style="width:8rem">Creada</th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-r let-expanded="expanded">
            <tr>
              <td><button pButton type="button" [icon]="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" class="p-button-text p-button-sm" [attr.aria-label]="expanded ? 'Ocultar paquetes' : 'Ver paquetes'" (click)="toggle(r)"></button></td>
              <td><span class="dz-est" [ngClass]="'e-' + estadoClass(r.estado)">{{ estadoLabel(r.estado) }}</span></td>
              <td class="mono">{{ r.rfc_solicitante }}</td>
              <td>{{ r.rol }}</td>
              <td class="mono">{{ r.fecha_ini | date:'dd/MM/yy' }} → {{ r.fecha_fin | date:'dd/MM/yy' }} · {{ r.tipo_solicitud }}</td>
              <td class="ta-r mono">{{ r.numero_cfdis != null ? (r.numero_cfdis | number) : '—' }}</td>
              <td class="ta-r mono">{{ r.packages_done }}/{{ r.packages_total }}</td>
              <td class="mono">{{ r.created_at | date:'dd/MM HH:mm' }}</td>
            </tr>
          </ng-template>
          <ng-template pTemplate="rowexpansion" let-r>
            <tr><td colspan="8" class="dz-ev">
              @if (pkgLoading()[r.id]) { <div class="dz-ev-msg">Cargando paquetes…</div> }
              @else if (packages()[r.id]?.length) {
                <table class="dz-pkgs">
                  <thead><tr><th>Paquete</th><th style="width:8rem">Estado</th><th class="ta-r" style="width:6rem">CFDI</th><th>Detalle</th></tr></thead>
                  <tbody>
                    @for (p of packages()[r.id]; track p.id) {
                      <tr><td class="mono">{{ p.id_paquete }}</td><td><span class="dz-est" [ngClass]="'e-' + estadoClass(p.estado)">{{ p.estado }}</span></td><td class="ta-r mono">{{ p.num_cfdis != null ? (p.num_cfdis | number) : '—' }}</td><td class="dz-err">{{ p.last_error || '—' }}</td></tr>
                    }
                  </tbody>
                </table>
              } @else {
                <div class="dz-ev-msg">Sin paquetes aún. @if (r.mensaje_sat) { <span class="mono">SAT: {{ r.mensaje_sat }}</span> }</div>
              }
            </td></tr>
          </ng-template>
          <ng-template pTemplate="emptymessage"><tr><td colspan="8" class="dz-empty">
            @if (loading()) { Cargando… }
            @else if (errored()) { <i class="pi pi-exclamation-triangle"></i> No se pudo cargar la bandeja. <button pButton type="button" label="Reintentar" class="p-button-sm p-button-text" (click)="reload()"></button> }
            @else { <i class="pi pi-cloud-download"></i> Sin solicitudes de descarga. @if (canManage) { Crea una con "Nueva descarga". } @else { Requiere permiso de gestión. } }
          </td></tr></ng-template>
        </p-table>
      </div>

      <p-dialog [(visible)]="showNew" [modal]="true" [style]="{ width: '30rem' }" header="Nueva descarga masiva" [draggable]="false">
        <div class="dz-form">
          <label class="dz-f"><span>RFC solicitante *</span><input type="text" pInputText [(ngModel)]="form.rfcSolicitante" placeholder="XAXX010101000" maxlength="13" style="text-transform:uppercase" /></label>
          <label class="dz-f"><span>Rol *</span>
            <div class="dz-seg">
              <button type="button" [class.active]="form.rol==='recibidas'" (click)="form.rol='recibidas'">Recibidas</button>
              <button type="button" [class.active]="form.rol==='emitidas'" (click)="form.rol='emitidas'">Emitidas</button>
            </div>
          </label>
          <label class="dz-f"><span>Tipo</span>
            <div class="dz-seg">
              <button type="button" [class.active]="form.tipo==='CFDI'" (click)="form.tipo='CFDI'">CFDI</button>
              <button type="button" [class.active]="form.tipo==='Metadata'" (click)="form.tipo='Metadata'">Metadata</button>
            </div>
          </label>
          <div class="dz-row">
            <label class="dz-f"><span>Desde *</span><input type="date" [(ngModel)]="form.fechaIni" /></label>
            <label class="dz-f"><span>Hasta *</span><input type="date" [(ngModel)]="form.fechaFin" /></label>
          </div>
          <p class="dz-note"><i class="pi pi-info-circle"></i> Requiere la e.firma del RFC cargada en <strong>Credenciales</strong>. El SAT limita a 72h para descargar los paquetes generados.</p>
        </div>
        <ng-template pTemplate="footer">
          <button pButton type="button" label="Cancelar" class="p-button-text p-button-sm" (click)="showNew=false"></button>
          <button pButton type="button" label="Crear y solicitar" icon="pi pi-check" class="p-button-sm" [loading]="creating()" [disabled]="!formValid()" (click)="crear()"></button>
        </ng-template>
      </p-dialog>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .dz-head { display: flex; align-items: flex-start; gap: 1rem; }
    .dz-head-actions { margin-left: auto; display: flex; gap: .4rem; align-items: center; }
    .dz-table { font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .85em; }
    .dz-est { display: inline-block; padding: .1rem .5rem; border-radius: var(--r-pill, 999px); font-size: .66rem; font-weight: 700; text-transform: capitalize; }
    .e-ok { background: color-mix(in srgb, var(--ok-fg, #16a34a) 14%, transparent); color: var(--ok-fg, #16a34a); }
    .e-run { background: color-mix(in srgb, var(--warn-fg, #d97706) 16%, transparent); color: var(--warn-soft-fg, #b45309); }
    .e-bad { background: color-mix(in srgb, var(--bad-fg, #dc2626) 15%, transparent); color: var(--bad-fg, #dc2626); }
    .e-neutral { background: var(--surface-hover-bg, #f5f5f4); color: var(--text-muted); }
    .dz-ev { background: var(--surface-hover-bg, #fafaf9); padding: .8rem 1.2rem; }
    .dz-ev-msg { font-size: .82rem; color: var(--text-muted); }
    .dz-pkgs { width: 100%; border-collapse: collapse; font-size: .82rem; }
    .dz-pkgs th { text-align: left; font-size: .66rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted); padding: .2rem .5rem; border-bottom: 1px solid var(--border-color); }
    .dz-pkgs td { padding: .25rem .5rem; border-bottom: 1px solid var(--border-color); color: var(--text-main); }
    .dz-pkgs .ta-r { text-align: right; }
    .dz-err { color: var(--text-muted); max-width: 30ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dz-empty { padding: 2.5rem 1rem; text-align: center; color: var(--text-muted); }
    .dz-empty .pi { display: block; font-size: 1.5rem; margin-bottom: .5rem; opacity: .6; }
    .dz-form { display: flex; flex-direction: column; gap: .8rem; padding-top: .5rem; }
    .dz-f { display: flex; flex-direction: column; gap: .25rem; font-size: .72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
    .dz-f input { border: 1px solid var(--border-color); border-radius: var(--r-sm, 8px); padding: .45rem .6rem; background: var(--card-bg); color: var(--text-main); }
    .dz-row { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
    .dz-seg { display: inline-flex; border: 1px solid var(--border-color); border-radius: var(--r-pill, 999px); overflow: hidden; width: fit-content; }
    .dz-seg button { border: none; background: var(--card-bg); padding: .35rem .9rem; font-size: .8rem; cursor: pointer; color: var(--text-muted); }
    .dz-seg button.active { background: var(--action); color: var(--action-ink, #fff); font-weight: 600; }
    .dz-note { font-size: .75rem; color: var(--text-muted); background: var(--surface-hover-bg, #f7f7f6); border-radius: var(--r-sm, 8px); padding: .5rem .7rem; margin: 0; display: flex; gap: .4rem; }
  `],
})
export class ContabilidadDescargaComponent implements OnInit {
  readonly tabs = CONTABILIDAD_TABS;
  private readonly svc = inject(DescargaService);
  private readonly toast = inject(MessageService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  readonly canManage = this.auth.user()?.permissions?.[Permission.FISCAL_DESCARGA_GESTIONAR] === true;
  readonly rows = signal<DownloadRequest[]>([]);
  readonly loading = signal(false);
  readonly errored = signal(false);
  readonly creating = signal(false);
  readonly expanded = signal<Record<string, boolean>>({});
  readonly packages = signal<Record<string, DownloadPackage[]>>({});
  readonly pkgLoading = signal<Record<string, boolean>>({});

  showNew = false;
  form: { rfcSolicitante: string; rol: 'recibidas' | 'emitidas'; tipo: 'CFDI' | 'Metadata'; fechaIni: string; fechaFin: string } =
    { rfcSolicitante: '', rol: 'recibidas', tipo: 'CFDI', fechaIni: '', fechaFin: '' };

  ngOnInit() { this.reload(); }

  reload() {
    this.loading.set(true); this.errored.set(false);
    this.svc.list().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.rows.set(r); this.loading.set(false); },
      error: () => { this.loading.set(false); this.errored.set(true); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar la bandeja de descargas.' }); },
    });
  }

  toggle(r: DownloadRequest) {
    const open = !!this.expanded()[r.id];
    this.expanded.update((e) => { const c = { ...e }; if (open) delete c[r.id]; else c[r.id] = true; return c; });
    if (!open && !this.packages()[r.id]) {
      this.pkgLoading.update((d) => ({ ...d, [r.id]: true }));
      this.svc.get(r.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (d) => { this.packages.update((p) => ({ ...p, [r.id]: d.packages ?? [] })); this.pkgLoading.update((x) => ({ ...x, [r.id]: false })); },
        error: () => { this.packages.update((p) => ({ ...p, [r.id]: [] })); this.pkgLoading.update((x) => ({ ...x, [r.id]: false })); },
      });
    }
  }

  openNew() { this.form = { rfcSolicitante: '', rol: 'recibidas', tipo: 'CFDI', fechaIni: '', fechaFin: '' }; this.showNew = true; }
  formValid(): boolean {
    return /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/.test((this.form.rfcSolicitante || '').toUpperCase()) && !!this.form.fechaIni && !!this.form.fechaFin && this.form.fechaIni <= this.form.fechaFin;
  }
  crear() {
    if (!this.formValid()) return;
    this.creating.set(true);
    this.svc.crear({ ...this.form, rfcSolicitante: this.form.rfcSolicitante.toUpperCase() }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.creating.set(false); this.showNew = false; this.toast.add({ severity: 'success', summary: 'Solicitud creada', detail: 'El pipeline de descarga arrancó en segundo plano.' }); this.reload(); },
      error: () => { this.creating.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo crear (¿e.firma cargada? ¿permiso de gestión?).' }); },
    });
  }

  estadoClass(e: string): string {
    if (['descargada', 'terminada'].includes(e)) return 'ok';
    if (['error', 'rechazada', 'vencida'].includes(e)) return 'bad';
    if (['solicitada', 'en_proceso'].includes(e)) return 'run';
    return 'neutral';
  }
  estadoLabel(e: string): string {
    const m: Record<string, string> = { nueva: 'Nueva', solicitada: 'Solicitada', en_proceso: 'En proceso', terminada: 'Terminada', descargada: 'Descargada', error: 'Error', rechazada: 'Rechazada', vencida: 'Vencida' };
    return m[e] || e;
  }
}
