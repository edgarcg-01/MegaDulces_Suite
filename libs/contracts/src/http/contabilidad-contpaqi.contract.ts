/**
 * `[LC.21]` — **Lo que devuelven los dos desgloses de la contabilidad ContPAQi.**
 *
 * Son los dos endpoints que abren una cifra: los renglones de póliza de una cuenta de la
 * balanza, y los movimientos de una fila del auxiliar bancario. Nacen acá —y no en el
 * servicio— porque la pantalla ya declaraba estas mismas formas a mano
 * (`apps/view/.../contabilidad-contpaqi.service.ts`), y dos copias de una forma es como se
 * fabrica una discrepancia que nadie ve (ADR-052).
 *
 * ⚠️ **Deuda con nombre:** las copias del front siguen vivas; colapsarlas contra estas es un
 * item aparte, porque tocar la pantalla acá ensancharía un cambio de tipado a un cambio de UI.
 */

/** Un renglón de póliza de ContPAQi, tal como lo publica el desglose de la balanza. */
export interface ContpaqiRenglonPoliza {
  anio_mes: string;
  tipo_pol: string;
  folio: string;
  num_movto: number;
  cargo_abono: string;
  importe: number;
  referencia: string | null;
  concepto: string | null;
  cfdi_uuid: string | null;
}

/**
 * Los renglones de póliza de UNA cuenta en el rango, con su suma y la de la balanza.
 *
 * ⭐ `cuadra` existe porque las dos sumas pueden no coincidir y eso es un hallazgo, no un
 * error: hay cuentas con cargos en la balanza y ningún renglón de póliza importado. Se
 * devuelven las dos y se dice si cuadran, en vez de suponerlo.
 */
export interface ContpaqiBalanzaRenglones {
  cuenta: string;
  nombre: string | null;
  from_mes: string;
  to_mes: string;
  page: number;
  page_size: number;
  renglones: number;
  cargos: number;
  abonos: number;
  balanza: { cargos: number; abonos: number };
  cuadra: boolean;
  filas: ContpaqiRenglonPoliza[];
}

/** Un movimiento bancario de ContPAQi dentro del desglose del auxiliar. */
export interface ContpaqiMovimientoBanco {
  /** `YYYY-MM-DD`, o `null` si la póliza no trae fecha. */
  fecha: string | null;
  cuenta: string;
  banco: string;
  flujo: string;
  importe: number;
  concepto: string | null;
  referencia: string | null;
  /** `tipo/folio` de la póliza, o `null` si no la tiene. */
  poliza: string | null;
  conciliado: boolean;
}

/** Los movimientos detrás de una fila del auxiliar bancario, con la suma de lo filtrado. */
export interface ContpaqiBancoMovimientos {
  cuenta: string | null;
  mes: string | null;
  flujo: string | null;
  from_mes: string;
  to_mes: string;
  page: number;
  page_size: number;
  movs: number;
  depositos: number;
  retiros: number;
  filas: ContpaqiMovimientoBanco[];
}

/**
 * Lo que acepta el desglose de la balanza. `page` es 1-based.
 *
 * ⚠️ `from_mes`/`to_mes` son `string`, no `unknown`: el servicio se los pasa tal cual a su
 * resolvedor de rango, que los exige tipados. Los demás llegan del query string y el servicio
 * los normaliza (`String(…)`, `Number(…)`), así que ahí `unknown` es lo honesto.
 */
export interface ContpaqiBalanzaRenglonesQuery {
  cuenta?: unknown;
  from_mes?: string;
  to_mes?: string;
  page?: unknown;
  page_size?: unknown;
}

/** Lo que acepta el desglose del auxiliar bancario. `page` es 1-based. */
export interface ContpaqiBancoMovimientosQuery {
  cuenta?: unknown;
  mes?: unknown;
  flujo?: unknown;
  from_mes?: string;
  to_mes?: string;
  page?: unknown;
  page_size?: unknown;
}

/** `[LC.21]` Un CFDI del proveedor, dentro del desglose «CFDI vs Contabilidad». */
export interface CfdiDeProveedor {
  uuid: string;
  serie: string | null;
  folio: string | null;
  /** `YYYY-MM-DD`, o `null` si el CFDI no trae fecha. */
  fecha: string | null;
  tipo: string;
  /** Subtotal: la base gravable, sin impuestos. */
  base: number;
  iva: number;
  total: number;
  metodo_pago: string | null;
  /** `vigente` · `cancelado` · `desconocido` — nunca se dibuja «vigente» por omisión. */
  estatus_sat: string;
  tiene_xml: boolean;
}

/** `[LC.21]` Los CFDI de UN proveedor en el periodo: los que cuenta su renglón del cruce. */
export interface CfdisProveedorResponse {
  period: string;
  rfc: string;
  num_cfdis: number;
  total: number;
  cfdis: CfdiDeProveedor[];
}
