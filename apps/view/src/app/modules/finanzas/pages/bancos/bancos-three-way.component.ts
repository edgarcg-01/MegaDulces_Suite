import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { CommonModule } from '@angular/common';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { ButtonModule } from 'primeng/button';
import { BankService, ThreeWay, ThreeWayRow, ThreeWayAccount, ChequesTransito, ThreeWayDetail } from '../../bank.service';
import { money, dmy, dmShort } from './bancos-shared';
import { exportXlsx, XlsxSheet } from '../../../../shared/export/xlsx-export';
import { CUADRE_STYLES } from '../cuadre.styles';
import { ExplainAccount, ExplainMovement, PAIR_META, TwPair, TwRow,
         explainAccounts, explainMovements, totalDelta } from './three-way-explain';

/**
 * CB.24 — Cuadre 3 vías. Enfrenta las TRES fuentes de verdad del banco en el periodo:
 *   • Workbook   = el estado de cuenta (lo que realmente movió el banco).
 *   • Kepler     = tesorería del ERP por banco (kdm1); el 102 contable no se desglosa.
 *   • ContPAQi   = los libros fiscales (con folio de póliza).
 *
 * Comparte armadura con el Cuadre de `/finanzas/caja` — misma pregunta, misma forma, y desde
 * 2026-08 el mismo vocabulario visual (`CUADRE_STYLES`):
 *   control-total (N fuentes × 2 renglones) → nota de qué es cada fuente → veredicto de una
 *   línea → tabla del desglose con la fila EXPANDIBLE que muestra, lado a lado, qué tiene una
 *   fuente que la otra no.
 *
 * El drill vive dentro de la fila y no en un diálogo: al cerrar un modal se perdía el renglón
 * de contexto y había que volver a buscarlo en una tabla de 20 cuentas.
 *
 * Presentacional: recibe el payload de threeWay(); trae por su cuenta cheques y detalles.
 */
@Component({
  selector: 'bancos-three-way',
  standalone: true,
  imports: [CommonModule, TableModule, TagModule, DialogModule, ButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (data(); as d) {
      <!-- ── Control-total: aquí cuadran las 3 (mismo organismo que el de caja) ── -->
      <div class="cg-kve-wrap">
        <table class="cg-kve">
          <thead>
            <tr>
              <th></th>
              <th class="ta-r">Workbook <span class="cg-sub">(banco)</span></th>
              <th class="ta-r">Kepler <span class="cg-sub">(tesorería)</span></th>
              <th class="ta-r">ContPAQi <span class="cg-sub">(libros)</span></th>
              <th class="ta-r">Δ <span class="cg-sub">wb–kep</span></th>
              <th class="ta-r">Δ <span class="cg-sub">wb–cpq</span></th>
              <th class="ta-r">Δ <span class="cg-sub">kep–cpq</span></th>
              <th class="ta-c cg-w-e">Estado</th>
            </tr>
          </thead>
          <tbody>
            @for (row of rows(d); track row.label) {
              <tr>
                <th scope="row">
                  <i class="pi" [class.pi-arrow-down-left]="row.label === 'Ingresos'" [class.cg-in]="row.label === 'Ingresos'"
                     [class.pi-arrow-up-right]="row.label !== 'Ingresos'" [class.cg-eg]="row.label !== 'Ingresos'" aria-hidden="true"></i>
                  {{ row.label }} <span class="muted">({{ row.label === 'Ingresos' ? 'entra' : 'sale' }})</span>
                </th>
                <td class="ta-r num strong">{{ money(row.workbook) }}</td>
                <td class="ta-r num">{{ money(row.kepler) }}</td>
                <td class="ta-r num">{{ money(row.contpaqi) }}</td>
                @for (p of PAIRS; track p) {
                  <td class="ta-r num" [class.warn]="!cuad(delta(row, p))">
                    @if (cuad(delta(row, p))) { {{ money(delta(row, p)) }} }
                    @else {
                      <!-- §Q.4: el número que evidencia algo lleva a su explicación. -->
                      <button type="button" class="cg-dlink" (click)="explain(d, row, p)"
                              [attr.aria-label]="'Ver qué explica el descuadre de ' + row.label + ' entre ' + PAIR_META[p].a + ' y ' + PAIR_META[p].b">
                        {{ money(delta(row, p)) }}<i class="pi pi-search-plus" aria-hidden="true"></i>
                      </button>
                    }
                  </td>
                }
                <td class="ta-c">
                  @if (row.cuadra) { <i class="pi pi-check-circle cg-ok-i" title="Cuadra dentro de la tolerancia"></i> }
                  @else { <i class="pi pi-exclamation-triangle cg-bad-i" title="No cuadra — abre la cuenta de abajo"></i> }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <p class="cg-note">Enfrenta el <b>Workbook</b> (estado de cuenta — lo que de verdad movió el banco) contra
        <b>Kepler</b> (tesorería del ERP por banco, {{ d.kepler_movs }} movs) y contra <b>ContPAQi</b>
        (libros fiscales, {{ d.kepler_linked }} cuentas enlazadas). Semáforo ±{{ money(d.tolerance) }}.
        Diferencias esperadas: Kepler registra lo capturado, hay cheques en tránsito y timing.
        Clic en un Δ → <b>qué lo explica</b>; clic en una cuenta → <b>dónde está el descuadre</b>
        (movimientos que faltan de cada lado).</p>

      <!-- ── Cobertura: captura pendiente ≠ descuadre. Mide DÍAS del periodo capturados, no
           conteos — el banco registra en bulto lo que Kepler parte por venta. Sólo aparece
           cuando alguna fuente va corta; si las 3 están al día no hay nada que decir. ── -->
      @if (anyStale(d)) {
        <div class="cg-legacy-note" role="note">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>Cobertura despareja: {{ covSummary(d) }}. Sus diferencias son <b>captura pendiente</b>,
          no descuadre — se cierran cuando esa fuente se pone al día. El banco (Workbook) va al día.</span>
        </div>
      }

      <!-- ── Veredicto: una línea, DESPUÉS del dinero y su lectura ── -->
      <div class="cg-verdict" [class.ok]="d.cuadra" [class.warn]="!d.cuadra">
        @if (d.cuadra) {
          <i class="pi pi-check-circle" aria-hidden="true"></i> <b>Cuadra</b> — las 3 fuentes empatan en {{ d.period }} (±{{ money(d.tolerance) }}).
        } @else {
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i> <b>{{ badAccounts(d) }} cuenta(s) con diferencia</b> — {{ verdictGaps(d) }}. Ábrelas abajo.
        }
      </div>

      <!-- ── Por cuenta: el desglose, con el drill DENTRO de la fila ── -->
      <p-table [value]="d.por_cuenta" dataKey="account_label" [expandedRowKeys]="expanded()"
               styleClass="p-datatable-sm surf-table surf-table--sticky" [rowHover]="true"
               [scrollable]="true" scrollHeight="flex" [paginator]="d.por_cuenta.length > 60" [rows]="60">
        <ng-template #header>
          <tr>
            <th class="cg-w-x" rowspan="2"></th>
            <th rowspan="2" pSortableColumn="bank">Cuenta <p-sorticon field="bank" /></th>
            <th class="ta-r" colspan="3"><i class="pi pi-arrow-down-left cg-in" aria-hidden="true"></i> Depósitos</th>
            <th class="ta-r" colspan="3"><i class="pi pi-arrow-up-right cg-eg" aria-hidden="true"></i> Retiros</th>
            <th class="ta-r cg-w-e" rowspan="2" pSortableColumn="worst_abs"
                title="Peor desviación contra el banco entre las fuentes disponibles">Diferencia <p-sorticon field="worst_abs" /></th>
          </tr>
          <tr>
            <th class="ta-r cg-sub">Workbook</th><th class="ta-r cg-sub">Kepler</th><th class="ta-r cg-sub">ContPAQi</th>
            <th class="ta-r cg-sub">Workbook</th><th class="ta-r cg-sub">Kepler</th><th class="ta-r cg-sub">ContPAQi</th>
          </tr>
        </ng-template>

        <ng-template #body let-r>
          <tr class="cg-row-click" [class.cg-row-open]="isExp(r)" (click)="toggleAcct(d.period, r)">
            <td><i class="pi cg-chev" [class.pi-chevron-right]="!isExp(r)" [class.pi-chevron-down]="isExp(r)" aria-hidden="true"></i></td>
            <td class="cg-emp" [title]="r.bank + ' ' + r.account_label">
              <b>{{ r.bank }}</b> <span class="muted cg-mono">{{ r.account_label }}</span>
              @if (!r.linked) { <span class="muted"> · sin enlazar</span> }
            </td>
            <td class="ta-r num strong">{{ money(r.wb_in) }}</td>
            <td class="ta-r num cg-kep" [class.warn]="r.kep_has && !cuad(r.delta_wk_in)">{{ r.kep_has ? money(r.kep_in) : '—' }}</td>
            <td class="ta-r num muted" [class.warn]="r.linked && !cuad(r.delta_in)">{{ r.linked ? money(r.cp_in) : '—' }}</td>
            <td class="ta-r num strong">{{ money(r.wb_out) }}</td>
            <td class="ta-r num cg-kep" [class.warn]="r.kep_has && !cuad(r.delta_wk_out)">{{ r.kep_has ? money(r.kep_out) : '—' }}</td>
            <td class="ta-r num muted" [class.warn]="r.linked && !cuad(r.delta_out)">{{ r.linked ? money(r.cp_out) : '—' }}</td>
            <!-- La diferencia como CIFRA + contra qué fuente: el tinte solo no dice cuánto ni de quién. -->
            <td class="ta-r cg-w-e">
              @if (!r.comparable) { <span class="muted">sin comparar</span> }
              @else if (r.cuadra) { <p-tag value="cuadra" severity="success" styleClass="cg-tag" /> }
              @else { <p-tag [value]="money(r.worst_delta) + ' vs ' + (r.worst_src === 'K' ? 'Kepler' : 'ContPAQi')" severity="warn" styleClass="cg-tag" /> }
            </td>
          </tr>
        </ng-template>

        <ng-template #expandedrow let-r>
          <tr class="cg-detail-row"><td colspan="10">
            @if (drillLoad()[r.account_label]) { <div class="muted cg-drill-none">Casando movimientos de la cuenta…</div> }
            @else if (drillErr()[r.account_label]; as e) { <div class="cg-dayerr"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ e }}</div> }
            @else if (drill()[r.account_label]; as dd) {
              <p class="cg-drill-lead">Enfrentamos cada movimiento del <b>banco (Workbook)</b> contra cada fuente por
                importe y dirección. Lo que casa desaparece; <b>lo que queda es el descuadre</b> — a la izquierda lo
                que el banco movió y la fuente no tiene, a la derecha lo que la fuente registra y el banco no movió.</p>
              @for (p of pairings(dd, r); track p.key) {
                <div class="cg-pair">
                  <div class="cg-pair-t">vs {{ p.title }}</div>
                  <div class="cg-side">
                    <div class="cg-side-h">
                      <span class="cg-side-name">{{ p.name }}</span>
                      @if (cuad(p.delta)) { <p-tag value="cuadra" severity="success" styleClass="cg-tag" /> }
                      @else { <p-tag [value]="'Δ ' + money(p.delta)" severity="warn" styleClass="cg-tag" /> }
                      <span class="muted cg-side-sub">Banco {{ money(p.wb_total) }} · {{ p.short }} {{ money(p.other_total) }} · {{ p.matched }} casados</span>
                    </div>
                    @if (!p.wb_only.length && !p.other_only.length) {
                      <p class="cg-drill-clean muted"><i class="pi pi-check-circle" aria-hidden="true"></i> Todo casa.</p>
                    } @else {
                      <div class="cg-drill-cols">
                        <div class="cg-drill-col">
                          <div class="cg-drill-colh cg-col-caja">En el banco, sin {{ p.short }} ({{ p.wb_only.length }}) · {{ money(p.wb_only_amount) }}</div>
                          @if (p.wb_only.length) {
                            <table class="cg-daytbl"><tbody>
                              @for (m of p.wb_only; track m.id) {
                                <tr><td class="cg-mono muted">{{ dmShort(m.fecha) }}</td>
                                  <td class="ta-r num strong">{{ money(m.importe) }}</td>
                                  <td class="cg-emp" [title]="m.concepto || ''">{{ m.concepto || '—' }}</td></tr>
                              }
                            </tbody></table>
                          } @else { <p class="cg-drill-none muted">— nada —</p> }
                        </div>
                        <div class="cg-drill-col">
                          <div class="cg-drill-colh cg-col-other">En {{ p.short }}, sin el banco ({{ p.other_only.length }}) · {{ money(p.other_only_amount) }}</div>
                          @if (p.other_only.length) {
                            <table class="cg-daytbl"><tbody>
                              @for (m of p.other_only; track m.id) {
                                <tr><td class="cg-mono muted">{{ dmShort(m.fecha) }}</td>
                                  <td class="ta-r num strong">{{ money(m.importe) }}</td>
                                  <td class="cg-emp" [title]="m.concepto || ''">{{ m.concepto || '—' }}</td></tr>
                              }
                            </tbody></table>
                          } @else { <p class="cg-drill-none muted">— nada —</p> }
                        </div>
                      </div>
                    }
                  </div>
                </div>
              }
              <div class="cg-drill-foot">
                <button type="button" class="cg-xls" [disabled]="exporting()" (click)="exportDrill(dd, r)"
                        title="Descarga el detalle de esta cuenta">
                  <i class="pi" [class.pi-file-excel]="!exporting()" [class.pi-spin]="exporting()" [class.pi-spinner]="exporting()" aria-hidden="true"></i> Excel de la cuenta
                </button>
              </div>
            }
          </td></tr>
        </ng-template>

        <ng-template #emptymessage><tr><td colspan="10"><div class="cg-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>Sin cuentas para {{ d.period }}.</span></div></td></tr></ng-template>
      </p-table>

      <div class="cg-foot">
        <button type="button" class="cg-xls" [disabled]="exporting()" (click)="exportCuadre(d)"
                title="Descarga el control-total y el desglose por cuenta">
          <i class="pi" [class.pi-file-excel]="!exporting()" [class.pi-spin]="exporting()" [class.pi-spinner]="exporting()" aria-hidden="true"></i> Excel del cuadre
        </button>
      </div>

      <!-- ── Cheques en tránsito: el gap de timing banco↔Kepler ── -->
      @if (cheques(); as ch) {
        @if (ch.total.en_transito_n > 0) {
          <h3 class="cg-h3" id="tw-cheques">Cheques en tránsito</h3>
          <p class="cg-note" style="margin-top:0">Kepler descuenta el cheque al emitirlo; el banco, cuando se cobra.
            <b>{{ money(ch.total.en_transito_monto) }}</b> en {{ ch.total.en_transito_n }} cheques sin cobrar explican
            por qué Kepler puede mostrar más salida que el banco. Ya cobrados: {{ money(ch.total.cobrado_monto) }} ({{ ch.total.cobrado_n }}).</p>
          <div class="cg-daywrap">
            <table class="cg-daytbl">
              <thead><tr><th>Cuenta</th><th>Doc</th><th>Beneficiario</th><th class="ta-r">Importe</th><th>Emitido</th></tr></thead>
              <tbody>
                @for (q of transito(ch); track q.folio) {
                  <tr><td class="cg-mono">{{ q.account_label }}</td><td class="cg-mono muted">{{ q.doc_tipo }} {{ q.folio }}</td>
                    <td class="cg-emp" [title]="q.beneficiario || ''">{{ q.beneficiario || '—' }}</td>
                    <td class="ta-r num strong">{{ money(q.importe) }}</td>
                    <td class="cg-mono muted">{{ dmy(q.fecha) }}</td></tr>
                }
              </tbody>
            </table>
          </div>
          @if (ch.total.en_transito_n > 50) {
            <p class="cg-note">Mostrando 50 de {{ ch.total.en_transito_n }} cheques sin cobrar.</p>
          }
        }
      }
    } @else {
      <div class="cg-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>Sin datos de cuadre para {{ period() }}.</span></div>
    }

    <!-- Qué explica un descuadre del control-total. Dos niveles, y el orden importa: primero el
         reparto POR CUENTA, que suma el total exacto, y recién después los movimientos, que
         ilustran pero no cuadran solos (un movimiento casado con importe distinto también mueve
         el Δ). Presentarlos al revés haría creer que la lista de movimientos ES el descuadre. -->
    <p-dialog [visible]="expOpen()" (visibleChange)="expOpen.set($event)" [modal]="true" [dismissableMask]="true"
              [style]="{ width: '58rem', maxWidth: '96vw' }" [draggable]="false" [header]="expTitle()">
      @if (expCtx(); as ctx) {
        <p class="cg-drill-lead">
          Faltan <b class="num warn">{{ money(ctx.delta) }}</b> entre <b>{{ ctx.a }}</b> y <b>{{ ctx.b }}</b>
          en {{ ctx.rowLabel.toLowerCase() }} de {{ period() }}. Se reparte así entre las cuentas.
          @if (!expResidual()) { <b>Las contribuciones suman el total exacto.</b> }
        </p>

        @if (chequesHint(); as h) {
          <p class="cg-legacy-note">
            <i class="pi pi-info-circle" aria-hidden="true"></i>
            <span><b>{{ money(h.monto) }}</b> de esta diferencia son <b>{{ h.n }} cheques emitidos y no cobrados</b>:
            Kepler los descuenta al emitir, el banco cuando se presentan. No es descuadre.
            <button type="button" class="cg-xls cg-hint-go" (click)="goToCheques()">Ver cheques <i class="pi pi-arrow-right" aria-hidden="true"></i></button></span>
          </p>
        }

        @if (expResidual(); as resto) {
          <p class="cg-legacy-note">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            <span><b class="num">{{ money(resto) }}</b> del descuadre no cae en ninguna cuenta del desglose:
            alguna fuente tiene movimientos en una cuenta que no está en el catálogo de bancos.
            Revisá el enlace de cuentas en Configuración.</span>
          </p>
        }

        @if (expAccounts().length) {
          @for (a of expAccounts(); track a.account_label) {
            <div class="cg-pair">
              <div class="cg-side-h">
                <span class="cg-side-name">{{ a.bank }} <span class="muted cg-mono">{{ a.account_label }}</span></span>
                @if (a.falta_en) { <p-tag [value]="'sin datos en ' + a.falta_en" severity="warn" styleClass="cg-tag" /> }
                <span class="num warn cg-exp-d">{{ money(a.delta) }}</span>
                <span class="muted cg-side-sub">{{ a.pct }}% del descuadre</span>
              </div>

              @if (expMovs()[a.account_label]; as movs) {
                @if (movs.length) {
                  <table class="cg-daytbl"><tbody>
                    @for (m of movs; track $index) {
                      <tr><td class="cg-mono muted">{{ dmShort(m.fecha) }}</td>
                        <td class="ta-r num strong">{{ money(m.importe) }}</td>
                        <td class="muted">falta en {{ m.falta_en }}</td>
                        <td class="cg-emp" [title]="m.concepto">{{ m.concepto }}</td></tr>
                    }
                  </tbody></table>
                } @else {
                  <p class="cg-drill-none muted">Ningún movimiento falta por completo en una fuente: la diferencia
                    viene de importes que no coinciden. Se ven al abrir la cuenta.</p>
                }
              } @else if (expLoading()) {
                <p class="cg-drill-none muted"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Cargando movimientos…</p>
              }
            </div>
          }
          @if (expRest() > 0) {
            <p class="cg-note">Se muestran las {{ expAccounts().length }} cuentas de mayor aporte
              (cubren el {{ expShownPct() }}% de la diferencia bruta). Quedan {{ expRest() }} con aportes menores.</p>
          }
          <p class="cg-note">Los movimientos listados son los que <b>faltan por completo</b> en una de las dos fuentes
            ({{ ctx.hint }}). No suman el Δ por sí solos: un movimiento presente en ambas con importe distinto también
            lo mueve, y ese aparece al abrir la cuenta.</p>
        } @else {
          <div class="cg-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>Ninguna cuenta aporta al descuadre por encima de un centavo.</span></div>
        }
      }
    </p-dialog>
  `,
  styles: [CUADRE_STYLES, `
    /* Encabezado de sección dentro de la vista (mismo tamaño que en caja). */
    .cg-h3 { font-size:.9rem; font-weight:700; margin:1.2rem 0 .5rem; }

    /* El Δ que no cuadra es un botón: subrayado punteado para que se lea clicable sin
       convertirse en un enlace azul en medio de una columna de cifras. */
    .cg-dlink { font:inherit; font-family:var(--font-mono); font-variant-numeric:tabular-nums; color:inherit;
      background:none; border:none; padding:0; cursor:pointer; display:inline-flex; align-items:center; gap:.25rem;
      text-decoration:underline; text-decoration-style:dotted; text-underline-offset:3px; }
    .cg-dlink i { font-size:.7rem; opacity:0; transition:opacity 120ms ease; }
    .cg-dlink:hover i { opacity:.8; }
    .cg-dlink:focus-visible { outline:2px solid var(--action-ring); outline-offset:2px; border-radius:var(--r-sm); }

    /* Export: ghost, discreto — es acción secundaria. */
    .cg-xls { display:inline-flex; align-items:center; gap:4px; background:none; border:1px solid var(--border-color);
      border-radius:var(--r-sm); color:var(--text-muted); font:inherit; font-size:.72rem; padding:2px .5rem; cursor:pointer; }
    .cg-xls:hover:not(:disabled) { color:var(--text-main); background:var(--hover-bg); }
    .cg-xls:disabled { opacity:.6; cursor:default; }
    .cg-xls:focus-visible { outline:2px solid var(--action-ring); outline-offset:1px; }
    .cg-foot { display:flex; justify-content:flex-end; margin-top:.5rem; }
    .cg-drill-foot { display:flex; justify-content:flex-end; }
    .cg-hint-go { margin-left:.4rem; }

    /* Aporte de una cuenta al descuadre: empuja el % al extremo derecho del renglón. */
    .cg-exp-d { margin-left:auto; font-weight:700; }
  `],
})
export class BancosThreeWayComponent {
  readonly data = input.required<ThreeWay | null>();
  readonly period = input<string>('');

  private readonly api = inject(BankService);
  private readonly destroyRef = inject(DestroyRef);

  readonly money = money;
  readonly dmy = dmy;
  readonly dmShort = dmShort;
  readonly PAIRS: TwPair[] = ['wk', 'wc', 'kc'];
  readonly PAIR_META = PAIR_META;

  /** Cheques en tránsito del periodo. */
  readonly cheques = signal<ChequesTransito | null>(null);

  // ── Drill por cuenta, DENTRO de la fila ──────────────────────────────────
  // Se cachea por cuenta: reabrir una fila ya vista no vuelve a pegarle al API, y quedan
  // varias abiertas a la vez para comparar cuentas sin perder ninguna (lo que el diálogo
  // hacía imposible).
  readonly expanded = signal<Record<string, boolean>>({});
  readonly drill = signal<Record<string, ThreeWayDetail>>({});
  readonly drillLoad = signal<Record<string, boolean>>({});
  readonly drillErr = signal<Record<string, string>>({});

  isExp(r: ThreeWayAccount): boolean { return !!this.expanded()[r.account_label]; }

  toggleAcct(period: string, r: ThreeWayAccount): void {
    const k = r.account_label;
    const open = { ...this.expanded() };
    if (open[k]) { delete open[k]; this.expanded.set(open); return; }
    open[k] = true;
    this.expanded.set(open);
    if (this.drill()[k] || this.drillLoad()[k]) return;
    this.drillLoad.update((m) => ({ ...m, [k]: true }));
    this.api.threeWayDetail(period, k).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (dd) => {
        this.drill.update((m) => ({ ...m, [k]: dd }));
        this.drillLoad.update((m) => ({ ...m, [k]: false }));
      },
      error: (e) => {
        // Un drill que falla lo dice. Tragarlo se leía igual que "esta cuenta casa perfecto".
        this.drillErr.update((m) => ({ ...m, [k]: this.httpMsg(e) }));
        this.drillLoad.update((m) => ({ ...m, [k]: false }));
      },
    });
  }

  private httpMsg(e: { status?: number }): string {
    const s = e?.status ?? 0;
    if (s === 0) return 'Sin conexión con el servidor.';
    if (s === 404) return 'El endpoint del detalle no existe en el servidor (¿API sin desplegar?).';
    if (s === 403 || s === 401) return 'Sin permiso o sesión vencida.';
    return `No se pudo cargar el detalle de la cuenta (error ${s}).`;
  }

  /**
   * Las dos comparaciones de una cuenta, en la forma que pinta el detalle: por cada fuente,
   * lo que el banco tiene y ella no, y lo que ella registra y el banco no movió.
   *
   * Sólo se ofrece la comparación que EXISTE: una cuenta sin datos en Kepler o sin enlace a
   * ContPAQi no genera su par, porque una lista vacía ahí se leería como "todo casa".
   */
  pairings(dd: ThreeWayDetail, r: ThreeWayAccount) {
    const out: {
      key: string; title: string; name: string; short: string; delta: number;
      wb_total: number; other_total: number; matched: number;
      wb_only: { id: string; fecha: string; importe: number; concepto: string | null }[];
      other_only: { id: string; fecha: string; importe: number; concepto: string | null }[];
      wb_only_amount: number; other_only_amount: number;
    }[] = [];
    const sum = <T extends { importe: number }>(xs: T[]) => Math.round(xs.reduce((s, x) => s + x.importe, 0) * 100) / 100;

    if (r.kep_has) {
      const solo = dd.excel.filter((e) => !e.kepler)
        .map((e) => ({ id: e.id, fecha: e.fecha, importe: e.importe, concepto: e.concepto }));
      const otro = dd.kepler_only.map((k) => ({ id: k.doc, fecha: k.fecha, importe: k.importe, concepto: k.concepto || k.doc }));
      out.push({
        key: 'kep', title: 'Kepler (tesorería del ERP)', name: 'Banco vs Kepler', short: 'Kepler',
        delta: Math.round(((r.delta_wk_in) + (r.delta_wk_out)) * 100) / 100,
        wb_total: Math.round((r.wb_in + r.wb_out) * 100) / 100,
        other_total: Math.round((r.kep_in + r.kep_out) * 100) / 100,
        matched: dd.totals.excel_en_kepler,
        wb_only: solo, other_only: otro, wb_only_amount: sum(solo), other_only_amount: sum(otro),
      });
    }
    if (r.linked) {
      const solo = dd.excel.filter((e) => !e.contpaqi)
        .map((e) => ({ id: e.id, fecha: e.fecha, importe: e.importe, concepto: e.concepto }));
      const otro = dd.contpaqi_only.map((c) => ({ id: c.poliza, fecha: c.fecha, importe: c.importe, concepto: c.concepto || c.poliza }));
      out.push({
        key: 'cpq', title: 'ContPAQi (libros fiscales)', name: 'Banco vs ContPAQi', short: 'ContPAQi',
        delta: Math.round(((r.delta_in) + (r.delta_out)) * 100) / 100,
        wb_total: Math.round((r.wb_in + r.wb_out) * 100) / 100,
        other_total: Math.round((r.cp_in + r.cp_out) * 100) / 100,
        matched: dd.totals.excel_en_contpaqi,
        wb_only: solo, other_only: otro, wb_only_amount: sum(solo), other_only_amount: sum(otro),
      });
    }
    return out;
  }

  constructor() {
    effect(() => {
      const d = this.data();
      this.cheques.set(null);
      // Periodo nuevo: se descarta el cache de drills; si no, una fila abierta mostraría
      // los movimientos del mes anterior bajo los totales del nuevo.
      this.expanded.set({}); this.drill.set({}); this.drillLoad.set({}); this.drillErr.set({});
      if (d?.period) {
        this.api.chequesTransito(d.period).pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({ next: (c) => this.cheques.set(c), error: () => this.cheques.set(null) });
      }
    });
  }

  // ── Qué explica un descuadre del control-total ───────────────────────────
  /** Cuántas cuentas se detallan. Más de seis deja de ser una explicación. */
  private readonly EXP_TOP = 6;

  readonly expOpen = signal(false);
  readonly expLoading = signal(false);
  readonly expCtx = signal<{ row: TwRow; pair: TwPair; rowLabel: string; a: string; b: string; hint: string; delta: number } | null>(null);
  /** Reparto por cuenta: exacto, suma el Δ del control-total. */
  readonly expAccounts = signal<ExplainAccount[]>([]);
  /** Movimientos por cuenta; llegan después, en paralelo. */
  readonly expMovs = signal<Record<string, ExplainMovement[]>>({});
  /** Cuentas con aporte que quedaron fuera del top. */
  readonly expRest = signal(0);
  /** Qué parte de la diferencia BRUTA cubren las cuentas mostradas. */
  readonly expShownPct = signal(0);
  /**
   * Δ del control-total menos la suma de TODAS las cuentas.
   *
   * Debería ser cero: el total y el desglose salen del mismo periodo. Pero el total de Kepler
   * suma todas sus cuentas mientras `por_cuenta` sale del cruce Workbook↔ContPAQi, así que una
   * cuenta que exista en Kepler y no en nuestro catálogo entraría al total sin caer en ninguna
   * fila. No pude descartarlo con datos, así que en vez de confiar se calcula y se muestra
   * cuando aparece: el panel no puede afirmar de más.
   */
  readonly expResidual = signal(0);

  readonly expTitle = computed(() => {
    const c = this.expCtx();
    return c ? `Qué explica el descuadre — ${c.rowLabel} · ${c.a} vs ${c.b}` : 'Descuadre';
  });

  /**
   * Cheques en tránsito, sólo cuando son pertinentes al descuadre que se está mirando: el par
   * Workbook↔Kepler en egresos. En cualquier otro par no explican nada y ofrecerlos sería ruido.
   */
  readonly chequesHint = computed(() => {
    const c = this.expCtx(), ch = this.cheques();
    if (!c || c.pair !== 'wk' || c.row !== 'egresos') return null;
    if (!ch || !ch.total.en_transito_n) return null;
    return { n: ch.total.en_transito_n, monto: ch.total.en_transito_monto };
  });

  goToCheques(): void {
    this.expOpen.set(false);
    setTimeout(() => document.getElementById('tw-cheques')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60);
  }

  /** Abre el panel para un Δ del control-total. */
  explain(d: ThreeWay, row: ThreeWayRow, pair: TwPair): void {
    const key: TwRow = row.label.toLowerCase().startsWith('ing') ? 'ingresos' : 'egresos';
    const meta = PAIR_META[pair];
    const all = explainAccounts(d, key, pair);
    const top = all.slice(0, this.EXP_TOP);
    const totalAbs = all.reduce((s2, a) => s2 + Math.abs(a.delta), 0) || 1;
    const shown = top.reduce((s2, a) => s2 + Math.abs(a.delta), 0);
    const suma = all.reduce((s2, a) => s2 + a.delta, 0);
    this.expResidual.set(Math.round((totalDelta(row, pair) - suma) * 100) / 100);

    this.expCtx.set({ row: key, pair, rowLabel: row.label, a: meta.a, b: meta.b, hint: meta.hint, delta: totalDelta(row, pair) });
    this.expAccounts.set(top);
    this.expRest.set(all.length - top.length);
    this.expShownPct.set(Math.round((shown / totalAbs) * 100));
    this.expMovs.set({});
    this.expOpen.set(true);
    this.loadExpMovs(d.period, key, pair, top);
  }

  /**
   * Trae el detalle de cada cuenta en paralelo. Una cuenta que falle no tumba al resto: queda
   * sin lista y el reparto —que es lo que explica el número— sigue en pie.
   */
  private loadExpMovs(period: string, row: TwRow, pair: TwPair, accts: ExplainAccount[]): void {
    if (!accts.length) return;
    this.expLoading.set(true);
    forkJoin(
      accts.map((a) => this.api.threeWayDetail(period, a.account_label).pipe(catchError(() => of(null)))),
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((res) => {
        const map: Record<string, ExplainMovement[]> = {};
        res.forEach((dd, i) => {
          if (dd) map[accts[i].account_label] = explainMovements(dd as ThreeWayDetail, row, pair);
        });
        this.expMovs.set(map);
        this.expLoading.set(false);
      });
  }

  transito(ch: ChequesTransito) { return ch.cheques.filter((q) => !q.cobrado).slice(0, 50); }

  // ── Export ───────────────────────────────────────────────────────────────
  readonly exporting = signal(false);

  async exportDrill(dd: ThreeWayDetail, r: ThreeWayAccount): Promise<void> {
    this.exporting.set(true);
    try {
      const sheets: XlsxSheet<any>[] = [{
        name: 'Detalle 3 vias',
        subtitle: `${r.bank} ${r.account_label} - ${dd.period} - ${dd.excel.length} movimientos del banco`,
        rows: dd.excel,
        cols: [
          { header: 'Fecha', get: (x: any) => x.fecha, type: 'date', width: 12 },
          { header: 'Direccion', get: (x: any) => (x.dir === 'in' ? 'Deposito' : 'Retiro'), width: 11 },
          { header: 'Workbook', get: (x: any) => x.importe, type: 'money', total: true },
          { header: 'Kepler', get: (x: any) => x.kepler_importe, type: 'money', total: true },
          { header: 'Doc Kepler', get: (x: any) => x.kepler_doc, width: 16 },
          { header: 'ContPAQi', get: (x: any) => x.contpaqi_importe, type: 'money', total: true },
          { header: 'Poliza ContPAQi', get: (x: any) => x.contpaqi_poliza, width: 16 },
          { header: 'Concepto', get: (x: any) => x.concepto, width: 46 },
        ],
      }];
      if (dd.kepler_only.length) {
        sheets.push({
          name: 'En Kepler sin banco', rows: dd.kepler_only,
          cols: [
            { header: 'Fecha', get: (x: any) => x.fecha, type: 'date', width: 12 },
            { header: 'Doc', get: (x: any) => x.doc, width: 16 },
            { header: 'Importe', get: (x: any) => x.importe, type: 'money', total: true },
            { header: 'Metodo', get: (x: any) => x.metodo, width: 14 },
            { header: 'Concepto', get: (x: any) => x.concepto, width: 46 },
          ],
        });
      }
      if (dd.contpaqi_only.length) {
        sheets.push({
          name: 'En ContPAQi sin banco', rows: dd.contpaqi_only,
          cols: [
            { header: 'Fecha', get: (x: any) => x.fecha, type: 'date', width: 12 },
            { header: 'Poliza', get: (x: any) => x.poliza, width: 16 },
            { header: 'Importe', get: (x: any) => x.importe, type: 'money', total: true },
            { header: 'Concepto', get: (x: any) => x.concepto, width: 46 },
          ],
        });
      }
      await exportXlsx(`Detalle 3 vias ${r.account_label} ${dd.period}`, sheets);
    } finally { this.exporting.set(false); }
  }

  async exportCuadre(d: ThreeWay): Promise<void> {
    this.exporting.set(true);
    try {
      await exportXlsx('Cuadre 3 vias ' + d.period, [
        {
          name: 'Control-total', subtitle: d.period + ' - tolerancia +/-' + d.tolerance,
          rows: this.rows(d),
          cols: [
            { header: '', get: (r: any) => r.label, width: 18 },
            { header: 'Workbook', get: (r: any) => r.workbook, type: 'money', total: true },
            { header: 'Kepler (tesoreria)', get: (r: any) => r.kepler, type: 'money', total: true },
            { header: 'ContPAQi', get: (r: any) => r.contpaqi, type: 'money', total: true },
            { header: 'Delta W-K', get: (r: any) => r.delta_wk, type: 'money', total: true },
            { header: 'Delta W-C', get: (r: any) => r.delta_wc, type: 'money', total: true },
            { header: 'Delta K-C', get: (r: any) => r.delta_kc, type: 'money', total: true },
          ],
        },
        {
          name: 'Por cuenta', rows: d.por_cuenta,
          cols: [
            { header: 'Banco', get: (r: any) => r.bank, width: 20 },
            { header: 'Cuenta', get: (r: any) => r.account_label, width: 16 },
            { header: 'Dep. Workbook', get: (r: any) => r.wb_in, type: 'money', total: true },
            { header: 'Dep. Kepler', get: (r: any) => (r.kep_has ? r.kep_in : null), type: 'money', total: true },
            { header: 'Dep. ContPAQi', get: (r: any) => r.cp_in, type: 'money', total: true },
            { header: 'Ret. Workbook', get: (r: any) => r.wb_out, type: 'money', total: true },
            { header: 'Ret. Kepler', get: (r: any) => (r.kep_has ? r.kep_out : null), type: 'money', total: true },
            { header: 'Ret. ContPAQi', get: (r: any) => r.cp_out, type: 'money', total: true },
            { header: 'Diferencia', get: (r: any) => (r.comparable && !r.cuadra ? r.worst_delta : null), type: 'money', total: true },
            { header: 'Diferencia vs', get: (r: any) => (r.comparable && !r.cuadra ? (r.worst_src === 'K' ? 'Kepler' : 'ContPAQi') : ''), width: 14 },
            { header: 'Enlazada a ContPAQi', get: (r: any) => (r.linked ? 'Si' : 'No'), width: 18 },
          ],
        },
      ]);
    } finally { this.exporting.set(false); }
  }

  // ── Lecturas ─────────────────────────────────────────────────────────────
  /**
   * Tolerancia de cuadre: la manda el servidor. El encabezado imprimía `d.tolerance` mientras
   * las celdas semaforeaban con un 1000 hardcodeado; el día que el backend mueva TOL, la
   * pantalla decía "±$X" y pintaba con otro número.
   */
  tol(): number { return this.data()?.tolerance ?? 1000; }
  cuad(delta: number): boolean { return Math.abs(delta) < this.tol(); }

  rows(d: ThreeWay): ThreeWayRow[] { return [d.total.ingresos, d.total.egresos]; }

  delta(r: ThreeWayRow, p: TwPair): number { return totalDelta(r, p); }

  /** Cuentas que no cuadran contra alguna de sus fuentes disponibles. */
  badAccounts(d: ThreeWay): number { return d.por_cuenta.filter((a) => a.comparable && !a.cuadra).length; }

  /** Qué renglón del control-total falla y con qué magnitud. */
  verdictGaps(d: ThreeWay): string {
    const gaps: string[] = [];
    const i = d.total.ingresos, e = d.total.egresos;
    if (!i.cuadra) gaps.push(`ingresos hasta ${money(this.maxDelta(i))}`);
    if (!e.cuadra) gaps.push(`egresos hasta ${money(this.maxDelta(e))}`);
    return gaps.length ? gaps.join(' y ') : 'el control-total cuadra, el desglose no';
  }
  private maxDelta(r: ThreeWayRow): number {
    return Math.max(Math.abs(r.delta_wk), Math.abs(r.delta_wc), Math.abs(r.delta_kc));
  }

  covSources(d: ThreeWay) {
    const c = d.coverage;
    return [
      { key: 'wb', label: 'Workbook (banco)', ...c.workbook },
      { key: 'kep', label: 'Kepler (tesorería)', ...c.kepler },
      { key: 'cpq', label: 'ContPAQi (libros)', ...c.contpaqi },
    ];
  }

  /** Qué fuente va corta y por cuánto, en llano. */
  covSummary(d: ThreeWay): string {
    const mal = this.covSources(d)
      .filter((s) => s.sin_datos || s.stale)
      .map((s) => `${s.label.split(' ')[0]} ${s.sin_datos ? 'sin datos del periodo' : `capturado sólo hasta el día ${s.days_covered} de ${s.days_target}`}`);
    return mal.join(' · ');
  }

  anyStale(d: ThreeWay): boolean {
    const c = d.coverage;
    return !!(c.kepler.stale || c.contpaqi.stale || c.kepler.sin_datos || c.contpaqi.sin_datos);
  }
}
