import { importeConComas, type CamposDelCheque } from './cheque-impreso';
import { centavosExactos } from './importe-con-letra';

/**
 * `[PGP.168.1]` **La póliza del cheque, armada por la Suite.**
 *
 * ── Por qué ────────────────────────────────────────────────────────────────────────────────
 * Hoy la póliza se llena con papel carbón debajo del cheque y el número se pone a mano, sobre un talonario preimpreso
 * de media carta (anexo CH, §0 filas 9–11). Con el cheque impreso por la Suite (`[PGP.165]`) el carbón ya no copia
 * nada. Francisco (2026-11-19): *«2 hojas de póliza para que reimprima el cheque, anexe los documentos pagados, el
 * nombre de quien firma»*; (2026-11-25): *«la impresión de la póliza, avanzamos de una vez»*.
 *
 * DCH10-b: la póliza **completa en hoja blanca de media carta**, no sobre el talonario — no hay nada que calibrar y
 * caben todos los documentos. Lleva lo mismo que el talonario: la copia del cheque, el banco, el concepto, la tabla
 * cuenta · sub-cuenta · nombre · parcial · cargo · abono con sus sumas iguales, el recibí y hecho / revisado / sello /
 * número de póliza.
 *
 * ── Lo que la Suite pone y lo que no ────────────────────────────────────────────────────────
 * - El cheque, **las mismas cadenas** que el cheque impreso (`camposDelCheque`): nunca otra cifra ni otra letra.
 * - Cada documento con lo que sale del banco por él (el NETO) en «parcial», y si hubo descuento al pagar, la factura
 *   y el descuento con su motivo: así el proveedor ve por qué el cheque es menor que su factura (anexo CH §5 fila 6).
 * - La cuenta contable del BANCO (`finance.bank_accounts.contpaqi_cuenta`, llena en las dos cuentas de cheque).
 * - ⛔ La cuenta del BENEFICIARIO queda en blanco: la Suite no la tiene (NO MEDIDA, DCH10) y no se adivina.
 * - ⛔ El nombre de quien recibe va en blanco: no hay contacto registrado del proveedor (DCH9). Se escribe a mano.
 */

export interface DocumentoParaPoliza {
  /** Folio de Kepler del documento (el `concept` del renglón de una factura); null si no es factura de Kepler. */
  folio: string | null;
  sucursal: string | null;
  /** La referencia que se tecleó al capturar la factura en Kepler (captura libre: se dice «Ref.», no «Factura»). */
  referencia: string | null;
  /** El UUID del CFDI ligado, si se ligó uno solo. */
  uuid: string | null;
  /** `YYYY-MM-DD`. */
  vence: string | null;
  /** Lo que sale del banco por este documento (el NETO): número o texto de un `numeric`. */
  aplicado: number | string;
  /** El descuento al pagar (`discount_amount`); 0 sin descuento. */
  descuento: number | string;
  /** «Pronto pago 3 %», «Anticipo 1234» (`rotuloDescuentos`); null sin descuento. */
  descuentoRotulo: string | null;
  /** El texto del renglón cuando no es factura de Kepler (un gasto, un compromiso). */
  concepto: string | null;
}

export interface DatosDePoliza {
  /** El número del cheque (`folioDelCheque`). */
  folio: string;
  /** Los campos del cheque impreso: la póliza los repite tal cual. */
  campos: CamposDelCheque;
  /** El importe del cheque en centavos (el del dictamen). */
  centavos: number;
  /** «BanBajío · Conecta · BB 4166». */
  banco: string;
  /** La cuenta contable del banco y su nombre en ContPAQi; null si la cuenta no la tiene. */
  cuentaBanco: { cuenta: string; nombre: string | null } | null;
  /** «Proveedor de mercancía», «Gasto»… */
  clasificacion: string;
  /** El día del Calendario (`YYYY-MM-DD`). */
  dia: string;
  /** El código del acreedor en Kepler, si es uno solo. */
  acreedor: string | null;
  documentos: readonly DocumentoParaPoliza[];
  /** Quien imprime (el usuario de la sesión). */
  hechoPor: string | null;
}

export interface RenglonPoliza {
  cuenta: string;
  subcuenta: string;
  nombre: string;
  /** Segunda línea en letra chica (UUID, vencimiento, la factura y su descuento). */
  detalle: string | null;
  parcial: string;
  cargo: string;
  abono: string;
}

export interface PolizaDeCheque {
  cheque: { folio: string; fecha: string; beneficiario: string; importe: string; letra: string; banco: string };
  concepto: string;
  renglones: RenglonPoliza[];
  sumas: { cargo: string; abono: string };
  recibi: string;
  hechoPor: string;
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** `2026-11-20` → `20-nov-2026`, leyendo el texto (sin `Date`: sería el día anterior en México). */
export function fechaCortaDePoliza(iso: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
  return `${Number(m[3])}-${MESES[Number(m[2]) - 1]}-${m[1]}`;
}

/** El documento en palabras: «Suc 05 · folio 12345 · Ref. A-1234», o el concepto si no es factura de Kepler. */
function nombreDelDocumento(d: DocumentoParaPoliza): string {
  const partes: string[] = [];
  if (d.folio) partes.push(`${d.sucursal ? `Suc ${d.sucursal} · ` : ''}folio ${d.folio}`);
  else if (d.concepto && /[\p{L}\p{N}]/u.test(d.concepto)) partes.push(d.concepto.trim());
  if (d.referencia) partes.push(`Ref. ${d.referencia.trim()}`);
  return partes.join(' · ') || 'Documento sin folio';
}

/**
 * **La póliza de un cheque.** ⛔ Lanza si los documentos no suman el cheque al centavo: una póliza que no cuadra con
 * su cheque es la misma falla que devolvía cheques, escrita en otro papel. Pura: el servicio le da lo que ya leyó.
 */
export function polizaDelCheque(d: DatosDePoliza): PolizaDeCheque {
  if (!d.documentos.length) throw new RangeError('una póliza sin documentos no se imprime');
  let suma = 0;
  const parciales: RenglonPoliza[] = d.documentos.map((doc) => {
    const neto = centavosExactos(doc.aplicado);
    const desc = centavosExactos(doc.descuento || 0);
    suma += neto;
    const detalle = [
      doc.uuid ? `CFDI ${doc.uuid}` : doc.folio ? 'CFDI sin ligar' : null,
      fechaCortaDePoliza(doc.vence) ? `vence ${fechaCortaDePoliza(doc.vence)}` : null,
      desc > 0 ? `factura ${importeConComas(neto + desc)} − ${doc.descuentoRotulo || 'descuento'} ${importeConComas(desc)}` : null,
    ].filter(Boolean).join(' · ');
    return { cuenta: '', subcuenta: '', nombre: nombreDelDocumento(doc), detalle: detalle || null, parcial: importeConComas(neto), cargo: '', abono: '' };
  });
  if (suma !== d.centavos) {
    throw new RangeError(`la póliza no cuadra con el cheque: los documentos suman ${importeConComas(suma)} y el cheque es ${importeConComas(d.centavos)}`);
  }
  const total = importeConComas(d.centavos);
  const n = d.documentos.length;
  return {
    cheque: { folio: d.folio, fecha: d.campos.fecha, beneficiario: d.campos.beneficiario, importe: d.campos.importe, letra: d.campos.letra, banco: d.banco },
    concepto: `${d.clasificacion} · ${n === 1 ? '1 documento' : `${n} documentos`} · Calendario de pagos del ${fechaCortaDePoliza(d.dia) ?? d.dia}`,
    renglones: [
      // El cargo, al beneficiario, con sus documentos como parciales. Su cuenta la pone Contabilidad.
      { cuenta: '', subcuenta: '', nombre: d.acreedor ? `${d.campos.beneficiario} (acreedor ${d.acreedor})` : d.campos.beneficiario, detalle: null, parcial: '', cargo: total, abono: '' },
      ...parciales,
      // El abono, al banco, con su cuenta de ContPAQi.
      { cuenta: d.cuentaBanco?.cuenta ?? '', subcuenta: '', nombre: d.cuentaBanco?.nombre || d.banco, detalle: null, parcial: '', cargo: '', abono: total },
    ],
    sumas: { cargo: total, abono: total },
    recibi: `Recibí el cheque No. ${d.folio} por $${total}.`,
    hechoPor: (d.hechoPor ?? '').trim(),
  };
}
