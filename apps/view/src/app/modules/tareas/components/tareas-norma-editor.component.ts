import { ChangeDetectionStrategy, Component, HostListener, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { DatePickerModule } from 'primeng/datepicker';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TextareaModule } from 'primeng/textarea';
import {
  EVIDENCIAS_PUNTO, validarHora, validarPuntos, type NormaTarea, type PuntoChecklist,
} from '@megadulces/contracts';
import { TareasService } from '../tareas.service';
import { etiquetaEvidencia, fechaLarga, fechaMx } from '../tareas-formato';

/**
 * `[MDT.3.2b]` Cambiar una tarea del manual: su hora límite y sus puntos, como una VERSIÓN NUEVA con
 * fecha de inicio y motivo. Nada se pisa: las entregas ya abiertas conservan la versión con la que se
 * juzgan, y una fecha hacia atrás no se acepta (lo dice el servidor; aquí el calendario ni la ofrece).
 *
 * Vive dentro del panel lateral del manual: el jefe ve la tarea y la cambia en el mismo lugar. La hora
 * límite es lo primero porque hoy las 51 tareas vencen a las 23:00 (`MDT.UI.1`).
 */
@Component({
  selector: 'app-tareas-norma-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ButtonModule, CheckboxModule, DatePickerModule, InputTextModule, SelectModule, TextareaModule],
  template: `
    <section class="ne" aria-label="Versión nueva de la tarea">
      <p class="ne-aviso">Se guarda como la <strong>versión {{ norma().version + 1 }}</strong>. Lo que ya se entregó o se abrió
        sigue con la versión {{ norma().version }}.</p>

      <div class="ne-fila">
        <label class="ne-campo" for="ne-hora">
          <span class="ne-rotulo">Hora límite (24 h)</span>
          <input pInputText id="ne-hora" inputmode="numeric" maxlength="5" placeholder="23:00" autocomplete="off"
                 [value]="hora()" (input)="hora.set($any($event.target).value.trim())" />
          <span class="ne-pista">Empieza a las {{ norma().start_time }}. Hoy: {{ norma().due_time }}.</span>
        </label>
        <div class="ne-campo">
          <label class="ne-rotulo" for="ne-desde">Rige desde</label>
          <p-datepicker inputId="ne-desde" [ngModel]="desde()" (ngModelChange)="desde.set($event)" dateFormat="dd/mm/yy"
                        [showIcon]="true" appendTo="body" [minDate]="hoyFecha" [fluid]="true" />
          <span class="ne-pista">{{ fechaLarga(desdeTexto()) }}</span>
        </div>
      </div>
      @if (errorHora(); as e) { <p class="ne-error" role="alert">{{ e }}</p> }

      <h3 class="ne-titulo">Puntos de control ({{ puntos().length }})</h3>
      <ol class="ne-puntos">
        @for (p of puntos(); track p.id; let i = $index) {
          <li class="ne-punto">
            <div class="ne-punto-cab">
              <span class="ne-num" aria-hidden="true">{{ i + 1 }}</span>
              <textarea pTextarea rows="2" class="ne-texto" maxlength="500" [value]="p.label"
                        [attr.aria-label]="'Qué pide el punto ' + (i + 1)" (input)="cambiar(i, { label: $any($event.target).value })"></textarea>
            </div>
            <div class="ne-fila">
              <label class="ne-campo">
                <span class="ne-rotulo">Bloque (opcional)</span>
                <input pInputText maxlength="80" placeholder="Inicio, Surtido…" [value]="p.block ?? ''"
                       (input)="cambiar(i, { block: $any($event.target).value || null })" />
              </label>
              <div class="ne-campo">
                <span class="ne-rotulo" [id]="'ne-ev-' + p.id">Se prueba con</span>
                <p-select [options]="evidencias" optionLabel="label" optionValue="value" [ngModel]="p.evidence"
                          (ngModelChange)="cambiar(i, { evidence: $event })" appendTo="body" [ariaLabelledBy]="'ne-ev-' + p.id" />
              </div>
            </div>
            <div class="ne-marcas">
              <span class="ne-marca"><p-checkbox [binary]="true" [inputId]="'ne-doc-' + p.id" [ngModel]="p.accepts_documents"
                (ngModelChange)="cambiar(i, { accepts_documents: $event })" /><label [for]="'ne-doc-' + p.id">Acepta PDF</label></span>
              <span class="ne-marca"><p-checkbox [binary]="true" [inputId]="'ne-monto-' + p.id" [ngModel]="p.requires_amount"
                (ngModelChange)="cambiar(i, { requires_amount: $event })" /><label [for]="'ne-monto-' + p.id">Pide monto</label></span>
              <span class="ne-marca"><p-checkbox [binary]="true" [inputId]="'ne-folio-' + p.id" [ngModel]="p.requires_folio"
                (ngModelChange)="cambiar(i, { requires_folio: $event })" /><label [for]="'ne-folio-' + p.id">Pide folio</label></span>
              <span class="ne-marca"><p-checkbox [binary]="true" [inputId]="'ne-com-' + p.id" [ngModel]="p.requires_comment"
                (ngModelChange)="cambiar(i, { requires_comment: $event })" /><label [for]="'ne-com-' + p.id">Pide comentario</label></span>
            </div>
            <div class="ne-mover">
              <button type="button" class="ne-btn" (click)="mover(i, -1)" [disabled]="i === 0" [attr.aria-label]="'Subir el punto ' + (i + 1)">
                <i class="pi pi-arrow-up" aria-hidden="true"></i></button>
              <button type="button" class="ne-btn" (click)="mover(i, 1)" [disabled]="i === puntos().length - 1" [attr.aria-label]="'Bajar el punto ' + (i + 1)">
                <i class="pi pi-arrow-down" aria-hidden="true"></i></button>
              <button type="button" class="ne-btn ne-quitar" (click)="quitar(i)" [disabled]="puntos().length === 1"
                      [attr.aria-label]="'Quitar el punto ' + (i + 1)">Quitar</button>
            </div>
          </li>
        }
      </ol>
      <button type="button" class="ne-agregar" (click)="agregar()" [disabled]="puntos().length >= 200">
        <i class="pi pi-plus" aria-hidden="true"></i> Agregar punto</button>

      <label class="ne-campo" for="ne-motivo">
        <span class="ne-rotulo">Motivo del cambio</span>
        <textarea pTextarea id="ne-motivo" rows="2" maxlength="500" placeholder="Por qué cambia (queda en la versión)"
                  [value]="motivo()" (input)="motivo.set($any($event.target).value)"></textarea>
      </label>

      @if (errorServidor(); as e) { <p class="ne-error" role="alert">{{ e }}</p> }
      <div class="ne-pie">
        @if (falta(); as f) { <p class="ne-falta">{{ f }}</p> }
        <button pButton type="button" class="p-button-text" (click)="cerrar.emit()" [disabled]="guardando()">
          <span class="p-button-label">Cancelar</span></button>
        <button pButton type="button" (click)="guardar()" [disabled]="!!falta() || guardando()">
          <span class="p-button-label">{{ guardando() ? 'Guardando…' : 'Guardar versión ' + (norma().version + 1) }}</span></button>
      </div>
    </section>
  `,
  styles: [`
    :host { display: block; }
    .ne { display: flex; flex-direction: column; gap: var(--sp-4); }
    .ne-aviso { margin: 0; font-size: var(--fs-sm); color: var(--text-main); }
    .ne-fila { display: flex; flex-wrap: wrap; gap: var(--sp-3); }
    .ne-campo { display: flex; flex-direction: column; gap: var(--sp-1); flex: 1 1 12rem; min-width: 0; }
    .ne-rotulo { font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); }
    .ne-pista { font-size: var(--fs-xs); color: var(--text-muted); }
    .ne-titulo { margin: 0; font-size: var(--fs-md); font-weight: 600; }
    .ne-puntos { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
    .ne-punto { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3); border: 1px solid var(--border-color);
      border-radius: var(--r-md); background: var(--card-bg); }
    .ne-punto-cab { display: flex; align-items: flex-start; gap: var(--sp-2); }
    .ne-num { font-variant-numeric: tabular-nums; color: var(--text-faint); min-width: 1.5em; padding-top: var(--sp-2); }
    .ne-texto { flex: 1; width: 100%; }
    .ne-marcas { display: flex; flex-wrap: wrap; gap: var(--sp-3); font-size: var(--fs-sm); }
    .ne-marca { display: inline-flex; align-items: center; gap: var(--sp-1); min-height: 32px; }
    .ne-mover { display: flex; gap: var(--sp-2); justify-content: flex-end; }
    .ne-btn { min-width: 32px; min-height: 32px; padding: 0 var(--sp-2); cursor: pointer; background: var(--card-bg); color: var(--text-main);
      border: 1px solid var(--border-color); border-radius: var(--r-sm); font: inherit; font-size: var(--fs-sm); }
    .ne-btn:disabled { opacity: 0.5; cursor: default; }
    .ne-quitar { color: var(--text-muted); }
    .ne-btn:focus-visible, .ne-agregar:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .ne-agregar { align-self: flex-start; display: inline-flex; align-items: center; gap: var(--sp-2); min-height: 36px; padding: 0 var(--sp-3);
      cursor: pointer; background: none; color: var(--text-main); border: 1px dashed var(--border-color); border-radius: var(--r-md); font: inherit; }
    @media (pointer: coarse) { .ne-btn, .ne-agregar, .ne-marca { min-height: 44px; min-width: 44px; } }
    .ne-error { margin: 0; padding: var(--sp-2) var(--sp-3); font-size: var(--fs-sm); background: var(--bad-soft-bg); color: var(--bad-soft-fg);
      border-radius: var(--r-sm); }
    .ne-pie { position: sticky; bottom: 0; display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--sp-2);
      padding: var(--sp-3) 0; background: var(--card-bg); border-top: 1px solid var(--border-color); }
    .ne-falta { margin: 0 auto 0 0; font-size: var(--fs-sm); color: var(--text-muted); }
  `],
})
export class TareasNormaEditorComponent {
  private readonly svc = inject(TareasService);

  readonly norma = input.required<NormaTarea>();
  readonly guardada = output<NormaTarea>();
  readonly cerrar = output<void>();

  readonly fechaLarga = fechaLarga;
  readonly evidencias = EVIDENCIAS_PUNTO.map((value) => ({ value, label: etiquetaEvidencia(value) }));
  readonly hoyFecha = this.aFecha(fechaMx());

  readonly hora = signal('');
  readonly desde = signal<Date>(this.hoyFecha);
  readonly puntos = signal<PuntoChecklist[]>([]);
  readonly motivo = signal('');
  readonly guardando = signal(false);
  readonly errorServidor = signal<string | null>(null);

  /** Al cambiar de tarea, el borrador vuelve a la versión que rige. */
  private readonly alCambiar = effect(() => {
    const n = this.norma();
    untracked(() => {
      this.hora.set(n.due_time);
      this.desde.set(this.hoyFecha);
      this.puntos.set(n.puntos.map((p) => ({ ...p })));
      this.motivo.set('');
      this.errorServidor.set(null);
    });
  });

  readonly desdeTexto = computed(() => this.aTexto(this.desde()));
  readonly errorHora = computed(() => {
    const h = this.hora();
    if (!h) return null;
    const e = validarHora(h);
    if (e) return e;
    return h <= this.norma().start_time ? `Tiene que ser después de las ${this.norma().start_time}, cuando empieza el día de la tarea` : null;
  });
  /** Hay algo que perder si se cierra sin guardar. */
  readonly sucio = computed(() => {
    const n = this.norma();
    return this.hora() !== n.due_time || !!this.motivo().trim() || this.desdeTexto() !== fechaMx()
      || JSON.stringify(this.puntos()) !== JSON.stringify(n.puntos);
  });
  /** ¿Cambió la hora o algún punto? Sólo el motivo o la fecha no hacen una versión nueva. */
  readonly cambio = computed(() => {
    const n = this.norma();
    return this.hora() !== n.due_time || JSON.stringify(this.puntos()) !== JSON.stringify(n.puntos);
  });
  /** Lo que falta para poder guardar, en una frase; `null` = se puede. */
  readonly falta = computed(() => {
    if (!this.hora()) return 'Escribe la hora límite.';
    if (this.errorHora()) return 'Corrige la hora límite.';
    const e = validarPuntos(this.puntos().map((p) => ({ ...p, label: p.label.trim() })));
    if (e) return e;
    if (!this.cambio()) return 'Cambia la hora o los puntos para guardar una versión.';
    if (!this.motivo().trim()) return 'Escribe el motivo del cambio.';
    return null;
  });

  @HostListener('window:beforeunload', ['$event'])
  alSalir(ev: BeforeUnloadEvent): void {
    if (this.sucio() && !this.guardando()) { ev.preventDefault(); ev.returnValue = ''; }
  }

  cambiar(i: number, parche: Partial<PuntoChecklist>): void {
    this.puntos.update((ps) => ps.map((p, j) => (j === i ? { ...p, ...parche } : p)));
  }

  mover(i: number, delta: -1 | 1): void {
    const j = i + delta;
    this.puntos.update((ps) => {
      if (j < 0 || j >= ps.length) return ps;
      const copia = ps.slice();
      const x = copia[i];
      copia[i] = copia[j];
      copia[j] = x;
      return copia;
    });
  }

  quitar(i: number): void {
    this.puntos.update((ps) => (ps.length > 1 ? ps.filter((_, j) => j !== i) : ps));
  }

  /** Un punto nuevo lleva un id que no usó NINGUNA versión anterior: las respuestas viejas no se le pegan. */
  agregar(): void {
    const usados = this.norma().puntos.concat(this.puntos()).map((p) => Number(/^p(\d+)$/.exec(p.id)?.[1] ?? -1));
    const siguiente = usados.reduce((m, n) => Math.max(m, n), -1) + 1;
    this.puntos.update((ps) => ps.concat([{
      id: `p${siguiente}`, label: '', block: null, evidence: 'photos',
      accepts_documents: false, requires_amount: false, requires_folio: false, requires_comment: false,
    }]));
  }

  guardar(): void {
    if (this.falta() || this.guardando()) return;
    const n = this.norma();
    this.guardando.set(true);
    this.errorServidor.set(null);
    this.svc.nuevaVersion(n.template_id, {
      items: this.puntos().map((p) => ({ ...p, label: p.label.trim(), block: p.block?.trim() || null })),
      change_note: this.motivo().trim(),
      valid_from: this.desdeTexto(),
      ...(this.hora() !== n.due_time ? { due_time: this.hora() } : {}),
    }).subscribe({
      next: (r) => { this.guardando.set(false); this.guardada.emit(r); },
      error: (err: HttpErrorResponse) => { this.guardando.set(false); this.errorServidor.set(err.error?.message || err.message); },
    });
  }

  private aFecha(ymd: string): Date {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  private aTexto(d: Date | null): string {
    if (!d) return fechaMx();
    const dos = (x: number) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
  }
}
