/**
 * Fase RH · frente NE · `[NE.1.3]` — EL SOBRE AL BILLETE, Y EL RESIDUO QUE NADIE NOMBRA.
 *
 * ── Lo medido en el sistema actual (sólo lectura, 2026-11-23) ───────────────────────────────
 *  · Las denominaciones que el sistema registra son: billetes de 1000, 500, 200, 100, 50 y 20;
 *    monedas de 100, 20, 10, 5, 2, 1 y **0.50**. ⛔ **No hay moneda de 10, 20 ni 5 centavos.**
 *  · El efectivo a pagar se calcula **al centavo**: en 927 recibos con efectivo desde octubre,
 *    **737 (79.5 %) no son múltiplo de 50 centavos**. Armar el sobre exacto es **físicamente
 *    imposible** en cuatro de cada cinco casos — no es un error de quien lo arma.
 *  · Y así sale: de 926 sobres armados, **sólo 188 (20.3 %) suman exacto** lo exigible. Las
 *    diferencias son casi siempre de menos de 50 centavos (−46, +4, −3, −15…). En dos meses
 *    derivan **25,594 centavos**.
 *
 * → Lo que este módulo cambia **no es el monto: es que el residuo tenga nombre**. Hoy cada semana
 *   cada persona recibe unos centavos de más o de menos y **nadie lo registra**. Acá el sobre
 *   devuelve siempre `residuoCentavos`, y quien lo use tiene que decidir qué hacer con él — lo que
 *   no puede es no verlo.
 *
 * ⛔ Este módulo **no decide la política** del residuo (arrastrarlo, redondear siempre a favor de
 * la persona, absorberlo). Eso es una decisión de negocio; acá sólo se calcula y se nombra.
 */

import type { Centavos } from './recibo';

/** La moneda más chica que existe en el sobre. Todo lo que no sea múltiplo de esto no es pagable. */
export const MONEDA_MINIMA_CENTAVOS = 50;

/** Denominaciones reales, en centavos, de mayor a menor. */
export const DENOMINACIONES: readonly { readonly clave: string; readonly centavos: Centavos; readonly tipo: 'billete' | 'moneda' }[] = [
  { clave: 'b1000', centavos: 100_000, tipo: 'billete' },
  { clave: 'b500', centavos: 50_000, tipo: 'billete' },
  { clave: 'b200', centavos: 20_000, tipo: 'billete' },
  { clave: 'b100', centavos: 10_000, tipo: 'billete' },
  { clave: 'b50', centavos: 5_000, tipo: 'billete' },
  { clave: 'b20', centavos: 2_000, tipo: 'billete' },
  { clave: 'm100', centavos: 10_000, tipo: 'moneda' },
  { clave: 'm20', centavos: 2_000, tipo: 'moneda' },
  { clave: 'm10', centavos: 1_000, tipo: 'moneda' },
  { clave: 'm5', centavos: 500, tipo: 'moneda' },
  { clave: 'm2', centavos: 200, tipo: 'moneda' },
  { clave: 'm1', centavos: 100, tipo: 'moneda' },
  { clave: 'm50c', centavos: 50, tipo: 'moneda' },
];

const POR_CLAVE = new Map(DENOMINACIONES.map((d) => [d.clave, d]));

/** Cuántas piezas de cada denominación. Las claves son las de `DENOMINACIONES`. */
export type PiezasDelSobre = Readonly<Record<string, number>>;

export class SobreInvalido extends Error {}

export interface Sobre {
  readonly piezas: PiezasDelSobre;
  /** Lo que el sobre realmente contiene. */
  readonly entregadoCentavos: Centavos;
  /** Lo que se debía entregar. */
  readonly exigibleCentavos: Centavos;
  /**
   * ⭐ Lo que NO se puede entregar en monedas: `exigible − entregado`, siempre entre 0 y 49.
   * Que sea chico no lo hace cero. Medido: pasa en el 79.5 % de los recibos con efectivo.
   */
  readonly residuoCentavos: Centavos;
}

function exigeEnteroNoNegativo(v: unknown, dónde: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new SobreInvalido(`${dónde}: se esperaba un entero no negativo, llegó ${JSON.stringify(v)}`);
  }
  return v;
}

/** Lo que de verdad se puede poner en un sobre: el múltiplo de 50 centavos inmediato inferior. */
export function pagableEnMonedas(centavos: Centavos): Centavos {
  exigeEnteroNoNegativo(centavos, 'pagableEnMonedas');
  return centavos - (centavos % MONEDA_MINIMA_CENTAVOS);
}

/** Los centavos que ninguna moneda puede cubrir. Entre 0 y 49. */
export function residuoNoPagable(centavos: Centavos): Centavos {
  exigeEnteroNoNegativo(centavos, 'residuoNoPagable');
  return centavos % MONEDA_MINIMA_CENTAVOS;
}

export function sumaDelSobre(piezas: PiezasDelSobre): Centavos {
  return Object.entries(piezas).reduce((total, [clave, cantidad]) => {
    const den = POR_CLAVE.get(clave);
    if (!den) throw new SobreInvalido(`denominación desconocida: ${JSON.stringify(clave)}`);
    return total + den.centavos * exigeEnteroNoNegativo(cantidad, `piezas de ${clave}`);
  }, 0);
}

/**
 * Propone el sobre para un importe: de la denominación más grande a la más chica, como lo arma una
 * persona. ⚠️ Es una PROPUESTA: quien entrega puede no tener esas piezas. El sobre que se registra
 * es el que se armó de verdad — por eso existe `verificaSobre`.
 */
export function armaSobre(exigibleCentavos: Centavos): Sobre {
  exigeEnteroNoNegativo(exigibleCentavos, 'armaSobre');
  let resto = pagableEnMonedas(exigibleCentavos);
  const piezas: Record<string, number> = {};
  // Una sola pieza por valor: con billete y moneda del mismo valor (100 y 20), se prefiere el billete.
  const vistos = new Set<Centavos>();
  for (const d of DENOMINACIONES) {
    if (vistos.has(d.centavos)) continue;
    vistos.add(d.centavos);
    const n = Math.floor(resto / d.centavos);
    if (n > 0) {
      piezas[d.clave] = n;
      resto -= n * d.centavos;
    }
  }
  /* c8 ignore next */
  if (resto !== 0) throw new SobreInvalido(`no se pudo armar el sobre: quedaron ${resto} centavos sin denominación`);
  const entregadoCentavos = pagableEnMonedas(exigibleCentavos);
  return {
    piezas,
    entregadoCentavos,
    exigibleCentavos,
    residuoCentavos: residuoNoPagable(exigibleCentavos),
  };
}

export interface CuadreDelSobre {
  readonly cuadra: boolean;
  readonly entregadoCentavos: Centavos;
  readonly exigibleCentavos: Centavos;
  /** entregado − exigible. Negativo = se entregó de menos. */
  readonly diferenciaCentavos: Centavos;
  /** Si la diferencia se explica sola por no existir moneda chica. */
  readonly esSoloResiduo: boolean;
}

/**
 * Mide un sobre ya armado contra lo exigible, sin lanzar. Es la puerta del espejo: separa la
 * diferencia **estructural** (no hay moneda de menos de 50 centavos) de la que hay que explicar.
 */
export function verificaSobre(piezas: PiezasDelSobre, exigibleCentavos: Centavos): CuadreDelSobre {
  exigeEnteroNoNegativo(exigibleCentavos, 'verificaSobre');
  const entregadoCentavos = sumaDelSobre(piezas);
  const diferenciaCentavos = entregadoCentavos - exigibleCentavos;
  return {
    cuadra: diferenciaCentavos === 0,
    entregadoCentavos,
    exigibleCentavos,
    diferenciaCentavos,
    esSoloResiduo: diferenciaCentavos === -residuoNoPagable(exigibleCentavos) && diferenciaCentavos !== 0,
  };
}
