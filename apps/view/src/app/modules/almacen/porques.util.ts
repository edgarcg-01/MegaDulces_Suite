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

import {
  coberturaAutoabasto, COBERTURA_AUTOABASTO_DEFAULT, warehouseName,
  type AutoabastoMesaRenglon, type EstadoRenglon, type SurteRenglon,
} from '@megadulces/contracts';

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
  /** `[AB.15]` Venta de 30 días en cajas (la misma cuenta que «V30d» de Compras). */
  venta_30d?: number | null;
  /** `[AB.15]` Temporalidad que multiplica la demanda; 1 = sin ajuste. */
  season_ratio?: number | null;
  /** `[AB.22]` Código del almacén: decide los días de cobertura del objetivo. */
  warehouse_code?: string | null;
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
  // `qty()` y no la cifra cruda: Postgres manda `numeric` como texto ("1.0") y se leía «cada 1.0 d».
  return Number(r.cadence_days) ? `cada ${qty(r.cadence_days)} d` : '—';
}

/** ¿Por qué debo pedir hoy? — la explicación larga. `[AB.28]` Sólo pide los campos que usa: la mesa nueva no trae `PorqueRow` entero. */
export function cuandoPorQue(
  r: Pick<PorqueRow, 'next_due_date' | 'cadence_days' | 'lead_time_days' | 'on_hand' | 'avg_daily_units'>,
  hoy: Date = new Date(),
): string {
  const partes: string[] = [];
  const f = fechaCorta(r.next_due_date);
  const d = diasHasta(r.next_due_date, hoy);
  if (f) {
    partes.push(
      d === null ? `Próxima entrega: ${f}.`
        : d < 0 ? `La entrega del ${f} está vencida por ${-d} día(s).`
        : d === 0 ? `La entrega es HOY (${f}).`
        : `Próxima entrega: ${f}, en ${d} día(s).`);
  } else if (Number(r.cadence_days)) {
    partes.push(`El canal entrega cada ${qty(r.cadence_days)} día(s), pero no hay fecha de próxima entrega registrada.`);
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
export function cantidadPorQue(r: PorqueRow, politicaTransito?: string | null, base_objetivo?: string | null): string {
  if (r.target_qty == null || !Number.isFinite(Number(r.target_qty))) {
    return `Faltan ${qty(r.suggested_qty)} caja(s) para el objetivo, pero esta versión de la API no publica ` +
      `el objetivo que usó, así que la resta no se puede mostrar.`;
  }
  const resta = restaPorQue(r, politicaTransito);
  // `[AB.15]` Con la base 'demanda' el objetivo NO es el máximo: es la venta de 30 días por la
  // temporalidad, igual que en Compras. Se dice de dónde sale, o el almacenista buscaría el
  // objetivo en la columna Máx y no lo encontraría.
  return base_objetivo === 'demanda' ? `${objetivoDemandaTexto(r)} ${resta}` : resta;
}

/**
 * `[AB.15]` De dónde sale el objetivo con la base 'demanda'. La temporalidad sólo se menciona si
 * mueve algo (≠ 1); sin venta medida se dice, no se dibuja «venta 0».
 */
export function objetivoDemandaTexto(r: Pick<PorqueRow, 'venta_30d' | 'season_ratio' | 'warehouse_code'>): string {
  // `[AB.22]` Los días de cobertura son por almacén: 30 (= Compras) en CEDIS y matrices, 21 en las
  // sucursales que no abastecen y 2.5 en las rutas.
  const cov = coberturaAutoabasto(r.warehouse_code);
  const dias = cov.toLocaleString('es-MX', { maximumFractionDigits: 1 });
  if (r.venta_30d == null || !Number.isFinite(Number(r.venta_30d))) {
    return cov === COBERTURA_AUTOABASTO_DEFAULT
      ? 'Objetivo = venta de 30 días, igual que en Compras, pero este producto no tiene venta medida.'
      : `Objetivo = ${dias} días de venta, pero este producto no tiene venta medida.`;
  }
  const s = Number(r.season_ratio ?? 1);
  const temp = Number.isFinite(s) && Math.abs(s - 1) >= 0.005
    ? ` × temporalidad ${s.toLocaleString('es-MX', { maximumFractionDigits: 2 })}`
    : '';
  if (cov === COBERTURA_AUTOABASTO_DEFAULT) {
    return `Objetivo = venta de 30 días (${qty(r.venta_30d)})${temp}, igual que en Compras.`;
  }
  return `Objetivo = ${dias} días de venta: venta de 30 días (${qty(r.venta_30d)}) ÷ 30 × ${dias}${temp}.`;
}

function restaPorQue(r: PorqueRow, politicaTransito?: string | null): string {
  // `[AB.14]` Con la política `ignorar` (transito.ts, RA.TR) el motor NO resta lo que está en
  // camino. Escribir «− en camino 3» daría una resta que no cuadra y haría creer que ya se
  // descontó. Sin política (API anterior a AB.14) se conserva la redacción de antes.
  const ignora = politicaTransito === 'ignorar';
  const base = ignora
    ? `Objetivo ${qty(r.target_qty)} − existencia ${qty(r.on_hand)} = faltan ${qty(r.suggested_qty)} caja(s).` +
      (r.in_transit > 0 ? ` En camino hay ${qty(r.in_transit)} que NO se restan: revísalo antes de pedir.` : '')
    : `Objetivo ${qty(r.target_qty)} − existencia ${qty(r.on_hand)} − en camino ${qty(r.in_transit)} ` +
      `= faltan ${qty(r.suggested_qty)} caja(s).`;
  if (r.transfer_in > 0 && r.buy_qty > 0) {
    return `${base} De eso, ${qty(r.transfer_in)} sale del sobrante de la red y ${qty(r.buy_qty)} hay que comprarlo.`;
  }
  if (r.transfer_in > 0) return `${base} Se cubre completo con el sobrante de otras sucursales.`;
  return base;
}

// ── [AB.28] Los porqués de la mesa sobre la cuenta única (renglones de AB.26/AB.27) ──────────────
// Misma regla del archivo: cuando falta el dato se dice por qué falta. La sucursal se NOMBRA, nunca
// se numera (`warehouseName`, el mismo resolvedor de la pipe `sucursal`).

/** A quién se le pide — el texto corto de la columna «Surte». */
export function surteTexto(s: SurteRenglon): string {
  if (s.tipo === 'matriz') return warehouseName(s.clave);
  if (s.tipo === 'proveedor') return s.nombre;
  return 'Sin ruta';
}

/** A quién se le pide — la explicación larga. Sin canal NO es compra (ADR-056). */
export function surtePorQue(s: SurteRenglon): string {
  if (s.tipo === 'matriz') return `Traspaso: este producto le llega de ${warehouseName(s.clave)}, que es su canal configurado.`;
  if (s.tipo === 'proveedor') return `Compra a ${s.nombre}: es el canal configurado para este proveedor en esta sucursal.`;
  return 'No hay canal configurado para este proveedor en esta sucursal: no se sabe a quién pedírselo, y no se supone que sea compra.';
}

/**
 * ¿Por qué esa falta neta? — la resta completa, con lo que se resta y lo que NO.
 *
 * `medidos = false` = la sucursal no tiene cliente de traspaso en Kepler: lo ya pedido no se pudo
 * leer, y la pantalla no puede afirmar «nadie lo ha pedido» sin decirlo.
 */
export function faltaNetaPorQue(
  r: Pick<AutoabastoMesaRenglon, 'objetivo' | 'existencia' | 'falta' | 'ya_pedido' | 'en_camino' | 'falta_neta' | 'planeado_compras' | 'atorado'>,
  medidos = true,
): string {
  const partes = [
    `Objetivo ${r.objetivo == null ? 'sin publicar' : qty(r.objetivo)} − existencia ${qty(r.existencia)} = falta ${qty(r.falta)} caja(s).`,
  ];
  if (r.ya_pedido > 0 || r.en_camino > 0) {
    partes.push(`Ya viene: pedido abierto ${qty(r.ya_pedido)} + en camino ${qty(r.en_camino)} → falta neta ${qty(r.falta_neta)}.`);
  } else {
    partes.push(medidos
      ? 'No hay pedido abierto ni embarque en camino para este producto.'
      : 'Lo ya pedido NO se pudo medir: esta sucursal no tiene cliente de traspaso en Kepler.');
  }
  if (r.planeado_compras > 0) {
    partes.push(`Compras planeó ${qty(r.planeado_compras)} que todavía no está en Kepler: se muestra, no se resta.`);
  }
  if (r.atorado > 0) {
    partes.push(`Hay ${qty(r.atorado)} en pedidos de más de 7 días: reclámalos; no se restan.`);
  }
  return partes.join(' ');
}

/**
 * Qué quiere decir el estado del renglón, en palabras.
 *
 * `[AB.35]` Con cobertura PARCIAL (ya vienen 20 de 32) no se puede decir «nadie lo ha pedido»: se dice
 * cuánto ya viene y que nadie ha pedido EL RESTO. Por eso recibe el renglón, no sólo el estado.
 */
export function estadoPorQue(
  r: Pick<AutoabastoMesaRenglon, 'estado' | 'falta' | 'falta_neta' | 'ya_pedido' | 'en_camino'>,
): string {
  const viene = (r.ya_pedido || 0) + (r.en_camino || 0);
  switch (r.estado) {
    case 'sin_pedir': return viene > 0
      ? `Faltan ${qty(r.falta_neta)} caja(s) por pedir: ya vienen ${qty(viene)} de ${qty(r.falta)}, y nadie ha pedido el resto.`
      : 'Le falta y nadie lo ha pedido: ni un pedido abierto a la matriz, ni un embarque en camino, ni un plan de Compras.';
    case 'lo_pediste': return 'Le falta y ya lo mandaste a Compras: espera a que lo aprueben y se pase a Kepler. No se vuelve a pedir.';
    case 'compras_lo_planeo': return 'Le falta, y Compras ya lo planeó, pero todavía no es un pedido en Kepler.';
    case 'ya_viene': return 'Lo que falta ya está pedido o en camino.';
    case 'en_politica': return 'No le falta: está dentro de su objetivo.';
  }
}
