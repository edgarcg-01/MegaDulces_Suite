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
  /**
   * `[PF.12.3]` El último costo de compra. Sólo en la lista Sencillo y sólo si `costo_visible`.
   * `null` = el producto no tiene entradas XA20 («Sin compras», nunca $0). Ausente = no se pidió (Detallado) o
   * no se pudo leer (`costo_medido: false`).
   */
  ultimoCosto?: UltimoCosto | null;
}

/**
 * `[PF.12.3]` Cómo se sabe que el costo de una entrada va SIN IVA ni IEPS:
 *  - `neto`: el renglón lo capturó sin impuestos (tasa positiva o cero: el documento los suma aparte);
 *  - `descontado`: el renglón lo traía CON impuestos (tasa negativa) y se le quitaron;
 *  - `sin_dato`: el renglón no trae tasa, no se sabe si los incluye. Va tal cual y se DICE.
 */
export type ImpuestoEntrada = 'neto' | 'descontado' | 'sin_dato';

/** `[PF.12.3]` El último costo en una unidad del renglón. */
export interface CostoEnUnidad {
  unidad: string;
  /** Sin IVA ni IEPS, en ESTA unidad. */
  costo: number;
  /** El precio de lista de esta unidad SIN impuestos: contra lo que se compara. `null` = sin precio o sin tasa. */
  precioSinImpuestos: number | null;
  /**
   * `precioSinImpuestos` queda por debajo del costo (a centavos). `null` = no se puede comparar: la unidad no
   * tiene precio o no se sabe el impuesto.
   */
  bajoCosto: boolean | null;
}

/** `[PF.12.3]` El último costo de compra de un producto: la última entrada XA20, en cada unidad. */
export interface UltimoCosto {
  /** Fecha de la entrada (YYYY-MM-DD). */
  fecha: string;
  /** Código de la sucursal de la entrada; la pantalla la NOMBRA. */
  sucursal: string;
  /** La unidad en que se capturó la entrada (`kdm2.c11`). */
  unidad: string;
  /** Sin IVA ni IEPS, por `unidad`. `null` = la entrada no trae costo (> 0): se declara, nunca $0. */
  costo: number | null;
  impuesto: ImpuestoEntrada;
  /**
   * El costo en cada unidad del renglón, en el MISMO orden que `unidades`. `[]` = sin convertir: la unidad de
   * la entrada no está en la escalera (o no hay costo). Nunca se inventa un factor.
   */
  porUnidad: CostoEnUnidad[];
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
  /**
   * `[NP.22]` Cuántos de la búsqueda están en seguimiento de Productos nuevos (lo que lista «Mostrar › Productos
   * nuevos», que sirve la vista Detallado). null = no se midió en esta respuesta (Productos nuevos se está calculando);
   * ausente = un servidor anterior.
   */
  nuevos?: number | null;
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
  /** `[PF.12.3]` Si el renglón trae `ultimoCosto` (lo decide `puedeVerCostoCatalogo`). */
  costo_visible: boolean;
  /**
   * `[PF.12.3]` `false` = el costo no se pudo leer ahora (falló o pasó el tope): los renglones van SIN
   * `ultimoCosto` y la pantalla dice «Sin dato», no «Sin compras». `null` = no se pidió.
   */
  costo_medido: boolean | null;
}

export interface FichaSucursal {
  codigo: string;
  nombre: string | null;
  /**
   * Lo vendido en el PERIODO pedido (por omisión, el mes en curso; el nombre se quedó por compatibilidad).
   * `null` = no se puede medir: la sucursal no tiene corte a Kepler, o su corte cae dentro del periodo.
   */
  vendidoMes: { monto: number; unidadesBase: number } | null;
  /** `[PF.23]` Desde cuándo vende en Kepler (YYYY-MM-DD). `null` = siempre estuvo en Kepler, o no tiene corte. */
  corteKepler: string | null;
  /** `[PF.23]` Sin corte a Kepler registrado: su venta no se puede medir en ningún periodo. */
  sinCorte: boolean;
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
  /** Última venta del periodo en alguna sucursal (YYYY-MM-DD). */
  corteVenta: string | null;
  /** `[PF.23]` El periodo de la venta por sucursal (YYYY-MM-DD, ambos inclusive). Precio y existencia son de HOY. */
  periodo: { desde: string; hasta: string };
  ultimaEntrada: {
    sucursal: string;
    nombreSucursal: string | null;
    fecha: string;
    cantidad: number;
    unidad: string;
    /**
     * `[PF.12.3]` Por `unidad`, SIN IVA ni IEPS (`costoSinImpuestos`), el mismo número que la lista. `null` si
     * quien consulta no lo ve (`puedeVerCostoCatalogo`) o si la entrada no trae costo.
     */
    costo: number | null;
    /** `[PF.12.3]` Cómo se sabe que `costo` va sin impuestos; `sin_dato` = no se sabe y se dice. */
    impuesto: ImpuestoEntrada;
    /** `[PF.22]` El costo en cada unidad de `unidades`, en su orden. `[]` = sin convertir o sin permiso de verlo. */
    porUnidad: CostoEnUnidad[];
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

/** `[PF.12.3]` La última entrada XA20 como la devuelve `ULTIMAS_ENTRADAS_SQL`. */
export interface EntradaCruda {
  sucursal: string;
  fecha: string;
  unidad: string;
  cantidad: Num;
  /** `kdm2.c12` crudo: con o sin impuestos según el signo de las tasas. */
  costo: Num;
  /** `kdm2.c17`: tasa de IVA del renglón (16, −16, 0). */
  iva: Num;
  /** `kdm2.c18`: tasa de IEPS del renglón (8, −8, 0). */
  ieps: Num;
}

/** 6 decimales, los que guarda `kdm2.c12`: quita el ruido de punto flotante sin redondear antes de convertir. */
const redondear = (v: number): number => Math.round(v * 1e6) / 1e6;
const centavos = (v: number): number => Math.round(v * 100);

/**
 * `[PF.12.3]` El costo de una entrada XA20 SIN IVA ni IEPS, y el factor para llevar un neto a «con impuestos».
 *
 * ⛔ `kdm2.c12` NO siempre es neto: lo decide el SIGNO de la tasa del renglón (`c17` IVA, `c18` IEPS). Medido en
 * la base local el 2026-10-30 sobre los 215 renglones XA20 (7 SKUs, sucursales 00–08, may–oct 2026; las
 * negativas hasta ago-2026, las positivas desde jun-2026):
 *  - tasa positiva o cero → `c12` NETO; el documento suma el impuesto aparte: Σ`c13` + `kdm1.c14` + `c15` = `c16`
 *    en los 9 documentos completos (IEPS +8). Contra el costo de la ficha `kdii.c77` (neto, VERDAD §16.2):
 *    17085 (IVA +16) 43.1035 contra 43.10; 63018 52.68 = 52.68; 88022 154.1808 contra 154.18.
 *  - tasa NEGATIVA → `c12` TRAE el impuesto: Σ`c13` = `c16` en los 2 documentos completos (IEPS −8). Mismo SKU,
 *    mismo costo de lista, las dos convenciones: 63018 56.8942 = 52.68 × 1.08; 88022 166.515 = 154.18 × 1.08;
 *    44238 31.60 = 29.26 × 1.08; 17085 el 29-jun $55.00 con −16 y el 30-jun $47.41 con +16 (= 55.00 / 1.16).
 *  - sin tasa → no se sabe: va tal cual y se DECLARA `sin_dato` (no hay con qué comparar el precio).
 * Las tasas del renglón coinciden con las de la ficha (`kdii.c18`/`c19`) en 215 de 215: por eso sirven también
 * para quitarle el impuesto al PRECIO (`conImpuestos`). IEPS sobre la base e IVA sobre (base + IEPS), como en la
 * venta (`[E.25]`); el caso con las dos incluidas no aparece en la muestra local.
 * Un costo ≤ 0 no es un costo: `null` («sin costo»), nunca $0.
 */
export function costoSinImpuestos(costo: Num, iva: Num, ieps: Num): {
  costo: number | null;
  impuesto: ImpuestoEntrada;
  /** neto × esto = con impuestos. `null` = no se sabe el impuesto. */
  conImpuestos: number | null;
} {
  const c = precioValido(costo);
  const tIva = num(iva);
  const tIeps = num(ieps);
  if (tIva === null && tIeps === null) return { costo: c, impuesto: 'sin_dato', conImpuestos: null };
  const iv = Math.abs(tIva ?? 0) / 100;
  const ie = Math.abs(tIeps ?? 0) / 100;
  // Sólo las tasas negativas vienen DENTRO de c12.
  const incluido = (1 + ((tIeps ?? 0) < 0 ? ie : 0)) * (1 + ((tIva ?? 0) < 0 ? iv : 0));
  return {
    costo: c === null ? null : redondear(c / incluido),
    impuesto: incluido > 1 ? 'descontado' : 'neto',
    conImpuestos: (1 + ie) * (1 + iv),
  };
}

/**
 * `[PF.12.3]` El último costo de un renglón, en cada una de sus unidades.
 *
 * Unidades: la de la entrada (`c11`) se busca POR RÓTULO en las unidades del renglón (la escalera de la
 * sucursal que se lista, las mismas que pinta la tabla); costo base = costo ÷ su factor, y el de cada unidad =
 * costo base × su factor. Si el rótulo no está en la escalera, `porUnidad = []` («sin convertir»): el costo
 * se queda en su propia unidad. Nunca se inventa un factor.
 *
 * «Precio bajo costo» (`bajoCosto`): el precio de lista trae impuestos y el costo no; se comparan los dos sin
 * impuestos (precio ÷ `conImpuestos`), a centavos. Sin precio o sin saber el impuesto → `null`, no se compara.
 */
export function armarUltimoCosto(unidades: UnidadPrecio[], entrada: EntradaCruda | null | undefined): UltimoCosto | null {
  if (!entrada) return null;
  const unidad = etiqueta(entrada.unidad) ?? '';
  const { costo, impuesto, conImpuestos } = costoSinImpuestos(entrada.costo, entrada.iva, entrada.ieps);
  const deEntrada = unidad ? unidades.find((u) => u.unidad === unidad) : undefined;
  const porUnidad: CostoEnUnidad[] =
    costo !== null && deEntrada && deEntrada.factorBase > 0
      ? unidades.map((u) => {
          const c = redondear((costo / deEntrada.factorBase) * u.factorBase);
          const precioSinImpuestos = u.precio === null || conImpuestos === null ? null : redondear(u.precio / conImpuestos);
          const bajoCosto = precioSinImpuestos === null ? null : centavos(precioSinImpuestos) < centavos(c);
          return { unidad: u.unidad, costo: c, precioSinImpuestos, bajoCosto };
        })
      : [];
  return { fecha: entrada.fecha, sucursal: entrada.sucursal, unidad, costo, impuesto, porUnidad };
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
  /** `[PF.23]` Su corte a Kepler (null = siempre en Kepler, o sin corte). */
  corte?: string | null;
  sin_corte?: boolean;
}

const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;
/** El periodo más largo que se pide de una vez: dos años (la venta diaria de un producto, sin ventana en la matvista). */
export const PERIODO_MAX_DIAS = 731;

/** Días de `desde` a `hasta`, los dos incluidos (YYYY-MM-DD). */
export function diasEntre(desde: string, hasta: string): number {
  return Math.round((new Date(hasta + 'T00:00:00Z').getTime() - new Date(desde + 'T00:00:00Z').getTime()) / 86_400_000) + 1;
}

/**
 * `[PF.23]` El periodo de la venta de la ficha. Sin fechas → el mes en curso hasta hoy (lo de siempre).
 * Con fechas: las dos válidas, `desde <= hasta`, `hasta` no pasa de hoy (se recorta: el futuro no tiene venta) y a lo
 * más `PERIODO_MAX_DIAS`. `null` = el pedido no es un periodo (el controlador responde 400, no se adivina).
 */
export function periodoFicha(desde: string | null | undefined, hasta: string | null | undefined, hoy: string): { desde: string; hasta: string } | null {
  const d = (desde ?? '').trim();
  const h = (hasta ?? '').trim();
  if (!d && !h) return { desde: hoy.slice(0, 8) + '01', hasta: hoy };
  if (!FECHA_ISO.test(d) || !FECHA_ISO.test(h)) return null;
  const fd = new Date(d + 'T00:00:00Z');
  const fh = new Date(h + 'T00:00:00Z');
  if (Number.isNaN(fd.getTime()) || Number.isNaN(fh.getTime())) return null;
  if (fd.toISOString().slice(0, 10) !== d || fh.toISOString().slice(0, 10) !== h) return null; // 2026-02-31
  const hastaReal = h > hoy ? hoy : h;
  if (d > hastaReal) return null;
  if (diasEntre(d, hastaReal) > PERIODO_MAX_DIAS) return null;
  return { desde: d, hasta: hastaReal };
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
      corteKepler: s.corte ?? null,
      sinCorte: s.sin_corte === true,
      existenciaBase: existencia.has(s.codigo) ? num(existencia.get(s.codigo)) : null,
    };
  });
}

/** count/min/max del precio base entre sucursales; sólo precios > 0. */
export function precioDeRed(precios: Num[]): { sucursales: number; min: number | null; max: number | null } {
  const v = precios.map(precioValido).filter((x): x is number => x !== null);
  return { sucursales: v.length, min: v.length ? Math.min(...v) : null, max: v.length ? Math.max(...v) : null };
}

/**
 * `[PF.21]` La sucursal del PRECIO en Compras › Catálogo, recortada al ALCANCE de la persona con la misma regla que
 * Precios (`PreciosCatalogoService.sucursalesPermitidas`). Antes se servía cualquier `?sucursal=` a quien viera el catálogo.
 *  - pedida y en su alcance → ésa; pedida y fuera (o mal escrita) → `null`: el controlador responde 403.
 *  - sin pedir → la 01 si está en su alcance (el default de siempre); si no, la primera de las suyas.
 *  - ninguna en su alcance → la 01, como antes: el precio al público no es secreto, y el costo lo decide
 *    `puedeVerCostoCatalogo` (que deja fuera al cliente externo).
 */
export function sucursalDelCatalogo(permitidas: ReadonlyArray<{ codigo: string }>, pedida: string | null | undefined): string | null {
  const defecto = !permitidas.length || permitidas.some((s) => s.codigo === '01') ? '01' : permitidas[0].codigo;
  const p = (pedida ?? '').trim();
  // Pedir la MISMA que se da por omisión siempre pasa: si no, quien no tiene ninguna en su alcance abre la lista (01)
  // y la ficha, que pide la 01 de la lista, le daba 403.
  if (p) return permitidas.some((s) => s.codigo === p) || p === defecto ? p : null;
  return defecto;
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
