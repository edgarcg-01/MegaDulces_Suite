/**
 * `[CGS.41]` **El arqueo completo de la caja**: lo que antes sólo contaba el Access de Control
 * (jubilado el 2026-10-22) y ahora cuenta la Suite.
 *
 * Cinco rubros: efectivo pieza por pieza, caja fuerte, cheques, vales y papeles, y dólares con su
 * tipo de cambio y de dónde salió ese tipo de cambio. Un rubro en `null` es «no se contó»; en 0 es
 * «se contó y no hay».
 *
 * - `recuento`: la supervisora vuelve a contar a ciegas el cajón de un corte cerrado, a la mañana
 *   siguiente y antes de mover dinero. Es el testigo del conteo de ese corte.
 * - `intermedio`: cualquier arqueo a media jornada.
 */
export type TipoArqueoCaja = 'recuento' | 'intermedio';

export interface PiezaArqueoCaja {
  /** Clave del catálogo (`DENOMINACIONES_MXN`): `500`, `20m`, `0.5`… */
  denom_key: string;
  piezas: number;
}

/** Lo que manda la pantalla. */
export interface NuevoArqueoCajaInput {
  tipo: TipoArqueoCaja;
  /** Obligatorio en el recuento: el corte que se recuenta. */
  corte_id?: string | null;
  piezas: PiezaArqueoCaja[];
  morralla?: number | null;
  caja_fuerte?: number | null;
  /** De dónde salió la cifra de la caja fuerte: `pantalla de la máquina`, `conteo físico`… */
  caja_fuerte_fuente?: string | null;
  /**
   * ⛔ `[CGS.59]` Ya no se teclean: salen de `documentos`. Un importe sin sus renglones se rechaza
   * (era lo que arrastraba Control: el mismo importe de papeles durante un año).
   */
  cheques?: null;
  papeles?: null;
  /** `[CGS.59]` Los cheques y los papeles, uno por uno. Sin esto, los dos quedan «no se contó». */
  documentos?: DocumentosArqueoInput | null;
  usd?: number | null;
  tipo_cambio?: number | null;
  tipo_cambio_fuente?: string | null;
  nota?: string | null;
}

// ── `[CGS.59]` Cheques y papeles, uno por uno ───────────────────────────────────────────────────
//
// Edgar, 2026-10-30: «cuando hay un cheque, crédito o papel… cómo agregar esos apartados». Cada
// documento es un renglón con lo que lo identifica; el importe del apartado es la suma de los que
// ESTÁN. Lo que había en el arqueo anterior se marca —sigue o salió, y si salió, por qué—, nunca se
// vuelve a teclear y nunca desaparece sin decir a dónde fue.

export type TipoDocumentoCaja = 'cheque' | 'papel';

/** El papel: `vale` = alguien de la empresa se llevó efectivo; `credito` = un cliente quedó a deber. */
export type ClasePapel = 'vale' | 'credito';

export const CLASE_PAPEL_TEXTO: Readonly<Record<ClasePapel, string>> = Object.freeze({
  vale: 'Vale',
  credito: 'Crédito',
});

/** Por qué ya no está en la caja un documento que estaba en el arqueo anterior. */
export type SalidaDocumento = 'depositado' | 'devuelto' | 'pagado' | 'comprobado' | 'otro';

export const SALIDAS_DE: Readonly<Record<TipoDocumentoCaja, readonly SalidaDocumento[]>> = Object.freeze({
  cheque: ['depositado', 'devuelto', 'otro'],
  papel: ['pagado', 'comprobado', 'otro'],
});

export const SALIDA_TEXTO: Readonly<Record<SalidaDocumento, string>> = Object.freeze({
  depositado: 'Se depositó',
  devuelto: 'Lo devolvió el banco',
  pagado: 'Lo pagaron',
  comprobado: 'Se comprobó',
  otro: 'Otra cosa',
});

/**
 * Un renglón de un apartado. Con `pieza`, es un documento que estaba en el arqueo anterior: sólo se
 * dice si sigue o salió (sus datos no se vuelven a teclear y no se pueden cambiar). Sin `pieza`, es
 * uno nuevo y lleva sus datos.
 */
export interface DocumentoArqueoInput {
  pieza?: string | null;
  estado: 'esta' | 'salio';
  salida?: SalidaDocumento | null;
  /** Obligatoria con la salida `otro`. */
  salida_nota?: string | null;
  // ── Sólo para uno nuevo ──
  /** Sólo el papel. */
  clase?: ClasePapel | null;
  monto?: number | null;
  /** Sólo el cheque. */
  banco?: string | null;
  /** Sólo el cheque. */
  numero?: string | null;
  /** El cheque: quién lo firmó o de quién vino. El papel: quién debe. */
  de_quien?: string | null;
  /** El papel: por qué. En el cheque, opcional. */
  concepto?: string | null;
  /** `YYYY-MM-DD`: la del cheque o la del papel. */
  fecha?: string | null;
}

export interface DocumentosArqueoInput {
  /**
   * El último arqueo de la Suite que vio la pantalla al abrir (`DocumentosEnCajaDto.base`). Si
   * alguien guardó otro mientras tanto, la lista de «lo que había» ya no es la de ahora: 409.
   */
  base: string | null;
  /** `null` = no se contaron; `[]` = se contaron y no hay. */
  cheques: DocumentoArqueoInput[] | null;
  papeles: DocumentoArqueoInput[] | null;
}

/** Un documento que está en la caja según el último arqueo que contó su apartado. */
export interface DocumentoEnCaja {
  pieza: string;
  tipo: TipoDocumentoCaja;
  clase: ClasePapel | null;
  monto: number;
  banco: string | null;
  numero: string | null;
  de_quien: string;
  concepto: string | null;
  fecha: string | null;
  /** `YYYY-MM-DD` del primer arqueo en que se vio: cuánto lleva en la caja. */
  visto_desde: string;
}

export interface ApartadoEnCaja {
  /** El último arqueo de la Suite que contó este apartado. `null` = nunca se contó con detalle. */
  desde: { arqueo_id: string; at: string; quien: string | null } | null;
  /** Lo que estaba: cada uno se marca al contar. */
  piezas: DocumentoEnCaja[];
  /**
   * Lo último que se declaró SIN detalle (Control, o un arqueo anterior a `[CGS.59]`): se muestra
   * para que se cuente uno por uno, no se arrastra. `null` = no hay nada así.
   */
  sin_detalle: { monto: number; origen: 'control' | 'suite'; at: string } | null;
}

/** `GET /finance/cash-ledger/arqueos-caja/documentos`: lo que la pantalla pide marcar. */
export interface DocumentosEnCajaDto {
  /** `false` = la base todavía no tiene la tabla de los renglones (migración `[CGS.59]` sin aplicar). */
  instalado: boolean;
  /** El último arqueo de la Suite (de cualquier apartado): la llave contra dos conteos a la vez. */
  base: string | null;
  cheques: ApartadoEnCaja;
  papeles: ApartadoEnCaja;
}

/** Lo que cambió en un apartado al guardar. */
export interface ResumenApartado {
  total: number;
  siguen: number;
  entraron: number;
  salieron: Array<{ texto: string; monto: number; salida: SalidaDocumento; nota: string | null }>;
}

/** Cómo se nombra un documento en una línea: «Banamex 001234 · Juan Pérez», «Vale · Pedro: gasolina». */
export function textoDocumento(d: {
  tipo: TipoDocumentoCaja; clase?: ClasePapel | null; banco?: string | null; numero?: string | null;
  de_quien: string; concepto?: string | null;
}): string {
  if (d.tipo === 'cheque') return `${[d.banco, d.numero].filter(Boolean).join(' ')} · ${d.de_quien}`;
  const clase = d.clase ? CLASE_PAPEL_TEXTO[d.clase] : 'Papel';
  return `${clase} · ${d.de_quien}${d.concepto ? `: ${d.concepto}` : ''}`;
}

/** Un arqueo, de la Suite o del histórico de Control (`origen`). */
export interface ArqueoCajaDto {
  origen: 'suite' | 'control';
  /** Id de la Suite o folio de Control (`A23706`). */
  folio: string;
  /** Instante ISO. */
  at: string;
  /** `YYYY-MM-DD`. */
  dia: string;
  tipo: TipoArqueoCaja | 'conteo';
  /** Trae los cinco rubros. */
  completo: boolean;
  efectivo: number;
  caja_fuerte: number | null;
  cheques: number | null;
  papeles: number | null;
  usd: number | null;
  tipo_cambio: number | null;
  tipo_cambio_fuente: string | null;
  quien: string | null;
  corte_id: string | null;
  nota: string | null;
  /** Suma en pesos de lo que se contó. `null` si falta algún rubro (no se suma lo que no se contó). */
  total_mxn: number | null;
}

/**
 * Lo que devuelve guardar un recuento: recién AHORA se revela contra qué se comparó. Contar
 * viendo la cifra a la que hay que llegar no es contar.
 */
export interface ArqueoGuardadoDto {
  arqueo: ArqueoCajaDto;
  /** Sólo en el recuento: lo que selló el corte y la diferencia. */
  contra_corte: { folio: string; contado: number | null; diferencia: number | null } | null;
  /** `[CGS.59]` Lo que cambió en cada apartado. `null` = ese apartado no se contó. */
  documentos: { cheques: ResumenApartado | null; papeles: ResumenApartado | null };
}
