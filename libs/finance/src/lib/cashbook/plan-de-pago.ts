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

/**
 * El vale de `/finanzas/aprobacion-gastos` que la cajera elige al pagar (D18). Ampara el pago sólo
 * si guarda QUIÉN lo aprobó (`aprobado_at`): medido 2026-11-02, de 1,374 vales `validada` desde el
 * 1-oct sólo 148 la guardan, y el cierre de Kepler valida vales que nadie firmó (`[GX.85]`).
 * `[LE.6.28]` El SQL que llena `aprobadoAt` (`FIRMA_DE_PERSONA`) toma, cuando falta `aprobado_at`, la
 * validación de una PERSONA (lo de antes del 28/10); la del cierre de Kepler sigue sin firma.
 */
export interface ValeElegido {
  folio: string;
  estado: string;
  importeCentavos: bigint;
  aprobadoAt: string | null;
}

/**
 * `[LE.2.13]` **Lo que respalda el pago, según Kepler** (PM, 2026-11-03: *«las compras ya se autorizan
 * cuando se hace la compra»*; *«¿por qué volverlos a aprobar?»*). El servidor lo lee del documento, no
 * lo escoge la cajera:
 *  · `gasto`: el X-D-26 aplica gastos XA1001 (`kdm5`); cada uno, con el vale de su solicitud.
 *  · `compra`: el X-D-26 aplica órdenes de entrada A-20 (`kdxf`): la compra ya fue la autorización.
 *  · `ninguno`: Kepler no dice qué paga (o el ODS no está): sólo así firma Tesorería.
 *
 * Medido 2026-11-03 (prod, sólo lectura): de 4,068 X-D-26 de caja jul–oct, 1,206 pagan compras, 2,861
 * gastos y 1 nada; en las 6 hojas de gastos, 32 de 32 suman su respaldo al centavo.
 */
export type Respaldo =
  | { tipo: 'gasto'; aplicadoCentavos: bigint; gastos: ReadonlyArray<{ folio: string; vale: ValeElegido | null }> }
  | { tipo: 'compra'; aplicadoCentavos: bigint; documentos: number; pagadosDeMas: number }
  | { tipo: 'ninguno' };

export type BloqueoDePago = 'importe_invalido' | 'ya_ordenado' | 'ya_pagado' | 'sin_cuenta_kepler' | 'vale_de_otro_importe'
  | 'vale_rechazado' | 'respaldo_no_cuadra' | 'compra_pagada_de_mas' | 'gasto_sin_expediente' | 'gasto_sin_aprobar';

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

function motivoDeFirma(vale: ValeElegido | null): string | null {
  if (!vale) return 'no trae vale aprobado';
  if (!ESTADOS_APROBADOS.has(vale.estado)) return `el vale ${vale.folio} está ${vale.estado}, no aprobado`;
  if (!vale.aprobadoAt) return `el vale ${vale.folio} no guarda quién lo aprobó`;
  return null;
}

/** Aprobado por una PERSONA: `validada` sin `aprobado_at` es el cierre de Kepler validando lo que ya salió (GX.85). */
const aprobadoPorPersona = (v: ValeElegido): boolean => ESTADOS_APROBADOS.has(v.estado) && !!v.aprobadoAt;

/**
 * `[LE.2.13]` Con el respaldo que Kepler declara, UNA autorización basta: la del gasto en «Aprobación de
 * gastos» o la compra misma. Lo que no la tiene NO sale (no se manda a firmar): se arregla donde se
 * autoriza. Sólo lo que no respalda nada pide la firma de Tesorería.
 */
function porRespaldo(doc: DocumentoAPagar, r: Respaldo): { bloqueo: BloqueoDePago | null; motivoFirma: string | null } {
  if (r.tipo === 'ninguno') return { bloqueo: null, motivoFirma: 'Kepler no dice qué gasto o compra paga' };
  if (r.aplicadoCentavos !== doc.importeCentavos) return { bloqueo: 'respaldo_no_cuadra', motivoFirma: null };
  if (r.tipo === 'compra') return { bloqueo: r.pagadosDeMas > 0 ? 'compra_pagada_de_mas' : null, motivoFirma: null };
  if (r.gastos.some((g) => !g.vale)) return { bloqueo: 'gasto_sin_expediente', motivoFirma: null };
  if (r.gastos.some((g) => g.vale?.estado === 'rechazada')) return { bloqueo: 'vale_rechazado', motivoFirma: null };
  if (r.gastos.some((g) => g.vale && !aprobadoPorPersona(g.vale))) return { bloqueo: 'gasto_sin_aprobar', motivoFirma: null };
  return { bloqueo: null, motivoFirma: null };
}

/**
 * `yaPagado`: el libro viejo (`finance.cash_ledger`) ya lo registró; no se paga otra vez por la Ventanilla.
 * `respaldo`: lo que Kepler dice que paga el documento (`[LE.2.13]`). Si es `ninguno` y la cajera eligió
 * un vale, manda el vale (el ODS puede venir atrasado); sin respaldo ni vale, firma Tesorería.
 */
export function planDePago(doc: DocumentoAPagar, opciones: { yaOrdenado: boolean; yaPagado?: boolean; vale: ValeElegido | null; respaldo?: Respaldo }): PlanDePago {
  const pagable = doc.importeCentavos > 0n ? alMedioPeso(doc.importeCentavos) : 0n;
  const maquina = (pagable / BILLETE_MINIMO) * BILLETE_MINIMO;
  const vale = opciones.vale;
  const conRespaldo = opciones.respaldo && opciones.respaldo.tipo !== 'ninguno' ? porRespaldo(doc, opciones.respaldo) : null;
  const motivoFirma = conRespaldo ? conRespaldo.motivoFirma
    : vale ? motivoDeFirma(vale) : opciones.respaldo ? porRespaldo(doc, opciones.respaldo).motivoFirma : motivoDeFirma(null);
  let bloqueo: BloqueoDePago | null = null;
  if (doc.importeCentavos <= 0n) bloqueo = 'importe_invalido';
  else if (opciones.yaOrdenado) bloqueo = 'ya_ordenado';
  else if (opciones.yaPagado) bloqueo = 'ya_pagado';
  else if (!doc.cuentaKepler) bloqueo = 'sin_cuenta_kepler';
  else if (conRespaldo?.bloqueo) bloqueo = conRespaldo.bloqueo;
  // PM 2026-11-03: «lo rechazado no se paga» — tampoco con la firma de Tesorería.
  else if (!conRespaldo && vale?.estado === 'rechazada') bloqueo = 'vale_rechazado';
  else if (!conRespaldo && vale && vale.importeCentavos !== doc.importeCentavos) bloqueo = 'vale_de_otro_importe';
  return {
    documento: doc,
    pagableCentavos: pagable,
    redondeoCentavos: pagable - doc.importeCentavos,
    maquinaCentavos: maquina,
    cajonCentavos: pagable - maquina,
    requiereFirma: motivoFirma !== null,
    motivoFirma,
    bloqueo,
  };
}

/** La cuenta la resuelve y la dice la cola (`movimientos-pendientes`); el veredicto no la vuelve a juzgar. */
const CUENTA_DE_LA_COLA = '(la cola)';

/**
 * `[LE.2.13]` El veredicto de una fila de «Por pagar hoy»: el MISMO motor que `planDePago` (no una
 * copia), sin la cuenta y sin el vale de la cajera — en la cola el vale lo pone Kepler.
 */
export function veredictoDePago(importeCentavos: bigint, opciones: { yaOrdenado: boolean; yaPagado: boolean; respaldo?: Respaldo })
  : { bloqueo: BloqueoDePago | null; requiereFirma: boolean; motivoFirma: string | null } {
  const p = planDePago({ origenRef: '', folio: '', beneficiario: '', importeCentavos, cuentaKepler: CUENTA_DE_LA_COLA },
    { ...opciones, vale: null });
  return { bloqueo: p.bloqueo, requiereFirma: p.requiereFirma, motivoFirma: p.motivoFirma };
}

/** Dónde se arregla lo detenido; `null` = no se arregla aprobando (rechazado, pagado de más…). */
export const ARREGLO_DEL_BLOQUEO: Readonly<Partial<Record<BloqueoDePago, 'aprobacion_gastos'>>> = {
  gasto_sin_expediente: 'aprobacion_gastos',
  gasto_sin_aprobar: 'aprobacion_gastos',
};

/** La frase de la fila cuando no se puede pagar (la pantalla la muestra en la fila, no en un aviso aparte). */
export const MOTIVO_BLOQUEO: Readonly<Record<BloqueoDePago, string>> = {
  importe_invalido: 'El documento no trae un importe que pagar.',
  ya_ordenado: 'Este documento ya tiene su orden de pago: no se paga dos veces.',
  ya_pagado: 'Este documento ya está registrado en el libro de caja: no se paga dos veces.',
  sin_cuenta_kepler: 'Falta su cuenta de Kepler.',
  vale_de_otro_importe: 'El vale elegido es por otro importe que el documento.',
  vale_rechazado: 'El gasto está rechazado en Aprobación de gastos: no se paga.',
  respaldo_no_cuadra: 'Lo que Kepler dice que paga este documento no suma su importe: se aclara en Kepler antes de pagar.',
  compra_pagada_de_mas: 'Una de las entradas que paga ya estaba pagada: con este pago quedaría pagada de más.',
  gasto_sin_expediente: 'El gasto no tiene su solicitud en Aprobación de gastos: se sube ahí y se aprueba antes de pagar.',
  gasto_sin_aprobar: 'El gasto todavía no lo aprueba nadie en Aprobación de gastos: se aprueba ahí antes de pagar.',
};
