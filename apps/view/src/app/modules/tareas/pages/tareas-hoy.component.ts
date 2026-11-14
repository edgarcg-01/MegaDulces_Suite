import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { rxResource } from '@angular/core/rxjs-interop';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { DIAS_ENTREGA_TARDIA, ORDEN_MOMENTO, type TareaDelDia } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { TareasService } from '../tareas.service';
import { etiquetaEstado, etiquetaMomento, fechaLarga, fechaMx, horaComun, horaDe, severidadEstado } from '../tareas-formato';

/**
 * `[MDT.3.1]` Mis tareas de hoy — lo que el manual de mi puesto me pide hoy y todavía no entregué.
 *
 * Móvil primero (la anaquelista entrega desde el piso): cada tarea es un objetivo de 44 px que abre su
 * entrega. Lo pendiente y lo vencido primero, lo entregado al final. La lista se DERIVA de la norma en
 * el servidor (D3): no hay un emisor que la cree, así que una tarea sin abrir aparece «pendiente».
 */
@Component({
  selector: 'app-tareas-hoy',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, SelectModule, TagModule, ToastModule, LoadStateComponent, FreshnessPillComponent, MetricStripComponent, SegmentedComponent, ContextHelpComponent],
  providers: [MessageService],
  template: `
    <div class="surf-page th-page">
      <p-toast position="top-center"></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Mis tareas del manual</h1>
          <p class="surf-page-sub">
            @if (datos()?.position_name; as puesto) { {{ puesto }} · } {{ fechaLarga(datos()?.fecha) }}.
            @if (hora(); as h) { Todo vence a las {{ h }}. } Un punto cuenta como hecho cuando tiene su evidencia.
          </p>
        </div>
        <div class="th-acciones">
          <app-freshness-pill measures="fetch" [since]="cargado()" label="Actualizado" [staleAfterSec]="900" />
          <app-context-help topic="tareas-puesto" />
        </div>
      </header>

      <div class="th-dia">
        <app-segmented [options]="dias" [value]="dia()" (valueChange)="dia.set($event)" ariaLabel="Qué día ver" />
        @if (dia() === 'otro') {
          <p-select [options]="diasAtras" optionLabel="label" optionValue="value" [ngModel]="atras()" (ngModelChange)="atras.set($event)"
                    ariaLabel="Día anterior" styleClass="th-otro" />
        }
      </div>

      @if (datos(); as d) {
        @if (d.position_code) {
          <app-metric-strip [items]="kpis()" ariaLabel="Avance de mis tareas" density="compact" />
        }
      }

      <app-load-state [loading]="res.isLoading() && !datos()" [error]="error()" [isEmpty]="!!datos() && !tareas().length"
                      emptyIcon="pi-check-square" [emptyTitle]="vacioTitulo()" [emptyHint]="vacioPista()" (retry)="res.reload()">
        <ul class="th-lista" aria-label="Tareas del día">
          @for (t of tareas(); track t.template_id) {
            <li>
              <button type="button" class="th-tarea" [class.th-vencida]="t.vencida" [disabled]="abriendo() === t.template_id"
                      (click)="abrir(t)" [attr.aria-label]="t.name + ', ' + etiquetaEstado(t.estado) + (t.vencida ? ', vencida' : '')">
                <span class="th-tarea-cuerpo">
                  <span class="th-nombre">{{ t.name }}</span>
                  <span class="th-meta">
                    {{ etiquetaMomento(t.moment) }}@if (!hora()) { · vence {{ horaDe(t.due_at) }} }
                    @if (t.avance.total) { · {{ t.avance.hechos }} de {{ t.avance.total }} puntos }
                    @if (t.per_event) { <span class="th-evento">Una vez al día: junta todas las de hoy</span> }
                  </span>
                </span>
                <span class="th-estado">
                  @if (t.vencida) { <p-tag value="Vencida" severity="danger" /> }
                  @else { <p-tag [value]="etiquetaEstado(t.estado)" [severity]="severidadEstado(t.estado)" /> }
                  <i class="pi pi-chevron-right" aria-hidden="true"></i>
                </span>
              </button>
            </li>
          }
        </ul>
      </app-load-state>

      @if (datos()?.no_responde?.length) {
        <details class="th-limites">
          <summary>Lo que esta lista no sabe</summary>
          <ul>@for (n of datos()!.no_responde; track n) { <li>{{ n }}</li> }</ul>
        </details>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .th-page { display: flex; flex-direction: column; gap: var(--sp-4); }
    .th-dia { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .th-evento { display: block; color: var(--text-main); }
    .th-acciones { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .th-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    .th-tarea {
      width: 100%; min-height: 44px; display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3);
      padding: var(--sp-3) var(--sp-4); text-align: left; cursor: pointer;
      background: var(--card-bg); color: var(--text-main);
      border: 1px solid var(--border-color); border-radius: var(--r-md);
    }
    .th-tarea:hover { background: var(--overlay-hover); }
    .th-tarea:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .th-tarea:disabled { opacity: 0.6; cursor: progress; }
    .th-vencida { border-left: 3px solid var(--bad-fg); }
    .th-tarea-cuerpo { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
    .th-nombre { font-size: var(--fs-md); font-weight: 600; }
    .th-meta { font-size: var(--fs-sm); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .th-estado { display: flex; align-items: center; gap: var(--sp-2); flex-shrink: 0; color: var(--text-faint); }
    .th-limites { font-size: var(--fs-sm); color: var(--text-muted); }
    .th-limites ul { margin: var(--sp-2) 0 0; padding-left: var(--sp-5); }
    @container (max-width: 30rem) { .th-meta { font-size: var(--fs-xs); } }
  `],
})
export class TareasHoyComponent {
  private readonly svc = inject(TareasService);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);

  readonly etiquetaEstado = etiquetaEstado;
  readonly severidadEstado = severidadEstado;
  readonly etiquetaMomento = etiquetaMomento;
  readonly horaDe = horaDe;

  readonly dias: SegOption[] = [{ label: 'Hoy', value: 'hoy' }, { label: 'Ayer', value: 'ayer' }, { label: 'Otro día', value: 'otro' }];
  readonly dia = signal<string>('hoy');
  /** Hasta donde el servidor deja entregar tarde: la misma constante del contrato (`[MDT.UI.7]`). */
  readonly diasAtras = Array.from({ length: DIAS_ENTREGA_TARDIA - 1 }, (_, i) => ({ label: fechaLarga(fechaMx(-(i + 2))), value: i + 2 }));
  readonly atras = signal<number>(2);
  readonly fechaLarga = fechaLarga;
  readonly abriendo = signal<string | null>(null);
  readonly cargado = signal<Date | null>(null);

  readonly res = rxResource({
    params: () => ({ fecha: this.dia() === 'ayer' ? fechaMx(-1) : this.dia() === 'otro' ? fechaMx(-this.atras()) : null }),
    stream: ({ params }) => this.svc.mias(params.fecha),
  });
  readonly datos = computed(() => (this.res.hasValue() ? this.res.value() : null));
  private readonly alCargar = effect(() => { if (this.datos()) untracked(() => this.cargado.set(new Date())); });
  readonly error = computed(() => {
    const e = this.res.error();
    return e ? (e instanceof HttpErrorResponse ? e.error?.message || e.message : 'No se pudieron cargar tus tareas') : null;
  });

  /**
   * Lo vencido y lo pendiente primero, lo entregado al final; dentro, por MOMENTO del día y después por
   * hora (`[MDT.UI.8]`): con la misma hora límite para todas, ordenar por hora caía a orden alfabético.
   */
  readonly tareas = computed<TareaDelDia[]>(() => {
    const peso = (t: TareaDelDia) => (t.vencida ? 0 : t.estado === 'en_proceso' ? 1 : t.estado === 'pendiente' ? 2 : 3);
    const momento = (t: TareaDelDia) => (t.moment ? ORDEN_MOMENTO[t.moment] ?? 9 : 9);
    return [...(this.datos()?.tareas ?? [])].sort((a, b) => (peso(a) - peso(b)) || (momento(a) - momento(b))
      || a.due_at.localeCompare(b.due_at) || a.name.localeCompare(b.name, 'es'));
  });
  /** La hora límite común, para decirla una vez arriba y no en cada renglón. */
  readonly hora = computed(() => horaComun((this.datos()?.tareas ?? []).map((t) => t.due_at)));

  readonly kpis = computed<MetricStripItem[]>(() => {
    const ts = this.datos()?.tareas ?? [];
    const pend = ts.filter((t) => t.estado === 'pendiente' || t.estado === 'en_proceso').length;
    const venc = ts.filter((t) => t.vencida).length;
    const total = ts.reduce((s, t) => s + t.avance.total, 0);
    const hechos = ts.reduce((s, t) => s + t.avance.hechos, 0);
    return [
      { label: 'Por entregar', value: pend, tone: pend ? 'warn' : 'ok', sub: `de ${ts.length} tareas` },
      { label: 'Vencidas', value: venc, tone: venc ? 'bad' : 'default' },
      // Sin puntos que medir el valor es «—», nunca 0 % (`[MDT.UI.10]`, ADR-056).
      total
        ? { label: 'Puntos con evidencia', value: Math.round((hechos / total) * 100), format: 'percent', sub: `${hechos} de ${total}` }
        : { label: 'Puntos con evidencia', value: '—', sub: 'sin puntos este día' },
    ];
  });

  readonly vacioTitulo = computed(() => (this.datos() && !this.datos()!.position_code ? 'No tienes puesto asignado' : 'Sin tareas del manual este día'));
  readonly vacioPista = computed(() => (this.datos() && !this.datos()!.position_code
    ? 'Pide que te asignen tu puesto en Administración › Personas: de él sale lo que te toca.'
    : 'El manual de tu puesto no pide tareas este día.'));

  abrir(t: TareaDelDia): void {
    if (t.run_id) { void this.router.navigate(['/tareas/entrega', t.run_id]); return; }
    this.abriendo.set(t.template_id);
    this.svc.abrir(t.template_id, t.period_date).subscribe({
      next: (e) => { this.abriendo.set(null); void this.router.navigate(['/tareas/entrega', e.id]); },
      error: (err: HttpErrorResponse) => {
        this.abriendo.set(null);
        this.toast.add({ severity: 'error', summary: 'No se pudo abrir la tarea', detail: err.error?.message || err.message });
      },
    });
  }
}
