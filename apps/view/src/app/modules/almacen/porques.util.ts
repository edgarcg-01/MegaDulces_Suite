/**
 * Fase AB — **los porqués de Autoabasto**, como funciones puras.
 *
 * El plan del 2026-09-21 pide que cada sugerencia se explique. Esas explicaciones son **texto de
 * negocio**, no presentación: las lee el almacenista para justificar un pedido frente a su
 * encargado. Por eso viven acá y no dentro del componente — un componente sólo se prueba con
 * `TestBed`, y lo que hay que fijar con candado es justo esto: **qué dice el sistema cuando el
 * dato falta**.
 *
 * Regla de todo el archivo: **cuando falta el dato se dice por qué falta**. No se rellena con un
 * default. Un "Compra" inventado sobre un par sin ruta configurada, o un "Objetivo 0" que en
 * realidad era `undefined`, son cifras falsas con cara de sanas (ADR-056).
 */

/** Lo que estas funciones necesitan de un renglón de la mesa. Subconjunto de `AutoabastoRow`. */
export interface PorqueRow {
  on_hand: number;
  in_transit: number;
  suggested_qty: number;
  transfer_in: number;
  buy_qty: number;
  target_qty: number | null;
  replenish_via: 'purchase' | 'transfer' | null;
  source_warehouse_code: string | null;
  supplier_name: string | null;
  cadence_days: number | null;
  next_due_date: string | null;
  lead_time_days: number | null;
  avg_daily_units: number | null;
}

/** Cajas con hasta 1 decimal. `—` cuando no es un número, en vez de imprimir `NaN`. */
export function qty(v: number | null | undefined): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('es-MX', { maximumFractionDigits: 1 });
}

/**
 * Formatea `YYYY-MM-DD` **sin pasar por la zona horaria**.
 *
 * ⛔ `new Date('2026-09-25T00:00:00.000Z').toLocaleDateString('es-MX')` imprime **24 de sep**: la
 * API serializa un `date` de Postgres como medianoche UTC y el navegador lo renderiza en hora de
 * México (−06:00), o sea el día anterior. Es el bug que LC.16 encontró en el libro de compras, y
 * en una fecha de entrega se leería como "llega un día antes". Por eso se parsea el TEXTO y se
 * construye la fecha en hora local.
 */
export function fechaCorta(v: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v ?? '');
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    .toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
}

/** Días de calendario entre `hoy` y una fecha `YYYY-MM-DD`. `hoy` se inyecta para poder probarlo. */
export function diasHasta(v: string | null | undefined, hoy: Date = new Date()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v ?? '');
  if (!m) return null;
  const a = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()).getTime();
  const b = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Math.round((b - a) / 86_400_000);
}

/**
 * Días que aguanta la existencia a la venta medida.
 *
 * `null` = **sin venta medida**, que NO es "dura para siempre": es que no hay con qué calcularlo.
 * Devolver `Infinity` o un número grande acá pondría fechas de agotamiento inventadas en pantalla.
 */
export function diasDeCobertura(r: Pick<PorqueRow, 'on_hand' | 'avg_daily_units'>): number | null {
  const v = Number(r.avg_daily_units ?? 0);
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.floor(Number(r.on_hand ?? 0) / v);
}

/** ¿Por qué a ese origen? — el texto corto de la columna. */
export function origenTexto(r: Pick<PorqueRow, 'replenish_via' | 'source_warehouse_code' | 'supplier_name'>): string {
  if (r.replenish_via === 'transfer') return r.source_warehouse_code ? `← ${r.source_warehouse_code}` : 'Traspaso';
  if (r.replenish_via === 'purchase') return r.supplier_name || 'Compra';
  return r.supplier_name || '—';
}

/**
 * Clase del chip de origen. **Sin ruta configurada tiene clase propia**: si compartiera la de
 * compra, un par sin canal se vería exactamente igual que uno que sí se compra.
 */
export function origenCls(r: Pick<PorqueRow, 'replenish_via'>): string {
  if (r.replenish_via === 'transfer') return 'ab-o-transfer';
  if (r.replenish_via === 'purchase') return 'ab-o-buy';
  return 'ab-o-none';
}

/** ¿Por qué a ese origen? — la explicación larga. */
export function origenPorQue(r: Pick<PorqueRow, 'replenish_via' | 'source_warehouse_code' | 'supplier_name'>): string {
  if (r.replenish_via === 'transfer') {
    const src = r.source_warehouse_code ? `el almacén ${r.source_warehouse_code}` : 'otro almacén';
    return `Traspaso: la ruta configurada para este proveedor en esta sucursal surte desde ${src}.`;
  }
  if (r.replenish_via === 'purchase') {
    return `Compra directa a ${r.supplier_name || 'su proveedor'}: es la ruta configurada para esta sucursal.`;
  }
  return 'Sin ruta configurada para este proveedor en esta sucursal. El origen no está decidido — no se supone que sea compra.';
}

/** ¿Por qué debo pedir hoy? — el texto corto de la columna. */
export function cuandoTexto(r: Pick<PorqueRow, 'next_due_date' | 'cadence_days'>): string {
  const f = fechaCorta(r.next_due_date);
  if (f) return f;
  return r.cadence_days ? `cada ${r.cadence_days} d` : '—';
}

/** ¿Por qué debo pedir hoy? — la explicación larga. */
export function cuandoPorQue(r: PorqueRow, hoy: Date = new Date()): string {
  const partes: string[] = [];
  const f = fechaCorta(r.next_due_date);
  const d = diasHasta(r.next_due_date, hoy);
  if (f) {
    partes.push(
      d === null ? `Próxima entrega: ${f}.`
        : d < 0 ? `La entrega del ${f} está vencida por ${-d} día(s).`
        : d === 0 ? `La entrega es HOY (${f}).`
        : `Próxima entrega: ${f}, en ${d} día(s).`);
  } else if (r.cadence_days) {
    partes.push(`El canal entrega cada ${r.cadence_days} día(s), pero no hay fecha de próxima entrega registrada.`);
  } else {
    partes.push('Sin calendario de entregas configurado para este origen.');
  }
  if (r.lead_time_days) partes.push(`Tarda ${r.lead_time_days} día(s) en llegar desde que se solicita.`);
  const cob = diasDeCobertura(r);
  partes.push(cob === null
    ? 'La existencia no tiene venta medida, así que no se puede estimar cuándo se agota.'
    : `Con la venta actual, la existencia alcanza ~${cob} día(s).`);
  return partes.join(' ');
}

/**
 * ¿Por qué esa cantidad? — la resta, con el objetivo que publicó el MOTOR.
 *
 * ⚠️ `target_qty` lo agregó AB.3b. Si responde una API anterior llega `undefined`, y `qty()` lo
 * imprimiría como **0**: se leería "el objetivo es cero" en vez de "esta API no lo publica".
 */
export function cantidadPorQue(r: PorqueRow): string {
  if (r.target_qty == null || !Number.isFinite(Number(r.target_qty))) {
    return `Faltan ${qty(r.suggested_qty)} caja(s) para el objetivo, pero esta versión de la API no publica ` +
      `el objetivo que usó, así que la resta no se puede mostrar.`;
  }
  const base = `Objetivo ${qty(r.target_qty)} − existencia ${qty(r.on_hand)} − en camino ${qty(r.in_transit)} ` +
    `= faltan ${qty(r.suggested_qty)} caja(s).`;
  if (r.transfer_in > 0 && r.buy_qty > 0) {
    return `${base} De eso, ${qty(r.transfer_in)} sale del sobrante de la red y ${qty(r.buy_qty)} hay que comprarlo.`;
  }
  if (r.transfer_in > 0) return `${base} Se cubre completo con el sobrante de otras sucursales.`;
  return base;
}
