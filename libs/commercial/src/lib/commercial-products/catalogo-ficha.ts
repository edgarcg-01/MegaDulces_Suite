/**
 * Compras › Catálogo: la lista y la ficha de un producto. Lógica PURA (sin base) para que la prueba
 * corra este texto y no una copia. Las consultas viven en `catalogo-ficha.sql.ts`.
 *
 * Fuentes (todas del ODS o derivadas de él, cero importers):
 *  - Unidades: `analytics.v_kepler_unit_ladder` (u1 = base `kdii.c11`; f2_cap/f3_cap cuentan desde la BASE).
 *  - Precios: `commercial.product_label_prices` por (product_id, sucursal). El precio de una unidad que
 *    no cuadra con `pack_size`/`box_size` se DECLARA `null` («sin precio»), nunca 0.
 */

/** Una unidad en que se maneja el producto, con su precio en la sucursal pedida. */
export interface UnidadPrecio {
  unidad: string;
  /** `null` = es la unidad base. Si no, cuántas de la unidad anterior (o de la base) trae. */
  equivale: { cantidad: number; unidad: string } | null;
  /** Cuántas unidades base trae. */
  factorBase: number;
  /** `null` = sin precio cargado para esta unidad (NUNCA 0). */
  precio: number | null;
  mayoreo: { precio: number; desde: number } | null;
}

export interface CatalogoFila {
  id: string;
  sku: string | null;
  nombre: string;
  proveedor: { id: string; nombre: string } | null;
  unidades: UnidadPrecio[];
  razon: string | null;
  /** Códigos de barras activos distintos (el principal + los de catalog.product_barcodes). 0 = sin código. */
  nCodigos: number;
}

/**
 * Qué subconjunto de la búsqueda se lista («Mostrar»). Se filtra en el SERVIDOR porque la lista es
 * paginada: filtrar la página en el navegador escondería lo que está en la página 2.
 */
export type MostrarCatalogo = 'todos' | 'varios_codigos' | 'sin_codigo' | 'sin_precio';
export const MOSTRAR_CATALOGO: readonly MostrarCatalogo[] = ['todos', 'varios_codigos', 'sin_codigo', 'sin_precio'];

/** Cuántos productos de la BÚSQUEDA caen en cada opción de «Mostrar» (no dependen de la opción elegida). */
export interface ConteosCatalogo {
  todos: number;
  variosCodigos: number;
  sinCodigo: number;
  /**
   * Productos con alguna unidad sin precio en la sucursal. null = NO SE PUEDE MEDIR: la base no tiene
   * precio por sucursal (sin [NORM.3]) y todos los precios viajan null — contar eso como «sin precio»
   * sería contar el hueco del dato, no el del catálogo.
   */
  sinPrecio: number | null;
}

export interface CatalogoLista {
  sucursal: string;
  /** Total de la opción de «Mostrar» aplicada (el que pagina). */
  total: number;
  filas: CatalogoFila[];
  calculado_al: string;
  conteos: ConteosCatalogo;
  /** La opción que el servidor APLICÓ (sin_precio no medible se aplica como todos). */
  mostrar: MostrarCatalogo;
}

export interface FichaSucursal {
  codigo: string;
  nombre: string | null;
  /** `null` = la venta de esa sucursal no se puede medir en el mes (sin corte a Kepler, o corte dentro del mes). */
  vendidoMes: { monto: number; unidadesBase: number } | null;
  /** `null` = sin dato de existencia en Kepler para esa sucursal. */
  existenciaBase: number | null;
}

export interface FichaProducto {
  id: string;
  sku: string | null;
  nombre: string;
  /** Sólo si es distinta del nombre. */
  descripcion: string | null;
  activo: boolean;
  proveedor: { id: string; nombre: string } | null;
  /** Principal primero. */
  codigos: string[];
  unidadBase: string | null;
  unidades: UnidadPrecio[];
  precioRed: { sucursales: number; min: number | null; max: number | null };
  sucursales: FichaSucursal[];
  corteVenta: string | null;
  ultimaEntrada: {
    sucursal: string;
    nombreSucursal: string | null;
    fecha: string;
    cantidad: number;
    unidad: string;
    /** `null` si el usuario no tiene permiso de costo. */
    costo: number | null;
  } | null;
  costo_visible: boolean;
  calculado_al: string;
}

// ─── Entradas crudas (como llegan de la base) ───────────────────────────────────────────────

type Num = string | number | null | undefined;

export interface EscaleraCruda {
  u1_label: string | null;
  u2_label: string | null;
  u3_label: string | null;
  f2_cap: Num;
  f3_cap: Num;
}

export interface PrecioCrudo {
  unit_base: string | null;
  piece_price: Num;
  wholesale_piece_price: Num;
  wholesale_piece_min_qty: Num;
  pack_size: Num;
  pack_price: Num;
  wholesale_pack_price: Num;
  wholesale_pack_min_qty: Num;
  box_size: Num;
  box_price: Num;
}

/** Número finito o `null`. Un texto vacío o basura NO es 0. */
export function num(v: Num): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Precio válido: > 0. Un 0 en la tabla es «sin precio», no un regalo. */
function precioValido(v: Num): number | null {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
}

const mismoFactor = (a: number | null, b: number): boolean => a !== null && Math.abs(a - b) < 1e-6;
const etiqueta = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim().toUpperCase();
  return t ? t : null;
};

/** Mayoreo válido: precio > 0 y desde > 1 (un «mayoreo desde 1» es el precio normal). */
function mayoreoDe(precio: Num, desde: Num): { precio: number; desde: number } | null {
  const p = precioValido(precio);
  const d = num(desde);
  return p !== null && d !== null && d > 1 ? { precio: p, desde: d } : null;
}

/**
 * Arma las unidades de un producto en una sucursal.
 *
 * Peldaños: la base (u1, factor 1) y luego u2/u3 sólo si su factor es > 1 y MAYOR que el último que
 * quedó (quita los repetidos tipo PAQ/PAQ(1)/CJA(20) y los de factor ≤ 1). `equivale` se expresa contra
 * el peldaño anterior cuando divide exacto (CJA = 18 PAQ), si no contra la base.
 *
 * Precio: la base lleva `piece_price`; un peldaño con factor F lleva `pack_price` si `pack_size == F`,
 * `box_price` si `box_size == F`, y si no `null` («sin precio»).
 *
 * Mayoreo, con el mismo reparto que `analytics.v_label_prices` (migración `[ETQ-ODS.1]`):
 *  - `wholesale_piece_*` es el mayoreo de la BASE.
 *  - `wholesale_pack_*`: con base agrupada (PAQ/CJA) es el mayoreo de la BASE; con otra base (PZA) es el
 *    del PAQUETE y va al peldaño cuyo factor es `pack_size`. Si ese peldaño no existe, el mayoreo NO se
 *    coloca: ponerlo en la base le daría a la pieza el precio de un paquete.
 *
 * Sin escalera: si la etiqueta trae `unit_base`, una sola unidad base con su precio; si no, `[]`.
 */
export function armarUnidades(escalera: EscaleraCruda | null, precio: PrecioCrudo | null): UnidadPrecio[] {
  const base = etiqueta(escalera?.u1_label) ?? etiqueta(precio?.unit_base);
  if (!base) return [];

  const peldanos: { unidad: string; factor: number }[] = [{ unidad: base, factor: 1 }];
  if (escalera && etiqueta(escalera.u1_label)) {
    for (const [lab, f] of [
      [escalera.u2_label, escalera.f2_cap],
      [escalera.u3_label, escalera.f3_cap],
    ] as const) {
      const u = etiqueta(lab);
      const factor = num(f);
      const ultimo = peldanos[peldanos.length - 1];
      if (!u || factor === null || factor <= 1 || factor <= ultimo.factor) continue;
      peldanos.push({ unidad: u, factor });
    }
  }

  const unidades: UnidadPrecio[] = peldanos.map((p, i) => {
    if (i === 0) {
      return { unidad: p.unidad, equivale: null, factorBase: 1, precio: precioValido(precio?.piece_price), mayoreo: null };
    }
    const prev = peldanos[i - 1];
    const cociente = p.factor / prev.factor;
    const exacto = Math.abs(cociente - Math.round(cociente)) < 1e-6;
    const equivale = exacto && i > 1
      ? { cantidad: Math.round(cociente), unidad: prev.unidad }
      : { cantidad: p.factor, unidad: base };
    let pr: number | null = null;
    if (precio) {
      if (mismoFactor(num(precio.pack_size), p.factor)) pr = precioValido(precio.pack_price);
      else if (mismoFactor(num(precio.box_size), p.factor)) pr = precioValido(precio.box_price);
    }
    return { unidad: p.unidad, equivale, factorBase: p.factor, precio: pr, mayoreo: null };
  });

  if (precio) {
    unidades[0].mayoreo = mayoreoDe(precio.wholesale_piece_price, precio.wholesale_piece_min_qty);
    const mayPack = mayoreoDe(precio.wholesale_pack_price, precio.wholesale_pack_min_qty);
    if (mayPack) {
      const agrupada = base === 'PAQ' || base === 'CJA';
      const packSize = num(precio.pack_size);
      const destino = agrupada
        ? unidades[0]
        : packSize !== null
          ? unidades.find((u, i) => i > 0 && mismoFactor(packSize, u.factorBase))
          : undefined;
      if (destino && !destino.mayoreo) destino.mayoreo = mayPack;
    }
  }
  return unidades;
}

/** Normaliza para comparar nombre y descripción: espacios colapsados, mayúsculas. */
const normal = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();

/** La descripción sólo viaja si dice algo distinto del nombre. */
export function descripcionDistinta(nombre: string, descripcion: string | null | undefined): string | null {
  const d = (descripcion ?? '').trim();
  if (!d) return null;
  return normal(d) === normal(nombre) ? null : d;
}

/** Códigos de barras: el principal (`catalog.products.barcode`) primero, luego los demás, sin repetidos ni vacíos. */
export function ordenarCodigos(principal: string | null | undefined, otros: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const c of [principal, ...otros]) {
    const t = (c ?? '').trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export interface SucursalCruda {
  codigo: string;
  nombre: string | null;
  /**
   * La venta del mes se puede medir completa: el corte a Kepler cae en o antes del día 1. Lo calcula SQL
   * porque el corte de las plazas que siempre estuvieron en Kepler (03/04/05) es `-infinity`, que no
   * sobrevive a un `to_char` (sale NULL y las marcaría «sin dato» por error).
   */
  venta_medible: boolean;
}

/**
 * Una fila por sucursal. La venta del mes se DECLARA `null` cuando no se puede medir completa: la
 * sucursal no tiene corte a Kepler o el corte cae dentro del mes (la parte previa está en Wincaja y
 * esta matvista no la cuenta). Medible y sin filas = 0 de verdad.
 */
export function armarSucursales(
  sucursales: SucursalCruda[],
  venta: Map<string, { monto: Num; unidades: Num }>,
  existencia: Map<string, Num>,
): FichaSucursal[] {
  return sucursales.map((s) => {
    const v = venta.get(s.codigo);
    return {
      codigo: s.codigo,
      nombre: s.nombre,
      vendidoMes: s.venta_medible === true
        ? { monto: Math.round((num(v?.monto) ?? 0) * 100) / 100, unidadesBase: num(v?.unidades) ?? 0 }
        : null,
      existenciaBase: existencia.has(s.codigo) ? num(existencia.get(s.codigo)) : null,
    };
  });
}

/** count/min/max del precio base entre sucursales; sólo precios > 0. */
export function precioDeRed(precios: Num[]): { sucursales: number; min: number | null; max: number | null } {
  const v = precios.map(precioValido).filter((x): x is number => x !== null);
  return { sucursales: v.length, min: v.length ? Math.min(...v) : null, max: v.length ? Math.max(...v) : null };
}

/** Sucursal pedida: dos dígitos; por default la 01. */
export function sucursalValida(s: string | null | undefined): string {
  const t = (s ?? '').trim();
  return /^[0-9]{2}$/.test(t) ? t : '01';
}

/**
 * La opción de «Mostrar» que se aplica. Desconocida → todos. sin_precio sin precio por sucursal → todos
 * (no se puede medir; el front lo declara en vez de listar todo como «sin precio»).
 */
export function mostrarValido(s: string | null | undefined, conPrecio: boolean): MostrarCatalogo {
  const t = (s ?? '').trim() as MostrarCatalogo;
  if (!MOSTRAR_CATALOGO.includes(t)) return 'todos';
  return t === 'sin_precio' && !conPrecio ? 'todos' : t;
}

/** Los conteos crudos de la base (count de postgres llega como string) → números; sinPrecio null si no se midió. */
export function armarConteos(
  r: { todos: Num; varios: Num; sin_codigo: Num; sin_precio: Num } | null | undefined,
  conPrecio: boolean,
): ConteosCatalogo {
  return {
    todos: num(r?.todos) ?? 0,
    variosCodigos: num(r?.varios) ?? 0,
    sinCodigo: num(r?.sin_codigo) ?? 0,
    sinPrecio: conPrecio ? num(r?.sin_precio) ?? 0 : null,
  };
}

/**
 * La regla de «alguna unidad sin precio», sobre lo que pinta la tabla. El SQL
 * (SIN_PRECIO_LATERAL_SQL) la repite para poder filtrar y contar en el servidor; este es el testigo
 * contra el que se cruza (ver la prueba y el cruce contra la base en el log).
 */
export function algunaSinPrecio(unidades: UnidadPrecio[]): boolean {
  return unidades.some((u) => u.precio === null);
}
