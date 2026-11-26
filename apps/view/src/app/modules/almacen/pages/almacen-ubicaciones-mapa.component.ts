import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import {
  aisleOrder,
  describeLocationCode,
  FIXTURE_KINDS,
  LOCATION_KINDS,
  nombrePieza,
  parseLocationCode,
  rackFace,
  rackOpuesto,
  type CroquisResponse,
  type LocationKind,
  type LocationZone,
  type RackFace,
  type WarehouseFixture,
  type WarehouseLocationRow,
  type WarehouseLocationsResponse,
} from '@megadulces/contracts';
import { Permission } from '../../../core/constants/permissions';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AlmacenUbicacionesCatalogoService } from '../almacen-ubicaciones-catalogo.service';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { UbicacionesCapturaComponent } from './ubicaciones-captura.component';
import { UbicacionesCarretasComponent } from './ubicaciones-carretas.component';
import { elegirAlmacen, guardarAlmacenPreferido, recordarRollo, rolloRecordado } from '../shared/almacen-preferido';
import { AndenCartelComponent, type CartelUbicacion, type FormatoCartel } from '../anden/components/anden-cartel.component';
import { ROLLOS_AMARILLOS, ROLLO_POR_OMISION, type RolloAmarillo } from '../anden/etiqueta-ubicacion';

/** Estado de un rack en el mapa: el más urgente de sus niveles. */
export type EstadoRack = 'bloqueada' | 'contenido' | 'activa' | 'baja' | 'vacio';

export interface Celda {
  rack: number;
  estado: EstadoRack;
  niveles: WarehouseLocationRow[];
  /**
   * `[UB.RF.17]` Productos con lugar asignado en el rack. Es **el número que se pinta**, porque es el
   * único que varía: medido el 2026-11-25, los 75 racks de CEDIS tenían los mismos 5 niveles y los 39 de
   * Padre Hidalgo los mismos 4, así que el mapa dibujaba 75 cuadros idénticos mientras 2 de esos racks ya
   * tenían producto y se veían igual que los otros 37.
   */
  productos: number;
  aria: string;
}
/**
 * `[UB.RF.18]` Un **frente** de un pasillo: el de los nones o el de los pares. Un pasillo es un
 * corredor con dos frentes enfrentados (Edgar, 2026-11-25) y el mapa los dibuja como tales.
 */
export interface Fila {
  pasillo: string;
  cara: RackFace;
  /** Índice en la lista plana de frentes: es con lo que se mueven las flechas. */
  fi: number;
  celdas: Celda[];
}

export interface PasilloMapa {
  pasillo: string;
  /** La columna k son los racks 2k-1 (non) y 2k (par): quedan uno enfrente del otro. */
  columnas: number;
  nones: Fila;
  pares: Fila;
}

/**
 * `[UB.PL]` Una pieza puesta en el croquis: el mueble, el bloque de racks que le corresponde (si
 * genera ubicaciones) y cómo se dibuja. Una cabecera **no** lleva corredor en medio: es de una cara,
 * y dibujarle dos frentes es dibujar algo que no existe en la tienda.
 */
interface PiezaEnCroquis {
  pieza: WarehouseFixture;
  bloque: PasilloMapa | null;
  nombre: string;
  dosFrentes: boolean;
}

interface FilaCroquis {
  fila: number;
  piezas: PiezaEnCroquis[];
}

const ESTADO_LABEL: Record<EstadoRack, string> = {
  bloqueada: 'con un nivel bloqueado',
  contenido: 'con mercancía acomodada',
  activa: 'dada de alta',
  baja: 'dada de baja',
  vacio: 'sin dar de alta',
};

/**
 * `[UB.1]` Mapa de ubicaciones (Fase UB, ADR-090).
 *
 * Los pasillos en renglones y los racks en columnas, por zona (bodega / tienda). Cada cuadro es
 * un rack y se pinta con el estado más urgente de sus niveles. Al tocarlo se ven sus niveles. Quien
 * tiene GESTIONAR puede dar de alta una ubicación desde aquí; la captura masiva llega en `[UB.2]`.
 *
 * Lo que no tiene formato nuevo (códigos libres del Andén, como `R-12`) no se esconde: se lista
 * aparte como "código libre", porque sigue existiendo y puede tener mercancía.
 */
@Component({
  selector: 'app-almacen-ubicaciones-mapa',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, SelectModule, InputTextModule, MetricStripComponent, SegmentedComponent, UbicacionesCapturaComponent, UbicacionesCarretasComponent, AndenCartelComponent],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head ub-head">
        <div class="ub-head-text">
          <!-- [UB.RF.19] El almacén va EN el título, no en gris chico al lado: quien no tiene almacen en
               su ficha abre en el primero por codigo y leia «no hay nada» sin notar de cual hablaba. -->
          <h1>Ubicaciones @if (data()?.warehouse; as w) { <span class="ub-wh">· {{ w.name }}</span> }</h1>
          <span class="ub-meta">bodega y tienda en el mismo almacén</span>
        </div>
        <div class="ub-actions">
          @if (almacenOpts().length > 1) {
            <p-select [options]="almacenOpts()" optionLabel="label" optionValue="value" [ngModel]="warehouseId()" (onChange)="pickAlmacen($event.value)" ariaLabel="Almacén" appendTo="body" class="ub-sel" />
          }
          @if (data()?.warehouse && !enCaptura() && !enCarretas()) {
            <!-- [UB.RF.10] Carteles para pegar en el rack: uno, un rack, un pasillo o toda la zona. -->
            <!-- [UB.RF.12] En tienda son etiquetas chicas para el canto del anaquel (un cartel le quita vista al producto). -->
            <button pButton type="button" class="p-button-sm p-button-outlined" [attr.aria-pressed]="imprimirAbierto()" (click)="abrirImpresion()"><span class="p-button-icon pi pi-print" aria-hidden="true"></span><span class="p-button-label">{{ zona() === 'T' ? 'Imprimir etiquetas' : 'Imprimir carteles' }}</span></button>
          }
          @if (puedeGestionar() && data()?.warehouse) {
            @if (enCaptura()) {
              <button pButton type="button" class="p-button-sm p-button-outlined" (click)="verCaptura(false)"><span class="p-button-icon pi pi-map" aria-hidden="true"></span><span class="p-button-label">Volver al mapa</span></button>
            } @else {
              <button pButton type="button" class="p-button-sm" (click)="verCaptura(true)"><span class="p-button-icon pi pi-table" aria-hidden="true"></span><span class="p-button-label">Captura masiva</span></button>
            }
          }
          <!-- [GP.11.5] Carretas y carritos: el mismo catálogo, su propia vista. -->
          @if (data()?.warehouse && !enCaptura()) {
            @if (enCarretas()) {
              <button pButton type="button" class="p-button-sm p-button-outlined" (click)="verCarretas(false)"><span class="p-button-icon pi pi-map" aria-hidden="true"></span><span class="p-button-label">Volver al mapa</span></button>
            } @else {
              <button pButton type="button" class="p-button-sm p-button-outlined" (click)="verCarretas(true)"><span class="p-button-icon pi pi-shopping-cart" aria-hidden="true"></span><span class="p-button-label">Carretas</span></button>
            }
          }
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="loading()" (click)="reload()" aria-label="Actualizar"><span class="p-button-icon pi pi-refresh" aria-hidden="true"></span></button>
        </div>
      </header>

      @if (err(); as e) { <div class="ub-errbox" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span class="ub-errbox-txt">{{ e }}</span><button pButton type="button" class="p-button-sm p-button-outlined" (click)="reload()"><span class="p-button-label">Reintentar</span></button></div> }

      @if (loading() && !data()) { <div class="ub-skeleton" aria-busy="true">@for (i of skel; track $index) { <div class="ub-skel-row"></div> }</div> }
      @else if (data(); as d) {
        @if (!d.warehouse) {
          <div class="ub-note ub-note-bad" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span>Tu ficha no tiene un almacén asignado, así que no hay ubicaciones que mostrarte. Pide que te lo asignen en <b>Administración › Personas</b>.</span></div>
        } @else {
          <app-metric-strip [items]="kpis()" ariaLabel="Resumen de ubicaciones" />

          <!-- [UB.RF.19] Si este almacen no tiene productos ubicados y otro si, se DICE con su nombre y
               su cifra. «No hay nada» sobre el almacen equivocado se lee como «se perdio lo que guarde». -->
          @if (otroConTrabajo(); as o) {
            <p class="ub-note">
              <i class="pi pi-info-circle" aria-hidden="true"></i>
              <span>{{ data()?.warehouse?.name }} todavía no tiene productos ubicados. <b>{{ o.name }}</b> tiene {{ o.con_producto }}.</span>
              <button pButton type="button" class="p-button-sm p-button-text" (click)="pickAlmacen(o.id)"><span class="p-button-label">Ver {{ o.name }}</span></button>
            </p>
          }

          <!-- [UB.RF.17] Lo que el mapa NO recorre se declara, no se cuenta en silencio: Zamora Centro
               publicaba «3 activas» y el mapa vacío, porque sus 3 son carretas (medido 2026-11-25). -->
          @if (!enCaptura() && fueraDelMapa(); as f) {
            <p class="ub-note">
              <i class="pi pi-info-circle" aria-hidden="true"></i>
              <span>{{ f.texto }}</span>
              @if (f.carretas && !enCarretas()) {
                <button pButton type="button" class="p-button-sm p-button-text" (click)="verCarretas(true)"><span class="p-button-label">Ver carretas</span></button>
              }
            </p>
          }

          @if (carteles().length) {
            <section class="ub-block ub-carteles" [attr.aria-label]="formatoCartel() === 'etiqueta' ? 'Etiquetas para imprimir' : 'Carteles para imprimir'">
              <app-anden-cartel [ubicaciones]="carteles()" [formato]="formatoCartel()" [rollo]="rolloCartel()" (cerrar)="cerrarImpresion()" />
            </section>
          } @else if (imprimirAbierto() && !enCaptura()) {
            <section class="ub-block ub-step ub-imprimir" aria-labelledby="ub-h-imp">
              <h3 id="ub-h-imp">Imprimir · {{ zona() === 'B' ? 'bodega' : 'tienda' }}</h3>
              @if (pasillosCartel().length) {
                <app-segmented [options]="formatosCartel" [value]="opcionCartel()" (valueChange)="pickFormato($any($event))" ariaLabel="Tamaño del papel" />
                <app-segmented [options]="pasillosCartel()" [value]="pasilloCartel()" (valueChange)="pasilloCartel.set($any($event))" ariaLabel="Pasillo" />
                <p class="ub-hint">{{ formatoCartel() === 'etiqueta' ? 'Etiquetas en la TSC TE200, rollo amarillo de ' + medidaRollo().cm + '.' : 'Salen dos por hoja carta; se recorta por la línea punteada.' }} Para uno solo o un rack, tócalo en el mapa.</p>
                <div class="ub-acts">
                  <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="cerrarImpresion()"><span class="p-button-label">Cancelar</span></button>
                  <button pButton type="button" class="p-button-sm" (click)="verCarteles({ pasillo: pasilloCartel() === '*' ? null : pasilloCartel() })"><span class="p-button-label">Ver {{ cuentaCartel() }} {{ nombreCartel(cuentaCartel()) }}</span></button>
                </div>
              } @else {
                <p class="ub-hint">No hay ubicaciones de {{ zona() === 'B' ? 'bodega' : 'tienda' }} dadas de alta: no hay nada que imprimir.</p>
              }
            </section>
          }

          @if (enCaptura()) {
            <app-ubicaciones-captura [warehouse]="d.warehouse" [ubicaciones]="d.ubicaciones" (cambio)="reload()" />
          } @else if (enCarretas()) {
            <app-ubicaciones-carretas [warehouse]="d.warehouse" [puedeGestionar]="puedeGestionar()" [puedeCoordinar]="puedeCoordinar()" />
          } @else {
          <div class="ub-split">
            <section class="ub-block" aria-labelledby="ub-h-mapa">
              <div class="ub-bh">
                <h2 id="ub-h-mapa" class="sr-only">Mapa</h2>
                <app-segmented [options]="zonaOpts()" [value]="zona()" (valueChange)="pickZona($any($event))" ariaLabel="Zona" />
                <!-- [UB.RF.17] Leyenda VIVA: sólo los estados que esta zona tiene. Antes listaba los cinco
                     siempre, y dos de ellos (bloqueada, baja) no los puede producir nadie todavía. -->
                <div class="ub-legend">
                  @for (l of leyenda(); track l.estado) {
                    <span><i class="ub-sw ub-c-{{ l.estado }}">@if (l.icono) { <i class="pi {{ l.icono }}" aria-hidden="true"></i> }</i>{{ l.label }}</span>
                  }
                  @if (conProducto()) { <span><b class="num">N</b> productos con lugar ahí</span> }
                </div>
              </div>

              <!-- [UB.PL] Si la sucursal ya tiene croquis, el mapa dibuja LA TIENDA: cada pieza en su
                   lugar, y cada una como lo que es. Una cabecera no lleva corredor en medio porque es
                   de una cara. Sin croquis se dibuja el mapa de siempre, que no desaparece. -->
              @if (hayCroquis()) {
                <div class="ub-croquis" role="group" aria-label="Croquis de la sucursal: flechas para moverse, Enter para ver el rack" (keydown)="onGridKey($event)">
                  @for (f of filasDelCroquis(); track f.fila) {
                    <div class="ub-cro-fila">
                      @for (p of f.piezas; track p.pieza.id) {
                        <section class="ub-pieza ub-pieza-{{ p.pieza.tipo }}" [attr.aria-label]="p.nombre">
                          <h3 class="ub-ph">{{ p.nombre }}</h3>
                          @if (p.bloque; as b) {
                            <div class="ub-corredor" [style.--ub-cols]="b.columnas">
                              @for (fr of (p.dosFrentes ? [b.nones, b.pares] : [b.nones]); track fr.cara) {
                                @if (p.dosFrentes && fr.cara === 'pares') { <div class="ub-via" aria-hidden="true"><span>corredor</span></div> }
                                @if (p.dosFrentes) { <span class="ub-cara">{{ fr.cara }}</span> } @else { <span class="ub-cara">frente</span> }
                                <div class="ub-frente">
                                  @if (fr.cara === 'nones') {
                                    <div class="ub-nums">@for (c of fr.celdas; track c.rack) { <span class="ub-rh num">{{ dos(c.rack) }}</span> }</div>
                                  }
                                  <div class="ub-celdas">
                                    @for (c of fr.celdas; track c.rack; let ci = $index) {
                                      <button type="button" class="ub-cell ub-c-{{ c.estado }}" [class.sel]="selKey() === fr.pasillo + c.rack"
                                        [attr.data-pos]="fr.fi + '-' + ci" [attr.tabindex]="esFoco(fr.fi, ci) ? 0 : -1"
                                        [attr.aria-label]="c.aria" [attr.aria-pressed]="selKey() === fr.pasillo + c.rack" (click)="pickRack(fr.pasillo, c, fr.fi, ci)">
                                        @if (c.estado === 'bloqueada') { <i class="pi pi-ban" aria-hidden="true"></i> }
                                        @else if (c.estado === 'contenido') { <i class="pi pi-box" aria-hidden="true"></i> }
                                        @else if (c.productos) { <span class="ub-cell-n num" aria-hidden="true">{{ c.productos }}</span> }
                                        @else if (c.estado === 'baja') { <i class="pi pi-minus" aria-hidden="true"></i> }
                                      </button>
                                    }
                                  </div>
                                  @if (p.dosFrentes && fr.cara === 'pares') {
                                    <div class="ub-nums">@for (c of fr.celdas; track c.rack) { <span class="ub-rh num">{{ dos(c.rack) }}</span> }</div>
                                  }
                                </div>
                              }
                            </div>
                          } @else {
                            <!-- Una caja o un mostrador estan en el croquis para ubicarse y no guardan codigos. -->
                            <p class="ub-hint">No guarda mercancía con código.</p>
                          }
                        </section>
                      }
                    </div>
                  }
                </div>
                @if (piezasSinLugar().length) {
                  <p class="ub-hint"><b>{{ piezasSinLugar().length }}</b> pieza(s) todavía sin lugar en el croquis: {{ nombresSinLugar() }}. Se ven abajo, en el mapa por pasillos.</p>
                }
              }

              @if (filas().length) {
                <!-- [UB.RF.18] Un pasillo es un CORREDOR con dos frentes enfrentados: se dibujan como
                     tales, los nones arriba y los pares abajo, con el corredor en medio. Cada frente
                     lleva su propia regleta de numeros pegada a su fila, para que nadie tenga que
                     deducir cual rack es cual. Una sola parada de tabulador; las flechas mueven (D.4a). -->
                <div class="ub-grid-wrap" role="group" aria-label="Mapa de pasillos: flechas para moverse, Enter para ver el rack" (keydown)="onGridKey($event)">
                  @for (p of pasillos(); track p.pasillo) {
                    <section class="ub-pasillo" [attr.aria-label]="'Pasillo ' + p.pasillo">
                      <h3 class="ub-ph">Pasillo <b class="num">{{ p.pasillo }}</b></h3>
                      <div class="ub-corredor" [style.--ub-cols]="p.columnas">
                        @for (f of [p.nones, p.pares]; track f.cara) {
                          @if (f.cara === 'pares') { <div class="ub-via" aria-hidden="true"><span>corredor</span></div> }
                          <span class="ub-cara">{{ f.cara }}</span>
                          <div class="ub-frente">
                            @if (f.cara === 'nones') {
                              <div class="ub-nums">@for (c of f.celdas; track c.rack) { <span class="ub-rh num">{{ dos(c.rack) }}</span> }</div>
                            }
                            <div class="ub-celdas">
                              @for (c of f.celdas; track c.rack; let ci = $index) {
                                <button type="button" class="ub-cell ub-c-{{ c.estado }}" [class.sel]="selKey() === f.pasillo + c.rack"
                                  [attr.data-pos]="f.fi + '-' + ci" [attr.tabindex]="esFoco(f.fi, ci) ? 0 : -1"
                                  [attr.aria-label]="c.aria" [attr.aria-pressed]="selKey() === f.pasillo + c.rack" (click)="pickRack(f.pasillo, c, f.fi, ci)">
                                  @if (c.estado === 'bloqueada') { <i class="pi pi-ban" aria-hidden="true"></i> }
                                  @else if (c.estado === 'contenido') { <i class="pi pi-box" aria-hidden="true"></i> }
                                  @else if (c.productos) { <span class="ub-cell-n num" aria-hidden="true">{{ c.productos }}</span> }
                                  @else if (c.estado === 'baja') { <i class="pi pi-minus" aria-hidden="true"></i> }
                                </button>
                              }
                            </div>
                            @if (f.cara === 'pares') {
                              <div class="ub-nums">@for (c of f.celdas; track c.rack) { <span class="ub-rh num">{{ dos(c.rack) }}</span> }</div>
                            }
                          </div>
                        }
                      </div>
                    </section>
                  }
                </div>
                <!-- [UB.PL] La salida para que el mapa deje de ser una rejilla: se arma de lo que YA
                     existe, sin recapturar ni borrar nada. -->
                @if (!hayCroquis() && puedeGestionar()) {
                  <p class="ub-note">
                    <i class="pi pi-info-circle" aria-hidden="true"></i>
                    <span>Este mapa dibuja todo como pasillos. Si {{ data()?.warehouse?.name }} tiene cabeceras, islas o cajas, el croquis las muestra como son.</span>
                    <button pButton type="button" class="p-button-sm p-button-text" (click)="configurarCroquis()"><span class="p-button-label">Configurar el croquis</span></button>
                  </p>
                }
                @if (croquisErr(); as e) { <p class="ub-hint ub-bad" role="alert">{{ e }}</p> }
                <p class="ub-hint">Cada pasillo tiene dos frentes, uno a cada lado del corredor: los racks <b>nones</b> de un lado y los <b>pares</b> del otro, así que el <b class="num">{{ dos(1) }}</b> queda enfrente del <b class="num">{{ dos(2) }}</b>. El número del cuadro es cuántos productos ya tienen su lugar ahí; tócalo para ver sus niveles.</p>
              } @else {
                <div class="ub-empty"><i class="pi pi-map" aria-hidden="true"></i><span>Todavía no hay ubicaciones de {{ zona() === 'B' ? 'bodega' : 'tienda' }} con el formato nuevo en {{ d.warehouse.code }}.</span>@if (puedeGestionar()) { <span>Da de alta la primera aquí a la derecha, o muchas a la vez con «Captura masiva» (por rango o desde Excel).</span> }</div>
              }
            </section>

            <aside class="ub-block ub-side" aria-label="Detalle">
              @if (sel(); as s) {
                <div class="ub-step">
                  <!-- [UB.RF.18] Dice de que frente es y que tiene enfrente: parado en el pasillo, eso es lo que ubica. -->
                  <h3>Rack {{ s.pasillo }}{{ dos(s.celda.rack) }} · {{ zona() === 'B' ? 'bodega' : 'tienda' }}</h3>
                  <p class="ub-sub">Frente de {{ cara(s.celda.rack) }}, enfrente del <b class="num">{{ s.pasillo }}{{ dos(opuesto(s.celda.rack)) }}</b>.</p>
                  @if (s.celda.niveles.length) {
                    <ul class="ub-levels">
                      @for (n of s.celda.niveles; track n.id) {
                        <li class="ub-level">
                          <span class="ub-code mono">{{ n.code }}</span>
                          <span class="ub-level-txt">Nivel {{ n.nivel }} · {{ tipoLabel(n.tipo) }}@if (n.productos_asignados) { · <b>{{ n.productos_asignados }} {{ n.productos_asignados === 1 ? 'producto' : 'productos' }}</b> }@if (n.renglones_con_cantidad) { · <b>{{ n.renglones_con_cantidad }} con mercancía</b> }</span>
                          <span class="ub-chip ub-chip-{{ n.estado }}">{{ estadoTxt(n.estado) }}</span>
                          @if (n.estado !== 'baja') {
                            <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" [attr.aria-label]="'Imprimir ' + (formatoCartel() === 'etiqueta' ? 'la etiqueta' : 'el cartel') + ' de ' + n.code" (click)="verCarteles({ code: n.code })"><span class="p-button-icon pi pi-print" aria-hidden="true"></span></button>
                          }
                          @if (n.motivo_estado) { <span class="ub-sub">{{ n.motivo_estado }}</span> }
                        </li>
                      }
                    </ul>
                    <div class="ub-acts ub-acts-start">
                      <!-- [UB.RF.17] Q.4: el numero del mapa lleva a donde se arregla. El boton NO dice
                           "ver sus N productos" porque Asignacion todavia no se puede filtrar por rack:
                           [UB.RF.15] trae ese filtro y no esta en el repo. Prometerlo seria un rotulo falso. -->
                      <button pButton type="button" class="p-button-sm p-button-outlined" (click)="verAsignacion()"><span class="p-button-icon pi pi-sitemap" aria-hidden="true"></span><span class="p-button-label">Asignar productos</span></button>
                      <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="verCarteles({ pasillo: s.pasillo, rack: s.celda.rack })"><span class="p-button-icon pi pi-print" aria-hidden="true"></span><span class="p-button-label">Imprimir {{ formatoCartel() === 'etiqueta' ? 'las etiquetas' : 'los carteles' }}</span></button>
                    </div>
                  } @else {
                    <p class="ub-hint">Este rack no tiene niveles dados de alta.</p>
                  }
                </div>
              }

              @if (puedeGestionar()) {
                <form class="ub-step" (ngSubmit)="crear()" aria-labelledby="ub-h-alta">
                  <h3 id="ub-h-alta">Dar de alta una ubicación</h3>
                  <label class="ub-field" for="ub-code">Código
                    <input pInputText id="ub-code" name="code" class="mono" autocomplete="off" [ngModel]="codigo()" (ngModelChange)="onCodigo($event)" placeholder="BA053" maxlength="12" [attr.aria-invalid]="codigo() && !parsed().ok" aria-describedby="ub-code-help" />
                  </label>
                  <span id="ub-code-help" class="ub-sub" [class.ub-bad]="codigo() && !parsed().ok" aria-live="polite">{{ ayudaCodigo() }}</span>
                  <label class="ub-field" for="ub-tipo">Tipo
                    <p-select inputId="ub-tipo" [options]="tipos" optionLabel="label" optionValue="key" [ngModel]="tipo()" (onChange)="tipo.set($event.value)" appendTo="body" placeholder="Sin tipo" [showClear]="true" />
                  </label>
                  @if (crearErr(); as e) { <span class="ub-sub ub-bad" role="alert">{{ e }}</span> }
                  @if (creada(); as c) { <span class="ub-sub ub-ok" role="status">{{ c }} quedó dada de alta.</span> }
                  <button pButton type="submit" class="p-button-sm" [disabled]="!parsed().ok || creando()" [loading]="creando()"><span class="p-button-label">Dar de alta</span></button>
                </form>
              }

              @if (legado().length) {
                <div class="ub-step">
                  <h3>Con código libre ({{ legado().length }})</h3>
                  <!-- [UB.RF.17] Antes decía «se recodifican desde Mantenimiento», y esa pantalla no existe
                       (UB.4 no tiene código ni endpoint). Un texto que manda a un lugar inexistente es peor
                       que no decir nada: la persona lo busca. -->
                  <p class="ub-hint">Las dio de alta el Andén antes del formato nuevo. Siguen valiendo y se pueden usar; todavía no hay forma de recodificarlas desde la suite.</p>
                  <ul class="ub-levels">
                    @for (n of legado(); track n.id) {
                      <li class="ub-level"><span class="ub-code mono">{{ n.code }}</span><span class="ub-level-txt">{{ n.label || 'Sin nombre' }}@if (n.renglones_con_cantidad) { · <b>{{ n.renglones_con_cantidad }} con mercancía</b> }</span><span class="ub-chip ub-chip-{{ n.estado }}">{{ estadoTxt(n.estado) }}</span></li>
                    }
                  </ul>
                </div>
              }
            </aside>
          </div>
          }
        }
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap; margin-bottom:.5rem; }
    .ub-head-text { display:flex; flex-wrap:wrap; align-items:baseline; gap:.35rem .75rem; min-width:0; }
    .ub-head-text h1 { margin:0; font-size:var(--fs-h2); font-weight:700; letter-spacing:-.01em; }
    /* [UB.RF.19] El almacen, en el titulo: mismo tamano, menos peso. No es metadato. */
    .ub-wh { font-weight:500; color:var(--text-muted); }
    .ub-meta { font-size:var(--fs-xs); color:var(--text-muted); }
    .ub-actions { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; }
    /* ::ng-deep sólo para el ancho del p-select de PrimeNG (vendor). */
    :host ::ng-deep .ub-sel { min-width:12rem; }
    app-metric-strip { display:block; margin-bottom:.75rem; }
    .ub-split { display:flex; flex-wrap:wrap; gap:.75rem; align-items:flex-start; }
    .ub-block { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); min-width:0; flex:999 1 36rem; }
    .ub-side { flex:1 1 20rem; }
    .ub-bh { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:.5rem; padding:.6rem .85rem; border-bottom:1px solid var(--border-color); }
    /* [UB.RF.17] --focus-ring (anillo SÓLIDO), no --action-ring: ése es el halo translúcido de un
       box-shadow y como outline daba 1.56:1 en claro y 1.07:1 sobre una celda pintada. El mapa se
       recorre con flechas: su anillo es el único indicador de dónde está la persona. */
    .ub-cell:focus-visible { outline:2px solid var(--focus-ring); outline-offset:1px; }
    .ub-legend { display:flex; flex-wrap:wrap; gap:.4rem .9rem; font-size:var(--fs-xs); color:var(--text-muted); }
    .ub-legend span { display:inline-flex; align-items:center; gap:.35rem; }
    .ub-sw { display:inline-flex; align-items:center; justify-content:center; width:1rem; height:1rem; border-radius:3px; }
    .ub-sw .pi { font-size:var(--fs-nano); }
    .ub-grid-wrap { overflow-x:auto; padding:.75rem .85rem .25rem; display:flex; flex-direction:column; gap:var(--sp-5); }
    /* [UB.PL] El croquis: los renglones de la tienda, y en cada uno sus piezas de izquierda a
       derecha. Se agrupa con ESPACIO; el borde de 1px es lo unico que delimita cada mueble. */
    .ub-croquis { display:flex; flex-direction:column; gap:var(--sp-5); padding:.75rem .85rem .25rem; overflow-x:auto; }
    .ub-cro-fila { display:flex; gap:var(--sp-5); align-items:flex-start; min-width:min-content; }
    .ub-pieza { border:1px solid var(--border-color); border-radius:var(--r-md); padding:.5rem .6rem; display:flex; flex-direction:column; gap:.3rem; min-width:min-content; }
    /* Una cabecera es un mueble corto y de una cara: se ve distinta de un anaquel sin usar otro color. */
    .ub-pieza-cabecera { border-style:dashed; }
    .ub-pieza-caja, .ub-pieza-mostrador { background:var(--hover-bg); align-self:center; }
    /* [UB.RF.18] Un bloque por pasillo: los dos frentes se agrupan por ESPACIO, no por una caja mas. */
    .ub-pasillo { display:flex; flex-direction:column; gap:.3rem; min-width:min-content; }
    .ub-ph { font-size:var(--fs-xs); font-weight:600; color:var(--text-muted); margin:0; text-transform:uppercase; letter-spacing:.04em; }
    .ub-ph b { color:var(--text-main); font-size:var(--fs-sm); }
    .ub-corredor { display:grid; grid-template-columns:3.5rem 1fr; gap:.15rem .6rem; align-items:center; }
    .ub-cara { font-size:var(--fs-micro); color:var(--text-muted); text-align:right; white-space:nowrap; }
    .ub-frente { display:flex; flex-direction:column; gap:.15rem; }
    .ub-nums, .ub-celdas { display:grid; grid-template-columns:repeat(var(--ub-cols), minmax(1.75rem, 1fr)); gap:.25rem; }
    /* El corredor: la linea que separa los dos frentes es el pasillo por el que se camina. */
    .ub-via { grid-column:1 / -1; display:flex; align-items:center; gap:.5rem; margin:.15rem 0; }
    .ub-via::before, .ub-via::after { content:''; flex:1; border-top:1px dashed var(--border-color); }
    .ub-via span { font-size:var(--fs-nano); color:var(--text-faint); text-transform:uppercase; letter-spacing:.08em; }
    /* [GP.RF.12] 11 px (antes 10): piso de letra para etiquetas y chips. */ .ub-rh { text-align:center; font-size:var(--fs-micro); color:var(--text-muted); }
    .ub-cell { height:2.25rem; border-radius:var(--r-sm); border:1px solid transparent; cursor:pointer; padding:0; display:inline-flex; align-items:center; justify-content:center; color:var(--text-main); }
    .ub-cell .pi { font-size:var(--fs-xs); }
    /* [GP.RF.12] 11 px es el piso de letra: el dato principal del mapa no puede ir por debajo. */
    .ub-cell-n { font-size:var(--fs-micro); font-weight:700; color:var(--card-bg); }
    @media (pointer: coarse) { .ub-cell { height:2.75rem; } }
    .ub-cell.sel { outline:3px solid var(--action); outline-offset:2px; }
    .ub-c-activa { background:var(--text-muted); border-color:var(--text-muted); }
    .ub-c-contenido { background:var(--warn-soft-bg); border-color:var(--warn-border); color:var(--warn-soft-fg); }
    .ub-c-bloqueada { background:var(--bad-soft-bg); border:2px solid var(--bad-fg); color:var(--bad-fg); }
    /* [UB.RF.17] «Dada de baja» y «sin dar de alta» se distinguían sólo por un relleno a 1.10:1 y un
       borde a 1.27:1 contra la tarjeta — por debajo del 3:1 que pide un objeto que porta información.
       Ahora: baja = borde sólido + guion; vacío = borde punteado. Trazo e ícono, no sólo color. */
    .ub-c-baja { background:var(--hover-bg); border:1px solid var(--text-muted); color:var(--text-muted); }
    .ub-c-vacio { background:transparent; border:1px dashed var(--text-muted); }
    .ub-step { padding:.75rem .85rem; border-top:1px solid var(--border-color); display:flex; flex-direction:column; gap:.5rem; }
    .ub-side > .ub-step:first-child { border-top:0; }
    .ub-step h3 { font-size:var(--fs-sm); font-weight:700; margin:0; }
    .ub-levels { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:.4rem; }
    .ub-level { display:grid; grid-template-columns:auto 1fr auto auto; gap:.15rem .6rem; align-items:center; padding:.45rem .6rem; border:1px solid var(--border-color); border-radius:var(--r-sm); }
    .ub-level .ub-sub { grid-column:1 / -1; }
    .ub-code { font-size:var(--fs-lg); font-weight:600; }
    .ub-level-txt { font-size:var(--fs-xs); color:var(--text-muted); min-width:0; }
    .ub-level-txt b { color:var(--text-main); font-weight:600; }
    .ub-chip { font-size:var(--fs-micro); padding:.1rem .45rem; border-radius:999px; border:1px solid var(--border-color); white-space:nowrap; }
    .ub-chip-activa { background:var(--ok-soft-bg); color:var(--ok-soft-fg); border-color:var(--ok-border); }
    .ub-chip-bloqueada { background:var(--bad-soft-bg); color:var(--bad-soft-fg); border-color:var(--bad-border); }
    .ub-chip-baja { background:var(--hover-bg); color:var(--text-muted); }
    .ub-field { display:flex; flex-direction:column; gap:.25rem; font-size:var(--fs-xs); color:var(--text-muted); }
    .ub-field input { font-size:var(--fs-body); height:2.5rem; }
    .ub-sub { font-size:var(--fs-xs); color:var(--text-muted); }
    .ub-sub.ub-bad { color:var(--bad-fg); }
    /* [GP.RF.13] texto: el tono para texto (el de relleno no llega a 4.5:1). */ .ub-sub.ub-ok { color:var(--ok-soft-fg); }
    .ub-hint { font-size:var(--fs-xs); color:var(--text-muted); margin:0; padding:0 .85rem .7rem; }
    .ub-step .ub-hint { padding:0; }
    /* [UB.RF.10] Imprimir carteles: el panel de alcance y la vista previa ocupan todo el ancho. */
    .ub-imprimir, .ub-carteles { flex:1 1 100%; margin-bottom:.75rem; }
    .ub-carteles { padding:.75rem .85rem; }
    .ub-imprimir { border-top:1px solid var(--border-color); }
    .ub-acts { display:flex; justify-content:flex-end; gap:.5rem; }
    .ub-acts-start { justify-content:flex-start; flex-wrap:wrap; }
    .ub-note:not(.ub-note-bad) { align-items:center; }
    .ub-note:not(.ub-note-bad) .pi { color:var(--text-muted); }
    .ub-note span { flex:1; min-width:0; }
    .ub-legend b { color:var(--text-main); font-weight:700; }
    .num, .mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); border:0; }
    .ub-note { display:flex; gap:.5rem; align-items:flex-start; padding:.6rem .8rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); font-size:var(--fs-sm); }
    .ub-note-bad { border-left:3px solid var(--bad-fg); }
    .ub-note-bad .pi { color:var(--bad-fg); }
    .ub-errbox { display:flex; align-items:center; gap:.6rem; padding:.7rem .85rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-left:3px solid var(--bad-fg); border-radius:var(--r-md); background:var(--card-bg); }
    .ub-errbox .pi { color:var(--bad-fg); } .ub-errbox-txt { flex:1; font-size:var(--fs-sm); }
    .ub-empty { display:flex; flex-direction:column; align-items:center; gap:var(--sp-2); padding:var(--sp-6); text-align:center; color:var(--text-muted); font-size:var(--fs-sm); }
    .ub-empty .pi { font-size:var(--fs-lg); }
    .ub-skeleton { display:flex; flex-direction:column; gap:var(--sp-2); margin-top:var(--sp-4); }
    .ub-skel-row { height:var(--row-h-md); border-radius:var(--r-sm); background:var(--hover-bg); animation:ub-pulse 1.4s ease-in-out infinite; }
    @keyframes ub-pulse { 0%,100% { opacity:1; } 50% { opacity:.55; } }
    @media (prefers-reduced-motion: reduce) { .ub-skel-row { animation:none; } }
  `],
})
export class AlmacenUbicacionesMapaComponent implements OnInit {
  private readonly api = inject(AlmacenUbicacionesCatalogoService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /** `?vista=captura` — en la URL, para que el enlace se pueda compartir y el botón Atrás funcione. */
  private readonly vista = toSignal(this.route.queryParamMap.pipe(map((q) => q.get('vista'))), { initialValue: null });
  readonly enCaptura = computed(() => this.vista() === 'captura' && this.puedeGestionar());
  /** `[GP.11.5]` `?vista=carretas`: carretas y carritos del almacén. */
  readonly enCarretas = computed(() => this.vista() === 'carretas');

  // ── [UB.RF.10] Carteles: uno, un rack, un pasillo o toda la zona ────────────────────────────────
  readonly imprimirAbierto = signal(false);
  readonly carteles = signal<CartelUbicacion[]>([]);
  /** Pasillo elegido para imprimir; '*' = todos los de la zona. */
  readonly pasilloCartel = signal<string>('*');
  readonly pasillosCartel = computed<SegOption[]>(() => {
    const deZona = this.conFormato().filter((u) => u.zona === this.zona() && u.estado !== 'baja');
    if (!deZona.length) return [];
    const porPasillo = new Map<string, number>();
    for (const u of deZona) if (u.pasillo) porPasillo.set(u.pasillo, (porPasillo.get(u.pasillo) ?? 0) + 1);
    const pasillos = [...porPasillo.keys()].sort((a, b) => aisleOrder(a) - aisleOrder(b));
    return [{ label: 'Todos', value: '*', count: deZona.length }, ...pasillos.map((p) => ({ label: 'Pasillo ' + p, value: p, count: porPasillo.get(p) }))];
  });
  readonly cuentaCartel = computed(() => this.pasillosCartel().find((o) => o.value === this.pasilloCartel())?.count ?? 0);

  /**
   * `[UB.RF.12]` Tamaño de lo que se imprime. Por omisión, el de la zona: en TIENDA etiquetas chicas para el
   * canto del anaquel (un cartel de media carta le quita vista al producto, Edgar 2026-11-19); en BODEGA el
   * cartel, que se lee caminando. La persona lo puede cambiar.
   */
  readonly formatoElegido = signal<FormatoCartel | null>(null);
  readonly formatoCartel = computed<FormatoCartel>(() => this.formatoElegido() ?? formatoPorZona(this.zona()));
  /**
   * `[UB.RF.20]` Hay **dos rollos amarillos** y conviven: distintas sucursales tienen cargado uno u otro
   * (Edgar, 2026-11-25), los dos medidos con regla. Las opciones dicen los **milímetros**, no «chica» y
   * «grande»: la persona tiene el rollo en la mano y lo que puede contrastar es la medida.
   */
  readonly formatosCartel: SegOption[] = [
    { label: 'Etiqueta 55 × 25', value: 'etiqueta:55x25' },
    { label: 'Etiqueta 60 × 29', value: 'etiqueta:60x29' },
    { label: 'Cartel · media carta', value: 'cartel' },
  ];

  /**
   * El rollo se recuerda **por máquina**, no por persona ni por sucursal: el rollo está cargado en la
   * impresora que tiene al lado quien imprime. Quien cambia de equipo elige una vez y queda.
   */
  readonly medidaRollo = computed(() => ROLLOS_AMARILLOS[this.rolloCartel()]);
  readonly rolloCartel = computed<RolloAmarillo>(() => this.rolloElegido() ?? rolloRecordado() ?? ROLLO_POR_OMISION);
  readonly rolloElegido = signal<RolloAmarillo | null>(null);

  /** El valor del control: formato y rollo en una sola opción, porque elegir «etiqueta» sin el rollo no sirve. */
  readonly opcionCartel = computed(() => (this.formatoCartel() === 'etiqueta' ? `etiqueta:${this.rolloCartel()}` : 'cartel'));

  pickFormato(v: string): void {
    if (v === 'cartel') { this.formatoElegido.set('cartel'); return; }
    const rollo = v.split(':')[1] as RolloAmarillo;
    this.formatoElegido.set('etiqueta');
    this.rolloElegido.set(rollo);
    recordarRollo(rollo);
  }
  nombreCartel(n: number): string {
    return this.formatoCartel() === 'etiqueta' ? (n === 1 ? 'etiqueta' : 'etiquetas') : n === 1 ? 'cartel' : 'carteles';
  }

  abrirImpresion(): void { this.imprimirAbierto.update((v) => !v); this.pasilloCartel.set('*'); this.formatoElegido.set(null); this.carteles.set([]); }
  cerrarImpresion(): void { this.imprimirAbierto.set(false); this.formatoElegido.set(null); this.carteles.set([]); }
  verCarteles(f: { pasillo?: string | null; rack?: number | null; code?: string }): void {
    this.carteles.set(cartelesDe(this.conFormato(), { zona: this.zona(), ...f }, this.data()?.warehouse?.code ?? null));
  }

  readonly skel = Array.from({ length: 6 });
  readonly tipos = [...LOCATION_KINDS];

  readonly data = signal<WarehouseLocationsResponse | null>(null);
  /** Folio de la consulta vigente: una respuesta vieja (cambio rápido de almacén) no pisa a la nueva. */
  private consulta = 0;
  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly warehouseId = signal<string | null>(null);
  readonly zona = signal<LocationZone>('B');
  readonly sel = signal<{ pasillo: string; celda: Celda } | null>(null);
  readonly selKey = computed(() => {
    const s = this.sel();
    return s ? s.pasillo + s.celda.rack : null;
  });

  /** Celda que recibe el foco del tabulador (roving): la elegida, o la primera. */
  readonly foco = signal<{ fi: number; ci: number }>({ fi: 0, ci: 0 });

  readonly zonaOpts = computed<SegOption[]>(() => [
    { label: `B · Bodega (${this.cuentaZona('B')})`, value: 'B' },
    { label: `T · Tienda (${this.cuentaZona('T')})`, value: 'T' },
  ]);

  /**
   * `[UB.RF.17]` Las ubicaciones que el mapa de esta zona SÍ recorre. Todo KPI se cuenta sobre esto,
   * no sobre el resumen del almacén: el resumen suma carretas, contenedores y la otra zona, y así
   * Zamora Centro publicaba «3 activas» con el mapa vacío (medido 2026-11-25).
   */
  private readonly enMapa = computed(() => this.conFormato().filter((u) => u.zona === this.zona() && u.estado !== 'baja'));
  /** Para la leyenda: si algún CUADRO del mapa lleva número. */
  readonly conProducto = computed(() => this.enMapa().filter((u) => u.productos_asignados > 0).length);
  /**
   * `[UB.RF.17]` Todo lo que esta pantalla muestra: el mapa de la zona **y** la lista de código libre.
   * Los KPI de contenido se cuentan sobre esto. Si se contaran sólo sobre el mapa, 8 Esquinas publicaría
   * «0 con mercancía» con su única ubicación —de código libre— diciendo «1 con mercancía» tres dedos
   * más abajo (medido 2026-11-25).
   */
  private readonly recorrible = computed(() => [...this.enMapa(), ...this.legado().filter((u) => u.estado !== 'baja')]);

  /**
   * `[UB.RF.17]` Las familias que no tienen pasillo ni rack y por lo tanto no caben en el mapa. Si no se
   * dicen, se cuelan en los KPI y la persona busca en el mapa algo que nunca va a estar ahí.
   */
  readonly fueraDelMapa = computed<{ texto: string; carretas: number } | null>(() => {
    const otras = (this.data()?.ubicaciones ?? []).filter((u) => u.familia !== 'ubicacion' && u.familia !== 'legado');
    if (!otras.length) return null;
    const carretas = otras.filter((u) => u.familia === 'carreta').length;
    const resto = otras.length - carretas;
    const partes: string[] = [];
    if (carretas) partes.push(`${carretas} ${carretas === 1 ? 'carreta' : 'carretas'}`);
    if (resto) partes.push(`${resto} sin pasillo ni rack`);
    return { texto: `Este almacén tiene ${partes.join(' y ')} fuera del mapa: no se dibujan porque no tienen lugar en la cuadrícula.`, carretas };
  });

  readonly leyenda = computed<Array<{ estado: EstadoRack; label: string; icono?: string }>>(() => {
    const presentes = new Set<EstadoRack>();
    for (const f of this.filas()) for (const c of f.celdas) presentes.add(c.estado);
    const todas: Array<{ estado: EstadoRack; label: string; icono?: string }> = [
      { estado: 'activa', label: 'Dada de alta' },
      { estado: 'contenido', label: 'Con mercancía', icono: 'pi-box' },
      { estado: 'bloqueada', label: 'Bloqueada', icono: 'pi-ban' },
      { estado: 'baja', label: 'Dada de baja', icono: 'pi-minus' },
      { estado: 'vacio', label: 'Sin dar de alta' },
    ];
    return todas.filter((l) => presentes.has(l.estado));
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const r = this.data()?.resumen;
    const enMapa = this.enMapa();
    const recorrible = this.recorrible();
    const zona = this.zona() === 'B' ? 'bodega' : 'tienda';
    const otra = this.cuentaZona(this.zona() === 'B' ? 'T' : 'B');
    const conProducto = recorrible.filter((u) => u.productos_asignados > 0).length;
    const bloqueadas = recorrible.filter((u) => u.estado === 'bloqueada').length;
    const conMercancia = recorrible.filter((u) => u.renglones_con_cantidad > 0).length;
    if (!r) return [];
    const items: MetricStripItem[] = [
      {
        label: `Ubicaciones en ${zona}`,
        value: enMapa.length,
        sub: otra > 0 ? `y ${otra} en ${zona === 'bodega' ? 'tienda' : 'bodega'}` : 'las que recorre este mapa',
      },
      { label: 'Con producto asignado', value: conProducto, sub: conProducto ? `de ${recorrible.length} a la vista` : 'nadie tiene lugar fijo todavía' },
    ];
    // [UB.RF.17] ADR-056: si el acomodo con escaneo nunca escribió en este almacén, el cero NO se
    // publica como un hecho de la operación. Medido el 2026-11-25: una sola fila en todo prod.
    items.push(
      r.contenido_medido
        ? { label: 'Con mercancía', value: conMercancia, sub: 'acomodada con escaneo' }
        : {
            label: 'Con mercancía',
            value: 'sin medir',
            format: 'text',
            state: 'no_medido',
            stateNote: 'El acomodo con escaneo todavía no registra nada en este almacén, así que no hay con qué decir cuántas tienen mercancía.',
          },
    );
    if (bloqueadas > 0) items.push({ label: 'Bloqueadas', value: bloqueadas, tone: 'bad', sub: 'no se sugieren' });
    if (r.legado > 0) items.push({ label: 'Código libre', value: r.legado, tone: 'warn', sub: 'sin el formato BA053' });
    return items;
  });

  readonly codigo = signal('');
  readonly tipo = signal<LocationKind | null>(null);
  readonly creando = signal(false);
  readonly crearErr = signal<string | null>(null);
  readonly creada = signal<string | null>(null);
  readonly parsed = computed(() => parseLocationCode(this.codigo()));

  /** `[GP.11.5]` Liberar a mano una carreta con pedido es del coordinador de surtido. */
  readonly puedeCoordinar = computed(
    () => this.perms.isAdmin() || !!this.auth.user()?.permissions?.[Permission.ALMACEN_SURTIDO_COORDINAR],
  );
  readonly puedeGestionar = computed(
    () => this.perms.isAdmin() || !!this.auth.user()?.permissions?.[Permission.ALMACEN_UBICACIONES_GESTIONAR],
  );

  readonly almacenOpts = computed(() =>
    (this.data()?.alcance.almacenes ?? []).map((w) => ({ label: w.name, value: w.id })) /* [UB.RF.7] por nombre */,
  );

  /**
   * `[UB.RF.19]` El almacén del alcance que SÍ tiene productos ubicados, cuando el que se está viendo
   * no tiene ninguno. Sale de `alcance.almacenes`, que ya trae el conteo de cada uno.
   *
   * Es el agujero que se midió el 2026-11-25: quien no tiene almacén en su ficha abre en el primero por
   * código (CEDIS, 375 ubicaciones y **0 productos**), lee «no hay nada» y concluye que se perdió lo que
   * acababa de guardar — en Padre Hidalgo. Terminó en cinco intentos de dar de alta una que ya existía.
   */
  readonly otroConTrabajo = computed(() => elAlmacenQueSiTieneTrabajo(this.data()?.alcance.almacenes ?? [], this.data()?.warehouse?.id ?? null));

  private readonly conFormato = computed(() => (this.data()?.ubicaciones ?? []).filter((u) => u.familia === 'ubicacion'));
  readonly legado = computed(() => (this.data()?.ubicaciones ?? []).filter((u) => u.familia === 'legado'));

  /** Columnas: del rack 1 al mayor que exista en la zona (los huecos se ven como "sin dar de alta"). */
  /**
   * `[UB.RF.18]` Un pasillo por bloque, y **cada bloque con sus dos frentes** enfrentados. Cada pasillo
   * usa sólo las columnas que necesita: uno de 6 racks ya no arrastra las 25 columnas del más largo.
   */
  readonly pasillos = computed<PasilloMapa[]>(() => armarPasillos(this.conFormato(), this.zona()));

  /** Los frentes en una sola lista, en el orden en que se recorren: es lo que mueven las flechas. */
  readonly filas = computed<Fila[]>(() => this.pasillos().flatMap((p) => [p.nones, p.pares]));

  // ── `[UB.PL]` El croquis: el mapa dibuja la tienda que es, no una rejilla ──────────────────
  readonly croquis = signal<CroquisResponse | null>(null);
  readonly acomodando = signal(false);
  readonly croquisErr = signal<string | null>(null);

  /** Las piezas de la zona que se está mirando, ya acomodadas en el croquis. */
  private readonly piezasDeZona = computed(() => (this.croquis()?.piezas ?? []).filter((p) => p.zona === this.zona()));
  readonly piezasAcomodadas = computed(() => this.piezasDeZona().filter((p) => p.fila != null && p.columna != null));
  readonly piezasSinLugar = computed(() => this.piezasDeZona().filter((p) => p.fila == null || p.columna == null));
  /** Hay croquis cuando alguien ya acomodó al menos una pieza: si no, se dibuja el mapa de siempre. */
  readonly hayCroquis = computed(() => this.piezasAcomodadas().length > 0);

  /**
   * El croquis en renglones: cada uno con sus piezas en orden de columna, y cada pieza con los
   * frentes que ya arma `armarPasillos` (por su letra). Así el dibujo sale de **dónde está cada
   * mueble**, no de suponer que todo es un pasillo.
   */
  readonly nombresSinLugar = computed(() => this.piezasSinLugar().map((p) => nombrePieza(p)).join(', '));

  /** `[UB.PL.2]` Configura el croquis a partir de lo que ya existe. No crea ni borra ubicaciones. */
  configurarCroquis(): void {
    const w = this.warehouseId();
    if (!w) return;
    this.croquisErr.set(null);
    this.api.derivarPiezas(w).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.cargarCroquis(),
      error: (e: HttpErrorResponse) => {
        const m = e.error?.message;
        this.croquisErr.set(typeof m === 'string' ? m : 'No se pudo configurar el croquis.');
      },
    });
  }

  private cargarCroquis(): void {
    const w = this.warehouseId();
    if (!w) return;
    this.api.croquis(w, this.zona()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (c) => this.croquis.set(c),
      // Sin croquis la pantalla sigue sirviendo: se dibuja el mapa por pasillos de siempre.
      error: () => this.croquis.set(null),
    });
  }

  readonly filasDelCroquis = computed<FilaCroquis[]>(() => {
    const porPasillo = new Map(this.pasillos().map((p) => [p.pasillo, p]));
    const porFila = new Map<number, PiezaEnCroquis[]>();
    for (const pieza of this.piezasAcomodadas()) {
      const bloque = pieza.pasillo ? porPasillo.get(pieza.pasillo) ?? null : null;
      const lista = porFila.get(pieza.fila as number) ?? [];
      lista.push({ pieza, bloque, nombre: nombrePieza(pieza), dosFrentes: FIXTURE_KINDS[pieza.tipo]?.dosFrentes ?? false });
      porFila.set(pieza.fila as number, lista);
    }
    return [...porFila.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([fila, piezas]) => ({ fila, piezas: piezas.sort((a, b) => (a.pieza.columna ?? 0) - (b.pieza.columna ?? 0)) }));
  });

  ngOnInit(): void {
    this.reload();
  }

  reload(): void {
    const folio = ++this.consulta;
    this.loading.set(true);
    this.err.set(null);
    this.api.list(this.warehouseId()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        if (folio !== this.consulta) return;
        // [UB.RF.7] Sin elección en esta pantalla, abre el almacén que eligió en Asignación o Contenido
        // (si está en su alcance); antes abría siempre el que proponía el servidor.
        if (!this.warehouseId() && d.warehouse) {
          const elegido = elegirAlmacen(d.alcance.almacenes, d.warehouse.id);
          if (elegido && elegido !== d.warehouse.id) { this.warehouseId.set(elegido); this.reload(); return; }
        }
        this.data.set(d);
        if (!this.warehouseId() && d.warehouse) this.warehouseId.set(d.warehouse.id);
        // [UB.RF.5] Si la zona elegida está vacía y la otra no, se abre en la que tiene ubicaciones: CEDIS
        // abría en «Bodega (0)» con sus 375 en Tienda, y la persona leía «no hay» (medido 2026-11-17).
        const z = zonaConUbicaciones(this.zona(), this.cuentaZona('B'), this.cuentaZona('T'));
        if (z !== this.zona()) this.pickZona(z);
        this.cargarCroquis();
        this.refrescarSel();
        this.foco.set({ fi: 0, ci: 0 });
        this.loading.set(false);
      },
      error: (e: HttpErrorResponse) => {
        if (folio !== this.consulta) return;
        this.loading.set(false);
        const m = e.error?.message;
        this.err.set(typeof m === 'string' ? `No se pudieron cargar las ubicaciones: ${m}` : 'No se pudieron cargar las ubicaciones.');
      },
    });
  }

  verCarretas(si: boolean): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { vista: si ? 'carretas' : null }, queryParamsHandling: 'merge' });
  }

  /**
   * `[UB.RF.17]` Abre Asignación, que es donde se le pone lugar a un producto.
   *
   * ⚠️ Deuda con nombre: todavía **sin el rack filtrado**. El filtro `?rack=TA01` existe en el backend
   * sólo dentro de `[UB.RF.15]`, que vive sin commitear en el checkout compartido; mandarlo igual haría
   * que la pantalla dijera «sólo los de este rack» mostrando los 86,619 del catálogo. Cuando `[UB.RF.15]`
   * entre al repo, esto vuelve a llevar el rack y el botón puede decir «ver sus N productos».
   */
  verAsignacion(): void {
    void this.router.navigate(['/almacen/ubicaciones/asignacion']);
  }

  verCaptura(si: boolean): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { vista: si ? 'captura' : null }, queryParamsHandling: 'merge' });
  }

  pickAlmacen(id: string): void {
    this.warehouseId.set(id);
    guardarAlmacenPreferido(id); // [UB.RF.7]
    this.sel.set(null);
    this.reload();
  }

  pickZona(z: LocationZone): void {
    this.zona.set(z);
    this.sel.set(null);
    this.foco.set({ fi: 0, ci: 0 });
  }

  pickRack(pasillo: string, celda: Celda, fi: number, ci: number): void {
    this.foco.set({ fi, ci });
    this.sel.set(this.selKey() === pasillo + celda.rack ? null : { pasillo, celda });
  }

  esFoco(fi: number, ci: number): boolean {
    const f = this.foco();
    return f.fi === fi && f.ci === ci;
  }

  /**
   * Flechas: izquierda y derecha mueven por el frente; arriba y abajo **cruzan el corredor** y pasan
   * al pasillo siguiente. Inicio/Fin, a los extremos del frente. Enter y Espacio los da el botón.
   *
   * `[UB.RF.18]` Cada frente tiene su propio largo (un pasillo de 6 racks y otro de 25), así que el
   * tope de columnas se lee de la fila a la que se va, no de un máximo global: si no, la flecha dejaba
   * el foco en una celda que no existe y no se veía dónde quedó.
   */
  onGridKey(ev: KeyboardEvent): void {
    const filas = this.filas();
    if (!filas.length) return;
    let { fi, ci } = this.foco();
    const cols = (i: number) => filas[i]?.celdas.length ?? 0;
    if (!cols(fi)) return;
    switch (ev.key) {
      case 'ArrowRight': ci = Math.min(cols(fi) - 1, ci + 1); break;
      case 'ArrowLeft': ci = Math.max(0, ci - 1); break;
      case 'ArrowDown': fi = Math.min(filas.length - 1, fi + 1); break;
      case 'ArrowUp': fi = Math.max(0, fi - 1); break;
      case 'Home': ci = 0; break;
      case 'End': ci = cols(fi) - 1; break;
      default: return;
    }
    ci = Math.min(ci, Math.max(0, cols(fi) - 1));
    ev.preventDefault();
    this.foco.set({ fi, ci });
    this.host.nativeElement.querySelector<HTMLButtonElement>(`[data-pos="${fi}-${ci}"]`)?.focus();
  }

  /** Tras recargar, el rack elegido se vuelve a leer de los datos nuevos (si no, mostraría niveles viejos). */
  private refrescarSel(): void {
    const s = this.sel();
    if (!s) return;
    const fila = this.filas().find((f) => f.pasillo === s.pasillo);
    const celda = fila?.celdas.find((c) => c.rack === s.celda.rack);
    this.sel.set(celda ? { pasillo: s.pasillo, celda } : null);
  }

  cuentaZona(z: LocationZone): number {
    return this.conFormato().filter((u) => u.zona === z && u.estado !== 'baja').length;
  }

  onCodigo(v: string): void {
    this.codigo.set(v);
    this.crearErr.set(null);
    this.creada.set(null);
  }

  ayudaCodigo(): string {
    const p = this.parsed();
    if (!this.codigo()) return 'Zona (T/B) · pasillo · rack 01–99 · nivel 1–6. Ejemplo: BA053.';
    return p.ok ? describeLocationCode(p.parts) : p.motivo;
  }

  crear(): void {
    const p = this.parsed();
    const w = this.warehouseId();
    if (!p.ok || !w || this.creando()) return;
    this.creando.set(true);
    this.crearErr.set(null);
    this.api.create({ warehouse_id: w, code: p.code, tipo: this.tipo() }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (row) => {
        this.creando.set(false);
        this.creada.set(row.code);
        this.codigo.set('');
        // Si la nueva es de la otra zona, el rack elegido ya no corresponde: se limpia.
        if (row.zona && row.zona !== this.zona()) this.pickZona(row.zona);
        this.reload();
      },
      error: (e: HttpErrorResponse) => {
        this.creando.set(false);
        const m = e.error?.message;
        this.crearErr.set(typeof m === 'string' ? m : 'No se pudo dar de alta la ubicación.');
      },
    });
  }

  dos(n: number): string {
    return String(n).padStart(2, '0');
  }
  /** `[UB.RF.18]` El frente y el rack de enfrente, los dos deducidos del número: no hay nada que capturar. */
  cara(rack: number): RackFace {
    return rackFace(rack);
  }
  opuesto(rack: number): number {
    return rackOpuesto(rack);
  }
  tipoLabel(t: LocationKind | null): string {
    return t ? LOCATION_KINDS.find((k) => k.key === t)?.label ?? t : 'sin tipo';
  }
  estadoTxt(e: string): string {
    return e === 'activa' ? 'Activa' : e === 'bloqueada' ? 'Bloqueada' : 'Baja';
  }
}

/** El estado más urgente de los niveles de un rack (bloqueada > con mercancía > activa > baja > vacío). */
/**
 * `[UB.RF.10]` Los carteles a imprimir: los de la zona (y, si se pide, de un pasillo, un rack o un solo
 * código), sin los dados de baja, en el orden en que se recorre el almacén. El rótulo es corto a
 * propósito: el código ya dice pasillo y rack, y en el cartel cabe una línea.
 */
/** `[UB.RF.12]` Lo que se imprime por omisión en cada zona: tienda → etiqueta chica; bodega → cartel. */
export function formatoPorZona(zona: LocationZone): FormatoCartel {
  return zona === 'T' ? 'etiqueta' : 'cartel';
}

export function cartelesDe(
  ubicaciones: WarehouseLocationRow[],
  f: { zona: LocationZone; pasillo?: string | null; rack?: number | null; code?: string },
  almacen: string | null,
): CartelUbicacion[] {
  return ubicaciones
    .filter((u) => u.estado !== 'baja' && u.zona === f.zona)
    .filter((u) => (f.code ? u.code === f.code : true))
    .filter((u) => (f.pasillo ? u.pasillo === f.pasillo : true))
    .filter((u) => (f.rack != null ? u.rack === f.rack : true))
    .sort((a, b) => aisleOrder(a.pasillo ?? '') - aisleOrder(b.pasillo ?? '') || (a.rack ?? 0) - (b.rack ?? 0) || (a.nivel ?? 0) - (b.nivel ?? 0))
    .map((u) => ({ code: u.code, label: `${u.zona === 'T' ? 'Tienda' : 'Bodega'} · nivel ${u.nivel ?? '—'}`, almacen }));
}

/**
 * `[UB.RF.5]` La zona en la que abre el mapa: la elegida, salvo que esté vacía y la otra no. Un almacén
 * con todas sus ubicaciones en Tienda no debe abrir diciendo «no hay» en Bodega.
 */
export function zonaConUbicaciones(actual: LocationZone, enBodega: number, enTienda: number): LocationZone {
  const deActual = actual === 'B' ? enBodega : enTienda;
  const deOtra = actual === 'B' ? enTienda : enBodega;
  return deActual === 0 && deOtra > 0 ? (actual === 'B' ? 'T' : 'B') : actual;
}

/** Un almacén del alcance, con cuánto trabajo tiene. */
type AlmacenDelAlcance = { id: string; name: string; con_producto: number };

/**
 * `[UB.RF.19]` El almacén que SÍ tiene productos ubicados, cuando el que se está viendo no tiene
 * ninguno. `null` si el de aquí ya tiene, o si ningún otro tiene (entonces no hay nada que ofrecer).
 *
 * El agujero que cierra, medido el 2026-11-25: quien no tiene almacén en su ficha abre en el primero
 * por código —CEDIS, con 375 ubicaciones y **0 productos**—, lee «no hay nada» y concluye que se perdió
 * lo que acababa de guardar, que estaba en Padre Hidalgo. Terminó en cinco intentos de dar de alta una
 * ubicación que ya existía.
 */
export function elAlmacenQueSiTieneTrabajo<T extends AlmacenDelAlcance>(todos: readonly T[], aqui: string | null): T | null {
  const actual = todos.find((w) => w.id === aqui);
  if (!aqui || !actual || actual.con_producto > 0) return null;
  return [...todos].filter((w) => w.id !== aqui && w.con_producto > 0).sort((a, b) => b.con_producto - a.con_producto)[0] ?? null;
}

/**
 * `[UB.RF.18]` Arma el mapa de una zona: **un bloque por pasillo, con sus dos frentes**.
 *
 * Un pasillo es un corredor y tiene racks de los dos lados (Edgar, 2026-11-25): los nones de uno y los
 * pares del otro. La columna `k` son los racks `2k-1` y `2k`, que con los dos frentes parejos quedan
 * uno enfrente del otro. Cada pasillo usa sólo las columnas que necesita, así que uno de 6 racks ya no
 * arrastra las 25 columnas del más largo.
 *
 * `fi` es la posición del frente en la lista plana: es con lo que se mueven las flechas.
 */
export function armarPasillos(conFormato: WarehouseLocationRow[], zona: LocationZone): PasilloMapa[] {
  const deZona = conFormato.filter((u) => u.zona === zona);
  const nombres = [...new Set(deZona.map((u) => u.pasillo as string))].sort((a, b) => aisleOrder(a) - aisleOrder(b));
  let fi = 0;
  return nombres.map((pasillo) => {
    const suyas = deZona.filter((u) => u.pasillo === pasillo);
    const columnas = Math.ceil(Math.max(0, ...suyas.map((u) => u.rack ?? 0)) / 2);
    const frente = (cara: RackFace): Fila => ({
      pasillo,
      cara,
      fi: fi++,
      celdas: Array.from({ length: columnas }, (_, k) => {
        const rack = cara === 'nones' ? 2 * k + 1 : 2 * k + 2;
        const niveles = suyas.filter((u) => u.rack === rack).sort((a, b) => (a.nivel ?? 0) - (b.nivel ?? 0));
        const estado = estadoDeRack(niveles);
        const productos = productosDeRack(niveles);
        return { rack, estado, niveles, productos, aria: ariaDeRack(pasillo, rack, estado, niveles.length, productos) };
      }),
    });
    return { pasillo, columnas, nones: frente('nones'), pares: frente('pares') };
  });
}

/**
 * `[UB.RF.17]` Productos con lugar asignado en el rack, sin contar los niveles dados de baja (un lugar
 * en una ubicación retirada no es un lugar). Es lo que el mapa pinta.
 */
export function productosDeRack(niveles: WarehouseLocationRow[]): number {
  return niveles.reduce((n, u) => n + (u.estado === 'baja' ? 0 : u.productos_asignados), 0);
}

/**
 * `[UB.RF.17]` Lo que oye quien no ve el cuadro. Dice las tres cosas que el ojo saca del mapa —estado,
 * cuántos niveles y cuántos productos— porque el color no es portador de nada por sí solo.
 */
export function ariaDeRack(pasillo: string, rack: number, estado: EstadoRack, niveles: number, productos: number): string {
  // [UB.RF.18] El frente va en el aria: sin ver el dibujo, «A05» no dice de qué lado del corredor está.
  const code = `${pasillo}${String(rack).padStart(2, '0')}, frente de ${rackFace(rack)}`;
  if (estado === 'vacio') return `Rack ${code}, ${ESTADO_LABEL.vacio}`;
  const cuantos = `${niveles} ${niveles === 1 ? 'nivel' : 'niveles'}`;
  const conProducto = productos === 0 ? 'sin productos asignados' : `${productos} ${productos === 1 ? 'producto asignado' : 'productos asignados'}`;
  return `Rack ${code}, ${ESTADO_LABEL[estado]}, ${cuantos}, ${conProducto}`;
}

export function estadoDeRack(niveles: WarehouseLocationRow[]): EstadoRack {
  if (!niveles.length) return 'vacio';
  if (niveles.some((n) => n.estado === 'bloqueada')) return 'bloqueada';
  if (niveles.some((n) => n.estado !== 'baja' && n.renglones_con_cantidad > 0)) return 'contenido';
  if (niveles.some((n) => n.estado === 'activa')) return 'activa';
  return 'baja';
}
