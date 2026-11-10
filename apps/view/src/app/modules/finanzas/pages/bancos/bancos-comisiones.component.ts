import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { LoadStateComponent } from '../../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent } from '../../../../shared/components/metric-strip/metric-strip.component';
import { SidePeekComponent } from '../../../../shared/components/side-peek/side-peek.component';
import { ContextHelpComponent } from '../../../../shared/context-help/context-help.component';
import { SucursalPipe } from '../../../../shared/pipes/sucursal.pipe';
import type { DiaComision, PropuestaComisiones } from '../../bank.service';
import { cifrasDeComisiones, polizaDelGasto, vistaDeComisiones, type SeccionComisiones } from './bancos-comisiones';
import { dmShort, dmy } from './bancos-shared';
import { BANCOS_STYLES } from './bancos.styles';

/**
 * `[CB.62]` Bancos › Contra Kepler › **Comisiones**: ¿qué comisiones del banco faltan en Kepler?
 *
 * Diseño (FASE_CB §9.4, firmado por Edgar el 2026-11-10): primero la respuesta —cuánto está listo y el único botón—,
 * después lo listo, y plegado con su conteo lo que NO se escribe y por qué (a medias en Finanzas, esperando a la
 * sucursal, por revisar). El detalle de un día se abre al lado, sin perder la lista.
 *
 * ⛔ Sólo LEE: «Generar en Kepler» está apagado y lo dice en pantalla, no en un `title`. La escritura llega con
 * CB.62.4 (captura de prueba, permiso en Kepler, escritor con interruptor).
 */
@Component({
  selector: 'bancos-comisiones',
  standalone: true,
  imports: [CurrencyPipe, ButtonModule, TableModule, LoadStateComponent, FreshnessPillComponent, MetricStripComponent, SidePeekComponent, ContextHelpComponent, SucursalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-load-state [loading]="loading()" [error]="error()" (retry)="reintentar.emit()"
                    [isEmpty]="!!data() && data()!.medido && !data()!.resumen.cargos"
                    emptyTitle="La descarga no trae comisiones de tarjeta"
                    emptyHint="Sube la descarga del banco en Estados de cuenta: de ahí salen las comisiones y su IVA.">
      @if (data(); as d) {
        @if (!d.medido) {
          <p class="cm-nomedido" role="status"><i class="pi pi-info-circle" aria-hidden="true"></i> No se pudo medir: {{ d.motivo }}</p>
        } @else {
          <!-- Q.1 · primario: cuánto está listo, y la única acción -->
          <section class="cm-head" aria-labelledby="cm-titulo">
            <div class="cm-answer">
              <h3 id="cm-titulo" class="cm-q">Comisiones del banco que faltan en Kepler <app-context-help topic="bancos_comisiones" /></h3>
              <p class="cm-primary"><span class="mono">{{ d.resumen.monto_listo | currency:'MXN':'symbol-narrow':'1.2-2' }}</span> listos para Kepler
                <span class="cm-sub">· {{ d.resumen.listos }} {{ d.resumen.listos === 1 ? 'cargo' : 'cargos' }}</span></p>
              <p class="cm-secondary muted">de {{ d.resumen.cargos }} cargos de comisión e IVA en la descarga del {{ dm(d.desde) }} al {{ dm(d.hasta) }}
                · descarga hasta el {{ dm(d.descarga.hasta) }} <app-freshness-pill measures="data" [since]="d.descarga.subida_en" label="subida" [staleAfterSec]="86400" /></p>
            </div>
            <div class="cm-act">
              <button pButton type="button" class="p-button-sm" [disabled]="true" aria-describedby="cm-apagado">
                <span class="p-button-icon p-button-icon-left pi pi-send" aria-hidden="true"></span><span class="p-button-label">Generar en Kepler</span>
              </button>
              <p id="cm-apagado" class="cm-apagado muted">Apagado: la Suite todavía no escribe en Kepler.</p>
            </div>
          </section>

          <!-- secundario: lo que no se escribe, cada cifra abre su lista -->
          <app-metric-strip [items]="cifras()" density="compact" ariaLabel="Comisiones que no se escriben, por motivo" (drill)="abrir($event)" />

          <!-- Listos -->
          <section class="cm-sec" aria-labelledby="cm-listos">
            <h4 id="cm-listos" class="fb-card-title">Listos <span class="muted">· {{ v().listos.length }} {{ v().listos.length === 1 ? 'día' : 'días' }} de venta</span></h4>
            @if (v().listos.length) {
              <div class="card-premium card-flat fb-tablewrap">
                <p-table [value]="v().listos" styleClass="p-datatable-sm surf-table surf-table--plain" [rowHover]="true" dataKey="dia_venta">
                  <ng-template #header>
                    <tr><th>Sucursal</th><th class="col-w8">Día de venta</th><th class="col-w7">Banco</th><th class="comm-num col-w6">Cargos</th><th class="comm-num col-w8">Total</th></tr>
                  </ng-template>
                  <ng-template #body let-dia>
                    <tr class="fb-row-click" tabindex="0" role="button" [attr.aria-label]="'Ver el detalle de ' + (dia.sucursal | sucursal) + ' del ' + dm(dia.dia_venta)"
                        (click)="sel.set(dia)" (keyup.enter)="sel.set(dia)">
                      <td>{{ dia.sucursal | sucursal }}</td><td class="mono">{{ dm(dia.dia_venta) }}</td><td>{{ dia.banco }}</td>
                      <td class="comm-num">{{ dia.cargos.length }}</td><td class="comm-num">{{ dia.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                    </tr>
                  </ng-template>
                </p-table>
              </div>
            } @else {
              <p class="muted cm-vacio">Nada listo: lo que trae la descarga ya lo tiene Finanzas, espera a la sucursal o hay que revisarlo.</p>
            }
          </section>

          <!-- A medias en Finanzas -->
          <section class="cm-sec" aria-labelledby="cm-medias">
            <h4 id="cm-medias" class="fb-card-title">
              <button type="button" class="cm-toggle" [attr.aria-expanded]="abierta() === 'medias'" aria-controls="cm-medias-cuerpo" (click)="alternar('medias')">
                <i class="pi" [class.pi-chevron-right]="abierta() !== 'medias'" [class.pi-chevron-down]="abierta() === 'medias'" aria-hidden="true"></i>
                Finanzas los dejó a medias <span class="muted">· {{ d.resumen.gasto_capturado_sin_pago }} cargos · gasto capturado, faltan sus pagos · no se escriben encima</span>
              </button>
            </h4>
            @if (abierta() === 'medias') {
              <div id="cm-medias-cuerpo" class="card-premium card-flat fb-tablewrap">
                <p-table [value]="v().medias" styleClass="p-datatable-sm surf-table surf-table--plain" [rowHover]="true">
                  <ng-template #header>
                    <tr><th>Sucursal</th><th class="col-w8">Día de venta</th><th class="col-w7">Banco</th><th class="comm-num col-w8">Total</th><th>Qué tiene Finanzas en Kepler</th></tr>
                  </ng-template>
                  <ng-template #body let-dia>
                    <tr class="fb-row-click" tabindex="0" role="button" [attr.aria-label]="'Ver el detalle de ' + (dia.sucursal | sucursal) + ' del ' + dm(dia.dia_venta)"
                        (click)="sel.set(dia)" (keyup.enter)="sel.set(dia)">
                      <td>{{ dia.sucursal | sucursal }}</td><td class="mono">{{ dm(dia.dia_venta) }}</td><td>{{ dia.banco }}</td>
                      <td class="comm-num">{{ dia.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</td><td class="cm-motivo">{{ dia.motivos.join(' · ') }}</td>
                    </tr>
                  </ng-template>
                  <ng-template #emptymessage><tr><td colspan="5"><div class="surf-empty"><p>Ningún día a medias.</p></div></td></tr></ng-template>
                </p-table>
              </div>
            }
          </section>

          <!-- Esperando a la sucursal -->
          <section class="cm-sec" aria-labelledby="cm-espera">
            <h4 id="cm-espera" class="fb-card-title">
              <button type="button" class="cm-toggle" [attr.aria-expanded]="abierta() === 'espera'" aria-controls="cm-espera-cuerpo" (click)="alternar('espera')">
                <i class="pi" [class.pi-chevron-right]="abierta() !== 'espera'" [class.pi-chevron-down]="abierta() === 'espera'" aria-hidden="true"></i>
                Esperando a la sucursal <span class="muted">· {{ d.resumen.esperando_sucursal }} cargos · la sucursal no ha capturado su depósito en Kepler (suele tardar de 0 a 5 días)</span>
              </button>
            </h4>
            @if (abierta() === 'espera') {
              <div id="cm-espera-cuerpo" class="card-premium card-flat fb-tablewrap">
                <p class="muted cm-nota">Sin el depósito en Kepler no se sabe de qué sucursal ni de qué día es: por eso va por cuenta.</p>
                <p-table [value]="v().espera" styleClass="p-datatable-sm surf-table surf-table--plain">
                  <ng-template #header>
                    <tr><th>Cuenta</th><th class="comm-num col-w7">Depósitos</th><th class="comm-num col-w6">Cargos</th><th class="comm-num col-w8">Total</th><th class="col-w8">Desde</th></tr>
                  </ng-template>
                  <ng-template #body let-f>
                    <tr><td>{{ f.banco }} {{ f.cuenta }}</td><td class="comm-num">{{ f.depositos }}</td><td class="comm-num">{{ f.cargos }}</td>
                      <td class="comm-num">{{ f.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</td><td class="mono">{{ dm(f.desde) }}</td></tr>
                  </ng-template>
                  <ng-template #emptymessage><tr><td colspan="5"><div class="surf-empty"><p>Nada espera a la sucursal.</p></div></td></tr></ng-template>
                </p-table>
              </div>
            }
          </section>

          <!-- Por revisar -->
          <section class="cm-sec" aria-labelledby="cm-revisar">
            <h4 id="cm-revisar" class="fb-card-title">
              <button type="button" class="cm-toggle" [attr.aria-expanded]="abierta() === 'revisar'" aria-controls="cm-revisar-cuerpo" (click)="alternar('revisar')">
                <i class="pi" [class.pi-chevron-right]="abierta() !== 'revisar'" [class.pi-chevron-down]="abierta() === 'revisar'" aria-hidden="true"></i>
                Por revisar <span class="muted">· {{ d.resumen.por_revisar }} cargos · la Suite no adivina: cada uno dice por qué</span>
              </button>
            </h4>
            @if (abierta() === 'revisar') {
              <div id="cm-revisar-cuerpo" class="card-premium card-flat fb-tablewrap">
                <p-table [value]="v().revisar" styleClass="p-datatable-sm surf-table surf-table--plain" dataKey="clave">
                  <ng-template #header>
                    <tr><th>Sucursal o cuenta</th><th class="col-w8">Fecha</th><th class="comm-num col-w6">Cargos</th><th class="comm-num col-w8">Total</th><th>Por qué</th></tr>
                  </ng-template>
                  <ng-template #body let-f>
                    <tr [class.fb-row-click]="!!f.dia" [attr.tabindex]="f.dia ? 0 : null" [attr.role]="f.dia ? 'button' : null"
                        (click)="f.dia && sel.set(f.dia)" (keyup.enter)="f.dia && sel.set(f.dia)">
                      <td>@if (f.sucursal) { {{ f.sucursal | sucursal }} · {{ f.banco }} } @else { {{ f.banco }} {{ f.cuenta }} }</td>
                      <td class="mono">{{ dm(f.fecha) }}</td><td class="comm-num">{{ f.cargos }}</td>
                      <td class="comm-num">{{ f.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</td><td class="cm-motivo">{{ f.motivo }}</td>
                    </tr>
                  </ng-template>
                  <ng-template #emptymessage><tr><td colspan="5"><div class="surf-empty"><p>Nada por revisar.</p></div></td></tr></ng-template>
                </p-table>
              </div>
            }
          </section>

          <p class="muted cm-completos"><i class="pi pi-check-circle ok" aria-hidden="true"></i> {{ d.resumen.ya_en_kepler }} cargos ya tienen su pago en Kepler: no son trabajo de nadie.</p>
        }
      }
    </app-load-state>

    <!-- El detalle de un día, al lado (O.1: no en un modal) -->
    <app-side-peek [open]="!!sel()" (openChange)="$event || sel.set(null)"
                   [title]="sel() ? (sel()!.sucursal | sucursal) + ' · venta del ' + dmLargo(sel()!.dia_venta) : 'Día de venta'"
                   [subtitle]="sel() ? sel()!.banco + ' · ' + sel()!.cargos.length + ' cargos · ' + (sel()!.total | currency:'MXN':'symbol-narrow':'1.2-2') : ''">
      @if (sel(); as dia) {
        @if (dia.motivos.length) { <p class="cm-motivos" role="status"><i class="pi pi-info-circle" aria-hidden="true"></i> {{ dia.motivos.join(' · ') }}</p> }
        <h5 class="fb-pnl-title">Los cargos del banco</h5>
        <table class="surf-table surf-table--plain is-dense cm-tabla">
          <thead><tr><th>Fecha</th><th>Texto del banco</th><th class="comm-num">Importe</th><th>En Kepler</th></tr></thead>
          <tbody>
            @for (c of dia.cargos; track c.id) {
              <tr>
                <td class="mono">{{ dm(c.fecha) }}</td>
                <td class="cm-concepto">{{ c.concepto }}<span class="muted"> · {{ c.tipo === 'iva' ? 'IVA' : 'comisión' }} · cuenta {{ c.cuenta }}</span></td>
                <td class="comm-num">{{ c.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td class="mono muted">@if (c.kepler_pago) { pago {{ c.kepler_pago }} } @else if (c.kepler_gasto) { {{ c.kepler_gasto }} } @else { — }</td>
              </tr>
            }
          </tbody>
        </table>
        @if (dia.plan; as plan) {
          <h5 class="fb-pnl-title">Lo que se escribiría en Kepler</h5>
          <p class="cm-plan">Una solicitud y un gasto de <b class="mono">{{ plan.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</b>
            ({{ plan.gasto.kdm6.length }} {{ plan.gasto.kdm6.length === 1 ? 'renglón' : 'renglones' }} de comisión en 611-003, IVA de
            <span class="mono">{{ plan.iva | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>) y {{ plan.pagos.length }} pagos, uno por cargo, cada uno igual al banco.</p>
          <table class="surf-table surf-table--plain is-dense cm-tabla" aria-label="Póliza del gasto">
            <thead><tr><th>Cuenta</th><th>Cargo o abono</th><th class="comm-num">Importe</th></tr></thead>
            <tbody>
              @for (r of poliza(); track $index) {
                <tr><td class="mono">{{ r.cuenta }}</td><td>{{ r.lado }}</td><td class="comm-num">{{ r.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td></tr>
              }
            </tbody>
          </table>
          <p class="muted cm-nota">Póliza de diario del gasto, fechada el día de venta. Cada pago lleva además su póliza de egreso (201 contra 102).</p>
        }
      }
    </app-side-peek>
  `,
  styles: [BANCOS_STYLES, `
    :host { display: block; container-type: inline-size; }
    /* #9 · en angosto (sidebar abierto, tablet) el botón y su motivo bajan bajo la respuesta, alineados a la izquierda. */
    @container (max-width: 40rem) {
      .cm-act { align-items: flex-start; }
      .cm-apagado { text-align: left; }
    }
    .cm-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: var(--sp-3); margin-bottom: var(--sp-3); }
    .cm-answer { min-width: 0; flex: 1 1 28rem; }
    .cm-q { margin: 0 0 var(--sp-1); font-size: var(--fs-sm); font-weight: 600; color: var(--text-muted); display: flex; align-items: center; gap: var(--sp-1); }
    .cm-primary { margin: 0; font-size: var(--fs-xl); font-weight: 700; color: var(--text-main); font-variant-numeric: tabular-nums; }
    .cm-sub { font-size: var(--fs-body); font-weight: 400; color: var(--text-muted); }
    .cm-secondary { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1); }
    .cm-act { display: flex; flex-direction: column; align-items: flex-end; gap: var(--sp-1); }
    .cm-apagado { margin: 0; font-size: var(--fs-xs); max-width: 18rem; text-align: right; }
    .cm-sec { margin-top: var(--sp-4); }
    .cm-toggle { display: inline-flex; align-items: center; gap: var(--sp-2); background: none; border: 0; padding: 0; font: inherit; color: inherit; cursor: pointer; text-align: left; }
    .cm-toggle:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; border-radius: var(--r-sm); }
    .cm-vacio, .cm-completos { font-size: var(--fs-sm); margin: var(--sp-2) 0 0; }
    .cm-completos { margin-top: var(--sp-4); display: flex; align-items: center; gap: var(--sp-1); }
    .cm-nota { font-size: var(--fs-xs); margin: var(--sp-2) 0; }
    .cm-motivo { font-size: var(--fs-sm); color: var(--text-muted); }
    .cm-nomedido, .cm-motivos { display: flex; align-items: baseline; gap: var(--sp-1); font-size: var(--fs-sm); color: var(--text-muted); margin: 0 0 var(--sp-3); }
    .cm-tabla { width: 100%; margin-bottom: var(--sp-3); }
    .cm-concepto { font-size: var(--fs-sm); word-break: break-word; }
    .cm-plan { font-size: var(--fs-sm); margin: 0 0 var(--sp-2); }
  `],
})
export class BancosComisionesComponent {
  readonly data = input<PropuestaComisiones | null>(null);
  readonly loading = input(false);
  readonly error = input<string | null>(null);
  readonly reintentar = output<void>();

  readonly v = computed(() => {
    const d = this.data();
    return d ? vistaDeComisiones(d) : { listos: [], medias: [], espera: [], revisar: [] };
  });
  readonly cifras = computed(() => {
    const d = this.data();
    return d ? cifrasDeComisiones(d) : [];
  });
  /** La sección plegable abierta: una a la vez. */
  readonly abierta = signal<SeccionComisiones | null>(null);
  readonly sel = signal<DiaComision | null>(null);
  readonly poliza = computed(() => {
    const d = this.sel();
    return d ? polizaDelGasto(d) : [];
  });

  alternar(s: SeccionComisiones): void { this.abierta.set(this.abierta() === s ? null : s); }
  /** La cifra de la franja abre su lista. */
  abrir(s: string): void { if (s === 'medias' || s === 'espera' || s === 'revisar') this.abierta.set(s); }
  dm(v: string | null | undefined): string { return v ? dmShort(v) : '—'; }
  dmLargo(v: string): string { return dmy(v); }
}
