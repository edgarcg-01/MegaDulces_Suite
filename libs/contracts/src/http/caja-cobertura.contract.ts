// ⭐⭐ `[CG.183]` LA COBERTURA DE CAJA GENERAL — qué parte del universo explica el número publicado.
//
// ── EL PROBLEMA, MEDIDO ──────────────────────────────────────────────────────────────────────
//
// `list()` calcula sus KPIs **sólo** sobre `finance.cash_ledger` y los publica **sin su
// denominador**. Medido contra prod el 2026-10-14, ventana 01→14-oct:
//
//     capturado        70 movimientos · $  774,890.89
//     por confirmar   549 movimientos · $3,827,485.38
//     cobertura           11.3 % de los movimientos · 16.8 % del dinero
//
// El rótulo «El libro, del X al Y» no miente: dice de dónde sale. Lo que falta es que el agregado
// diga **contra qué**. Un KPI sin denominador no es un número incompleto — es un número que invita
// a leerse como el total.
//
// ── POR QUÉ TRES ESTADOS Y NO UN BOOLEANO ────────────────────────────────────────────────────
//
// Las tres ausencias NO son la misma, y cada una la arregla alguien distinto:
//
//   · `medida`          — hay denominador y se publica.
//   · `no_corresponde`  — hay un filtro que el universo por confirmar no sabe aplicar (cuenta,
//                         búsqueda, «míos»). **Lo arregla quien mira**: quitando el filtro.
//   · `sin_medir`       — el cálculo falló o la frescura no se puede afirmar. **Lo arregla
//                         Sistemas.** Nadie que mire la pantalla puede hacer nada.
//
// ⛔ Con dos valores, el día que el cálculo falle se va a disfrazar de dato. No es hipotético: es
// `[CG.181]`, el 429 publicado como «0 corte(s)», en este mismo archivo y **hoy**. Y es el
// `cfg ? classify : 'ok'` que la Fase VP midió dando verde incondicional a tres matvistas.
//
// ── POR QUÉ `por_confirmar` ES NULLABLE Y NO UN NÚMERO CON DEFAULT ───────────────────────────
//
// ⚠️ El universo por confirmar **no tiene dueño**: son documentos del ERP que nadie capturó
// todavía. Con el filtro «míos» activo, un `0` honesto significaría «ninguno es mío» y se
// publicaría como **100 % de cobertura** — el peor resultado posible, porque es tranquilizador.
// Un `null` no se puede dividir por accidente; un `0` sí.
//
// ── LA FRESCURA ES `Freshness`, NO UN TIMESTAMP ──────────────────────────────────────────────
//
// Un `as_of` no puede decir «no sé», y este módulo **ya fue corregido por eso** en `[CG.141.1]`.
// Además se compone de DOS piernas y gana la peor: el carril del ODS y el refresco del matview.
// Un matview fresco sobre un ODS parado es verde falso.
//
// ⭐ Y hay una razón de aritmética, no sólo de higiene: medido, **139 de 1,308 movimientos del
// universo de 30 días (10.6 %) entraron en las últimas 72 h** — o sea que **un carril parado tres
// días MEJORA la cobertura solo**, porque encoge el denominador. Por eso la regla
// `frescura.stale || unknown ⇒ estado 'sin_medir'` vive del lado del servidor y no de la pantalla:
// es parte de la definición del número, no de cómo se pinta.
//
// ── LA VENTANA VIAJA SIEMPRE CON EL PORCENTAJE ───────────────────────────────────────────────
//
// ⛔ Medido, con el numerador casi quieto (69→71 movimientos), la cobertura da **12.0 % (mes en
// curso) · 5.4 % (30 d) · 3.6 % (45 d) · 2.9 % (un día)**. Una ventana equivocada no se equivoca un
// poco: da cuatro respuestas distintas y todas parecen razonables. Por eso `ventana` es parte del
// contrato y no un detalle de presentación — un porcentaje sin su ventana no es citable.
//
// ── POR QUÉ VIVE ACÁ ─────────────────────────────────────────────────────────────────────────
//
// Lo escribe el servidor, que es quien decide la forma que devuelve, y lo consume la pantalla.
// ⚠️ `apps/view` no puede importar de `@megadulces/finance` —sólo `contracts`, y la compuerta de
// fronteras lo hace cumplir—, así que un tipo que viva en el dominio **se va a re-declarar a
// mano**. Es lo que le pasó a `Freshness`: nació en `libs/commercial` y a los **tres días** estaba
// copiado en `apps/view`. Acá el tipo es uno, y divergir deja de ser posible en vez de improbable.

import { z } from 'zod';
import { Freshness } from './provenance.contract';

/**
 * El veredicto sobre la cobertura. ⛔ **Las dos ausencias se separan a propósito**: `no_corresponde`
 * la resuelve quien mira (quitando un filtro) y `sin_medir` la resuelve Sistemas. Fundirlas en un
 * «no disponible» le pide a la persona equivocada que arregle el problema.
 */
export const CajaCoberturaEstado = z.enum(['medida', 'no_corresponde', 'sin_medir']);
export type CajaCoberturaEstado = z.infer<typeof CajaCoberturaEstado>;

/** Un lado de la cuenta: cuántos movimientos y cuánto dinero. */
export const CajaCoberturaLado = z.object({
  movimientos: z.number().int().nonnegative(),
  /**
   * ⚠️ En pesos, y **siempre `number`**. El repo NO fija `setTypeParser`, así que un `::numeric` de
   * Postgres llega al JSON como **string** y hoy sobrevive sólo porque `money()` hace
   * `Number(v || 0)` en la pantalla. El servidor convierte en el `map`; acá el tipo lo exige.
   * ⛔ Y en SQL va `::numeric`, nunca `::float8`: esto es dinero.
   */
  monto: z.number(),
});
export type CajaCoberturaLado = z.infer<typeof CajaCoberturaLado>;

/**
 * Los filtros que el universo por confirmar **no sabe aplicar**, y por eso vuelven la comparación
 * imposible en vez de incorrecta.
 *
 * ⚠️ `mios` es el más engañoso de los tres: lo por confirmar no tiene dueño, así que el único
 * resultado posible sería `0` — que se leería como cobertura total.
 */
export const CajaCoberturaFiltro = z.enum(['cuenta', 'search', 'mios']);
export type CajaCoberturaFiltro = z.infer<typeof CajaCoberturaFiltro>;

/**
 * Por qué no hay cobertura. ⛔ **Nunca es `null` cuando el estado no es `medida`**: un estado sin
 * motivo obliga a la pantalla a inventar el texto, y ahí es donde las dos ausencias se funden.
 */
export const CajaCoberturaMotivo = z.discriminatedUnion('tipo', [
  z.object({
    tipo: z.literal('filtro'),
    /** ⚠️ TODOS los filtros activos, en orden fijo `cuenta → search → mios`. Nombrar sólo el primero
     *  manda a quitar uno y volver a chocar con el siguiente. */
    filtros: z.array(CajaCoberturaFiltro).min(1),
    texto: z.string().min(1),
  }),
  z.object({
    tipo: z.literal('fallo'),
    /** Qué falló, en palabras accionables. ⛔ Nunca el mensaje crudo de Postgres: esto llega a una
     *  pantalla de captura de efectivo. Misma regla que `[CG.154]`. */
    texto: z.string().min(1),
  }),
]);
export type CajaCoberturaMotivo = z.infer<typeof CajaCoberturaMotivo>;

/**
 * La cobertura de un agregado de Caja General.
 *
 * ⚠️ Los tres estados tienen forma distinta **y el esquema lo exige**, en vez de confiar en que
 * quien lo llene se acuerde:
 *
 *     estado           por_confirmar   motivo
 *     medida           {…}             null
 *     no_corresponde   null            {tipo:'filtro', …}
 *     sin_medir        null            {tipo:'fallo',  …}
 */
export const CajaCobertura = z.object({
  estado: CajaCoberturaEstado,
  /** ⛔ Sale del `from`/`to` que recibió la petición, **nunca** de una ventana fija. Ver arriba. */
  ventana: z.object({ from: z.string(), to: z.string() }),
  capturado: CajaCoberturaLado,
  /** `null` salvo que el estado sea `medida`. Ver por qué no es `0`, arriba. */
  por_confirmar: CajaCoberturaLado.nullable(),
  frescura: Freshness,
  motivo: CajaCoberturaMotivo.nullable(),
}).superRefine((c, ctx) => {
  // ⛔ La coherencia se verifica en el ESQUEMA, no en una convención escrita en un comentario. Un
  // contrato de tres valores se degrada a dos sin que nadie lo note — y el modo en que se degrada
  // es exactamente éste: un `sin_medir` con `por_confirmar` poblado, que la pantalla divide igual.
  if (c.estado === 'medida') {
    if (c.por_confirmar === null) {
      ctx.addIssue({ code: 'custom', path: ['por_confirmar'], message: 'estado `medida` exige `por_confirmar`' });
    }
    if (c.motivo !== null) {
      ctx.addIssue({ code: 'custom', path: ['motivo'], message: 'estado `medida` no lleva motivo' });
    }
    return;
  }
  if (c.por_confirmar !== null) {
    ctx.addIssue({ code: 'custom', path: ['por_confirmar'], message: `estado \`${c.estado}\` no puede traer \`por_confirmar\`` });
  }
  if (c.motivo === null) {
    ctx.addIssue({ code: 'custom', path: ['motivo'], message: `estado \`${c.estado}\` exige motivo` });
  } else if (c.estado === 'no_corresponde' && c.motivo.tipo !== 'filtro') {
    ctx.addIssue({ code: 'custom', path: ['motivo'], message: '`no_corresponde` lleva motivo de tipo `filtro`' });
  } else if (c.estado === 'sin_medir' && c.motivo.tipo !== 'fallo') {
    ctx.addIssue({ code: 'custom', path: ['motivo'], message: '`sin_medir` lleva motivo de tipo `fallo`' });
  }
});
export type CajaCobertura = z.infer<typeof CajaCobertura>;

/**
 * El porcentaje, derivado de los dos lados. `null` cuando no se puede calcular — **nunca `0`**,
 * que se leería como «nada capturado» en vez de «no se sabe».
 *
 * ⚠️ Vive acá y no en cada consumidor porque hay DOS lecturas legítimas (movimientos y dinero) y
 * dan números distintos: 11.3 % contra 16.8 % el 14-oct. Que las dos salgan de la misma función es
 * lo que impide que una pantalla publique una y la otra la otra sin decir cuál.
 */
export function cajaCoberturaPct(c: CajaCobertura, eje: 'movimientos' | 'monto'): number | null {
  if (c.estado !== 'medida' || !c.por_confirmar) return null;
  const n = eje === 'monto' ? c.capturado.monto : c.capturado.movimientos;
  const d = n + (eje === 'monto' ? c.por_confirmar.monto : c.por_confirmar.movimientos);
  if (!(d > 0)) return null;
  return Math.round((n / d) * 1000) / 10;
}
