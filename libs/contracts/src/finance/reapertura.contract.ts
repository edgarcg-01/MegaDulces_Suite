/**
 * `[GX.30]` — **La forma de lo que viaja al reabrir un vale de gasto.**
 *
 * ## Por qué acá y no en cada lado
 * Estas dos formas nacieron en `expense-proofs.service.ts` y **a los dos días ya estaban
 * copiadas a mano** en `comprobaciones.service.ts` del frontend. Es exactamente lo que la
 * Fase VP midió y ADR-056 prohíbe: un tipo del borde que vive duplicado empieza idéntico y
 * termina distinto, y el día que se desincroniza nadie se entera — compila de los dos lados.
 *
 * ⚠️ Son tipos del BORDE HTTP, no del dominio: describen lo que sale por el cable. Si el
 * servicio necesita más campos adentro, los suma a su propia forma; lo que no puede hacer es
 * cambiar éstos sin que el frontend lo vea.
 */

/** Lo que devuelve pedir la reapertura: la solicitud queda esperando, nada se reabre solo. */
export interface SolicitudReaperturaCreada {
  id: string;
  /** Siempre `pending_approval` al crearse: quien firmó todavía no decidió. */
  estado: string;
}

/**
 * Una solicitud de reapertura esperando la firma de quien aprobó ESE vale.
 *
 * ⛔ El servidor sólo devuelve las que le tocan a quien pregunta. La pantalla no filtra
 * nada: si filtrara, un error suyo mostraría el vale de otro.
 */
export interface ReaperturaPendiente {
  /** Id de la solicitud (`finance.proposed_actions`), no del vale. */
  id: string;
  motivo: string | null;
  /** Quién la pidió — el capturista del vale. */
  solicita: string | null;
  created_at: string;
  /** El vale al que se refiere (`finance.expense_proofs`). */
  proof_id: string;
  folio_solicitud: string | null;
  proveedor: string | null;
  status: string;
  importe: number;
}

/** Lo que devuelve decidir: `reabierto:false` es una negativa, no un error. */
export interface ReaperturaDecidida {
  proof_id: string;
  reabierto: boolean;
}
