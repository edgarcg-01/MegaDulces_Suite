/**
 * Fase CP `[CP.8.2]` (ADR-040) — **El armador del asiento de egreso para ContPAQi.**
 *
 * Vive aparte del servicio y sin dependencias de Nest, por la misma razón que `poliza-txt.ts`:
 * decide sobre dinero y tiene que poder probarse sin DI. El smoke
 * `test-newdb-contpaqi-poliza-egreso.js` carga este archivo tal cual vía ts-node.
 *
 * ── La forma del asiento: MEDIDA, no supuesta ───────────────────────────────────────────────
 * Leída el 2026-10-08 de pólizas reales de `ctLUIS_FRANCISCO_LOPEZ_GUTIERREZ` (tipo 2, Egreso).
 * Son siempre tres renglones:
 *
 *     #1 CARGO  5200510001 RENTA BIENES INMUEBLES     135,000.00   <- subtotal
 *     #2 CARGO  1060000000 IVA ACREDITABLE             21,600.00   <- del CFDI
 *     #3 ABONO  1020220000 BBVA 0489396721            156,600.00   <- total
 *
 * ── ⭐ Por qué el IVA NO se calcula ──────────────────────────────────────────────────────────
 * Medido en "PAGO TRASLADO DE EFECTIVO": subtotal 134,082.29. Multiplicar por 0.16 da
 * **21,453.17**, y ContPAQi tiene asentado **21,453.18**. En otra póliza del mismo concepto la
 * diferencia son **2 centavos**. El IVA sale del CFDI —donde se calcula por concepto y se
 * redondea ahí—, no de multiplicar el total.
 *
 * Por eso `iva` es un parámetro OBLIGATORIO y este módulo **se niega a derivarlo**. Si lo
 * calculara, el asiento quedaría descuadrado por centavos y ContPAQi lo rechazaría. Esos
 * importes ya los tenemos: `fiscal.cfdis` guarda las bases gravables por impuesto y tasa
 * (Fase LC.1, 167,135 comprobantes).
 *
 * ── Lo que este módulo NO hace, a propósito ─────────────────────────────────────────────────
 * ⛔ No elige la cuenta: la recibe en `regla`, que sale de `contpaqi.account_rules` con su
 *    confianza medida. Elegir cuenta es política contable y la firma el contador.
 * ⛔ No serializa. El transporte (TXT hoy, SDK después) es otra capa — justamente para que
 *    cambiarlo no toque esta lógica.
 * ⛔ No redondea para que cuadre. Si no cuadra, **falla**: un asiento descuadrado que ContPAQi
 *    rechaza es infinitamente preferible a uno que acepta corrido de campo (`[LC.9]`).
 */

/** ContPAQi: 1 = Ingreso · 2 = Egreso · 3 = Diario. Verificado contra su catálogo. */
export const TIPO_POLIZA_EGRESO = 2;

/** `MovimientosPoliza.TipoMovto` — decodificado en CP.0 y re-verificado en vivo. */
export const CARGO = false;
export const ABONO = true;

export type EstadoRegla = 'derivada' | 'aprobada' | 'sin_regla';

export interface ReglaCuenta {
  categoria_code: string;
  cuenta_gasto: string | null;
  cuenta_iva: string;
  confianza_pct: number | null;
  estado: EstadoRegla;
}

export interface EntradaEgreso {
  regla: ReglaCuenta;
  /** Base gravable. En pesos, con 2 decimales. */
  subtotal: number;
  /** ⭐ El IVA **declarado por el CFDI**. Nunca derivado de `subtotal`. */
  iva: number;
  /** Total efectivamente pagado — el que salió del banco. */
  total: number;
  /** Cuenta contable del banco en ContPAQi (`102xxxxxxx`). Viene del crosswalk de CP.2. */
  cuenta_banco: string;
  concepto: string;
  /** `YYYY-MM-DD`. */
  fecha: string;
  /** `IdSegNeg`. 0 = sin segmento, que es lo que ContPAQi tiene en el 97.6% de los casos. */
  seg_negocio?: number;
}

export interface MovimientoAsiento {
  cuenta: string;
  abono: boolean;
  importe: number;
  concepto: string;
  seg_negocio: number;
}

export interface Asiento {
  tipo_poliza: number;
  fecha: string;
  concepto: string;
  movimientos: MovimientoAsiento[];
  total: number;
}

/** El motor no lanza `Error` pelado: el motivo es parte del dato y se guarda en el export. */
export class AsientoRechazado extends Error {
  constructor(readonly motivo: string, mensaje: string) {
    super(mensaje);
    this.name = 'AsientoRechazado';
  }
}

/** Centavos enteros. Comparar pesos en punto flotante es cómo se cuelan descuadres de 1 ¢. */
const cent = (n: number) => Math.round(Number(n) * 100);

/**
 * Arma el asiento de un egreso, o lo RECHAZA con motivo. Nunca devuelve algo a medias.
 *
 * Los cuatro rechazos son deliberados y cada uno corresponde a un modo de falla ya vivido:
 *  - `sin_regla`        — la categoría se midió y no concluyó. Asentarla sería inventar.
 *  - `regla_sin_cuenta` — `[LC.9]`: un nulo se vuelve espacios y tira el archivo entero.
 *  - `importe_invalido` — un importe no positivo no es un pago.
 *  - `descuadre`        — subtotal + IVA != total. Es LO que ContPAQi debe rechazar.
 */
export function armarAsientoEgreso(e: EntradaEgreso): Asiento {
  const { regla } = e;

  if (regla.estado === 'sin_regla') {
    throw new AsientoRechazado(
      'sin_regla',
      `La categoría "${regla.categoria_code}" no tiene regla concluyente` +
        (regla.confianza_pct != null ? ` (concentra ${regla.confianza_pct}%)` : ' (sin medir)') +
        '. Se declara, no se asienta.',
    );
  }
  if (!regla.cuenta_gasto) {
    throw new AsientoRechazado(
      'regla_sin_cuenta',
      `La regla "${regla.categoria_code}" está en estado "${regla.estado}" pero no trae cuenta de gasto.`,
    );
  }

  const sub = cent(e.subtotal);
  const iva = cent(e.iva);
  const tot = cent(e.total);

  if (sub <= 0 || tot <= 0) {
    throw new AsientoRechazado('importe_invalido', `Importes no positivos: subtotal ${e.subtotal}, total ${e.total}.`);
  }
  if (iva < 0) {
    throw new AsientoRechazado('importe_invalido', `IVA negativo: ${e.iva}.`);
  }
  // ⭐ Sin tolerancia. La tentación es admitir ±1 ¢ "porque el IVA redondea"; sería tapar
  // justamente el caso que descubrió que el IVA viene del CFDI y no de multiplicar.
  if (sub + iva !== tot) {
    throw new AsientoRechazado(
      'descuadre',
      `No cuadra: ${(sub / 100).toFixed(2)} + ${(iva / 100).toFixed(2)} = ` +
        `${((sub + iva) / 100).toFixed(2)}, pero el total es ${(tot / 100).toFixed(2)}.`,
    );
  }

  const seg = e.seg_negocio ?? 0;
  const movimientos: MovimientoAsiento[] = [
    { cuenta: regla.cuenta_gasto, abono: CARGO, importe: sub / 100, concepto: e.concepto, seg_negocio: seg },
  ];
  // El renglón de IVA sólo existe si hay IVA. Un gasto exento con un renglón en cero no es
  // "más completo": es un renglón que no ocurrió.
  if (iva > 0) {
    movimientos.push({
      cuenta: regla.cuenta_iva, abono: CARGO, importe: iva / 100, concepto: e.concepto, seg_negocio: 0,
    });
  }
  movimientos.push({
    cuenta: e.cuenta_banco, abono: ABONO, importe: tot / 100, concepto: e.concepto, seg_negocio: 0,
  });

  return {
    tipo_poliza: TIPO_POLIZA_EGRESO,
    fecha: e.fecha,
    concepto: e.concepto,
    movimientos,
    total: tot / 100,
  };
}

/**
 * Verifica que un asiento ya armado cuadre. Se usa como última compuerta antes de entregarlo,
 * porque entre armarlo y mandarlo pueden mediar transformaciones (y ya pasó: `[LC.9]`
 * encontró que `setInclusion` limpiaba el hash pero no el contenido, y se servía el viejo).
 */
export function asientoCuadra(a: Asiento): boolean {
  let cargos = 0;
  let abonos = 0;
  for (const m of a.movimientos) {
    if (m.abono) abonos += cent(m.importe);
    else cargos += cent(m.importe);
  }
  return cargos === abonos && cargos === cent(a.total);
}
