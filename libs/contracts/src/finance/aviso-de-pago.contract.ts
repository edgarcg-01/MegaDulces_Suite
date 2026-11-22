/**
 * `[PGP.194]` **El aviso de pago al proveedor** (anexo AV, DA3 de Francisco, 2026-11-21).
 *
 * Para que la cobranza del proveedor genere su complemento de pago (REP) necesita, por cada factura, qué se le pagó y
 * con qué transferencia. Hoy se arma a mano en recortes. El aviso lo dice **en los documentos del proveedor** —su
 * folio (la referencia que se capturó en Kepler), el UUID de su CFDI y las notas de crédito o devoluciones aplicadas—
 * y anexa el PDF de la transferencia.
 *
 * ⛔ Lo que no se sabe se DICE (`faltantes`), no se omite: una factura sin CFDI ligado o un pago sin comprobante.
 * ⛔ El aviso no calcula los campos del REP (saldo anterior, insoluto): son del proveedor y de sus reglas fiscales. Da
 *    los hechos con los que los calcula.
 */

/** Por dónde se manda. `liga` = se copió la liga (o se descargó) sin abrir WhatsApp ni el correo. */
export type CanalAviso = 'whatsapp' | 'correo' | 'liga';
export const CANALES_AVISO: readonly CanalAviso[] = ['whatsapp', 'correo', 'liga'];

/** Una nota de crédito, devolución o pago que Kepler aplicó a la factura (`kdxf`). */
export interface AplicacionDelAviso {
  /** «Nota de crédito», «Devolución», «Transferencia»… (`nombreTipoPagoKepler`). */
  nombre: string;
  /** Documento interno de Mega Dulces: `X-D-55 0000131`. */
  documento: string;
  /** La referencia que se capturó en ese documento (a veces el folio del proveedor); null si no trae. */
  referencia: string | null;
  fecha: string | null;
  importe: number;
}

export interface FacturaDelAviso {
  /** La referencia capturada en Kepler (`kdxe.c16`): casi siempre el folio del proveedor. */
  referencia: string | null;
  /** Documento interno: `X-A-20 0000683`. */
  documento: string | null;
  uuid: string | null;
  metodo: 'PUE' | 'PPD' | null;
  /** Fecha de la factura: la del CFDI si se ligó; si no, la del documento de Kepler. */
  fecha: string | null;
  /** Total del CFDI; si no se ligó, el importe del documento de Kepler. */
  total: number | null;
  /** Notas de crédito y devoluciones aplicadas en Kepler a esta factura. */
  notas: AplicacionDelAviso[];
  /** El descuento que se dio al pagar (`[PGP.91]`); 0 si no hubo. */
  descuento: number;
  /** Lo que esta transferencia le pagó a la factura. */
  pagado: number;
}

export interface ContactoCobranza {
  nombre: string | null;
  email: string | null;
  whatsapp: string | null;
}

export interface AvisoEnviado {
  canal: CanalAviso;
  destino: string | null;
  por: string;
  /** ISO. */
  el: string;
}

export interface AvisoDePago {
  pago_id: string;
  /** Quien paga (identidad fiscal de la empresa); null si no está configurada. */
  emisor: { nombre: string; rfc: string } | null;
  proveedor: { codigo: string | null; nombre: string; rfc: string | null };
  /** Fecha de la transferencia (la del comprobante; si no, la del día del pago), `YYYY-MM-DD`. */
  fecha_pago: string | null;
  importe: number;
  rastreo: string | null;
  /** Banco de origen y sus últimos 4 dígitos: «BBVA ···4166». */
  origen: string | null;
  /** Cuenta destino enmascarada: «···6033». */
  destino: string | null;
  /** El PDF de la transferencia, si la Suite lo tiene. */
  comprobante_id: string | null;
  facturas: FacturaDelAviso[];
  contacto: ContactoCobranza | null;
  avisos: AvisoEnviado[];
  /** Lo que el aviso no pudo decir, en palabras. Vacío = completo. */
  faltantes: string[];
  /** Se puede mandar: el pago está pagado. Si no, `motivo` dice por qué no. */
  se_puede: boolean;
  motivo: string | null;
}

/** `POST finance/payment-notices/:allocationId` — se genera la liga y queda el registro de a quién se avisó. */
export interface CrearAvisoDePago {
  canal: CanalAviso;
  email?: string | null;
  whatsapp?: string | null;
  nombre?: string | null;
}

export interface AvisoDePagoCreado {
  aviso_id: string;
  /** La liga pública al PDF del aviso (con su comprobante anexo). */
  url: string;
  /** `https://wa.me/…?text=…` con el mensaje y la liga. */
  whatsapp_url: string;
  /** `mailto:…?subject=…&body=…`. */
  mailto: string;
}

const pesos = (n: number) => `$${n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fechaMx = (iso: string | null) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : 'sin fecha');

/** Los últimos `n` dígitos de una cuenta, enmascarada: `···6033`. Null si no trae dígitos. */
export function enmascarar(cuenta: string | null | undefined, n = 4): string | null {
  const d = String(cuenta ?? '').replace(/\D/g, '');
  return d ? `···${d.slice(-n)}` : null;
}

/**
 * El WhatsApp a 12 dígitos con lada de México (`52` + 10), o null si no es un número válido. Acepta lo que la gente
 * teclea: espacios, guiones, `+52`, `044`/`045` viejos o el `521` de antes de 2020.
 */
export function normalizarWhatsApp(crudo: string | null | undefined): string | null {
  let d = String(crudo ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 13 && d.startsWith('521')) d = `52${d.slice(3)}`;
  if (d.length === 13 && (d.startsWith('044') || d.startsWith('045'))) d = d.slice(3);
  if (d.length === 10) d = `52${d}`;
  return d.length === 12 && d.startsWith('52') ? d : null;
}

/** Un correo con forma de correo (una arroba, dominio con punto, sin espacios). Null si no. */
export function normalizarCorreo(crudo: string | null | undefined): string | null {
  const c = String(crudo ?? '').trim().toLowerCase();
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(c) ? c : null;
}

/** Lo que el aviso no puede decir, en palabras (va en el PDF y en el diálogo). */
export function faltantesDelAviso(a: Pick<AvisoDePago, 'rastreo' | 'comprobante_id' | 'facturas'>): string[] {
  const f: string[] = [];
  if (!a.comprobante_id) f.push('La Suite no tiene el PDF de la transferencia: el aviso sale sin comprobante anexo.');
  else if (!a.rastreo) f.push('No se pudo leer la clave de rastreo del comprobante.');
  const sinUuid = a.facturas.filter((x) => !x.uuid).length;
  if (sinUuid) f.push(`${sinUuid} de ${a.facturas.length} factura${a.facturas.length === 1 ? '' : 's'} sin CFDI ligado: va con su referencia, sin UUID.`);
  return f;
}

/** El mensaje que acompaña la liga (WhatsApp y cuerpo del correo). Corto: el detalle está en el PDF. */
export function textoDelAviso(a: Pick<AvisoDePago, 'emisor' | 'proveedor' | 'fecha_pago' | 'importe' | 'rastreo' | 'facturas'>, url: string): string {
  const quien = a.emisor?.nombre ?? 'Mega Dulces';
  const refs = a.facturas.map((f) => f.referencia || f.uuid?.slice(0, 8) || f.documento).filter(Boolean) as string[];
  const facturas = refs.length ? `Facturas: ${refs.slice(0, 6).join(', ')}${refs.length > 6 ? ` y ${refs.length - 6} más` : ''}.` : '';
  return [
    `Buen día, ${a.proveedor.nombre}.`,
    `${quien} les informa el pago por transferencia del ${fechaMx(a.fecha_pago)} por ${pesos(a.importe)}${a.rastreo ? ` (clave de rastreo ${a.rastreo})` : ''}.`,
    facturas,
    `El desglose por factura, con las notas de crédito aplicadas y el comprobante de la transferencia: ${url}`,
    'Les agradeceremos el complemento de pago (REP) de las facturas PPD.',
  ].filter(Boolean).join('\n');
}

export function asuntoDelAviso(a: Pick<AvisoDePago, 'emisor' | 'fecha_pago' | 'importe'>): string {
  return `Aviso de pago ${a.emisor?.nombre ?? 'Mega Dulces'} · ${fechaMx(a.fecha_pago)} · ${pesos(a.importe)}`;
}

/** `wa.me` con el número (si lo hay) y el texto. Sin número, WhatsApp deja elegir el chat. */
export function ligaWhatsApp(whatsapp: string | null, texto: string): string {
  const n = normalizarWhatsApp(whatsapp);
  return `https://wa.me/${n ?? ''}?text=${encodeURIComponent(texto)}`;
}

export function ligaCorreo(email: string | null, asunto: string, cuerpo: string): string {
  const to = normalizarCorreo(email) ?? '';
  return `mailto:${to}?subject=${encodeURIComponent(asunto)}&body=${encodeURIComponent(cuerpo)}`;
}
