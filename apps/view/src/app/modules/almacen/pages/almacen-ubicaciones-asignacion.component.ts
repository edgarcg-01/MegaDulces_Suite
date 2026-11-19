import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Location } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { Subject, debounceTime, firstValueFrom, map } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import {
  describeLocationCode,
  parseLocationCode,
  type AssignmentRole,
  type ProductAssignment,
  type ProductLocationDetail,
  type ProductLocationFilter,
  type ProductLocationRow,
  type ProductLocationsList,
  type ProductPresentation,
  type WarehouseLocationRow,
} from '@megadulces/contracts';
import { Permission } from '../../../core/constants/permissions';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { UsoService } from '../../../core/services/uso.service';
import { AlmacenUbicacionesCatalogoService } from '../almacen-ubicaciones-catalogo.service';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { UbicacionesAsignacionExcelComponent } from '../components/ubicaciones-asignacion-excel.component';
import {
  clasificarLectura,
  lugaresEnPalabras,
  papelLabel,
  papelParaUbicacion,
  presentacionDeLectura,
  presentacionParaLugar,
  tipoLabel,
  tipoPorDefecto,
  type LugarEnPalabras,
} from '../components/ubicaciones-censo.logica';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { elegirAlmacen, guardarAlmacenPreferido } from '../shared/almacen-preferido';

const PAGINA = 50;

/** Un `<input type="number">` con ngModel entrega number, null o '' — nunca se asume string. */
type Cantidad = string | number | null;
interface Edicion { id: string; code: string; min: Cantidad; max: Cantidad }
type Deshacer = { tipo: 'quitar'; id: string } | { tipo: 'volver'; id: string; code: string };
interface Aviso { tono: 'ok' | 'mal' | 'info'; texto: string; deshacer?: Deshacer }
/** Lo asignado escaneando en una ubicación de trabajo («Aquí»), para verlo y quitarlo en el acto. */
interface Hecho { id: string; code: string; sku: string; nombre: string; rotulo: string | null }
/** Una ubicación que no existe: se crea y después se hace lo que se iba a hacer con ella. */
interface PorCrear { code: string; luego: 'aqui' | 'asignar' }
/** Un renglón de la presentación: un papel y sus asignaciones (vacío = «falta»). */
interface FilaPapel { papel: AssignmentRole; etiqueta: string; asignaciones: ProductAssignment[] }

/**
 * `[UB.RF.11]` Ubicar productos — la Asignación rehecha desde cero (FASE_UB §8.2, maqueta aprobada por
 * Edgar el 2026-11-19: «generémosla desde 0, práctica y lo más accesible para el usuario»).
 *
 * Lo que la motivó, medido en prod ese día: la pantalla decía «0 % ya ubicado» con 8 productos ya
 * puestos en tienda (sólo contaba el lugar de surtido en bodega), el camino a mano no creaba la
 * ubicación que faltaba (Padre Hidalgo no tenía ninguna de bodega) y 6 de 17 asignaciones se
 * rechazaron sin dejar su motivo.
 *
 * UN campo arriba, para lector, cámara-teclado o dedos:
 * - un **producto** abre su ficha; con una ubicación de trabajo («Aquí: BA053») se asigna ahí;
 * - una **ubicación** con un producto abierto le da ese lugar; sin producto, queda como «Aquí» y cada
 *   producto que se escanee después va a ella (el censo de UB.3b, ya sin ser «otra vista»).
 * El papel sale de la ubicación (B de surtido → lugar fijo, B de reserva → reserva, T → tienda) y la
 * presentación del código de barras o de lo que la persona señaló. Si la ubicación no existe, se crea
 * en el acto. Cada guardado se confirma con «Deshacer»; cada rechazo deja su motivo (incidente).
 *
 * La lista va por venta de 30 días (lo más vendido primero) y cada tarjeta dice en palabras dónde está
 * el producto: «Tienda TA011 · Bodega falta».
 */
@Component({
  selector: 'app-almacen-ubicaciones-asignacion',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ButtonModule, SelectModule, InputTextModule, SegmentedComponent, UbicacionesAsignacionExcelComponent, LoadStateComponent, MetricStripComponent, FreshnessPillComponent],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head ub-head">
        <div class="ub-head-text">
          <h1>Ubicar productos</h1>
          <!-- fetch y no data: dice cuándo llegó la lista, no promete la edad del ODS. -->
          <app-freshness-pill measures="fetch" [since]="cargadoEn()" />
        </div>
        @if (almacenOpts().length > 1) {
          <label class="ub-f ub-alm" for="ub-alm"><span class="ub-l">Almacén</span>
            <p-select inputId="ub-alm" [options]="almacenOpts()" optionLabel="label" optionValue="value" [ngModel]="warehouseId()" (onChange)="pickAlmacen($event.value)" appendTo="body" />
          </label>
        } @else if (almacen(); as w) {
          <span class="ub-meta">{{ w.name }}</span>
        }
      </header>

      @if (sinAlmacen()) {
        <div class="ub-note ub-note-bad" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span>Tu ficha no tiene un almacén asignado. Pide que te lo asignen en <b>Administración › Personas</b>.</span></div>
      } @else if (enExcel() && almacen()) {
        <button pButton type="button" class="p-button-sm p-button-text ub-volver" (click)="verExcel(false)"><span class="p-button-icon pi pi-arrow-left" aria-hidden="true"></span><span class="p-button-label">Ubicar productos</span></button>
        <app-ubicaciones-asignacion-excel [warehouse]="almacen()!" (cambio)="cargarLista()" />
      } @else {
        <!-- EL campo: producto o ubicación. El lector «teclea» y manda Enter. -->
        <form class="ub-campo" role="search" (ngSubmit)="leer()">
          <label class="ub-l ub-l-campo" for="ub-in">{{ rotuloCampo() }}</label>
          <div class="ub-campo-row">
            <input #campo pInputText id="ub-in" name="lectura" class="ub-in" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="go"
              [ngModel]="entrada()" (ngModelChange)="onEntrada($event)" aria-describedby="ub-ayuda" />
            <button pButton type="submit" class="ub-go"><span class="p-button-label">{{ ocupado() ? 'Guardando…' : 'Listo' }}</span></button>
          </div>
          <p id="ub-ayuda" class="ub-sub">{{ ayudaCampo() }}</p>
        </form>

        @if (aqui(); as u) {
          <section class="ub-aqui" aria-labelledby="ub-h-aqui">
            <div class="ub-aqui-top">
              <span class="ub-aqui-code mono">{{ u.code }}</span>
              <span class="ub-aqui-txt"><b id="ub-h-aqui">Aquí: {{ descripcionUbic(u) }}</b><br>{{ papelDeAqui() }}</span>
              <button pButton type="button" class="p-button-sm p-button-text p-button-secondary ub-tap" (click)="soltarAqui()"><span class="p-button-label">Terminar aquí</span></button>
            </div>
            @if (hechosAqui().length) {
              <ul class="ub-hechos" aria-label="Asignados aquí">
                @for (h of hechosAqui(); track h.id) {
                  <li><span class="ub-hecho-nom">{{ h.nombre }} <span class="mono ub-sub">{{ h.sku }}{{ h.rotulo ? ' · ' + h.rotulo : '' }}</span></span>
                    <button pButton type="button" class="p-button-sm p-button-text p-button-secondary ub-tap" [attr.aria-label]="'Quitar ' + h.nombre + ' de ' + h.code" [disabled]="ocupado()" (click)="quitarHecho(h)"><span class="p-button-label">Quitar</span></button></li>
                }
              </ul>
            }
          </section>
        }

        @if (porCrear(); as c) {
          <div class="ub-accion" role="group" aria-label="Ubicación que no existe">
            <span><b class="mono">{{ c.code }}</b> no existe en {{ almacen()?.name }}.</span>
            <span class="ub-btns">
              <button pButton type="button" class="p-button-sm ub-tap" [loading]="ocupado()" (click)="crear(c)"><span class="p-button-label">{{ c.luego === 'asignar' ? 'Crear ' + c.code + ' y asignar' : 'Crear ' + c.code }}</span></button>
              <button pButton type="button" class="p-button-sm p-button-text p-button-secondary ub-tap" (click)="cancelarAccion()"><span class="p-button-label">Cancelar</span></button>
            </span>
          </div>
        }
        @if (elegir(); as e) {
          <div class="ub-accion" role="group" [attr.aria-label]="'¿Qué presentación de ' + e.detalle.product.nombre + '?'">
            <span><b>{{ e.detalle.product.nombre }}</b> en <b class="mono">{{ e.ubic.code }}</b>: ¿qué presentación?</span>
            <span class="ub-btns">
              @for (p of e.opciones; track p.peldano) {
                <button pButton type="button" class="p-button-sm p-button-outlined ub-tap" (click)="elegirPresentacion(e.detalle, p.peldano, e.ubic)"><span class="p-button-label">{{ p.rotulo || 'Presentación ' + p.peldano }}</span></button>
              }
              <button pButton type="button" class="p-button-sm p-button-text p-button-secondary ub-tap" (click)="cancelarAccion()"><span class="p-button-label">Cancelar</span></button>
            </span>
          </div>
        }
        @if (mover(); as m) {
          <div class="ub-accion" role="group" aria-label="Ya tiene ese lugar en otra ubicación">
            <span><b>{{ m.detalle.product.nombre }}</b> · {{ m.asignacion.presentacion_rotulo || 'presentación ' + m.asignacion.presentacion }} ya tiene {{ papelTexto(m.asignacion.papel) }} en <b class="mono">{{ m.asignacion.code }}</b>.</span>
            <span class="ub-btns">
              <button pButton type="button" class="p-button-sm ub-tap" [loading]="ocupado()" (click)="moverA(m.detalle, m.asignacion, m.ubic)"><span class="p-button-label">Moverlo a {{ m.ubic.code }}</span></button>
              <button pButton type="button" class="p-button-sm p-button-text p-button-secondary ub-tap" (click)="cancelarAccion()"><span class="p-button-label">Dejarlo en {{ m.asignacion.code }}</span></button>
            </span>
          </div>
        }

        <!-- Una sola región viva, siempre presente: lo que pasó con la última lectura. -->
        <p class="ub-msg" [class.ub-ok]="aviso()?.tono === 'ok'" [class.ub-mal]="aviso()?.tono === 'mal'" aria-live="polite">
          @if (aviso(); as a) {
            @if (a.tono === 'ok') { <i class="pi pi-check" aria-hidden="true"></i> } @else if (a.tono === 'mal') { <i class="pi pi-times-circle" aria-hidden="true"></i> }
            <span>{{ a.texto }}</span>
            @if (a.deshacer && puedeGestionar()) { <button type="button" class="ub-link ub-tap" [disabled]="ocupado()" (click)="deshacer(a.deshacer)">Deshacer</button> }
          }
        </p>

        @if (modo() === 'producto') {
          <section class="ub-prod" aria-labelledby="ub-h-prod">
            <button pButton type="button" class="p-button-sm p-button-text ub-volver ub-tap" (click)="volverALista()"><span class="p-button-icon pi pi-arrow-left" aria-hidden="true"></span><span class="p-button-label">{{ tituloLista() }}</span></button>
            @if (cargandoDet()) {
              <div class="ub-skel" aria-busy="true"><span class="sr-only">Leyendo el producto…</span></div>
            } @else if (det(); as d) {
              <span class="ub-sub mono">{{ d.product.sku }}</span>
              <h2 id="ub-h-prod" class="ub-h2">{{ d.product.nombre }}</h2>
              @if (d.presentaciones.length > 1) { <p class="ub-sub">{{ escalera(d) }}</p> }
              @if (d.aviso) { <p class="ub-aviso" role="note">{{ d.aviso }}</p> }
              @if (!d.presentaciones.length) {
                <p class="ub-note ub-note-bad">Este producto no tiene ficha en Kepler de {{ d.warehouse.name }}: no hay presentaciones que ubicar.</p>
              }
              @for (p of d.presentaciones; track p.peldano) {
                <div class="ub-pres" role="group" [attr.aria-labelledby]="'ub-pres-' + p.peldano">
                  <h3 class="ub-pres-h" [id]="'ub-pres-' + p.peldano"><span class="ub-pres-r">{{ p.rotulo || 'Presentación ' + p.peldano }}</span><span class="ub-sub">{{ explicaFactor(p, d) }}</span></h3>
                  @for (f of filasDe(d, p); track f.papel) {
                    <div class="ub-lugar">
                      <span class="ub-lugar-l">{{ f.etiqueta + ' ' }}</span>
                      @for (a of f.asignaciones; track a.id) {
                        @if (edicion()?.id === a.id) {
                          <form class="ub-edit" (ngSubmit)="guardarEdicion(a)">
                            <label class="ub-f"><span class="ub-l">Ubicación</span><input pInputText class="mono" name="code" autocapitalize="characters" [ngModel]="edicion()!.code" (ngModelChange)="setEdicion('code', $event)" maxlength="8" /></label>
                            <label class="ub-f"><span class="ub-l">Mínimo ({{ p.rotulo }})</span><input pInputText type="number" inputmode="numeric" min="0" class="mono" name="min" [ngModel]="edicion()!.min" (ngModelChange)="setEdicion('min', $event)" /></label>
                            <label class="ub-f"><span class="ub-l">Máximo ({{ p.rotulo }})</span><input pInputText type="number" inputmode="numeric" min="0" class="mono" name="max" [ngModel]="edicion()!.max" (ngModelChange)="setEdicion('max', $event)" /></label>
                            <span class="ub-btns">
                              <button pButton type="button" class="p-button-sm p-button-text p-button-secondary ub-tap" (click)="edicion.set(null)"><span class="p-button-label">Cancelar</span></button>
                              <button pButton type="submit" class="p-button-sm ub-tap" [loading]="ocupado()"><span class="p-button-label">Guardar</span></button>
                            </span>
                          </form>
                        } @else {
                          <span class="ub-lugar-v"><b class="mono">{{ a.code }}</b>
                            <span class="ub-sub">{{ minMax(a, p) }}@if (a.estado !== 'activa') { · <b class="ub-bad">{{ a.estado === 'baja' ? 'dada de baja' : 'bloqueada' }}</b> }</span></span>
                          @if (puedeGestionar()) {
                            <span class="ub-btns">
                              @if (quitar() === a.id) {
                                <span class="ub-sub">¿Quitar {{ a.code }}?</span>
                                <button pButton type="button" class="p-button-sm p-button-text p-button-secondary ub-tap" (click)="quitar.set(null)"><span class="p-button-label">No</span></button>
                                <button pButton type="button" class="p-button-sm p-button-outlined p-button-danger ub-tap" [attr.aria-label]="'Sí, quitar ' + a.code" [loading]="ocupado()" (click)="confirmarQuitar(a)"><span class="p-button-label">Sí, quitar</span></button>
                              } @else {
                                <button pButton type="button" class="p-button-sm p-button-text p-button-secondary ub-tap" [attr.aria-label]="'Cambiar ' + a.code" (click)="editar(a)"><span class="p-button-label">Cambiar</span></button>
                                <button pButton type="button" class="p-button-sm p-button-text p-button-secondary ub-tap" [attr.aria-label]="'Quitar ' + a.code" (click)="quitar.set(a.id)"><span class="p-button-label">Quitar</span></button>
                              }
                            </span>
                          }
                        }
                      } @empty {
                        <span class="ub-falta">falta</span>
                        @if (puedeGestionar()) {
                          <button pButton type="button" class="p-button-sm p-button-outlined ub-tap ub-poner" [attr.aria-label]="'Poner lugar de ' + f.etiqueta.toLowerCase() + ' al ' + (p.rotulo || 'producto')" (click)="senalar(p, f.papel)"><span class="p-button-label">Poner lugar</span></button>
                        }
                      }
                    </div>
                  }
                </div>
              }
              @if (huerfanas(d).length) {
                <div class="ub-pres" role="group" aria-labelledby="ub-h-huerf">
                  <h3 class="ub-pres-h" id="ub-h-huerf"><span class="ub-bad">Ya no está en Kepler</span><span class="ub-sub">Asignada a una presentación que Kepler ya no tiene aquí. Quítala y, si hace falta, ubica la vigente.</span></h3>
                  @for (a of huerfanas(d); track a.id) {
                    <div class="ub-lugar">
                      <span class="ub-lugar-l">{{ papelTexto(a.papel) }}</span>
                      <span class="ub-lugar-v"><b class="mono">{{ a.code }}</b><span class="ub-sub">se guardó como {{ a.presentacion_rotulo || 'presentación ' + a.presentacion }}</span></span>
                      @if (puedeGestionar()) {
                        <span class="ub-btns">
                          @if (quitar() === a.id) {
                            <button pButton type="button" class="p-button-sm p-button-text p-button-secondary ub-tap" (click)="quitar.set(null)"><span class="p-button-label">No</span></button>
                            <button pButton type="button" class="p-button-sm p-button-outlined p-button-danger ub-tap" [attr.aria-label]="'Sí, quitar ' + a.code" [loading]="ocupado()" (click)="confirmarQuitar(a)"><span class="p-button-label">Sí, quitar</span></button>
                          } @else {
                            <button pButton type="button" class="p-button-sm p-button-text p-button-secondary ub-tap" [attr.aria-label]="'Quitar ' + a.code" (click)="quitar.set(a.id)"><span class="p-button-label">Quitar</span></button>
                          }
                        </span>
                      }
                    </div>
                  }
                </div>
              }
            } @else if (errDet(); as e) {
              <p class="ub-note ub-note-bad" role="alert">{{ e }}</p>
            }
          </section>
        } @else {
          <app-load-state [loading]="!lista() && !err()" [error]="err()" errorTitle="No se pudo cargar la lista" [isEmpty]="false" (retry)="reintentar()">
            @if (lista(); as l) {
              @if (!l.ficha_kepler) {
                <div class="ub-note" role="note"><i class="pi pi-info-circle" aria-hidden="true"></i><span>{{ l.warehouse?.name }} no tiene fichas de Kepler (es sólo Wincaja o una ruta): no hay productos que ubicar aquí.</span></div>
              } @else {
                @if (l.ubicaciones_bodega === 0 && puedeGestionar()) {
                  <div class="ub-note" role="note"><i class="pi pi-info-circle" aria-hidden="true"></i><span>{{ l.warehouse?.name }} todavía no tiene ubicaciones de bodega. Escanea o escribe una (empiezan con B, como BA053) y se crea al asignarla.</span></div>
                }
                <section class="ub-lista" aria-labelledby="ub-h-lista">
                  <h2 id="ub-h-lista" class="ub-h2">{{ tituloLista() }}</h2>
                  <!-- La respuesta primero, con rótulos que dicen lo que cuentan: tienda Y bodega (antes, «0 % ya ubicado»). -->
                  <app-metric-strip [items]="kpis()" density="compact" ariaLabel="Avance de la ubicación" />
                  <p class="ub-avance">{{ avance(l) }}</p>
                  <app-segmented [options]="filtros()" [value]="filtro()" (valueChange)="pickFiltro($any($event))" ariaLabel="Qué productos ver" />
                  <ul class="ub-cards">
                    @for (r of filas(); track r.product_id) {
                      <li>
                        <button type="button" class="ub-card" (click)="abrir(r)">
                          <span class="ub-card-nom">{{ r.nombre + ' ' }}</span>
                          <span class="ub-card-sku mono">{{ r.sku + ' ' }}</span>
                          <span class="ub-card-lugares">
                            <!-- Con espacios y « · » de verdad en el texto: un lector de pantalla no lee «TA011Bodega». -->
                            @for (x of lugaresDe(r); track x.etiqueta; let ultimo = $last) {
                              <span class="ub-card-lugar">{{ x.etiqueta + ' ' }}@if (x.valor) { <b class="mono">{{ x.valor }}</b> } @else { <span class="ub-falta">falta</span> }{{ ultimo ? '' : ' · ' }}</span>
                            }
                          </span>
                        </button>
                      </li>
                    } @empty {
                      <li class="ub-empty"><span>{{ vacioTexto(l) }}</span>@if (q() || filtro() !== 'sin_ubicacion') { <button type="button" class="ub-link ub-tap" (click)="limpiar()">Ver los que faltan por ubicar</button> }</li>
                    }
                  </ul>
                  @if (filas().length && filas().length < l.total) {
                    <button pButton type="button" class="p-button-sm p-button-outlined ub-mas ub-tap" [loading]="cargandoMas()" (click)="verMas()"><span class="p-button-label">Ver más · van {{ fmt(filas().length) }} de {{ fmt(l.total) }}</span></button>
                  } @else if (filas().length) {
                    <p class="ub-sub ub-fin">Son todos: {{ fmt(l.total) }}.</p>
                  }
                </section>
              }
            }
          </app-load-state>
        }

        @if (puedeGestionar() && almacen()) {
          <nav class="ub-mas-nav" aria-label="Más formas de ubicar">
            <span class="ub-sub">Más:</span>
            <button type="button" class="ub-link ub-tap" (click)="verExcel(true)">Ubicar muchos desde Excel</button>
            <button type="button" class="ub-link ub-tap" (click)="irAlMapa()">Mapa de ubicaciones</button>
          </nav>
        }
      }
    </div>
  `,
  styles: [`
    :host { display:block; container-type:inline-size; }
    /* Angosta (celular, o el panel con el menú abierto): los botones de un lugar bajan a su renglón. */
    @container (max-width: 26rem) {
      .ub-lugar .ub-btns, .ub-poner { margin-left:0; flex-basis:100%; }
      .ub-go { min-width:4.5rem; }
    }
    .ub-head { display:flex; justify-content:space-between; align-items:flex-end; gap:.5rem 1rem; flex-wrap:wrap; margin-bottom:.75rem; }
    .ub-head-text { display:flex; flex-wrap:wrap; align-items:baseline; gap:.35rem .75rem; min-width:0; }
    .ub-head-text h1 { margin:0; font-size:var(--fs-h2); font-weight:700; letter-spacing:-.01em; }
    .ub-meta { font-size:var(--fs-sm); color:var(--text-muted); }
    .ub-f { display:flex; flex-direction:column; gap:.2rem; }
    .ub-l { font-size:var(--fs-sm); font-weight:600; color:var(--text-main); }
    :host ::ng-deep .ub-alm .p-select { min-width:12rem; }
    /* El campo: lo primero y lo más grande de la pantalla. */
    .ub-campo { display:flex; flex-direction:column; gap:.3rem; margin-bottom:.5rem; }
    .ub-l-campo { font-size:var(--fs-body); }
    .ub-campo-row { display:flex; gap:.5rem; }
    .ub-in { flex:1 1 auto; min-width:0; min-height:3rem; font-size:var(--fs-lg); font-family:var(--font-mono); letter-spacing:.02em; }
    .ub-go { min-height:3rem; min-width:5.5rem; }
    .ub-sub { font-size:var(--fs-sm); color:var(--text-muted); margin:0; }
    .ub-tap { min-height:2.75rem; }
    @media (pointer: fine) { .ub-tap { min-height:2.25rem; } }
    .ub-aqui { border:2px solid var(--text-main); border-radius:var(--r-md); background:var(--card-bg); padding:.6rem .75rem; margin-bottom:.5rem; }
    .ub-aqui-top { display:flex; align-items:center; gap:.5rem .9rem; flex-wrap:wrap; }
    .ub-aqui-code { font-size:2rem; font-weight:800; line-height:1; }
    .ub-aqui-txt { flex:1 1 12rem; font-size:var(--fs-sm); color:var(--text-muted); line-height:1.4; }
    .ub-aqui-txt b { color:var(--text-main); }
    .ub-hechos { list-style:none; margin:.5rem 0 0; padding:0; }
    .ub-hechos li { display:flex; justify-content:space-between; align-items:center; gap:.5rem; padding:.3rem 0; border-top:1px solid var(--border-color); }
    .ub-hecho-nom { font-size:var(--fs-sm); font-weight:600; min-width:0; overflow-wrap:anywhere; }
    .ub-accion { display:flex; flex-wrap:wrap; align-items:center; gap:.5rem 1rem; padding:.6rem .75rem; margin-bottom:.5rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); font-size:var(--fs-body); }
    .ub-btns { display:inline-flex; flex-wrap:wrap; align-items:center; gap:.35rem; }
    /* La región viva tiene su alto reservado: un aviso no empuja la lista (CLS). */
    .ub-msg { min-height:1.75rem; margin:0 0 .5rem; display:flex; flex-wrap:wrap; align-items:center; gap:.4rem; font-size:var(--fs-body); font-weight:600; color:var(--text-main); }
    .ub-ok { color:var(--ok-soft-fg); }
    .ub-mal { color:var(--bad-fg); }
    .ub-link { background:none; border:0; padding:0 .25rem; color:var(--action); cursor:pointer; font:inherit; font-weight:600; text-decoration:underline; }
    .ub-link:focus-visible, .ub-card:focus-visible { outline:2px solid var(--action); outline-offset:2px; }
    .ub-note { display:flex; gap:.5rem; align-items:flex-start; padding:.6rem .8rem; margin:0 0 .6rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); font-size:var(--fs-sm); }
    .ub-note-bad { border-left:3px solid var(--bad-fg); }
    .ub-h2 { margin:0; font-size:var(--fs-h3); font-weight:700; }
    .ub-avance { margin:.15rem 0 .5rem; font-size:var(--fs-sm); color:var(--text-main); }
    .ub-cards { list-style:none; margin:.6rem 0 0; padding:0; display:grid; grid-template-columns:repeat(auto-fill, minmax(min(100%, 20rem), 1fr)); gap:.5rem; }
    .ub-card { width:100%; min-height:3.5rem; display:flex; flex-direction:column; align-items:flex-start; gap:.15rem; text-align:left; padding:.6rem .75rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); color:var(--text-main); font:inherit; cursor:pointer; }
    .ub-card:hover { background:var(--hover-bg); }
    .ub-card-nom { font-size:var(--fs-body); font-weight:600; overflow-wrap:anywhere; }
    .ub-card-sku { font-size:var(--fs-sm); color:var(--text-muted); }
    .ub-card-lugares { display:flex; flex-wrap:wrap; gap:.15rem .9rem; font-size:var(--fs-sm); color:var(--text-muted); }
    .ub-card-lugar b { color:var(--text-main); }
    .ub-falta { font-weight:600; color:var(--warn-soft-fg); }
    .ub-empty { display:flex; flex-direction:column; align-items:flex-start; gap:.4rem; padding:1rem; color:var(--text-muted); font-size:var(--fs-sm); }
    .ub-mas { margin-top:.6rem; }
    .ub-fin { margin-top:.6rem; }
    .ub-volver { margin-bottom:.4rem; }
    .ub-prod { display:flex; flex-direction:column; gap:.4rem; }
    .ub-skel { height:16rem; border-radius:var(--r-md); background:var(--hover-bg); }
    .ub-aviso { margin:0; font-size:var(--fs-sm); padding:.45rem .6rem; border:1px solid var(--warn-border); border-radius:var(--r-sm); background:var(--warn-soft-bg); color:var(--warn-soft-fg); }
    .ub-pres { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); padding:.6rem .75rem; display:flex; flex-direction:column; gap:.4rem; }
    .ub-pres-h { margin:0; display:flex; flex-wrap:wrap; align-items:baseline; gap:.25rem .6rem; font-size:var(--fs-body); }
    .ub-pres-r { font-weight:700; padding:.05rem .5rem; border:2px solid var(--text-main); border-radius:var(--r-sm); }
    .ub-lugar { display:flex; flex-wrap:wrap; align-items:center; gap:.35rem .75rem; padding:.35rem 0; border-top:1px solid var(--border-color); }
    .ub-lugar-l { min-width:4.5rem; font-size:var(--fs-sm); font-weight:600; color:var(--text-muted); }
    .ub-lugar-v { display:flex; flex-direction:column; min-width:0; font-size:var(--fs-lg); }
    .ub-lugar .ub-btns { margin-left:auto; }
    .ub-poner { margin-left:auto; }
    .ub-edit { display:flex; flex-wrap:wrap; align-items:flex-end; gap:.5rem .6rem; flex:1 1 100%; }
    .ub-edit input { width:7rem; min-height:2.75rem; }
    .ub-bad { color:var(--bad-fg); }
    .ub-mas-nav { display:flex; flex-wrap:wrap; align-items:center; gap:.25rem .75rem; margin-top:1rem; padding-top:.6rem; border-top:1px solid var(--border-color); }
    .mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
    .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); border:0; }
    @media (forced-colors: active) { .ub-falta { text-decoration:underline; } .ub-aqui { border-color:CanvasText; } }
  `],
})
export class AlmacenUbicacionesAsignacionComponent implements OnInit {
  private readonly api = inject(AlmacenUbicacionesCatalogoService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly uso = inject(UsoService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly location = inject(Location);
  private readonly destroyRef = inject(DestroyRef);
  private readonly campo = viewChild<ElementRef<HTMLInputElement>>('campo');
  private readonly q$ = new Subject<string>();

  readonly almacenes = signal<Array<{ id: string; code: string; name: string }>>([]);
  readonly warehouseId = signal<string | null>(null);
  readonly sinAlmacen = signal(false);
  readonly entrada = signal('');
  readonly q = signal('');
  readonly filtro = signal<ProductLocationFilter>('sin_ubicacion');
  readonly lista = signal<ProductLocationsList | null>(null);
  readonly filas = signal<ProductLocationRow[]>([]);
  readonly cargandoMas = signal(false);
  readonly err = signal<string | null>(null);
  readonly cargadoEn = signal<Date | null>(null);
  readonly modo = signal<'lista' | 'producto'>('lista');
  readonly det = signal<ProductLocationDetail | null>(null);
  readonly cargandoDet = signal(false);
  readonly errDet = signal<string | null>(null);
  /** La presentación (y el papel) que la persona señaló con «Poner lugar». */
  readonly senalada = signal<{ peldano: 1 | 2 | 3; papel: AssignmentRole } | null>(null);
  readonly aqui = signal<WarehouseLocationRow | null>(null);
  readonly hechos = signal<Hecho[]>([]);
  readonly aviso = signal<Aviso | null>(null);
  readonly porCrear = signal<PorCrear | null>(null);
  readonly elegir = signal<{ detalle: ProductLocationDetail; opciones: ProductPresentation[]; ubic: WarehouseLocationRow } | null>(null);
  readonly mover = signal<{ detalle: ProductLocationDetail; asignacion: ProductAssignment; ubic: WarehouseLocationRow } | null>(null);
  readonly edicion = signal<Edicion | null>(null);
  readonly quitar = signal<string | null>(null);
  readonly ocupado = signal(false);

  private ubicaciones = new Map<string, WarehouseLocationRow>();
  private cola: string[] = [];
  private folioLista = 0;
  private folioDet = 0;
  private folioAlmacen = 0;
  /** El producto se abrió empujando una entrada al historial: «atrás» del celular regresa a la lista. */
  private productoEnHistorial = false;

  private readonly vista = toSignal(this.route.queryParamMap.pipe(map((m) => m.get('vista'))), { initialValue: null });
  readonly puedeGestionar = computed(() => this.perms.isAdmin() || !!this.auth.user()?.permissions?.[Permission.ALMACEN_UBICACIONES_GESTIONAR]);
  readonly enExcel = computed(() => this.vista() === 'excel' && this.puedeGestionar());
  readonly almacen = computed(() => this.almacenes().find((w) => w.id === this.warehouseId()) ?? null);
  readonly almacenOpts = computed(() => this.almacenes().map((w) => ({ label: w.name, value: w.id })));
  readonly hechosAqui = computed(() => this.hechos().filter((h) => h.code === this.aqui()?.code));

  readonly filtros = computed<SegOption[]>(() => {
    const l = this.lista();
    const n = (v: number) => (l?.ficha_kepler ? ` (${fmt(v)})` : '');
    return [
      { label: `Por ubicar${n(l?.sin_ubicacion ?? 0)}`, value: 'sin_ubicacion' },
      { label: `Con lugar para surtir${n(Math.max(0, (l?.universo ?? 0) - (l?.sin_ubicacion ?? 0)))}`, value: 'con_ubicacion' },
      { label: 'Todos', value: 'todos' },
    ];
  });

  readonly tituloLista = computed(() => {
    const porVenta = this.lista()?.con_venta != null;
    const base = this.filtro() === 'sin_ubicacion' ? 'Por ubicar' : this.filtro() === 'con_ubicacion' ? 'Con lugar para surtir' : 'Todos los productos';
    return porVenta ? `${base} · lo más vendido primero` : base;
  });

  /** El rótulo del campo dice lo que va a pasar con lo que se lea. */
  readonly rotuloCampo = computed(() => {
    const d = this.modo() === 'producto' ? this.det() : null;
    if (this.aqui()) return `Escanea un producto para ponerlo en ${this.aqui()!.code}`;
    if (d && this.puedeGestionar()) {
      const s = this.senalada();
      const p = s ? d.presentaciones.find((x) => x.peldano === s.peldano) : null;
      return p ? `Ubicación para ${p.rotulo || 'esta presentación'} (${papelLabel(s!.papel).toLowerCase()})` : `Ubicación para ${d.product.nombre}, u otro producto`;
    }
    return this.puedeGestionar() ? 'Producto o ubicación' : 'Buscar producto';
  });
  readonly ayudaCampo = computed(() => {
    if (!this.puedeGestionar()) return 'Clave, nombre o código de barras. Para ubicar productos se necesita el permiso de gestionar ubicaciones.';
    if (this.aqui()) return 'Escanea cada producto que está en este lugar. Otra ubicación cambia el lugar.';
    if (this.modo() === 'producto') return 'Escanea el cartel de la ubicación o escribe su código (BA053 bodega, TA011 tienda) y pulsa Listo.';
    return 'Escanea o escribe una clave, un nombre o un código de barras para abrir el producto; o una ubicación (BA053) para ubicar ahí varios.';
  });
  readonly papelDeAqui = computed(() => {
    const u = this.aqui();
    if (!u) return '';
    const p = papelParaUbicacion(u);
    return 'papel' in p ? `Lo que escanees queda como ${papelLabel(p.papel).toLowerCase()}.` : p.motivo;
  });

  readonly fmt = fmt;

  ngOnInit(): void {
    // Teclear filtra la lista (con pausa); Enter procesa la lectura. Una ubicación no filtra.
    this.q$.pipe(debounceTime(350), takeUntilDestroyed(this.destroyRef)).subscribe((v) => {
      const t = v.trim();
      if (clasificarLectura(t).tipo === 'ubicacion' || this.modo() === 'producto' || this.aqui()) return;
      if (t === this.q()) return;
      this.q.set(t);
      this.cargarLista();
    });
    // «Atrás» del celular con un producto abierto: la URL deja de nombrarlo y se vuelve a la lista.
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((m) => {
      if (!m.get('producto') && this.modo() === 'producto' && this.productoEnHistorial) {
        this.productoEnHistorial = false;
        this.cerrarProducto();
      }
    });
    this.cargarAlmacenes();
  }

  // ── Almacén, lista y ubicaciones ────────────────────────────────────────────────────────────

  reintentar(): void {
    if (this.warehouseId()) this.cargarLista();
    else this.cargarAlmacenes();
  }

  private cargarAlmacenes(): void {
    this.err.set(null);
    this.api.list(null).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.almacenes.set(d.alcance.almacenes);
        if (!d.warehouse) { this.sinAlmacen.set(true); return; }
        // [UB.RF.7] el almacén que eligió en Mapa o Contenido, si está en su alcance.
        const id = elegirAlmacen(d.alcance.almacenes, d.warehouse.id) ?? d.warehouse.id;
        this.warehouseId.set(id);
        if (id === d.warehouse.id) this.ubicaciones = new Map(d.ubicaciones.map((u) => [u.code, u]));
        else this.cargarUbicaciones(id);
        this.cargarLista();
        this.enfocar();
      },
      error: (e: HttpErrorResponse) => this.err.set(mensaje(e, 'No se pudo cargar el almacén.')),
    });
  }

  private cargarUbicaciones(id: string): void {
    const folio = this.folioAlmacen;
    this.api.list(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { if (folio === this.folioAlmacen) this.ubicaciones = new Map(r.ubicaciones.map((u) => [u.code, u])); },
      error: () => undefined, // sin el mapa, «no existe» lo dice el servidor al asignar
    });
  }

  pickAlmacen(id: string): void {
    this.warehouseId.set(id);
    guardarAlmacenPreferido(id); // [UB.RF.7]
    this.folioAlmacen++;
    this.folioDet++;
    this.ubicaciones = new Map();
    this.cargarUbicaciones(id);
    this.soltarAqui();
    this.cancelarAccion();
    this.aviso.set(null);
    this.cerrarProducto();
    this.cargarLista();
  }

  cargarLista(): void {
    const w = this.warehouseId();
    if (!w) return;
    const folio = ++this.folioLista;
    this.err.set(null);
    this.api.products(w, { q: this.q(), filtro: this.filtro(), orden: 'venta', limit: PAGINA, offset: 0 }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (l) => {
        if (folio !== this.folioLista) return;
        this.lista.set(l);
        this.filas.set(l.filas);
        this.cargadoEn.set(new Date());
      },
      error: (e: HttpErrorResponse) => { if (folio === this.folioLista) this.err.set(mensaje(e, 'No se pudieron cargar los productos.')); },
    });
  }

  /** La página siguiente se AGREGA: el total que se publica se puede recorrer completo (Cruce 1). */
  verMas(): void {
    const w = this.warehouseId();
    if (!w || this.cargandoMas()) return;
    const folio = this.folioLista;
    this.cargandoMas.set(true);
    this.api.products(w, { q: this.q(), filtro: this.filtro(), orden: 'venta', limit: PAGINA, offset: this.filas().length }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (l) => {
        this.cargandoMas.set(false);
        if (folio !== this.folioLista) return;
        const ya = new Set(this.filas().map((f) => f.product_id));
        this.filas.update((f) => [...f, ...l.filas.filter((x) => !ya.has(x.product_id))]);
      },
      error: (e: HttpErrorResponse) => { this.cargandoMas.set(false); this.aviso.set({ tono: 'mal', texto: mensaje(e, 'No se pudieron leer más productos.') }); },
    });
  }

  pickFiltro(f: ProductLocationFilter): void { this.filtro.set(f); this.cargarLista(); }
  limpiar(): void { this.q.set(''); this.entrada.set(''); this.filtro.set('sin_ubicacion'); this.cargarLista(); }

  /** Las cifras de arriba: cuentan sobre el universo (lo que coincide con la búsqueda), no sobre la página. */
  readonly kpis = computed<MetricStripItem[]>(() => {
    const l = this.lista();
    if (!l?.ficha_kepler) return [];
    const con = Math.max(0, l.universo - l.sin_ubicacion);
    return [
      { label: 'Con lugar para surtir', value: con, sub: 'en bodega' },
      { label: 'Con lugar en tienda', value: l.con_tienda, sub: 'exhibición' },
      l.con_venta == null
        ? { label: 'Se venden aquí', value: 'sin dato', format: 'text' as const, sub: 'sin venta registrada', state: 'no_medido' as const, stateNote:'La sucursal no tiene venta registrada en 30 días: la lista va por nombre.' }
        : { label: 'Se vendieron en 30 días', value: l.con_venta, sub: 'van primero' },
    ];
  });

  /** La línea dice el universo de las cifras: de cuántos productos y por qué orden. */
  avance(l: ProductLocationsList): string {
    const de = this.q() ? `De ${fmt(l.universo)} productos que coinciden` : `De ${fmt(l.universo)} productos de ${l.warehouse?.name ?? 'la sucursal'}`;
    const orden = l.con_venta == null ? 'sin venta registrada aquí: van por nombre' : 'van primero los que más se vendieron en los últimos 30 días';
    return `${de}; ${orden}.`;
  }
  vacioTexto(l: ProductLocationsList): string {
    if (this.q()) return `Ningún producto coincide con «${this.q()}» en ${l.warehouse?.name ?? 'este almacén'}.`;
    return this.filtro() === 'sin_ubicacion' ? 'Todos tienen lugar para surtir.' : 'Ninguno todavía.';
  }
  lugaresDe(r: ProductLocationRow): LugarEnPalabras[] { return lugaresEnPalabras(r.lugares ?? []); }

  // ── El campo ────────────────────────────────────────────────────────────────────────────────

  onEntrada(v: string): void {
    this.entrada.set(v);
    this.q$.next(v);
  }

  enfocar(): void {
    queueMicrotask(() => this.campo()?.nativeElement.focus());
  }

  /**
   * Enter (lector o teclado): una ubicación o un producto. Lo leído entra a una FILA y el campo se vacía
   * al instante: un lector rápido no pierde lecturas ni las pega a la anterior mientras se guarda.
   */
  leer(): void {
    const raw = this.entrada().trim();
    this.entrada.set('');
    this.enfocar();
    if (!raw) return;
    this.cola.push(raw);
    void this.procesarCola();
  }

  private async procesarCola(): Promise<void> {
    if (this.ocupado()) return;
    const raw = this.cola.shift();
    if (raw === undefined) return;
    this.cancelarAccion();
    const l = clasificarLectura(raw);
    this.ocupado.set(true);
    try {
      if (l.tipo === 'ubicacion') await this.leerUbicacion(l.code);
      else if (l.tipo === 'producto') await this.leerProducto(l.texto);
    } finally {
      this.ocupado.set(false);
      this.enfocar();
    }
    void this.procesarCola();
  }

  private async leerUbicacion(code: string): Promise<void> {
    if (!this.puedeGestionar()) { this.aviso.set({ tono: 'info', texto: `${code} es una ubicación. Para ubicar productos se necesita el permiso de gestionar ubicaciones.` }); return; }
    const u = this.ubicaciones.get(code);
    const conProducto = this.modo() === 'producto' && !!this.det() && !this.aqui();
    if (!u) {
      this.porCrear.set({ code, luego: conProducto ? 'asignar' : 'aqui' });
      this.aviso.set(null);
      return;
    }
    if (conProducto) await this.asignarAlAbierto(u);
    else this.fijarAqui(u);
  }

  private async leerProducto(texto: string): Promise<void> {
    const w = this.warehouseId();
    if (!w) return;
    let lista: ProductLocationsList;
    try {
      lista = await firstValueFrom(this.api.products(w, { q: texto, filtro: 'todos', orden: 'venta', limit: 5, offset: 0 }));
    } catch (e) {
      this.aviso.set({ tono: 'mal', texto: mensaje(e as HttpErrorResponse, 'No se pudo buscar el producto.') });
      return;
    }
    const exacto = lista.filas.filter((f) => f.sku.toUpperCase() === texto.toUpperCase());
    const filas = exacto.length === 1 ? exacto : lista.filas;
    if (!filas.length) { this.aviso.set({ tono: 'mal', texto: `No encontré «${texto}» en ${this.almacen()?.name ?? 'este almacén'}.` }); return; }
    if (filas.length > 1) {
      // Varios: la lista los muestra y la persona toca el suyo.
      this.aviso.set({ tono: 'info', texto: `«${texto}» coincide con ${fmt(lista.total)} productos: toca el tuyo o escanea su código de barras.` });
      this.q.set(texto);
      this.filtro.set('todos');
      if (this.modo() === 'producto') this.volverALista();
      this.cargarLista();
      return;
    }
    const detalle = await this.leerDetalle(filas[0].product_id);
    if (!detalle) return;
    if (this.aqui()) { await this.asignarEnAqui(detalle, texto); return; }
    this.abrirDetalle(detalle, texto);
  }

  // ── Producto abierto ────────────────────────────────────────────────────────────────────────

  abrir(r: ProductLocationRow): void {
    void this.leerDetalle(r.product_id).then((d) => { if (d) this.abrirDetalle(d, null); });
  }

  private async leerDetalle(productId: string): Promise<ProductLocationDetail | null> {
    const w = this.warehouseId();
    if (!w) return null;
    const folio = ++this.folioDet;
    this.cargandoDet.set(true);
    this.errDet.set(null);
    try {
      const d = await firstValueFrom(this.api.productDetail(w, productId));
      if (folio !== this.folioDet) return null;
      return d;
    } catch (e) {
      if (folio === this.folioDet) this.aviso.set({ tono: 'mal', texto: mensaje(e as HttpErrorResponse, 'No se pudo leer el producto.') });
      return null;
    } finally {
      if (folio === this.folioDet) this.cargandoDet.set(false);
    }
  }

  /** Abre el producto. Si se leyó su código de barras, esa presentación queda señalada. */
  private abrirDetalle(d: ProductLocationDetail, lectura: string | null): void {
    this.det.set(d);
    this.edicion.set(null);
    this.quitar.set(null);
    const p = lectura ? presentacionDeLectura(d, lectura) : null;
    const porCodigo = p && 'peldano' in p && d.presentaciones.length > 1 && d.presentaciones.some((x) => x.codigos.some((c) => c.toUpperCase() === lectura!.trim().toUpperCase()));
    this.senalada.set(porCodigo ? { peldano: p.peldano, papel: 'surtido_fijo' } : null);
    if (this.modo() !== 'producto') {
      this.modo.set('producto');
      if (this.route.snapshot.queryParamMap.get('producto') !== d.product.id) {
        this.productoEnHistorial = true;
        void this.router.navigate([], { relativeTo: this.route, queryParams: { producto: d.product.id }, queryParamsHandling: 'merge' });
      }
    }
    this.aviso.set({ tono: 'info', texto: `${d.product.nombre}: ${this.puedeGestionar() ? 'escanea o escribe su ubicación.' : 'esto es lo que tiene.'}` });
    // Lo tecleado para encontrarlo ya cumplió: al volver, la lista es otra vez la de «por ubicar».
    if (this.q()) { this.q.set(''); this.filtro.set('sin_ubicacion'); this.cargarLista(); }
    this.enfocar();
  }

  volverALista(): void {
    if (this.productoEnHistorial) {
      this.productoEnHistorial = false;
      this.location.back();
    } else if (this.route.snapshot.queryParamMap.get('producto')) {
      void this.router.navigate([], { relativeTo: this.route, queryParams: { producto: null }, queryParamsHandling: 'merge', replaceUrl: true });
    }
    this.cerrarProducto();
  }

  private cerrarProducto(): void {
    this.folioDet++;
    this.modo.set('lista');
    this.det.set(null);
    this.cargandoDet.set(false);
    this.senalada.set(null);
    this.edicion.set(null);
    this.quitar.set(null);
    this.cancelarAccion();
    this.enfocar();
  }

  senalar(p: ProductPresentation, papel: AssignmentRole): void {
    this.senalada.set({ peldano: p.peldano, papel });
    this.aviso.set({ tono: 'info', texto: `Escanea o escribe la ubicación de ${papel === 'exhibicion_tienda' ? 'tienda' : 'bodega'} para ${p.rotulo || 'esta presentación'}.` });
    this.enfocar();
  }

  /** Los renglones de una presentación: tienda y bodega siempre (si falta, se dice); reserva si tiene. */
  filasDe(d: ProductLocationDetail, p: ProductPresentation): FilaPapel[] {
    const de = (papel: AssignmentRole) => d.asignaciones.filter((a) => a.presentacion === p.peldano && a.papel === papel);
    const filas: FilaPapel[] = [
      { papel: 'exhibicion_tienda', etiqueta: 'Tienda', asignaciones: de('exhibicion_tienda') },
      { papel: 'surtido_fijo', etiqueta: 'Bodega', asignaciones: de('surtido_fijo') },
    ];
    const reserva = de('reserva_preferida');
    if (reserva.length) filas.push({ papel: 'reserva_preferida', etiqueta: 'Reserva', asignaciones: reserva });
    return filas;
  }

  /** Asignaciones cuya presentación ya no está en la escalera de Kepler: se ven y se pueden quitar. */
  huerfanas(d: ProductLocationDetail): ProductAssignment[] {
    const vivos = new Set(d.presentaciones.map((p) => p.peldano));
    return d.asignaciones.filter((a) => !vivos.has(a.presentacion));
  }

  // ── Asignar ─────────────────────────────────────────────────────────────────────────────────

  private async asignarAlAbierto(u: WarehouseLocationRow): Promise<void> {
    const d = this.det();
    if (!d) return;
    const papel = papelParaUbicacion(u);
    if (!('papel' in papel)) { this.aviso.set({ tono: 'mal', texto: papel.motivo }); return; }
    if (!d.presentaciones.length) { this.aviso.set({ tono: 'mal', texto: `${d.product.nombre} no tiene ficha en Kepler aquí: no hay presentación que ubicar.` }); return; }
    const pres = presentacionParaLugar(d, papel.papel, this.senalada()?.peldano ?? null);
    if ('opciones' in pres) { this.elegir.set({ detalle: d, opciones: pres.opciones, ubic: u }); return; }
    await this.asignar(d, pres.peldano, papel.papel, u);
  }

  private async asignarEnAqui(d: ProductLocationDetail, lectura: string): Promise<void> {
    const u = this.aqui()!;
    const papel = papelParaUbicacion(u);
    if (!('papel' in papel)) { this.aviso.set({ tono: 'mal', texto: papel.motivo }); return; }
    if (!d.presentaciones.length) { this.aviso.set({ tono: 'mal', texto: `${d.product.nombre} no tiene ficha en Kepler aquí: no hay presentación que ubicar.` }); return; }
    const pres = presentacionDeLectura(d, lectura);
    if ('opciones' in pres) { this.elegir.set({ detalle: d, opciones: pres.opciones, ubic: u }); return; }
    await this.asignar(d, pres.peldano, papel.papel, u);
  }

  elegirPresentacion(d: ProductLocationDetail, peldano: 1 | 2 | 3, u: WarehouseLocationRow): void {
    const papel = papelParaUbicacion(u);
    this.elegir.set(null);
    if (!('papel' in papel)) return;
    this.ocupado.set(true);
    void this.asignar(d, peldano, papel.papel, u).finally(() => { this.ocupado.set(false); this.enfocar(); });
  }

  private async asignar(d: ProductLocationDetail, peldano: 1 | 2 | 3, papel: AssignmentRole, u: WarehouseLocationRow): Promise<void> {
    const rotulo = d.presentaciones.find((p) => p.peldano === peldano)?.rotulo ?? null;
    const que = `${d.product.nombre} · ${rotulo ?? 'presentación ' + peldano}`;
    if (d.asignaciones.some((a) => a.presentacion === peldano && a.papel === papel && a.code === u.code)) {
      this.aviso.set({ tono: 'ok', texto: `${que} ya estaba en ${u.code}.` });
      return;
    }
    // Lugar fijo y reserva son uno por presentación: si ya tiene otro, se ofrece moverlo (no se duplica).
    const otra = papel !== 'exhibicion_tienda' ? d.asignaciones.find((a) => a.presentacion === peldano && a.papel === papel) : undefined;
    if (otra) { this.mover.set({ detalle: d, asignacion: otra, ubic: u }); return; }
    try {
      const a = await firstValueFrom(this.api.createAssignment({ warehouse_id: d.warehouse.id, product_id: d.product.id, presentacion: peldano, papel, bin_code: u.code }));
      this.senalada.set(null);
      if (this.aqui()?.code === u.code) this.hechos.update((l) => [{ id: a.id, code: u.code, sku: d.product.sku, nombre: d.product.nombre, rotulo }, ...l.filter((x) => x.id !== a.id)]);
      this.aviso.set({ tono: 'ok', texto: `${que} en ${papel === 'exhibicion_tienda' ? 'tienda' : papel === 'surtido_fijo' ? 'bodega' : 'reserva'} ${u.code}.`, deshacer: { tipo: 'quitar', id: a.id } });
      this.trasGuardar(d.product.id);
    } catch (e) {
      this.rechazo('asignar', e, { code: u.code, papel, presentacion: peldano });
    }
  }

  async moverA(d: ProductLocationDetail, a: ProductAssignment, u: WarehouseLocationRow): Promise<void> {
    this.ocupado.set(true);
    try {
      const r = await firstValueFrom(this.api.updateAssignment(a.id, { bin_code: u.code }));
      this.mover.set(null);
      if (this.aqui()?.code === u.code) this.hechos.update((l) => [{ id: r.id, code: u.code, sku: d.product.sku, nombre: d.product.nombre, rotulo: a.presentacion_rotulo }, ...l.filter((x) => x.id !== r.id)]);
      this.aviso.set({ tono: 'ok', texto: `${d.product.nombre} se movió de ${a.code} a ${u.code}.`, deshacer: { tipo: 'volver', id: r.id, code: a.code } });
      this.trasGuardar(d.product.id);
    } catch (e) {
      this.rechazo('mover', e, { code: u.code, papel: a.papel, presentacion: a.presentacion });
    } finally {
      this.ocupado.set(false);
      this.enfocar();
    }
  }

  /** Crea la ubicación que no existía y sigue con lo que se iba a hacer (asignar o fijar «Aquí»). */
  async crear(c: PorCrear): Promise<void> {
    const w = this.warehouseId();
    const p = parseLocationCode(c.code);
    if (!w || !p.ok) return;
    this.ocupado.set(true);
    try {
      const u = await firstValueFrom(this.api.create({ warehouse_id: w, code: c.code, tipo: tipoPorDefecto(p.parts.zona) }));
      this.ubicaciones.set(u.code, u);
      this.porCrear.set(null);
      if (c.luego === 'asignar' && this.det()) {
        this.aviso.set({ tono: 'ok', texto: `${u.code} quedó creada.` });
        await this.asignarAlAbierto(u);
      } else {
        this.fijarAqui(u);
        this.aviso.set({ tono: 'ok', texto: `${u.code} quedó creada. Escanea los productos que están ahí.` });
      }
      this.cargarLista();
    } catch (e) {
      this.rechazo('crear_ubicacion', e, { code: c.code });
    } finally {
      this.ocupado.set(false);
      this.enfocar();
    }
  }

  private fijarAqui(u: WarehouseLocationRow): void {
    const p = papelParaUbicacion(u);
    if (!('papel' in p)) { this.aviso.set({ tono: 'mal', texto: p.motivo }); return; }
    if (this.modo() === 'producto') this.volverALista();
    this.aqui.set(u);
    this.aviso.set({ tono: 'info', texto: `Aquí: ${u.code}. Escanea los productos que están ahí.` });
  }

  soltarAqui(): void {
    this.aqui.set(null);
    this.hechos.set([]);
    this.enfocar();
  }

  cancelarAccion(): void {
    this.porCrear.set(null);
    this.elegir.set(null);
    this.mover.set(null);
  }

  async deshacer(x: Deshacer): Promise<void> {
    const productId = this.det()?.product.id ?? null;
    this.ocupado.set(true);
    try {
      if (x.tipo === 'quitar') {
        await firstValueFrom(this.api.removeAssignment(x.id));
        this.hechos.update((l) => l.filter((h) => h.id !== x.id));
        this.aviso.set({ tono: 'info', texto: 'Listo: se deshizo.' });
      } else {
        await firstValueFrom(this.api.updateAssignment(x.id, { bin_code: x.code }));
        this.hechos.update((l) => l.filter((h) => h.id !== x.id));
        this.aviso.set({ tono: 'info', texto: `Listo: regresó a ${x.code}.` });
      }
      this.trasGuardar(productId);
    } catch (e) {
      this.rechazo('deshacer', e, {});
    } finally {
      this.ocupado.set(false);
      this.enfocar();
    }
  }

  async quitarHecho(h: Hecho): Promise<void> {
    await this.deshacer({ tipo: 'quitar', id: h.id });
  }

  // ── Cambiar y quitar desde el producto ──────────────────────────────────────────────────────

  editar(a: ProductAssignment): void {
    this.quitar.set(null);
    this.edicion.set({ id: a.id, code: a.code, min: a.min_qty == null ? '' : String(a.min_qty), max: a.max_qty == null ? '' : String(a.max_qty) });
  }
  setEdicion<K extends keyof Edicion>(k: K, v: Edicion[K]): void { this.edicion.update((e) => (e ? { ...e, [k]: v } : e)); }

  async guardarEdicion(a: ProductAssignment): Promise<void> {
    const e = this.edicion();
    const d = this.det();
    if (!e || !d || this.ocupado()) return;
    this.ocupado.set(true);
    try {
      const cuerpo = { ...(e.code.trim().toUpperCase() !== a.code ? { bin_code: e.code.trim() } : {}), min_qty: vacio(e.min), max_qty: vacio(e.max) };
      await firstValueFrom(this.api.updateAssignment(a.id, cuerpo));
      this.edicion.set(null);
      this.aviso.set({ tono: 'ok', texto: 'Cambio guardado.' });
      this.trasGuardar(d.product.id);
    } catch (err) {
      this.rechazo('cambiar', err, { code: e.code, papel: a.papel, presentacion: a.presentacion });
    } finally {
      this.ocupado.set(false);
    }
  }

  async confirmarQuitar(a: ProductAssignment): Promise<void> {
    const d = this.det();
    if (!d || this.ocupado()) return;
    this.ocupado.set(true);
    try {
      await firstValueFrom(this.api.removeAssignment(a.id));
      this.quitar.set(null);
      this.aviso.set({ tono: 'ok', texto: `Se quitó de ${a.code}.` });
      this.trasGuardar(d.product.id);
    } catch (e) {
      this.quitar.set(null);
      this.rechazo('quitar', e, { code: a.code, papel: a.papel, presentacion: a.presentacion });
    } finally {
      this.ocupado.set(false);
    }
  }

  /** Tras guardar: el producto abierto se relee y la lista también (sus cifras y la tarjeta cambiaron). */
  private trasGuardar(productId: string | null): void {
    if (productId && this.modo() === 'producto' && this.det()?.product.id === productId) {
      void this.leerDetalle(productId).then((d) => { if (d) this.det.set(d); });
    }
    this.cargarLista();
  }

  /**
   * Un rechazo se dice en palabras Y deja su motivo en el canal de incidentes. Medido el 2026-11-19: 6 de
   * 17 asignaciones de ese día se rechazaron y el motivo no quedó en ningún lado.
   */
  private rechazo(accion: string, e: unknown, extra: Record<string, unknown>): void {
    const err = e as HttpErrorResponse;
    const texto = mensaje(err, 'No se pudo guardar.');
    this.aviso.set({ tono: 'mal', texto });
    this.uso.reportarIncidente('ubicar_rechazado', { accion, status: Number(err?.status ?? 0) || 0, motivo: texto.slice(0, 300), warehouse_id: this.warehouseId(), ...extra });
  }

  // ── Textos ──────────────────────────────────────────────────────────────────────────────────

  verExcel(si: boolean): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { vista: si ? 'excel' : null }, queryParamsHandling: 'merge' });
  }
  irAlMapa(): void { void this.router.navigate(['/almacen/ubicaciones']); }

  papelTexto(p: AssignmentRole): string { return papelLabel(p).toLowerCase(); }
  descripcionUbic(u: WarehouseLocationRow): string {
    const p = parseLocationCode(u.code);
    return `${p.ok ? describeLocationCode(p.parts) : u.code} · ${tipoLabel(u.tipo).toLowerCase()}`;
  }
  /** «1 CJA = 32 PAQ». */
  escalera(d: ProductLocationDetail): string {
    const base = d.presentaciones.find((x) => x.peldano === 1)?.rotulo ?? 'base';
    return d.presentaciones.filter((p) => p.peldano !== 1).map((p) => (p.factor == null ? `${p.rotulo ?? '?'}: Kepler no dice cuántas trae` : `1 ${p.rotulo ?? '?'} = ${fmt(p.factor)} ${base}`)).join(' · ');
  }
  explicaFactor(p: ProductPresentation, d: ProductLocationDetail): string {
    if (p.peldano === 1) return 'la presentación base';
    if (p.factor == null) return 'Kepler no dice cuántas trae';
    const base = d.presentaciones.find((x) => x.peldano === 1)?.rotulo ?? 'base';
    return `trae ${fmt(p.factor)} ${base}${p.fuente === 'derivado_del_costo' ? ' (calculado del costo)' : ''}`;
  }
  minMax(a: ProductAssignment, p: ProductPresentation): string {
    if (a.min_qty == null && a.max_qty == null) return 'sin mínimo ni máximo';
    return `mínimo ${a.min_qty == null ? '—' : fmt(a.min_qty)} · máximo ${a.max_qty == null ? '—' : fmt(a.max_qty)} ${p.rotulo ?? ''}`;
  }
}

const fmt = (n: number) => n.toLocaleString('es-MX', { maximumFractionDigits: 3 });
const vacio = (v: Cantidad): number | null => (v == null || v === '' ? null : Number(v));
function mensaje(e: HttpErrorResponse, fallback: string): string {
  const m = e?.error?.message;
  return typeof m === 'string' ? m : Array.isArray(m) ? m.join(' · ') : fallback;
}
