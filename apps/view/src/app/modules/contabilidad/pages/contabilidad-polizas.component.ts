import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { InputTextModule } from 'primeng/inputtext';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectButtonModule } from 'primeng/selectbutton';
import { MessageService } from 'primeng/api';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { PolizasService, PolizaRow, PolizaDetail, TiposSummary, DoctypeVerdict } from '../polizas.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';

/**
 * PV.3 (Fase PV, ADR-041) — Auditor de Pólizas. Responde "¿se subió mal esta póliza?":
 * bandeja de pólizas con semáforo de cuadre (cargos=abonos), drill a los asientos +
 * CFDI vinculado + hallazgos. Fuente ContPAQi (verdad fiscal) / Kepler (por sucursal).
 */
@Component({
  selector: 'app-contabilidad-polizas',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, ToastModule, InputTextModule, TableModule, TagModule, SelectButtonModule, ContextHelpComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>

      <header class="surf-page-head pz-head">
        <div class="surf-page-head-text">
          <h1 class="pz-h1">Auditor de pólizas <app-context-help topic="polizas-cuadre" /></h1>
          <p class="surf-page-sub">Verifica el cuadre de la partida doble por póliza y detecta las que se subieron mal (descuadre, cuenta no afectable, periodo, duplicado, importe ≠ CFDI).</p>
        </div>
        @if (canManage()) {
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="scanning()" (click)="scan()"><span class="p-button-icon p-button-icon-left pi pi-bolt" aria-hidden="true"></span><span class="p-button-label">Correr detectores</span></button>
        }
      </header>

      <!-- KPIs -->
      <div class="pz-kpis">
        <div class="pz-kpi"><span class="pz-kpi-n">{{ sum().total | number }}</span><span class="pz-kpi-l">Pólizas</span></div>
        <div class="pz-kpi" [class.is-bad]="sum().descuadradas > 0"><span class="pz-kpi-n">{{ sum().descuadradas | number }}</span><span class="pz-kpi-l">No cuadran</span></div>
        <div class="pz-kpi"><span class="pz-kpi-n">{{ money(sum().monto_descuadre) }}</span><span class="pz-kpi-l">Monto descuadre</span></div>
        <div class="pz-kpi"><span class="pz-kpi-n">{{ sum().contpaqi | number }}<span class="pz-kpi-sub"> / {{ sum().kepler | number }}</span></span><span class="pz-kpi-l">ContPAQi / Kepler</span></div>
      </div>

      <!-- PV.4 — Tipo de poliza. Va ARRIBA de los filtros a proposito: lo primero
           que tiene que verse es si el control pudo correr, no el resultado. -->
      <section class="card-premium card-flat pz-tipos">
        <header class="pz-t-head">
          <button type="button" class="pz-t-toggle" (click)="tiposOpen.set(!tiposOpen())" [attr.aria-expanded]="tiposOpen()">
            <i class="pi" [class.pi-chevron-down]="tiposOpen()" [class.pi-chevron-right]="!tiposOpen()" aria-hidden="true"></i>
            <span>Tipo de póliza</span>
            <small>D&nbsp;Diario · E&nbsp;Egresos · I&nbsp;Ingresos</small>
          </button>
          @if (tiposCiego()) {
            <p-tag severity="warn" value="Control a ciegas"></p-tag>
          } @else if (tiposVivos() > 0) {
            <p-tag severity="danger" [value]="tiposVivos() + ' por corregir'"></p-tag>
          } @else {
            <p-tag severity="success" value="Sin incongruencias vivas"></p-tag>
          }
          @if (canManage()) {
            <button pButton type="button" class="p-button-sm p-button-text pz-t-sync" [loading]="syncing()" (click)="syncTipos()"><span class="p-button-icon p-button-icon-left pi pi-send" aria-hidden="true"></span><span class="p-button-label">Mandar a hallazgos y avisar</span></button>
          }
        </header>

        @if (tiposOpen()) {
          <!-- Lo que NO se pudo medir, primero y con motivo. Una lista vacía y una
               pantalla ciega se leen igual, y significan lo contrario. -->
          @if (tipos()?.catalogo?.state === 'not_measured') {
            <div class="pz-t-nm"><i class="pi pi-eye-slash" aria-hidden="true"></i><span><strong>Catálogo de Kepler: NO MEDIDO.</strong> {{ tipos()?.catalogo?.reason }}</span></div>
          }
          @if (tipos()?.cruce?.state === 'not_measured') {
            <div class="pz-t-nm"><i class="pi pi-eye-slash" aria-hidden="true"></i><span><strong>Cruce con ContPAQi: NO MEDIDO.</strong> {{ tipos()?.cruce?.reason }}</span></div>
          }

          @if (tipos()?.catalogo?.state === 'measured') {
            <div class="pz-t-kpis">
              <div class="pz-t-kpi" [class.is-bad]="tiposVivos() > 0"><span class="pz-kpi-n">{{ tiposVivos() }}</span><span class="pz-kpi-l">Incongruentes en uso</span></div>
              <div class="pz-t-kpi"><span class="pz-kpi-n">{{ money(tipos()!.catalogo.importe_en_riesgo) }}</span><span class="pz-kpi-l">Capturado este año</span></div>
              <div class="pz-t-kpi"><span class="pz-kpi-n">{{ tipos()!.catalogo.incongruentes - tiposVivos() }}</span><span class="pz-kpi-l">Dormidas (sin uso)</span></div>
              <div class="pz-t-kpi"><span class="pz-kpi-n">{{ tipos()!.catalogo.no_juzgables.doctypes }}</span><span class="pz-kpi-l">Sin cuentas: no juzgables</span></div>
            </div>
          }

          @if (incong().length) {
            <table class="pz-t-tabla">
              <thead>
                <tr>
                  <th scope="col">Documento</th>
                  <th scope="col">Declarado</th>
                  <th scope="col">Debería ser</th>
                  <th scope="col">Cuentas</th>
                  <th scope="col" class="pz-num">Docs</th>
                  <th scope="col" class="pz-num">Importe</th>
                </tr>
              </thead>
              <tbody>
                @for (t of incong(); track t.doc) {
                  <tr [class.pz-t-dormido]="t.docs === 0">
                    <td><code class="comm-code">{{ t.doc }}</code> <span class="pz-l-name">{{ t.descripcion }}</span></td>
                    <td><p-tag [severity]="t.docs > 0 ? 'danger' : 'secondary'" [value]="t.tipo_declarado"></p-tag></td>
                    <td><strong>{{ t.tipo_esperado }}</strong></td>
                    <td class="pz-t-ctas">{{ t.cargo || '—' }} <i class="pi pi-arrow-right" aria-hidden="true"></i> {{ t.abono || '—' }}</td>
                    <td class="pz-num">{{ t.docs ? (t.docs | number) : '—' }}</td>
                    <td class="pz-num">{{ t.docs ? money(t.importe) : '—' }}</td>
                  </tr>
                }
              </tbody>
            </table>
            <p class="pz-t-nota">Criterio: si el documento mueve efectivo o equivalentes (102 y 111 bancos, 110 caja) el tipo debe ser E o I; si no los toca, D. Las filas grises son doctypes sin uso este año: catálogo dormido, no trabajo pendiente.</p>
          } @else if (tipos()?.catalogo?.state === 'measured') {
            <p class="pz-t-nota">Ningún doctype contradice sus cuentas. Se revisaron {{ tipos()!.catalogo.total }} y {{ tipos()!.catalogo.no_juzgables.doctypes }} no declaran cuentas, así que sobre ésos no se opina.</p>
          }
        }
      </section>

      <!-- Filtros -->
      <div class="pz-filters">
        <p-selectbutton [options]="sourceOpts" [ngModel]="source()" (ngModelChange)="setSource($event)" optionLabel="label" optionValue="value" [allowEmpty]="false" styleClass="sb-liquid" ariaLabel="Fuente" />
        <input type="text" pInputText [ngModel]="mesInput()" (ngModelChange)="mesInput.set($event)" (keydown.enter)="reload()" placeholder="Mes YYYY-MM" class="pz-mes" maxlength="7" />
        <input type="text" pInputText [ngModel]="qInput()" (ngModelChange)="qInput.set($event)" (keydown.enter)="reload()" placeholder="Buscar folio / concepto" class="pz-q" />
        <label class="pz-check"><input type="checkbox" [ngModel]="onlyDescuadre()" (ngModelChange)="onlyDescuadre.set($event); reload()" /> Solo las que no cuadran</label>
        <button pButton type="button" class="p-button-sm p-button-text" [loading]="loading()" (click)="reload()"><span class="p-button-icon p-button-icon-left pi pi-search" aria-hidden="true"></span><span class="p-button-label">Buscar</span></button>
      </div>

      <div class="pz-split">
        <!-- Tabla -->
        <div class="card-premium card-flat pz-list">
          <p-table [value]="rows()" [loading]="loading()" styleClass="p-datatable-sm surf-table surf-table--sticky" [scrollable]="true" scrollHeight="560px"
            [(selection)]="selected" selectionMode="single" dataKey="folio" (onRowSelect)="openDetail($event.data)">
            <ng-template #header>
              <tr>
                <th scope="col" class="pz-c-ok"><span class="sr-only">Estado</span></th>
                <th scope="col">Póliza</th>
                <th scope="col">Mes</th>
                <th scope="col" class="pz-num">Cargos</th>
                <th scope="col" class="pz-num">Abonos</th>
                <th scope="col" class="pz-num">Descuadre</th>
              </tr>
            </ng-template>
            <ng-template #body let-r>
              <tr [pSelectableRow]="r" [class.pz-sel]="selected?.folio === r.folio && selected?.tipo_pol === r.tipo_pol" [class.pz-bad]="!r.cuadra">
                <td class="pz-c-ok">
                  @if (r.cuadra) { <i class="pi pi-check-circle" style="color:var(--ok-fg)" pTooltip="Cuadra"></i> }
                  @else { <i class="pi pi-times-circle" style="color:var(--danger-fg,#dc2626)" pTooltip="No cuadra"></i> }
                </td>
                <td><code class="comm-code">{{ r.tipo_pol }}/{{ r.folio }}</code> <span class="pz-src">{{ r.source }}</span></td>
                <td>{{ r.anio_mes }}</td>
                <td class="pz-num">{{ money(r.cargos) }}</td>
                <td class="pz-num">{{ money(r.abonos) }}</td>
                <td class="pz-num" [class.pz-bad-n]="!r.cuadra">{{ money(r.neto) }}</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="6" class="comm-muted" style="padding:1rem;text-align:center;">
                Sin pólizas (analytics.gl_polizas vacío para este filtro). Corre los importers PV.1.
              </td></tr>
            </ng-template>
          </p-table>
          @if (total() > rows().length) { <p class="pz-more">Mostrando {{ rows().length }} de {{ total() | number }}. Refiná con filtros.</p> }
        </div>

        <!-- Detalle -->
        <div class="card-premium card-flat pz-detail">
          @if (!detail()) {
            <div class="pz-empty"><i class="pi pi-arrow-left"></i> Elegí una póliza para ver sus asientos, su CFDI y los hallazgos.</div>
          } @else {
            <div class="pz-d-head">
              <h3><code>{{ detail()!.header?.tipo_pol }}/{{ detail()!.header?.folio }}</code></h3>
              @if (detail()!.header?.cuadra) { <p-tag severity="success" value="Cuadra"></p-tag> } @else { <p-tag severity="danger" [value]="'Descuadre ' + money(detail()!.header!.neto)"></p-tag> }
            </div>
            <p class="pz-d-concepto">{{ detail()!.header?.concepto || '—' }} · {{ detail()!.header?.anio_mes }} @if (detail()!.header?.fecha) { · {{ detail()!.header?.fecha }} }</p>

            @if (detail()!.findings.length) {
              <div class="pz-findings">
                @for (f of detail()!.findings; track f.rule_key + f.titulo) {
                  <div class="pz-finding" [class.crit]="f.severity === 'critical'"><i class="pi pi-exclamation-triangle"></i> <span><strong>{{ f.titulo }}</strong> — {{ f.resumen }}</span></div>
                }
              </div>
            }

            <table class="pz-lines">
              <thead><tr><th>Cuenta</th><th class="pz-num">Cargo</th><th class="pz-num">Abono</th><th>CFDI</th></tr></thead>
              <tbody>
                @for (l of detail()!.lines; track l.num_movto) {
                  <tr [class.pz-line-bad]="l.cuenta_afectable === false">
                    <td><code class="comm-code">{{ l.cuenta }}</code> <span class="pz-l-name">{{ l.cuenta_nombre || '' }}</span>@if (l.cuenta_afectable === false) { <span class="pz-noaf" pTooltip="Cuenta no afectable (de agrupación)">⚠</span> }</td>
                    <td class="pz-num">{{ l.cargo_abono === 'C' ? money(l.importe) : '' }}</td>
                    <td class="pz-num">{{ l.cargo_abono === 'A' ? money(l.importe) : '' }}</td>
                    <td class="pz-l-cfdi">{{ l.cfdi_uuid ? (l.cfdi_uuid | slice:0:8) + '…' : '—' }}</td>
                  </tr>
                }
              </tbody>
              <tfoot>
                <tr><td>Total</td><td class="pz-num">{{ money(detail()!.header!.cargos) }}</td><td class="pz-num">{{ money(detail()!.header!.abonos) }}</td><td></td></tr>
              </tfoot>
            </table>
          }
        </div>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .pz-head { display: flex; align-items: flex-start; gap: 1rem; }
    .pz-h1 { display: inline-flex; align-items: center; gap: .3rem; }
    .pz-head > button { margin-left: auto; }
    .pz-kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: .75rem; margin: 1rem 0; }
    .pz-kpi { border: 1px solid var(--border-color); border-radius: var(--r-md); padding: .8rem 1rem; background: var(--card-bg); display: flex; flex-direction: column; gap: .2rem; }
    .pz-kpi.is-bad { border-color: color-mix(in srgb, var(--danger-fg, #dc2626) 45%, transparent); }
    .pz-kpi-n { font-size: 1.4rem; font-weight: 700; color: var(--text-main); font-variant-numeric: tabular-nums; }
    .pz-kpi.is-bad .pz-kpi-n { color: var(--danger-fg, #dc2626); }
    .pz-kpi-sub { font-size: .9rem; color: var(--text-muted); font-weight: 500; }
    .pz-kpi-l { font-size: .7rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted); }
    .pz-tipos { padding: .6rem .85rem .85rem; margin-bottom: 1rem; }
    .pz-t-head { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
    .pz-t-toggle { background: none; border: 0; padding: .15rem 0; cursor: pointer; display: inline-flex; align-items: baseline; gap: .45rem; color: var(--text-main); font: inherit; font-weight: 700; }
    .pz-t-toggle small { font-weight: 500; font-size: .7rem; color: var(--text-muted); letter-spacing: .02em; }
    .pz-t-sync { margin-left: auto; }
    .pz-t-nm { display: flex; gap: .5rem; align-items: baseline; font-size: .78rem; margin-top: .7rem; padding: .5rem .7rem; border-radius: var(--r-sm); background: color-mix(in srgb, var(--warn-fg) 12%, transparent); border: 1px solid color-mix(in srgb, var(--warn-fg) 38%, transparent); }
    .pz-t-nm .pi { color: var(--warn-fg); }
    .pz-t-kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: .6rem; margin: .8rem 0 .2rem; }
    .pz-t-kpi { display: flex; flex-direction: column; gap: .15rem; padding: .5rem .7rem; border: 1px solid var(--border-color); border-radius: var(--r-sm); }
    .pz-t-kpi.is-bad { border-color: color-mix(in srgb, var(--danger-fg, #dc2626) 45%, transparent); }
    .pz-t-kpi.is-bad .pz-kpi-n { color: var(--danger-fg, #dc2626); }
    table.pz-t-tabla { width: 100%; border-collapse: collapse; font-size: .78rem; margin-top: .8rem; }
    table.pz-t-tabla th, table.pz-t-tabla td { padding: .35rem .5rem; border-bottom: 1px solid var(--border-color); text-align: left; vertical-align: baseline; }
    table.pz-t-tabla th { font-size: .68rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted); font-weight: 600; }
    tr.pz-t-dormido { opacity: .55; }
    .pz-t-ctas { font-family: var(--font-mono, monospace); font-size: .74rem; white-space: nowrap; }
    .pz-t-ctas .pi { font-size: .6rem; color: var(--text-muted); margin: 0 .2rem; }
    .pz-t-nota { font-size: .72rem; color: var(--text-muted); margin: .6rem 0 0; line-height: 1.45; }
    .pz-filters { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; margin-bottom: 1rem; }
    .pz-mes { width: 8rem; font-family: var(--font-mono, monospace); }
    .pz-q { width: 16rem; }
    .pz-check { font-size: .78rem; color: var(--text-muted); display: inline-flex; gap: .35rem; align-items: center; cursor: pointer; }
    .pz-split { display: grid; grid-template-columns: 1.35fr 1fr; gap: 1rem; align-items: start; }
    .pz-list, .pz-detail { padding: .5rem; }
    .pz-num { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--font-mono, monospace); white-space: nowrap; }
    .pz-c-ok { width: 2.2rem; text-align: center; }
    .pz-src { font-size: .65rem; text-transform: uppercase; color: var(--text-muted); margin-left: .3rem; }
    tr.pz-bad td.pz-c-ok, tr.pz-bad td:nth-child(2) { box-shadow: inset 3px 0 0 var(--danger-fg, #dc2626); }
    .pz-bad-n { color: var(--danger-fg, #dc2626); font-weight: 700; }
    .pz-more { font-size: .72rem; color: var(--text-muted); padding: .4rem .6rem 0; }
    .pz-detail { min-height: 300px; }
    .pz-empty { color: var(--text-muted); font-size: .85rem; display: flex; gap: .5rem; align-items: center; justify-content: center; height: 260px; }
    .pz-d-head { display: flex; align-items: center; gap: .6rem; padding: .3rem .3rem 0; }
    .pz-d-head h3 { margin: 0; }
    .pz-d-concepto { font-size: .78rem; color: var(--text-muted); padding: 0 .3rem .6rem; }
    .pz-findings { display: flex; flex-direction: column; gap: .4rem; margin: 0 .3rem .8rem; }
    .pz-finding { font-size: .76rem; background: color-mix(in srgb, var(--warn-fg) 12%, transparent); border: 1px solid color-mix(in srgb, var(--warn-fg) 35%, transparent); border-radius: var(--r-sm); padding: .45rem .6rem; display: flex; gap: .4rem; align-items: baseline; }
    .pz-finding.crit { background: color-mix(in srgb, var(--danger-fg, #dc2626) 12%, transparent); border-color: color-mix(in srgb, var(--danger-fg, #dc2626) 40%, transparent); }
    .pz-finding .pi { color: var(--warn-fg); }
    .pz-finding.crit .pi { color: var(--danger-fg, #dc2626); }
    table.pz-lines { width: 100%; border-collapse: collapse; font-size: .8rem; }
    table.pz-lines th, table.pz-lines td { padding: .35rem .5rem; border-bottom: 1px solid var(--border-color); text-align: left; }
    table.pz-lines tfoot td { font-weight: 700; border-top: 2px solid var(--border-color); border-bottom: none; }
    .pz-l-name { color: var(--text-muted); font-size: .72rem; }
    .pz-l-cfdi { font-family: var(--font-mono, monospace); font-size: .72rem; color: var(--text-muted); }
    tr.pz-line-bad { background: color-mix(in srgb, var(--warn-fg) 8%, transparent); }
    .pz-noaf { color: var(--warn-fg); cursor: help; }
    @media (max-width: 1100px) { .pz-split { grid-template-columns: 1fr; } .pz-kpis { grid-template-columns: repeat(2, 1fr); } }
  `],
})
export class ContabilidadPolizasComponent {
  private readonly svc = inject(PolizasService);
  private readonly toast = inject(MessageService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  readonly sourceOpts = [{ label: 'ContPAQi', value: 'contpaqi' }, { label: 'Kepler', value: 'kepler' }];
  readonly source = signal<'contpaqi' | 'kepler'>('contpaqi');
  readonly mesInput = signal('');
  readonly qInput = signal('');
  readonly onlyDescuadre = signal(false);

  readonly sum = signal({ total: 0, descuadradas: 0, monto_descuadre: 0, contpaqi: 0, kepler: 0, ultimo_mes: null as string | null });
  readonly rows = signal<PolizaRow[]>([]);
  readonly total = signal(0);
  readonly loading = signal(false);
  readonly scanning = signal(false);
  readonly detail = signal<PolizaDetail | null>(null);
  selected: PolizaRow | null = null;

  /* ---- PV.4: tipo de poliza ---- */
  readonly tipos = signal<TiposSummary | null>(null);
  readonly incong = signal<DoctypeVerdict[]>([]);
  readonly tiposOpen = signal(true);
  readonly syncing = signal(false);
  /** Vivos = con uso este ano. Un doctype dormido no es trabajo pendiente. */
  readonly tiposVivos = computed(() => this.tipos()?.catalogo?.incongruentes_vivos ?? 0);
  /**
   * Alguno de los dos bloques no pudo medirse. Se muestra ANTES que el resultado
   * porque "no encontre nada" y "no busque" se leen igual en una pantalla.
   */
  readonly tiposCiego = computed(() => {
    const t = this.tipos();
    return !!t && (t.catalogo.state === 'not_measured' || t.cruce.state === 'not_measured');
  });

  readonly canManage = computed(() => (this.auth.user()?.permissions || {})[Permission.FISCAL_CONTAB_GESTIONAR] === true);

  constructor() { this.reloadSummary(); this.reload(); this.reloadTipos(); }

  setSource(s: 'contpaqi' | 'kepler') { this.source.set(s); this.reloadSummary(); this.reload(); }

  money(n: number): string {
    return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 });
  }

  reloadSummary() {
    this.svc.summary(this.source()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => this.sum.set(s), error: () => {},
    });
  }

  reload() {
    this.loading.set(true);
    this.svc.list({
      source: this.source(), anio_mes: this.mesInput().trim() || undefined,
      q: this.qInput().trim() || undefined, only_descuadre: this.onlyDescuadre(), page: 1, page_size: 100,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.rows.set(r.rows); this.total.set(r.total); this.loading.set(false); },
      error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar la lista.' }); },
    });
  }

  openDetail(r: PolizaRow | PolizaRow[] | undefined) {
    if (!r || Array.isArray(r)) return;
    this.detail.set(null);
    this.svc.detail(r).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => this.detail.set(d),
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el detalle.' }),
    });
  }

  /* ---- PV.4 ---- */

  reloadTipos() {
    this.svc.tiposSummary().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (t) => {
        this.tipos.set(t);
        // Abierto solo cuando hay algo que hacer o algo que no se pudo medir: si
        // todo esta bien, el bloque no se queda ocupando la primera pantalla.
        this.tiposOpen.set(t.catalogo.incongruentes_vivos > 0 || this.tiposCiego());
      },
      error: () => {},
    });
    this.svc.tiposCatalogo().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (b) => this.incong.set(b.data?.incongruentes || []),
      error: () => {},
    });
  }

  syncTipos() {
    this.syncing.set(true);
    this.svc.tiposSync().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.syncing.set(false);
        this.toast.add({
          severity: r.inserted > 0 ? 'success' : 'info',
          summary: 'Hallazgos de tipo de póliza',
          detail: r.inserted > 0
            ? `${r.inserted} hallazgo(s) nuevo(s) en la bandeja. Se avisó por la campana.`
            : `Sin novedades: ${r.pushed} evaluado(s), ${r.skipped} ya estaban.`,
        });
      },
      error: () => { this.syncing.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo mandar a la bandeja.' }); },
    });
  }

  scan() {
    this.scanning.set(true);
    this.svc.scan().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.scanning.set(false); this.toast.add({ severity: 'success', summary: 'Detectores', detail: `${r.nuevos} hallazgo(s) nuevo(s) en ${r.reglas} reglas.` }); this.reloadSummary(); this.reload(); },
      error: () => { this.scanning.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo correr el scan.' }); },
    });
  }
}
