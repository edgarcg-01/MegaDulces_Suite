import { ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { forkJoin } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';
import { CheckboxModule } from 'primeng/checkbox';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import type { Freshness, Coverage, BudgetResult, BudgetResultMonth, BudgetResultAnnual }
  from '@megadulces/contracts'; // solo tipos → cero bytes al bundle
import { environment } from '../../../../environments/environment';

interface Capacity { capacity_date: string; authorized_amount: number; note: string | null; updated_by: string | null; updated_at: string }
interface CapacityHistoryRow { previous_amount: number | null; new_amount: number; reason: string | null; changed_by: string; changed_at: string }
interface ExpenseObligation {
  id: string; concept: string; beneficiary: string; area: string | null; subtype: string | null;
  original_amount: number; reserved_amount: number; paid_amount: number; available_amount: number;
  original_due_date: string | null; status: string; is_critical: boolean; critical_reason: string | null;
}
interface BudgetHeader { id: string; folio: string | null; name: string; fiscal_year: number; scenario: string; status: string; currency: string; version: number }
interface BudgetLine {
  id: string; concept: string; line_type: string; area: string | null;
  /** `[PU.VA]` Ya viajaban (el servicio devuelve la fila entera); faltaba declararlos para poder usarlos. */
  cost_center?: string | null; source?: string | null;
  vigente_amount: number; reserved_amount: number; committed_amount: number; exercised_amount: number;
  paid_amount: number; available_amount: number; control_level: string; status: string;
  expense_class: string | null; recurrence: string | null; responsible: string | null;
}
interface RealBlock { available: boolean; deferred?: boolean; ventas: number | null; costo: number | null; margen: number | null; data_as_of: string | null; reason?: string }
interface Summary {
  budget: BudgetHeader;
  /** `[PU.VA]` `alcance` dice qué suma: los cinco estados son del EGRESO. La meta de ventas viaja en `ingreso_meta`. */
  ejecucion: { vigente: number; reserved: number; committed: number; exercised: number; paid: number; disponible: number; ocupacion_pct: number | null; alcance?: 'egreso'; ingreso_meta?: number };
  presupuesto: { ingresos: number; costo_ventas: number; gasto: number; margen: number };
  real: RealBlock;
  kpis: { cumplimiento_ventas_pct: number | null; desviacion_ventas: number | null; margen_real: number | null; ocupacion_presupuestaria_pct: number | null };
  freshness: Freshness; coverage: Coverage;
}
interface CashBucket { week: string; cobros: number; pagos: number; pagos_autorizados?: number; neto: number; neto_acumulado: number; saldo_proyectado: number | null }
interface Cashflow {
  period: { from: string; to: string; bucket: string };
  opening_balance: {
    available: boolean; amount: number | null; as_of: string | null; source: string; reason?: string;
    /** `[TES.3]` Filas de fecha imposible, excluidas del saldo y de la frescura. Declaradas, no borradas. */
    anomalias?: { filas: number; futuras: number; absurdas: number; rango: { min: string; max: string }; efecto: string };
  };
  /** `[TES.2]` La deuda DERIVADA del ERP: lo que la curva de pago dibuja, y lo que deja fuera. */
  deuda_erp?: {
    base: string; por_tipo: Record<string, number>; as_of: string | null; as_of_reason: string;
    fuente: string; clasificador: string;
    cobertura: {
      en_ventana: number; vencido_fuera: number; posterior: number; sin_vencimiento: number;
      total: number; pct_en_ventana: number | null; interno_excluido: number;
    };
  };
  /** ⛔ `pagos_autorizados` NO se suma a `pagos`: el traslape con la deuda del ERP no está resuelto. */
  totals: { cobros: number; pagos: number; pagos_autorizados?: number; neto: number };
  saldo_minimo_proyectado: number | null;
  buckets: CashBucket[];
  alerts: { week: string; saldo_proyectado: number | null; tipo: string }[];
  sources: { cobros: { source: string; as_of: string | null; base?: string } };
  /** `[CXC.22]` Qué porción de la cartera cobrable dibuja esta curva, y qué queda fuera. */
  cobranza_cobertura?: {
    en_ventana: number; vencido_fuera: number; posterior: number;
    sin_vencimiento: number; total: number; pct_en_ventana: number | null;
  };
  freshness: Freshness; coverage: Coverage;
}

interface Campaign {
  id: string; name: string; campaign_type: string; status: string; objective?: string | null; responsible?: string | null;
  channels?: string | null; start_date?: string | null; end_date?: string | null; planned_budget: number; attribution_rule?: string | null;
}
interface Contribution { id: string; supplier: string; amount: number; condition: string | null; status: string; evidence: string | null }
interface CampaignEval {
  campaign: { id: string; name: string; campaign_type: string; status: string; start_date: string | null; end_date: string | null; attribution_rule: string | null };
  partidas: number; presupuesto: number; costo: number; costo_neto_aportacion: number;
  aportaciones: { confirmada: number; incierta: number; nota: string };
  ventas_vinculadas: { available: boolean; source: string; as_of: string | null; attribution: string; reason?: string; monto: number | null };
  freshness: Freshness;
  intensidad_gasto_ventas_pct: number | null;
  retorno: { available: boolean; roi_pct: number | null; basis?: string; reason?: string };
  warnings: string[];
}

/** [PU.VA] Latido de la pasada que arma el presupuesto. status: null = no sé, nunca «ok». */
interface AutopilotStatus {
  status: string | null; last_start: string | null; last_finish: string | null;
  note: string | null; error: string | null; host: string | null;
  pasadas_completadas: number; nunca_completo: boolean;
}
interface ImportPreview { summary: { total: number; create: number; update: number; errors: number }; rows: { i: number; concept: string; action: string; error?: string }[] }
interface Projection { authorized_vigente: number; proyeccion_firme: number; proyeccion_plena: number; actual: { exercised: number; committed: number; reserved: number; disponible: number }; note: string }
interface CompareRow { concept: string; area: string | null; line_type: string; vigente_a: number | null; vigente_b: number | null; delta: number | null; estado: string }
interface CompareResult { totals: { a: number; b: number; delta: number }; rows: CompareRow[] }

// ── Presupuesto de ventas (PV) ──
interface SalesCell {
  entity_key: string; channel: string; channel_label: string; entity_type: string;
  warehouse_code: string; branch_name: string | null; period_no: number;
  meta: number | null; real: number | null; real_prior: number | null;
  cumplimiento_pct: number | null; crec_pct: number | null; part_pct: number | null;
  method: string | null;
}
interface SalesComparison {
  budget: { id: string; name: string; fiscal_year: number; status: string };
  prior_year: number;
  cells: SalesCell[];
  totals: { meta: number; real: number | null; real_prior: number; cumplimiento_pct: number | null; crec_pct: number | null };
  /** [PU.V6] Cuánto AÑO cubre `totals.meta`. Va fuera de `totals` a propósito: adentro, alguien lo sumaría. */
  periodos?: {
    del_anio: number; con_meta: number; sin_meta: number[]; completo: boolean;
    /** Lo que esos períodos valieron en el último ejercicio COMPLETO. `null` = no se pudo medir, nunca $0. */
    referencia: { fiscal_year: number; monto: number } | null;
    nota: string;
  };
  data_as_of: string | null;
  real_available: boolean;
  freshness: Freshness; coverage: Coverage;
}
interface SalesEntity { entity_key: string; channel: string; channel_label: string; entity_type: string; warehouse_code: string; branch_name: string | null; route_code: string | null; route_zona: string | null }
interface SalesRow {
  label: string; channel_label: string; entity_key: string | null; is_rollup: boolean;
  meta: number | null; real: number | null; cumplimiento_pct: number | null; crec_pct: number | null; part_pct: number | null;
  method: string | null;
}
// PVA — propuesta automática
interface GrowthChannel { growth_pct: number; basis: string; paired_periods: number; years_used: number[] }
interface GrowthProposal {
  by_channel: Record<string, GrowthChannel>;
  global: { growth_pct: number; basis: string; paired_periods: number };
  years_available: number[]; fiscal_year: number; min_paired_periods?: number;
}
interface GrowthEditRow { channel: string; channel_label: string; growth_pct: number; basis: string; paired_periods: number }
interface ProposeCoverage {
  historico_ajustado: number; estacional: number; proxy_canal: number; sin_base_declarado: number; no_signal: number; manual_kept: number;
  /**
   * `[PVI.2]` El DINERO por método. `coverage` cuenta CELDAS, y el dinero no se reparte por celda:
   * medido en prod, el proxy eran 104 de 429 celdas (24.2 %) **y** $197,160,564 (24.46 % de la
   * meta) — que casi coincidieran fue casualidad de ese ejercicio, no una regla, y **nadie
   * calculaba el segundo**. Opcional a propósito: contra una API que todavía no lo emite la
   * pantalla **declara que no lo midió**, en vez de quedarse en blanco o dibujar un 0.
   */
  coverage_monto?: { historico_ajustado: number; estacional: number; proxy_canal: number; sin_base_declarado: number };
  meta_total?: number;
  /** Fracción de la meta repartida con el PROMEDIO DE OTRAS entidades del canal. `null` si la meta
   *  es 0: una meta de 0 no tiene «0 % sin base», tiene un porcentaje indefinido. */
  proxy_canal_pct?: number | null;
}
interface IndicatorSeries { year: number; real: number | null; crec_pct: number | null; part_pct: number | null }
interface IndicatorCurrent { meta: number | null; real: number | null; cumplimiento_pct: number | null; crec_pct: number | null }
interface IndicatorRow { channel?: string; channel_label: string; label?: string; entity_key?: string; series: IndicatorSeries[]; current: IndicatorCurrent }
interface SalesIndicators {
  budget: { id: string; name: string; fiscal_year: number; status: string };
  prior_year: number; years_available: number[];
  company: { series: IndicatorSeries[]; current: IndicatorCurrent };
  by_channel: IndicatorRow[]; by_entity: IndicatorRow[];
  data_as_of: string | null; real_available: boolean;
  freshness: Freshness;
}
interface ReconAnnualRow { channel: string; channel_label: string; year: string; sell_out: number; facturacion: number; delta: number; ratio_pct: number | null; status: string }
interface SalesReconciliation { annual: ReconAnnualRow[]; monthly: unknown[]; notes: string[]; data_as_of: string | null; freshness: Freshness }

// ── PVG: presupuesto de gastos auto-propuesto desde egresos Kepler ──
interface ExpensePlanLine { account_code: string; account_name: string | null; familia: string | null; sucursal: string; year_month: string; monto: number; method: string; growth_pct: number | null; base_amount: number | null }
interface ExpensePlanSettings { proposal_families: string[]; default_growth_pct: number; growth_by_account: Record<string, number>; by_sucursal: boolean; control_level: string; exists?: boolean }
interface ExpensePlan { budget: BudgetHeader; settings: ExpensePlanSettings; lines: ExpensePlanLine[] }
interface ExpenseCoverage { historico_ajustado: number; estacional: number; no_signal: number; manual_kept: number; accounts: number }
interface ExpenseGrowthProposal { global: { growth_pct: number; basis: string; paired_months: number; meses_abiertos_excluidos?: number }; years_available: number[]; fiscal_year: number; families: string[]; as_of: string | null; min_paired_months?: number; by_account: Record<string, { growth_pct: number; basis: string; paired_months: number; account_name: string | null }> }

type PresView = 'ejercicios' | 'gasto-op' | 'ventas' | 'flujo' | 'campanas' | 'capacidad' | 'gastos';

/**
 * Fase PU — Presupuestos (ADR-066). Surface Operations (quiet-luxury, answer-first). Tres vistas:
 *  - Ejercicios: el sistema de presupuestos (PU.1-2) — KPIs vs real + tabla de partidas (ledger de 5 estados).
 *  - Capacidad de pago + Gastos autorizados: el alimentador del Calendario de Pagos (Fase TP).
 * «Sin datos» ≠ cero: el real del ODS, si no hay, se DECLARA (no se dibuja 0).
 */
@Component({
  selector: 'app-finanzas-presupuesto',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, InputTextModule, SelectModule, DialogModule,
    CheckboxModule, TagModule, ToastModule, SegmentedComponent, MetricStripComponent, FreshnessPillComponent, SucursalPipe,
  ],
  providers: [MessageService],
  template: `
    <div class="surf-page in pres-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Presupuesto</h1>
          <p class="surf-page-sub">El sistema <strong>arma solo</strong> el presupuesto desde el ODS y Kepler — supuestos, plan y partidas. Tú <strong>autorizas</strong>. Alimenta el <strong>Calendario de pagos</strong> con la capacidad y las obligaciones.</p>
        </div>
        <div class="pres-nav">
          <app-segmented [options]="viewOptsArmar" [value]="view()" (valueChange)="setView($event)" ariaLabel="Armar el presupuesto" />
          <span class="pres-nav-sep">Programación de pagos</span>
          <app-segmented [options]="viewOptsPagos" [value]="view()" (valueChange)="setView($event)" ariaLabel="Programación de pagos" />
        </div>
      </header>

      <!-- ══════════ EJERCICIOS (sistema de presupuestos) ══════════ -->
      @if (view() === 'ejercicios') {
        <section class="pres-section">
          <div class="pres-section-head">
            <h2>Ejercicios</h2>
            <!-- [PU.VA] Acá estaba «Nuevo ejercicio» en PRIMARIO (relleno naranja, x=1887 y=220: la
                 posición más fuerte de la página), compitiendo con «Enviar a autorización», que es
                 la única acción que el subtítulo declara tuya. Dos primarios no jerarquizan nada.
                 Se mudó a la barra del ejercicio, en secundario, con las demás. -->
          </div>

          @if (budgets().length) {
            <div class="pres-budget-chips">
              @for (b of budgets(); track b.id) {
                <!-- [VE.5-A] El FOLIO adelante y el nombre despues: el folio se genera, el nombre
                     es texto libre que se teclea una vez y queda para siempre (de ahi salio
                     "presupesto"). Si el folio falta -- fila anterior a la migracion -- se declara
                     en vez de dejar un hueco mudo. -->
                <button type="button" class="pres-chip" [class.on]="selected()?.id === b.id" (click)="selectBudget(b)">
                  <span class="pres-mono">{{ b.folio || 'sin folio' }}</span>
                  <span class="pres-chip-name">{{ b.name }}</span>
                  <span class="pres-chip-yr pres-mono">{{ b.fiscal_year }}</span>
                  <p-tag [value]="b.status" [severity]="budgetSeverity(b.status)" styleClass="pres-tag" />
                </button>
              }
            </div>
          } @else if (loadingBudgets()) {
            <p class="pres-muted">Cargando ejercicios…</p>
          } @else {
            <!-- [VE.9] El vacio decia "Crear el primero" y contradecia a la cabecera de arriba:
                 si el sistema arma solo, no puede pedirte que lo crees. El ejercicio del ano
                 siguiente lo crea la pasada nocturna; el boton solo ADELANTA esa pasada. Crear uno
                 a mano queda como la excepcion (otro ano, otro escenario), no como el camino. -->
            <div class="pres-empty-block">
              <span class="pi pi-chart-pie pres-empty-ico"></span>
              <p>No hay ejercicios todavía. <strong>El sistema crea el del año siguiente solo</strong>, en la pasada de las 03:30, y lo arma con los supuestos derivados del ODS y de Kepler.</p>
              <div class="pres-detail-actions">
                <button pButton type="button" class="p-button-sm" (click)="runAutopilot()" [loading]="runningAutopilot()" title="Corre ahora la misma pasada del cron: crea el ejercicio del año siguiente si falta, deriva los supuestos y propone ventas, gastos y partidas"><span class="pi pi-bolt"></span>&nbsp;Armarlo ahora</button>
                <button pButton type="button" class="p-button-sm p-button-text" (click)="openNewBudget()" title="Para un año o escenario distinto del que arma el sistema"><span class="pi pi-plus"></span>&nbsp;Crear uno a mano</button>
              </div>
            </div>
          }

          @if (selected(); as b) {
            <div class="pres-detail-bar">
              <span class="pres-summary-title">{{ b.name }} · {{ b.fiscal_year }} · <span class="pres-muted">escenario {{ b.scenario }}</span> <p-tag [value]="b.status" [severity]="budgetSeverity(b.status)" styleClass="pres-tag" /></span>
              <div class="pres-detail-actions">
                @if (b.status === 'borrador' || b.status === 'en_revision') {
                  <!-- [VE.9] Adelanta la pasada nocturna sobre ESTE ejercicio. No reemplaza al
                       cron: lo que hace es no tener que esperar a manana para ver el efecto de un
                       cambio en los supuestos o en el catalogo. -->
                  <!-- [PU.VA] Re-armar es una HERRAMIENTA, no una decisión: adelanta el cron para
                       no esperar a mañana. Pasa a icono con tooltip, para que no compita con la
                       única acción que el subtítulo declara tuya. -->
                  <button pButton type="button" class="p-button-sm p-button-text pres-act-ico" (click)="runAutopilot()" [loading]="runningAutopilot()" aria-label="Re-armar ahora" title="Re-armar ahora — corre la pasada de la mañana sobre TODOS los ejercicios (no sólo éste): supuestos derivados + plan de ventas + plan de gastos + partidas. Respeta lo capturado a mano"><span class="pi pi-bolt"></span></button>
                  <button pButton type="button" class="p-button-sm" (click)="lifecycle(b, 'submit')" [loading]="savingLifecycle()">Enviar a autorización</button>
                }
                @if (b.status === 'pendiente') {
                  <button pButton type="button" class="p-button-sm" (click)="lifecycle(b, 'approve')" [loading]="savingLifecycle()">Aprobar</button>
                }
                @if (b.status === 'aprobado') {
                  <button pButton type="button" class="p-button-sm p-button-text" (click)="materializeNow(b)" [loading]="materializing()" title="Re-sincronizar las partidas desde los planes"><span class="pi pi-sync"></span>&nbsp;Re-materializar</button>
                  <button pButton type="button" class="p-button-sm p-button-text" (click)="lifecycle(b, 'close')" [loading]="savingLifecycle()">Cerrar</button>
                }
                <!-- [PU.VA] ⛔ Decía «Copiar del año anterior» y **no es lo que hace**: 'copyBudget'
                     clona el ejercicio SELECCIONADO, con el MISMO año fiscal por default
                     ('dto.fiscal_year ?? src.fiscal_year'). Sirve para armar un escenario
                     —conservador, expansión— sobre el base, que es algo que el piloto NO cubre.
                     El botón no sobraba: su rótulo mentía. -->
                <button pButton type="button" class="p-button-sm p-button-text" (click)="openCopy()" title="Duplica ESTE ejercicio como una versión nueva en borrador (para un escenario alterno). No copia del año anterior."><span class="pi pi-copy"></span>&nbsp;Duplicar como escenario</button>
                <!-- [PU.VA] «Nuevo ejercicio» baja de primario a secundario y se muda acá, con las
                     demás. Estaba arriba a la derecha —la posición más fuerte de la página— y en
                     naranja, compitiendo con la acción real; el propio '[VE.9]' lo llama «la
                     excepción, no el camino», porque el del año siguiente lo crea el piloto solo. -->
                <button pButton type="button" class="p-button-sm p-button-text" (click)="openNewBudget()" title="Para un año o escenario distinto del que arma el sistema. El del año siguiente lo crea solo, cada noche."><span class="pi pi-plus"></span>&nbsp;Nuevo ejercicio</button>
              </div>
            </div>

            <!-- [VE.7] Los supuestos DEJARON DE CAPTURARSE. Antes eran seis inputs y un boton
                 «Guardar»: el numero que gobierna todo el plan dependia de que alguien se
                 acordara, y el que estaba guardado (credito -29.4%) resulto ser una
                 reclasificacion de canal, no una caida. Ahora los calcula el sistema desde la
                 historia y se muestran. Si uno esta mal, se corrige LA FUENTE -- que es como se
                 arreglo ese -29.4%, normalizando el canal, no tecleando otro numero.
                 Lo que sigue siendo del humano es la POLITICA (que familias presupuestar, si se
                 abre por sucursal, que hace el control de sobregiro): eso no es un dato que la
                 historia pueda derivar, es una decision. -->
            <div class="pres-assump">
              <div class="pres-assump-head">
                <h3><span class="pi pi-sliders-h"></span> Supuestos del año <span class="pres-muted">— los calcula el sistema desde la historia; no se capturan</span></h3>
              </div>
              <div class="pres-assump-grid">
                <div class="pres-assump-col">
                  <h4>Ventas — crecimiento por canal (%)</h4>
                  @for (ch of channelsList; track ch) {
                    <div class="pres-assump-row">
                      <span>{{ channelLabels[ch] || ch }}</span>
                      @if (asVentasGrowth[ch] == null) {
                        <!-- [VE.7.1] Un canal sin historia propia usa el respaldo, y hay que
                             DECIRLO: mostrarlo igual que uno derivado es como Mayoreo exhibia
                             2.6% teniendo -8.4% de verdad. -->
                        <span class="pres-assump-val pres-muted pres-mono" title="Este canal no tiene par de años con que calcular su propio crecimiento; usa el respaldo"><span class="pres-assump-num">{{ asVentasDefault }} %</span><span class="pres-assump-suf">· respaldo</span></span>
                      } @else {
                        <span class="pres-assump-val"><strong class="pres-mono pres-assump-num">{{ asVentasGrowth[ch] }} %</strong><span class="pres-assump-suf"></span></span>
                      }
                    </div>
                  }
                  <!-- [PU.VA] Mismo markup que los canales: es otra cosa (un parámetro, no un canal),
                       pero vive en la misma lista, y una columna de números que se rompe en el último
                       renglón se lee como un error de dato. -->
                  <div class="pres-assump-row"><span class="pres-muted">Respaldo — para un canal sin par de años</span><span class="pres-assump-val"><strong class="pres-mono pres-assump-num">{{ asVentasDefault == null ? '—' : asVentasDefault + ' %' }}</strong><span class="pres-assump-suf"></span></span></div>
                </div>
                <div class="pres-assump-col">
                  <h4>Gastos</h4>
                  <!-- [PU.VA] El servicio DECLARA su base ('yoy_paired' = medido · 'default' = no se
                       pudo) y la pantalla leía sólo el número: un «0 %» de ausencia se veía igual que
                       un 0 % medido. Medido en prod: son 3 pares contra un mínimo de 4, porque el
                       egreso de familia 6 arranca en agosto de 2025. Ahora se dice, igual que el
                       «· respaldo» de la columna de ventas. VERDAD_ABSOLUTA §22.3. -->
                  <div class="pres-assump-row">
                    <span>Crecimiento (%)</span>
                    @if (asGastosDefault == null) {
                      <span class="pres-muted pres-mono">—</span>
                    } @else if (asGastosBasis !== 'yoy_paired') {
                      <span class="pres-muted pres-mono" [title]="asGastosMotivo">{{ asGastosDefault }} % · sin medir</span>
                    } @else {
                      <strong class="pres-mono" [title]="asGastosMotivo">{{ asGastosDefault }} %</strong>
                    }
                  </div>
                  <h4 class="pres-assump-sub">Política — esto sí lo decides tú</h4>
                  <label class="pres-assump-row"><span>Familias Kepler</span><input pInputText type="text" [(ngModel)]="asGastosFamilies" [disabled]="b.status !== 'borrador' && b.status !== 'en_revision'" class="pres-assump-in" placeholder="6" /></label>
                  <!-- [PU.VA] '.pres-assump-row' es 'space-between', así que el control y su texto
                       suelto se iban cada uno a un extremo: ~700 px de aire entre la casilla y lo
                       que dice. Envueltos en un mismo hijo, viajan juntos. -->
                  <label class="pres-assump-row"><span class="pres-assump-check"><p-checkbox [(ngModel)]="asGastosBySucursal" [binary]="true" [disabled]="b.status !== 'borrador' && b.status !== 'en_revision'" /> Presupuestar por sucursal</span></label>
                  <label class="pres-assump-row"><span>Control de sobregiro</span>
                    <select [(ngModel)]="asGastosControl" [disabled]="b.status !== 'borrador' && b.status !== 'en_revision'" class="pres-assump-in">
                      <option value="informativo">Informativo (no avisa)</option>
                      <option value="advertencia">Advertencia (avisa)</option>
                      <option value="bloqueo">Bloqueo (impide sobregirar)</option>
                    </select>
                  </label>
                  @if (b.status === 'borrador' || b.status === 'en_revision') {
                    <button pButton type="button" class="p-button-sm" (click)="saveAssumptions()" [loading]="savingAssump()">Guardar política</button>
                  }
                  <p class="pres-lbl-hint">6 = gasto operativo · 5 = compras · 7 = financieros · 1 = inversión. <strong>Bloqueo</strong> impide autorizar un gasto que exceda la partida.</p>
                </div>
              </div>
              <p class="pres-lbl-hint">El crecimiento sale de la historia (ventas año-contra-año del sell-out + egresos de Kepler) y se recalcula en la <strong>pasada nocturna</strong>, junto con el plan. <strong>Si un supuesto no cuadra, el arreglo es la fuente, no el número</strong>: el «−29.4 %» que mostraba Crédito era el canal reclasificándose, y se corrigió normalizando el catálogo.</p>
            </div>

            <!-- Answer-first: el resumen ejecutivo antes del grid (DESIGN §15) -->
            @if (summary(); as s) {
              <div class="pres-summary-head">
                @if (s.real.available && s.real.data_as_of) {
                  <app-freshness-pill measures="data" [freshness]="s.freshness" />
                } @else if (s.real.deferred) {
                  <button pButton type="button" class="p-button-sm p-button-text" (click)="loadSummaryReal()" [loading]="loadingSummaryReal()" title="Consulta el sell-out del ODS (unos segundos)"><span class="pi pi-refresh"></span>&nbsp;Cargar real vs presupuesto</button>
                } @else {
                  <span class="pres-nodata"><span class="pi pi-info-circle"></span> Real del ODS: {{ s.real.reason || 'sin datos' }}</span>
                }
              </div>
              <app-metric-strip [items]="kpiItems(s)" mode="strip" ariaLabel="Resumen ejecutivo del presupuesto" />
            }

            <p-table [value]="lines()" [loading]="loadingDetail()" styleClass="p-datatable-sm surf-table pres-table" [scrollable]="true">
              <ng-template #header>
                <tr>
                  <th>Partida</th><th>Tipo</th><th>Área</th>
                  <th class="ta-r">Vigente</th><th class="ta-r">Reservado</th><th class="ta-r">Comprometido</th>
                  <th class="ta-r">Ejercido</th><th class="ta-r">Disponible</th><th class="ta-r">Ocupación</th><th>Estado</th>
                  <th style="width:3rem"><span class="sr-only">Acciones</span></th>
                </tr>
              </ng-template>
              <ng-template #body let-l>
                <tr>
                  <td>{{ l.concept }}</td>
                  <td class="pres-muted">{{ tipoLabel(l.line_type) }}</td>
                  <td class="pres-muted" [title]="dimensionTitulo(l)">{{ dimension(l) }}</td>
                  <td class="ta-r pres-mono">{{ money(l.vigente_amount) }}</td>
                  <td class="ta-r pres-mono">{{ dash(l.reserved_amount) }}</td>
                  <td class="ta-r pres-mono">{{ dash(l.committed_amount) }}</td>
                  <td class="ta-r pres-mono">{{ dash(l.exercised_amount) }}</td>
                  <td class="ta-r pres-mono" [class.pres-neg]="l.available_amount < 0">{{ money(l.available_amount) }}</td>
                  <td class="ta-r pres-mono">{{ ocupacion(l) }}</td>
                  <td><p-tag [value]="l.status" [severity]="l.status === 'activa' ? 'info' : 'secondary'" styleClass="pres-tag" /></td>
                  <td>@if (b.status === 'aprobado' && l.status === 'activa') { <button pButton type="button" class="p-button-sm p-button-text" (click)="openMovement(l)" title="Movimiento" aria-label="Movimiento de partida"><span class="pi pi-bolt"></span></button> }</td>
                </tr>
              </ng-template>
              <!-- [VE.5] El texto decia "al aprobar" y quedo viejo: materialize acepta borrador y
                   revision, y desde [VE.3] el piloto lo corre cada noche. Decir "al aprobar" hace
                   que una tabla vacia parezca normal cuando en realidad el automatico no corrio. -->
              <!-- [PU.VA] Dejó de CONJETURAR. El texto anterior ofrecía una hipótesis («la pasada
                   no corrió») mientras 'analytics.cron_runs' tenía el veredicto escrito: el
                   2026-10-07 en prod, 'budget_autopilot' estaba en **error** con la causa probable
                   («¿contexto de tenant / RLS?») y 'generation_runs' en cero. Ahora se pregunta. -->
              <ng-template #emptymessage><tr><td colspan="11" class="pres-empty">
                <!-- [PU.V7] Decia solo "en la pasada nocturna" y mandaba a esperar hasta manana a
                     quien acababa de crear un ejercicio. El boton de rayo de arriba corre la MISMA
                     pasada ahora mismo; omitirlo convertia un clic en un dia de espera. -->
                Sin partidas todavía. Las partidas se <strong>materializan solas</strong> de los planes (Ventas + Gastos) — no se capturan a mano.
                Si acabás de crear este ejercicio, dale al botón <span class="pi pi-bolt"></span> <strong>Re-armar ahora</strong> de arriba y las arma en el momento; si no, entran solas en la pasada de la mañana.
                @if (autopilot(); as a) {
                  @if (a.status === 'error') {
                    <div class="pres-empty-diag bad"><span class="pi pi-times-circle"></span> La pasada <strong>falló</strong>{{ a.last_start ? ' (' + (a.last_start | date:'dd/MM HH:mm') + ')' : '' }}: {{ a.error || 'sin detalle' }}</div>
                  } @else if (a.nunca_completo) {
                    <div class="pres-empty-diag bad"><span class="pi pi-exclamation-triangle"></span> La pasada <strong>nunca completó</strong>: no hay ni un registro en el historial de generaciones.</div>
                  } @else if (a.status == null) {
                    <div class="pres-empty-diag"><span class="pi pi-question-circle"></span> La pasada <strong>no reporta latido</strong> — no se puede saber si corrió.</div>
                  } @else {
                    <div class="pres-empty-diag"><span class="pi pi-info-circle"></span> Última pasada: <strong>{{ a.status }}</strong>{{ a.last_finish ? ' · ' + (a.last_finish | date:'dd/MM HH:mm') : '' }} · {{ a.pasadas_completadas }} completada(s).</div>
                  }
                }
              </td></tr></ng-template>
            </p-table>
            <p class="pres-hint"><span class="pi pi-info-circle"></span> Las partidas son un <strong>derivado del plan</strong> (ingreso = plan de ventas · gasto = plan de gastos). Se materializan <strong>solas cada noche</strong> mientras el ejercicio esté en borrador o revisión, y otra vez al aprobar. Los movimientos (reservar / comprometer / ejercer / pagar) se habilitan con el ejercicio <strong>aprobado</strong>.</p>
          }
        </section>
      }

      <!-- ══════════ GASTO OPERATIVO (PU.7) ══════════ -->
      @if (view() === 'gasto-op') {
        <section class="pres-section">
          @if (selected(); as b) {
            <div class="pres-section-head">
              <h2>Gastos · <span class="pres-muted">{{ b.name }} {{ b.fiscal_year }}</span></h2>
              @if (b.status === 'borrador' || b.status === 'en_revision') {
                <button pButton type="button" class="p-button-sm" (click)="runProposeExpense()" [loading]="savingExpensePropose()" title="Arma los gastos con los supuestos del año"><span class="pi pi-bolt"></span>&nbsp;Proponer gastos del año</button>
              }
            </div>
            <app-metric-strip [items]="gastoKpis()" mode="strip" ariaLabel="Resumen de gasto operativo" />
            <p-table [value]="gastoLines()" [loading]="loadingDetail()" styleClass="p-datatable-sm surf-table pres-table" [scrollable]="true">
              <ng-template #header>
                <tr>
                  <th>Concepto</th><th>Área / CC</th><th>Responsable</th><th>Clase</th><th>Recurrencia</th>
                  <th class="ta-r">Vigente</th><th class="ta-r">Comprometido</th><th class="ta-r">Ejercido</th><th class="ta-r">Disponible</th><th class="ta-r">Ocupación</th>
                  <th style="width:3rem"><span class="sr-only">Acciones</span></th>
                </tr>
              </ng-template>
              <ng-template #body let-l>
                <tr>
                  <td>{{ l.concept }}</td>
                  <td class="pres-muted" [title]="dimensionTitulo(l)">{{ dimension(l) }}</td>
                  <td class="pres-muted">{{ l.responsible || '—' }}</td>
                  <td>{{ classLabel(l.expense_class) }}</td>
                  <td class="pres-muted">{{ recurrenceLabel(l.recurrence) }}</td>
                  <td class="ta-r pres-mono">{{ money(l.vigente_amount) }}</td>
                  <td class="ta-r pres-mono">{{ dash(l.committed_amount) }}</td>
                  <td class="ta-r pres-mono">{{ dash(l.exercised_amount) }}</td>
                  <td class="ta-r pres-mono" [class.pres-neg]="l.available_amount < 0">{{ money(l.available_amount) }}</td>
                  <td class="ta-r pres-mono">{{ ocupacion(l) }}</td>
                  <td>@if (b.status === 'aprobado' && l.status === 'activa') { <button pButton type="button" class="p-button-sm p-button-text" (click)="openMovement(l)" title="Movimiento" aria-label="Movimiento de partida"><span class="pi pi-bolt"></span></button> }</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="11" class="pres-empty">Sin partidas de gasto todavía. Se materializan del <strong>presupuesto propuesto</strong> (abajo) al aprobar el ejercicio.</td></tr></ng-template>
            </p-table>
            <p class="pres-hint"><span class="pi pi-info-circle"></span> Control antes de comprometer: el disponible manda. Reservar/comprometer más que el disponible se <strong>bloquea</strong> (o avisa) según el control de cada partida. Los movimientos se operan con el ejercicio <strong>aprobado</strong>.</p>

            <!-- ── Presupuesto de gastos PROPUESTO (automático desde egresos de Kepler · PVG) ── -->
            <div class="pres-section-head" style="margin-top:1.4rem">
              <h3 style="margin:0;font-size:1rem">Presupuesto propuesto <span class="pres-muted">· automático desde egresos de Kepler</span></h3>
            </div>
            @if (lastExpenseCoverage(); as cov) {
              <p class="pres-hint"><span class="pi pi-check-circle"></span> Última propuesta: <strong>{{ cov.accounts }}</strong> cuentas · <strong>{{ cov.historico_ajustado }}</strong> por base histórica · <strong>{{ cov.estacional }}</strong> por recurrencia · <strong>{{ cov.no_signal }}</strong> sin señal (no se inventan) · <strong>{{ cov.manual_kept }}</strong> a mano.</p>
            }
            <p-table [value]="expenseByAccount()" [loading]="loadingExpense()" styleClass="p-datatable-sm surf-table pres-table" [scrollable]="true">
              <ng-template #header>
                <tr><th>Cuenta mayor</th><th>Familia</th><th>Sucursal</th><th>Origen</th><th class="ta-r">Meses</th><th class="ta-r">Presupuesto anual</th></tr>
              </ng-template>
              <ng-template #body let-r>
                <tr>
                  <td>{{ r.account_code }} · <span class="pres-muted">{{ r.account_name }}</span></td>
                  <td class="pres-muted">{{ r.familia || '—' }}</td>
                  <td class="pres-muted">{{ (r.sucursal | sucursal) || 'Consolidado' }}</td>
                  <td>{{ r.method }}</td>
                  <td class="ta-r pres-mono">{{ r.months }}</td>
                  <td class="ta-r pres-mono">{{ money(r.anual) }}</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="6" class="pres-empty">Sin presupuesto de gastos propuesto. @if (b.status === 'borrador' || b.status === 'en_revision') { Usá «Proponer gastos del año» para armarlo desde los egresos de Kepler. }</td></tr></ng-template>
            </p-table>
            @if (expenseByAccount().length) {
              <p class="pres-hint"><span class="pi pi-calculator"></span> Total propuesto (año): <strong class="pres-mono">{{ money(expenseTotal()) }}</strong> · grano <strong>cuenta mayor × mes</strong> (base del año anterior × crecimiento; relleno por recurrencia). Al <strong>aprobar</strong> el ejercicio, esta propuesta se materializa en las partidas del libro de 5 estados (arriba).</p>
            }
          } @else {
            <p class="pres-muted">Elegí un ejercicio en la pestaña «Ejercicios» para ver y capturar sus gastos operativos.</p>
          }
        </section>
      }

      <!-- ══════════ PRESUPUESTO DE VENTAS (PV) ══════════ -->
      @if (view() === 'ventas') {
        <section class="pres-section">
          @if (selected(); as b) {
            <div class="pres-section-head">
              <h2>Presupuesto de ventas · <span class="pres-muted">{{ b.name }} {{ b.fiscal_year }}</span></h2>
              <div class="pres-detail-actions">
                <app-segmented [options]="salesTabOpts" [value]="salesTab()" (valueChange)="setSalesTab($any($event))" ariaLabel="Vista de ventas" />
                @if (b.status === 'borrador' || b.status === 'en_revision') {
                  <button pButton type="button" class="p-button-sm" (click)="runProposePlan()" [loading]="savingPropose()" title="Arma el plan con los supuestos del año (Ejercicio)"><span class="pi pi-bolt"></span>&nbsp;Proponer plan del año</button>
                }
                <button pButton type="button" class="p-button-sm p-button-text" (click)="loadSalesComparison()" [loading]="loadingSales()" title="Consulta el sell-out del ODS (unos segundos)"><span class="pi pi-refresh"></span>&nbsp;{{ salesCmp() ? 'Actualizar real' : 'Cargar meta vs real' }}</button>
                <button pButton type="button" class="p-button-sm p-button-text" (click)="projectTargets()" [loading]="projecting()" title="Reparte la meta del plan (13×4) a metas mensuales del «vs objetivo» del sub-módulo Análisis (reparto por días)."><span class="pi pi-share-alt"></span>&nbsp;Proyectar a Análisis</button>
              </div>
            </div>

            <!-- ── PLAN (pivote meta vs real) ── -->
            @if (salesTab() === 'plan') {
              @if (salesCmp(); as c) {
                <div class="pres-summary-head">
                  @if (c.real_available && c.data_as_of) {
                    <app-freshness-pill measures="data" [freshness]="c.freshness" />
                  } @else {
                    <span class="pres-nodata"><span class="pi pi-info-circle"></span> Real del ODS: sin datos</span>
                  }
                  <span class="pres-muted">CREC = crecimiento vs {{ c.prior_year }}</span>
                  @if (c.coverage?.measured && c.coverage?.pct != null) {
                    <span class="pres-muted" [title]="c.coverage.note">Cobertura real: {{ c.coverage.pct }}%</span>
                  }
                </div>
                <app-metric-strip [items]="salesKpis(c)" mode="strip" ariaLabel="Resumen del presupuesto de ventas" />
                <!-- [PU.V6] El total cubre PARTE del año y eso se dice acá, no en un tooltip. El
                     motor hace bien en no inventar los periodos sin base; lo que estaba mal era
                     que el aviso viviera en la columna method -que el encabezado no suma- y el
                     $0 en el campo que si suma. Dice ademas CUANTO falta, porque "incompleto" no
                     deja decidir y "faltan ~$166M" si. -->
                @if (c.periodos && !c.periodos.completo) {
                  <p class="pres-warn">
                    <span class="pi pi-exclamation-triangle"></span>
                    <span>{{ c.periodos.nota }}</span>
                  </p>
                }
                @if (lastCoverage(); as cov) {
                  @if (covEnDinero(cov); as cm) {
                    <p class="pres-hint"><span class="pi pi-check-circle"></span> Última propuesta, <strong>en dinero</strong>:
                      {{ money(cm.historico_ajustado) }} de base real ({{ cov.historico_ajustado }} celdas) ·
                      {{ money(cm.estacional) }} por estacionalidad ({{ cov.estacional }}) ·
                      {{ money(cm.proxy_canal) }} proxy de canal ({{ cov.proxy_canal }}) ·
                      <strong>{{ cov.sin_base_declarado }}</strong> celdas sin base, declaradas (—, no $0) ·
                      {{ cov.manual_kept }} a mano.
                    </p>
                    @if (proxyAviso(cov); as av) {
                      <p class="pres-warn"><span class="pi pi-exclamation-triangle"></span> <span>{{ av }}</span></p>
                    }
                  } @else {
                    <p class="pres-hint"><span class="pi pi-check-circle"></span> Última propuesta: <strong>{{ cov.historico_ajustado }}</strong> de base real · <strong>{{ cov.estacional }}</strong> por estacionalidad · <strong>{{ cov.proxy_canal }}</strong> proxy de canal · <strong>{{ cov.sin_base_declarado }}</strong> sin base (declaradas, no en 0) · <strong>{{ cov.no_signal }}</strong> sin señal · <strong>{{ cov.manual_kept }}</strong> a mano.</p>
                    <p class="pres-hint pres-nodata"><span class="pi pi-info-circle"></span> <strong>Cuánto DINERO representa cada origen: no medido.</strong> Esta API todavía no publica el desglose por monto. El conteo de celdas no lo dice: un cuarto de las celdas puede ser un cuarto de la meta o la mitad.</p>
                  }
                }
                <div class="pres-detail-actions" style="margin:.6rem 0 .2rem">
                  <label class="pres-muted">Periodo (13×4):</label>
                  <p-select [options]="periodOpts" [(ngModel)]="salesPeriod" optionLabel="label" optionValue="value" placeholder="Todos" styleClass="pres-inline-select" />
                </div>
                <p-table [value]="salesRows()" [loading]="loadingSales()" styleClass="p-datatable-sm surf-table pres-table" [scrollable]="true">
                  <ng-template #header>
                    <tr>
                      <th>Entidad</th><th>Canal</th><th>Origen</th>
                      <th class="ta-r">Meta</th><th class="ta-r">Real</th><th class="ta-r">Cumpl.</th>
                      <th class="ta-r">CREC</th><th class="ta-r">PART</th>
                      <th style="width:3rem"><span class="sr-only">Acciones</span></th>
                    </tr>
                  </ng-template>
                  <ng-template #body let-r>
                    <tr [class.pres-rollup]="r.is_rollup">
                      <td>{{ r.label }}</td>
                      <td class="pres-muted">{{ r.channel_label }}</td>
                      <td>@if (!r.is_rollup && r.method) { <span class="ec-src ec-src-{{ r.method }}">{{ methodLabel(r.method) }}</span> }</td>
                      <td class="ta-r pres-mono">{{ r.meta == null ? '—' : money(r.meta) }}</td>
                      <td class="ta-r pres-mono">{{ r.real == null ? '—' : money(r.real) }}</td>
                      <td class="ta-r pres-mono">{{ r.cumplimiento_pct == null ? '—' : r.cumplimiento_pct + '%' }}</td>
                      <td class="ta-r pres-mono" [class.pres-neg]="r.crec_pct != null && r.crec_pct < 0">{{ r.crec_pct == null ? '—' : r.crec_pct + '%' }}</td>
                      <td class="ta-r pres-mono">{{ r.part_pct == null ? '—' : r.part_pct + '%' }}</td>
                      <td></td>
                    </tr>
                  </ng-template>
                  <ng-template #emptymessage><tr><td colspan="9" class="pres-empty">Sin plan de ventas todavía. @if (b.status === 'borrador' || b.status === 'en_revision') { Usá «Proponer plan del año» para que el sistema lo arme desde la historia. }</td></tr></ng-template>
                </p-table>
                <p class="pres-hint"><span class="pi pi-info-circle"></span> <strong>Meta</strong> = plan. <strong>Origen</strong>: Histórico (real año anterior × crecimiento) · Estacional (participación + estacionalidad) · Proxy canal (entidad nueva, estimada desde su canal) · Sin base (ni entidad ni canal con señal → declarada en 0, no ausente) · Manual. <strong>Real</strong> = sell-out del ODS por el calendario 13×4. «Sin datos» ≠ cero (—).</p>
              } @else if (loadingSales()) {
                <p class="pres-muted">Cargando presupuesto de ventas…</p>
              } @else {
                <p class="pres-hint"><span class="pi pi-info-circle"></span> El «meta vs real» consulta el sell-out del ODS (unos segundos). Pulsá <strong>«Cargar meta vs real»</strong> para verlo. La propuesta del plan no lo necesita.</p>
              }
            }

            <!-- ── INDICADORES (CREC/PART histórico + meta-vs-real) ── -->
            @if (salesTab() === 'indicadores') {
              @if (indicators(); as ind) {
                <div class="pres-summary-head">
                  @if (ind.real_available && ind.data_as_of) {
                    <app-freshness-pill measures="data" [freshness]="ind.freshness" />
                  } @else {
                    <span class="pres-nodata"><span class="pi pi-info-circle"></span> Real del ODS: sin datos</span>
                  }
                  <span class="pres-muted">Años con historia: {{ ind.years_available.join(', ') }} · CREC vs {{ ind.prior_year }}</span>
                </div>
                <p-table [value]="ind.by_channel" styleClass="p-datatable-sm surf-table pres-table" [scrollable]="true">
                  <ng-template #header>
                    <tr>
                      <th>Canal</th>
                      <th class="ta-r">Real {{ ind.budget.fiscal_year }}</th><th class="ta-r">CREC</th><th class="ta-r">PART</th>
                      <th class="ta-r">Meta</th><th class="ta-r">Cumpl.</th>
                    </tr>
                  </ng-template>
                  <ng-template #body let-r>
                    <tr>
                      <td>{{ r.channel_label }}</td>
                      <td class="ta-r pres-mono">{{ r.current.real == null ? '—' : money(r.current.real) }}</td>
                      <td class="ta-r pres-mono" [class.pres-neg]="r.current.crec_pct != null && r.current.crec_pct < 0">{{ r.current.crec_pct == null ? '—' : r.current.crec_pct + '%' }}</td>
                      <td class="ta-r pres-mono">{{ indPart(r) }}</td>
                      <td class="ta-r pres-mono">{{ r.current.meta == null ? '—' : money(r.current.meta) }}</td>
                      <td class="ta-r pres-mono">{{ r.current.cumplimiento_pct == null ? '—' : r.current.cumplimiento_pct + '%' }}</td>
                    </tr>
                  </ng-template>
                  <ng-template #footer>
                    <tr class="pres-rollup">
                      <td>Total Venta</td>
                      <td class="ta-r pres-mono">{{ ind.company.current.real == null ? '—' : money(ind.company.current.real) }}</td>
                      <td class="ta-r pres-mono">{{ ind.company.current.crec_pct == null ? '—' : ind.company.current.crec_pct + '%' }}</td>
                      <td class="ta-r pres-mono">100%</td>
                      <td class="ta-r pres-mono">{{ ind.company.current.meta == null ? '—' : money(ind.company.current.meta) }}</td>
                      <td class="ta-r pres-mono">{{ ind.company.current.cumplimiento_pct == null ? '—' : ind.company.current.cumplimiento_pct + '%' }}</td>
                    </tr>
                  </ng-template>
                </p-table>
                <p class="pres-hint"><span class="pi pi-info-circle"></span> Bloques de consolidación del reporte (CREC = crecimiento año vs año · PART = participación en el total), directo del sell-out del ODS. Reemplaza el seguimiento manual del Excel.</p>
              } @else if (loadingIndicators()) {
                <p class="pres-muted">Cargando indicadores…</p>
              }
            }

            <!-- ── CONCILIACIÓN (documentada) sell-out ↔ facturación contable 401 ── -->
            @if (salesTab() === 'conciliacion') {
              @if (reconciliation(); as rec) {
                @if (rec.freshness) { <div class="pres-summary-head"><app-freshness-pill measures="data" [freshness]="rec.freshness" /><span class="pres-muted">Conciliación documental — el real del presupuesto sigue siendo el sell-out</span></div> }
                <p-table [value]="rec.annual" styleClass="p-datatable-sm surf-table pres-table" [scrollable]="true">
                  <ng-template #header>
                    <tr><th>Año</th><th>Canal</th><th class="ta-r">Sell-out</th><th class="ta-r">Facturación (401)</th><th class="ta-r">Δ</th><th class="ta-r">401/sell-out</th><th>Estado</th></tr>
                  </ng-template>
                  <ng-template #body let-r>
                    <tr>
                      <td class="pres-mono">{{ r.year }}</td>
                      <td class="pres-muted">{{ r.channel_label }}</td>
                      <td class="ta-r pres-mono">{{ money(r.sell_out) }}</td>
                      <td class="ta-r pres-mono">{{ money(r.facturacion) }}</td>
                      <td class="ta-r pres-mono" [class.pres-neg]="r.delta < 0">{{ money(r.delta) }}</td>
                      <td class="ta-r pres-mono">{{ r.ratio_pct == null ? '—' : r.ratio_pct + '%' }}</td>
                      <td><span class="ec-src ec-src-recon-{{ r.status }}">{{ statusLabel(r.status) }}</span></td>
                    </tr>
                  </ng-template>
                  <ng-template #emptymessage><tr><td colspan="7" class="pres-empty">Sin datos de conciliación.</td></tr></ng-template>
                </p-table>
                <div class="pres-recon-notes">
                  @for (n of rec.notes; track n) { <p class="pres-hint"><span class="pi pi-info-circle"></span> {{ n }}</p> }
                </div>
              } @else if (loadingReconciliation()) {
                <p class="pres-muted">Cargando conciliación…</p>
              }
            }
          } @else {
            <p class="pres-muted">Elegí un ejercicio en la pestaña «Ejercicios» para ver su presupuesto de ventas.</p>
          }
        </section>
      }

      <!-- ══════════ FLUJO / RESULTADO (PU.3 + PR.4) ══════════ -->
      @if (view() === 'flujo') {
        <section class="pres-section">
          <!-- [PU.R] Estado de resultados: PLAN contra REAL, renglon por renglon.
               Lo anterior era ingresos menos egresos, sin costo de ventas, y publicaba 100% de
               margen sobre el ejercicio real. Ahora cada celda declara cuando no hay con que. -->
          @if (selected()) {
            <h2>Estado de resultados <span class="pres-muted">— plan contra real, renglón por renglón</span></h2>
            @if (resultado(); as res) {
              <div class="pres-summary-head"><app-freshness-pill measures="data" [freshness]="res.freshness" /></div>

              <!-- La cascada anual. El orden de los renglones ES la lectura del P&L. -->
              <table class="pres-pnl">
                <tr><th class="pres-pnl-rgl">Renglón</th><th class="ta-r">Plan</th><th class="ta-r">Real</th><th class="ta-r">Cumplimiento</th></tr>
                @for (r of pnlRenglones; track r.key) {
                  <tr [class.pres-pnl-fuerte]="r.fuerte">
                    <td class="pres-pnl-rgl">{{ r.resta ? '−' : '' }} {{ r.label }}</td>
                    <td class="ta-r pres-mono">{{ celda(cel(res.annual, r.key), 'plan') }}</td>
                    <td class="ta-r pres-mono"
                        [class.pres-neg]="(cel(res.annual, r.key).real ?? 0) < 0">{{ celda(cel(res.annual, r.key), 'real') }}</td>
                    <td class="ta-r pres-mono pres-muted">
                      @if (r.key === 'venta' && res.annual.venta.plan && res.annual.venta.real) {
                        {{ pctOf(res.annual.venta.real, res.annual.venta.plan) }}%
                      } @else { — }
                    </td>
                  </tr>
                }
                <tr>
                  <td class="pres-pnl-rgl pres-muted">Margen bruto %</td>
                  <td class="ta-r pres-mono pres-muted">{{ res.annual.margen_bruto_pct.plan == null ? '—' : res.annual.margen_bruto_pct.plan + '%' }}</td>
                  <td class="ta-r pres-mono pres-muted">{{ res.annual.margen_bruto_pct.real == null ? '—' : res.annual.margen_bruto_pct.real + '%' }}</td>
                  <td></td>
                </tr>
              </table>

              <!-- Al lado y NUNCA sumado: sumarlo al gasto lo multiplica por nueve. -->
              <p class="pres-hint">
                <span class="pi pi-info-circle"></span>
                Fuera del resultado, porque es <strong>flujo</strong> y no gasto del periodo:
                compra de inventario <strong class="pres-mono">{{ dash(res.annual.compra_inventario) }}</strong>
                · inversión <strong class="pres-mono">{{ dash(res.annual.inversion) }}</strong>.
              </p>

              <!-- Lo que no se puede medir, con su razon. No es decoracion: hoy es el mensaje. -->
              @for (s of res.sources; track s.key) {
                @if (!s.available) {
                  <p class="pres-nodata"><span class="pi pi-info-circle"></span> <strong>{{ s.label }}:</strong> {{ s.reason }}</p>
                }
              }

              <!-- El arbitro (ADR-059). Un renglon que nadie contrasta es una afirmacion sola. -->
              @for (a of res.arbitros; track a.renglon) {
                <p class="pres-hint">
                  <span class="pi" [class.pi-check-circle]="a.veredicto === 'cuadra'"
                        [class.pi-exclamation-triangle]="a.veredicto === 'difiere'"
                        [class.pi-info-circle]="a.veredicto === 'no_comparable' || a.veredicto === 'no_medido'"></span>
                  <strong>{{ a.renglon }}</strong> contra {{ a.fuente_arbitro }}:
                  @if (a.veredicto === 'no_comparable') { <em>no comparable</em>. }
                  @else if (a.veredicto === 'no_medido') { <em>no medido</em>. }
                  @else { {{ money(a.mio) }} contra {{ money(a.arbitro) }} — Δ {{ money(a.delta) }} ({{ a.delta_pct }}%). }
                  {{ a.nota }}
                </p>
              }

              <!-- [VE.1] Los huecos: el backend los arma desde PU.R y la pantalla NO los mostraba,
                   asi que lo que esta pantalla no puede medir no se veia en ningun lado. Un hueco
                   con nombre y monto es el mensaje, no una nota al pie (ADR-056). -->
              @for (h of res.huecos; track h.key) {
                <p class="pres-nodata">
                  <span class="pi pi-flag"></span>
                  <strong>{{ h.label }}</strong>
                  @if (h.monto !== null) { — <span class="pres-mono">{{ money(h.monto) }}</span>. }
                  @else { — <em>monto no medido</em>. }
                  {{ h.nota }}
                </p>
              }

              <p-table [value]="res.months" styleClass="p-datatable-sm surf-table pres-table">
                <ng-template #header>
                  <tr>
                    <th>Mes</th>
                    <th class="ta-r">Venta plan</th><th class="ta-r">Venta real</th><th class="ta-r">Cumpl.</th>
                    <th class="ta-r">Costo</th><th class="ta-r">Margen</th>
                    <th class="ta-r">Gasto op.</th><th class="ta-r">Resultado</th>
                    <th class="ta-r">Compra inv.</th>
                  </tr>
                </ng-template>
                <ng-template #body let-m>
                  <tr>
                    <td class="pres-mono">{{ m.year_month }}</td>
                    <td class="ta-r pres-mono">{{ celda(m.venta, 'plan') }}</td>
                    <td class="ta-r pres-mono">{{ celda(m.venta, 'real') }}</td>
                    <td class="ta-r pres-mono pres-muted">{{ m.cumplimiento_venta_pct == null ? '—' : m.cumplimiento_venta_pct + '%' }}</td>
                    <td class="ta-r pres-mono">{{ celda(m.costo_ventas, 'real') }}</td>
                    <td class="ta-r pres-mono">{{ celda(m.margen_bruto, 'real') }}</td>
                    <td class="ta-r pres-mono">{{ celda(m.gasto_operativo, 'real') }}</td>
                    <td class="ta-r pres-mono" [class.pres-neg]="(m.resultado.real ?? 0) < 0">{{ celda(m.resultado, 'real') }}</td>
                    <td class="ta-r pres-mono pres-muted">{{ dash(m.fuera_del_resultado.compra_inventario) }}</td>
                  </tr>
                </ng-template>
              </p-table>
            } @else if (loadingResultado()) {
              <p class="pres-muted">Calculando resultado…</p>
            }
          } @else {
            <p class="pres-muted">Elegí un ejercicio en «Ejercicio» para ver su resultado presupuestado.</p>
          }

          <div class="pres-section-head" style="margin-top:1.4rem">
            <h2>Flujo de caja previsto</h2>
            <div class="pres-cf-period">
              <input type="date" [(ngModel)]="cfFrom" class="pres-date" aria-label="Desde" />
              <input type="date" [(ngModel)]="cfTo" class="pres-date" aria-label="Hasta" />
              <button pButton type="button" class="p-button-sm" (click)="loadCashflow()" [loading]="loadingCashflow()">Actualizar</button>
            </div>
          </div>

          @if (cashflow(); as cf) {
            @if (cf.sources.cobros.as_of) {
              <div class="pres-summary-head"><app-freshness-pill measures="data" [freshness]="cf.freshness" /></div>
            }
            <app-metric-strip [items]="cashflowKpis(cf)" mode="strip" ariaLabel="Resumen de flujo de efectivo" />

            @if (!cf.opening_balance.available) {
              <p class="pres-nodata"><span class="pi pi-info-circle"></span> Sin saldo inicial de bancos ({{ cf.opening_balance.reason || 'Fase CB' }}): el saldo proyectado y la alerta de insuficiencia se declaran (—). El neto por semana sí es real.</p>
            } @else if (cf.alerts.length) {
              <div class="pres-alert"><span class="pi pi-exclamation-triangle"></span> {{ cf.alerts.length }} semana(s) con posible falta de liquidez (saldo proyectado &lt; 0).</div>
            }

            <!-- [CXC.22] La curva agenda por fecha de vencimiento. Con la cartera 89.7% vencida,
                 publicarla muda se lee como "esto es toda la cobranza que viene". -->
            @if (cf.cobranza_cobertura; as cc) {
              @if (cc.vencido_fuera > 0) {
                <p class="pres-nodata">
                  <span class="pi pi-info-circle"></span>
                  Esta curva dibuja
                  <strong>{{ cc.pct_en_ventana != null ? cc.pct_en_ventana + '%' : 'una parte' }}</strong>
                  de la cartera cobrable ({{ money(cc.en_ventana) }} de {{ money(cc.total) }}).
                  Quedan fuera <strong>{{ money(cc.vencido_fuera) }}</strong> que <b>ya vencieron</b>:
                  son exigibles hoy y no tienen fecha comprometida, así que no se pueden agendar
                  en una semana sin inventarles una.
                </p>
              }
            }

            <!-- [TES.2] El mismo aviso del lado del PAGO. Sin él la pantalla publica la curva de
                 pagos sin decir que ve una fracción — que es el defecto que [CXC.22] corrigió
                 arriba, y acá era peor: hasta hoy la fracción era CERO. -->
            @if (cf.deuda_erp?.cobertura; as dc) {
              @if (dc.vencido_fuera > 0) {
                <p class="pres-nodata">
                  <span class="pi pi-info-circle"></span>
                  Del lado del <b>pago</b> dibuja
                  <strong>{{ dc.pct_en_ventana != null ? dc.pct_en_ventana + '%' : 'una parte' }}</strong>
                  de la deuda con proveedor ({{ money(dc.en_ventana) }} de {{ money(dc.total) }}).
                  Quedan fuera <strong>{{ money(dc.vencido_fuera) }}</strong> que <b>ya vencieron</b>:
                  exigibles sin fecha comprometida, por la misma razón que la cobranza.
                  @if (dc.interno_excluido > 0) {
                    No se cuentan {{ money(dc.interno_excluido) }} de traspasos entre sucursales,
                    que no son deuda con terceros.
                  }
                </p>
              }
            }

            <!-- [TES.3] Las filas de fecha imposible se EXCLUYEN del saldo y de la frescura, y se
                 declaran acá: son del dominio de contabilidad, no se borran. -->
            @if (cf.opening_balance?.anomalias; as an) {
              <p class="pres-nodata">
                <span class="pi pi-exclamation-triangle"></span>
                {{ an.filas }} movimientos bancarios con fecha imposible
                ({{ an.futuras }} en el futuro, {{ an.absurdas }} anteriores a 2015) quedan
                <b>fuera del saldo y de la frescura</b>. No se borran: hay que reclasificarlos.
              </p>
            }

            <p-table [value]="cf.buckets" styleClass="p-datatable-sm surf-table pres-table">
              <ng-template #header>
                <tr><th>Semana</th><th class="ta-r">Cobros</th><th class="ta-r">Pagos</th><th class="ta-r">Neto</th><th class="ta-r">Neto acum.</th><th class="ta-r">Saldo proyectado</th></tr>
              </ng-template>
              <ng-template #body let-w>
                <tr>
                  <td class="pres-mono">{{ w.week }}</td>
                  <td class="ta-r pres-mono">{{ dash(w.cobros) }}</td>
                  <td class="ta-r pres-mono">{{ dash(w.pagos) }}</td>
                  <td class="ta-r pres-mono" [class.pres-neg]="w.neto < 0">{{ money(w.neto) }}</td>
                  <td class="ta-r pres-mono" [class.pres-neg]="w.neto_acumulado < 0">{{ money(w.neto_acumulado) }}</td>
                  <td class="ta-r pres-mono" [class.pres-neg]="w.saldo_proyectado != null && w.saldo_proyectado < 0">{{ w.saldo_proyectado == null ? '—' : money(w.saldo_proyectado) }}</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="6" class="pres-empty">Sin cobros ni pagos previstos en el periodo.</td></tr></ng-template>
            </p-table>
            <p class="pres-hint"><span class="pi pi-info-circle"></span> Cobros: cartera por vencimiento. Pagos: obligaciones pendientes (Presupuestos + Compras + Finanzas). Liquidez a nivel empresa, no por ejercicio.</p>
          } @else if (loadingCashflow()) {
            <p class="pres-muted">Cargando flujo…</p>
          } @else {
            <p class="pres-hint"><span class="pi pi-info-circle"></span> El flujo de caja consulta la cartera CXC en vivo (unos segundos). Pulsá <strong>«Actualizar»</strong> para calcularlo.</p>
          }
        </section>
      }

      <!-- ══════════ CAMPAÑAS / MARKETING (PU.5) ══════════ -->
      @if (view() === 'campanas') {
        <section class="pres-section">
          <div class="pres-section-head">
            <h2>Campañas</h2>
            <button pButton type="button" class="p-button-sm" (click)="openNewCamp()"><span class="pi pi-plus"></span>&nbsp;Nueva campaña</button>
          </div>

          @if (campaigns().length) {
            <div class="pres-budget-chips">
              @for (c of campaigns(); track c.id) {
                <button type="button" class="pres-chip" [class.on]="selectedCampaign()?.id === c.id" (click)="selectCampaign(c)">
                  {{ c.name }} <span class="pres-chip-yr">{{ campTypeLabel(c.campaign_type) }}</span>
                  <p-tag [value]="c.status" [severity]="campSeverity(c.status)" styleClass="pres-tag" />
                </button>
              }
            </div>
          } @else if (loadingCampaigns()) {
            <p class="pres-muted">Cargando campañas…</p>
          } @else {
            <div class="pres-empty-block">
              <span class="pi pi-megaphone pres-empty-ico"></span>
              <p>Aún no hay campañas.</p>
              <button pButton type="button" class="p-button-sm" (click)="openNewCamp()"><span class="pi pi-plus"></span>&nbsp;Crear la primera</button>
            </div>
          }

          @if (campEval(); as ev) {
            <div class="pres-detail-bar">
              <span class="pres-summary-title">{{ ev.campaign.name }} · {{ campTypeLabel(ev.campaign.campaign_type) }} <p-tag [value]="ev.campaign.status" [severity]="campSeverity(ev.campaign.status)" styleClass="pres-tag" /> · <span class="pres-muted">{{ ev.partidas }} partida(s)</span></span>
              <div class="pres-detail-actions">
                @if (ev.campaign.status === 'borrador') { <button pButton type="button" class="p-button-sm" (click)="setCampStatus('activa')" [loading]="savingCampStatus()">Activar</button> }
                @if (ev.campaign.status === 'activa') { <button pButton type="button" class="p-button-sm p-button-text" (click)="setCampStatus('cerrada')" [loading]="savingCampStatus()">Cerrar</button> }
              </div>
            </div>

            @if (ev.ventas_vinculadas.available && ev.ventas_vinculadas.as_of) {
              <div class="pres-summary-head"><app-freshness-pill measures="data" [freshness]="ev.freshness" /></div>
            }
            <app-metric-strip [items]="campKpis(ev)" mode="strip" ariaLabel="Evaluación de campaña" />

            <!-- Honestidad declarada (spec §9/§10): atribución, retorno, aportaciones, descuento -->
            <div class="pres-eval-notes">
              <p><span class="pi pi-link"></span> <strong>Ventas vinculadas:</strong>
                {{ ev.ventas_vinculadas.available ? money(ev.ventas_vinculadas.monto) : (ev.ventas_vinculadas.reason || 'sin datos') }}
                — atribución: {{ ev.ventas_vinculadas.attribution }} <em>(no prueba efecto incremental)</em>.</p>
              <p><span class="pi pi-chart-line"></span> <strong>Retorno:</strong>
                @if (ev.retorno.available) { {{ ev.retorno.roi_pct }}% <span class="pres-muted">({{ ev.retorno.basis }})</span> }
                @else {
                  <span class="pres-muted">{{ ev.retorno.reason }}</span>
                  <span class="pres-inline-calc">
                    <input pInputText type="number" [(ngModel)]="margenInput" placeholder="Margen incremental" class="pres-margen" />
                    <button pButton type="button" class="p-button-sm p-button-text" (click)="recalcRetorno()">Calcular</button>
                  </span>
                }
              </p>
              <p><span class="pi pi-gift"></span> <strong>Aportaciones:</strong>
                confirmada <span class="pres-mono">{{ money(ev.aportaciones.confirmada) }}</span> · incierta <span class="pres-mono">{{ money(ev.aportaciones.incierta) }}</span>
                <em class="pres-muted">({{ ev.aportaciones.nota }})</em>
                <button pButton type="button" class="p-button-sm p-button-text" (click)="openAddContrib()"><span class="pi pi-plus"></span>&nbsp;Aportación</button></p>
              @for (w of ev.warnings; track w) { <div class="pres-alert"><span class="pi pi-exclamation-triangle"></span> {{ w }}</div> }
            </div>

            @if (contributions().length) {
              <p-table [value]="contributions()" styleClass="p-datatable-sm surf-table pres-table">
                <ng-template #header><tr><th>Proveedor</th><th class="ta-r">Importe</th><th>Condición</th><th>Estado</th><th style="width:3rem"><span class="sr-only">Acciones</span></th></tr></ng-template>
                <ng-template #body let-ct>
                  <tr>
                    <td>{{ ct.supplier }}</td>
                    <td class="ta-r pres-mono">{{ money(ct.amount) }}</td>
                    <td class="pres-muted">{{ ct.condition || '—' }}</td>
                    <td><p-tag [value]="ct.status" [severity]="contribSeverity(ct.status)" styleClass="pres-tag" /></td>
                    <td>@if (ct.status === 'incierta') { <button pButton type="button" class="p-button-sm p-button-text" (click)="confirmContrib(ct)" title="Confirmar" aria-label="Confirmar aportación"><span class="pi pi-check"></span></button> }</td>
                  </tr>
                </ng-template>
              </p-table>
            }
          }
        </section>
      }

      <!-- ══════════ CAPACIDAD DE PAGO (Fase TP + PR.2) ══════════ -->
      @if (view() === 'capacidad') {
        <section class="pres-section">
          <!-- Proponer capacidad desde el flujo (cobranza esperada) · PR.2 -->
          <div class="pres-section-head">
            <h2>Capacidad de pago <span class="pres-muted">— cuánto se AUTORIZA pagar por día; el sistema lo propone, tú confirmas</span></h2>
          </div>

          <!-- [VP.MS] La respuesta arriba (DESIGN.md §15 answer-first): antes esta pestaña
               abria con dos formularios y una tabla, sin una sola cifra que contestara
               cuanto se autorizo ni con que se calculo. -->
          <app-metric-strip [items]="capacidadKpis()" mode="strip" ariaLabel="Resumen de capacidad de pago" />

          <p class="pres-nodata">
            <span class="pi pi-info-circle"></span>
            <strong>Esto es un permiso, no un saldo.</strong> La capacidad es el tope que Presupuestos
            autoriza para un día; responde <em>¿alcanza la autorización?</em>, no <em>¿alcanza el dinero?</em>.
            El saldo en banco vive en <strong>Flujo / Resultado</strong> y no se suma acá.
          </p>

          <div class="pres-cap-form">
            <input type="date" [(ngModel)]="capProposeFrom" class="pres-date" aria-label="Desde" />
            <input type="date" [(ngModel)]="capProposeTo" class="pres-date" aria-label="Hasta" />
            <button pButton type="button" class="p-button-sm" (click)="proposeCapacity()" [loading]="loadingCapProp()"><span class="pi pi-bolt"></span>&nbsp;Proponer capacidad</button>
          </div>
          @if (capProposal(); as p) {
            @if (!p.available) {
              <p class="pres-nodata"><span class="pi pi-info-circle"></span> {{ p.reason || 'Sin cartera CXC para proponer capacidad.' }}</p>
            } @else {
              <p class="pres-hint"><span class="pi pi-info-circle"></span> {{ p.note }} · <strong>{{ p.items.length }}</strong> días · total <strong class="pres-mono">{{ money(capProposalTotal()) }}</strong>.
                <button pButton type="button" class="p-button-sm" (click)="confirmCapacity()" [loading]="confirmingCap()">Confirmar capacidad propuesta</button></p>
              <p-table [value]="p.items" styleClass="p-datatable-sm surf-table pres-table" [scrollable]="true" scrollHeight="16rem">
                <ng-template #header><tr><th>Día</th><th class="ta-r">Capacidad propuesta</th><th class="ta-r">Cobranza de la semana</th></tr></ng-template>
                <ng-template #body let-it>
                  <tr><td class="pres-mono">{{ it.date }}</td><td class="ta-r pres-mono">{{ money(it.amount) }}</td><td class="ta-r pres-mono">{{ dash(it.cobros_week) }}</td></tr>
                </ng-template>
              </p-table>
            }
          }

          <h3 style="margin-top:1.4rem">Ajuste manual de un día</h3>
          <div class="pres-cap-form">
            <input type="date" [(ngModel)]="capDate" (change)="loadCapacity()" class="pres-date" aria-label="Fecha" />
            <input pInputText type="number" [(ngModel)]="capAmount" placeholder="Importe autorizado" class="pres-amt" />
            <input pInputText type="text" [(ngModel)]="capReason" placeholder="Motivo del cambio" class="pres-reason" />
            <button pButton type="button" (click)="saveCapacity()" [loading]="savingCap()">Guardar</button>
          </div>
          @if (currentCapacity(); as c) {
            <p class="pres-current">Capacidad actual del {{ capDate }}: <strong class="pres-mono">{{ money(c.authorized_amount) }}</strong> · actualizado por {{ c.updated_by || '—' }}</p>
          } @else {
            <p class="pres-current pres-none">Sin capacidad definida para el {{ capDate }}.</p>
          }
          @if (history().length) {
            <table class="pres-hist-table">
              <thead><tr><th>Cambiado</th><th class="ta-r">Antes</th><th class="ta-r">Después</th><th>Motivo</th><th>Quién</th></tr></thead>
              <tbody>
                @for (h of history(); track h.changed_at) {
                  <tr>
                    <td class="pres-mono">{{ h.changed_at | date:'short' }}</td>
                    <td class="ta-r pres-mono">{{ h.previous_amount == null ? '—' : money(h.previous_amount) }}</td>
                    <td class="ta-r pres-mono">{{ money(h.new_amount) }}</td>
                    <td>{{ h.reason || '—' }}</td>
                    <td>{{ h.changed_by }}</td>
                  </tr>
                }
              </tbody>
            </table>
          }
        </section>
      }

      <!-- ══════════ OBLIGACIONES (Fase TP + PR.3) ══════════ -->
      @if (view() === 'gastos') {
        <section class="pres-section">
          <div class="pres-section-head">
            <h2>Obligaciones <span class="pres-muted">— se auto-generan del plan de gastos; tú autorizas</span></h2>
            <div class="pres-detail-actions">
              <button pButton type="button" class="p-button-sm" (click)="generateObligFromPlan()" [loading]="generatingOblig()" title="Genera obligaciones recurrentes del plan de gastos aprobado"><span class="pi pi-bolt"></span>&nbsp;Generar del plan</button>
              <button pButton type="button" class="p-button-sm" (click)="authorizeOblig()" [loading]="authorizingOblig()" title="Autoriza las seleccionadas (entran al Calendario)"><span class="pi pi-check"></span>&nbsp;Autorizar seleccionadas</button>
            </div>
          </div>
          <!-- [VP.MS] La respuesta arriba: con 312 filas, la tabla cruda no dejaba decir
               cuanto suma lo que de verdad va a pagarse. -->
          <app-metric-strip [items]="obligacionesKpis()" mode="strip" ariaLabel="Resumen de obligaciones" />

          <p class="pres-hint"><span class="pi pi-info-circle"></span> Las <strong>propuesta</strong> son auto-generadas (sin autorizar): selecciónalas y autoriza. Sólo las autorizadas entran al Calendario de Pagos.</p>

          <!-- [TES.10] Medido en prod el 2026-10-08: de 312 obligaciones, 156 cuelgan del
               FY2027 real y 156 del duplicado marcado is_test. El endpoint no devuelve de que
               ejercicio viene cada fila, asi que la pantalla NO puede separarlas: se declara.
               Autorizar una del duplicado la mete al Calendario de Pagos. -->
          <p class="pres-nodata">
            <span class="pi pi-exclamation-triangle"></span>
            <strong>Esta lista no distingue el ejercicio de prueba.</strong> La obligación no trae
            de qué presupuesto viene, así que si hay un ejercicio marcado como prueba sus
            obligaciones aparecen acá mezcladas — y autorizar una la mete al Calendario.
            Verificá el ejercicio antes de autorizar.
          </p>
          <p-table [value]="expenses()" [loading]="loadingExpenses()" styleClass="p-datatable-sm surf-table pres-table">
            <ng-template #header>
              <tr><th style="width:2.2rem"><span class="sr-only">Seleccionar</span></th><th>Concepto</th><th>Beneficiario</th><th>Tipo</th><th>Vence</th><th class="ta-r">Disponible</th><th>Estado</th><th style="width:3rem"><span class="sr-only">Acciones</span></th></tr>
            </ng-template>
            <ng-template #body let-e>
              <tr [class.pres-row-critical]="e.is_critical">
                <td>@if (e.status === 'propuesta') { <input type="checkbox" [checked]="isObligSel(e.id)" (change)="toggleOblig(e.id)" aria-label="Seleccionar obligación" /> }</td>
                <td>{{ e.concept }} @if (e.is_critical) { <i class="pi pi-flag pres-crit" [title]="e.critical_reason"></i> }</td>
                <td>{{ e.beneficiary }}</td>
                <td class="pres-muted">{{ e.subtype || '—' }}</td>
                <td class="pres-mono">{{ e.original_due_date || '—' }}</td>
                <td class="ta-r pres-mono">{{ money(e.available_amount) }}</td>
                <td><p-tag [value]="e.status" [severity]="e.status === 'paid' ? 'success' : e.status === 'cancelled' ? 'secondary' : e.status === 'propuesta' ? 'warn' : 'info'" styleClass="pres-tag" /></td>
                <td>@if (e.status === 'pending' || e.status === 'propuesta') { <button pButton type="button" class="p-button-sm p-button-text p-button-danger" (click)="cancelExpense(e)" title="Cancelar" aria-label="Cancelar obligación"><span class="pi pi-times"></span></button> }</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="8" class="pres-empty">Sin obligaciones. Usá «Generar del plan» para crear las recurrentes del plan de gastos.</td></tr></ng-template>
          </p-table>
        </section>
      }
    </div>

    <!-- Nuevo ejercicio -->
    <p-dialog [(visible)]="newBudgetVisible" [modal]="true" header="Nuevo ejercicio presupuestal" [style]="{ width: '26rem' }">
      <label class="pres-lbl">Nombre</label>
      <input pInputText type="text" [(ngModel)]="budgetForm.name" class="pres-full" placeholder="Ej. Presupuesto operativo" />
      <label class="pres-lbl">Año fiscal</label>
      <input pInputText type="number" [(ngModel)]="budgetForm.fiscal_year" class="pres-full" />
      <label class="pres-lbl">Escenario</label>
      <p-select [options]="scenarioOpts" [(ngModel)]="budgetForm.scenario" optionLabel="label" optionValue="value" placeholder="Escenario" styleClass="pres-full" />
      <div class="pres-dlg-actions"><button pButton type="button" (click)="confirmNewBudget()" [loading]="savingBudget()">Crear</button></div>
    </p-dialog>

    <!-- Copiar del año anterior -->
    <p-dialog [(visible)]="copyVisible" [modal]="true" header="Copiar del año anterior" [style]="{ width: '26rem' }">
      <p class="pres-lbl-hint">Crea un ejercicio nuevo en <strong>borrador</strong> clonando el actual (sin autorizaciones). Luego ajustas los supuestos y propones.</p>
      <label class="pres-lbl">Nombre</label>
      <input pInputText type="text" [(ngModel)]="copyForm.name" class="pres-full" />
      <label class="pres-lbl">Año fiscal</label>
      <input pInputText type="number" [(ngModel)]="copyForm.fiscal_year" class="pres-full" />
      <label class="pres-lbl">Escenario</label>
      <p-select [options]="scenarioOpts" [(ngModel)]="copyForm.scenario" optionLabel="label" optionValue="value" placeholder="Escenario" styleClass="pres-full" />
      <div class="pres-dlg-actions"><button pButton type="button" (click)="confirmCopy()" [loading]="savingCopy()">Copiar</button></div>
    </p-dialog>

    <!-- PR.5 (ADR-074): dialogos retirados — captura manual de partida/gasto/meta y los diálogos de
         «Proponer» (ahora un clic con los Supuestos del año). La partida se materializa del plan. -->

    <!-- Movimiento de partida -->
    <p-dialog [(visible)]="movVisible" [modal]="true" [header]="'Movimiento — ' + (movLine()?.concept || '')" [style]="{ width: '30rem' }">
      @if (movLine(); as l) {
        <div class="pres-mov-state">
          <span>Vigente <b class="pres-mono">{{ money(l.vigente_amount) }}</b></span>
          <span>Reservado <b class="pres-mono">{{ money(l.reserved_amount) }}</b></span>
          <span>Comprometido <b class="pres-mono">{{ money(l.committed_amount) }}</b></span>
          <span>Ejercido <b class="pres-mono">{{ money(l.exercised_amount) }}</b></span>
          <span>Disponible <b class="pres-mono" [class.pres-neg]="l.available_amount < 0">{{ money(l.available_amount) }}</b></span>
        </div>
        <label class="pres-lbl">Acción</label>
        <p-select [options]="movOpts" [(ngModel)]="movForm.action" optionLabel="label" optionValue="value" placeholder="Acción" styleClass="pres-full" />
        <label class="pres-lbl">Importe</label>
        <input pInputText type="number" [(ngModel)]="movForm.amount" class="pres-full" />
        @if (movForm.action === 'comprometer') {
          <label class="pres-check"><p-checkbox [(ngModel)]="movForm.fromReserva" [binary]="true" />Desde una reserva previa (convierte reserva → compromiso)</label>
        }
        @if (movForm.action === 'cancelar') {
          <label class="pres-lbl">Cancelar de</label>
          <p-select [options]="cancelTargetOpts" [(ngModel)]="movForm.target" optionLabel="label" optionValue="value" placeholder="Reserva o compromiso" styleClass="pres-full" />
        }
        <label class="pres-lbl">Nota (opcional)</label>
        <input pInputText type="text" [(ngModel)]="movForm.note" class="pres-full" />
        <div class="pres-dlg-actions"><button pButton type="button" (click)="applyMovement()" [loading]="savingMov()">Aplicar</button></div>
      }
    </p-dialog>

    <!-- Nueva campaña -->
    <p-dialog [(visible)]="newCampVisible" [modal]="true" header="Nueva campaña" [style]="{ width: '28rem' }">
      <label class="pres-lbl">Nombre</label>
      <input pInputText type="text" [(ngModel)]="campForm.name" class="pres-full" />
      <label class="pres-lbl">Tipo</label>
      <p-select [options]="campTypeOpts" [(ngModel)]="campForm.campaign_type" optionLabel="label" optionValue="value" placeholder="Tipo" styleClass="pres-full" />
      <label class="pres-lbl">Objetivo</label>
      <input pInputText type="text" [(ngModel)]="campForm.objective" class="pres-full" />
      <label class="pres-lbl">Responsable</label>
      <input pInputText type="text" [(ngModel)]="campForm.responsible" class="pres-full" />
      <label class="pres-lbl">Canales / sucursales</label>
      <input pInputText type="text" [(ngModel)]="campForm.channels" class="pres-full" />
      <div class="pres-row2">
        <div><label class="pres-lbl">Inicio</label><input type="date" [(ngModel)]="campForm.start_date" class="pres-full" /></div>
        <div><label class="pres-lbl">Fin</label><input type="date" [(ngModel)]="campForm.end_date" class="pres-full" /></div>
      </div>
      <label class="pres-lbl">Inversión planeada</label>
      <input pInputText type="number" [(ngModel)]="campForm.planned_budget" class="pres-full" />
      <label class="pres-lbl">Regla de atribución (cómo se mide el resultado)</label>
      <input pInputText type="text" [(ngModel)]="campForm.attribution_rule" class="pres-full" placeholder="Ej. ventas de la ventana en sus sucursales" />
      <p class="pres-lbl-hint">Sin una regla de atribución explícita, las ventas vinculadas no prueban efecto incremental.</p>
      <div class="pres-dlg-actions"><button pButton type="button" (click)="confirmNewCamp()" [loading]="savingCamp()">Crear</button></div>
    </p-dialog>

    <!-- Nueva aportación de proveedor -->
    <p-dialog [(visible)]="addContribVisible" [modal]="true" header="Aportación de proveedor" [style]="{ width: '26rem' }">
      <label class="pres-lbl">Proveedor</label>
      <input pInputText type="text" [(ngModel)]="contribForm.supplier" class="pres-full" />
      <label class="pres-lbl">Importe</label>
      <input pInputText type="number" [(ngModel)]="contribForm.amount" class="pres-full" />
      <label class="pres-lbl">Condición</label>
      <input pInputText type="text" [(ngModel)]="contribForm.condition" class="pres-full" placeholder="Ej. sujeta a exhibición" />
      <label class="pres-lbl">Estado</label>
      <p-select [options]="contribStatusOpts" [(ngModel)]="contribForm.status" optionLabel="label" optionValue="value" placeholder="Estado" styleClass="pres-full" />
      <p class="pres-lbl-hint">Solo la confirmada/aplicada reduce el gasto neto — la incierta no.</p>
      <div class="pres-dlg-actions"><button pButton type="button" (click)="confirmAddContrib()" [loading]="savingContrib()">Agregar</button></div>
    </p-dialog>

    <!-- PR.5 (ADR-074): «Nuevo gasto autorizado» retirado — las obligaciones se auto-generan del plan
         de gastos (estado propuesta) y se autorizan en lote desde la pestaña Obligaciones. -->
  `,
  styles: [`
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .pres-section { margin-top:1.4rem; }
    .pres-section-head { display:flex; justify-content:space-between; align-items:center; }
    .pres-section h2 { font-size:.95rem; margin:0 0 .5rem; }
    .pres-budget-chips { display:flex; gap:.5rem; flex-wrap:wrap; margin:.4rem 0 1rem; }
    .pres-chip { display:inline-flex; align-items:center; gap:.4rem; padding:.35rem .6rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); color:var(--text-main); font-size:.82rem; cursor:pointer; }
    .pres-chip.on { border-color:var(--action); box-shadow:0 0 0 1px var(--action); }
    .pres-chip-yr { color:var(--text-muted); }
    /* El nombre acompana al folio, no compite con el: el folio es la identidad. */
    .pres-chip-name { color:var(--text-muted); }
    .pres-summary-head { display:flex; justify-content:flex-end; align-items:center; gap:.75rem; flex-wrap:wrap; margin:.6rem 0 .4rem; }
    .pres-summary-title { font-size:.9rem; font-weight:600; display:inline-flex; align-items:center; gap:.4rem; flex-wrap:wrap; }
    .pres-detail-bar { display:flex; justify-content:space-between; align-items:center; gap:.75rem; flex-wrap:wrap; margin:.4rem 0 .2rem; }
    .pres-detail-actions { display:flex; gap:.4rem; flex-wrap:wrap; }
    .pres-mov-state { display:flex; flex-wrap:wrap; gap:.4rem 1rem; font-size:.78rem; color:var(--text-muted); padding:.5rem .6rem; border:1px solid var(--border-color); border-radius:var(--r-md); margin-bottom:.6rem; }
    .pres-mov-state b { color:var(--text-main); margin-left:.25rem; }
    .pres-lbl-hint { font-size:.72rem; color:var(--text-faint); margin:.3rem 0 0; }
    .pres-cf-period { display:flex; gap:.4rem; flex-wrap:wrap; align-items:center; }
    .pres-eval-notes { margin:.6rem 0; font-size:.82rem; }
    .pres-eval-notes p { margin:.35rem 0; display:flex; align-items:center; gap:.4rem; flex-wrap:wrap; }
    .pres-inline-calc { display:inline-flex; align-items:center; gap:.3rem; }
    .pres-margen { width:9rem; }
    .pres-row2 { display:flex; gap:.6rem; } .pres-row2 > div { flex:1; }
    .pres-alert { display:flex; align-items:center; gap:.4rem; font-size:.8rem; color:var(--warn-fg,#b45309); background:color-mix(in srgb, var(--warn-fg,#b45309) 8%, transparent); border:1px solid color-mix(in srgb, var(--warn-fg,#b45309) 25%, transparent); border-radius:var(--r-md); padding:.4rem .6rem; margin:.5rem 0; }
    .pres-nodata { font-size:.76rem; color:var(--warn-fg,#b45309); display:inline-flex; align-items:center; gap:.3rem; }
    .pres-cap-form { display:flex; gap:.5rem; flex-wrap:wrap; align-items:center; }
    .pres-nav { display:flex; gap:.6rem; align-items:center; flex-wrap:wrap; }
    /* [PU.VA] Era texto gris en MAYÚSCULAS pegado a las pestañas, y se leía como una octava
       pestaña deshabilitada. Ahora es un rótulo de grupo: minúscula, sin tracking de botón, con
       el divisor separado del texto y el cursor de texto apagado. */
    .pres-nav-sep { font-size:.7rem; color:var(--text-muted); letter-spacing:0; margin-left:.5rem;
      padding-left:.75rem; border-left:1px solid var(--border-color); cursor:default; user-select:none; }
    /* [PU.VA] Acción-herramienta: ícono sin rótulo, para que no compita con la acción de negocio. */
    .pres-act-ico { min-width:2rem; padding-inline:.5rem; }
    .pres-assump { border:1px solid var(--border-color); border-radius:var(--r-md); padding:.7rem .8rem; margin:.6rem 0 1rem; background:color-mix(in srgb, var(--action, #d97706) 4%, transparent); }
    .pres-assump-head { display:flex; align-items:center; justify-content:space-between; gap:.6rem; flex-wrap:wrap; margin-bottom:.5rem; }
    .pres-assump-head h3 { margin:0; font-size:.92rem; }
    .pres-assump-grid { display:flex; gap:1.4rem; flex-wrap:wrap; }
    .pres-assump-col { flex:1; min-width:14rem; }
    .pres-assump-col h4 { margin:.2rem 0 .4rem; font-size:.8rem; color:var(--text-muted); }
    /* [VE.7.1] Sin text-transform capitalize: capitalizaba CADA palabra y producia
       "Presupuestar Por Sucursal", "Control De Sobregiro" y "Respaldo (Canal Sin Historia
       Propia)". Los rotulos ya vienen escritos como deben leerse. */
    .pres-assump-row { display:flex; align-items:center; justify-content:space-between; gap:.5rem; margin:.25rem 0; font-size:.82rem; }
    /* [PU.VA] La casilla y su rótulo son UNA cosa: sin esto 'space-between' los manda a los
       extremos opuestos del renglón. */
    .pres-assump-check { display:inline-flex; align-items:center; gap:.45rem; }
    /* [PU.VA] Los valores de la columna se alineaban por su BORDE derecho, no por el dígito: el
       renglón del respaldo («29.3 % · respaldo») es más ancho y su número quedaba corrido, o sea
       que el único que avisa que no es una medición propia era el único que no se podía escanear.
       Un ancho fijo para el número y el sufijo afuera arregla las dos cosas. */
    .pres-assump-row .pres-mono { font-variant-numeric: tabular-nums; }
    .pres-assump-val { display:inline-flex; align-items:baseline; gap:.35rem; justify-content:flex-end; }
    .pres-assump-val > .pres-assump-num { min-width:4.2rem; text-align:right; }
    /* [PU.VA] El sufijo reserva su ancho SIEMPRE, incluso vacío. Sin esto no alcanzaba con darle
       ancho al número: el «· respaldo» va después y lo corre hacia la izquierda, así que el único
       renglón que avisa que no es una medición propia era el único que no se podía escanear.
       Medido en pantalla: el primer intento (ancho sólo en el número) NO lo arregló. */
    .pres-assump-val > .pres-assump-suf { min-width:5.2rem; text-align:left; }
    /* [VE.7] Separa lo que el sistema CALCULA de lo que la persona DECIDE. */
    .pres-assump-sub { margin:1rem 0 .35rem; padding-top:.6rem; border-top:1px solid var(--border-subtle,#e5e1dc); font-size:var(--fs-xs); color:var(--text-muted); }
    .pres-assump-in { width:8rem; }
    /* [PU.R] La cascada del estado de resultados. El renglon de corte va en negritas y con
       linea arriba: es lo que separa margen bruto de resultado al leerla de corrido. */
    .pres-pnl { border-collapse:collapse; margin:.4rem 0 .8rem; min-width:min(100%,38rem); }
    .pres-pnl th { text-align:left; font-size:.68rem; text-transform:uppercase; letter-spacing:.05em;
      color:var(--text-muted,#78716c); font-weight:600; padding:.3rem .7rem;
      border-bottom:1px solid var(--surface-border,#e7e5e4); }
    .pres-pnl td { padding:.32rem .7rem; font-size:.84rem; }
    .pres-pnl-rgl { white-space:nowrap; }
    .pres-pnl-fuerte td { font-weight:700; border-top:1px solid var(--surface-border,#e7e5e4); }
    .pres-date { padding:.35rem .6rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); color:var(--text-main); font-size:.85rem; }
    .pres-amt { width:10rem; } .pres-reason { flex:1; min-width:12rem; }
    .pres-current { font-size:.82rem; color:var(--text-muted); margin-top:.5rem; }
    .pres-none { color:var(--warn-fg); }
    .pres-hist-table { width:100%; border-collapse:collapse; font-size:.78rem; margin-top:.6rem; }
    .pres-hist-table th, .pres-hist-table td { padding:.3rem .5rem; border-bottom:1px solid var(--border-color); text-align:left; }
    .pres-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
    .ta-r { text-align:right; }
    .pres-neg { color:var(--bad-fg,#b42318); }
    .pres-table { font-size:.84rem; margin-top:.4rem; }
    .pres-muted { color:var(--text-muted); }
    .pres-hint { font-size:.76rem; color:var(--text-muted); margin-top:.5rem; display:flex; align-items:center; gap:.35rem; }
    /* [PU.V6] El aviso de que el total cubre PARTE del ejercicio. No es un hint apagado: una
       persona esta por aprobar un presupuesto al que le falta su mejor trimestre. */
    .pres-warn { font-size:.8rem; margin:.5rem 0 0; padding:.5rem .7rem; display:flex; align-items:flex-start; gap:.45rem;
      border-radius:var(--radius-sm); border:1px solid var(--warn-border, var(--border));
      background:var(--warn-bg, var(--surface-2)); color:var(--warn-text, var(--text)); }
    .pres-warn .pi { margin-top:.1rem; flex:0 0 auto; }
    .pres-crit { color:var(--bad-fg); margin-left:.3rem; }
    .pres-row-critical { background:color-mix(in srgb, var(--bad-fg) 5%, transparent); }
    .pres-empty-block { text-align:center; padding:1.6rem; color:var(--text-muted); display:flex; flex-direction:column; align-items:center; gap:.5rem; }
    .pres-empty-ico { font-size:1.6rem; color:var(--text-faint); }
    :host ::ng-deep .pres-tag { font-size:.64rem; }
    .pres-empty { text-align:center; color:var(--text-faint); padding:1.2rem; }
    .pres-lbl { display:block; font-size:.76rem; color:var(--text-muted); margin:.4rem 0 .2rem; }
    .pres-full { width:100%; }
    .pres-check { display:flex; align-items:center; gap:.4rem; margin-top:.6rem; font-size:.82rem; }
    .pres-dlg-actions { margin-top:.8rem; }
    /* PVA — badge de origen de la meta */
    .ec-src { display:inline-block; font-size:.62rem; padding:.05rem .35rem; border-radius:.35rem; border:1px solid var(--border); color:var(--text-muted); white-space:nowrap; }
    .ec-src-historico_ajustado { color:var(--good-fg,#067647); border-color:color-mix(in srgb, var(--good-fg,#067647) 40%, transparent); }
    .ec-src-estacional { color:var(--text-muted); border-style:dashed; }
    .ec-src-proxy_canal { color:var(--warn-fg); border-style:dashed; }
    .ec-src-sin_base_declarado { color:var(--text-faint); border-style:dotted; }
    .ec-src-manual { color:var(--bad-fg,#b42318); border-color:color-mix(in srgb, var(--bad-fg,#b42318) 40%, transparent); }
    .ec-src-mixto { color:var(--text-faint); }
    .pres-propose-tbl { width:100%; border-collapse:collapse; font-size:.82rem; margin:.4rem 0 .2rem; }
    .pres-propose-tbl th, .pres-propose-tbl td { padding:.3rem .4rem; border-bottom:1px solid var(--border); text-align:left; }
    .pres-growth-in { width:5rem; text-align:right; }
    /* PVR — badges de estado de conciliación */
    .ec-src-recon-concilia { color:var(--good-fg,#067647); border-color:color-mix(in srgb, var(--good-fg,#067647) 40%, transparent); }
    .ec-src-recon-revisar { color:var(--bad-fg,#b42318); border-color:color-mix(in srgb, var(--bad-fg,#b42318) 40%, transparent); }
    .ec-src-recon-sin_facturacion, .ec-src-recon-sin_sellout { color:var(--text-faint); border-style:dashed; }
    .pres-recon-notes { margin-top:.6rem; }
  `],
})
export class FinanzasPresupuestoComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  /**
   * `[PU.VA]` ⛔ **Los supuestos de ventas llegaban y no se pintaban.** El componente es `OnPush` y
   * `channelsList` / `asVentasGrowth` / `asVentasDefault` son campos **planos, no signals**:
   * mutarlos dentro de un `subscribe` no marca el componente para revisión, así que la vista se
   * quedaba con los valores sembrados (`8 %`, y los canales en minúscula del respaldo local).
   *
   * ⭐ **Es un defecto latente que recién hoy se pudo ver**, y la razón es la mitad interesante:
   * mientras `budget.sales_plan_settings` estuvo vacía —o sea *siempre*, hasta que la pasada de
   * hoy escribió su primera fila (`VERDAD_ABSOLUTA` §22.2)—, `vacio` daba true y corría
   * `suggestAssumptions()`, que sí toca signals (`suggestingAssump.set`) y de rebote repintaba.
   * El camino "ya hay supuestos guardados" **nunca se había ejercido**, y es el que no pinta.
   *
   * Probado en el navegador: con la pantalla mostrando `8 % · respaldo`, un click —que dispara
   * detección— la cambió sola a `Mostrador 21.1 % · Mayoreo 26.7 % · Ruta 8.3 % · Vecinal 51.2 %`.
   * El dato estaba; faltaba el repintado.
   */
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly base = `${environment.apiUrl}/finance/budget`;

  // ── Sub-navegación ──
  view = signal<PresView>('ejercicios');
  // Grupo «armar el presupuesto» (automático) + grupo «programación de pagos» (alimenta Calendario).
  viewOptsArmar = [
    { label: 'Ejercicio', value: 'ejercicios' },
    { label: 'Ventas', value: 'ventas' },
    { label: 'Gastos', value: 'gasto-op' },
    { label: 'Flujo / Resultado', value: 'flujo' },
    { label: 'Campañas', value: 'campanas' },
  ];
  viewOptsPagos = [
    { label: 'Capacidad de pago', value: 'capacidad' },
    { label: 'Obligaciones', value: 'gastos' },
  ];
  setView(v: string) {
    this.view.set(v as PresView);
    // `[VE.3]` El flujo de caja se cargaba sólo apretando «Actualizar». Una cifra que hay que
    // pedir no es un tablero: es un reporte a demanda. Se dispara al entrar a la pestaña, en
    // segundo plano — la pantalla ya se pintó, el bloque llega cuando llega — y el botón se
    // queda, pero ahora significa «volvé a consultar», no «traémelo por primera vez».
    if (v === 'flujo') { this.loadResultado(); if (!this.cashflow()) this.loadCashflow(); }
    if (v === 'campanas' && !this.campaigns().length) this.loadCampaigns();
    // Entrar a Ventas abre la pestaña «Plan», y `setSalesTab` no corre si no se cambia de
    // pestaña: sin esta línea la comparación seguiría esperando un clic en el caso más común.
    if (v === 'ventas' && this.salesTab() === 'plan' && !this.salesCmp()) this.loadSalesComparison();
    // `[VE.4]` La capacidad de pago abría con las dos fechas en blanco y un botón «Proponer» que,
    // sin elegirlas, sólo contestaba «Elegí desde y hasta». Ahora entra con una ventana por
    // default (hoy → +30 días) y la propuesta ya calculada. ⚠️ Proponer NO autoriza: la capacidad
    // se fija con «Guardar», que es el acto que el Calendario después consume como tope.
    if (v === 'capacidad') {
      if (!this.capProposeFrom || !this.capProposeTo) {
        const hoy = new Date();
        const mas30 = new Date(hoy.getTime() + 30 * 864e5);
        const iso = (d: Date) => d.toISOString().slice(0, 10);
        this.capProposeFrom = iso(hoy); this.capProposeTo = iso(mas30);
      }
      if (!this.capProposal()) this.proposeCapacity();
    }
    // 'ventas': el pivote meta-vs-real consulta el sell-out del ODS (lento) → opt-in por botón, no al cargar
    if (v === 'gasto-op') this.loadExpensePlan();
    if (v === 'ejercicios') this.loadAssumptions();
    if (v === 'gastos') this.loadObligProposals();
  }

  // ── Ejercicios (PU) ──
  budgets = signal<BudgetHeader[]>([]);
  loadingBudgets = signal(false);
  /** `[VE.9]` La pasada del piloto, disparada a mano desde la pantalla. */
  runningAutopilot = signal(false);
  selected = signal<BudgetHeader | null>(null);
  summary = signal<Summary | null>(null);
  lines = signal<BudgetLine[]>([]);
  loadingDetail = signal(false);
  /** `[PU.VA]` El estado real de la pasada, para que el vacío de la tabla no tenga que adivinar. */
  autopilot = signal<AutopilotStatus | null>(null);
  newBudgetVisible = false;
  savingBudget = signal(false);
  budgetForm: { name?: string; fiscal_year?: number; scenario?: string } = {};
  scenarioOpts = [{ label: 'Base', value: 'base' }, { label: 'Conservador', value: 'conservador' }, { label: 'Expansión', value: 'expansion' }];
  savingLifecycle = signal(false);

  // ── Partidas / movimientos (PU.1) ──
  addLineVisible = false;
  savingLine = signal(false);
  lineForm: { concept?: string; line_type?: string; area?: string; original_amount?: number; control_level?: string } = {};
  lineTypeOpts = [
    { label: 'Gasto', value: 'gasto' }, { label: 'Ingreso', value: 'ingreso' }, { label: 'Costo de ventas', value: 'costo_ventas' },
    { label: 'Compra de inventario', value: 'compra_inventario' }, { label: 'Inversión', value: 'inversion' }, { label: 'Flujo', value: 'flujo' },
  ];
  controlOpts = [{ label: 'Bloqueo', value: 'bloqueo' }, { label: 'Advertencia', value: 'advertencia' }, { label: 'Informativo', value: 'informativo' }];

  movVisible = false;
  savingMov = signal(false);
  movLine = signal<BudgetLine | null>(null);
  movForm: { action?: string; amount?: number; fromReserva?: boolean; target?: string; note?: string } = {};
  movOpts = [
    { label: 'Reservar', value: 'reservar' }, { label: 'Comprometer', value: 'comprometer' }, { label: 'Ejercer', value: 'ejercer' },
    { label: 'Pagar', value: 'pagar' }, { label: 'Cancelar', value: 'cancelar' }, { label: 'Ampliar (adecuación)', value: 'ampliar' }, { label: 'Reducir (adecuación)', value: 'reducir' },
  ];
  cancelTargetOpts = [{ label: 'Reserva', value: 'reserva' }, { label: 'Compromiso', value: 'compromiso' }];

  // ── Planeación (PU.4): copiar / comparar / importar / proyección ──
  copyVisible = false; savingCopy = signal(false);
  copyForm: { name?: string; scenario?: string; fiscal_year?: number } = {};
  importVisible = false; importText = ''; importPreviewing = signal(false); importApplying = signal(false);
  importPreview = signal<ImportPreview | null>(null);
  compareVisible = false; compareOther = ''; comparing = signal(false);
  compareResult = signal<CompareResult | null>(null);
  projVisible = false; loadingProj = signal(false);
  projection = signal<Projection | null>(null);

  // ── Gasto operativo (PU.7) — vista dedicada sobre las partidas tipo Gasto ──
  newGastoVisible = false; savingGasto = signal(false);
  gastoForm: { concept?: string; area?: string; responsible?: string; original_amount?: number; expense_class?: string; recurrence?: string; control_level?: string } = {};
  expenseClassOpts = [{ label: 'Fijo', value: 'fijo' }, { label: 'Variable', value: 'variable' }];
  recurrenceOpts = [{ label: 'Recurrente', value: 'recurrente' }, { label: 'No recurrente', value: 'no_recurrente' }];

  // ── Presupuesto de ventas (PV) ──
  salesCmp = signal<SalesComparison | null>(null);
  loadingSales = signal(false);
  salesPeriod = 0; // 0 = Todos (anual); 1..13 = periodo
  periodOpts = [{ label: 'Todos (anual)', value: 0 }, ...Array.from({ length: 13 }, (_, i) => ({ label: `P${i + 1}`, value: i + 1 }))];
  genPlanVisible = false; savingGen = signal(false); genGrowthPct: number | null = 10; genOverwriteManual = false;
  metaEditVisible = false; savingMeta = signal(false); metaEditRow = signal<SalesRow | null>(null); metaEditAmount: number | null = null;
  // PVA — automatización
  salesTab = signal<'plan' | 'indicadores' | 'conciliacion'>('plan');
  salesTabOpts = [{ label: 'Plan', value: 'plan' }, { label: 'Indicadores', value: 'indicadores' }, { label: 'Conciliación', value: 'conciliacion' }];
  proposeVisible = false; savingPropose = signal(false); loadingProposal = signal(false);
  growthRows = signal<GrowthEditRow[]>([]); proposeDefaultGrowth: number | null = 8; proposeOverwriteManual = false;
  proposal = signal<GrowthProposal | null>(null); lastCoverage = signal<ProposeCoverage | null>(null);
  indicators = signal<SalesIndicators | null>(null); loadingIndicators = signal(false);
  reconciliation = signal<SalesReconciliation | null>(null); loadingReconciliation = signal(false);

  // ── Flujo de efectivo (PU.3) ──
  cashflow = signal<Cashflow | null>(null);
  loadingCashflow = signal(false);
  cfFrom = new Date().toISOString().slice(0, 10);
  cfTo = (() => { const d = new Date(); d.setDate(d.getDate() + 56); return d.toISOString().slice(0, 10); })();

  // ── Campañas / Marketing (PU.5) ──
  campaigns = signal<Campaign[]>([]);
  loadingCampaigns = signal(false);
  selectedCampaign = signal<Campaign | null>(null);
  campEval = signal<CampaignEval | null>(null);
  contributions = signal<Contribution[]>([]);
  savingCampStatus = signal(false);
  newCampVisible = false;
  savingCamp = signal(false);
  campForm: { name?: string; campaign_type?: string; objective?: string; responsible?: string; channels?: string; start_date?: string; end_date?: string; planned_budget?: number; attribution_rule?: string } = {};
  campTypeOpts = [
    { label: 'Publicidad', value: 'publicidad' }, { label: 'Materiales', value: 'materiales' }, { label: 'Eventos', value: 'eventos' },
    { label: 'Promociones', value: 'promociones' }, { label: 'Descuento comercial', value: 'descuento_comercial' }, { label: 'Otro', value: 'otro' },
  ];
  addContribVisible = false;
  savingContrib = signal(false);
  contribForm: { supplier?: string; amount?: number; condition?: string; status?: string } = {};
  contribStatusOpts = [{ label: 'Incierta', value: 'incierta' }, { label: 'Confirmada', value: 'confirmada' }, { label: 'Aplicada', value: 'aplicada' }];
  margenInput: number | null = null;

  // ── Capacidad (TP) ──
  capDate = new Date().toISOString().slice(0, 10);
  capAmount: number | null = null;
  capReason = '';
  savingCap = signal(false);
  currentCapacity = signal<Capacity | null>(null);
  history = signal<CapacityHistoryRow[]>([]);

  // ── Gastos (TP) ──
  expenses = signal<ExpenseObligation[]>([]);
  loadingExpenses = signal(false);
  saving = signal(false);
  subtypeOpts = [
    { label: 'Luz', value: 'luz' }, { label: 'Renta', value: 'renta' }, { label: 'Sueldos', value: 'sueldos' },
    { label: 'Comisiones', value: 'comisiones' }, { label: 'Operativo', value: 'operativo' }, { label: 'Otro', value: 'otro' },
  ];
  newVisible = false;
  form: { concept?: string; beneficiary?: string; subtype?: string; area?: string; original_amount?: number; original_due_date?: string; is_critical?: boolean; critical_reason?: string } = {};

  ngOnInit(): void { this.loadBudgets(); this.loadCapacity(); this.loadExpenses(); }

  // ── Ejercicios ──
  loadBudgets(): void {
    this.loadingBudgets.set(true);
    this.http.get<BudgetHeader[]>(`${this.base}/budgets`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => {
        this.budgets.set(rows ?? []);
        this.loadingBudgets.set(false);
        const cur = this.selected();
        if (!cur && rows?.length) this.selectBudget(rows[0]);
        // Re-sincronizar el header del ejercicio abierto (estado/versión) con la fila fresca:
        // sin esto, tras un cambio de ciclo de vida el chip mostraba el estado nuevo y la barra
        // de detalle el viejo (selectBudget solo refresca resumen/partidas, no el header).
        else if (cur) { const fresh = (rows ?? []).find((r) => r.id === cur.id); if (fresh) this.selected.set(fresh); }
      },
      error: () => { this.loadingBudgets.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar los ejercicios.' }); },
    });
  }

  selectBudget(b: BudgetHeader): void {
    this.selected.set(b);
    this.summary.set(null); this.lines.set([]); this.salesCmp.set(null);
    this.loadingDetail.set(true);
    // `[PU.VA]` El latido de la pasada, para que el vacío de la tabla no tenga que conjeturar.
    // Va APARTE del `forkJoin`: si no se puede leer, la pantalla igual tiene que pintar el
    // ejercicio, y el signal queda en `null`, que el vacío lee como «no sé si corrió» (ADR-056).
    this.autopilot.set(null);
    this.http.get<AutopilotStatus>(`${this.base}/autopilot/status`).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (a) => this.autopilot.set(a), error: () => this.autopilot.set(null) });
    forkJoin({
      summary: this.http.get<Summary>(`${this.base}/budgets/${b.id}/summary`),
      lines: this.http.get<BudgetLine[]>(`${this.base}/budgets/${b.id}/lines`),
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: ({ summary, lines }) => {
        this.summary.set(summary); this.lines.set(lines ?? []); this.loadingDetail.set(false);
        // `[VE.3]` El «real vs presupuesto» llegaba `deferred:true` y esperaba a que alguien
        // apretara «Cargar real vs presupuesto». Ahora se pide solo, DESPUÉS de pintar el
        // ejercicio y en una llamada aparte, así que no retrasa nada de lo que ya se ve.
        // ⚠️ El diferimiento del backend NO era una precaución vieja: medido contra prod el
        // 2026-10-06, ese agregado recorre 2.2 M filas de `mv_sales_blended` y tarda 1,893 ms
        // en frío (283 ms caliente). Por eso se dispara en segundo plano y no se mete en el
        // `forkJoin` de arriba: meterlo ahí haría esperar 2 s a la pantalla entera.
        if (summary?.real?.deferred) this.loadSummaryReal();
      },
      error: () => { this.loadingDetail.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el ejercicio.' }); },
    });
    this.loadAssumptions();
    if (this.view() === 'flujo') this.loadResultado();
    if (this.view() === 'gasto-op') this.loadExpensePlan();
    if (this.view() === 'gastos') this.loadExpenses();
  }

  /**
   * `[VE.9]` Adelanta la pasada nocturna. Es la MISMA que corre a las 03:30, no una versión
   * recortada: crea el ejercicio del año siguiente si falta, deriva los supuestos del histórico y
   * propone ventas, gastos, proyección y partidas, respetando todo lo capturado a mano.
   *
   * Las dos llamadas van en orden porque la segunda lee el plan de gastos que escribe la primera
   * (viven en módulos distintos, `[VE.4]`). Si la primera falla, la segunda no corre: generar
   * obligaciones de un plan que no se escribió sería proponer pagos sobre nada.
   */
  runAutopilot(): void {
    this.runningAutopilot.set(true);
    this.http.post<{ ejercicios: number; tocados: number; celdas: number; errores: string[] }>(`${this.base}/autopilot/run`, {})
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          const detalle = `${r.tocados}/${r.ejercicios} ejercicios · ${r.celdas} celdas escritas`;
          if (r.errores?.length) {
            // No se dibuja como éxito: una pasada con fallas que dice «listo» es justo lo que el
            // latido de este módulo ya hizo una vez (ok sobre cero).
            this.toast.add({ severity: 'warn', summary: 'Pasada con fallas', detail: `${detalle} — ${r.errores.join(' · ')}`, life: 12000 });
          } else {
            this.toast.add({ severity: 'success', summary: 'Presupuesto armado', detail: detalle });
          }
          this.http.post<{ generadas: number; actualizadas: number; errores: string[] }>(`${this.base}/expenses/autopilot/run`, {})
            .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
              next: (o) => {
                this.runningAutopilot.set(false); this.loadBudgets();
                if (o.generadas || o.actualizadas) {
                  this.toast.add({ severity: 'info', summary: 'Obligaciones propuestas', detail: `${o.generadas} nuevas · ${o.actualizadas} actualizadas — esperan tu autorización` });
                }
              },
              error: (e) => { this.runningAutopilot.set(false); this.loadBudgets(); this.toast.add({ severity: 'warn', summary: 'Obligaciones', detail: e?.error?.message || 'El presupuesto se armó; las obligaciones no.' }); },
            });
        },
        error: (e) => { this.runningAutopilot.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo armar el presupuesto.' }); },
      });
  }

  openNewBudget(): void { this.budgetForm = { fiscal_year: new Date().getFullYear() + 1, scenario: 'base' }; this.newBudgetVisible = true; }
  confirmNewBudget(): void {
    if (!this.budgetForm.name?.trim() || !(Number(this.budgetForm.fiscal_year) >= 2000)) {
      this.toast.add({ severity: 'warn', summary: 'Faltan datos', detail: 'Nombre y año fiscal son requeridos.' }); return;
    }
    this.savingBudget.set(true);
    this.http.post<BudgetHeader>(`${this.base}/budgets`, this.budgetForm).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (b) => { this.savingBudget.set(false); this.newBudgetVisible = false; this.loadBudgets(); if (b) this.selectBudget(b); this.toast.add({ severity: 'success', summary: 'Creado', detail: 'Ejercicio creado en borrador.' }); },
      error: (e) => { this.savingBudget.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo crear.' }); },
    });
  }

  lifecycle(b: BudgetHeader, action: 'submit' | 'approve' | 'close'): void {
    this.savingLifecycle.set(true);
    this.http.post<{ materialization?: { error?: string } }>(`${this.base}/budgets/${b.id}/${action}`, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (resp) => {
        this.savingLifecycle.set(false); this.loadBudgets(); this.reloadDetail();
        if (action === 'approve') {
          // el backend materializa best-effort; NO afirmar éxito si falló (era una falla silenciosa).
          const matErr = resp?.materialization?.error;
          this.http.post(`${this.base}/budgets/${b.id}/sales-plan/project-targets`, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => { /* silencioso */ }, error: () => { /* no bloquea */ } });
          if (matErr) {
            this.toast.add({ severity: 'warn', summary: 'Aprobado, pero SIN materializar', detail: `Las partidas NO se materializaron: ${matErr}. Corregí y usá "Re-materializar".`, life: 8000 });
          } else {
            this.toast.add({ severity: 'success', summary: 'Ejercicio aprobado', detail: 'Partidas materializadas del plan y metas proyectadas a Análisis.' });
          }
        } else {
          this.toast.add({ severity: 'success', summary: 'Listo', detail: action === 'submit' ? 'Enviado a autorización.' : 'Ejercicio cerrado.' });
        }
      },
      error: (e) => { this.savingLifecycle.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo', detail: e?.error?.message || 'Acción rechazada.' }); },
    });
  }

  materializing = signal(false);
  materializeNow(b: BudgetHeader): void {
    this.materializing.set(true);
    this.http.post<{ created: number; updated: number; adjusted: number; closed: number }>(`${this.base}/budgets/${b.id}/materialize`, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.materializing.set(false); this.reloadDetail(); this.toast.add({ severity: 'success', summary: 'Partidas materializadas', detail: `${r.created} creadas · ${r.updated} actualizadas · ${r.adjusted} ajustadas · ${r.closed} cerradas.` }); },
      error: (e) => { this.materializing.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo materializar.' }); },
    });
  }

  openAddLine(): void { this.lineForm = { line_type: 'gasto', control_level: 'bloqueo' }; this.addLineVisible = true; }
  confirmAddLine(): void {
    const b = this.selected(); if (!b) return;
    if (!this.lineForm.concept?.trim() || !(Number(this.lineForm.original_amount) >= 0)) {
      this.toast.add({ severity: 'warn', summary: 'Faltan datos', detail: 'Concepto e importe son requeridos.' }); return;
    }
    this.savingLine.set(true);
    this.http.post(`${this.base}/budgets/${b.id}/lines`, this.lineForm).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.savingLine.set(false); this.addLineVisible = false; this.reloadDetail(); this.toast.add({ severity: 'success', summary: 'Agregada', detail: 'Partida creada.' }); },
      error: (e) => { this.savingLine.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo agregar.' }); },
    });
  }

  openMovement(l: BudgetLine): void { this.movLine.set(l); this.movForm = { action: 'reservar' }; this.movVisible = true; }
  applyMovement(): void {
    const l = this.movLine(); const action = this.movForm.action;
    if (!l || !action) return;
    if (!(Number(this.movForm.amount) > 0)) { this.toast.add({ severity: 'warn', summary: 'Importe', detail: 'Captura un importe > 0.' }); return; }
    if (action === 'cancelar' && !this.movForm.target) { this.toast.add({ severity: 'warn', summary: 'Falta destino', detail: 'Elige reserva o compromiso.' }); return; }
    const body: Record<string, unknown> = { amount: Number(this.movForm.amount), note: this.movForm.note || undefined };
    if (action === 'comprometer') body['fromReserva'] = !!this.movForm.fromReserva;
    if (action === 'cancelar') body['target'] = this.movForm.target;
    this.savingMov.set(true);
    this.http.post<{ warning?: string | null }>(`${this.base}/lines/${l.id}/${action}`, body).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.savingMov.set(false); this.movVisible = false; this.reloadDetail();
        if (res?.warning) this.toast.add({ severity: 'warn', summary: 'Aplicado con aviso', detail: res.warning });
        else this.toast.add({ severity: 'success', summary: 'Aplicado', detail: 'Movimiento registrado.' });
      },
      error: (e) => { this.savingMov.set(false); this.toast.add({ severity: 'error', summary: 'Rechazado', detail: e?.error?.message || 'No se pudo aplicar.' }); },
    });
  }

  private reloadDetail(): void { const b = this.selected(); if (b) this.selectBudget(b); }

  // El «real vs presupuesto» agrega el sell-out del ODS (lento) → opt-in, no bloquea la carga del ejercicio.
  loadingSummaryReal = signal(false);
  loadSummaryReal(): void {
    const b = this.selected(); if (!b) return;
    this.loadingSummaryReal.set(true);
    this.http.get<Summary>(`${this.base}/budgets/${b.id}/summary`, { params: { real: '1' } }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => { this.summary.set(s); this.loadingSummaryReal.set(false); },
      error: (e) => { this.loadingSummaryReal.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo cargar el real del ODS.' }); },
    });
  }

  // ── Planeación (PU.4) ──
  openCopy(): void { const b = this.selected(); this.copyForm = { name: b?.name, scenario: b?.scenario, fiscal_year: (Number(b?.fiscal_year) || new Date().getFullYear()) + 1 }; this.copyVisible = true; }
  confirmCopy(): void {
    const b = this.selected(); if (!b) return;
    this.savingCopy.set(true);
    this.http.post<{ budget: BudgetHeader; copied_lines: number }>(`${this.base}/budgets/${b.id}/copy`, this.copyForm).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.savingCopy.set(false); this.copyVisible = false; this.loadBudgets(); if (r?.budget) this.selectBudget(r.budget); this.toast.add({ severity: 'success', summary: 'Copiado', detail: `Nuevo ejercicio en borrador (${r?.copied_lines ?? 0} partidas, sin autorizaciones).` }); },
      error: (e) => { this.savingCopy.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo copiar.' }); },
    });
  }

  openImport(): void { this.importText = ''; this.importPreview.set(null); this.importVisible = true; }
  /** Cada renglón: `concepto; tipo; area; importe` (tipo/area opcionales). */
  private parseImport(): { concept: string; line_type: string; area: string | null; original_amount: number }[] {
    return this.importText.split('\n').map((ln) => ln.trim()).filter(Boolean).map((ln) => {
      const [concept, tipo, area, imp] = ln.split(';').map((s) => s.trim());
      return { concept: concept || '', line_type: tipo || 'gasto', area: area || null, original_amount: Number(imp) };
    });
  }
  doPreview(): void {
    const b = this.selected(); if (!b) return;
    const rows = this.parseImport();
    if (!rows.length) { this.toast.add({ severity: 'warn', summary: 'Sin filas', detail: 'Pega al menos una partida.' }); return; }
    this.importPreviewing.set(true);
    this.http.post<ImportPreview>(`${this.base}/budgets/${b.id}/import/preview`, { rows }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => { this.importPreview.set(p); this.importPreviewing.set(false); },
      error: (e) => { this.importPreviewing.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo previsualizar.' }); },
    });
  }
  doApply(): void {
    const b = this.selected(); if (!b) return;
    const rows = this.parseImport();
    this.importApplying.set(true);
    this.http.post<{ created: number; updated: number; skipped: number }>(`${this.base}/budgets/${b.id}/import/apply`, { rows }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.importApplying.set(false); this.importVisible = false; this.reloadDetail(); this.toast.add({ severity: 'success', summary: 'Importado', detail: `${r.created} creadas · ${r.updated} actualizadas · ${r.skipped} omitidas.` }); },
      error: (e) => { this.importApplying.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo importar.' }); },
    });
  }

  openCompare(): void { this.compareOther = ''; this.compareResult.set(null); this.compareVisible = true; }
  runCompare(): void {
    const b = this.selected(); if (!b || !this.compareOther) { this.toast.add({ severity: 'warn', summary: 'Falta', detail: 'Elige el ejercicio a comparar.' }); return; }
    this.comparing.set(true);
    this.http.get<CompareResult>(`${this.base}/compare`, { params: { a: b.id, b: this.compareOther } }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.compareResult.set(r); this.comparing.set(false); },
      error: (e) => { this.comparing.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo comparar.' }); },
    });
  }
  otherBudgets(): BudgetHeader[] { const id = this.selected()?.id; return this.budgets().filter((x) => x.id !== id); }

  openProjection(): void {
    const b = this.selected(); if (!b) return;
    this.projection.set(null); this.loadingProj.set(true); this.projVisible = true;
    this.http.get<Projection>(`${this.base}/budgets/${b.id}/projection`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => { this.projection.set(p); this.loadingProj.set(false); },
      error: () => { this.loadingProj.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo calcular la proyección.' }); },
    });
  }
  compareSeverity(estado: string): 'secondary' | 'info' | 'warn' { return estado === 'igual' ? 'secondary' : estado === 'cambio' ? 'warn' : 'info'; }

  // ── Gasto operativo ──
  gastoLines(): BudgetLine[] { return this.lines().filter((l) => l.line_type === 'gasto'); }
  gastoKpis(): MetricStripItem[] {
    const g = this.gastoLines();
    const sum = (f: (l: BudgetLine) => number) => Math.round(g.reduce((s, l) => s + f(l), 0) * 100) / 100;
    const vigente = sum((l) => Number(l.vigente_amount));
    const usado = sum((l) => Number(l.reserved_amount) + Number(l.committed_amount) + Number(l.exercised_amount));
    const disponible = Math.round((vigente - usado) * 100) / 100;
    return [
      { label: 'Presupuesto gasto', value: vigente, format: 'currency-short' },
      { label: 'Comprometido + ejercido', value: sum((l) => Number(l.committed_amount) + Number(l.exercised_amount)), format: 'currency-short' },
      { label: 'Disponible', value: disponible, format: 'currency-short', tone: disponible < 0 ? 'bad' : 'ok' },
      { label: 'Ocupación', value: vigente > 0 ? Math.round((usado / vigente) * 1000) / 10 : 0, format: vigente > 0 ? 'percent' : 'text', sub: vigente > 0 ? undefined : 'sin base' },
    ];
  }
  openNewGasto(): void { this.gastoForm = { control_level: 'bloqueo' }; this.newGastoVisible = true; }
  confirmNewGasto(): void {
    const b = this.selected(); if (!b) return;
    if (!this.gastoForm.concept?.trim() || !(Number(this.gastoForm.original_amount) >= 0)) {
      this.toast.add({ severity: 'warn', summary: 'Faltan datos', detail: 'Concepto e importe son requeridos.' }); return;
    }
    this.savingGasto.set(true);
    this.http.post(`${this.base}/budgets/${b.id}/lines`, { ...this.gastoForm, line_type: 'gasto' }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.savingGasto.set(false); this.newGastoVisible = false; this.reloadDetail(); this.toast.add({ severity: 'success', summary: 'Agregado', detail: 'Gasto operativo registrado.' }); },
      error: (e) => { this.savingGasto.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo agregar.' }); },
    });
  }
  classLabel(c: string | null): string { return c === 'fijo' ? 'Fijo' : c === 'variable' ? 'Variable' : '—'; }
  recurrenceLabel(r: string | null): string { return r === 'recurrente' ? 'Recurrente' : r === 'no_recurrente' ? 'No recurrente' : '—'; }

  // ── PVG: presupuesto de gastos auto-propuesto desde egresos de Kepler ──
  expensePlan = signal<ExpensePlan | null>(null);
  loadingExpense = signal(false);
  expenseProposeVisible = false;
  savingExpensePropose = signal(false);
  loadingExpenseProposal = signal(false);
  expenseGrowthProposal = signal<ExpenseGrowthProposal | null>(null);
  lastExpenseCoverage = signal<ExpenseCoverage | null>(null);
  expenseDefaultGrowth: number | null = 8;
  expenseFamilies = '6';
  expenseBySucursal = false;
  expenseOverwriteManual = false;

  gpct(x: number): string { return (Number(x || 0) * 100).toFixed(1) + '%'; }

  loadExpensePlan(): void {
    const b = this.selected(); if (!b) { this.expensePlan.set(null); return; }
    this.loadingExpense.set(true);
    this.http.get<ExpensePlan>(`${this.base}/budgets/${b.id}/expense-plan`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => { this.expensePlan.set(p); this.loadingExpense.set(false); },
      error: () => { this.loadingExpense.set(false); },
    });
  }

  /** Agrega la rejilla propuesta (cuenta × sucursal × mes) a una fila por cuenta con Σ anual. */
  expenseByAccount(): Array<{ account_code: string; account_name: string; familia: string; sucursal: string; method: string; anual: number; months: number }> {
    const p = this.expensePlan(); if (!p) return [];
    const m = new Map<string, { account_code: string; account_name: string; familia: string; sucursal: string; methods: Set<string>; anual: number; months: number }>();
    for (const l of p.lines) {
      const key = l.account_code + '|' + (l.sucursal || '');
      if (!m.has(key)) m.set(key, { account_code: l.account_code, account_name: l.account_name || l.account_code, familia: l.familia || '', sucursal: l.sucursal || '', methods: new Set(), anual: 0, months: 0 });
      const g = m.get(key)!; g.anual += Number(l.monto) || 0; g.months++; g.methods.add(l.method);
    }
    return [...m.values()].map((g) => ({
      account_code: g.account_code, account_name: g.account_name, familia: g.familia, sucursal: g.sucursal,
      method: g.methods.has('manual') ? 'mixto/manual' : (g.methods.has('estacional') ? 'híbrido' : 'histórico'),
      anual: g.anual, months: g.months,
    })).sort((a, b) => b.anual - a.anual);
  }
  expenseTotal(): number { const p = this.expensePlan(); return p ? p.lines.reduce((s, l) => s + (Number(l.monto) || 0), 0) : 0; }

  openExpensePropose(): void {
    const b = this.selected(); if (!b) return;
    this.expenseOverwriteManual = false;
    this.loadingExpenseProposal.set(true);
    this.expenseProposeVisible = true;
    this.http.get<ExpenseGrowthProposal>(`${this.base}/budgets/${b.id}/expense-plan/propose-growth`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => {
        this.expenseGrowthProposal.set(p);
        this.expenseFamilies = (p.families || ['6']).join(',');
        this.expenseDefaultGrowth = Math.round((p.global?.growth_pct || 0) * 1000) / 10;
        this.loadingExpenseProposal.set(false);
      },
      error: (e) => { this.loadingExpenseProposal.set(false); this.expenseProposeVisible = false; this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo calcular la tendencia de gastos.' }); },
    });
  }

  confirmExpensePropose(): void {
    const b = this.selected(); if (!b) return;
    const families = this.expenseFamilies.split(',').map((s) => s.trim()).filter(Boolean);
    this.savingExpensePropose.set(true);
    this.http.post<{ coverage: ExpenseCoverage; prior_year: number }>(`${this.base}/budgets/${b.id}/expense-plan/propose`,
      { default_growth_pct: (Number(this.expenseDefaultGrowth) || 0) / 100, families, by_sucursal: this.expenseBySucursal, overwrite_manual: this.expenseOverwriteManual })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.savingExpensePropose.set(false); this.expenseProposeVisible = false; this.lastExpenseCoverage.set(r.coverage);
          this.loadExpensePlan();
          const c = r.coverage;
          this.toast.add({ severity: 'success', summary: 'Gastos propuestos', detail: `${c.accounts} cuentas · ${c.historico_ajustado} histórico · ${c.estacional} recurrente · ${c.no_signal} sin señal · ${c.manual_kept} manual.` });
        },
        error: (e) => { this.savingExpensePropose.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo proponer el presupuesto de gastos.' }); },
      });
  }

  // ── Presupuesto de ventas (PV) ──
  loadSalesComparison(): void {
    const b = this.selected(); if (!b) { this.salesCmp.set(null); return; }
    this.loadingSales.set(true);
    this.http.get<SalesComparison>(`${this.base}/budgets/${b.id}/sales-comparison`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (c) => { this.salesCmp.set(c); this.loadingSales.set(false); },
      error: (e) => { this.loadingSales.set(false); this.salesCmp.set(null); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo cargar el presupuesto de ventas.' }); },
    });
  }

  salesKpis(c: SalesComparison): MetricStripItem[] {
    // [PU.V6] El total NO se rotula «Meta total» a secas cuando cubre parte del año. Medido en
    // prod: el «Presupuesto 2027» publicaba $604.8M y eran 10 de 13 períodos — los tres que
    // faltaban (nov–ene) valieron $166.6M en 2025 y son los MEJORES del año. El motor hizo bien
    // en no inventarlos; lo que estaba mal era presentar el subtotal como si fuera el ejercicio.
    const per = c.periodos;
    const parcial = per != null && per.completo === false;
    return [
      {
        label: parcial ? `Meta de ${per.con_meta} de ${per.del_anio} períodos` : 'Meta total',
        value: c.totals.meta, format: 'currency-short',
        sub: parcial ? `faltan ${per.sin_meta.join(', ')} — sin base aún` : undefined,
        tone: parcial ? 'warn' : undefined,
      },
      { label: 'Real', value: c.totals.real == null ? '—' : c.totals.real, format: c.totals.real == null ? 'text' : 'currency-short', sub: c.totals.real == null ? 'sin datos' : undefined },
      { label: 'Cumplimiento', value: c.totals.cumplimiento_pct ?? 0, format: c.totals.cumplimiento_pct == null ? 'text' : 'percent', sub: c.totals.cumplimiento_pct == null ? 's/meta' : undefined, tone: c.totals.cumplimiento_pct != null && c.totals.cumplimiento_pct >= 100 ? 'ok' : undefined },
      { label: `CREC vs ${c.prior_year}`, value: c.totals.crec_pct ?? 0, format: c.totals.crec_pct == null ? 'text' : 'percent', sub: c.totals.crec_pct == null ? 's/base' : undefined, tone: c.totals.crec_pct != null && c.totals.crec_pct < 0 ? 'bad' : undefined },
    ];
  }

  /** Pivote entidad × periodo → filas por entidad (o del periodo elegido) + subtotales por canal + total. */
  salesRows(): SalesRow[] {
    const c = this.salesCmp(); if (!c) return [];
    const period = this.salesPeriod;
    const cells = period > 0 ? c.cells.filter((x) => x.period_no === period) : c.cells;
    // total real del alcance mostrado (para PART)
    const scopeReal = cells.reduce((s, x) => s + (x.real ?? 0), 0);
    // agregar por entidad
    const byEntity = new Map<string, { label: string; channel: string; channel_label: string; meta: number | null; real: number | null; prior: number | null; methods: Set<string> }>();
    for (const x of cells) {
      let e = byEntity.get(x.entity_key);
      if (!e) { e = { label: x.branch_name || x.warehouse_code, channel: x.channel, channel_label: x.channel_label, meta: null, real: null, prior: null, methods: new Set() }; byEntity.set(x.entity_key, e); }
      if (x.meta != null) e.meta = (e.meta ?? 0) + x.meta;
      if (x.real != null) e.real = (e.real ?? 0) + x.real;
      if (x.real_prior != null) e.prior = (e.prior ?? 0) + x.real_prior;
      if (x.method) e.methods.add(x.method);
    }
    const rowMethod = (ms: Set<string>): string | null => (ms.size === 0 ? null : ms.size === 1 ? [...ms][0] : 'mixto');
    const pct = (n: number | null, d: number | null) => (n == null || d == null || d === 0 ? null : Math.round((n / d) * 1000) / 10);
    // «Sin datos» ≠ cero (ADR-056): sin real (r=null) el CREC es desconocido, NO −100%.
    const crec = (r: number | null, p: number | null) => (r == null || p == null || p === 0 ? null : Math.round((((r - p) / p) * 100) * 10) / 10);
    const rows: SalesRow[] = [];
    const entries = [...byEntity.entries()];
    // [VSO.8] Se recorren TODOS los canales PRESENTES, ordenados por un orden conocido y con lo
    // desconocido al final — **nunca se descarta uno**. Antes esto era la lista literal
    // `['mostrador','credito','ruta','preventa']`, y como el bucle FILTRA por ella, las entidades
    // de canal `mayoreo` y `contado_nf` no producían renglón. Medido en prod el 2026-09-28: eran
    // **$21,754,366 de meta capturada** que esta pantalla no pintaba. Un canal nuevo entra solo.
    const ORDEN = ['mostrador', 'contado_nf', 'credito', 'mayoreo', 'ruta', 'preventa'];
    const pos = (c: string) => { const i = ORDEN.indexOf(c); return i < 0 ? ORDEN.length : i; };
    const channelOrder = entries.map(([, e]) => e.channel)
      .filter((v, i, a) => a.indexOf(v) === i)   // dedup sin spread de Set (bundle lo downlevelea mal)
      .sort((a, b) => (pos(a) - pos(b)) || String(a).localeCompare(String(b)));
    for (const ch of channelOrder) {
      const inCh = entries.filter(([, e]) => e.channel === ch);
      if (!inCh.length) continue;
      for (const [ek, e] of inCh) {
        rows.push({ label: e.label, channel_label: e.channel_label, entity_key: ek, is_rollup: false,
          meta: e.meta, real: e.real, cumplimiento_pct: pct(e.real, e.meta), crec_pct: crec(e.real, e.prior), part_pct: pct(e.real, scopeReal), method: rowMethod(e.methods) });
      }
      // subtotal por canal — real NULL si ningún miembro tiene real (no 0 falso → CREC/PART correctos)
      const sMeta = inCh.reduce((s, [, e]) => s + (e.meta ?? 0), 0);
      const sReal = inCh.some(([, e]) => e.real != null) ? inCh.reduce((s, [, e]) => s + (e.real ?? 0), 0) : null;
      const sPrior = inCh.reduce((s, [, e]) => s + (e.prior ?? 0), 0);
      rows.push({ label: `Subtotal ${inCh[0][1].channel_label}`, channel_label: '', entity_key: null, is_rollup: true,
        meta: sMeta, real: sReal, cumplimiento_pct: pct(sReal, sMeta), crec_pct: crec(sReal, sPrior), part_pct: pct(sReal, scopeReal), method: null });
    }
    // total general
    const tMeta = entries.reduce((s, [, e]) => s + (e.meta ?? 0), 0);
    const tReal = entries.some(([, e]) => e.real != null) ? entries.reduce((s, [, e]) => s + (e.real ?? 0), 0) : null;
    const tPrior = entries.reduce((s, [, e]) => s + (e.prior ?? 0), 0);
    rows.push({ label: 'Total Venta', channel_label: '', entity_key: null, is_rollup: true,
      meta: tMeta, real: tReal, cumplimiento_pct: pct(tReal, tMeta), crec_pct: crec(tReal, tPrior), part_pct: tReal != null && tReal > 0 ? 100 : null, method: null });
    return rows;
  }

  openGenPlan(): void { this.genGrowthPct = 10; this.genOverwriteManual = false; this.genPlanVisible = true; }
  confirmGenPlan(): void {
    const b = this.selected(); if (!b) return;
    const g = Number(this.genGrowthPct);
    if (!Number.isFinite(g)) { this.toast.add({ severity: 'warn', summary: 'Falta', detail: 'Ingresá el crecimiento objetivo.' }); return; }
    this.savingGen.set(true);
    this.http.post<{ generated: number; entities_with_base: number; prior_year: number }>(`${this.base}/budgets/${b.id}/sales-plan/generate`,
      { growth_pct: g / 100, overwrite_manual: this.genOverwriteManual }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.savingGen.set(false); this.genPlanVisible = false; this.loadSalesComparison(); this.toast.add({ severity: 'success', summary: 'Generado', detail: `${r.generated} metas desde el real ${r.prior_year}.` }); },
      error: (e) => { this.savingGen.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo generar.' }); },
    });
  }

  openMetaEdit(r: SalesRow): void { this.metaEditRow.set(r); this.metaEditAmount = r.meta; this.metaEditVisible = true; }
  confirmMetaEdit(): void {
    const b = this.selected(); const r = this.metaEditRow(); if (!b || !r || !r.entity_key) return;
    if (!(Number(this.metaEditAmount) >= 0)) { this.toast.add({ severity: 'warn', summary: 'Falta', detail: 'Ingresá una meta válida (≥ 0).' }); return; }
    this.savingMeta.set(true);
    this.http.post(`${this.base}/budgets/${b.id}/sales-plan/line`, { entity_key: r.entity_key, period_no: this.salesPeriod, meta_amount: Number(this.metaEditAmount) }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.savingMeta.set(false); this.metaEditVisible = false; this.loadSalesComparison(); this.toast.add({ severity: 'success', summary: 'Guardada', detail: 'Meta capturada.' }); },
      error: (e) => { this.savingMeta.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo guardar.' }); },
    });
  }

  // ── PVA — automatización (el sistema propone, el humano ajusta) ──
  setSalesTab(t: 'plan' | 'indicadores' | 'conciliacion'): void {
    this.salesTab.set(t);
    if (t === 'indicadores' && !this.indicators()) this.loadIndicators();
    if (t === 'conciliacion' && !this.reconciliation()) this.loadReconciliation();
    // `[VE.3]` Las otras dos pestañas ya se cargaban solas; «Plan» era la única que exigía
    // apretar «Cargar meta vs real» para ver el real al lado de la meta — justo la comparación
    // que da sentido a la pestaña.
    if (t === 'plan' && !this.salesCmp()) this.loadSalesComparison();
  }
  statusLabel(s: string): string { return s === 'concilia' ? 'Concilia' : s === 'revisar' ? 'Revisar' : s === 'sin_facturacion' ? 'Sin facturación' : s === 'sin_sellout' ? 'Sin sell-out' : s; }
  loadReconciliation(): void {
    this.loadingReconciliation.set(true);
    this.http.get<SalesReconciliation>(`${this.base}/sales-reconciliation`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.reconciliation.set(r); this.loadingReconciliation.set(false); },
      error: (e) => { this.loadingReconciliation.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo cargar la conciliación.' }); },
    });
  }

  methodLabel(m: string | null): string {
    return m === 'historico_ajustado' ? 'Histórico' : m === 'estacional' ? 'Estacional' : m === 'proxy_canal' ? 'Proxy canal' : m === 'sin_base_declarado' ? 'Sin base' : m === 'manual' ? 'Manual' : m === 'mixto' ? 'Mixto' : '—';
  }

  /**
   * `[PVI.2]` El desglose en DINERO, o `null` si la API no lo emite.
   *
   * ⛔ Devuelve `null` —no un objeto en ceros— a propósito: la pantalla tiene que poder distinguir
   * «la cobertura en dinero vale cero» de «no la pude medir». Un objeto relleno de ceros colapsa
   * las dos cosas y es la forma exacta del defecto que esto viene a corregir (ADR-056).
   */
  covEnDinero(cov: ProposeCoverage): ProposeCoverage['coverage_monto'] | null {
    const m = cov.coverage_monto;
    return m && typeof m.historico_ajustado === 'number' ? m : null;
  }

  /**
   * `[PVI.2]` El aviso del proxy, sólo cuando hay proxy y su monto se pudo medir.
   *
   * ⭐ Dice **de dónde sale** la cifra, no sólo que es estimada: el proxy reparte el promedio de
   * OTRAS entidades del canal, en partes iguales, a entidades sin historia propia. Medido en prod:
   * 8 entidades recibieron $197,160,564 contra $19,063,383 de venta real — 10.3×, y en el extremo
   * una recibió 2,860× lo suyo. Un «estimado» genérico no deja ver eso; el método sí.
   */
  proxyAviso(cov: ProposeCoverage): string | null {
    const m = this.covEnDinero(cov);
    if (!m || !(m.proxy_canal > 0)) return null;
    const pct = cov.proxy_canal_pct;
    const parte = typeof pct === 'number' ? `${(pct * 100).toFixed(1)} % de la meta` : `${this.money(m.proxy_canal)} de la meta`;
    return `${parte} se repartió con el PROMEDIO DE OTRAS entidades del canal, no con historia propia. `
      + `Son ${cov.proxy_canal} celdas sin base: la entidad no aporta ninguna señal y su monto sale del canal.`;
  }
  basisLabel(b: string): string {
    return b === 'yoy_paired' ? 'tendencia histórica' : b === 'global' ? 'tendencia global' : 'default (sin tendencia confiable)';
  }

  openProposePlan(): void {
    const b = this.selected(); if (!b) return;
    this.proposeOverwriteManual = false;
    this.loadingProposal.set(true);
    this.proposeVisible = true;
    this.http.get<GrowthProposal>(`${this.base}/budgets/${b.id}/sales-plan/propose-growth`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => {
        this.proposal.set(p);
        // [VSO.8] Los canales salen de lo que el backend DEVOLVIÓ, no de una lista de acá: con la
        // lista literal, una propuesta de crecimiento para `mayoreo` se calculaba y no se mostraba.
        const ORDENP = ['mostrador', 'contado_nf', 'credito', 'mayoreo', 'ruta', 'preventa'];
        const posP = (c: string) => { const i = ORDENP.indexOf(c); return i < 0 ? ORDENP.length : i; };
        const labels: Record<string, string> = { mostrador: 'Mostrador', credito: 'Mayoreo / Crédito', ruta: 'Ruta directa (RD)', preventa: 'Vecinal / Preventa' };
        const order = Object.keys(p.by_channel || {}).sort((a, b) => (posP(a) - posP(b)) || a.localeCompare(b));
        this.growthRows.set(order.filter((ch) => p.by_channel[ch]).map((ch) => ({
          channel: ch, channel_label: labels[ch] || ch,
          growth_pct: Math.round((p.by_channel[ch].growth_pct || 0) * 1000) / 10, // fracción → %
          basis: p.by_channel[ch].basis, paired_periods: p.by_channel[ch].paired_periods,
        })));
        this.proposeDefaultGrowth = Math.round((p.global.growth_pct || 0) * 1000) / 10;
        this.loadingProposal.set(false);
      },
      error: (e) => { this.loadingProposal.set(false); this.proposeVisible = false; this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo calcular la propuesta de crecimiento.' }); },
    });
  }

  confirmProposePlan(): void {
    const b = this.selected(); if (!b) return;
    const growthByChannel: Record<string, number> = {};
    for (const r of this.growthRows()) growthByChannel[r.channel] = (Number(r.growth_pct) || 0) / 100; // % → fracción
    this.savingPropose.set(true);
    this.http.post<{ coverage: ProposeCoverage; prior_year: number }>(`${this.base}/budgets/${b.id}/sales-plan/propose`,
      { growth_by_channel: growthByChannel, default_growth_pct: (Number(this.proposeDefaultGrowth) || 0) / 100, overwrite_manual: this.proposeOverwriteManual })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.savingPropose.set(false); this.proposeVisible = false; this.lastCoverage.set(r.coverage);
          this.loadSalesComparison(); this.indicators.set(null);
          const c = r.coverage;
          this.toast.add({ severity: 'success', summary: 'Plan propuesto', detail: `${c.historico_ajustado} histórico · ${c.estacional} estacional · ${c.proxy_canal} proxy · ${c.sin_base_declarado} sin base · ${c.no_signal} sin señal · ${c.manual_kept} manual.` });
        },
        error: (e) => { this.savingPropose.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo proponer el plan.' }); },
      });
  }

  projecting = signal(false);
  projectTargets(): void {
    const b = this.selected(); if (!b) return;
    this.projecting.set(true);
    this.http.post<{ projected: number; months: number; lines: number; note?: string }>(`${this.base}/budgets/${b.id}/sales-plan/project-targets`, {})
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.projecting.set(false);
          if (r.note === 'plan vacío' || !r.lines) {
            this.toast.add({ severity: 'warn', summary: 'Sin plan', detail: 'No hay metas capturadas para proyectar. Armá el plan primero.' });
          } else {
            this.toast.add({ severity: 'success', summary: 'Proyectado a Análisis', detail: `${r.projected} metas mensuales (scope×mes) desde ${r.lines} celdas del plan · ${r.months} meses. Ya se ve en el «vs objetivo» de Análisis.` });
          }
        },
        error: (e) => { this.projecting.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo proyectar el plan a las metas de Análisis.' }); },
      });
  }

  // ══════════ PR.5 (ADR-074): interfaz automática ══════════

  // ── Supuestos del año (consolida las perillas de ventas + gastos) ──
  loadingAssump = signal(false); savingAssump = signal(false); assumpLoaded = signal(false);
  /** [VSO.8] Lo declara el backend (`sales-plan/settings.channels`, derivado de `v_sales_entity`).
   *  Esta lista es sólo el respaldo del primer pintado: cuando era la fuente, las perillas de
   *  crecimiento no alcanzaban a `mayoreo` ni a `contado_nf`, y al GUARDAR (`gbc`) tampoco los
   *  escribía — o sea que ni siquiera se podía fijar un supuesto para ellos. */
  channelsList: string[] = ['mostrador', 'credito', 'ruta', 'preventa'];
  channelLabels: Record<string, string> = {};
  // `[VE.7.2]` `number | null` porque un canal SIN supuesto propio se declara, no cae al respaldo
  // en silencio. Y arranca VACÍO: la semilla era `{ mostrador: 8, credito: 8, ruta: 8, preventa: 8 }`
  // — un 8 % inventado en cuatro canales, uno de ellos (`credito`) muerto desde el 2026-09-18. El
  // vocabulario lo trae el backend desde `v_sales_entity`; sembrarlo acá era adivinarlo.
  asVentasGrowth: Record<string, number | null> = {};
  asVentasDefault: number | null = 8;
  // `[PU.VA]` Arranca en `null`, no en 8: ese 8 era un número inventado que se mostraba como si el
  // sistema lo hubiera medido —el mismo pecado que `[VE.7.2]` ya había sacado de los canales— y
  // sobrevivía acá porque si `propose-growth` falla, el `error:` del suscriptor no lo toca.
  asGastosDefault: number | null = null;
  /** `yoy_paired` = medido contra la historia · `default` = no se pudo medir. Lo manda el servicio. */
  asGastosBasis: string | null = null;
  asGastosMotivo = '';
  asGastosFamilies = '6';
  asGastosBySucursal = false;
  asGastosControl: 'informativo' | 'advertencia' | 'bloqueo' = 'advertencia';

  loadAssumptions(): void {
    const b = this.selected(); if (!b) return;
    this.loadingAssump.set(true);
    this.http.get<{ default_growth_pct: number; growth_by_channel: Record<string, number>; channels?: { value: string; label: string }[] }>(`${this.base}/budgets/${b.id}/sales-plan/settings`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => {
        // [VSO.8] El vocabulario llega del backend; el respaldo local queda sólo si no vino.
        if (s.channels?.length) {
          this.channelsList = s.channels.map((c) => c.value);
          this.channelLabels = {}; for (const c of s.channels) this.channelLabels[c.value] = c.label;
        }
        this.asVentasDefault = Math.round((Number(s.default_growth_pct) || 0) * 1000) / 10;
        const g = s.growth_by_channel || {};
        // `[VE.7.1]` Un canal SIN supuesto propio queda en `null`, no cae al respaldo en silencio.
        // Antes mostraba el default como si fuera su cifra: `mayoreo` exhibía 2.6 % cuando su
        // valor derivado es −8.4 %, y nada en pantalla decía que ese 2.6 % era genérico.
        for (const ch of this.channelsList) this.asVentasGrowth[ch] = g[ch] != null ? Math.round(Number(g[ch]) * 1000) / 10 : null;
        this.assumpLoaded.set(true); this.loadingAssump.set(false);
        // `[PU.VA]` Campos planos + OnPush: sin esto el dato llega y la vista no se entera.
        this.cdr.markForCheck();
        // `[VE.4]` Si el ejercicio todavía no tiene supuestos, la pantalla mostraba 0 % en todos
        // los canales y había que apretar «Sugerir» para ver la propuesta del histórico. Un cero
        // de ausencia se lee como una decisión (ADR-056), y acá además era la que alimenta todo
        // el plan. Se sugiere solo, y SÓLO si está todo en cero: si alguien ya configuró algo
        // —aunque sea un canal—, no se le pisa el formulario.
        // ⚠️ Sugerir NO guarda: `saveAssumptions` es el acto explícito. Esto llena la pantalla,
        // no el presupuesto.
        const vacio = !this.asVentasDefault
          && this.channelsList.every((ch) => !this.asVentasGrowth[ch]);
        if (vacio) this.suggestAssumptions();
      },
      error: () => this.loadingAssump.set(false),
    });
    this.http.get<{ default_growth_pct: number; proposal_families: string[]; by_sucursal: boolean; control_level?: 'informativo' | 'advertencia' | 'bloqueo'; exists?: boolean }>(`${this.base}/budgets/${b.id}/expense-plan/settings`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => {
        // `[PU.VA]` ⛔ El servicio devuelve `default_growth_pct: 0, exists: false` cuando NO HAY
        // fila de supuestos — y en prod esa tabla tiene **cero filas**. El `|| 0` de acá convertía
        // esa ausencia en un «0 %» que la pantalla presentaba bajo el rótulo «los calcula el
        // sistema desde la historia». Si no existe, no se pinta: lo llena `suggestAssumptions()`,
        // que sí trae el `basis`.
        this.asGastosDefault = s.exists === false ? null : Math.round((Number(s.default_growth_pct) || 0) * 1000) / 10;
        this.asGastosBasis = s.exists === false ? null : 'guardado';
        this.asGastosFamilies = (s.proposal_families || ['6']).join(',');
        this.asGastosBySucursal = !!s.by_sucursal;
        this.asGastosControl = s.control_level || 'advertencia';
        this.cdr.markForCheck();
      },
      error: () => { /* declara defaults */ },
    });
  }

  // Estima el crecimiento desde la historia y llena los supuestos (no guarda — el humano revisa y Guarda).
  // Reusa los motores PVA: ventas = YoY del sell-out por canal; gastos = tendencia de egresos Kepler.
  suggestingAssump = signal(false);
  suggestAssumptions(): void {
    const b = this.selected(); if (!b) return;
    this.suggestingAssump.set(true);
    let pending = 2; const done = () => { if (--pending === 0) this.suggestingAssump.set(false); };
    this.http.get<GrowthProposal>(`${this.base}/budgets/${b.id}/sales-plan/propose-growth`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => {
        const g = Math.round((p.global?.growth_pct || 0) * 1000) / 10; // fracción → %
        this.asVentasDefault = g;
        // `[VE.7.2]` Un canal sin base propia queda en `null` — antes se le copiaba el global `g`,
        // que es cómo Mayoreo terminaba exhibiendo 2.6 % con aspecto de cifra calculada. El
        // «· respaldo» de la pantalla sale justamente de este null.
        for (const ch of this.channelsList) { const c = p.by_channel?.[ch]; this.asVentasGrowth[ch] = c && c.basis === 'yoy_paired' ? Math.round((c.growth_pct || 0) * 1000) / 10 : null; }
        const yoy = Object.values(p.by_channel || {}).filter((c) => c.basis === 'yoy_paired').length;
        this.toast.add({ severity: 'success', summary: 'Crecimiento calculado', detail: `${yoy} canal(es) con base histórica año-contra-año; el resto usa el respaldo y así se muestra.` });
        // `[PU.VA]` Acá el repintado venía de rebote, por los signals del toast y de
        // `suggestingAssump`. Que funcione por un efecto lateral no es que funcione: se pide.
        this.cdr.markForCheck();
        done();
      },
      error: (e) => { this.toast.add({ severity: 'warn', summary: 'Ventas', detail: e?.error?.message || 'Sin historia suficiente para estimar el crecimiento de ventas.' }); done(); },
    });
    this.http.get<ExpenseGrowthProposal>(`${this.base}/budgets/${b.id}/expense-plan/propose-growth`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => {
        // `[PU.VA]` El `basis` viaja junto al número y decide cómo se pinta. Un `|| 0` suelto acá
        // convertía «no se pudo medir» en «medí cero», que es lo que la pantalla publicaba.
        const g = p.global;
        this.asGastosBasis = g?.basis ?? null;
        this.asGastosDefault = g?.growth_pct == null ? null : Math.round(Number(g.growth_pct) * 1000) / 10;
        this.asGastosMotivo = g?.basis === 'yoy_paired'
          ? `Año contra año sobre ${g.paired_months} mes(es) apareado(s) y cerrados.`
          : `Sin par de años suficiente (${g?.paired_months ?? 0} mes(es) apareado(s); hacen falta ${p.min_paired_months ?? 4}). Se usa el respaldo guardado.`;
        done();
        this.cdr.markForCheck();
      },
      // Que falle la estimación NO puede dejar en pantalla el número anterior como si fuera nuevo.
      error: () => { this.asGastosBasis = null; this.asGastosDefault = null; this.asGastosMotivo = 'No se pudo consultar la historia de egresos.'; done(); },
    });
  }

  saveAssumptions(): void {
    const b = this.selected(); if (!b) return;
    this.savingAssump.set(true);
    const families = this.asGastosFamilies.split(',').map((s) => s.trim()).filter(Boolean);
    // `[VE.7]` Guarda SÓLO la política. ⛔ Antes mandaba también `growth_by_channel` con lo que
    // hubiera en pantalla, y ahora eso sería un bug grave: el piloto respeta todo canal que ya
    // tenga valor guardado (misma regla que `method='manual'`), así que apretar «Guardar» una vez
    // CONGELARÍA los supuestos derivados para siempre — el presupuesto dejaría de actualizarse
    // solo sin que nadie se entere. El crecimiento lo escribe la pasada nocturna, no esta pantalla.
    this.http.put(`${this.base}/budgets/${b.id}/expense-plan/settings`, { proposal_families: families, by_sucursal: this.asGastosBySucursal, control_level: this.asGastosControl }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.savingAssump.set(false); this.toast.add({ severity: 'success', summary: 'Política guardada', detail: 'El crecimiento lo sigue calculando el sistema desde la historia.' }); },
      error: (e) => { this.savingAssump.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo guardar la política de gastos.' }); },
    });
  }

  // ── `[PU.R]` Estado de resultados: PLAN contra REAL, renglón por renglón ──
  //
  // ⛔ Antes esto era `ingresos − egresos` y sobre el ejercicio FY2027 real publicaba
  // $468,804,497.42 con 100 % de margen: a la fórmula le faltaba el costo de ventas (el 88 % del
  // egreso) y el plan de gastos está vacío. Ahora el tipo lo manda el contrato y cada celda puede
  // venir en `null` — que es lo que hay que poder leer: dónde NO hay con qué medir.
  resultado = signal<BudgetResult | null>(null);
  loadingResultado = signal(false);
  /** Los cinco renglones del P&L, en orden de lectura. Se arma acá para no repetir la tabla. */
  readonly pnlRenglones: Array<{ key: keyof BudgetResultMonth & keyof BudgetResultAnnual; label: string; fuerte?: boolean; resta?: boolean }> = [
    { key: 'venta', label: 'Venta' },
    { key: 'costo_ventas', label: 'Costo de ventas', resta: true },
    { key: 'margen_bruto', label: 'Margen bruto', fuerte: true },
    { key: 'gasto_operativo', label: 'Gasto operativo', resta: true },
    { key: 'financieros', label: 'Gastos financieros e impuestos', resta: true },
    { key: 'resultado', label: 'Resultado', fuerte: true },
  ];
  /** `null` se DECLARA, no se dibuja como cero: es la diferencia entre «no hay» y «dio cero». */
  celda(c: { plan: number | null; real: number | null } | undefined, lado: 'plan' | 'real'): string {
    const v = c ? c[lado] : null;
    return v === null || v === undefined ? '—' : this.money(v);
  }
  cel(m: BudgetResultMonth | BudgetResultAnnual, k: string): { plan: number | null; real: number | null } {
    return (m as unknown as Record<string, { plan: number | null; real: number | null }>)[k];
  }
  /** Cumplimiento. Sin denominador NO hay porcentaje — ni 0 ni 100. */
  pctOf(num: number | null, den: number | null): number | null {
    return num === null || den === null || den === 0 ? null : Math.round((num / den) * 1000) / 10;
  }
  loadResultado(): void {
    const b = this.selected(); if (!b) { this.resultado.set(null); return; }
    this.loadingResultado.set(true);
    this.http.get<BudgetResult>(`${this.base}/budgets/${b.id}/resultado`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.resultado.set(r); this.loadingResultado.set(false); },
      error: () => this.loadingResultado.set(false),
    });
  }

  /**
   * `[VP.MS]` **Capacidad de pago — la respuesta arriba, y el rótulo que evita leerla como dinero.**
   *
   * ⛔ `budget.daily_capacity.authorized_amount` es un **tope que pone un humano**, no un saldo.
   * Cruzarlo contra obligaciones responde *¿alcanza el permiso?*, nunca *¿alcanza la plata?*.
   * Si se publica junto al saldo bancario sin rotularlo, se lee como liquidez.
   *
   * ⚠️ Y la propuesta **deriva del tramo de cartera con vencimiento futuro**, que es una
   * fracción: por eso sale `parcial` con su cobertura, no como cifra cerrada.
   */
  capacidadKpis(): MetricStripItem[] {
    const p = this.capProposal();
    const cc = p?.cobranza_cobertura;
    const dias = p?.items?.length ?? 0;
    const total = this.capProposalTotal();
    const cur = this.currentCapacity();
    const fuera = cc && cc.vencido_fuera > 0
      ? `${this.money(cc.vencido_fuera)} de cartera vencida no sostiene esta propuesta: es exigible, pero sin fecha`
      : undefined;
    return [
      p?.available
        ? { label: 'Capacidad propuesta', value: total, format: 'currency-short', state: 'parcial', stateNote: fuera }
        : { label: 'Capacidad propuesta', value: '—', format: 'text', state: 'no_medido', stateNote: p?.reason || 'Todavía no se propuso capacidad para un rango' },
      p?.available && dias > 0
        ? { label: 'Por día hábil', value: total / dias, format: 'currency-short', state: 'parcial', stateNote: `Repartida entre ${dias} días hábiles del rango` }
        : { label: 'Por día hábil', value: '—', format: 'text', state: 'no_medido', stateNote: 'Sin propuesta no hay reparto por día' },
      cc
        ? { label: 'Cobranza que la sostiene', value: cc.en_ventana, format: 'currency-short', state: 'parcial',
            stateNote: cc.pct_en_ventana != null ? `Es el ${cc.pct_en_ventana}% de la cartera cobrable` : undefined }
        : { label: 'Cobranza que la sostiene', value: '—', format: 'text', state: 'no_medido', stateNote: 'La propuesta no trajo su cobertura' },
      // ⛔ NULL ≠ 0: un día sin fila es capacidad **no definida**, no cero. Leerlo como cero
      // fabrica una insolvencia que no existe — y hoy en prod son 57 de 57 días sin fila.
      cur
        ? { label: `Autorizado el ${this.capDate}`, value: cur.authorized_amount, format: 'currency-short', state: 'medido',
            stateNote: `Tope autorizado por ${cur.updated_by || 'alguien sin registrar'} — es un permiso, no un saldo` }
        : { label: `Autorizado el ${this.capDate}`, value: '—', format: 'text', state: 'no_medido',
            stateNote: 'Sin fila para ese día: capacidad NO DEFINIDA, que no es lo mismo que cero' },
    ];
  }

  /**
   * `[VP.MS]` **Obligaciones — qué entra al Calendario y qué no.**
   *
   * ⚠️ Sólo las **autorizadas** entran. La tabla mezclaba los dos universos sin totalizar
   * ninguno: con 312 filas nadie podía decir cuánto suma lo que de verdad va a pagarse.
   */
  obligacionesKpis(): MetricStripItem[] {
    const rows = this.expenses() ?? [];
    const sum = (f: (e: ExpenseObligation) => boolean) =>
      rows.filter(f).reduce((s, e) => s + (Number(e.available_amount) || 0), 0);
    const n = (f: (e: ExpenseObligation) => boolean) => rows.filter(f).length;
    const autorizada = (e: ExpenseObligation) => e.status === 'pending' || e.status === 'partial';
    return [
      { label: 'Autorizado — entra al Calendario', value: sum(autorizada), format: 'currency-short',
        state: 'medido', stateNote: `${n(autorizada)} obligaciones · disponible = original − reservado − pagado` },
      { label: 'Propuesto — NO entra', value: sum((e) => e.status === 'propuesta'), format: 'currency-short',
        state: 'medido', stateNote: `${n((e) => e.status === 'propuesta')} auto-generadas, esperando autorización` },
      { label: 'Ineludibles', value: sum((e) => e.is_critical && autorizada(e)), format: 'currency-short',
        state: 'medido', stateNote: `${n((e) => e.is_critical)} marcadas a mano con motivo. La criticidad NUNCA se infiere del importe` },
      // Medido el 2026-10-08: de las 312 filas de prod, 156 cuelgan del FY2027 real y 156 del
      // duplicado `is_test`. El endpoint NO devuelve de qué ejercicio viene cada una, así que
      // esto se DECLARA en vez de fabricarse. Autorizar una del duplicado la mete al Calendario.
      { label: 'Del ejercicio de prueba', value: '—', format: 'text', state: 'no_medido',
        stateNote: 'La lista no distingue el ejercicio de prueba: la obligación no trae su presupuesto. En prod la mitad de las filas son del duplicado' },
    ];
  }

  // ── Capacidad propuesta desde el flujo ──
  capProposeFrom = ''; capProposeTo = '';
  /**
   * `[VP.MS]` `cobranza_cobertura` y `base` **ya viajaban** desde `budget-capacity.service.ts`
   * y esta pantalla los tiraba: el tipo estaba copiado a mano y se quedó corto. Proponer
   * capacidad desde el 11.8% de la cartera sin decirlo es el mismo defecto que `[CXC.22]`
   * corrigió del lado del flujo.
   */
  capProposal = signal<{
    available: boolean; items: Array<{ date: string; amount: number; week: string; cobros_week: number }>;
    note?: string; reason?: string; base?: string; as_of?: string | null;
    cobranza_cobertura?: { en_ventana: number; vencido_fuera: number; posterior: number; sin_vencimiento: number; total: number; pct_en_ventana: number | null };
  } | null>(null);
  loadingCapProp = signal(false); confirmingCap = signal(false);
  proposeCapacity(): void {
    if (!this.capProposeFrom || !this.capProposeTo) { this.toast.add({ severity: 'warn', summary: 'Fechas', detail: 'Elegí desde y hasta.' }); return; }
    this.loadingCapProp.set(true);
    this.http.get<NonNullable<ReturnType<typeof this.capProposal>>>(`${this.base}/capacity/propose`, { params: { from: this.capProposeFrom, to: this.capProposeTo } }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.capProposal.set(r); this.loadingCapProp.set(false); },
      error: (e) => { this.loadingCapProp.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo proponer la capacidad.' }); },
    });
  }
  capProposalTotal(): number { const p = this.capProposal(); return p && p.items ? Math.round(p.items.reduce((s, i) => s + Number(i.amount), 0) * 100) / 100 : 0; }
  confirmCapacity(): void {
    const p = this.capProposal(); if (!p || !p.available || !p.items.length) return;
    this.confirmingCap.set(true);
    this.http.post<{ written: number }>(`${this.base}/capacity/confirm`, { items: p.items.map((i) => ({ date: i.date, amount: i.amount })), reason: 'Capacidad propuesta desde el flujo' }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.confirmingCap.set(false); this.capProposal.set(null); this.toast.add({ severity: 'success', summary: 'Capacidad confirmada', detail: `${r.written} días escritos.` }); this.loadCapacity(); },
      error: (e) => { this.confirmingCap.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo confirmar la capacidad.' }); },
    });
  }

  // ── Obligaciones auto-generadas del plan + autorización ──
  loadObligProposals(): void { this.loadExpenses(); }
  generatingOblig = signal(false); authorizingOblig = signal(false);
  obligSelected = new Set<string>();
  isObligSel(id: string): boolean { return this.obligSelected.has(id); }
  toggleOblig(id: string): void { if (this.obligSelected.has(id)) this.obligSelected.delete(id); else this.obligSelected.add(id); }
  generateObligFromPlan(): void {
    const b = this.selected(); if (!b) { this.toast.add({ severity: 'warn', summary: 'Ejercicio', detail: 'Elegí un ejercicio en «Ejercicio».' }); return; }
    this.generatingOblig.set(true);
    this.http.post<{ generated: number; updated: number; skipped: number; accounts_recurrent: number }>(`${this.base}/expenses/from-plan`, { budget_id: b.id }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.generatingOblig.set(false); this.toast.add({ severity: 'success', summary: 'Obligaciones generadas', detail: `${r.generated} nuevas · ${r.updated} actualizadas · ${r.skipped} sin cambio (${r.accounts_recurrent} cuentas recurrentes).` }); this.loadExpenses(); },
      error: (e) => { this.generatingOblig.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudieron generar las obligaciones.' }); },
    });
  }
  authorizeOblig(): void {
    const ids = [...this.obligSelected]; if (!ids.length) { this.toast.add({ severity: 'warn', summary: 'Selección', detail: 'Seleccioná obligaciones en estado propuesta.' }); return; }
    this.authorizingOblig.set(true);
    this.http.post<{ authorized: number; skipped: number }>(`${this.base}/expenses/authorize`, { ids }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.authorizingOblig.set(false); this.obligSelected.clear(); this.toast.add({ severity: 'success', summary: 'Autorizadas', detail: `${r.authorized} obligaciones autorizadas (entran al Calendario).` }); this.loadExpenses(); },
      error: (e) => { this.authorizingOblig.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudieron autorizar.' }); },
    });
  }

  // Proponer de un clic usando los supuestos guardados (PR.5: la perilla vive en «Supuestos del año»)
  runProposePlan(): void {
    const b = this.selected(); if (!b) return;
    this.savingPropose.set(true);
    this.http.post<{ coverage: ProposeCoverage }>(`${this.base}/budgets/${b.id}/sales-plan/propose`, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.savingPropose.set(false); this.lastCoverage.set(r.coverage); this.loadSalesComparison(); const c = r.coverage; this.toast.add({ severity: 'success', summary: 'Plan de ventas propuesto', detail: `${c.historico_ajustado} histórico · ${c.estacional} estacional · ${c.proxy_canal} proxy · ${c.sin_base_declarado} sin base · ${c.no_signal} sin señal · ${c.manual_kept} manual.` }); },
      error: (e) => { this.savingPropose.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo proponer el plan.' }); },
    });
  }
  runProposeExpense(): void {
    const b = this.selected(); if (!b) return;
    this.savingExpensePropose.set(true);
    this.http.post<{ coverage: ExpenseCoverage }>(`${this.base}/budgets/${b.id}/expense-plan/propose`, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.savingExpensePropose.set(false); this.lastExpenseCoverage.set(r.coverage); this.loadExpensePlan(); const c = r.coverage; this.toast.add({ severity: 'success', summary: 'Gastos propuestos', detail: `${c.accounts} cuentas · ${c.historico_ajustado} histórico · ${c.estacional} recurrente · ${c.no_signal} sin señal.` }); },
      error: (e) => { this.savingExpensePropose.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo proponer los gastos.' }); },
    });
  }

  indPart(r: IndicatorRow): string {
    const last = r.series && r.series.length ? r.series[r.series.length - 1] : null;
    return last && last.part_pct != null ? last.part_pct + '%' : '—';
  }

  loadIndicators(): void {
    const b = this.selected(); if (!b) return;
    this.loadingIndicators.set(true);
    this.http.get<SalesIndicators>(`${this.base}/budgets/${b.id}/sales-indicators`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (i) => { this.indicators.set(i); this.loadingIndicators.set(false); },
      error: (e) => { this.loadingIndicators.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo cargar el tablero.' }); },
    });
  }

  // ── Flujo de efectivo ──
  loadCashflow(): void {
    this.loadingCashflow.set(true);
    this.http.get<Cashflow>(`${this.base}/cashflow`, { params: { from: this.cfFrom, to: this.cfTo } }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (cf) => { this.cashflow.set(cf); this.loadingCashflow.set(false); },
      error: (e) => { this.loadingCashflow.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo cargar el flujo.' }); },
    });
  }
  /** «Sin datos» del saldo inicial se DECLARA (texto), nunca 0 (ADR-056). */
  /**
   * `[VP.MS]` **La tira declara con qué se calculó cada cifra.** Antes de esto tenía tres
   * defectos medidos, y los tres eran la misma cosa —el estado codificado como color—:
   *
   *   · «Cobros previstos» llevaba `tone: 'ok'` **clavado, sin condición**: verde mientras la
   *     curva ve una fracción de la cartera. No era un `cfg ? classify : 'ok'`: no había `cfg`.
   *   · «Saldo mín. proyectado: sin base» era una **ausencia renderizada como valor normal**.
   *   · «Neto» salía verde con sólo ser positivo — y hasta el 2026-10-08 ese neto era
   *     **+$10,642,041 porque «Pagos» valía $0**: el verde más confiado sobre el número más falso.
   *
   * ⚠️ El `no_medido` ya no necesita que acá se elija un tono: `effTone()` del componente lo
   * neutraliza. Se declara el estado y el color deja de ser una decisión del llamador.
   */
  cashflowKpis(cf: Cashflow): MetricStripItem[] {
    const cc = cf.cobranza_cobertura, dd = cf.deuda_erp?.cobertura;
    const fuera = (m: number | undefined) => (m ? `${this.money(m)} exigibles sin fecha quedan fuera` : undefined);
    return [
      cf.opening_balance.available
        ? {
            label: 'Saldo inicial', value: cf.opening_balance.amount as number, format: 'currency-short',
            state: 'medido',
            stateNote: cf.opening_balance.anomalias
              ? `${cf.opening_balance.anomalias.filas} movimientos de fecha imposible quedan fuera del saldo`
              : undefined,
          }
        : {
            label: 'Saldo inicial', value: '—', format: 'text',
            state: 'no_medido', stateNote: cf.opening_balance.reason || 'Sin movimientos bancarios (Fase CB)',
          },
      {
        label: 'Cobros previstos', value: cf.totals.cobros, format: 'currency-short',
        // Parcial, no verde: la curva agenda por vencimiento y lo ya vencido no tiene fecha.
        state: cc && cc.vencido_fuera > 0 ? 'parcial' : 'medido',
        stateNote: fuera(cc?.vencido_fuera),
      },
      {
        label: 'Pagos previstos', value: cf.totals.pagos, format: 'currency-short',
        state: dd && dd.vencido_fuera > 0 ? 'parcial' : 'medido',
        stateNote: fuera(dd?.vencido_fuera),
      },
      {
        label: 'Neto', value: cf.totals.neto, format: 'currency-short',
        tone: cf.totals.neto < 0 ? 'bad' : 'ok',
        // ⛔ El neto hereda la PEOR cobertura de sus dos sumandos: si cualquiera de los dos lados
        // ve una fracción, el neto también — aunque su tono siga calificando el signo.
        state: (cc && cc.vencido_fuera > 0) || (dd && dd.vencido_fuera > 0) ? 'parcial' : 'medido',
        stateNote: 'Cobros − pagos de lo que vence DENTRO de la ventana; lo vencido de ambos lados queda fuera',
      },
      cf.opening_balance.available && cf.saldo_minimo_proyectado != null
        ? {
            label: 'Saldo mín. proyectado', value: cf.saldo_minimo_proyectado, format: 'currency-short',
            tone: cf.saldo_minimo_proyectado < 0 ? 'bad' : 'ok', state: 'parcial',
            stateNote: 'Proyectado sobre la ventana; no incluye lo vencido de ninguno de los dos lados',
          }
        : {
            label: 'Saldo mín. proyectado', value: '—', format: 'text',
            state: 'no_medido', stateNote: 'Sin saldo inicial de bancos no hay base contra la cual proyectar',
          },
    ];
  }

  // ── Campañas ──
  loadCampaigns(): void {
    this.loadingCampaigns.set(true);
    this.http.get<Campaign[]>(`${this.base}/campaigns`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => { this.campaigns.set(rows ?? []); this.loadingCampaigns.set(false); if (!this.selectedCampaign() && rows?.length) this.selectCampaign(rows[0]); },
      error: () => { this.loadingCampaigns.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar las campañas.' }); },
    });
  }
  selectCampaign(c: Campaign): void {
    this.selectedCampaign.set(c); this.campEval.set(null); this.contributions.set([]); this.margenInput = null;
    this.reloadCampaign(c.id);
  }
  private reloadCampaign(id: string, margen?: number | null): void {
    const evalParams = margen != null ? { params: { margen_incremental: String(margen) } } : {};
    forkJoin({
      ev: this.http.get<CampaignEval>(`${this.base}/campaigns/${id}/evaluate`, evalParams),
      contribs: this.http.get<Contribution[]>(`${this.base}/campaigns/${id}/contributions`),
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: ({ ev, contribs }) => { this.campEval.set(ev); this.contributions.set(contribs ?? []); },
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo evaluar la campaña.' }),
    });
  }
  openNewCamp(): void { this.campForm = { campaign_type: 'publicidad' }; this.newCampVisible = true; }
  confirmNewCamp(): void {
    if (!this.campForm.name?.trim()) { this.toast.add({ severity: 'warn', summary: 'Falta el nombre', detail: 'La campaña necesita un nombre.' }); return; }
    this.savingCamp.set(true);
    this.http.post<Campaign>(`${this.base}/campaigns`, this.campForm).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (c) => { this.savingCamp.set(false); this.newCampVisible = false; this.loadCampaigns(); if (c) this.selectCampaign(c); this.toast.add({ severity: 'success', summary: 'Creada', detail: 'Campaña creada.' }); },
      error: (e) => { this.savingCamp.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo crear.' }); },
    });
  }
  setCampStatus(status: string): void {
    const c = this.selectedCampaign(); if (!c) return;
    this.savingCampStatus.set(true);
    this.http.post(`${this.base}/campaigns/${c.id}/status`, { status }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.savingCampStatus.set(false); this.loadCampaigns(); this.reloadCampaign(c.id); this.toast.add({ severity: 'success', summary: 'Listo', detail: 'Estado actualizado.' }); },
      error: (e) => { this.savingCampStatus.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo.' }); },
    });
  }
  recalcRetorno(): void {
    const c = this.selectedCampaign(); if (!c) return;
    if (!(Number(this.margenInput) > 0)) { this.toast.add({ severity: 'warn', summary: 'Margen', detail: 'Captura un margen incremental > 0.' }); return; }
    this.reloadCampaign(c.id, Number(this.margenInput));
  }
  openAddContrib(): void { this.contribForm = { status: 'incierta' }; this.addContribVisible = true; }
  confirmAddContrib(): void {
    const c = this.selectedCampaign(); if (!c) return;
    if (!this.contribForm.supplier?.trim() || !(Number(this.contribForm.amount) > 0)) { this.toast.add({ severity: 'warn', summary: 'Faltan datos', detail: 'Proveedor e importe son requeridos.' }); return; }
    this.savingContrib.set(true);
    this.http.post(`${this.base}/campaigns/${c.id}/contributions`, this.contribForm).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.savingContrib.set(false); this.addContribVisible = false; this.reloadCampaign(c.id, this.margenInput); this.toast.add({ severity: 'success', summary: 'Agregada', detail: 'Aportación registrada.' }); },
      error: (e) => { this.savingContrib.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo.' }); },
    });
  }
  confirmContrib(ct: Contribution): void {
    const c = this.selectedCampaign(); if (!c) return;
    this.http.post(`${this.base}/campaigns/${c.id}/contributions/${ct.id}/status`, { status: 'confirmada' }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.reloadCampaign(c.id, this.margenInput); this.toast.add({ severity: 'success', summary: 'Confirmada', detail: 'La aportación ahora reduce el gasto neto.' }); },
      error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo.' }),
    });
  }
  campKpis(ev: CampaignEval): MetricStripItem[] {
    return [
      { label: 'Presupuesto', value: ev.presupuesto, format: 'currency-short' },
      { label: 'Costo (ejercido)', value: ev.costo, format: 'currency-short' },
      { label: 'Costo neto', value: ev.costo_neto_aportacion, format: 'currency-short', sub: 'menos aportación confirmada' },
      ev.ventas_vinculadas.available
        ? { label: 'Ventas vinculadas', value: ev.ventas_vinculadas.monto as number, format: 'currency-short' }
        : { label: 'Ventas vinculadas', value: 'sin datos', format: 'text', tone: 'warn' },
      ev.intensidad_gasto_ventas_pct != null
        ? { label: 'Gasto / ventas', value: ev.intensidad_gasto_ventas_pct, format: 'percent' }
        : { label: 'Gasto / ventas', value: 'sin base', format: 'text' },
    ];
  }
  campTypeLabel(t: string): string {
    return ({ publicidad: 'Publicidad', materiales: 'Materiales', eventos: 'Eventos', promociones: 'Promociones', descuento_comercial: 'Descuento com.', otro: 'Otro' } as Record<string, string>)[t] || t;
  }
  campSeverity(s: string): 'success' | 'info' | 'secondary' { return s === 'activa' ? 'success' : s === 'cerrada' ? 'secondary' : 'info'; }
  contribSeverity(s: string): 'success' | 'info' | 'warn' { return s === 'confirmada' || s === 'aplicada' ? 'success' : 'warn'; }

  /** Resumen ejecutivo → KPI strip. «Sin datos» del real se DECLARA (texto), no se dibuja 0. */
  kpiItems(s: Summary): MetricStripItem[] {
    const items: MetricStripItem[] = [
      // `[PU.VA]` El rótulo dice de QUÉ es el saldo. Decía sólo «Vigente» mientras sumaba la meta
      // de ventas con el plan de gastos: $547 M que no eran ni lo uno ni lo otro.
      { label: 'Egreso vigente', value: s.ejecucion.vigente, format: 'currency-short' },
      { label: 'Disponible', value: s.ejecucion.disponible, format: 'currency-short', tone: s.ejecucion.disponible < 0 ? 'bad' : 'ok' },
      // La meta de ventas es el OTRO lado del presupuesto y ahora se ve como tal, en vez de estar
      // disuelta dentro del saldo de gasto.
      ...(s.ejecucion.ingreso_meta != null
        ? [{ label: 'Meta de ventas', value: s.ejecucion.ingreso_meta, format: 'currency-short' } as MetricStripItem]
        : []),
      // `[PU.VA]` ⛔ Decía `?? 0` con `format:'text'`, o sea que imprimía el literal **0** debajo de
      // la leyenda «sin base» — un cero dibujado con su propia desmentida al lado, y en el mismo
      // archivo que dos funciones más abajo declara «Sin datos» ≠ cero (ADR-056). Sin partidas no
      // hay ocupación que medir: eso es «—», no 0 %.
      { label: 'Ocupación', value: s.ejecucion.ocupacion_pct ?? '—', format: s.ejecucion.ocupacion_pct == null ? 'text' : 'percent', sub: s.ejecucion.ocupacion_pct == null ? 'sin base' : undefined },
    ];
    if (s.real.available) {
      items.push({ label: 'Ventas real', value: s.real.ventas as number, format: 'currency-short' });
      items.push(s.kpis.cumplimiento_ventas_pct != null
        ? { label: 'Cumplimiento', value: s.kpis.cumplimiento_ventas_pct, format: 'percent', tone: s.kpis.cumplimiento_ventas_pct >= 100 ? 'ok' : 'warn' }
        : { label: 'Cumplimiento', value: 'sin base', format: 'text' });
    } else if (s.real.deferred) {
      items.push({ label: 'Ventas real', value: 'sin cargar', format: 'text' });
    } else {
      items.push({ label: 'Ventas real', value: 'sin datos', format: 'text', tone: 'warn' });
    }
    return items;
  }

  /**
   * `[PU.VA]` La columna «Área» mostraba `l.area || '—'`, y **las 47 partidas de prod tienen `area`
   * en NULL**: un guion en las 47 filas se lee como «falta capturar esto», cuando no falta nada.
   *
   * Medido: `area` **sí tiene productor** —la captura manual de una partida la guarda— pero el
   * materializador no la escribe, porque una partida derivada del plan no tiene área: tiene la
   * dimensión con la que se planeó. Y ésa sí está, en `cost_center`:
   *
   *   · ingreso → la entidad (`mayoreo:01`), que el concepto ya repite («Ventas mayoreo · 01»)
   *   · gasto   → **NULL, y por una razón**: el plan se armó CONSOLIDADO (`by_sucursal` apagado)
   *
   * Así que el guion tapaba tres cosas distintas. Ahora cada una se dice: lo capturado a mano, la
   * dimensión del plan, o **«consolidado»** — que no es un dato faltante, es cómo se presupuestó.
   * «Sin datos» ≠ cero, y tampoco ≠ «no aplica» (ADR-056).
   */
  dimension(l: BudgetLine): string {
    if (l.area) return l.area;
    if (l.cost_center) return l.cost_center;
    // Sólo una partida DERIVADA DEL PLAN puede declararse consolidada; una capturada a mano sin
    // área es un hueco de verdad, y ahí el guion dice la verdad.
    return l.source === 'plan' && l.line_type !== 'ingreso' ? 'consolidado' : '—';
  }
  dimensionTitulo(l: BudgetLine): string {
    if (l.area) return 'Área capturada en la partida';
    if (l.cost_center) return `Dimensión del plan: ${l.cost_center}`;
    if (l.source === 'plan') return 'El plan de gastos se armó consolidado (sin abrir por sucursal). No es un dato faltante.';
    return 'Sin área capturada';
  }

  ocupacion(l: BudgetLine): string {
    const v = Number(l.vigente_amount);
    if (!(v > 0)) return '—';
    const used = Number(l.reserved_amount) + Number(l.committed_amount) + Number(l.exercised_amount);
    return `${Math.round((used / v) * 1000) / 10}%`;
  }
  tipoLabel(t: string): string {
    return ({ ingreso: 'Ingreso', costo_ventas: 'Costo vta.', gasto: 'Gasto', compra_inventario: 'Compra inv.', inversion: 'Inversión', flujo: 'Flujo' } as Record<string, string>)[t] || t;
  }
  budgetSeverity(status: string): 'success' | 'info' | 'warn' | 'secondary' {
    return status === 'aprobado' ? 'success' : status === 'cerrado' ? 'secondary' : status === 'pendiente' ? 'warn' : 'info';
  }
  // «Sin datos» ≠ cero (ADR-056): sólo null/undefined es «—»; un 0 real se muestra como $0.00.
  dash(n: number | null | undefined): string { return n == null ? '—' : this.money(n); }

  // ── Capacidad (TP) ──
  loadCapacity(): void {
    this.http.get<Capacity | null>(`${this.base}/capacity`, { params: { date: this.capDate } }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (c) => { this.currentCapacity.set(c); this.capAmount = c?.authorized_amount ?? null; },
      error: () => this.currentCapacity.set(null),
    });
    this.http.get<CapacityHistoryRow[]>(`${this.base}/capacity/history`, { params: { date: this.capDate } }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (h) => this.history.set(h), error: () => this.history.set([]),
    });
  }
  saveCapacity(): void {
    if (this.capAmount == null || Number(this.capAmount) < 0) { this.toast.add({ severity: 'warn', summary: 'Falta el importe', detail: 'Captura un importe autorizado válido.' }); return; }
    this.savingCap.set(true);
    this.http.post(`${this.base}/capacity`, { date: this.capDate, amount: Number(this.capAmount), reason: this.capReason || undefined }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.savingCap.set(false); this.capReason = ''; this.loadCapacity(); this.toast.add({ severity: 'success', summary: 'Guardado', detail: 'Capacidad actualizada.' }); },
      error: (e) => { this.savingCap.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo guardar.' }); },
    });
  }

  // ── Gastos (TP) ──
  loadExpenses(): void {
    this.loadingExpenses.set(true);
    this.http.get<ExpenseObligation[]>(`${this.base}/expenses`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => { this.expenses.set(rows); this.loadingExpenses.set(false); },
      error: () => { this.loadingExpenses.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar los gastos.' }); },
    });
  }
  openNew(): void { this.form = { is_critical: false }; this.newVisible = true; }
  confirmNew(): void {
    if (!this.form.concept?.trim() || !this.form.beneficiary?.trim() || !(Number(this.form.original_amount) > 0)) {
      this.toast.add({ severity: 'warn', summary: 'Faltan datos', detail: 'Concepto, beneficiario e importe son requeridos.' }); return;
    }
    this.saving.set(true);
    this.http.post(`${this.base}/expenses`, this.form).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.saving.set(false); this.newVisible = false; this.loadExpenses(); this.toast.add({ severity: 'success', summary: 'Autorizado', detail: 'Gasto registrado.' }); },
      error: (e) => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo guardar.' }); },
    });
  }
  cancelExpense(e: ExpenseObligation): void {
    this.http.post(`${this.base}/expenses/${e.id}/cancelar`, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.loadExpenses(); this.toast.add({ severity: 'info', summary: 'Cancelado', detail: 'El gasto se canceló.' }); },
      error: (err) => this.toast.add({ severity: 'error', summary: 'Error', detail: err?.error?.message || 'No se pudo cancelar.' }),
    });
  }

  money(n: number | null | undefined): string { return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 }); }
}
