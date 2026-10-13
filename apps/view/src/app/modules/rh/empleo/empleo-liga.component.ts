import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import {
  HR_CUESTIONARIO_LIDERAZGO, HR_NIVELES_LIKERT, HR_NIVELES_STAR, hrPuntajeStar,
  type HrAptitudesEvaluacion, type HrCompetenciaStar, type HrLiderazgoAvanceDto, type HrLigaContextoDto, type HrLigaCvSubida,
  type HrNivelStar, type HrPostulacionResultadoDto,
} from '@megadulces/contracts';
import { environment } from '../../../../environments/environment';
import { MAX_DOCUMENTO_BYTES, leerComoDataUri } from '../reclutamiento-formato';

type Modo = 'pdf' | 'fotos';

/** El mensaje del servidor, o uno que diga qué hacer. Una liga que no sirve dice lo mismo pase lo que pase. */
function errorDe(e: unknown): string {
  if (e instanceof HttpErrorResponse) {
    if (e.status === 403) return 'Este enlace ya no sirve. Pide uno nuevo a Capital Humano.';
    if (e.status === 429) return 'Hiciste varios intentos seguidos. Espera unos minutos y vuelve a enviar.';
    if (e.status === 413) return 'Tu archivo es demasiado pesado. Toma la foto con menos calidad o manda un PDF.';
    if (e.status === 0) return 'No hay conexión. Revisa tu internet y vuelve a intentar.';
    const m = (e.error as { message?: string | string[] } | null)?.message;
    if (Array.isArray(m)) return m.join(' · ');
    if (typeof m === 'string' && m) return m;
  }
  return 'No pudimos recibir tu CV. Vuelve a intentar en un momento.';
}

/**
 * Fase RH · `[RH.2.4]` — la página de una LIGA PERSONAL (`/empleo/liga/:token`). Antes: `/solicitud/:id` y
 * `/evaluacion/:id` de Mega Talento, que abrían con el id del candidato. Hace una de dos cosas, según la liga:
 *   · subir el CV —un PDF, o dos fotos (frente y reverso), la regla de Mega Talento—;
 *   · el cuestionario de liderazgo —12 preguntas, una a la vez; cada respuesta se guarda al momento (RH puede estar
 *     viéndolo en la videollamada). El candidato NO ve su puntaje; si califica o no, lo decide el servidor;
 *   · la evaluación de aptitudes —la abre el JEFE que entrevista (antes `/evaluar-aptitudes/:id`): cada competencia de
 *     la hoja del puesto con su pregunta STAR y las 3 anclas; él sí ve el puntaje mientras califica (como allá).
 * Sin la voz de Mega Talento (Azure): queda fuera hasta que RH la pida.
 * El servidor vuelve a validar todo.
 */
@Component({
  selector: 'app-empleo-liga',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="el">
      <p class="el-marca">Mega Dulces de Los Altos · Capital Humano</p>
      @if (cargando()) {
        <p class="el-nota">Abriendo tu enlace…</p>
      } @else if (errorLiga()) {
        <section class="el-card" role="alert"><h1>No se pudo abrir</h1><p>{{ errorLiga() }}</p></section>
      } @else if (resultado(); as r) {
        <section class="el-card el-ok" role="status" aria-live="polite"><h1>¡Listo!</h1><p>{{ r.mensaje }}</p></section>
      } @else if (ctx()?.form === 'aptitudes') {
        <section class="el-card">
          <h1>Evaluación de aptitudes</h1>
          <p><b>{{ ctx()?.candidato_nombre || 'Candidato' }}</b>@if (ctx()?.puesto) { · {{ ctx()?.puesto }}}</p>
          <p class="el-nota">Califica cada competencia después de la entrevista. Puedes corregir y volver a guardar.</p>
          <label class="el-campo">Tu nombre * <input [value]="evaluador()" (input)="evaluador.set(valor($event))" maxlength="150" autocomplete="name" /></label>
          <label class="el-campo">Tu puesto <input [value]="cargo()" (input)="cargo.set(valor($event))" maxlength="150" /></label>
          <label class="el-campo">Duración de la entrevista <input [value]="tiempo()" (input)="tiempo.set(valor($event))" maxlength="50" placeholder="Ej. 40 min" /></label>
        </section>
        @for (c of competencias(); track c.key; let i = $index) {
          <section class="el-card el-comp" [attr.aria-label]="c.parametro">
            <p class="el-nota">{{ i + 1 }} de {{ competencias().length }} · {{ c.categoria }}</p>
            <h2>{{ c.parametro }}</h2>
            <p class="el-star">{{ c.preguntaStar }}</p>
            <div class="el-likert" role="radiogroup" [attr.aria-label]="c.parametro">
              @for (n of nivelesStar; track n.id) {
                <button type="button" role="radio" [attr.aria-checked]="rubrica()[c.key] === n.id" (click)="calificar(c.key, n.id)">
                  <b>{{ n.label }} · {{ n.puntos }}</b><small>{{ ancla(c, n.id) }}</small>
                </button>
              }
            </div>
          </section>
        }
        <section class="el-card el-total" aria-live="polite">
          <p><b class="mono">{{ calc().puntaje }}/{{ calc().max }}</b> · {{ calc().pct }}% · {{ calc().banda }}
            @if (!calc().completa) { <span class="el-nota"> — faltan {{ calc().total - calc().calificadas }}</span> }</p>
          <label class="el-campo">Observaciones <textarea rows="3" [value]="observaciones()" (input)="observaciones.set(valor($event))" maxlength="2000"></textarea></label>
          @if (error(); as e) { <p class="el-err" role="alert">{{ e }}</p> }
          <button type="button" class="el-btn" [disabled]="!puedeGuardarApt() || enviando()" (click)="guardarAptitudes()">{{ enviando() ? 'Guardando…' : 'Guardar evaluación' }}</button>
        </section>
      } @else if (ctx()?.form === 'liderazgo') {
        @if (terminado()) {
          <section class="el-card el-ok" role="status" aria-live="polite"><h1>¡Gracias!</h1>
            <p>Terminaste el cuestionario. Capital Humano de Mega Dulces revisará tus respuestas y te dirá los siguientes pasos.</p></section>
        } @else if (pregunta(); as q) {
          <section class="el-card">
            <h1>Hola{{ ctx()?.nombre ? ' ' + ctx()?.nombre : '' }}</h1>
            <p class="el-nota">Pregunta {{ paso() + 1 }} de {{ preguntas.length }} · ¿Qué tanto te describe?</p>
            <div class="el-barra" role="progressbar" [attr.aria-valuenow]="contestadas()" aria-valuemin="0" [attr.aria-valuemax]="preguntas.length">
              <span [style.width.%]="contestadas() * 100 / preguntas.length"></span>
            </div>
            <p class="el-pregunta">{{ q.texto }}</p>
            <div class="el-likert" role="radiogroup" [attr.aria-label]="'Pregunta ' + q.num">
              @for (n of niveles; track n.valor) {
                <button type="button" role="radio" [attr.aria-checked]="respuestas()[q.num] === n.valor" [disabled]="enviando()"
                        (click)="responder(q.num, n.valor)">{{ n.etiquetaCorta }}</button>
              }
            </div>
            @if (error(); as e) { <p class="el-err" role="alert">{{ e }}</p> }
            @if (paso() > 0) { <button type="button" class="el-link" (click)="paso.set(paso() - 1)">Pregunta anterior</button> }
          </section>
        }
      } @else if (ctx(); as c) {
        <section class="el-card">
          <h1>Hola{{ c.nombre ? ' ' + c.nombre : '' }}</h1>
          <p>Sube tu CV para continuar tu proceso@if (c.puesto) { para <b>{{ c.puesto }}</b>}.</p>
          @if (c.ya_tiene_cv) { <p class="el-nota">Ya tenemos un CV tuyo. Si mandas otro, lo agregamos.</p> }

          <div class="el-seg" role="group" aria-label="Cómo mandas tu CV">
            <button type="button" [attr.aria-pressed]="modo() === 'pdf'" (click)="cambiarModo('pdf')">Un PDF</button>
            <button type="button" [attr.aria-pressed]="modo() === 'fotos'" (click)="cambiarModo('fotos')">Dos fotos</button>
          </div>

          @if (modo() === 'pdf') {
            <label class="el-subir"><input type="file" accept="application/pdf" (change)="elegir($event, 0)" />
              <span>{{ archivos()[0]?.name || 'Elegir PDF' }}</span></label>
          } @else {
            <label class="el-subir"><input type="file" accept="image/*" capture="environment" (change)="elegir($event, 0)" />
              <span>{{ archivos()[0]?.name || 'Foto del frente' }}</span></label>
            <label class="el-subir"><input type="file" accept="image/*" capture="environment" (change)="elegir($event, 1)" />
              <span>{{ archivos()[1]?.name || 'Foto del reverso' }}</span></label>
          }
          <small class="el-nota">Hasta 10 MB por archivo. El enlace es personal@if (vence()) {: vence el {{ vence() }}}.</small>

          @if (error(); as e) { <p class="el-err" role="alert">{{ e }}</p> }
          <button type="button" class="el-btn" [disabled]="!completo() || enviando()" (click)="enviar()">{{ enviando() ? 'Enviando…' : 'Enviar mi CV' }}</button>
        </section>
      }
    </main>
  `,
  styles: [`
    :host { display: block; min-height: 100vh; background: var(--surface-ground); }
    .el { max-width: 32rem; margin: 0 auto; padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); font-family: var(--font-body); color: var(--text-main); }
    .el-marca { margin: 0; font-size: var(--fs-xs); font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--action); }
    .el-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); }
    .el-card h1 { margin: 0; font: 700 var(--fs-h2)/1.2 var(--font-body); }
    .el-card p { margin: 0; }
    .el-ok { border-color: var(--ok-soft-fg); }
    .el-nota { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
    .el-err { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); background: var(--bad-soft-bg); color: var(--bad-soft-fg); font-size: var(--fs-sm); }
    .el-seg { display: inline-flex; border: 1px solid var(--border-color); border-radius: var(--r-sm); overflow: hidden; align-self: flex-start; }
    .el-seg button { border: 0; background: var(--card-bg); padding: var(--sp-2) var(--sp-3); min-height: 2.75rem; font: inherit; color: var(--text-muted); cursor: pointer; }
    .el-seg button + button { border-left: 1px solid var(--border-color); }
    .el-seg button[aria-pressed='true'] { background: var(--surface-selected-bg); color: var(--text-main); font-weight: 700; }
    .el-subir { position: relative; display: flex; align-items: center; min-height: 2.75rem; padding: var(--sp-2) var(--sp-3);
      border: 1px dashed var(--border-color); border-radius: var(--r-sm); cursor: pointer; overflow-wrap: anywhere; }
    .el-subir input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
    .el-btn { border: 0; border-radius: var(--r-sm); padding: var(--sp-2) var(--sp-4); min-height: 2.75rem; font: inherit; font-weight: 700;
      background: var(--action); color: var(--action-ink); cursor: pointer; }
    .el-btn:hover:not(:disabled) { background: var(--action-hover); }
    .el-btn:disabled { opacity: .6; cursor: not-allowed; }
    .el-seg button:focus-visible, .el-btn:focus-visible, .el-subir:focus-within { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .el-barra { height: 6px; border-radius: var(--r-pill); background: var(--surface-2); overflow: hidden; }
    .el-barra span { display: block; height: 100%; background: var(--action); }
    .el-pregunta { font-size: var(--fs-body); font-weight: 600; line-height: 1.5; }
    .el-likert { display: flex; flex-direction: column; gap: var(--sp-2); }
    .el-likert button { min-height: 2.75rem; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-sm);
      background: var(--card-bg); color: var(--text-main); font: inherit; text-align: left; cursor: pointer; }
    .el-likert button[aria-checked='true'] { border-color: var(--action); background: var(--surface-selected-bg); font-weight: 700; }
    .el-likert button:focus-visible, .el-link:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .el-campo { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); font-weight: 600; }
    .el-campo input, .el-campo textarea { font: inherit; font-weight: 400; padding: var(--sp-2) var(--sp-3); min-height: 2.75rem; border: 1px solid var(--border-color);
      border-radius: var(--r-sm); background: var(--card-bg); color: var(--text-main); }
    .el-campo input:focus-visible, .el-campo textarea:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .el-comp h2 { margin: 0; font-size: var(--fs-h3); }
    .el-star { color: var(--text-muted); font-size: var(--fs-sm); line-height: 1.5; }
    .el-comp .el-likert button { display: flex; flex-direction: column; gap: var(--sp-1); }
    .el-comp .el-likert small { color: var(--text-muted); font-size: var(--fs-xs); line-height: 1.4; }
    .el-total { position: sticky; bottom: 0; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .el-link { align-self: flex-start; border: 0; background: none; padding: 0; font: inherit; font-size: var(--fs-sm); color: var(--text-muted); text-decoration: underline; cursor: pointer; }
  `],
})
export class EmpleoLigaComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly base = `${environment.apiUrl}/hr/talent/public/links`;
  private token = '';

  readonly cargando = signal(true);
  readonly ctx = signal<HrLigaContextoDto | null>(null);
  readonly errorLiga = signal<string | null>(null);
  readonly modo = signal<Modo>('pdf');
  readonly archivos = signal<Array<File | null>>([null, null]);
  readonly enviando = signal(false);
  readonly error = signal<string | null>(null);
  readonly resultado = signal<HrPostulacionResultadoDto | null>(null);

  // ── Cuestionario de liderazgo ──
  readonly preguntas = HR_CUESTIONARIO_LIDERAZGO;
  readonly niveles = HR_NIVELES_LIKERT;
  readonly respuestas = signal<Record<number, number>>({});
  readonly paso = signal(0);
  readonly terminado = signal(false);
  readonly pregunta = computed(() => this.preguntas[this.paso()] ?? null);
  readonly contestadas = computed(() => Object.keys(this.respuestas()).length);

  // ── Evaluación de aptitudes (la llena el jefe) ──
  readonly nivelesStar = HR_NIVELES_STAR;
  readonly competencias = signal<HrCompetenciaStar[]>([]);
  readonly rubrica = signal<Record<string, HrNivelStar>>({});
  readonly evaluador = signal('');
  readonly cargo = signal('');
  readonly tiempo = signal('');
  readonly observaciones = signal('');
  readonly calc = computed(() => hrPuntajeStar(this.rubrica(), this.competencias()));
  readonly puedeGuardarApt = computed(() => {
    const listo = this.calc().completa;
    return listo && this.evaluador().trim().length >= 3;
  });

  /** PDF: uno. Fotos: las dos (regla de Mega Talento). */
  readonly completo = computed(() => {
    const [a, b] = this.archivos();
    return this.modo() === 'pdf' ? !!a : !!a && !!b;
  });
  readonly vence = computed(() => {
    const v = this.ctx()?.vence;
    return v ? new Date(v).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'long' }) : null;
  });

  ngOnInit(): void {
    this.token = this.route.snapshot.paramMap.get('token') ?? '';
    this.http.get<HrLigaContextoDto>(`${this.base}/${encodeURIComponent(this.token)}`).subscribe({
      next: (c) => {
        this.ctx.set(c);
        if (c.form === 'aptitudes') {
          this.competencias.set(c.competencias ?? []);
          this.rubrica.set({ ...(c.rubrica ?? {}) });
          if (c.evaluacion) {
            this.evaluador.set(c.evaluacion.evaluador); this.cargo.set(c.evaluacion.cargoEvaluador);
            this.tiempo.set(c.evaluacion.tiempo); this.observaciones.set(c.evaluacion.observaciones);
          }
        }
        if (c.form === 'liderazgo') {
          const r = c.respuestas ?? {};
          this.respuestas.set(r);
          this.terminado.set(!!c.terminado);
          // Retoma en la primera que le falta.
          const falta = this.preguntas.findIndex((q) => !r[q.num]);
          this.paso.set(falta < 0 ? this.preguntas.length - 1 : falta);
        }
        this.cargando.set(false);
      },
      error: (e) => { this.errorLiga.set(errorDe(e)); this.cargando.set(false); },
    });
  }

  valor(ev: Event): string {
    return (ev.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  /** El ancla (descripción) de un nivel para una competencia. */
  ancla(c: HrCompetenciaStar, n: HrNivelStar): string {
    return c.anclas?.[n] ?? '';
  }

  /** Marcar un nivel; volver a tocar el mismo lo quita (como en Mega Talento). */
  calificar(key: string, n: HrNivelStar): void {
    const r = { ...this.rubrica() };
    if (r[key] === n) delete r[key]; else r[key] = n;
    this.rubrica.set(r);
  }

  guardarAptitudes(): void {
    if (!this.puedeGuardarApt()) return;
    this.enviando.set(true);
    this.error.set(null);
    const cuerpo: HrAptitudesEvaluacion = {
      rubrica: this.rubrica(), evaluador: this.evaluador(), cargo_evaluador: this.cargo() || null,
      tiempo: this.tiempo() || null, observaciones: this.observaciones() || null,
    };
    this.http.post<HrPostulacionResultadoDto>(`${this.base}/${encodeURIComponent(this.token)}/aptitudes`, cuerpo).subscribe({
      next: (r) => { this.enviando.set(false); this.resultado.set(r); },
      error: (e) => { this.enviando.set(false); this.error.set(errorDe(e)); },
    });
  }

  /** Guarda la respuesta al momento y pasa a la siguiente que falte. */
  responder(num: number, valor: number): void {
    this.enviando.set(true);
    this.error.set(null);
    this.http.post<HrLiderazgoAvanceDto>(`${this.base}/${encodeURIComponent(this.token)}/liderazgo`, { num, valor }).subscribe({
      next: (a) => {
        this.enviando.set(false);
        const r = { ...this.respuestas(), [num]: valor };
        this.respuestas.set(r);
        if (a.terminado) { this.terminado.set(true); return; }
        const sig = this.preguntas.findIndex((q, i) => i > this.paso() && !r[q.num]);
        const cualquiera = this.preguntas.findIndex((q) => !r[q.num]);
        this.paso.set(sig >= 0 ? sig : cualquiera >= 0 ? cualquiera : this.paso());
      },
      error: (e) => {
        this.enviando.set(false);
        if (e instanceof HttpErrorResponse && e.status === 409) { this.terminado.set(true); return; }
        this.error.set(errorDe(e));
      },
    });
  }

  cambiarModo(m: Modo): void {
    if (this.modo() === m) return;
    this.modo.set(m);
    this.archivos.set([null, null]);
    this.error.set(null);
  }

  elegir(ev: Event, i: 0 | 1): void {
    const input = ev.target as HTMLInputElement;
    const f = input.files?.[0] ?? null;
    if (f && f.size > MAX_DOCUMENTO_BYTES) {
      this.error.set('El archivo pasa de 10 MB. Toma la foto con menos calidad o manda un PDF.');
      input.value = '';
      return;
    }
    this.error.set(null);
    const lista = [...this.archivos()];
    lista[i] = f;
    this.archivos.set(lista);
  }

  async enviar(): Promise<void> {
    if (!this.completo()) return;
    this.enviando.set(true);
    this.error.set(null);
    try {
      const elegidos = this.archivos().slice(0, this.modo() === 'pdf' ? 1 : 2).filter((f): f is File => !!f);
      const cuerpo: HrLigaCvSubida = { files: await Promise.all(elegidos.map(async (f) => ({ file_base64: await leerComoDataUri(f), file_name: f.name }))) };
      this.http.post<HrPostulacionResultadoDto>(`${this.base}/${encodeURIComponent(this.token)}/cv`, cuerpo).subscribe({
        next: (r) => { this.enviando.set(false); this.resultado.set(r); },
        error: (e) => { this.enviando.set(false); this.error.set(errorDe(e)); },
      });
    } catch {
      this.enviando.set(false);
      this.error.set('No pudimos leer tu archivo. Vuelve a elegirlo.');
    }
  }
}
