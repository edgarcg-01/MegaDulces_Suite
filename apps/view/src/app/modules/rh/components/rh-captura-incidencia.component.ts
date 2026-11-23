import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, model, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import type { HrIncidenciaDto, HrTipoIncidenciaDto } from '@megadulces/contracts';
import { RhService, rhError } from '../rh.service';
import { firmaHoras, horasTexto } from '../reporte-formato';
import { type FormCaptura, conAutorizacion, cuerpoCaptura, deUnDia, etiquetaConAlias, etiquetaNota, notaObligatoria } from '../incidencia-captura';

interface GrupoTipos { label: string; items: HrTipoIncidenciaDto[]; }

/**
 * Fase RH · `[RH.18.1]` — Capturar una incidencia. La usan el panel de Incidencias (cualquier persona, cualquier día) y
 * la ficha de la persona, debajo del renglón del día (E1: sin salir de la ficha, como en Mega Talento).
 *
 * Las cinco preguntas (`diseno` §0b):
 *  1. Qué ve: el tipo (desde el día: los que tienen sentido arriba; `[RH.18.3]` ninguno elegido, lo eligen ellas, y cada uno
 *     con su nombre de Mega Talento), las fechas y sólo los campos que pide ESE tipo. Un botón principal: Guardar.
 *  2. Qué no ve: desde la ficha, el número de la persona (ya se sabe quién es: se dice su nombre).
 *  3. Accesibilidad: el tipo se busca tecleando (también «tráfico» o «personal»); Enter guarda; «Horario distinto» llega con
 *     lo que checó ese día para corregir, no para teclear.
 *  4. Ligada a: el mismo endpoint y la misma calificación que el panel de Incidencias (lo capturado cuenta cuando lo
 *     califica otra persona, salvo que quien captura también califique y no la entregue).
 *  5. Le toca: capturar. Calificar y cerrar la semana siguen en el panel.
 *
 * El estado del formulario lo guarda quien la usa (`[(form)]`): así el panel conserva su forma y sus pruebas.
 */
@Component({
  selector: 'app-rh-captura-incidencia',
  standalone: true,
  imports: [FormsModule, SelectModule, InputTextModule, ButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (form(); as f) {
      <form class="ci-form" (ngSubmit)="guardar()" [attr.aria-label]="titulo()">
        <h2>{{ titulo() }}</h2>
        @if (persona(); as nom) {
          <p class="ci-quien">{{ nom }} <span class="ci-cod">#{{ f.person_code }}</span></p>
        } @else {
          <label>Número de la persona <input pInputText name="persona" [(ngModel)]="f.person_code" required /></label>
        }
        <label>Tipo
          @if (grupos(); as g) {
            <p-select [options]="g" [group]="true" optionGroupLabel="label" optionGroupChildren="items" optionLabel="etiqueta" optionValue="tipo"
                      [filter]="true" filterBy="etiqueta" name="tipo" [(ngModel)]="f.incident_type" appendTo="body" placeholder="Elige el tipo" ariaLabel="Tipo de incidencia" />
          } @else {
            <p-select [options]="conAlias()" optionLabel="etiqueta" optionValue="tipo" [filter]="true" filterBy="etiqueta"
                      name="tipo" [(ngModel)]="f.incident_type" appendTo="body" placeholder="Elige el tipo" ariaLabel="Tipo de incidencia" />
          }
        </label>
        <label>Desde <input pInputText type="date" name="desde" [(ngModel)]="f.date_from" required /></label>
        @if (!deUnDia(f.incident_type)) {
          <label>Hasta <input pInputText type="date" name="hasta" [(ngModel)]="f.date_to" [min]="f.date_from" /></label>
        }
        @if (f.incident_type === 'horas_extra') {
          <label>Horas extra usadas <input pInputText type="time" name="horas" [(ngModel)]="f.horas" required /></label>
          <div class="ci-saldo">
            <p-button label="Ver su saldo" [text]="true" size="small" [disabled]="!f.person_code.trim()" (onClick)="verSaldo(f.person_code)" />
            @if (saldoUso(); as s) { <span role="status">{{ s }}</span> }
          </div>
        }
        @if (f.incident_type === 'horario_distinto') {
          <label>Entró a las <input pInputText type="time" name="entrada" [(ngModel)]="f.entrada" required /></label>
          <label>Salió a las (opcional) <input pInputText type="time" name="salida" [(ngModel)]="f.salida" /></label>
          <label>Comida ese día, en minutos (opcional)
            <input pInputText type="number" inputmode="numeric" name="comidaDia" min="0" max="240" [(ngModel)]="f.comidaDia" /></label>
          @if (deLoChecado()) {
            <p class="ci-ancho ci-ayuda ci-propuesto">Ya trae lo que checó ese día: corrígelo con el horario que se autorizó.</p>
          }
          <p class="ci-ancho ci-ayuda">Con la salida, ese día se mide de la entrada a la salida: retardo, salida temprana y horas extra. Sin la salida sólo cambia la entrada. Sin la comida se descuenta la de su horario. Su horario de siempre no cambia.</p>
        }
        @if (f.incident_type === 'desayuno_distinto' || f.incident_type === 'comida_distinta') {
          <label>Minutos de {{ f.incident_type === 'desayuno_distinto' ? 'desayuno' : 'comida' }} autorizados
            <input pInputText type="number" inputmode="numeric" name="minutos" min="0" max="240" [(ngModel)]="f.minutos" required /></label>
        }
        @if (f.incident_type === 'visita_fuera') {
          <label>Lo recogieron a las <input pInputText type="time" name="recogida" [(ngModel)]="f.recogida" required /></label>
          <label>Lo dejaron a las <input pInputText type="time" name="entrega" [(ngModel)]="f.entrega" required /></label>
          <label>Quién autorizó la visita <input pInputText name="autorizoVf" [(ngModel)]="f.authorized_by_name" required /></label>
          <p class="ci-ancho ci-ayuda">Justifica el día y el tiempo de la recogida a la entrega se suma a sus horas trabajadas. No toca su saldo de horas extra; en su día de descanso no suma.</p>
        }
        @if (f.incident_type === 'pago_horas_extra') {
          <label>Horas pagadas <input pInputText type="number" inputmode="decimal" name="horasPagadas" min="0.5" max="100" step="0.5" [(ngModel)]="f.horasPagadas" required /></label>
          <div class="ci-saldo">
            <p-button label="Ver su saldo" [text]="true" size="small" [disabled]="!f.person_code.trim()" (onClick)="verSaldo(f.person_code)" />
            @if (saldoUso(); as s) { <span role="status">{{ s }}</span> }
          </div>
          <p class="ci-ancho ci-ayuda">Se le pagaron en efectivo en vez de tomarlas: descuentan de su saldo de horas extra. Es el total, en un solo día, y no cambia su asistencia.</p>
        }
        @if (f.incident_type === 'cambio_descanso') {
          <p class="ci-ancho ci-ayuda">El día elegido es su descanso de esa semana, y su descanso de siempre pasa a ser día de trabajo: si no viene ese día, es falta.</p>
        }
        @if (f.incident_type === 'descanso') {
          <p class="ci-ancho ci-ayuda">Esos días cuentan como descanso (no como falta ni como vacaciones), y su descanso de siempre no se mueve. Sirve para quien descansa dos días esa semana, o para quitarle a unas vacaciones el día que de todos modos descansaba.</p>
        }
        @if (conAutorizacion(f.incident_type)) {
          <label class="ci-ancho">Por qué ese día fue distinto <input pInputText name="motivo" [(ngModel)]="f.reason" required /></label>
          <label>Quién lo autorizó <input pInputText name="autorizo" [(ngModel)]="f.authorized_by_name" required /></label>
        }
        <label class="ci-ancho">{{ etiquetaNota(f.incident_type) }} <input pInputText name="nota" [(ngModel)]="f.note" [required]="notaObligatoria(f.incident_type)" /></label>
        @if (puedeCalificar()) {
          <label class="ci-check"><input type="checkbox" name="entregar" [(ngModel)]="f.deliver" /> Entregarla para que la califique otra persona</label>
        }
        @if (error(); as e) { <p class="ci-ancho ci-error" role="alert">{{ e }}</p> }
        <div class="ci-btns">
          <!-- [RH.18.3] Sin tipo no se guarda: nada viene elegido, así que Guardar espera a que lo elijan. -->
          <p-button type="submit" label="Guardar" [loading]="ocupado()" [disabled]="!site() || !f.incident_type" />
          <p-button label="Cancelar" [text]="true" severity="secondary" [disabled]="ocupado()" (onClick)="cancelar()" />
        </div>
      </form>
    }
  `,
  styles: [`
    :host { display: block; }
    .ci-form { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: flex-end; padding: var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); }
    .ci-form h2 { flex: 1 1 100%; margin: 0; font-size: var(--fs-h3); color: var(--text-main); }
    .ci-form label { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); }
    .ci-form .ci-ancho { flex: 1 1 18rem; }
    .ci-form .ci-check { flex-direction: row; align-items: center; gap: var(--sp-2); }
    .ci-quien { margin: 0; align-self: center; font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); }
    .ci-cod { font-family: var(--font-mono); font-weight: 400; color: var(--text-muted); font-size: var(--fs-xs); }
    .ci-saldo { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; font-size: var(--fs-sm); color: var(--text-muted); }
    .ci-ayuda { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .ci-propuesto { color: var(--info-soft-fg); }
    .ci-error { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); font-size: var(--fs-sm); background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .ci-btns { display: flex; gap: var(--sp-2); }
  `],
})
export class RhCapturaIncidenciaComponent {
  private readonly api = inject(RhService);
  private readonly destroyRef = inject(DestroyRef);

  /** El formulario abierto (null = cerrado). Lo guarda quien usa la pieza. */
  readonly form = model<FormCaptura | null>(null);
  readonly site = input<string | null>(null);
  readonly tipos = input<HrTipoIncidenciaDto[]>([]);
  /** `[RH.18.1]` Los tipos que tienen sentido para el día, el más probable primero (vacío = la lista completa). */
  readonly sugeridos = input<string[]>([]);
  /** Desde la ficha: el nombre de la persona (su número ya va en el formulario y no se edita). */
  readonly persona = input<string | null>(null);
  readonly titulo = input('Capturar incidencia');
  readonly puedeCalificar = input(false);
  /** `[RH.18.1]` La entrada y la salida ya vienen de lo que checó ese día. */
  readonly deLoChecado = input(false);
  readonly guardada = output<HrIncidenciaDto>();
  readonly cancelada = output<void>();

  readonly ocupado = signal(false);
  readonly error = signal<string | null>(null);
  readonly saldoUso = signal<string | null>(null);

  readonly deUnDia = deUnDia;
  readonly notaObligatoria = notaObligatoria;
  readonly etiquetaNota = etiquetaNota;
  readonly conAutorizacion = conAutorizacion;

  /** `[RH.18.3]` Cada tipo con su nombre de Mega Talento («Incapacidad · cita médica»): se ve y se encuentra tecleándolo. */
  readonly conAlias = computed<HrTipoIncidenciaDto[]>(() => this.tipos().map((t) => ({ ...t, etiqueta: etiquetaConAlias(t.tipo, t.etiqueta) })));

  /** Con sugeridos: «Para este día» arriba, «Todos los tipos» abajo. Sin ellos, la lista plana de siempre. */
  readonly grupos = computed<GrupoTipos[] | null>(() => {
    const tipos = this.conAlias();
    const sug = this.sugeridos();
    const arriba = sug.map((s) => tipos.find((t) => t.tipo === s)).filter((t): t is HrTipoIncidenciaDto => !!t);
    if (!arriba.length) return null;
    const resto = tipos.filter((t) => !sug.includes(t.tipo));
    return [{ label: 'Para este día', items: arriba }, { label: 'Todos los tipos', items: resto }];
  });

  /** `[RH.1.10]` El saldo de horas extra de la persona, para capturar su uso sabiendo cuánto tiene. */
  verSaldo(persona: string): void {
    const site = this.site();
    const cod = persona.trim();
    if (!site || !cod) return;
    this.saldoUso.set('Calculando…');
    this.api.bancoHorasExtra(site, cod).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (b) => {
        const p = b.personas.find((x) => x.codigo === cod);
        this.saldoUso.set(p ? `Saldo: ${firmaHoras(p.saldoMin) || '0h 00m'} (ganó ${horasTexto(p.ganadasMin)}, usó ${horasTexto(p.usadasMin)})` : 'Sin horas extra en el banco.');
      },
      error: (e) => this.saldoUso.set(rhError(e, 'No se pudo leer el saldo.')),
    });
  }

  /** Se apaga en el primer toque (el doble clic del pánico no captura dos veces). */
  guardar(): void {
    const f = this.form();
    const site = this.site();
    if (!f || !site || !f.incident_type || this.ocupado()) return;
    this.ocupado.set(true);
    this.error.set(null);
    this.api.capturar(cuerpoCaptura(f, site)).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (n) => { this.ocupado.set(false); this.saldoUso.set(null); this.form.set(null); this.guardada.emit(n); },
      error: (e) => { this.ocupado.set(false); this.error.set(rhError(e, 'No se pudo guardar la incidencia. Nada cambió.')); },
    });
  }

  cancelar(): void {
    this.error.set(null);
    this.saldoUso.set(null);
    this.form.set(null);
    this.cancelada.emit();
  }
}
