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
   *
   * ⭐ `nonnegative()` y **NO `positive()`**, y la distinción es de GRANO: el `CHECK` de la base es
   * sobre la FILA (`cash_ledger_monto_chk: monto > 0`, y la vista de la cola filtra `importe > 0`;
   * medido: 0 negativos en 75 filas del libro y en 13,330 de la cola, mínimos \$1.00 y \$0.17).
   * Este contrato describe el **agregado**, y `{ movimientos: 0, monto: 0 }` es un estado
   * perfectamente válido: **la ventana sin nada capturado**, que es lo primero que ve quien abre un
   * día nuevo. Con `positive()` el contrato rechazaría justo ese caso.
   *
   * ⛔ Y se descarta conservar el signo «por si acaso»: modelaría un estado que la base PROHÍBE.
   * Una rama para algo que no puede ocurrir es deuda, no defensa.
   */
  monto: z.number().nonnegative(),
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
  /**
   * ⛔ Sale del `from`/`to` que recibió la petición, **nunca** de una ventana fija. Ver arriba.
   *
   * ⭐ Con FORMA, no `z.string()` pelado — porque hay **tres maneras de romper una ventana y las
   * tres terminan en cero filas**, que es lo que las vuelve indistinguibles entre sí y de «no hubo
   * movimientos»:
   *
   *   · forma inválida  → el `regex`. ⚠️ No es hipotético en este dominio: `pg` devuelve `date`
   *     como **objeto**, y `String(f).slice(0,10)` ya produjo **`"Wed Jan 28"`** acá (por eso
   *     existe el helper `ymd()`); viajaba al front, volvía como `?from=` y Postgres tiraba
   *     `22007`. El `regex` ataja exactamente ese viaje.
   *   · orden invertido → el `superRefine` de abajo. Una ventana al revés tiene **forma perfecta**
   *     y devuelve cero filas: se lee como «no se capturó nada».
   *   · ausencia        → el campo es obligatorio. Opcional, el día que el servidor no la mande el
   *     front compila igual y publica dos cifras sin decir de qué periodo son.
   */
  ventana: z.object({
    /**
     * ⛔ `null` = **no hay periodo que describir**, y es un estado REAL, no un hueco.
     *
     * Cuando no vienen `from`/`to` y el filtro no devuelve nada, `min(fecha)`/`max(fecha)` son
     * NULL: no se contó nada, así que no hay un periodo que se haya contado. Medido y **alcanzable
     * desde la pantalla**: `tipo = 'deposito'` da **0 filas en todo el libro** y el selector lo
     * ofrece; `ingreso` + sucursal `06` también.
     *
     * ⭐ La primera versión ponía `''` ahí, y es justo el defecto que este módulo persigue: un
     * vacío sin motivo es indistinguible de un olvido. Las otras dos salidas también se
     * descartaron — un periodo por default INVENTA un mes que nadie pidió (la cuarta respuesta
     * plausible que `ventana` existe para evitar), y dejar el `''` no pasa el esquema.
     *
     * ⚠️ Es el mismo caso que las tres sesiones pasamos una hora protegiendo con `nonnegative()`
     * —la ventana vacía que ve quien abre un día nuevo— y se nos coló por el otro campo:
     * protegimos el contador y dejamos la fecha.
     */
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha en formato YYYY-MM-DD').nullable(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha en formato YYYY-MM-DD').nullable(),
  }).refine((v) => (v.from === null) === (v.to === null), {
    // Media ventana no existe: o se sabe el periodo o no se sabe. Una punta sola invita a
    // completar la otra con un default.
    message: 'la ventana va completa o va nula, nunca a medias',
    path: ['to'],
  }).refine((v) => v.from === null || v.to === null || v.from <= v.to, {
    // ⚠️ `<=` y NO `<`: la ventana de UN SOLO DÍA es legítima y está medida (`from = to =
    // 2026-10-08` da 1 capturado contra 33 por confirmar). Es el camino de quien revisa el día de
    // un corte concreto desde la liga con `?from=`/`?to=`. Un `<` estricto lo rompería el día que
    // se use en serio — el mismo error de grado que `positive()` sobre un agregado que puede ser 0.
    message: 'la ventana está invertida: `from` es posterior a `to`',
    path: ['from'],
  }),
  capturado: CajaCoberturaLado,
  /** `null` salvo que el estado sea `medida`. Ver por qué no es `0`, arriba. */
  por_confirmar: CajaCoberturaLado.nullable(),
  frescura: Freshness,
  motivo: CajaCoberturaMotivo.nullable(),
}).superRefine((c, ctx) => {
  /**
   * ⛔ **Sin periodo no puede haber movimientos contados.** Es lo que impide que el `null` de la
   * ventana se vuelva una puerta de escape: nace para el único caso en que es verdad —no se contó
   * nada, así que no hay periodo— y acá se sella para que no sirva de comodín cuando alguien no
   * tenga la fecha a mano. Un `null` que se puede poner siempre deja de significar algo.
   */
  if (c.ventana.from === null && c.capturado.movimientos > 0) {
    ctx.addIssue({
      code: 'custom', path: ['ventana'],
      message: 'hay movimientos contados, así que hubo un periodo: la ventana no puede ser nula',
    });
  }
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
/**
 * ⚠️ `[CG.183]` **En qué tramo cayeron DE VERDAD los movimientos contados.** Informativo, y va
 * **aparte de `ventana`** a propósito: *describir no es acotar*.
 *
 * ⛔ Está en el contrato y no suelto en la respuesta por dos razones medidas:
 *
 * 1. `z.object` **descarta las claves desconocidas en silencio** (no es `strict` por default), así
 *    que un campo que el servidor manda y ningún esquema describe **desaparece sin un error** el
 *    día que alguien parsee la respuesta. Un campo que se pierde callado es peor que uno que rompe.
 * 2. Es el defecto de VP.2.1 al revés: allá el front inventaba un tipo que el servidor ya tenía;
 *    acá el servidor mandaría un campo que el front tiene que redeclarar a mano.
 *
 * ⭐ Y merece el mismo rigor que `ventana` **aunque sea informativo, porque es el campo que hizo
 * caer la primera versión**: lo que se publicaba como ventana era justamente esto. Separarlo fue
 * correcto; dejarlo fuera del contrato obligaría al próximo que lea la respuesta a adivinar cuál de
 * los dos describe las cifras — que es el estado del que esta fase salió.
 *
 * ⚠️ `from`/`to` y **no `desde`/`hasta`**: `CLAUDE.md` §Convenciones fija *English snake_case* para
 * los campos de DTO, y un rango de fechas no es un término de dominio sin traducción limpia. Dos
 * vocabularios para el mismo concepto a diez líneas de distancia, y justo entre los dos campos que
 * esta fase existe para no mezclar.
 */
export const CajaPeriodoContado = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha en formato YYYY-MM-DD').nullable(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha en formato YYYY-MM-DD').nullable(),
}).refine((v) => (v.from === null) === (v.to === null), {
  message: 'el periodo contado va completo o va nulo, nunca a medias',
  path: ['to'],
});
export type CajaPeriodoContado = z.infer<typeof CajaPeriodoContado>;

/**
 * ⛔⛔ **LA VENTANA ES LO QUE SE PREGUNTÓ, NO LO QUE CONTESTÓ.**
 *
 * Existe como función —y no como dos `??` en el servicio— porque el defecto que cierra es
 * invisible y vuelve solo. Nombre: **un denominador que se persigue la cola.**
 *
 * La primera versión derivaba la ventana del `min`/`max` de lo capturado. El numerador no llevaba
 * filtro de fecha, pero el denominador sí se acotaba a esa ventana derivada — o sea **al tramo
 * donde el numerador casualmente vive**. Medido en prod el 2026-10-14, sin `from`/`to`:
 *
 *     numerador                           75 movimientos (2026-09-25 → 2026-12-10)
 *     denominador recortado a la derivada     835
 *     denominador real                     13,235
 *     cobertura publicada 8.2 %   ·   cobertura real 0.6 %      ← 15× mejor
 *
 * ⭐ El denominador se encoge hasta alcanzar al numerador, así que **tiende a 100 % por
 * construcción y falla SIEMPRE hacia el lado que tranquiliza** — el peor sesgo posible para un
 * número que existe para inquietar. Y nada se rompe: `8.2 %` es perfectamente plausible.
 *
 * ⚠️ Muerde también el caso lleno: pedir 01→31 sobre un libro que va del 05 al 12 publicaría
 * «ventana 05→12» sobre cifras calculadas en 31 días. Ése es el que nadie va a mirar, porque no
 * revienta.
 *
 * ⛔ `null` significa **«sin límite»**, NUNCA «no se sabe». Son dos ausencias distintas, y es la
 * misma distinción que separa `no_corresponde` de `sin_medir` un campo más arriba. Lo que no se
 * pudo determinar va en `estado: 'sin_medir'`; un `null` de acá dice que la pregunta no tenía tope.
 */
export function ventanaDeCobertura(q: { from?: string | null; to?: string | null }): {
  from: string | null; to: string | null;
} {
  return { from: q.from ?? null, to: q.to ?? null };
}

export function cajaCoberturaPct(c: CajaCobertura, eje: 'movimientos' | 'monto'): number | null {
  if (c.estado !== 'medida' || !c.por_confirmar) return null;
  const n = eje === 'monto' ? c.capturado.monto : c.capturado.movimientos;
  const d = n + (eje === 'monto' ? c.por_confirmar.monto : c.por_confirmar.movimientos);
  if (!(d > 0)) return null;
  return Math.round((n / d) * 1000) / 10;
}
