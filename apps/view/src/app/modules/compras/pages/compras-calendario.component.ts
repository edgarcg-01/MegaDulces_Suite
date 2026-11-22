import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { DatePickerModule } from 'primeng/datepicker';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TextareaModule } from 'primeng/textarea';
import {
  ETIQUETA_MOTIVO_NO_SE_PIDE, MARCA_MAX_ADELANTE_DIAS, MOTIVOS_NO_SE_PIDE, ordenDelEmbudo, proximasRevisiones, sumarDias, validarFueraDeCiclo,
  validarMarca, validarRegla, warehouseName,
  type AlcanceRevision, type AvanceDelEmbudo, type CalendarioCompras, type EscalonLlenado, type CorrimientoFinDeSemana, type FueraDeCicloDto, type GuardarReglaDto,
  type MarcarRevisionDto, type MotivoNoSePide, type PatronDeRegla, type PatronRevision, type PropuestaDiaFijo, type PropuestaSinRegla,
  type PropuestasCalendario, type ReglaCalendario, type ResultadoRevision, patronDelDiaFijo,
} from '@megadulces/contracts';
import { coincideBusqueda } from '@megadulces/ui-web';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { motivoHttp } from '../../almacen/shared/http-motivo';
import { CalendarioComprasService } from '../calendario-compras.service';
import {
  alcanceEnPalabras, atencionEnPalabras, avanceEscalonEnPalabras, avanceTotalEnPalabras, corrimientoEnPalabras, NOMBRE_ESCALON, pesoEnPalabras, diaCorto, diaFijoEnPalabras, diaFijoEvidencia, diaFijoReciente,
  estadoEnPalabras, fechasEnRango, fichaEnPalabras, paraQuienVe, patronEnPalabras, propuestaEnPalabras, proximasDeLaRegla, relativo, type EstadoVisible, type FechaEnCalendario,
} from '../calendario-compras-reglas';

type Vista = 'revisar' | 'semana' | 'mes' | 'reglas' | 'sin_regla';
const VISTAS: readonly Vista[] = ['revisar', 'semana', 'mes', 'reglas', 'sin_regla'];
const DIAS_SEMANA = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const DIAS_SEMANA_LARGO = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
/** Más renglones que esto, en táctil, se paginan (diseño M.8). */
const POR_PAGINA = 50;

/** El proveedor del formulario de regla: su clave de Kepler y desde dónde contar «cada N días». */
interface ProveedorDelFormulario {
  readonly code: string;
  readonly name: string | null;
  /** Última actividad (regla existente) o última OC (propuesta). */
  readonly ancla: string | null;
}

/**
 * `[PQ.3.5]` Compras › Calendario de compras. Plan: FASE_PQ_ANEXO_CALENDARIO_COMPRAS §10.6 (las preguntas
 * de diseño, escritas antes de esta plantilla).
 *
 * Una pregunta: ¿a qué proveedor le debo la revisión hoy, y dónde? El estado lo calcula la API con Kepler
 * (OC, también canceladas, y entradas) y las marcas de la Suite; esta pantalla no recalcula el estado: lo
 * DICE. «Semana» y «Mes» usan el MISMO cálculo de fechas que la API (`fechasDeLaRegla` del contrato).
 *
 * ⛔ Veracidad: lo que no se mide se declara (el proveedor sin regla no es «al día»; sin fecha base no se
 * inventa una). «Abrir en Pedido» sólo se ofrece cuando la clave de Kepler tiene productos en Pedido (R5).
 */
@Component({
  selector: 'app-compras-calendario',
  standalone: true,
  imports: [
    FormsModule, RouterLink, ButtonModule, TableModule, TagModule, DialogModule, DatePickerModule, InputNumberModule, InputTextModule,
    SelectModule, TextareaModule, LoadStateComponent, MetricStripComponent, FreshnessPillComponent, SegmentedComponent, SidePeekComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page cc-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Calendario de compras</h1>
          <p class="surf-page-sub">
            <span>A qué proveedor le toca la revisión y dónde, con lo que dice Kepler.</span>
          </p>
        </div>
        <div class="cc-head-acc">
          <app-freshness-pill measures="fetch" [since]="cargadoEn()" />
        </div>
      </header>

      @if (errorAccion()) { <p class="cc-error cc-error-fuera" role="alert">{{ errorAccion() }}</p> }
      @if (aviso()) { <p class="cc-aviso" role="status">{{ aviso() }}</p> }

      <!-- Respuesta y cifras SOLO con el calendario leído: cargando o con error no se dibuja un cero. -->
      @if (cal() && !error()) {
        <p class="cc-respuesta" role="status">{{ respuesta() }}</p>
        <!-- [PQ.3.6] Sin sucursal en su ficha, la respuesta lo dice todo: ni la línea de alcance, ni cinco ceros, ni vistas
             que no le sirven (la prueba visual lo encontró dicho tres veces). -->
        @if (!sinSucursal()) {
          @if (alcanceTexto(); as t) { <p class="cc-alcance">{{ t }}</p> }
          <app-metric-strip [items]="kpis()" density="compact" ariaLabel="Revisiones por estado" (drill)="irAVista($event)" />
        }
      }

      @if (!sinSucursal()) {
      <div class="cc-barra">
        <app-segmented [options]="opcionesVista()" [value]="vista()" (valueChange)="irAVista($event)" ariaLabel="Qué ver" />
        <input pInputText type="search" class="cc-buscar" [value]="busqueda()" (input)="busqueda.set($any($event.target).value)"
               placeholder="Proveedor, clave o sucursal" aria-label="Buscar por proveedor, clave o sucursal" autocomplete="off" enterkeyhint="search" />
      </div>

      @if (vista() !== 'sin_regla') {
        <app-load-state class="dt-scope" [loading]="cargando()" [error]="error()" [isEmpty]="vacio()" [skeletonRows]="8"
                        emptyIcon="pi-calendar" [emptyTitle]="vacioTitulo()" [emptyHint]="vacioPista()" (retry)="cargar()">
          @if (vista() === 'revisar' || vista() === 'reglas') {
            <p-table [value]="$any(vista() === 'revisar' ? porRevisar() : reglas())" dataKey="id"
                     class="cc-table dt-stack surf-table surf-table--plain surf-table--sticky" size="small" [rowHover]="true"
                     [paginator]="(vista() === 'revisar' ? porRevisar() : reglas()).length > porPagina" [rows]="porPagina"
                     [tableStyle]="{ 'min-width': '40rem' }">
              <ng-template #header>
                <tr>
                  <th>Proveedor</th>
                  <th>Dónde</th>
                  <th>Cuándo toca</th>
                  <th>Estado</th>
                  <th>Última atención</th>
                  <th><span class="cc-sr">Acciones</span></th>
                </tr>
              </ng-template>
              <ng-template #body let-r>
                <tr>
                  <td role="cell" data-label="Proveedor">
                    <button type="button" class="cc-link" (click)="abrir(r.id)" [attr.aria-label]="'Ver el detalle de ' + nombre(r) + ' en ' + r.alcance_nombre">
                      {{ nombre(r) }}
                    </button>
                    <span class="cc-sub">clave {{ r.supplier_code }}</span>
                  </td>
                  <td role="cell" data-label="Dónde">
                    <span class="cc-pri">{{ r.alcance_nombre }}</span>
                    <span class="cc-sub">Revisa: {{ r.revisa }}</span>
                  </td>
                  <td role="cell" data-label="Cuándo toca">
                    {{ patron(r) }}
                    @if (corrimiento(r); as c) { <span class="cc-sub">{{ c }}</span> }
                  </td>
                  <td role="cell" data-label="Estado">
                    @if (estado(r); as e) {
                      <p-tag [value]="e.etiqueta" [severity]="e.severidad" />
                      @if (e.detalle) { <span class="cc-sub">{{ e.detalle }}</span> }
                    }
                  </td>
                  <td role="cell" data-label="Última atención">
                    @if (atencion(r); as a) {
                      <span [class.cc-falta]="!a.cuando">{{ a.que }}</span>
                      @if (a.cuando) { <span class="cc-sub">{{ a.cuando }}</span> }
                    }
                  </td>
                  <td role="cell" data-label="Acciones">
                    <div class="cc-acc">
                      @if (puedeMarcar() && r.estado.estado !== 'fuera_de_ciclo') {
                        <button pButton type="button" class="p-button-sm p-button-outlined p-button-secondary" (click)="abrirMarcar(r, null)"
                                [attr.aria-label]="'Marcar la revisión de ' + nombre(r) + ' en ' + r.alcance_nombre">
                          <span class="p-button-label">Marcar</span>
                        </button>
                      }
                      <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="abrir(r.id)"
                              [attr.aria-label]="'Más de ' + nombre(r) + ' en ' + r.alcance_nombre">
                        <span class="p-button-label">Detalle</span>
                      </button>
                    </div>
                  </td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="6" class="cc-nota">Nada coincide con «{{ busqueda() }}».</td></tr>
              </ng-template>
            </p-table>
          } @else {
            <p class="cc-nota">
              {{ vista() === 'semana' ? 'Los próximos 7 días' : 'Los próximos 31 días' }}, desde hoy {{ dia(cal()?.hoy) }}.
              Lo que ya se debe está en «Por revisar»; una regla fuera de ciclo vuelve a salir al día siguiente de su fecha.
            </p>
            <p-table [value]="$any(fechas())" class="cc-table dt-stack surf-table surf-table--plain surf-table--sticky" size="small"
                     [rowHover]="true" [paginator]="fechas().length > porPagina" [rows]="porPagina" [tableStyle]="{ 'min-width': '40rem' }">
              <ng-template #header>
                <tr>
                  <th>Fecha</th>
                  <th>Proveedor</th>
                  <th>Dónde</th>
                  <th>Cuándo toca</th>
                  <th>Hoy</th>
                  <th><span class="cc-sr">Acciones</span></th>
                </tr>
              </ng-template>
              <ng-template #body let-f>
                <tr [class.cc-dia-nuevo]="esPrimeraDelDia(f)">
                  <td role="cell" data-label="Fecha">
                    <span class="cc-pri">{{ dia(f.fecha) }}</span>
                    <span class="cc-sub">
                      {{ rel(f.fecha) }}@if (f.corrida_de) { · era el {{ dia(f.corrida_de) }} }@if (f.pospuesta) { · nueva fecha de una «hoy no se pide» }
                    </span>
                  </td>
                  <td role="cell" data-label="Proveedor">
                    <button type="button" class="cc-link" (click)="abrir(f.regla.id)" [attr.aria-label]="'Ver el detalle de ' + nombre(f.regla) + ' en ' + f.regla.alcance_nombre">
                      {{ nombre(f.regla) }}
                    </button>
                    <span class="cc-sub">clave {{ f.regla.supplier_code }}</span>
                  </td>
                  <td role="cell" data-label="Dónde">{{ f.regla.alcance_nombre }}</td>
                  <td role="cell" data-label="Cuándo toca">{{ patron(f.regla) }}</td>
                  <td role="cell" data-label="Hoy">
                    @if (estado(f.regla); as e) { <p-tag [value]="e.etiqueta" [severity]="e.severidad" /> }
                  </td>
                  <td role="cell" data-label="Acciones">
                    <div class="cc-acc">
                    @if (puedeMarcar() && sePuedeMarcar(f.fecha)) {
                      <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="abrirMarcar(f.regla, f.fecha)"
                              [attr.aria-label]="'Marcar la revisión del ' + dia(f.fecha) + ' de ' + nombre(f.regla)">
                        <span class="p-button-label">Marcar</span>
                      </button>
                    }
                    </div>
                  </td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="6" class="cc-nota">
                  {{ busqueda() ? 'Nada coincide con «' + busqueda() + '».' : 'Ninguna regla toca en estos días.' }}
                </td></tr>
              </ng-template>
            </p-table>
          }
          <!-- Terciario: de dónde sale «atendido» (lo dice la API), al pie y no en el encabezado: en celular empujaba la lista fuera de la pantalla. -->
          @if (cal()?.fuente; as fu) { <p class="cc-nota cc-fuente">{{ fu }}</p> }
        </app-load-state>
      } @else {
        <!-- ===== Sin regla: lo que propone Kepler (vista PQ.3.1) ===== -->
        <app-load-state class="dt-scope" [loading]="cargandoProp()" [error]="errorProp()" [isEmpty]="!!prop() && !prop()!.sin_regla.length && !prop()!.dia_fijo_pendiente.length"
                        [skeletonRows]="8" emptyIcon="pi-check-circle" emptyTitle="Todos los proveedores con compra tienen regla"
                        emptyHint="Un proveedor nuevo aparece aquí con su primera orden de compra en Kepler." (retry)="cargarPropuestas()">
          <!-- [PQ.3.18] El embudo de llenado (anexo C §10.10): primero cuánto se lleva, luego por dónde seguir. Cada escalón
               es un botón que filtra la lista a ése (aria-pressed); el avance va en texto, no sólo en color. -->
          @if (prop(); as p) {
            <section class="cc-embudo" aria-label="Llenado del calendario">
              <p class="cc-embudo-total">{{ avanceTotal(p.embudo.total) }}</p>
              @if (p.embudo.measured) {
                <ul class="cc-embudo-escalones">
                  @for (e of p.embudo.escalones; track e.escalon) {
                    <li>
                      <button type="button" class="cc-escalon" [class.is-on]="escalonFiltro() === e.escalon"
                              [attr.aria-pressed]="escalonFiltro() === e.escalon" (click)="filtrarEscalon(e.escalon)">{{ nombreEscalon(e.escalon) }}</button>
                      <span class="cc-sub">{{ avanceEscalon(e) }}</span>
                    </li>
                  }
                </ul>
              } @else {
                <p class="cc-advertencia" role="status">{{ p.embudo.note }}</p>
              }
            </section>
          }
          <p class="cc-nota">
            Proveedores con orden de compra en Kepler en los últimos 12 meses y sin regla, primero los que más pesan: por escalón
            y luego por su parte de la compra de 12 meses. «Kepler propone» es la mediana entre sus rondas de órdenes: es una
            propuesta, no un ciclo confirmado.
          </p>
          <!-- [PQ.3.14] El día fijo por sucursal: de dónde sale, y si no se pudo medir, se DICE (no es «no hay»). -->
          @if (prop(); as p) {
            @if (!p.dia_fijo.measured) {
              <p class="cc-advertencia" role="status">{{ p.dia_fijo.note }} Las propuestas por ciclo sí están.</p>
            } @else if (diasFijosTotal(); as n) {
              <p class="cc-nota">
                {{ n }} {{ n === 1 ? 'sucursal tiene' : 'sucursales tienen' }} día fijo: el proveedor pasa, se le pide y entrega el mismo
                día de la semana (órdenes y entradas de Kepler de 12 meses; el CEDIS no, ahí es día de recepción). Su regla ya viene armada:
                ábrela desde su renglón.
              </p>
            }
          }
          <!-- [PQ.3.18] El filtro por escalón se dice pegado a la lista que filtra (la prueba visual lo encontró entre dos notas). -->
          @if (escalonFiltro(); as e) {
            <p class="cc-nota" role="status">Viendo sólo el {{ nombreEscalon(e) }}.
              <button type="button" class="cc-link" (click)="filtrarEscalon(null)">Ver todos</button>
            </p>
          }
          <p-table [value]="$any(sinRegla())" dataKey="supplier_code" class="cc-table dt-stack surf-table surf-table--plain surf-table--sticky"
                   size="small" [rowHover]="true" [paginator]="sinRegla().length > porPagina" [rows]="porPagina" [tableStyle]="{ 'min-width': '40rem' }">
            <ng-template #header>
              <tr>
                <th>Proveedor</th>
                <th>Peso en la compra</th>
                <th>Kepler propone</th>
                <th>Última orden</th>
                <th>Sucursales</th>
                <th><span class="cc-sr">Acciones</span></th>
              </tr>
            </ng-template>
            <ng-template #body let-p>
              <tr>
                <!-- [PQ.3.14] Las celdas de varias líneas van en UN hijo (.cc-celda): en el celular la tabla apilada hace
                     flex la celda, y sin él el ciclo, cada sucursal y su evidencia salían como columnas de una palabra. -->
                <td role="cell" data-label="Proveedor">
                  <div class="cc-celda">
                    <span class="cc-pri">{{ p.supplier_name ?? 'Proveedor ' + p.supplier_code }}</span>
                    <span class="cc-sub">clave {{ p.supplier_code }}@if (ficha(p); as fi) { · {{ fi }} }</span>
                    @if (p.reglas_vivas) {
                      <span class="cc-sub">ya tiene {{ p.reglas_vivas }} {{ p.reglas_vivas === 1 ? 'regla' : 'reglas' }}; falta la de su sucursal con día fijo</span>
                    }
                  </div>
                </td>
                <!-- [PQ.3.18] Lo que pesa: su parte de la compra de 12 meses; debajo sus OC, rondas (antes su propia columna) y escalón. -->
                <td role="cell" data-label="Peso en la compra">
                  <div class="cc-celda">
                    <span class="cc-pri">{{ peso(p).principal }}</span>
                    <span class="cc-sub">{{ peso(p).detalle }}</span>
                  </div>
                </td>
                <td role="cell" data-label="Kepler propone">
                  <div class="cc-celda">
                    {{ propuesta(p) }}
                    @for (d of p.dias_fijos; track d.branch_code) {
                      <button type="button" class="cc-link cc-diafijo" (click)="abrirReglaDeDiaFijo(p, d)"
                              [attr.aria-label]="'Definir la regla de ' + sucursales([d.branch_code]) + ': ' + diaFijo(d)">
                        {{ sucursales([d.branch_code]) }}: {{ diaFijo(d) }}
                      </button>
                      <span class="cc-sub">{{ diaFijoReciente(d) }}</span>
                    }
                  </div>
                </td>
                <td role="cell" data-label="Última orden">
                  {{ dia(p.last_order_date) }}
                  <span class="cc-sub">{{ rel(p.last_order_date) }}</span>
                </td>
                <td role="cell" data-label="Sucursales">{{ sucursales(p.branches_12m) }}</td>
                <td role="cell" data-label="Acciones">
                  <div class="cc-acc">
                  @if (puedeCiclo()) {
                    <button pButton type="button" class="p-button-sm p-button-outlined p-button-secondary" (click)="abrirReglaDePropuesta(p)"
                            [attr.aria-label]="'Definir la regla de ' + (p.supplier_name ?? p.supplier_code)">
                      <span class="p-button-label">Definir regla</span>
                    </button>
                  }
                  </div>
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="6" class="cc-nota">
                @if (busqueda()) { Nada coincide con «{{ busqueda() }}». } @else { No quedan proveedores sin regla en el {{ nombreEscalon(escalonFiltro()) }}. }
              </td></tr>
            </ng-template>
          </p-table>
        </app-load-state>
      }
      }

      <!-- ===== Detalle de una regla (side-peek) ===== -->
      <app-side-peek [open]="!!abierta()" (openChange)="!$event && cerrar()" [title]="abierta() ? nombre(abierta()!) : ''"
                     [subtitle]="abierta() ? abierta()!.alcance_nombre + ' · clave ' + abierta()!.supplier_code : null">
        @if (abierta(); as r) {
          <div class="cc-peek">
            <section>
              <h3>Hoy</h3>
              @if (estado(r); as e) {
                <p-tag [value]="e.etiqueta" [severity]="e.severidad" />
                @if (e.detalle) { <p class="cc-sub">{{ e.detalle }}</p> }
              }
            </section>
            <section>
              <h3>Cuándo toca</h3>
              <p class="cc-pri">{{ patron(r) }}</p>
              @if (corrimiento(r); as c) { <p class="cc-sub">{{ c }}</p> }
              @if (proximas(r).length) {
                <p class="cc-sub">Las siguientes: {{ proximasTexto(r) }}</p>
              }
              <p class="cc-sub">Revisa: {{ r.revisa }}</p>
            </section>
            <section>
              <h3>Última atención</h3>
              @if (atencion(r); as a) { <p>{{ a.que }}{{ a.cuando ? ', ' + a.cuando : '' }}</p> }
              @if (r.ultima_marca; as m) {
                <p class="cc-sub">
                  Última marca: {{ m.outcome === 'skipped' ? 'hoy no se pide' : 'se pidió fuera de Kepler' }} del {{ dia(m.review_date) }}
                  @if (m.skip_reason) { ({{ motivo(m.skip_reason) }}) }
                  @if (m.postponed_to) { · nueva fecha {{ dia(m.postponed_to) }} }
                  · {{ m.marcada_por ?? 'sin nombre' }}
                </p>
                @if (m.note) { <p class="cc-sub">«{{ m.note }}»</p> }
              }
            </section>
            <section>
              <h3>La regla</h3>
              <p class="cc-sub">Definida por {{ r.definida_por ?? 'alguien sin nombre registrado' }} el {{ dia(r.definida_el) }}.</p>
              @if (r.note) { <p class="cc-sub">Nota: {{ r.note }}</p> }
            </section>

            <div class="cc-acc cc-peek-acc">
              @if (puedeMarcar() && r.estado.estado !== 'fuera_de_ciclo') {
                <button pButton type="button" class="p-button-sm" (click)="abrirMarcar(r, null)"><span class="p-button-label">Marcar la revisión</span></button>
              }
              @if (puedePedido()) {
                @if (r.pedido_supplier_id) {
                  <a pButton class="p-button-sm p-button-outlined p-button-secondary" [routerLink]="['/compras/pedido']"
                     [queryParams]="{ supplier_id: r.pedido_supplier_id, warehouse_ids: r.pedido_warehouse_ids.length ? r.pedido_warehouse_ids.join(',') : null }">
                    <span class="p-button-label">Abrir en Pedido</span>
                  </a>
                } @else {
                  <p class="cc-sub">Esta clave de Kepler no tiene productos en Pedido. Si el proveedor tiene otra ficha en la Suite, búscalo en Pedido por nombre.</p>
                }
              }
            </div>
            @if (puedeCiclo()) {
              <div class="cc-acc cc-peek-acc">
                <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="abrirReglaDe(r, true)">
                  <span class="p-button-label">Corregir la regla</span>
                </button>
                <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="abrirReglaDe(r, false)">
                  <span class="p-button-label">Otra regla para este proveedor</span>
                </button>
                <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="abrirFuera(r)">
                  <span class="p-button-label">{{ r.estado.estado === 'fuera_de_ciclo' ? 'Regresar al ciclo' : 'Sacar del ciclo' }}</span>
                </button>
              </div>
              <div class="cc-acc cc-peek-acc cc-peek-baja">
                <button pButton type="button" class="p-button-sm p-button-text cc-btn-bad" (click)="abrirBaja(r)">
                  <span class="p-button-label">Dar de baja la regla</span>
                </button>
              </div>
            }
          </div>
        }
      </app-side-peek>

      <!-- ===== Definir o corregir una regla ===== -->
      <p-dialog [visible]="dlgRegla()" (visibleChange)="dlgRegla.set($event)" [modal]="true" [draggable]="false"
                [header]="tituloRegla()" [style]="{ width: '38rem' }" appendTo="body">
        <div class="cc-form">
          <p class="cc-pri">{{ rProv?.name ?? 'Proveedor ' + rProv?.code }} <span class="cc-sub cc-inline">clave {{ rProv?.code }}</span></p>
          @if (rEvidencia) { <p class="cc-sub">{{ rEvidencia }}</p> }

          <span class="cc-label">¿Dónde se revisa?</span>
          <app-segmented [options]="opcionesAlcance" [value]="rScope" (valueChange)="cambiarAlcance($event)" ariaLabel="Dónde se revisa" />
          @if (rScope === 'zone') {
            <label class="cc-label" for="cc-zona">Zona</label>
            <p-select [options]="opcionesZona()" [(ngModel)]="rZona" inputId="cc-zona" placeholder="Elige la zona" appendTo="body" />
          } @else if (rScope === 'branch') {
            <label class="cc-label" for="cc-suc">Sucursal</label>
            <p-select [options]="opcionesSucursal()" [(ngModel)]="rSucursal" inputId="cc-suc" placeholder="Elige la sucursal" appendTo="body" />
          }
          <p class="cc-sub">Revisa: {{ revisaDelFormulario() }}</p>

          <span class="cc-label">¿Cuándo toca?</span>
          <app-segmented [options]="opcionesPatron" [value]="rPatron" (valueChange)="cambiarPatron($event)" ariaLabel="Cuándo toca" />
          @if (rPatron === 'weekdays') {
            <div class="cc-dias" role="group" aria-label="Días de la semana">
              @for (d of diasSemana; track $index) {
                <button type="button" class="cc-dia" [class.is-on]="rSemana[$index]" [attr.aria-pressed]="rSemana[$index]"
                        [attr.aria-label]="diasSemanaLargo[$index]" (click)="rSemana[$index] = !rSemana[$index]">{{ d }}</button>
              }
            </div>
          } @else if (rPatron === 'month_days') {
            <div class="cc-mes" role="group" aria-label="Días del mes">
              @for (d of diasMes; track d) {
                <button type="button" class="cc-dia" [class.is-on]="rMes[d - 1]" [attr.aria-pressed]="rMes[d - 1]"
                        [attr.aria-label]="'Día ' + d" (click)="rMes[d - 1] = !rMes[d - 1]">{{ d }}</button>
              }
              <button type="button" class="cc-dia cc-dia-ultimo" [class.is-on]="rUltimo" [attr.aria-pressed]="rUltimo"
                      (click)="rUltimo = !rUltimo">El último</button>
            </div>
            <span class="cc-label">Si cae en sábado o domingo</span>
            <app-segmented [options]="opcionesCorrimiento" [value]="rCorre" (valueChange)="cambiarCorrimiento($event)" ariaLabel="Si cae en fin de semana" />
          } @else {
            <label class="cc-label" for="cc-n">Cada cuántos días</label>
            <p-inputnumber [(ngModel)]="rCadaN" inputId="cc-n" [min]="1" [max]="365" [useGrouping]="false" suffix=" días" />
            <p class="cc-sub">
              Cuenta desde la última orden o entrada de Kepler@if (rProv?.ancla) { (la última, {{ dia(rProv?.ancla) }})}.
            </p>
          }

          <label class="cc-label" for="cc-nota">Nota (opcional)</label>
          <textarea pTextarea id="cc-nota" rows="2" [(ngModel)]="rNota" maxlength="500" placeholder="Ejemplo: el ejecutivo pasa en la mañana"></textarea>

          @if (!problemaRegla()) {
            <p class="cc-preview">
              @if (vistaPrevia().length) { Las siguientes: {{ vistaPrevia() }} } @else { Sin compras para contar los días: la primera fecha sale con la siguiente orden o entrada. }
            </p>
          }
          @if (avisoReemplazo(); as a) { <p class="cc-advertencia">{{ a }}</p> }
          @if (problemaRegla(); as p) { <p class="cc-sub" role="status">{{ p }}</p> }
          @if (errorDlg()) { <p class="cc-error" role="alert">{{ errorDlg() }}</p> }
          <div class="cc-acc">
            <button pButton type="button" class="p-button-sm" [disabled]="!!problemaRegla() || ocupado()" (click)="guardarRegla()">
              <span class="p-button-label">{{ ocupado() ? 'Guardando…' : 'Guardar la regla' }}</span>
            </button>
            <button pButton type="button" class="p-button-sm p-button-text" [disabled]="ocupado()" (click)="dlgRegla.set(false)">
              <span class="p-button-label">Cancelar</span>
            </button>
          </div>
        </div>
      </p-dialog>

      <!-- ===== Marcar la revisión ===== -->
      <p-dialog [visible]="dlgMarcar()" (visibleChange)="dlgMarcar.set($event)" [modal]="true" [draggable]="false"
                [header]="'Marcar la revisión de ' + (mRegla ? nombre(mRegla) : '')" [style]="{ width: '34rem' }" appendTo="body">
        <div class="cc-form">
          <p class="cc-sub">{{ mRegla?.alcance_nombre }} · {{ mRegla ? patron(mRegla) : '' }}. Si hubo orden de compra o entrada en Kepler no hace falta marcar: el calendario la toma solo.</p>
          <label class="cc-label" for="cc-mfecha">Fecha de la revisión</label>
          <p-datepicker [(ngModel)]="mFecha" inputId="cc-mfecha" dateFormat="dd/mm/yy" [maxDate]="maxMarca()" [showIcon]="true"
                        [showOnFocus]="false" appendTo="body" />
          <span class="cc-label">¿Qué pasó?</span>
          <app-segmented [options]="opcionesResultado" [value]="mResultado ?? ''" (valueChange)="cambiarResultado($event)" ariaLabel="Qué pasó en la revisión" />
          @if (mResultado === 'skipped') {
            <label class="cc-label" for="cc-motivo">¿Por qué no se pide?</label>
            <p-select [options]="opcionesMotivo" [(ngModel)]="mMotivo" inputId="cc-motivo" placeholder="Elige el motivo" appendTo="body" />
            <label class="cc-label" for="cc-nueva">Nueva fecha (opcional)</label>
            <p-datepicker [(ngModel)]="mNueva" inputId="cc-nueva" dateFormat="dd/mm/yy" [minDate]="minNueva()" [showIcon]="true"
                          [showClear]="true" [showOnFocus]="false" appendTo="body" />
            <p class="cc-sub">Con nueva fecha, ese día también toca. Sin ella, la siguiente es la de la regla.</p>
          }
          <label class="cc-label" for="cc-mnota">Nota{{ mMotivo === 'other' ? ' (obligatoria con «Otro»)' : ' (opcional)' }}</label>
          <textarea pTextarea id="cc-mnota" rows="2" [(ngModel)]="mNota" maxlength="500"></textarea>
          @if (problemaMarca(); as p) { <p class="cc-sub" role="status">{{ p }}</p> }
          @if (errorDlg()) { <p class="cc-error" role="alert">{{ errorDlg() }}</p> }
          <div class="cc-acc">
            <button pButton type="button" class="p-button-sm" [disabled]="!!problemaMarca() || ocupado()" (click)="guardarMarca()">
              <span class="p-button-label">{{ ocupado() ? 'Guardando…' : 'Guardar la marca' }}</span>
            </button>
            <button pButton type="button" class="p-button-sm p-button-text" [disabled]="ocupado()" (click)="dlgMarcar.set(false)">
              <span class="p-button-label">Cancelar</span>
            </button>
          </div>
        </div>
      </p-dialog>

      <!-- ===== Sacar del ciclo / regresar ===== -->
      <p-dialog [visible]="dlgFuera()" (visibleChange)="dlgFuera.set($event)" [modal]="true" [draggable]="false"
                [header]="(fRegla?.estado?.estado === 'fuera_de_ciclo' ? 'Fuera de ciclo: ' : 'Sacar del ciclo a ') + (fRegla ? nombre(fRegla) : '')"
                [style]="{ width: '32rem' }" appendTo="body">
        <div class="cc-form">
          @if (fRegla?.estado?.estado === 'fuera_de_ciclo') {
            <p>Está fuera de ciclo hasta el {{ dia(fRegla?.out_of_cycle_until) }}@if (fRegla?.out_of_cycle_reason) { : {{ fRegla?.out_of_cycle_reason }} }.</p>
            <p class="cc-sub">Puedes regresarla hoy o cambiar la fecha.</p>
          } @else {
            <p class="cc-sub">Mientras esté fuera de ciclo no se cuenta como rezagada. Ejemplo: un proveedor de temporada o que dejó de surtir.</p>
          }
          <label class="cc-label" for="cc-hasta">Fuera de ciclo hasta</label>
          <p-datepicker [(ngModel)]="fHasta" inputId="cc-hasta" dateFormat="dd/mm/yy" [minDate]="hoyFecha()" [showIcon]="true"
                        [showOnFocus]="false" appendTo="body" />
          <label class="cc-label" for="cc-fmotivo">¿Por qué? (obligatorio)</label>
          <textarea pTextarea id="cc-fmotivo" rows="2" [(ngModel)]="fMotivo" maxlength="500" placeholder="Ejemplo: de temporada, vuelve en enero"></textarea>
          @if (problemaFuera(); as p) { <p class="cc-sub" role="status">{{ p }}</p> }
          @if (errorDlg()) { <p class="cc-error" role="alert">{{ errorDlg() }}</p> }
          <div class="cc-acc">
            <button pButton type="button" class="p-button-sm" [disabled]="!!problemaFuera() || ocupado()" (click)="guardarFuera(false)">
              <span class="p-button-label">{{ ocupado() ? 'Guardando…' : 'Guardar' }}</span>
            </button>
            @if (fRegla?.estado?.estado === 'fuera_de_ciclo') {
              <button pButton type="button" class="p-button-sm p-button-outlined p-button-secondary" [disabled]="ocupado()" (click)="guardarFuera(true)">
                <span class="p-button-label">Regresar al ciclo hoy</span>
              </button>
            }
            <button pButton type="button" class="p-button-sm p-button-text" [disabled]="ocupado()" (click)="dlgFuera.set(false)">
              <span class="p-button-label">Cancelar</span>
            </button>
          </div>
        </div>
      </p-dialog>

      <!-- ===== Dar de baja ===== -->
      <p-dialog [visible]="dlgBaja()" (visibleChange)="dlgBaja.set($event)" [modal]="true" [draggable]="false"
                header="Dar de baja la regla" [style]="{ width: '30rem' }" appendTo="body">
        <div class="cc-form">
          <p>{{ bRegla ? nombre(bRegla) : '' }} en {{ bRegla?.alcance_nombre }} ({{ bRegla ? patron(bRegla) : '' }}) deja de revisarse.</p>
          <p class="cc-sub">La regla queda en la bitácora con tu nombre y la fecha. Si el proveedor no tiene otra regla, vuelve a «Sin regla».</p>
          @if (errorDlg()) { <p class="cc-error" role="alert">{{ errorDlg() }}</p> }
          <div class="cc-acc">
            <button pButton type="button" class="p-button-sm cc-btn-bad-solid" [disabled]="ocupado()" (click)="guardarBaja()">
              <span class="p-button-label">{{ ocupado() ? 'Guardando…' : 'Dar de baja' }}</span>
            </button>
            <button pButton type="button" class="p-button-sm p-button-text" [disabled]="ocupado()" (click)="dlgBaja.set(false)">
              <span class="p-button-label">Cancelar</span>
            </button>
          </div>
        </div>
      </p-dialog>
    </div>
  `,
  styleUrls: ['./compras-calendario.component.css'],
})
export class ComprasCalendarioComponent implements OnInit {
  private readonly api = inject(CalendarioComprasService);
  private readonly perms = inject(PermissionsService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly puedeMarcar = this.perms.has$(Permission.COMPRAS_CALENDARIO_GESTIONAR);
  readonly puedeCiclo = this.perms.has$(Permission.COMPRAS_CALENDARIO_CICLO);
  readonly puedePedido = this.perms.has$(Permission.COMPRAS_PEDIDO_VER);
  readonly porPagina = POR_PAGINA;

  // ── Datos ───────────────────────────────────────────────────────────────────────────────────
  readonly cal = signal<CalendarioCompras | null>(null);
  readonly cargando = signal(true);
  readonly error = signal<string | null>(null);
  readonly cargadoEn = signal<Date | null>(null);
  readonly prop = signal<PropuestasCalendario | null>(null);
  readonly cargandoProp = signal(true);
  readonly errorProp = signal<string | null>(null);

  // ── Vista ───────────────────────────────────────────────────────────────────────────────────
  /**
   * La vista de la URL (`?vista=`); sin ella, «Sin regla» si todavía no hay reglas y «Por revisar» si las hay.
   * `[PQ.3.6]` «Sin regla» es el trabajo de quien DEFINE ciclos (DC8): quien sólo ve o marca no la tiene, ni por URL.
   */
  private readonly vistaUrl = signal<Vista | null>(null);
  readonly vista = computed<Vista>(() => {
    const v = this.vistaUrl();
    if (v && (v !== 'sin_regla' || this.puedeCiclo())) return v;
    return this.cal()?.reglas.length === 0 && this.puedeCiclo() ? 'sin_regla' : 'revisar';
  });
  readonly busqueda = signal('');
  private readonly abiertaId = signal<string | null>(null);
  /** Se deriva del calendario: tras guardar, el detalle muestra la regla como quedó en la base. */
  readonly abierta = computed(() => this.cal()?.reglas.find((r) => r.id === this.abiertaId()) ?? null);

  readonly opcionesVista = computed<SegOption[]>(() => [
    { label: 'Por revisar', value: 'revisar' },
    { label: 'Semana', value: 'semana' },
    { label: 'Mes', value: 'mes' },
    { label: 'Reglas', value: 'reglas' },
    ...(this.puedeCiclo() ? [{ label: 'Sin regla', value: 'sin_regla' }] : []),
  ]);

  /** `[PQ.3.6]` La lista recortada a sus sucursales se dice; `null` si ve todas. */
  readonly alcanceTexto = computed(() => {
    const a = this.cal()?.tu_alcance;
    return a ? alcanceEnPalabras(a, (c) => warehouseName(c)) : null;
  });
  private readonly paraQuien = computed(() => {
    const a = this.cal()?.tu_alcance;
    return a ? paraQuienVe(a, (c) => warehouseName(c)) : '';
  });
  /** `[PQ.3.6]` Alcance resuelto a NINGUNA sucursal (su ficha no tiene): la pantalla se reduce a la respuesta. */
  readonly sinSucursal = computed(() => {
    const a = this.cal()?.tu_alcance;
    return !!a && !a.todas && !a.sucursales.length;
  });

  // ── Mensajes ────────────────────────────────────────────────────────────────────────────────
  readonly aviso = signal<string | null>(null);
  readonly errorAccion = signal<string | null>(null);
  readonly errorDlg = signal<string | null>(null);
  readonly ocupado = signal(false);

  // ── Derivados ───────────────────────────────────────────────────────────────────────────────
  readonly reglas = computed<ReglaCalendario[]>(() => {
    const q = this.busqueda();
    return (this.cal()?.reglas ?? []).filter((r) => coincideBusqueda(q, r.supplier_name, r.supplier_code, r.alcance_nombre));
  });
  readonly porRevisar = computed(() => this.reglas().filter((r) => ['rezagada', 'toca_hoy', 'sin_ancla'].includes(r.estado.estado)));
  readonly fechas = computed<FechaEnCalendario[]>(() => {
    const hoy = this.cal()?.hoy;
    if (!hoy) return [];
    return fechasEnRango(this.reglas(), hoy, sumarDias(hoy, this.vista() === 'mes' ? 30 : 6));
  });
  /** `[PQ.3.18]` El escalón del embudo que se está viendo; `null` = todos. */
  readonly escalonFiltro = signal<EscalonLlenado | null>(null);
  readonly sinRegla = computed<PropuestaSinRegla[]>(() => {
    const q = this.busqueda();
    const e = this.escalonFiltro();
    // `[PQ.3.14]` También los que YA tienen alguna regla y aún tienen día fijo en una sucursal sin la suya: definir
    // primero la corporativa no borra la propuesta de la sucursal. No cuentan en la cifra «Sin regla».
    // `[PQ.3.18]` Las dos listas juntas van por el orden del embudo: escalón, luego lo que pesa en la compra.
    const p0 = this.prop();
    return [...(p0?.sin_regla ?? []), ...(p0?.dia_fijo_pendiente ?? [])].sort(ordenDelEmbudo).filter((p) =>
      (e === null || p.peso?.escalon === e)
      && coincideBusqueda(q, p.supplier_name, p.supplier_code, ...p.branches_12m.map((c) => warehouseName(c))));
  });

  /** Vacío SIN buscar (la búsqueda sin resultados la dice la tabla, no el estado vacío). */
  readonly vacio = computed(() => {
    const c = this.cal();
    if (!c) return false;
    const v = this.vista();
    if (v === 'revisar') return !c.reglas.some((r) => ['rezagada', 'toca_hoy', 'sin_ancla'].includes(r.estado.estado));
    return !c.reglas.length;
  });
  readonly vacioTitulo = computed(() => {
    if (!this.cal()?.reglas.length) return `Todavía no hay reglas de revisión${this.paraQuien()}`;
    return this.vista() === 'revisar' ? 'Hoy no se debe ninguna revisión' : 'Sin reglas';
  });
  readonly vacioPista = computed(() => {
    if (!this.cal()?.reglas.length) {
      return this.puedeCiclo()
        ? 'Empieza en «Sin regla»: Kepler propone el ciclo de cada proveedor y tú lo confirmas.'
        : 'Las define la gerencia de compras; cuando haya, aquí sale a quién le toca la revisión.';
    }
    return 'Todas las reglas están al día o fuera de ciclo. «Semana» dice lo que viene.';
  });

  readonly respuesta = computed(() => {
    const c = this.cal();
    if (!c) return '';
    const r = c.resumen;
    const partes: string[] = [];
    const debe = r.rezagada + r.toca_hoy;
    if (this.sinSucursal()) {
      partes.push('Tu ficha no tiene sucursal: las reglas de revisión se ven por sucursal y no vas a ver ninguna hasta que te asignen una.');
    } else if (!c.reglas.length) {
      partes.push(`Todavía no hay reglas de revisión${this.paraQuien()}: el calendario empieza cuando la gerencia de compras las define.`);
    } else if (!debe) {
      partes.push('Hoy no se debe ninguna revisión.');
    } else {
      // La API ordena lo rezagado por días de atraso: la primera es la más atrasada.
      const peor = c.reglas.find((x) => x.estado.estado === 'rezagada');
      const det: string[] = [];
      if (r.rezagada) {
        det.push(`${r.rezagada} ${r.rezagada === 1 ? 'rezagada' : 'rezagadas'}`
          + (peor ? ` (la más atrasada, ${this.nombre(peor)} en ${peor.alcance_nombre}, desde el ${diaCorto(peor.estado.pendiente_desde)})` : ''));
      }
      if (r.toca_hoy) det.push(`${r.toca_hoy} ${r.toca_hoy === 1 ? 'toca' : 'tocan'} hoy`);
      partes.push(`Se ${debe === 1 ? 'debe 1 revisión' : `deben ${debe} revisiones`}: ${det.join(' y ')}.`);
    }
    if (r.sin_ancla) partes.push(`${r.sin_ancla} sin fecha base para contar los días.`);
    const p = this.puedeCiclo() ? this.prop() : null;
    if (p?.sin_regla.length) {
      const n = p.sin_regla.length;
      partes.push(`${n} ${n === 1 ? 'proveedor' : 'proveedores'} con compra en Kepler no ${n === 1 ? 'tiene' : 'tienen'} regla.`);
    }
    return partes.join(' ');
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const c = this.cal();
    if (!c) return [];
    const r = c.resumen;
    const p = this.prop();
    return [
      { label: 'Rezagadas', value: r.rezagada, format: 'number', tone: r.rezagada ? 'bad' : 'default', sub: 'se deben de días anteriores', drill: 'revisar' },
      { label: 'Tocan hoy', value: r.toca_hoy, format: 'number', tone: r.toca_hoy ? 'warn' : 'default', sub: 'sin orden, entrada ni marca', drill: 'revisar' },
      { label: 'Sin fecha base', value: r.sin_ancla, format: 'number', sub: 'cada N días, sin compra para contar', drill: 'revisar' },
      { label: 'Al día', value: r.al_dia, format: 'number', sub: `de ${c.reglas.length} ${c.reglas.length === 1 ? 'regla' : 'reglas'}`, drill: 'reglas' },
      { label: 'Fuera de ciclo', value: r.fuera_de_ciclo, format: 'number', sub: 'con fecha de regreso', drill: 'reglas' },
      // `[PQ.3.6]` «Sin regla» sólo para quien define ciclos: a quien no, es una cifra que no puede atender.
      ...(!this.puedeCiclo() ? [] : [p
        ? { label: 'Sin regla', value: p.sin_regla.length, format: 'number', sub: 'proveedores con compra en Kepler', drill: 'sin_regla' } as MetricStripItem
        : { label: 'Sin regla', value: '—', format: 'text', state: 'no_medido', stateNote: this.errorProp() ?? 'cargando la propuesta de Kepler', sub: 'proveedores con compra en Kepler', drill: 'sin_regla' } as MetricStripItem]),
    ];
  });

  ngOnInit(): void {
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((p) => {
      const v = p.get('vista') as Vista | null;
      this.vistaUrl.set(v && VISTAS.includes(v) ? v : null);
    });
    this.cargar();
    // `[PQ.3.6]` La propuesta de Kepler (~0.3 s) sólo la usa quien define ciclos. Los permisos ya están: el guard
    // de la ruta los leyó para dejar entrar.
    if (this.puedeCiclo()) this.cargarPropuestas();
  }

  // ── Carga ───────────────────────────────────────────────────────────────────────────────────
  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.api.calendario().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (c) => { this.cal.set(c); this.cargando.set(false); this.cargadoEn.set(new Date()); },
      error: (e) => { this.error.set(motivoHttp(e, 'leer el calendario de compras')); this.cargando.set(false); },
    });
  }

  cargarPropuestas(): void {
    this.cargandoProp.set(true);
    this.errorProp.set(null);
    this.api.propuestas().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => { this.prop.set(p); this.cargandoProp.set(false); },
      error: (e) => { this.errorProp.set(motivoHttp(e, 'leer lo que propone Kepler')); this.cargandoProp.set(false); },
    });
  }

  irAVista(v: string): void {
    if (!VISTAS.includes(v as Vista)) return;
    void this.router.navigate([], { relativeTo: this.route, queryParams: { vista: v }, queryParamsHandling: 'merge' });
  }

  abrir(id: string): void { this.abiertaId.set(id); }
  cerrar(): void { this.abiertaId.set(null); }

  // ── Presentación ────────────────────────────────────────────────────────────────────────────
  nombre(r: Pick<ReglaCalendario, 'supplier_name' | 'supplier_code'>): string {
    return r.supplier_name ?? `Proveedor ${r.supplier_code}`;
  }
  patron(r: PatronDeRegla): string { return patronEnPalabras(r); }
  corrimiento(r: PatronDeRegla): string | null { return corrimientoEnPalabras(r); }
  estado(r: ReglaCalendario): EstadoVisible { return estadoEnPalabras(r.estado, r, this.cal()?.hoy ?? ''); }
  atencion(r: ReglaCalendario) { return atencionEnPalabras(r.ultima_actividad, r.ultima_marca); }
  dia(f: string | null | undefined): string { return diaCorto(f); }
  rel(f: string): string { const h = this.cal()?.hoy ?? this.prop()?.hoy; return h ? relativo(f, h) : ''; }
  motivo(m: MotivoNoSePide): string { return ETIQUETA_MOTIVO_NO_SE_PIDE[m]; }
  propuesta(p: PropuestaSinRegla): string { return propuestaEnPalabras(p); }
  diaFijo(d: PropuestaDiaFijo): string { return diaFijoEnPalabras(d); }
  diaFijoReciente(d: PropuestaDiaFijo): string { return diaFijoReciente(d); }
  /** `[PQ.3.14]` Cuántas sucursales traen su regla de día fijo armada (las de «Sin regla» y las pendientes). */
  readonly diasFijosTotal = computed(() => {
    const p = this.prop();
    return p ? [...p.sin_regla, ...p.dia_fijo_pendiente].reduce((n, x) => n + x.dias_fijos.length, 0) : 0;
  });
  ficha(p: PropuestaSinRegla): string | null { return fichaEnPalabras(p); }
  // `[PQ.3.18]` El embudo de llenado en palabras.
  avanceTotal(a: AvanceDelEmbudo): string { return avanceTotalEnPalabras(a); }
  avanceEscalon(a: AvanceDelEmbudo): string { return avanceEscalonEnPalabras(a); }
  nombreEscalon(e: EscalonLlenado | null): string { return e === null ? '' : NOMBRE_ESCALON[e]; }
  peso(p: PropuestaSinRegla) { return pesoEnPalabras(p.peso, p.rounds_12m); }
  /** Un clic en el escalón filtra la lista a ése; otro clic en el mismo, vuelve a todos. */
  filtrarEscalon(e: EscalonLlenado | null): void { this.escalonFiltro.set(this.escalonFiltro() === e ? null : e); }
  sucursales(codes: readonly string[]): string { return codes.map((c) => warehouseName(c)).join(', '); }
  proximas(r: ReglaCalendario): FechaEnCalendario[] {
    const hoy = this.cal()?.hoy;
    return hoy ? proximasDeLaRegla(r, sumarDias(hoy, 1), 4) : [];
  }
  proximasTexto(r: ReglaCalendario): string { return this.proximas(r).map((f) => diaCorto(f.fecha)).join(' · '); }
  /** La primera fila de cada día en «Semana»/«Mes» lleva una línea arriba (agrupar por espacio, no por caja). */
  esPrimeraDelDia(f: FechaEnCalendario): boolean {
    const xs = this.fechas();
    const i = xs.indexOf(f);
    return i > 0 && xs[i - 1].fecha !== f.fecha;
  }
  sePuedeMarcar(f: string): boolean {
    const hoy = this.cal()?.hoy;
    return !!hoy && f <= sumarDias(hoy, MARCA_MAX_ADELANTE_DIAS);
  }

  // ── Regla: definir, corregir, otra ──────────────────────────────────────────────────────────
  readonly dlgRegla = signal(false);
  /** La regla que se abrió para CORREGIR (null = nueva). */
  private reglaEditando: ReglaCalendario | null = null;
  rProv: ProveedorDelFormulario | null = null;
  rScope: AlcanceRevision = 'corporate';
  rZona: string | null = null;
  rSucursal: string | null = null;
  rPatron: PatronRevision = 'weekdays';
  rSemana: boolean[] = new Array(7).fill(false);
  rMes: boolean[] = new Array(31).fill(false);
  rUltimo = false;
  rCadaN: number | null = null;
  rCorre: CorrimientoFinDeSemana = 'friday';
  rNota = '';
  /** `[PQ.3.14]` De dónde sale la regla propuesta (día fijo), en una frase; null si no viene de una propuesta. */
  rEvidencia: string | null = null;

  readonly diasSemana = DIAS_SEMANA;
  readonly diasSemanaLargo = DIAS_SEMANA_LARGO;
  readonly diasMes = Array.from({ length: 31 }, (_, i) => i + 1);
  readonly opcionesAlcance: SegOption[] = [
    { label: 'Todas las sucursales', value: 'corporate' },
    { label: 'Una zona', value: 'zone' },
    { label: 'Una sucursal', value: 'branch' },
  ];
  readonly opcionesPatron: SegOption[] = [
    { label: 'Días de la semana', value: 'weekdays' },
    { label: 'Días del mes', value: 'month_days' },
    { label: 'Cada N días', value: 'every_n_days' },
  ];
  readonly opcionesCorrimiento: SegOption[] = [
    { label: 'Se adelanta al viernes', value: 'friday' },
    { label: 'Pasa al lunes', value: 'monday' },
  ];
  readonly opcionesZona = computed(() => (this.cal()?.zonas ?? []).map((z) => ({
    label: `${z.nombre} (${z.sucursales.map((c) => warehouseName(c)).join(', ')})`, value: z.code,
  })));
  readonly opcionesSucursal = computed(() => (this.cal()?.sucursales ?? []).map((c) => ({ label: warehouseName(c), value: c })));

  tituloRegla(): string {
    return this.reglaEditando ? 'Corregir la regla' : 'Definir la regla de revisión';
  }

  abrirReglaDePropuesta(p: PropuestaSinRegla): void {
    this.prepararRegla({ code: p.supplier_code, name: p.supplier_name, ancla: p.last_order_date }, null);
    if (p.proposal_status === 'propuesto' && p.cycle_days_proposed) {
      this.rPatron = 'every_n_days';
      this.rCadaN = p.cycle_days_proposed;
    }
    this.dlgRegla.set(true);
  }

  /**
   * `[PQ.3.14]` El formulario ya lleno con la regla de sucursal que propone el día fijo: sucursal, patrón y, en «cada
   * N días», la fecha base de ESA sucursal (su última orden o entrada), no la de la empresa.
   */
  abrirReglaDeDiaFijo(p: PropuestaSinRegla, d: PropuestaDiaFijo): void {
    this.prepararRegla({ code: p.supplier_code, name: p.supplier_name, ancla: d.ultima }, null);
    const patron = patronDelDiaFijo(d);
    this.rScope = 'branch';
    this.rSucursal = d.branch_code;
    this.rPatron = patron.pattern;
    for (const w of patron.weekdays ?? []) this.rSemana[w - 1] = true;
    this.rCadaN = patron.every_n_days;
    this.rEvidencia = diaFijoEvidencia(d, warehouseName(d.branch_code));
    this.dlgRegla.set(true);
  }

  /** `corregir`: la misma regla con su patrón; si no, otra regla del mismo proveedor (otro alcance). */
  abrirReglaDe(r: ReglaCalendario, corregir: boolean): void {
    this.prepararRegla({ code: r.supplier_code, name: r.supplier_name, ancla: r.ultima_actividad?.fecha ?? null }, corregir ? r : null);
    if (corregir) {
      this.rScope = r.scope;
      this.rZona = r.zone_code;
      this.rSucursal = r.branch_code;
      this.rPatron = r.pattern;
      for (const d of r.weekdays ?? []) this.rSemana[d - 1] = true;
      for (const d of r.month_days ?? []) this.rMes[d - 1] = true;
      this.rUltimo = r.month_last_day;
      this.rCadaN = r.every_n_days;
      this.rCorre = r.weekend_shift;
      this.rNota = r.note ?? '';
    } else {
      this.rScope = 'branch';
    }
    this.dlgRegla.set(true);
  }

  private prepararRegla(prov: ProveedorDelFormulario, editando: ReglaCalendario | null): void {
    this.errorDlg.set(null);
    this.errorAccion.set(null);
    this.aviso.set(null);
    this.reglaEditando = editando;
    this.rProv = prov;
    this.rScope = 'corporate';
    this.rZona = null;
    this.rSucursal = null;
    this.rPatron = 'weekdays';
    this.rSemana = new Array(7).fill(false);
    this.rMes = new Array(31).fill(false);
    this.rUltimo = false;
    this.rCadaN = null;
    this.rCorre = 'friday';
    this.rNota = '';
    this.rEvidencia = null;
  }

  cambiarAlcance(v: string): void {
    this.rScope = v === 'zone' ? 'zone' : v === 'branch' ? 'branch' : 'corporate';
  }
  cambiarPatron(v: string): void {
    this.rPatron = v === 'month_days' ? 'month_days' : v === 'every_n_days' ? 'every_n_days' : 'weekdays';
  }
  cambiarCorrimiento(v: string): void {
    this.rCorre = v === 'monday' ? 'monday' : 'friday';
  }

  private patronDelFormulario(): PatronDeRegla {
    return {
      pattern: this.rPatron,
      weekdays: this.rPatron === 'weekdays' ? this.rSemana.map((on, i) => (on ? i + 1 : 0)).filter(Boolean) : null,
      month_days: this.rPatron === 'month_days' ? this.rMes.map((on, i) => (on ? i + 1 : 0)).filter(Boolean) : null,
      month_last_day: this.rPatron === 'month_days' && this.rUltimo,
      every_n_days: this.rPatron === 'every_n_days' ? this.rCadaN : null,
      weekend_shift: this.rCorre,
    };
  }

  /** La regla viva de este proveedor en el alcance elegido (la API la reemplazaría). */
  private reglaDelAlcance(): ReglaCalendario | null {
    const code = this.rProv?.code;
    if (!code) return null;
    const zona = this.rScope === 'zone' ? this.rZona : null;
    const suc = this.rScope === 'branch' ? this.rSucursal : null;
    return this.cal()?.reglas.find((r) => r.supplier_code === code && r.scope === this.rScope
      && (r.zone_code ?? null) === zona && (r.branch_code ?? null) === suc) ?? null;
  }

  private dtoRegla(): GuardarReglaDto {
    const p = this.patronDelFormulario();
    return {
      supplier_code: this.rProv?.code ?? '',
      scope: this.rScope,
      zone_code: this.rScope === 'zone' ? this.rZona : null,
      branch_code: this.rScope === 'branch' ? this.rSucursal : null,
      pattern: p.pattern,
      ...(p.pattern === 'weekdays' ? { weekdays: p.weekdays } : {}),
      ...(p.pattern === 'month_days' ? { month_days: p.month_days, month_last_day: p.month_last_day } : {}),
      ...(p.pattern === 'every_n_days' ? { every_n_days: p.every_n_days } : {}),
      weekend_shift: p.weekend_shift,
      // Quien revisa no se elige aquí todavía (§10.6): se CONSERVA el de la regla que se reemplaza.
      reviewer_user_id: this.reglaDelAlcance()?.reviewer_user_id ?? null,
      note: this.rNota.trim() || null,
    };
  }

  /** La MISMA validación de la API (contrato), con las zonas y sucursales que la API usa. */
  problemaRegla(): string | null {
    if (!this.rProv) return 'Falta el proveedor.';
    const c = this.cal();
    return validarRegla(this.dtoRegla(), (c?.zonas ?? []).map((z) => z.code), c?.sucursales ?? []);
  }

  vistaPrevia(): string {
    const hoy = this.cal()?.hoy;
    if (!hoy) return '';
    const p = this.patronDelFormulario();
    const ancla = p.pattern === 'every_n_days' ? this.rProv?.ancla ?? null : null;
    return proximasRevisiones(p, hoy, 4, ancla).map((f) => diaCorto(f.fecha) + (f.corrida_de ? ` (era el ${diaCorto(f.corrida_de)})` : '')).join(' · ');
  }

  revisaDelFormulario(): string {
    const viva = this.reglaDelAlcance();
    if (viva?.reviewer_user_id) return viva.revisa;
    if (this.rScope === 'corporate') return 'Gerencia de compras';
    if (this.rScope === 'zone') {
      const z = this.cal()?.zonas.find((x) => x.code === this.rZona);
      return z ? `Gerencia de zona (${z.nombre})` : 'Gerencia de la zona';
    }
    return this.rSucursal ? `Encargado de ${warehouseName(this.rSucursal)}` : 'Encargado de la sucursal';
  }

  /** Dónde aplica lo que se guarda, para el aviso: «todas las sucursales» · «zona Zamora» · «Yurécuaro». */
  private alcanceDelFormulario(): string {
    if (this.rScope === 'corporate') return 'todas las sucursales';
    if (this.rScope === 'zone') return `zona ${this.cal()?.zonas.find((x) => x.code === this.rZona)?.nombre ?? this.rZona}`;
    return this.rSucursal ? warehouseName(this.rSucursal) : 'la sucursal';
  }

  /** Dice qué va a pasar ANTES de guardar: reemplazar otra regla, o crear una nueva al cambiar de alcance. */
  avisoReemplazo(): string | null {
    const viva = this.reglaDelAlcance();
    const ed = this.reglaEditando;
    if (viva && viva.id !== ed?.id) {
      return `Ya hay una regla de este proveedor para ${viva.alcance_nombre} (${patronEnPalabras(viva)}): guardar la reemplaza y conserva sus marcas.`;
    }
    if (ed && !viva && this.problemaRegla() === null) {
      return `Cambiaste el lugar: se crea una regla NUEVA y la de ${ed.alcance_nombre} sigue igual. Si ya no va, dala de baja.`;
    }
    return null;
  }

  guardarRegla(): void {
    if (this.ocupado() || this.problemaRegla()) return;
    const dto = this.dtoRegla();
    this.ocupado.set(true); // en el primer clic, antes de esperar la respuesta
    this.errorDlg.set(null);
    this.api.guardarRegla(dto).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.ocupado.set(false);
        this.dlgRegla.set(false);
        this.aviso.set(`${r.accion === 'creada' ? 'Regla creada' : 'Regla actualizada'}: ${this.rProv?.name ?? dto.supplier_code} en ${this.alcanceDelFormulario()}, ${patronEnPalabras(this.patronDelFormulario()).toLowerCase()}.`);
        // `[PQ.3.14]` En «Sin regla» se aceptan propuestas una tras otra: el detalle NO se abre encima de la lista (la
        // prueba visual: cada propuesta costaba un clic más para cerrarlo). Lo guardado sale del renglón y el aviso dice dónde quedó.
        if (this.vista() !== 'sin_regla') this.abiertaId.set(r.id);
        this.cargar();
        this.cargarPropuestas();
      },
      error: (e) => {
        this.ocupado.set(false);
        const m = `La regla no se guardó. ${motivoHttp(e, 'guardar la regla')}`;
        this.errorDlg.set(m);
        this.errorAccion.set(m);
      },
    });
  }

  // ── Marcar la revisión ──────────────────────────────────────────────────────────────────────
  readonly dlgMarcar = signal(false);
  mRegla: ReglaCalendario | null = null;
  mFecha: Date | null = null;
  mResultado: ResultadoRevision | null = null;
  mMotivo: MotivoNoSePide | null = null;
  mNueva: Date | null = null;
  mNota = '';
  readonly opcionesResultado: SegOption[] = [
    { label: 'Se pidió fuera de Kepler', value: 'ordered_outside_kepler' },
    { label: 'Hoy no se pide', value: 'skipped' },
  ];
  readonly opcionesMotivo = MOTIVOS_NO_SE_PIDE.map((m) => ({ label: ETIQUETA_MOTIVO_NO_SE_PIDE[m], value: m }));

  /** `fecha` = la de la fila de «Semana» (para marcar antes, «el lunes no se pide»); sin ella, hoy. */
  abrirMarcar(r: ReglaCalendario, fecha: string | null): void {
    this.errorDlg.set(null);
    this.errorAccion.set(null);
    this.aviso.set(null);
    this.mRegla = r;
    this.mFecha = this.aFecha(fecha ?? this.cal()?.hoy ?? null);
    // A propósito sin valor: es una decisión, no un default.
    this.mResultado = null;
    this.mMotivo = null;
    this.mNueva = null;
    this.mNota = '';
    this.dlgMarcar.set(true);
  }

  cambiarResultado(v: string): void {
    this.mResultado = v === 'skipped' ? 'skipped' : v === 'ordered_outside_kepler' ? 'ordered_outside_kepler' : null;
    if (this.mResultado !== 'skipped') { this.mMotivo = null; this.mNueva = null; }
  }

  private dtoMarca(): MarcarRevisionDto {
    const salta = this.mResultado === 'skipped';
    return {
      review_date: this.mFecha ? this.iso(this.mFecha) : '',
      outcome: (this.mResultado ?? '') as ResultadoRevision,
      skip_reason: salta ? this.mMotivo : null,
      postponed_to: salta && this.mNueva ? this.iso(this.mNueva) : null,
      note: this.mNota.trim() || null,
    };
  }

  problemaMarca(): string | null {
    const hoy = this.cal()?.hoy;
    if (!hoy) return 'El calendario no ha cargado.';
    return validarMarca(this.dtoMarca(), hoy);
  }

  maxMarca(): Date | null { const h = this.cal()?.hoy; return h ? this.aFecha(sumarDias(h, MARCA_MAX_ADELANTE_DIAS)) : null; }
  minNueva(): Date | null { return this.mFecha ? this.aFecha(sumarDias(this.iso(this.mFecha), 1)) : null; }
  hoyFecha(): Date | null { return this.aFecha(this.cal()?.hoy ?? null); }

  guardarMarca(): void {
    const r = this.mRegla;
    if (!r || this.ocupado() || this.problemaMarca()) return;
    const dto = this.dtoMarca();
    this.ocupado.set(true);
    this.errorDlg.set(null);
    this.api.marcar(r.id, dto).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.ocupado.set(false);
        this.dlgMarcar.set(false);
        const que = dto.outcome === 'skipped' ? `hoy no se pide (${this.motivo(dto.skip_reason as MotivoNoSePide).toLowerCase()})` : 'se pidió fuera de Kepler';
        this.aviso.set(`${res.accion === 'corregida' ? 'Marca corregida' : 'Marcado'}: ${this.nombre(r)} en ${r.alcance_nombre}, el ${diaCorto(dto.review_date)}: ${que}.`);
        this.cargar();
      },
      error: (e) => {
        this.ocupado.set(false);
        const m = `La marca no se guardó. ${motivoHttp(e, 'marcar la revisión')}`;
        this.errorDlg.set(m);
        this.errorAccion.set(m);
      },
    });
  }

  // ── Fuera de ciclo ──────────────────────────────────────────────────────────────────────────
  readonly dlgFuera = signal(false);
  fRegla: ReglaCalendario | null = null;
  fHasta: Date | null = null;
  fMotivo = '';

  abrirFuera(r: ReglaCalendario): void {
    this.errorDlg.set(null);
    this.errorAccion.set(null);
    this.aviso.set(null);
    this.fRegla = r;
    this.fHasta = this.aFecha(r.out_of_cycle_until);
    this.fMotivo = r.out_of_cycle_reason ?? '';
    this.dlgFuera.set(true);
  }

  private dtoFuera(regresar: boolean): FueraDeCicloDto {
    return regresar ? { hasta: null } : { hasta: this.fHasta ? this.iso(this.fHasta) : '', motivo: this.fMotivo.trim() || null };
  }

  problemaFuera(): string | null {
    const hoy = this.cal()?.hoy;
    if (!hoy) return 'El calendario no ha cargado.';
    if (!this.fHasta) return 'Elige hasta cuándo.';
    return validarFueraDeCiclo(this.dtoFuera(false), hoy);
  }

  guardarFuera(regresar: boolean): void {
    const r = this.fRegla;
    if (!r || this.ocupado() || (!regresar && this.problemaFuera())) return;
    const dto = this.dtoFuera(regresar);
    this.ocupado.set(true);
    this.errorDlg.set(null);
    this.api.fueraDeCiclo(r.id, dto).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.ocupado.set(false);
        this.dlgFuera.set(false);
        this.aviso.set(regresar
          ? `${this.nombre(r)} en ${r.alcance_nombre} regresó al ciclo.`
          : `${this.nombre(r)} en ${r.alcance_nombre} queda fuera de ciclo hasta el ${diaCorto(dto.hasta)}.`);
        this.cargar();
      },
      error: (e) => {
        this.ocupado.set(false);
        const m = `No cambió. ${motivoHttp(e, 'cambiar el ciclo de la regla')}`;
        this.errorDlg.set(m);
        this.errorAccion.set(m);
      },
    });
  }

  // ── Baja ────────────────────────────────────────────────────────────────────────────────────
  readonly dlgBaja = signal(false);
  bRegla: ReglaCalendario | null = null;

  abrirBaja(r: ReglaCalendario): void {
    this.errorDlg.set(null);
    this.errorAccion.set(null);
    this.aviso.set(null);
    this.bRegla = r;
    this.dlgBaja.set(true);
  }

  guardarBaja(): void {
    const r = this.bRegla;
    if (!r || this.ocupado()) return;
    this.ocupado.set(true);
    this.errorDlg.set(null);
    this.api.darDeBaja(r.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.ocupado.set(false);
        this.dlgBaja.set(false);
        this.abiertaId.set(null);
        this.aviso.set(`Regla dada de baja: ${this.nombre(r)} en ${r.alcance_nombre}.`);
        this.cargar();
        this.cargarPropuestas();
      },
      error: (e) => {
        this.ocupado.set(false);
        const m = `La regla sigue. ${motivoHttp(e, 'dar de baja la regla')}`;
        this.errorDlg.set(m);
        this.errorAccion.set(m);
      },
    });
  }

  // ── Fechas ──────────────────────────────────────────────────────────────────────────────────
  private aFecha(s: string | null | undefined): Date | null {
    if (!s) return null;
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }

  /** `YYYY-MM-DD` en hora LOCAL: `toISOString()` es UTC y de noche adelanta el día. */
  private iso(f: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${f.getFullYear()}-${p(f.getMonth() + 1)}-${p(f.getDate())}`;
  }
}
