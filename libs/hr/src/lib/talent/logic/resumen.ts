import {
  HR_TALENT_META_HORAS, HR_TALENT_SIN_CIUDAD, type HrResumenReclutamientoDto, type HrTalentEtapa,
} from '@megadulces/contracts';
import { ciudadDelCatalogo } from '../bot/registro';
import { CIUDADES } from '../bot/orientacion';
import { DESENLACES, ETAPAS_VIGENTES, etapaDe } from './etapas';

/**
 * Fase RH · `[RH.8.1]` — el RESUMEN del reclutamiento: quién está en proceso, en qué etapa y de qué ciudad (el
 * «concentrado» de Mega Talento, reducido a la pregunta que RH hace a diario).
 *
 * La CIUDAD sale de la misma regla que usa el bot (`ciudadDelCatalogo`): la ciudad que escribió la persona es texto
 * libre (unas 280 variantes medidas el 9-nov: «Morelia, Michoacán», «En morelia», correos…). Lo que no se reconoce, o
 * nombra dos ciudades («La Piedad o Santa Ana»), NO se adivina: va a «sin ciudad» y se dice cuántos y por qué.
 *
 * El tiempo se mide desde la última actividad (o el alta): la misma base que la marca de «atrasado» de la lista de
 * Candidatos (`rebasaSla`). Y se separan dos cosas que, juntas, no dicen nada:
 *  · REZAGO — sin movimiento hace más de `REZAGO_DIAS`: casos que nadie cerró. Medido el 9-nov con los datos de Mega
 *    Talento: «fuera de meta» a secas daba 1,285 de 1,288 en Filtro y 954 de 956 en Aptitudes — Mega Talento casi nunca
 *    llenaba la última actividad (vacía en 2,690 de 2,843) y nadie cierra candidatos (0 rechazados): todo se veía atrasado.
 *  · FUERA DE META — de los que SÍ se mueven, quién lleva más que la meta de su etapa: ahí se atora el proceso hoy.
 */

const ORDEN: HrTalentEtapa[] = [...ETAPAS_VIGENTES, ...DESENLACES];

/** Más de esto sin movimiento ya no es atraso: es un caso que nadie cerró. */
export const REZAGO_DIAS = 30;

export interface FilaResumen { city_branch: string | null; stage: string | null; desde: string | Date | null }

/** La ciudad con la que se agrupa un texto libre: una del catálogo, o `sin_ciudad`. */
export function ciudadDe(texto: string | null | undefined): string {
  return ciudadDelCatalogo(texto) ?? HR_TALENT_SIN_CIUDAD;
}

export function resumenReclutamiento(filas: FilaResumen[], ahora: Date = new Date()): HrResumenReclutamientoDto {
  const vacioEtapas = (): Record<HrTalentEtapa, number> =>
    Object.fromEntries(ORDEN.map((e) => [e, 0])) as Record<HrTalentEtapa, number>;
  const porCiudad = new Map<string, Record<HrTalentEtapa, number>>();
  for (const c of [...CIUDADES.map((x) => x.etiqueta), HR_TALENT_SIN_CIUDAD]) porCiudad.set(c, vacioEtapas());
  const etapas = new Map<HrTalentEtapa, { total: number; fuera: number; rezago: number }>(ORDEN.map((e) => [e, { total: 0, fuera: 0, rezago: 0 }]));
  const sin = { vacia: 0, no_reconocida: 0 };

  for (const f of filas) {
    const etapa = etapaDe(f.stage);
    const ciudad = ciudadDe(f.city_branch);
    if (ciudad === HR_TALENT_SIN_CIUDAD) {
      if (!f.city_branch || !String(f.city_branch).trim()) sin.vacia++; else sin.no_reconocida++;
    }
    (porCiudad.get(ciudad) as Record<HrTalentEtapa, number>)[etapa]++;
    const e = etapas.get(etapa) as { total: number; fuera: number; rezago: number };
    e.total++;
    // Los desenlaces (contratado, rechazado) terminaron: ni meta ni rezago.
    const meta = HR_TALENT_META_HORAS[etapa];
    const t = f.desde ? new Date(f.desde).getTime() : NaN;
    if (!meta || Number.isNaN(t)) continue;
    const horas = (ahora.getTime() - t) / 3600000;
    if (horas > REZAGO_DIAS * 24) e.rezago++;
    else if (horas > meta) e.fuera++;
  }

  return {
    total: filas.length,
    ciudades: [...porCiudad.entries()].map(([ciudad, por_etapa]) => ({
      ciudad, por_etapa, total: Object.values(por_etapa).reduce((a, b) => a + b, 0),
    })),
    etapas: ORDEN.map((etapa) => {
      const e = etapas.get(etapa) as { total: number; fuera: number; rezago: number };
      return { etapa, total: e.total, rezago: e.rezago, fuera_de_meta: HR_TALENT_META_HORAS[etapa] ? e.fuera : null };
    }),
    rezago_dias: REZAGO_DIAS,
    sin_ciudad: sin,
  };
}
