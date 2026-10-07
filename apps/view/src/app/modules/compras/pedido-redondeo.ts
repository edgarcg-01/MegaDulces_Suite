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
 * `[RA-PRO.68]` Rótulos de unidad de un producto, de MAYOR a MENOR, con la misma regla que la
 * cotización (COT.16/17, `televenta/quote-units.ts`): la unidad mayor, el paquete del medio si
 * existe, y la unidad base — con los nombres que declara Kepler, no "cj"/"pz" fijos.
 *
 * Antes el pedido escribía "4 cj 3 pz" a un producto que se cuenta en PAQUETES (83185: caja de
 * 10 PAQ), y "pz" a un bulto que se cuenta en kilos.
 */
export interface EtiquetaUnidades {
  /** Abreviatura de la unidad mayor: cj, bto, cub… */
  mayor: string;
  /** Unidades base que trae el paquete del medio. `null` = no hay unidad intermedia confiable. */
  medio: number | null;
  /** Abreviatura del paquete del medio (paq). */
  medioAbr: string;
  /** Abreviatura de la unidad base: pz, paq, kg, u. */
  base: string;
}

const ABR: Record<string, string> = {
  PZA: 'pz', PAQ: 'paq', KG: 'kg', CJA: 'cj', CAJA: 'cj', BTO: 'bto', BULTO: 'bto', CUB: 'cub', CUBETA: 'cub',
};
const NOMBRE: Record<string, string> = {
  pz: 'Pieza', paq: 'Paquete', kg: 'Kilo', cj: 'Caja', bto: 'Bulto', cub: 'Cubeta', 'u.': 'Unidad',
};

/** Etiquetas por defecto (lo que la pantalla decía antes): cajas y piezas, sin intermedio. */
export const UNIDADES_CJ_PZ: EtiquetaUnidades = { mayor: 'cj', medio: null, medioAbr: 'paq', base: 'pz' };

/** `[RA-PRO.70]` Una unidad real del artículo: su abreviatura, su nombre y cuántas unidades BASE trae. */
export interface UnidadEscalera { abr: string; nombre: string; factor: number }

/** Abreviatura de un rótulo de Kepler. Un GRAMAJE (`500`, `250`) es "u." (UNIDADES_DE_MEDIDA §7.6). */
function abrDe(raw: string): string {
  if (!raw) return '';
  if (/^[\d.]+$/.test(raw)) return 'u.';
  return ABR[raw] ?? raw.toLowerCase();
}

/**
 * `[RA-PRO.70]` La escalera REAL de unidades del artículo, de menor a mayor: 1, 2 o 3 unidades.
 *
 * Kepler RELLENA los tres peldaños aunque el artículo no los tenga: repite el rótulo con factor 1
 * (`70001` mazapán = PAQ ×1 · PAQ ×1 · CJA ×20; `17063` rollo = KG · KG · KG). Leer sólo los
 * rótulos daba botones "kg | kg" o una "cj" que no existe (`57009` cubeta). La regla: hay una
 * unidad por cada peldaño donde el FACTOR crece (≥ 1.5× el anterior), con el factor que se deriva
 * del costo por peldaño (`f2`, `f3`, contra la base).
 *
 * Medido en prod el 2026-10-03 sobre 6,291 artículos del plan: 604 con 1 unidad, 5,313 con 2 y
 * 374 con 3. La unidad MAYOR siempre trae el factor del motor (`uxc`), que es el que convierte el
 * pedido: en 22 artículos el peldaño de Kepler no coincide y manda `uxc`.
 *
 * Sin factores (feed viejo) cae a los rótulos + la etiquetera, como antes.
 */
export function escaleraUnidades(o: {
  u1?: string | null; u2?: string | null; u3?: string | null;
  f2?: number | string | null; f3?: number | string | null;
  uxc?: number | null; boxSize?: number | null; packSize?: number | null;
}): UnidadEscalera[] {
  const up = (s: string | null | undefined) => (s || '').trim().toUpperCase();
  const u1 = up(o.u1), u2 = up(o.u2), u3 = up(o.u3);
  const uxc = Number(o.uxc) > 0 ? Number(o.uxc) : 1;
  const mk = (raw: string, factor: number): UnidadEscalera => {
    const abr = abrDe(raw) || (factor === 1 ? 'pz' : 'cj');
    return { abr, nombre: NOMBRE[abr] ?? raw, factor };
  };
  const base = mk(u1, 1);
  if (uxc <= 1) return [base];   // una sola unidad: el pedido se cuenta en la base

  const f2 = Number(o.f2), f3 = Number(o.f3);
  const tieneFactores = Number.isFinite(f2) && f2 > 0 || Number.isFinite(f3) && f3 > 0;
  const cerca = (a: number, b: number) => Math.abs(a - b) <= 0.02 * Math.max(a, b);
  const real2 = !!u2 && Number.isFinite(f2) && f2 >= 1.5;
  const real3 = !!u3 && Number.isFinite(f3) && f3 >= 1.5 && (!real2 || f3 / f2 >= 1.5);

  // La mayor: el peldaño cuyo factor coincide con el del motor; si ninguno, el rótulo más alto.
  let mayorRaw = '';
  if (real3 && cerca(f3, uxc)) mayorRaw = u3;
  else if (real2 && cerca(f2, uxc)) mayorRaw = u2;
  else mayorRaw = [u3, u2].find((u) => u && u !== u1) || 'CJA';
  let mayor = mk(mayorRaw, uxc);
  // Kepler a veces rotula base y mayor igual con factor distinto (89106: PAQ ×1 y PAQ ×24, medido
  // 2026-10-03 en 3 artículos). Dos botones "paq | paq" no se distinguen: la mayor lleva su tamaño.
  if (mayor.abr === base.abr) mayor = { abr: mayor.abr + '×' + uxc, nombre: mayor.nombre + ' de ' + uxc, factor: uxc };

  // El del medio: el peldaño 2 cuando es real, no es la mayor, cabe exacto en la caja y su rótulo
  // no repite el de la base (20323 trae PAQ/PAQ: "1 paq 3 paq" no se lee como nada).
  let medio: UnidadEscalera | null = null;
  if (tieneFactores) {
    const m = Math.round(f2);
    if (real2 && mayorRaw !== u2 && m > 1 && m < uxc && cerca(uxc / m, Math.round(uxc / m)) && u2 !== u1) medio = mk(u2, m);
  } else {
    // Feed viejo: la etiquetera (pack que cabe exacto en la caja y caja = factor del motor).
    const pack = Number(o.packSize), box = Number(o.boxSize);
    if (u3 && u2 && u2 !== u1 && pack > 1 && pack < uxc && uxc % pack === 0 && box === uxc) medio = mk(u2, pack);
  }
  return medio ? [base, medio, mayor] : [base, mayor];
}

/** Las etiquetas de mayor a menor, derivadas de la escalera (ver `escaleraUnidades`). */
export function etiquetaUnidades(o: Parameters<typeof escaleraUnidades>[0]): EtiquetaUnidades {
  const e = escaleraUnidades(o);
  const base = e[0], mayor = e[e.length - 1], medio = e.length === 3 ? e[1] : null;
  return { mayor: mayor.abr, medio: medio ? medio.factor : null, medioAbr: medio ? medio.abr : 'paq', base: base.abr };
}

/**
 * Una cantidad en cajas (el canónico) escrita de mayor a menor: "4 cj 3 paq", "1 cj 2 paq 5 pz",
 * "8 pz". Se redondea UNA vez, sobre el total en unidades base, como `cajasYPiezas`.
 */
export function textoUnidades(cajas: number, uxc: number, et: EtiquetaUnidades = UNIDADES_CJ_PZ): string {
  // Una sola unidad (uxc = 1): no hay unidad menor que absorba la fracción, va con decimal (4.3 cub).
  if (Number(uxc) === 1) return (Math.round((Number(cajas) || 0) * 10) / 10).toLocaleString('es-MX') + ' ' + et.mayor;
  const p = cajasYPiezas(cajas, uxc);
  if (!p) return `${(Math.round((Number(cajas) || 0) * 10) / 10).toLocaleString('es-MX')} ${et.mayor}`;
  const partes: string[] = [];
  if (p.cj) partes.push(`${p.cj.toLocaleString('es-MX')} ${et.mayor}`);
  let resto = p.pz;
  if (et.medio && resto >= et.medio) { partes.push(`${Math.floor(resto / et.medio)} ${et.medioAbr}`); resto %= et.medio; }
  if (resto) partes.push(`${resto} ${et.base}`);
  return partes.length ? partes.join(' ') : `0 ${et.mayor}`;
}

/**
 * Suma de varios productos de mayor a menor. Las unidades MAYORES se suman entre sí (son la unidad
 * en que se le pide al proveedor); las sueltas sólo se suman con las de su MISMA unidad: "3 paq"
 * de un producto y "5 pz" de otro no son "8" de nada. (Antes las sumaba todas como piezas.)
 */
export function textoSumaUnidades(items: { cajas: number; uxc: number; et?: EtiquetaUnidades }[]): string {
  const mayores = new Map<string, number>();
  const sueltas = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  for (const it of items) {
    const et = it.et ?? UNIDADES_CJ_PZ;
    const p = cajasYPiezas(it.cajas, it.uxc);
    if (!p) { add(mayores, et.mayor, Math.max(0, Number(it.cajas) || 0)); continue; }
    if (p.cj) add(mayores, et.mayor, p.cj);
    let resto = p.pz;
    if (et.medio && resto >= et.medio) { add(sueltas, et.medioAbr, Math.floor(resto / et.medio)); resto %= et.medio; }
    if (resto) add(sueltas, et.base, resto);
  }
  const fmt = (m: Map<string, number>) => [...m].filter(([, v]) => v > 0)
    .map(([k, v]) => `${(Math.round(v * 10) / 10).toLocaleString('es-MX')} ${k}`);
  const partes = [...fmt(mayores), ...fmt(sueltas)];
  return partes.length ? partes.join(' ') : '0 cj';
}

/**
 * `[RA-PRO.69]` ¿Este pedido se parece al pedido TÍPICO del proveedor?
 *
 * ⚠️ Lo que guarda `catalog.suppliers.min_order_amount` / `min_order_boxes` NO es un mínimo que
 * el proveedor imponga: `import-supplier-params.js` (RA-PRO.10) lo DERIVA del historial como el
 * pedido típico de su almacén principal, y no hay columna que distinga un valor capturado a mano de
 * uno derivado. Por eso esto INFORMA (cuánto llevas contra lo que normalmente se le compra) y NO
 * rellena el pedido: subir una compra hasta un promedio histórico es comprar de más.
 *
 * Precedencia igual que `/compras/proveedores`: el MONTO manda; las cajas, si no hay monto.
 */
export interface PedidoTipicoEval {
  criterio: 'monto' | 'cajas' | null;
  llevas: number;
  tipico: number | null;
  /** llevas ÷ típico, 0..∞. `null` = el proveedor no tiene pedido típico. */
  pct: number | null;
  nivel: 'sin_dato' | 'bajo' | 'cerca' | 'alcanza';
}
export function evaluarPedidoTipico(cajas: number, monto: number, tipicoCajas: number | null | undefined, tipicoMonto: number | null | undefined): PedidoTipicoEval {
  const tm = Number(tipicoMonto), tc = Number(tipicoCajas);
  const criterio = tm > 0 ? 'monto' : tc > 0 ? 'cajas' : null;
  if (!criterio) return { criterio: null, llevas: 0, tipico: null, pct: null, nivel: 'sin_dato' };
  const llevas = criterio === 'monto' ? Math.max(0, Number(monto) || 0) : Math.max(0, Number(cajas) || 0);
  const tipico = criterio === 'monto' ? tm : tc;
  const pct = llevas / tipico;
  return { criterio, llevas, tipico, pct, nivel: pct >= 0.9 ? 'alcanza' : pct >= 0.5 ? 'cerca' : 'bajo' };
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

/**
 * `[RA-PRO.57]` Un paso de + / − sobre la cantidad del pedido (teclas ← → en escritorio, botones
 * − + en celular y tableta), en la unidad en que se está capturando.
 *
 * Si el valor trae decimales, el paso **cae al siguiente entero** en vez de arrastrar la fracción:
 * `147.4 +` → 148, `147.4 −` → 147. Así un par de toques deja la cantidad en número cerrado, que
 * es lo que se le pide al proveedor. Nunca baja de `min` (0).
 * El margen de 1e-9 absorbe el ruido de flotante de convertir cajas↔piezas (3.0000000004 es 3).
 */
export function pasoCantidad(valor: number, delta: 1 | -1, min = 0): number {
  const v = Number(valor) || 0;
  const EPS = 1e-9;
  const next = delta > 0 ? Math.floor(v + EPS) + 1 : Math.ceil(v - EPS) - 1;
  return Math.max(min, next);
}

/**
 * `[RA-PRO.59]` Dinero en corto para la barra de celular, donde `$4,284,837` no cabe junto a los
 * botones: `$519 mil`, `$4.3 M`, `$850`. Es un resumen para ubicarse: la cifra exacta sigue en la
 * vista completa (y en escritorio no se usa).
 */
export function dineroCorto(v: number): string {
  const n = Number(v) || 0;
  const s = n < 0 ? '−' : '';
  const a = Math.abs(n);
  if (a < 1_000) return `${s}$${Math.round(a).toLocaleString('es-MX')}`;
  // Se decide con el valor YA redondeado: 999,600 redondea a 1,000 mil, y eso se escribe "1 M".
  const miles = Math.round(a / 1_000);
  if (miles >= 1_000) return `${s}$${(Math.round(a / 100_000) / 10).toLocaleString('es-MX')} M`;
  return `${s}$${miles.toLocaleString('es-MX')} mil`;
}

/** Lo que importa de una tecla para decidir el paso (subconjunto de `KeyboardEvent`, para probarlo sin DOM). */
export interface TeclaPaso { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; }

/**
 * `[RA-PRO.57]` Qué paso hace una tecla en la columna de captura del pedido: +1, −1 o nada (0).
 *  - `→` / `←` SIN modificadores: +1 / −1. Con Shift/Ctrl/Alt/Meta se deja lo nativo
 *    (Shift+← selecciona texto, Ctrl+← salta palabra…).
 *  - `Alt + ↑` / `Alt + ↓`: +1 / −1 (el atajo de antes, se conserva).
 *  - `↑ ↓` solas y `Enter` NO son paso: mueven de renglón (regla D.5), las resuelve el componente.
 */
export function pasoPorTecla(t: TeclaPaso): 1 | -1 | 0 {
  const mod = t.altKey || t.ctrlKey || t.metaKey || t.shiftKey;
  if (!mod && t.key === 'ArrowRight') return 1;
  if (!mod && t.key === 'ArrowLeft') return -1;
  if (t.altKey && !t.ctrlKey && !t.metaKey && !t.shiftKey) {
    if (t.key === 'ArrowUp') return 1;
    if (t.key === 'ArrowDown') return -1;
  }
  return 0;
}
