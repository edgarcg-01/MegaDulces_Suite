import {
  ChangeDetectionStrategy, Component, DestroyRef, OnDestroy,
  computed, inject, input, output, signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ComercialService, ResolveHit, VoiceSlots, VoiceTurn } from '../comercial.service';
import { VoiceDictationService } from '../voice-dictation.service';
import { elegirVozLatina } from '../voz-latina';

/**
 * **El asistente de caducidades: se le habla y llena el renglón.**
 *
 * *"Quiero dar de alta un producto que caducó"* → el asistente pregunta lo que
 * falte (producto, cantidad, fecha) hasta tener lo esencial, y va prellenando el
 * formulario de al lado. El renglón **lo agrega la persona**, no el asistente:
 * acá se llena, se ve y se confirma (co-piloto, ADR-020).
 *
 * Cadena: `MediaRecorder` → `thot/transcribe` (Groq Whisper, español) →
 * `POST /commercial/expiry-reviews/voice/intake` (Claude Haiku extrae campos, el
 * catálogo resuelve el producto) → `slotsChange` al padre.
 *
 * Los tres chips de arriba son el corazón de la UX: el operador **ve** llenarse
 * producto/cantidad/caducidad, así que sabe qué le falta decir sin escuchar toda
 * la respuesta. Hablar sin retroalimentación visible es donde estos asistentes
 * se sienten adivinanza.
 */
@Component({
  selector: 'app-expiry-voice-panel',
  standalone: true,
  imports: [CommonModule],
  providers: [VoiceDictationService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="evp" [class.open]="open()">
      <header class="evp-head">
        <button type="button" class="evp-toggle" (click)="toggleOpen()" [attr.aria-expanded]="open()">
          <i class="pi pi-microphone" aria-hidden="true"></i>
          <span class="evp-title">Asistente por voz</span>
          <span class="evp-sub">Decile qué producto caducó y él llena el renglón</span>
          <i class="pi" [class.pi-chevron-down]="!open()" [class.pi-chevron-up]="open()" aria-hidden="true"></i>
        </button>
      </header>

      @if (open()) {
        <div class="evp-body">
          <!-- Lo que ya entendió: el operador ve qué falta sin tener que escuchar. -->
          <div class="evp-slots" role="status" aria-live="polite">
            <span class="evp-slot" [class.on]="!!slots().product_id">
              <i class="pi" [class.pi-check]="!!slots().product_id" [class.pi-circle]="!slots().product_id" aria-hidden="true"></i>
              {{ slots().product_name || slots().product_query || 'Producto' }}
            </span>
            <span class="evp-slot" [class.on]="!!slots().quantity">
              <i class="pi" [class.pi-check]="!!slots().quantity" [class.pi-circle]="!slots().quantity" aria-hidden="true"></i>
              {{ qtyLabel() }}
            </span>
            <span class="evp-slot" [class.on]="!!slots().expiry_date">
              <i class="pi" [class.pi-check]="!!slots().expiry_date" [class.pi-circle]="!slots().expiry_date" aria-hidden="true"></i>
              {{ slots().expiry_date ? fmtDate(slots().expiry_date!) : 'Caducidad' }}
            </span>
          </div>

          <!-- Conversación -->
          @if (turns().length) {
            <div class="evp-chat">
              @for (t of turns(); track $index) {
                <p class="evp-turn" [class.me]="t.role === 'user'">{{ t.content }}</p>
              }
            </div>
          } @else {
            <p class="evp-hint">Tocá el micrófono y decí, por ejemplo: <em>«tengo 3 cajas de mazapán que caducan en octubre»</em>.</p>
          }

          <!-- Desempate: el catálogo encontró varios -->
          @if (candidates().length) {
            <div class="evp-cands">
              @for (c of candidates(); track c.id) {
                <button type="button" class="evp-cand" (click)="pick(c)">
                  <strong>{{ c.nombre }}</strong>
                  @if (c.sku) { <code>{{ c.sku }}</code> }
                  @if (presentationOf(c)) { <span>{{ presentationOf(c) }}</span> }
                </button>
              }
            </div>
          }

          @if (dict.error(); as e) {
            <p class="evp-err" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ e }}</p>
          }
          @if (apiError(); as e) {
            <p class="evp-err" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ e }}</p>
          }

          <div class="evp-actions">
            <button type="button" class="evp-mic" [class.rec]="dict.recording()" [disabled]="dict.transcribing() || thinking()"
              (click)="dict.toggle()"
              [attr.aria-label]="dict.recording() ? 'Detener y enviar' : 'Hablar'">
              <i class="pi" [class.pi-microphone]="!dict.recording() && !dict.transcribing() && !thinking()"
                 [class.pi-stop-circle]="dict.recording()"
                 [class.pi-spinner]="dict.transcribing() || thinking()"
                 [class.pi-spin]="dict.transcribing() || thinking()" aria-hidden="true"></i>
              <span>{{ micLabel() }}</span>
            </button>

            <button type="button" class="evp-mini" (click)="speaks.set(!speaks())"
              [attr.aria-pressed]="speaks()" [title]="speaks() ? 'Silenciar la voz del asistente' : 'Que el asistente hable'">
              <i class="pi" [class.pi-volume-up]="speaks()" [class.pi-volume-off]="!speaks()" aria-hidden="true"></i>
            </button>

            @if (turns().length) {
              <button type="button" class="evp-mini evp-reset" (click)="reset()" title="Empezar de nuevo">
                <i class="pi pi-refresh" aria-hidden="true"></i>
              </button>
            }
          </div>

          <!-- Sin esto el modo de falla es MUDO: si el equipo no tiene voz en
               español, el navegador lee el texto español con una voz en inglés y
               nadie entiende por qué suena así. No se arregla desde el código —
               hay que instalar la voz en Windows — así que se dice. -->
          @if (speaks() && vozUsada() && !vozEsEspanol()) {
            <p class="evp-voz-warn" role="status">
              <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
              Este equipo no tiene voz en español: está leyendo con
              <strong>{{ vozUsada() }}</strong>. Instalá la voz de
              <strong>Español (México)</strong> en Windows y suena como debe.
            </p>
          } @else if (speaks() && vozUsada()) {
            <p class="evp-voz-ok">
              <i class="pi pi-volume-up" aria-hidden="true"></i> Voz: {{ vozUsada() }}
            </p>
          }

          @if (!dict.supported) {
            <p class="evp-hint evp-hint-warn">
              Este equipo no da acceso al micrófono (requiere HTTPS). Podés seguir capturando por escaneo o a mano.
            </p>
          }
        </div>
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .evp { border: 1px solid var(--border-color); border-radius: var(--r-md, 8px);
      background: var(--surface-ground); overflow: hidden; }
    .evp.open { background: var(--card-bg); }
    .evp-toggle { display: flex; align-items: center; gap: .6rem; width: 100%; padding: .7rem .8rem;
      background: transparent; border: 0; cursor: pointer; font: inherit; color: var(--text-main); text-align: left; }
    .evp-toggle:focus-visible { outline: 2px solid var(--action); outline-offset: -2px; }
    .evp-toggle > .pi-microphone { color: var(--action); }
    .evp-title { font-weight: 700; font-size: .85rem; }
    .evp-sub { flex: 1; min-width: 0; color: var(--text-muted); font-size: .75rem;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .evp-body { padding: 0 .8rem .8rem; display: flex; flex-direction: column; gap: .6rem; }
    .evp-slots { display: flex; flex-wrap: wrap; gap: .4rem; }
    .evp-slot { display: inline-flex; align-items: center; gap: .3rem; padding: .25rem .55rem;
      border: 1px dashed var(--border-color); border-radius: 999px;
      font-size: .74rem; color: var(--text-muted); max-width: 100%; }
    .evp-slot.on { border-style: solid; border-color: var(--ok-border, #bbf7d0);
      background: var(--ok-soft-bg, #dcfce7); color: var(--ok-soft-fg, #166534); font-weight: 600; }
    .evp-slot .pi { font-size: .7rem; }
    .evp-chat { display: flex; flex-direction: column; gap: .3rem; max-height: 11rem; overflow-y: auto; }
    .evp-turn { margin: 0; padding: .4rem .6rem; border-radius: var(--r-md, 8px); font-size: .8rem;
      background: var(--surface-ground); color: var(--text-main); max-width: 92%; }
    .evp-turn.me { align-self: flex-end; background: var(--action); color: var(--action-fg, #fff); }
    .evp-hint { margin: 0; font-size: .76rem; color: var(--text-muted); }
    .evp-hint em { color: var(--text-main); font-style: normal; }
    .evp-hint-warn { color: var(--warn-soft-fg, #92400e); }
    .evp-err { display: flex; align-items: center; gap: .35rem; margin: 0; font-size: .76rem;
      color: var(--bad-fg, #b91c1c); }
    .evp-cands { display: flex; flex-direction: column; gap: .3rem; }
    .evp-cand { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; text-align: left;
      padding: .45rem .6rem; min-height: 44px; cursor: pointer; font: inherit; font-size: .8rem;
      border: 1px solid var(--border-color); border-radius: var(--r-md, 8px);
      background: var(--card-bg); color: var(--text-main); }
    .evp-cand:hover { border-color: var(--action); }
    .evp-cand code, .evp-cand span { font-size: .72rem; color: var(--text-muted); }
    .evp-cand code { font-family: var(--font-mono, monospace); }
    .evp-actions { display: flex; align-items: center; gap: .4rem; }
    .evp-mic { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: .5rem;
      min-height: 48px; padding: 0 1rem; cursor: pointer; font: inherit; font-weight: 700; font-size: .85rem;
      border-radius: var(--r-md, 8px); border: 1px solid var(--action);
      background: var(--action); color: var(--action-fg, #fff); }
    .evp-mic:disabled { opacity: .6; cursor: default; }
    .evp-mic.rec { background: var(--bad-fg, #b91c1c); border-color: var(--bad-fg, #b91c1c);
      animation: evp-pulse 1.4s ease-in-out infinite; }
    .evp-mini { min-width: 48px; min-height: 48px; cursor: pointer; font: inherit;
      border: 1px solid var(--border-color); border-radius: var(--r-md, 8px);
      background: var(--card-bg); color: var(--text-muted); }
    .evp-mini:hover { border-color: var(--action); color: var(--action); }
    .evp-voz-ok, .evp-voz-warn { margin: .35rem 0 0; display: flex; align-items: flex-start; gap: .4rem;
      font-size: var(--fs-xs, .72rem); line-height: 1.35; }
    .evp-voz-ok { color: var(--c-text-3, var(--text-muted)); }
    .evp-voz-warn { color: var(--tone-warn, var(--text-muted)); max-width: 60ch; }
    @keyframes evp-pulse { 0%, 100% { box-shadow: 0 0 0 0 var(--action-ring); } 50% { box-shadow: 0 0 0 6px var(--action-ring); } }
    @media (prefers-reduced-motion: reduce) { .evp-mic.rec { animation: none; } }
  `],
})
export class ExpiryVoicePanelComponent implements OnDestroy {
  /** Ubicación por defecto de la hoja: si el operador no dice dónde, va ésta. */
  readonly defaultLocation = input<string>('');

  /** Campos entendidos hasta ahora — el padre prellena el formulario con esto. */
  readonly slotsChange = output<VoiceSlots>();

  protected readonly dict = inject(VoiceDictationService);
  private readonly svc = inject(ComercialService);
  private readonly destroyRef = inject(DestroyRef);

  readonly open = signal(false);
  readonly slots = signal<VoiceSlots>({});
  readonly candidates = signal<ResolveHit[]>([]);
  readonly turns = signal<VoiceTurn[]>([]);
  readonly thinking = signal(false);
  readonly apiError = signal<string | null>(null);
  /** El asistente contesta en voz alta (se puede silenciar; queda por sesión). */
  readonly speaks = signal(true);

  /**
   * Qué voz quedó elegida, para mostrarla. Existe porque el modo de falla de
   * `speechSynthesis` es MUDO y engañoso: si el equipo no tiene ninguna voz en
   * español, pedir `lang='es-MX'` no falla — Windows lee el texto español con
   * una voz en INGLÉS (y la default suele ser masculina). Se oye mal y nadie
   * sabe por qué. Mejor decirlo.
   */
  readonly vozUsada = signal<string | null>(null);
  readonly vozEsEspanol = signal(true);
  private vozElegida: SpeechSynthesisVoice | null = null;

  readonly micLabel = computed(() => {
    if (this.dict.recording()) return `Escuchando… ${this.dict.seconds()}s`;
    if (this.dict.transcribing()) return 'Transcribiendo…';
    if (this.thinking()) return 'Pensando…';
    return this.turns().length ? 'Seguir hablando' : 'Hablar';
  });

  constructor() {
    this.dict.transcript$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((text) => this.send(text));
  }

  toggleOpen(): void {
    this.open.update((v) => !v);
    if (!this.open()) this.dict.cancel();
    // Al ABRIR se resuelve la voz, no al hablar. Si se dejaba para el primer
    // `say()`, el aviso de "este equipo no tiene voz en español" aparecía
    // DESPUÉS de que ya se escuchó la voz equivocada — enterarse tarde de algo
    // que se podía avisar antes.
    else this.prepararVoz();
  }

  /** Resuelve la voz sin hablar, sólo para poder mostrar cuál va a usar. */
  private prepararVoz(): void {
    const synth = (window as any).speechSynthesis as SpeechSynthesis | undefined;
    if (synth) this.resolverVoz(synth);
  }

  /** Manda al asistente lo transcrito y aplica lo que entendió. */
  private send(text: string): void {
    this.turns.update((t) => [...t, { role: 'user', content: text }]);
    this.thinking.set(true);
    this.apiError.set(null);
    this.candidates.set([]);
    this.svc.voiceIntake({ transcript: text, slots: this.slots(), history: this.turns().slice(-8) })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.thinking.set(false); this.absorb(r.reply, r.slots, r.candidates); },
        error: (e) => {
          this.thinking.set(false);
          this.apiError.set(e?.error?.message || 'No se pudo consultar al asistente.');
        },
      });
  }

  /** El operador desempató tocando un candidato. */
  pick(c: ResolveHit): void {
    this.candidates.set([]);
    this.thinking.set(true);
    this.svc.voicePick(this.slots(), c.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.thinking.set(false); this.absorb(r.reply, r.slots, r.candidates); },
        error: () => { this.thinking.set(false); this.apiError.set('No se pudo fijar el producto.'); },
      });
  }

  reset(): void {
    this.dict.cancel();
    this.slots.set({});
    this.turns.set([]);
    this.candidates.set([]);
    this.apiError.set(null);
    this.slotsChange.emit({});
  }

  private absorb(reply: string, slots: VoiceSlots, candidates: ResolveHit[]): void {
    // La ubicación por defecto de la hoja se respeta si el operador no dijo otra.
    const merged: VoiceSlots = { ...slots };
    if (!merged.location && this.defaultLocation()) merged.location = this.defaultLocation();
    this.slots.set(merged);
    this.candidates.set(candidates || []);
    this.turns.update((t) => [...t, { role: 'assistant', content: reply }]);
    // Prellena el formulario en vivo: el operador VE lo que entendió y corrige
    // ahí mismo. Nunca se guarda el renglón desde acá.
    this.slotsChange.emit(merged);
    this.say(reply);
  }

  /**
   * Voz del navegador (`speechSynthesis`): gratis, sin red y sin mandar nada a
   * un tercero. En el anaquel importa poder oír la pregunta sin mirar la pantalla.
   */
  private say(text: string): void {
    if (!this.speaks() || !text) return;
    const synth = (window as any).speechSynthesis as SpeechSynthesis | undefined;
    if (!synth) return;
    try {
      synth.cancel(); // que no se encimen dos respuestas
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'es-MX';
      // Voz EXPLÍCITA. Con solo `lang` el navegador elige, y elige mal: agarra
      // la default del sistema (masculina en inglés en un Windows sin español).
      const v = this.resolverVoz(synth);
      if (v) u.voice = v;
      u.rate = 1.03;
      u.pitch = 1.05; // apenas arriba: se entiende mejor en un pasillo con ruido
      synth.speak(u);
    } catch { /* sin voz instalada: el texto ya está en pantalla */ }
  }

  /**
   * Elige la voz **femenina latina** disponible, o la menos mala.
   *
   * `getVoices()` depende del SISTEMA y del navegador, no de nosotros: no hay
   * una lista fija que se pueda hardcodear. Así que se puntúa lo que haya:
   *
   *   1. **Región**: `es-MX` primero; después el resto de Latinoamérica
   *      (`es-US`, `es-419`, `es-CO`…). `es-ES` PIERDE puntos — es español, pero
   *      el acento peninsular no es lo que se pidió.
   *   2. **Sexo de la voz**: el API no lo expone (no hay `v.gender`), así que se
   *      infiere del nombre. Las femeninas de es-MX son *Sabina* (Windows) y
   *      *Dalia* (Azure/Edge); las masculinas *Raúl* y *Jorge* restan.
   *   3. **Proveedor**: las de Google/Microsoft en la nube suenan bastante mejor
   *      que las locales viejas, así que suman un poco.
   *
   * Si no hay NINGUNA voz española, devuelve null y marca `vozEsEspanol=false`
   * para que la pantalla lo diga: no hay forma de arreglar eso desde el código.
   */
  private resolverVoz(synth: SpeechSynthesis): SpeechSynthesisVoice | null {
    if (this.vozElegida) return this.vozElegida;

    const todas = synth.getVoices();
    // Las voces cargan ASÍNCRONAS: la primera llamada suele devolver []. Se
    // reintenta cuando el navegador avisa, en vez de resignarse a la default.
    if (!todas.length) {
      synth.addEventListener?.('voiceschanged', () => this.resolverVoz(synth), { once: true });
      return null;
    }

    // La decisión (qué acento, qué voz es de mujer) vive en `voz-latina.ts`,
    // pura y con tests. Acá sólo queda lo que es del navegador.
    const r = elegirVozLatina(todas);
    this.vozEsEspanol.set(r.esEspanol);
    this.vozUsada.set(r.etiqueta);
    this.vozElegida = (r.voz as SpeechSynthesisVoice) || null;
    return this.vozElegida;
  }

  /** "3 cajas" o el placeholder. Fuera del template: concatenar un `number|null`
   *  ahí lo rechaza el chequeo estricto de plantillas. */
  qtyLabel(): string {
    const q = this.slots().quantity;
    return q != null ? `${q} ${this.unitLabel(this.slots().unit)}` : 'Cantidad';
  }

  unitLabel(u: string | null | undefined): string {
    switch (u) {
      case 'caja': return 'cajas';
      case 'bulto': return 'bultos';
      case 'kg': return 'kg';
      case 'pieza': return 'pz';
      default: return 'pz';
    }
  }

  presentationOf(c: ResolveHit): string {
    if (!c.unit_sale && !c.factor_sale) return '';
    return c.factor_sale && c.factor_sale > 1 ? `${c.unit_sale || 'unidad'} x ${c.factor_sale}` : String(c.unit_sale || '');
  }

  fmtDate(ymd: string): string {
    const s = String(ymd).slice(0, 10).split('-');
    return s.length === 3 ? `${s[2]}/${s[1]}/${s[0]}` : String(ymd);
  }

  ngOnDestroy(): void {
    this.dict.cancel();
    try { (window as any).speechSynthesis?.cancel(); } catch { /* no hay voz */ }
  }
}
