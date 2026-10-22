/**
 * `[CP.8.72]` — **El asiento COMPLETO de un pago a proveedor**, con las reglas medidas en
 * `FASE_CP8_ATERRIZAJE.md` §3.5–§3.6 contra las pólizas reales de 2026.
 *
 * `armarPagoProveedor` (en `poliza-egreso.ts`) arma «2120 / banco» y declara `iva_traspaso:
 * 'no_emitido'`: es la forma real en **1.7 %** de los pagos (`[CP.8.60]`). Éste recibe además
 * **qué facturas y qué notas** paga el movimiento —eso lo resuelve otra capa: la cadena Kepler
 * (`kdxf`), el REP del proveedor o el importe— y arma la póliza como la arma la contadora:
 *
 *   por factura   R1 provisionada → cargo 2120 + traspaso IEPS (1470100 C / 1470110 A) e IVA
 *                    (1060 C / 1470040 A), por el total de la factura
 *                 R2 compra directa → cargo 5020 (base al 16 %) + 1060 IVA + 1470100 IEPS + 5010 el resto
 *   por nota      abono 5050/5070 (descuento) o 5060/5080 (devolución) + la reversa de IVA e IEPS
 *   banco         abono por lo pagado
 *   redondeo      la diferencia < $1: a favor → abono 4200010000; en contra → cargo 5201000000
 *
 * Medido de punta a punta (`database/scripts/punta-a-punta-proveedor-contpaqi.js`): con estas reglas
 * se reproducen 1,051 de 1,142 pólizas armadas; de las 91 distintas, 29 son error del puente.
 *
 * Mismo contrato que `poliza-egreso.ts`: sin Nest, sin DB, **rechaza con motivo** en lugar de
 * devolver algo a medias, y no elige facturas ni cuentas — las recibe.
 */
import { ABONO, AsientoRechazado, CARGO, type Asiento, type MovimientoAsiento, TIPO_POLIZA_EGRESO } from './poliza-egreso';

export const CUENTA = {
  IVA_ACREDITABLE: '1060000000',
  IVA_POR_ACREDITAR: '1470040000',
  IEPS_ACREDITABLE: '1470100000',
  IEPS_POR_ACREDITAR: '1470110000',
  OTROS_INGRESOS: '4200010000',
  NO_DEDUCIBLES: '5201000000',
} as const;

/** Familias por proveedor: la cuenta es `<familia><sufijo de 6 dígitos del proveedor>`. */
export const FAMILIA = {
  PROVEEDOR: '2120',
  COMPRA_0: '5010',
  COMPRA_16: '5020',
  DESCUENTO_0: '5050',
  DEVOLUCION_0: '5060',
  DESCUENTO_16: '5070',
  DEVOLUCION_16: '5080',
} as const;

/** `[CP.8.60]` Corte de contabilidad: sólo se provisiona la factura de $20 mil o más, con impuestos. */
export const UMBRAL_PROVISION = 20000;

/** Lo que dice el CFDI de una factura (I) o nota (E). Importes en pesos. */
export interface ComprobanteCfdi {
  uuid: string;
  total: number;
  /** IVA trasladado declarado por el CFDI. Nunca derivado. */
  iva: number;
  /** IEPS trasladado declarado por el CFDI. */
  ieps: number;
  /** Σ (importe − descuento) de los conceptos al 16 % (`subtotal_iva_16`). Ausente → `iva / 0.16`. */
  base16?: number | null;
  /** `YYYY-MM-DD`. */
  fecha: string;
}

export interface FacturaPagada extends ComprobanteCfdi {
  /** ¿Está en la póliza de provisión de su mes en ContPAQi? (abono 2120 por su total). */
  enProvision: boolean;
  /** Parte pagada (1 = completa). Sólo la propuesta «a confirmar» usa otra cosa. */
  fraccion?: number;
}

export interface NotaAplicada extends ComprobanteCfdi {
  /** `CfdiRelacionados.TipoRelacion`. `'03'` = devolución de mercancía; lo demás, descuento. */
  tipoRelacion?: string | null;
}

export interface EntradaPagoProveedor {
  fecha: string;
  concepto: string;
  /** Cuenta del banco en ContPAQi (`102xxxxxxx`). */
  cuenta_banco: string;
  /** Lo que salió del banco. */
  pagado: number;
  /** Los 6 dígitos que identifican al proveedor (`2120000078` → `000078`). */
  sufijo: string;
  facturas: FacturaPagada[];
  notas: NotaAplicada[];
}

export interface AsientoPagoProveedor extends Asiento {
  /** UUID de cada factura y nota, en el orden de sus renglones: van a los renglones `AD` del TXT. */
  uuids: string[];
  /** Diferencia llevada a redondeo (positiva = a favor). 0 si cuadró exacto. */
  redondeo: number;
}

const cent = (n: number) => Math.round(Number(n) * 100);
const mes = (f: string) => String(f).slice(0, 7);

/**
 * `[CP.8.67]` 2120 o compra directa: **la regla de 20 mil + mes anterior, O la factura está en la
 * provisión de su mes.** Contra la contadora empata con la regla sola (743 de 790 en pago completo) y
 * además no repite el doble registro de `[CP.8.68]` (provisionada y pagada como compra directa).
 */
export function esProvisionada(f: FacturaPagada, fechaPago: string): boolean {
  return (f.total >= UMBRAL_PROVISION && mes(f.fecha) < mes(fechaPago)) || f.enProvision;
}

/**
 * `[CP.8.81]` **Un pago de tarjeta de crédito no es un pago a proveedor**, aunque traiga la categoría de compra y el
 * nombre de la tienda («PAGO TDC AMEX - SAMS»): lo que sale del banco liquida la tarjeta, y la contadora lo asienta
 * contra la tarjeta (2140800000). Medido sobre ene–sep 2026 con `comparar-armado-contpaqi.js`: de 18 pagos «TDC»
 * que el puente armaba como proveedor, **0 salían iguales** a los suyos. No se arma: se declara con su motivo.
 */
export function esPagoDeTarjeta(concepto: unknown): boolean {
  return /\bTDC\b/i.test(String(concepto ?? ''));
}

/** `[CP.8.66]` Descuento o devolución: el tipo de relación del CFDI de la nota (91.7 % contra la contadora). */
export function esDevolucion(n: NotaAplicada): boolean {
  return n.tipoRelacion === '03';
}

/** La base al 16 % en centavos: la del CFDI; si no viene, la que implica el IVA. Sin IVA, cero. */
function base16Cent(c: ComprobanteCfdi): number {
  if (cent(c.iva) <= 0) return 0;
  return c.base16 && c.base16 > 0 ? cent(c.base16) : Math.round(cent(c.iva) / 0.16);
}

export function armarPagoProveedorCompleto(e: EntradaPagoProveedor): AsientoPagoProveedor {
  if (!/^\d{6}$/.test(e.sufijo)) {
    throw new AsientoRechazado('proveedor_sin_cuenta', `Sufijo de proveedor inválido: "${e.sufijo}".`);
  }
  if (!e.facturas.length) {
    throw new AsientoRechazado('sin_facturas', 'No se sabe qué facturas paga el movimiento: no se arma.');
  }
  const pagado = cent(e.pagado);
  if (pagado <= 0) throw new AsientoRechazado('importe_invalido', `Pagado no positivo: ${e.pagado}.`);

  const movs: MovimientoAsiento[] = [];
  const uuids: string[] = [];
  const mov = (cuenta: string, abono: boolean, c: number) => {
    if (c > 0) movs.push({ cuenta, abono, importe: c / 100, concepto: e.concepto, seg_negocio: 0 });
  };

  for (const f of e.facturas) {
    const k = f.fraccion ?? 1;
    if (!(k > 0 && k <= 1)) throw new AsientoRechazado('importe_invalido', `Fracción pagada inválida: ${k}.`);
    const parte = (c: number) => Math.round(c * k);
    const tot = parte(cent(f.total)); const iva = parte(cent(f.iva)); const ieps = parte(cent(f.ieps));
    if (tot <= 0) throw new AsientoRechazado('importe_invalido', `Factura ${f.uuid} con total no positivo.`);
    if (esProvisionada(f, e.fecha)) {
      mov(FAMILIA.PROVEEDOR + e.sufijo, CARGO, tot);
      mov(CUENTA.IEPS_ACREDITABLE, CARGO, ieps); mov(CUENTA.IEPS_POR_ACREDITAR, ABONO, ieps);
      mov(CUENTA.IVA_ACREDITABLE, CARGO, iva); mov(CUENTA.IVA_POR_ACREDITAR, ABONO, iva);
    } else {
      const b16 = parte(base16Cent(f));
      mov(FAMILIA.COMPRA_16 + e.sufijo, CARGO, b16);
      mov(CUENTA.IVA_ACREDITABLE, CARGO, iva);
      mov(CUENTA.IEPS_ACREDITABLE, CARGO, ieps);
      // `[CP.8.65]` El residuo de centavos de la base NO abre un renglón 5010: va al redondeo.
      const resto = tot - b16 - iva - ieps;
      if (Math.abs(resto) >= 100) mov(FAMILIA.COMPRA_0 + e.sufijo, CARGO, resto);
    }
    uuids.push(f.uuid);
  }

  for (const n of e.notas) {
    const tot = cent(n.total); const iva = cent(n.iva); const ieps = cent(n.ieps);
    if (tot <= 0) throw new AsientoRechazado('importe_invalido', `Nota ${n.uuid} con total no positivo.`);
    const dev = esDevolucion(n);
    const b16 = base16Cent(n);
    mov((dev ? FAMILIA.DEVOLUCION_16 : FAMILIA.DESCUENTO_16) + e.sufijo, ABONO, b16);
    mov(CUENTA.IVA_ACREDITABLE, ABONO, iva);
    mov(CUENTA.IEPS_ACREDITABLE, ABONO, ieps);
    const resto = tot - b16 - iva - ieps;
    if (Math.abs(resto) >= 100) mov((dev ? FAMILIA.DEVOLUCION_0 : FAMILIA.DESCUENTO_0) + e.sufijo, ABONO, resto);
    uuids.push(n.uuid);
  }

  mov(e.cuenta_banco, ABONO, pagado);

  // ── Compuerta: Σ cargos = Σ abonos, con la diferencia < $1 al redondeo. Arriba de eso, NO se arma.
  const cargos = movs.filter((m) => !m.abono).reduce((a, m) => a + cent(m.importe), 0);
  const abonos = movs.filter((m) => m.abono).reduce((a, m) => a + cent(m.importe), 0);
  const dif = cargos - abonos;
  if (Math.abs(dif) >= 100) {
    throw new AsientoRechazado(
      'no_cuadra',
      `Las facturas menos las notas no dan lo pagado: diferencia ${(dif / 100).toFixed(2)}. ` +
        'Falta una nota, sobra una factura o es un pago parcial: va a confirmar.',
    );
  }
  if (dif > 0) mov(CUENTA.OTROS_INGRESOS, ABONO, dif);
  if (dif < 0) mov(CUENTA.NO_DEDUCIBLES, CARGO, -dif);

  return {
    tipo_poliza: TIPO_POLIZA_EGRESO,
    fecha: e.fecha,
    concepto: e.concepto,
    movimientos: movs,
    total: (cargos + Math.max(0, -dif)) / 100,
    uuids,
    redondeo: dif / 100,
  };
}
