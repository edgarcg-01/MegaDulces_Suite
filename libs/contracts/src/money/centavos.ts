/**
 * `[LE.2.1]` — **Dinero exacto: centavos enteros (`bigint`), nunca `float`** (Fase LE, regla de
 * banco B6; ADR-103).
 *
 * ── Por qué existe ─────────────────────────────────────────────────────────────────────────
 * El libro de efectivo (`cashbook`) guarda centavos `bigint`. En código el cálculo a centavos
 * estaba repetido a mano en ≥ 10 archivos de `libs/commercial`, cada uno con su `Math.round`. Un
 * `0.1 + 0.2` de JavaScript es `0.30000000000000004`: en una caja eso termina en un centavo que
 * nadie puede explicar. ADR-056: el primitivo vive aquí, una vez.
 *
 * ── Reglas ─────────────────────────────────────────────────────────────────────────────────
 *  · Los pesos ENTRAN como texto (`'1234.50'`): un `number` con decimales ya puede venir mal.
 *  · Los centavos viajan como texto entero (`'123450'`): JSON no tiene `bigint`.
 *  · UN solo punto de redondeo — la conversión de moneda — y es mitad lejos del cero.
 *  · Una llave de denominación desconocida REVIENTA: es dinero que no se puede contar.
 */
import { BILLETES_USD, DENOMINACIONES_MXN, type Denominacion } from './denominations';

export type Moneda = 'MXN' | 'USD';

export class DineroInvalido extends Error {
  constructor(readonly codigo: string, mensaje: string) {
    super(mensaje);
    this.name = 'DineroInvalido';
  }
}

const PESOS = /^(-)?(\d{1,13})(?:\.(\d{1,2}))?$/;
const ENTERO = /^-?\d{1,15}$/;
const TIPO_DE_CAMBIO = /^(\d{1,6})\.(\d{1,6})$/;

/** `'1234.5'` → `123450n`. Más de dos decimales, notación científica o separadores: error. */
export function pesosACentavos(texto: string): bigint {
  const m = PESOS.exec(String(texto).trim());
  if (!m) throw new DineroInvalido('monto_invalido', `«${texto}» no es un monto en pesos con hasta dos decimales`);
  const c = BigInt(m[2]) * 100n + BigInt(((m[3] ?? '') + '00').slice(0, 2));
  return m[1] ? -c : c;
}

/** Centavos que llegan de la base (texto entero) o de código (`bigint`, o `number` entero seguro). */
export function centavos(valor: string | number | bigint): bigint {
  if (typeof valor === 'bigint') return valor;
  if (typeof valor === 'number') {
    if (!Number.isSafeInteger(valor)) throw new DineroInvalido('centavos_invalidos', `${valor} no es un entero de centavos`);
    return BigInt(valor);
  }
  if (!ENTERO.test(valor)) throw new DineroInvalido('centavos_invalidos', `«${valor}» no es un entero de centavos`);
  return BigInt(valor);
}

/** Lo que viaja al libro (`amount_minor`). */
export const centavosATexto = (c: bigint): string => c.toString();

export const sumarCentavos = (xs: readonly bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);

/** `123450n` → `'$1,234.50'` · en dólares `'US$1,234.50'`. Sin pasar nunca por `number`. */
export function formatearDinero(c: bigint, moneda: Moneda = 'MXN'): string {
  const negativo = c < 0n;
  const a = negativo ? -c : c;
  const enteros = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const resto = (a % 100n).toString().padStart(2, '0');
  return `${negativo ? '-' : ''}${moneda === 'USD' ? 'US$' : '$'}${enteros}.${resto}`;
}

/**
 * El ÚNICO punto de redondeo: centavos de una moneda × tipo de cambio → centavos de la otra,
 * mitad lejos del cero. El tipo de cambio viaja como texto (`'18.2500'`) para no perder decimales.
 */
export function convertirMoneda(c: bigint, tipoDeCambio: string): bigint {
  const m = TIPO_DE_CAMBIO.exec(tipoDeCambio);
  if (!m) throw new DineroInvalido('tipo_de_cambio_invalido', `«${tipoDeCambio}» no es un tipo de cambio (n.nnnn)`);
  const escala = 10n ** BigInt(m[2].length);
  const producto = c * BigInt(m[1] + m[2]);
  const cociente = producto / escala;
  const resto = producto % escala;
  if ((resto < 0n ? -resto : resto) * 2n >= escala) return producto < 0n ? cociente - 1n : cociente + 1n;
  return cociente;
}

function catalogo(moneda: Moneda): ReadonlyMap<string, Denominacion> {
  return new Map((moneda === 'USD' ? BILLETES_USD : DENOMINACIONES_MXN).map((d) => [d.key, d]));
}
const CATALOGOS: Record<Moneda, ReadonlyMap<string, Denominacion>> = { MXN: catalogo('MXN'), USD: catalogo('USD') };

/** Cuánto vale una pieza, en centavos. Una llave fuera del catálogo revienta. */
export function valorDePiezaEnCentavos(key: string, moneda: Moneda = 'MXN'): bigint {
  const d = CATALOGOS[moneda].get(String(key));
  if (!d) throw new DineroInvalido('denominacion_fuera_de_catalogo', `${moneda} «${key}» no está en el catálogo`);
  return BigInt(Math.round(d.valor * 100));
}

/** El total de un conteo por denominación (piezas con signo), en centavos. */
export function valorDePiezas(piezas: Readonly<Record<string, number>>, moneda: Moneda = 'MXN'): bigint {
  let total = 0n;
  for (const [k, n] of Object.entries(piezas)) {
    if (!Number.isSafeInteger(n) || n === 0) throw new DineroInvalido('pieza_invalida', `${k} = ${n}: las piezas son enteras y distintas de cero`);
    total += BigInt(n) * valorDePiezaEnCentavos(k, moneda);
  }
  return total;
}
