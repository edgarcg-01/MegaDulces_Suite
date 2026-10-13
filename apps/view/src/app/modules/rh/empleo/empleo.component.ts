import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import {
  HR_CIUDADES_EMPLEO, HR_FUENTES_EMPLEO, HR_SUCURSALES_EMPLEO, hrPideLicencia, hrVacanteEnCiudad,
  type HrPostulacionPublica, type HrPostulacionResultadoDto, type HrVacantePublicaDto,
} from '@megadulces/contracts';
import { environment } from '../../../../environments/environment';
import { MAX_DOCUMENTO_BYTES, leerComoDataUri } from '../reclutamiento-formato';

/**
 * ⚠️ BORRADOR — Mega Talento no tenía un aviso de privacidad para candidatos (su pie decía «Aviso de privacidad» sin
 * texto detrás). Esto es lo mínimo que la página tiene que decir; NO es texto legal aprobado. Antes de publicar
 * `/empleo` en producción, el texto oficial lo da la empresa y reemplaza esta constante.
 */
export const AVISO_PRIVACIDAD_CANDIDATOS = [
  'Mega Dulces de Los Altos recibe estos datos sólo para tu proceso de reclutamiento: revisar tu solicitud, contactarte y, si avanzas, armar tu expediente.',
  'No los vendemos ni los compartimos fuera de la empresa. Si no avanzas, los conservamos para considerarte en vacantes futuras.',
  'Puedes pedir que corrijamos o borremos tus datos escribiéndonos por WhatsApp al número de Recursos Humanos.',
];

interface Form {
  city_branch: string; job_posting_id: string; full_name: string; phone: string; email: string; heard_from: string;
  relative_in_company: string; rehire_note: string; privacy_accepted: boolean; website: string;
}

const vacio = (): Form => ({
  city_branch: '', job_posting_id: '', full_name: '', phone: '', email: '', heard_from: '',
  relative_in_company: '', rehire_note: '', privacy_accepted: false, website: '',
});

/** Las ciudades de una vacante, para mostrarlas (sin sucursales asignadas = todas). */
export function ciudadesDe(v: Pick<HrVacantePublicaDto, 'branch_codes' | 'branches_text'>): string {
  if (v.branches_text) return v.branches_text;
  if (!v.branch_codes?.length) return 'Todas las ciudades';
  return [...new Set(HR_SUCURSALES_EMPLEO.filter((s) => v.branch_codes.includes(s.id)).map((s) => s.ciudad))].join(' · ');
}

/** El mensaje del servidor, o uno que diga qué hacer. */
function errorDe(e: unknown): string {
  if (e instanceof HttpErrorResponse) {
    if (e.status === 429) return 'Hiciste varios intentos seguidos. Espera unos minutos y vuelve a enviar.';
    if (e.status === 413) return 'Tu archivo es demasiado pesado. Toma la foto con menos calidad o manda un PDF.';
    if (e.status === 0) return 'No hay conexión. Revisa tu internet y vuelve a intentar.';
    const m = (e.error as { message?: string | string[] } | null)?.message;
    if (Array.isArray(m)) return m.join(' · ');
    if (typeof m === 'string' && m) return m;
  }
  return 'No pudimos enviar tu solicitud. Vuelve a intentar en un momento.';
}

/**
 * Fase RH · `[RH.2.4]` — la bolsa de trabajo pública (`/empleo`). Antes: `/empleos` y `/unete` de Mega Talento.
 *
 * Sin sesión, desde el celular. Las vacantes arriba; el formulario abajo, con las mismas reglas que el formulario de
 * Mega Talento (el puesto se elige después de la ciudad, CV obligatorio, licencia para Chofer y Logística, «¿dónde te
 * enteraste?»). El servidor vuelve a validar todo: lo de aquí es para ayudar a quien llena, no para proteger.
 * El campo «website» no se ve: si llega lleno es un robot.
 */
@Component({
  selector: 'app-empleo',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="em">
      <header class="em-head">
        <p class="em-marca">Mega Dulces de Los Altos</p>
        <h1>Trabaja con nosotros</h1>
        <p>Elige una vacante, llena tus datos y adjunta tu CV. Te contactamos por WhatsApp o por teléfono.</p>
      </header>

      @if (resultado(); as r) {
        <section class="em-card em-res" [attr.data-t]="r.resultado" role="status" aria-live="polite">
          <h2>{{ r.resultado === 'recibida' ? '¡Listo!' : 'No pudimos recibirla' }}</h2>
          <p>{{ r.mensaje }}</p>
          @if (r.resultado === 'recibida') { <button type="button" class="em-btn em-btn-sec" (click)="otra()">Volver a las vacantes</button> }
          @else { <button type="button" class="em-btn em-btn-sec" (click)="resultado.set(null)">Revisar mis datos</button> }
        </section>
      } @else {
        <section class="em-card" aria-label="Vacantes">
          <h2>Vacantes</h2>
          @if (cargando()) { <p class="em-nota">Cargando vacantes…</p> }
          @else if (errorVacantes()) { <p class="em-err" role="alert">{{ errorVacantes() }} <button type="button" class="em-link" (click)="cargar()">Reintentar</button></p> }
          @else if (!vacantes().length) { <p class="em-nota">Por ahora no hay vacantes publicadas.</p> }
          <ul class="em-vacantes">
            @for (v of vacantes(); track v.id) {
              <li [class.sel]="f.job_posting_id === v.id">
                <div class="em-v-head">
                  <h3>{{ v.name }}</h3>
                  <button type="button" class="em-btn" (click)="elegir(v)">Postularme</button>
                </div>
                <p class="em-v-meta">{{ ciudadesDe(v) }}@if (v.salary_text) { · {{ v.salary_text }} }@if (v.schedule_text) { · {{ v.schedule_text }} }</p>
                @if (v.description || v.requirements) {
                  <details><summary>Ver detalles</summary>
                    @if (v.description) { <p>{{ v.description }}</p> }
                    @if (v.requirements) { <p><b>Requisitos:</b> {{ v.requirements }}</p> }
                  </details>
                }
              </li>
            }
          </ul>
        </section>

        <form id="solicitud" class="em-card em-form" (ngSubmit)="enviar()" aria-label="Solicitud">
          <h2>Tu solicitud</h2>

          <label>Ciudad donde te interesa trabajar *
            <select name="ciudad" [(ngModel)]="f.city_branch" (ngModelChange)="alCambiarCiudad()" required>
              <option value="" disabled>Elige una ciudad…</option>
              @for (c of ciudades; track c) { <option [value]="c">{{ c }}</option> }
            </select>
          </label>

          <label>Puesto que te interesa *
            <select name="puesto" [(ngModel)]="f.job_posting_id" [disabled]="!f.city_branch" required>
              <option value="" disabled>{{ f.city_branch ? 'Elige un puesto…' : 'Primero elige una ciudad' }}</option>
              @for (v of vacantesDeCiudad(); track v.id) { <option [value]="v.id">{{ v.name }}</option> }
            </select>
            @if (f.city_branch && !vacantesDeCiudad().length) { <small>No hay vacantes en {{ f.city_branch }} por ahora.</small> }
          </label>

          <label>Nombre completo * <input name="nombre" [(ngModel)]="f.full_name" autocomplete="name" required maxlength="150" /></label>
          <label>Teléfono (10 dígitos) *
            <input name="telefono" type="tel" inputmode="numeric" [(ngModel)]="f.phone" autocomplete="tel" required maxlength="14" placeholder="Ej. 3521234567" />
          </label>
          <label>Correo (opcional) <input name="correo" type="email" [(ngModel)]="f.email" autocomplete="email" maxlength="150" /></label>

          <label>¿Dónde te enteraste de la vacante? *
            <select name="fuente" [(ngModel)]="f.heard_from" required>
              <option value="" disabled>Elige una opción…</option>
              @for (x of fuentes; track x) { <option [value]="x">{{ x }}</option> }
            </select>
          </label>

          <label>¿Tienes un familiar o pareja trabajando en la empresa? (opcional)
            <input name="familiar" [(ngModel)]="f.relative_in_company" maxlength="300" placeholder="Nombre y parentesco, o «ninguno»" />
          </label>
          <label>¿Ya trabajaste antes con nosotros? (opcional)
            <input name="reingreso" [(ngModel)]="f.rehire_note" maxlength="300" placeholder="Sucursal, puesto y cuándo" />
          </label>

          <div class="em-archivo">
            <span>Tu CV * <small>PDF o foto, hasta 10 MB</small></span>
            <label class="em-subir">
              <input type="file" accept="application/pdf,image/*" (change)="archivo($event, 'cv')" />
              <span>{{ cv() ? cv()!.name : 'Tomar foto o elegir archivo' }}</span>
            </label>
          </div>

          @if (pideLicencia()) {
            <div class="em-archivo">
              <span>Licencia de manejo vigente * <small>Para {{ puestoElegido()?.name }}</small></span>
              <label class="em-subir">
                <input type="file" accept="application/pdf,image/*" (change)="archivo($event, 'licencia')" />
                <span>{{ licencia() ? licencia()!.name : 'Tomar foto o elegir archivo' }}</span>
              </label>
            </div>
          }

          <!-- Campo trampa: una persona no lo ve ni lo llena. -->
          <div class="em-trampa" aria-hidden="true">
            <label>No llenar <input name="website" [(ngModel)]="f.website" tabindex="-1" autocomplete="off" /></label>
          </div>

          <details class="em-aviso"><summary>Aviso de privacidad</summary>
            @for (p of aviso; track $index) { <p>{{ p }}</p> }
          </details>
          <label class="em-check"><input type="checkbox" name="privacidad" [(ngModel)]="f.privacy_accepted" /> Leí y acepto el aviso de privacidad.</label>

          @if (error(); as e) { <p class="em-err" role="alert">{{ e }}</p> }
          <button type="submit" class="em-btn em-enviar" [disabled]="enviando()">{{ enviando() ? 'Enviando…' : 'Enviar solicitud' }}</button>
        </form>
      }
    </main>
  `,
  styles: [`
    :host { display: block; min-height: 100vh; background: var(--surface-ground); }
    .em { max-width: 40rem; margin: 0 auto; padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-4); font-family: var(--font-body); color: var(--text-main); }
    .em-head h1 { margin: var(--sp-1) 0; font: 700 var(--fs-h2)/1.2 var(--font-body); letter-spacing: -0.01em; }
    .em-head p { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
    .em-head .em-marca { font-size: var(--fs-xs); font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--action); }
    .em-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); }
    .em-card h2 { margin: 0; font-size: var(--fs-h3); }
    .em-nota { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
    .em-err { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); background: var(--bad-soft-bg); color: var(--bad-soft-fg); font-size: var(--fs-sm); }
    .em-vacantes { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--sp-2); }
    .em-vacantes li { border: 1px solid var(--border-color); border-radius: var(--r-sm); padding: var(--sp-3); }
    .em-vacantes li.sel { border-color: var(--action); }
    .em-v-head { display: flex; justify-content: space-between; align-items: center; gap: var(--sp-2); }
    .em-v-head h3 { margin: 0; font-size: var(--fs-body); font-weight: 700; }
    .em-v-meta { margin: var(--sp-1) 0 0; color: var(--text-muted); font-size: var(--fs-xs); }
    .em-vacantes details { margin-top: var(--sp-2); font-size: var(--fs-sm); }
    .em-vacantes details p { margin: var(--sp-1) 0 0; }
    .em-form label { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); font-weight: 600; }
    .em-form label small { font-weight: 400; color: var(--text-muted); }
    .em-form input:not([type='checkbox']):not([type='file']), .em-form select {
      font: inherit; font-weight: 400; padding: var(--sp-2) var(--sp-3); min-height: 2.75rem; border: 1px solid var(--border-color);
      border-radius: var(--r-sm); background: var(--card-bg); color: var(--text-main); }
    .em-form input:focus-visible, .em-form select:focus-visible, .em-btn:focus-visible, .em-subir:focus-within { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .em-archivo { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); font-weight: 600; }
    .em-archivo small { font-weight: 400; color: var(--text-muted); margin-left: var(--sp-1); }
    .em-subir { position: relative; display: flex; align-items: center; min-height: 2.75rem; padding: var(--sp-2) var(--sp-3);
      border: 1px dashed var(--border-color); border-radius: var(--r-sm); font-weight: 400; cursor: pointer; overflow-wrap: anywhere; }
    .em-subir input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
    .em-trampa { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }
    .em-aviso { font-size: var(--fs-xs); color: var(--text-muted); }
    .em-aviso p { margin: var(--sp-1) 0 0; }
    .em-form .em-check { flex-direction: row; align-items: center; gap: var(--sp-2); font-weight: 400; }
    .em-check input { width: 1.25rem; height: 1.25rem; }
    .em-btn { border: 0; border-radius: var(--r-sm); padding: var(--sp-2) var(--sp-4); min-height: 2.75rem; font: inherit; font-weight: 700;
      background: var(--action); color: var(--action-ink); cursor: pointer; }
    .em-btn:hover:not(:disabled) { background: var(--action-hover); }
    .em-btn:disabled { opacity: .6; cursor: progress; }
    .em-btn-sec { background: var(--surface-2); color: var(--text-main); align-self: flex-start; }
    .em-enviar { width: 100%; }
    .em-link { border: 0; background: none; padding: 0; font: inherit; color: inherit; text-decoration: underline; cursor: pointer; }
    .em-res[data-t='recibida'] { border-color: var(--ok-soft-fg); }
    .em-res[data-t='rechazada'] { border-color: var(--warn-soft-fg); }
    .em-res p { margin: 0; }
    @media (max-width: 30rem) { .em { padding: var(--sp-3); } }
  `],
})
export class EmpleoComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/hr/talent/public`;

  readonly ciudades = HR_CIUDADES_EMPLEO;
  readonly fuentes = HR_FUENTES_EMPLEO;
  readonly aviso = AVISO_PRIVACIDAD_CANDIDATOS;
  readonly ciudadesDe = ciudadesDe;

  readonly vacantes = signal<HrVacantePublicaDto[]>([]);
  readonly cargando = signal(false);
  readonly errorVacantes = signal<string | null>(null);
  readonly enviando = signal(false);
  readonly error = signal<string | null>(null);
  readonly resultado = signal<HrPostulacionResultadoDto | null>(null);
  readonly cv = signal<File | null>(null);
  readonly licencia = signal<File | null>(null);
  /** Para que los `computed` se enteren de los cambios del formulario (que vive en un objeto plano por ngModel). */
  private readonly version = signal(0);
  f: Form = vacio();

  readonly vacantesDeCiudad = computed(() => {
    this.version();
    const c = this.f.city_branch;
    return c ? this.vacantes().filter((v) => hrVacanteEnCiudad(v.branch_codes, c)) : [];
  });
  readonly puestoElegido = computed(() => { this.version(); return this.vacantes().find((v) => v.id === this.f.job_posting_id) ?? null; });
  readonly pideLicencia = computed(() => hrPideLicencia(this.puestoElegido()?.name));

  ngOnInit(): void { this.cargar(); }

  cargar(): void {
    this.cargando.set(true);
    this.errorVacantes.set(null);
    this.http.get<HrVacantePublicaDto[]>(`${this.base}/jobs`).subscribe({
      next: (v) => { this.vacantes.set(v); this.cargando.set(false); this.version.update((n) => n + 1); },
      error: (e) => { this.errorVacantes.set(errorDe(e)); this.cargando.set(false); },
    });
  }

  /** «Postularme» en una vacante: la deja elegida (con su ciudad si es una sola) y baja al formulario. */
  elegir(v: HrVacantePublicaDto): void {
    const ciudades = [...new Set(HR_SUCURSALES_EMPLEO.filter((s) => v.branch_codes?.includes(s.id)).map((s) => s.ciudad))];
    if (ciudades.length === 1) this.f.city_branch = ciudades[0];
    if (this.f.city_branch && hrVacanteEnCiudad(v.branch_codes, this.f.city_branch)) this.f.job_posting_id = v.id;
    this.version.update((n) => n + 1);
    document.getElementById('solicitud')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }

  /** Si el puesto elegido ya no aplica en la ciudad nueva, se limpia (regla de Mega Talento). */
  alCambiarCiudad(): void {
    this.version.update((n) => n + 1);
    if (this.f.job_posting_id && !this.vacantesDeCiudad().some((v) => v.id === this.f.job_posting_id)) this.f.job_posting_id = '';
    this.version.update((n) => n + 1);
  }

  archivo(ev: Event, cual: 'cv' | 'licencia'): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    if (file && file.size > MAX_DOCUMENTO_BYTES) {
      this.error.set('El archivo pasa de 10 MB. Toma la foto con menos calidad o manda un PDF.');
      input.value = '';
      return;
    }
    this.error.set(null);
    (cual === 'cv' ? this.cv : this.licencia).set(file);
  }

  /** Lo que falta, en el orden del formulario (el servidor valida lo mismo; esto sólo ayuda a quien llena). */
  faltante(): string | null {
    const f = this.f;
    if (!f.city_branch) return 'Elige la ciudad.';
    if (!f.job_posting_id) return 'Elige el puesto.';
    if (f.full_name.trim().split(/\s+/).length < 2) return 'Escribe tu nombre completo.';
    if (f.phone.replace(/\D/g, '').length < 10) return 'Escribe tu teléfono a 10 dígitos.';
    if (!f.heard_from) return 'Dinos dónde te enteraste de la vacante.';
    if (!this.cv()) return 'Adjunta tu CV.';
    if (this.pideLicencia() && !this.licencia()) return 'Adjunta tu licencia de manejo.';
    if (!f.privacy_accepted) return 'Acepta el aviso de privacidad.';
    return null;
  }

  async enviar(): Promise<void> {
    this.version.update((n) => n + 1);
    const falta = this.faltante();
    if (falta) { this.error.set(falta); return; }
    this.enviando.set(true);
    this.error.set(null);
    try {
      const cv = this.cv()!;
      const lic = this.pideLicencia() ? this.licencia() : null;
      const cuerpo: HrPostulacionPublica = {
        full_name: this.f.full_name, phone: this.f.phone, email: this.f.email || null, city_branch: this.f.city_branch,
        job_posting_id: this.f.job_posting_id, heard_from: this.f.heard_from, relative_in_company: this.f.relative_in_company || null,
        rehire_note: this.f.rehire_note || null, cv_base64: await leerComoDataUri(cv), cv_file_name: cv.name,
        license_base64: lic ? await leerComoDataUri(lic) : null, license_file_name: lic?.name ?? null,
        privacy_accepted: this.f.privacy_accepted, website: this.f.website || null,
      };
      this.http.post<HrPostulacionResultadoDto>(`${this.base}/applications`, cuerpo).subscribe({
        next: (r) => { this.enviando.set(false); this.resultado.set(r); window.scrollTo?.({ top: 0 }); },
        error: (e) => { this.enviando.set(false); this.error.set(errorDe(e)); },
      });
    } catch {
      this.enviando.set(false);
      this.error.set('No pudimos leer tu archivo. Vuelve a elegirlo.');
    }
  }

  /** Después de una postulación recibida: formulario limpio. */
  otra(): void {
    this.f = vacio();
    this.cv.set(null);
    this.licencia.set(null);
    this.resultado.set(null);
    this.version.update((n) => n + 1);
  }
}
