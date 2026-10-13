import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { PageTabsComponent, type PageTab } from '../../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../../core/constants/permissions';

const VER = [Permission.HR_RECRUITMENT_VER, Permission.HR_RECRUITMENT_GESTIONAR];

/**
 * Fase RH · `[RH.2.3]` — el marco de Reclutamiento: encabezado y pestañas (Candidatos · Vacantes · Revisiones).
 * Las tres leen con VER o GESTIONAR, igual que sus endpoints: ningún permiso aterriza en una pestaña que rebota.
 */
@Component({
  selector: 'app-rh-reclutamiento-marco',
  standalone: true,
  imports: [PageTabsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="rm-head">
      <div>
        <h1>Reclutamiento</h1>
        <p>{{ subtitulo() }}</p>
      </div>
      <div class="rm-btns"><ng-content select="[acciones]" /></div>
    </header>
    <app-page-tabs [tabs]="tabs" variant="underline" ariaLabel="Reclutamiento" />
  `,
  styles: [`
    :host { display: block; }
    .rm-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-3); flex-wrap: wrap; }
    .rm-head h1 { margin: 0; font: 700 var(--fs-h2)/1.2 var(--font-body); color: var(--text-main); letter-spacing: -0.01em; }
    .rm-head p { margin: var(--sp-1) 0 0; color: var(--text-muted); font-size: var(--fs-sm); max-width: 90ch; }
    .rm-btns { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
  `],
})
export class RhReclutamientoMarcoComponent {
  readonly subtitulo = input('Quién se postuló, en qué etapa va y qué le falta. Nada se borra: lo que sale va a la papelera y se puede restaurar.');

  readonly tabs: PageTab[] = [
    { label: 'Candidatos', route: '/rh/reclutamiento', anyOf: VER },
    { label: 'Vacantes', route: '/rh/reclutamiento/vacantes', anyOf: VER },
    { label: 'Revisiones', route: '/rh/reclutamiento/revisiones', anyOf: VER },
  ];
}
