import {
  CAMPOS_FICHA,
  type CambioPrecioPlaza,
  type CampoFicha,
  type ConsultaFichaSucursales,
  type DiferenciaCampoFicha,
  type FilaFichaSucursales,
} from '@megadulces/contracts';

/**
 * `[CAT-PRECIO.1]` — **La ficha de venta tiene que ser la misma en todas las sucursales.**
 *
 * Esta es la REGLA, sin base de datos, para que se pruebe sola. El servicio sólo junta las fichas
 * (`FICHA_SUCURSALES_SQL`); qué campo difiere, cuál es la referencia y qué plaza se sale lo decide
 * esto.
 *
 * ── Por qué igualdad EXACTA y no la tolerancia de 0.5 % de Costos ──────────────────────────────
 * Un costo se redondea al capturarse y la regla de Costos lo absorbe. Un precio de venta no: el
 * cliente paga el número impreso, y 35.70 contra 35.71 es un centavo que alguien cobró distinto.
 * Compras lo pidió así: «todo tiene que estar igual». Por eso la clave de cada precio son sus
 * centavos y cualquier diferencia cuenta.
 *
 * ── Por qué la referencia es la mayoría (y por qué es provisional) ──────────────────────────────
 * Lo que manda es el Sistema Concentrador, y su base no llega al ODS. Sin él, lo único defendible
 * es el valor que comparte la mayoría de las plazas; un empate se DECLARA (`sin_mayoria`) en vez de
 * elegir. La mayoría puede estar equivocada —medido con 02073: ocho plazas con el precio viejo y
 * sólo la 03 con el nuevo—, por eso cada fila lleva el último cambio de precio de cada plaza.
 */

/** Una ficha de una plaza, tal como la arma `FICHA_SUCURSALES_SQL`. */
export interface FichaPlaza {
  sucursal: string;
  descripcion: string | null;
  linea: string | null;
  linea_nombre: string | null;
  tipo: string | null;
  tipo_nombre: string | null;
  grupo: string | null;
  grupo_nombre: string | null;
  iva: number | string | null;
  ieps: number | string | null;
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
  /** Niveles 0 de precio por volumen: `UNIDAD:desde:precio` separados por `;`. Vacío = sin volumen. */
  mayoreo: string | null;
  /** Último cambio real de precio de esa plaza en la bitácora, `YYYY-MM-DD`. */
  ultimo_cambio: string | null;
}

/** El código que Kepler usa para «NO APLICA» en línea, tipo y grupo. */
const NO_APLICA = '00001';
const SIN_DATO = '—';

const num = (v: number | string | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const txt = (v: string | null | undefined): string => (v ?? '').trim();

const pesos = (n: number): string =>
  '$' + n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** La unidad sólo existe si tiene rótulo; el factor de una unidad sin rótulo es basura de captura. */
const unidad = (rotulo: string | null, factor: number | string | null): { u: string; f: number } | null => {
  const u = txt(rotulo).toUpperCase();
  return u ? { u, f: num(factor) } : null;
};

function textoClasificacion(codigo: string | null, nombre: string | null): string {
  const c = txt(codigo);
  if (!c) return SIN_DATO;
  if (c === NO_APLICA) return 'NO APLICA';
  return txt(nombre) || c;
}

function textoImpuesto(tasa: number | string | null): string {
  const t = num(tasa);
  if (t === 0) return '0 %';
  // Nota de la ficha de Kepler: negativo = el precio de venta YA lo incluye.
  return `${Math.abs(t)} % ${t < 0 ? '(incluido)' : '(no incluido)'}`;
}

function textoMayoreo(m: string | null): string {
  const s = txt(m);
  if (!s) return 'sin precio por volumen';
  return s
    .split(';')
    .map((tramo) => {
      const [u, desde, precio] = tramo.split(':');
      return `${u} desde ${num(desde)}: ${pesos(num(precio))}`;
    })
    .join(' · ');
}

function textoBarras(f: FichaPlaza): string {
  const partes = [
    [f.u1, f.cb1],
    [f.u2, f.cb2],
    [f.u3, f.cb3],
  ]
    .map(([u, cbs]) => {
      const codigos = ((cbs as (string | null)[] | null) ?? []).map((c) => txt(c)).filter(Boolean);
      return codigos.length ? `${txt(u as string | null) || '¿?'}: ${codigos.join(', ')}` : '';
    })
    .filter(Boolean);
  return partes.length ? partes.join(' · ') : SIN_DATO;
}

/** La clave con que se compara cada campo y el texto con que se muestra. */
export function claveYTexto(campo: CampoFicha, f: FichaPlaza): { clave: string; texto: string } {
  switch (campo) {
    case 'precio1':
    case 'precio2':
    case 'precio3': {
      const i = campo === 'precio1' ? 1 : campo === 'precio2' ? 2 : 3;
      const pv = num(i === 1 ? f.pv1 : i === 2 ? f.pv2 : f.pv3);
      const u = txt(i === 1 ? f.u1 : i === 2 ? f.u2 : f.u3).toUpperCase();
      if (pv <= 0) return { clave: '', texto: SIN_DATO };
      return { clave: pv.toFixed(2), texto: u ? `${pesos(pv)} / ${u}` : pesos(pv) };
    }
    case 'mayoreo':
      return { clave: txt(f.mayoreo), texto: textoMayoreo(f.mayoreo) };
    case 'unidades': {
      const u1 = unidad(f.u1, 1);
      const u2 = unidad(f.u2, f.f2);
      const u3 = unidad(f.u3, f.f3);
      const clave = [u1, u2, u3].map((x) => (x ? `${x.u}:${x.f}` : '')).join('|');
      const texto = [u1?.u, u2 && `${u2.u} ×${u2.f}`, u3 && `${u3.u} ×${u3.f}`].filter(Boolean).join(' · ');
      return { clave, texto: texto || SIN_DATO };
    }
    case 'iva':
      return { clave: String(num(f.iva)), texto: textoImpuesto(f.iva) };
    case 'ieps':
      return { clave: String(num(f.ieps)), texto: textoImpuesto(f.ieps) };
    case 'linea':
      return { clave: txt(f.linea), texto: textoClasificacion(f.linea, f.linea_nombre) };
    case 'tipo':
      return { clave: txt(f.tipo), texto: textoClasificacion(f.tipo, f.tipo_nombre) };
    case 'grupo':
      return { clave: txt(f.grupo), texto: textoClasificacion(f.grupo, f.grupo_nombre) };
    case 'descripcion':
      return { clave: txt(f.descripcion), texto: txt(f.descripcion) || SIN_DATO };
    case 'barras': {
      const todas = [f.cb1, f.cb2, f.cb3].map((cbs) => (cbs ?? []).map((c) => txt(c)).join(',')).join('|');
      return { clave: todas, texto: textoBarras(f) };
    }
  }
}

export interface ResultadoMayoria {
  veredicto: 'igual' | 'distinto' | 'sin_mayoria';
  /** La clave de la mayoría. `null` en `sin_mayoria`. */
  mayoria: string | null;
  fuera: string[];
}

/**
 * La mayoría por igualdad exacta de clave. La AUSENCIA también es un valor (`''`): si siete plazas
 * tienen precio de caja y una no, la que no lo tiene se sale.
 */
export function mayoriaDeClaves(celdas: { sucursal: string; clave: string }[]): ResultadoMayoria {
  const cuenta = new Map<string, number>();
  for (const c of celdas) cuenta.set(c.clave, (cuenta.get(c.clave) ?? 0) + 1);
  if (cuenta.size <= 1) return { veredicto: 'igual', mayoria: celdas[0]?.clave ?? null, fuera: [] };
  const max = Math.max(...cuenta.values());
  const empatados = [...cuenta.entries()].filter(([, k]) => k === max);
  if (empatados.length > 1) return { veredicto: 'sin_mayoria', mayoria: null, fuera: [] };
  const mayoria = empatados[0][0];
  return { veredicto: 'distinto', mayoria, fuera: celdas.filter((c) => c.clave !== mayoria).map((c) => c.sucursal) };
}

const ES_PRECIO: ReadonlySet<CampoFicha> = new Set(['precio1', 'precio2', 'precio3']);

/** Compara UN campo entre plazas. `null` = todas las plazas coinciden. */
export function compararCampo(campo: CampoFicha, fichas: FichaPlaza[]): DiferenciaCampoFicha | null {
  const celdas = fichas.map((f) => ({ sucursal: f.sucursal, ...claveYTexto(campo, f) }));
  const r = mayoriaDeClaves(celdas);
  if (r.veredicto === 'igual') return null;

  let diferencia: number | null = null;
  if (ES_PRECIO.has(campo)) {
    const precios = celdas.map((c) => Number(c.clave)).filter((n) => n > 0);
    diferencia = precios.length >= 2 ? Math.round((Math.max(...precios) / Math.min(...precios) - 1) * 10000) / 100 : null;
  }
  const fuera = new Set(r.fuera);
  return {
    campo,
    veredicto: r.veredicto,
    mayoria: r.mayoria === null ? null : (celdas.find((c) => c.clave === r.mayoria)?.texto ?? null),
    sucursales_fuera: r.fuera,
    diferencia_pct: diferencia,
    valores: celdas.map((c) => ({
      sucursal: c.sucursal,
      texto: c.texto,
      fuera: r.veredicto === 'sin_mayoria' ? null : fuera.has(c.sucursal),
    })),
  };
}

/** Arma la fila de un producto: los campos que no coinciden y quién movió el precio al último. */
export function compararFicha(sku: string, fichas: FichaPlaza[], venta30d = 0): FilaFichaSucursales {
  const campos = CAMPOS_FICHA.map(({ campo }) => compararCampo(campo, fichas)).filter(
    (x): x is DiferenciaCampoFicha => x !== null,
  );

  const descripcion = mayoriaDeClaves(fichas.map((f) => ({ sucursal: f.sucursal, clave: txt(f.descripcion) })));
  const nombre = descripcion.mayoria || txt(fichas[0]?.descripcion) || sku;

  const cambios: CambioPrecioPlaza[] = fichas.map((f) => ({ sucursal: f.sucursal, fecha: f.ultimo_cambio || null }));
  const fechas = cambios.filter((c): c is { sucursal: string; fecha: string } => !!c.fecha);
  const ultima = fechas.reduce<string | null>((m, c) => (m === null || c.fecha > m ? c.fecha : m), null);
  const conUltima = fechas.filter((c) => c.fecha === ultima);
  // Si varias plazas cambiaron el mismo día, no hay UNA que lo haya movido al último: no se elige.
  const cambio_mas_reciente = conUltima.length === 1 ? conUltima[0] : null;

  return { sku, nombre, plazas: fichas.length, venta_30d: venta30d, campos, cambios, cambio_mas_reciente };
}

/**
 * Busca por SKU, descripción o código de barras (cualquier plaza). Sin acentos ni mayúsculas, y con
 * varias palabras: TODAS tienen que aparecer, en cualquier orden («oreo fudge» encuentra
 * «GALL OREO DARK FUDGE»).
 */
export function coincideBusqueda(fila: FilaFichaSucursales, fichas: FichaPlaza[], q: string | undefined): boolean {
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const palabras = norm((q ?? '').trim()).split(/\s+/).filter(Boolean);
  if (!palabras.length) return true;
  const codigos = fichas.flatMap((f) => [...(f.cb1 ?? []), ...(f.cb2 ?? []), ...(f.cb3 ?? [])].map((c) => norm(txt(c))));
  const pajar = [norm(fila.sku), norm(fila.nombre), ...fichas.map((f) => norm(txt(f.descripcion))), ...codigos].join(' ');
  return palabras.every((p) => pajar.includes(p));
}

/** Filtros de campo y de plaza (la búsqueda va aparte porque también define el resumen). */
export function pasaFiltros(fila: FilaFichaSucursales, c: Pick<ConsultaFichaSucursales, 'campo' | 'sucursal'>): boolean {
  if (c.campo && !fila.campos.some((x) => x.campo === c.campo)) return false;
  if (c.sucursal && !fila.campos.some((x) => (!c.campo || x.campo === c.campo) && x.sucursales_fuera.includes(c.sucursal!))) {
    return false;
  }
  return true;
}
