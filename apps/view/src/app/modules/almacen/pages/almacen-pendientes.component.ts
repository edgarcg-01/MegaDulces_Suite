import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import type { ColaSucursal, SucursalPendientesAlmacen, SucursalPendientesResponse } from '@megadulces/contracts';
import { SucursalPendientesService } from '../sucursal-pendientes.service';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { GRUPO_LABEL, porGrupo, repartir, veredicto } from '../pendientes-sucursal.util';

/**
 * `[AB.44]` → `[AB.45]` **Pendientes de la sucursal** (`/almacen/pendientes`): TODO lo que la Suite
 * tiene abierto de una sucursal, en una pantalla. Edgar (2026-11-03): «aquí deben estar todos los
 * pendientes de la Suite que tiene la sucursal». Una sola llamada
 * (`GET /commercial/sucursal-pendientes`); qué es pendiente lo decide el registro del servidor.
 *
 * ── Las cinco preguntas (skill `diseno` §0b) ────────────────────────────────────────────────────
 * 1. Qué ve y en qué orden: el veredicto (cuántos pendientes, en cuántas colas, cuánto espera el más
 *    viejo); la franja por proceso; las colas con trabajo, la que más espera primero, y dentro de cada
 *    una, lo más viejo primero.
 * 2. Qué no: las colas en cero son una línea («al día»), no secciones. Lo que espera a OTRA área se ve
 *    abajo, compacto, y no suma. Lo que se buscó y no entra se lista con su porqué, plegado.
 * 3. Accesibilidad: folio, detalle (de quién, qué) y días en la fila; la pantalla que lo resuelve a un
 *    clic, con el filtro puesto si la pantalla lo acepta. Hasta 10 filas por cola; el total siempre.
 * 4. Ligado a: cada cola lleva a su pantalla dueña; el traspaso se recibe en Kepler.
 * 5. Le toca: sólo viajan las colas cuya pantalla la persona puede abrir.
 *
 * Jerarquía: primario = el veredicto; secundario = cada cola (qué es, cuántos, qué hacer); terciario =
 * folios, importes, ventanas y lo de otra área.
 */
@Component({
  selector: 'app-almacen-pendientes',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, TableModule, ButtonModule, SelectModule, TagModule,
    LoadStateComponent, FreshnessPillComponent, MetricStripComponent, ContextHelpComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in pen-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1 class="pen-h1">Pendientes de la sucursal <app-context-help topic="almacen-pendientes" /></h1>
          @if (almacenes().length > 1) {
            <p-select [options]="almacenes()" optionLabel="name" optionValue="id" [ngModel]="sel()" (ngModelChange)="elegir($event)"
                      inputId="pen-suc" ariaLabel="Sucursal" appendTo="body" class="pen-suc"></p-select>
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
                      emptyHint="Tu alcance en Almacén no incluye ninguna sucursal. Pídele a Sistemas que te la asigne."
                      (retry)="cargarAlmacenes()">
        <app-load-state [loading]="cargando() && !resp()" [error]="error()" [isEmpty]="!!resp() && !resp()!.colas.length"
                        emptyIcon="pi-lock" emptyTitle="No ves ninguna cola de pendientes"
                        emptyHint="Tu puesto no abre ninguna de las pantallas donde se resuelven." (retry)="cargar()">
          @if (resp()) {
            <p class="pen-veredicto" role="status">{{ frase() }}</p>
            @if (nota(); as n) { <p class="pen-nota">{{ n }}</p> }
            <app-metric-strip [items]="kpis()" ariaLabel="Pendientes de la sucursal por proceso"></app-metric-strip>

            @for (c of reparto().conTrabajo; track c.id) {
              <section class="pen-sec" [attr.aria-labelledby]="'pen-h-' + c.id">
                <div class="pen-sec-head">
                  <div>
                    <h2 class="pen-h2" [id]="'pen-h-' + c.id">{{ c.label }}</h2>
                    <p class="pen-sub">{{ grupo(c) }} · {{ c.accion }}@if (c.ventana) { · {{ c.ventana }} }</p>
                  </div>
                  <span class="pen-cuenta">{{ c.total | number }}</span>
                  <a pButton class="p-button-sm p-button-text pen-ir" [routerLink]="c.ruta" [queryParams]="c.query">
                    <span class="p-button-label">Resolver</span><i class="pi pi-arrow-right" aria-hidden="true"></i>
                  </a>
                </div>
                <div class="dt-scope">
                  <p-table [value]="c.filas" size="small" class="surf-table surf-table--plain dt-stack">
                    <ng-template #header>
                      <tr><th>Folio</th><th>Detalle</th><th class="comm-num">Días</th><th class="comm-num">Importe</th></tr>
                    </ng-template>
                    <ng-template #body let-f>
                      <tr>
                        <td class="dt-id" data-label="Folio" role="cell"><span class="pen-folio">{{ f.folio || '—' }}</span></td>
                        <td data-label="Detalle" role="cell">{{ f.detalle || '—' }}</td>
                        <td class="comm-num dt-num" data-label="Días" role="cell">{{ f.dias == null ? '—' : (f.dias | number) }}</td>
                        <td class="comm-num dt-num" data-label="Importe" role="cell">{{ f.monto == null ? '—' : dinero(f.monto) }}</td>
                      </tr>
                    </ng-template>
                  </p-table>
                </div>
                @if (c.total > c.filas.length) {
                  <p class="pen-tenue">Se muestran {{ c.filas.length }} de {{ c.total | number }}, las más viejas primero. El resto, en «Resolver».</p>
                }
              </section>
            }

            @for (c of reparto().sinLeer; track c.id) {
              <section class="pen-sec pen-sinleer" role="alert">
                <h2 class="pen-h2">{{ c.label }}</h2>
                <p class="pen-sub"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ c.motivo || 'No se pudo leer esta cola.' }} No quiere decir que esté en cero.</p>
              </section>
            }

            @if (reparto().alDia.length) {
              <p class="pen-aldia"><i class="pi pi-check-circle" aria-hidden="true"></i> Al día: {{ alDiaTexto() }}.</p>
            }

            @if (reparto().otraArea.length) {
              <section class="pen-sec" aria-labelledby="pen-h-otra">
                <h2 class="pen-h2" id="pen-h-otra">Abierto en tu sucursal, lo atiende otra área</h2>
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
                          <a pButton class="p-button-sm p-button-text" [routerLink]="c.ruta" [queryParams]="c.query" [attr.aria-label]="'Ver ' + c.label">
                            <span class="p-button-label">Ver</span>
                          </a>
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
    .pen-sec { margin-top: var(--sp-6); }
    .pen-sec-head { display: flex; flex-wrap: wrap; align-items: flex-start; gap: var(--sp-3); margin-bottom: var(--sp-2); }
    .pen-h2 { margin: 0; font-size: var(--fs-h3); font-weight: 600; color: var(--text-main); }
    .pen-sub { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .pen-cuenta { font-size: var(--fs-h3); font-weight: 600; color: var(--text-main); font-variant-numeric: tabular-nums; }
    .pen-ir { margin-left: auto; }
    .pen-folio { font-family: var(--font-mono, monospace); }
    .pen-tenue { margin: var(--sp-2) 0 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .pen-sinleer .pen-sub { color: var(--warn-fg); }
    .pen-aldia { margin: var(--sp-6) 0 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .pen-aldia .pi { color: var(--ok-fg); }
    .pen-fuera { margin-top: var(--sp-6); font-size: var(--fs-sm); color: var(--text-muted); }
    .pen-fuera summary { cursor: pointer; }
    .pen-fuera ul { margin: var(--sp-2) 0 0; padding-left: var(--sp-6); }
    .pen-fuera li { margin-bottom: var(--sp-1); }
    .pen-oculto { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    @container (max-width: 48rem) { .pen-ir { margin-left: 0; } }
  `],
})
export class AlmacenPendientesComponent implements OnInit {
  private readonly api = inject(SucursalPendientesService);
  private readonly destroyRef = inject(DestroyRef);

  readonly almacenes = signal<SucursalPendientesAlmacen[]>([]);
  readonly cargandoAlmacenes = signal(true);
  readonly errorAlmacenes = signal<string | null>(null);
  readonly sel = signal<string | null>(null);
  readonly almacenActual = computed(() => this.almacenes().find((a) => a.id === this.sel()) ?? null);

  readonly resp = signal<SucursalPendientesResponse | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly cargadoEn = signal<Date | null>(null);

  readonly reparto = computed(() => repartir(this.resp()?.colas ?? []));
  private readonly ver = computed(() => veredicto(this.resp()?.colas ?? []));

  readonly frase = computed(() => {
    const v = this.ver();
    if (!v.total) return v.sinLeer ? 'Sin pendientes en lo que se pudo leer' : 'Al día: la sucursal no tiene pendientes';
    const viejo = v.masViejo ? ` · el más viejo espera ${v.masViejo} ${v.masViejo === 1 ? 'día' : 'días'}` : '';
    return `${v.total.toLocaleString('es-MX')} ${v.total === 1 ? 'pendiente' : 'pendientes'} en ${v.colas} ${v.colas === 1 ? 'cola' : 'colas'}${viejo}`;
  });

  readonly nota = computed(() => {
    const n = this.ver().sinLeer;
    if (!n) return null;
    return `${n === 1 ? 'Una cola no se pudo leer' : `${n} colas no se pudieron leer`}: el total no la incluye.`;
  });

  readonly kpis = computed<MetricStripItem[]>(() => porGrupo(this.resp()?.colas ?? []).map((g) => ({
    label: GRUPO_LABEL[g.grupo],
    value: g.total,
    format: 'number',
    tone: g.total ? 'warn' : 'ok',
    state: g.sinLeer ? 'parcial' : undefined,
    stateNote: g.sinLeer ? 'Una de sus colas no se pudo leer' : undefined,
  })));

  readonly alDiaTexto = computed(() => this.reparto().alDia.map((c) => c.label.charAt(0).toLowerCase() + c.label.slice(1)).join(' · '));

  ngOnInit(): void {
    this.cargarAlmacenes();
  }

  cargarAlmacenes(): void {
    this.cargandoAlmacenes.set(true);
    this.errorAlmacenes.set(null);
    this.api.almacenes().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (a) => {
        this.almacenes.set(a);
        this.cargandoAlmacenes.set(false);
        if (a.length && !a.some((x) => x.id === this.sel())) this.elegir(a[0].id);
      },
      error: (e) => {
        this.cargandoAlmacenes.set(false);
        this.errorAlmacenes.set(mensaje(e));
      },
    });
  }

  elegir(id: string): void {
    this.sel.set(id);
    this.resp.set(null);
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
      error: (e) => {
        this.cargando.set(false);
        this.error.set(mensaje(e));
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
