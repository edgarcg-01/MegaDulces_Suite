import { ChangeDetectionStrategy, Component, computed, inject, input, model, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import type { AccionAltaRapida, AltaRapidaResultado, RolAltaRapida } from '@megadulces/contracts';
// Por subruta, no por el barrel: lo que se importa con valor del barrel cae en el chunk de arranque.
import { erroresDeAltaRapida } from '@megadulces/contracts/http/alta-persona';
import { LogisticaService } from '../logistica.service';

const MENSAJE: Record<AccionAltaRapida, string> = {
  creada: 'Se dio de alta.',
  ya_existia: 'Ya estaba en el padrón: se usa la misma persona.',
  papel_agregado: 'Ya estaba en el padrón con otro papel: se le agregó éste.',
  reactivada: 'Estaba dada de baja: se reactivó.',
};

/**
 * `[EMB.32]` Alta rápida de un ayudante o cargador desde donde se necesita (la guía, el cierre),
 * sin ir a Logística › Personal. Sólo nombre completo; el servidor no duplica: si el nombre ya
 * existe usa a esa persona y, si estaba de baja, la reactiva. Al guardar emite la persona para que
 * quien lo abrió la seleccione.
 */
@Component({
  selector: 'app-alta-persona',
  standalone: true,
  imports: [FormsModule, ButtonModule, DialogModule, InputTextModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-dialog [header]="titulo()" [visible]="visible()" (visibleChange)="visible.set($event)" [modal]="true"
      [style]="{ width: '26rem', maxWidth: '95vw' }" appendTo="body" (onShow)="alAbrir()">
      <div class="ap-form">
        <label for="ap-nombre">Nombre completo</label>
        <input pInputText id="ap-nombre" [ngModel]="nombre()" (ngModelChange)="nombre.set($event)"
          (keydown.enter)="guardar()" autocomplete="off" placeholder="Nombre y apellidos">
        <span class="ap-sub">Queda en el padrón de logística como {{ rol() }} y para la próxima ya aparece en la lista.</span>
        @if (errorVisible()) { <span class="ap-err" role="alert">{{ errorVisible() }}</span> }
      </div>
      <ng-template #footer>
        <button pButton type="button" severity="secondary" [text]="true" (click)="visible.set(false)"><span class="p-button-label">Cancelar</span></button>
        <button pButton type="button" [loading]="guardando()" [disabled]="errores().length > 0" (click)="guardar()"><span class="p-button-icon p-button-icon-left pi pi-user-plus" aria-hidden="true"></span><span class="p-button-label">Agregar</span></button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    .ap-form { display: flex; flex-direction: column; gap: .4rem; }
    .ap-form label { font-size: var(--fs-sm); color: var(--c-text-2); }
    .ap-sub { font-size: var(--fs-xs); color: var(--c-text-2); }
    .ap-err { font-size: var(--fs-sm); color: var(--bad-fg); }
  `],
})
export class AltaPersonaComponent {
  private readonly api = inject(LogisticaService);

  readonly visible = model(false);
  readonly rol = input<RolAltaRapida>('ayudante');
  /** Lo que la persona ya había escrito en el buscador de la lista, para no teclearlo dos veces. */
  readonly nombreInicial = input('');
  readonly creada = output<AltaRapidaResultado & { mensaje: string }>();

  readonly nombre = signal('');
  readonly guardando = signal(false);
  readonly errorServidor = signal<string | null>(null);
  readonly tocado = signal(false);

  readonly titulo = computed(() => (this.rol() === 'cargador' ? 'Nuevo cargador' : 'Nuevo ayudante'));
  readonly errores = computed(() => erroresDeAltaRapida({ full_name: this.nombre(), rol: this.rol() }));
  readonly errorVisible = computed(() => this.errorServidor() ?? (this.tocado() && this.errores()[0]) ?? null);

  alAbrir(): void {
    this.nombre.set(this.nombreInicial() ?? '');
    this.errorServidor.set(null);
    this.tocado.set(false);
  }

  guardar(): void {
    this.tocado.set(true);
    if (this.errores().length || this.guardando()) return;
    this.guardando.set(true);
    this.errorServidor.set(null);
    this.api.altaRapidaPersona({ full_name: this.nombre(), rol: this.rol() }).subscribe({
      next: (r) => {
        this.guardando.set(false);
        this.visible.set(false);
        this.creada.emit({ ...r, mensaje: `${r.driver.full_name}: ${MENSAJE[r.accion]}` });
      },
      error: (e) => {
        this.guardando.set(false);
        this.errorServidor.set(e?.error?.message ?? 'No se pudo dar de alta.');
      },
    });
  }
}
