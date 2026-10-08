import { ChangeDetectionStrategy, Component, OnInit, computed, input, output, signal } from '@angular/core';
import type { HrRelojEstadoDto, HrSiteDto } from '@megadulces/contracts';
import { desdeCuando, desfaseTexto, faltantesTexto, motivoReloj, peorSemaforo, resumenRelojes } from '../relojes-formato';

/**
 * Fase RH · `[RH.1.7b]` — la franja de relojes, con el formato que RH ya conoce de Mega Talento
 * (`asistencia-resumen`, «SEMÁFORO DE RELOJES»): un encabezado de una línea con el peor estado y el resumen, el
 * aviso «este sitio no ha reportado» SIEMPRE visible aunque esté plegada, y al abrir un renglón por reloj con
 * desde cuándo, la hora corrida, lo que falta y el motivo.
 *
 * Se trasladó el FORMATO, no el CSS a mano de Mega Talento: los colores salen de los tokens de la Suite
 * (DESIGN.md, Operations). El borde izquierdo es la señal periférica: se ve sin tener que leer.
 *
 * Se usa en Asistencia (los relojes del sitio que se está viendo, plegada) y en Relojes (todos, abierta, y con
 * «Editar» si quien la ve administra relojes).
 */
@Component({
  selector: 'app-rh-relojes-franja',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="rf" [attr.data-estado]="peor()" aria-label="Relojes checadores">
      <button type="button" class="rf-head" (click)="abierta.set(!abierta())" [attr.aria-expanded]="abierta()">
        <span class="rf-dot" [attr.data-s]="peor()" aria-hidden="true"></span>
        <span class="rf-titulo">Relojes</span>
        <span class="rf-resumen">{{ resumen() }}</span>
        @if (desfasados() > 0) {
          <span class="rf-aviso" title="Con la hora del reloj corrida, la tolerancia se aplica sobre una hora falsa y salen retardos que no existen.">
            {{ desfasados() }} con la hora corrida
          </span>
        }
        <i class="pi pi-chevron-down rf-chev" [class.abierto]="abierta()" aria-hidden="true"></i>
      </button>

      @if (sitioSinSenal()) {
        <p class="rf-alerta" role="alert">
          El reloj de este sitio <b>no ha reportado</b>. Lo que se ve es la última asistencia que llegó, no la de hoy
          — y un día sin dato <b>no es una falta</b>.
        </p>
      }

      @if (abierta()) {
        @if (relojes().length) {
          <ul class="rf-lista">
            @for (r of relojes(); track r.serie) {
              <li class="rf-rel" [attr.data-s]="r.semaforo">
                <span class="rf-dot" [attr.data-s]="r.semaforo" aria-hidden="true"></span>
                <span class="rf-nombre">
                  {{ r.alias || nombreSitio(r.sucursalId) }}
                  @if (r.modo === 'push') { <em class="rf-modo">push</em> }
                </span>
                <span class="rf-cuando">{{ cuando(r) }}</span>
                @if (desfase(r); as d) {
                  <span class="rf-chip warn" title="La tolerancia del horario se está midiendo contra una hora que no es. Se corrige en el equipo, no en el sistema.">{{ d }}</span>
                }
                @if (faltantes(r); as f) {
                  @if (f !== 'completo') {
                    <span class="rf-chip" title="Checadas que el equipo declara tener y todavía no están en la base.">{{ f }}</span>
                  }
                }
                @if (editable()) {
                  <button type="button" class="rf-editar" (click)="editar.emit(r.serie)" [attr.aria-label]="'Editar ' + (r.alias || r.serie)">Editar</button>
                }
                @if (motivo(r); as m) { <span class="rf-motivo">{{ m }}</span> }
                @if (detalle()) {
                  <span class="rf-detalle mono">{{ r.serie }}@if (r.ip) { · {{ r.ip }} }@if (r.logsEnReloj !== null) { · {{ r.logsEnReloj }} en el reloj / {{ r.logsEnBase ?? '—' }} en la base }</span>
                }
              </li>
            }
          </ul>
        } @else {
          <p class="rf-vacio">{{ vacio() }}</p>
        }
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .rf { border: 1px solid var(--border-color); border-left-width: 3px; border-radius: var(--r-md); background: var(--card-bg); overflow: hidden; }
    .rf[data-estado='mudo'] { border-left-color: var(--bad-fg); }
    .rf[data-estado='atrasado'] { border-left-color: var(--warn-fg); }
    .rf[data-estado='pendiente'] { border-left-color: var(--text-muted); }
    .rf[data-estado='ok'] { border-left-color: var(--ok-fg); }
    .rf-head { display: flex; align-items: center; gap: var(--sp-2); width: 100%; background: none; border: 0; padding: var(--sp-2) var(--sp-3);
      cursor: pointer; text-align: left; font: inherit; color: var(--text-main); }
    .rf-head:hover { background: var(--surface-hover-bg); }
    .rf-head:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .rf-titulo { font-size: var(--fs-sm); font-weight: 700; }
    .rf-resumen { font-size: var(--fs-sm); color: var(--text-muted); }
    .rf-aviso { font-size: var(--fs-xs); font-weight: 600; color: var(--warn-soft-fg); background: var(--warn-soft-bg); border-radius: var(--r-pill); padding: 1px var(--sp-2); }
    .rf-chev { margin-left: auto; color: var(--text-muted); font-size: var(--fs-xs); }
    .rf-chev.abierto { transform: rotate(180deg); }
    .rf-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--text-muted); }
    .rf-dot[data-s='ok'] { background: var(--ok-fg); }
    .rf-dot[data-s='atrasado'] { background: var(--warn-fg); }
    .rf-dot[data-s='mudo'] { background: var(--bad-fg); }
    .rf-alerta { margin: 0; padding: var(--sp-2) var(--sp-3); font-size: var(--fs-sm); line-height: 1.45; color: var(--bad-soft-fg); background: var(--bad-soft-bg);
      border-top: 1px solid var(--bad-border); }
    .rf-alerta b { font-weight: 700; }
    .rf-lista { list-style: none; margin: 0; padding: var(--sp-1) 0 var(--sp-2); border-top: 1px solid var(--border-color); }
    .rf-rel { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-1) var(--sp-2); padding: var(--sp-1) var(--sp-3); font-size: var(--fs-sm); }
    .rf-nombre { font-weight: 600; color: var(--text-main); }
    .rf-modo { font-style: normal; font-size: var(--fs-micro); font-weight: 700; text-transform: uppercase; color: var(--info-soft-fg); background: var(--info-soft-bg);
      border-radius: var(--r-sm); padding: 0 var(--sp-1); margin-left: var(--sp-1); }
    .rf-cuando { color: var(--text-muted); }
    .rf-rel[data-s='mudo'] .rf-cuando { color: var(--bad-soft-fg); font-weight: 600; }
    .rf-chip { font-size: var(--fs-xs); font-weight: 600; color: var(--text-muted); background: var(--surface-2); border-radius: var(--r-pill); padding: 1px var(--sp-2); }
    .rf-chip.warn { color: var(--warn-soft-fg); background: var(--warn-soft-bg); }
    .rf-editar { margin-left: auto; background: none; border: 0; padding: 0 var(--sp-1); font: inherit; font-size: var(--fs-xs); color: var(--text-muted);
      text-decoration: underline; cursor: pointer; }
    .rf-editar:focus-visible { outline: 2px solid var(--focus-ring); }
    .rf-motivo, .rf-detalle { flex-basis: 100%; padding-left: 19px; font-size: var(--fs-xs); color: var(--text-muted); }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .rf-vacio { margin: 0; padding: var(--sp-2) var(--sp-3); font-size: var(--fs-sm); color: var(--text-muted); border-top: 1px solid var(--border-color); }
    @media (prefers-reduced-motion: no-preference) { .rf-chev { transition: transform .15s; } }
  `],
})
export class RhRelojesFranjaComponent implements OnInit {
  /** Los relojes que se muestran (en Asistencia, sólo los del sitio). */
  readonly relojes = input.required<HrRelojEstadoDto[]>();
  readonly sitios = input<HrSiteDto[]>([]);
  /** El sitio que se está viendo: si todos SUS relojes están mudos, sale el aviso aunque la franja esté plegada. */
  readonly sitio = input<string | null>(null);
  /** Cómo arranca: plegada en Asistencia, abierta en Relojes. */
  readonly abiertaAlInicio = input(false);
  /** Muestra «Editar» en cada reloj (quien administra relojes). */
  readonly editable = input(false);
  /** Muestra serie, IP y conteos (la pantalla de Relojes). */
  readonly detalle = input(false);
  readonly vacio = input('Este sitio todavía no tiene reloj checador.');
  readonly editar = output<string>();

  readonly abierta = signal(false);
  readonly peor = computed(() => peorSemaforo(this.relojes()));
  readonly resumen = computed(() => resumenRelojes(this.relojes()));
  readonly desfasados = computed(() => this.relojes().filter((r) => desfaseTexto(r) !== '').length);
  readonly sitioSinSenal = computed(() => {
    const s = this.sitio();
    const propios = this.relojes().filter((r) => !s || r.sucursalId === s);
    return !!s && propios.length > 0 && propios.every((r) => r.semaforo === 'mudo');
  });
  private readonly nombres = computed(() => new Map(this.sitios().map((s) => [s.code, s.name])));

  /** Se lee UNA vez: después manda quien la abre o la cierra. */
  ngOnInit(): void { this.abierta.set(this.abiertaAlInicio()); }

  nombreSitio(code: string | null): string { return (code && this.nombres().get(code)) || code || 'Reloj sin sitio'; }
  cuando(r: HrRelojEstadoDto): string { return desdeCuando(r); }
  desfase(r: HrRelojEstadoDto): string { return desfaseTexto(r); }
  faltantes(r: HrRelojEstadoDto): string { return faltantesTexto(r); }
  motivo(r: HrRelojEstadoDto): string { return motivoReloj(r); }
}
