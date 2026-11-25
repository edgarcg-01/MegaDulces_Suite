import { ChangeDetectionStrategy, Component, EventEmitter, Output, computed, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { Balances, CoberturaCategoria, CoberturaPorArea, Diagnostico } from '../../bank.service';
import { motivoPorLigar } from './bancos-shared';
import { exportXlsx } from '../../../../shared/export/xlsx-export';
import { MetricStripComponent, MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../../shared/components/load-state/load-state.component';
import { ContextHelpComponent } from '../../../../shared/context-help/context-help.component';
import { BANCOS_STYLES } from './bancos.styles';

/** Una sucursal de la venta de tienda (la sucursal del corte, con su nombre). */
type Sucursal = { sucursal: string; nombre?: string; n: number; monto: number };
/** Un renglón de las tablas: el encabezado de un grupo, un origen o área, o una sucursal de la venta de tienda. */
export type RenglonDeDireccion =
  | { tipo: 'grupo'; clave: string; nombre: string; n: number; monto: number }
  | { tipo: 'fila'; clave: string; g: CoberturaPorArea; sub: string; tenue: boolean; desplegable: boolean }
  | { tipo: 'suc'; clave: string; g: CoberturaPorArea; s: Sucursal };

/** El orden de lectura de lo que entró con documento: lo que es ingreso primero, el traspaso al final (no es ingreso). */
const ORDEN_CON_DOC = ['venta_tienda', 'cobranza', 'devolucion', 'otro_documento', 'traspaso'];
/** Las salidas que todavía no son de nadie (estados, no áreas), en este orden. */
const DE_NADIE = ['en_plazo', 'por_asignar', 'quien_captura', 'sin_motivo'];

/** La línea bajo cada origen: de qué documento sale, o qué dice el banco cuando no hay documento. */
const QUE_ES: Readonly<Record<string, string>> = {
  cobranza: 'cobro de una factura a un cliente',
  traspaso: 'viene de otra cuenta tuya: no es ingreso',
  devolucion: 'el banco regresó una transferencia',
  otro_documento: 'casado con otro documento de Kepler',
  'sin_documento:prestamo': '«depósito de préstamo»: no es venta',
  'sin_documento:efectivo': 'venta o cobranza sin su cobro en Kepler',
  'sin_documento:terminal': '«terminales punto de venta»: falta su corte',
  'sin_documento:transferencia': 'SPEI o transferencia sin documento',
  'sin_documento:devolucion': 'transferencia regresada, sin documento',
  'sin_documento:otro': 'el banco no dice qué es',
  en_plazo: 'Kepler todavía puede capturarlo',
  por_asignar: 'Kepler no lo tiene · lo asigna Tesorería',
  quien_captura: 'va a quien captura los depósitos de la cuenta',
  sin_motivo: 'el motor no lo decidió',
};

/**
 * [BFU.4.5.13] Bancos › Ingresos y egresos: de dónde viene y a dónde va cada peso de la descarga del banco.
 *
 * Nace de partir Cuentas en dos (Edgar, 2026-11-25: «para no hacer tanto scroll, separar ingresos y egresos de las
 * cuentas de banco»): Cuentas contestaba dos preguntas —quién explica cada peso y si cuadran los saldos— y la
 * auditoría del 25-nov (lienzo «Bancos › Cuentas: auditoría y propuesta») lo marcó como conflación. Aquí se contesta
 * UNA: «¿qué dinero del banco de este mes falta explicar?»; entradas y salidas son su desglose, lado a lado.
 *
 * Primario = lo que falta explicar (la cifra de --fs-display, la única) y su botón, el único de acción · secundario =
 * entró, salió, entre tus cuentas y saldos (tira sin animación: la cifra nace con su valor) y las dos tablas ·
 * terciario = qué dice el banco, quién lo atiende y cuántos van tarde. Cada renglón abre sus movimientos con la MISMA
 * regla del servidor que su cifra (grupoDeLaFila, BFU.4.5.12).
 */
@Component({
  selector: 'bancos-ingresos',
  standalone: true,
  imports: [CommonModule, RouterLink, ButtonModule, TableModule, MetricStripComponent, LoadStateComponent, ContextHelpComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card-premium card-flat fb-ie" aria-labelledby="fb-ie-t">
      <div class="fb-ie-head">
        <h3 id="fb-ie-t" class="fb-ie-t">Ingresos y egresos <span class="fb-ie-t-sub">· de dónde viene y a dónde va cada peso de la descarga del banco</span>
          <app-context-help topic="bancos_ingresos_egresos" /></h3>
        <button type="button" class="fb-btn" (click)="verTodos.emit()">Ver todos los movimientos</button>
        @if (sinClasificar(); as n) { <button type="button" class="fb-btn fb-btn-txt" (click)="verSinClasificar.emit()">{{ n | number }} sin clasificar</button> }
        <button type="button" class="fb-btn" [disabled]="exporting() || !cobertura()" (click)="exportXls()">Excel</button>
      </div>

      <app-load-state [loading]="cargando()" [error]="error()" [isEmpty]="!cargando() && !error() && !hayDirecciones()"
                      emptyTitle="Sin movimientos del banco para separar" [emptyHint]="vacio()" (retry)="reintentar.emit()">
        @if (cobertura(); as cob) {
          <div class="fb-ie-band">
            <div class="fb-ie-falta">
              <span class="fb-cap">Falta explicar</span>
              @if (cob.explicado; as e) {
                <span class="fb-ie-cifra">{{ millones(e.por_ligar.monto) }}</span>
                <span class="fb-ie-falta-sub"><span class="mono">{{ e.por_ligar.n | number }}</span> movimientos ·
                  <span class="fb-tarde mono">{{ e.atrasados | number }}</span> con más de 5 días hábiles</span>
                @if (e.por_ligar.n > 0) {
                  <div><button pButton type="button" class="p-button-sm" (click)="abrirPorLigar()"><span class="p-button-label">Ver lo que falta explicar</span></button></div>
                }
              } @else {
                <span class="fb-ie-nm" role="status">No se pudo medir en este periodo: faltan los hechos de algún renglón.</span>
              }
            </div>
            <app-metric-strip class="fb-ie-tira" [items]="cifras()" density="compact" [instant]="true"
                              ariaLabel="Lo que entró, lo que salió y los saldos" (drill)="onDrill($event)" />
          </div>

          <div class="fb-ie-dos">
            @if (cob.entradas; as ent) {
              <section class="fb-ie-panel" aria-labelledby="fb-ie-ent">
                <div class="fb-ie-ph">
                  <i class="pi pi-arrow-down-left" aria-hidden="true"></i>
                  <h4 id="fb-ie-ent">Ingresos <span class="fb-ie-t-sub">· de dónde vino</span></h4>
                  <span class="mono fb-ie-ph-tot">{{ ent.monto | currency:'MXN':'symbol-narrow':'1.0-0' }} <span class="muted">· {{ ent.n | number }}</span></span>
                </div>
                <div class="fb-ie-caja" role="region" aria-labelledby="fb-ie-ent" tabindex="0">
                  <ng-container *ngTemplateOutlet="tabla; context: { $implicit: ingresos(), dir: ent, col: 'De dónde vino', tot: 'Total ingresos' }"></ng-container>
                </div>
              </section>
            }
            @if (cob.salidas; as sal) {
              <section class="fb-ie-panel" aria-labelledby="fb-ie-sal">
                <div class="fb-ie-ph">
                  <i class="pi pi-arrow-up-right" aria-hidden="true"></i>
                  <h4 id="fb-ie-sal">Egresos <span class="fb-ie-t-sub">· quién lo explica</span></h4>
                  <span class="mono fb-ie-ph-tot">{{ sal.monto | currency:'MXN':'symbol-narrow':'1.0-0' }} <span class="muted">· {{ sal.n | number }}</span></span>
                </div>
                <div class="fb-ie-caja" role="region" aria-labelledby="fb-ie-sal" tabindex="0">
                  <ng-container *ngTemplateOutlet="tabla; context: { $implicit: egresos(), dir: sal, col: 'Quién lo explica', tot: 'Total egresos' }"></ng-container>
                </div>
              </section>
            }
          </div>
        }
      </app-load-state>
    </section>

    <ng-template #tabla let-filas let-dir="dir" let-col="col" let-tot="tot">
      <p-table [value]="filas" dataKey="clave" size="small" class="surf-table surf-table--plain fb-ie-tbl">
        <ng-template #header>
          <tr>
            <th scope="col">{{ col }}</th>
            <th scope="col" class="ta-r comm-num">Pesos</th>
            <th scope="col" class="ta-r comm-num fb-opt">Movs.</th>
            <th scope="col" class="ta-r comm-num">Falta explicar</th>
          </tr>
        </ng-template>
        <ng-template #body let-r>
          @switch (r.tipo) {
            @case ('grupo') {
              <tr class="fb-ie-grupo">
                <th scope="rowgroup" colspan="2">{{ r.nombre }}</th>
                <td colspan="2" class="ta-r mono">{{ r.monto | currency:'MXN':'symbol-narrow':'1.0-0' }} · {{ r.n | number }}</td>
              </tr>
            }
            @case ('fila') {
              <tr class="fb-row-click" tabindex="0" (click)="abrir(r.g, false)" (keydown.enter)="abrir(r.g, false)"
                  (keydown.space)="$event.preventDefault(); abrir(r.g, false)">
                <th scope="row" class="fb-ie-n" [class.muted]="r.tenue">
                  @if (r.desplegable) {
                    <button type="button" class="fb-tog" (click)="$event.stopPropagation(); toggleVenta()" (keydown.enter)="$event.stopPropagation()"
                            (keydown.space)="$event.stopPropagation()" [attr.aria-expanded]="ventaAbierta()"
                            [attr.aria-label]="(ventaAbierta() ? 'Plegar' : 'Ver') + ' la venta de tienda por sucursal'">
                      <i class="pi" [class.pi-chevron-down]="ventaAbierta()" [class.pi-chevron-right]="!ventaAbierta()" aria-hidden="true"></i></button>
                  }
                  {{ r.g.nombre || r.g.area }}<span class="sr-only">, abre sus movimientos</span>
                  @if (r.sub) { <span class="fb-ie-sub" [class.fb-ie-sub-in]="r.desplegable">{{ r.sub }}</span> }
                </th>
                <td class="ta-r mono comm-num" [class.muted]="r.tenue">{{ r.g.monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                <td class="ta-r mono comm-num fb-opt" [class.muted]="r.tenue">{{ r.g.n | number }}</td>
                <td class="ta-r comm-num">
                  @if (r.g.por_ligar === null) { <span class="muted">no medido</span> }
                  @else if (r.g.por_ligar.n > 0) {
                    <button type="button" class="fb-ligar" (click)="$event.stopPropagation(); abrir(r.g, true)"
                            [attr.aria-label]="'Ver los ' + r.g.por_ligar.n + ' movimientos por explicar de ' + (r.g.nombre || r.g.area)">
                      <b class="mono">{{ r.g.por_ligar.n | number }}</b>
                      @if (r.g.atrasados) { <span class="fb-tarde mono"> · {{ r.g.atrasados | number }} tarde</span> }</button>
                    @if (r.g.motivos[0]; as m) { <span class="fb-ie-sub">{{ motivo(m.motivo) }}</span> }
                  } @else { <span class="muted">—</span> }
                </td>
              </tr>
            }
            @case ('suc') {
              <tr class="fb-row-click fb-ie-suc" tabindex="0" (click)="abrirSucursal(r.g, r.s)" (keydown.enter)="abrirSucursal(r.g, r.s)"
                  (keydown.space)="$event.preventDefault(); abrirSucursal(r.g, r.s)">
                <th scope="row">{{ r.s.nombre || r.s.sucursal }}<span class="sr-only">, abre sus depósitos</span>
                  <a class="fb-cortes" [routerLink]="['/finanzas/cortes-sucursales']" [queryParams]="{ month: period(), sucursal: r.s.sucursal }"
                     (click)="$event.stopPropagation()" (keydown.enter)="$event.stopPropagation()">cortes de caja</a></th>
                <td class="ta-r mono comm-num">{{ r.s.monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                <td class="ta-r mono comm-num fb-opt">{{ r.s.n | number }}</td>
                <td></td>
              </tr>
            }
          }
        </ng-template>
        <ng-template #footer>
          <tr class="fb-ie-tot">
            <th scope="row">{{ tot }}</th>
            <td class="ta-r mono comm-num">{{ dir.monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
            <td class="ta-r mono comm-num fb-opt">{{ dir.n | number }}</td>
            <td class="ta-r mono comm-num">@if (dir.por_ligar; as l) { {{ l.n | number }} } @else { <span class="muted">no medido</span> }</td>
          </tr>
        </ng-template>
      </p-table>
    </ng-template>
  `,
  styles: [BANCOS_STYLES, `
    .fb-ie { padding: var(--sp-4) var(--sp-5) var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-4); margin-bottom: var(--sp-3); }
    .fb-ie-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); }
    .fb-ie-t { flex: 1 1 18rem; margin: 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); color: var(--text-main); }
    .fb-ie-t-sub { font-weight: var(--fw-regular, 400); color: var(--text-muted); font-size: var(--fs-sm); }
    .fb-btn { display: inline-flex; align-items: center; min-height: 32px; padding: 0 var(--sp-3); border: 1px solid var(--border-color);
      border-radius: var(--r-sm); background: var(--card-bg); color: var(--text-main); font: inherit; font-size: var(--fs-sm); font-weight: var(--fw-medium); cursor: pointer; }
    .fb-btn:hover:not(:disabled) { background: var(--hover-bg); }
    .fb-btn:disabled { opacity: .6; cursor: default; }
    .fb-btn-txt { border-color: transparent; background: none; color: var(--text-muted); }
    .fb-btn:focus-visible, .fb-tog:focus-visible, .fb-ligar:focus-visible, .fb-cortes:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }

    .fb-ie-band { display: flex; flex-wrap: wrap; gap: var(--sp-4) var(--sp-8); align-items: stretch; }
    .fb-ie-falta { flex: 1 1 16rem; display: flex; flex-direction: column; gap: var(--sp-1); }
    .fb-cap { font-size: var(--fs-micro); font-weight: var(--fw-medium); letter-spacing: .05em; text-transform: uppercase; color: var(--text-muted); }
    .fb-ie-cifra { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-display); font-weight: var(--fw-black); line-height: 1; color: var(--text-main); }
    .fb-ie-falta-sub { font-size: var(--fs-sm); color: var(--text-main); }
    .fb-ie-falta .p-button { margin-top: var(--sp-2); }
    .fb-ie-nm { font-size: var(--fs-sm); color: var(--text-muted); }
    .fb-ie-tira { flex: 2 1 32rem; min-width: 0; border-left: 1px solid var(--border-color); padding-left: var(--sp-6); align-self: center; }
    .fb-tarde { color: var(--warn-soft-fg); font-weight: var(--fw-bold); }

    .fb-ie-dos { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 34rem), 1fr)); gap: var(--sp-4); align-items: start; }
    .fb-ie-panel { min-width: 0; border: 1px solid var(--border-color); border-radius: var(--r-md); container-type: inline-size; }
    .fb-ie-ph { display: flex; align-items: baseline; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4) var(--sp-2); }
    .fb-ie-ph .pi { font-size: var(--fs-xs); color: var(--text-muted); align-self: center; }
    .fb-ie-ph h4 { margin: 0; font-size: var(--fs-body); font-weight: var(--fw-bold); color: var(--text-main); }
    .fb-ie-ph-tot { margin-left: auto; font-size: var(--fs-sm); font-weight: var(--fw-bold); }
    .fb-ie-caja { overflow-x: auto; }
    .fb-ie-caja:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .fb-ie-grupo > th, .fb-ie-grupo > td { background: var(--surface-ground); font-size: var(--fs-xs); font-weight: var(--fw-bold); color: var(--text-main); }
    .fb-ie-grupo > td { font-weight: var(--fw-medium); color: var(--text-muted); }
    .fb-ie-n { text-align: left; font-weight: var(--fw-medium); color: var(--text-main); }
    .fb-ie-sub { display: block; font-size: var(--fs-xs); font-weight: var(--fw-regular, 400); color: var(--text-muted); }
    .fb-ie-sub-in { padding-left: 1.75rem; }
    .fb-ie-suc > th, .fb-ie-suc > td { background: var(--surface-ground); }
    tr.fb-ie-suc > th { text-align: left; font-weight: var(--fw-regular, 400); padding-left: 2.75rem; }
    .fb-ie-tot > th, .fb-ie-tot > td { font-weight: var(--fw-bold); }
    .muted { color: var(--text-muted); }
    tr.fb-row-click:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .fb-tog { display: inline-flex; align-items: center; justify-content: center; width: 1.5rem; height: 1.5rem; margin-right: var(--sp-1);
      border: 0; border-radius: var(--r-sm); background: none; color: var(--text-muted); cursor: pointer; padding: 0; vertical-align: middle; }
    .fb-tog:hover { background: var(--hover-bg); color: var(--text-main); }
    .fb-ligar { display: inline-flex; align-items: baseline; font: inherit; background: none; border: 0; cursor: pointer;
      padding: 2px var(--sp-1); border-radius: var(--r-sm); color: var(--text-main); white-space: nowrap; }
    .fb-ligar:hover { background: var(--hover-bg); }
    .fb-cortes { margin-left: var(--sp-2); font-size: var(--fs-xs); color: var(--text-main); text-decoration: underline; text-underline-offset: 2px; white-space: nowrap; }
    @container (width < 30rem) { .fb-opt { display: none; } }
  `],
})
export class BancosIngresosComponent {
  readonly diagnostico = input.required<Diagnostico | null>();
  readonly balances = input<Balances | null>(null);
  readonly period = input<string>('');
  readonly cargando = input(false);
  readonly error = input<string | null>(null);

  /** El shell abre Movimientos con ese grupo (la misma forma que usaba Cuentas). */
  @Output() openGrupo = new EventEmitter<{ direccion?: '' | 'entra' | 'sale'; area?: string; origen?: string; sucursal?: string; porLigar?: boolean }>();
  @Output() verTodos = new EventEmitter<void>();
  @Output() verSinClasificar = new EventEmitter<void>();
  /** La cifra de saldos lleva a la vista Cuentas. */
  @Output() irACuentas = new EventEmitter<void>();
  @Output() reintentar = new EventEmitter<void>();

  readonly cobertura = computed<CoberturaCategoria | null>(() => this.diagnostico()?.cobertura_categoria ?? null);
  readonly hayDirecciones = computed(() => !!(this.cobertura()?.entradas && this.cobertura()?.salidas));
  readonly sinClasificar = computed(() => this.diagnostico()?.sin_clasificar_n ?? 0);
  readonly vacio = computed(() => (this.cobertura()
    ? 'La API no separó lo que entró de lo que salió: algún renglón no trae la dirección del dinero.'
    : 'Todavía no hay descarga del banco para este periodo.'));

  /** La venta de tienda nace plegada (dice cuántas sucursales tiene): así cada tabla cabe sin desplazarse. */
  readonly ventaAbierta = signal(false);
  toggleVenta(): void { this.ventaAbierta.update((v) => !v); }

  readonly ingresos = computed<RenglonDeDireccion[]>(() => renglonesDeIngresos(this.cobertura(), this.ventaAbierta()));
  readonly egresos = computed<RenglonDeDireccion[]>(() => renglonesDeEgresos(this.cobertura(), (c) => this.nombreDe(c)));

  readonly cifras = computed<MetricStripItem[]>(() => {
    const cob = this.cobertura(), ent = cob?.entradas, sal = cob?.salidas, ec = cob?.entre_cuentas;
    if (!ent || !sal) return [];
    const items: MetricStripItem[] = [
      { label: 'Entró', value: millones(ent.monto), format: 'text', drill: 'entra', drillLabel: 'Ver todo lo que entró',
        sub: `${num(ent.n)} depósitos${ec ? ` · de fuera ${millones(ent.monto - ec.entra.monto)}` : ''}` },
      { label: 'Salió', value: millones(sal.monto), format: 'text', drill: 'sale', drillLabel: 'Ver todo lo que salió',
        sub: `${num(sal.n)} retiros${ec ? ` · a fuera ${millones(sal.monto - ec.sale.monto)}` : ''}` },
    ];
    if (ec) items.push({ label: 'Entre tus cuentas', value: millones(ec.entra.monto), format: 'text',
      sub: `entró ${num(ec.entra.n)} · salió ${millones(ec.sale.monto)} · no es ingreso ni egreso` });
    const b = this.balances();
    if (b) {
      const con = b.accounts.filter((a) => !a.sin_saldo);
      const cierran = con.filter((a) => a.cuadra).length, no = con.length - cierran;
      items.push({ label: 'Saldos', value: `${cierran} de ${con.length} cierran`, format: 'text', tone: no ? 'bad' : 'default',
        sub: no ? `${no} no ${no === 1 ? 'cierra' : 'cierran'} · ver en Cuentas` : 'ver en Cuentas', drill: 'saldos', drillLabel: 'Ver los saldos en Cuentas' });
    } else {
      items.push({ label: 'Saldos', value: '—', format: 'text', sub: 'sin leer todavía', drill: 'saldos', drillLabel: 'Ver los saldos en Cuentas' });
    }
    return items;
  });

  motivo = motivoPorLigar;
  millones = millones;
  /** El nombre de un departamento por su código (el de la tabla de áreas), para «lo atiende …». */
  nombreDe(code: string): string {
    return this.cobertura()?.por_area.find((x) => x.area === code)?.nombre ?? (code === 'tesoreria' ? 'Tesorería' : code);
  }

  abrir(g: CoberturaPorArea, porLigar: boolean): void {
    const ent = this.cobertura()?.entradas?.grupos.includes(g);
    this.openGrupo.emit(ent ? { direccion: 'entra', origen: g.area, porLigar } : { direccion: 'sale', area: g.area, porLigar });
  }
  abrirSucursal(g: CoberturaPorArea, s: { sucursal: string }): void {
    this.openGrupo.emit({ direccion: 'entra', origen: g.area, sucursal: s.sucursal });
  }
  abrirPorLigar(): void { this.openGrupo.emit({ porLigar: true }); }
  onDrill(k: string): void {
    if (k === 'entra' || k === 'sale') this.openGrupo.emit({ direccion: k });
    else if (k === 'saldos') this.irACuentas.emit();
  }

  readonly exporting = signal(false);
  async exportXls(): Promise<void> {
    const cob = this.cobertura();
    if (!cob) return;
    this.exporting.set(true);
    try {
      type Hoja = Record<string, unknown>;
      const plano = (rs: RenglonDeDireccion[]): Hoja[] => rs.flatMap((r): Hoja[] => (r.tipo === 'fila' ? [{ ...r.g, nombre: r.g.nombre || r.g.area, que: r.sub }]
        : r.tipo === 'suc' ? [{ ...r.s, nombre: `   ${r.g.nombre || r.g.area} · ${r.s.nombre || r.s.sucursal}`, que: 'sucursal del corte', _suc: true }] : []));
      const cols = (primera: string) => [
        { header: primera, get: (r: any) => r.nombre, width: 34 },
        { header: 'Que es', get: (r: any) => r.que ?? '', width: 38 },
        { header: 'Movimientos', get: (r: any) => (r._suc ? null : r.n), type: 'int' as const, total: true },
        { header: 'Pesos', get: (r: any) => (r._suc ? null : r.monto), type: 'money' as const, total: true },
        { header: 'Movimientos de la sucursal', get: (r: any) => (r._suc ? r.n : null), type: 'int' as const },
        { header: 'Pesos de la sucursal', get: (r: any) => (r._suc ? r.monto : null), type: 'money' as const },
        { header: 'Pesos explicados', get: (r: any) => (r._suc ? null : r.explicado?.monto ?? null), type: 'money' as const, total: true },
        { header: 'Falta explicar', get: (r: any) => (r._suc ? null : r.por_ligar?.n ?? null), type: 'int' as const, total: true },
        { header: 'Falta explicar (pesos)', get: (r: any) => (r._suc ? null : r.por_ligar?.monto ?? null), type: 'money' as const, total: true },
        { header: 'Mas de 5 dias habiles', get: (r: any) => (r._suc ? null : r.atrasados), type: 'int' as const, total: true },
      ];
      await exportXlsx('Ingresos y egresos ' + this.period(), [
        { name: 'Ingresos', subtitle: this.period(), rows: plano(renglonesDeIngresos(cob, true)), cols: cols('De donde vino') },
        { name: 'Egresos', subtitle: this.period(), rows: plano(this.egresos()), cols: cols('Quien lo explica') },
      ]);
    } finally { this.exporting.set(false); }
  }
}

/**
 * [BFU.4.5.13] Los renglones de Ingresos: «con documento de Kepler» (lo que es ingreso primero; el traspaso al final,
 * tenue) y «sin documento: lo que dice el banco» (lo de más pesos primero). La venta de tienda se despliega por sucursal.
 * Exportada para probarla sin montar la pantalla.
 */
export function renglonesDeIngresos(cob: CoberturaCategoria | null, ventaAbierta: boolean): RenglonDeDireccion[] {
  const e = cob?.entradas;
  if (!e) return [];
  const orden = (k: string) => { const i = ORDEN_CON_DOC.indexOf(k); return i < 0 ? ORDEN_CON_DOC.length : i; };
  const con = e.grupos.filter((g) => !g.area.startsWith('sin_documento:')).sort((a, b) => orden(a.area) - orden(b.area) || b.monto - a.monto);
  const sin = e.grupos.filter((g) => g.area.startsWith('sin_documento:')).sort((a, b) => b.monto - a.monto);
  const out: RenglonDeDireccion[] = [];
  const grupo = (clave: string, nombre: string, gs: CoberturaPorArea[]) => {
    if (gs.length) out.push({ tipo: 'grupo', clave, nombre, n: gs.reduce((t, g) => t + g.n, 0), monto: gs.reduce((t, g) => t + Number(g.monto || 0), 0) });
  };
  grupo('g:con', 'Con documento de Kepler', con);
  for (const g of con) {
    const sucs = g.sucursales ?? [];
    const sub = g.area === 'venta_tienda' ? `cobro de un corte de caja · ${sucs.length} ${sucs.length === 1 ? 'sucursal' : 'sucursales'}` : QUE_ES[g.area] ?? '';
    out.push({ tipo: 'fila', clave: g.area, g, sub, tenue: g.area === 'traspaso', desplegable: sucs.length > 0 });
    if (sucs.length && ventaAbierta) for (const s of sucs) out.push({ tipo: 'suc', clave: `${g.area}|${s.sucursal}`, g, s });
  }
  grupo('g:sin', 'Sin documento · lo que dice el banco', sin);
  for (const g of sin) out.push({ tipo: 'fila', clave: g.area, g, sub: QUE_ES[g.area] ?? '', tenue: false, desplegable: false });
  return out;
}

/** [BFU.4.5.13] Los renglones de Egresos: «de un área» (lo de más pesos primero) y «todavía de nadie» (estados, no áreas). */
export function renglonesDeEgresos(cob: CoberturaCategoria | null, nombreDe: (code: string) => string): RenglonDeDireccion[] {
  const s = cob?.salidas;
  if (!s) return [];
  const area = s.grupos.filter((g) => !DE_NADIE.includes(g.area)).sort((a, b) => b.monto - a.monto || b.n - a.n);
  const nadie = s.grupos.filter((g) => DE_NADIE.includes(g.area)).sort((a, b) => DE_NADIE.indexOf(a.area) - DE_NADIE.indexOf(b.area));
  const out: RenglonDeDireccion[] = [];
  const grupo = (clave: string, nombre: string, gs: CoberturaPorArea[]) => {
    if (gs.length) out.push({ tipo: 'grupo', clave, nombre, n: gs.reduce((t, g) => t + g.n, 0), monto: gs.reduce((t, g) => t + Number(g.monto || 0), 0) });
  };
  const sub = (g: CoberturaPorArea) => QUE_ES[g.area] ?? (g.atiende && g.atiende !== g.area ? `lo atiende ${nombreDe(g.atiende)}` : '');
  grupo('g:area', 'De un área', area);
  for (const g of area) out.push({ tipo: 'fila', clave: g.area, g, sub: sub(g), tenue: false, desplegable: false });
  grupo('g:nadie', 'Todavía de nadie', nadie);
  for (const g of nadie) out.push({ tipo: 'fila', clave: g.area, g, sub: sub(g), tenue: false, desplegable: false });
  return out;
}

const num = (v: number) => new Intl.NumberFormat('es-MX').format(Number(v || 0));

/** Pesos en millones para una cifra («$35.4 M»); debajo del millón, completo. */
function millones(v: number): string {
  const n = Number(v || 0);
  return Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)} M`
    : new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(n);
}
