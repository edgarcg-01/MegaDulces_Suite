import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { rxResource } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { ConfirmationService, MessageService } from 'primeng/api';
import type { NormaTarea } from '@megadulces/contracts';
import { coincideBusqueda } from '@megadulces/ui-web';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { TareasService } from '../tareas.service';
import { TareasNormaEditorComponent } from '../components/tareas-norma-editor.component';
import { etiquetaEvidencia, etiquetaFrecuencia, etiquetaMomento, fechaLarga } from '../tareas-formato';

/**
 * `[MDT.3.2]` Manual por puesto — ¿qué pide el manual a este puesto?
 *
 * Tareas del puesto elegido con su versión vigente; los puntos en un panel lateral. Quien gestiona la
 * norma la cambia en ese mismo panel (`[MDT.3.2b]`): hora límite y puntos, como versión nueva con fecha
 * de inicio y motivo.
 */
@Component({
  selector: 'app-tareas-manual',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ButtonModule, ConfirmDialogModule, InputTextModule, SelectModule, TableModule, TagModule, ToastModule,
    LoadStateComponent, FreshnessPillComponent, MetricStripComponent, SidePeekComponent, ContextHelpComponent, TareasNormaEditorComponent],
  providers: [MessageService, ConfirmationService],
  template: `
    <div class="surf-page tm-page">
      <p-toast position="top-center"></p-toast>
      <p-confirmdialog></p-confirmdialog>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Manual por puesto</h1>
          <p class="surf-page-sub">Las tareas que los Manuales Corporativos de Operación piden a cada puesto, con la versión que rige hoy.</p>
        </div>
        <div class="tm-acciones">
          <app-freshness-pill measures="fetch" [since]="cargado()" label="Actualizado" [staleAfterSec]="3600" />
          <app-context-help topic="tareas-puesto" />
        </div>
      </header>

      @if (datos()) {
        <app-metric-strip [items]="kpis()" ariaLabel="Tamaño del manual" />
      }
      <div class="tm-filtros">
        <p-select [options]="puestos()" optionLabel="name" optionValue="code" [ngModel]="puesto()" (ngModelChange)="puesto.set($event)"
                  [showClear]="true" placeholder="Todos los puestos" [filter]="true" filterBy="name" ariaLabel="Puesto" class="tm-puesto" />
        <input pInputText type="search" enterkeyhint="search" class="tm-buscar" [value]="busqueda()" (input)="busqueda.set($any($event.target).value)"
               placeholder="Buscar en tareas y puntos" aria-label="Buscar en el manual" />
      </div>

      <app-load-state [loading]="res.isLoading() && !datos()" [error]="error()" [isEmpty]="!!datos() && !visibles().length"
                      emptyIcon="pi-book" [emptyTitle]="busqueda() || puesto() ? 'Nada coincide' : 'El manual está vacío'" (retry)="res.reload()">
        <p-table [value]="visibles()" dataKey="template_id" styleClass="p-datatable-sm surf-table surf-table--plain surf-table--sticky dt-stack"
                 [rowHover]="true" selectionMode="single" [selection]="elegida()" (onRowSelect)="elegir($event.data)">
          <ng-template #header>
            <tr>
              <th scope="col">Tarea</th>
              <th scope="col">Cuándo</th>
              <th scope="col" class="comm-num">Puntos</th>
              <th scope="col">Puestos</th>
              <th scope="col">Documento</th>
            </tr>
          </ng-template>
          <ng-template #body let-t>
            <tr [pSelectableRow]="t" tabindex="0" (keydown.enter)="elegida.set(t)">
              <td data-label="Tarea"><span class="tm-nombre">{{ t.name }}</span><span class="tm-sub">{{ etiquetaMomento(t.moment) }}</span></td>
              <td data-label="Cuándo">{{ etiquetaFrecuencia(t.frequency, t.weekday, t.month_day) }} <span class="tm-sub">vence {{ t.due_time }}</span></td>
              <td data-label="Puntos" class="comm-num">{{ t.puntos.length }}</td>
              <td data-label="Puestos">{{ nombresPuesto(t) }}</td>
              <td data-label="Documento"><span class="tm-sub">{{ t.document_title || 'Sin documento' }} · v{{ t.version }} desde {{ t.valid_from }}</span></td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>

      <app-side-peek [open]="!!elegida()" (openChange)="!$event && pedirCerrar()" [title]="elegida()?.name ?? ''"
                     [subtitle]="elegida() ? (elegida()!.document_title || '') + ' · versión ' + elegida()!.version : null">
        @if (elegida(); as t) {
          @if (editando()) {
            <app-tareas-norma-editor [norma]="t" (guardada)="alGuardar($event)" (cerrar)="pedirCerrar(true)" />
          } @else {
          <p class="tm-vigente">Vence a las <strong>{{ t.due_time }}</strong> · versión {{ t.version }}, desde el {{ fechaLarga(t.valid_from) }}
            @if (t.change_note) { <span class="tm-sub">Motivo: {{ t.change_note }}</span> }</p>
          @if (puedeEditar()) {
            <button pButton type="button" class="p-button-outlined tm-cambiar" (click)="editando.set(true)">
              <span class="p-button-icon p-button-icon-left pi pi-pencil" aria-hidden="true"></span>
              <span class="p-button-label">Cambiar hora o puntos</span></button>
          }
          @if (t.note) { <p class="tm-sub">{{ t.note }}</p> }
          <ol class="tm-puntos">
            @for (p of t.puntos; track p.id) {
              <li>
                <span>@if (p.block) { <span class="tm-sub-inline">{{ p.block }}:</span> } {{ p.label }}</span>
                <span class="tm-sub">Se prueba con: {{ etiquetaEvidencia(p.evidence) }}@if (p.accepts_documents) { · acepta documento }@if (p.requires_amount) { · pide monto }@if (p.requires_folio) { · pide folio }</span>
              </li>
            }
          </ol>
          }
        }
      </app-side-peek>
    </div>
  `,
  styles: [`
    :host { display: block; container-type: inline-size; }
    .tm-page { display: flex; flex-direction: column; gap: var(--sp-4); }
    .tm-acciones { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .tm-filtros { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); }
    .tm-puesto { min-width: 16rem; }
    .tm-buscar { flex: 1 1 16rem; max-width: 24rem; }
    .tm-nombre { display: block; font-weight: 600; }
    .tm-sub { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
    .tm-sub-inline { color: var(--text-muted); }
    .tm-vigente { margin: 0 0 var(--sp-3); font-size: var(--fs-sm); }
    .tm-cambiar { margin-bottom: var(--sp-3); min-height: 44px; }
    .tm-puntos { margin: 0; padding-left: var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-3); }
    @container (max-width: 40rem) { .tm-puesto, .tm-buscar { min-width: 0; max-width: none; flex: 1 1 100%; } }
  `],
})
export class TareasManualComponent {
  private readonly svc = inject(TareasService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly editor = viewChild(TareasNormaEditorComponent);

  readonly etiquetaMomento = etiquetaMomento;
  readonly etiquetaFrecuencia = etiquetaFrecuencia;
  readonly etiquetaEvidencia = etiquetaEvidencia;
  readonly fechaLarga = fechaLarga;

  /** Cambiar la norma es de quien la gestiona; el resto (jefaturas) la lee. */
  readonly puedeEditar = computed(() => this.perms.has(Permission.TAREAS_PUESTO_NORMA_GESTIONAR));
  readonly editando = signal(false);

  readonly puesto = signal<string | null>(null);
  readonly busqueda = signal('');
  readonly elegida = signal<NormaTarea | null>(null);
  readonly cargado = signal<Date | null>(null);

  readonly res = rxResource({ stream: () => this.svc.normas() });
  readonly datos = computed(() => (this.res.hasValue() ? this.res.value() : null));
  private readonly alCargar = effect(() => { if (this.datos()) untracked(() => this.cargado.set(new Date())); });
  readonly error = computed(() => {
    const e = this.res.error();
    return e ? (e instanceof HttpErrorResponse ? e.error?.message || e.message : 'No se pudo cargar el manual') : null;
  });

  /** Los puestos que tienen manual, por nombre. */
  readonly puestos = computed(() => {
    const vistos: Record<string, string> = {};
    for (const t of this.datos() ?? []) for (const p of t.positions) vistos[p.code] = p.name;
    return Object.keys(vistos).map((code) => ({ code, name: vistos[code] })).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  });

  readonly visibles = computed(() => {
    const q = this.busqueda();
    const pu = this.puesto();
    return (this.datos() ?? [])
      .filter((t) => !pu || t.positions.some((p) => p.code === pu))
      .filter((t) => coincideBusqueda(q, t.name, t.document_title, ...t.puntos.map((p) => p.label)));
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const ts = this.visibles();
    return [
      { label: 'Tareas', value: ts.length },
      { label: 'Puntos de control', value: ts.reduce((s, t) => s + t.puntos.length, 0) },
      { label: 'Puestos con manual', value: this.puestos().length },
    ];
  });

  /** `onRowSelect` tipa `data` como fila o lista (por la selección múltiple): aquí sólo hay una. */
  elegir(d: NormaTarea | NormaTarea[] | undefined): void {
    if (!d || Array.isArray(d)) return;
    if (this.editando() && this.editor()?.sucio()) { this.pedirCerrar(false, () => this.elegida.set(d)); return; }
    this.editando.set(false);
    this.elegida.set(d);
  }

  /**
   * Cerrar el panel (o sólo el editor, con `soloEditor`) sin perder lo capturado en silencio: si hay
   * cambios sin guardar, se pregunta antes.
   */
  pedirCerrar(soloEditor = false, despues?: () => void): void {
    const cerrar = () => { this.editando.set(false); if (!soloEditor) this.elegida.set(null); despues?.(); };
    if (!this.editando() || !this.editor()?.sucio()) { cerrar(); return; }
    this.confirm.confirm({
      header: '¿Descartar los cambios?',
      message: 'La versión nueva todavía no se guarda.',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, descartar',
      rejectLabel: 'Seguir editando',
      acceptButtonStyleClass: 'p-button-danger',
      rejectButtonStyleClass: 'p-button-text',
      accept: cerrar,
    });
  }

  alGuardar(n: NormaTarea): void {
    // El servidor devuelve la versión que rige HOY: si la nueva empieza otro día, todavía no es ésta.
    const futura = n.version <= (this.elegida()?.version ?? 0);
    this.editando.set(false);
    this.elegida.set(n);
    this.res.reload();
    this.toast.add({
      severity: 'success', summary: 'Versión guardada',
      detail: futura
        ? `Rige desde la fecha que elegiste; hasta entonces se sigue pidiendo la versión ${n.version}.`
        : 'Las entregas ya abiertas conservan la versión anterior.',
    });
  }

  nombresPuesto(t: NormaTarea): string {
    return t.positions.map((p) => p.name).join(', ') || 'Sin puesto';
  }
}
