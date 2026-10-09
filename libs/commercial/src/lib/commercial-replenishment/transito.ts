/**
 * `[RA.TR]` — **Cuánto del tránsito se descuenta del pedido, decidido en UN solo lugar.**
 *
 * Pedido de Edgar (2026-10-08): *"ignoremos en transito ya que hay muchas ordenes que no cumplen
 * o se ignoran"*.
 *
 * ---
 *
 * ## Por qué este archivo existe
 *
 * Antes de esta fase, **seis expresiones distintas** restaban el tránsito, cada una escrita a mano
 * en su propia consulta: la matriz, el desglose por sucursal, el drill por producto, los dos
 * resúmenes, el escáner de hallazgos y el diálogo "En camino". Mover una sola dejaba a la tabla
 * contradiciendo a su propio detalle — el comprador vería un sugerido en la fila y otro al abrirla,
 * sin ningún error de por medio. La única forma de que no se separen es que **no haya seis
 * expresiones**.
 *
 * ⛔ Si agregás un lugar nuevo que reste tránsito, se llama a {@link transitoDescontado}. El
 * candado `transito.spec.ts` recorre los fuentes de esta carpeta y se pone **rojo** si aparece una
 * resta escrita a mano.
 *
 * ---
 *
 * ## Lo que se midió antes de decidir (2026-10-08, contra prod)
 *
 * El motor **ya ignoraba la mayor parte del tránsito**, y no por decreto sino por evidencia: la
 * curva `analytics.oc_survival_curve` se deriva del ODS en cada corrida y pesa cada OC por la
 * probabilidad de que llegue, dada su edad.
 *
 * | lo que hay en papel | lo que el motor ya ignoraba | lo que todavía descontaba |
 * |---|---|---|
 * | $60,272,454 | $42,655,515 (70.8% en pesos · **82.5% en cajas**) | $17,616,939 |
 *
 * Y las 394 OC abiertas ($36.8 M) le dan la razón a la premisa del pedido en su parte más fuerte:
 *
 * | antigüedad | OCs | pesos | P(llega) según la curva |
 * |---|---:|---:|---:|
 * | 0-3 días   |  20 | $4.86 M | **86.2%** |
 * | 4-7        |  18 | $1.75 M | 76.3% |
 * | 8-14       |  36 | $5.64 M | 66.0% |
 * | 15-21      |  32 | $2.36 M | 53.4% |
 * | 22-30      |  41 | $3.21 M | 43.9% |
 * | 31-45      |  55 | $4.79 M | 20.3% |
 * | 46-60      |  41 | $6.44 M | 11.3% |
 * | **+60**    | **151** | **$7.78 M** | **9.8%** |
 *
 * ⭐ **151 de 394 OC (38%) llevan más de 60 días abiertas** — eso es exactamente "órdenes que no
 * cumplen", y la curva, que nadie calibró a mano, ya las descartaba casi enteras.
 *
 * ⚠️ **Lo que esta decisión cambia de verdad** son las **38 OC de menos de 7 días ($6.6 M)**, donde
 * la curva da 76-86%. Ésas sí llegan, y al dejar de descontarlas el motor va a sugerir otra vez lo
 * que entra esta semana. Es una compra doble **conocida y aceptada**: se eligió a cambio de no
 * quedarse corto por papeles que nadie cerró.
 *
 * ---
 *
 * ## Lo que NO cambia
 *
 * El tránsito **se sigue MOSTRANDO**. La columna "En camino" y el diálogo de folios siguen ahí, y
 * con esta política pasan a mostrar el **crudo** — el papel, tal cual, sin pesar. Antes mostraban
 * la cifra pesada mientras su propio comentario afirmaba que mostraban la cruda, así que la columna
 * nunca cuadró con los folios que lista el diálogo; ahora sí.
 *
 * ⭐ Ésa es la compensación de fondo: el motor deja de decidir por el comprador, y a cambio le pone
 * enfrente el dato completo para que decida él.
 *
 * ---
 *
 * ## Cómo se revierte
 *
 * Una línea: {@link POLITICA_TRANSITO}. Las tres opciones leen la misma columna del fact, así que
 * volver atrás no necesita recalcular nada ni volver a correr un importer.
 */

/**
 * - `'ignorar'` — el tránsito NO se resta. El sugerido sale como si no hubiera nada en camino.
 * - `'curva'` — se resta pesado por P(llega | edad de la OC), derivado del ODS. Era el comportamiento
 *   anterior a 2026-10-09 (RA-PRO.45).
 * - `'crudo'` — se resta entero, como si toda OC en papel fuera a llegar. Es el comportamiento
 *   original de RA.5, el que la curva vino a corregir. Queda sólo para poder comparar.
 */
export type PoliticaTransito = 'ignorar' | 'curva' | 'crudo';

/**
 * ⭐ **La decisión, en una línea.** Cambiar este valor cambia los seis sitios a la vez.
 *
 * Decidido por Edgar el 2026-10-08 y ratificado el 2026-10-09 después de ver las 394 OC abiertas.
 */
export const POLITICA_TRANSITO: PoliticaTransito = 'ignorar';

/**
 * La expresión SQL de **lo que se le RESTA al sugerido**.
 *
 * @param eff   columna con las cajas ya pesadas por la curva (p. ej. `rpl.transit_eff_cajas`)
 * @param crudo columna con las cajas en papel (p. ej. `rpl.transit_cajas`)
 *
 * ⚠️ Devuelve siempre una expresión **no nula**: quien la llama la resta directo, y un NULL en una
 * resta anula el renglón entero. Con la política vigente devuelve el literal `0`, que es válido en
 * cualquier contexto donde entraba la expresión anterior — incluida una agregada.
 */
export function transitoDescontado(eff: string, crudo: string, politica: PoliticaTransito = POLITICA_TRANSITO): string {
  switch (politica) {
    case 'ignorar': return '0';
    case 'curva':   return `COALESCE(${eff}, ${crudo}, 0)`;
    case 'crudo':   return `COALESCE(${crudo}, 0)`;
  }
}

/**
 * La expresión SQL de **lo que se le MUESTRA al comprador**.
 *
 * Siempre el crudo, en las tres políticas: es el papel que él puede ir a buscar por folio. La única
 * cifra que tiene que cuadrar con el diálogo "En camino" es ésta.
 */
export function transitoMostrado(crudo: string): string {
  return `COALESCE(${crudo}, 0)`;
}

/**
 * Lo que la pantalla le dice al comprador sobre esta política, en sus palabras. Viaja en la
 * respuesta para que el motivo esté **donde está el número**, y no sólo en este archivo.
 *
 * ADR-056: lo que el motor decidió no usar se DECLARA; callarlo haría que una OC en camino se lea
 * como un descuido del sugerido.
 */
export const AVISO_TRANSITO: Record<PoliticaTransito, string> = {
  ignorar: 'El sugerido NO descuenta las OC en camino: 151 de 394 llevan mas de 60 dias abiertas. Revisa la columna En camino antes de pedir.',
  curva:   'El sugerido descuenta las OC en camino pesadas por la probabilidad de que lleguen, segun su antiguedad.',
  crudo:   'El sugerido descuenta las OC en camino completas, como si todas fueran a llegar.',
};
