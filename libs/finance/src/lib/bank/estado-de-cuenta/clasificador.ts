/**
 * `[CB.61]` La categoría de un renglón del banco SIN las columnas M/C que Tesorería escribe a mano.
 *
 * El libro «CUENTAS» clasifica con `classifyWith(M, C, concepto)`: casi todas sus reglas miran M (tipo)
 * o C (clave de Tesorería), que el banco no trae. Sin libro, la categoría sale de tres fuentes, en este
 * orden (medido en ago–oct 2026 contra la categoría del libro):
 *
 * 1. **El documento de Kepler casado** (`runMatchTreasury`): traspaso, cobro o pago a proveedor. Acierta
 *    en 99 % de los movimientos que lo tienen; barajando los documentos entre movimientos, 51 %.
 * 2. **El texto del banco**: los cargos del propio banco (IVA, comisión, tasa de descuento, renta de
 *    terminal, compra con tarjeta) y los traspasos y devoluciones que el banco nombra. ⚠️ Antes que las
 *    reglas genéricas del libro: la regla genérica `COMISION` → `comisiones_venta` es correcta para un
 *    concepto escrito por Tesorería y falsa para el estado de cuenta, donde «COMISION» la cobra el banco.
 * 3. **Las reglas del libro que sólo miran el concepto** (SAT, IMSS, nómina…), que llegan como función.
 *
 * Un depósito sin otra señal es **cobranza**, declarado con su propia fuente (`deposito`), para que se
 * pueda medir aparte. Un retiro sin señal queda `sin_clasificar`: no se adivina.
 */

export type FuenteDeCategoria = 'documento' | 'banco' | 'regla_del_libro' | 'deposito' | 'ninguna';

export interface RenglonAClasificar {
  amount_in: number | string;
  amount_out: number | string;
  concepto?: string | null;
  /** Tipo del documento de Kepler casado (`U-A-5`, `N-A-26`, `X-D-26`…), si lo hay. */
  doc_tipo?: string | null;
  /** Entidad del documento de Kepler (`kdm1.c10`): `C…` proveedor, `GN…` nómina. */
  entidad?: string | null;
}

export interface CategoriaDelRenglon { categoria: string; por: FuenteDeCategoria }

const SIN = 'sin_clasificar';
const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '');

function porDocumento(tipo: string, entidad: string): string | null {
  if (tipo === 'N-A-26' || tipo === 'X-A-45') return 'traspaso_entre_cuentas';
  if (/^U-A-(5|7|25)$/.test(tipo)) return 'cobranza';
  if (/^X-D-/.test(tipo)) {
    if (/^C[A-Z]/.test(entidad)) return 'compra_mercancia';
    if (/^GN/.test(entidad)) return 'nomina';
  }
  return null;
}

/**
 * Lo que el banco escribe de sí mismo. El orden importa: «IVA COMISION» es IVA, «COMISION FEDERAL»
 * (CFE) es un servicio, y lo demás que dice COMISION en un estado de cuenta lo cobra el banco.
 * «TRASPASO A CUENTA DE TERCEROS» NO es entre cuentas propias.
 */
const RETIRO: [RegExp, string][] = [
  [/^IVA\b|\bIVA (COM|TASA|POR)|COBRO IVA|PAGO DE IVA|\bI V A\b|\bI\.V\.A\./, 'iva_acreditable'],
  [/DOMICILIACION|^CFE\b|COMISION FEDERA|TELMEX|TELEFONOS DE MEXICO/, 'servicios'],
  [/TASA DE DES|\bCOMISION\b|^COM VTAS|RENTA (DE )?TERMINAL|RENTA TPV|CUOTA AFILIACION|MEMBRESIA|ANUALIDAD/, 'comision_bancaria'],
  [/DISPOSICION POR POS/, 'compra_tarjeta'],
  [/^TRASPASO (ENTRE|CUENTAS PROPIAS|A (?!CUENTA DE TERCEROS))|RETIRO DE RECURSOS/, 'traspaso_entre_cuentas'],
];
const DEPOSITO: [RegExp, string][] = [
  [/SPEI DEVUELTO|^DEV\.? (SPEI|DEPOSITO)/, 'devolucion_spei'],
  [/^TRASPASO (ENTRE|CUENTAS PROPIAS|DE )|ENTREGA DE RECURSOS/, 'traspaso_entre_cuentas'],
  [/^ANUL|^BONI/, SIN],
];

export function clasificarRenglon(r: RenglonAClasificar, reglaDelLibro?: (concepto: string) => string): CategoriaDelRenglon {
  const doc = porDocumento(norm(r.doc_tipo), norm(r.entidad));
  if (doc) return { categoria: doc, por: 'documento' };
  const t = norm(r.concepto);
  const entra = Math.round(Number(r.amount_in ?? 0) * 100) > 0;
  for (const [re, cat] of entra ? DEPOSITO : RETIRO) {
    if (re.test(t)) return { categoria: cat, por: cat === SIN ? 'ninguna' : 'banco' };
  }
  // Las reglas del libro describen gastos: sobre un depósito («VENTAS TDC») dan una compra con tarjeta.
  const libro = !entra && reglaDelLibro ? reglaDelLibro(t) : SIN;
  if (libro && libro !== SIN) return { categoria: libro, por: 'regla_del_libro' };
  return entra ? { categoria: 'cobranza', por: 'deposito' } : { categoria: SIN, por: 'ninguna' };
}
