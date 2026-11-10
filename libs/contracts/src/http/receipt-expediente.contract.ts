/**
 * `[RE.35]` El expediente de la factura de una orden de entrada —
 * `GET /finance/goods-receipts/:sucursal/:folio/expediente`.
 *
 * Regla de fuentes (ADR-085): **el papel identifica, el CFDI informa.** Del documento que sube el
 * auxiliar (la remisión o factura del repartidor) sólo se usan las LLAVES para encontrar la factura
 * en `fiscal.cfdis` (UUID, folio, RFC, total). Todo dato fiscal (método y forma de pago, uso,
 * regímenes, impuestos) sale del CFDI que sincroniza ContPAQi, nunca del OCR.
 *
 * Producer `GoodsReceiptExpedienteService` y consumer `/compras/revision-facturas` (antes `/compras/costo-por-compra`) importan de acá
 * (ADR-052).
 */

/** El cubo en que cae la entrada. Cada entrada cae en EXACTAMENTE uno. */
export type ExpedienteCubo = 'auto' | 'revisar' | 'sin_cfdi_aun' | 'sin_documento' | 'fuera_de_alcance';

/**
 * `[RE.35.5]` Qué hacer y con quién: cobrar nota de crédito · factura mal emitida (refacturar) ·
 * entrega incompleta (devolución en Kepler) · sin orden de compra · nota de crédito ya aplicada ·
 * ajuste comercial (sólo informa). `[RE.63]` nota en CFDI que Kepler no aplicó (aplicarla en Kepler) ·
 * nota en Kepler sin CFDI del proveedor (pedírsela). Informativos: no cambian el cubo.
 */
export type ExpedienteHallazgo = 'cobrar_nc' | 'mal_emitida' | 'incompleta' | 'sin_oc' | 'nc_aplicada' | 'comercial'
  | 'nc_solo_cfdi' | 'nc_solo_kepler';

/** `[RE.63]` Todos los hallazgos, en el orden en que se ofrecen (lista blanca del filtro y conteos en cero). */
export const EXPEDIENTE_HALLAZGOS: readonly ExpedienteHallazgo[] = [
  'cobrar_nc', 'mal_emitida', 'incompleta', 'sin_oc', 'nc_aplicada', 'comercial', 'nc_solo_cfdi', 'nc_solo_kepler',
];

/**
 * `[RE.63]` Dónde está la rebaja de la entrada: en Kepler (X-D-55/40 aplicadas a la orden de entrada), en el
 * CFDI (notas que relacionan su factura), en los dos o en ninguno. Se compara POR ENTRADA: Kepler y el
 * proveedor no registran la misma nota (Kepler captura el descuento pactado; el proveedor timbra otro monto).
 * `cfdi_no_medido` = Kepler aplicó notas y la entrada no tiene factura CFDI ligada: el lado del SAT no se sabe.
 */
export type ExpedienteLadoNotas = 'ambas' | 'solo_cfdi' | 'solo_kepler' | 'ninguna' | 'cfdi_no_medido';

export interface ExpedienteNotasLados {
  estado: ExpedienteLadoNotas;
  /** `tipo` 55 = nota de crédito · 40 = devolución de compra. `aplicado` = lo aplicado a ESTA entrada. */
  kepler: { tipo: '55' | '40'; folio: string; aplicado: number; fecha: string | null; motivo: string | null }[];
  /** Notas cuyo CFDI relaciona la factura; `facturas` = cuántas relaciona. `null` sin factura ligada. */
  cfdi: { uuid: string; total: number; fecha: string | null; facturas: number }[] | null;
  kepler_total: number;
  cfdi_total: number | null;
  /** CFDI − Kepler, sólo con notas en los dos lados. */
  diferencia: number | null;
  /** Alguna nota CFDI relaciona también otras facturas: la diferencia no es atribuible al peso. */
  compartida: boolean;
  /**
   * La consecuencia: lo que Kepler pagará (entrada − sus notas) contra lo que el proveedor factura neto
   * (factura − sus notas). Una nota de un solo lado no siempre cambia lo que se paga (Kepler pudo capturar
   * la entrada ya con el descuento). `null` sin factura ligada o con nota compartida.
   */
  neto_kepler: number;
  neto_cfdi: number | null;
  /** neto_cfdi − neto_kepler: > 0, el proveedor factura neto más de lo que Kepler pagará; < 0, al revés. */
  dif_neta: number | null;
  netos_cuadran: boolean | null;
}

/** `[RE.35.5]` El veredicto compacto de una fila del listado. */
export interface ExpedienteResumenFila {
  cubo: ExpedienteCubo;
  hallazgos: ExpedienteHallazgo[];
  /** El primer motivo, para la fila (el panel trae todos). */
  motivo: string | null;
}

/**
 * `[RE.35.5]` Conteos sobre el universo del listado (alcance + periodo, sin el filtro de bandeja ni
 * la búsqueda): son los números de la Bandeja y del Hallazgo.
 */
export interface ExpedienteConteos {
  por_cubo: Record<ExpedienteCubo, number>;
  por_hallazgo: Record<ExpedienteHallazgo, number>;
  /** Cuánto tardó el cálculo por lote (se declara: es lo que cuesta tener la bandeja). */
  ms: number;
}

/** Qué documento subió el auxiliar. */
export type ExpedienteDocTipo = 'factura' | 'remision' | 'ninguno';

/**
 * Cómo se encontró el CFDI de la entrada. Exactas: `asignado`, `uuid`, `uuid_corregido`, `rfc_folio` y
 * `folio_total` (dos llaves impresas e independientes, con candidato único). `rfc_importe` y
 * `total_fecha` son SUGERENCIA: las tiene que confirmar una persona.
 */
export type ExpedienteLigaMetodo =
  | 'asignado'        // ya confirmado antes en fiscal.cfdi_assignments
  | 'uuid'            // el UUID leído del documento existe tal cual
  | 'uuid_corregido'  // el UUID leído difiere en <= 3 caracteres de uno solo existente
  | 'rfc_folio'       // RFC + folio de la factura
  | 'folio_total'     // folio + total
  | 'rfc_importe'     // RFC + importe (del papel o de la entrada)
  | 'nombre_importe'  // [RE.59] nombre del emisor + importe de la entrada (el RFC no sirve en ningún lado); sugerencia
  | 'total_fecha';    // total + fecha cercana

export interface ExpedienteLiga {
  metodo: ExpedienteLigaMetodo;
  exacta: boolean;
  /** Cuántos CFDI cumplían la llave usada (1 = sin ambigüedad). */
  candidatos: number;
}

/** El estado de un check. `null` = no aplica o no se pudo medir (se DECLARA, no se dibuja como verde). */
export type ExpedienteCheckEstado = 'ok' | 'falla' | 'aviso' | 'no_aplica' | 'sin_medir';

export type ExpedienteCheckGrupo = 'identificacion' | 'fiscal' | 'entrada';

export interface ExpedienteCheck {
  /** Clave estable (`F1_receptor`, `E1_cuadre`…): la usa la bitácora de decisiones (RE.37). */
  clave: string;
  grupo: ExpedienteCheckGrupo;
  etiqueta: string;
  /** Valor mostrado (del CFDI para lo fiscal, de Kepler para lo de la entrada). */
  valor: string | null;
  /** Lo que se esperaba, en palabras. */
  esperado: string | null;
  estado: ExpedienteCheckEstado;
  nota: string | null;
  /** Si falla, ¿impide que la entrada pase sola? Los avisos no bloquean. */
  bloquea: boolean;
}

/** Los datos fiscales del CFDI, tal cual los trae ContPAQi. */
export interface ExpedienteCfdi {
  uuid: string;
  serie: string | null;
  folio: string | null;
  fecha: string | null;
  fecha_timbrado: string | null;
  emisor_rfc: string;
  emisor_nombre: string | null;
  emisor_regimen: string | null;
  receptor_rfc: string | null;
  receptor_regimen: string | null;
  uso_cfdi: string | null;
  metodo_pago: string | null;
  forma_pago: string | null;
  moneda: string | null;
  tipo_cambio: number | null;
  subtotal: number | null;
  descuento: number | null;
  total: number;
  total_trasladados: number | null;
  total_retenidos: number | null;
  iva_trasladado: number | null;
  ieps_trasladado: number | null;
  /** `true` si algún traslado de IEPS es por CUOTA (se acredita, no se va al costo). */
  ieps_por_cuota: boolean;
  lugar_expedicion: string | null;
  /** `desconocido` en lo que llega de ContPAQi: nadie verificó la cancelación. */
  estatus_sat: string;
}

/** Lo que se leyó del documento subido (sólo llaves de identificación). */
export interface ExpedienteLectura {
  uuid: string | null;
  folio: string | null;
  rfc: string | null;
  total: number | null;
  fecha: string | null;
  ocr_status: string | null;
  /**
   * `[RE.35.7]` Lo que da valor al papel: el sello de recibido y la firma de quien recibió.
   * `null` = no se distingue o la lectura es anterior a RE.35.7 (no bloquea).
   */
  sello?: boolean | null;
  firma?: boolean | null;
  sello_evidencia?: string | null;
}

export interface ReceiptExpediente {
  sucursal: string;
  folio: string;
  doc_tipo: ExpedienteDocTipo;
  cubo: ExpedienteCubo;
  /** Por qué no pasa sola, en palabras (vacío si `cubo = 'auto'`). */
  motivos: string[];
  checks: ExpedienteCheck[];
  cfdi: ExpedienteCfdi | null;
  liga: ExpedienteLiga | null;
  lectura: ExpedienteLectura | null;
  /** Total de la entrada en Kepler (con impuestos). */
  monto_entrada: number;
  /** factura − entrada (null sin factura). */
  diferencia: number | null;
  /**
   * `[RE.35.2]` Con qué reglas se evaluó: `factura` (CFDI + fiscal) o `remision` (cuadre con el total del
   * papel, OC y fecha). Una factura cuyo proveedor no tiene CFDI en ContPAQi se evalúa como remisión.
   */
  via: 'factura' | 'remision';
  /** `[RE.35.5]` Qué hacer y con quién (mismo cálculo que la fila del listado). */
  hallazgos: ExpedienteHallazgo[];
  /**
   * `[RE.35.2]` La nota de crédito que hizo cuadrar una factura mayor que la entrada. `[RE.62]` Sólo una
   * nota cuyo CFDI relaciona ESTA factura (y a ninguna otra); si fueron varias, `total` es la suma y
   * `uuid` las une con « + ». Una nota que sólo casa por importe NO llega aquí: va como motivo de E1.
   */
  nota_credito: { uuid: string; total: number; fecha: string | null } | null;
  /** `[RE.63]` Dónde está la rebaja: Kepler, CFDI, los dos o ninguno (opcional: respuestas anteriores no lo traen). */
  notas_lados?: ExpedienteNotasLados;
  /** La regla y la versión que dieron el veredicto (sello de ADR-085). */
  regla: string;
  /** Tolerancia aplicada al cuadre. */
  tolerancia: { pct: number; abs: number };
}

/**
 * `[RE.35.3]` Entradas sin orden de compra, por quién las capturó en Kepler —
 * `GET /finance/goods-receipts/sin-oc`. Es el correctivo AL ORIGEN (ADR-085): la OC es obligatoria sin
 * excepción, y lo que la mejora es que la captura la registre, no aflojar la regla.
 * ⚠️ Kepler guarda quién CAPTURÓ el vale de entrada, no quién pidió la mercancía.
 */
export interface EntradasSinOcFila {
  sucursal: string;
  /** Usuario de Kepler que capturó el vale (`null` si Kepler no lo trae, p. ej. Wincaja). */
  usuario: string | null;
  entradas: number;
  sin_oc: number;
  monto_sin_oc: number;
}

export interface EntradasSinOcResumen {
  desde: string;
  hasta: string;
  filas: EntradasSinOcFila[];
  total_entradas: number;
  total_sin_oc: number;
  monto_sin_oc: number;
}

// ═══════════════════════════ [RE.35.7] Captura por lote: identificar la entrada ═══════════════════════════

/** Lo leído de UN papel escaneado (lo que manda la pantalla para identificar su entrada). */
export interface IdentificarLectura {
  uuid?: string | null;
  rfc?: string | null;
  proveedor?: string | null;
  folio?: string | null;
  total?: number | null;
  fecha?: string | null;
  sello?: boolean | null;
  firma?: boolean | null;
}

/** Una entrada de Kepler que puede ser la de ese papel. */
export interface IdentificacionCandidata {
  sucursal: string;
  folio: string;
  receipt_date: string | null;
  proveedor_nombre: string | null;
  proveedor_rfc: string | null;
  oc_folio: string | null;
  monto: number;
  /** total del documento (CFDI, o lo leído) − entrada. */
  diferencia: number;
  /** El proveedor de la entrada es el emisor (por RFC o por nombre). null = no se pudo comparar. */
  proveedor_ok: boolean | null;
  /** Documentos ya adjuntos a esa entrada. */
  deposits: number;
  /**
   * `[RE.43.1]` `false` = se halló por el folio del PROVEEDOR (`referencia` de Kepler) y su importe
   * NO cuadra con lo leído (el OCR pudo leer mal el total). Nunca sale «listo» así. Ausente = se
   * halló por importe, como siempre.
   */
  importe_ok?: boolean;
}

export type IdentificacionConfianza = 'listo' | 'revisar' | 'elegir' | 'sin_entrada';

export type IdentificacionMotivo =
  | 'todo_coincide'
  | 'sin_cfdi'
  | 'liga_sugerida'
  | 'proveedor_sin_confirmar'
  | 'sin_sello'
  | 'sin_firma'
  | 'sello_no_visible'
  | 'ya_tiene_papel'
  | 'varias_entradas'
  | 'otras_parecidas'
  | 'fecha_lejana'
  | 'sin_lectura'
  | 'sin_candidatas'
  | 'importe_no_cuadra';

/**
 * `POST /finance/goods-receipts/identificar`. El papel identifica (UUID, RFC, folio, total), el CFDI
 * de ContPAQi informa (total y emisor), y con eso se buscan las entradas de Kepler que cuadran.
 * ⛔ Nada se guarda aquí: «listo» sólo significa que la propuesta viene pre-marcada.
 */
export interface IdentificacionEntrada {
  cfdi: { uuid: string; emisor_rfc: string; emisor_nombre: string | null; folio: string | null; total: number; fecha: string | null } | null;
  liga: ExpedienteLiga | null;
  candidatas: IdentificacionCandidata[];
  confianza: IdentificacionConfianza;
  /** La entrada propuesta (null en «elegir» y «sin_entrada»). */
  propuesta: { sucursal: string; folio: string } | null;
  /** Todo lo que impide «listo», en orden. Vacío si es «listo». */
  motivos: IdentificacionMotivo[];
}

/** Texto corto que explica POR QUÉ la fila quedó como quedó (pantalla y servidor dicen lo mismo). */
export function textoMotivoIdentificacion(m: IdentificacionMotivo): string {
  switch (m) {
    case 'todo_coincide': return 'CFDI exacto, una entrada que cuadra, sello y firma';
    case 'sin_cfdi': return 'Sin CFDI en ContPAQi que lo confirme';
    case 'liga_sugerida': return 'CFDI sugerido (no exacto): confírmalo';
    case 'proveedor_sin_confirmar': return 'El proveedor de la entrada no se pudo confirmar';
    case 'sin_sello': return 'El papel no trae sello de recibido';
    case 'sin_firma': return 'El papel no trae firma de quien recibió';
    case 'sello_no_visible': return 'No se distinguió el sello o la firma';
    case 'ya_tiene_papel': return 'Esa entrada ya tiene documento: confirma';
    case 'varias_entradas': return 'Varias entradas posibles: elige';
    case 'fecha_lejana': return 'La entrada está lejos de la fecha de la factura: confirma';
    case 'otras_parecidas': return 'Hay otras entradas del mismo proveedor e importe: confirma la fecha';
    case 'sin_lectura': return 'No se leyó ni el total ni el UUID';
    case 'sin_candidatas': return 'Ninguna entrada de Kepler cuadra';
    case 'importe_no_cuadra': return 'Se halló por el folio del proveedor, pero el importe no cuadra: confirma el total';
  }
}
