import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import type { HrBancoHorasExtraDto, HrPersonaHorasExtraDto } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { RhMarcoComponent } from '../components/rh-marco.component';
import { RhAsistenciaEstado } from '../rh-asistencia.estado';
import { RhService, fechaCorta, rhError } from '../rh.service';
import { diaLargo, firmaHoras, horasTexto } from '../reporte-formato';

/** El mínimo de letras del motivo de un ajuste o de su anulación (el servidor exige lo mismo). */
const MOTIVO_MINIMO = 5;
/**
 * `[RH.19.2]` (David, 2026-11-24: «un aprox que pueda ser editable pero con justificación») Las ganadas son un APROXIMADO:
 * RH las corrige con «Editar», escribiendo las horas correctas y por qué. Se guarda como un ajuste del banco por la
 * diferencia (la tabla de siempre, sin migración), con este principio en el motivo; así la pantalla sabe que ese ajuste
 * CORRIGE las ganadas y lo muestra ahí («3h 00m → 2h 00m»), no en «Ajustes». Se quita como cualquier ajuste, con motivo.
 */
export const CORRECCION_GANADAS = 'Ganadas corregidas de ';
/** Los minutos de las correcciones de ganadas de una persona (ajustes vigentes con ese motivo). */
export const correccionesMin = (p: HrPersonaHorasExtraDto): number =>
  p.ajustes.filter((a) => a.motivo.startsWith(CORRECCION_GANADAS)).reduce((t, a) => t + a.minutos, 0);
/** Como `horasTexto`, pero el cero se dice («0h 00m»): corregir a cero es una cifra, no un vacío. */
export const horasOCero = (min: number): string => (min > 0 ? horasTexto(min) : '0h 00m');
/** «2:30», «2» o «12:05» → minutos; otra cosa, null. */
export const minutosDeTexto = (t: string): number | null => {
  const m = /^(\d{1,3})(?::([0-5]\d))?$/.exec(t.trim());
  return m ? Number(m[1]) * 60 + Number(m[2] ?? 0) : null;
};

/**
 * Fase RH · `[RH.1.10]` — Horas extra (`/rh/asistencia/horas-extra`). El banco de cada persona: lo que GANÓ
 * quedándose después de su salida (bloques de 30 min), lo que USÓ con «Uso de horas extra» y los ajustes de RH.
 * Saldo = ganadas − usadas + ajustes, desde que arrancó el banco. Traslado de la pestaña Horas extra de Mega
 * Talento (ee4ff38). El saldo no se guarda: lo recalcula el servidor con la asistencia de cada vez.
 */
@Component({
  selector: 'app-rh-horas-extra',
  standalone: true,
  imports: [FormsModule, SelectModule, InputTextModule, ButtonModule, LoadStateComponent, SidePeekComponent, RhMarcoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="he-page">
      <app-rh-marco [barra]="false" />
      <!-- Sin plazas el marco lo declara: aquí no se pinta «nadie» ni ceros de algo que nadie midió. -->
      @if (!est.sinPlazas()) {
      <section class="he-bar" aria-label="Plaza">
        <p-select [options]="est.sitios()" optionLabel="name" optionValue="code" [ngModel]="est.sitio()" (ngModelChange)="est.setSitio($event)"
                  placeholder="Plaza" appendTo="body" ariaLabel="Plaza" class="he-plaza" />
        @if (banco(); as b) {
          <p class="he-desde">Desde el {{ corta(b.desde) }} hasta hoy · bloques de {{ b.bloqueMin }} min</p>
        }
        <p-button icon="pi pi-refresh" label="Actualizar" severity="secondary" [outlined]="true" [loading]="loading()" (onClick)="cargar()" />
      </section>

      <app-load-state [loading]="loading() && !banco()" [error]="error()" (retry)="cargar()">
        <section class="he-card" aria-label="Banco de horas extra">
          <p class="he-nota">Es <b>hora extra</b> lo que se queda después de su hora de salida, en bloques completos de 30 min, y sólo después de
            reponer lo que llegó tarde o se pasó de desayuno o de comida. <b>Es un aproximado</b>: RH lo corrige con «Editar», con su justificación. Se calcula con su horario asignado o, si no tiene, con el que sale
            de sus checadas (sólo jornada completa y fija).@if (banco()?.sinHorarioFijo) { <span> {{ banco()?.sinHorarioFijo }} persona(s) de planta
            no tienen horario fijo y no se les calcula.</span> }</p>
          @if (!personas().length) {
            <p class="he-vacio">Nadie tiene horas extra en esta plaza.</p>
          } @else {
            <div class="he-scroll dt-scope">
              <table class="he-tabla dt-stack">
                <thead><tr>
                  <th scope="col">Clv</th><th scope="col">Nombre</th><th scope="col">Departamento</th><th scope="col">Según</th>
                  <th scope="col" class="num">Ganadas (aprox.)</th><th scope="col" class="num">Usadas</th><th scope="col" class="num">Pagadas</th><th scope="col" class="num">Ajustes</th><th scope="col" class="num">Saldo</th>
                </tr></thead>
                <tbody>
                  @for (p of personas(); track p.codigo) {
                    <tr [class.sel]="sel()?.codigo === p.codigo">
                      <td class="mono" role="cell" data-label="Clv">{{ p.codigo }}</td>
                      <td class="dt-id" role="cell"><button type="button" class="he-nom" (click)="abrir(p)">{{ p.nombreCompleto }}</button></td>
                      <td role="cell" data-label="Departamento">{{ p.departamento || '—' }}</td>
                      <td role="cell" data-label="Según">{{ segun(p) }}</td>
                      <td class="num mono dt-num" role="cell" data-label="Ganadas (aprox.)">
                        @if (correccionesMin(p)) {
                          <s class="he-aprox" title="El aproximado">{{ horas(p.ganadasMin) }}</s> → <b>{{ horas(ganadasEfectivas(p)) }}</b>
                        } @else { {{ horas(p.ganadasMin) }} }
                        @if (gestiona()) {
                          <button type="button" class="he-editar" [attr.aria-expanded]="editando() === p.codigo" (click)="editar(p)"
                                  [attr.aria-label]="'Editar las horas extra de ' + p.nombreCompleto">Editar</button>
                        }
                      </td>
                      <td class="num mono dt-num" role="cell" data-label="Usadas">{{ horas(p.usadasMin) }}</td>
                      <!-- [RH.6.7] Lo que se le pagó en efectivo (descuenta del saldo). Mismo formato que Usadas. -->
                      <td class="num mono dt-num" role="cell" data-label="Pagadas">{{ p.pagadasMin === undefined ? '—' : horas(p.pagadasMin) }}</td>
                      <td class="num mono dt-num" role="cell" data-label="Ajustes">{{ otrosAjustes(p) ? firma(otrosAjustes(p)) : '—' }}</td>
                      <td class="num mono he-saldo dt-num" role="cell" data-label="Saldo" [class.neg]="p.saldoMin < 0">{{ firma(p.saldoMin) }}</td>
                    </tr>
                    @if (editando() === p.codigo) {
                      <!-- [RH.19.2] Corregir el aproximado: las horas correctas y por qué. Sin justificación no se guarda. -->
                      <tr class="he-edit-fila"><td colspan="9">
                        <form class="he-edit" (ngSubmit)="guardarEdicion(p)" [attr.aria-label]="'Corregir las horas extra de ' + p.nombreCompleto">
                          <label>Horas extra correctas
                            <input pInputText name="correctas" inputmode="numeric" placeholder="2:30" [ngModel]="horasCorrectas()" (ngModelChange)="horasCorrectas.set($event)" />
                          </label>
                          <label class="he-ancho">Justificación
                            <input pInputText name="justificacion" placeholder="Ej. se quedó esperando transporte, no trabajó" [ngModel]="justificacion()" (ngModelChange)="justificacion.set($event)" />
                          </label>
                          <p-button type="submit" label="Guardar" size="small" [disabled]="!edicionValida()" [loading]="ocupado()" />
                          <p-button label="Cancelar" [text]="true" size="small" (onClick)="editando.set(null)" />
                          <p class="he-ayuda">Aproximado {{ horas(p.ganadasMin) }}@if (nuevoMin() !== null) { · queda en {{ horasOCero(nuevoMin()!) }} }. Se guarda como ajuste, con quién y por qué; se puede quitar después, con motivo.</p>
                        </form>
                        @if (avisoTabla(); as a) { <p class="he-banner" [class.bad]="a.mal" role="status">{{ a.texto }}</p> }
                      </td></tr>
                    }
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      </app-load-state>
      }

      <app-side-peek [open]="!!sel()" (openChange)="cambio($event)" [width]="560" [title]="sel()?.nombreCompleto ?? ''" [subtitle]="subtitulo()">
        @if (sel(); as p) {
          <div class="he-ficha">
            <p class="he-resumen">Ganó <b>{{ horas(ganadasEfectivas(p)) }}</b>@if (correccionesMin(p)) { <span> (aprox. {{ horas(p.ganadasMin) }}, corregidas)</span> } · usó <b>{{ horas(p.usadasMin) }}</b>
              @if (p.pagadasMin) { · le pagaron <b>{{ horas(p.pagadasMin) }}</b> }
              @if (otrosAjustes(p)) { · ajustes <b>{{ firma(otrosAjustes(p)) }}</b> } · saldo <b [class.neg]="p.saldoMin < 0">{{ firma(p.saldoMin) }}</b></p>

            <h3>Días con horas extra</h3>
            @if (!p.ganadas.length) { <p class="he-vacio">Ninguno.</p> } @else {
              <ul class="he-lista">
                @for (g of p.ganadas; track g.fecha) {
                  <li><span>{{ dia(g.fecha) }}</span><span class="mono">salió {{ g.salida || '—' }} · debía {{ g.salidaEsperada || '—' }}</span><b class="mono">+{{ horas(g.extraMin) }}</b></li>
                }
              </ul>
            }

            <h3>Usos</h3>
            @if (!p.usos.length) { <p class="he-vacio">Ninguno.</p> } @else {
              <ul class="he-lista">
                @for (u of p.usos; track u.id) {
                  <li><span>{{ corta(u.desde) }}@if (u.hasta !== u.desde) { a {{ corta(u.hasta) }} }</span><span>{{ u.nota }}</span><b class="mono">−{{ horas(u.totalMin) }}</b></li>
                }
              </ul>
            }

            <!-- [RH.6.7] Cada pago de horas extras: un total en una fecha, con la referencia del pago. -->
            <h3>Pagadas</h3>
            @if (!p.pagos?.length) { <p class="he-vacio">Ninguna.</p> } @else {
              <ul class="he-lista">
                @for (x of p.pagos; track x.id) {
                  <li><span>{{ corta(x.fecha) }}</span><span>{{ x.nota }}</span><b class="mono">−{{ horas(x.minutos) }}</b></li>
                }
              </ul>
            }

            <h3>Ajustes de RH</h3>
            @if (!p.ajustes.length) { <p class="he-vacio">Ninguno.</p> } @else {
              <ul class="he-lista">
                @for (a of p.ajustes; track a.id) {
                  <li>
                    <span>{{ corta(a.fecha) }}</span><span>{{ a.motivo }}@if (a.creadoPor) { <em> · {{ a.creadoPor }}</em> }</span><b class="mono">{{ firma(a.minutos) }}</b>
                    @if (gestiona()) {
                      @if (anulando() === a.id) {
                        <span class="he-anular">
                          <input pInputText [ngModel]="motivoAnular()" (ngModelChange)="motivoAnular.set($event)" placeholder="Por qué se quita" aria-label="Por qué se quita el ajuste" />
                          <p-button label="Quitar" severity="danger" size="small" [disabled]="motivoAnular().trim().length < motivoMinimo" [loading]="ocupado()" (onClick)="anular(a.id)" />
                          <p-button label="Cancelar" [text]="true" size="small" (onClick)="anulando.set(null)" />
                        </span>
                      } @else {
                        <p-button label="Quitar" [text]="true" size="small" (onClick)="anulando.set(a.id); motivoAnular.set('')" />
                      }
                    }
                  </li>
                }
              </ul>
            }

            @if (gestiona()) {
              <form class="he-form" (ngSubmit)="guardarAjuste()" aria-label="Ajustar el saldo">
                <h3>Ajustar el saldo</h3>
                <p class="he-ayuda">Saldo inicial de quien traía horas de antes del banco, o una corrección. Se puede quitar después, con motivo.</p>
                <div class="he-campos">
                  <label>Suma o resta
                    <select name="signo" [ngModel]="signo()" (ngModelChange)="signo.set($event)" aria-label="Suma o resta">
                      <option value="1">Suma</option><option value="-1">Resta</option>
                    </select>
                  </label>
                  <label>Horas <input pInputText type="time" name="horas" [ngModel]="horasAjuste()" (ngModelChange)="horasAjuste.set($event)" aria-label="Horas del ajuste" /></label>
                  <label>Desde <input pInputText type="date" name="fecha" [ngModel]="fechaAjuste()" (ngModelChange)="fechaAjuste.set($event)" aria-label="Desde cuándo cuenta" /></label>
                  <label class="he-ancho">Motivo <input pInputText name="motivo" [ngModel]="motivoAjuste()" (ngModelChange)="motivoAjuste.set($event)" placeholder="Ej. saldo que traía al 23 de septiembre" /></label>
                </div>
                <p-button type="submit" label="Guardar ajuste" size="small" [disabled]="!ajusteValido()" [loading]="ocupado()" />
              </form>
            }
            @if (aviso(); as a) { <p class="he-banner" [class.bad]="a.mal" role="status">{{ a.texto }}</p> }
          </div>
        }
      </app-side-peek>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .he-nom { min-height: var(--tap-min); }
    /* [RH.13.5] Con el dedo, todo lo que se toca mide al menos 44 px (--tap-min: 0 con mouse, 44 en táctil). */
    :host ::ng-deep .p-button, :host ::ng-deep .p-select, :host ::ng-deep .p-multiselect, :host ::ng-deep input.p-inputtext { min-height: var(--tap-min); }
    .he-page { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); }
    .he-bar { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }
    .he-plaza { min-width: 14rem; }
    .he-desde { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); flex: 1 1 auto; }
    .he-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); min-width: 0; padding-bottom: var(--sp-2); }
    .he-nota { margin: 0; padding: var(--sp-3); font-size: var(--fs-sm); color: var(--text-muted); max-width: 90ch; line-height: 1.5; }
    .he-nota b { color: var(--text-main); }
    .he-vacio { margin: 0; padding: var(--sp-2) var(--sp-3); color: var(--text-muted); font-size: var(--fs-sm); }
    .he-scroll { overflow-x: auto; }
    .he-tabla { border-collapse: collapse; width: 100%; font-size: var(--fs-sm); }
    .he-tabla th { text-align: left; font-size: var(--fs-micro); font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted);
      background: var(--surface-2); padding: var(--sp-2) var(--sp-3); white-space: nowrap; }
    .he-tabla td { padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--border-color); color: var(--text-main); vertical-align: middle; }
    .he-tabla tr.sel td { background: var(--surface-2); }
    .num { text-align: right; }
    .he-nom { border: 0; background: none; padding: 0; font: inherit; font-weight: 700; color: var(--text-main); cursor: pointer; text-align: left; }
    .he-nom:hover { text-decoration: underline; }
    .he-nom:focus-visible { outline: 2px solid var(--focus-ring); }
    .he-saldo { font-weight: 700; }
    .he-aprox { color: var(--text-muted); }
    .he-editar { margin-left: var(--sp-2); border: 0; background: none; padding: 0 var(--sp-1); font: inherit; font-size: var(--fs-xs); font-weight: 600;
      color: var(--text-main); text-decoration: underline; cursor: pointer; min-height: var(--tap-min); }
    .he-editar:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .he-edit-fila td { background: var(--surface-2); }
    .he-edit { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: flex-end; }
    .he-edit label { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); }
    .he-edit .he-ayuda { flex: 1 1 100%; }
    .neg { color: var(--bad-soft-fg); }
    .he-ficha { display: flex; flex-direction: column; gap: var(--sp-2); }
    .he-ficha h3 { margin: var(--sp-2) 0 0; font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); }
    .he-resumen { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .he-resumen b { color: var(--text-main); }
    .he-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .he-lista li { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; padding: var(--sp-1) 0; border-top: 1px solid var(--border-color); font-size: var(--fs-sm); }
    .he-lista li span:first-child { min-width: 9rem; color: var(--text-main); }
    .he-lista li span:nth-child(2) { flex: 1 1 10rem; color: var(--text-muted); }
    .he-anular { display: flex; flex-wrap: wrap; gap: var(--sp-1); align-items: center; width: 100%; }
    .he-anular input { flex: 1 1 12rem; min-width: 0; }
    .he-form { display: flex; flex-direction: column; gap: var(--sp-2); border-top: 1px solid var(--border-color); padding-top: var(--sp-2); }
    .he-ayuda { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .he-campos { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
    .he-campos label { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); }
    .he-campos select { padding: var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-sm); background: var(--card-bg); color: var(--text-main); font: inherit; }
    .he-ancho { flex: 1 1 100%; }
    .he-banner { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); font-size: var(--fs-sm); background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .he-banner.bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    @media (max-width: 40rem) { .he-page { padding: var(--sp-3); } .he-plaza { min-width: 0; flex: 1 1 100%; } }
  `],
})
export class RhHorasExtraComponent {
  readonly est = inject(RhAsistenciaEstado);
  private readonly api = inject(RhService);
  private readonly perms = inject(PermissionsService);

  readonly banco = signal<HrBancoHorasExtraDto | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly sel = signal<HrPersonaHorasExtraDto | null>(null);
  readonly ocupado = signal(false);
  readonly aviso = signal<{ texto: string; mal: boolean } | null>(null);
  readonly signo = signal<'1' | '-1'>('1');
  readonly horasAjuste = signal('');
  readonly fechaAjuste = signal('');
  readonly motivoAjuste = signal('');
  readonly anulando = signal<string | null>(null);
  readonly motivoAnular = signal('');
  readonly motivoMinimo = MOTIVO_MINIMO;
  /** `[RH.19.2]` La persona cuya cifra se está corrigiendo, y lo que se escribió. */
  readonly editando = signal<string | null>(null);
  readonly horasCorrectas = signal('');
  readonly justificacion = signal('');
  readonly avisoTabla = signal<{ texto: string; mal: boolean } | null>(null);
  readonly nuevoMin = computed(() => minutosDeTexto(this.horasCorrectas()));
  readonly edicionValida = computed(() => {
    const p = this.personas().find((x) => x.codigo === this.editando());
    const n = this.nuevoMin();
    return !!p && n !== null && n !== this.ganadasEfectivas(p) && this.justificacion().trim().length >= MOTIVO_MINIMO;
  });
  private seq = 0;

  readonly personas = computed(() => this.banco()?.personas ?? []);
  readonly gestiona = computed(() => this.perms.has(Permission.HR_ATTENDANCE_GESTIONAR));
  readonly subtitulo = computed(() => {
    const p = this.sel();
    return p ? `#${p.codigo}${p.departamento ? ' · ' + p.departamento : ''} · ${this.segun(p)}` : '';
  });
  /** Minutos del ajuste a partir de «hh:mm», con su signo; 0 si no es válido. */
  readonly minutosAjuste = computed(() => {
    const m = /^(\d{1,3}):(\d{2})$/.exec(this.horasAjuste().trim());
    const t = m ? Number(m[1]) * 60 + Number(m[2]) : 0;
    return t * Number(this.signo());
  });
  readonly ajusteValido = computed(() => this.minutosAjuste() !== 0 && this.motivoAjuste().trim().length >= MOTIVO_MINIMO);

  constructor() {
    // Sólo la plaza dispara la lectura; lo que `cargar` toca adentro no se rastrea.
    effect(() => { if (this.est.sitio()) untracked(() => this.cargar()); });
  }

  cargar(): void {
    const site = this.est.sitio();
    if (!site) return;
    const mi = ++this.seq;
    this.loading.set(true);
    this.error.set(null);
    this.api.bancoHorasExtra(site).subscribe({
      next: (b) => {
        if (mi !== this.seq) return;
        this.banco.set(b);
        this.loading.set(false);
        // La ficha abierta se refresca con lo nuevo (o se cierra si la persona ya no aparece).
        const abierta = this.sel();
        if (abierta) this.sel.set(b.personas.find((p) => p.codigo === abierta.codigo) ?? null);
      },
      error: (e) => { if (mi !== this.seq) return; this.error.set(rhError(e, 'No se pudo calcular el banco de horas extra.')); this.loading.set(false); },
    });
  }

  abrir(p: HrPersonaHorasExtraDto): void {
    this.sel.set(p);
    this.aviso.set(null);
    this.anulando.set(null);
    this.horasAjuste.set(''); this.motivoAjuste.set(''); this.signo.set('1');
    this.fechaAjuste.set(this.banco()?.desde ?? '');
  }

  cambio(abierta: boolean): void { if (!abierta) this.sel.set(null); }

  guardarAjuste(): void {
    const p = this.sel();
    const site = this.est.sitio();
    if (!p || !site || !this.ajusteValido()) return;
    this.ocupado.set(true);
    this.aviso.set(null);
    this.api.crearAjusteHorasExtra({
      site_code: site, person_code: p.codigo, minutes: this.minutosAjuste(), reason: this.motivoAjuste().trim(),
      effective_date: this.fechaAjuste() || undefined,
    }).subscribe({
      next: () => {
        this.ocupado.set(false);
        this.horasAjuste.set(''); this.motivoAjuste.set('');
        this.aviso.set({ texto: 'Ajuste guardado: el saldo ya lo cuenta.', mal: false });
        this.cargar();
      },
      error: (e) => { this.ocupado.set(false); this.aviso.set({ texto: rhError(e, 'No se pudo guardar el ajuste.'), mal: true }); },
    });
  }

  anular(id: string): void {
    const m = this.motivoAnular().trim();
    if (m.length < MOTIVO_MINIMO) return;
    this.ocupado.set(true);
    this.aviso.set(null);
    this.api.anularAjusteHorasExtra(id, m).subscribe({
      next: () => { this.ocupado.set(false); this.anulando.set(null); this.aviso.set({ texto: 'Ajuste quitado. Queda registrado quién y por qué.', mal: false }); this.cargar(); },
      error: (e) => { this.ocupado.set(false); this.aviso.set({ texto: rhError(e, 'No se pudo quitar el ajuste.'), mal: true }); },
    });
  }

  // ── [RH.19.2] El aproximado y su corrección ──
  correccionesMin(p: HrPersonaHorasExtraDto): number { return correccionesMin(p); }
  ganadasEfectivas(p: HrPersonaHorasExtraDto): number { return p.ganadasMin + correccionesMin(p); }
  /** Los ajustes que NO corrigen ganadas (saldo inicial, otros): las correcciones ya se ven en «Ganadas». */
  otrosAjustes(p: HrPersonaHorasExtraDto): number { return p.ajustesMin - correccionesMin(p); }

  editar(p: HrPersonaHorasExtraDto): void {
    if (this.editando() === p.codigo) { this.editando.set(null); return; }
    this.editando.set(p.codigo);
    this.horasCorrectas.set('');
    this.justificacion.set('');
    this.avisoTabla.set(null);
  }

  guardarEdicion(p: HrPersonaHorasExtraDto): void {
    const site = this.est.sitio();
    const nuevo = this.nuevoMin();
    if (!site || nuevo === null || !this.edicionValida()) return;
    const actual = this.ganadasEfectivas(p);
    this.ocupado.set(true);
    this.avisoTabla.set(null);
    this.api.crearAjusteHorasExtra({
      site_code: site, person_code: p.codigo, minutes: nuevo - actual,
      reason: `${CORRECCION_GANADAS}${horasOCero(actual)} a ${horasOCero(nuevo)}: ${this.justificacion().trim()}`,
      effective_date: this.banco()?.hasta || undefined,
    }).subscribe({
      next: () => { this.ocupado.set(false); this.editando.set(null); this.cargar(); },
      error: (e) => { this.ocupado.set(false); this.avisoTabla.set({ texto: rhError(e, 'No se pudo guardar la corrección.'), mal: true }); },
    });
  }

  horas(min: number): string { return horasTexto(min); }
  horasOCero(min: number): string { return horasOCero(min); }
  firma(min: number): string { return firmaHoras(min); }
  corta(f: string): string { return fechaCorta(f); }
  dia(f: string): string { return diaLargo(f); }
  segun(p: HrPersonaHorasExtraDto): string {
    return p.segun === 'asignado' ? 'Horario asignado' : p.segun === 'deducido' ? 'Horario de sus checadas (revisar)' : 'Sin horario fijo';
  }
}
