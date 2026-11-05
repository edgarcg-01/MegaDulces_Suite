/**
 * `[LE.2.9]` — **Pagar en un solo acto** (V3, ADR-112): de un X-D-26 de Kepler, qué sale de la máquina
 * con código, qué sale del cajón por pieza, y si hace falta la firma de Tesorería antes del dinero.
 *
 * ── Medido para decidir (prod, sólo lectura, 2026-11-02) ─────────────────────────────────────
 *  · Fuente del importe: `analytics.bank_movement_legs` (la que ya usa la caja), contrastada contra
 *    un testigo: el X-D-26 0023782 de hoy sale en $796.73, como en la pantalla.
 *  · 178 de 915 pagos de caja desde el 1-oct (19 %) NO se pueden pagar exacto con monedas: traen
 *    centavos que no son múltiplo de 50. La diferencia nunca pasa de 25 centavos ($19.31 en el mes).
 *
 * ── D26 (decidida 2026-11-02) ────────────────────────────────────────────────────────────────
 *  Se paga al medio peso más cercano (25 centavos sube) y la diferencia queda DECLARADA como
 *  redondeo en el libro: nunca se absorbe, cada peso tiene su explicación.
 *
 * Función pura: el servicio la alimenta con el documento, el vale elegido y lo que ya se ordenó.
 */

export interface DocumentoAPagar {
  /** `sucursal|X-D-26|folio|cuenta`, la misma llave del libro viejo (`origen_ref`). */
  origenRef: string;
  folio: string;
  beneficiario: string;
  importeCentavos: bigint;
  /** La cuenta contable de Kepler con que se asienta; sin ella no se paga (la pantalla dice por qué). */
  cuentaKepler: string | null;
}

/** El vale de `/finanzas/aprobacion-gastos` que la cajera elige al pagar (D18). */
export interface ValeElegido {
  folio: string;
  estado: string;
  importeCentavos: bigint;
}

export type BloqueoDePago = 'importe_invalido' | 'ya_ordenado' | 'sin_cuenta_kepler' | 'vale_de_otro_importe';

export interface PlanDePago {
  documento: DocumentoAPagar;
  /** Lo que se paga de verdad: el importe llevado al medio peso más cercano. */
  pagableCentavos: bigint;
  /** pagable − importe: entre −25 y +25 centavos, declarado en el libro. */
  redondeoCentavos: bigint;
  /** Billetes de $20 para arriba: salen de la máquina con el código de la orden. */
  maquinaCentavos: bigint;
  /** Lo que falta para el pagable: sale del cajón, contado por pieza. */
  cajonCentavos: bigint;
  /** V4/D18: sin vale aprobado, Tesorería firma ANTES de que salga el código. */
  requiereFirma: boolean;
  motivoFirma: string | null;
  bloqueo: BloqueoDePago | null;
}

const ESTADOS_APROBADOS = new Set(['aprobada', 'validada']);
const BILLETE_MINIMO = 2000n;   // $20
const MEDIO_PESO = 50n;

export function alMedioPeso(c: bigint): bigint {
  const r = c % MEDIO_PESO;
  return r * 2n >= MEDIO_PESO ? c - r + MEDIO_PESO : c - r;
}

export function planDePago(doc: DocumentoAPagar, opciones: { yaOrdenado: boolean; vale: ValeElegido | null }): PlanDePago {
  const pagable = doc.importeCentavos > 0n ? alMedioPeso(doc.importeCentavos) : 0n;
  const maquina = (pagable / BILLETE_MINIMO) * BILLETE_MINIMO;
  const vale = opciones.vale;
  const valeAprobado = !!vale && ESTADOS_APROBADOS.has(vale.estado);
  let bloqueo: BloqueoDePago | null = null;
  if (doc.importeCentavos <= 0n) bloqueo = 'importe_invalido';
  else if (opciones.yaOrdenado) bloqueo = 'ya_ordenado';
  else if (!doc.cuentaKepler) bloqueo = 'sin_cuenta_kepler';
  else if (vale && vale.importeCentavos !== doc.importeCentavos) bloqueo = 'vale_de_otro_importe';
  return {
    documento: doc,
    pagableCentavos: pagable,
    redondeoCentavos: pagable - doc.importeCentavos,
    maquinaCentavos: maquina,
    cajonCentavos: pagable - maquina,
    requiereFirma: !valeAprobado,
    motivoFirma: valeAprobado ? null : vale ? `el vale ${vale.folio} está ${vale.estado}, no aprobado` : 'no trae vale aprobado',
    bloqueo,
  };
}

/** La frase de la fila cuando no se puede pagar (la pantalla la muestra en la fila, no en un aviso aparte). */
export const MOTIVO_BLOQUEO: Readonly<Record<BloqueoDePago, string>> = {
  importe_invalido: 'El documento no trae un importe que pagar.',
  ya_ordenado: 'Este documento ya tiene su orden de pago: no se paga dos veces.',
  sin_cuenta_kepler: 'Falta su cuenta de Kepler.',
  vale_de_otro_importe: 'El vale elegido es por otro importe que el documento.',
};
