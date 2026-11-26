import { ChangeDetectionStrategy, Component, computed, input, model, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import type { PaymentCalendarSuficiencia, SuficienciaDeCuenta } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { money } from '../../../shared/util/money.util';
import { fechaCorta } from '../pages/calendario-pagos-grupos';
import { cargosDelDesglose, cuentasCortas, lineaDeLaSemana, nombreCuenta, type CargoConCuenta } from '../pages/calendario-pagos-suficiencia';

/**
 * `[PGP.218]` **El desglose de «¿qué cuenta se queda corta?»** (anexo CR §3.0, DCR9): se abre desde la línea de la
 * barra de la semana del Calendario. Las preguntas de `diseno` §0a/§0b están contestadas en el anexo CR §3.0.
 *
 * Tres niveles: primario = la respuesta (qué cuenta, cuánto falta); secundario = cada cuenta con su saldo, lo
 * preparado y sus cargos; terciario = cada cargo del banco con su día. Sólo lee: fondear una cuenta es un traspaso en
 * el banco, y confirmar un contrato vive en `[PGP.214]`.
 */
@Component({
  selector: 'app-suficiencia-cuentas-peek',
  standalone: true,
  imports: [RouterLink, TableModule, TagModule, LoadStateComponent, SidePeekComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: block; }
    .sc-res { margin: 0 0 var(--sp-2); font-size: var(--fs-lg); font-weight: var(--fw-bold); color: var(--text-main); }
    .sc-res.is-bad { color: var(--bad-fg); }
    .sc-how, .sc-d { margin: 0 0 var(--sp-4); font-size: var(--fs-sm); color: var(--text-muted); }
    .sc-h { margin: var(--sp-6) 0 var(--sp-2); font-size: var(--fs-body); font-weight: var(--fw-bold); color: var(--text-main); }
    .sc-sub { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
    .sc-bad { color: var(--bad-fg); font-weight: var(--fw-bold); }
    /* --warn-soft-fg y no --warn-fg: el ámbar puro sobre blanco da 2.15:1 como texto (medido en la prueba visual
       del 2026-11-26, «de hace N días» a 12 px); el suave pasa AA en claro y en oscuro. */
    .sc-nm { color: var(--warn-soft-fg); }
    /* El valor y su renglón chico son UNA pieza: apilada (teléfono) queda a la derecha de su rótulo. */
    .sc-v { display: inline-block; text-align: right; }
    /* Las cifras a la derecha, encabezado incluido. .comm-num sola no alcanza dentro de p-table: la regla de celda de
       PrimeNG pesa más y las dejaba a la izquierda (medido en la prueba visual del 2026-11-26, escritorio y Fold). */
    .sc-tabla th.comm-num, .sc-tabla td.comm-num { text-align: right; }
    .sc-tags { display: inline-flex; gap: var(--sp-1); flex-wrap: wrap; }
    .sc-pie { margin: var(--sp-4) 0 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .sc-det { margin: var(--sp-1) 0 0; padding-left: var(--sp-4); font-size: var(--fs-sm); color: var(--text-muted); }
    .sc-mas { display: inline-flex; align-items: center; gap: var(--sp-1); margin: var(--sp-2) 0 0; padding: 0; border: 0; background: transparent;
              font: inherit; font-size: var(--fs-sm); color: var(--text-main); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
    .sc-mas:focus-visible, .sc-link:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .sc-link { display: inline-flex; align-items: center; gap: var(--sp-1); }
    /* Con el dedo manda Fitts (DESIGN §716): 44 px. Medido en la prueba visual: el enlace, 17 px. */
    @media (pointer: coarse) { .sc-mas, .sc-link { min-height: 44px; } }
  `],
  template: `
    <app-side-peek [open]="open()" (openChange)="open.set($event)" [width]="760" title="Cuentas de origen: lo que sale en 7 días"
                   [subtitle]="subtitulo()">
      <!-- §2: cargando, error (con Reintentar) y dato son tres estados distintos; el panel siempre tiene algo que decir, así
           que no hay «vacío» (sin cuentas cortas dice que todas cubren). -->
      <app-load-state [loading]="!suficiencia() && !error()" [skeletonRows]="5"
                      errorTitle="No se pudo revisar si las cuentas cubren los cargos del banco"
                      [error]="error() ? 'Preparar y autorizar siguen funcionando: el aviso no bloquea. Si al reintentar sigue fallando, avisa a Sistemas.' : null"
                      (retry)="reintentar.emit()">
      @if (suficiencia(); as s) {
        <p class="sc-res" [class.is-bad]="cortas().length > 0" role="status">{{ respuesta() }}</p>
        <p class="sc-how">El saldo al cierre de la última descarga del banco (o del libro), menos lo ya preparado desde la cuenta y menos
          los cargos que el banco cobra solo, según lo que ha cobrado cada mes. Los depósitos por venir no se suman: si falta, hay que
          fondear la cuenta antes del día del cargo. Ninguna cuenta tiene saldo mínimo registrado.</p>

        <!-- [PGP.218] .dt-stack ([UIM.1]): en el teléfono cada cuenta se apila con TODOS sus campos. Sin ella, la regla
             global de tablas bajo 48rem fijaba la última columna con fondo transparente y tapaba las demás (medido el
             2026-11-26: «CaQueda del banco» en el Fold 7; Saldo cortado y Preparado/Cargos fuera a 390 px). -->
        <div class="dt-scope">
        <p-table [value]="visibles()" size="small" class="surf-table surf-table--plain dt-stack sc-tabla" [tableStyle]="{ 'min-width': '100%' }" dataKey="bank_account_id">
          <ng-template #header>
            <tr>
              <th scope="col">Cuenta</th>
              <th scope="col" class="comm-num">Saldo</th>
              <th scope="col" class="comm-num">Preparado</th>
              <th scope="col" class="comm-num">Cargos del banco</th>
              <th scope="col" class="comm-num">Queda</th>
            </tr>
          </ng-template>
          <ng-template #body let-c>
            <tr>
              <td class="dt-id" role="cell">{{ nombre(c) }}
                <span class="sc-sub">@switch (c.estado) {
                  @case ('no_alcanza') { <p-tag severity="danger" value="No alcanza" /> }
                  @case ('no_medido') { <p-tag severity="warn" value="Saldo no medido" /> }
                  @default { <p-tag severity="secondary" [value]="s.cargos_medidos ? 'Alcanza' : 'Alcanza lo preparado'" /> }
                }</span>
              </td>
              <td class="comm-num dt-num" role="cell" data-label="Saldo">
                @if (c.saldo === null) { <span class="sc-nm">no medido</span> }
                @else { <span class="sc-v">{{ dinero(c.saldo) }}
                  <span class="sc-sub">al {{ dia(c.saldo_fecha) }} · {{ c.saldo_fuente === 'banco' ? 'descarga' : 'libro' }}@if (c.saldo_viejo) { · <span class="sc-nm">de hace {{ c.saldo_dias }} días</span> }</span></span>
                }
              </td>
              <td class="comm-num dt-num" role="cell" data-label="Preparado"><span class="sc-v">{{ c.programado ? dinero(c.programado) : '—' }}@if (c.pagos.length) { <span class="sc-sub">{{ c.pagos.length === 1 ? '1 pago' : c.pagos.length + ' pagos' }}</span> }</span></td>
              <td class="comm-num dt-num" role="cell" data-label="Cargos del banco">
                @if (!s.cargos_medidos) { <span class="sc-nm">no medido</span> }
                @else { <span class="sc-v">{{ c.cargos_total ? dinero(c.cargos_total) : '—' }}@if (c.cargos.length) { <span class="sc-sub">{{ c.cargos.length === 1 ? '1 cargo' : c.cargos.length + ' cargos' }}</span> }</span> }
              </td>
              <td class="comm-num dt-num" role="cell" data-label="Queda">
                @if (c.disponible === null) { — }
                @else if (c.disponible < 0) { <span class="sc-bad">faltan {{ dinero(-c.disponible) }}</span> }
                @else { {{ dinero(c.disponible) }} }
              </td>
            </tr>
          </ng-template>
          <ng-template #emptymessage><tr><td colspan="5">Ninguna cuenta tiene pagos preparados ni cargos del banco en estos 7 días.</td></tr></ng-template>
        </p-table>
        </div>
        @if (ocultas() > 0) { <p class="sc-d">{{ ocultas() === 1 ? 'Otra cuenta' : ocultas() + ' cuentas más' }} sin pagos preparados ni cargos del banco en estos días.</p> }

        @if (!s.cargos_medidos) {
          <p class="sc-pie sc-nm"><i class="pi pi-info-circle" aria-hidden="true"></i> Los cargos que el banco cobra solo todavía no se pueden revisar: avisa a Sistemas. Lo de arriba sólo cuenta lo preparado.</p>
        } @else {
          <h3 class="sc-h">Cargos del banco del {{ dia(s.hoy) }} al {{ dia(s.hasta) }}</h3>
          <!-- Primero los de las cuentas que se quedan cortas (contestan la pregunta del panel); los de las que alcanzan,
               plegados con su número y su total, a un toque. Medido: 25 cargos apilados en el celular = 6,185 px. -->
          <div class="dt-scope" id="sc-cargos">
          @if (cargosVisibles().length) {
          <p-table [value]="cargosVisibles()" size="small" class="surf-table surf-table--plain dt-stack sc-tabla" [tableStyle]="{ 'min-width': '100%' }">
            <ng-template #header>
              <tr><th scope="col">Día</th><th scope="col">Cuenta</th><th scope="col">Cargo</th><th scope="col" class="comm-num">Importe</th><th scope="col"><span class="sr-only">Estado</span></th></tr>
            </ng-template>
            <ng-template #body let-x>
              <tr>
                <td role="cell" data-label="Día">{{ dia(x.fecha) }}</td>
                <td role="cell" data-label="Cuenta">{{ x.cuenta }}</td>
                <td class="dt-id" role="cell">{{ x.concepto }}@if (x.concepto_reciente && x.concepto_reciente !== x.concepto) { <span class="sc-sub">{{ x.concepto_reciente }}</span> }</td>
                <td class="comm-num dt-num" role="cell" data-label="Importe">{{ dinero(x.importe) }}</td>
                <td role="cell" data-label="Estado" [class.dt-omit]="x.cubierto !== false && !x.atrasado && !x.estimado"><span class="sc-tags">
                  @if (x.cubierto === false) { <p-tag severity="danger" value="No cabe" /> }
                  @if (x.atrasado) { <p-tag severity="warn" value="Atrasado" /> }
                  @if (x.estimado) { <p-tag severity="secondary" value="Estimado" /> }
                </span></td>
              </tr>
            </ng-template>
          </p-table>
          }
          </div>
          @if (!desglose().deCortas.length && !desglose().otros.length) {
            <p class="sc-d">El banco no tiene cargos esperados en estos días.</p>
          }
          @if (desglose().otros.length) {
            <button type="button" class="sc-mas" [attr.aria-expanded]="verTodos()" aria-controls="sc-cargos" (click)="verTodos.set(!verTodos())">
              <i class="pi" [class.pi-angle-down]="!verTodos()" [class.pi-angle-up]="verTodos()" aria-hidden="true"></i>
              @if (verTodos()) { Ver sólo los de las cuentas que no alcanzan }
              @else if (desglose().deCortas.length) { Ver {{ desglose().otros.length === 1 ? 'el otro cargo' : 'los otros ' + desglose().otros.length + ' cargos' }}, de cuentas que sí alcanzan · {{ dinero(desglose().otrosTotal) }} }
              @else { Ver {{ desglose().otros.length === 1 ? 'el cargo' : 'los ' + desglose().otros.length + ' cargos' }} del banco de estos días · {{ dinero(desglose().otrosTotal) }} }
            </button>
          }
          <p class="sc-pie">Los cargos salen de lo que el banco ha cobrado cada mes, 3 meses o más; cuando haya contratos, saldrán de su contrato.
            «Atrasado»: su día ya pasó y el banco no lo ha cobrado. «Estimado»: el importe cambia cada mes (un interés) y se toma el último.</p>
          @if (detenidos().length) {
            <p class="sc-pie">Con más de un mes de atraso no se cuentan: el banco ya debió cobrar también el del mes siguiente y no lo
              hizo. Si vuelve a cobrar, vuelven a contar.</p>
            <ul class="sc-det">
              @for (x of detenidos(); track x.series_key) { <li>{{ x.cuenta }} · {{ x.concepto }} · {{ dinero(x.importe) }}, esperado el {{ dia(x.fecha) }}</li> }
            </ul>
          }
        }
        @if (s.sin_cuenta.pagos > 0) {
          <p class="sc-pie"><b>{{ s.sin_cuenta.pagos === 1 ? '1 pago' : s.sin_cuenta.pagos + ' pagos' }} por {{ dinero(s.sin_cuenta.importe) }}</b>
            de estos días todavía no tienen cuenta de origen: se elige al preparar y hasta entonces no se cuentan en ninguna cuenta.</p>
        }
        <p class="sc-pie"><a class="sc-link" routerLink="/finanzas/bancos" [queryParams]="{ view: 'estados' }"><i class="pi pi-building-columns" aria-hidden="true"></i> Ver los estados de cuenta</a>
          (de ahí sale el saldo).</p>
      }
      </app-load-state>
    </app-side-peek>
  `,
})
export class SuficienciaCuentasPeekComponent {
  readonly open = model(false);
  readonly suficiencia = input<PaymentCalendarSuficiencia | null>(null);
  readonly error = input(false);
  /** «Reintentar» del error: el Calendario vuelve a pedir la suficiencia. */
  readonly reintentar = output<void>();

  readonly nombre = nombreCuenta;
  dinero(n: number | null): string { return money(Number(n ?? 0)); }
  dia(iso: string | null): string { return iso ? fechaCorta(iso, this.suficiencia()?.hoy ?? iso) : '—'; }

  readonly cortas = computed(() => { const s = this.suficiencia(); return s ? cuentasCortas(s) : []; });
  /** Las que tienen algo que decir: lo que falta primero; las demás por banco. */
  readonly visibles = computed<SuficienciaDeCuenta[]>(() => {
    const s = this.suficiencia();
    if (!s) return [];
    const cortas = this.cortas();
    const resto = s.cuentas.filter((c) => !cortas.includes(c) && (c.cargos.length > 0 || c.pagos.length > 0));
    return [...cortas, ...resto];
  });
  readonly ocultas = computed(() => (this.suficiencia()?.cuentas.length ?? 0) - this.visibles().length);
  /** Los cargos del banco: los de las cuentas cortas a la vista, los demás plegados (`verTodos`). */
  readonly desglose = computed(() => cargosDelDesglose(this.suficiencia()));
  readonly verTodos = signal(false);
  readonly cargosVisibles = computed<CargoConCuenta[]>(() => {
    const d = this.desglose();
    return this.verTodos()
      ? [...d.deCortas, ...d.otros].sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : b.importe - a.importe))
      : d.deCortas;
  });
  /** Los cargos con más de un mes de atraso: no se cuentan (`cargos_detenidos`), y se dice cuáles. */
  readonly detenidos = computed<CargoConCuenta[]>(() => {
    const s = this.suficiencia();
    if (!s) return [];
    return s.cuentas
      .flatMap((c) => c.cargos_detenidos.map((x) => ({ ...x, cuenta: nombreCuenta(c), cuenta_id: c.bank_account_id })))
      .sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : b.importe - a.importe));
  });
  readonly respuesta = computed(() => {
    const s = this.suficiencia();
    const l = lineaDeLaSemana(s, this.error(), { dinero: (n) => this.dinero(n), dia: (iso) => this.dia(iso) });
    if (l) return l.texto;
    return `Todas las cuentas cubren lo preparado y los cargos del banco de estos ${s?.dias ?? 7} días.`;
  });
  readonly subtitulo = computed(() => {
    const s = this.suficiencia();
    return s ? `Del ${this.dia(s.hoy)} al ${this.dia(s.hasta)} · el saldo es el de Bancos` : null;
  });
}
