import { HR_HOY_NOTA_NO_CONTESTO, HR_TALENT_META_HORAS, type HrHoyPendienteId } from '@megadulces/contracts';
import { etapaDe } from './etapas';

/**
 * Fase RH · `[RH.17.1]` — la REGLA de «Hoy»: en qué pendiente del día cae cada candidato. Pura, sin base: el servicio
 * le pasa las filas ya leídas y aquí se decide, se ordena y se corta a la cuota.
 *
 * Un candidato cae en UN solo pendiente, el primero que aplique en este orden:
 *   1. `nuevos`      — en Filtro, se postuló hace ≤ 48 h y nadie de RH le ha hablado.
 *   2. `expediente`  — en Entrevista conductual con el expediente obligatorio completo: revisarlo y pasarlo.
 *   3. `jefe`        — en Aptitudes, sin evaluación y sin liga vigente para el jefe que entrevista.
 *   4. `seguimiento` — ya pasó el tiempo que RH se dio para su etapa (`HR_TALENT_META_HORAS`).
 * Lo que lleva más de `DIAS_APARTADO` días sin movimiento NO es pendiente del día: se cuenta aparte («apartados»).
 */

/** Cuántos se ven por pendiente en el día. Los demás siguen contados: «20 para hoy (de 846)». */
export const CUOTA_DIA = 20;
/** «Nuevo» = se postuló en las últimas 48 h (cubre «desde ayer» aunque RH entre tarde). */
export const VENTANA_NUEVOS_H = 48;
/** Sin movimiento en más de esto, sale de los pendientes del día. */
export const DIAS_APARTADO = 30;
/** La nota EXACTA que deja el botón «No contestó» de la tarjeta; con ella se cuentan los intentos. */
export const NOTA_NO_CONTESTO = HR_HOY_NOTA_NO_CONTESTO;
/**
 * El principio de la nota que deja `HrTalentLinksService.crear` al generar la liga de aptitudes (no hay tabla de
 * ligas). Si ese texto cambia, esta regla deja de ver la liga: lo cuida `hoy.spec.ts`.
 */
export const NOTA_LIGA_APTITUDES = 'Se generó la liga de la evaluación de aptitudes';
/** La liga vence a los 7 días (`VIGENCIA_DIAS` de las ligas): después se puede volver a pedir. */
export const DIAS_LIGA_VIGENTE = 7;

const H = 3_600_000;

export interface FilaHoy {
  id: string;
  stage: string | null;
  created_at: Date | string;
  last_activity_at: Date | string | null;
  /** Alguien de RH registró un contacto o una entrevista (los mensajes del bot no cuentan). */
  contactado: boolean;
  /** Casilleros obligatorios que le faltan. */
  faltantes: number;
  tiene_eval: boolean;
  liga_aptitudes_vigente: boolean;
}

const ms = (x: Date | string): number => (x instanceof Date ? x.getTime() : Date.parse(x));
/** Horas desde la última actividad (o el alta, si nunca hubo). */
export const horasSin = (f: Pick<FilaHoy, 'created_at' | 'last_activity_at'>, ahora: Date): number =>
  (ahora.getTime() - ms(f.last_activity_at ?? f.created_at)) / H;

/** El pendiente de un candidato, `'apartado'` si lleva demasiado sin movimiento, o `null` si va al corriente. */
export function pendienteDe(f: FilaHoy, ahora: Date): HrHoyPendienteId | 'apartado' | null {
  const etapa = etapaDe(f.stage);
  if (etapa === 'contratado' || etapa === 'rechazado') return null;
  const horas = horasSin(f, ahora);
  if (horas > DIAS_APARTADO * 24) return 'apartado';
  if (etapa === 'filtro_inicial' && !f.contactado && (ahora.getTime() - ms(f.created_at)) / H <= VENTANA_NUEVOS_H) return 'nuevos';
  if (etapa === 'entrevista_rh' && f.faltantes === 0) return 'expediente';
  if (etapa === 'aptitudes' && !f.tiene_eval && !f.liga_aptitudes_vigente) return 'jefe';
  const meta = HR_TALENT_META_HORAS[etapa];
  if (meta != null && horas > meta) return 'seguimiento';
  return null;
}

export const PENDIENTES: readonly HrHoyPendienteId[] = ['nuevos', 'seguimiento', 'expediente', 'jefe'];

/**
 * El orden de cada pendiente:
 *   · nuevos: el que más lleva esperando primero (se atiende por orden de llegada);
 *   · seguimiento: la actividad MÁS RECIENTE primero (con rezago, es quien más probablemente sigue interesado);
 *   · expediente y jefe: el que más lleva esperando primero.
 */
function orden(id: HrHoyPendienteId, ahora: Date): (a: FilaHoy, b: FilaHoy) => number {
  if (id === 'nuevos') return (a, b) => ms(a.created_at) - ms(b.created_at);
  if (id === 'seguimiento') return (a, b) => horasSin(a, ahora) - horasSin(b, ahora);
  return (a, b) => horasSin(b, ahora) - horasSin(a, ahora);
}

export interface HoyArmado<T extends FilaHoy> {
  pendientes: Array<{ id: HrHoyPendienteId; total: number; filas: T[] }>;
  apartados: number;
}

/** Reparte las filas en los pendientes, ordena cada uno y lo corta a la cuota (el total se conserva). */
export function armarHoy<T extends FilaHoy>(filas: readonly T[], ahora: Date, cuota = CUOTA_DIA): HoyArmado<T> {
  const grupos = new Map<HrHoyPendienteId, T[]>(PENDIENTES.map((p) => [p, []]));
  let apartados = 0;
  for (const f of filas) {
    const p = pendienteDe(f, ahora);
    if (p === 'apartado') apartados += 1;
    else if (p) grupos.get(p)!.push(f);
  }
  return {
    pendientes: PENDIENTES.map((id) => {
      const g = grupos.get(id)!;
      return { id, total: g.length, filas: [...g].sort(orden(id, ahora)).slice(0, Math.max(0, cuota)) };
    }),
    apartados,
  };
}
