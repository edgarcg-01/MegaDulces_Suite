/**
 * `[RE.83]` Facturas devueltas: lo que lee la campana de quien puede subir y lo que responde el aviso
 * manual a la sucursal. Lo sirve `finance/goods-receipts/devueltas`.
 */
export interface DevueltaFila {
  proof_id: string;
  sucursal: string;
  sucursal_nombre: string;
  folio: string;
  proveedor: string | null;
  monto: number | null;
  motivo: string | null;
  motivo_codigo: string | null;
  devuelta_por: string | null;
  devuelta_at: string;
  /** La devolución o el último aviso manual, lo más reciente: la campana lo usa para saber si es nuevo. */
  aviso_at: string;
}

export interface DevueltasResumen {
  /** Todas las devueltas pendientes; `recientes` trae sólo las primeras 30. */
  n: number;
  recientes: DevueltaFila[];
  /** `false` = quien pregunta sube en TODAS las sucursales (oficina): la campana no le muestra devueltas. */
  de_sucursal: boolean;
}

export interface AvisoSucursal {
  sucursal: string;
  sucursal_nombre: string;
  devueltas: number;
  /** Personas a las que les llega: pueden subir en esa sucursal (sin el god-mode). 0 = a nadie. */
  destinatarios: number;
}
