/**
 * Fase RH · frente NE · `[NE.1.5]` — LA ENTREGA: donde el recibo y el sobre se tienen que dar la mano.
 *
 * `recibo.ts` exige que lo entregado sea **exactamente** la suma de los conceptos. `sobre.ts` midió
 * que el efectivo **no se puede entregar exacto** en 4 de cada 5 casos, porque la moneda más chica
 * es de 50 centavos. Las dos cosas no pueden ser verdad a la vez sin una decisión: este módulo es
 * esa decisión, hecha explícita y con su costo medido.
 *
 * ── La decisión, con lo que cuesta (medido 2026-11-23 sobre 927 recibos con efectivo) ───────────
 *  · 737 (79.5 %) piden un importe que ninguna moneda puede armar.
 *  · ⭐ **Redondear A FAVOR de la persona cuesta 12,698 centavos en el periodo (≈ $943 al año).**
 *  · Redondear en contra le quita **24,152 centavos** — casi el doble.
 *  · Es más barato ser generoso porque los residuos se concentran arriba: el más frecuente es 46
 *    centavos (330 veces), así que hacia arriba faltan 4 y hacia abajo se pierden 46.
 *  · Promedio: 13.7 centavos por persona y semana.
 *
 * → Default **`a_favor`**: cuesta menos, nunca le queda debiendo centavos a un trabajador, y elimina
 *   una clase entera de descuadre. La otra política existe porque la decisión es de negocio y puede
 *   cambiar; lo que **no** se puede es dejarla sin tomar y que el residuo desaparezca en silencio.
 *
 * ⭐ El redondeo entra como **concepto del recibo**, no como un ajuste escondido en el total: la
 * aritmética sigue cerrando y cualquiera puede sumar cuánto se redondeó en un periodo.
 */

import {
  armaRecibo,
  totalDevengado,
  type Centavos,
  type ConceptoDelRecibo,
  type EntregaDelRecibo,
  type Recibo,
} from './recibo';
import { armaSobre, MONEDA_MINIMA_CENTAVOS, residuoNoPagable, type Sobre } from './sobre';

export class EntregaInvalida extends Error {}

export type PoliticaDeResiduo = 'a_favor' | 'en_contra';

export const CLAVE_REDONDEO_A_FAVOR = 'redondeo_a_favor';
export const CLAVE_REDONDEO_EN_CONTRA = 'redondeo_en_contra';

const MOTIVO = 'no existe moneda menor a 50 centavos';

export interface Entrega {
  /** Ya cuadrado: incluye el concepto de redondeo si hizo falta. */
  readonly recibo: Recibo;
  /** El sobre del efectivo. Su residuo es **siempre 0**: el redondeo ya lo resolvió. */
  readonly sobre: Sobre;
  /** Lo que se redondeó. Positivo = a favor de la persona; negativo = en contra; 0 = no hizo falta. */
  readonly redondeoCentavos: Centavos;
}

export interface PedidoDeEntrega {
  readonly conceptos: readonly ConceptoDelRecibo[];
  /** Lo que va por transferencia. El resto sale en efectivo. */
  readonly bancoCentavos: Centavos;
  readonly politica?: PoliticaDeResiduo;
}

/**
 * Arma la entrega completa a partir de lo devengado y de lo que va por banco.
 *
 * ⛔ No inventa el reparto banco/efectivo: ése viene decidido de afuera (hoy lo trae el catálogo de
 * la persona). Acá sólo se resuelve el efectivo que queda y su residuo.
 */
export function preparaEntrega({ conceptos, bancoCentavos, politica = 'a_favor' }: PedidoDeEntrega): Entrega {
  if (!Number.isInteger(bancoCentavos) || bancoCentavos < 0) {
    throw new EntregaInvalida(`bancoCentavos: se esperaba un entero no negativo, llegó ${JSON.stringify(bancoCentavos)}`);
  }
  if (politica !== 'a_favor' && politica !== 'en_contra') {
    throw new EntregaInvalida(`política de residuo desconocida: ${JSON.stringify(politica)}`);
  }

  const devengado = totalDevengado(conceptos);
  if (bancoCentavos > devengado) {
    throw new EntregaInvalida(
      `lo que va por banco (${bancoCentavos}) supera lo devengado (${devengado}) por ${bancoCentavos - devengado} centavos`,
    );
  }

  const efectivoBruto = devengado - bancoCentavos;
  const residuo = residuoNoPagable(efectivoBruto);

  let efectivoPagado = efectivoBruto;
  let redondeoCentavos = 0;
  const conceptosFinales: ConceptoDelRecibo[] = [...conceptos];

  if (residuo > 0) {
    if (politica === 'a_favor') {
      redondeoCentavos = MONEDA_MINIMA_CENTAVOS - residuo;
      efectivoPagado = efectivoBruto + redondeoCentavos;
      conceptosFinales.push({
        clave: CLAVE_REDONDEO_A_FAVOR,
        importe: redondeoCentavos,
        signo: 'devenga',
        motivo: MOTIVO,
      });
    } else {
      redondeoCentavos = -residuo;
      efectivoPagado = efectivoBruto - residuo;
      conceptosFinales.push({
        clave: CLAVE_REDONDEO_EN_CONTRA,
        importe: residuo,
        signo: 'descuenta',
        motivo: MOTIVO,
      });
    }
  }

  const entregas: EntregaDelRecibo[] = [];
  if (bancoCentavos > 0) entregas.push({ forma: 'banco', importe: bancoCentavos });
  if (efectivoPagado > 0) entregas.push({ forma: 'efectivo', importe: efectivoPagado });
  if (!entregas.length) entregas.push({ forma: 'banco', importe: 0 });

  // Si esto lanza, es un defecto de ESTE módulo: el redondeo debía dejar el recibo cuadrado.
  const recibo = armaRecibo(conceptosFinales, entregas);
  const sobre = armaSobre(efectivoPagado);
  /* c8 ignore next */
  if (sobre.residuoCentavos !== 0) {
    throw new EntregaInvalida(`defecto interno: el sobre quedó con residuo ${sobre.residuoCentavos} después de redondear`);
  }
  return { recibo, sobre, redondeoCentavos };
}

/**
 * Cuánto se redondeó en un conjunto de entregas. Es la cifra que una pantalla publica para que el
 * redondeo **se pueda auditar**, en vez de quedar diluido peso por peso.
 */
export function redondeoDelPeriodo(entregas: readonly Entrega[]): {
  readonly aFavorCentavos: Centavos;
  readonly enContraCentavos: Centavos;
  readonly conRedondeo: number;
} {
  let aFavorCentavos = 0;
  let enContraCentavos = 0;
  let conRedondeo = 0;
  for (const e of entregas) {
    if (e.redondeoCentavos > 0) aFavorCentavos += e.redondeoCentavos;
    else if (e.redondeoCentavos < 0) enContraCentavos += -e.redondeoCentavos;
    if (e.redondeoCentavos !== 0) conRedondeo++;
  }
  return { aFavorCentavos, enContraCentavos, conRedondeo };
}
