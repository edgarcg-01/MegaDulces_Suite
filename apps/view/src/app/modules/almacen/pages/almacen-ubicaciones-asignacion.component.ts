import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { Subject, debounceTime, map } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { TableModule, type TableLazyLoadEvent } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import {
  ASSIGNMENT_ROLES,
  parseLocationCode,
  type AssignmentRole,
  type ProductAssignment,
  type ProductLocationDetail,
  type ProductLocationFilter,
  type ProductLocationRow,
  type ProductLocationsList,
  type ProductPresentation,
} from '@megadulces/contracts';
import { Permission } from '../../../core/constants/permissions';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AlmacenUbicacionesCatalogoService } from '../almacen-ubicaciones-catalogo.service';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { UbicacionesAsignacionExcelComponent } from '../components/ubicaciones-asignacion-excel.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';

const PAGINA = 50;
const PAPEL = new Map(ASSIGNMENT_ROLES.map((r) => [r.key, r]));

/** Un `<input type="number">` con ngModel entrega number, null o '' — nunca se asume string. */
type Cantidad = string | number | null;
interface Edicion {
  id: string;
  code: string;
  min: Cantidad;
  max: Cantidad;
}
interface Alta {
  peldano: number;
  papel: AssignmentRole;
  code: string;
  min: Cantidad;
  max: Cantidad;
}

/**
 * `[UB.3]` Asignación por producto y presentación (Fase UB, ADR-090 punto 7, D10).
 *
 * A la izquierda los productos con ficha en Kepler de la sucursal (buscador del servidor, filtro
 * «sin lugar fijo»). A la derecha el producto: sus presentaciones TAL COMO las tiene Kepler en esa
 * sucursal (rótulo, cuántas unidades base trae cada una, códigos de barras) y dónde va cada una:
 * lugar fijo de surtido, exhibición en tienda y reserva preferida, con su mínimo y máximo.
 *
 * El factor no se teclea ni se guarda: se lee de Kepler. Si Kepler no lo tiene se dice «sin factor»,
 * nunca se dibuja 0.
 */
@Component({
  selector: 'app-almacen-ubicaciones-asignacion',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, SelectModule, InputTextModule, TableModule, TagModule, SegmentedComponent, UbicacionesAsignacionExcelComponent, MetricStripComponent, LoadStateComponent, FreshnessPillComponent],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head as-head">
        <div class="as-head-text">
          <h1>Asignación</h1>
          @if (almacen(); as w) { <span class="as-meta">{{ w.name }} · dónde va cada producto, por presentación</span> }
          <!-- fetch y no data: las presentaciones se leen de Kepler al cargar; esto dice cuándo se pidió, no promete la edad del ODS. -->
          <app-freshness-pill measures="fetch" [since]="cargadoEn()" />
        </div>
        <div class="as-actions">
          @if (almacenOpts().length > 1) {
            <p-select [options]="almacenOpts()" optionLabel="label" optionValue="value" [ngModel]="warehouseId()" (onChange)="pickAlmacen($event.value)" ariaLabel="Almacén" appendTo="body" class="as-sel" />
          }
          @if (puedeGestionar() && almacen()) {
            @if (enExcel()) {
              <button pButton type="button" class="p-button-sm p-button-outlined" (click)="verExcel(false)"><span class="p-button-icon pi pi-list" aria-hidden="true"></span><span class="p-button-label">Volver a la lista</span></button>
            } @else {
              <button pButton type="button" class="p-button-sm p-button-outlined" (click)="verExcel(true)"><span class="p-button-icon pi pi-file-excel" aria-hidden="true"></span><span class="p-button-label">Asignar desde Excel</span></button>
            }
          }
        </div>
      </header>

      @if (sinAlmacen()) {
        <div class="as-note as-note-bad" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span>Tu ficha no tiene un almacén asignado. Pide que te lo asignen en <b>Administración › Personas</b>.</span></div>
      } @else if (enExcel() && almacen()) {
        <app-ubicaciones-asignacion-excel [warehouse]="almacen()!" (cambio)="cargarLista()" />
      } @else {
        <app-load-state [loading]="!lista() && !err()" [error]="err()" errorTitle="No se pudo cargar la asignación" [isEmpty]="false" (retry)="reintentar()">
        @if (lista(); as l) {
        @if (!l.ficha_kepler) {
          <div class="as-note" role="note"><i class="pi pi-info-circle" aria-hidden="true"></i><span>{{ l.warehouse?.name }} no tiene fichas de Kepler (es sólo Wincaja o una ruta): no hay presentaciones que asignar aquí.</span></div>
        } @else {
          <!-- La respuesta primero: de lo que hay en Kepler aquí, cuánto ya tiene lugar fijo. -->
          <app-metric-strip [items]="kpis()" ariaLabel="Avance de la asignación" />
          <div class="as-split">
            <section class="as-block as-list dt-scope" aria-labelledby="as-h-lista">
              <div class="as-bh">
                <h2 id="as-h-lista" class="sr-only">Productos</h2>
                <label class="as-q"><span class="sr-only">Buscar producto</span>
                  <input pInputText type="search" [ngModel]="q()" (ngModelChange)="onQ($event)" placeholder="Clave o nombre" aria-label="Buscar producto por clave o nombre" />
                </label>
                <app-segmented [options]="filtros()" [value]="filtro()" (valueChange)="pickFiltro($any($event))" ariaLabel="Filtro" />
              </div>
              <p-table [value]="l.filas" size="small" class="surf-table dt-stack" [lazy]="true" (onLazyLoad)="onPagina($event)" [paginator]="l.total > pagina" [rows]="pagina" [totalRecords]="l.total" [first]="offset()"
                selectionMode="single" [selection]="selFila()" (selectionChange)="pickProducto($event)" dataKey="product_id" [scrollable]="true" scrollHeight="calc(100vh - 21rem)" [loading]="cargandoLista()">
                <ng-template #header><tr><th>Producto</th><th>Lugar fijo</th></tr></ng-template>
                <ng-template #body let-r>
                  <tr [pSelectableRow]="r">
                    <td role="cell" data-label="Producto"><span class="as-nom">{{ r.nombre }}</span><span class="as-sub mono">{{ r.sku }}</span></td>
                    <td role="cell" data-label="Lugar fijo">
                      @if (r.surtido_fijo.length) { @for (c of r.surtido_fijo; track $index) { <span class="as-code mono">{{ c }}</span> } }
                      @else { <p-tag value="Sin lugar fijo" severity="warn" styleClass="as-tag" /> }
                    </td>
                  </tr>
                </ng-template>
                <ng-template #emptymessage>
                  <tr><td colspan="2"><div class="as-empty"><i class="pi pi-search" aria-hidden="true"></i><span>Ningún producto con estos filtros en {{ l.warehouse?.name }}.</span>@if (q() || filtro() !== 'todos') { <button type="button" class="as-link" (click)="limpiar()">Quitar filtros</button> }</div></td></tr>
                </ng-template>
              </p-table>
            </section>

            <aside class="as-block as-side" aria-label="Producto">
              @if (cargandoDet()) { <div class="as-skel" aria-busy="true"></div> }
              @else if (det(); as d) {
                <div class="as-step">
                  <span class="as-sub mono">{{ d.product.sku }}</span>
                  <h2 class="as-h2">{{ d.product.nombre }}</h2>
                  @if (d.presentaciones.length) {
                    <div class="as-ladder" role="group" aria-label="Presentaciones en Kepler">
                      <span class="as-sub">Presentaciones en Kepler ({{ d.warehouse.name }}):</span>
                      @for (p of d.presentaciones; track p.peldano) { <span class="as-pill mono">{{ etiquetaPres(p, d) }}</span> }
                    </div>
                  } @else {
                    <p class="as-sub as-bad">Este producto no tiene ficha en Kepler de {{ d.warehouse.name }}: no hay presentaciones que asignar.</p>
                  }
                  @if (d.aviso) { <p class="as-aviso" role="note">{{ d.aviso }}</p> }
                </div>

                @for (p of d.presentaciones; track p.peldano) {
                  <div class="as-step">
                    <div class="as-pres-h">
                      <span class="as-pres-r">{{ p.rotulo || 'Sin rótulo' }}</span>
                      <span class="as-sub">{{ explicaFactor(p, d) }}</span>
                    </div>
                    @for (a of asignacionesDe(d, p.peldano); track a.id) {
                      <div class="as-row">
                        <p-tag [value]="papelLabel(a.papel)" [severity]="a.papel === 'exhibicion_tienda' ? 'info' : a.papel === 'surtido_fijo' ? 'success' : 'secondary'" styleClass="as-tag" />
                        @if (edicion()?.id === a.id) {
                          <form class="as-form" (ngSubmit)="guardarEdicion(a)">
                            <label class="as-f"><span class="as-l">Ubicación</span><input pInputText class="mono" name="code" [ngModel]="edicion()!.code" (ngModelChange)="setEdicion('code', $event)" maxlength="8" /></label>
                            <label class="as-f"><span class="as-l">Mín ({{ p.rotulo }})</span><input pInputText type="number" min="0" class="mono" name="min" [ngModel]="edicion()!.min" (ngModelChange)="setEdicion('min', $event)" /></label>
                            <label class="as-f"><span class="as-l">Máx ({{ p.rotulo }})</span><input pInputText type="number" min="0" class="mono" name="max" [ngModel]="edicion()!.max" (ngModelChange)="setEdicion('max', $event)" /></label>
                            <span class="as-btns">
                              <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="edicion.set(null)"><span class="p-button-label">Cancelar</span></button>
                              <button pButton type="submit" class="p-button-sm" [loading]="guardando()"><span class="p-button-label">Guardar</span></button>
                            </span>
                          </form>
                        } @else {
                          <span class="as-code-l mono">{{ a.code }}</span>
                          <span class="as-sub">{{ minMax(a, p) }}@if (a.estado !== 'activa') { · <b class="as-bad">{{ a.estado === 'baja' ? 'dada de baja' : 'bloqueada' }}</b> }</span>
                          @if (puedeGestionar()) {
                            <span class="as-btns">
                              @if (quitar() === a.id) {
                                <span class="as-sub">¿Quitar?</span>
                                <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="quitar.set(null)"><span class="p-button-label">No</span></button>
                                <button pButton type="button" class="p-button-sm p-button-outlined p-button-danger" [attr.aria-label]="'Sí, quitar ' + a.code" [loading]="guardando()" (click)="confirmarQuitar(a)"><span class="p-button-label">Sí, quitar</span></button>
                              } @else {
                                <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" [attr.aria-label]="'Cambiar ' + a.code" (click)="editar(a)"><span class="p-button-label">Cambiar</span></button>
                                <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" [attr.aria-label]="'Quitar ' + a.code" (click)="quitar.set(a.id)"><span class="p-button-label">Quitar</span></button>
                              }
                            </span>
                          }
                        }
                      </div>
                    } @empty {
                      <p class="as-sub">Todavía sin ubicación en este almacén.</p>
                    }

                    @if (puedeGestionar()) {
                      @if (alta()?.peldano === p.peldano) {
                        <form class="as-form as-alta" (ngSubmit)="guardarAlta()">
                          <label class="as-f" for="as-papel-{{ p.peldano }}"><span class="as-l">Papel</span>
                            <p-select [inputId]="'as-papel-' + p.peldano" name="papel" [options]="papelesPara(d, p.peldano)" optionLabel="label" optionValue="key" [ngModel]="alta()!.papel" (onChange)="setAlta('papel', $event.value)" appendTo="body" />
                          </label>
                          <label class="as-f"><span class="as-l">Ubicación</span><input pInputText class="mono" name="code" [ngModel]="alta()!.code" (ngModelChange)="setAlta('code', $event)" [placeholder]="placeholderCodigo()" maxlength="8" /></label>
                          <label class="as-f"><span class="as-l">Mín ({{ p.rotulo }})</span><input pInputText type="number" min="0" class="mono" name="min" [ngModel]="alta()!.min" (ngModelChange)="setAlta('min', $event)" /></label>
                          <label class="as-f"><span class="as-l">Máx ({{ p.rotulo }})</span><input pInputText type="number" min="0" class="mono" name="max" [ngModel]="alta()!.max" (ngModelChange)="setAlta('max', $event)" /></label>
                          <span class="as-sub as-full" [class.as-bad]="!!ayudaAlta()?.mal" aria-live="polite">{{ ayudaAlta()?.txt }}</span>
                          <span class="as-btns as-full">
                            <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="alta.set(null)"><span class="p-button-label">Cancelar</span></button>
                            <button pButton type="submit" class="p-button-sm" [disabled]="!!ayudaAlta()?.mal || guardando()" [loading]="guardando()"><span class="p-button-label">Asignar</span></button>
                          </span>
                        </form>
                      } @else if (papelesPara(d, p.peldano).length) {
                        <div><button pButton type="button" class="p-button-sm p-button-text" (click)="nuevaAlta(d, p.peldano)"><span class="p-button-icon pi pi-plus" aria-hidden="true"></span><span class="p-button-label">Asignar {{ p.rotulo || 'esta presentación' }}</span></button></div>
                      }
                    }
                  </div>
                }
                @if (huerfanas(d).length) {
                  <div class="as-step" role="group" aria-labelledby="as-h-huerf">
                    <div class="as-pres-h">
                      <span id="as-h-huerf" class="as-pres-r as-bad">Ya no está en Kepler</span>
                      <span class="as-sub">Asignada a una presentación que Kepler ya no tiene en {{ d.warehouse.name }}. Quítala y, si hace falta, asigna la presentación vigente.</span>
                    </div>
                    @for (a of huerfanas(d); track a.id) {
                      <div class="as-row">
                        <p-tag [value]="papelLabel(a.papel)" severity="secondary" styleClass="as-tag" />
                        <span class="as-code-l mono">{{ a.code }}</span>
                        <span class="as-sub">se guardó como {{ a.presentacion_rotulo || 'presentación ' + a.presentacion }}</span>
                        @if (puedeGestionar()) {
                          <span class="as-btns">
                            @if (quitar() === a.id) {
                              <span class="as-sub">¿Quitar?</span>
                              <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="quitar.set(null)"><span class="p-button-label">No</span></button>
                              <button pButton type="button" class="p-button-sm p-button-outlined p-button-danger" [attr.aria-label]="'Sí, quitar ' + a.code" [loading]="guardando()" (click)="confirmarQuitar(a)"><span class="p-button-label">Sí, quitar</span></button>
                            } @else {
                              <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" [attr.aria-label]="'Quitar ' + a.code" (click)="quitar.set(a.id)"><span class="p-button-label">Quitar</span></button>
                            }
                          </span>
                        }
                      </div>
                    }
                  </div>
                }
                @if (msg(); as m) { <p class="as-step as-ok" role="status">{{ m }}</p> }
                @if (errDet(); as e) { <p class="as-step as-bad" role="alert">{{ e }}</p> }
              } @else if (errDet(); as e) {
                <p class="as-step as-bad" role="alert">{{ e }}</p>
              } @else {
                <div class="as-empty"><i class="pi pi-arrow-left" aria-hidden="true"></i><span>Elige un producto para ver sus presentaciones y dónde va cada una.</span></div>
              }
            </aside>
          </div>
        }
        }
        </app-load-state>
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap; margin-bottom:.5rem; }
    .as-head-text { display:flex; flex-wrap:wrap; align-items:baseline; gap:.35rem .75rem; min-width:0; }
    .as-head-text h1 { margin:0; font-size:var(--fs-h2); font-weight:700; letter-spacing:-.01em; }
    .as-meta { font-size:var(--fs-xs); color:var(--text-muted); }
    .as-actions { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; }
    /* ::ng-deep sólo para el ancho del p-select y el tamaño del p-tag de PrimeNG (vendor). */
    :host ::ng-deep .as-sel { min-width:12rem; }
    :host ::ng-deep .as-tag { font-size:var(--fs-nano); }
    .as-split { display:flex; flex-wrap:wrap; gap:.75rem; align-items:flex-start; }
    .as-block { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); min-width:0; }
    .as-list { flex:1 1 26rem; }
    .as-side { flex:999 1 30rem; }
    .as-bh { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:.5rem; padding:.6rem .85rem; border-bottom:1px solid var(--border-color); }
    .as-q input { min-width:14rem; height:2.25rem; }
    .as-nom { display:block; font-size:var(--fs-sm); }
    .as-sub { font-size:var(--fs-xs); color:var(--text-muted); margin:0; }
    .as-code { display:inline-block; margin-right:.3rem; font-size:var(--fs-sm); font-weight:600; }
    .as-step { padding:.75rem .85rem; border-top:1px solid var(--border-color); display:flex; flex-direction:column; gap:.5rem; }
    .as-side > .as-step:first-child { border-top:0; }
    .as-h2 { margin:0; font-size:var(--fs-h3); font-weight:700; }
    .as-ladder { display:flex; flex-wrap:wrap; gap:.35rem; align-items:center; }
    .as-pill { font-size:var(--fs-xs); padding:.15rem .5rem; border:1px solid var(--border-color); border-radius:var(--r-sm); background:var(--hover-bg); }
    .as-aviso { margin:0; font-size:var(--fs-xs); padding:.45rem .6rem; border:1px solid var(--warn-border); border-radius:var(--r-sm); background:var(--warn-soft-bg); color:var(--warn-soft-fg); }
    .as-pres-h { display:flex; flex-wrap:wrap; align-items:baseline; gap:.5rem; }
    .as-pres-r { font-size:var(--fs-body); font-weight:700; padding:.1rem .55rem; border:2px solid var(--text-main); border-radius:var(--r-sm); }
    .as-row { display:flex; flex-wrap:wrap; align-items:center; gap:.4rem .75rem; padding:.4rem .55rem; border:1px solid var(--border-color); border-radius:var(--r-sm); }
    .as-code-l { font-size:var(--fs-lg); font-weight:600; }
    .as-btns { display:inline-flex; flex-wrap:wrap; align-items:center; gap:.25rem; margin-left:auto; }
    .as-form { display:flex; flex-wrap:wrap; align-items:flex-end; gap:.5rem .6rem; flex:1 1 100%; }
    .as-alta { padding:.5rem .55rem; border:1px dashed var(--border-color); border-radius:var(--r-sm); }
    .as-f { display:flex; flex-direction:column; gap:.2rem; }
    .as-f input { width:6.5rem; height:2.25rem; }
    .as-l { font-size:var(--fs-nano); color:var(--text-muted); }
    .as-full { flex-basis:100%; }
    @media (pointer: coarse) { .as-f input, .as-q input { height:2.75rem; } }
    .as-sub.as-bad, .as-bad { color:var(--bad-fg); }
    .as-ok { margin:0; font-size:var(--fs-sm); color:var(--ok-fg); }
    .as-link { background:none; border:0; padding:0; color:var(--action); cursor:pointer; font:inherit; text-decoration:underline; }
    .num, .mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); border:0; }
    .as-note { display:flex; gap:.5rem; align-items:flex-start; padding:.6rem .8rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); font-size:var(--fs-sm); }
    .as-note-bad { border-left:3px solid var(--bad-fg); }
    app-metric-strip { display:block; margin-bottom:.75rem; }
    .as-empty { display:flex; flex-direction:column; align-items:center; gap:var(--sp-2); padding:var(--sp-6); text-align:center; color:var(--text-muted); font-size:var(--fs-sm); }
    .as-skel { height:12rem; border-radius:var(--r-md); background:var(--hover-bg); animation:as-pulse 1.4s ease-in-out infinite; }
    @keyframes as-pulse { 0%,100% { opacity:1; } 50% { opacity:.55; } }
    @media (prefers-reduced-motion: reduce) { .as-skel { animation:none; } }
  `],
})
export class AlmacenUbicacionesAsignacionComponent implements OnInit {
  private readonly api = inject(AlmacenUbicacionesCatalogoService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly q$ = new Subject<string>();

  readonly pagina = PAGINA;
  readonly almacenes = signal<Array<{ id: string; code: string; name: string }>>([]);
  readonly warehouseId = signal<string | null>(null);
  readonly sinAlmacen = signal(false);
  readonly q = signal('');
  readonly filtro = signal<ProductLocationFilter>('todos');
  readonly offset = signal(0);
  readonly lista = signal<ProductLocationsList | null>(null);
  readonly cargandoLista = signal(false);
  readonly err = signal<string | null>(null);
  readonly selFila = signal<ProductLocationRow | null>(null);
  readonly det = signal<ProductLocationDetail | null>(null);
  readonly cargandoDet = signal(false);
  readonly errDet = signal<string | null>(null);
  readonly msg = signal<string | null>(null);
  readonly edicion = signal<Edicion | null>(null);
  readonly alta = signal<Alta | null>(null);
  readonly quitar = signal<string | null>(null);
  readonly guardando = signal(false);
  private folioLista = 0;
  /** Hora del navegador en que llegó la lista (para la píldora «cargado hace N»). */
  readonly cargadoEn = signal<Date | null>(null);
  private folioDet = 0;

  private readonly vista = toSignal(this.route.queryParamMap.pipe(map((m) => m.get('vista'))), { initialValue: null });
  readonly puedeGestionar = computed(() => this.perms.isAdmin() || !!this.auth.user()?.permissions?.[Permission.ALMACEN_UBICACIONES_GESTIONAR]);
  readonly enExcel = computed(() => this.vista() === 'excel' && this.puedeGestionar());
  readonly almacen = computed(() => this.almacenes().find((w) => w.id === this.warehouseId()) ?? null);
  readonly almacenOpts = computed(() => this.almacenes().map((w) => ({ label: `${w.code} · ${w.name}`, value: w.id })));
  readonly filtros = computed<SegOption[]>(() => [
    { label: 'Todos', value: 'todos' },
    { label: `Sin lugar fijo${this.lista()?.ficha_kepler ? ` (${this.lista()!.sin_ubicacion})` : ''}`, value: 'sin_ubicacion' },
    { label: 'Con lugar fijo', value: 'con_ubicacion' },
  ]);

  /**
   * La respuesta de arriba. Cuenta sobre el UNIVERSO (productos con ficha en Kepler de la sucursal que
   * coinciden con la búsqueda), no sobre la página: la página la recorta el filtro de lugar fijo.
   */
  readonly kpis = computed<MetricStripItem[]>(() => {
    const l = this.lista();
    if (!l || !l.ficha_kepler) return [];
    const con = Math.max(0, l.universo - l.sin_ubicacion);
    const busca = this.q() ? ' que coinciden' : '';
    return [
      { label: `Productos en Kepler${busca}`, value: l.universo, sub: `con ficha en ${l.warehouse?.name ?? 'esta sucursal'}` },
      { label: 'Con lugar fijo', value: con, tone: 'ok', sub: l.universo ? `${Math.round((con / l.universo) * 100)} % ya ubicado` : 'nada que ubicar' },
      { label: 'Sin lugar fijo', value: l.sin_ubicacion, tone: l.sin_ubicacion > 0 ? 'warn' : 'default', sub: 'falta decir dónde se surten' },
    ];
  });

  ngOnInit(): void {
    this.q$.pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef)).subscribe((v) => {
      this.q.set(v);
      this.offset.set(0);
      this.cargarLista();
    });
    this.cargarAlmacenes();
  }

  /** Si lo que falló fue el almacén, se vuelve a pedir; si no, sólo la lista. */
  reintentar(): void {
    if (this.warehouseId()) this.cargarLista();
    else this.cargarAlmacenes();
  }

  private cargarAlmacenes(): void {
    this.err.set(null);
    // El selector de almacén sale del mismo alcance que el Mapa.
    this.api.list(null).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.almacenes.set(d.alcance.almacenes);
        if (!d.warehouse) { this.sinAlmacen.set(true); return; }
        this.warehouseId.set(d.warehouse.id);
        this.cargarLista();
      },
      error: (e: HttpErrorResponse) => this.err.set(mensaje(e, 'No se pudo cargar el almacén.')),
    });
  }

  verExcel(si: boolean): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { vista: si ? 'excel' : null }, queryParamsHandling: 'merge' });
  }

  pickAlmacen(id: string): void {
    this.warehouseId.set(id);
    this.offset.set(0);
    this.folioDet++; // la respuesta en vuelo del producto anterior ya no aplica
    this.selFila.set(null);
    this.det.set(null);
    this.cargandoDet.set(false);
    this.errDet.set(null);
    this.msg.set(null);
    this.edicion.set(null);
    this.alta.set(null);
    this.quitar.set(null);
    this.cargarLista();
  }
  onQ(v: string): void { this.q$.next(v); }
  pickFiltro(f: ProductLocationFilter): void { this.filtro.set(f); this.offset.set(0); this.cargarLista(); }
  limpiar(): void { this.q.set(''); this.filtro.set('todos'); this.offset.set(0); this.cargarLista(); }
  onPagina(ev: TableLazyLoadEvent): void {
    const o = ev.first ?? 0;
    if (o === this.offset()) return;
    this.offset.set(o);
    this.cargarLista();
  }

  cargarLista(): void {
    const w = this.warehouseId();
    if (!w) return;
    const folio = ++this.folioLista;
    this.cargandoLista.set(true);
    this.err.set(null);
    this.api.products(w, { q: this.q(), filtro: this.filtro(), limit: PAGINA, offset: this.offset() }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (l) => { if (folio !== this.folioLista) return; this.lista.set(l); this.cargadoEn.set(new Date()); this.cargandoLista.set(false); },
      error: (e: HttpErrorResponse) => { if (folio !== this.folioLista) return; this.cargandoLista.set(false); this.err.set(mensaje(e, 'No se pudieron cargar los productos.')); },
    });
  }

  pickProducto(r: ProductLocationRow | null): void {
    this.selFila.set(r);
    this.edicion.set(null);
    this.alta.set(null);
    this.quitar.set(null);
    this.msg.set(null);
    if (r) this.cargarDetalle(r.product_id);
    else this.det.set(null);
  }

  private cargarDetalle(productId: string): void {
    const w = this.warehouseId();
    if (!w) return;
    const folio = ++this.folioDet;
    this.cargandoDet.set(true);
    this.errDet.set(null);
    this.api.productDetail(w, productId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { if (folio !== this.folioDet) return; this.det.set(d); this.cargandoDet.set(false); },
      error: (e: HttpErrorResponse) => { if (folio !== this.folioDet) return; this.cargandoDet.set(false); this.det.set(null); this.errDet.set(mensaje(e, 'No se pudo cargar el producto.')); },
    });
  }

  asignacionesDe(d: ProductLocationDetail, peldano: number): ProductAssignment[] {
    return d.asignaciones.filter((a) => a.presentacion === peldano);
  }

  /** Asignaciones cuya presentación ya no está en la escalera de Kepler (I1): se ven y se pueden quitar. */
  huerfanas(d: ProductLocationDetail): ProductAssignment[] {
    const vivos = new Set(d.presentaciones.map((p) => p.peldano));
    return d.asignaciones.filter((a) => !vivos.has(a.presentacion));
  }

  /** Los papeles que todavía se pueden agregar: los únicos (lugar fijo, reserva) sólo si no están. */
  papelesPara(d: ProductLocationDetail, peldano: number) {
    const ya = new Set(this.asignacionesDe(d, peldano).map((a) => a.papel));
    return ASSIGNMENT_ROLES.filter((r) => !r.unico || !ya.has(r.key));
  }

  nuevaAlta(d: ProductLocationDetail, peldano: number): void {
    const papel = this.papelesPara(d, peldano)[0]?.key;
    if (!papel) return;
    this.edicion.set(null);
    this.msg.set(null);
    this.errDet.set(null);
    this.alta.set({ peldano, papel, code: '', min: '', max: '' });
  }
  setAlta<K extends keyof Alta>(k: K, v: Alta[K]): void { this.alta.update((a) => (a ? { ...a, [k]: v } : a)); }
  setEdicion<K extends keyof Edicion>(k: K, v: Edicion[K]): void { this.edicion.update((e) => (e ? { ...e, [k]: v } : e)); }

  placeholderCodigo(): string {
    const z = PAPEL.get(this.alta()?.papel ?? 'surtido_fijo')?.zona;
    return z === 'T' ? 'TA021' : 'BA053';
  }

  /** Ayuda en vivo: el código cumple el formato y su zona es la del papel. */
  ayudaAlta(): { txt: string; mal: boolean } | null {
    const a = this.alta();
    if (!a) return null;
    const rol = PAPEL.get(a.papel)!;
    if (!a.code) return { txt: `${rol.label}: una ubicación de ${rol.zona === 'B' ? 'bodega (empieza con B)' : 'tienda (empieza con T)'}.`, mal: true };
    const p = parseLocationCode(a.code);
    if (!p.ok) return { txt: p.motivo, mal: true };
    if (p.parts.zona !== rol.zona) return { txt: `${rol.label} va en ${rol.zona === 'B' ? 'bodega (B…)' : 'tienda (T…)'}.`, mal: true };
    const min = vacio(a.min);
    const max = vacio(a.max);
    if ((min != null && !(min >= 0)) || (max != null && !(max >= 0))) return { txt: 'Mínimo y máximo: números de 0 en adelante.', mal: true };
    if (min != null && max != null && min > max) return { txt: 'El mínimo no puede pasar del máximo.', mal: true };
    return { txt: `${p.code} · ${rol.label.toLowerCase()}`, mal: false };
  }

  guardarAlta(): void {
    const a = this.alta();
    const d = this.det();
    const w = this.warehouseId();
    if (!a || !d || !w || this.guardando() || this.ayudaAlta()?.mal) return;
    this.guardando.set(true);
    this.errDet.set(null);
    this.api
      .createAssignment({ warehouse_id: w, product_id: d.product.id, presentacion: a.peldano as 1 | 2 | 3, papel: a.papel, bin_code: a.code, min_qty: vacio(a.min), max_qty: vacio(a.max) })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.guardando.set(false); this.alta.set(null); this.msg.set(`Asignado a ${r.code}.`); this.refrescar(d.product.id, w); },
        error: (e: HttpErrorResponse) => { this.guardando.set(false); this.errDet.set(mensaje(e, 'No se pudo asignar.')); },
      });
  }

  editar(a: ProductAssignment): void {
    this.alta.set(null);
    this.msg.set(null);
    this.errDet.set(null);
    this.edicion.set({ id: a.id, code: a.code, min: a.min_qty == null ? '' : String(a.min_qty), max: a.max_qty == null ? '' : String(a.max_qty) });
  }

  guardarEdicion(a: ProductAssignment): void {
    const e = this.edicion();
    const d = this.det();
    const w = this.warehouseId();
    if (!e || !d || !w || this.guardando()) return;
    this.guardando.set(true);
    this.errDet.set(null);
    const cuerpo = { ...(e.code !== a.code ? { bin_code: e.code } : {}), min_qty: vacio(e.min), max_qty: vacio(e.max) };
    this.api.updateAssignment(a.id, cuerpo).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.guardando.set(false); this.edicion.set(null); this.msg.set('Cambio guardado.'); this.refrescar(d.product.id, w); },
      error: (err: HttpErrorResponse) => { this.guardando.set(false); this.errDet.set(mensaje(err, 'No se pudo guardar el cambio.')); },
    });
  }

  confirmarQuitar(a: ProductAssignment): void {
    const d = this.det();
    const w = this.warehouseId();
    if (!d || !w || this.guardando()) return;
    this.guardando.set(true);
    this.errDet.set(null);
    this.api.removeAssignment(a.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.guardando.set(false); this.quitar.set(null); this.msg.set(`Se quitó de ${a.code}.`); this.refrescar(d.product.id, w); },
      error: (e: HttpErrorResponse) => { this.guardando.set(false); this.quitar.set(null); this.errDet.set(mensaje(e, 'No se pudo quitar.')); },
    });
  }

  /**
   * Tras un cambio: el detalle y la lista (el lugar fijo de la fila y el conteo «sin lugar fijo»).
   * Si mientras se guardaba la persona cambió de almacén, el producto era de OTRO: sólo la lista.
   */
  private refrescar(productId: string, warehouseId: string): void {
    if (this.warehouseId() === warehouseId) this.cargarDetalle(productId);
    this.cargarLista();
  }

  papelLabel(p: AssignmentRole): string { return PAPEL.get(p)?.label ?? p; }

  /** «CJA = 20 PAQ», «PAQ (base)», «EXH · sin factor en Kepler». */
  etiquetaPres(p: ProductPresentation, d: ProductLocationDetail): string {
    const base = d.presentaciones.find((x) => x.peldano === 1)?.rotulo ?? 'base';
    if (p.peldano === 1) return `${p.rotulo ?? 'base'} (base)`;
    return p.factor == null ? `${p.rotulo ?? '?'} · sin factor` : `${p.rotulo ?? '?'} = ${fmt(p.factor)} ${base}`;
  }

  explicaFactor(p: ProductPresentation, d: ProductLocationDetail): string {
    if (p.peldano === 1) return 'presentación base de Kepler';
    if (p.factor == null) return 'Kepler no tiene cuántas trae: sin factor (no se convierten cantidades)';
    const base = d.presentaciones.find((x) => x.peldano === 1)?.rotulo ?? 'base';
    return `trae ${fmt(p.factor)} ${base}${p.es_caja ? ' · la presentación mayor' : ''}${p.fuente === 'derivado_del_costo' ? ' · factor calculado del costo' : ''}`;
  }

  minMax(a: ProductAssignment, p: ProductPresentation): string {
    const u = p.rotulo ?? '';
    if (a.min_qty == null && a.max_qty == null) return 'sin mínimo ni máximo';
    return `mín ${a.min_qty == null ? '—' : fmt(a.min_qty)} · máx ${a.max_qty == null ? '—' : fmt(a.max_qty)} ${u}`;
  }
}

const fmt = (n: number) => n.toLocaleString('es-MX', { maximumFractionDigits: 3 });
const vacio = (v: Cantidad): number | null => (v == null || v === '' ? null : Number(v));
function mensaje(e: HttpErrorResponse, fallback: string): string {
  const m = e.error?.message;
  return typeof m === 'string' ? m : Array.isArray(m) ? m.join(' · ') : fallback;
}
