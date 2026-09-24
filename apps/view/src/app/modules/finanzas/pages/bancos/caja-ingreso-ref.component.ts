import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { BankService, IngresosControl, IngresosControlCuenta } from '../../bank.service';
import { money, dmShort } from './bancos-shared';
import { BANCOS_STYLES } from './bancos.styles';

/**
 * CB.35 — CONTROL de ingresos (no memo): ¿cada depósito del banco tiene origen?
 * Clasifica cada depósito contra tesorería Kepler + cobranza (UA0501) + caja de tienda,
 * con prioridad de fuente + consumo greedy. Lo que no case = EXCEPCIÓN accionable
 * (sin explicar → investigar). Además FUGA: caja registrada que no llegó al banco.
 * Read-only: consume /finance/bank/ingresos-control por periodo. Se embebe en Conciliación
 * y Concentrado (referencia compartida al lado de ingresos).
 */
@Component({
  selector: 'caja-ingreso-ref',
  standalone: true,
  imports: [CommonModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (data(); as c) {
      <div class="ic-card" [class.ic-ok]="c.cuadra" [class.ic-warn]="!c.cuadra">
        <div class="ic-head">
          <h3 class="ic-title">Control de ingresos <span class="muted">— ¿cada depósito del banco tiene origen? ({{ c.bank_n }} depósitos · {{ c.bank_total | currency:'MXN':'symbol-narrow':'1.2-2' }})</span></h3>
          @if (c.cuadra) {
            <span class="ic-verdict ok"><i class="pi pi-check-circle"></i> Cuadra</span>
          } @else {
            <span class="ic-verdict warn"><i class="pi pi-exclamation-triangle"></i> {{ c.sin_explicar.monto | currency:'MXN':'symbol-narrow':'1.2-2' }} sin explicar</span>
          }
        </div>

        <div class="ic-grid">
          <div class="ic-cell"><span class="ic-l">Tesorería Kepler</span><span class="ic-v ok">{{ c.via_tesoreria.monto | currency:'MXN':'symbol-narrow':'1.2-2' }}</span><span class="ic-s">{{ c.via_tesoreria.n }} · casó kdm1</span></div>
          <div class="ic-cell"><span class="ic-l">Cobranza cliente</span><span class="ic-v">{{ c.via_cobranza.monto | currency:'MXN':'symbol-narrow':'1.2-2' }}</span><span class="ic-s">{{ c.via_cobranza.n }} · UA0501</span></div>
          <div class="ic-cell"><span class="ic-l">Depósito de tienda</span><span class="ic-v">{{ c.via_caja.monto | currency:'MXN':'symbol-narrow':'1.2-2' }}</span><span class="ic-s">{{ c.via_caja.n }} · Caja</span></div>
          <!-- CB.47 — dinero nuestro cambiando de cuenta. Tiene celda propia porque NO es ingreso
               del negocio: sumarlo a ventas o listarlo como "sin origen" son los dos errores. -->
          @if (c.via_traspaso && c.via_traspaso.n > 0) {
            <div class="ic-cell"><span class="ic-l">Entre cuentas propias</span><span class="ic-v">{{ c.via_traspaso.monto | currency:'MXN':'symbol-narrow':'1.2-2' }}</span><span class="ic-s">{{ c.via_traspaso.n }} · no es ingreso</span></div>
          }
          <div class="ic-cell ic-excn" [class.hot]="c.sin_explicar.n > 0"><span class="ic-l">Sin explicar</span><span class="ic-v" [class.bad]="c.sin_explicar.n > 0">{{ c.sin_explicar.monto | currency:'MXN':'symbol-narrow':'1.2-2' }}</span><span class="ic-s">{{ c.sin_explicar.n }} depósitos</span></div>
        </div>

        <div class="ic-bar" role="img" [attr.aria-label]="'Explicado ' + pctExpl(c) + '%'">
          <span class="ic-seg tes" [style.width.%]="pct(c.via_tesoreria.monto, c.bank_total)"></span>
          <span class="ic-seg cob" [style.width.%]="pct(c.via_cobranza.monto, c.bank_total)"></span>
          <span class="ic-seg caj" [style.width.%]="pct(c.via_caja.monto, c.bank_total)"></span>
          <span class="ic-seg tra" [style.width.%]="pct(c.via_traspaso?.monto || 0, c.bank_total)"></span>
          <span class="ic-seg dec" [style.width.%]="pct(declarado(c), c.bank_total)"></span>
          <span class="ic-seg sin" [style.width.%]="pct(c.sin_explicar.monto, c.bank_total)"></span>
        </div>
        <p class="ic-note">
          <b class="ok">{{ pctExpl(c) }}% explicado</b> ({{ c.explicado | currency:'MXN':'symbol-narrow':'1.2-2' }}).
          @if (c.sin_explicar.n > 0) {
            El resto son depósitos que ninguna fuente explica — <b>revísalos</b> (¿transferencia no registrada? ¿ingreso ajeno? ¿otra cuenta/mes?).
          } @else { Todo depósito tiene origen. }
        </p>

        <!-- CB.46/47 — lo que NO se pudo medir se dice, no se reparte entre "explicado" y
             "sin explicar". Cada renglón trae la acción que de verdad lo resuelve. -->
        @if (declarado(c) > 0) {
          <p class="ic-declara">
            <i class="pi pi-info-circle"></i>
            <span>
              <b>{{ declarado(c) | currency:'MXN':'symbol-narrow':'1.2-2' }} no se pudo medir</b> — no entra ni en explicado ni en sin explicar:
              @if (c.traspaso_sin_contraparte && c.traspaso_sin_contraparte.n > 0) {
                <br><b>{{ c.traspaso_sin_contraparte.monto | currency:'MXN':'symbol-narrow':'1.2-2' }}</b>
                en {{ c.traspaso_sin_contraparte.n }} traspaso(s) sin la pata contraria — el dinero salió de una cuenta nuestra
                que <b>no tiene estado de cuenta cargado</b> este mes. Cárgalo y se resuelven solos.
              }
              @if (c.fecha_invalida && c.fecha_invalida.n > 0) {
                <br><b>{{ c.fecha_invalida.monto | currency:'MXN':'symbol-narrow':'1.2-2' }}</b>
                en {{ c.fecha_invalida.n }} movimiento(s) con la fecha fuera del periodo (año mal capturado en el Excel): con esa fecha no hay con qué cruzarlos.
              }
            </span>
          </p>
        }

        @if (c.por_cuenta?.length) {
          <button type="button" class="ic-toggle" (click)="openAcct.set(!openAcct())" [attr.aria-expanded]="openAcct()">
            <i class="pi" [class.pi-chevron-right]="!openAcct()" [class.pi-chevron-down]="openAcct()"></i>
            {{ openAcct() ? 'Ocultar' : 'Ver' }} desglose por cuenta ({{ c.por_cuenta.length }})
          </button>
          @if (openAcct()) {
            <div class="ic-tablewrap">
              <table class="ic-table">
                <!-- CB.47 — "Entre cuentas" es columna propia: sin ella las columnas no sumaban
                     el total de la fila y el faltante parecía un hueco. -->
                <thead><tr><th>Cuenta</th><th class="ta-r">Depósitos</th><th class="ta-r">Kepler (mayoreo)</th><th class="ta-r">Tienda</th><th class="ta-r">Entre cuentas</th><th class="ta-r">Sin medir</th><th class="ta-r">Sin explicar</th><th class="ta-r">% Kepler</th></tr></thead>
                <tbody>
                  @for (a of c.por_cuenta; track a.account_label) {
                    <tr>
                      <td class="mono">{{ a.account_label || a.bank || '—' }}</td>
                      <td class="ta-r mono">{{ a.bank_total | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                      <td class="ta-r mono ok">{{ a.kepler | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                      <td class="ta-r mono">{{ a.retail | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                      <td class="ta-r mono muted">{{ a.via_traspaso ? (a.via_traspaso | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</td>
                      <td class="ta-r mono muted">{{ sinMedir(a) ? (sinMedir(a) | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</td>
                      <td class="ta-r mono" [class.bad]="a.sin_explicar > 1">{{ a.sin_explicar | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                      <td class="ta-r mono">{{ pct(a.kepler, a.bank_total) | number:'1.0-0' }}%</td>
                    </tr>
                  }
                </tbody>
              </table>
              <p class="ic-more muted"><b>Kepler (mayoreo)</b> = tesorería (kdm1) + cobranza (UA0501). <b>Tienda</b> = depósito de Caja. <b>Entre cuentas</b> = traspaso interno con su retiro espejo localizado: es dinero nuestro moviéndose, no ingreso. <b>Sin medir</b> = traspaso sin la pata contraria o fecha fuera del periodo. Los depósitos de venta de menudeo (Wincaja) que Kepler no ve NO son de Kepler — por eso su rebanada es el mayoreo.</p>
            </div>
          }
        }

        @if (c.sin_explicar.n > 0) {
          <button type="button" class="ic-toggle" (click)="open.set(!open())" [attr.aria-expanded]="open()">
            <i class="pi" [class.pi-chevron-right]="!open()" [class.pi-chevron-down]="open()"></i>
            {{ open() ? 'Ocultar' : 'Ver' }} los {{ c.sin_explicar.n }} depósitos sin explicar
          </button>
          @if (open()) {
            <div class="ic-tablewrap">
              <table class="ic-table">
                <thead><tr><th>Fecha</th><th>Cuenta</th><th class="ta-r">Monto</th><th>Concepto</th></tr></thead>
                <tbody>
                  @for (e of c.exceptions; track e.id) {
                    <tr><td class="mono">{{ dmShort(e.fecha) }}</td><td class="mono">{{ e.account_label || e.bank || '—' }}</td>
                        <td class="ta-r mono bad">{{ e.monto | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                        <td class="ic-concept" [title]="e.concept">{{ e.concept || '—' }}</td></tr>
                  }
                </tbody>
              </table>
              @if (c.sin_explicar.n > c.exceptions.length) { <p class="ic-more muted">… y {{ c.sin_explicar.n - c.exceptions.length }} más (mostrando los {{ c.exceptions.length }} mayores).</p> }
            </div>
          }
        }

        @if (c.fuga.n > 0) {
          <p class="ic-fuga"><i class="pi pi-arrow-circle-up"></i> <b>Fuga:</b> {{ c.fuga.monto | currency:'MXN':'symbol-narrow':'1.2-2' }} en {{ c.fuga.n }} depósitos que Caja registró pero <b>no llegaron al banco</b> (rezago / no depositado). <a routerLink="/finanzas/caja" class="ic-link">Ver en Caja General <i class="pi pi-arrow-right"></i></a></p>
        }
      </div>
    }
  `,
  styles: [BANCOS_STYLES, `
    .ic-card { background: var(--card-bg); border: 1px solid var(--border-color); border-left: 3px solid var(--border-color); border-radius: var(--r-md); padding: 1rem 1.1rem; margin-bottom: var(--sp-3); }
    .ic-card.ic-ok { border-left-color: var(--ok-fg); } .ic-card.ic-warn { border-left-color: var(--warn-fg); }
    .ic-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; margin-bottom: var(--sp-3); }
    .ic-title { font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); margin: 0; }
    .ic-verdict { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-sm); font-weight: 700; white-space: nowrap; padding: 2px var(--sp-2); border-radius: var(--r-pill); }
    .ic-verdict.ok { color: var(--ok-fg); background: color-mix(in srgb, var(--ok-fg) 12%, transparent); }
    .ic-verdict.warn { color: var(--warn-fg); background: color-mix(in srgb, var(--warn-fg) 12%, transparent); }
    .ic-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: var(--sp-3); }
    .ic-cell { display: flex; flex-direction: column; gap: 2px; padding: var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .ic-cell.ic-excn.hot { border-color: var(--warn-fg); background: color-mix(in srgb, var(--warn-fg) 6%, transparent); }
    .ic-l { font-size: var(--fs-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em; }
    .ic-v { font-size: var(--fs-lg); font-weight: 700; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .ic-v.ok { color: var(--ok-fg); } .ic-v.bad { color: var(--warn-fg); }
    .ic-s { font-size: var(--fs-xs); color: var(--text-faint); }
    .ic-bar { display: flex; height: 8px; border-radius: var(--r-pill); overflow: hidden; margin: var(--sp-3) 0 var(--sp-2); background: var(--border-color); }
    .ic-seg { height: 100%; } .ic-seg.tes { background: var(--ok-fg); } .ic-seg.cob { background: var(--chart-2); } .ic-seg.caj { background: var(--chart-4); } .ic-seg.sin { background: var(--warn-fg); }
    /* CB.47 — traspaso = tono neutro de traspasos del Concentrado (GROUP_COLOR.traspaso).
       CB.46 — "declarado" en rayado: no es ni bueno ni malo, es que no se pudo medir. */
    .ic-seg.tra { background: var(--chart-8); }
    .ic-seg.dec { background: repeating-linear-gradient(45deg, var(--text-faint) 0 3px, transparent 3px 6px); }
    .ic-declara { display: flex; gap: var(--sp-2); align-items: flex-start; font-size: var(--fs-sm); line-height: 1.45;
      color: var(--text-muted); margin: var(--sp-3) 0 0; padding: var(--sp-2) var(--sp-3);
      border: 1px dashed var(--border-color); border-radius: var(--r-md); }
    .ic-declara i { color: var(--text-faint); margin-top: 2px; }
    .ic-declara b { color: var(--text-main); }
    .ic-note { font-size: var(--fs-sm); color: var(--text-main); margin: var(--sp-2, .5rem) 0 0; line-height: 1.4; } .bad { color: var(--warn-fg); }
    .ic-toggle { display: inline-flex; align-items: center; gap: 6px; margin-top: var(--sp-3); background: none; border: none; color: var(--action); font-weight: 600; font-size: var(--fs-sm); cursor: pointer; padding: 0; }
    .ic-toggle:hover { text-decoration: underline; }
    .ic-tablewrap { margin-top: var(--sp-2); overflow-x: auto; }
    .ic-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .ic-table th { text-align: left; font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted); padding: 4px 8px; border-bottom: 1px solid var(--border-color); }
    .ic-table td { padding: 4px 8px; border-bottom: 1px solid var(--border-color); }
    .ic-concept { max-width: 22rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); }
    .ic-more { font-size: var(--fs-xs); margin: var(--sp-2) 0 0; }
    .ic-fuga { font-size: var(--fs-sm); color: var(--text-main); margin: var(--sp-3) 0 0; line-height: 1.4; }
    .ic-link { color: var(--action); font-weight: 600; text-decoration: none; white-space: nowrap; }
    .ic-link:hover { text-decoration: underline; }
  `],
})
export class CajaIngresoRefComponent {
  readonly period = input<string>('');
  private readonly api = inject(BankService);
  private readonly destroyRef = inject(DestroyRef);
  readonly data = signal<IngresosControl | null>(null);
  readonly open = signal(false);
  readonly openAcct = signal(false);
  dmShort = dmShort;
  money = money;
  private seq = 0;

  constructor() {
    effect(() => {
      const p = this.period();
      if (!p || !/^\d{4}-\d{2}$/.test(p)) { this.data.set(null); return; }
      const token = ++this.seq;
      this.open.set(false);
      this.openAcct.set(false);
      this.api.ingresosControl(p).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (d) => { if (token === this.seq) this.data.set(d); },
        error: () => { if (token === this.seq) this.data.set(null); },
      });
    });
  }

  pct(part: number, total: number): number { return total > 0 ? Math.max(0, Math.min(100, (part / total) * 100)) : 0; }
  pctExpl(c: IngresosControl): number { return c.bank_total > 0 ? Math.round((c.explicado / c.bank_total) * 100) : 0; }
  /** CB.46/47 — el dinero cuyo origen NO se pudo medir; ni explicado ni sin explicar (ADR-056). */
  declarado(c: IngresosControl): number {
    return (c.traspaso_sin_contraparte?.monto || 0) + (c.fecha_invalida?.monto || 0);
  }
  /** Lo mismo, por cuenta, para que las columnas de la tabla sumen el total de su fila. */
  sinMedir(a: IngresosControlCuenta): number {
    return (a.traspaso_sin_contraparte || 0) + (a.fecha_invalida || 0);
  }
}
