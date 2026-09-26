/**
 * `[RA-PRO.51]` Redondeo del SUGERIDO del motor para `/compras/pedido`, aislado del componente
 * para poder probarlo sin montar Angular (ADR-056: un primitivo que decide un número se prueba).
 *
 * Regla pedida por el comprador (2026-09-25): que el sugerido llegue listo para pedir.
 *  - Media caja o más → **cajas CERRADAS**, al entero más cercano (147.1 → 147, 1.5 → 2, 0.6 → 1).
 *  - Menos de media caja → se propone en **PIEZAS enteras** (0.4 cj × 20 → 8 pz), mínimo 1 pieza:
 *    si el motor pidió algo, no se borra redondeando a cero.
 *
 * El canónico SIGUE siendo cajas: en el ramo de piezas se devuelve `pz / uxc` (fracción de caja),
 * así que días, valor, totales, requisición y Excel leen el mismo número que ve el input. `unit`
 * sólo dice en qué unidad se PROPONE capturar.
 */
export interface SeedRedondeado {
  /** Valor inicial del input, SIEMPRE en cajas (el canónico). */
  cajas: number;
  /** Unidad en que se propone capturar: caja cerrada, o pieza si no llega a media caja. */
  unit: 'caja' | 'pieza';
}

/**
 * @param ped sugerido del motor, en cajas.
 * @param uxc unidades (piezas) por caja de este producto en esta plaza.
 */
export function roundSeed(ped: number, uxc: number): SeedRedondeado {
  // No hay nada que pedir (o el motor mandó un valor inválido).
  if (!(ped > 0)) return { cajas: 0, unit: 'caja' };

  // ⚠️ `uxc` inválido (0, negativo, NaN): sin factor de caja no se puede proponer en piezas sin
  // dividir por cero (`pz / uxc` → Infinity). Se cae a cajas cerradas, que no depende de `uxc`.
  const factor = uxc > 0 ? uxc : 1;

  // Media caja o más → cajas cerradas (Math.round nunca da 0 acá: round(0.5) = 1).
  if (ped >= 0.5) return { cajas: Math.round(ped), unit: 'caja' };

  // Menos de media caja → piezas enteras, mínimo 1.
  const pz = Math.max(1, Math.round(ped * factor));
  return { cajas: pz / factor, unit: 'pieza' };
}

/**
 * `[RA-PRO.52]` Parte una cantidad en cajas (el canónico, puede traer fracción) en **cajas
 * cerradas + piezas sueltas**, para que el acuse "Se entrega en" diga lo que se le pide al
 * proveedor (6.5 cj con 12 pz/caja → 6 cj 6 pz) y no una fracción que nadie puede surtir.
 *
 * Se redondea UNA vez, sobre el total en piezas, y de ahí se divide: sumar la fracción de cada
 * sucursal por separado (4 pz + 2 pz) podría dar "5 cj 12 pz" en vez de "6 cj".
 *
 * `uxc` inválido (0, negativo, NaN) → `null`: sin factor de caja no hay piezas que contar, y el
 * que llama muestra las cajas como vienen en vez de inventar una conversión.
 */
export function cajasYPiezas(cajas: number, uxc: number): { cj: number; pz: number } | null {
  if (!(uxc > 0)) return null;
  const totalPz = Math.max(0, Math.round((Number(cajas) || 0) * uxc));
  return { cj: Math.floor(totalPz / uxc), pz: totalPz % uxc };
}

/**
 * `[RA-PRO.52]` La misma cantidad, ya como texto: "6 cj 6 pz", "147 cj", "8 pz". Es lo que
 * imprimen el acuse de la pantalla y el PDF de requisición, para que nunca digan cosas distintas.
 * Sin factor de caja válido se muestra en cajas con un decimal, como antes.
 */
export function textoCajasPiezas(cajas: number, uxc: number): string {
  const p = cajasYPiezas(cajas, uxc);
  if (!p) return `${(Math.round((Number(cajas) || 0) * 10) / 10).toLocaleString('es-MX')} cj`;
  if (p.cj && p.pz) return `${p.cj.toLocaleString('es-MX')} cj ${p.pz} pz`;
  if (p.pz) return `${p.pz} pz`;
  return `${p.cj.toLocaleString('es-MX')} cj`;
}

/**
 * `[RA-PRO.55]` Suma de varios productos en "cajas cerradas + piezas sueltas". Cada producto trae
 * su propio factor de caja (20, 25, 1…), así que las piezas sueltas de productos distintos NO se
 * pueden convertir a cajas: se suman las cajas cerradas por un lado y las piezas por otro.
 * (6 cj 10 pz de uno + 5 cj de otro = "11 cj 10 pz".) Es el total del pedido por almacén.
 *
 * Un producto sin factor de caja válido no se puede partir: sus cajas (con decimal) se suman a
 * las cajas, que es como la pantalla ya lo muestra.
 */
export function textoSumaCajasPiezas(items: { cajas: number; uxc: number }[]): string {
  let cj = 0, pz = 0;
  for (const it of items) {
    const p = cajasYPiezas(it.cajas, it.uxc);
    if (p) { cj += p.cj; pz += p.pz; } else cj += Math.max(0, Number(it.cajas) || 0);
  }
  cj = Math.round(cj * 10) / 10;
  if (cj && pz) return `${cj.toLocaleString('es-MX')} cj ${pz.toLocaleString('es-MX')} pz`;
  if (pz) return `${pz.toLocaleString('es-MX')} pz`;
  return `${cj.toLocaleString('es-MX')} cj`;
}

/**
 * `[RA-PRO.53]` Días de inventario: (existencia + pedido) ÷ (venta 30 d ÷ 30.4). 30.4 es el
 * convenio de días del mes que ya usa el comprador en su Excel. Con `pedido = 0` son los días que
 * aguanta la sucursal HOY; con el pedido, los que aguantará al recibirlo.
 *
 * Devuelve `null` —que la pantalla y el PDF pintan "—" / "s/venta"— cuando no se puede calcular:
 *  - sin venta: no hay ritmo contra qué dividir (un 0 se leería "urge"; un número enorme, "sobra");
 *  - `noConfiable`: el peldaño de unidad de esa sucursal está contradicho (U.2), así que su
 *    existencia en cajas no es verdad y los días tampoco lo serían.
 */
export function diasInventario(exis: number, venta30: number, pedido = 0, noConfiable = false): number | null {
  const v = Number(venta30);
  if (noConfiable || !(v > 0)) return null;
  return ((Number(exis) || 0) + (Number(pedido) || 0)) * 30.4 / v;
}
