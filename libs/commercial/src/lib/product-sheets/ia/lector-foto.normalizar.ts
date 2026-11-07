/**
 * `[NP.7.L.11d]` De lo que respondió el modelo a `LecturaFotoV1`: la frontera donde el JSON de la IA se
 * vuelve dato del contrato. Función PURA (sin red, sin base, sin reloj).
 *
 * Qué hace y por qué:
 *  - **Ausente = `null`** (regla 11). En el cable, un campo ausente llega con evidencia vacía y valor de
 *    relleno ("", 0, []) porque la API no admite más de 16 uniones (ver `lector-foto.schema.ts`); aquí se
 *    convierte en `null`. También los marcadores que el modelo a veces escribe en vez de callar
 *    («n/a», «desconocido», «-», «null»).
 *  - **Un 0 de relleno nunca sobrevive como dato**: contenido, piezas y cantidades deben ser > 0. Sólo la
 *    tabla nutrimental admite 0, porque ahí «0 g» es lo impreso (y lo ausente viaja como `null`).
 *  - **Las listas cerradas se cierran**: sellos y leyendas de NOM-051 fuera de la lista se descartan;
 *    alérgenos fuera de `ALERGENOS` pasan a `alergenos_otros`, tal cual (el diccionario dirá si conviene
 *    cerrarlos). Nada se pierde: el renglón completo sigue en `texto_literal`.
 *  - **Lo estructural no se adivina**: sin `rostro_visible` y `persona_visible` booleanos, sin `legible`, sin
 *    nivel físico de la lista o sin `campos`, la lectura es inválida. ⛔ En particular, `rostro_visible`
 *    desconocido NO se supone `false`: esa foto no puede tratarse como limpia (§10b.3 punto 7; es lo que
 *    bloquea). `persona_visible` es informativo desde el 2026-11-05, pero tampoco se supone: un booleano que
 *    falta dice que el modelo no siguió el esquema, y entonces no se le cree el resto.
 *  - Confianza que no es alta/media/baja → `baja`: la confianza la declara el modelo y nadie la ha medido
 *    (NP.7.L.11b), así que ante la duda se le cree menos, no más.
 */
import {
  ALERGENOS,
  LECTURA_FOTO_VERSION,
  LEYENDAS_NOM051,
  NIVELES_FISICOS,
  SELLOS_NOM051,
  UNIDADES_CONTENIDO,
  type Alergeno,
  type CampoLeido,
  type CamposLeidos,
  type Cantidad,
  type Confianza,
  type Empaque,
  type LecturaFotoV1,
  type LeyendaNom051,
  type NivelFisico,
  type Nutricion,
  type SelloNom051,
  type UnidadContenido,
} from './lectura-foto.contract';

export type ResultadoNormalizar = { ok: true; lectura: LecturaFotoV1 } | { ok: false; error: string };

/** Evidencia que se pone cuando el nivel físico llegó sin ella: dice que falta, no la inventa. */
export const SIN_EVIDENCIA = '(sin evidencia citada)';

type Obj = Record<string, unknown>;
const esObjeto = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// ── Texto ──────────────────────────────────────────────────────────────────────────────────────────

/** Lo que el modelo escribe en vez de dejar vacío. Se comparan en minúsculas y sin espacios a los lados. */
const MARCADORES_VACIO = new Set([
  '', 'n/a', 'na', 'n/d', 'nd', 'n.a.', 'n.d.', 'null', 'none', 'undefined', 'nil', '-', '--', '---', '—', '–', '?',
  'desconocido', 'desconocida', 'no visible', 'no aparece', 'no disponible', 'no legible', 'ilegible', 'ninguno',
  'ninguna', 'sin dato', 'sin datos', 'no aplica',
]);

function texto(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return MARCADORES_VACIO.has(t.toLowerCase()) ? null : t;
}

/** Clave para comparar contra una lista cerrada: sin acentos, mayúsculas, sin signos, espacios simples. */
function clave(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

// ── Números ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Número desde número o texto. «1,250» → 1250 (coma de miles, como se imprime en México); «1 250» → 1250;
 * «0,5» / «12,5» → decimal con coma (no es un grupo de miles); «.5» → 0.5. Negativos y texto con
 * unidades o signos («<1», «120 g») → `null`: ahí no hay un número sin interpretar.
 */
export function numeroDesde(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/\s+/g, ' ');
  let n: number | null = null;
  if (/^[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/.test(t)) n = Number(t.replace(/,/g, ''));
  else if (/^[1-9]\d{0,2}( \d{3})+(\.\d+)?$/.test(t)) n = Number(t.replace(/ /g, ''));
  else if (/^\d+(\.\d+)?$/.test(t)) n = Number(t);
  else if (/^\d+,\d+$/.test(t)) n = Number(t.replace(',', '.'));
  else if (/^\.\d+$/.test(t)) n = Number(`0${t}`);
  return n !== null && Number.isFinite(n) ? n : null;
}

const positivo = (v: unknown): number | null => {
  const n = numeroDesde(v);
  return n !== null && n > 0 ? n : null;
};

// ── Unidades y cantidades ──────────────────────────────────────────────────────────────────────────

const SINONIMOS_UNIDAD: Record<string, UnidadContenido> = {
  g: 'g', gr: 'g', grs: 'g', gramo: 'g', gramos: 'g',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogramo: 'kg', kilogramos: 'kg',
  mg: 'mg', miligramo: 'mg', miligramos: 'mg',
  ml: 'ml', mililitro: 'ml', mililitros: 'ml',
  l: 'l', lt: 'l', lts: 'l', litro: 'l', litros: 'l',
  pzas: 'pzas', pza: 'pzas', pz: 'pzas', pzs: 'pzas', pieza: 'pzas', piezas: 'pzas',
};

function unidad(v: unknown): UnidadContenido | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase().replace(/\.$/, '');
  if ((UNIDADES_CONTENIDO as readonly string[]).includes(t)) return t as UnidadContenido;
  return SINONIMOS_UNIDAD[t] ?? null;
}

/** Una cantidad con unidad de la lista. Cantidad 0 = relleno de «ausente» → `null`. */
function cantidad(v: unknown): Cantidad | null {
  if (!esObjeto(v)) return null;
  const c = positivo(v['cantidad']);
  const u = unidad(v['unidad']);
  return c !== null && u !== null ? { cantidad: c, unidad: u } : null;
}

// ── Listas cerradas ────────────────────────────────────────────────────────────────────────────────

/** «EXCESO DE AZÚCARES» y «EXCESO AZUCARES» son el mismo sello: la clave ignora acentos, signos y el «DE». */
const claveSello = (s: string) => clave(s).replace(/\bDE\b/g, ' ').replace(/\s+/g, ' ').trim();
const SELLOS_POR_CLAVE = new Map<string, SelloNom051>(SELLOS_NOM051.map((s) => [claveSello(s), s]));
const LEYENDAS_POR_CLAVE = new Map<string, LeyendaNom051>(LEYENDAS_NOM051.map((s) => [clave(s), s]));

/** Las formas en que el empaque nombra a un alérgeno de la lista (además del plural simple). */
const SINONIMOS_ALERGENO: Record<string, Alergeno> = {
  MANI: 'cacahuate', CACAHUETE: 'cacahuate', CACAHUATES: 'cacahuate',
  SOJA: 'soya',
  HUEVOS: 'huevo',
  NUEZ: 'nueces', 'NUECES DE ARBOL': 'nueces',
  SESAMO: 'ajonjoli',
  CRUSTACEO: 'crustaceos', MOLUSCO: 'moluscos', SULFITO: 'sulfitos', PESCADOS: 'pescado',
  LACTEOS: 'leche', 'DERIVADOS LACTEOS': 'leche', 'DERIVADOS DE LECHE': 'leche',
};
const ALERGENO_POR_CLAVE = new Map<string, Alergeno>(ALERGENOS.map((a) => [clave(a), a]));

function alergenoDe(s: string): Alergeno | null {
  const k = clave(s);
  const directo = ALERGENO_POR_CLAVE.get(k) ?? SINONIMOS_ALERGENO[k];
  if (directo) return directo;
  // Plural simple: «CACAHUATES» → «CACAHUATE», «AJONJOLÍES» → «AJONJOLI».
  if (k.endsWith('S') && ALERGENO_POR_CLAVE.has(k.slice(0, -1))) return ALERGENO_POR_CLAVE.get(k.slice(0, -1)) ?? null;
  if (k.endsWith('ES') && ALERGENO_POR_CLAVE.has(k.slice(0, -2))) return ALERGENO_POR_CLAVE.get(k.slice(0, -2)) ?? null;
  return null;
}

const textosDeLista = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(texto).filter((t): t is string => t !== null) : [];

/** Lo que está en la lista cerrada, sin repetir; lo demás se descarta. */
function cerrada<T extends string>(v: unknown, porClave: (s: string) => T | null): T[] {
  const dentro: T[] = [];
  for (const t of textosDeLista(v)) {
    const k = porClave(t);
    if (k !== null && !dentro.includes(k)) dentro.push(k);
  }
  return dentro;
}

/** Separa una lista de alérgenos en los de la lista cerrada y los demás (tal cual, sin repetir). */
function separarAlergenos(v: unknown): { cerrados: Alergeno[]; abiertos: string[] } {
  const cerrados: Alergeno[] = [];
  const abiertos: string[] = [];
  for (const t of textosDeLista(v)) {
    const a = alergenoDe(t);
    if (a !== null) {
      if (!cerrados.includes(a)) cerrados.push(a);
    } else if (!abiertos.some((x) => x.toLowerCase() === t.toLowerCase())) {
      abiertos.push(t);
    }
  }
  return { cerrados, abiertos };
}

// ── Campos ─────────────────────────────────────────────────────────────────────────────────────────

const CONFIANZAS: readonly Confianza[] = ['alta', 'media', 'baja'];
function confianza(v: unknown): Confianza {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return (CONFIANZAS as readonly string[]).includes(t) ? (t as Confianza) : 'baja';
}

/** Evidencia y confianza de un campo crudo; `null` si no trae evidencia (= ausente en el cable). */
function cabecera(raw: unknown): { evidencia: string; confianza: Confianza; valor: unknown } | null {
  if (!esObjeto(raw)) return null;
  const evidencia = texto(raw['evidencia']);
  if (evidencia === null) return null;
  return { evidencia, confianza: confianza(raw['confianza']), valor: raw['valor'] };
}

/** Un campo genérico: sin evidencia o sin valor válido, `null`. */
function campo<T>(raw: unknown, valor: (v: unknown) => T | null): CampoLeido<T> | null {
  const c = cabecera(raw);
  if (c === null) return null;
  const v = valor(c.valor);
  return v === null ? null : { valor: v, confianza: c.confianza, evidencia: c.evidencia };
}

/** El código impreso, sin espacios ni guiones («7 500443 006889» → «7500443006889»); la evidencia queda tal cual. */
function codigo(v: unknown): string | null {
  const t = texto(v);
  if (t === null) return null;
  const limpio = t.replace(/[\s-]+/g, '').toUpperCase();
  return /^[0-9A-Z]+$/.test(limpio) && /\d/.test(limpio) ? limpio : null;
}

function piezas(v: unknown): number | null {
  const n = positivo(v);
  return n !== null && Number.isInteger(n) ? n : null;
}

const listaNoVacia = <T>(xs: T[]): T[] | null => (xs.length ? xs : null);

const RENGLONES_NUTRICION = [
  'kcal', 'proteinas_g', 'grasas_totales_g', 'grasas_saturadas_g', 'grasas_trans_mg', 'carbohidratos_g',
  'azucares_g', 'azucares_anadidos_g', 'fibra_g', 'sodio_mg',
] as const satisfies ReadonlyArray<Exclude<keyof Nutricion, 'base'>>;

/** La tabla: sin base válida no se sabe a qué se refieren los números → `null`; sin ningún renglón, también. */
function nutricion(v: unknown): Nutricion | null {
  if (!esObjeto(v)) return null;
  const base = cantidad(v['base']);
  if (base === null) return null;
  const n = { base } as Nutricion;
  let alguno = false;
  for (const r of RENGLONES_NUTRICION) {
    n[r] = numeroDesde(v[r]);
    if (n[r] !== null) alguno = true;
  }
  return alguno ? n : null;
}

function empaque(v: unknown): Empaque | null {
  if (!esObjeto(v)) return null;
  const colores: string[] = [];
  for (const c of textosDeLista(v['colores'])) if (!colores.some((x) => x.toLowerCase() === c.toLowerCase())) colores.push(c);
  const e: Empaque = { tipo: texto(v['tipo']), material: texto(v['material']), colores };
  return e.tipo === null && e.material === null && !colores.length ? null : e;
}

/**
 * Alérgenos: lo de la lista cerrada va a `alergenos` y lo demás a `alergenos_otros`, venga del campo que
 * venga (el modelo a veces pone «leche» en otros, o «avellana» en alérgenos). La evidencia viaja con el
 * valor: si el renglón «Contiene: leche, avellana» respalda a los dos, respalda a los dos campos.
 */
function alergenos(rawAlergenos: unknown, rawOtros: unknown): Pick<CamposLeidos, 'alergenos' | 'alergenos_otros'> {
  const a = cabecera(rawAlergenos);
  const o = cabecera(rawOtros);
  const sepA = a ? separarAlergenos(a.valor) : { cerrados: [], abiertos: [] };
  const sepO = o ? separarAlergenos(o.valor) : { cerrados: [], abiertos: [] };

  const cerrados = [...sepA.cerrados];
  for (const x of sepO.cerrados) if (!cerrados.includes(x)) cerrados.push(x);
  const abiertos = [...sepO.abiertos];
  for (const x of sepA.abiertos) if (!abiertos.some((y) => y.toLowerCase() === x.toLowerCase())) abiertos.push(x);

  const fuenteA = sepA.cerrados.length ? a : sepO.cerrados.length ? o : null;
  const fuenteO = sepO.abiertos.length ? o : sepA.abiertos.length ? a : null;
  return {
    alergenos: fuenteA && cerrados.length ? { valor: cerrados, confianza: fuenteA.confianza, evidencia: fuenteA.evidencia } : null,
    alergenos_otros: fuenteO && abiertos.length ? { valor: abiertos, confianza: fuenteO.confianza, evidencia: fuenteO.evidencia } : null,
  };
}

function normalizarCampos(c: Obj, nivel: NivelFisico): CamposLeidos {
  const campos: CamposLeidos = {
    marca: campo(c['marca'], texto),
    denominacion: campo(c['denominacion'], texto),
    nombre_comercial: campo(c['nombre_comercial'], texto),
    variante: campo(c['variante'], texto),
    edicion: campo(c['edicion'], texto),
    fabricante: campo(c['fabricante'], texto),
    contenido_neto: campo(c['contenido_neto'], cantidad),
    piezas: campo(c['piezas'], piezas),
    contenido_por_pieza: campo(c['contenido_por_pieza'], cantidad),
    sellos_nom051: campo(c['sellos_nom051'], (v) => listaNoVacia(cerrada(v, (s) => SELLOS_POR_CLAVE.get(claveSello(s)) ?? null))),
    leyendas_nom051: campo(c['leyendas_nom051'], (v) => listaNoVacia(cerrada(v, (s) => LEYENDAS_POR_CLAVE.get(clave(s)) ?? null))),
    ...alergenos(c['alergenos'], c['alergenos_otros']),
    // «Puede contener» fuera de la lista se descarta: el contrato lo cierra y el renglón sigue en texto_literal.
    puede_contener: campo(c['puede_contener'], (v) => listaNoVacia(separarAlergenos(v).cerrados)),
    ingredientes: campo(c['ingredientes'], texto),
    nutricion: campo(c['nutricion'], nutricion),
    codigo_barras_visible: campo(c['codigo_barras_visible'], codigo),
    pais_origen: campo(c['pais_origen'], texto),
    conservacion: campo(c['conservacion'], texto),
    empaque: campo(c['empaque'], empaque),
  };
  // §10b.7 punto 6: lo empacado en tienda no es empaque del fabricante: no se le leen sellos ni código.
  if (nivel === 'empacado_en_tienda') {
    campos.sellos_nom051 = null;
    campos.leyendas_nom051 = null;
    campos.codigo_barras_visible = null;
  }
  return campos;
}

// ── La lectura ─────────────────────────────────────────────────────────────────────────────────────

/** Los renglones TAL CUAL: sólo se quitan los vacíos (aquí «N/D» o «-» pueden ser texto impreso). */
function renglones(v: unknown[]): string[] {
  return v.map((r) => (typeof r === 'string' ? r.trim() : typeof r === 'number' ? String(r) : '')).filter((r) => r !== '');
}

function booleano(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

function legible(v: unknown): LecturaFotoV1['legible'] | null {
  if (typeof v !== 'string') return null;
  const k = clave(v).toLowerCase();
  return k === 'si' || k === 'parcial' || k === 'no' ? k : null;
}

function nivelFisico(raw: unknown): CampoLeido<NivelFisico> | null {
  if (!esObjeto(raw) || typeof raw['valor'] !== 'string') return null;
  const v = raw['valor'].trim().toLowerCase();
  if (!(NIVELES_FISICOS as readonly string[]).includes(v)) return null;
  const evidencia = texto(raw['evidencia']);
  // Sin evidencia el nivel no se tira (el resto de la lectura sirve), pero tampoco se le cree.
  return evidencia === null
    ? { valor: v as NivelFisico, confianza: 'baja', evidencia: SIN_EVIDENCIA }
    : { valor: v as NivelFisico, confianza: confianza(raw['confianza']), evidencia };
}

export function normalizarLectura(raw: unknown): ResultadoNormalizar {
  if (!esObjeto(raw)) return { ok: false, error: 'la respuesta no es un objeto JSON' };
  if (raw['version'] !== undefined && raw['version'] !== LECTURA_FOTO_VERSION) {
    return { ok: false, error: `versión desconocida: ${String(raw['version']).slice(0, 40)}` };
  }
  const rostro = booleano(raw['rostro_visible']);
  if (rostro === null) return { ok: false, error: 'rostro_visible no es booleano (no se supone false)' };
  const persona = booleano(raw['persona_visible']);
  if (persona === null) return { ok: false, error: 'persona_visible no es booleano (no se supone false)' };
  const leg = legible(raw['legible']);
  if (leg === null) return { ok: false, error: 'legible no es si/parcial/no' };
  if (!Array.isArray(raw['texto_literal'])) return { ok: false, error: 'falta texto_literal' };
  const nivel = nivelFisico(raw['nivel_fisico']);
  if (nivel === null) return { ok: false, error: 'nivel_fisico fuera de la lista cerrada' };
  if (!esObjeto(raw['campos'])) return { ok: false, error: 'falta campos' };

  return {
    ok: true,
    lectura: {
      version: LECTURA_FOTO_VERSION,
      nivel_fisico: nivel,
      persona_visible: persona,
      rostro_visible: rostro,
      legible: leg,
      motivo_no_legible: leg === 'si' ? null : texto(raw['motivo_no_legible']),
      texto_literal: renglones(raw['texto_literal'] as unknown[]),
      campos: normalizarCampos(raw['campos'] as Obj, nivel.valor),
    },
  };
}
