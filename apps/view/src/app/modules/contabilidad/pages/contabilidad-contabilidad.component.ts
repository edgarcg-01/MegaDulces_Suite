import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { InputTextModule } from 'primeng/inputtext';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { SelectButtonModule } from 'primeng/selectbutton';
import { DatePickerModule } from 'primeng/datepicker';
import { MessageService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { CONTABILIDAD_TABS } from '../contabilidad-tabs';
import { ContabilidadService, CodAgrupadorRow } from '../contabilidad.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { SAT_COD_AGRUPADOR } from '../../../shared/constants/sat-cod-agrupador';

/**
 * FISCAL.9 + FE.11 — Contabilidad electrónica (Operations). Genera y descarga los
 * XML que exige el SAT: catálogo de cuentas y balanza de comprobación, desde la
 * balanza (analytics.ledger_monthly). FE.11 agrega el mapeo cuenta mayor →
 * código agrupador SAT (editable), que hace el catálogo 100% válido.
 */
@Component({
  selector: 'app-contabilidad-contabilidad',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, ToastModule, InputTextModule, TableModule, TagModule, SelectModule, SelectButtonModule, DatePickerModule, PageTabsComponent, FreshnessPillComponent, ContextHelpComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="tabs" variant="liquid" />

      <header class="surf-page-head cb-head">
        <div class="surf-page-head-text">
          <h1 class="cb-h1">Contabilidad electrónica <app-context-help topic="contabilidad-e" /></h1>
          <p class="surf-page-sub">Genera los XML que exige el SAT desde la balanza contable: catálogo de cuentas y balanza de comprobación (1.3).</p>
        </div>
        @if (loadedAt()) { <span class="cb-head-fresh"><app-freshness-pill [since]="loadedAt()" /></span> }
      </header>

      <div class="card-premium card-flat cb-panel">
        <div class="cb-form">
          <label class="cb-f"><span>Periodo</span><p-datepicker [(ngModel)]="periodD" (onSelect)="syncPeriod()" view="month" dateFormat="mm/yy" [showIcon]="true" appendTo="body" ariaLabel="Periodo (mes)" styleClass="cb-dp" /></label>
          <label class="cb-f"><span>RFC (opcional)</span><input type="text" pInputText [(ngModel)]="rfc" placeholder="e.firma activa si vacío" maxlength="13" style="text-transform:uppercase" /></label>
          <label class="cb-f"><span>Tipo de envío (balanza)</span>
            <p-select [options]="tipoEnvioOpts" [(ngModel)]="tipoEnvio" optionLabel="label" optionValue="value" styleClass="cb-sel sel-liquid" ariaLabel="Tipo de envío de la balanza" />
          </label>
        </div>
        <div class="cb-cards">
          <div class="cb-card">
            <div class="cb-card-body">
              <i class="pi pi-book"></i>
              <div><div class="cb-card-title">Catálogo de cuentas</div><div class="cb-card-desc">Estructura de cuentas con nivel, naturaleza y código agrupador SAT (1.3).</div></div>
            </div>
            <button pButton type="button" label="Descargar XML" icon="pi pi-download" class="p-button-sm p-button-outlined" [loading]="dl()==='catalogo'" (click)="descargar('catalogo')"></button>
          </div>
          <div class="cb-card">
            <div class="cb-card-body">
              <i class="pi pi-list"></i>
              <div><div class="cb-card-title">Balanza de comprobación</div><div class="cb-card-desc">SaldoIni / Debe / Haber / SaldoFin por cuenta (BCE 1.3).</div></div>
            </div>
            <button pButton type="button" label="Descargar XML" icon="pi pi-download" class="p-button-sm p-button-outlined" [loading]="dl()==='balanza'" (click)="descargar('balanza')"></button>
          </div>
        </div>
      </div>

      <!-- FE.11 — Mapeo cuenta mayor → código agrupador SAT -->
      <div class="card-premium card-flat cb-panel">
        <div class="cb-map-head">
          <div>
            <div class="cb-card-title">Código agrupador SAT</div>
            <div class="cb-card-desc">Mapea cada cuenta mayor a la clave del catálogo del SAT. El catálogo de cuentas XML usa este mapeo; las cuentas sin mapear caen al placeholder (la propia cuenta mayor).</div>
          </div>
          <div class="cb-map-actions">
            <p-selectButton [options]="mapFilterOpts" [ngModel]="onlyUnmapped()" (ngModelChange)="onlyUnmapped.set($event)" optionLabel="label" optionValue="value" [allowEmpty]="false" styleClass="cb-sb sb-liquid" ariaLabel="Filtrar cuentas por mapeo" />
            <span class="cb-cover" [class.is-full]="coverage().unmapped === 0" [class.is-empty]="coverage().total === 0">
              <i class="pi" [ngClass]="coverage().unmapped === 0 && coverage().total > 0 ? 'pi-check-circle' : 'pi-exclamation-circle'"></i>
              {{ coverage().mapped }}/{{ coverage().total }} mapeadas
            </span>
            <button *ngIf="canManage()" pButton type="button" label="Auto-sugerir faltantes" icon="pi pi-bolt"
                    class="p-button-sm p-button-outlined" [loading]="suggesting()" [disabled]="coverage().unmapped === 0"
                    (click)="autoSuggest()"></button>
            <button pButton type="button" icon="pi pi-refresh" class="p-button-sm p-button-text" [loading]="loadingMap()" (click)="loadMap()" pTooltip="Refrescar"></button>
          </div>
        </div>

        <datalist id="sat-agrup">
          <option *ngFor="let c of satCodes" [value]="c.code">{{ c.label }}</option>
        </datalist>

        <p-table [value]="displayRows()" [loading]="loadingMap()" responsiveLayout="scroll"
                 styleClass="p-datatable-sm surf-table surf-table--sticky" [scrollable]="true" scrollHeight="440px">
          <ng-template pTemplate="header">
            <tr>
              <th scope="col">Cuenta mayor</th>
              <th scope="col">Nombre</th>
              <th scope="col" class="cb-c-fam">Fam.</th>
              <th scope="col">Código agrupador SAT</th>
              <th scope="col" class="cb-c-nat">Natur.</th>
              <th scope="col" class="cb-c-src">Origen</th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-r>
            <tr [class.cb-unmapped]="!r.cod_agrupador">
              <td><code class="comm-code">{{ r.cuenta_mayor }}</code></td>
              <td class="cb-name">{{ r.nombre || '—' }}</td>
              <td class="cb-c-fam">{{ r.familia }}</td>
              <td>
                <input *ngIf="canManage(); else roCode" type="text" pInputText list="sat-agrup"
                       class="cb-code-input" [(ngModel)]="r.cod_agrupador"
                       placeholder="ej. 105.01" inputmode="decimal"
                       (blur)="saveRow(r)"
                       (keydown.enter)="$any($event.target).blur()" />
                <ng-template #roCode><span [class.comm-muted]="!r.cod_agrupador">{{ r.cod_agrupador || '— sin mapear —' }}</span></ng-template>
              </td>
              <td class="cb-c-nat">{{ r.natur || r.natur_default }}</td>
              <td class="cb-c-src">
                <p-tag *ngIf="r.source === 'manual'" severity="success" value="manual"></p-tag>
                <p-tag *ngIf="r.source === 'auto'" severity="warn" value="auto"></p-tag>
                <span *ngIf="!r.source" class="comm-muted is-small">—</span>
              </td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage">
            <tr><td colspan="6" class="comm-muted" style="padding:1rem;text-align:center;">
              @if (onlyUnmapped() && mapRows().length) { <i class="pi pi-check-circle"></i> Todas las cuentas están mapeadas. <button pButton type="button" label="Ver todas" class="p-button-sm p-button-text" (click)="onlyUnmapped.set(false)"></button> }
              @else { Sin balanza cargada (analytics.ledger_monthly vacío para este tenant). }
            </td></tr>
          </ng-template>
        </p-table>
        <p class="cb-note"><i class="pi pi-info-circle"></i> El código agrupador debe ser una clave del catálogo del SAT (formato <code>NNN</code> o <code>NNN.NN</code>). El campo sugiere claves comunes; podés escribir cualquiera válida.</p>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cb-head { display: flex; align-items: flex-start; gap: 1rem; }
    .cb-h1 { display: inline-flex; align-items: center; gap: .3rem; }
    .cb-head-fresh { margin-left: auto; }
    .cb-panel { padding: 1.2rem; }
    .cb-form { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.2rem; }
    .cb-f { display: flex; flex-direction: column; gap: .25rem; font-size: .7rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
    .cb-f input { border: 1px solid var(--border-color); border-radius: var(--r-sm); padding: .45rem .6rem; background: var(--card-bg); color: var(--text-main); font-family: var(--font-mono, monospace); min-width: 12rem; }
    .cb-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem; }
    .cb-card { border: 1px solid var(--border-color); border-radius: var(--r-md); padding: 1rem; display: flex; flex-direction: column; gap: .8rem; justify-content: space-between; background: var(--card-bg); }
    .cb-card-body { display: flex; gap: .8rem; align-items: flex-start; }
    .cb-card-body .pi { font-size: 1.4rem; color: var(--action); margin-top: .1rem; }
    .cb-card-title { font-size: .9rem; font-weight: 700; color: var(--text-main); }
    .cb-card-desc { font-size: .78rem; color: var(--text-muted); margin-top: .15rem; max-width: 60ch; }
    .cb-card button { align-self: flex-start; }
    .cb-note { font-size: .75rem; color: var(--text-muted); background: var(--surface-hover-bg); border-radius: var(--r-sm); padding: .55rem .75rem; margin: 1rem 0 0; display: flex; gap: .4rem; align-items: baseline; }

    /* ── FE.11 mapeo ── */
    .cb-map-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; }
    .cb-map-actions { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
    .cb-cover { display: inline-flex; align-items: center; gap: .35rem; font-size: .78rem; font-weight: 600; color: var(--text-muted); padding: .25rem .6rem; border-radius: var(--r-pill); border: 1px solid var(--border-color); white-space: nowrap; }
    .cb-cover.is-full { color: var(--ok-fg); border-color: color-mix(in srgb, var(--ok-fg) 40%, transparent); }
    .cb-cover.is-full .pi { color: var(--ok-fg); }
    .cb-cover:not(.is-full):not(.is-empty) .pi { color: var(--warn-fg); }
    .cb-name { color: var(--text-muted); font-size: .82rem; max-width: 32ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cb-c-fam, .cb-c-nat { text-align: center; width: 4.5rem; font-family: var(--font-mono, monospace); }
    .cb-c-src { width: 6rem; }
    .cb-code-input { width: 100%; max-width: 12rem; font-family: var(--font-mono, monospace); }
    tr.cb-unmapped td:first-child { box-shadow: inset 3px 0 0 var(--warn-fg); }
  `],
})
export class ContabilidadContabilidadComponent {
  readonly tabs = CONTABILIDAD_TABS;
  readonly satCodes = SAT_COD_AGRUPADOR;
  private readonly svc = inject(ContabilidadService);
  private readonly toast = inject(MessageService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  period = this.currentMonth();
  periodD: Date = new Date();
  readonly loadedAt = signal<number | null>(null);
  rfc = '';
  tipoEnvio: 'N' | 'C' = 'N';

  /** p-datepicker (vista mes) → sincroniza period YYYY-MM (descarga es con botón). */
  syncPeriod() { if (this.periodD) this.period = `${this.periodD.getFullYear()}-${String(this.periodD.getMonth() + 1).padStart(2, '0')}`; }
  readonly tipoEnvioOpts = [{ label: 'Normal', value: 'N' }, { label: 'Complementaria', value: 'C' }];
  readonly dl = signal<'' | 'catalogo' | 'balanza'>('');

  readonly mapRows = signal<CodAgrupadorRow[]>([]);
  readonly loadingMap = signal(false);
  readonly suggesting = signal(false);
  readonly onlyUnmapped = signal(false);
  readonly mapFilterOpts = [{ label: 'Todas', value: false }, { label: 'Sin mapear', value: true }];

  readonly canManage = computed(() => (this.auth.user()?.permissions || {})[Permission.FISCAL_CONTAB_GESTIONAR] === true);

  readonly coverage = computed(() => {
    const rows = this.mapRows();
    const mapped = rows.filter((r) => !!r.cod_agrupador).length;
    return { total: rows.length, mapped, unmapped: rows.length - mapped };
  });

  /** "Sin mapear" filtra client-side sobre las cuentas ya cargadas (el trabajo real de cerrar el catálogo). */
  readonly displayRows = computed(() => this.onlyUnmapped() ? this.mapRows().filter((r) => !r.cod_agrupador) : this.mapRows());

  constructor() {
    this.loadMap();
  }

  loadMap(): void {
    this.loadingMap.set(true);
    this.svc.listCodAgrupador().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => { this.mapRows.set(rows || []); this.loadingMap.set(false); this.loadedAt.set(Date.now()); },
      error: () => { this.loadingMap.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el mapeo.' }); },
    });
  }

  autoSuggest(): void {
    this.suggesting.set(true);
    this.svc.suggestCodAgrupador().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => { this.suggesting.set(false); this.toast.add({ severity: 'success', summary: 'Sugerido', detail: `${res.inserted} cuenta(s) sembrada(s). Revisá y corregí las que no correspondan.` }); this.loadMap(); },
      error: () => { this.suggesting.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo auto-sugerir.' }); },
    });
  }

  saveRow(r: CodAgrupadorRow): void {
    const cod = (r.cod_agrupador || '').trim();
    // Vacío = eliminar mapeo (vuelve al placeholder).
    if (!cod) {
      if (!r.source) return; // no había nada que borrar
      this.svc.deleteCodAgrupador(r.cuenta_mayor).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => { r.cod_agrupador = null; r.source = null; this.mapRows.set([...this.mapRows()]); this.toast.add({ severity: 'info', summary: 'Mapeo eliminado', detail: r.cuenta_mayor, life: 2500 }); },
        error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo eliminar.' }),
      });
      return;
    }
    if (!/^\d{3}(\.\d{1,3})?$/.test(cod)) {
      this.toast.add({ severity: 'warn', summary: 'Formato inválido', detail: 'Usá NNN o NNN.NN (ej. 105.01).' });
      return;
    }
    this.svc.saveCodAgrupador({ cuenta_mayor: r.cuenta_mayor, cod_agrupador: cod }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (saved) => { r.cod_agrupador = saved.cod_agrupador; r.source = 'manual'; this.mapRows.set([...this.mapRows()]); this.toast.add({ severity: 'success', summary: 'Guardado', detail: `${r.cuenta_mayor} → ${saved.cod_agrupador}`, life: 2500 }); },
      error: (err) => this.toast.add({ severity: 'error', summary: 'Error', detail: err?.error?.message || 'No se pudo guardar.' }),
    });
  }

  descargar(tipo: 'catalogo' | 'balanza') {
    if (!/^\d{4}-\d{2}$/.test(this.period)) { this.toast.add({ severity: 'warn', summary: 'Periodo inválido', detail: 'Elige un mes válido.' }); return; }
    this.dl.set(tipo);
    const rfc = this.rfc ? this.rfc.toUpperCase() : undefined;
    const obs = tipo === 'catalogo' ? this.svc.catalogo(this.period, rfc) : this.svc.balanza(this.period, rfc, this.tipoEnvio);
    obs.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (xml) => { this.dl.set(''); this.saveXml(xml, `${tipo}_${this.period}.xml`); this.toast.add({ severity: 'success', summary: 'XML generado', detail: `${tipo === 'catalogo' ? 'Catálogo' : 'Balanza'} ${this.period} descargado.` }); },
      error: () => { this.dl.set(''); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo generar el XML (¿hay balanza en el periodo? ¿RFC/e.firma?).' }); },
    });
  }

  private saveXml(xml: string, filename: string) {
    const blob = new Blob([xml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  private currentMonth(): string { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
}
