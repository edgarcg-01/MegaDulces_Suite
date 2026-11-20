import { ChangeDetectionStrategy, Component, computed, effect, inject, model, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { SelectModule } from 'primeng/select';
import { diaMxDeInstante, type ArqueosResponse } from '@megadulces/contracts';
import { environment } from '../../../../../environments/environment';
import { LoadStateComponent } from '../../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, type MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { ContextHelpComponent } from '../../../../shared/context-help/context-help.component';
import { CashLedgerService, type MovimientoCaja } from '../../cash-ledger.service';
import { money, dmy } from '../finanzas-format';
import { armarEstadoDeCuenta, limitesDeMes, restarDias, type EstadoDeCuenta } from './estado-cuenta-caja.util';
import { avisosDelEstado, imprimirEstadoCuenta } from './estado-cuenta-caja-papel';

/**
 * ⭐ `[LE.6.38]` **Estado de cuenta de Caja General**, dentro de Arqueos (Edgar, 2026-11-20:
 * *«¿no podemos generar el arqueo y el estado de cuenta en uno solo?»*).
 *
 * Era una pestaña aparte con su propia tabla de cortes; Arqueos ya tiene esa tabla (un renglón por
 * corte, lo contado contra lo que debía haber) y cada corte se abre en su cuenta y sus movimientos.
 * Lo único que Arqueos no daba es la lectura del PERIODO (con cuánto arrancó y terminó el mes, y de
 * qué se compone) y la hoja para Tesorería y Dirección. Eso es este diálogo; el detalle por corte y
 * por movimiento con saldo corrido viaja en la hoja impresa.
 *
 * Jerarquía: primario = saldo final contra inicial; secundario = sus componentes; terciario = los avisos.
 */
const mesMx = (): string => (diaMxDeInstante(new Date()) ?? new Date().toISOString()).slice(0, 7);
/** El primer corte de Captura es del 12-oct-2026: antes no hay estado de cuenta que armar. */
const PRIMER_MES = '2026-10';
const NOMBRE_MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
/** Los movimientos llegan hasta 16 días antes de su corte (medido): se pide el doble de holgura. */
const HOLGURA_DIAS = 31;
const PAGINA = 500;
const TOPE_PAGINAS = 8;

@Component({
  selector: 'app-estado-cuenta-caja',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ButtonModule, DialogModule, SelectModule, LoadStateComponent, MetricStripComponent, ContextHelpComponent],
  template: `
    <p-dialog header="Estado de cuenta de Caja General" [(visible)]="visible" [modal]="true" [dismissableMask]="true"
              [style]="{ width: '58rem', maxWidth: '96vw' }" appendTo="body">
      <div class="ec-barra">
        <p-select [options]="meses" optionLabel="label" optionValue="value" [ngModel]="mes()" (onChange)="cambiarMes($event.value)"
                  ariaLabel="Mes" styleClass="ec-sel" />
        <span class="ec-sp"></span>
        <app-context-help topic="caja-estado-cuenta" />
        <p-button size="small" icon="pi pi-print" label="Imprimir o PDF" [disabled]="!estado()?.dias?.length" (onClick)="imprimir()" />
      </div>
      @if (avisoImpresion(); as a) { <p class="ec-avisos warn" role="alert">{{ a }}</p> }

      <app-load-state [loading]="cargando() && !estado()" [error]="error()" [isEmpty]="!!estado() && !estado()!.dias.length"
                      emptyIcon="pi-wallet" emptyTitle="Sin cortes sellados en este mes"
                      emptyHint="El estado de cuenta se arma con los cortes cerrados de Caja General."
                      errorTitle="No se pudo armar el estado de cuenta" (retry)="cargar()">
        @if (estado(); as e) {
          @if (e.dias.length) {
            <p class="ec-veredicto">
              Del {{ dmy(e.dias[0].fecha) }} al {{ dmy(e.dias[e.dias.length - 1].fecha) }} la caja pasó de
              <b class="num">{{ m(e.resumen.saldo_inicial) }}</b> a <b class="num">{{ m(e.resumen.saldo_final) }}</b>
              <span class="ec-cuadra">· {{ textoCuadre(e) }}</span>
            </p>
            <app-metric-strip [items]="kpis(e)" ariaLabel="De qué se compone el saldo del periodo" density="compact" [instant]="true" />
            @if (avisos().length) {
              <ul class="ec-avisos" aria-label="Lo que este estado de cuenta no puede afirmar">
                @for (a of avisos(); track a) { <li><i class="pi pi-info-circle" aria-hidden="true"></i> {{ a }}</li> }
              </ul>
            }
            @if (truncado()) {
              <p class="ec-avisos warn">El libro tenía más movimientos de los que se pidieron: puede faltar detalle (los totales de cada corte sí son completos).</p>
            }
            <p class="ec-pie">La hoja impresa lleva cada corte con sus movimientos y el saldo después de cada uno.</p>
          }
        }
      </app-load-state>
    </p-dialog>
  `,
  styles: [`
    :host { display: contents; }
    .ec-barra { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-3); }
    .ec-sp { flex: 1; }
    .ec-veredicto { font-size: var(--fs-lg); font-weight: 600; color: var(--text-main); margin: 0 0 var(--sp-3); }
    .ec-veredicto .num { font-variant-numeric: tabular-nums; }
    .ec-cuadra { font-size: var(--fs-sm); font-weight: 400; color: var(--text-muted); }
    .ec-avisos { list-style: none; margin: var(--sp-3) 0; padding: 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .ec-avisos li { margin-bottom: var(--sp-1); }
    .ec-avisos.warn { color: var(--bad-fg); }
    .ec-pie { font-size: var(--fs-xs); color: var(--text-muted); margin: var(--sp-3) 0 0; }
  `],
})
export class EstadoCuentaCajaComponent {
  private readonly http = inject(HttpClient);
  private readonly libro = inject(CashLedgerService);
  private readonly base = `${environment.apiUrl}/finance/cash-ledger`;

  readonly visible = model(false);
  readonly dmy = dmy;
  readonly meses = construirMeses(mesMx());
  readonly mes = signal(mesMx());
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly estado = signal<EstadoDeCuenta | null>(null);
  readonly truncado = signal(false);
  readonly avisoImpresion = signal<string | null>(null);
  readonly avisos = computed(() => { const e = this.estado(); return e ? avisosDelEstado(e) : []; });
  private pedido = 0;

  constructor() {
    // Se pide al abrir, no al entrar a Arqueos: son hasta 8 páginas del libro que la revisión diaria no usa.
    effect(() => { if (this.visible() && !this.estado() && !this.cargando()) void this.cargar(); });
  }

  cambiarMes(v: string): void {
    if (!v || v === this.mes()) return;
    this.mes.set(v);
    this.estado.set(null);
    void this.cargar();
  }

  async cargar(): Promise<void> {
    const yo = ++this.pedido;
    const periodo = limitesDeMes(this.mes());
    this.cargando.set(true);
    this.error.set(null);
    try {
      const params = new HttpParams().set('desde', periodo.desde).set('hasta', periodo.hasta).set('limit', '62');
      const [arq, movs] = await Promise.all([
        firstValueFrom(this.http.get<ArqueosResponse>(`${this.base}/cortes/arqueos`, { params })),
        this.movimientos(restarDias(periodo.desde, HOLGURA_DIAS), periodo.hasta),
      ]);
      if (yo !== this.pedido) return;
      this.truncado.set(movs.truncado);
      this.estado.set(armarEstadoDeCuenta(arq?.rows ?? [], movs.rows, periodo));
    } catch {
      if (yo === this.pedido) this.error.set('Revisa la conexión e intenta de nuevo.');
    } finally {
      if (yo === this.pedido) this.cargando.set(false);
    }
  }

  /** El libro de la ventana, página por página (el servidor entrega a lo más 500 por llamada). */
  private async movimientos(from: string, to: string): Promise<{ rows: MovimientoCaja[]; truncado: boolean }> {
    const rows: MovimientoCaja[] = [];
    for (let p = 0; p < TOPE_PAGINAS; p++) {
      const r = await firstValueFrom(this.libro.libro({ from, to, limit: PAGINA, offset: p * PAGINA }));
      rows.push(...(r?.rows ?? []));
      if (!r?.has_more) return { rows, truncado: false };
    }
    return { rows, truncado: true };
  }

  imprimir(): void {
    const e = this.estado();
    if (!e) return;
    this.avisoImpresion.set(imprimirEstadoCuenta(e, limitesDeMes(this.mes())) ? null : 'El navegador no dejó armar la hoja. Intenta de nuevo.');
  }

  kpis(e: EstadoDeCuenta): MetricStripItem[] {
    const r = e.resumen;
    const item = (label: string, v: number | null, sub?: string): MetricStripItem =>
      v == null ? { label, value: 'No medido', format: 'text', state: 'no_medido', sub } : { label, value: v, format: 'currency', sub };
    return [
      item('Saldo inicial', r.saldo_inicial, 'fondo del primer corte'),
      item('Entradas', r.entradas, `${r.movimientos} movimientos en ${r.dias} cortes`),
      item('Salidas', r.salidas),
      item('Caja fuerte (neto)', r.caja_fuerte, 'dejó en el cajón menos lo que se llevó'),
      item('Diferencias de arqueo', r.diferencias, 'contado menos lo que debía haber'),
      item('Saldo final', r.saldo_final, 'contado en el último corte'),
    ];
  }

  textoCuadre(e: EstadoDeCuenta): string {
    const r = e.resumen;
    if (r.residuo == null) return 'hay días sin medir: no se puede comprobar que cuadre';
    if (Math.abs(r.residuo) < 0.01) return 'la cuenta cuadra al centavo';
    return `no cuadra por ${this.s(r.residuo)}`;
  }

  m(v: number | null): string { return v == null ? 'no medido' : money(v); }
  s(v: number | null): string { return v == null ? 'no medido' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${money(Math.abs(v))}`; }
}

function construirMeses(hasta: string): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  let [y, m] = PRIMER_MES.split('-').map(Number);
  const [yf, mf] = hasta.split('-').map(Number);
  while (y < yf || (y === yf && m <= mf)) {
    const value = `${y}-${String(m).padStart(2, '0')}`;
    out.unshift({ label: `${NOMBRE_MES[m - 1]} ${y}`, value });
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
