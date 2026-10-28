import { estadoDeExistencia, mensajeSinExistencia, type StockState, type VendorZoneStockResponse } from '@megadulces/contracts';

/**
 * `[MCP.3.12]` La tira chica de existencias de la zona en cada producto de la toma de pedido.
 *
 * Pedido de David (2026-10-23): el vendedor ve cuánto hay en cada sucursal de su zona «en un tamaño
 * discreto pero visible». Esta parte SÓLO muestra; elegir de qué sucursal se surte es la parte 2.
 *
 * `[MCP.3.16]` Desde el 2026-10-27 cada sucursal declara si su lectura está vieja (`stale`). La
 * regla de lectura del contrato: producto ausente de la matriz + sucursal al día = 0 en esa sucursal;
 * sucursal `stale` = SIN DATO («—»), nunca 0. Un servidor viejo (sin `stale`) se lee como antes.
 */
export interface ChipZona {
  id: string;
  short: string;
  name: string;
  mine: boolean;
  /** Existencia en la unidad que se está pidiendo (enteros); `null` = sin dato de esa sucursal. */
  qty: number | null;
  /** `[MCP.3.16]` La existencia en unidad BASE (para «menos de una caja»); `null` = sin dato. */
  base: number | null;
  /** `[MCP.3.16]` La lectura de esa sucursal está vieja o falló. */
  stale: boolean;
  /** Texto del número: «14», «0», «<1» (hay piezas pero no completa una) o «—» (sin dato). */
  texto: string;
  /** `[MCP.3.16]` No hay nada en esa sucursal (0 real, no «sin dato» ni «menos de una»). */
  cero: boolean;
}

/** `[MCP.3.16]` ¿La respuesta trae el contrato con frescura por sucursal? Un servidor viejo no. */
export function zonaConFrescura(zona: VendorZoneStockResponse | null): boolean {
  return !!zona && zona.warehouses.some((w) => typeof w.stale === 'boolean');
}

/** La zona se midió (hay sucursales y no viene declarada sin medir). */
function zonaMedida(zona: VendorZoneStockResponse | null): zona is VendorZoneStockResponse {
  return !!zona && !zona.unmeasured_reason && zona.warehouses.length > 0;
}

/**
 * La existencia en unidad base de la sucursal `i` para la fila dada. `null` = sin dato.
 * Con el contrato nuevo, una celda vacía o un producto ausente en una sucursal al día es 0.
 */
function baseEn(zona: VendorZoneStockResponse, i: number, fila: (number | null)[] | undefined): number | null {
  const w = zona.warehouses[i];
  if (w.stale === true) return null;
  const nuevo = zonaConFrescura(zona);
  const crudo = fila ? fila[i] : null;
  if (crudo == null) return nuevo ? 0 : null;
  const n = Number(crudo);
  return Number.isFinite(n) ? n : null;
}

/**
 * Las existencias de un producto en cada sucursal de la zona, en la unidad elegida.
 *
 * Devuelve `null` (no se pinta la tira) cuando no aporta nada o no se puede afirmar:
 *  · la zona no se cargó o vino declarada sin medir;
 *  · la zona tiene una sola sucursal (ya lo dice la existencia de siempre);
 *  · el producto no tiene existencia en ninguna sucursal de la zona (no viaja en `stock`) y ninguna
 *    sucursal está vieja — ese caso lo dice `nadieEnZona`. Si alguna está vieja, la tira sí se pinta:
 *    las al día en 0 y la vieja en «—», para no afirmar que nadie tiene.
 */
export function chipsDeZona(
  zona: VendorZoneStockResponse | null,
  productId: string,
  factor: number,
): ChipZona[] | null {
  if (!zona || zona.unmeasured_reason || zona.warehouses.length < 2) return null;
  const fila = zona.stock[productId];
  if (!fila && !(zonaConFrescura(zona) && zona.warehouses.some((w) => w.stale === true))) return null;
  const f = factor > 1 ? factor : 1;
  return zona.warehouses.map((w, i) => {
    const base = baseEn(zona, i, fila);
    const qty = base == null ? null : Math.max(0, Math.floor(base / f));
    const menosDeUna = qty === 0 && base != null && base > 0;
    const texto = qty == null ? '—' : menosDeUna ? '<1' : String(qty);
    return {
      id: w.id,
      short: w.short,
      name: w.name,
      mine: w.mine,
      qty,
      base,
      stale: w.stale === true,
      texto,
      cero: qty === 0 && !menosDeUna,
    };
  });
}

/**
 * `[MCP.3.16]` «Nadie en tu zona tiene»: sólo se puede afirmar si la zona se midió, tiene más de una
 * sucursal, habla el contrato nuevo, NINGUNA sucursal está vieja y ninguna tiene el producto.
 */
export function nadieEnZona(zona: VendorZoneStockResponse | null, productId: string): boolean {
  if (!zona || zona.unmeasured_reason || zona.warehouses.length < 2 || !zonaConFrescura(zona)) return false;
  if (zona.warehouses.some((w) => w.stale === true)) return false;
  const fila = zona.stock[productId];
  return !fila || !fila.some((x) => x != null && Number(x) > 0);
}

/**
 * `[MCP.3.16]` El estado de existencia de un producto en una sucursal de la zona, para decidir si se
 * puede surtir de ahí. `null` = no se puede saber con esta respuesta (sin zona, sin medir, servidor
 * viejo o sucursal fuera de la zona): quien lo use NO bloquea.
 *
 * Un producto ausente de la matriz en una sucursal al día es 0 «agotado» (la matriz no distingue
 * «sin registro» de «registro en cero»; los dos bloquean igual). Una celda `null` = sin registro.
 */
export function estadoEnZona(
  zona: VendorZoneStockResponse | null,
  warehouseId: string,
  productId: string,
): StockState | null {
  if (!zonaMedida(zona) || !zonaConFrescura(zona)) return null;
  const i = zona.warehouses.findIndex((w) => w.id === warehouseId);
  if (i < 0) return null;
  if (zona.warehouses[i].stale === true) return 'sin_dato';
  const fila = zona.stock[productId];
  const crudo = fila ? fila[i] : 0;
  return estadoDeExistencia({ medido: true, conRegistro: crudo != null, qty: crudo == null ? null : Number(crudo) });
}

/** `[MCP.3.16]` Existencia en unidad base de una sucursal de la zona (`null` = sin dato o sin zona). */
export function baseEnZona(zona: VendorZoneStockResponse | null, warehouseId: string, productId: string): number | null {
  if (!zonaMedida(zona) || !zonaConFrescura(zona)) return null;
  const i = zona.warehouses.findIndex((w) => w.id === warehouseId);
  if (i < 0) return null;
  return baseEn(zona, i, zona.stock[productId]);
}

export interface AlternativaZona {
  id: string;
  short: string;
  /** Existencia en unidad base. */
  base: number;
}

/**
 * `[MCP.3.16]` Otras sucursales de la zona que SÍ tienen el producto (al día y con existencia > 0),
 * mayor primero, máximo 3 — el mismo orden y tope que las `alternatives` del 409 del servidor.
 */
export function alternativasEnZona(
  zona: VendorZoneStockResponse | null,
  productId: string,
  excluirId: string | null,
): AlternativaZona[] {
  if (!zonaMedida(zona) || !zonaConFrescura(zona)) return [];
  const fila = zona.stock[productId];
  const out: AlternativaZona[] = [];
  zona.warehouses.forEach((w, i) => {
    if (w.id === excluirId) return;
    const base = baseEn(zona, i, fila);
    if (base != null && base > 0) out.push({ id: w.id, short: w.short, base });
  });
  return out.sort((a, b) => b.base - a.base).slice(0, 3);
}

/** `[MCP.3.16]` Los nombres cortos de las sucursales cuya lectura está vieja o falló. */
export function sucursalesSinDato(zona: VendorZoneStockResponse | null): string[] {
  if (!zona || zona.unmeasured_reason) return [];
  return zona.warehouses.filter((w) => w.stale === true).map((w) => w.short);
}

/**
 * `[MCP.3.16]` Una cantidad en unidad base dicha en la unidad que se está pidiendo: «14 CJA»; si no
 * completa una, en piezas: «5 pzas» (nunca «0 CJA», que se leería como que no hay).
 */
export function cantidadEnUnidad(base: number, factor: number, unidad: string, unidadBase: string): string {
  const f = factor > 1 ? factor : 1;
  const n = Math.floor(base / f);
  if (f > 1 && n >= 1) return `${n}${unidad ? ' ' + unidad : ''}`;
  return rotuloBase(base, unidadBase);
}

/** «5 pzas» / «1 pza»; cualquier otra unidad base (KG, PAQ…) se dice con su rótulo. Admite fracción (KG). */
export function rotuloBase(n: number, unidadBase: string): string {
  const num = Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
  const u = (unidadBase || '').trim();
  if (!u || u.toUpperCase() === 'PZA') return `${num} ${n === 1 ? 'pza' : 'pzas'}`;
  return `${num} ${u}`;
}

/**
 * `[MCP.3.16]` El texto del bloqueo al agregar. Es la MISMA función que usa el servidor para el 409
 * (`mensajeSinExistencia` de `@megadulces/contracts`): antes había dos y no coincidían.
 *  · con alternativas: «No se puede agregar: no hay existencias en PH · LPA tiene 14 CJA»;
 *  · si la zona entera se midió al día y nadie tiene: «No se puede agregar un producto que no hay en tu zona»;
 *  · si no se puede afirmar lo de la zona (no se leyó, o alguna sucursal está vieja), sólo lo que sí
 *    se sabe — y qué sucursales quedaron sin dato. Nunca se afirma «nadie tiene» sin haberlo medido.
 */
export const mensajeBloqueo = mensajeSinExistencia;

/** Para el lector de pantalla: «Existencias en tu zona, en CJA: LPA (tu sucursal) 0, PH 14, …». */
export function ariaZona(chips: readonly ChipZona[], unidad: string): string {
  const partes = chips.map(
    (c) => `${c.name}${c.mine ? ' (tu sucursal)' : ''} ${c.qty == null ? 'sin dato' : c.texto === '<1' ? 'menos de 1' : c.qty}`,
  );
  return `Existencias en tu zona${unidad ? ', en ' + unidad : ''}: ${partes.join(', ')}`;
}

/**
 * La edad de la existencia de las OTRAS sucursales (la más vieja), para declararla (ADR-056):
 * «hace 12 min». `null` si no hay otras sucursales o ninguna trae fecha.
 * `[MCP.3.16]` Las sucursales viejas (`stale`) no cuentan: ésas se declaran aparte como «sin dato».
 */
export function edadZona(zona: VendorZoneStockResponse | null, ahora: number): string | null {
  if (!zona || zona.warehouses.length < 2) return null;
  const fechas = zona.warehouses
    .filter((w) => !w.mine && w.stale !== true && w.as_of)
    .map((w) => new Date(w.as_of as string).getTime())
    .filter((t) => Number.isFinite(t));
  if (!fechas.length) return null;
  const min = Math.max(0, Math.round((ahora - Math.min(...fechas)) / 60_000));
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  return `hace ${d} día${d === 1 ? '' : 's'}`;
}
