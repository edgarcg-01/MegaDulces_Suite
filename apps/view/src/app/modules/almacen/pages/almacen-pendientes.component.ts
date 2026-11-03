import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import type { SucursalPendientesAlmacen } from '@megadulces/contracts';
import { AutoabastoService } from '../autoabasto.service';
import { EntradasService } from '../../compras/entradas.service';
import { PickingService } from '../../reparto/picking.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import {
  hoyMx, ordenarSecciones, seccionEntradas, seccionLlega, seccionSurtido, veredicto,
  type EstadoSeccion, type Seccion, type SeccionId,
} from '../pendientes-sucursal.util';

/** Ventana de Entradas: la MISMA de la bandeja «Entradas sin comprobante» de Mi trabajo (`me-work.ts`). */
const ENTRADAS_VENTANA_DIAS = 90;
/** Cuántas entradas se listan. El total viene del servidor, así que lo recortado se dice. */
const ENTRADAS_TOPE = 50;

const TITULO: Record<SeccionId, string> = {
  llega: 'Lo que te va a llegar',
  entradas: 'Entradas sin comprobante',
  surtido: 'Surtidos',
};

/**
 * `[AB.44]` **Pendientes de la sucursal** (`/almacen/pendientes`): qué tiene que hacer HOY la sucursal,
 * en una pantalla. No calcula nada propio: lee los endpoints dueños de cada proceso (Autoabasto,
 * Entradas, Consola de surtido) con su permiso y su alcance, y decide qué es pendiente en
 * `pendientes-sucursal.util.ts`.
 *
 * ── Las cinco preguntas (skill `diseno` §0b), contestadas antes de la plantilla ──────────────────
 * 1. Qué ve y en qué orden: el veredicto (cuántos pendientes y cuánto espera el más viejo), y las
 *    secciones ordenadas por su pendiente más viejo; dentro, lo más viejo primero.
 * 2. Qué no: lo que espera a OTRA área (pedido sin embarcar, requisición por aprobar) es una línea, no
 *    filas. Fuera por medición (2026-11-03): arqueos sin validar (los valida otra área), cortes (sólo
 *    existen para la matriz), reclamos de recepción (0 filas jamás), conteos (0 activos), hojas de
 *    caducidad en borrador (restos del flujo de hoja que `/tienda/caducidades` reemplazó el
 *    2026-09-08), existencia negativa (es de Prevención, Fase MX) y la caducidad al recibir en el
 *    Andén (0 vales desde el 7-oct: no se pinta un «520» diario hasta que Edgar decida si es trabajo
 *    de la sucursal).
 * 3. Accesibilidad: folio, de quién viene y días esperando en la fila; la pantalla que lo resuelve a
 *    un clic, con el filtro puesto donde la pantalla lo acepta (Entradas: sucursal + pendientes).
 * 4. Ligado a: el traspaso se recibe en KEPLER (`U-A-50`; la Suite no escribe ahí); la entrada se
 *    resuelve en `/compras/entradas`; el surtido en la consola.
 * 5. Le toca: sí, a la sucursal. Cada sección se pinta sólo con el permiso de la pantalla que la
 *    resuelve; sin ninguno, la ruta no abre (`anyPermissionGuard`).
 *
 * Jerarquía: primario = el veredicto; secundario = cada pendiente (qué es y qué hacer); terciario =
 * folio, importe y lo que espera a otra área.
 */
@Component({
  selector: 'app-almacen-pendientes',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, TableModule, ButtonModule, SelectModule,
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
          <button pButton type="button" class="p-button-sm p-button-text" icon="pi pi-refresh" (click)="recargar()"
                  [disabled]="!sel()" aria-label="Volver a leer"></button>
        </div>
      </header>

      <app-load-state [loading]="cargandoAlmacenes()" [error]="errorAlmacenes()" [isEmpty]="!cargandoAlmacenes() && !almacenes().length"
                      emptyIcon="pi-building" emptyTitle="No tienes una sucursal asignada"
                      emptyHint="Tu alcance en Almacén no incluye ninguna sucursal. Pídele a Sistemas que te la asigne."
                      (retry)="cargarAlmacenes()">
        @if (sel()) {
          <p class="pen-veredicto" role="status">{{ frase() }}</p>
          @if (nota(); as n) { <p class="pen-nota">{{ n }}</p> }
          <app-metric-strip [items]="kpis()" ariaLabel="Pendientes por proceso"></app-metric-strip>

          @for (s of secciones(); track s.id) {
            <section class="pen-sec" [attr.aria-labelledby]="'pen-h-' + s.id">
              <div class="pen-sec-head">
                <h2 class="pen-h2" [id]="'pen-h-' + s.id">{{ s.titulo }}</h2>
                @if (s.estado.estado === 'ok') {
                  <span class="pen-cuenta">{{ s.estado.data.total ? s.estado.data.total : 'Al día' }}</span>
                  <a pButton class="p-button-sm p-button-text pen-ir" [routerLink]="s.estado.data.ruta"
                     [queryParams]="s.estado.data.queryParams ?? null">
                    <span class="p-button-label">{{ s.estado.data.rutaLabel }}</span>
                    <i class="pi pi-arrow-right" aria-hidden="true"></i>
                  </a>
                }
              </div>
              <app-load-state class="dt-scope" [loading]="s.estado.estado === 'cargando'"
                              [error]="s.estado.estado === 'error' ? s.estado.mensaje : null"
                              [isEmpty]="s.estado.estado === 'ok' && !s.estado.data.pendientes.length"
                              [skeletonRows]="3" emptyIcon="pi-check-circle" emptyTitle="Nada pendiente aquí"
                              [emptyHint]="s.estado.estado === 'ok' ? s.estado.data.informativo : null"
                              (retry)="cargarSeccion(s.id)">
                @if (s.estado.estado === 'ok' && s.estado.data.pendientes.length) {
                  <p-table [value]="s.estado.data.pendientes" dataKey="clave" size="small"
                           class="surf-table surf-table--plain dt-stack">
                    <ng-template #header>
                      <tr>
                        <th>Pendiente</th>
                        <th>Folio</th>
                        <th class="comm-num">Días</th>
                        <th class="comm-num">Importe</th>
                        <th>Qué hacer</th>
                      </tr>
                    </ng-template>
                    <ng-template #body let-p>
                      <tr>
                        <td class="dt-id" data-label="Pendiente" role="cell">
                          <span class="pen-que">{{ p.titulo }}</span>
                          <span class="pen-tenue">{{ p.detalle }}</span>
                        </td>
                        <td data-label="Folio" role="cell"><span class="pen-folio">{{ p.folio || '—' }}</span></td>
                        <td class="comm-num dt-num" data-label="Días" role="cell">
                          {{ p.dias == null ? '—' : (p.dias | number) }}
                        </td>
                        <td class="comm-num dt-num" data-label="Importe" role="cell">{{ p.monto == null ? '—' : dinero(p.monto) }}</td>
                        <td data-label="Qué hacer" role="cell">{{ p.accion }}</td>
                      </tr>
                    </ng-template>
                  </p-table>
                  @if (s.estado.data.total > s.estado.data.pendientes.length) {
                    <p class="pen-tenue pen-recorte">Se muestran {{ s.estado.data.pendientes.length }} de {{ s.estado.data.total }}, las más viejas primero. El resto, en «{{ s.estado.data.rutaLabel }}».</p>
                  }
                  @if (s.estado.data.informativo) { <p class="pen-tenue pen-info">{{ s.estado.data.informativo }}</p> }
                }
              </app-load-state>
            </section>
          }
          @if (!secciones().length) {
            <p class="pen-nota">Tu puesto no tiene permiso en ninguno de los procesos que esta pantalla junta.</p>
          }
        }
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
    .pen-sec-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-2); margin-bottom: var(--sp-2); }
    .pen-h2 { margin: 0; font-size: var(--fs-h3); font-weight: 600; color: var(--text-main); }
    .pen-cuenta { font-size: var(--fs-sm); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .pen-ir { margin-left: auto; }
    .pen-que { display: block; color: var(--text-main); font-weight: 600; }
    .pen-tenue { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
    .pen-folio { font-family: var(--font-mono, monospace); }
    .pen-recorte, .pen-info { margin-top: var(--sp-2); }
    @container (max-width: 48rem) { .pen-ir { margin-left: 0; } }
  `],
})
export class AlmacenPendientesComponent implements OnInit {
  private readonly autoabasto = inject(AutoabastoService);
  private readonly entradasApi = inject(EntradasService);
  private readonly picking = inject(PickingService);
  private readonly perms = inject(PermissionsService);
  private readonly destroyRef = inject(DestroyRef);

  /** Qué secciones ve esta persona: el permiso de la pantalla que resuelve cada una. */
  private readonly ve: Record<SeccionId, boolean> = {
    llega: this.perms.has(Permission.AUTOABASTO_VER),
    entradas: this.perms.has(Permission.COMPRAS_ENTRADAS_VER),
    surtido: this.perms.has(Permission.ALMACEN_SURTIDO_COORDINAR),
  };

  readonly almacenes = signal<SucursalPendientesAlmacen[]>([]);
  readonly cargandoAlmacenes = signal(true);
  readonly errorAlmacenes = signal<string | null>(null);
  readonly sel = signal<string | null>(null);
  readonly cargadoEn = signal<Date | null>(null);
  readonly almacenActual = computed(() => this.almacenes().find((a) => a.id === this.sel()) ?? null);

  private readonly estados = signal<Record<SeccionId, EstadoSeccion<Seccion>>>({
    llega: { estado: 'sin_permiso' }, entradas: { estado: 'sin_permiso' }, surtido: { estado: 'sin_permiso' },
  });

  /** Las secciones que la persona ve, con su estado. Las leídas, por su pendiente más viejo. */
  readonly secciones = computed(() => {
    const e = this.estados();
    const visibles = (Object.keys(e) as SeccionId[]).filter((id) => e[id].estado !== 'sin_permiso');
    const leidas = ordenarSecciones(visibles.flatMap((id) => {
      const x = e[id];
      return x.estado === 'ok' ? [x.data] : [];
    })).map((d) => ({ id: d.id, titulo: d.titulo, estado: e[d.id] }));
    const resto = visibles.filter((id) => e[id].estado !== 'ok').map((id) => ({ id, titulo: TITULO[id], estado: e[id] }));
    return [...leidas, ...resto];
  });

  private readonly ver = computed(() => veredicto(this.secciones().map((s) => s.estado)));

  readonly frase = computed(() => {
    const v = this.ver();
    if (v.cargando && !v.total) return 'Leyendo los pendientes de la sucursal…';
    if (!v.total) return v.sinLeer ? 'Sin pendientes en lo que se pudo leer' : 'Al día: la sucursal no tiene pendientes';
    const viejo = v.masViejo ? ` · el más viejo espera ${v.masViejo} ${v.masViejo === 1 ? 'día' : 'días'}` : '';
    return `${v.total} ${v.total === 1 ? 'pendiente' : 'pendientes'}${viejo}`;
  });

  readonly nota = computed(() => {
    const v = this.ver();
    if (!v.sinLeer) return null;
    return `${v.sinLeer === 1 ? 'Una sección no se pudo leer' : `${v.sinLeer} secciones no se pudieron leer`}: el total no la incluye.`;
  });

  readonly kpis = computed<MetricStripItem[]>(() => this.secciones().map((s) => {
    if (s.estado.estado === 'ok') {
      return { label: s.titulo, value: s.estado.data.total, format: 'number', tone: s.estado.data.total ? 'warn' : 'ok' };
    }
    return {
      label: s.titulo, value: '—', format: 'text', tone: 'muted',
      state: s.estado.estado === 'error' ? 'no_medido' : undefined,
      stateNote: s.estado.estado === 'error' ? 'No se pudo leer' : undefined,
    };
  }));

  ngOnInit(): void {
    this.cargarAlmacenes();
  }

  cargarAlmacenes(): void {
    this.cargandoAlmacenes.set(true);
    this.errorAlmacenes.set(null);
    this.autoabasto.pendientesAlmacenes().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
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
    this.recargar();
  }

  recargar(): void {
    for (const id of Object.keys(this.ve) as SeccionId[]) this.cargarSeccion(id);
    this.cargadoEn.set(new Date());
  }

  cargarSeccion(id: SeccionId): void {
    const a = this.almacenActual();
    if (!this.ve[id] || !a) return;
    this.poner(id, { estado: 'cargando' });
    const hoy = hoyMx();
    const ok = (data: Seccion) => this.poner(id, { estado: 'ok', data });
    const error = (e: unknown) => this.poner(id, { estado: 'error', mensaje: mensaje(e) });
    if (id === 'llega') {
      this.autoabasto.viene(a.id).pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (r) => ok(seccionLlega(r.documentos)), error });
    } else if (id === 'entradas') {
      if (!a.sucursal) {
        // Sin llave de sucursal no hay con qué filtrar Entradas: pedir sin filtro traería toda la red.
        this.poner(id, { estado: 'error', mensaje: 'Este almacén no tiene llave de sucursal: no se pueden filtrar sus entradas.' });
        return;
      }
      const desde = hoyMx(new Date(Date.now() - ENTRADAS_VENTANA_DIAS * 86_400_000));
      const sucursal = a.sucursal;
      // `antiguedad` = lo más viejo primero (el orden de trabajo del capturista).
      this.entradasApi.list({
        warehouse_codes: [sucursal], estado: 'pendiente', from: desde, orden: 'antiguedad',
        page: 1, pageSize: ENTRADAS_TOPE,
      }).pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (r) => ok(seccionEntradas(r.rows, r.total, hoy, sucursal, desde)), error });
    } else {
      this.picking.consola(a.id).pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (c) => ok(seccionSurtido(c, hoy)), error });
    }
  }

  private poner(id: SeccionId, e: EstadoSeccion<Seccion>): void {
    this.estados.update((x) => ({ ...x, [id]: e }));
  }

  dinero(n: number): string {
    return Number(n).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }
}

function mensaje(e: unknown): string {
  if (e instanceof HttpErrorResponse) {
    const m = (e.error as { message?: unknown } | null)?.message;
    if (typeof m === 'string' && m) return m;
    if (e.status === 403) return 'No tienes acceso a esta información para esa sucursal.';
  }
  return 'No se pudo leer esta sección.';
}
