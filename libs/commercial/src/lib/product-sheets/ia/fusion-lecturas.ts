/**
 * `[NP.7.L.11d]` **Fusión de las caras**: las lecturas de las 5 fotos de la unidad principal → UNA
 * `PropuestaAmpliada` (lo que Catálogo acepta o corrige como `sheet.ampliado`, plan §7.2).
 *
 * Función pura: no lee base ni llama a la IA. El contrato manda (`lectura-foto.contract.ts`).
 *
 * Reglas (y su porqué):
 *  - **Campo escalar: gana la confianza más alta.** La confianza la declara el propio modelo y nadie la
 *    ha medido (NP.7.L.11b); por eso no basta: si otra cara leyó un valor DISTINTO, se guarda en
 *    `conflicto` y la ficha va a revisión con las dos lecturas. Nunca se «promedia» ni se elige en
 *    silencio (regla 11).
 *  - **Empate de confianza → la cara que mejor muestra ese campo** (el frente dice marca y contenido; el
 *    reverso y los laterales, la tabla nutrimental y los ingredientes; la cara del código, el código).
 *  - **Arreglos (sellos, leyendas, alérgenos): unión sin repetidos**, sin conflicto: cada cara muestra
 *    una parte (los sellos van al frente, los alérgenos atrás) y que una cara no los traiga no
 *    contradice a la otra.
 *  - **`rostro_visible`: basta UNA cara** (OR; §10b.3 punto 7: esa foto no se publica, no va a estudio y se
 *    pide otra). Una lectura que no trae el booleano (guardada antes de que existiera el campo) cuenta como
 *    rostro: no se supone `false` (regla 11). Hoy no hay ninguna (la IA nunca se encendió), es defensa.
 *  - **`persona_visible`: también OR, pero INFORMATIVO** (una mano, una pierna, un zapato; Francisco,
 *    2026-11-05): no bloquea nada.
 *  - **Nivel físico: mayoría ponderada por confianza; empate → conflicto**, porque «la IA duda del
 *    nivel» es exactamente lo que §10b.7 punto 5 manda a revisión.
 */
import { normalizarBusqueda } from '../../commercial-products/catalogo-busqueda';
import {
  LECTURA_FOTO_VERSION, NOMBRES_CAMPOS,
  type CampoLeido, type CampoPropuesto, type Cantidad, type Confianza, type Empaque, type LecturaFotoV1,
  type NivelFisico, type NombreCampo, type Nutricion, type PropuestaAmpliada,
} from './lectura-foto.contract';

export interface EntradaFusion {
  /** La cara de la foto: `frente`, `posterior`… (contrato) o `reverso`, `lateral_izq`… (captura, `CARAS_PRINCIPAL`). */
  cara: string;
  lectura: LecturaFotoV1;
}

// ── Comparación (la usan también la auditoría y la calificación del corpus) ───────────────────────

/** Texto comparable: sin acentos, minúsculas y sin espacios de sobra. Conserva los signos. */
export function textoComparable(texto: string | null | undefined): string {
  return normalizarBusqueda(texto).replace(/\s+/g, ' ');
}

const A_BASE: Record<string, { unidad: string; factor: number }> = {
  g: { unidad: 'g', factor: 1 }, kg: { unidad: 'g', factor: 1000 }, mg: { unidad: 'g', factor: 0.001 },
  ml: { unidad: 'ml', factor: 1 }, l: { unidad: 'ml', factor: 1000 }, pzas: { unidad: 'pzas', factor: 1 },
};

/**
 * Una cantidad en su unidad base (g, ml o pzas): `0.12 kg` y `120 g` son la misma. Una unidad fuera del
 * contrato no se convierte: se devuelve tal cual, y entonces no empata con nada (no se adivina).
 */
export function aUnidadBase(c: Cantidad): { cantidad: number; unidad: string } {
  const u = String(c.unidad ?? '').toLowerCase();
  const b = A_BASE[u];
  return b ? { cantidad: Number(c.cantidad) * b.factor, unidad: b.unidad } : { cantidad: Number(c.cantidad), unidad: u };
}

/** Igualdad numérica a 6 decimales: `0.12 × 1000` da `120.00000000000001`, que es 120. */
export function mismoNumero(a: number, b: number): boolean {
  return Math.round(a * 1e6) === Math.round(b * 1e6);
}

function esObjeto(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
function esCantidad(x: unknown): x is Cantidad {
  return esObjeto(x) && typeof x['cantidad'] === 'number' && typeof x['unidad'] === 'string';
}
function esNutricion(x: unknown): x is Nutricion {
  return esObjeto(x) && 'base' in x && 'kcal' in x;
}
function esEmpaque(x: unknown): x is Empaque {
  return esObjeto(x) && 'tipo' in x && 'material' in x && Array.isArray(x['colores']);
}

/** Llave de un elemento de arreglo, para la unión y para comparar como conjunto. */
function llaveDeElemento(x: unknown): string {
  return typeof x === 'string' ? textoComparable(x) : JSON.stringify(x);
}

export interface OpcionesComparacion {
  /**
   * `false` (la fusión): un `null` DENTRO de la nutrición o del empaque no contradice al valor de otra
   * cara, porque en el contrato `null` es «no se ve en esta cara» (el frente no muestra el «PAP 21»).
   * `true` (por defecto, la calificación del corpus): `null` contra un valor es distinto, porque ahí sí
   * importa que el lector no lo leyó.
   */
  estricto?: boolean;
}

/**
 * ¿Dos lecturas dicen lo mismo? Texto sin acentos/mayúsculas/espacios de sobra; cantidades en unidad
 * base; arreglos como conjuntos; nutrición campo por campo.
 *
 * ⚠️ El empaque se compara por `tipo` y `material`, **no por `colores`**: cada cara de la misma caja
 * muestra colores distintos (el frente rojo, el reverso blanco), y compararlos marcaría conflicto en
 * casi toda ficha sin que haya desacuerdo real. Decisión de este archivo, no del plan.
 */
export function mismoValor(a: unknown, b: unknown, op: OpcionesComparacion = {}): boolean {
  const estricto = op.estricto !== false;
  if (a == null || b == null) return a == null && b == null;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    const A = new Set(a.map(llaveDeElemento));
    const B = new Set(b.map(llaveDeElemento));
    return A.size === B.size && [...A].every((x) => B.has(x));
  }
  if (typeof a === 'string' && typeof b === 'string') return textoComparable(a) === textoComparable(b);
  if (typeof a === 'number' && typeof b === 'number') return mismoNumero(a, b);
  if (esCantidad(a) && esCantidad(b)) {
    const x = aUnidadBase(a);
    const y = aUnidadBase(b);
    return x.unidad === y.unidad && mismoNumero(x.cantidad, y.cantidad);
  }
  /** Sub-campo de un objeto: sin `estricto`, un lado en null no contradice. */
  const sub = (x: unknown, y: unknown): boolean => (!estricto && (x == null || y == null)) || mismoValor(x, y, op);
  if (esNutricion(a) && esNutricion(b)) {
    const ra = a as unknown as Record<string, unknown>;
    const rb = b as unknown as Record<string, unknown>;
    return [...new Set([...Object.keys(ra), ...Object.keys(rb)])].every((k) => sub(ra[k], rb[k]));
  }
  if (esEmpaque(a) && esEmpaque(b)) return sub(a.tipo, b.tipo) && sub(a.material, b.material);
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── Preferencia de cara por campo ─────────────────────────────────────────────────────────────────

/**
 * La captura nombra las caras `reverso`, `lateral_izq`, `lateral_der` (`levantamiento.rules.ts`) y el
 * contrato `posterior`, `lateral_1`, `lateral_2`: se agrupan en familias para que la preferencia valga
 * con los dos nombres. ⚠️ La cara `base` de la captura (la de abajo) NO se trata como la del código:
 * en qué cara viene el código depende del empaque, y no está medido.
 */
export function familiaCara(cara: string): string {
  const c = textoComparable(cara);
  if (c === 'reverso' || c === 'posterior') return 'posterior';
  if (c.startsWith('lateral')) return 'lateral';
  return c;
}

const FRENTE = ['frente'] as const;
const ATRAS = ['posterior', 'lateral'] as const;
const CODIGO = ['codigo'] as const;

/**
 * Cara preferida por campo (sólo desempata confianzas iguales). Lo que pide el plan: identidad y
 * contenido → frente; nutrición, ingredientes, alérgenos, fabricante, origen y conservación → reverso y
 * laterales; el código → la cara del código. ⚠️ Agregado aquí (el plan no lo dice): `piezas` y
 * `contenido_por_pieza` van con el contenido neto (frente), `empaque` también (es la cara que mejor lo
 * muestra), y los sellos y leyendas de NOM-051 al frente (ahí los exige la norma). En los arreglos el
 * orden sólo decide el orden de la unión.
 */
export const CARA_PREFERIDA: Record<NombreCampo, readonly string[]> = {
  marca: FRENTE, nombre_comercial: FRENTE, denominacion: FRENTE, variante: FRENTE, edicion: FRENTE,
  contenido_neto: FRENTE, piezas: FRENTE, contenido_por_pieza: FRENTE, empaque: FRENTE,
  sellos_nom051: FRENTE, leyendas_nom051: FRENTE,
  nutricion: ATRAS, ingredientes: ATRAS, alergenos: ATRAS, puede_contener: ATRAS, alergenos_otros: ATRAS,
  fabricante: ATRAS, pais_origen: ATRAS, conservacion: ATRAS,
  codigo_barras_visible: CODIGO,
};

/** Campos que son listas: se unen, no compiten. */
export const CAMPOS_ARREGLO: readonly NombreCampo[] = ['sellos_nom051', 'leyendas_nom051', 'alergenos', 'puede_contener', 'alergenos_otros'];

const PESO: Record<Confianza, number> = { alta: 3, media: 2, baja: 1 };

function rango(preferidas: readonly string[], cara: string): number {
  const i = preferidas.indexOf(familiaCara(cara));
  return i === -1 ? preferidas.length : i;
}

interface Lectura<T> {
  cara: string;
  /** Orden de llegada: último desempate, para que el resultado no dependa de nada más. */
  orden: number;
  leido: CampoLeido<T>;
}

/** Mayor confianza primero; luego la cara preferida; luego el orden de llegada. */
function ordenar<T>(xs: Array<Lectura<T>>, preferidas: readonly string[]): Array<Lectura<T>> {
  return [...xs].sort(
    (a, b) => PESO[b.leido.confianza] - PESO[a.leido.confianza] || rango(preferidas, a.cara) - rango(preferidas, b.cara) || a.orden - b.orden,
  );
}

function fusionarEscalar<T>(xs: Array<Lectura<T>>, preferidas: readonly string[]): CampoPropuesto<T> | null {
  if (!xs.length) return null;
  const [gana, ...resto] = ordenar(xs, preferidas);
  const conflicto = resto
    .filter((o) => !mismoValor(o.leido.valor, gana.leido.valor, { estricto: false }))
    .map((o) => ({ cara: o.cara, valor: o.leido.valor, evidencia: o.leido.evidencia }));
  return {
    valor: gana.leido.valor, confianza: gana.leido.confianza, evidencia: gana.leido.evidencia, de_cara: gana.cara,
    conflicto: conflicto.length ? conflicto : null,
  };
}

/**
 * Unión de listas. Aportan las caras que trajeron al menos un elemento; si todas leyeron la lista
 * vacía (lo vieron y no hay), la propuesta es `[]` con esas caras. La confianza es la MÁS BAJA de las
 * que aportaron: la unión es tan segura como su lectura más floja.
 */
function fusionarArreglo<T>(xs: Array<Lectura<T[]>>, preferidas: readonly string[]): CampoPropuesto<T[]> | null {
  if (!xs.length) return null;
  const enOrden = [...xs].sort((a, b) => rango(preferidas, a.cara) - rango(preferidas, b.cara) || a.orden - b.orden);
  const conAlgo = enOrden.filter((o) => Array.isArray(o.leido.valor) && o.leido.valor.length > 0);
  const aportan = conAlgo.length ? conAlgo : enOrden;
  const vistos = new Set<string>();
  const valor: T[] = [];
  for (const o of aportan) {
    for (const el of o.leido.valor ?? []) {
      const k = llaveDeElemento(el);
      if (vistos.has(k)) continue;
      vistos.add(k);
      valor.push(el);
    }
  }
  const caras = [...new Set(aportan.map((o) => o.cara))];
  const confianza = aportan.reduce<Confianza>((min, o) => (PESO[o.leido.confianza] < PESO[min] ? o.leido.confianza : min), 'alta');
  return {
    valor, confianza, de_cara: caras.join(', '),
    evidencia: aportan.map((o) => `${o.cara}: ${o.leido.evidencia}`).join(' | '),
    conflicto: null,
  };
}

/**
 * Nivel físico por mayoría ponderada (alta 3 · media 2 · baja 1). Gana el nivel con más peso; si dos
 * empatan arriba, se elige uno para mostrar (el de la lectura más segura; luego el frente) y el
 * `conflicto` lista las caras que vieron otro nivel: la ficha no se liga sola (§10b.7 punto 5).
 * Sin empate no hay conflicto aunque alguna cara disienta: la mayoría ya lo resolvió.
 */
function fusionarNivel(xs: Array<Lectura<NivelFisico>>): CampoPropuesto<NivelFisico> | null {
  if (!xs.length) return null;
  const votos = new Map<NivelFisico, { peso: number; lecturas: Array<Lectura<NivelFisico>> }>();
  for (const x of xs) {
    const v = votos.get(x.leido.valor) ?? { peso: 0, lecturas: [] };
    v.peso += PESO[x.leido.confianza];
    v.lecturas.push(x);
    votos.set(x.leido.valor, v);
  }
  const maximo = Math.max(...[...votos.values()].map((v) => v.peso));
  const arriba = [...votos.entries()].filter(([, v]) => v.peso === maximo);
  // El mejor representante de cada nivel empatado decide cuál se muestra (confianza, frente, llegada).
  const representantes = arriba.map(([nivel, v]) => ({ nivel, v, mejor: ordenar(v.lecturas, FRENTE)[0] }));
  representantes.sort(
    (a, b) => PESO[b.mejor.leido.confianza] - PESO[a.mejor.leido.confianza]
      || rango(FRENTE, a.mejor.cara) - rango(FRENTE, b.mejor.cara) || a.mejor.orden - b.mejor.orden,
  );
  const { nivel, v, mejor } = representantes[0];
  const conflicto = arriba.length > 1
    ? xs.filter((x) => x.leido.valor !== nivel).map((x) => ({ cara: x.cara, valor: x.leido.valor, evidencia: x.leido.evidencia }))
    : null;
  return {
    valor: nivel, confianza: mejor.leido.confianza, evidencia: mejor.leido.evidencia,
    de_cara: [...new Set(v.lecturas.map((x) => x.cara))].join(', '),
    conflicto,
  };
}

// ── La fusión ─────────────────────────────────────────────────────────────────────────────────────

export function fusionarLecturas(entradas: Array<{ cara: string; lectura: LecturaFotoV1 }>): PropuestaAmpliada {
  const campos = {} as Record<NombreCampo, CampoPropuesto<unknown> | null>;
  for (const campo of NOMBRES_CAMPOS) {
    const xs: Array<Lectura<unknown>> = [];
    entradas.forEach((e, orden) => {
      const leido = e.lectura.campos?.[campo] as CampoLeido<unknown> | null | undefined;
      if (leido) xs.push({ cara: e.cara, orden, leido });
    });
    campos[campo] = CAMPOS_ARREGLO.includes(campo)
      ? fusionarArreglo(xs as Array<Lectura<unknown[]>>, CARA_PREFERIDA[campo])
      : fusionarEscalar(xs, CARA_PREFERIDA[campo]);
  }
  const niveles: Array<Lectura<NivelFisico>> = [];
  entradas.forEach((e, orden) => {
    if (e.lectura.nivel_fisico) niveles.push({ cara: e.cara, orden, leido: e.lectura.nivel_fisico });
  });
  return {
    version: LECTURA_FOTO_VERSION,
    caras_leidas: [...new Set(entradas.map((e) => e.cara))],
    nivel_fisico: fusionarNivel(niveles),
    persona_visible: entradas.some((e) => e.lectura.persona_visible === true),
    // `!== false`: sin el booleano, la cara no se da por limpia (ver la cabecera).
    rostro_visible: entradas.some((e) => e.lectura.rostro_visible !== false),
    campos: campos as PropuestaAmpliada['campos'],
  };
}
