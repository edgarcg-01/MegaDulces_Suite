import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { DrawerModule } from 'primeng/drawer';
import { TooltipModule } from 'primeng/tooltip';
import { CONTEXT_HELP } from './context-help.dictionary';

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
      <button pButton type="button" icon="pi pi-question-circle"
              class="p-button-text p-button-rounded p-button-sm ch-btn"
              [attr.aria-label]="'Ayuda: ' + topic.title"
              pTooltip="¿Qué significan estos campos?" tooltipPosition="bottom"
              (click)="open.set(true)"></button>

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
    .ch-intro { font-size: .82rem; color: var(--text-muted); margin: 0 0 1rem; line-height: 1.4; }
    .ch-group { margin-bottom: 1.1rem; }
    .ch-h { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: var(--text-faint); font-weight: 700; margin: 0 0 .5rem; }
    .ch-dl { margin: 0; display: flex; flex-direction: column; gap: .55rem; }
    .ch-row { display: grid; grid-template-columns: minmax(5.5rem, 8rem) 1fr; gap: .6rem; align-items: baseline; }
    .ch-row dt { font-family: var(--font-mono, ui-monospace, monospace); font-size: .78rem; font-weight: 700; color: var(--text-main); }
    .ch-row dd { margin: 0; font-size: .8rem; color: var(--text-muted); line-height: 1.4; }
    @media (max-width: 520px) { .ch-row { grid-template-columns: 1fr; gap: .15rem; } }
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
  readonly open = signal(false);
  readonly t = computed(() => CONTEXT_HELP[this.topic()] ?? null);
}
