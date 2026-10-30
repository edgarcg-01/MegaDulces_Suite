import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { DrawerModule } from 'primeng/drawer';
import { TooltipModule } from 'primeng/tooltip';
// ⛔ `[RES.7 2026-10-12]` El diccionario NO se importa con valor acá, a propósito. Son **134 KB**
//    de texto y este componente lo usan **49 páginas**: cuando tantos chunks lazy comparten un
//    módulo, el bundler lo sube al chunk COMÚN, que `main` carga al arrancar. Es el mismo patrón
//    que midió `[EMB.24]` — *«por el barrel caía en el chunk compartido que main carga al
//    arrancar»*. Con el import estático `main` llegó a 1.65 MB y **el CI rompió por 232 bytes**.
//    ⚠️ El `import type` NO cuenta: los tipos se borran al compilar, no viajan al bundle.
import type { HelpTopic } from './context-help.dictionary';

/**
 * `[RES.7]` El diccionario, cargado UNA vez para toda la app y compartido por las 49 páginas.
 *
 * ⭐ Vive a nivel de módulo y no por instancia porque en una pantalla puede haber varios
 *    `<app-context-help>`: con estado por instancia, cada uno dispararía su propia carga. La
 *    `promesa` memoriza el vuelo en curso, así N componentes montados a la vez piden UNA sola vez.
 *
 * ⚠️ Mientras no llega, `t()` devuelve null y **el botón `?` todavía no se pinta** — el template
 *    lo condiciona a `@if (t(); as topic)`. Es ayuda contextual, no funcionalidad: aparecer unos
 *    milisegundos más tarde no le quita nada a nadie, y a cambio saca 134 KB del arranque de TODOS.
 *
 * ⚠️ Si la carga falla, el error se traga a propósito: que no haya botón de ayuda no puede tumbar
 *    la pantalla que lo contiene. Queda en null, que es el mismo estado que «este apartado no tiene
 *    ayuda» — y eso el template ya lo maneja.
 */
const DICCIONARIO = signal<Record<string, HelpTopic> | null>(null);
let promesa: Promise<void> | null = null;

/**
 * DESIGN §P — Ayuda contextual ("about" por módulo). Botón `?` en el header del
 * apartado que abre un cajón lateral (p-drawer) documentando la jerga/reglas de ESE
 * módulo, sin sacar al usuario de la pantalla. El contenido se consume del diccionario
 * de negocio versionado (context-help.dictionary.ts), nunca se redacta en el template.
 *
 * Uso: <app-context-help topic="cfdi" />
 * a11y: p-drawer trae focus-trap + Escape + máscara; el botón lleva aria-label.
 */
@Component({
  selector: 'app-context-help',
  standalone: true,
  imports: [ButtonModule, DrawerModule, TooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (t(); as topic) {
      @if (label(); as l) {
        <button pButton type="button" class="p-button-text p-button-sm ch-btn" [attr.aria-label]="'Ayuda: ' + topic.title" (click)="open.set(true)"><span class="p-button-icon p-button-icon-left pi pi-question-circle" aria-hidden="true"></span><span class="p-button-label">{{ l }}</span></button>
      } @else {
        <button pButton type="button" class="p-button-text p-button-rounded p-button-sm ch-btn" [attr.aria-label]="'Ayuda: ' + topic.title" pTooltip="¿Qué significan estos campos?" tooltipPosition="bottom" (click)="open.set(true)"><span class="p-button-icon p-button-icon-left pi pi-question-circle" aria-hidden="true"></span></button>
      }

      <p-drawer [visible]="open()" (visibleChange)="open.set($event)" position="right"
                [style]="{ width: '26rem' }" [header]="topic.title" styleClass="ch-drawer" [dismissible]="true">
        @if (topic.intro) { <p class="ch-intro">{{ topic.intro }}</p> }
        @for (g of topic.groups ?? []; track g.heading) {
          <section class="ch-group">
            <h3 class="ch-h">{{ g.heading }}</h3>
            <dl class="ch-dl">
              @for (e of g.entries; track e.term) {
                <div class="ch-row"><dt>{{ e.term }}</dt><dd>{{ e.def }}</dd></div>
              }
            </dl>
          </section>
        }
        @if (topic.resolve?.length) {
          <section class="ch-group">
            <h3 class="ch-h">Cómo se resuelve</h3>
            @for (b of topic.resolve; track b.heading) {
              <div class="ch-rb" [class.info]="b.kind === 'info'">
                <div class="ch-rb-head">
                  <span class="ch-rb-badge">{{ b.kind === 'info' ? 'No requiere acción' : 'Se corrige' }}</span>
                  <span class="ch-rb-title">{{ b.heading }}</span>
                </div>
                @if (b.intro) { <p class="ch-rb-intro">{{ b.intro }}</p> }
                <ol class="ch-rb-steps">
                  @for (s of b.steps; track $index) { <li>{{ s }}</li> }
                </ol>
              </div>
            }
          </section>
        }
      </p-drawer>
    }
  `,
  styles: [`
    :host { display: inline-flex; }
    .ch-btn { color: var(--text-muted); }
    /* Medía 22x30: la mitad del minimo tactil (DESIGN §11, Ley de Fitts). Es un
       icon-button sin texto, asi que el area de toque es todo lo que tiene. */
    @media (pointer: coarse) {
      .ch-btn { min-width: var(--tap-min, 44px); min-height: var(--tap-min, 44px); }
    }
    .ch-intro { font-size: .82rem; color: var(--text-muted); margin: 0 0 1rem; line-height: 1.4; }
    .ch-group { margin-bottom: 1.1rem; }
    .ch-h { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: var(--text-faint); font-weight: 700; margin: 0 0 .5rem; }
    .ch-dl { margin: 0; display: flex; flex-direction: column; gap: .55rem; }
    .ch-row { display: grid; grid-template-columns: minmax(5.5rem, 8rem) 1fr; gap: .6rem; align-items: baseline; }
    .ch-row dt { font-family: var(--font-mono, ui-monospace, monospace); font-size: .78rem; font-weight: 700; color: var(--text-main); }
    .ch-row dd { margin: 0; font-size: .8rem; color: var(--text-muted); line-height: 1.4; }
    @media (max-width: 32.5rem) { .ch-row { grid-template-columns: 1fr; gap: .15rem; } }
    /* Bloques "cómo se resuelve" */
    .ch-rb { border-left: 2px solid var(--action, #d9772e); padding: 0 0 0 .7rem; margin: 0 0 .9rem; }
    .ch-rb.info { border-left-color: var(--border-color, #e5e1da); }
    .ch-rb-head { display: flex; align-items: center; gap: .45rem; margin-bottom: .3rem; flex-wrap: wrap; }
    .ch-rb-badge { font-size: .6rem; text-transform: uppercase; letter-spacing: .04em; font-weight: 700;
      padding: .1rem .4rem; border-radius: var(--r-xs, 4px); background: color-mix(in srgb, var(--action, #d9772e) 15%, transparent); color: var(--action, #d9772e); white-space: nowrap; }
    .ch-rb.info .ch-rb-badge { background: color-mix(in srgb, var(--text-muted, #78716c) 12%, transparent); color: var(--text-muted); }
    .ch-rb-title { font-size: .82rem; font-weight: 700; color: var(--text-main); }
    .ch-rb-intro { font-size: .78rem; color: var(--text-muted); margin: 0 0 .4rem; line-height: 1.4; }
    .ch-rb-steps { margin: 0; padding-left: 1.1rem; display: flex; flex-direction: column; gap: .3rem; }
    .ch-rb-steps li { font-size: .8rem; color: var(--text-muted); line-height: 1.4; }
  `],
})
export class ContextHelpComponent {
  /** Clave del apartado en el diccionario (context-help.dictionary.ts). */
  readonly topic = input.required<string>();
  /**
   * `[PR.V11]` Texto opcional junto al `?`. Sólo hace falta cuando una pantalla lleva DOS
   * ayudas: el motor de margen tenía dos botones idénticos, y no había manera de saber cuál
   * explicaba qué sin abrirlos. Sin `label` se pinta exactamente como antes.
   */
  readonly label = input<string | null>(null);
  readonly open = signal(false);
  readonly t = computed(() => DICCIONARIO()?.[this.topic()] ?? null);

  constructor() {
    if (DICCIONARIO()) return;
    promesa ??= import('./context-help.dictionary')
      .then((m) => { DICCIONARIO.set(m.CONTEXT_HELP); })
      .catch(() => { /* sin ayuda, pero la pantalla sigue viva */ });
  }
}
