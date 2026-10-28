/**
 * `[ETQ-HISTORIAL]` Historial de cambios de precio de UN producto, en las plazas que la bitácora de Kepler sirve.
 *
 * Fuente: `analytics.v_label_price_changes` (derivada de `kepler_ods.kdpv_bitacora_precios`), la única que guarda el
 * precio ANTERIOR. Ver `FASE_ETQ_HISTORIAL_PRECIOS`.
 *
 * ⭐ Lo que la medición en prod encontró y por qué existe `compactarHistorial`: Kepler **recalcula y vuelve a escribir** el
 * mismo cambio. El SKU 92013 en la plaza 06 tiene 687 filas en 98 días y **676 de sus 686 pasos repiten el precio**
 * (`1152.44 → 1152.45`, de 5 a 10 veces por día); en dos años tiene 21 precios distintos. Las filas crudas son la verdad de
 * lo que Kepler escribió; los tramos son la verdad de lo que le pasó al precio. La pantalla ofrece las dos.
 */

import type { Freshness } from './provenance.contract';

/** Una fila de la bitácora tal cual (ya filtrada a los cambios que mueven el precio impreso). */
export interface PriceHistoryRow {
  sucursal: string;
  /** `YYYY-MM-DD`. */
  fecha: string;
  /** `HH:MM:SS.cc`, o `null` si la bitácora no la trae. */
  hora: string | null;
  /** Presentación (PZA, PAQ, CJA…). `null` = la bitácora no la trae: NO se inventa. */
  unidad: string | null;
  precio_anterior: number | null;
  precio_nuevo: number | null;
  delta: number | null;
  /** El precio nuevo es cero: Kepler le quitó el precio. No es una rebaja. */
  es_baja: boolean;
}

/** Un tramo: el precio que tuvo una presentación en una plaza, de `desde` a `hasta`. */
export interface PriceHistoryRun {
  sucursal: string;
  unidad: string | null;
  desde: string;
  hasta: string;
  /** El precio que quedó en ese tramo. */
  precio: number | null;
  /** Lo que había justo antes de que empezara el tramo (el `precio_anterior` de su primera fila). */
  precio_anterior: number | null;
  delta: number | null;
  es_baja: boolean;
  /** Cuántas filas de la bitácora lo escribieron. 1 = un cambio limpio; 8 = Kepler lo reescribió 8 veces. */
  veces: number;
}

export interface PriceHistoryResult {
  sku: string;
  items: PriceHistoryRow[];
  /** Días pedidos hacia atrás; `null` = toda la bitácora. */
  dias: number | null;
  /** El servidor alcanzó su tope y recortó lo MÁS VIEJO. Se dice en pantalla: un recorte mudo se lee como «no hubo más». */
  truncado: boolean;
  tope: number;
  /** Qué tan al día va el carril de precios del ERP: una bitácora atrasada se lee igual que «no cambió nada». Se declara. */
  freshness: Freshness;
}

const orden = (a: PriceHistoryRow, b: PriceHistoryRow): number =>
  a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : (a.hora ?? '') < (b.hora ?? '') ? -1 : (a.hora ?? '') > (b.hora ?? '') ? 1 : 0;

/**
 * Funde las filas CONSECUTIVAS que dejan el mismo precio, por (plaza, presentación).
 *
 *  · Sólo se funden vecinas: `A → B → A` son TRES tramos, no dos (el precio volvió, y eso es un hecho).
 *  · El tramo dura hasta que cambia el precio; `hasta` es la última fecha en que Kepler lo escribió.
 *  · Una fila con `precio_nuevo` nulo nunca se funde con otra: no se sabe qué precio dejó.
 *  · Sin hora completa en dos filas del mismo día no se inventa su orden: se respeta el de llegada (el sort es estable).
 *
 * Devuelve por plaza y presentación, del tramo más reciente al más viejo.
 */
export function compactarHistorial(filas: readonly PriceHistoryRow[]): PriceHistoryRun[] {
  const grupos = new Map<string, PriceHistoryRow[]>();
  for (const f of filas) {
    const k = `${f.sucursal}|${f.unidad ?? ''}`;
    const g = grupos.get(k);
    if (g) g.push(f);
    else grupos.set(k, [f]);
  }
  const out: PriceHistoryRun[] = [];
  for (const g of [...grupos.values()].sort((a, b) => (a[0].sucursal + (a[0].unidad ?? '')).localeCompare(b[0].sucursal + (b[0].unidad ?? '')))) {
    const asc = [...g].sort(orden);
    const tramos: PriceHistoryRun[] = [];
    for (const f of asc) {
      const ult = tramos[tramos.length - 1];
      if (ult && ult.precio !== null && f.precio_nuevo !== null && ult.precio === f.precio_nuevo) {
        ult.hasta = f.fecha;
        ult.veces += 1;
        continue;
      }
      tramos.push({
        sucursal: f.sucursal, unidad: f.unidad, desde: f.fecha, hasta: f.fecha, precio: f.precio_nuevo,
        precio_anterior: f.precio_anterior, delta: f.delta, es_baja: f.es_baja, veces: 1,
      });
    }
    out.push(...tramos.reverse());
  }
  return out;
}
