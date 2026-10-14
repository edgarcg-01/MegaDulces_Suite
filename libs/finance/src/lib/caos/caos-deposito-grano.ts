import { leerVentaDeRuta, fechaDeVentaDeclarada } from '../caja/caja-ruta.engine';

/**
 * ⭐⭐ `[CG.58.6]` — **Qué GRANO declara el texto de un depósito de la caja fuerte.**
 *
 * ── Por qué un grano y no una fecha ─────────────────────────────────────────────────────────
 *
 * El pedido era *"el 38.1% hay que cazarlo por monto y fecha"*. Se intentó y **no funciona**, y
 * quedó medido con un conjunto de respuestas conocidas: a los 551 depósitos que SÍ declaran su
 * fecha se les escondió, y se corrió el cazador por importe contra la venta de su ruta en la
 * ventana `[día−6, día]`:
 *
 *     tolerancia   acierta   se equivoca   ambiguo   sin candidato
 *        $10          59          5           2          485
 *        $50         155          8           6          382
 *       $200         195         28          31          297
 *
 * Aun a $200 recupera el **35%** y ya se equivoca 28 veces. La causa estaba medida de antes: en
 * el agregado el depósito de una ruta iguala su venta (105–112%), pero **día por día no** — un
 * depósito no es un día. El calendario tampoco cierra: la ruta 28 tiene 26 depósitos sin fecha
 * contra 31 días huérfanos, y las otras rutas tienen huérfanos **negativos** (hay depósitos
 * fechados a días que la fuente de venta ni registra).
 *
 * ⇒ El patrón no está en el monto: está en el **grano**. Atribuyendo cada familia al nivel que
 * su texto aguanta, todo cierra:
 *
 *     ruta 28, sumando sus 26 sin fecha   $1,281,650  vs  $1,287,985   **99.5%**
 *     Canindo, a nivel PLAZA (48 dep.)    $3,864,610  vs  $4,059,584   **95.2%**
 *
 * ⛔ **Canindo cierra sin saber cuál de las 501–505, y así se queda.** El texto dice `rd can`;
 * elegir una ruta concreta sería inventar, y una ruta inventada le cobra el depósito a un camión
 * que no fue. El grano `plaza` es exacto; uno más fino sería una suposición con formato de dato.
 *
 * ── Lo que NO hace esta función ─────────────────────────────────────────────────────────────
 *
 * No valida que la ruta exista (eso es del servicio, contra `analytics.v_route_zone` — ver el
 * contrato de `caja-ruta.engine`), no mapea plaza → rutas, y no adivina. Declara lo que el texto
 * declara, y cuando el texto no declara nada lo dice.
 */

/** El nivel al que el texto permite atribuir el depósito. Más fino que esto sería inventar. */
export type GranoDeposito = 'ruta_dia' | 'ruta' | 'plaza' | 'sin_declarar';

export interface DepositoAtribuido {
  grano: GranoDeposito;
  /** Número de ruta tal como lo dice el texto, sin ceros a la izquierda. Null en `plaza`. */
  ruta: string | null;
  /** Plaza normalizada (`canindo` · `morelia`). Null salvo en el grano `plaza`. */
  plaza: string | null;
  /** `YYYY-MM-DD` de la venta. Null salvo en `ruta_dia` — y un null acá se DECLARA, no se rellena. */
  fecha: string | null;
  /** Por qué quedó en ese grano. Va a la fila para que la pantalla no tenga que deducirlo. */
  motivo: string;
}

/**
 * Las plazas que el corpus nombra SIN número de ruta, medidas sobre los 749 depósitos:
 *
 *     canindo   48 depósitos · $3,864,610   (`rd can`, `rd canindo`)
 *     morelia   28 depósitos · $1,309,180   (`rd mor`, `rd morelia`)
 *
 * ⚠️ `ph` NO está: en ese corpus Padre Hidalgo siempre viene con número (`ruta 28 ph`), así que
 * resuelve por ruta y nunca llega acá. Se agrega el día que aparezca, no antes.
 */
const PLAZAS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:rd|ruta)\s*can(?:indo)?\b/i, 'canindo'],
  [/\b(?:rd|ruta)\s*mor(?:elia)?\b/i, 'morelia'],
];

/**
 * ⛔ La vecinal NO entra: es otro circuito y se atribuye aparte. Mismo criterio que
 * `caja-ruta.engine`, y por la misma razón — mezclarla le cobraría a un camión la venta de un
 * vendedor que no lo maneja.
 */
const RX_VECINAL = /\br\.?\s?v\b|\brv\d|ruta\s*vecinal/i;

/**
 * @param ref       el texto que tecleó quien depositó (`caos_cash_movements.ref`)
 * @param capturado el día del depósito, para inferir el año de un `dd/mm` sin año
 */
export function atribuirDeposito(ref: string | null | undefined, capturado: string | Date): DepositoAtribuido {
  const t = String(ref ?? '').trim();
  const vacio: DepositoAtribuido = { grano: 'sin_declarar', ruta: null, plaza: null, fecha: null, motivo: '' };

  if (!t) return { ...vacio, motivo: 'el depósito no trae referencia' };
  if (RX_VECINAL.test(t)) return { ...vacio, motivo: 'es ruta vecinal: otro circuito, se atribuye aparte' };

  // 1 · El grano más fino que existe: la ruta Y el día.
  const d = leerVentaDeRuta(t);
  if (d) {
    const fecha = fechaDeVentaDeclarada(t, capturado);
    if (fecha) {
      return { grano: 'ruta_dia', ruta: d.ruta, plaza: null, fecha, motivo: 'el texto declara ruta y día' };
    }
    /**
     * ⚠️ Camino raro pero real: `leerVentaDeRuta` resolvió las dos mitades y
     * `fechaDeVentaDeclarada` rechazó la fecha (un 31 de febrero, por ejemplo). Se baja de grano
     * en vez de devolver una fecha corrida en silencio.
     */
    return { grano: 'ruta', ruta: d.ruta, plaza: null, fecha: null, motivo: 'la fecha del texto no es una fecha válida' };
  }

  /**
   * 2 · La ruta sola, sin día. Es el caso de los 26 `rd28` que dejaban a la ruta 28 en 67.4%.
   *
   * ⚠️ Lo que se prohíbe después del número son **dígitos**, no letras: si hay más dígitos, el
   * texto intentó declarar una fecha y algo no se entendió, y bajar a `ruta` escondería que hay
   * algo sin leer. Letras sí: `ruta 28 ph` nombra la plaza además de la ruta y sigue declarando
   * la ruta 28 sin ambigüedad.
   *
   * ⛔ La primera versión exigía que el texto TERMINARA en el número y mandaba `ruta 28 ph` a
   * `sin_declarar` — o sea que perdía una ruta perfectamente declarada por culpa de dos letras.
   */
  const mr = t.match(/^\s*(?:ruta|r\.?\s?d\.?|r)\s*0*(\d{2,3})(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+)*\s*$/i);
  if (mr) {
    return { grano: 'ruta', ruta: String(Number(mr[1])), plaza: null, fecha: null, motivo: 'el texto declara la ruta y no el día' };
  }

  // 3 · La plaza, sin saber cuál de sus rutas. Exacto a ese nivel; más fino sería inventar.
  for (const [rx, plaza] of PLAZAS) {
    if (rx.test(t)) {
      return { grano: 'plaza', ruta: null, plaza, fecha: null, motivo: `el texto nombra la plaza (${plaza}) y no la ruta` };
    }
  }

  return { ...vacio, motivo: 'el texto no declara ruta ni plaza' };
}
