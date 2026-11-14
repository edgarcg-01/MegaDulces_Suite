import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { rxResource } from '@angular/core/rxjs-interop';
import { InputTextModule } from 'primeng/inputtext';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { warehouseName, type AvanceDePersona } from '@megadulces/contracts';
import { coincideBusqueda } from '@megadulces/ui-web';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { TareasService } from '../tareas.service';
import { etiquetaEstado, fechaMx, horaComun, horaDe, severidadEstado } from '../tareas-formato';

/**
 * `[MDT.3.3]` Tareas de mi equipo — ¿quién de mi gente va atrasado hoy?
 *
 * La gente es la de MI cadena de mando (y mi sucursal, si tengo una): lo decide el servidor. La tabla
 * abre por atraso (más vencidas primero), no alfabética. El detalle de cada persona va en un panel
 * lateral, y cada tarea abre su entrega en sólo lectura.
 */
@Component({
  selector: 'app-tareas-equipo',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, InputTextModule, TableModule, TagModule, LoadStateComponent, FreshnessPillComponent, MetricStripComponent,
    SegmentedComponent, SidePeekComponent, ContextHelpComponent, SucursalPipe],
  template: `
    <div class="surf-page tq-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Tareas de mi equipo</h1>
          <p class="surf-page-sub">Lo que el manual le pide a la gente a tu cargo y cuánto lleva entregado. Un punto cuenta cuando tiene evidencia.</p>
        </div>
        <div class="tq-acciones">
          <app-freshness-pill measures="fetch" [since]="cargado()" label="Actualizado" [staleAfterSec]="900" />
          <app-context-help topic="tareas-puesto" />
        </div>
      </header>

      @if (datos()) {
        <app-metric-strip [items]="kpis()" ariaLabel="Avance del equipo" />
        <!-- Los límites se leen SIN abrir nada, junto al veredicto (MDT.UI.1 y MDT.UI.2): acusan o absuelven a alguien. -->
        @if (limites().length) {
          <ul class="tq-limites" aria-label="Lo que esta vista no sabe">
            @for (n of limites(); track n) { <li>{{ n }}</li> }
          </ul>
        }
      }
      <div class="tq-filtros">
        <app-segmented [options]="dias" [value]="dia()" (valueChange)="dia.set($event)" ariaLabel="Qué día ver" />
        <input pInputText type="search" enterkeyhint="search" class="tq-buscar" [value]="busqueda()" (input)="busqueda.set($any($event.target).value)"
               placeholder="Buscar por nombre, puesto o sucursal" aria-label="Buscar persona" />
      </div>

      <app-load-state [loading]="res.isLoading() && !datos()" [error]="error()" [isEmpty]="!!datos() && !visibles().length"
                      emptyIcon="pi-users" [emptyTitle]="busqueda() ? 'Nadie coincide con la búsqueda' : 'No hay gente a tu cargo con tareas del manual'"
                      [emptyHint]="busqueda() ? null : 'Tu equipo sale del organigrama: los puestos que dependen del tuyo (y tu sucursal, si tienes una).'"
                      (retry)="res.reload()">
        <p-table [value]="visibles()" dataKey="user_id" size="small" class="surf-table surf-table--plain surf-table--sticky dt-stack"
                 [rowHover]="true" selectionMode="single" [selection]="elegida()" (onRowSelect)="elegir($event.data)">
          <ng-template #header>
            <tr>
              <th scope="col">Persona</th>
              <th scope="col">Sucursal</th>
              <th scope="col" class="comm-num">Entregadas</th>
              <th scope="col" class="comm-num">Vencidas</th>
              <th scope="col" class="comm-num">Puntos con evidencia</th>
            </tr>
          </ng-template>
          <ng-template #body let-p>
            <tr [pSelectableRow]="p" tabindex="0" (keydown.enter)="elegida.set(p)">
              <td data-label="Persona"><span class="tq-nombre">{{ p.nombre }}</span><span class="tq-sub">{{ p.position_name || 'Sin puesto' }}</span></td>
              <td data-label="Sucursal">{{ p.warehouse_code ? (p.warehouse_code | sucursal) : 'Corporativo' }}</td>
              <td data-label="Entregadas" class="comm-num">{{ p.entregadas }} de {{ p.tareas }}</td>
              <td data-label="Vencidas" class="comm-num">
                @if (p.vencidas) { <p-tag [value]="'' + p.vencidas" severity="danger" /> } @else { <span class="tq-tenue">0</span> }
              </td>
              <td data-label="Puntos con evidencia" class="comm-num">{{ pct(p) }} <span class="tq-sub">{{ p.puntos.hechos }} de {{ p.puntos.total }}</span></td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>


      <app-side-peek [open]="!!elegida()" (openChange)="!$event && elegida.set(null)" [title]="elegida()?.nombre ?? ''"
                     [subtitle]="elegida()?.position_name ?? null">
        @if (elegida(); as p) {
          <ul class="tq-tareas" aria-label="Tareas del día">
            @for (t of p.detalle; track t.template_id) {
              <li class="tq-tarea">
                <span class="tq-tarea-cuerpo">
                  @if (t.run_id) {
                    <a [routerLink]="['/tareas/entrega', t.run_id]" [queryParams]="{ desde: 'equipo' }">{{ t.name }}</a>
                  } @else {
                    <span>{{ t.name }}</span>
                  }
                  <span class="tq-sub">vence {{ horaDe(t.due_at) }} · {{ t.avance.hechos }} de {{ t.avance.total }} puntos</span>
                </span>
                @if (t.vencida) { <p-tag value="Vencida" severity="danger" /> }
                @else { <p-tag [value]="etiquetaEstado(t.estado)" [severity]="severidadEstado(t.estado)" /> }
              </li>
            } @empty {
              <li class="tq-sub">El manual de su puesto no le pide tareas este día.</li>
            }
          </ul>
          <p class="tq-sub">Una tarea sin abrir no tiene entrega que ver: sólo la persona la abre.</p>
        }
      </app-side-peek>
    </div>
  `,
  styles: [`
    :host { display: block; container-type: inline-size; }
    .tq-page { display: flex; flex-direction: column; gap: var(--sp-4); }
    .tq-acciones { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .tq-filtros { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); }
    .tq-buscar { flex: 1 1 16rem; max-width: 24rem; }
    .tq-nombre { display: block; font-weight: 600; }
    .tq-sub { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
    .tq-tenue { color: var(--text-faint); }
    .tq-limites { margin: 0; padding-left: var(--sp-5); font-size: var(--fs-sm); color: var(--text-main); display: flex; flex-direction: column; gap: var(--sp-1); }
    .tq-tareas { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    .tq-tarea { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); min-height: 44px;
      padding: var(--sp-2) 0; border-bottom: 1px solid var(--border-color); }
    .tq-tarea-cuerpo { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
    @container (max-width: 40rem) { .tq-buscar { max-width: none; } }
  `],
})
export class TareasEquipoComponent {
  private readonly svc = inject(TareasService);

  readonly etiquetaEstado = etiquetaEstado;
  readonly severidadEstado = severidadEstado;
  readonly horaDe = horaDe;

  readonly dias: SegOption[] = [{ label: 'Hoy', value: 'hoy' }, { label: 'Ayer', value: 'ayer' }];
  readonly dia = signal('hoy');
  readonly busqueda = signal('');
  readonly elegida = signal<AvanceDePersona | null>(null);
  readonly cargado = signal<Date | null>(null);

  readonly res = rxResource({
    params: () => ({ fecha: this.dia() === 'ayer' ? fechaMx(-1) : null }),
    stream: ({ params }) => this.svc.equipo(params.fecha),
  });
  readonly datos = computed(() => (this.res.hasValue() ? this.res.value() : null));
  private readonly alCargar = effect(() => { if (this.datos()) untracked(() => this.cargado.set(new Date())); });
  readonly error = computed(() => {
    const e = this.res.error();
    return e ? (e instanceof HttpErrorResponse ? e.error?.message || e.message : 'No se pudo cargar el equipo') : null;
  });

  /** El servidor ya ordena por atraso; la búsqueda sólo filtra. */
  readonly visibles = computed(() => {
    const q = this.busqueda();
    return (this.datos()?.personas ?? []).filter((p) => coincideBusqueda(q, p.nombre, p.position_name, p.warehouse_code, p.warehouse_code ? warehouseName(p.warehouse_code) : 'Corporativo'));
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const ps = this.datos()?.personas ?? [];
    const conVencidas = ps.filter((p) => p.vencidas > 0).length;
    const total = ps.reduce((s, p) => s + p.puntos.total, 0);
    const hechos = ps.reduce((s, p) => s + p.puntos.hechos, 0);
    const porEntregar = ps.reduce((s, p) => s + p.pendientes + p.en_proceso, 0);
    const conPendientes = ps.filter((p) => p.pendientes + p.en_proceso > 0).length;
    const h = this.hora();
    return [
      { label: 'Personas con tareas por entregar', value: conPendientes, tone: conPendientes ? 'warn' : 'ok', sub: `${porEntregar} tareas · de ${ps.length} personas` },
      // Cero vencidas NO es verde mientras todo venza al cierre: a media tarde no sabe nada (MDT.UI.1).
      { label: 'Con tareas vencidas', value: conVencidas, tone: conVencidas ? 'bad' : 'default', sub: h ? `todo vence a las ${h}` : undefined },
      total
        ? { label: 'Puntos con evidencia', value: Math.round((hechos / total) * 100), format: 'percent', sub: `${hechos} de ${total}` }
        : { label: 'Puntos con evidencia', value: '—', sub: 'sin puntos este día' },
    ];
  });

  /** La hora límite común a todas las tareas del equipo, si la hay. */
  readonly hora = computed(() => {
    const isos: string[] = [];
    for (const p of this.datos()?.personas ?? []) for (const t of p.detalle) isos.push(t.due_at);
    return horaComun(isos);
  });

  /** Lo que la vista no sabe, más la advertencia de la hora límite cuando todo vence al cierre. */
  readonly limites = computed(() => {
    const h = this.hora();
    const extra = h ? [`todas las tareas vencen al final del día (${h}): la Suite todavía no tiene el horario de cada sucursal, así que no sabe si una apertura va tarde`] : [];
    return [...extra, ...(this.datos()?.no_responde ?? [])];
  });

  /** `onRowSelect` tipa `data` como fila o lista (por la selección múltiple): aquí sólo hay una. */
  elegir(d: AvanceDePersona | AvanceDePersona[] | undefined): void {
    if (d && !Array.isArray(d)) this.elegida.set(d);
  }

  pct(p: AvanceDePersona): string {
    return p.puntos.total ? `${Math.round((p.puntos.hechos / p.puntos.total) * 100)} %` : '—';
  }
}
