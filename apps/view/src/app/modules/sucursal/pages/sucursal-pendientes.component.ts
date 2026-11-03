import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import type { Observable } from 'rxjs';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import type { ColaSucursal, PendienteSucursalFila, SucursalPendientesAlmacen, SucursalPendientesResponse } from '@megadulces/contracts';
import { SucursalPendientesService } from '../sucursal-pendientes.service';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { GRUPO_LABEL, porGrupo, repartir, veredicto } from '../pendientes-sucursal.util';

/**
 * `[AB.44]` → `[AB.45]` → `[AB.46]` **Pendientes de sucursal** (`/sucursal/pendientes`), módulo propio: TODO
 * lo que la Suite tiene abierto de una sucursal, y quién se encargó de cada cosa.
 *
 * Edgar (2026-11-03): «como módulo, no como submódulo» · «darle acceso a cada persona con la sucursal a la
 * misma información, en oficinas con el selector, para que todos puedan atribuirse el resolver los
 * pendientes». Toda la sucursal ve las mismas colas; «Resolver» lleva a la pantalla dueña sólo a quien su
 * puesto se la abre (`puede_abrir`); cualquiera se atribuye un pendiente.
 *
 * ── Las cinco preguntas (skill `diseno` §0b) ────────────────────────────────────────────────────
 * 1. Qué ve y en qué orden: el veredicto (cuántos, en cuántas colas, cuánto espera el más viejo); la franja
 *    por proceso; las colas con trabajo, la que más espera primero; en cada fila, quién la está resolviendo.
 * 2. Qué no: colas en cero = una línea («al día»); lo de OTRA área, compacto y sin sumar; lo que no entra,
 *    plegado con su porqué. Sin importes de arqueo: la ve toda la sucursal y el arqueo es ciego.
 * 3. Accesibilidad: folio, detalle y días en la fila; «Yo lo resuelvo» en la misma fila (una sola interfaz
 *    por flujo); la pantalla dueña a un clic, con su filtro.
 * 4. Ligado a: cada cola a su pantalla dueña; el traspaso se recibe en Kepler.
 * 5. Le toca: a toda la sucursal; la sucursal la fija su alcance (oficinas eligen).
 *
 * Jerarquía: primario = el veredicto; secundario = cada pendiente y quién lo tiene; terciario = folios,
 * importes, ventanas y lo de otra área.
 */
@Component({
  selector: 'app-sucursal-pendientes',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, TableModule, ButtonModule, SelectModule, ToastModule,
    LoadStateComponent, FreshnessPillComponent, MetricStripComponent, ContextHelpComponent],
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
                      emptyHint="Tu ficha no tiene sucursal y tu alcance no incluye ninguna. Pídele a Sistemas que te la asigne."
                      (retry)="cargarAlmacenes()">
        <app-load-state [loading]="cargando() && !resp()" [error]="error()" [isEmpty]="false" (retry)="cargar()">
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
                  @if (c.puede_abrir) {
                    <a pButton class="p-button-sm p-button-text pen-ir" [routerLink]="c.ruta" [queryParams]="c.query">
                      <span class="p-button-label">Resolver</span><i class="pi pi-arrow-right" aria-hidden="true"></i>
                    </a>
                  } @else {
                    <span class="pen-sin-acceso">Se resuelve en una pantalla que tu puesto no abre</span>
                  }
                </div>
                <div class="dt-scope">
                  <p-table [value]="c.filas" dataKey="clave" size="small" class="surf-table surf-table--plain dt-stack">
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
                            <span class="pen-resp" [class.pen-resp--yo]="r.soy_yo">{{ r.soy_yo ? 'Tú' : r.nombre }}</span>
                            <span class="pen-tenue">desde {{ r.desde | date:'d MMM, HH:mm' }}</span>
                            @if (r.soy_yo) {
                              <button pButton type="button" class="p-button-sm p-button-text" [disabled]="ocupado(c, f)"
                                      (click)="soltar(c, f)" [attr.aria-label]="'Soltar ' + f.folio">
                                <span class="p-button-label">Soltar</span>
                              </button>
                            }
                          } @else {
                            <button pButton type="button" class="p-button-sm p-button-outlined" [disabled]="ocupado(c, f)"
                                    (click)="atribuir(c, f)" [attr.aria-label]="'Yo resuelvo ' + f.folio">
                              <span class="p-button-label">Yo lo resuelvo</span>
                            </button>
                          }
                        </td>
                      </tr>
                    </ng-template>
                  </p-table>
                </div>
                @if (c.total > c.filas.length) {
                  <p class="pen-tenue pen-recorte">Se muestran {{ c.filas.length }} de {{ c.total | number }}, las más viejas primero.@if (c.puede_abrir) { El resto, en «Resolver». }</p>
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
    .pen-ir, .pen-sin-acceso { margin-left: auto; }
    .pen-sin-acceso { font-size: var(--fs-xs); color: var(--text-muted); align-self: center; }
    .pen-folio { font-family: var(--font-mono, monospace); }
    .pen-quien { white-space: nowrap; }
    .pen-resp { font-weight: 600; color: var(--text-main); margin-right: var(--sp-2); }
    .pen-resp--yo { color: var(--ok-fg); }
    .pen-tenue { font-size: var(--fs-xs); color: var(--text-muted); }
    .pen-recorte { display: block; margin: var(--sp-2) 0 0; }
    .pen-sinleer .pen-sub { color: var(--warn-fg); }
    .pen-aldia { margin: var(--sp-6) 0 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .pen-aldia .pi { color: var(--ok-fg); }
    .pen-fuera { margin-top: var(--sp-6); font-size: var(--fs-sm); color: var(--text-muted); }
    .pen-fuera summary { cursor: pointer; }
    .pen-fuera ul { margin: var(--sp-2) 0 0; padding-left: var(--sp-6); }
    .pen-fuera li { margin-bottom: var(--sp-1); }
    .pen-oculto { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    @container (max-width: 48rem) { .pen-ir, .pen-sin-acceso { margin-left: 0; } .pen-quien { white-space: normal; } }
  `],
})
export class SucursalPendientesComponent implements OnInit {
  private readonly api = inject(SucursalPendientesService);
  private readonly toast = inject(MessageService);
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
  /** Filas con una atribución en vuelo: el botón se apaga en el PRIMER clic (idempotencia visual). */
  private readonly enVuelo = signal<ReadonlySet<string>>(new Set());

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
