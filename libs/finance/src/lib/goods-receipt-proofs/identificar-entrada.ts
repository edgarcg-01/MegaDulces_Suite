/**
 * `[RE.35.7]` — **¿De qué entrada de Kepler es este papel?** La pregunta de la captura por lote:
 * se sueltan varias facturas escaneadas (con su sello de recibido y su firma) y cada una tiene que
 * encontrar su orden de entrada sin que nadie teclee el folio.
 *
 * Mismo principio que el expediente (ADR-085): **el papel identifica, el CFDI informa.**
 *  1. Con lo leído del papel (UUID, RFC, folio, total) se busca su CFDI en ContPAQi — `ligarCfdi`,
 *     el mismo motor del expediente, sin llaves de Kepler (todavía no se sabe qué entrada es).
 *  2. Con el total y el emisor del CFDI (o, sin CFDI, con lo leído) se buscan las entradas que
 *     cuadran dentro de la tolerancia de R-v2 y cuyo proveedor es ese emisor.
 *
 * Como en la captura por lote de pagos (`[PC.3]`): **nada se guarda sin el clic de «Guardar».**
 * «listo» sólo significa que la propuesta viene pre-marcada, y exige TODO: CFDI con liga exacta,
 * una sola entrada libre que cuadra con proveedor confirmado, y sello y firma vistos en el papel.
 */
import type {
  ExpedienteLiga, IdentificacionCandidata, IdentificacionConfianza, IdentificacionMotivo,
} from '@megadulces/contracts';

export interface EntradaParaIdentificar {
  sucursal: string;
  folio: string;
  receipt_date: string | null;
  proveedor_nombre: string | null;
  proveedor_rfc: string | null;
  oc_folio: string | null;
  monto: number;
  deposits: number;
}

/**
 * Ventana alrededor de la fecha del papel en que se espera capturada su entrada: unos días antes
 * (llegó antes de facturarse) a diez después. Sirve para DISTINGUIR entre gemelas, nunca para pre-marcar.
 */
export const CERCA_ANTES = 3;
export const CERCA_DESPUES = 10;

const dias = (a: string | null, b: string | null): number | null => {
  if (!a || !b) return null;
  const x = Date.parse(a.slice(0, 10)); const y = Date.parse(b.slice(0, 10));
  return Number.isNaN(x) || Number.isNaN(y) ? null : Math.round((x - y) / 864e5);
};

export interface ClasificacionIdentificacion {
  confianza: IdentificacionConfianza;
  propuesta: { sucursal: string; folio: string } | null;
  motivos: IdentificacionMotivo[];
}

/**
 * La decisión, pura. `candidatas` ya viene filtrada a las que cuadran y cuyo proveedor no es OTRO
 * (`proveedor_ok !== false`).
 */
export function clasificarIdentificacion(p: {
  hayLectura: boolean;
  cfdi: boolean;
  liga: ExpedienteLiga | null;
  sello: boolean | null | undefined;
  firma: boolean | null | undefined;
  candidatas: IdentificacionCandidata[];
  /** Fecha del documento (la del CFDI, o la leída): distingue entre entradas gemelas. */
  fechaDocumento?: string | null;
}): ClasificacionIdentificacion {
  if (!p.hayLectura) return { confianza: 'sin_entrada', propuesta: null, motivos: ['sin_lectura'] };
  if (!p.candidatas.length) return { confianza: 'sin_entrada', propuesta: null, motivos: ['sin_candidatas'] };

  // ⛔ Medido en prod (2026-10-06, 576 facturas ya archivadas): los proveedores que entregan el MISMO
  // importe cada semana (rompope, cueritos, abarrotes) tienen varias entradas gemelas. Elegir "la única
  // libre" pegaba el papel a la entrega de OTRA semana cuando la correcta ya tenía documento. Por eso
  // las que ya tienen papel CUENTAN como candidatas, y con más de una nunca se pre-marca.
  let una: IdentificacionCandidata | null = null;
  let gemelas = false;
  if (p.candidatas.length === 1) {
    una = p.candidatas[0];
  } else {
    gemelas = true;
    const cerca = p.candidatas.filter((c) => {
      const d = dias(c.receipt_date, p.fechaDocumento ?? null);
      return d != null && d >= -CERCA_ANTES && d <= CERCA_DESPUES;
    });
    // Sólo se propone si la fecha distingue a UNA; si no, elige la persona. Elegir la primera pegaría
    // el papel a la entrega equivocada del proveedor correcto: un error que se ve bien y nadie audita.
    if (cerca.length !== 1) return { confianza: 'elegir', propuesta: null, motivos: ['varias_entradas'] };
    una = cerca[0];
  }

  const motivos: IdentificacionMotivo[] = [];
  if (gemelas) motivos.push('otras_parecidas');
  // Una sola candidata pero lejos de la fecha del papel: puede ser otra entrega que por casualidad
  // cuadra (medido: una factura de $180,661 cuadraba con una entrada de OTRA sucursal 14 días antes,
  // mientras la suya llegó incompleta). Se propone, pero no se pre-marca.
  const dUna = dias(una.receipt_date, p.fechaDocumento ?? null);
  if (!gemelas && (dUna == null || dUna < -CERCA_ANTES || dUna > CERCA_DESPUES)) motivos.push('fecha_lejana');
  if (!p.cfdi) motivos.push('sin_cfdi');
  else if (!p.liga?.exacta) motivos.push('liga_sugerida');
  if (una.proveedor_ok !== true) motivos.push('proveedor_sin_confirmar');
  if (una.deposits > 0) motivos.push('ya_tiene_papel');
  if (p.sello === false) motivos.push('sin_sello');
  if (p.firma === false) motivos.push('sin_firma');
  if (p.sello == null || p.firma == null) motivos.push('sello_no_visible');

  return {
    confianza: motivos.length ? 'revisar' : 'listo',
    propuesta: { sucursal: una.sucursal, folio: una.folio },
    motivos: motivos.length ? motivos : ['todo_coincide'],
  };
}
