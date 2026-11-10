/**
 * `[CGA-A.60]` Un retiro de CAOS paga un lote de egresos de la cola: la forma del boundary REST.
 *
 * Sólo tipos (ADR-052): producer (`CashLedgerController`) y consumer (`/finanzas/caja-general`)
 * importan lo mismo, así que un cambio de forma es error de compilación en los dos lados.
 */

/** Un retiro de CAOS al que todavía le queda dinero libre: puede pagar un lote. */
export interface CaosRetiroLibre {
  device: string;
  external_id: number;
  occurred_at: string;
  ref: string | null;
  user_external: string | null;
  /** Lo que sacó la máquina. */
  total: number;
  /** Lo que todavía no explica ningún egreso. */
  libre: number;
}

export interface CaosRetirosLibres {
  rows: CaosRetiroLibre[];
  desde: string;
  limit: number;
}

/** Cómo quedó el retiro después de pagar el lote. */
export interface CaosRetiroDelLote {
  device: string;
  external_id: number;
  ref: string | null;
  /** Lo que tenía libre el retiro al empezar el lote. */
  libre_antes: number;
  /** Σ de lo que tomaron los egresos guardados. */
  tomado: number;
  /** Lo que el retiro todavía tiene libre: el corte lo espera en el cajón si nadie más lo toma. */
  libre_despues: number;
  /** Lo que el retiro NO alcanzó a pagar de los egresos guardados: salió del cajón. */
  del_cajon: number;
}

/**
 * `[CGA-A.71]` Un pendiente de Kepler que la cola ofrece y que ya entró al libro por otro camino.
 *
 * Edgar, 2026-11-09: la cola de Captura mostraba 88 pendientes. Medido ese día: 21 ya estaban en el
 * libro, 19 capturados desde el depósito de CAOS sin declarar el documento («rd21 10/10» es el cobro
 * U-A-5 0000008 de la ruta 21) y 2 con otra llave. Confirmarlos los metería dos veces. No se esconden:
 * se marcan, y quien captura liga en vez de capturar.
 *
 * - `deposito_ruta`: un depósito de CAOS capturado que declara la MISMA ruta y el mismo día (certeza alta).
 * - `deposito_importe`: un depósito de CAOS capturado sin ruta, mismo importe ± $1, uno con uno (por confirmar).
 * - `otra_llave`: un cobro capturado de la misma camioneta, mismo día e importe, con otro folio (por confirmar).
 * - `otra_camioneta`: el mismo documento e importe capturado con la llave de otra camioneta (por confirmar).
 */
export type ComoYaEnLibro = 'deposito_ruta' | 'deposito_importe' | 'otra_llave' | 'otra_camioneta';

export interface YaEnLibro {
  como: ComoYaEnLibro;
  certeza: 'alta' | 'por_confirmar';
  /** `finance.cash_ledger.id` de esa captura: con él se liga (`[CGA-A.72]`). */
  id: string | null;
  /** El movimiento del libro que ya lo trae. */
  folio: string;
  fecha: string;
  monto: number;
  /** La glosa de esa captura: lo que la persona escribió (p. ej. «CAOS Deposito #1580 · rd21 10/10»). */
  glosa: string | null;
}

/** `[CGA-A.72]` Ligar un depósito de CAOS ya capturado con el documento de Kepler que es. */
export interface LigarDocumentoInput {
  /** La llave del documento de Kepler, como la trae la cola (`01-001|U-A-5|0000008|0011`). */
  origen_ref: string;
}

export interface LigarDocumentoResultado {
  folio: string;
  declared_doc_ref: string;
  /** `true` = ya estaba ligado a ese mismo documento: no se escribió nada. */
  ya_estaba: boolean;
  como?: ComoYaEnLibro;
  certeza?: YaEnLibro['certeza'];
}
