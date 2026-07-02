// Fase LM.5 — DTOs del corte de caja del repartidor. Validación en el servicio.

/** Denominaciones MXN válidas para el arqueo. */
export const MXN_DENOMINATIONS = [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5];

export interface OpenLiquidationDto {
  rider_user_id: string;
  business_date: string; // YYYY-MM-DD
  branch_store_id?: string;
}

export interface CloseLiquidationDto {
  /** Arqueo por denominación: { "1000": 2, "500": 5, ..., "0.5": 3 }. */
  cash_breakdown: Record<string, number>;
  notes?: string;
}
