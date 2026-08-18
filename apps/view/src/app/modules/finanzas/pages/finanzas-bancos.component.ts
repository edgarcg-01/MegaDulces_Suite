import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { CheckboxModule } from 'primeng/checkbox';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { MessageService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { FINANZAS_TABS } from '../finanzas-tabs';
import { BankService, BankAccount, MovementCategory, BankStatement, BankMovement, Concentrado, Reconciliation, MatchResult, Differences, Balances, Diagnostico, KeplerAccount, ContpaqiCompare, ContpaqiBankAccount, FactorajeCompare, ThreeWay, SheetSyncConfig, ImportResult, SyncFindingsResult, SheetSyncRunResult } from '../bank.service';
import { BancosSocketService, BancosEvent, FinanceJobEvent, JobAccepted } from '../bancos-socket.service';
import { FinanceJobsClient } from '../finance-jobs.client';
import { AuthService } from '../../../core/services/auth.service';
import {
  BankView as View, MONTHS_ES, WORK_VIEWS,
  GROUP_LABELS, GROUP_ORDER,
} from './bancos/bancos-shared';
import { BancosConcentradoComponent } from './bancos/bancos-concentrado.component';
import { BancosConciliacionComponent } from './bancos/bancos-conciliacion.component';
import { BancosCuentasComponent } from './bancos/bancos-cuentas.component';
import { BancosCierreComponent } from './bancos/bancos-cierre.component';
import { BancosMovimientosComponent } from './bancos/bancos-movimientos.component';
import { BancosAdminComponent } from './bancos/bancos-admin.component';
import { BancosContpaqiComponent } from './bancos/bancos-contpaqi.component';
import { BancosThreeWayComponent } from './bancos/bancos-three-way.component';
import { BancosCapturasComponent } from './bancos/bancos-capturas.component';
import { BANCOS_STYLES } from './bancos/bancos.styles';

/**
 * CB.3 — Conciliación bancaria (ADR-033). Reemplaza el workbook Excel: tablero
 * CONCENTRADO (pivote cuenta × grupo), grid de movimientos con reclasificación
 * inline, y lista de cuentas. Surface Operations (denso, quiet-luxury, dark-first).
 */
@Component({
  selector: 'app-finanzas-bancos',
  standalone: true,
  imports: [DatePipe, FormsModule, ButtonModule, TableModule, ToastModule, SelectModule, CheckboxModule, InputNumberModule, InputTextModule, IconFieldModule, InputIconModule, PageTabsComponent, MetricStripComponent, LoadStateComponent, FreshnessPillComponent, ContextHelpComponent, BancosConcentradoComponent, BancosConciliacionComponent, BancosCuentasComponent, BancosCierreComponent, BancosMovimientosComponent, BancosAdminComponent, BancosContpaqiComponent, BancosThreeWayComponent, BancosCapturasComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in fb-page">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="tabs" />

      <header class="surf-page-head fb-head">
        <div class="surf-page-head-text">
          <div class="fb-title-row"><h1>Bancos</h1><app-context-help topic="bancos" /></div>
          <p class="surf-page-sub">Conciliación bancaria: estados de cuenta clasificados contra el catálogo alineado a Kepler. Reemplaza el Excel manual.</p>
        </div>
        <div class="fb-head-actions">
          <label class="fb-period">
            <span>Periodo</span>
            <p-select [options]="periods()" [ngModel]="period()" (ngModelChange)="setPeriod($event)"
                      appendTo="body" styleClass="fb-sel sel-liquid" [style]="{ minWidth: '8rem' }" ariaLabel="Periodo"></p-select>
          </label>
          <input #fileInput type="file" accept=".xlsx" hidden (change)="onFile($event)">
          <button pButton type="button" class="p-button-sm p-button-text" [loading]="syncingSheet()" (click)="runSheetSync()" title="Baja el workbook maestro del Google Sheet (export público) y lo procesa"><span class="p-button-icon p-button-icon-left pi pi-cloud-download" aria-hidden="true"></span><span class="p-button-label">Sincronizar del Sheet</span></button>
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="uploading()" (click)="fileInput.click()"><span class="p-button-icon p-button-icon-left pi pi-upload" aria-hidden="true"></span><span class="p-button-label">Subir estado de cuenta</span></button>
        </div>
      </header>

      <!-- Barra de estado del cierre (answer-first: dónde va el periodo de un vistazo) -->
      <div class="fb-status" aria-label="Estado del cierre">
        <button type="button" class="fb-status-chip" (click)="view.set('cuentas')"
                aria-label="Ir a Cuentas: ver el cuadre de saldos de cada cuenta" title="Ir a Cuentas — cuadre de saldos">
          <i class="pi pi-inbox"></i> Importado <b class="mono">{{ importStatus().loaded }}/{{ importStatus().total }}</b> cuentas</button>
        <button type="button" class="fb-status-chip" [class.warn]="(classifiedPct() ?? 100) < 100"
                (click)="fGroup.set(''); fUncat.set(true); view.set('movimientos'); reloadMovements()"
                aria-label="Ir a Movimientos filtrado a los que faltan clasificar" title="Ir a Movimientos — sólo los que faltan clasificar">
          <i class="pi pi-tags"></i> Clasificado <b class="mono">{{ classifiedPct() == null ? '—' : classifiedPct() + '%' }}</b></button>
        <button type="button" class="fb-status-chip" [class.warn]="reconciledPct() != null && reconciledPct()! < 80"
                (click)="view.set('conciliacion')"
                aria-label="Ir a Conciliación contra Kepler" title="Ir a Conciliación — contra Kepler">
          <i class="pi pi-sync"></i> Conciliado <b class="mono">{{ reconciledPct() == null ? 'sin correr' : reconciledPct() + '%' }}</b></button>
        @if (sheetCfg(); as sc) {
          <span class="fb-status-chip" [class.warn]="!!sc.last_error"
                [title]="sc.last_error || 'Sync del workbook maestro (Google Sheet)'">
            <i class="pi pi-cloud"></i> Sheet <b class="mono">{{ sc.active ? 'auto' : 'manual' }}</b>
            @if (sc.last_synced_at) { · <span class="mono">{{ sc.last_synced_at | date:'dd/MM HH:mm' }}</span> }
          </span>
        }
        <app-freshness-pill [since]="lastImported()" />
        @if (wsConnected()) {
          <span class="fb-status-chip fb-live" title="Actualización en vivo activa — el tablero se refresca solo">
            <i class="pi pi-circle-fill" aria-hidden="true"></i> En vivo
          </span>
        }
      </div>

      <div class="fb-viewseg" role="tablist">
        @for (v of WORK_VIEWS; track v.key) {
          <button role="tab" [attr.aria-selected]="view()===v.key" [class.active]="view()===v.key" (click)="goView(v.key)">
            <i [class]="v.icon"></i> {{ v.label }}
            @if (v.key === 'cierre' && diagnostico() && !diagnostico()!.cuadra) { <span class="fb-seg-count">{{ diagnostico()!.items.length }}</span> }
          </button>
        }
        <button role="tab" class="fb-seg-config" [attr.aria-selected]="view()==='admin'" [class.active]="view()==='admin'"
                (click)="openAdmin()" aria-label="Configuración" title="Configuración: reglas, categorías y cuentas"><i class="pi pi-cog"></i></button>
      </div>

      @if (loading()) {
        <div class="fb-skeleton" aria-busy="true">
          @for (i of [1,2,3,4,5,6]; track i) { <div class="fb-skel-row"></div> }
        </div>
      } @else {

      <!-- ── CIERRE (home): veredicto + resumen del dinero + qué falta (accionable) ── -->
      @if (view() === 'cierre') {
        @if (diagError()) {
          <app-load-state [error]="diagError()" (retry)="setPeriod(period())"></app-load-state>
        } @else {
          <bancos-cierre [diagnostico]="diagnostico()" [concentrado]="concentrado()" [balances]="balances()"
            [period]="period()" (itemAction)="itemAction($event)" />
        }
      }

      <!-- ── CONCENTRADO ── -->
      @if (view() === 'concentrado') {
        @if (concError()) {
          <app-load-state [error]="concError()" (retry)="setPeriod(period())"></app-load-state>
        } @else {
          @if (concentrado(); as c) {
            <bancos-concentrado [concentrado]="c" [balances]="balances()" [accountOpts]="accountOpts()" [period]="period()" />
          } @else {
            <div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin estados de cuenta para {{ period() }}.</p></div>
          }
        }
      }

      <!-- ── MOVIMIENTOS: la tabla de todos los ingresos y egresos ── -->
      @if (view() === 'movimientos') {
        <bancos-movimientos [movements]="movements()" [movTotal]="movTotal()"
          [accountOpts]="accountOpts()" [groupOpts]="groupOpts()" [reconOpts]="reconOpts"
          [fAccount]="fAccount()" [fGroup]="fGroup()" [fRecon]="fRecon()" [fUncat]="fUncat()" [fSearch]="fSearch()"
          (filter)="onMovFilter($event)" (searchChange)="onSearch($event)" />
      }

      <!-- ── CONCILIACIÓN banco ↔ Kepler (answer-first: veredicto → sin conciliar → evidencia) ── -->
      @if (view() === 'conciliacion') {
        @if (reconError()) {
          <app-load-state [error]="reconError()" (retry)="setPeriod(period())"></app-load-state>
        } @else {
          <bancos-conciliacion [reconciliation]="reconciliation()" [matchResult]="matchResult()"
            [differences]="differences()" [matching]="matching()" [syncing]="syncing()" [period]="period()"
            (runMatch)="runMatch()" (syncFindings)="syncFindings()" />
        }
      }


      <!-- ── vs ContPAQi: banco (Excel) contra los LIBROS reales de contabilidad ── -->
      @if (view() === 'contpaqi') {
        @if (cpqError()) {
          <app-load-state [error]="cpqError()" (retry)="loadContpaqi()"></app-load-state>
        } @else if (cpqLoading()) {
          <div class="fb-skeleton" aria-busy="true">@for (i of [1,2,3,4,5,6]; track i) { <div class="fb-skel-row"></div> }</div>
        } @else {
          <bancos-contpaqi [compare]="contpaqiCompare()" [linking]="cpqLinking()" [period]="period()" [available]="cpqAccounts()" [factoraje]="factorajeCompare()" (link)="linkContpaqi()" (manualLink)="manualLinkContpaqi($event)" />
        }
      }

      <!-- ── CUADRE 3 VÍAS: Workbook ↔ Kepler 102 ↔ ContPAQi ── -->
      @if (view() === 'cuadre') {
        @if (twError()) {
          <app-load-state [error]="twError()" (retry)="loadThreeWay()"></app-load-state>
        } @else if (twLoading()) {
          <div class="fb-skeleton" aria-busy="true">@for (i of [1,2,3,4]; track i) { <div class="fb-skel-row"></div> }</div>
        } @else {
          <bancos-three-way [data]="threeWay()" [period]="period()" />
        }
      }

      <!-- ── CAPTURAS WHATSAPP: bandeja de depósitos recibidos por WhatsApp (CBW.4) ── -->
      @if (view() === 'capturas') {
        <bancos-capturas />
      }

      <!-- ── CUENTAS: cuadre de saldos por cuenta (clic → sus movimientos) ── -->
      @if (view() === 'cuentas') {
        <bancos-cuentas [balances]="balances()" [statements]="statements()" [diagnostico]="diagnostico()"
          [period]="period()" (openAccount)="verCuentaMovs($event)" />
      }

      <!-- ── ADMIN: catálogo real Kepler (read-only) + setup de cuentas de banco ── -->
      @if (view() === 'admin') {
        <bancos-admin [keplerAccounts]="keplerAccounts()" [accounts]="accounts()"
          [kaSearch]="kaSearch()" [addingAcct]="addingAcct()"
          (search)="onKaSearch($event)" (patchAccount)="patchAccount($event.a, $event.patch)"
          (addAccount)="addAccount($event)" />
      }
      }
    </div>
  `,
  styles: [BANCOS_STYLES, `
    .fb-head-actions { display: flex; align-items: center; gap: var(--sp-3); }
    .fb-period { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-xs); color: var(--text-muted); }

    :host ::ng-deep .fb-sel.p-select { font-size: var(--fs-sm); }
    :host ::ng-deep .fb-sel .p-select-label { padding: var(--sp-1) var(--sp-2); }
    :host ::ng-deep .fb-search .p-inputtext { width: 100%; font-size: var(--fs-sm); }

    /* Quiet-luxury (Linear/Stripe): hairline, cero gloss, cero sombra difusa. La regla de
       elevación in-page es borde 1px O sombra, nunca ambas — antes llevaba borde + doble
       sombra + gloss iOS, que encima necesitaba un override de dark aparte porque el brillo
       blanco no sobrevive el tema. El desborde se ANUNCIA con fade en los bordes: 9 destinos
       con scrollbar oculto dejaban vistas invisibles en pantalla mediana. */
    .fb-viewseg {
      display: flex; align-items: stretch; gap: 2px; margin: var(--sp-3) 0; padding: 3px;
      background: var(--surface-ground); border: 1px solid var(--border-color); border-radius: var(--r-pill);
      overflow-x: auto; overflow-y: hidden; scrollbar-width: none; -ms-overflow-style: none;
      -webkit-mask-image: linear-gradient(to right, transparent 0, #000 var(--sp-4), #000 calc(100% - var(--sp-4)), transparent 100%);
      mask-image: linear-gradient(to right, transparent 0, #000 var(--sp-4), #000 calc(100% - var(--sp-4)), transparent 100%);
    }
    .fb-viewseg::-webkit-scrollbar { display: none; }
    .fb-viewseg button {
      display: inline-flex; align-items: center; gap: var(--sp-1); background: none; border: none; border-radius: var(--r-pill);
      color: var(--text-muted); font: inherit; font-size: var(--fs-sm); font-weight: 500;
      padding: var(--sp-1) var(--sp-3); cursor: pointer; white-space: nowrap;
      transition: background-color var(--dur-short) var(--ease-standard), color var(--dur-short) var(--ease-standard);
    }
    .fb-viewseg button:not(.active):hover { color: var(--text-main); }
    /* Activo = superficie + ring 1px tokenizado (no sombra): se lee igual en light y dark. */
    .fb-viewseg button.active {
      color: var(--action); background: var(--card-bg);
      box-shadow: 0 0 0 1px var(--border-color);
    }
    .fb-viewseg button:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 1px; }
    .fb-seg-config { margin-left: auto; }
    .fb-title-row { display: inline-flex; align-items: center; gap: var(--sp-1); }

    .fb-status { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); margin: var(--sp-2) 0 0; }
    .fb-status-chip { display: inline-flex; align-items: center; gap: var(--sp-1); font: inherit; font-size: var(--fs-xs);
      color: var(--text-muted); background: none; border: 1px solid transparent; border-radius: var(--r-pill);
      padding: 2px var(--sp-2); cursor: pointer; transition: background-color 120ms ease, border-color 120ms ease; }
    .fb-status-chip:hover { background: var(--hover-bg); border-color: var(--border-color); }
    /* Afordancia de navegación: sólo los chips que SON botón muestran la flecha.
       No son nav redundante del segmentado — saltan con el filtro ya puesto (DESIGN §Q.4). */
    button.fb-status-chip::after { content: '→'; opacity: 0; margin-left: 2px; transition: opacity var(--dur-short) var(--ease-standard); }
    button.fb-status-chip:hover::after, button.fb-status-chip:focus-visible::after { opacity: .55; }
    .fb-status-chip:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 1px; }
    .fb-status-chip i { font-size: .8rem; color: var(--text-faint); }
    .fb-status-chip b { color: var(--text-main); font-weight: 600; }
    .fb-status-chip.warn { color: var(--warn-fg); }
    .fb-status-chip.warn i, .fb-status-chip.warn b { color: var(--warn-fg); }
    .fb-live { color: var(--ok-fg); border-color: color-mix(in srgb, var(--ok-fg) 30%, transparent); }
    .fb-live i { color: var(--ok-fg); font-size: .5rem; animation: fb-live-pulse 2s ease-in-out infinite; }
    @media (prefers-reduced-motion: reduce) { .fb-live i { animation: none; } }
    @keyframes fb-live-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }

    .fb-cat-chip { display: inline-block; font-size: var(--fs-xs); color: var(--text-muted); }

    :host ::ng-deep .fb-pin.p-inputtext { width: 100%; font-size: var(--fs-xs); padding: 2px var(--sp-2); }

    .fb-colored > td { background: color-mix(in srgb, var(--g, transparent) 8%, transparent); }
    .fb-legend-item.active { border-color: var(--g); color: var(--text-main); background: color-mix(in srgb, var(--g) 8%, transparent); }
    .fb-skeleton { display: flex; flex-direction: column; gap: var(--sp-2); margin-top: var(--sp-4); }
    .fb-skel-row { height: var(--row-h-md); border-radius: var(--r-sm); background: var(--hover-bg); animation: fb-pulse 1.4s ease-in-out infinite; }
    @keyframes fb-pulse { 0%,100% { opacity: .5; } 50% { opacity: .9; } }
    @media (prefers-reduced-motion: reduce) { .fb-skel-row { animation: none; } }
    .fb-bal-badge.warn { color: var(--warn-fg); background: color-mix(in srgb, var(--warn-fg) 12%, transparent); }
    .fb-seg-count { display: inline-flex; align-items: center; justify-content: center; min-width: 1.1rem; height: 1.1rem; padding: 0 4px; margin-left: 4px; font-size: var(--fs-micro); font-weight: 700; border-radius: var(--r-pill); background: var(--warn-fg); color: var(--stone-950); }
    .fb-match-rate.warn { color: var(--warn-fg); }
    .fb-adminseg button.active { color: var(--action); border-color: var(--action); background: color-mix(in srgb, var(--action) 8%, transparent); }
  `],
})
export class FinanzasBancosComponent implements OnInit {
  private readonly api = inject(BankService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly sock = inject(BancosSocketService);
  private readonly auth = inject(AuthService);

  /** WS en vivo: verde cuando el socket `/bancos` está conectado. */
  readonly wsConnected = computed(() => this.sock.connected());
  private wsTimer: any = null;

  readonly tabs = FINANZAS_TABS;
  readonly GROUP_ORDER = GROUP_ORDER;
  readonly WORK_VIEWS = WORK_VIEWS;

  @ViewChild('fileInput') fileInput?: ElementRef<HTMLInputElement>;

  readonly view = signal<View>('cierre');
  readonly loading = signal(true);
  readonly periods = signal<string[]>([]);
  readonly period = signal<string>('');
  readonly accounts = signal<BankAccount[]>([]);
  readonly categories = signal<MovementCategory[]>([]);
  readonly statements = signal<BankStatement[]>([]);
  readonly concentrado = signal<Concentrado | null>(null);
  readonly reconciliation = signal<Reconciliation | null>(null);
  readonly balances = signal<Balances | null>(null);
  readonly diagnostico = signal<Diagnostico | null>(null);
  readonly matchResult = signal<MatchResult | null>(null);
  readonly differences = signal<Differences | null>(null);
  /** COMM-P0 — trabajos largos disparados desde ESTA pantalla (job_id → name). */
  private readonly pendingJobs = new Map<string, string>();
  private readonly jobsClient = inject(FinanceJobsClient);
  readonly matching = signal(false);
  readonly syncing = signal(false);
  readonly movements = signal<BankMovement[]>([]);
  readonly movTotal = signal(0);
  // CP.2 — comparación vs LIBROS ContPAQi (lazy: se carga al abrir la pestaña).
  readonly contpaqiCompare = signal<ContpaqiCompare | null>(null);
  readonly cpqLoading = signal(false);
  readonly cpqError = signal<string | null>(null);
  readonly cpqLinking = signal(false);
  readonly cpqAccounts = signal<ContpaqiBankAccount[]>([]);
  readonly factorajeCompare = signal<FactorajeCompare | null>(null);
  // CB.24 — cuadre 3 vías (lazy: se carga al abrir la pestaña).
  readonly threeWay = signal<ThreeWay | null>(null);
  readonly twLoading = signal(false);
  readonly twError = signal<string | null>(null);
  // CB.23 — estado del sync del workbook maestro (Google Sheet).
  readonly sheetCfg = signal<SheetSyncConfig | null>(null);
  readonly syncingSheet = signal(false);

  // Filtros de Movimientos (el shell los posee para poder recargar al cambiar de periodo).
  readonly fAccount = signal('');
  readonly fGroup = signal('');
  readonly fUncat = signal(false);
  readonly fSearch = signal('');
  readonly fRecon = signal('');
  readonly uploading = signal(false);
  private searchTimer: any = null;

  readonly reconOpts = [
    { label: 'Conciliación: todos', value: '' },
    { label: 'Conciliados', value: 'matched' },
    { label: 'Sin conciliar', value: 'unmatched' },
  ];

  // CB.13 — buscador del catálogo real de cuentas Kepler (resultados los posee el shell).
  readonly kaSearch = signal('');
  readonly keplerAccounts = signal<KeplerAccount[]>([]);

  // Errores por vista (banner + Reintentar; separa "no cargó" de "vacío" — DESIGN §6).
  readonly concError = signal<string | null>(null);
  readonly movError = signal<string | null>(null);
  readonly reconError = signal<string | null>(null);
  readonly diagError = signal<string | null>(null);
  // Auto-disable síncrono del alta de cuenta (anti doble-submit — DESIGN §13).
  readonly addingAcct = signal(false);

  // Opciones para los p-select (label/value).
  readonly accountOpts = computed(() => [
    { label: 'Todas las cuentas', value: '' },
    ...this.accounts().map((a) => ({ label: `${a.bank} ${a.account_label}`, value: a.id })),
  ]);
  readonly groupOpts = computed(() => [
    { label: 'Todos los grupos', value: '' },
    ...GROUP_ORDER.map((g) => ({ label: GROUP_LABELS[g] || g, value: g })),
  ]);

  /** Última importación del periodo (para la píldora de frescura). */
  readonly lastImported = computed(() => {
    const ds = this.statements().map((s) => s.imported_at).filter(Boolean) as string[];
    return ds.length ? ds.sort().reverse()[0] : null;
  });

  // ── Estado del cierre para la barra de comando (chips answer-first) ──
  readonly importStatus = computed(() => {
    const total = this.accounts().filter((a) => a.active).length;
    return { loaded: this.statements().length, total };
  });
  readonly classifiedPct = computed(() => {
    const d = this.diagnostico();
    if (!d || !d.movimientos) return null;
    const sc = this.concentrado()?.groupTotals?.['sin_clasificar']?.movs ?? 0;
    return Math.max(0, Math.round(((d.movimientos - sc) / d.movimientos) * 100));
  });
  // % por MONTO (no por conteo): es el que importa — el dinero grande casa, las
  // comisiones/nómina chiquitas que Kepler agrupa no, y subvenden el conteo.
  amtPct(mr: { matched_amount: number; bank_amount: number }): number {
    return mr?.bank_amount ? Math.round((mr.matched_amount / mr.bank_amount) * 100) : 0;
  }
  readonly reconciledPct = computed(() => {
    const mr = this.matchResult(); if (!mr) return null;
    return this.amtPct(mr);
  });

  ngOnInit(): void {
    // WS realtime `/bancos`: refresca solo cuando el feed importa, el cron sincroniza
    // el Sheet, se corre la conciliación o entra/valida un comprobante (otro operador).
    this.sock.connect();
    this.sock.change$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((ev) => this.onRemoteChange(ev));
    this.sock.job$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((ev) => this.onJob(ev));
    this.destroyRef.onDestroy(() => this.sock.disconnect());

    this.api.periods().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (ps) => {
        this.periods.set(ps);
        this.period.set(ps[0] || '');
        this.api.categories().pipe(takeUntilDestroyed(this.destroyRef)).subscribe((cs) => this.categories.set(cs));
        this.api.accounts().pipe(takeUntilDestroyed(this.destroyRef)).subscribe((as) => this.accounts.set(as));
        this.api.sheetSyncConfig().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (c) => this.sheetCfg.set(c), error: () => { /* sync opcional */ } });
        if (this.period()) this.loadPeriod();
        else this.loading.set(false);
      },
      error: () => this.fail('No se pudieron cargar los periodos.'),
    });
  }

  /**
   * COMM-P0 — cierre de un motor largo (import / conciliación / hallazgos / sync del
   * Sheet). El endpoint contestó 202 y el resultado llega aquí: sin esto, un workbook
   * grande se pasaba de los 60 s de nginx y el navegador veía 504 con el import a medias.
   * Sólo actúa sobre los trabajos que ESTA pantalla disparó (los de otros usuarios ya
   * refrescan por `bancos_changed`).
   */
  private track(job: JobAccepted): void {
    this.pendingJobs.set(job.job_id, job.name);
    // Respaldo del WS: si no conectó, la sonda trae el cierre igual (el primero gana).
    this.jobsClient.watch(job.job_id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (ev) => this.onJob(ev),
      error: () => { /* el WS sigue siendo el camino principal */ },
    });
  }

  private onJob(ev: FinanceJobEvent): void {
    if (ev.status === 'running') return;
    if (!this.pendingJobs.delete(ev.job_id)) return;

    switch (ev.name) {
      case 'bank-import': this.uploading.set(false); break;
      case 'bank-match': this.matching.set(false); break;
      case 'bank-findings-sync': this.syncing.set(false); break;
      case 'bank-sheet-sync': this.syncingSheet.set(false); break;
    }

    if (ev.status === 'error') { this.fail(ev.error || `No se pudo completar: ${ev.label}`); return; }

    if (ev.name === 'bank-import') {
      const res = ev.result as ImportResult;
      this.toast.add({ severity: 'success', summary: `Importado ${res.period}`, detail: `${res.total} movimientos · ${res.sin_clasificar} sin clasificar`, life: 4000 });
      if (!this.periods().includes(res.period)) this.periods.update((ps) => [res.period, ...ps].sort().reverse());
      this.setPeriod(res.period);
      return;
    }
    if (ev.name === 'bank-match') {
      const mr = ev.result as MatchResult;
      this.matchResult.set(mr);
      this.toast.add({ severity: 'success', summary: `Conciliación ${mr.match_rate}%`, detail: `${mr.matched} de ${mr.bank_movements} retiros conciliados`, life: 3500 });
      this.api.differences(this.period()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (df) => this.differences.set(df), error: () => this.differences.set(null) });
      this.refreshDiagnostico();
      this.reloadMovements();
      return;
    }
    if (ev.name === 'bank-findings-sync') {
      const r = ev.result as SyncFindingsResult;
      this.toast.add({ severity: 'success', summary: `${r.pushed} diferencias enviadas`, detail: `${r.inserted} nuevas en /finanzas/hallazgos · ${r.skipped} omitidas`, life: 4000 });
      return;
    }
    if (ev.name === 'bank-sheet-sync') {
      const r = ev.result as SheetSyncRunResult;
      if (r.skipped) {
        this.toast.add({ severity: 'info', summary: 'Sin cambios', detail: 'El Sheet no cambió desde la última sincronización.', life: 3000 });
      } else {
        this.toast.add({ severity: 'success', summary: `Sincronizado ${r.period}`, detail: `${r.total ?? 0} movimientos · ${r.swept ?? 0} borrados · ${r.sin_clasificar ?? 0} sin clasificar`, life: 4500 });
      }
      this.api.sheetSyncConfig().pipe(takeUntilDestroyed(this.destroyRef)).subscribe((c) => this.sheetCfg.set(c));
      this.threeWay.set(null);
      this.loadPeriod();
    }
  }

  /** Un cambio remoto de Bancos llegó por WS: refresca en silencio + avisa si fue de otro. */
  private onRemoteChange(ev: BancosEvent): void {
    const mine = !!ev.actor && ev.actor === this.auth.user()?.username;
    // Refresca sólo si el cambio toca el periodo visible (o es global sin periodo).
    if (!ev.period || ev.period === this.period()) this.scheduleSoftRefresh();
    // Toast sólo para cambios de OTROS (el tuyo ya te dio feedback local; evita doble aviso).
    if (!mine) this.toast.add({ severity: 'info', summary: 'Bancos actualizado', detail: ev.detail || this.wsLabel(ev.action), life: 4000 });
  }

  private wsLabel(a: BancosEvent['action']): string {
    switch (a) {
      case 'imported': return 'Se importó un estado de cuenta';
      case 'sheet_synced': return 'Se sincronizó el workbook maestro';
      case 'matched': return 'Se corrió la conciliación';
      case 'capture_new': return 'Llegó un comprobante de depósito';
      case 'capture_validated': return 'Se validó un comprobante';
      case 'capture_rejected': return 'Se rechazó un comprobante';
      default: return 'Bancos actualizado';
    }
  }

  private scheduleSoftRefresh(): void {
    if (this.wsTimer) clearTimeout(this.wsTimer);
    this.wsTimer = setTimeout(() => this.softRefresh(), 600);
  }

  /** Refresco silencioso (sin skeleton) del periodo + la vista abierta, tras un cambio remoto. */
  private softRefresh(): void {
    const p = this.period();
    if (!p) return;
    this.api.concentrado(p).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (c) => this.concentrado.set(c), error: () => { /* silencioso */ } });
    this.api.statements(p).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (s) => this.statements.set(s), error: () => { /* silencioso */ } });
    this.api.diagnostico(p).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (d) => this.diagnostico.set(d), error: () => { /* silencioso */ } });
    this.api.balances(p).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (b) => this.balances.set(b), error: () => { /* silencioso */ } });
    this.reloadMovements();
    const v = this.view();
    if (v === 'conciliacion') this.api.reconciliation(p).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (rc) => this.reconciliation.set(rc), error: () => { /* silencioso */ } });
    if (v === 'cuadre') this.loadThreeWay();
    if (v === 'contpaqi') this.loadContpaqi();
  }

  setPeriod(p: string): void { this.period.set(p); this.loadPeriod(); }

  /** Cambio de vista; carga perezosa del comparador (payload grande) al abrirlo. */
  goView(v: View): void {
    this.view.set(v);
    if (v === 'contpaqi' && !this.contpaqiCompare() && !this.cpqLoading()) this.loadContpaqi();
    if (v === 'cuadre' && !this.threeWay() && !this.twLoading()) this.loadThreeWay();
  }

  /** CB.24 — carga el cuadre 3 vías del periodo (lazy). */
  loadThreeWay(): void {
    const p = this.period();
    if (!p) return;
    this.twLoading.set(true);
    this.twError.set(null);
    this.api.threeWay(p).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.threeWay.set(d); this.twLoading.set(false); },
      error: () => { this.twError.set('No se pudo cargar el cuadre 3 vías.'); this.twLoading.set(false); },
    });
  }

  /** CB.23 — sincroniza AHORA el workbook maestro del Google Sheet y recarga el periodo. */
  runSheetSync(): void {
    if (this.syncingSheet()) return;
    this.syncingSheet.set(true);
    this.api.sheetSyncRun().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (job) => this.track(job),
      error: (e) => { this.syncingSheet.set(false); this.fail(e?.error?.message || 'No se pudo sincronizar del Sheet.'); },
    });
  }

  /** CP.2 — carga la comparación banco vs libros ContPAQi del periodo (lazy). */
  loadContpaqi(): void {
    const p = this.period();
    if (!p) return;
    this.cpqLoading.set(true);
    this.cpqError.set(null);
    this.api.contpaqiCompare(p).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (c) => { this.contpaqiCompare.set(c); this.cpqLoading.set(false); },
      error: () => { this.cpqError.set('No se pudo cargar la comparación vs ContPAQi.'); this.cpqLoading.set(false); },
    });
    if (!this.cpqAccounts().length) {
      this.api.contpaqiAccounts().pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (as) => this.cpqAccounts.set(as), error: () => { /* selector opcional */ } });
    }
    this.api.factorajeCompare(p).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (f) => this.factorajeCompare.set(f), error: () => { /* factoraje opcional */ } });
  }

  /** CP.2 — enlace manual de una cuenta (Santander 1604/1621) a su cuenta contable ContPAQi. */
  manualLinkContpaqi(e: { bankAccountId: string; cuenta: string | null }): void {
    this.api.manualLinkContpaqi(e.bankAccountId, e.cuenta).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.toast.add({ severity: 'success', summary: 'Cuenta enlazada', detail: 'Se guardó el enlace manual a ContPAQi', life: 2500 });
        this.cpqAccounts.set([]);
        this.loadContpaqi();
      },
      error: () => this.fail('No se pudo enlazar la cuenta con ContPAQi.'),
    });
  }

  /** CP.2 — auto-enlaza las cuentas de banco con su cuenta contable 102xxx de ContPAQi. */
  linkContpaqi(): void {
    this.cpqLinking.set(true);
    this.api.linkContpaqi().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.cpqLinking.set(false);
        this.toast.add({ severity: 'success', summary: `${r.linked} de ${r.total} cuentas enlazadas`, detail: 'Comparando contra los libros de ContPAQi', life: 3000 });
        this.loadContpaqi();
      },
      error: () => { this.cpqLinking.set(false); this.fail('No se pudieron enlazar las cuentas con ContPAQi.'); },
    });
  }
  private loadPeriod(): void {
    this.loading.set(true);
    this.matchResult.set(null);
    this.differences.set(null);
    this.concError.set(null);
    this.reconError.set(null);
    this.diagError.set(null);
    this.contpaqiCompare.set(null);
    this.factorajeCompare.set(null);
    this.cpqError.set(null);
    this.threeWay.set(null);
    this.twError.set(null);
    const p = this.period();
    if (this.view() === 'contpaqi') this.loadContpaqi();
    if (this.view() === 'cuadre') this.loadThreeWay();
    this.api.concentrado(p).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (c) => { this.concentrado.set(c); this.loading.set(false); },
      error: () => { this.concError.set('No se pudo cargar el concentrado del periodo.'); this.loading.set(false); },
    });
    this.api.statements(p).pipe(takeUntilDestroyed(this.destroyRef)).subscribe((s) => this.statements.set(s));
    this.api.reconciliation(p).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (rc) => this.reconciliation.set(rc), error: () => { this.reconciliation.set(null); this.reconError.set('No se pudo cargar la conciliación del periodo.'); } });
    this.api.balances(p).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (b) => this.balances.set(b), error: () => this.balances.set(null) });
    this.api.diagnostico(p).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (d) => this.diagnostico.set(d), error: () => { this.diagnostico.set(null); this.diagError.set('No se pudo cargar el diagnóstico del periodo.'); } });
    this.reloadMovements();
  }

  reloadMovements(): void {
    const p = this.period();
    if (!p) { this.loading.set(false); return; }
    this.movError.set(null);
    this.api.movements({
      period: p, account_id: this.fAccount() || undefined, group_key: this.fGroup() || undefined,
      uncategorized: this.fUncat() || undefined, recon_status: this.fRecon() || undefined,
      search: this.fSearch() || undefined, limit: 500,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.movements.set(r.rows); this.movTotal.set(r.total); this.loading.set(false); },
      error: () => { this.movError.set('No se pudieron cargar los movimientos.'); this.loading.set(false); },
    });
  }

  onSearch(v: string): void {
    this.fSearch.set(v);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.reloadMovements(), 300);
  }

  /** Sube un workbook Excel: deriva el periodo del nombre (o usa el seleccionado) e importa. */
  onFile(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const upper = file.name.toUpperCase();
    const m = upper.match(/(ENERO|FEBRERO|MARZO|ABRIL|MAYO|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE)\s+(\d{4})/);
    const period = m ? `${m[2]}-${MONTHS_ES[m[1]]}` : this.period();
    if (!period) { this.fail('No pude derivar el periodo del nombre; selecciona un periodo primero.'); input.value = ''; return; }

    this.uploading.set(true);
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = String(reader.result || '');
      this.api.importWorkbook(b64, period, file.name).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (job) => {
          input.value = '';
          this.track(job);
          this.toast.add({ severity: 'info', summary: 'Importando…', detail: `${file.name} — te aviso al terminar.`, life: 3000 });
        },
        error: () => { this.uploading.set(false); input.value = ''; this.fail('No se pudo importar el Excel.'); },
      });
    };
    reader.onerror = () => { this.uploading.set(false); input.value = ''; this.fail('No se pudo leer el archivo.'); };
    reader.readAsDataURL(file);
  }

  /** Corre el matching por-transacción del periodo y recarga los movimientos (recon_status). */
  runMatch(): void {
    if (!this.period()) return;
    this.matching.set(true);
    this.api.runMatch(this.period()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (job) => this.track(job),
      error: () => { this.matching.set(false); this.fail('No se pudo correr la conciliación.'); },
    });
  }

  /** CB.7 — Empuja las diferencias del periodo a la bandeja de hallazgos de Maat. */
  syncFindings(): void {
    if (!this.period()) return;
    this.syncing.set(true);
    this.api.syncFindings(this.period()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (job) => this.track(job),
      error: () => { this.syncing.set(false); this.fail('No se pudieron enviar las diferencias a Hallazgos.'); },
    });
  }

  /** Refresca el diagnóstico + balances del periodo (tras reclasificar / conciliar). */
  private refreshDiagnostico(): void {
    const p = this.period();
    if (!p) return;
    this.api.diagnostico(p).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (d) => this.diagnostico.set(d), error: () => {} });
    this.api.balances(p).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (b) => this.balances.set(b), error: () => {} });
  }

  /** Cambio de filtro emitido por <bancos-movimientos>: setea el signal y recarga. */
  onMovFilter(e: { field: string; value: any }): void {
    switch (e.field) {
      case 'account': this.fAccount.set(e.value || ''); break;
      case 'group': this.fGroup.set(e.value || ''); break;
      case 'recon': this.fRecon.set(e.value || ''); break;
      case 'uncat': this.fUncat.set(!!e.value); break;
    }
    this.reloadMovements();
  }

  /** Checklist accionable: salta al lugar exacto para resolver cada descuadre del diagnóstico. */
  itemAction(it: { tipo?: string }): void {
    switch (it?.tipo) {
      case 'sin_clasificar': this.view.set('movimientos'); this.fGroup.set(''); this.fUncat.set(true); this.reloadMovements(); break;
      case 'traspaso_descuadre': this.view.set('movimientos'); this.fUncat.set(false); this.fGroup.set('traspaso'); this.reloadMovements(); break;
      case 'saldo_no_cuadra': this.view.set('cuentas'); break;
      case 'kepler_pnl': this.view.set('conciliacion'); break;
      case 'cuenta_sin_cargar': this.fileInput?.nativeElement.click(); break;
      default: this.view.set('movimientos'); this.reloadMovements();
    }
  }
  /** Desde Cuentas: salta a Movimientos filtrado a esa cuenta. */
  verCuentaMovs(a: { bank: string; account_label: string }): void {
    const acct = this.accounts().find((x) => x.bank === a.bank && x.account_label === a.account_label);
    this.fAccount.set(acct?.id || '');
    this.fGroup.set('');
    this.fUncat.set(false);
    this.view.set('movimientos');
    this.reloadMovements();
  }
  // CB.13 — búsqueda en el catálogo real de cuentas de Kepler.
  onKaSearch(v: string): void {
    this.kaSearch.set(v);
    const s = (v || '').trim();
    if (!s) { this.keplerAccounts.set([]); return; }
    this.api.keplerAccounts(s).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.keplerAccounts.set(r), error: () => this.keplerAccounts.set([]),
    });
  }

  // ── Admin ──
  openAdmin(): void { this.view.set('admin'); }

  private ok(summary: string): void { this.toast.add({ severity: 'success', summary, life: 1500 }); }

  patchAccount(a: BankAccount, patch: Partial<BankAccount>): void {
    this.accounts.update((as) => as.map((x) => x.id === a.id ? { ...x, ...patch } : x));
    this.api.updateAccount(a.id, patch).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => this.ok('Cuenta actualizada'), error: () => this.fail('No se pudo actualizar la cuenta.') });
  }
  addAccount(p: { bank: string; account_label: string; alias: string; kind: string; kepler_link: string }): void {
    if (this.addingAcct()) return;
    if (!p.bank || !p.account_label) { this.fail('Banco y cuenta requeridos.'); return; }
    this.addingAcct.set(true);
    this.api.createAccount({ bank: p.bank, account_label: p.account_label, alias: p.alias || null, kind: p.kind, kepler_link: p.kepler_link || null } as any)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => { this.addingAcct.set(false); this.api.accounts().pipe(takeUntilDestroyed(this.destroyRef)).subscribe((as) => this.accounts.set(as)); this.ok('Cuenta agregada'); },
        error: () => { this.addingAcct.set(false); this.fail('No se pudo agregar la cuenta.'); },
      });
  }

  private fail(msg: string): void {
    this.loading.set(false);
    this.toast.add({ severity: 'error', summary: 'Error', detail: msg, life: 4000 });
  }
}
