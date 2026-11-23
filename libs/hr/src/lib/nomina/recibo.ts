/**
 * Fase RH · frente NE · `[NE.1.1]` — LA ARITMÉTICA DEL RECIBO, COMO REGLA.
 *
 * Cierra el patrón C2 de `FASE_RH_FRENTE_NE_DISENO.md`: «dinero entregado sin concepto». No lo
 * cierra con una validación de pantalla —ésas se saltean— sino con la **forma del tipo**: un recibo
 * no existe si lo entregado no es exactamente la suma de sus conceptos.
 *
 * ── Lo medido en el sistema actual (sólo lectura, 2026-11-23) ───────────────────────────────
 *  · La identidad se cumple en **252 de 254** recibos de la última semana cerrada:
 *      lo entregado (banco + efectivo) = sueldo + horas extra + ajustes a favor − ajustes en contra.
 *  · Los **2 que fallan** entregan efectivo de más **sin ningún concepto que lo explique**. Con este
 *    modelo no se pueden construir: faltaría el concepto, y el error dice cuánto y de qué lado.
 *  · ⛔ El sistema actual suma en **punto flotante**: un total semanal sale como
 *    `519937.59999999788`. Acá el dinero son **centavos enteros**; los pesos sólo existen al
 *    entrar y al salir. Un centavo perdido por redondeo es un centavo que alguien no cobró.
 *  · Los conceptos de despensa, puntualidad y asistencia **van DENTRO** de lo devengado, no se
 *    suman aparte: en el año, lo devengado ≈ lo entregado, y esos tres suman la mitad de ese total.
 *    Modelarlos como sumandos adicionales duplicaría medio sueldo.
 *
 * Dos puertas, a propósito:
 *  · `armaRecibo` es **estricta** — es la que usa el sistema nuevo y no deja pasar un descuadre.
 *  · `cuadreDeRecibo` **no lanza** — es la que mide el sistema viejo durante el espejo (Etapa 1),
 *    donde el descuadre es justamente lo que queremos contar, no una excepción que corte la corrida.
 */

/** Dinero: centavos enteros. Nunca un `number` con decimales. */
export type Centavos = number;

export class ReciboInvalido extends Error {}

/** Lo que un concepto le hace al total. */
export type SignoConcepto = 'devenga' | 'descuenta';

/** Conceptos que no se pueden registrar sin decir por qué. Medido: son los que varían semana a semana. */
const EXIGEN_MOTIVO = new Set(['ajuste_mas', 'ajuste_menos']);

export interface ConceptoDelRecibo {
  /** `sueldo`, `horas_extra`, `ajuste_mas`, `ajuste_menos`, … en snake_case. */
  readonly clave: string;
  /** Siempre positivo. El signo lo dice `signo`, no el número: un importe negativo esconde su intención. */
  readonly importe: Centavos;
  readonly signo: SignoConcepto;
  readonly motivo?: string;
}

export type FormaDePago = 'banco' | 'efectivo';

export interface EntregaDelRecibo {
  readonly forma: FormaDePago;
  readonly importe: Centavos;
}

export interface Recibo {
  readonly conceptos: readonly ConceptoDelRecibo[];
  readonly entregas: readonly EntregaDelRecibo[];
  readonly totalCentavos: Centavos;
}

const RE_CLAVE = /^[a-z][a-z0-9_]*$/;

function exigeEntero(importe: unknown, dónde: string): Centavos {
  if (typeof importe !== 'number' || !Number.isInteger(importe)) {
    throw new ReciboInvalido(`${dónde}: el dinero son centavos enteros, llegó ${JSON.stringify(importe)}`);
  }
  if (importe < 0) {
    throw new ReciboInvalido(`${dónde}: el importe es positivo y el signo va aparte, llegó ${importe}`);
  }
  return importe;
}

/** Pesos → centavos, redondeando una sola vez y en el borde. */
export function pesosACentavos(pesos: number): Centavos {
  if (typeof pesos !== 'number' || !Number.isFinite(pesos)) {
    throw new ReciboInvalido(`no es un importe en pesos: ${JSON.stringify(pesos)}`);
  }
  return Math.round(pesos * 100);
}

/** Centavos → pesos, sólo para mostrar o para escribir un archivo. Nunca para seguir sumando. */
export function centavosAPesos(centavos: Centavos): number {
  return exigeEntero(centavos, 'centavosAPesos') / 100;
}

export function totalDevengado(conceptos: readonly ConceptoDelRecibo[]): Centavos {
  return conceptos.reduce((suma, c) => {
    const importe = exigeEntero(c.importe, `concepto ${c.clave}`);
    return c.signo === 'devenga' ? suma + importe : suma - importe;
  }, 0);
}

export function totalEntregado(entregas: readonly EntregaDelRecibo[]): Centavos {
  return entregas.reduce((suma, e) => suma + exigeEntero(e.importe, `entrega por ${e.forma}`), 0);
}

export interface CuadreDelRecibo {
  readonly cuadra: boolean;
  readonly devengadoCentavos: Centavos;
  readonly entregadoCentavos: Centavos;
  /** entregado − devengado. Positivo = se entregó de más. */
  readonly diferenciaCentavos: Centavos;
}

/**
 * Mide sin lanzar. Es la puerta del espejo (Etapa 1): sobre el sistema viejo el descuadre es el
 * dato, no un accidente. ⛔ No usar para construir un recibo nuevo — para eso está `armaRecibo`.
 */
export function cuadreDeRecibo(
  conceptos: readonly ConceptoDelRecibo[],
  entregas: readonly EntregaDelRecibo[],
): CuadreDelRecibo {
  const devengadoCentavos = totalDevengado(conceptos);
  const entregadoCentavos = totalEntregado(entregas);
  const diferenciaCentavos = entregadoCentavos - devengadoCentavos;
  return { cuadra: diferenciaCentavos === 0, devengadoCentavos, entregadoCentavos, diferenciaCentavos };
}

/**
 * Construye un recibo o explica por qué no se puede. Un recibo que no cuadra **no existe**: no hay
 * forma de guardarlo y arreglarlo después, que es como el sistema viejo terminó entregando dinero
 * sin concepto.
 */
export function armaRecibo(
  conceptos: readonly ConceptoDelRecibo[],
  entregas: readonly EntregaDelRecibo[],
): Recibo {
  if (!conceptos.length) throw new ReciboInvalido('un recibo sin conceptos no es un recibo');
  if (!entregas.length) throw new ReciboInvalido('un recibo sin entrega no es un recibo');

  const vistas = new Set<string>();
  for (const c of conceptos) {
    if (!RE_CLAVE.test(c.clave)) throw new ReciboInvalido(`clave de concepto inválida: ${JSON.stringify(c.clave)}`);
    exigeEntero(c.importe, `concepto ${c.clave}`);
    if (c.signo !== 'devenga' && c.signo !== 'descuenta') {
      throw new ReciboInvalido(`concepto ${c.clave}: signo inválido ${JSON.stringify(c.signo)}`);
    }
    if (EXIGEN_MOTIVO.has(c.clave) && !c.motivo?.trim()) {
      throw new ReciboInvalido(`concepto ${c.clave}: exige motivo — un ajuste sin motivo no se puede auditar después`);
    }
  }
  for (const e of entregas) {
    if (e.forma !== 'banco' && e.forma !== 'efectivo') {
      throw new ReciboInvalido(`forma de pago inválida: ${JSON.stringify(e.forma)}`);
    }
    if (vistas.has(e.forma)) throw new ReciboInvalido(`la entrega por ${e.forma} aparece dos veces`);
    vistas.add(e.forma);
    exigeEntero(e.importe, `entrega por ${e.forma}`);
  }

  const { cuadra, devengadoCentavos, entregadoCentavos, diferenciaCentavos } = cuadreDeRecibo(conceptos, entregas);
  if (devengadoCentavos < 0) {
    throw new ReciboInvalido(`los descuentos superan lo devengado por ${-devengadoCentavos} centavos`);
  }
  if (!cuadra) {
    const lado = diferenciaCentavos > 0 ? 'de más' : 'de menos';
    throw new ReciboInvalido(
      `el recibo no cuadra: se entregan ${Math.abs(diferenciaCentavos)} centavos ${lado} ` +
        `(devengado ${devengadoCentavos}, entregado ${entregadoCentavos}). ` +
        `Falta el concepto que lo explique.`,
    );
  }
  return { conceptos: [...conceptos], entregas: [...entregas], totalCentavos: devengadoCentavos };
}

/** Cuánto de este recibo sale en efectivo. Lo usa el armado del sobre (`[NE.1.3]`). */
export function efectivoDelRecibo(r: Recibo): Centavos {
  return r.entregas.find((e) => e.forma === 'efectivo')?.importe ?? 0;
}
