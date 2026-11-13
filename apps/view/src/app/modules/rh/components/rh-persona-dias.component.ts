import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { HrDiaAsistencia, HrPersonaAsistencia } from '@megadulces/contracts';
import { ESTADO_DIA_LABEL } from '../rh.service';
import { type ColumnaDia, diasPorFecha, difHorario, firmaHoras, horasTexto, incidenciasEnDescanso, pausasDelDia } from '../reporte-formato';

/**
 * Fase RH · `[RH.1.7c]` — una persona, un día por renglón (la vista «Una persona» de Mega Talento): Entrada,
 * Desayuno, Comida, Salida, Horas, Min. retardo y vs. horario, con «+N min» en rojo si llegó tarde y en ámbar si salió
 * antes o se pasó de la comida o del desayuno. La usan la ficha y «Ver solo a esta persona».
 */
interface RenglonDia {
  col: ColumnaDia;
  d: HrDiaAsistencia | undefined;
  /** El día se mide (tiene jornada) o se dice con una etiqueta. */
  medido: boolean;
  etiqueta: string;
  tono: 'bad' | 'warn' | 'info' | 'mute';
  desayuno: string | null;
  comida: string | null;
  vs: number | null;
}

@Component({
  selector: 'app-rh-persona-dias',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pd-scroll dt-scope">
      <table class="pd-tabla dt-stack">
        <thead>
          <tr>
            <th scope="col">Día</th><th scope="col">Entrada</th><th scope="col">Desayuno</th><th scope="col">Comida</th><th scope="col">Salida</th>
            <th class="num" scope="col">Horas</th><th class="num" scope="col">{{ mideRetardo() ? 'Min. retardo' : 'Retardo' }}</th>
            @if (persona().horarioAsignado) { <th class="num" scope="col">vs. horario</th> }
            @if (capturable()) { <th scope="col"><span class="sr-only">Acción</span></th> }
          </tr>
        </thead>
        <tbody>
          @for (r of renglones(); track r.col.fecha) {
            <tr [class.apagado]="!r.medido && r.tono === 'mute'">
              <td class="m dt-id" role="cell" data-label="Día">{{ r.col.dow }} {{ r.col.dia }}</td>
              @if (r.medido && r.d; as d) {
                <td class="m" role="cell" data-label="Entrada">{{ d.entrada }}@if (mideRetardo() && d.atrasoMin > 0) { <span class="tag bad">+{{ d.atrasoMin }} min</span> }
                  @if (d.turno) { <span class="d" [title]="'Tiene varios horarios: este día se midió contra el de las ' + d.turno">turno {{ d.turno }}</span> }
                  @if (d.horasExtraUsadasMin) { <span class="tag info">−{{ horas(d.horasExtraUsadasMin) }} de horas extra usadas</span> }</td>
                <td class="m" role="cell" data-label="Desayuno">@if (r.desayuno) { {{ r.desayuno }} <span class="d">{{ d.desayunoMin }} min</span> }
                  @else { <span class="d">—</span> }@if ((d.desayunoExcesoMin || 0) > 0) { <span class="tag warn">+{{ d.desayunoExcesoMin }} min</span> }</td>
                <td class="m" role="cell" data-label="Comida">@if (r.comida) { {{ r.comida }} @if (d.comidaMin !== null && d.comidaMin !== undefined) { <span class="d">{{ d.comidaMin }} min</span> } }
                  @else { <span class="d">—</span> }@if ((d.comidaExcesoMin || 0) > 0) { <span class="tag warn">+{{ d.comidaExcesoMin }} min</span> }</td>
                <td class="m" role="cell" data-label="Salida">{{ d.salida }}@if ((d.salidaAntesMin || 0) > 0) { <span class="tag warn">−{{ d.salidaAntesMin }} min</span> }</td>
                <td class="num dt-num" role="cell" data-label="Horas">{{ horas(d.netasMin) }}</td>
                <td class="num dt-num" role="cell" [attr.data-label]="mideRetardo() ? 'Min. retardo' : 'Retardo'">@if (mideRetardo()) { {{ d.atrasoMin || '' }} } @else { — }</td>
                @if (persona().horarioAsignado) { <td class="num dt-num" role="cell" data-label="vs. horario" [class.menos]="(r.vs ?? 0) < 0" [class.mas]="(r.vs ?? 0) > 0">{{ firma(r.vs) }}</td> }
              } @else {
                <td role="cell" data-label="Qué pasó" [attr.colspan]="persona().horarioAsignado ? 7 : 6"><span class="pill" [attr.data-t]="r.tono">{{ r.etiqueta }}</span></td>
              }
              <!-- [RH.13.5] La incidencia se captura con ESE día ya puesto (antes: el inicio de la semana y a buscar el día). -->
              @if (capturable()) {
                <td class="pd-acc" role="cell"><button type="button" class="pd-inc" (click)="capturar.emit(r.col.fecha)"
                  [attr.aria-label]="'Capturar una incidencia del ' + r.col.dow + ' ' + r.col.dia">+ Incidencia</button></td>
              }
            </tr>
          }
        </tbody>
        <tfoot>
          <tr>
            <td colspan="5">Total</td>
            <td class="num">{{ horas(persona().minutosTrabajados) }}</td>
            <td class="num">{{ mideRetardo() ? persona().atrasoBrutoMin : '—' }}</td>
            @if (persona().horarioAsignado) { <td class="num">{{ firma(dif()) }}</td> }
            @if (capturable()) { <td></td> }
          </tr>
        </tfoot>
      </table>
    </div>
  `,
  styles: [`
    .pd-acc { text-align: right; white-space: nowrap; }
    .pd-inc { border: 0; background: none; padding: 2px var(--sp-1); font: inherit; font-size: var(--fs-xs); color: var(--text-muted); cursor: pointer; border-radius: var(--r-sm); }
    .pd-inc:hover { color: var(--text-main); background: var(--surface-hover-bg); }
    .pd-inc:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    @media (pointer: coarse) { .pd-inc { min-height: 44px; padding: 0 var(--sp-2); } }
    :host { display: block; min-width: 0;
      /* [RH.13.5] «Con cuadros» (David, 13-nov): la misma rejilla visible que la tabla de la semana. */
      --pd-linea: color-mix(in srgb, var(--text-muted) 30%, var(--card-bg));
      --pd-linea-fuerte: color-mix(in srgb, var(--text-muted) 55%, var(--card-bg)); }
    .pd-scroll { overflow-x: auto; border: 1px solid var(--pd-linea); border-radius: var(--r-md); }
    .pd-tabla { border-collapse: collapse; width: 100%; font-size: var(--fs-sm); }
    .pd-tabla th { text-align: left; font-size: var(--fs-micro); font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted);
      background: var(--surface-2); padding: var(--sp-2); white-space: nowrap; }
    .pd-tabla td { padding: 6px var(--sp-2); border-top: 1px solid var(--pd-linea); vertical-align: top; white-space: nowrap; color: var(--text-main); }
    .num { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    th.num { text-align: right; }
    .m { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .d { color: var(--text-muted); font-size: var(--fs-xs); }
    tr.apagado td { color: var(--text-faint); }
    tfoot td { font-weight: 700; background: var(--surface-2); border-top: 2px solid var(--pd-linea-fuerte); }
    /* Las líneas verticales sólo con la rejilla: apilada en el teléfono cada renglón ya es una tarjeta. */
    @container densetable (min-width: 34.0625rem) {
      .pd-tabla th { border-bottom: 2px solid var(--pd-linea-fuerte); }
      .pd-tabla th + th, .pd-tabla td + td { border-left: 1px solid var(--pd-linea); }
    }
    .tag { display: inline-block; font: 700 var(--fs-micro)/1 var(--font-mono); padding: 2px 5px; border-radius: var(--r-sm); margin-left: 4px; }
    .tag.bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .tag.warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .tag.info { background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .pill { display: inline-block; padding: 1px var(--sp-2); border-radius: var(--r-pill); font-size: var(--fs-xs); background: var(--surface-2); color: var(--text-muted); }
    .pill[data-t='bad'] { background: var(--bad-soft-bg); color: var(--bad-soft-fg); font-weight: 600; }
    .pill[data-t='warn'] { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .pill[data-t='info'] { background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .menos { color: var(--warn-soft-fg); }
    .mas { color: var(--ok-soft-fg); }
  `],
})
export class RhPersonaDiasComponent {
  readonly persona = input.required<HrPersonaAsistencia>();
  readonly columnas = input.required<ColumnaDia[]>();
  readonly hoy = input.required<string>();
  readonly mideRetardo = input(true);
  /** `[RH.13.5]` Con un «+ Incidencia» por día (quien captura). */
  readonly capturable = input(false);
  readonly capturar = output<string>();

  readonly horas = horasTexto;
  readonly firma = firmaHoras;
  readonly dif = computed(() => difHorario(this.persona()));

  readonly renglones = computed<RenglonDia[]>(() => {
    const p = this.persona();
    const dias = diasPorFecha(p);
    return this.columnas().map((col) => {
      const d = dias.get(col.fecha);
      const incs = d?.incidencias?.length ? d.incidencias : p.incidencias.filter((i) => i.desde <= col.fecha && i.hasta >= col.fecha);
      const inc = incs.map((i) => `${i.codigo} · ${i.etiqueta}`).join(', ');
      const base = { col, d, medido: false, desayuno: null, comida: null, vs: null };
      if (!d) return { ...base, etiqueta: inc || (col.fecha > this.hoy() ? '' : 'Sin checadas que medir'), tono: inc ? 'info' : 'mute' } as RenglonDia;
      if (col.hoy && d.estado !== 'descanso' && d.estado !== 'justificado') {
        return { ...base, etiqueta: d.estado === 'falta' ? 'Todavía no checa hoy' : `Entró ${d.entrada || d.hora || ''} · sigue en su jornada`, tono: 'mute' } as RenglonDia;
      }
      switch (d.estado) {
        case 'falta': return { ...base, etiqueta: inc ? `Falta · ${inc}` : 'Falta', tono: 'bad' } as RenglonDia;
        case 'marca_faltante': return { ...base, etiqueta: `Una sola checada (${d.hora || d.entrada || '?'}): no se sabe si fue entrada o salida`, tono: 'bad' } as RenglonDia;
        case 'descanso': {
          // `[RH.6.2]` Unas vacaciones que cruzan su descanso no lo vuelven vacaciones: se dice el descanso capturado
          // y lo que no justifica (como en el reporte).
          const { deDescanso, otras } = incidenciasEnDescanso(incs);
          const txt = [...(deDescanso ? ['Descanso (lo capturó RH)'] : []), ...otras.map((i) => `${i.codigo} · ${i.etiqueta}`)].join(', ');
          return { ...base, etiqueta: txt || (d.descansoPorAusencia ? 'Descanso (no vino en un día que trabaja)' : 'Descanso'), tono: otras.length ? 'info' : 'mute' } as RenglonDia;
        }
        case 'justificado': return { ...base, etiqueta: inc || d.justificacion || ESTADO_DIA_LABEL.justificado, tono: 'info' } as RenglonDia;
        default: {
          const pz = pausasDelDia(d);
          const vs = p.horarioAsignado && d.netasMin != null && d.esperadoMin != null ? d.netasMin - d.esperadoMin : null;
          return { col, d, medido: true, etiqueta: '', tono: 'mute', desayuno: pz.desayuno, comida: pz.comida, vs };
        }
      }
    });
  });
}
