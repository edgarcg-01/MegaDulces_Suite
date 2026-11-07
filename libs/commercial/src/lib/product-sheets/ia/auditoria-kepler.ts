/**
 * `[NP.7.L.11d]` / `[NP.7.L.9b]` **Auditoría de la ficha contra Kepler**: lo que la IA leyó en las caras
 * (la `PropuestaAmpliada`) contra la fila de `kepler_ods.kdii` del SKU → hallazgos, una descripción
 * propuesta armada SÓLO con lo leído y la lista de información que Kepler no guarda.
 *
 * ⛔ La Suite no escribe en Kepler: todo hallazgo va a «Por revisar» (y después a Incidencias, L.3c).
 * ⛔ Testigo independiente (ADR-059): el lector nunca vio la descripción de Kepler; si la hubiera visto,
 *    esta auditoría compararía a Kepler consigo mismo.
 * ⛔ **No se adivina** (regla 10): un hallazgo sale SÓLO cuando los dos lados se pudieron interpretar y
 *    difieren. Lo que no se interpreta (un nombre sin gramaje, un factor no capturado) no produce
 *    hallazgo: produce silencio, y el silencio no se lee como «cuadra».
 *
 * Función pura. Quien la llama pasa la fila de `kdii` de la sucursal donde se capturó (§10b.3 punto 4e)
 * y el peldaño principal (`peldanoPrincipal`, `levantamiento.rules.ts`).
 *
 * ⚠️ `foto_no_legible` no sale de `auditarContraKepler`: la propuesta fusionada no trae `legible`. Sale de
 * `hallazgosDeLegibilidad` (aquí abajo), que el worker llama con las lecturas por cara y suma a la auditoría.
 *
 * Privacidad (§10b.3 punto 7; Francisco, 2026-11-05, por confirmar por Edgar y legal en D6): sólo
 * `rostro_visible` produce hallazgo. `persona_visible` (una mano, una pierna, un zapato) es informativo y NO.
 */
import type { Peldano } from '../../shared/kdii-codigo';
import { normalizarBusqueda } from '../../commercial-products/catalogo-busqueda';
import { normalizarClave } from './diccionario';
import { aUnidadBase, mismoNumero } from './fusion-lecturas';
import type {
  AuditoriaKepler, CampoPropuesto, Cantidad, HallazgoAuditoria, LecturaFotoV1, NivelFisico, NombreCampo, PropuestaAmpliada,
} from './lectura-foto.contract';

/** Lo que se necesita de la ficha de Kepler (`filaKdii`: `nombre` = `c2`, `f2` = `c81`, `f3` = `c84`). */
export interface FichaKeplerAuditada {
  nombre: string | null;
  principal: Peldano;
  u1: string | null;
  u2: string | null;
  f2: number | null;
  u3: string | null;
  f3: number | null;
}

// ── ¿Está la palabra en la descripción? ───────────────────────────────────────────────────────────

/**
 * Palabras de enlace que Kepler casi nunca escribe («Sabor Fresa» → `FRESA`, «Chocolate con leche» →
 * `CHOC C/LECHE`). `sin` NO está: «sin azúcar» cambia el producto.
 */
const PALABRAS_DE_ENLACE = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'con', 'en', 'a', 'al', 'sabor']);

function palabras(texto: string): string[] {
  return normalizarBusqueda(texto).split(/[^a-z0-9]+/).filter(Boolean);
}

/** El posesivo del empaque fuera: «HERSHEY'S» → «HERSHEY», «M&M'S» → «M&M» (ver `apareceEnNombre`). */
function sinPosesivo(texto: string | null | undefined): string {
  return String(texto ?? '').replace(/['’´`]s\b/gi, '');
}

/**
 * ¿Lo leído en la foto aparece en el nombre de Kepler? Tolerante a propósito, porque `c2` está
 * abreviado y sin acentos:
 *  1. sin acentos, mayúsculas, signos ni espacios, como subcadena («BON O BON» empata con `BONOBON`);
 *  2. palabra por palabra: cada palabra leída (salvo las de enlace) está en el nombre, o un token del
 *     nombre de ≥ 4 letras es prefijo de ella (`CHOC` por «chocolate», `FRES` por «fresa»).
 *
 * El posesivo del empaque se quita antes de comparar: «HERSHEY'S» → «HERSHEY», «M&M'S» → «M&M». Kepler lo
 * escribe sin él (`CHOC HERSHEY BARRA GRANEL 14KG`, VERDAD_ABSOLUTA.md), y la «s» suelta que dejaba el
 * apóstrofo no aparecía en el nombre: hallazgo falso con Hershey's, M&M's, Kellogg's o Lay's.
 *
 * ⚠️ Límites conocidos, NO MEDIDOS contra los nombres reales de `kdii` (revisión del 2026-11-05): una abreviatura
 * de menos de 4 letras (`PAL` por «Paleta») no empata, ni una palabra pegada combinada con una abreviatura
 * (`BONOBON CHOC` contra «Bon o Bon Chocolate»). Los dos dan hallazgo (de más, nunca de menos); la prueba
 * «límites declarados» los fija para que quien los resuelva lo haga a propósito.
 */
export function apareceEnNombre(leidoConPosesivo: string, nombreKepler: string): boolean {
  const leido = sinPosesivo(leidoConPosesivo);
  const claveLeido = normalizarClave(leido);
  if (!claveLeido) return true; // nada que buscar: no es hallazgo
  if (normalizarClave(nombreKepler).includes(claveLeido)) return true;
  const tokens = palabras(nombreKepler);
  const buscadas = palabras(leido).filter((p) => !PALABRAS_DE_ENLACE.has(p));
  if (!buscadas.length) return false;
  return buscadas.every((p) => tokens.some((t) => t === p || (t.length >= 4 && /^[a-z]+$/.test(t) && p.startsWith(t))));
}

// ── Sabores surtidos ──────────────────────────────────────────────────────────────────────────────

/** Lo que cuenta como letra de una palabra (con acentos): «surtido» se busca como palabra completa. */
const LETRA = 'a-z0-9áéíóúüñ';
/** «surtido», «surtida», «surtidos», «surtidas» como palabra, en CUALQUIER lugar («Sabores surtidos»). */
const RE_SURTIDO = new RegExp(`(?<![${LETRA}])surtid[oa]s?(?![${LETRA}])`, 'i');
const RE_SURTIDO_TODOS = new RegExp(RE_SURTIDO.source, 'gi');
/** «sabor», «sabores», «de sabores»: describen el surtido, no son un sabor. */
const RE_PALABRA_SABOR = new RegExp(`(?<![${LETRA}])(?:de\\s+)?sabor(?:es)?(?![${LETRA}])`, 'gi');

/**
 * Si la variante es una LISTA de sabores (un surtido), los sabores sueltos; si es un sabor, `null`. Es lista:
 *  - si dice «surtido» (surtida/surtidos/surtidas) como palabra, en cualquier lugar: «Surtido Cola, Naranja,
 *    Limón» → `[Cola, Naranja, Limón]`; «Sabores surtidos», «Surtido de sabores» o «Surtido» solo → `[]` (un
 *    surtido que no nombra sus sabores: «sabores» no es un sabor);
 *  - o, sin esa palabra, si trae comas y TRES o más sabores: «Cola, Naranja, Limón», «fresa, uva y piña».
 *
 * ⛔ «A y B» (o «A, B») sin «surtido» NO es lista: es un sabor combinado de UN SKU («Avellana y Fresa», «Chile y
 * Limón»). ❌ Antes « y » bastaba: la auditoría callaba si Kepler nombraba sólo uno de los dos, y la descripción
 * cambiaba los dos por SURTIDO, que es justo el dato que separa dos SKUs (revisión del 2026-11-05).
 * «Mix» en la variante tampoco la vuelve surtido: «Sweet Mix» es un nombre, y SURTIDO lo borraría.
 */
export function saboresDeVariante(variante: string | null | undefined): string[] | null {
  const t = String(variante ?? '').trim();
  if (!t) return null;
  const partir = (s: string): string[] => s
    .replace(RE_PALABRA_SABOR, ' ').replace(/\s+/g, ' ')
    .replace(/^[\s:,.;-]*(?:(?:de|del)\s+)?/i, '').replace(/[\s:,.;-]+$/, '')
    .split(/\s*,\s*|\s+y\s+/i).map((s) => s.trim()).filter(Boolean);
  if (RE_SURTIDO.test(t)) return partir(t.replace(RE_SURTIDO_TODOS, ' '));
  if (!t.includes(',')) return null;
  const sabores = partir(t);
  return sabores.length >= 3 ? sabores : null;
}

/** ¿El nombre de Kepler dice que es surtido? `SURTIDO`, `SURT`, `SURTIDA`… o `MIX`, como palabra. */
function nombreDiceSurtido(nombreKepler: string): boolean {
  return palabras(nombreKepler).some((t) => t.startsWith('surt') || t === 'mix');
}

// ── El contenido escrito en el nombre ─────────────────────────────────────────────────────────────

/** Unidades de peso/volumen como las escribe Kepler, de la más larga a la más corta (la regex prueba en orden). */
const UNIDADES_NOMBRE = 'KGS|KG|GRS|GRM|GR|GMS|GM|MG|ML|LTS|LT|G|L';
const UNIDAD_DE: Record<string, Cantidad['unidad']> = {
  KGS: 'kg', KG: 'kg', GRS: 'g', GRM: 'g', GR: 'g', GMS: 'g', GM: 'g', G: 'g', MG: 'mg', ML: 'ml', LTS: 'l', LT: 'l', L: 'l',
};
const NUM = '(\\d+(?:[.,]\\d+)?)';
/** «8/15G» (8 piezas de 15 g) y «12X25G». */
const RE_PIEZAS = new RegExp(`(?<![A-Z0-9.,/])(\\d+)\\s*([/X])\\s*${NUM}\\s*(${UNIDADES_NOMBRE})(?![A-Z])`, 'g');
/** «120G», «120 GR», «1KG», «500ML», «1.5L». */
const RE_SIMPLE = new RegExp(`(?<![A-Z0-9.,/])${NUM}\\s*(${UNIDADES_NOMBRE})(?![A-Z])`, 'g');
/** «10GR X 20»: ¿20 piezas de 10 g, o 10 g y otra cosa? No se interpreta. */
const RE_UNIDAD_POR = new RegExp(`(?<![A-Z0-9.,/])${NUM}\\s*(${UNIDADES_NOMBRE})\\s*X\\s*\\d`);
/** «25PZ 10G»: el gramaje puede ser de cada pieza o del total. No se interpreta un gramaje suelto con esto. */
const RE_CONTEO = /(?<![A-Z0-9])\d+\s*(PZAS|PZA|PZS|PZ|PIEZAS|PIEZA)(?![A-Z])/;
/**
 * `[NP.7.L.17]` El conteo como lo escribe Kepler: «/ 8», «/50P», «12P», «10P». Medido el 2026-11-04 en el
 * universo de Padre Hidalgo: 1,069 de 4,230 nombres (25 %) traen gramaje Y este conteo. Tres jueces leyeron 88
 * nombres reales: casi siempre el gramaje es el TOTAL de la Base («BUBBALO 357 GR / 70» = la bolsa de 357 g),
 * pero con Base PAQ a veces es de CADA pieza («LA ROSA JAPONES TUBO 60G 12P» = 12 tubos de 60 g). El nombre
 * no dice cuál: por eso el conteo NO cambia la lectura, sólo agrega la hipótesis «gramaje × conteo» en la
 * auditoría (`auditarContenido`). La diagonal antes de una unidad («/ 15 KG») no es conteo; un punto final
 * («/ 25.») sí lo deja pasar.
 */
const RE_CONTEO_KEPLER = /(?:\/\s*(\d+)(?!\d|[.,]\d)(?!\s*(?:KGS|KG|K|GRS|GRM|GRAMOS|GR|GMS|GM|G|MG|ML|LTS|LT|L)(?![A-Z]))\s*P?(?![A-Z0-9]))|(?:(?<![A-Z0-9.,/])(\d+)(?!\d|[.,]\d)\s*P(?![A-Z0-9]))/;

export interface ContenidoDelNombre {
  /** Total en unidad base (g o ml). */
  total: { cantidad: number; unidad: string };
  piezas: number | null;
  /** Contenido de cada pieza en unidad base, si el nombre dice «N/M» o «NxM». */
  por_pieza: { cantidad: number; unidad: string } | null;
  /** El pedazo del nombre que se interpretó («8/15G»), para la evidencia del hallazgo. */
  texto: string;
  /**
   * `[NP.7.L.17]` Conteo al estilo Kepler que acompaña a un gramaje suelto («/ 8», «12P»), si lo hay y es > 1.
   * NO cambia `total`: sólo habilita la hipótesis «gramaje × conteo» al comparar con la foto (ver `RE_CONTEO_KEPLER`).
   */
  conteo: number | null;
}

const num = (s: string): number => Number(s.replace(',', '.'));

/**
 * Interpreta el contenido escrito en el nombre de Kepler. Devuelve `null` (no se interpreta, no se
 * adivina) si no hay gramaje, si hay dos que no cuadran entre sí, o si la forma es ambigua:
 *  - «1/2KG» puede ser medio kilo o «1 pieza de 2 kg»: «N/M» con kg o l no se interpreta;
 *  - «10GR X 20» (¿el gramaje es de cada pieza?) no se interpreta;
 *  - un gramaje suelto junto a un conteo («25PZ 10G») no se interpreta: puede ser de cada pieza.
 * Las formas que SÍ: «120G», «120 GR», «1KG», «500ML», «8/15G» (8 piezas de 15 g), «12X25G».
 */
export function contenidoDelNombre(nombre: string | null | undefined): ContenidoDelNombre | null {
  if (!nombre) return null;
  const n = normalizarBusqueda(nombre).toUpperCase();
  if (RE_UNIDAD_POR.test(n)) return null;
  const hallados: ContenidoDelNombre[] = [];
  const ocupado: Array<[number, number]> = [];
  for (const m of n.matchAll(RE_PIEZAS)) {
    const unidad = UNIDAD_DE[m[4]];
    ocupado.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    if (m[2] === '/' && (unidad === 'kg' || unidad === 'l')) return null; // fracción ambigua
    const piezas = Number(m[1]);
    const porPieza = aUnidadBase({ cantidad: num(m[3]), unidad });
    if (!(piezas > 0) || !(porPieza.cantidad > 0)) continue;
    hallados.push({ total: { cantidad: piezas * porPieza.cantidad, unidad: porPieza.unidad }, piezas, por_pieza: porPieza, texto: m[0].trim(), conteo: null });
  }
  for (const m of n.matchAll(RE_SIMPLE)) {
    const ini = m.index ?? 0;
    if (ocupado.some(([a, b]) => ini >= a && ini < b)) continue; // ya es parte de un «N/M»
    const total = aUnidadBase({ cantidad: num(m[1]), unidad: UNIDAD_DE[m[2]] });
    if (!(total.cantidad > 0)) continue;
    hallados.push({ total, piezas: null, por_pieza: null, texto: m[0].trim(), conteo: null });
  }
  if (!hallados.length) return null;
  if (!hallados.some((h) => h.piezas != null) && RE_CONTEO.test(n)) return null;
  const [primero] = hallados;
  const cuadran = hallados.every((h) => h.total.unidad === primero.total.unidad && mismoNumero(h.total.cantidad, primero.total.cantidad));
  if (!cuadran) return null; // dos gramajes distintos en el nombre: no se elige uno
  const conPiezas = hallados.find((h) => h.piezas != null);
  if (conPiezas) return conPiezas;
  const m = RE_CONTEO_KEPLER.exec(n);
  const conteo = m ? Number(m[1] ?? m[2]) : null;
  return { ...primero, conteo: conteo != null && conteo > 1 ? conteo : null };
}

// ── Nivel físico contra peldaño (L.9b, §10b.7 punto 5) ────────────────────────────────────────────

/**
 * Qué nivel físico puede ser cada peldaño.
 *
 * ⚠️ Desviación declarada del encargo: el encargo decía «base = pieza / empacado en tienda / granel».
 * Aquí la Base también admite **empaque interior**, porque el plan pone como ejemplo de Base justo
 * eso: el 95805 es «la caja de 8 (si la Base es la caja)» (§10b.7 punto 1; maqueta B0 «Kepler: CJA ·
 * factor 1 (Base)»), y el rótulo `CJA` «a veces» es empaque interior (tabla del punto 5). Sin esto, la
 * ficha de ejemplo del plan saldría con un hallazgo falso. Lo que el plan sí exige se mantiene: un
 * **corrugado (caja exterior) con el código de la Base es hallazgo**. `otro` no es compatible con
 * ningún peldaño (es «empaque sin unidad en Kepler», va a revisión).
 */
export const NIVELES_COMPATIBLES: Record<Peldano, readonly NivelFisico[]> = {
  base: ['pieza', 'empaque_interior', 'empacado_en_tienda', 'granel'],
  dos: ['empaque_interior', 'caja_exterior'],
  tres: ['caja_exterior'],
};

const ETIQUETA_PELDANO: Record<Peldano, string> = { base: 'Base', dos: 'Unidad Dos', tres: 'Unidad Tres' };

// ── Descripción propuesta ─────────────────────────────────────────────────────────────────────────

/** Al estilo de `c2`: mayúsculas, sin acentos (ñ→n: la convención de Kepler para la ñ no está medida). */
function estiloKepler(texto: string): string {
  // La Ñ se CONSERVA: medido el 2026-11-04 en los 4,230 nombres del universo de Padre Hidalgo, 190 la usan
  // («ALTEÑO», «GARAPIÑADO») y sólo 1 la escribe como N. ❌ Antes se volvía N («ALTENO»), y la descripción
  // propuesta habría marcado como diferencia algo que Kepler escribe bien. Los demás acentos sí se quitan.
  // La marca es un carácter de uso privado (U+E000): la normalización (NFD + quitar diacríticos) no lo toca y no
  // es un carácter de control (`no-control-regex`).
  const conEnie = String(texto ?? '').replace(/[ñÑ]/g, '');
  return normalizarBusqueda(conEnie).toUpperCase().replace(//g, 'Ñ').replace(/\s+/g, ' ').trim();
}

function numeroCorto(x: number): string {
  return String(Math.round(x * 1000) / 1000);
}

function cantidadKepler(c: Cantidad): string {
  return `${numeroCorto(Number(c.cantidad))}${String(c.unidad).toUpperCase()}`;
}

const ES_PESO_O_VOLUMEN = (c: Cantidad | null | undefined): c is Cantidad => !!c && c.unidad !== 'pzas';

/**
 * MARCA + NOMBRE COMERCIAL (o DENOMINACIÓN) + VARIANTE + EDICIÓN + contenido, sólo con lo leído.
 * `null` si no hay marca ni denominación (no hay con qué nombrar el producto).
 *
 * Sabores compactos: si la variante es una lista (`saboresDeVariante`), va `SURTIDO` en vez de la lista
 * («Surtido Cola, Naranja, Limón» → `TINAJITA XPLOSODA SURTIDO 160G`). Los sabores siguen en la propuesta.
 * Un sabor combinado («Avellana y Fresa») NO es lista y va tal cual: es lo que distingue a ese SKU.
 *
 * ⚠️ No se trunca ni se abrevia. El largo máximo de `c2` en Kepler **NO está medido**: si pasa de 40
 * caracteres (la «EDICION ESPECIAL» del 95805 ya lo roza), es un dato a medir antes de proponer
 * abreviaturas, no algo que se resuelva cortando aquí.
 */
export function descripcionPropuesta(p: PropuestaAmpliada): string | null {
  const c = p.campos;
  const marca = c.marca?.valor ?? null;
  const denominacion = c.denominacion?.valor ?? null;
  if (!marca && !denominacion) return null;
  const partes: string[] = [];
  const vistos = new Set<string>();
  const poner = (t: string | null | undefined) => {
    if (!t) return;
    const k = normalizarClave(t);
    if (!k || vistos.has(k)) return; // «bon o bon» como marca y nombre comercial va una vez
    vistos.add(k);
    partes.push(estiloKepler(t));
  };
  poner(marca);
  poner(c.nombre_comercial?.valor ?? denominacion);
  const variante = c.variante?.valor;
  poner(variante != null && saboresDeVariante(variante) ? 'SURTIDO' : variante);
  poner(c.edicion?.valor);
  const piezas = c.piezas?.valor;
  const porPieza = c.contenido_por_pieza?.valor;
  const neto = c.contenido_neto?.valor;
  if (piezas != null && piezas > 0 && ES_PESO_O_VOLUMEN(porPieza)) partes.push(`${numeroCorto(piezas)}/${cantidadKepler(porPieza)}`);
  else if (neto) partes.push(cantidadKepler(neto));
  return partes.join(' ');
}

// ── Información nueva ─────────────────────────────────────────────────────────────────────────────

/** Lo que el empaque trae y `kdii` no guarda. */
export const CAMPOS_FUERA_DE_KEPLER: readonly NombreCampo[] = [
  'fabricante', 'sellos_nom051', 'leyendas_nom051', 'alergenos', 'puede_contener', 'alergenos_otros',
  'ingredientes', 'nutricion', 'pais_origen', 'conservacion', 'empaque',
];

/** Presente = leído y, si es lista, con algo: una lista vacía es «no trae», no información nueva. */
function presente(campo: CampoPropuesto<unknown> | null): boolean {
  if (!campo) return false;
  return Array.isArray(campo.valor) ? campo.valor.length > 0 : campo.valor != null;
}

// ── La auditoría ──────────────────────────────────────────────────────────────────────────────────

function textoValor(v: unknown): string {
  if (v == null) return 'nada';
  if (typeof v === 'object' && !Array.isArray(v) && 'cantidad' in (v as Cantidad)) return cantidadKepler(v as Cantidad);
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function deFoto(campo: CampoPropuesto<unknown>): string {
  return `${textoValor(campo.valor)} («${campo.evidencia}», ${campo.de_cara})`;
}

/**
 * Contenido de la foto en unidad base: el neto si es de peso o volumen; si no, piezas × contenido por pieza.
 * Un neto en piezas («Contenido: 50 piezas», regla 5 del prompt; lo normal en exhibidores) no es un total que se
 * compare con gramos: ❌ antes se devolvía igual y escondía el piezas × gramaje que sí estaba leído.
 */
function contenidoDeFoto(p: PropuestaAmpliada): { total: { cantidad: number; unidad: string }; texto: string } | null {
  const c = p.campos;
  if (c.contenido_neto && ES_PESO_O_VOLUMEN(c.contenido_neto.valor)) return { total: aUnidadBase(c.contenido_neto.valor), texto: deFoto(c.contenido_neto) };
  const piezas = c.piezas?.valor;
  const porPieza = c.contenido_por_pieza?.valor;
  if (piezas != null && piezas > 0 && ES_PESO_O_VOLUMEN(porPieza)) {
    const b = aUnidadBase(porPieza);
    return { total: { cantidad: piezas * b.cantidad, unidad: b.unidad }, texto: `${piezas} × ${cantidadKepler(porPieza)} («${c.contenido_por_pieza?.evidencia}»)` };
  }
  return null;
}

/** Factor (respecto de la Base) de un peldaño, sólo si Kepler lo capturó (> 1). `c84` en 0/1 = «no capturado». */
function factorCapturado(k: FichaKeplerAuditada, peldano: Peldano): number | null {
  if (peldano === 'base') return 1;
  const f = peldano === 'dos' ? k.f2 : k.f3;
  return f != null && Number(f) > 1 ? Number(f) : null;
}

/**
 * ¿El contenido de la foto contradice al nombre? Hallazgo SÓLO si los dos lados se interpretaron, son
 * de la misma magnitud (g con g, ml con ml; g contra ml también es hallazgo) y no cuadran con ningún
 * peldaño conocido de la escalera.
 *
 * Por qué la escalera: el nombre no siempre describe la Base. `91059 TURIN 16KG` tiene Base 500 g y el
 * nombre describe el bulto de 32 × 500 g (ERP_KEPLER §2.1). Así que la foto cuadra si
 * `nombre / factor_r = foto / factor_foto` para algún peldaño r con factor capturado. Si el peldaño
 * fotografiado no tiene factor capturado y no es la Base, no se puede relacionar: no hay hallazgo.
 */
function auditarContenido(p: PropuestaAmpliada, k: FichaKeplerAuditada): HallazgoAuditoria | null {
  const nombre = contenidoDelNombre(k.nombre);
  const foto = contenidoDeFoto(p);
  if (!nombre || !foto) return null;
  const { total: kt } = nombre;
  const ft = foto.total;
  const pesoOVol = (u: string) => u === 'g' || u === 'ml';
  if (!pesoOVol(kt.unidad) || !pesoOVol(ft.unidad)) return null; // un neto «8 pzas» no se compara con gramos
  const hallazgo = (explicacion: string): HallazgoAuditoria => ({
    tipo: 'contenido_distinto', kepler: `${k.nombre} → ${nombre.texto}`, foto: foto.texto, explicacion,
  });
  if (kt.unidad !== ft.unidad) {
    return hallazgo(`El nombre dice ${kt.unidad === 'g' ? 'peso' : 'volumen'} y el empaque ${ft.unidad === 'g' ? 'peso' : 'volumen'}.`);
  }
  const fFoto = factorCapturado(k, k.principal);
  if (fFoto == null) return null;
  const escalera = [1, k.f2, k.f3].filter((f): f is number => f != null && Number(f) >= 1).map(Number);
  const mismoPeldano = mismoNumero(kt.cantidad, ft.cantidad);
  const cuadraCon = (total: number) => escalera.some((fr) => mismoNumero(total * fFoto, ft.cantidad * fr));
  // [NP.7.L.17] «60G 12P» / «50G /20»: el nombre no dice si el gramaje es el total o de cada pieza (medido
  // con 88 nombres reales, ver RE_CONTEO_KEPLER). Se aceptan las DOS lecturas; hay hallazgo sólo si la foto
  // no cuadra con ninguna. No se adivina cuál es: se descarta la contradicción que no existe.
  const cuadra = cuadraCon(kt.cantidad) || (nombre.conteo != null && cuadraCon(kt.cantidad * nombre.conteo));
  if (!cuadra) {
    return hallazgo(
      `El nombre dice ${numeroCorto(kt.cantidad)} ${kt.unidad} y el empaque de la ${ETIQUETA_PELDANO[k.principal]} ${numeroCorto(ft.cantidad)} ${ft.unidad}, `
      + 'y no cuadra con ningún factor de la escalera'
      + (nombre.conteo != null ? ` (tampoco leyendo el gramaje como de cada una de sus ${nombre.conteo} piezas).` : '.'),
    );
  }
  // Mismo total y mismo peldaño: si el nombre dice «N/M», las piezas también tienen que cuadrar.
  const piezasFoto = p.campos.piezas?.valor;
  const porPiezaFoto = p.campos.contenido_por_pieza?.valor;
  if (mismoPeldano && nombre.piezas != null && nombre.por_pieza && piezasFoto != null && ES_PESO_O_VOLUMEN(porPiezaFoto)) {
    const b = aUnidadBase(porPiezaFoto);
    if (!mismoNumero(nombre.piezas, piezasFoto) || b.unidad !== nombre.por_pieza.unidad || !mismoNumero(b.cantidad, nombre.por_pieza.cantidad)) {
      return hallazgo(`Mismo total, distinta presentación: el nombre dice ${nombre.texto} y el empaque ${piezasFoto} de ${cantidadKepler(porPiezaFoto)}.`);
    }
  }
  return null;
}

/**
 * Piezas contra el factor del peldaño (sólo Dos y Tres). ⛔ Factor null o 1 = «Kepler no lo capturó»
 * (7,247 SKUs con `c84` en 0/1, §10b.3 punto 4d): NO es hallazgo de piezas distintas.
 *
 * Una leyenda «24 × 8» se puede leer como 24 (cajas) o como 192 (piezas), y el factor de la Tres en
 * Kepler va contra la Base (Trident: Dos 12, Tres 384). Cuadra con cualquiera de esas lecturas; el
 * hallazgo sale sólo si ninguna cuadra.
 */
function auditarPiezas(p: PropuestaAmpliada, k: FichaKeplerAuditada, nivelCompatible: boolean): HallazgoAuditoria | null {
  if (k.principal === 'base' || !nivelCompatible) return null;
  const factor = factorCapturado(k, k.principal);
  const piezas = p.campos.piezas;
  if (factor == null || !piezas || !(piezas.valor > 0)) return null;
  const porPieza = p.campos.contenido_por_pieza?.valor;
  const lecturas = [piezas.valor];
  if (porPieza?.unidad === 'pzas' && porPieza.cantidad > 0) lecturas.push(piezas.valor * porPieza.cantidad);
  if (k.principal === 'tres' && k.f2 != null && Number(k.f2) > 1) lecturas.push(piezas.valor * Number(k.f2));
  if (lecturas.some((x) => mismoNumero(x, factor))) return null;
  const rotulo = k.principal === 'dos' ? k.u2 : k.u3;
  return {
    tipo: 'piezas_distintas',
    kepler: `${ETIQUETA_PELDANO[k.principal]}: ${rotulo ?? 'sin rótulo'} · factor ${numeroCorto(factor)}`,
    foto: deFoto(piezas),
    explicacion: `El empaque dice ${piezas.valor} y la escalera de Kepler ${numeroCorto(factor)}. No se corrige solo: va a Compras con la foto.`,
  };
}

/**
 * Lo propio del nombre comercial: sus palabras que NO son de la marca, sin posesivo («Ricolino Bubulubu» con marca
 * «Ricolino» → «bubulubu»; «Hershey's Kisses» con marca «Hershey's» → «kisses»). `null` si no queda ninguna (fuera de
 * las de enlace): entonces el nombre comercial ES la marca («Hershey» con marca «Hershey's») y ya lo juzgó la marca.
 * Sólo decide el hallazgo de NOMBRE COMERCIAL; la marca sigue juzgándose sola (ver la exención en `auditarContraKepler`).
 * ❌ Antes se comparaba con `normalizarClave` exacta (el posesivo hacía dos palabras distintas: hallazgo repetido) y se
 * exigía en Kepler TODO el nombre comercial, marca incluida (`BUBULUBU 35G` daba hallazgo; revisión del 2026-11-05).
 */
function comercialSinMarca(comercial: string, marca: string | null | undefined): string | null {
  if (normalizarClave(sinPosesivo(comercial)) === normalizarClave(sinPosesivo(marca))) return null;
  const deMarca = new Set(palabras(sinPosesivo(marca)));
  const propias = palabras(sinPosesivo(comercial)).filter((p) => !deMarca.has(p));
  return propias.some((p) => !PALABRAS_DE_ENLACE.has(p)) ? propias.join(' ') : null;
}

export function auditarContraKepler(propuesta: PropuestaAmpliada | null, kepler: FichaKeplerAuditada): AuditoriaKepler {
  if (!propuesta) return { hallazgos: [], descripcion_propuesta: null, informacion_nueva: [] };
  const c = propuesta.campos;
  const hallazgos: HallazgoAuditoria[] = [];
  const nombre = kepler.nombre?.trim() || null;
  const comercial = c.nombre_comercial;
  const comercialPropio = comercial ? comercialSinMarca(comercial.valor, c.marca?.valor) : null;

  // Marca y variante en la descripción. Si la marca leída es el fabricante («Arcor») y el nombre trae el
  // nombre comercial («BON O BON»), la descripción sí nombra el producto: no es hallazgo.
  // ⛔ La exención exige el nombre comercial COMPLETO, no `comercialPropio`: con los campos cruzados (marca «Chupi
  // Bomb», nombre comercial «Chupi Bomb Tinajita») lo propio es «Tinajita», y eximir con eso callaba el BUMB mal escrito.
  if (nombre && c.marca && !apareceEnNombre(c.marca.valor, nombre)
      && !(comercial && apareceEnNombre(comercial.valor, nombre))) {
    hallazgos.push({
      tipo: 'marca_no_en_descripcion', kepler: nombre, foto: deFoto(c.marca),
      explicacion: 'La marca del empaque no aparece en la descripción de Kepler.',
    });
  }
  // Nombre comercial («Chupi Bomb») en la descripción, sin las palabras de la marca: ésas ya las juzgó la marca.
  if (nombre && comercial && comercialPropio && !apareceEnNombre(comercialPropio, nombre)) {
    hallazgos.push({
      tipo: 'nombre_comercial_no_en_descripcion', kepler: nombre, foto: deFoto(comercial),
      explicacion: 'El nombre comercial del empaque no aparece en la descripción de Kepler: puede estar mal escrito en '
        + 'Kepler o ser otro producto. No se corrige solo: lo decide Catálogo con la foto.',
    });
  }
  if (nombre && c.variante) {
    // Un surtido («Surtido Cola, Naranja, Limón»): basta que Kepler diga SURTIDO/SURT/MIX o nombre UNO de sus sabores.
    // ⚠️ «Basta uno» (que `XPLOSODA NARANJA` no dé hallazgo contra un surtido) es decisión del constructor, POR
    // CONFIRMAR con Francisco (revisión del 2026-11-05). Un sabor combinado («A y B») no entra aquí: exige los dos.
    const sabores = saboresDeVariante(c.variante.valor);
    const falta = sabores
      ? !nombreDiceSurtido(nombre) && !sabores.some((s) => apareceEnNombre(s, nombre))
      : !apareceEnNombre(c.variante.valor, nombre);
    if (falta) {
      hallazgos.push({
        tipo: 'variante_no_en_descripcion', kepler: nombre, foto: deFoto(c.variante),
        explicacion: sabores
          ? `El empaque es surtido (${sabores.length ? sabores.join(', ') : 'sin nombrar sus sabores'}) y la descripción de `
            + 'Kepler no dice SURTIDO (ni SURT ni MIX) ni nombra ninguno de sus sabores.'
          : 'El sabor o variante del empaque no aparece en la descripción de Kepler.',
      });
    }
  }

  const contenido = auditarContenido(propuesta, kepler);
  if (contenido) hallazgos.push(contenido);

  // Nivel físico (L.9b). Con empate de nivel (conflicto) no se juzga: la IA duda y lo decide Catálogo.
  const nivel = propuesta.nivel_fisico;
  const nivelSeguro = nivel && !nivel.conflicto ? nivel.valor : null;
  const nivelCompatible = nivelSeguro != null && NIVELES_COMPATIBLES[kepler.principal].includes(nivelSeguro);
  if (nivel && nivelSeguro != null && !nivelCompatible) {
    const rotulo = kepler.principal === 'base' ? kepler.u1 : kepler.principal === 'dos' ? kepler.u2 : kepler.u3;
    hallazgos.push({
      tipo: 'nivel_fisico_no_coincide',
      kepler: `${ETIQUETA_PELDANO[kepler.principal]} (${rotulo ?? 'sin rótulo'})`,
      foto: `${nivel.valor} («${nivel.evidencia}», ${nivel.de_cara})`,
      explicacion: `La foto muestra ${nivel.valor.replace(/_/g, ' ')} y el código es de la ${ETIQUETA_PELDANO[kepler.principal]}: `
        + 'código en el peldaño equivocado o empaque sin unidad en Kepler (§10b.7 punto 5). Lo decide Catálogo.',
    });
  }

  const piezas = auditarPiezas(propuesta, kepler, nivelCompatible);
  if (piezas) hallazgos.push(piezas);

  // Conflictos entre caras: van a revisión con las dos lecturas.
  if (nivel?.conflicto) {
    hallazgos.push({
      tipo: 'campo_en_conflicto', kepler: null,
      foto: `nivel_fisico: ${nivel.valor} (${nivel.de_cara}) contra ${nivel.conflicto.map((x) => `${x.valor} (${x.cara})`).join(', ')}`,
      explicacion: 'Las caras no se ponen de acuerdo en qué unidad es: la IA duda del nivel físico.',
    });
  }
  for (const [campo, v] of Object.entries(c) as Array<[NombreCampo, CampoPropuesto<unknown> | null]>) {
    if (!v?.conflicto) continue;
    hallazgos.push({
      tipo: 'campo_en_conflicto', kepler: null,
      foto: `${campo}: ${textoValor(v.valor)} (${v.de_cara}) contra ${v.conflicto.map((x) => `${textoValor(x.valor)} (${x.cara})`).join(', ')}`,
      explicacion: 'Dos caras leyeron valores distintos para el mismo campo.',
    });
  }

  // Sólo el ROSTRO es hallazgo (Francisco, 2026-11-05). `persona_visible` (mano, pierna, zapato) es informativo.
  if (propuesta.rostro_visible) {
    // ⛔ El texto se guarda y la bandeja lo mostrará: no puede afirmar un control que no existe (Ley 0, regla 11).
    // Hoy nada borra la foto ni impide publicarla (deuda (a) de NP.7.L.11d; `revision.service.ts` no mira `ai_raw`).
    hallazgos.push({
      tipo: 'rostro_visible', kepler: null, foto: 'un rostro o rasgo facial de una persona real aparece en al menos una cara',
      explicacion: 'Aparece un rostro: según §10b.3 punto 7 esa foto NO debe publicarse ni ir a estudio, y se pide otra. '
        + 'El borrado automático y el bloqueo al publicar todavía no están construidos (deuda (a) de NP.7.L.11d): '
        + 'bórrala y márcala «recapturar» a mano.',
    });
  }

  return {
    hallazgos,
    descripcion_propuesta: descripcionPropuesta(propuesta),
    informacion_nueva: CAMPOS_FUERA_DE_KEPLER.filter((k) => presente(c[k] as CampoPropuesto<unknown> | null)),
  };
}

/**
 * `foto_no_legible`: un hallazgo por cara con `legible: 'no'` (el contrato: «`no` → la foto se pide de nuevo»).
 * Sin él, los campos de esa cara llegan en `null` y la ficha se audita sin hallazgos: «no se pudo leer» se vería
 * igual que «cuadra con Kepler» (regla 11). `'parcial'` no produce hallazgo: lo decide Catálogo (deuda (h)).
 * La recaptura NO se pide sola: la marca Catálogo («recapturar») al revisar.
 */
export function hallazgosDeLegibilidad(
  entradas: ReadonlyArray<{ cara: string; lectura: Pick<LecturaFotoV1, 'legible' | 'motivo_no_legible'> }>,
): HallazgoAuditoria[] {
  return entradas
    .filter((e) => e.lectura?.legible === 'no')
    .map((e) => ({
      tipo: 'foto_no_legible' as const,
      kepler: null,
      foto: `${e.cara}: ${e.lectura.motivo_no_legible?.trim() || 'el lector no dio el motivo'}`,
      explicacion: `El texto de la cara «${e.cara}» no se pudo leer: sus campos quedaron vacíos porque no se vieron, no `
        + 'porque el empaque no los traiga. Hay que volver a fotografiarla (Catálogo la marca «recapturar»).',
    }));
}
