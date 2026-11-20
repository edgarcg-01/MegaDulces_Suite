import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpParams } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { diaMxDeInstante, type ArqueosResponse } from '@megadulces/contracts';
import { environment } from '../../../../../environments/environment';
import { LoadStateComponent } from '../../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, type MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../../shared/context-help/context-help.component';
import { SucursalPipe } from '../../../../shared/pipes/sucursal.pipe';
import { CajaTabsComponent } from '../../caja-tabs.component';
import { CashLedgerService, type MovimientoCaja } from '../../cash-ledger.service';
import { money, dmy } from '../finanzas-format';
import { armarEstadoDeCuenta, limitesDeMes, restarDias, type EstadoDeCuenta } from './estado-cuenta-caja.util';
import { avisosDelEstado, imprimirEstadoCuenta } from './estado-cuenta-caja-papel';

/**
 * ⭐ `[LE.6.38]` **Estado de cuenta de Caja General** (Edgar, 2026-11-20: *«generemos un estado de
 * cuenta en el cual presentemos la información»*; consolidado, pantalla + PDF, para Tesorería y
 * Dirección).
 *
 * ── Las cinco preguntas (diseno §0b) ──────────────────────────────────────────────────────
 * 1. Qué ve y en qué orden: con cuánto arrancó y con cuánto terminó el mes (primario), de qué se
 *    compone la diferencia (secundario) y luego cada corte, del más viejo al más nuevo, como se lee
 *    un estado de cuenta; cada corte se abre en sus movimientos con saldo corrido.
 * 2. Qué no ve: el conteo pieza por pieza, la firma y la revisión de la supervisora (viven en
 *    Arqueos, a un clic desde el folio del corte); ni el libro nuevo (sin apertura: diría «vacía»).
 * 3. Accesibilidad: mes en un selector, cada corte se abre con teclado (botón), la sucursal por
 *    nombre, el saldo no depende del color (signo y palabra), y todo cabe en una hoja impresa.
 * 4. Ligas: el folio del corte abre ese día en Arqueos; los movimientos son los de Captura.
 * 5. ¿Le toca a esta pantalla?: sí, es la lectura del periodo; Arqueos revisa un día y Cuadre
 *    busca huecos contra Kepler. Ninguna de las dos da saldo inicial y final de un periodo.
 *
 * Jerarquía: primario = saldo final contra inicial; secundario = sus componentes; terciario = el
 * folio, la hora y el beneficiario.
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
  selector: 'app-finanzas-caja-estado-cuenta',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, ButtonModule, SelectModule, TableModule, LoadStateComponent, MetricStripComponent,
    FreshnessPillComponent, ContextHelpComponent, SucursalPipe, CajaTabsComponent],
  template: `
    <app-caja-tabs />
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Estado de cuenta</h1>
          <p class="surf-page-sub">El efectivo de Caja General en el periodo: con cuánto arrancó, qué entró y salió, y con cuánto cerró.</p>
        </div>
        <div class="ec-acciones">
          <app-context-help topic="caja-estado-cuenta" />
          <app-freshness-pill measures="fetch" [since]="leidoEn()" />
          <p-select [options]="meses" optionLabel="label" optionValue="value" [ngModel]="mes()" (onChange)="cambiarMes($event.value)"
                    ariaLabel="Mes" styleClass="ec-sel" />
          <p-button size="small" icon="pi pi-print" label="Imprimir o PDF" [disabled]="!estado()?.dias?.length" (onClick)="imprimir()" />
        </div>
      </header>
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

            <div class="card-premium card-flat tw-tablewrap dt-scope">
              <p-table [value]="e.dias" dataKey="corte_id" [expandedRowKeys]="abiertos()" size="small"
                       selectionMode="single" [metaKeySelection]="false" [rowHover]="true"
                       (onRowSelect)="alternar($event.data)" (onRowUnselect)="alternar($event.data)"
                       class="surf-table surf-table--plain surf-table--sticky">
                <ng-template #header>
                  <tr>
                    <th class="ec-w-tog"><span class="sr-only">Movimientos</span></th>
                    <th>Corte</th>
                    <th class="ta-r comm-num">Saldo inicial</th>
                    <th class="ta-r comm-num">Entradas</th>
                    <th class="ta-r comm-num">Salidas</th>
                    <th class="ta-r comm-num">Caja fuerte</th>
                    <th class="ta-r comm-num">Contado</th>
                    <th class="ta-r comm-num">Diferencia</th>
                  </tr>
                </ng-template>
                <ng-template #body let-d let-abierto="expanded">
                  <tr [pSelectableRow]="d" class="tw-clickable" [attr.aria-expanded]="abierto"
                      [attr.aria-label]="(abierto ? 'Cerrar' : 'Ver') + ' los movimientos del ' + dmy(d.fecha)">
                    <td role="cell"><i class="pi ec-tenue" [class.pi-chevron-down]="abierto" [class.pi-chevron-right]="!abierto" aria-hidden="true"></i></td>
                    <td role="cell">
                      <span class="ec-fecha">{{ dmy(d.fecha) }}</span>
                      <a class="ec-folio" [routerLink]="['/finanzas/caja-general/arqueos']" [queryParams]="{ corte: d.folio }" (click)="$event.stopPropagation()">{{ d.folio }}</a>
                      @if (d.salto) { <span class="ec-nota">fondo distinto al cierre anterior: {{ s(d.salto) }}</span> }
                      @if (d.sin_medir) { <span class="ec-nota">{{ d.sin_medir }}</span> }
                    </td>
                    <td role="cell" class="ta-r comm-num">{{ m(d.saldo_inicial) }}</td>
                    <td role="cell" class="ta-r comm-num">{{ m(d.entradas) }}</td>
                    <td role="cell" class="ta-r comm-num">{{ m(d.salidas) }}</td>
                    <td role="cell" class="ta-r comm-num ec-tenue">{{ d.caja_fuerte ? s(d.caja_fuerte) : '—' }}</td>
                    <td role="cell" class="ta-r comm-num strong">{{ m(d.contado) }}</td>
                    <td role="cell" class="ta-r comm-num" [class.bad]="(d.diferencia ?? 0) <= -1">{{ textoDif(d.diferencia) }}</td>
                  </tr>
                </ng-template>
                <ng-template #expandedrow let-d>
                  <tr>
                    <td colspan="8" class="ec-exp">
                      @if (!d.movimientos_cuadran) {
                        <p class="ec-nota">Los movimientos listados no suman lo que selló el corte: el saldo por movimiento no se publica.</p>
                      }
                      <table class="ec-movs">
                        <thead>
                          <tr><th>Fecha</th><th>Folio</th><th>Concepto</th><th>Sucursal</th>
                            <th class="ta-r">Entrada</th><th class="ta-r">Salida</th><th class="ta-r">Saldo</th></tr>
                        </thead>
                        <tbody>
                          <tr class="ec-sub"><td colspan="6">Fondo del corte</td><td class="ta-r comm-num">{{ m(d.saldo_inicial) }}</td></tr>
                          @for (l of d.movimientos; track l.id) {
                            <tr>
                              <td class="comm-num">{{ dmy(l.fecha) }}</td>
                              <td class="comm-num ec-tenue">{{ l.folio }}</td>
                              <td>{{ l.concepto }}@if (l.beneficiario) { <span class="ec-tenue"> · {{ l.beneficiario }}</span> }</td>
                              <td>{{ l.sucursal | sucursal }}</td>
                              <td class="ta-r comm-num">{{ l.entrada ? m(l.entrada) : '' }}</td>
                              <td class="ta-r comm-num">{{ l.salida ? m(l.salida) : '' }}</td>
                              <td class="ta-r comm-num">{{ l.saldo == null ? '' : m(l.saldo) }}</td>
                            </tr>
                          } @empty {
                            <tr><td colspan="7" class="ec-tenue">Sin movimientos capturados en este corte.</td></tr>
                          }
                          @if (d.caja_fuerte) { <tr class="ec-sub"><td colspan="6">Caja fuerte (dejó en el cajón menos lo que se llevó)</td><td class="ta-r comm-num">{{ s(d.caja_fuerte) }}</td></tr> }
                          @if (d.depositos) { <tr class="ec-sub"><td colspan="6">Depósitos</td><td class="ta-r comm-num">{{ s(-d.depositos) }}</td></tr> }
                          @if (d.otros) { <tr class="ec-sub"><td colspan="6">Otros ajustes del corte (custodia, documentos)</td><td class="ta-r comm-num">{{ s(d.otros) }}</td></tr> }
                          <tr class="ec-sub"><td colspan="6">Debía haber</td><td class="ta-r comm-num">{{ m(d.esperado) }}</td></tr>
                          <tr class="ec-sub strong"><td colspan="6">Se contó · {{ textoDif(d.diferencia) }}</td><td class="ta-r comm-num">{{ m(d.contado) }}</td></tr>
                        </tbody>
                      </table>
                    </td>
                  </tr>
                </ng-template>
              </p-table>
            </div>
          }
        }
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ec-acciones { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .ec-veredicto { font-size: var(--fs-lg); font-weight: 600; color: var(--text-main); margin: 0 0 var(--sp-3); }
    .ec-veredicto .num { font-variant-numeric: tabular-nums; }
    .ec-cuadra { font-size: var(--fs-sm); font-weight: 400; color: var(--text-muted); }
    .ec-avisos { list-style: none; margin: var(--sp-3) 0; padding: 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .ec-avisos li { margin-bottom: var(--sp-1); }
    .ec-avisos.warn, .bad { color: var(--bad-fg); }
    .ec-w-tog { width: 2.75rem; }
    .ec-fecha { font-weight: 600; margin-right: var(--sp-2); font-variant-numeric: tabular-nums; }
    .ec-folio { font-size: var(--fs-xs); color: var(--text-muted); }
    .ec-folio:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .ec-nota { display: block; font-size: var(--fs-xs); color: var(--warn-fg); margin-top: var(--sp-1); }
    .ec-tenue { color: var(--text-muted); }
    .strong { font-weight: 600; }
    .ec-exp { padding: var(--sp-2) var(--sp-4) var(--sp-4); background: var(--surface-ground); }
    .ec-movs { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .ec-movs th { font-size: var(--fs-xs); font-weight: 600; color: var(--text-muted); text-align: left; padding: var(--sp-1) var(--sp-2); border-bottom: 1px solid var(--border-color); }
    .ec-movs td { padding: var(--sp-1) var(--sp-2); border-bottom: 1px solid var(--border-color); vertical-align: top; }
    .ec-movs .ta-r, .ta-r { text-align: right; }
    .ec-sub td { color: var(--text-muted); }
    .ec-sub.strong td { color: var(--text-main); font-weight: 600; }
    .comm-num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  `],
})
export class FinanzasCajaEstadoCuentaComponent {
  private readonly http = inject(HttpClient);
  private readonly libro = inject(CashLedgerService);
  private readonly base = `${environment.apiUrl}/finance/cash-ledger`;

  readonly dmy = dmy;
  readonly meses = construirMeses(mesMx());
  readonly mes = signal(mesMx());
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly estado = signal<EstadoDeCuenta | null>(null);
  readonly truncado = signal(false);
  readonly leidoEn = signal<Date | null>(null);
  readonly avisoImpresion = signal<string | null>(null);
  readonly avisos = computed(() => { const e = this.estado(); return e ? avisosDelEstado(e) : []; });
  readonly abiertos = signal<Record<string, boolean>>({});
  private pedido = 0;

  constructor() { void this.cargar(); }

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
      this.abiertos.set({});
      this.estado.set(armarEstadoDeCuenta(arq?.rows ?? [], movs.rows, periodo));
      this.leidoEn.set(new Date());
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

  /** La fila entera abre y cierra sus movimientos: con clic, Enter o espacio, y con flechas entre filas. */
  alternar(d: { corte_id: string } | { corte_id: string }[] | undefined): void {
    // PrimeNG tipa el evento como fila, arreglo o nada; con selección simple llega una fila.
    const fila = Array.isArray(d) ? d[0] : d;
    if (!fila) return;
    this.abiertos.update((a) => ({ ...a, [fila.corte_id]: !a[fila.corte_id] }));
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

  textoDif(v: number | null): string {
    if (v == null) return 'no medido';
    if (Math.abs(v) < 0.01) return 'cuadra';
    return `${v < 0 ? 'falta' : 'sobra'} ${money(Math.abs(v))}`;
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

