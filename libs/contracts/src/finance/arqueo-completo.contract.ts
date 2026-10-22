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
  cheques?: number | null;
  papeles?: number | null;
  usd?: number | null;
  tipo_cambio?: number | null;
  tipo_cambio_fuente?: string | null;
  nota?: string | null;
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
}
