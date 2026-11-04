import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import type { Observable } from 'rxjs';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { ToastModule } from 'primeng/toast';
import { CheckboxModule } from 'primeng/checkbox';
import { InputTextModule } from 'primeng/inputtext';
import { MessageService } from 'primeng/api';
import {
  PENDIENTES_SUCURSAL_FILAS_VISIBLES,
  type ColaSucursal, type GrupoPendienteSucursal, type PendienteSucursalFila,
  type SucursalPendientesAlmacen, type SucursalPendientesResponse,
} from '@megadulces/contracts';
import { SucursalPendientesService } from '../sucursal-pendientes.service';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import {
  GRUPO_LABEL, SIN_FILTROS, conteosFiltros, filtrarColas, hayFiltros, porGrupo, repartir, veredicto,
  type FiltroQuien, type Filtros,
} from '../pendientes-sucursal.util';

const GRUPOS: GrupoPendienteSucursal[] = ['recibir', 'surtir', 'caja', 'inventario', 'administracion'];
const QUIEN: FiltroQuien[] = ['todos', 'sin_tomar', 'mios'];

/**
 * `[AB.44]` → `[AB.45]` → `[AB.46]` → `[AB.47]` **Pendientes de sucursal** (`/sucursal/pendientes`), módulo
 * propio: TODO lo que la Suite tiene abierto de una sucursal, y quién se encargó de cada cosa.
 *
 * Edgar (2026-11-03): «como módulo, no como submódulo» · «darle acceso a cada persona con la sucursal a la
 * misma información, en oficinas con el selector, para que todos puedan atribuirse el resolver los
 * pendientes» · «hay que agregar filtros o lo que sea necesario para mejorar la interfaz».
 *
 * ── Las cinco preguntas (skill `diseno` §0b) ────────────────────────────────────────────────────
 * 1. Qué ve y en qué orden: el veredicto; la franja por proceso, que también filtra; los filtros (quién
 *    lo tiene · sólo lo que puedo resolver · buscar); las colas con trabajo, la que más espera primero; en cada fila, quién la tiene.
 * 2. Qué no: colas en cero = una línea («al día»); lo de OTRA área, compacto y sin sumar; una cola que el
 *    filtro deja vacía sale y se dice cuántas salieron; cada cola pinta 10 filas y «Ver todas» abre el resto.
 *    Sin importes de arqueo: la ve toda la sucursal y el arqueo es ciego.
 * 3. Accesibilidad: buscar por folio, detalle o responsable (sin acentos, en cualquier orden); cada opción
 *    de filtro con su conteo sobre el universo de cada tipo (`[AB.48]`: antes contaba sólo lo que viajó); los filtros viven en la URL (se comparten y sobreviven a recargar);
 *    «Yo lo resuelvo» en la misma fila (una sola interfaz por flujo).
 * 4. Ligado a: cada cola a su pantalla dueña; el traspaso se recibe en Kepler.
 * 5. Le toca: a toda la sucursal; la sucursal la fija su alcance (oficinas eligen).
 *
 * Jerarquía: primario = el veredicto; secundario = cada pendiente y quién lo tiene; terciario = folios,
 * importes, ventanas, filtros y lo de otra área.
 */
@Component({
  selector: 'app-sucursal-pendientes',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, TableModule, ButtonModule, SelectModule, ToastModule, CheckboxModule, InputTextModule,
    LoadStateComponent, FreshnessPillComponent, MetricStripComponent, SegmentedComponent, ContextHelpComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-toast></p-toast>
    <div class="surf-page in pen-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1 class="pen-h1">Pendientes de sucursal <app-context-help topic="sucursal-pendientes" /></h1>
          @if (almacenes().length > 1) {
            <p-select [options]="almacenes()" optionLabel="name" optionValue="id" [ngModel]="sel()" (ngModelChange)="elegir($event)"
                      inputId="pen-suc" ariaLabel="Sucursal" appendTo="body" [filter]="almacenes().length > 6" class="pen-suc"></p-select>
          } @else if (almacenActual(); as a) {
            <p class="pen-suc-unica">{{ a.name }}</p>
          }
        </div>
        <div class="pen-head-acc">
          <app-freshness-pill measures="fetch" [since]="cargadoEn()" [staleAfterSec]="600"></app-freshness-pill>
          <button pButton type="button" class="p-button-sm p-button-text" icon="pi pi-refresh" (click)="cargar()"
                  [disabled]="!sel() || cargando()" aria-label="Volver a leer"></button>
        </div>
      </header>

      <app-load-state [loading]="cargandoAlmacenes()" [error]="errorAlmacenes()" [isEmpty]="!cargandoAlmacenes() && !almacenes().length"
                      emptyIcon="pi-building" emptyTitle="No tienes una sucursal asignada"
                      emptyHint="Tu ficha no tiene sucursal y tu alcance no incluye ninguna. Pídele a Sistemas que te la asigne."
                      (retry)="cargarAlmacenes()">
        <app-load-state [loading]="cargando() && !resp()" [error]="error()" [isEmpty]="false" (retry)="cargar()">
          @if (resp()) {
            <p class="pen-veredicto" role="status">{{ frase() }}</p>
            @if (nota(); as n) { <p class="pen-nota">{{ n }}</p> }
            <!-- La franja por proceso ES el filtro de proceso: clic filtra, otro clic lo quita. Cuenta con los otros filtros puestos. -->
            <app-metric-strip [items]="kpis()" [selected]="filtros().grupo === 'todos' ? null : filtros().grupo"
                              (drill)="porProceso($event)" ariaLabel="Pendientes de la sucursal por proceso; clic para filtrar"></app-metric-strip>

            <div class="pen-filtros" role="search" aria-label="Filtrar pendientes">
              <app-segmented [options]="opcionesQuien()" [value]="filtros().quien" (valueChange)="poner({ quien: $any($event) })"
                             ariaLabel="Quién lo tiene"></app-segmented>
              <span class="pen-buscar">
                <i class="pi pi-search" aria-hidden="true"></i>
                <input pInputText type="search" [ngModel]="texto()" (ngModelChange)="buscar($event)"
                       placeholder="Folio, proveedor, producto o persona" aria-label="Buscar pendientes" />
              </span>
              <label class="pen-puedo">
                <p-checkbox [binary]="true" [ngModel]="filtros().soloPuedo" (ngModelChange)="poner({ soloPuedo: $event })"
                            inputId="pen-puedo"></p-checkbox>
                <span>Sólo lo que puedo resolver</span>
              </label>
              @if (conFiltros()) {
                <button pButton type="button" class="p-button-sm p-button-text" (click)="limpiar()">
                  <span class="p-button-label">Quitar filtros</span>
                </button>
              }
            </div>
            @if (conFiltros()) {
              <p class="pen-tenue pen-resumen" role="status">
                {{ resumenFiltro() }}@if (vista().ocultas) { · {{ vista().ocultas }} {{ vista().ocultas === 1 ? 'tipo de pendiente no tiene' : 'tipos de pendiente no tienen' }} nada con estos filtros }
              </p>
            }

            @for (cf of vista().colas; track cf.cola.id) {
              <section class="pen-sec" [attr.aria-labelledby]="'pen-h-' + cf.cola.id">
                <div class="pen-sec-head">
                  <div>
                    <h2 class="pen-h2" [id]="'pen-h-' + cf.cola.id">{{ cf.cola.label }}</h2>
                    <p class="pen-sub">{{ grupo(cf.cola) }} · {{ cf.cola.accion }}@if (cf.cola.ventana) { · {{ cf.cola.ventana }} }</p>
                  </div>
                  <span class="pen-cuenta">
                    @if (cf.cuenta.n !== cf.cola.total) { {{ cf.cuenta.n | number }} <span class="pen-de">de {{ cf.cola.total | number }}</span> }
                    @else { {{ cf.cola.total | number }} }
                  </span>
                  @if (cf.cola.puede_abrir) {
                    <a pButton class="p-button-sm p-button-text pen-ir" [routerLink]="cf.cola.ruta" [queryParams]="cf.cola.query">
                      <span class="p-button-label">Resolver</span><i class="pi pi-arrow-right" aria-hidden="true"></i>
                    </a>
                  } @else {
                    <span class="pen-sin-acceso">Se resuelve en una pantalla que tu puesto no abre</span>
                  }
                </div>
                <div class="dt-scope">
                  <p-table [value]="filasVisibles(cf.cola.id, cf.filas)" dataKey="clave" size="small" class="surf-table surf-table--plain dt-stack">
                    <ng-template #header>
                      <tr><th>Folio</th><th>Detalle</th><th class="comm-num">Días</th><th class="comm-num">Importe</th><th>Quién lo resuelve</th></tr>
                    </ng-template>
                    <ng-template #body let-f>
                      <tr>
                        <td class="dt-id" data-label="Folio" role="cell"><span class="pen-folio">{{ f.folio || '—' }}</span></td>
                        <td data-label="Detalle" role="cell">{{ f.detalle || '—' }}</td>
                        <td class="comm-num dt-num" data-label="Días" role="cell">{{ f.dias == null ? '—' : (f.dias | number) }}</td>
                        <td class="comm-num dt-num" data-label="Importe" role="cell">{{ f.monto == null ? '—' : dinero(f.monto) }}</td>
                        <td data-label="Quién lo resuelve" role="cell" class="pen-quien">
                          @if (f.responsable; as r) {
                            <span class="pen-resp">{{ r.soy_yo ? 'Tú' : r.nombre }}</span>
                            <span class="pen-tenue">desde {{ r.desde | date:'d MMM, HH:mm' }}</span>
                            @if (r.soy_yo) {
                              <button pButton type="button" class="p-button-sm p-button-text" [disabled]="ocupado(cf.cola, f)"
                                      (click)="soltar(cf.cola, f)" [attr.aria-label]="'Soltar ' + f.folio">
                                <span class="p-button-label">Soltar</span>
                              </button>
                            }
                          } @else {
                            <!-- Neutro: hay uno por fila (66 en Padre Hidalgo); el color de acción queda para «Resolver». -->
                            <button pButton type="button" class="p-button-sm p-button-text p-button-secondary pen-tomar" [disabled]="ocupado(cf.cola, f)"
                                    (click)="atribuir(cf.cola, f)" [attr.aria-label]="'Yo resuelvo ' + f.folio">
                              <span class="p-button-label">Yo lo resuelvo</span>
                            </button>
                          }
                        </td>
                      </tr>
                    </ng-template>
                  </p-table>
                </div>
                <div class="pen-pie">
                  @if (cf.filas.length > visibles) {
                    <button pButton type="button" class="p-button-sm p-button-text" (click)="alternar(cf.cola.id)"
                            [attr.aria-expanded]="abiertas().has(cf.cola.id)">
                      <span class="p-button-label">{{ abiertas().has(cf.cola.id) ? 'Ver menos' : 'Ver las ' + cf.filas.length }}</span>
                    </button>
                  }
                  @if (cf.recortada) {
                    <span class="pen-tenue">Aquí están las {{ cf.cola.filas.length }} más viejas de {{ cf.cola.total | number }}@if (!cf.cuenta.exacta) {; la búsqueda sólo mira ésas}.@if (cf.cola.puede_abrir) { El resto, en «Resolver». }</span>
                  }
                </div>
              </section>
            } @empty {
              @if (conFiltros()) {
                <p class="pen-vacio"><i class="pi pi-filter-slash" aria-hidden="true"></i> Nada con estos filtros.
                  <button pButton type="button" class="p-button-sm p-button-text" (click)="limpiar()"><span class="p-button-label">Quitar filtros</span></button>
                </p>
              }
            }

            @if (!conFiltros()) {
              @for (c of reparto().sinLeer; track c.id) {
                <section class="pen-sec pen-sinleer" role="alert">
                  <h2 class="pen-h2">{{ c.label }}</h2>
                  <p class="pen-sub"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ c.motivo || 'No se pudo leer.' }} No quiere decir que esté en cero.</p>
                </section>
              }

              @if (reparto().alDia.length) {
                <p class="pen-aldia"><i class="pi pi-check-circle" aria-hidden="true"></i> Al día: {{ alDiaTexto() }}.</p>
              }

              @if (reparto().otraArea.length) {
                <section class="pen-sec" aria-labelledby="pen-h-otra">
                  <h2 class="pen-h2" id="pen-h-otra">Abierto en la sucursal, lo atiende otra área</h2>
                  <p class="pen-sub">No es trabajo de la sucursal y no suma arriba; se muestra para que sepas que está abierto.</p>
                  <div class="dt-scope">
                    <p-table [value]="reparto().otraArea" size="small" class="surf-table surf-table--plain dt-stack">
                      <ng-template #header>
                        <tr><th>Qué</th><th class="comm-num">Cuántos</th><th>Quién</th><th><span class="pen-oculto">Abrir</span></th></tr>
                      </ng-template>
                      <ng-template #body let-c>
                        <tr>
                          <td class="dt-id" data-label="Qué" role="cell">{{ c.label }}</td>
                          <td class="comm-num dt-num" data-label="Cuántos" role="cell">{{ c.estado === 'ok' ? (c.total | number) : 'No se pudo leer' }}</td>
                          <td data-label="Quién" role="cell">{{ c.accion }}</td>
                          <td class="dt-actions" data-label="Abrir" role="cell">
                            @if (c.puede_abrir) {
                              <a pButton class="p-button-sm p-button-text" [routerLink]="c.ruta" [queryParams]="c.query" [attr.aria-label]="'Ver ' + c.label">
                                <span class="p-button-label">Ver</span>
                              </a>
                            }
                          </td>
                        </tr>
                      </ng-template>
                    </p-table>
                  </div>
                </section>
              }

              @if (resp()!.fuera.length) {
                <details class="pen-fuera">
                  <summary>Lo que no aparece aquí, y por qué ({{ resp()!.fuera.length }})</summary>
                  <ul>
                    @for (f of resp()!.fuera; track f.label) { <li><strong>{{ f.label }}:</strong> {{ f.motivo }}</li> }
                  </ul>
                </details>
              }
            }
          }
        </app-load-state>
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; container-type: inline-size; }
    .pen-h1 { display: inline-flex; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-1); }
    .pen-head-acc { display: flex; align-items: center; gap: var(--sp-2); }
    .pen-suc-unica { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
    :host ::ng-deep .pen-suc { min-width: 14rem; }
    .pen-veredicto { margin: var(--sp-3) 0 var(--sp-1); font-size: var(--fs-h2); font-weight: 600; color: var(--text-main); }
    .pen-nota { margin: 0 0 var(--sp-3); font-size: var(--fs-sm); color: var(--text-muted); }
    .pen-filtros { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); margin: var(--sp-4) 0 var(--sp-2); }
    .pen-buscar { position: relative; display: inline-flex; align-items: center; }
    .pen-buscar .pi { position: absolute; left: var(--sp-3); color: var(--text-muted); font-size: var(--fs-sm); pointer-events: none; }
    .pen-buscar input { padding-left: var(--sp-8); min-width: 18rem; }
    .pen-puedo { display: inline-flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-main); cursor: pointer; }
    .pen-resumen { margin: 0 0 var(--sp-2); }
    .pen-sec { margin-top: var(--sp-6); }
    .pen-sec-head { display: flex; flex-wrap: wrap; align-items: flex-start; gap: var(--sp-3); margin-bottom: var(--sp-2); }
    .pen-h2 { margin: 0; font-size: var(--fs-h3); font-weight: 600; color: var(--text-main); }
    .pen-sub { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .pen-cuenta { font-size: var(--fs-h3); font-weight: 600; color: var(--text-main); font-variant-numeric: tabular-nums; }
    .pen-de { font-size: var(--fs-sm); font-weight: 400; color: var(--text-muted); }
    .pen-ir, .pen-sin-acceso { margin-left: auto; }
    .pen-sin-acceso { font-size: var(--fs-xs); color: var(--text-muted); align-self: center; }
    .pen-folio { font-family: var(--font-mono, monospace); }
    .pen-quien { white-space: nowrap; }
    .pen-resp { font-weight: 600; color: var(--text-main); margin-right: var(--sp-2); }
    .pen-tomar { white-space: nowrap; }
    .pen-tenue { font-size: var(--fs-xs); color: var(--text-muted); }
    .pen-pie { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-top: var(--sp-1); }
    .pen-vacio { margin-top: var(--sp-6); font-size: var(--fs-sm); color: var(--text-muted); }
    /* Texto en -soft-fg: --warn-fg sobre blanco da 2.15:1 (AA pide 4.5); el icono sí puede ir en -fg. */
    .pen-sinleer .pen-sub { color: var(--warn-soft-fg); }
    .pen-sinleer .pen-sub .pi { color: var(--warn-fg); }
    .pen-aldia { margin: var(--sp-6) 0 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .pen-aldia .pi { color: var(--ok-fg); }
    .pen-fuera { margin-top: var(--sp-6); font-size: var(--fs-sm); color: var(--text-muted); }
    .pen-fuera summary { cursor: pointer; }
    .pen-fuera ul { margin: var(--sp-2) 0 0; padding-left: var(--sp-6); }
    .pen-fuera li { margin-bottom: var(--sp-1); }
    .pen-oculto { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    @container (max-width: 48rem) {
      .pen-ir, .pen-sin-acceso { margin-left: 0; }
      .pen-quien { white-space: normal; }
      .pen-buscar, .pen-buscar input { width: 100%; min-width: 0; }
    }
  `],
})
export class SucursalPendientesComponent implements OnInit {
  private readonly api = inject(SucursalPendientesService);
  private readonly toast = inject(MessageService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  readonly visibles = PENDIENTES_SUCURSAL_FILAS_VISIBLES;

  readonly almacenes = signal<SucursalPendientesAlmacen[]>([]);
  readonly cargandoAlmacenes = signal(true);
  readonly errorAlmacenes = signal<string | null>(null);
  readonly sel = signal<string | null>(null);
  readonly almacenActual = computed(() => this.almacenes().find((a) => a.id === this.sel()) ?? null);

  readonly resp = signal<SucursalPendientesResponse | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly cargadoEn = signal<Date | null>(null);
  /** Filas con una atribución en vuelo: el botón se apaga en el PRIMER clic (idempotencia visual). */
  private readonly enVuelo = signal<ReadonlySet<string>>(new Set());

  // ── [AB.47] Filtros: viven en la URL (se comparten y sobreviven a recargar) ──────────────────
  readonly filtros = signal<Filtros>(SIN_FILTROS);
  /** Lo tecleado en el buscador, antes de aplicarse (`buscar`). */
  readonly texto = signal('');
  private tecleo: ReturnType<typeof setTimeout> | undefined;
  /** Colas con «Ver todas» abierto. */
  readonly abiertas = signal<ReadonlySet<string>>(new Set());

  readonly reparto = computed(() => repartir(this.resp()?.colas ?? []));
  private readonly ver = computed(() => veredicto(this.resp()?.colas ?? []));
  readonly vista = computed(() => filtrarColas(this.resp()?.colas ?? [], this.filtros()));
  readonly conFiltros = computed(() => hayFiltros(this.filtros()));
  private readonly conteos = computed(() => conteosFiltros(this.resp()?.colas ?? [], this.filtros()));

  readonly opcionesQuien = computed<SegOption[]>(() => {
    const k = this.conteos().quien;
    return [
      { label: 'Todos', value: 'todos', count: k.todos },
      { label: 'Sin tomar', value: 'sin_tomar', count: k.sin_tomar },
      { label: 'Míos', value: 'mios', count: k.mios },
    ];
  });

  readonly resumenFiltro = computed(() => {
    const n = this.vista().colas.reduce((s, c) => s + c.cuenta.n, 0);
    const parcial = this.vista().colas.some((c) => !c.cuenta.exacta) ? ' (la búsqueda sólo mira los más viejos de cada tipo)' : '';
    return `${n.toLocaleString('es-MX')} ${n === 1 ? 'pendiente' : 'pendientes'} con estos filtros${parcial}`;
  });

  readonly frase = computed(() => {
    const v = this.ver();
    if (!v.total) return v.sinLeer ? 'Sin pendientes en lo que se pudo leer' : 'Al día: la sucursal no tiene pendientes';
    const viejo = v.masViejo ? ` · el más viejo espera ${v.masViejo} ${v.masViejo === 1 ? 'día' : 'días'}` : '';
    return `${v.total.toLocaleString('es-MX')} ${v.total === 1 ? 'pendiente' : 'pendientes'} de ${v.colas} ${v.colas === 1 ? 'tipo' : 'tipos'}${viejo}`;
  });

  readonly nota = computed(() => {
    const n = this.ver().sinLeer;
    if (!n) return null;
    return `${n === 1 ? 'Un tipo de pendiente no se pudo leer' : `${n} tipos de pendiente no se pudieron leer`}: el total no ${n === 1 ? 'lo' : 'los'} incluye.`;
  });

  /**
   * La franja por proceso, que también es el filtro de proceso (antes había un segmentado aparte que
   * contaba otra cosa). Cuenta con los demás filtros puestos; sin filtros suma el total del veredicto.
   * Sin ámbar: «hay pendientes» no es una alerta, y como texto `--warn-fg` no se lee (2.15:1).
   */
  readonly kpis = computed<MetricStripItem[]>(() => {
    const k = this.conteos().grupo;
    const sel = this.filtros().grupo;
    return porGrupo(this.resp()?.colas ?? []).map((g): MetricStripItem => {
      const label = GRUPO_LABEL[g.grupo];
      const n = k[g.grupo] ?? 0;
      return {
        label,
        value: n,
        format: 'number',
        tone: n ? 'default' : 'muted',
        state: g.sinLeer ? 'parcial' : undefined,
        stateNote: g.sinLeer ? 'Uno de sus tipos de pendiente no se pudo leer' : undefined,
        drill: g.total || sel === g.grupo ? g.grupo : undefined,
        drillLabel: sel === g.grupo ? `Quitar el filtro de ${label}` : `Ver sólo ${label}: ${n.toLocaleString('es-MX')}`,
      };
    });
  });

  readonly alDiaTexto = computed(() => this.reparto().alDia.map((c) => c.label.charAt(0).toLowerCase() + c.label.slice(1)).join(' · '));

  ngOnInit(): void {
    // Los filtros de la URL, validados contra listas cerradas: un valor inventado no filtra nada.
    const qp = this.route.snapshot.queryParamMap;
    const quien = qp.get('quien');
    const grupo = qp.get('proceso');
    this.filtros.set({
      quien: QUIEN.includes(quien as FiltroQuien) ? (quien as FiltroQuien) : 'todos',
      grupo: GRUPOS.includes(grupo as GrupoPendienteSucursal) ? (grupo as GrupoPendienteSucursal) : 'todos',
      texto: qp.get('q') ?? '',
      soloPuedo: qp.get('puedo') === '1',
    });
    this.texto.set(this.filtros().texto);
    this.destroyRef.onDestroy(() => clearTimeout(this.tecleo));
    this.cargarAlmacenes(qp.get('suc'));
  }

  /** Clic en la franja: filtra ese proceso; otro clic en el mismo lo quita. */
  porProceso(g: string): void {
    const grupo = g as GrupoPendienteSucursal;
    this.poner({ grupo: this.filtros().grupo === grupo ? 'todos' : grupo });
  }

  /**
   * La búsqueda se aplica al dejar de teclear: el resumen es una región viva y, aplicada en cada tecla,
   * el lector de pantalla anunciaba una vez por letra («anfora» = 6 anuncios).
   */
  buscar(t: string): void {
    this.texto.set(t);
    clearTimeout(this.tecleo);
    this.tecleo = setTimeout(() => this.poner({ texto: t }), 300);
  }

  poner(cambio: Partial<Filtros>): void {
    this.filtros.update((f) => ({ ...f, ...cambio }));
    const f = this.filtros();
    void this.router.navigate([], {
      relativeTo: this.route,
      replaceUrl: true,
      queryParamsHandling: 'merge',
      queryParams: {
        quien: f.quien === 'todos' ? null : f.quien,
        proceso: f.grupo === 'todos' ? null : f.grupo,
        q: f.texto.trim() || null,
        puedo: f.soloPuedo ? '1' : null,
      },
    });
  }

  limpiar(): void {
    clearTimeout(this.tecleo);
    this.texto.set('');
    this.poner({ ...SIN_FILTROS });
  }

  alternar(colaId: string): void {
    this.abiertas.update((s) => {
      const n = new Set(s);
      if (n.has(colaId)) n.delete(colaId); else n.add(colaId);
      return n;
    });
  }

  filasVisibles(colaId: string, filas: PendienteSucursalFila[]): PendienteSucursalFila[] {
    return this.abiertas().has(colaId) ? filas : filas.slice(0, this.visibles);
  }

  cargarAlmacenes(preferida?: string | null): void {
    this.cargandoAlmacenes.set(true);
    this.errorAlmacenes.set(null);
    this.api.almacenes().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (a) => {
        this.almacenes.set(a);
        this.cargandoAlmacenes.set(false);
        const inicial = a.find((x) => x.id === (preferida ?? this.sel())) ?? a[0];
        if (inicial && inicial.id !== this.sel()) this.elegir(inicial.id);
      },
      error: (e: unknown) => {
        this.cargandoAlmacenes.set(false);
        this.errorAlmacenes.set(mensaje(e));
      },
    });
  }

  elegir(id: string): void {
    this.sel.set(id);
    this.resp.set(null);
    this.abiertas.set(new Set());
    void this.router.navigate([], { relativeTo: this.route, replaceUrl: true, queryParamsHandling: 'merge', queryParams: { suc: id } });
    this.cargar();
  }

  cargar(): void {
    const id = this.sel();
    if (!id) return;
    this.cargando.set(true);
    this.error.set(null);
    this.api.pendientes(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.resp.set(r);
        this.cargadoEn.set(new Date(r.generado_en));
        this.cargando.set(false);
      },
      error: (e: unknown) => {
        this.cargando.set(false);
        this.error.set(mensaje(e));
      },
    });
  }

  private llave(c: ColaSucursal, f: PendienteSucursalFila): string {
    return `${c.id}\u0000${f.clave}`;
  }

  ocupado(c: ColaSucursal, f: PendienteSucursalFila): boolean {
    return this.enVuelo().has(this.llave(c, f));
  }

  atribuir(c: ColaSucursal, f: PendienteSucursalFila): void {
    this.escribir(c, f, 'atribuir');
  }

  soltar(c: ColaSucursal, f: PendienteSucursalFila): void {
    this.escribir(c, f, 'soltar');
  }

  private escribir(c: ColaSucursal, f: PendienteSucursalFila, que: 'atribuir' | 'soltar'): void {
    const wh = this.sel();
    const k = this.llave(c, f);
    if (!wh || this.enVuelo().has(k)) return;
    this.enVuelo.update((s) => new Set([...s, k]));
    const fin = () => this.enVuelo.update((s) => { const n = new Set(s); n.delete(k); return n; });
    const body = { warehouse_id: wh, cola: c.id, clave: f.clave };
    // Tipado a `Observable<unknown>`: la unión de los dos Observable no deja llamar a `.pipe()`.
    const llamada: Observable<unknown> = que === 'atribuir' ? this.api.atribuir(body) : this.api.soltar(body);
    llamada.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { fin(); this.cargar(); },
      error: (e: unknown) => {
        fin();
        this.toast.add({ severity: 'warn', summary: que === 'atribuir' ? 'No se pudo tomar' : 'No se pudo soltar', detail: mensaje(e), life: 6000 });
        this.cargar();
      },
    });
  }

  grupo(c: ColaSucursal): string {
    return GRUPO_LABEL[c.grupo];
  }

  dinero(n: number): string {
    return Number(n).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }
}

function mensaje(e: unknown): string {
  if (e instanceof HttpErrorResponse) {
    const m = (e.error as { message?: unknown } | null)?.message;
    if (typeof m === 'string' && m) return m;
    if (e.status === 403) return 'No tienes acceso a los pendientes de esa sucursal.';
  }
  return 'No se pudieron leer los pendientes.';
}
