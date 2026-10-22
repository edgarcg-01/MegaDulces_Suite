/**
 * `[LC.20]` — Lee un CFDI (3.3 / 4.0) desde su XML para mostrarlo. Función pura: sin Angular, sin red.
 *
 * Se lee lo que el XML DICE, sin recalcular: el visor muestra el documento, no una interpretación.
 * Lo que falta en el XML viaja como `null` y se pinta como «—»; nunca como 0.
 */

export interface CfdiTraslado { impuesto: string; tipo_factor: string; tasa: number | null; base: number | null; importe: number | null }

export interface CfdiConcepto {
  clave_prod_serv: string | null;
  cantidad: number | null;
  clave_unidad: string | null;
  unidad: string | null;
  descripcion: string;
  valor_unitario: number | null;
  importe: number | null;
  descuento: number | null;
  traslados: CfdiTraslado[];
}

export interface CfdiLeido {
  version: string | null;
  tipo: string | null;
  serie: string | null;
  folio: string | null;
  fecha: string | null;
  moneda: string | null;
  metodo_pago: string | null;
  forma_pago: string | null;
  subtotal: number | null;
  descuento: number | null;
  total: number | null;
  emisor: { rfc: string | null; nombre: string | null; regimen: string | null };
  receptor: { rfc: string | null; nombre: string | null; uso: string | null };
  conceptos: CfdiConcepto[];
  /** Los traslados del comprobante (IVA, IEPS) por impuesto y tasa, como los declara el XML. */
  traslados: CfdiTraslado[];
  uuid: string | null;
  fecha_timbrado: string | null;
  /** Últimos 8 del sello: el `fe` del verificador del SAT. */
  sello_8: string | null;
}

const IMPUESTO: Record<string, string> = { '001': 'ISR', '002': 'IVA', '003': 'IEPS' };

const num = (v: string | null): number | null => {
  if (v == null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Hijos directos por nombre local (ignora el prefijo `cfdi:` / `tfd:`). */
const hijos = (el: Element | null, nombre: string): Element[] =>
  el ? Array.from(el.children).filter((c) => c.localName === nombre) : [];
const hijo = (el: Element | null, nombre: string): Element | null => hijos(el, nombre)[0] ?? null;

const traslados = (impuestos: Element | null): CfdiTraslado[] =>
  hijos(hijo(impuestos, 'Traslados'), 'Traslado').map((t) => ({
    impuesto: IMPUESTO[t.getAttribute('Impuesto') ?? ''] ?? t.getAttribute('Impuesto') ?? '',
    tipo_factor: t.getAttribute('TipoFactor') ?? '',
    tasa: num(t.getAttribute('TasaOCuota')),
    base: num(t.getAttribute('Base')),
    importe: num(t.getAttribute('Importe')),
  }));

/** null si el texto no es un CFDI legible (no se finge un documento vacío). */
export function leerCfdiXml(xml: string, parser: DOMParser = new DOMParser()): CfdiLeido | null {
  const doc = parser.parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return null;
  const c = doc.documentElement;
  if (!c || c.localName !== 'Comprobante') return null;
  const a = (n: string) => c.getAttribute(n);
  const emisor = hijo(c, 'Emisor');
  const receptor = hijo(c, 'Receptor');
  const tfd = Array.from(doc.getElementsByTagNameNS('*', 'TimbreFiscalDigital'))[0] ?? null;
  const sello = a('Sello');
  return {
    version: a('Version'),
    tipo: a('TipoDeComprobante'),
    serie: a('Serie'),
    folio: a('Folio'),
    fecha: a('Fecha'),
    moneda: a('Moneda'),
    metodo_pago: a('MetodoPago'),
    forma_pago: a('FormaPago'),
    subtotal: num(a('SubTotal')),
    descuento: num(a('Descuento')),
    total: num(a('Total')),
    emisor: { rfc: emisor?.getAttribute('Rfc') ?? null, nombre: emisor?.getAttribute('Nombre') ?? null, regimen: emisor?.getAttribute('RegimenFiscal') ?? null },
    receptor: { rfc: receptor?.getAttribute('Rfc') ?? null, nombre: receptor?.getAttribute('Nombre') ?? null, uso: receptor?.getAttribute('UsoCFDI') ?? null },
    conceptos: hijos(hijo(c, 'Conceptos'), 'Concepto').map((k) => ({
      clave_prod_serv: k.getAttribute('ClaveProdServ'),
      cantidad: num(k.getAttribute('Cantidad')),
      clave_unidad: k.getAttribute('ClaveUnidad'),
      unidad: k.getAttribute('Unidad'),
      descripcion: k.getAttribute('Descripcion') ?? '',
      valor_unitario: num(k.getAttribute('ValorUnitario')),
      importe: num(k.getAttribute('Importe')),
      descuento: num(k.getAttribute('Descuento')),
      traslados: traslados(hijo(k, 'Impuestos')),
    })),
    traslados: traslados(hijo(c, 'Impuestos')),
    uuid: tfd?.getAttribute('UUID')?.toUpperCase() ?? null,
    fecha_timbrado: tfd?.getAttribute('FechaTimbrado') ?? null,
    sello_8: sello && sello.length >= 8 ? sello.slice(-8) : null,
  };
}

/**
 * El enlace del verificador público del SAT (el mismo del código QR de la representación impresa).
 * null si falta algún dato: un enlace incompleto abre una página de error del SAT.
 */
export function urlVerificadorSat(c: CfdiLeido): string | null {
  if (!c.uuid || !c.emisor.rfc || !c.receptor.rfc || c.total == null || !c.sello_8) return null;
  const q = new URLSearchParams({ id: c.uuid, re: c.emisor.rfc, rr: c.receptor.rfc, tt: c.total.toFixed(6), fe: c.sello_8 });
  return `https://verificacfdi.facturaelectronica.sat.gob.mx/default.aspx?${q.toString()}`;
}
