/**
 * `[BFU.4.5.12]` **De dónde viene cada peso que ENTRA al banco.** La cifra «quién explica cada peso» (BFU.4.5.6)
 * repartía por área, y como el motor de categoría pone «cobranza» a todo depósito sin otra señal, Crédito y Cobranza
 * se quedaba con TODAS las entradas: la venta de la tienda, la cobranza de facturas, el préstamo del banco y los
 * traspasos del dueño, mezclados. Edgar (2026-11-25): *«a simple vista le falta si es ingreso o egreso, y faltan las
 * ventas de la tienda».*
 *
 * El origen sale del DOCUMENTO de Kepler con el que el depósito está casado (`bank_recon_matches`), no del texto:
 *   · `venta_tienda`  — un cobro (`U-A-*`) aplicado a un **corte de caja POS** (`U-D-23`, cliente CONTADO): la venta de
 *                       mostrador de una sucursal, la misma que lista `/finanzas/cortes-sucursales`;
 *   · `cobranza`      — un cobro aplicado a otra cosa (la factura `U-D-8` de telemarketing/mayoreo, casi siempre);
 *   · `traspaso`      — un traspaso entre cuentas de Kepler (`N-*-26`);
 *   · `otro_documento`— casado con otro documento.
 * Medido en prod (noviembre de 2026, 2,001 depósitos): 881 venta de tienda en 8 sucursales, 590 cobranza, 62 traspasos.
 * ⭐ El contraste independiente: el banco escribe «VENTAS CREDITO/DEBITO … TERMINALES PUNTO DE VENTA» en 360 depósitos
 * casados, y los 360 salen `venta_tienda`; **ninguno** sale `cobranza`.
 *
 * Sin documento, el origen sale de la categoría cuando ésta lo dice (traspaso, devolución) o del cliente declarado; si
 * no, queda `sin_documento` con **lo que dice el banco** (`senalDelBanco`): es una pista para quien lo va a ligar, NO
 * una explicación — lo explicado lo sigue decidiendo `leerFila`.
 */
import type { FilaDeCobertura } from './cobertura-de-categoria';

export type OrigenConDocumento = 'venta_tienda' | 'cobranza' | 'traspaso' | 'otro_documento';
export type SenalDelBanco = 'terminal' | 'efectivo' | 'transferencia' | 'prestamo' | 'devolucion' | 'otro';

/** El texto del renglón como lo leen las reglas: mayúsculas, sin acentos, espacios simples. */
const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Lo que el banco escribe de un depósito, en el orden en que se prueba. «PRESTAMO» y «DEVOLU» van ANTES que «EFECTIVO» y
 * «SPEI»: «DEPOSITO DE PRESTAMO» no es un depósito en efectivo de una venta. «VENTAS CREDITO/… TERMINALES PUNTO DE VENTA»
 * es venta con tarjeta de crédito: por eso «CREDITO» solo no dice préstamo.
 * ⚠️ El préstamo y la devolución repiten la señal de `depositoQueNoEsVenta` (BFU.7.10, sin commitear al 2026-11-25): al
 * entrar aquélla, ésta la importa (ADR-056).
 */
const SENALES: readonly [RegExp, SenalDelBanco][] = [
  [/\bPRESTAMO\b|CREDITO LIQUIDO|LINEA DE CREDITO|DISPOSICION (DE )?CREDITO|FINANCIAMIENTO/, 'prestamo'],
  [/DEVOLU|DEVUELT|\bREVERS|RECHAZ/, 'devolucion'],
  [/TERMINALES PUNTO DE VENTA|\bTPV\b/, 'terminal'],
  [/EFECTIVO/, 'efectivo'],
  [/\bSPEI\b|TRANSFER|TRASPASO|ENTREGA DE RECURSOS|CUENTA DE TERCERO|CUENTA PROPIA/, 'transferencia'],
];

export function senalDelBanco(concepto: string | null | undefined): SenalDelBanco {
  const t = norm(concepto);
  for (const [re, s] of SENALES) if (re.test(t)) return s;
  return 'otro';
}

const CON_DOCUMENTO: readonly string[] = ['venta_tienda', 'cobranza', 'traspaso', 'otro_documento'];

/**
 * El grupo de una ENTRADA: el origen de su documento; sin documento, el que dice su categoría o su cliente; y si nada lo
 * dice, `sin_documento:<lo que dice el banco>`. Es el ÚNICO lugar que lo decide: lo usan la cifra y el filtro de la lista.
 */
export function claveDeEntrada(f: Pick<FilaDeCobertura, 'origen_doc' | 'categoria' | 'cliente' | 'concepto'>): string {
  if (f.origen_doc && CON_DOCUMENTO.includes(f.origen_doc)) return f.origen_doc;
  if (f.categoria === 'traspaso_entre_cuentas') return 'traspaso';
  if (f.categoria === 'devolucion_spei') return 'devolucion';
  if (f.cliente) return 'cobranza';
  return `sin_documento:${senalDelBanco(f.concepto)}`;
}

/** El nombre de cada grupo de entradas, para la pantalla y el Excel. */
export const NOMBRE_DE_ORIGEN: Readonly<Record<string, string>> = {
  venta_tienda: 'Venta de tienda',
  cobranza: 'Cobranza de facturas',
  traspaso: 'Traspasos entre cuentas',
  devolucion: 'Devoluciones',
  otro_documento: 'Otros documentos de Kepler',
  'sin_documento:terminal': 'Venta con tarjeta',
  'sin_documento:efectivo': 'Depósito en efectivo',
  'sin_documento:transferencia': 'Transferencia recibida',
  'sin_documento:prestamo': 'Préstamo',
  'sin_documento:devolucion': 'Devolución',
  'sin_documento:otro': 'Otro depósito',
};

/** El orden de lectura: primero lo que tiene documento (de dónde vino), después lo que falta ligar. */
export const ORDEN_DE_ORIGEN: readonly string[] = Object.keys(NOMBRE_DE_ORIGEN);
