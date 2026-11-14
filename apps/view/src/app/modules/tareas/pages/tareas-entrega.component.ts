import { ChangeDetectionStrategy, Component, HostListener, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map, type Observable } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService, MessageService } from 'primeng/api';
import type { DetalleEntrega, GuardarPunto, PuntoDeEntrega } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { TareasService } from '../tareas.service';
import { etiquetaPunto, fechaLarga, horaDe, severidadPunto } from '../tareas-formato';

/** Lado mayor al que se reduce una foto antes de subirla: legible y ~10× más liviana que la de un teléfono. */
const LADO_MAX = 1600;

/** Un campo de un punto que se escribió y todavía no está guardado en el servidor (`[MDT.UI.3]`). */
interface Pendiente { estado: 'guardando' | 'error'; body: GuardarPunto }
/** Una foto que no subió: se conserva para reintentar sin volver a tomarla (`[MDT.UI.5]`). */
interface FotoFallida { dataUri: string; nombre: string; capturada: string }

/**
 * `[MDT.3.1]` La entrega de una tarea del manual: qué le falta para darla por hecha.
 *
 * Los puntos en el orden del manual, cada uno con su evidencia: la cámara para los de foto (y el
 * selector de archivo si el punto acepta un documento), un cuadro para los escritos. «Entregar» va
 * en una barra pegada abajo, al alcance del pulgar. Lo que se escribe se guarda al salir del campo.
 * La pantalla NO decide si un punto está hecho: lo dice el servidor con la regla del contrato.
 *
 * Revisión de diseño 2026-11-14 (`MDT.UI.3`–`6`): lo que no se guardó lo dice EN SU PUNTO con
 * «Reintentar» y conserva lo escrito; cada punto sube su foto sin congelar a los demás y la que falla
 * se conserva; «Entregar» espera a que no quede nada sin guardar; quitar una foto se confirma.
 */
@Component({
  selector: 'app-tareas-entrega',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ButtonModule, TagModule, TextareaModule, InputTextModule, ToastModule, ConfirmDialogModule,
    LoadStateComponent, FreshnessPillComponent, MetricStripComponent, ContextHelpComponent],
  providers: [MessageService, ConfirmationService],
  template: `
    <div class="surf-page te-page">
      <p-toast position="top-center"></p-toast>
      <p-confirmdialog></p-confirmdialog>
      <a class="te-volver" [routerLink]="volverA()"><i class="pi pi-arrow-left" aria-hidden="true"></i> {{ volverTexto() }}</a>

      <app-load-state [loading]="cargando() && !d()" [error]="error()" [isEmpty]="false" (retry)="cargar()">
        @if (d(); as e) {
          <header class="surf-page-head">
            <div class="surf-page-head-text">
              <h1>{{ e.name }}</h1>
              <p class="surf-page-sub">
                @if (!e.editable && e.assigned_name) { {{ e.assigned_name }} · }
                {{ fechaLarga(e.period_date) }} · vence {{ horaDe(e.due_at) }}
                @if (e.document_title) { · {{ e.document_title }}@if (e.document_version) { ({{ e.document_version }}) } }
                @if (e.format_code) { · {{ e.format_code }} }
              </p>
            </div>
            <div class="te-acciones">
              <app-freshness-pill measures="fetch" [since]="cargado()" label="Actualizado" [staleAfterSec]="600" />
              <app-context-help topic="tareas-puesto" />
            </div>
          </header>

          @if (e.status === 'submitted') {
            <p class="te-banda te-banda-ok" role="status"><i class="pi pi-check-circle" aria-hidden="true"></i>
              Entregada {{ e.submitted_late ? 'tarde' : 'a tiempo' }}. Ya no se puede cambiar.</p>
          }
          @if (e.note) { <p class="te-nota">{{ e.note }}</p> }

          <app-metric-strip [items]="kpis()" ariaLabel="Avance de la entrega" density="compact" />

          <ol class="te-puntos" aria-label="Puntos de control">
            @for (p of e.puntos; track p.id; let i = $index) {
              <li class="te-punto" [class.te-hecho]="p.estado === 'hecho'">
                <div class="te-punto-cab">
                  <span class="te-num" aria-hidden="true">{{ i + 1 }}</span>
                  <span class="te-texto">@if (p.block) { <span class="te-bloque">{{ p.block }}:</span> } {{ p.label }}</span>
                  <p-tag [value]="etiquetaPunto(p.estado)" [severity]="severidadPunto(p.estado)" />
                </div>

                @if (p.evidence === 'photos') {
                  <div class="te-fotos">
                    @for (a of p.archivos; track a.id) {
                      <figure class="te-foto">
                        @if (a.mime === 'application/pdf') {
                          <a [href]="a.url" target="_blank" rel="noopener" class="te-pdf"><i class="pi pi-file-pdf" aria-hidden="true"></i> {{ a.original_name || 'Documento' }}</a>
                        } @else if (a.url) {
                          <a [href]="a.url" target="_blank" rel="noopener"><img [src]="a.url" alt="Evidencia del punto {{ i + 1 }}" loading="lazy" width="96" height="96" /></a>
                        } @else {
                          <span class="te-sin-url">Archivo guardado (vista no disponible)</span>
                        }
                        @if (e.editable) {
                          <button type="button" class="te-quitar" (click)="pedirRetirar(a.id, i + 1)" [disabled]="entregando()"
                                  [attr.aria-label]="'Quitar archivo del punto ' + (i + 1)">
                            <i class="pi pi-trash" aria-hidden="true"></i> Quitar
                          </button>
                        }
                      </figure>
                    }
                    @if (e.editable) {
                      <label class="te-camara" [class.te-deshabilitado]="!!subiendo()[p.id] || entregando()">
                        <i class="pi pi-camera" aria-hidden="true"></i>
                        {{ subiendo()[p.id] ? 'Subiendo…' : (p.archivos.length ? 'Otra foto' : 'Tomar foto') }}
                        <input type="file" class="te-oculto" [attr.accept]="p.accepts_documents ? 'image/*,application/pdf' : 'image/*'"
                               [attr.capture]="p.accepts_documents ? null : 'environment'" [disabled]="!!subiendo()[p.id] || entregando()"
                               (change)="alElegir(p, $event)" />
                      </label>
                      @if (p.accepts_documents) { <span class="te-pista">Acepta foto o PDF del documento.</span> }
                    }
                  </div>
                  @if (fallidas()[p.id]; as f) {
                    <p class="te-error" role="alert">
                      <span>No se subió la foto ({{ f.nombre }}).</span>
                      <button type="button" class="te-enlace" (click)="reintentarFoto(p)" [disabled]="!!subiendo()[p.id]">Reintentar</button>
                      <button type="button" class="te-enlace" (click)="descartarFoto(p.id)">Descartar</button>
                    </p>
                  }
                }
                @if (p.evidence === 'text') {
                  <textarea pTextarea class="te-campo" rows="3" [value]="p.respuesta.text || ''" [readonly]="!e.editable"
                            [attr.aria-label]="'Lo escrito del punto ' + (i + 1)" placeholder="Escribe aquí la evidencia"
                            (input)="marcarSucio(p.id, 'text')"
                            (blur)="guardar(p, { text: $any($event.target).value })"></textarea>
                }
                @if (p.evidence === 'list') {
                  <textarea pTextarea class="te-campo" rows="3" [value]="lista(p)" [readonly]="!e.editable"
                            [attr.aria-label]="'Renglones del punto ' + (i + 1)" placeholder="Un renglón por línea"
                            (input)="marcarSucio(p.id, 'list')"
                            (blur)="guardar(p, { list: renglones($any($event.target).value) })"></textarea>
                }
                @if (p.evidence === 'none') {
                  <label class="te-marca"><input type="checkbox" [checked]="p.respuesta.checked === true" [disabled]="!e.editable"
                    (change)="guardar(p, { checked: $any($event.target).checked })" /> Hecho</label>
                }
                @if (p.requires_amount || p.requires_folio || p.requires_comment) {
                  <div class="te-extras">
                    @if (p.requires_amount) {
                      <label>Monto <input pInputText inputmode="decimal" [value]="p.respuesta.amount ?? ''" [readonly]="!e.editable"
                        (input)="marcarSucio(p.id, 'amount')" (blur)="guardar(p, { amount: monto($any($event.target).value) })" /></label>
                    }
                    @if (p.requires_folio) {
                      <label>Folio <input pInputText inputmode="text" autocomplete="off" [value]="p.respuesta.folio ?? ''" [readonly]="!e.editable"
                        (input)="marcarSucio(p.id, 'folio')" (blur)="guardar(p, { folio: $any($event.target).value || null })" /></label>
                    }
                    @if (p.requires_comment) {
                      <label class="te-ancho">Comentario <input pInputText [value]="p.respuesta.comment ?? ''" [readonly]="!e.editable"
                        (input)="marcarSucio(p.id, 'comment')" (blur)="guardar(p, { comment: $any($event.target).value || null })" /></label>
                    }
                  </div>
                }
                @if (errorDe(p.id); as campo) {
                  <p class="te-error" role="alert">
                    <span>No se guardó lo que escribiste en este punto. Sigue en el cuadro.</span>
                    <button type="button" class="te-enlace" (click)="reintentar(p, campo)">Reintentar</button>
                  </p>
                } @else if (guardandoDe(p.id)) {
                  <span class="te-pista" aria-live="polite">Guardando…</span>
                }
              </li>
            }
          </ol>

          @if (e.employee_note && !e.editable) { <p class="te-nota"><strong>Nota de la entrega:</strong> {{ e.employee_note }}</p> }

          @if (e.editable) {
            <div class="te-barra">
              @if (conError()) {
                <p class="te-barra-aviso">Hay {{ conError() }} punto(s) sin guardar: reintenta antes de entregar.</p>
              } @else if (guardandoAlgo()) {
                <p class="te-barra-aviso">Guardando lo que escribiste…</p>
              } @else if (tecleando()) {
                <p class="te-barra-aviso">Lo que escribes se guarda al salir del cuadro.</p>
              } @else if (faltan()) {
                <textarea pTextarea rows="2" class="te-campo" [value]="nota()" (input)="nota.set($any($event.target).value)"
                          aria-label="Por qué no se pudo completar" placeholder="Faltan {{ faltan() }} punto(s): escribe por qué no se pudo para entregar así"></textarea>
              }
              <button pButton type="button" class="te-entregar" [disabled]="!puedeEntregar()" (click)="entregar()">
                <span class="p-button-icon p-button-icon-left pi pi-send" aria-hidden="true"></span>
                {{ faltan() ? 'Entregar con justificación' : 'Entregar' }}
              </button>
            </div>
          }
        }
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; container-type: inline-size; }
    .te-page { display: flex; flex-direction: column; gap: var(--sp-4); padding-bottom: calc(var(--sp-12) + env(safe-area-inset-bottom)); }
    .te-volver { display: inline-flex; align-items: center; gap: var(--sp-2); min-height: 44px; color: var(--text-muted); text-decoration: none; }
    .te-volver:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .te-acciones { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .te-banda { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-3); border-radius: var(--r-md); margin: 0; }
    .te-banda-ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); border: 1px solid var(--ok-border); }
    .te-nota { font-size: var(--fs-sm); color: var(--text-muted); margin: 0; }
    .te-puntos { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
    .te-punto { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4); background: var(--card-bg);
      border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .te-hecho { border-left: 3px solid var(--ok-fg); }
    .te-punto-cab { display: flex; align-items: flex-start; gap: var(--sp-3); }
    .te-num { font-variant-numeric: tabular-nums; color: var(--text-faint); min-width: 1.5em; }
    .te-texto { flex: 1; font-size: var(--fs-body); }
    .te-bloque { color: var(--text-muted); }
    .te-fotos { display: flex; flex-wrap: wrap; align-items: flex-start; gap: var(--sp-3); }
    .te-foto { display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-1); margin: 0; }
    .te-foto img { width: 96px; height: 96px; object-fit: cover; border-radius: var(--r-sm); border: 1px solid var(--border-color); display: block; }
    .te-pdf { display: inline-flex; align-items: center; gap: var(--sp-1); min-height: 44px; }
    .te-sin-url { font-size: var(--fs-xs); color: var(--text-muted); }
    /* Quitar va DEBAJO de la miniatura, no encima: el dedo que abre la foto no la borra (MDT.UI.6). */
    .te-quitar { display: inline-flex; align-items: center; gap: var(--sp-1); min-height: 32px; padding: 0 var(--sp-2); cursor: pointer;
      border: 1px solid var(--border-color); border-radius: var(--r-sm); background: var(--card-bg); color: var(--text-muted); font-size: var(--fs-xs); }
    .te-quitar:focus-visible, .te-camara:focus-within, .te-enlace:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    @media (pointer: coarse) { .te-quitar { min-height: 44px; padding: 0 var(--sp-3); } }
    .te-camara { display: inline-flex; align-items: center; gap: var(--sp-2); min-height: 44px; padding: 0 var(--sp-4); cursor: pointer;
      border: 1px dashed var(--border-color); border-radius: var(--r-md); color: var(--text-main); }
    .te-deshabilitado { opacity: 0.6; cursor: progress; }
    .te-oculto { position: absolute; width: 1px; height: 1px; opacity: 0; }
    .te-pista { font-size: var(--fs-xs); color: var(--text-muted); }
    .te-error { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin: 0; padding: var(--sp-2) var(--sp-3);
      font-size: var(--fs-sm); background: var(--bad-soft-bg); color: var(--bad-soft-fg); border-radius: var(--r-sm); }
    .te-enlace { min-height: 44px; padding: 0 var(--sp-2); background: none; border: none; cursor: pointer; color: inherit;
      font: inherit; font-weight: 600; text-decoration: underline; }
    .te-campo { width: 100%; }
    .te-marca { display: inline-flex; align-items: center; gap: var(--sp-2); min-height: 44px; }
    .te-extras { display: flex; flex-wrap: wrap; gap: var(--sp-3); font-size: var(--fs-sm); color: var(--text-muted); }
    .te-extras label { display: flex; flex-direction: column; gap: var(--sp-1); }
    .te-ancho { flex: 1 1 100%; }
    .te-barra { position: sticky; bottom: 0; display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3) 0;
      padding-bottom: calc(var(--sp-3) + env(safe-area-inset-bottom)); background: var(--card-bg); border-top: 1px solid var(--border-color); }
    .te-barra-aviso { margin: 0; font-size: var(--fs-sm); color: var(--text-main); }
    .te-entregar { min-height: 44px; justify-content: center; }
    @container (min-width: 48rem) { .te-barra { flex-direction: row; align-items: center; } .te-entregar { flex-shrink: 0; } }
  `],
})
export class TareasEntregaComponent {
  private readonly svc = inject(TareasService);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly route = inject(ActivatedRoute);

  readonly etiquetaPunto = etiquetaPunto;
  readonly severidadPunto = severidadPunto;
  readonly horaDe = horaDe;
  readonly fechaLarga = fechaLarga;

  private readonly id = toSignal(this.route.paramMap.pipe(map((p) => p.get('id') ?? '')), { initialValue: '' });
  readonly d = signal<DetalleEntrega | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly cargado = signal<Date | null>(null);
  readonly entregando = signal(false);
  readonly nota = signal('');

  /** Campos tecleados y todavía sin salir del campo, por `punto:campo`. */
  readonly sucios = signal<Record<string, true>>({});
  /** Campos mandados al servidor (o que fallaron), por `punto:campo`. */
  readonly pendientes = signal<Record<string, Pendiente>>({});
  /** Puntos con una foto subiendo. Cada punto sube lo suyo sin bloquear a los demás. */
  readonly subiendo = signal<Record<string, true>>({});
  readonly fallidas = signal<Record<string, FotoFallida>>({});

  /** Escrituras en vuelo y si se encimaron: la respuesta de una puede ser más vieja que la de otra. */
  private enVuelo = 0;
  private encimadas = false;

  private readonly alCambiarId = effect(() => { const id = this.id(); if (id) untracked(() => this.cargar()); });

  readonly faltan = computed(() => (this.d()?.puntos ?? []).filter((p) => p.estado !== 'hecho').length);
  readonly conError = computed(() => {
    const ps = this.pendientes();
    const puntos: string[] = [];
    for (const k of Object.keys(ps)) {
      const punto = k.split(':')[0];
      if (ps[k].estado === 'error' && puntos.indexOf(punto) < 0) puntos.push(punto);
    }
    return puntos.length;
  });
  readonly tecleando = computed(() => Object.keys(this.sucios()).length > 0);
  readonly guardandoAlgo = computed(() => Object.values(this.pendientes()).some((x) => x.estado === 'guardando')
    || Object.keys(this.subiendo()).length > 0);
  readonly enCurso = computed(() => this.tecleando() || this.guardandoAlgo());
  readonly puedeEntregar = computed(() => !this.entregando() && !this.enCurso() && !this.conError()
    && (this.faltan() === 0 || !!this.nota().trim()));

  /** Quien llega desde el equipo (`?desde=equipo`) vuelve al equipo; la persona, a sus tareas. */
  private readonly desde = toSignal(this.route.queryParamMap.pipe(map((q) => q.get('desde'))), { initialValue: null });
  readonly volverA = computed(() => (this.desde() === 'equipo' ? '/tareas/equipo' : '/tareas/hoy'));
  readonly volverTexto = computed(() => (this.volverA() === '/tareas/equipo' ? 'Tareas de mi equipo' : 'Mis tareas'));
  readonly kpis = computed<MetricStripItem[]>(() => {
    const a = this.d()?.avance;
    if (!a) return [];
    return [
      { label: 'Con evidencia', value: a.hechos, tone: a.hechos === a.total ? 'ok' : 'default', sub: `de ${a.total} puntos` },
      { label: 'Justificados', value: a.justificados, tone: a.justificados ? 'warn' : 'muted' },
      { label: 'Sin evidencia', value: a.sin_ejecutar, tone: a.sin_ejecutar ? 'bad' : 'muted' },
    ];
  });

  /** Cerrar la pestaña con algo sin guardar pregunta antes (`[MDT.UI.3]`). */
  @HostListener('window:beforeunload', ['$event'])
  alSalir(ev: BeforeUnloadEvent): void {
    if (this.enCurso() || this.conError() || Object.keys(this.fallidas()).length) {
      ev.preventDefault();
      ev.returnValue = '';
    }
  }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.svc.detalle(this.id()).subscribe({
      next: (e) => this.poner(e),
      error: (err: HttpErrorResponse) => { this.cargando.set(false); this.error.set(err.error?.message || err.message); },
    });
  }

  marcarSucio(puntoId: string, campo: string): void {
    if (!this.d()?.editable) return;
    const k = `${puntoId}:${campo}`;
    if (!this.sucios()[k]) this.sucios.update((s) => ({ ...s, [k]: true }));
  }

  errorDe(puntoId: string): string | null {
    const ps = this.pendientes();
    for (const k of Object.keys(ps)) if (k.startsWith(`${puntoId}:`) && ps[k].estado === 'error') return k;
    return null;
  }

  guardandoDe(puntoId: string): boolean {
    const ps = this.pendientes();
    return Object.keys(ps).some((k) => k.startsWith(`${puntoId}:`) && ps[k].estado === 'guardando');
  }

  guardar(p: PuntoDeEntrega, body: GuardarPunto): void {
    const e = this.d();
    if (!e?.editable) return;
    const campo = Object.keys(body)[0] as keyof GuardarPunto;
    const k = `${p.id}:${campo}`;
    this.quitar(this.sucios, k);
    const antes = JSON.stringify(p.respuesta[campo as keyof typeof p.respuesta] ?? null);
    // Nada cambió y no había un intento fallido: no se llama al servidor.
    if (antes === JSON.stringify(body[campo] ?? null) && !this.pendientes()[k]) return;
    this.enviar(k, body, this.svc.guardarPunto(e.id, p.id, body));
  }

  reintentar(p: PuntoDeEntrega, k: string): void {
    const e = this.d();
    const pend = this.pendientes()[k];
    if (!e?.editable || !pend) return;
    this.enviar(k, pend.body, this.svc.guardarPunto(e.id, p.id, pend.body));
  }

  async alElegir(p: PuntoDeEntrega, ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const archivo = input.files?.[0];
    input.value = '';
    if (!archivo || !this.d()?.editable || this.subiendo()[p.id]) return;
    this.subiendo.update((s) => ({ ...s, [p.id]: true }));
    try {
      const dataUri = await this.preparar(archivo);
      this.subir(p, { dataUri, nombre: archivo.name, capturada: new Date(archivo.lastModified || Date.now()).toISOString() });
    } catch {
      this.quitar(this.subiendo, p.id);
      this.toast.add({ severity: 'error', summary: 'No se pudo leer el archivo', detail: 'Intenta tomar la foto otra vez.' });
    }
  }

  reintentarFoto(p: PuntoDeEntrega): void {
    const f = this.fallidas()[p.id];
    if (!f || this.subiendo()[p.id] || !this.d()?.editable) return;
    this.subiendo.update((s) => ({ ...s, [p.id]: true }));
    this.subir(p, f);
  }

  descartarFoto(puntoId: string): void {
    this.quitar(this.fallidas, puntoId);
  }

  pedirRetirar(fileId: string, numero: number): void {
    if (!this.d()?.editable || this.entregando()) return;
    this.confirm.confirm({
      header: '¿Quitar esta foto?',
      message: `Se quita del punto ${numero}. Si fue un error, tendrás que volver a tomarla.`,
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, quitar',
      rejectLabel: 'Conservar',
      acceptButtonStyleClass: 'p-button-danger',
      rejectButtonStyleClass: 'p-button-text',
      accept: () => this.retirar(fileId),
    });
  }

  entregar(): void {
    const e = this.d();
    if (!e?.editable || !this.puedeEntregar()) return;
    this.entregando.set(true); // síncrono en el primer clic: el doble toque no entrega dos veces
    this.svc.entregar(e.id, this.faltan() ? this.nota().trim() : null).subscribe({
      next: (r) => { this.poner(r); this.entregando.set(false); this.toast.add({ severity: 'success', summary: 'Entregada' }); },
      error: (err: HttpErrorResponse) => { this.entregando.set(false); this.fallo('No se entregó', err); },
    });
  }

  lista(p: PuntoDeEntrega): string {
    return (p.respuesta.list ?? []).join('\n');
  }

  renglones(texto: string): string[] {
    return String(texto ?? '').split('\n').map((r) => r.trim()).filter((r) => r.length > 0);
  }

  /** Liberal al recibir: «1,250.50» y «$ 1250» son el mismo monto. Vacío = sin monto. */
  monto(texto: string): number | null {
    const limpio = String(texto ?? '').replace(/[$,\s]/g, '');
    if (!limpio) return null;
    const n = Number(limpio);
    return Number.isFinite(n) ? n : null;
  }

  private retirar(fileId: string): void {
    const e = this.d();
    if (!e?.editable) return;
    this.empezar();
    this.svc.retirar(e.id, fileId).subscribe({
      next: (r) => this.terminar(r),
      error: (err: HttpErrorResponse) => { this.terminar(null); this.fallo('No se quitó el archivo', err); },
    });
  }

  private subir(p: PuntoDeEntrega, f: FotoFallida): void {
    const e = this.d();
    if (!e) return;
    this.empezar();
    this.svc.subir(e.id, p.id, { file_base64: f.dataUri, file_name: f.nombre, captured_at: f.capturada }).subscribe({
      next: (r) => { this.quitar(this.subiendo, p.id); this.quitar(this.fallidas, p.id); this.terminar(r); },
      error: (err: HttpErrorResponse) => {
        this.quitar(this.subiendo, p.id);
        this.fallidas.update((s) => ({ ...s, [p.id]: f }));
        this.terminar(null);
        this.fallo('No se subió la foto', err);
      },
    });
  }

  private enviar(k: string, body: GuardarPunto, peticion: Observable<DetalleEntrega>): void {
    this.pendientes.update((s) => ({ ...s, [k]: { estado: 'guardando', body } }));
    this.empezar();
    peticion.subscribe({
      next: (r) => { this.quitar(this.pendientes, k); this.terminar(r); },
      error: (err: HttpErrorResponse) => {
        this.pendientes.update((s) => ({ ...s, [k]: { estado: 'error', body } }));
        this.terminar(null);
        this.fallo('No se guardó', err);
      },
    });
  }

  private empezar(): void {
    if (this.enVuelo > 0) this.encimadas = true;
    this.enVuelo++;
  }

  /**
   * Una escritura terminó. Si se encimó con otra, su respuesta puede ser más vieja que la de la otra
   * (A lee antes de que B inserte y llega después): al terminar la última se relee del servidor en vez
   * de pintar una respuesta que podría borrar una foto ya subida.
   */
  private terminar(r: DetalleEntrega | null): void {
    this.enVuelo = Math.max(0, this.enVuelo - 1);
    if (this.enVuelo > 0) return;
    if (this.encimadas) { this.encimadas = false; this.cargar(); return; }
    if (r) this.poner(r);
  }

  private quitar<T>(sig: { (): Record<string, T>; set(v: Record<string, T>): void }, k: string): void {
    const actual = sig();
    if (!(k in actual)) return;
    const copia: Record<string, T> = {};
    for (const x of Object.keys(actual)) if (x !== k) copia[x] = actual[x];
    sig.set(copia);
  }

  private poner(e: DetalleEntrega): void {
    this.d.set(e);
    this.cargando.set(false);
    this.cargado.set(new Date());
    if (e.employee_note && !this.nota()) this.nota.set(e.employee_note);
  }

  private fallo(titulo: string, err: HttpErrorResponse): void {
    this.toast.add({ severity: 'error', summary: titulo, detail: err.error?.message || err.message });
  }

  /** Data URI del archivo; las fotos JPEG/PNG/WebP se reducen a {@link LADO_MAX} px de lado. PDF y HEIC van tal cual. */
  private async preparar(archivo: File): Promise<string> {
    const leer = (b: Blob) => new Promise<string>((ok, mal) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result));
      r.onerror = () => mal(r.error);
      r.readAsDataURL(b);
    });
    if (!/^image\/(jpeg|png|webp)$/.test(archivo.type)) return leer(archivo);
    const bmp = await createImageBitmap(archivo).catch(() => null);
    if (!bmp) return leer(archivo);
    const escala = Math.min(1, LADO_MAX / Math.max(bmp.width, bmp.height));
    if (escala === 1) { bmp.close(); return leer(archivo); }
    const lienzo = document.createElement('canvas');
    lienzo.width = Math.round(bmp.width * escala);
    lienzo.height = Math.round(bmp.height * escala);
    lienzo.getContext('2d')?.drawImage(bmp, 0, 0, lienzo.width, lienzo.height);
    bmp.close();
    const blob = await new Promise<Blob | null>((ok) => lienzo.toBlob(ok, 'image/jpeg', 0.82));
    return blob ? leer(blob) : leer(archivo);
  }
}
