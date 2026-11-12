/**
 * `[MKT.10]` — Las reglas del ranking de promociones, sin base de datos ni Nest.
 *
 * Reemplazan las fórmulas del Excel «RANKING SEMANA NN». Cada regla corrige un defecto medido en
 * los 45 archivos de 2026 (auditoría del 2026-11-11):
 *
 *  · CUBRIMIENTO CON TOPE de 100 %. En el Excel una fila con objetivo 1 y venta 34 (3,400 %)
 *    decidía el lugar de la sucursal; con tope, cumplir una promo vale lo mismo que cumplir otra.
 *  · SIN OBJETIVO ≠ CERO. Una promo sin objetivo no entra al promedio y se cuenta aparte; el
 *    Excel la dibujaba como 0 % y castigaba a la sucursal por una captura que no hizo nadie.
 *  · EL PROMEDIO CUBRE TODAS LAS FILAS. Los rangos `AVERAGE(G5:G45)` del Excel dejaban fuera
 *    renglones (20 de 45 semanas); aquí no hay rango que escribir.
 *  · EL PAGO ES LA REGLA, NO UNA FÓRMULA COPIADA. En el Excel 165 renglones multiplicaban por un
 *    monto distinto al que decía su texto ($25 × 100). Aquí el monto se captura una vez.
 */

export type Canal = 'mostrador' | 'preventa' | 'ruta' | 'mayoreo';
export const CANALES: readonly Canal[] = ['mostrador', 'preventa', 'ruta', 'mayoreo'];

/** Cómo se llama cada canal en la pantalla y en el PDF. */
export const CANAL_TEXTO: Record<Canal, string> = {
  mostrador: 'Sucursales (mostrador)',
  preventa: 'Vecinal (preventa)',
  ruta: 'Rutas',
  mayoreo: 'Televenta (mayoreo)',
};

export const esCanal = (v: unknown): v is Canal => typeof v === 'string' && (CANALES as readonly string[]).includes(v);

// ─────────────────────────────── semanas ───────────────────────────────

const DIA = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (ymd: string) => new Date(`${ymd}T00:00:00Z`);

/** El lunes de la semana de una fecha `YYYY-MM-DD` (semana ISO, lunes a domingo). */
export function lunesDe(ymd: string): string {
  const d = utc(ymd);
  const dow = d.getUTCDay() || 7; // domingo = 7
  return iso(new Date(d.getTime() - (dow - 1) * DIA));
}

export const sumarDias = (ymd: string, n: number) => iso(new Date(utc(ymd).getTime() + n * DIA));

/** Número de semana ISO (la que usa el Excel en su título «SEMANA 45»). */
export function numeroSemana(lunes: string): number {
  const d = utc(lunes);
  const jueves = new Date(d.getTime() + 3 * DIA);
  const inicioAnio = new Date(Date.UTC(jueves.getUTCFullYear(), 0, 1));
  return Math.ceil(((jueves.getTime() - inicioAnio.getTime()) / DIA + 1) / 7);
}

export interface Semana {
  lunes: string;
  domingo: string;
  numero: number;
  /** Hasta qué día hay datos: hoy si la semana está en curso. */
  hasta: string;
  en_curso: boolean;
}

/**
 * La semana pedida. Sin fecha, la última semana CERRADA (como el Excel, que se publica el lunes
 * con la semana anterior). Una semana futura se rechaza: no hay nada que medir.
 */
export function resolverSemana(pedida: string | undefined, hoy: string): Semana {
  const lunes = pedida && /^\d{4}-\d{2}-\d{2}$/.test(pedida) ? lunesDe(pedida) : sumarDias(lunesDe(hoy), -7);
  if (lunes > hoy) throw new Error('semana_futura');
  const domingo = sumarDias(lunes, 6);
  const en_curso = domingo >= hoy;
  return { lunes, domingo, numero: numeroSemana(lunes), hasta: en_curso ? hoy : domingo, en_curso };
}

// ─────────────────────────────── cubrimiento y ranking ───────────────────────────────

/** Venta ÷ objetivo con tope de 100 %. NULL si no hay objetivo (no se puede medir, no es cero). */
export function cubrimiento(venta: number, objetivo: number | null | undefined): number | null {
  if (objetivo === null || objetivo === undefined || !(objetivo > 0)) return null;
  return Math.min(1, Math.max(0, venta) / objetivo);
}

export interface RenglonPromo {
  promo_id: string;
  objetivo: number | null;
  venta: number;
}

export interface Puntaje {
  /** Promedio del cubrimiento con tope, sólo sobre las promos con objetivo. NULL si ninguna tiene. */
  puntaje: number | null;
  con_objetivo: number;
  sin_objetivo: number;
  cumplidas: number;
  sin_venta: number;
}

export function puntaje(rs: RenglonPromo[]): Puntaje {
  let suma = 0, con = 0, sin = 0, cumplidas = 0, sinVenta = 0;
  for (const r of rs) {
    if (!(r.venta > 0)) sinVenta++;
    const c = cubrimiento(r.venta, r.objetivo);
    if (c === null) { sin++; continue; }
    con++;
    suma += c;
    if (c >= 1) cumplidas++;
  }
  return { puntaje: con ? suma / con : null, con_objetivo: con, sin_objetivo: sin, cumplidas, sin_venta: sinVenta };
}

/**
 * Lugar en el ranking: mejor puntaje primero; empate → más promos cumplidas; los que no se pueden
 * medir (sin ningún objetivo) al final y SIN lugar.
 */
export function ordenarRanking<T extends Puntaje & { nombre: string }>(xs: T[]): Array<T & { lugar: number | null }> {
  const medibles = xs.filter((x) => x.puntaje !== null)
    .sort((a, b) => (b.puntaje! - a.puntaje!) || (b.cumplidas - a.cumplidas) || a.nombre.localeCompare(b.nombre, 'es'));
  const resto = xs.filter((x) => x.puntaje === null).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  return [
    ...medibles.map((x, i) => ({ ...x, lugar: i + 1 })),
    ...resto.map((x) => ({ ...x, lugar: null })),
  ];
}

/** Promedio general: cada participante pesa igual. NULL si nadie se pudo medir. */
export function promedioGeneral(xs: Array<{ puntaje: number | null }>): number | null {
  const v = xs.map((x) => x.puntaje).filter((p): p is number => p !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

// ─────────────────────────────── objetivo sugerido ───────────────────────────────

/**
 * Lo que el sistema propone como objetivo semanal: el promedio de lo vendido en las semanas de
 * historia que haya (hasta 4), redondeado hacia arriba, mínimo 1. Sin ninguna semana de historia
 * no se inventa: NULL, y Marketing lo captura.
 */
export function objetivoSugerido(ventasSemanales: number[]): number | null {
  const v = ventasSemanales.filter((x) => Number.isFinite(x));
  if (!v.length) return null;
  const prom = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.max(1, Math.ceil(prom));
}

// ─────────────────────────────── el producto de la promoción ───────────────────────────────
//
// Kepler NO guarda qué producto activa un código de promoción: el código simbólico («3 LECHE SAN
// JUAN = GRATIS 1 MAS», $0.01) es un producto aparte, sin liga a la leche. Barrido de las 242
// tablas de `kepler_ods` (2026-11-11): ninguna los relaciona; `kdpv_gratisxq/xm` tienen 5 reglas por
// sucursal, vencidas en 2025. La liga sólo queda en el TICKET: el cajero cobra la leche y aplica
// el código en la misma venta. Por eso se deriva de ahí, con DOS pruebas a la vez:
//   1. el producto sale en el mismo ticket que el código (en ≥ 10 % de esos tickets, mínimo 2);
//   2. su nombre comparte una palabra con lo que la promoción pide comprar (antes del «=»).
// Medido en prod (4 semanas de mostrador, 117 códigos con venta): 60 identificados así; sólo con
// la prueba 1 salían M&M's para «4 GALLETAS INDICADAS» (39 % de los tickets). Lo que no pasa las
// dos pruebas se DECLARA «sin identificar», nunca se adivina.

export type MetodoProducto = 'mismo_codigo' | 'ticket_y_nombre' | 'sin_identificar' | 'pocos_tickets';

export interface CandidatoProducto { sku: string; nombre: string | null; tickets: number }
export interface ProductoIdentificado { sku: string; nombre: string | null; tickets: number; pct: number | null }
export interface ProductosDePromo { metodo: MetodoProducto; tickets: number; productos: ProductoIdentificado[]; nota: string }

/** Palabras que dicen CÓMO es la promoción, no QUÉ producto: no sirven para ligar un nombre. */
const PALABRAS_VACIAS = new Set([
  'COMPRA', 'GRATIS', 'GRATUS', 'PROD', 'PRODS', 'PRODUCTO', 'PRODUCTOS', 'INDICADO', 'INDICADOS', 'INDICADA',
  'INDICADAS', 'BOLSA', 'BOLSAS', 'CAJAS', 'PIEZA', 'PIEZAS', 'LINEA', 'MERCANCIA', 'MERCA', 'EXHIBIDOR',
  'EXHIBIDORES', 'PEGAR', 'CADA', 'PROMOCIONAL', 'ENTRE', 'SURTIDO', 'SURTIDOS', 'PAQUETE', 'REJAS',
]);
export const MIN_TICKETS_PRODUCTO = 3;
const MAX_PRODUCTOS = 6;

const sinAcentos = (s: string) => s.toUpperCase().normalize('NFD').replace(/\p{M}/gu, '');

/** Las palabras de lo que se COMPRA (antes del «=»), sin plural: «LECHES» busca «LECHE». */
export function palabrasDePromo(descripcion: string | null | undefined): string[] {
  const pide = sinAcentos(String(descripcion ?? '')).split('=')[0];
  const out = new Set<string>();
  for (const w of pide.split(/[^A-Z]+/)) {
    if (w.length < 4 || PALABRAS_VACIAS.has(w)) continue;
    out.add(w.length >= 5 && w.endsWith('ES') && !w.endsWith('SES') ? w.slice(0, -1) : w.length >= 5 && w.endsWith('S') ? w.slice(0, -1) : w);
  }
  return [...out];
}

/** ¿El nombre del producto tiene alguna palabra que EMPIECE como una de la promoción? */
export function nombreCoincide(nombre: string | null | undefined, palabras: string[]): boolean {
  if (!nombre || !palabras.length) return false;
  const ws = sinAcentos(nombre).split(/[^A-Z]+/).filter(Boolean);
  return palabras.some((p) => ws.some((w) => w.startsWith(p)));
}

/**
 * Qué producto activa la promoción. `esSimbolico` = el código cuesta $0.01 o dice «= GRATIS»;
 * si NO lo es («WINIS T7 /24 + % GRATIS» a precio real), el producto ES el mismo código.
 */
export function identificarProductos(p: {
  code: string; descripcion: string | null; esSimbolico: boolean; tickets: number; candidatos: CandidatoProducto[];
}): ProductosDePromo {
  if (!p.esSimbolico) {
    return {
      metodo: 'mismo_codigo', tickets: p.tickets,
      productos: [{ sku: p.code, nombre: p.descripcion, tickets: p.tickets, pct: null }],
      nota: 'El código es el producto mismo, con contenido de regalo; no es un código simbólico.',
    };
  }
  if (p.tickets < MIN_TICKETS_PRODUCTO) {
    return {
      metodo: 'pocos_tickets', tickets: p.tickets, productos: [],
      nota: `Sólo ${p.tickets} ${p.tickets === 1 ? 'ticket' : 'tickets'} con la promoción en las últimas 4 semanas: no alcanza para saber con qué producto se vende.`,
    };
  }
  const palabras = palabrasDePromo(p.descripcion);
  const minimo = Math.max(2, Math.ceil(p.tickets * 0.1));
  const productos = p.candidatos
    .filter((c) => c.sku !== p.code && c.tickets >= minimo && nombreCoincide(c.nombre, palabras))
    .sort((a, b) => b.tickets - a.tickets || a.sku.localeCompare(b.sku))
    .slice(0, MAX_PRODUCTOS)
    .map((c) => ({ sku: c.sku, nombre: c.nombre, tickets: c.tickets, pct: Math.round((100 * c.tickets) / p.tickets) }));
  if (!productos.length) {
    return {
      metodo: 'sin_identificar', tickets: p.tickets, productos: [],
      nota: palabras.length
        ? `Ningún producto de los ${p.tickets} tickets con la promoción se llama como lo que pide («${palabras.join(', ')}»).`
        : 'La promoción no nombra un producto («productos indicados», «$X de mercancía»): Kepler no dice cuáles son.',
    };
  }
  return {
    metodo: 'ticket_y_nombre', tickets: p.tickets, productos,
    nota: `Sale en el mismo ticket que la promoción y su nombre coincide con lo que pide (${p.tickets} tickets, últimas 4 semanas).`,
  };
}

// ─────────────────────────────── incentivos ───────────────────────────────

export type TipoIncentivo = 'por_caja' | 'por_unidad' | 'por_monto' | 'por_cliente' | 'por_captura';
export type Redondeo = 'proporcional' | 'completo';

export const TIPO_INCENTIVO_TEXTO: Record<TipoIncentivo, string> = {
  por_caja: 'por caja vendida',
  por_unidad: 'por unidad vendida',
  por_monto: 'por cada monto vendido',
  por_cliente: 'por cliente distinto',
  por_captura: 'por captura (exhibidor colocado)',
};

/**
 * Cuántas «unidades de pago» lleva un vendedor. `proporcional` paga la fracción (como hoy el
 * Excel: 0.25 cajas → $12.50); `completo` sólo cuenta las unidades enteras.
 */
export function unidadesDePago(cantidad: number, redondeo: Redondeo): number {
  const c = Math.max(0, cantidad);
  return redondeo === 'completo' ? Math.floor(c + 1e-9) : Math.round(c * 100) / 100;
}

/** El texto de la regla, armado desde sus datos (nunca tecleado aparte del monto). */
export function textoRegla(i: { tipo: TipoIncentivo; pago: number; base_monto: number | null }): string {
  const p = `$${i.pago.toFixed(2)}`;
  switch (i.tipo) {
    case 'por_caja': return `${p} por caja vendida`;
    case 'por_unidad': return `${p} por unidad vendida`;
    case 'por_monto': return `${p} por cada $${(i.base_monto ?? 0).toFixed(2)} vendidos`;
    case 'por_cliente': return `${p} por cada cliente distinto`;
    case 'por_captura': return `${p} por cada exhibidor colocado (captura)`;
  }
}
