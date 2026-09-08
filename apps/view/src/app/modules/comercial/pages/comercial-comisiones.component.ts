import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import {
  ComercialService, CommissionPeriod, CommissionRunPayload, CommissionLine,
} from '../comercial.service';

/**
 * RD.6 — Comisiones de Ruta Directa. Reemplaza las hojas `COMISIONES`,
 * `FORMATO DE PAGO` y `FORMATO DE SUPERVISOR` del workbook `INDICADORES RD 2026`.
 *
 * Surface Operations: tabla densa, sin zebra, cifras en Geist Mono con `tabular-nums`,
 * divisor 1px por fila. Master-detail: quincenas a la izquierda, el detalle de la corrida
 * a la derecha.
 *
 * Motor decide / humano aprueba (ADR-016). El botón de Vista previa calcula sin persistir,
 * para poder cuadrar contra el Excel del periodo ANTES de crear la corrida; recién después
 * se crea el borrador, se aprueba y se marca pagada.
 *
 * Lo que la pantalla NO esconde:
 *  · `rutas_sin_dato` — una ruta sin venta en el periodo sale con motivo y no con $0, que
 *    se leería como "vendió cero" en vez de "no sabemos".
 *  · `subtotal_origen` — el tramo del push tiene el subtotal DERIVADO de la tasa de
 *    catálogo (±0.25% medido), no del ERP. Se marca en la fila.
 *  · La deducción del supervisor es por PERSONA y agregada sobre sus rutas, no por ruta:
 *    la línea de supervisor trae la contribución de cada ruta y el neto se suma abajo.
 */
@Component({
  selector: 'app-comercial-comisiones',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="cm-page">
      <header class="cm-head">
        <div>
          <h1>Comisiones de Ruta Directa</h1>
          <p class="cm-sub">Quincena de 14 días · la comisión va sobre el subtotal y la compuerta la abre la venta total</p>
        </div>
        <label class="cm-year">Año
          <select [ngModel]="anio()" (ngModelChange)="anio.set(+$event); loadPeriods()">
            @for (y of anios; track y) { <option [value]="y">{{ y }}</option> }
          </select>
        </label>
      </header>

      <div class="cm-split">
        <!-- ── Quincenas ─────────────────────────────────────────────── -->
        <aside class="cm-rail">
          @if (loadingPeriods()) {
            @for (i of skeleton; track i) { <div class="cm-skel"></div> }
          } @else if (!periods().length) {
            <p class="cm-empty">No hay quincenas cargadas para {{ anio() }}.</p>
          } @else {
            @for (p of periods(); track p.id) {
              <button type="button" class="cm-per" [class.sel]="selected()?.id === p.id" (click)="pick(p)">
                <span class="cm-per-no">Q{{ p.period_no }}</span>
                <span class="cm-per-fechas">{{ p.date_from }} → {{ p.date_to }}</span>
                @if (p.run) {
                  <span class="cm-chip" [class]="p.run.status">{{ p.run.status }}</span>
                  <span class="cm-per-monto">{{ money(+p.run.total_a_pagar) }}</span>
                  @if (p.run.rutas_sin_dato) { <span class="cm-chip warn">{{ p.run.rutas_sin_dato }} sin dato</span> }
                } @else {
                  <span class="cm-chip none">sin corrida</span>
                }
              </button>
            }
          }
        </aside>

        <!-- ── Detalle ───────────────────────────────────────────────── -->
        <section class="cm-detail">
          @if (!selected()) {
            <p class="cm-empty">Elegí una quincena.</p>
          } @else {
            <div class="cm-actions">
              <strong class="cm-detail-title">Q{{ selected()!.period_no }} · {{ selected()!.date_from }} → {{ selected()!.date_to }}</strong>
              @if (selected()!.pay_date) { <span class="cm-muted">pago {{ selected()!.pay_date }}</span> }
              <span class="cm-spacer"></span>
              <button type="button" class="cm-btn" (click)="preview()" [disabled]="busy()">
                <i class="pi pi-calculator" aria-hidden="true"></i> Vista previa
              </button>
              @if (canManage()) {
                <button type="button" class="cm-btn primary" (click)="compute()" [disabled]="busy()">
                  <i class="pi pi-play" aria-hidden="true"></i> {{ selected()!.run ? 'Recalcular borrador' : 'Crear corrida' }}
                </button>
                @if (selected()!.run?.status === 'borrador') {
                  <button type="button" class="cm-btn ok" (click)="status('approve')" [disabled]="busy()">
                    <i class="pi pi-check" aria-hidden="true"></i> Aprobar
                  </button>
                }
                @if (selected()!.run?.status === 'aprobado') {
                  <button type="button" class="cm-btn ok" (click)="status('pay')" [disabled]="busy()">
                    <i class="pi pi-wallet" aria-hidden="true"></i> Marcar pagada
                  </button>
                }
              }
            </div>

            @if (err()) { <p class="cm-err"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ err() }}</p> }

            @if (run(); as r) {
              <div class="cm-kpis">
                <div class="cm-kpi"><span>Subtotal</span><strong>{{ money(r.total_subtotal) }}</strong></div>
                <div class="cm-kpi"><span>Venta</span><strong>{{ money(r.total_venta) }}</strong></div>
                <div class="cm-kpi"><span>Comisión</span><strong>{{ money(r.total_comision) }}</strong></div>
                <div class="cm-kpi acc"><span>A pagar</span><strong>{{ money(r.total_a_pagar) }}</strong></div>
                <div class="cm-kpi"><span>Cobertura</span><strong>{{ r.rutas_con_dato }}/{{ r.rutas_con_dato + r.rutas_sin_dato }} rutas</strong></div>
              </div>

              @if (r.rutas_sin_dato) {
                <p class="cm-warn">
                  <i class="pi pi-info-circle" aria-hidden="true"></i>
                  {{ r.rutas_sin_dato }} ruta(s) sin venta en la fuente para este periodo. Salen declaradas, no en cero:
                  cero se leería como "vendió nada" en vez de "no sabemos".
                </p>
              }

              <div class="cm-tabs">
                @for (b of ['chofer','supervisor']; track b) {
                  <button type="button" class="cm-tab" [class.sel]="tab() === b" (click)="tab.set(b)">
                    {{ b === 'chofer' ? 'Choferes' : 'Supervisores' }}
                    <span class="cm-tab-n">{{ count(b) }}</span>
                  </button>
                }
              </div>

              <div class="cm-table-wrap">
                <table class="cm-table">
                  <thead>
                    <tr>
                      <th>Ruta</th><th>{{ tab() === 'chofer' ? 'Chofer' : 'Supervisor' }}</th>
                      <th class="num">Subtotal</th><th class="num">Venta</th><th class="num">%</th>
                      <th class="num">Comisión</th><th class="num">Bonos</th>
                      @if (tab() === 'chofer') { <th class="num">Nómina banco</th> }
                      <th class="num">A pagar</th><th>Nota</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (l of visibles(); track l.route_code + l.beneficiario) {
                      <tr [class.muted]="!!l.motivo_no_pago">
                        <td class="cm-route">R-{{ l.route_code }}</td>
                        <td class="cm-name">{{ (tab() === 'chofer' ? l.chofer_nombre : l.supervisor_nombre) || '—' }}</td>
                        <td class="num mono">{{ l.subtotal != null ? money(l.subtotal) : '—' }}</td>
                        <td class="num mono">{{ l.venta != null ? money(l.venta) : '—' }}</td>
                        <td class="num mono">{{ l.pct_aplicado != null ? (l.pct_aplicado + '%') : '—' }}</td>
                        <td class="num mono">{{ money(l.comision) }}</td>
                        <td class="num mono" [title]="bonosTip(l)">{{ l.bonos ? money(l.bonos) : '—' }}</td>
                        @if (tab() === 'chofer') { <td class="num mono neg">{{ l.nomina_banco ? ('−' + money(l.nomina_banco)) : '—' }}</td> }
                        <td class="num mono strong">{{ l.motivo_no_pago ? '—' : money(l.a_pagar) }}</td>
                        <td class="cm-nota">
                          @if (l.motivo_no_pago) { <span class="cm-chip warn">{{ motivo(l.motivo_no_pago) }}</span> }
                          @if (l.subtotal_origen && l.subtotal_origen !== 'erp') { <span class="cm-chip info" title="El subtotal del tramo push se deriva de la tasa de catálogo (±0.25% medido), no viene del ERP">derivado</span> }
                        </td>
                      </tr>
                    }
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colspan="2">Total {{ tab() === 'chofer' ? 'choferes' : 'supervisores' }}</td>
                      <td class="num mono">{{ money(sum('subtotal')) }}</td>
                      <td class="num mono">{{ money(sum('venta')) }}</td>
                      <td></td>
                      <td class="num mono">{{ money(sum('comision')) }}</td>
                      <td class="num mono">{{ money(sum('bonos')) }}</td>
                      @if (tab() === 'chofer') { <td class="num mono neg">−{{ money(sum('nomina_banco')) }}</td> }
                      <td class="num mono strong">{{ money(sum('a_pagar')) }}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              @if (tab() === 'supervisor') {
                <p class="cm-warn">
                  <i class="pi pi-info-circle" aria-hidden="true"></i>
                  La deducción del supervisor es por <strong>persona</strong> y agregada sobre sus rutas, no por ruta.
                  Estas filas traen la <em>contribución</em> de cada ruta; el neto por persona se arma sumando sus rutas
                  y restando su deducción. No se reparte entre rutas para no inventar una regla que el Excel no tiene.
                </p>
              }
            } @else if (!busy()) {
              <p class="cm-empty">Sin corrida todavía. Empezá por <strong>Vista previa</strong> para cuadrar contra el Excel del periodo.</p>
            }
          }
        </section>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display:block; }
    .cm-page { padding:1rem 1.1rem 2rem; }
    .cm-head { display:flex; align-items:flex-start; gap:1rem; margin-bottom:1rem; }
    .cm-head h1 { margin:0; font-size:var(--fs-xl,1.25rem); font-weight:var(--fw-bold); color:var(--c-text-1); }
    .cm-sub { margin:.15rem 0 0; font-size:var(--fs-sm); color:var(--c-text-3); }
    .cm-year { margin-left:auto; display:inline-flex; gap:.4rem; align-items:center; font-size:var(--fs-sm); color:var(--c-text-2); }
    .cm-year select { padding:.3rem .45rem; border:1px solid var(--border-color); border-radius:var(--r-sm,6px); background:var(--card-bg); color:var(--c-text-1); font:inherit; font-size:var(--fs-sm); }

    .cm-split { display:grid; grid-template-columns:minmax(240px,300px) 1fr; gap:1rem; align-items:start; }
    @media (max-width:900px) { .cm-split { grid-template-columns:1fr; } }

    .cm-rail { display:flex; flex-direction:column; gap:.25rem; max-height:78vh; overflow-y:auto; }
    .cm-per { display:grid; grid-template-columns:auto 1fr; gap:.15rem .5rem; align-items:center; text-align:left;
      padding:.45rem .6rem; border:1px solid var(--border-color); border-radius:var(--r-md,8px);
      background:var(--card-bg); font:inherit; cursor:pointer; }
    .cm-per:hover { background:var(--overlay-hover); }
    .cm-per.sel { border-color:var(--action); background:color-mix(in srgb, var(--action) 8%, transparent); }
    .cm-per-no { font-weight:var(--fw-bold); font-size:var(--fs-sm); color:var(--c-text-1); font-family:var(--font-mono,'Geist Mono',monospace); }
    .cm-per-fechas { font-size:var(--fs-micro); color:var(--c-text-3); font-family:var(--font-mono,'Geist Mono',monospace); }
    .cm-per-monto { grid-column:2; font-size:var(--fs-micro); color:var(--c-text-2); font-family:var(--font-mono,'Geist Mono',monospace); font-variant-numeric:tabular-nums; }
    .cm-skel { height:44px; border-radius:var(--r-md,8px); background:var(--c-surface-2); animation:cmPulse 1.2s ease-in-out infinite; }
    @keyframes cmPulse { 0%,100% { opacity:.55 } 50% { opacity:1 } }
    @media (prefers-reduced-motion: reduce) { .cm-skel { animation:none } }

    .cm-detail { min-width:0; }
    .cm-actions { display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; margin-bottom:.8rem; }
    .cm-detail-title { font-size:var(--fs-sm); color:var(--c-text-1); }
    .cm-spacer { flex:1 1 auto; }
    .cm-btn { display:inline-flex; gap:.35rem; align-items:center; padding:.35rem .7rem; border:1px solid var(--border-color);
      border-radius:var(--r-sm,6px); background:var(--card-bg); color:var(--c-text-1); font:inherit; font-size:var(--fs-sm); cursor:pointer; }
    .cm-btn:hover:not(:disabled) { background:var(--overlay-hover); }
    .cm-btn:disabled { opacity:.5; cursor:default; }
    .cm-btn.primary { background:var(--action); border-color:var(--action); color:#fff; }
    .cm-btn.ok { border-color:var(--ok-fg); color:var(--ok-fg); }

    .cm-kpis { display:flex; gap:.5rem; flex-wrap:wrap; margin-bottom:.8rem; }
    .cm-kpi { flex:1 1 130px; padding:.5rem .65rem; border:1px solid var(--border-color); border-radius:var(--r-md,8px); background:var(--card-bg); }
    .cm-kpi span { display:block; font-size:var(--fs-micro); text-transform:uppercase; letter-spacing:.05em; color:var(--c-text-3); }
    .cm-kpi strong { font-size:var(--fs-md,1rem); color:var(--c-text-1); font-family:var(--font-mono,'Geist Mono',monospace); font-variant-numeric:tabular-nums; }
    .cm-kpi.acc strong { color:var(--action); }

    .cm-tabs { display:flex; gap:.3rem; margin-bottom:.5rem; }
    .cm-tab { display:inline-flex; gap:.35rem; align-items:center; padding:.3rem .7rem; border:1px solid var(--border-color);
      border-radius:99px; background:var(--card-bg); color:var(--c-text-2); font:inherit; font-size:var(--fs-sm); cursor:pointer; }
    .cm-tab.sel { border-color:var(--action); color:var(--action); background:color-mix(in srgb, var(--action) 8%, transparent); }
    .cm-tab-n { font-size:var(--fs-micro); color:var(--c-text-3); font-family:var(--font-mono,'Geist Mono',monospace); }

    .cm-table-wrap { overflow-x:auto; border:1px solid var(--border-color); border-radius:var(--r-md,8px); }
    .cm-table { width:100%; border-collapse:collapse; font-size:var(--fs-sm); }
    .cm-table th { position:sticky; top:0; z-index:1; background:var(--card-bg); text-align:left; padding:.4rem .6rem;
      font-size:var(--fs-micro); text-transform:uppercase; letter-spacing:.05em; color:var(--c-text-3);
      font-weight:var(--fw-bold); border-bottom:1px solid var(--c-divider); white-space:nowrap; }
    .cm-table td { padding:.4rem .6rem; border-top:1px solid var(--c-divider); white-space:nowrap; }
    .cm-table th.num, .cm-table td.num { text-align:right; }
    .cm-table tbody tr.muted td { color:var(--c-text-3); }
    .cm-table tfoot td { padding:.45rem .6rem; border-top:2px solid var(--c-divider); font-weight:var(--fw-bold); background:var(--c-surface-2); white-space:nowrap; }
    .mono { font-family:var(--font-mono,'Geist Mono',monospace); font-variant-numeric:tabular-nums; }
    .mono.strong { font-weight:var(--fw-bold); }
    .mono.neg { color:var(--bad-fg); }
    .cm-route { font-weight:var(--fw-medium); font-family:var(--font-mono,'Geist Mono',monospace); }
    .cm-name { max-width:220px; overflow:hidden; text-overflow:ellipsis; }
    .cm-nota { display:flex; gap:.25rem; }

    .cm-chip { font-size:var(--fs-micro); font-weight:var(--fw-bold); padding:.1rem .45rem; border-radius:99px; text-transform:uppercase; letter-spacing:.03em; }
    .cm-chip.borrador { background:var(--c-surface-2); color:var(--c-text-2); }
    .cm-chip.aprobado { background:color-mix(in srgb, var(--action) 15%, transparent); color:var(--action); }
    .cm-chip.pagado { background:color-mix(in srgb, var(--ok-fg) 15%, transparent); color:var(--ok-fg); }
    .cm-chip.anulado, .cm-chip.none { background:var(--c-surface-2); color:var(--c-text-3); }
    .cm-chip.warn { background:color-mix(in srgb, var(--warn-fg) 15%, transparent); color:var(--warn-fg); }
    .cm-chip.info { background:var(--c-surface-2); color:var(--c-text-2); }

    .cm-warn { display:flex; gap:.4rem; align-items:flex-start; margin:.7rem 0 0; padding:.5rem .65rem;
      border:1px solid color-mix(in srgb, var(--warn-fg) 35%, transparent); border-radius:var(--r-md,8px);
      background:color-mix(in srgb, var(--warn-fg) 8%, transparent); font-size:var(--fs-sm); color:var(--c-text-2); }
    .cm-err { display:flex; gap:.4rem; align-items:center; color:var(--bad-fg); font-size:var(--fs-sm); margin:.4rem 0; }
    .cm-empty { color:var(--c-text-3); font-size:var(--fs-sm); }
    .cm-muted { color:var(--c-text-3); font-size:var(--fs-micro); }
  `],
})
export class ComercialComisionesComponent {
  private readonly api = inject(ComercialService);
  private readonly auth = inject(AuthService);

  readonly anios = [2026, 2027];
  readonly skeleton = Array.from({ length: 6 }, (_, i) => i);
  readonly anio = signal(2026);
  readonly periods = signal<CommissionPeriod[]>([]);
  readonly selected = signal<CommissionPeriod | null>(null);
  readonly run = signal<CommissionRunPayload | null>(null);
  readonly tab = signal<string>('chofer');
  readonly loadingPeriods = signal(false);
  readonly busy = signal(false);
  readonly err = signal<string | null>(null);

  readonly canManage = computed(() =>
    !!this.auth.user()?.permissions?.[Permission.COMMERCIAL_COMMISSIONS_GESTIONAR]);

  readonly visibles = computed<CommissionLine[]>(() =>
    (this.run()?.lines ?? []).filter((l) => l.beneficiario === this.tab()));

  constructor() { this.loadPeriods(); }

  loadPeriods() {
    this.loadingPeriods.set(true);
    this.api.commissionPeriods(this.anio()).subscribe({
      next: (ps) => {
        this.periods.set(ps);
        this.loadingPeriods.set(false);
        // Al cambiar de año, la selección vieja ya no aplica.
        const sel = this.selected();
        if (sel && !ps.some((p) => p.id === sel.id)) { this.selected.set(null); this.run.set(null); }
      },
      error: () => { this.loadingPeriods.set(false); this.err.set('No se pudieron cargar las quincenas.'); },
    });
  }

  pick(p: CommissionPeriod) {
    this.selected.set(p);
    this.run.set(null);
    this.err.set(null);
    if (p.run) this.loadRun(p.run.run_id);
  }

  private loadRun(runId: string) {
    this.busy.set(true);
    this.api.commissionRun(runId).subscribe({
      next: (d) => {
        // El detalle persistido y el payload del cálculo comparten forma salvo la cabecera.
        this.run.set({
          run_id: d.id, status: d.status,
          period: { id: '', anio: d.period?.anio ?? 0, period_no: d.period?.period_no ?? 0,
            date_from: d.period?.date_from ?? '', date_to: d.period?.date_to ?? '', pay_date: d.period?.pay_date ?? null },
          scale: { id: '', code: '', base_field: 'subtotal', gate_field: 'venta', share_supervisor_pct: 20 },
          total_subtotal: +d.total_subtotal, total_venta: +d.total_venta,
          total_comision: +d.total_comision, total_a_pagar: +d.total_a_pagar,
          rutas_con_dato: d.rutas_con_dato, rutas_sin_dato: d.rutas_sin_dato,
          lines: d.lines,
        });
        this.busy.set(false);
      },
      error: () => { this.busy.set(false); this.err.set('No se pudo cargar la corrida.'); },
    });
  }

  preview() { this.exec(this.api.commissionPreview(this.selected()!.id)); }
  compute() { this.exec(this.api.commissionCompute(this.selected()!.id, !!this.selected()!.run), true); }

  private exec(obs: ReturnType<ComercialService['commissionPreview']>, refresh = false) {
    this.busy.set(true);
    this.err.set(null);
    obs.subscribe({
      next: (r) => { this.run.set(r); this.busy.set(false); if (refresh) this.loadPeriods(); },
      error: (e) => { this.busy.set(false); this.err.set(e?.error?.message || 'No se pudo calcular el periodo.'); },
    });
  }

  status(accion: 'approve' | 'pay' | 'void') {
    const id = this.selected()?.run?.run_id;
    if (!id) return;
    this.busy.set(true);
    this.err.set(null);
    this.api.commissionSetStatus(id, accion).subscribe({
      next: () => { this.busy.set(false); this.loadPeriods(); this.loadRun(id); },
      error: (e) => { this.busy.set(false); this.err.set(e?.error?.message || 'No se pudo cambiar el estado.'); },
    });
  }

  count(b: string) { return (this.run()?.lines ?? []).filter((l) => l.beneficiario === b).length; }

  sum(campo: keyof CommissionLine): number {
    return this.visibles().reduce((s, l) => s + (Number(l[campo]) || 0), 0);
  }

  bonosTip(l: CommissionLine): string {
    if (!l.bonos_detalle?.length) return '';
    return l.bonos_detalle.map((b) => `${b.nombre}: ${this.money(b.monto)} (${b.metrica} > ${b.umbral})`).join(' · ');
  }

  motivo(m: string): string {
    return m === 'bajo_umbral' ? 'bajo umbral'
      : m === 'sin_dato_en_la_fuente' ? 'sin dato en la fuente'
      : m;
  }

  money(n: number | null | undefined): string {
    if (n == null) return '—';
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 }).format(Number(n));
  }
}
