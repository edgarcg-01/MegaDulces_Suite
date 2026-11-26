import { diaCorto } from '@megadulces/contracts';
import type { TemporadaFila } from './compras.service';

/**
 * `[PQ.95]` La etiqueta del freno de demanda en Pedido (plan PQ §19.3 y §19.15), como funciones puras.
 *
 * Viven fuera del componente para que la regla de «cuál manda» y lo que dice cada texto se puedan
 * probar y romper a propósito (`pedido-freno.spec.ts`). El componente sólo las llama.
 *
 * ⛔ Ley 0: ninguna etiqueta afirma un freno que el número no cumple. La regla de la temporada que dice
 * «no reponer» todavía no baja el sugerido (`[PQ.95.2]`), así que el texto lo dice.
 */

/** Una etiqueta de renglón. `warn` = la regla pide no reponer; `neutro` = explica o avisa. */
export interface EtiquetaFreno { txt: string; tono: 'warn' | 'neutro'; title: string }

/** Una línea de «Qué hacer»: verbo + qué + por qué. */
export interface AccionFreno { verbo: string; que: string; por: string; tono: 'warn' | 'info' }

/** ¿La regla de la temporada pide no reponer HOY? (compra única en venta, pasado el corte, remate). */
export function temporadaNoRepone(t: TemporadaFila): boolean {
  return !t.repone && t.estado !== 'por_iniciar';
}

/** «Padre Hidalgo, Canindo y Morelia Abastos»; con más de `max`, «N sucursales». Siempre por nombre. */
export function listaSucursales(nombres: string[], max = 3): string {
  if (nombres.length > max) return `${nombres.length} sucursales`;
  return nombres.length <= 1 ? (nombres[0] ?? '') : `${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}`;
}

/** «Navidad y posadas · se repone hasta 24-dic». Corto: va en el renglón junto a la clave. */
export function temporadaTxt(t: TemporadaFila): string {
  switch (t.estado) {
    case 'por_iniciar': return `${t.nombre} · empieza ${diaCorto(t.desde)}`;
    case 'en_venta': return t.repone ? `${t.nombre} · se repone hasta ${diaCorto(t.corte)}` : `${t.nombre} · compra única`;
    case 'pasado_el_corte': return `${t.nombre} · pasó el corte`;
    default: return `${t.nombre} · remate`;
  }
}

/** La temporada en una frase, con lo que el sistema HACE con el sugerido. */
export function temporadaTitle(t: TemporadaFila): string {
  const repo = t.reposicion === 'compra_unica' ? 'es compra única' : `se repone hasta el ${diaCorto(t.corte)}`;
  const base = `${t.nombre}, confirmada en Compras › Temporadas: se vende del ${diaCorto(t.desde)} al ${diaCorto(t.hasta)}, ${repo} y el remate empieza el ${diaCorto(t.remate)}.`;
  return temporadaNoRepone(t)
    ? `${base} La regla dice no reponer, pero el sugerido todavía no lo frena: no lo pidas.`
    : `${base} El sugerido no cambia por la temporada.`;
}

/** La línea de «Qué hacer» de la temporada, sólo con lo que el calendario dice. */
export function accionTemporada(t: TemporadaFila): AccionFreno {
  const sinFreno = 'el sugerido todavía no lo frena';
  switch (t.estado) {
    case 'por_iniciar':
      return { verbo: 'Prepara', que: t.nombre, tono: 'info',
        por: `(se vende del ${diaCorto(t.desde)} al ${diaCorto(t.hasta)}${t.reposicion === 'compra_unica' ? '; es compra única' : ''})` };
    case 'en_venta':
      return t.repone
        ? { verbo: 'Repón', que: `sólo hasta el ${diaCorto(t.corte)}`, por: `(${t.nombre}; el remate empieza el ${diaCorto(t.remate)})`, tono: 'info' }
        : { verbo: 'No repongas', que: t.nombre, por: `(es compra única; ${sinFreno})`, tono: 'warn' };
    case 'pasado_el_corte':
      return { verbo: 'No repongas', que: t.nombre, por: `(pasó el corte del ${diaCorto(t.corte)}; ${sinFreno})`, tono: 'warn' };
    default:
      return { verbo: 'Remata', que: t.nombre, por: `(desde el ${diaCorto(t.remate)}; ${sinFreno}: no lo pidas)`, tono: 'warn' };
  }
}

/** La línea de «Qué hacer» del fin de pico, con las sucursales frenadas por nombre. */
export function accionFinPico(frenadas: string[]): AccionFreno | null {
  if (!frenadas.length) return null;
  // Corto a propósito, como sus vecinas en «Qué hacer» (en escritorio la versión larga ocupaba 4 renglones,
  // prueba visual del 2026-11-26). El «40 % de su semana más alta» vive en la marca de cada sucursal.
  return { verbo: 'Se pide menos', que: `en ${listaSucursales(frenadas)}`, tono: 'info',
    por: '(fin de pico: se pide con la venta normal, sin el pico)' };
}

/**
 * La etiqueta del renglón: UNA, la que manda (criterio de §19.3).
 *  1. La temporada cuando su regla ya no deja reponer: es lo que el comprador NO debe hacer.
 *  2. Si no, el fin de pico, que es el que mueve el sugerido; dice EN CUÁLES sucursales.
 *  3. Si no hay pico, la temporada en curso o por iniciar, como aviso.
 * Sin freno, `null`: la etiqueta no decora (criterio 2).
 *
 * @param frenadas nombres de las sucursales donde frenó el fin de pico, en el orden en que se muestran.
 */
export function etiquetaFreno(t: TemporadaFila | null, frenadas: string[]): EtiquetaFreno | null {
  if (t && temporadaNoRepone(t)) return { txt: temporadaTxt(t), tono: 'warn', title: temporadaTitle(t) };
  if (frenadas.length) {
    const donde = frenadas.length === 1 ? frenadas[0] : `${frenadas.length} sucursales`;
    return {
      txt: `fin de pico · ${donde}`, tono: 'neutro',
      title: `Fin de pico en ${listaSucursales(frenadas, 9)}: la venta de 30 días trae un pico que ya pasó (la semana pasada vendió menos del 40 % de su semana más alta), y el motor pide con la venta normal.${t ? ` Además: ${temporadaTitle(t)}` : ''} Abre el producto para ver cada sucursal.`,
    };
  }
  return t ? { txt: temporadaTxt(t), tono: 'neutro', title: temporadaTitle(t) } : null;
}

/** La marca de UNA sucursal frenada, con su evidencia en la unidad de la fila. */
export function finPicoSucursalTitle(sucursal: string, vta30: number, fp: number, unidad: string): string {
  const f = (v: number) => (Math.round(v * 10) / 10).toLocaleString('es-MX');
  return `En ${sucursal} la venta de 30 días (${f(vta30)} ${unidad}) trae un pico que ya pasó: la semana pasada vendió menos del 40 % de su semana más alta. `
    + `El motor pide con la venta normal: ≈${f(vta30 * fp)} ${unidad} al mes, el ${Math.round(fp * 100)} % de la de 30 días.`;
}
