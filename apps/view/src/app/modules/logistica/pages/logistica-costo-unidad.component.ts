import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { ButtonModule } from 'primeng/button';
import { DatePickerModule } from 'primeng/datepicker';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService, MessageService } from 'primeng/api';
import type {
  AreaFlota, AvisoUnidad, CambiosFicha, DetalleUnidadCosto, FichaUnidad, GrupoRubro, Procedencia, Propiedad,
  RenglonRubro, ResumenCostoUnidad, UnidadCosto,
} from '@megadulces/contracts';
import {
  AREA_FLOTA_LABEL, CORTES_COSTO_UNIDAD, ESTADO_LINEA_FLOTA_LABEL, GRUPO_RUBRO_LABEL, PROCEDENCIA_LABEL,
} from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { LogisticaService } from '../logistica.service';
import { COSTO_UNIDAD_TABS } from '../costo-unidad-tabs';
import { aIso, deIso, enCorte, rangoDe, type CorteVista, type Preset } from '../costo-unidad-fechas';

const PROCEDENCIA_SEV: Record<Procedencia, 'success' | 'info' | 'secondary' | 'warn' | 'danger'> = {
  kepler: 'info', captura: 'secondary', calculado: 'success', sin_dato: 'warn', sin_medir: 'warn', restringido: 'secondary',
};

const GRUPOS: GrupoRubro[] = ['fijos', 'variables', 'administrativos', 'fuera_de_hoja'];

/**
 * `[FCU.3.1–3.3]` — **Costo por unidad: lo que hacía la hoja «TRANSPORTES 2026», con pantalla.**
 *
 * La pregunta que contesta: ¿cuánto cuesta cada unidad de Transportes contra lo presupuestado, y por
 * km? El gasto real sale de Kepler (la unidad sugerida por el texto o confirmada en «Gastos sin
 * unidad»), los km del GPS o del odómetro, las comisiones de sus guías a la tarifa de su ruta, y lo
 * que no existe en ninguna fuente (salario, nómina administrativa, depreciación) se captura.
 *
 * Jerarquía: primario = el veredicto del periodo (real contra presupuesto de la flota); secundario =
 * la fila por unidad; terciario = cada rubro con su cálculo, sus renglones y la ficha, en el panel.
 * El selector de corte reproduce las columnas de la hoja (anual, 6 y 4 meses, mes, periodo de 28
 * días, catorcena, día) a partir de lo medido en el periodo.
 */
@Component({
  selector: 'app-logistica-costo-unidad',
  standalone: true,
  imports: [
    CurrencyPipe, DecimalPipe, FormsModule, RouterLink, TableModule, SelectModule, ButtonModule, DatePickerModule, InputNumberModule,
    InputTextModule, TextareaModule, TagModule, ToastModule, ConfirmDialogModule, LoadStateComponent, MetricStripComponent,
    FreshnessPillComponent, SidePeekComponent, PageTabsComponent, ContextHelpComponent,
  ],
  providers: [MessageService, ConfirmationService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page cu">
      <p-toast />
      <p-confirmdialog />
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Costo por unidad</h1>
          <p class="surf-page-sub">Lo que hacía la hoja de costos de Transportes: cuánto cuesta cada unidad contra su presupuesto. El gasto sale de Kepler, los km del GPS y las comisiones de las guías; lo que no existe en ninguna fuente se captura aquí.</p>
        </div>
        <app-context-help topic="costo-unidad" />
      </header>
      <app-page-tabs [tabs]="tabs" ariaLabel="Pantallas de costo por unidad" />

      <section class="cu-barra" aria-label="Periodo y corte">
        <p-select [options]="presets" optionLabel="label" optionValue="value" [ngModel]="preset()" (ngModelChange)="elegirPreset($event)"
                  ariaLabel="Periodo" appendTo="body" class="cu-sel" />
        <p-datepicker [ngModel]="desdeFecha()" (ngModelChange)="cambiarFecha('desde', $event)" dateFormat="dd/mm/yy" [showIcon]="true"
                      inputId="cu-desde" ariaLabel="Desde" appendTo="body" class="cu-fecha" />
        <p-datepicker [ngModel]="hastaFecha()" (ngModelChange)="cambiarFecha('hasta', $event)" dateFormat="dd/mm/yy" [showIcon]="true"
                      inputId="cu-hasta" ariaLabel="Hasta" appendTo="body" class="cu-fecha" />
        <p-select [options]="cortes" optionLabel="label" optionValue="value" [ngModel]="corte()" (ngModelChange)="corte.set($event)"
                  ariaLabel="Expresar en" appendTo="body" class="cu-sel" />
        <span class="cu-espacio"></span>
        @if (data(); as d) { <app-freshness-pill measures="fetch" [since]="d.leido_at" label="gastos de Kepler y GPS" /> }
      </section>

      @if (data(); as d) {
        <p class="cu-titular">{{ titular() }}</p>
        @if (porConfirmar(); as p) {
          @if (p.renglones) {
            <p class="cu-aviso">
              {{ p.renglones }} gasto{{ p.renglones === 1 ? '' : 's' }} de flota por confirmar ({{ p.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}):
              hasta que alguien diga de qué unidad son, el costo de esa unidad queda corto o sugerido.
              <a routerLink="/logistica/costo-unidad/pendientes" [queryParams]="{ desde: desde(), hasta: hasta() }">Ir a Gastos sin unidad</a>
            </p>
          }
        }
        @if (d.meses_sin_nomina.length && puedeGestionar) {
          <p class="cu-aviso">Falta capturar la nómina administrativa de {{ d.meses_sin_nomina.join(', ') }}. <a routerLink="/logistica/costo-unidad/nomina">Capturarla</a></p>
        }
        <app-metric-strip [items]="kpis()" mode="strip" density="compact" ariaLabel="Costo de la flota en el periodo" />
      }

      <app-load-state [loading]="cargando() && !data()" [error]="error()" [isEmpty]="!!data() && !data()!.unidades.length"
                      emptyIcon="pi-truck" emptyTitle="Ninguna unidad está marcada como de Transportes"
                      emptyHint="Marca el área «Transportes» en la ficha de cada unidad para que aparezca aquí."
                      (retry)="cargar()">
        <div class="dt-scope">
          <p-table [value]="filas()" dataKey="vehicle_id" selectionMode="single" [selection]="seleccion()"
                   (onRowSelect)="alSeleccionar($event.data)" size="small"
                   class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first dt-stack" [tableStyle]="{ 'min-width': '60rem' }">
            <ng-template #header>
              <tr>
                <th scope="col">Unidad</th>
                <th scope="col" class="comm-num">Km</th>
                <th scope="col" class="comm-num">Guías</th>
                <th scope="col" class="comm-num">Presupuesto {{ corteLabel() }}</th>
                <th scope="col" class="comm-num">Real {{ corteLabel() }}</th>
                <th scope="col" class="comm-num">Diferencia</th>
                <th scope="col" class="comm-num">$/km real</th>
                <th scope="col" class="comm-num">$/km hoja</th>
                <th scope="col">Avisos</th>
              </tr>
            </ng-template>
            <ng-template #body let-u>
              <tr [pSelectableRow]="u" [attr.aria-label]="'Abrir ' + u.nombre">
                <td data-label="Unidad">
                  <span class="cu-unidad">{{ u.economic_number ?? 'Sin número' }} · {{ u.nombre }}</span>
                  <span class="cu-sub">{{ u.plate }}{{ u.fleet_area && u.fleet_area !== 'transportes' ? ' · ' + area(u.fleet_area) : '' }}</span>
                </td>
                <td data-label="Km" class="comm-num">
                  @if (u.km.km != null) { {{ u.km.km | number:'1.0-0' }} <span class="cu-sub">{{ u.km.fuente === 'gps' ? 'GPS' : 'odómetro' }}</span> }
                  @else { <span class="cu-falta">sin km</span> }
                </td>
                <td data-label="Guías" class="comm-num">{{ u.guias }}</td>
                <td data-label="Presupuesto" class="comm-num">@if (u.presCorte != null) { {{ u.presCorte | currency:'MXN':'symbol-narrow':'1.2-2' }} } @else { <span class="cu-falta">sin presupuesto</span> }</td>
                <td data-label="Real" class="comm-num cu-fuerte">{{ u.realCorte | currency:'MXN':'symbol-narrow':'1.2-2' }}
                  @if (u.rubros_sin_dato) { <span class="cu-sub">sin {{ u.rubros_sin_dato }} rubro{{ u.rubros_sin_dato === 1 ? '' : 's' }}</span> }
                </td>
                <td data-label="Diferencia" class="comm-num" [class.cu-malo]="(u.difCorte ?? 0) > 0">@if (u.difCorte != null) { {{ u.difCorte | currency:'MXN':'symbol-narrow':'1.2-2' }} } @else { — }</td>
                <td data-label="$/km real" class="comm-num">@if (u.por_km_real != null) { {{ u.por_km_real | currency:'MXN':'symbol-narrow':'1.2-2' }} } @else { — }</td>
                <td data-label="$/km hoja" class="comm-num">@if (u.por_km_presupuesto != null) { {{ u.por_km_presupuesto | currency:'MXN':'symbol-narrow':'1.2-2' }} } @else { — }</td>
                <td data-label="Avisos">
                  @for (a of u.avisos.slice(0, 2); track a.tipo) { <p-tag [value]="a.texto" [severity]="sev(a)" class="cu-tag" /> }
                  @if (u.avisos.length > 2) { <span class="cu-sub">y {{ u.avisos.length - 2 }} más</span> }
                </td>
              </tr>
            </ng-template>
            <ng-template #footer>
              <tr>
                <td>Flota ({{ filas().length }})</td><td class="comm-num">{{ totalKm() | number:'1.0-0' }}</td><td class="comm-num">{{ totalGuias() }}</td>
                <td class="comm-num">{{ totalPresCorte() | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td class="comm-num cu-fuerte">{{ totalRealCorte() | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td></td><td></td><td></td><td></td>
              </tr>
            </ng-template>
          </p-table>
        </div>
      </app-load-state>

      <app-side-peek [open]="!!selId()" (openChange)="!$event && cerrar()" [width]="760"
                     [title]="detalle()?.unidad?.nombre ?? seleccionada()?.nombre ?? ''"
                     [subtitle]="subtitulo()">
        @if (selId()) {
          <app-load-state [loading]="cargandoDetalle()" [error]="errorDetalle()" [isEmpty]="false" (retry)="cargarDetalle()">
            @if (detalle(); as d) {
              <div class="cu-peek">
                <div class="cu-peek-head">
                  <div>
                    <span class="cu-sub">Real del periodo</span>
                    <span class="cu-total">{{ d.unidad.real | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
                    <span class="cu-sub">contra {{ d.unidad.presupuesto != null ? (d.unidad.presupuesto | currency:'MXN':'symbol-narrow':'1.2-2') : 'sin presupuesto' }} · {{ d.periodo.dias }} días</span>
                  </div>
                  <dl class="cu-dl">
                    <dt>Km</dt><dd>{{ d.unidad.km.km != null ? (d.unidad.km.km | number:'1.0-0') + ' (' + (d.unidad.km.fuente === 'gps' ? 'GPS' : 'odómetro') + ')' : 'sin km' }}</dd>
                    <dt>$/km real</dt><dd>{{ d.unidad.por_km_real != null ? (d.unidad.por_km_real | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</dd>
                    <dt>$/km de la hoja</dt><dd>{{ d.unidad.por_km_presupuesto != null ? (d.unidad.por_km_presupuesto | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</dd>
                    <dt>Guías</dt><dd>{{ d.unidad.guias }}</dd>
                  </dl>
                </div>
                @for (a of d.unidad.avisos; track a.tipo) { <p-tag [value]="a.texto" [severity]="sev(a)" class="cu-tag" /> }

                @for (g of grupos; track g) {
                  @if (rubrosDe(d.unidad.rubros, g); as rs) {
                    @if (rs.length) {
                      <h3>{{ grupoLabel(g) }}</h3>
                      <p-table [value]="rs" size="small" class="surf-table surf-table--plain dt-stack">
                        <ng-template #header>
                          <tr><th scope="col">Rubro</th><th scope="col" class="comm-num">Presupuesto</th><th scope="col" class="comm-num">Real</th><th scope="col">De dónde sale</th></tr>
                        </ng-template>
                        <ng-template #body let-r>
                          <tr>
                            <td data-label="Rubro">{{ r.etiqueta }}
                              @if (r.presupuesto_anual != null) { <span class="cu-sub">{{ r.presupuesto_anual | currency:'MXN':'symbol-narrow':'1.0-0' }} al año</span> }
                            </td>
                            <td data-label="Presupuesto" class="comm-num">{{ r.presupuesto != null ? (r.presupuesto | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</td>
                            <td data-label="Real" class="comm-num cu-fuerte">
                              @if (r.real != null) { {{ r.real | currency:'MXN':'symbol-narrow':'1.2-2' }} } @else { <span class="cu-falta">{{ procedencia(r.procedencia) }}</span> }
                            </td>
                            <td data-label="De dónde sale"><p-tag [value]="procedencia(r.procedencia)" [severity]="sevProcedencia(r.procedencia)" class="cu-tag" /> <span class="cu-calculo">{{ r.calculo }}</span></td>
                          </tr>
                        </ng-template>
                      </p-table>
                    }
                  }
                }

                <h3>Gastos de Kepler de esta unidad ({{ d.lineas.length }})</h3>
                @if (d.lineas.length) {
                  <p-table [value]="d.lineas" size="small" class="surf-table surf-table--plain dt-stack">
                    <ng-template #header>
                      <tr><th scope="col">Fecha</th><th scope="col">Folio</th><th scope="col">Texto en Kepler</th><th scope="col" class="comm-num">Importe</th><th scope="col">Estado</th></tr>
                    </ng-template>
                    <ng-template #body let-l>
                      <tr>
                        <td data-label="Fecha">{{ l.fecha }}</td>
                        <td data-label="Folio" class="cu-mono">{{ l.folio }}</td>
                        <td data-label="Texto en Kepler">{{ l.cabecera }}<span class="cu-sub">{{ l.texto }}</span></td>
                        <td data-label="Importe" class="comm-num">{{ l.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                        <td data-label="Estado">{{ estadoLinea(l.estado) }}</td>
                      </tr>
                    </ng-template>
                  </p-table>
                } @else { <p class="cu-sub">Ningún gasto de Kepler del periodo nombra esta unidad.</p> }

                <details class="cu-det">
                  <summary>Guías del periodo ({{ d.guias.length }}) — de aquí sale la comisión</summary>
                  @if (d.guias.length) {
                    <p-table [value]="d.guias" size="small" class="surf-table surf-table--plain dt-stack">
                      <ng-template #header><tr><th scope="col">Fecha</th><th scope="col">Guía</th><th scope="col">Ruta</th><th scope="col" class="comm-num">Comisión chofer</th></tr></ng-template>
                      <ng-template #body let-g>
                        <tr><td data-label="Fecha">{{ g.fecha }}</td><td data-label="Guía" class="cu-mono">{{ g.guia }}</td><td data-label="Ruta">{{ g.ruta ?? '—' }}</td>
                          <td data-label="Comisión chofer" class="comm-num">{{ g.comision_chofer != null ? (g.comision_chofer | currency:'MXN':'symbol-narrow':'1.2-2') : 'sin tarifa' }}</td></tr>
                      </ng-template>
                    </p-table>
                  } @else { <p class="cu-sub">Sin guías de embarque en el periodo.</p> }
                </details>

                @if (d.km_por_mes.length) {
                  <h3>Km por mes</h3>
                  <ul class="cu-km">@for (k of d.km_por_mes; track k.mes) { <li><span>{{ k.mes }}</span><span class="comm-num">{{ k.km | number:'1.0-0' }} km · {{ k.fuente === 'gps' ? 'GPS' : 'odómetro' }}</span></li> }</ul>
                }

                <h3>Ficha</h3>
                <form class="cu-ficha" (ngSubmit)="guardarFicha()">
                  <fieldset [disabled]="!puedeGestionar || guardando()">
                    <legend>Identidad</legend>
                    <label>Número<input pInputText name="economic_number" [ngModel]="ficha().economic_number" (ngModelChange)="editar('economic_number', $event)" placeholder="UNIDAD 1" /></label>
                    <label>Nombre<input pInputText name="display_name" [ngModel]="ficha().display_name" (ngModelChange)="editar('display_name', $event)" /></label>
                    <label>Número de serie (VIN)<input pInputText name="vin" [ngModel]="ficha().vin" (ngModelChange)="editar('vin', $event)" class="cu-mono" /></label>
                    <label>Año del modelo<p-inputnumber name="year" [ngModel]="ficha().year" (ngModelChange)="editar('year', $event)" [useGrouping]="false" /></label>
                    <label>Área<p-select name="fleet_area" [options]="areas" optionLabel="label" optionValue="value" [ngModel]="ficha().fleet_area" (ngModelChange)="editar('fleet_area', $event)" [showClear]="true" appendTo="body" /></label>
                    <p class="cu-sub cu-span">Placa en la Suite: {{ d.ficha.plate }}@if (d.ficha.plate_kepler) { · en Kepler: {{ d.ficha.plate_kepler }} } · {{ d.ficha.tiene_gps ? 'con GPS ligado' : 'sin GPS ligado' }}</p>
                  </fieldset>
                  <fieldset [disabled]="!puedeGestionar || guardando()">
                    <legend>Seguro</legend>
                    <label>Aseguradora<input pInputText name="insurance_carrier" [ngModel]="ficha().insurance_carrier" (ngModelChange)="editar('insurance_carrier', $event)" /></label>
                    <label>Póliza<input pInputText name="insurance_policy" [ngModel]="ficha().insurance_policy" (ngModelChange)="editar('insurance_policy', $event)" /></label>
                    <label>Prima anual<p-inputnumber name="insurance_premium" [ngModel]="ficha().insurance_premium" (ngModelChange)="editar('insurance_premium', $event)" mode="currency" currency="MXN" locale="es-MX" /></label>
                    <label>Vence<p-datepicker name="insurance_expires_on" [ngModel]="fechaDe(ficha().insurance_expires_on)" (ngModelChange)="editarFecha('insurance_expires_on', $event)" dateFormat="dd/mm/yy" appendTo="body" /></label>
                  </fieldset>
                  <fieldset [disabled]="!puedeGestionar || guardando()">
                    <legend>Compra o renta</legend>
                    <label>Propia o arrendada<p-select name="ownership" [options]="propiedades" optionLabel="label" optionValue="value" [ngModel]="ficha().ownership" (ngModelChange)="editar('ownership', $event)" [showClear]="true" appendTo="body" /></label>
                    <label>Valor de compra<p-inputnumber name="purchase_value" [ngModel]="ficha().purchase_value" (ngModelChange)="editar('purchase_value', $event)" mode="currency" currency="MXN" locale="es-MX" /></label>
                    <label>Fecha de compra<p-datepicker name="purchase_date" [ngModel]="fechaDe(ficha().purchase_date)" (ngModelChange)="editarFecha('purchase_date', $event)" dateFormat="dd/mm/yy" appendTo="body" /></label>
                    <label>Vida útil (años)<p-inputnumber name="useful_life_years" [ngModel]="ficha().useful_life_years" (ngModelChange)="editar('useful_life_years', $event)" [maxFractionDigits]="1" /></label>
                    <label>Valor residual<p-inputnumber name="residual_value" [ngModel]="ficha().residual_value" (ngModelChange)="editar('residual_value', $event)" mode="currency" currency="MXN" locale="es-MX" /></label>
                  </fieldset>
                  <fieldset [disabled]="!puedeGestionar || guardando()">
                    <legend>Operación</legend>
                    <label>Km presupuestados al año<p-inputnumber name="budget_km_year" [ngModel]="ficha().budget_km_year" (ngModelChange)="editar('budget_km_year', $event)" /></label>
                    @if (d.ficha.salario_visible) {
                      <label>Salario mensual del chofer<p-inputnumber name="driver_monthly_salary" [ngModel]="ficha().driver_monthly_salary" (ngModelChange)="editar('driver_monthly_salary', $event)" mode="currency" currency="MXN" locale="es-MX" /></label>
                    } @else { <p class="cu-sub">El salario sólo lo ve quien gestiona Costo por unidad.</p> }
                    <label class="cu-span">Cómo se escribe en los gastos de Kepler (uno por renglón)
                      <textarea pTextarea name="kepler_aliases" rows="3" [ngModel]="aliasTexto()" (ngModelChange)="editarAlias($event)"></textarea>
                    </label>
                  </fieldset>
                  @if (puedeGestionar) {
                    <div class="cu-acciones">
                      <button pButton type="submit" size="small" [disabled]="!sucio() || guardando()"><span class="p-button-label">{{ guardando() ? 'Guardando…' : 'Guardar ficha' }}</span></button>
                      @if (sucio()) { <span class="cu-sub">Hay cambios sin guardar</span> }
                    </div>
                  }
                </form>
                <p class="cu-sub"><a routerLink="/logistica/costo-unidad/reposicion" [queryParams]="{ unidad: d.ficha.vehicle_id }">Simular su reposición</a> con el valor de compra de la ficha y sus km de los últimos 12 meses.</p>

                <h3>Odómetro {{ d.ficha.tiene_gps ? '(tiene GPS: sólo para cotejar)' : '(sin GPS: los km salen de aquí)' }}</h3>
                @if (puedeGestionar) {
                  <form class="cu-odo" (ngSubmit)="registrarLectura()">
                    <label>Fecha<p-datepicker name="odo_fecha" [ngModel]="lecturaFecha()" (ngModelChange)="lecturaFecha.set($event)" dateFormat="dd/mm/yy" appendTo="body" /></label>
                    <label>Km del odómetro<p-inputnumber name="odo_km" [ngModel]="lecturaKm()" (ngModelChange)="lecturaKm.set($event)" [useGrouping]="true" /></label>
                    <button pButton type="submit" size="small" [outlined]="true" [disabled]="!lecturaFecha() || lecturaKm() == null || guardando()"><span class="p-button-label">Registrar lectura</span></button>
                  </form>
                }
                @if (d.lecturas.length) {
                  <ul class="cu-km">@for (l of d.lecturas; track l.id) {
                    <li><span>{{ l.read_on }}</span><span class="comm-num">{{ l.odometer_km | number:'1.0-0' }} km</span>
                      @if (puedeGestionar) { <button pButton type="button" size="small" [text]="true" severity="danger" (click)="borrarLectura(l.id)" [disabled]="guardando()" [attr.aria-label]="'Quitar la lectura del ' + l.read_on"><span class="p-button-icon pi pi-times" aria-hidden="true"></span></button> }
                    </li>
                  }</ul>
                } @else { <p class="cu-sub">Sin lecturas capturadas.</p> }
              </div>
            }
          </app-load-state>
        }
      </app-side-peek>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cu { display: flex; flex-direction: column; gap: var(--sp-3); container-type: inline-size; }
    .cu-barra { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
    .cu-sel { min-width: 12rem; }
    .cu-fecha { width: 10rem; }
    .cu-espacio { flex: 1; }
    .cu-titular { margin: 0; font-size: var(--fs-lg); font-weight: var(--fw-bold); color: var(--fg-1); }
    .cu-aviso { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md); font-size: var(--fs-sm); background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .cu-unidad { font-weight: var(--fw-medium); }
    .cu-sub { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
    .cu-falta { font-size: var(--fs-xs); color: var(--warn-soft-fg); }
    .cu-fuerte { font-weight: var(--fw-bold); }
    .cu-malo { color: var(--bad-fg); }
    .cu-tag { margin: 0 var(--sp-1) var(--sp-1) 0; }
    .cu-mono { font-family: var(--font-mono); }
    .cu-peek { display: flex; flex-direction: column; gap: var(--sp-2); }
    .cu-peek h3 { margin: var(--sp-3) 0 var(--sp-1); font-size: var(--fs-sm); font-weight: var(--fw-bold); }
    .cu-peek-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: var(--sp-3); }
    .cu-total { display: block; font-size: var(--fs-h2); font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; }
    .cu-dl { display: grid; grid-template-columns: auto auto; gap: var(--sp-1) var(--sp-3); margin: 0; font-size: var(--fs-sm); }
    .cu-dl dt { color: var(--text-muted); }
    .cu-dl dd { margin: 0; font-variant-numeric: tabular-nums; }
    .cu-calculo { font-size: var(--fs-xs); color: var(--text-muted); }
    .cu-det summary { cursor: pointer; font-size: var(--fs-sm); font-weight: var(--fw-bold); padding: var(--sp-2) 0; }
    .cu-det summary:focus-visible { outline: 2px solid var(--action); outline-offset: 1px; }
    .cu-km { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); }
    .cu-km li { display: flex; align-items: center; gap: var(--sp-3); }
    .cu-ficha { display: flex; flex-direction: column; gap: var(--sp-3); }
    .cu-ficha fieldset { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: var(--sp-2) var(--sp-3); margin: 0; padding: 0; border: 0; }
    .cu-ficha legend { font-size: var(--fs-xs); font-weight: var(--fw-bold); color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em; margin-bottom: var(--sp-1); }
    .cu-ficha label, .cu-odo label { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); }
    .cu-span { grid-column: 1 / -1; }
    .cu-acciones { display: flex; align-items: center; gap: var(--sp-2); }
    .cu-odo { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--sp-2); }
    @container (max-width: 40rem) { .cu-espacio { display: none; } .cu-fecha { width: 100%; } }
  `],
})
export class LogisticaCostoUnidadComponent {
  private readonly api = inject(LogisticaService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(MessageService);
  private readonly confirmar = inject(ConfirmationService);

  readonly tabs = [...COSTO_UNIDAD_TABS];
  readonly grupos = GRUPOS;
  readonly presets: Array<{ value: Preset; label: string }> = [
    { value: 'mes', label: 'Este mes' }, { value: 'mes_anterior', label: 'Mes anterior' }, { value: 'anio', label: 'En lo que va del año' },
    { value: 'doce', label: 'Últimos 12 meses' }, { value: 'otro', label: 'Otras fechas' },
  ];
  readonly cortes: Array<{ value: CorteVista; label: string }> = [
    { value: 'periodo', label: 'Total del periodo' },
    ...CORTES_COSTO_UNIDAD.map((c) => ({ value: c.codigo as CorteVista, label: `Expresado ${c.etiqueta.toLowerCase()}` })),
  ];
  readonly areas = (Object.keys(AREA_FLOTA_LABEL) as AreaFlota[]).map((v) => ({ value: v, label: AREA_FLOTA_LABEL[v] }));
  readonly propiedades: Array<{ value: Propiedad; label: string }> = [{ value: 'propia', label: 'Propia' }, { value: 'arrendada', label: 'Arrendada' }];
  /** Gestionar: la clave exacta, o rol de plataforma (lo mismo que decide el backend). */
  get puedeGestionar(): boolean { return this.perms.has(Permission.LOGISTICS_COSTO_UNIDAD_GESTIONAR); }

  readonly preset = signal<Preset>('mes');
  readonly desde = signal(rangoDe('mes', new Date()).desde);
  readonly hasta = signal(rangoDe('mes', new Date()).hasta);
  readonly desdeFecha = computed(() => deIso(this.desde()));
  readonly hastaFecha = computed(() => deIso(this.hasta()));
  readonly corte = signal<CorteVista>('periodo');

  readonly data = signal<ResumenCostoUnidad | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);

  readonly selId = signal<string | null>(null);
  readonly detalle = signal<DetalleUnidadCosto | null>(null);
  readonly cargandoDetalle = signal(false);
  readonly errorDetalle = signal<string | null>(null);
  readonly ficha = signal<CambiosFicha>({});
  private readonly cambios = signal<CambiosFicha>({});
  readonly sucio = computed(() => Object.keys(this.cambios()).length > 0);
  readonly guardando = signal(false);
  readonly lecturaFecha = signal<Date | null>(new Date());
  readonly lecturaKm = signal<number | null>(null);

  readonly corteLabel = computed(() => {
    const c = this.corte();
    return c === 'periodo' ? 'del periodo' : (CORTES_COSTO_UNIDAD.find((x) => x.codigo === c)?.etiqueta ?? '').toLowerCase();
  });

  readonly filas = computed(() => {
    const d = this.data();
    if (!d) return [];
    const c = this.corte();
    return d.unidades.map((u) => {
      const presCorte = enCorte(u.presupuesto, d.periodo.dias, c);
      const realCorte = enCorte(u.real, d.periodo.dias, c) ?? 0;
      return { ...u, presCorte, realCorte, difCorte: presCorte == null ? null : Math.round((realCorte - presCorte) * 100) / 100 };
    });
  });
  readonly seleccion = computed(() => this.filas().find((f) => f.vehicle_id === this.selId()) ?? null);
  readonly seleccionada = computed<UnidadCosto | null>(() => this.data()?.unidades.find((u) => u.vehicle_id === this.selId()) ?? null);
  readonly subtitulo = computed(() => {
    const u = this.detalle()?.unidad ?? this.seleccionada();
    return u ? `${u.economic_number ?? 'Sin número'} · ${u.plate}` : null;
  });

  readonly totalKm = computed(() => this.filas().reduce((a, u) => a + (u.km.km ?? 0), 0));
  readonly totalGuias = computed(() => this.filas().reduce((a, u) => a + u.guias, 0));
  readonly totalPresCorte = computed(() => Math.round(this.filas().reduce((a, u) => a + (u.presCorte ?? 0), 0) * 100) / 100);
  readonly totalRealCorte = computed(() => Math.round(this.filas().reduce((a, u) => a + u.realCorte, 0) * 100) / 100);
  readonly porConfirmar = computed(() => {
    const p = this.data()?.pendientes;
    if (!p) return null;
    return { renglones: p.sugerido.renglones + p.ambiguo.renglones + p.sin_unidad.renglones,
      importe: Math.round((p.sugerido.importe + p.ambiguo.importe + p.sin_unidad.importe) * 100) / 100 };
  });

  readonly titular = computed(() => {
    const d = this.data();
    if (!d) return '';
    const n = d.unidades.length;
    const real = d.unidades.reduce((a, u) => a + u.real, 0);
    const conPres = d.unidades.filter((u) => u.presupuesto != null);
    const pres = conPres.reduce((a, u) => a + Number(u.presupuesto), 0);
    const sinDato = d.unidades.reduce((a, u) => a + u.rubros_sin_dato, 0);
    const $ = (x: number) => `$${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const base = `Del ${this.fechaCorta(d.periodo.desde)} al ${this.fechaCorta(d.periodo.hasta)} (${d.periodo.dias} días), ${n} unidad${n === 1 ? '' : 'es'} costaron ${$(real)}`;
    const contra = pres > 0 ? ` contra ${$(pres)} presupuestados (${Math.round((real / pres) * 100)} %).` : '; no hay presupuesto para el periodo.';
    const restringido = d.unidades.some((u) => u.rubros.some((r) => r.procedencia === 'restringido'));
    return base + contra + (sinDato ? ` Faltan datos en ${sinDato} rubro${sinDato === 1 ? '' : 's'}: el real los excluye.` : '')
      + (restringido ? ' No incluye salarios ni nómina administrativa: sólo los ve quien gestiona.' : '');
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.data();
    if (!d) return [];
    const real = d.unidades.reduce((a, u) => a + u.real, 0);
    const pres = d.unidades.reduce((a, u) => a + (u.presupuesto ?? 0), 0);
    const conKm = d.unidades.filter((u) => u.km.km != null);
    const km = conKm.reduce((a, u) => a + Number(u.km.km), 0);
    const realConKm = conKm.reduce((a, u) => a + u.real, 0);
    const pc = this.porConfirmar();
    return [
      { label: 'Real del periodo', value: real, format: 'currency', sub: 'Kepler, GPS, guías y capturas' },
      { label: 'Presupuesto del periodo', value: pres, format: 'currency', sub: `la hoja, a ${d.periodo.dias} días` },
      { label: 'Diferencia', value: Math.round((real - pres) * 100) / 100, format: 'currency', tone: real > pres ? 'bad' : 'ok', sub: 'real − presupuesto' },
      { label: '$/km de la flota', value: km > 0 ? Math.round((realConKm / km) * 100) / 100 : 'sin km', format: km > 0 ? 'currency2' : 'text',
        state: conKm.length < d.unidades.length ? 'parcial' : 'medido',
        sub: `${conKm.length} de ${d.unidades.length} unidades con km` },
      { label: 'Gastos por confirmar', value: pc?.renglones ?? 0, format: 'number', tone: pc?.renglones ? 'warn' : 'ok', sub: pc ? `$${pc.importe.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '' },
    ];
  });

  constructor() {
    this.cargar();
  }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.api.costoUnidadResumen(this.desde(), this.hasta()).subscribe({
      next: (d) => { this.data.set(d); this.cargando.set(false); },
      error: (e) => { this.cargando.set(false); this.error.set(e?.error?.message ?? 'No se pudo leer el costo de las unidades.'); },
    });
  }

  elegirPreset(p: Preset): void {
    this.preset.set(p);
    if (p === 'otro') return;
    const r = rangoDe(p, new Date());
    this.desde.set(r.desde);
    this.hasta.set(r.hasta);
    this.recargar();
  }

  cambiarFecha(cual: 'desde' | 'hasta', d: Date | null): void {
    if (!d) return;
    (cual === 'desde' ? this.desde : this.hasta).set(aIso(d));
    this.preset.set('otro');
    if (this.desde() <= this.hasta()) this.recargar();
  }

  private recargar(): void {
    this.data.set(null);
    this.cargar();
    if (this.selId()) this.cargarDetalle();
  }

  /** PrimeNG tipa la fila elegida como fila, lista o nada; en selección simple llega una. */
  alSeleccionar(d: UnidadCosto | UnidadCosto[] | undefined): void {
    if (d && !Array.isArray(d)) this.abrir(d);
  }

  abrir(u: UnidadCosto): void {
    if (this.sucio() && this.selId() !== u.vehicle_id) {
      this.confirmar.confirm({
        header: 'Cambios sin guardar', message: 'La ficha tiene cambios sin guardar. ¿Descartarlos y abrir otra unidad?',
        acceptLabel: 'Descartar', rejectLabel: 'Seguir editando', accept: () => { this.cambios.set({}); this.abrir(u); },
      });
      return;
    }
    this.selId.set(u.vehicle_id);
    this.cargarDetalle();
  }

  cerrar(): void {
    if (this.sucio()) {
      this.confirmar.confirm({
        header: 'Cambios sin guardar', message: 'La ficha tiene cambios sin guardar. ¿Descartarlos?',
        acceptLabel: 'Descartar', rejectLabel: 'Seguir editando', accept: () => { this.cambios.set({}); this.cerrar(); },
      });
      return;
    }
    this.selId.set(null);
    this.detalle.set(null);
  }

  cargarDetalle(): void {
    const id = this.selId();
    if (!id) return;
    this.cargandoDetalle.set(true);
    this.errorDetalle.set(null);
    this.api.costoUnidadDetalle(id, this.desde(), this.hasta()).subscribe({
      next: (d) => {
        if (this.selId() !== id) return;
        this.detalle.set(d);
        this.ficha.set(this.fichaEditable(d.ficha));
        this.cambios.set({});
        this.cargandoDetalle.set(false);
      },
      error: (e) => { this.cargandoDetalle.set(false); this.errorDetalle.set(e?.error?.message ?? 'No se pudo leer la unidad.'); },
    });
  }

  private fichaEditable(f: FichaUnidad): CambiosFicha {
    return {
      economic_number: f.economic_number, display_name: f.display_name, vin: f.vin, year: f.year, fleet_area: f.fleet_area,
      ownership: f.ownership, purchase_value: f.purchase_value, purchase_date: f.purchase_date, useful_life_years: f.useful_life_years,
      residual_value: f.residual_value, insurance_carrier: f.insurance_carrier, insurance_policy: f.insurance_policy,
      insurance_premium: f.insurance_premium, insurance_expires_on: f.insurance_expires_on,
      ...(f.salario_visible ? { driver_monthly_salary: f.driver_monthly_salary } : {}),
      budget_km_year: f.budget_km_year, kepler_aliases: [...f.kepler_aliases],
    };
  }

  editar<K extends keyof CambiosFicha>(k: K, v: CambiosFicha[K]): void {
    this.ficha.update((f) => ({ ...f, [k]: v }));
    this.cambios.update((c) => ({ ...c, [k]: v }));
  }
  editarFecha(k: 'insurance_expires_on' | 'purchase_date', d: Date | null): void { this.editar(k, d ? aIso(d) : null); }
  readonly aliasTexto = computed(() => (this.ficha().kepler_aliases ?? []).join('\n'));
  editarAlias(t: string): void { this.editar('kepler_aliases', String(t ?? '').split('\n').map((x) => x.trim()).filter(Boolean)); }
  fechaDe(s: string | null | undefined): Date | null { return s ? deIso(s) : null; }

  guardarFicha(): void {
    const id = this.selId();
    if (!id || !this.sucio() || this.guardando()) return;
    this.guardando.set(true);
    this.api.costoUnidadGuardarFicha(id, this.cambios()).subscribe({
      next: () => {
        this.guardando.set(false);
        this.cambios.set({});
        this.toast.add({ severity: 'success', summary: 'Ficha guardada', life: 2500 });
        this.recargar();
      },
      error: (e) => { this.guardando.set(false); this.toast.add({ severity: 'error', summary: 'No se guardó la ficha', detail: e?.error?.message ?? '' }); },
    });
  }

  registrarLectura(): void {
    const id = this.selId();
    const f = this.lecturaFecha();
    const km = this.lecturaKm();
    if (!id || !f || km == null || this.guardando()) return;
    this.guardando.set(true);
    this.api.costoUnidadRegistrarLectura(id, { read_on: aIso(f), odometer_km: Math.round(km) }).subscribe({
      next: () => { this.guardando.set(false); this.lecturaKm.set(null); this.recargar(); },
      error: (e) => { this.guardando.set(false); this.toast.add({ severity: 'error', summary: 'No se registró la lectura', detail: e?.error?.message ?? '' }); },
    });
  }

  borrarLectura(lecturaId: string): void {
    const id = this.selId();
    if (!id || this.guardando()) return;
    this.confirmar.confirm({
      header: 'Quitar lectura', message: '¿Quitar esta lectura de odómetro?', acceptLabel: 'Quitar', rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.guardando.set(true);
        this.api.costoUnidadBorrarLectura(id, lecturaId).subscribe({
          next: () => { this.guardando.set(false); this.recargar(); },
          error: (e) => { this.guardando.set(false); this.toast.add({ severity: 'error', summary: 'No se quitó la lectura', detail: e?.error?.message ?? '' }); },
        });
      },
    });
  }

  rubrosDe(rs: RenglonRubro[], g: GrupoRubro): RenglonRubro[] { return rs.filter((r) => r.grupo === g); }
  grupoLabel(g: GrupoRubro): string { return GRUPO_RUBRO_LABEL[g]; }
  procedencia(p: Procedencia): string { return PROCEDENCIA_LABEL[p]; }
  sevProcedencia(p: Procedencia) { return PROCEDENCIA_SEV[p]; }
  estadoLinea(e: keyof typeof ESTADO_LINEA_FLOTA_LABEL): string { return ESTADO_LINEA_FLOTA_LABEL[e]; }
  area(a: AreaFlota): string { return AREA_FLOTA_LABEL[a]; }
  sev(a: AvisoUnidad): 'danger' | 'warn' | 'secondary' { return a.severidad === 'alta' ? 'danger' : a.severidad === 'media' ? 'warn' : 'secondary'; }
  fechaCorta(iso: string): string {
    const M = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    return `${Number(iso.slice(8, 10))} ${M[Number(iso.slice(5, 7)) - 1]}`;
  }
}
