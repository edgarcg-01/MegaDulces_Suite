import type {
  CambioPrecioDia,
  FilaListaPrecios,
  OpcionClasificacion,
  OrdenListaPrecios,
  PrecioUnidad,
  TramoVolumen,
} from '@megadulces/contracts';

/**
 * `[CAT-PRECIO.2]` La REGLA del catálogo de precios, sin base de datos, para que se pruebe sola. El
 * servicio trae la ficha de la sucursal (`LISTA_PRECIOS_SQL`); el margen, las unidades, el cambio del
 * día y el orden se deciden aquí.
 */

/** Una ficha tal como sale de `LISTA_PRECIOS_SQL` (los `numeric` de Postgres llegan como texto). */
export interface FichaPrecio {
  sku: string;
  nombre: string | null;
  linea: string | null;
  linea_nombre: string | null;
  tipo: string | null;
  tipo_nombre: string | null;
  grupo: string | null;
  grupo_nombre: string | null;
  iva: number | string | null;
  ieps: number | string | null;
  costo: number | string | null;
  u1: string | null;
  u2: string | null;
  u3: string | null;
  f2: number | string | null;
  f3: number | string | null;
  pv1: number | string | null;
  pv2: number | string | null;
  pv3: number | string | null;
  cb1: (string | null)[] | null;
  cb2: (string | null)[] | null;
  cb3: (string | null)[] | null;
  vol1: { desde: number | string; precio: number | string }[] | null;
  vol2: { desde: number | string; precio: number | string }[] | null;
  vol3: { desde: number | string; precio: number | string }[] | null;
}

/** Un renglón de la bitácora de UN día (`CAMBIOS_DIA_SQL`). */
export interface CambioCrudo {
  sku: string;
  unidad: string;
  precio_anterior: number | string | null;
  precio_nuevo: number | string | null;
  delta: number | string | null;
  hora: string | null;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const txt = (v: string | null | undefined): string => (v ?? '').trim();
const r2 = (n: number) => Math.round(n * 100) / 100;

/** El código que Kepler usa para «NO APLICA» en línea, tipo y grupo. */
export const NO_APLICA = '00001';

/**
 * El precio sin impuestos. En la ficha de Kepler una tasa NEGATIVA quiere decir que el precio de
 * venta ya la incluye (nota en la propia pantalla); positiva, que se cobra encima. IEPS e IVA se
 * aplican en cascada, así que se quitan los dos.
 */
export function precioSinImpuestos(pv: number, iva: number, ieps: number): number {
  let p = pv;
  if (ieps < 0) p /= 1 + Math.abs(ieps) / 100;
  if (iva < 0) p /= 1 + Math.abs(iva) / 100;
  return p;
}

/**
 * El margen como lo calcula Kepler: ganancia sobre el COSTO (no sobre el precio), con el precio sin
 * impuestos. Verificado el 2026-10-16: casa con el «%Margen» de la ficha en 8,189 de 9,627 productos
 * de la 03 (85 %); la Oreo 02073 da 20.25 % en las dos. `null` cuando no hay con qué calcularlo.
 */
export function margenKepler(pv: number | null, costoUnidad: number | null, iva: number, ieps: number): number | null {
  if (!pv || pv <= 0 || !costoUnidad || costoUnidad <= 0) return null;
  return r2((precioSinImpuestos(pv, iva, ieps) / costoUnidad - 1) * 100);
}

export function ajustePct(anterior: number, nuevo: number): number | null {
  return anterior > 0 ? r2((nuevo / anterior - 1) * 100) : null;
}

/**
 * Los cambios de UN día, por `sku|UNIDAD`. Si un precio se movió varias veces ese día, cuenta el
 * movimiento NETO: el anterior del primer cambio contra el nuevo del último. Los de exactamente un
 * centavo se ocultan (mismo piso que Etiquetas › Cambios) y se cuentan aparte.
 */
export function cambiosDelDia(filas: CambioCrudo[]): { porClave: Map<string, CambioPrecioDia>; ocultos: number } {
  const orden = [...filas].sort((a, b) => txt(a.hora).localeCompare(txt(b.hora)));
  const acumulado = new Map<string, { anterior: number; nuevo: number; hora: string | null }>();
  for (const f of orden) {
    const k = `${txt(f.sku)}|${txt(f.unidad).toUpperCase()}`;
    const prev = acumulado.get(k);
    acumulado.set(k, { anterior: prev ? prev.anterior : num(f.precio_anterior), nuevo: num(f.precio_nuevo), hora: f.hora });
  }
  const porClave = new Map<string, CambioPrecioDia>();
  let ocultos = 0;
  for (const [k, c] of acumulado) {
    // En CENTAVOS ENTEROS: con flotantes, 35.71 − 35.70 da 0.01000000000000156 y el piso fallaba en
    // ~18 % de los cambios de un centavo (medido en la revisión independiente). Etiquetas lo hace en
    // `numeric` de SQL; aquí, en enteros, para que los dos cuadren.
    const centavos = Math.abs(Math.round(c.nuevo * 100) - Math.round(c.anterior * 100));
    // Neto cero (subió y volvió el mismo día): no es un cambio ni un «cambio de un centavo»; no se cuenta.
    if (centavos === 0) continue;
    if (centavos === 1) {
      ocultos++;
      continue;
    }
    porClave.set(k, { anterior: c.anterior, nuevo: c.nuevo, ajuste_pct: ajustePct(c.anterior, c.nuevo), hora: c.hora });
  }
  return { porClave, ocultos };
}

const entero = (n: number) => Math.abs(n - Math.round(n)) < 1e-9;
const fmt = (n: number) => (entero(n) ? String(Math.round(n)) : String(Math.round(n * 100) / 100));

/**
 * `[CAT-PRECIO.2]` La conversión de cada unidad, como la pidió Compras: «1 PZA», «PAQ = 10 PZA»,
 * «CJA = 14 PAQ = 140 PZA».
 *
 * En la ficha de Kepler los factores de la unidad 2 (`c81`) y 3 (`c84`) vienen en UNIDADES BASE —medido
 * el 2026-10-16 en la 03: en 2,992 de 2,993 fichas con unidad 3, `c84 ≥ c81`—, así que la unidad 3 en
 * unidades de la 2 es `f3 / f2`, y sólo se escribe cuando da entero (5 fichas no lo dan: ahí se dice sólo
 * en unidades base, no se redondea a una cantidad que no existe). Sin factor = `null`, no se inventa.
 */
export function conversiones(u1: string, u2: { u: string; f: number } | null, u3: { u: string; f: number } | null): (string | null)[] {
  const base = u1 || '¿?';
  const out: (string | null)[] = [`1 ${base}`];
  if (u2) out.push(u2.f > 0 ? `${u2.u} = ${fmt(u2.f)} ${base}` : null);
  if (u3) {
    if (!(u3.f > 0)) out.push(null);
    else {
      const enU2 = u2 && u2.f > 1 && u2.u !== base ? u3.f / u2.f : null;
      out.push(enU2 !== null && entero(enU2) && enU2 > 1
        ? `${u3.u} = ${fmt(enU2)} ${u2!.u} = ${fmt(u3.f)} ${base}`
        : `${u3.u} = ${fmt(u3.f)} ${base}`);
    }
  }
  return out;
}

const clasificacion = (codigo: string | null, nombre: string | null) => {
  const c = txt(codigo);
  return { codigo: c || null, nombre: c ? txt(nombre) || c : null };
};

const tramos = (v: FichaPrecio['vol1']): TramoVolumen[] =>
  (v ?? []).map((t) => ({ desde: num(t.desde), precio: num(t.precio) })).filter((t) => t.precio > 0);

/**
 * Arma el renglón: la unidad base siempre, la 2 y la 3 sólo si la ficha les puso rótulo (un factor
 * en una unidad sin rótulo es basura de captura). El costo de cada unidad = costo estándar × factor.
 */
export function armarFila(f: FichaPrecio, cambios?: Map<string, CambioPrecioDia>): FilaListaPrecios {
  const iva = num(f.iva);
  const ieps = num(f.ieps);
  const costo = num(f.costo);
  const defs: { n: 1 | 2 | 3; u: string | null; factor: number; pv: unknown; cb: FichaPrecio['cb1']; vol: FichaPrecio['vol1'] }[] = [
    { n: 1, u: f.u1, factor: 1, pv: f.pv1, cb: f.cb1, vol: f.vol1 },
    { n: 2, u: f.u2, factor: num(f.f2), pv: f.pv2, cb: f.cb2, vol: f.vol2 },
    { n: 3, u: f.u3, factor: num(f.f3), pv: f.pv3, cb: f.cb3, vol: f.vol3 },
  ];
  const conRotulo = defs.filter((d) => d.n === 1 || txt(d.u));
  const lab = (d: (typeof defs)[number]) => txt(d.u).toUpperCase();
  const conv = conversiones(
    lab(defs[0]),
    conRotulo.find((d) => d.n === 2) ? { u: lab(defs[1]), f: defs[1].factor } : null,
    conRotulo.find((d) => d.n === 3) ? { u: lab(defs[2]), f: defs[2].factor } : null,
  );
  const unidades: PrecioUnidad[] = [];
  for (const d of defs) {
    const unidad = txt(d.u).toUpperCase();
    if (d.n > 1 && !unidad) continue;
    const pv = num(d.pv) > 0 ? r2(num(d.pv)) : null;
    const factor = d.n === 1 ? 1 : d.factor;
    const costoUnidad = costo > 0 && factor > 0 ? costo * factor : null;
    unidades.push({
      n: d.n,
      unidad: unidad || '¿?',
      factor,
      conversion: conv[unidades.length] ?? null,
      precio: pv,
      margen_pct: margenKepler(pv, costoUnidad, iva, ieps),
      volumen: tramos(d.vol),
      codigos: (d.cb ?? []).map((c) => txt(c)).filter(Boolean),
      cambio: cambios?.get(`${txt(f.sku)}|${unidad}`) ?? null,
    });
  }
  return {
    sku: txt(f.sku),
    nombre: txt(f.nombre) || txt(f.sku),
    linea: clasificacion(f.linea, f.linea_nombre),
    tipo: clasificacion(f.tipo, f.tipo_nombre),
    grupo: clasificacion(f.grupo, f.grupo_nombre),
    iva,
    ieps,
    unidades,
  };
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Varias palabras, todas tienen que aparecer, en SKU, nombre o cualquier código de barras. */
export function coincide(f: FilaListaPrecios, q: string | undefined): boolean {
  const palabras = norm((q ?? '').trim()).split(/\s+/).filter(Boolean);
  if (!palabras.length) return true;
  const pajar = norm([f.sku, f.nombre, ...f.unidades.flatMap((u) => u.codigos)].join(' '));
  return palabras.every((p) => pajar.includes(p));
}

const clave = (c: { codigo: string | null; nombre: string | null }) => c.nombre ?? '￿';

/** Orden de la lista y del PDF: por artículo, o agrupado por línea, tipo o grupo (y dentro, por artículo). */
export function ordenar(filas: FilaListaPrecios[], orden: OrdenListaPrecios = 'articulo'): FilaListaPrecios[] {
  const porNombre = (a: FilaListaPrecios, b: FilaListaPrecios) => a.nombre.localeCompare(b.nombre, 'es') || a.sku.localeCompare(b.sku);
  if (orden === 'articulo') return [...filas].sort(porNombre);
  return [...filas].sort((a, b) => clave(a[orden]).localeCompare(clave(b[orden]), 'es') || porNombre(a, b));
}

/** Las opciones de un filtro de clasificación, con su conteo. Lo vacío se ofrece como «Sin asignar». */
export function opciones(filas: FilaListaPrecios[], campo: 'linea' | 'tipo' | 'grupo'): OpcionClasificacion[] {
  const m = new Map<string, OpcionClasificacion>();
  for (const f of filas) {
    const c = f[campo];
    const codigo = c.codigo ?? '';
    const o = m.get(codigo) ?? { codigo, nombre: codigo ? (c.nombre ?? codigo) : 'Sin asignar', productos: 0 };
    o.productos++;
    m.set(codigo, o);
  }
  return [...m.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}
