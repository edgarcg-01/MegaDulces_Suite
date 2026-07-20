import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { SelectButtonModule } from 'primeng/selectbutton';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { DatePickerModule } from 'primeng/datepicker';
import { MessageService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { CONTABILIDAD_TABS } from '../contabilidad-tabs';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { DescargaService, DownloadRequest, DownloadPackage } from '../descarga.service';
import { CredencialesService } from '../credenciales.service';

/**
 * FISCAL.4 — Bandeja de descarga masiva de CFDI (Operations). Lista de solicitudes
 * con su estado (1-6 del SAT) + paquetes; alta de solicitud (dispara el pipeline
 * con la e.firma de la bóveda). Requiere e.firma cargada (Credenciales).
 */
@Component({
  selector: 'app-contabilidad-descarga',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule, DialogModule, InputTextModule, SelectButtonModule, SelectModule, TagModule, DatePickerModule, PageTabsComponent, FreshnessPillComponent, ContextHelpComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="tabs" variant="liquid" />

      <header class="surf-page-head dz-head">
        <div class="surf-page-head-text">
          <h1 class="dz-h1">Descarga masiva CFDI <app-context-help topic="descarga" /></h1>
          <p class="surf-page-sub">Solicitudes de descarga ante el SAT. El pipeline (solicitud → verificación → paquete) corre en segundo plano firmando con la e.firma.</p>
        </div>
        <div class="dz-head-actions">
          @if (loadedAt()) { <app-freshness-pill [since]="loadedAt()" [staleAfterSec]="120" /> }
          @if (polling()) { <span class="dz-poll" title="Actualizando automáticamente mientras hay descargas en proceso"><i class="pi pi-sync pi-spin"></i> auto</span> }
          <button pButton type="button" label="Refrescar" icon="pi pi-refresh" class="p-button-sm p-button-text" [loading]="loading()" (click)="reload()"></button>
          @if (canManage) {
            <button pButton type="button" label="Nueva descarga" icon="pi pi-plus" class="p-button-sm" (click)="openNew()"></button>
          }
        </div>
      </header>

      <div class="dz-filters">
        <label class="dz-fld"><span>Estado</span>
          <p-select [options]="estadoOpts" [ngModel]="estado()" (ngModelChange)="setEstado($event)" optionLabel="label" optionValue="value" styleClass="dz-sel sel-liquid" ariaLabel="Filtrar por estado" />
        </label>
        @if (estado() !== 'all') { <button pButton type="button" label="Limpiar" icon="pi pi-times" class="p-button-sm p-button-text dz-clear" (click)="setEstado('all')"></button> }
      </div>

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
              <td><p-tag [value]="estadoLabel(r.estado)" [severity]="estadoSev(r.estado)" styleClass="dz-chip" /></td>
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
                <p-table [value]="packages()[r.id] || []" styleClass="p-datatable-sm dz-pkgs-tbl" [rowHover]="true">
                  <ng-template pTemplate="header"><tr><th>Paquete</th><th style="width:8rem">Estado</th><th class="ta-r" style="width:6rem">CFDI</th><th>Detalle</th></tr></ng-template>
                  <ng-template pTemplate="body" let-p>
                    <tr><td class="mono">{{ p.id_paquete }}</td><td><p-tag [value]="p.estado" [severity]="estadoSev(p.estado)" styleClass="dz-chip" /></td><td class="ta-r mono">{{ p.num_cfdis != null ? (p.num_cfdis | number) : '—' }}</td><td class="dz-err">{{ p.last_error || '—' }}</td></tr>
                  </ng-template>
                </p-table>
              } @else {
                <div class="dz-ev-msg">Sin paquetes aún. @if (r.mensaje_sat) { <span class="mono">SAT: {{ r.mensaje_sat }}</span> }</div>
              }
            </td></tr>
          </ng-template>
          <ng-template pTemplate="emptymessage"><tr><td colspan="8" class="dz-empty">
            @if (loading()) { Cargando… }
            @else if (errored()) { <i class="pi pi-exclamation-triangle"></i> No se pudo cargar la bandeja. <button pButton type="button" label="Reintentar" class="p-button-sm p-button-text" (click)="reload()"></button> }
            @else if (estado() !== 'all') { <i class="pi pi-filter-slash"></i> Sin descargas en estado "{{ estadoLabel(estado()) }}". <button pButton type="button" label="Ver todas" class="p-button-sm p-button-text" (click)="setEstado('all')"></button> }
            @else { <i class="pi pi-cloud-download"></i> Sin solicitudes de descarga. @if (canManage) { Crea una con "Nueva descarga". } @else { Requiere permiso de gestión. } }
          </td></tr></ng-template>
        </p-table>
      </div>

      <p-dialog [(visible)]="showNew" [modal]="true" [style]="{ width: '30rem' }" header="Nueva descarga masiva" [draggable]="false">
        <div class="dz-form">
          <label class="dz-f"><span>RFC solicitante *</span><input type="text" pInputText [(ngModel)]="form.rfcSolicitante" placeholder="XAXX010101000" maxlength="13" style="text-transform:uppercase" /></label>
          <label class="dz-f"><span>Rol *</span>
            <p-selectButton [options]="rolOpts" [(ngModel)]="form.rol" optionLabel="label" optionValue="value" [allowEmpty]="false" styleClass="dz-sb sb-liquid" ariaLabel="Rol" />
          </label>
          <label class="dz-f"><span>Tipo</span>
            <p-selectButton [options]="tipoOpts" [(ngModel)]="form.tipo" optionLabel="label" optionValue="value" [allowEmpty]="false" styleClass="dz-sb sb-liquid" ariaLabel="Tipo de solicitud" />
          </label>
          <div class="dz-row">
            <label class="dz-f"><span>Desde *</span><p-datepicker [(ngModel)]="form.fechaIni" dateFormat="yy-mm-dd" [showIcon]="true" appendTo="body" placeholder="Desde" styleClass="dz-dp" /></label>
            <label class="dz-f"><span>Hasta *</span><p-datepicker [(ngModel)]="form.fechaFin" dateFormat="yy-mm-dd" [showIcon]="true" appendTo="body" placeholder="Hasta" styleClass="dz-dp" /></label>
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
    .dz-h1 { display: inline-flex; align-items: center; gap: .3rem; }
    .dz-head-actions { margin-left: auto; display: flex; gap: .5rem; align-items: center; }
    .dz-filters { display: flex; gap: .6rem; align-items: flex-end; margin-bottom: .8rem; }
    .dz-fld { display: flex; flex-direction: column; gap: .15rem; font-size: .68rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
    .dz-clear { align-self: flex-end; }
    .dz-poll { display: inline-flex; align-items: center; gap: .3rem; font-size: .68rem; color: var(--text-faint); }
    .dz-poll .pi { font-size: .72rem; }
    .dz-table { font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .85em; }
    :host ::ng-deep .dz-chip .p-tag { font-size: .66rem; font-weight: 700; padding: .1rem .5rem; text-transform: capitalize; }
    .dz-ev { background: var(--surface-hover-bg); padding: .8rem 1.2rem; }
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
    .dz-f input { border: 1px solid var(--border-color); border-radius: var(--r-sm); padding: .45rem .6rem; background: var(--card-bg); color: var(--text-main); }
    .dz-row { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
    .dz-note { font-size: .75rem; color: var(--text-muted); background: var(--surface-hover-bg); border-radius: var(--r-sm); padding: .5rem .7rem; margin: 0; display: flex; gap: .4rem; }
  `],
})
export class ContabilidadDescargaComponent implements OnInit {
  readonly tabs = CONTABILIDAD_TABS;
  private readonly svc = inject(DescargaService);
  private readonly creds = inject(CredencialesService);
  private readonly toast = inject(MessageService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  readonly canManage = this.auth.user()?.permissions?.[Permission.FISCAL_DESCARGA_GESTIONAR] === true;
  readonly rows = signal<DownloadRequest[]>([]);
  readonly loading = signal(false);
  readonly errored = signal(false);
  readonly creating = signal(false);
  readonly loadedAt = signal<number | null>(null);
  readonly polling = signal(false);
  /** §9 — estados que indican una descarga aún en vuelo (auto-poll mientras existan). */
  private static readonly IN_FLIGHT = ['nueva', 'solicitada', 'en_proceso'];
  private pollId: ReturnType<typeof setTimeout> | null = null;
  readonly expanded = signal<Record<string, boolean>>({});
  readonly packages = signal<Record<string, DownloadPackage[]>>({});
  readonly pkgLoading = signal<Record<string, boolean>>({});
  /** RFCs con e.firma cargada (para precargar el RFC solicitante). */
  readonly credRfcs = signal<string[]>([]);

  readonly rolOpts = [{ label: 'Recibidas', value: 'recibidas' }, { label: 'Emitidas', value: 'emitidas' }];
  readonly tipoOpts = [{ label: 'CFDI', value: 'CFDI' }, { label: 'Metadata', value: 'Metadata' }];
  readonly estadoOpts = [
    { label: 'Todos', value: 'all' }, { label: 'Nueva', value: 'nueva' }, { label: 'Solicitada', value: 'solicitada' },
    { label: 'En proceso', value: 'en_proceso' }, { label: 'Terminada', value: 'terminada' }, { label: 'Descargada', value: 'descargada' },
    { label: 'Error', value: 'error' }, { label: 'Rechazada', value: 'rechazada' }, { label: 'Vencida', value: 'vencida' },
  ];
  readonly estado = signal<string>('all');

  showNew = false;
  form: { rfcSolicitante: string; rol: 'recibidas' | 'emitidas'; tipo: 'CFDI' | 'Metadata'; fechaIni: Date | null; fechaFin: Date | null } =
    { rfcSolicitante: '', rol: 'recibidas', tipo: 'CFDI', fechaIni: null, fechaFin: null };

  constructor() { this.destroyRef.onDestroy(() => this.clearPoll()); }

  ngOnInit() {
    this.reload();
    // Precarga los RFC con e.firma cargada → el alta preselecciona el RFC solicitante.
    this.creds.status().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (cs) => this.credRfcs.set(cs.filter((c) => c.active).map((c) => c.rfc)),
      error: () => {},
    });
  }

  /**
   * §9 — recarga la bandeja. `silent` = poll de fondo: no toca el spinner grande ni
   * pinta error (conserva la última data buena; el pipeline SAT tarda minutos).
   */
  setEstado(e: string) { this.estado.set(e); this.reload(); }

  reload(silent = false) {
    this.clearPoll();
    if (!silent) { this.loading.set(true); this.errored.set(false); }
    this.svc.list(this.estado() === 'all' ? undefined : this.estado()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.rows.set(r); this.loading.set(false); this.loadedAt.set(Date.now()); this.schedulePoll(); },
      error: () => {
        this.loading.set(false);
        if (!silent) { this.errored.set(true); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar la bandeja de descargas.' }); }
        else { this.schedulePoll(); } // el poll falló: reintenta en el próximo ciclo sin molestar
      },
    });
  }

  /** Agenda un poll silencioso en 20s solo si hay una descarga en vuelo. */
  private schedulePoll() {
    this.clearPoll();
    const inFlight = this.rows().some((r) => ContabilidadDescargaComponent.IN_FLIGHT.includes(r.estado));
    this.polling.set(inFlight);
    if (inFlight) this.pollId = setTimeout(() => this.reload(true), 20000);
  }
  private clearPoll() { if (this.pollId) { clearTimeout(this.pollId); this.pollId = null; } }

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

  openNew() { this.form = { rfcSolicitante: this.credRfcs()[0] ?? '', rol: 'recibidas', tipo: 'CFDI', fechaIni: null, fechaFin: null }; this.showNew = true; }

  /** yyyy-mm-dd local (rango de fechas del SAT, no instante). */
  private fmt(d: Date | null): string { return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : ''; }

  formValid(): boolean {
    return /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/.test((this.form.rfcSolicitante || '').toUpperCase())
      && !!this.form.fechaIni && !!this.form.fechaFin && this.form.fechaIni.getTime() <= this.form.fechaFin.getTime();
  }
  crear() {
    if (!this.formValid()) return;
    this.creating.set(true);
    this.svc.crear({ rfcSolicitante: this.form.rfcSolicitante.toUpperCase(), rol: this.form.rol, tipo: this.form.tipo, fechaIni: this.fmt(this.form.fechaIni), fechaFin: this.fmt(this.form.fechaFin) }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
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
  /** #5 — severidad p-tag mapeada al estado (nunca hex inline). */
  estadoSev(e: string): 'success' | 'danger' | 'warn' | 'secondary' {
    const c = this.estadoClass(e);
    return c === 'ok' ? 'success' : c === 'bad' ? 'danger' : c === 'run' ? 'warn' : 'secondary';
  }
  estadoLabel(e: string): string {
    const m: Record<string, string> = { nueva: 'Nueva', solicitada: 'Solicitada', en_proceso: 'En proceso', terminada: 'Terminada', descargada: 'Descargada', error: 'Error', rechazada: 'Rechazada', vencida: 'Vencida' };
    return m[e] || e;
  }
}
