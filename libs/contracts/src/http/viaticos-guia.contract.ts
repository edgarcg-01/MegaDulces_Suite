// EMB.19 — La guía ya no se teclea: comisión y viáticos se CALCULAN y van bloqueados.
//
// Los viáticos salen del HORARIO del viaje con la regla de la beta de Logística
// (`megadulces_beta`, `aplicarSugerenciasHorario`):
//
//   café     → sale antes de las 6:00
//   desayuno → sale antes de las 7:00
//   comida   → llega después de las 15:00
//   cena     → se queda a dormir, o llega después de las 20:00
//
// A cada persona que va en la guía (chofer y ayudantes) le toca lo mismo, con la tarifa de
// Logística › Configuración › Viáticos (`config_finance`, categoría `viatico`). En la beta el
// horario SUGERÍA las comidas y se podían destildar; aquí van bloqueadas (decisión de Logística,
// 2026-10-07). La leen la pantalla (para apagar el botón) y la API (para responder 400), así que
// no pueden contradecirse.
//
// Sin hora no hay viático que calcular, y sin tarifa la comida que sí toca saldría en $0 — y
// Liquidaciones paga lo que dice la guía. Por eso ninguna de las dos cosas se rellena con cero:
// la guía no se crea hasta que estén (`erroresDeViaticos`).

import { DONDE_SE_CAPTURA_LA_TARIFA } from './nuevo-embarque.contract';

export type ComidaViatico = 'cafe' | 'desayuno' | 'comida' | 'cena';
export const COMIDAS_VIATICO: readonly ComidaViatico[] = ['cafe', 'desayuno', 'comida', 'cena'];
export const ETIQUETA_COMIDA: Readonly<Record<ComidaViatico, string>> = {
  cafe: 'Café', desayuno: 'Desayuno', comida: 'Comida', cena: 'Cena',
};

/** Quién va en la guía, con las llaves de `logistics.delivery_guides`. */
export type PersonaGuia = 'driver' | 'helper1' | 'helper2';
export const PERSONAS_GUIA: readonly PersonaGuia[] = ['driver', 'helper1', 'helper2'];

/** Pesos por comida, de `config_finance` (`viatico_cafe`, `viatico_desayuno`…). */
export type TarifasViatico = Record<ComidaViatico, number>;

/** Dónde se captura la tarifa de viático que falta. */
export const DONDE_SE_CAPTURA_EL_VIATICO = 'Logística › Configuración › Viáticos';

/** El horario del viaje, como lo captura el coordinador. Horas en `HH:MM` (24 h). */
export interface HorarioGuia {
  salida: string | null;
  llegada: string | null;
  duerme_fuera: boolean;
}

export interface ViaticoPersona extends Record<ComidaViatico, boolean> {
  va: boolean;
  subtotal: number;
}

/**
 * Lo que se captura al agregar una guía a un embarque MANUAL: la tripulación y el horario.
 * Comisión y viáticos NO van — los calcula la API (tarifa de la ruta + horario).
 */
export interface NuevaGuiaBody {
  shipment_id: string;
  driver_id: string | null;
  helper1_id: string | null;
  helper2_id: string | null;
  departure_time: string | null;
  arrival_time: string | null;
  overnight: boolean;
  notes?: string | null;
}

/** Lo que se guarda en `delivery_guides.per_diem_breakdown`: el cálculo completo, auditable. */
export interface ViaticosDeLaGuia {
  regla: 'horario_beta';
  horario: HorarioGuia;
  tarifas: TarifasViatico;
  comidas: Record<ComidaViatico, boolean>;
  driver: ViaticoPersona;
  helper1: ViaticoPersona;
  helper2: ViaticoPersona;
  total: number;
}

const HORA = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;

/** `'05:30'` → 330. Acepta `HH:MM:SS` (así devuelve Postgres un `time`). Inválida o vacía → null. */
export function horaAMinutos(h: string | null | undefined): number | null {
  const m = HORA.exec(String(h ?? '').trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  return hh <= 23 && mm <= 59 ? hh * 60 + mm : null;
}

/** La hora normalizada a `HH:MM`, o null si no es una hora. */
export function horaNormal(h: string | null | undefined): string | null {
  const min = horaAMinutos(h);
  return min == null ? null : `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/** Las comidas que da el horario (la regla de la beta, tal cual). */
export function comidasPorHorario(h: HorarioGuia): Record<ComidaViatico, boolean> {
  const salida = horaAMinutos(h.salida);
  const llegada = horaAMinutos(h.llegada);
  return {
    cafe: salida != null && salida < 6 * 60,
    desayuno: salida != null && salida < 7 * 60,
    comida: llegada != null && llegada > 15 * 60,
    cena: h.duerme_fuera || (llegada != null && llegada > 20 * 60),
  };
}

/** Lo que falta para poder calcular los viáticos. Lista vacía = se pueden calcular. */
export function erroresDeViaticos(h: HorarioGuia, tarifas: TarifasViatico): string[] {
  const e: string[] = [];
  const hora = (v: string | null, que: string) => {
    if (!String(v ?? '').trim()) e.push(`Indica la hora de ${que}.`);
    else if (horaAMinutos(v) == null) e.push(`La hora de ${que} no es válida: usa HH:MM, por ejemplo 05:30.`);
  };
  hora(h.salida, 'salida');
  hora(h.llegada, 'llegada');
  if (e.length) return e;
  const comidas = comidasPorHorario(h);
  const sinTarifa = COMIDAS_VIATICO.filter((m) => comidas[m] && !((tarifas[m] ?? 0) > 0));
  if (sinTarifa.length) {
    e.push(`Falta la tarifa de ${sinTarifa.map((m) => ETIQUETA_COMIDA[m].toLowerCase()).join(', ')} en ${DONDE_SE_CAPTURA_EL_VIATICO}.`);
  }
  return e;
}

/** El cálculo. Sólo tiene sentido cuando `erroresDeViaticos` viene vacío. */
export function viaticosDeLaGuia(
  h: HorarioGuia,
  tarifas: TarifasViatico,
  va: Record<PersonaGuia, boolean>,
): ViaticosDeLaGuia {
  const comidas = comidasPorHorario(h);
  // En centavos: 50 + 100 + 100 no debe dar 249.99999.
  const centavosPorPersona = COMIDAS_VIATICO.reduce(
    (t, m) => t + (comidas[m] ? Math.round((tarifas[m] || 0) * 100) : 0), 0);
  const persona = (p: PersonaGuia): ViaticoPersona => ({
    va: va[p],
    cafe: va[p] && comidas.cafe,
    desayuno: va[p] && comidas.desayuno,
    comida: va[p] && comidas.comida,
    cena: va[p] && comidas.cena,
    subtotal: va[p] ? centavosPorPersona / 100 : 0,
  });
  const personas = { driver: persona('driver'), helper1: persona('helper1'), helper2: persona('helper2') };
  const total = PERSONAS_GUIA.filter((p) => va[p]).length * centavosPorPersona / 100;
  return {
    regla: 'horario_beta',
    horario: { salida: horaNormal(h.salida), llegada: horaNormal(h.llegada), duerme_fuera: !!h.duerme_fuera },
    tarifas: { ...tarifas },
    comidas,
    ...personas,
    total,
  };
}

/** Las tarifas desde los renglones de `config_finance` (`viatico_cafe` → `cafe`). */
export function tarifasDeViatico(rows: ReadonlyArray<{ key: string; value: number | string | null }>): TarifasViatico {
  const t: TarifasViatico = { cafe: 0, desayuno: 0, comida: 0, cena: 0 };
  for (const r of rows) {
    const m = String(r.key).replace(/^viatico_/, '') as ComidaViatico;
    if (COMIDAS_VIATICO.includes(m)) t[m] = Number(r.value) || 0;
  }
  return t;
}

// ── La comisión de una guía MANUAL: la tarifa de la ruta del embarque ───────────────────────────
//
// Misma fórmula que la del viaje de Kepler (`comisionesDeLaGuia`), pero con UNA ruta: la que el
// embarque manual tiene asignada. Sin ruta, o con la ruta sin tarifa, no se crea la guía.

/** La ruta del embarque con su tarifa, como la guarda `logistics.routes`. */
export interface TarifaDeRuta {
  route_id: string;
  nombre: string;
  driver: number | null;
  helper: number | null;
}

export function erroresDeTarifaDeRuta(
  ruta: TarifaDeRuta | null,
  ayudantes: { helper1: boolean; helper2: boolean },
): string[] {
  if (!ruta) return ['El embarque no tiene ruta: sin ruta no se calcula la comisión.'];
  const e: string[] = [];
  if (!((ruta.driver ?? 0) > 0)) e.push(`${ruta.nombre} no tiene tarifa de chofer en ${DONDE_SE_CAPTURA_LA_TARIFA}.`);
  if ((ayudantes.helper1 || ayudantes.helper2) && !((ruta.helper ?? 0) > 0)) {
    e.push(`${ruta.nombre} no tiene tarifa de ayudante en ${DONDE_SE_CAPTURA_LA_TARIFA}.`);
  }
  return e;
}

/** Errores de la tripulación de una guía, en lenguaje del usuario. Igual en la hoja y en la guía manual. */
export function erroresDeTripulacion(t: { driver_id: string | null; helper1_id: string | null; helper2_id: string | null }): string[] {
  const e: string[] = [];
  if (!t.driver_id) e.push('Elige al chofer.');
  if (t.driver_id && (t.helper1_id === t.driver_id || t.helper2_id === t.driver_id)) {
    e.push('El chofer no puede ir también como ayudante.');
  }
  if (t.helper1_id && t.helper1_id === t.helper2_id) e.push('Ayudante 1 y ayudante 2 son la misma persona.');
  if (t.helper2_id && !t.helper1_id) e.push('Captura primero al ayudante 1.');
  return e;
}

/** Lo que el coordinador elige en una guía manual (sin montos: ésos se calculan). */
export interface CapturaDeGuia {
  driver_id?: string | null;
  helper1_id?: string | null;
  helper2_id?: string | null;
  departure_time?: string | null;
  arrival_time?: string | null;
  overnight?: boolean | null;
}

/**
 * Todo lo que impide crear una guía manual, en el orden en que se ve en pantalla. Lo usan el
 * diálogo (para apagar el botón y decir qué falta) y la API (400): la misma lista en los dos.
 */
export function erroresDeGuiaManual(c: CapturaDeGuia, ruta: TarifaDeRuta | null, tarifas: TarifasViatico): string[] {
  const t = { driver_id: c.driver_id || null, helper1_id: c.helper1_id || null, helper2_id: c.helper2_id || null };
  return [
    ...erroresDeTripulacion(t),
    ...erroresDeTarifaDeRuta(ruta, { helper1: !!t.helper1_id, helper2: !!t.helper2_id }),
    ...erroresDeViaticos({ salida: c.departure_time ?? null, llegada: c.arrival_time ?? null, duerme_fuera: !!c.overnight }, tarifas),
  ];
}
