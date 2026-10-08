import type { ReceivingOrigin } from './receiving-origin';

/**
 * **El traspaso entre sucursales, como lo hace Kepler (`[WMS-REC.17]`).**
 *
 * Un traspaso NO es una compra y no viaja en los mismos documentos:
 *
 *   sale del origen   →  Embarque `U-D-41` (serie 2 = "Embarque Sucursal")
 *                        `c10` = destino como código `TI###`, `c32` = su nombre,
 *                        renglones en `kdm2` (vista viva `analytics.erp_shipment_lines`).
 *   entra al destino  →  Recepción `U-A-50` ("Recepción Traspaso Suc")
 *                        `c37`=41 · `c38`=serie · `c39`=folio del embarque que recibe.
 *
 * El Andén sólo leía la orden de entrada `XA2001`, que es el camino de las COMPRAS. Mientras
 * el CEDIS vivió en Wincaja, la sucursal registraba lo que le llegaba de él como si fuera una
 * compra (proveedor `TI000`), y por eso esos sí aparecían. Desde que el CEDIS entró a Kepler
 * (30-sep-2026) lo manda con su embarque, y la sucursal que lo recibe no lo veía en ninguna
 * parte. Ese fue el reporte: «CEDIS mandó mercancía a PH y no aparece para dar de alta las
 * caducidades».
 *
 * El vale de un traspaso se abre **desde el embarque**, que es el papel que trae el chofer y
 * que existe desde que el camión sale — la recepción `U-A-50` la captura el destino después,
 * y a veces nunca.
 */

/** Prefijo de la referencia de un vale de traspaso. Nunca es un código de sucursal. */
export const TRANSFER_REF_PREFIX = 'UD41';

/**
 * Cuánto tiempo hacia atrás se buscan embarques que siguen en camino.
 *
 * ⚠️ **Es una decisión, no una medición**: la demora real entre el embarque y la recepción
 * no se ha medido en producción (`medir-traspasos.js`, consulta 5). Siete días cubren un fin
 * de semana largo; si la medición dice otra cosa, se cambia ACÁ y en ningún otro lado.
 */
export const TRANSFER_WINDOW_DAYS = 7;

export interface TransferKey {
  /** Sucursal de Kepler donde vive el embarque (= la que embarcó). */
  origen: string;
  serie: number;
  folio: string;
}

/**
 * La referencia del vale: `UD41/<origen>/<serie>/<folio>`.
 *
 * El primer segmento NO es una sucursal a propósito. Los lectores viejos de `source_ref`
 * (`split_part(ref,'/',1)` = sucursal de la orden de entrada) caen así en vacío, en vez de
 * cruzar con una orden de entrada que casualmente tenga el mismo folio — el folio de Kepler
 * se repite entre sucursales y entre tipos de documento.
 */
export function transferRef(k: TransferKey): string {
  return `${TRANSFER_REF_PREFIX}/${String(k.origen).trim()}/${Number(k.serie)}/${String(k.folio).trim()}`;
}

/** Lo contrario de `transferRef`. `null` si la referencia no es de un traspaso. */
export function parseTransferRef(ref: string | null | undefined): TransferKey | null {
  const partes = String(ref ?? '').split('/');
  if (partes.length !== 4 || partes[0] !== TRANSFER_REF_PREFIX) return null;
  const [, origen, serieTx, folio] = partes;
  const serie = Number(serieTx);
  if (!origen || !folio || !Number.isInteger(serie)) return null;
  return { origen, serie, folio };
}

/**
 * De dónde viene un vale de traspaso.
 *
 * Acá el origen NO se deduce de un código `TI###` (que el ERP usa con nombres
 * contradictorios, ver `receiving-origin.ts`): es la **sucursal donde vive el embarque**,
 * que es un hecho del documento. `00` es el CEDIS.
 */
export function classifyShipmentOrigin(origen: string, nombre?: string | null): ReceivingOrigin {
  const isCedis = String(origen).trim() === '00';
  return {
    kind: 'transfer',
    isCedis,
    label: isCedis ? 'CEDIS' : 'Traspaso',
    name: nombre?.trim() || (isCedis ? 'CEDIS' : `Sucursal ${String(origen).trim()}`),
  };
}

/** Diferencia en días entre dos fechas `YYYY-MM-DD` (b − a). */
export function diasEntre(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/**
 * **¿Este embarque se ofrece en el menú del Andén?**
 *
 * La regla de las compras es «sólo los vales de hoy» (Edgar, 2026-09-24) y aplica a un
 * documento que Kepler crea cuando la mercancía YA entró. Un embarque es lo contrario:
 * se crea cuando el camión SALE, así que el día que llega casi nunca es el día del papel.
 * Con «sólo hoy» un camión que salió ayer en la tarde no aparecería nunca.
 *
 * Se ofrece si:
 *  1. salió **hoy**, o
 *  2. Kepler todavía **no registra la recepción** (`U-A-50`) y salió hace a lo más
 *     `TRANSFER_WINDOW_DAYS` — o sea, sigue en camino, o
 *  3. la recepción se registró **hoy** en Kepler (llegó hoy aunque haya salido antes).
 *
 * Lo que ya se abrió en el Andén nunca se ofrece aquí: pasa a «En curso».
 *
 * Fechas como `YYYY-MM-DD` en hora de México.
 */
export function transferVisible(t: { fecha: string; hoy: string; recibidoKepler: string | null }): boolean {
  if (t.fecha === t.hoy) return true;
  if (t.recibidoKepler && t.recibidoKepler === t.hoy) return true;
  if (t.recibidoKepler) return false;
  const dias = diasEntre(t.fecha, t.hoy);
  // Un documento fechado a futuro (pasa en Kepler: dedazo o fecha adelantada) sigue siendo
  // un camión que salió y no ha llegado: se ofrece. Se acota para que un "29/12" no viva
  // en el menú todo el año.
  return dias >= -TRANSFER_WINDOW_DAYS && dias <= TRANSFER_WINDOW_DAYS;
}
