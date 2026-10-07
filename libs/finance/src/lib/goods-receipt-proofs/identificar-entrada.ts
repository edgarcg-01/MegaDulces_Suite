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
}): ClasificacionIdentificacion {
  if (!p.hayLectura) return { confianza: 'sin_entrada', propuesta: null, motivos: ['sin_lectura'] };
  if (!p.candidatas.length) return { confianza: 'sin_entrada', propuesta: null, motivos: ['sin_candidatas'] };

  const libres = p.candidatas.filter((c) => !(c.deposits > 0));
  // Varias entradas libres que cuadran: elige la persona. Elegir la primera pegaría el papel a la
  // entrega equivocada del proveedor correcto — un error que se ve bien y nadie audita.
  if (libres.length > 1) return { confianza: 'elegir', propuesta: null, motivos: ['varias_entradas'] };

  const una = libres[0] ?? (p.candidatas.length === 1 ? p.candidatas[0] : null);
  if (!una) return { confianza: 'elegir', propuesta: null, motivos: ['varias_entradas'] };

  const motivos: IdentificacionMotivo[] = [];
  if (!p.cfdi) motivos.push('sin_cfdi');
  else if (!p.liga?.exacta) motivos.push('liga_sugerida');
  if (una.proveedor_ok !== true) motivos.push('proveedor_sin_confirmar');
  if (!libres.length) motivos.push('ya_tiene_papel');
  if (p.sello === false) motivos.push('sin_sello');
  if (p.firma === false) motivos.push('sin_firma');
  if (p.sello == null || p.firma == null) motivos.push('sello_no_visible');

  return {
    confianza: motivos.length ? 'revisar' : 'listo',
    propuesta: { sucursal: una.sucursal, folio: una.folio },
    motivos: motivos.length ? motivos : ['todo_coincide'],
  };
}
