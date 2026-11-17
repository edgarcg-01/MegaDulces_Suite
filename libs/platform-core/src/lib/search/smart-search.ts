import type { Knex } from 'knex';

/**
 * Opciones de {@link applySmartSearch}.
 */
export interface SmartSearchOptions {
  /**
   * Columnas de TEXTO a buscar, calificadas con su alias si hay join
   * (p.ej. `'c.proveedor_nombre'`). Se concatenan en un solo "haystack" normalizado
   * (unaccent + lower); cada token del query debe aparecer (AND) por substring
   * o por similitud de trigramas.
   */
  columns: string[];
  /**
   * Columnas NUMÉRICAS (p.ej. `'c.monto'`). Solo se consideran cuando el query parece
   * un número; matchean por substring de los dígitos (sirve para monto y para folios
   * con ceros a la izquierda). Van FUERA del haystack de texto para no ensuciar el fuzzy.
   */
  numeric?: string[];
  /** Umbral de similitud de trigramas por token (0..1). Default `0.35`. */
  threshold?: number;
  /**
   * `false` = modo ESTRICTO: cada token tiene que aparecer literalmente (substring, sin acentos
   * ni mayúsculas), sin el OR de trigramas. Para buscadores donde el operador escribe las
   * palabras exactas del renglón y un "parecido" sería ruido (cotizaciones: `altos rollo 25 35`
   * no debe traer `alto rollito`). Default `true` (el comportamiento de siempre).
   */
  fuzzy?: boolean;
  /**
   * Sinónimos de PALABRA COMPLETA: palabra que dice la gente → cómo viene escrita en los datos.
   * Cada sinónimo se busca como palabra entera (`\m…\M`), no como substring: `pal` (paleta en
   * Kepler) no debe pegar con "PALOMITAS". También vale pegado a un NÚMERO por delante, porque
   * así se escriben las medidas ("1KG", "500GR", "1K"): `kg` pega con "1kg" pero no con "akgx".
   * Las claves y valores van normalizados (minúsculas, sin acentos, sólo `[a-z0-9]`); lo que no
   * cumpla se ignora. Default: ninguno.
   */
  synonyms?: Record<string, string[]>;
  /**
   * `true` = además de la palabra tal cual, prueba su forma SINGULAR y sin DIMINUTIVO
   * ("pistaches" → "pistach", "payasitos" → "payaso", "paletas" → "paleta"). Español simple, sólo
   * palabras alfabéticas ≥ 5 letras. Las variantes se suman con OR: nunca quitan resultados.
   * Default `false`.
   */
  stem?: boolean;
  /**
   * Palabras de relleno que NO se exigen ("de", "por", "la"): quien dicta dice "altos 25 por 35"
   * y el catálogo dice "ALTOS 25X35". Se descartan del query; si el query quedara vacío se
   * usan las palabras originales (nunca se convierte en "traer todo"). Default: ninguna.
   */
  ignore?: string[];
}

/** Identificador SQL válido (`col` o `alias.col`). Las columnas vienen de código, no de input. */
const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;

/** Palabra segura para meter en una regex de Postgres (los sinónimos vienen de código). */
const WORD = /^[a-z0-9]+$/;

/**
 * Formas de una palabra en español sin plural ni diminutivo. Devuelve SÓLO las variantes
 * distintas de la palabra original (puede ser vacío).
 */
export function stemVariants(tok: string): string[] {
  if (tok.length < 5 || !/^[a-z]+$/.test(tok)) return [];
  const out = new Set<string>();
  const dim = tok.match(/^(.{3,})it([oa])s?$/); // payasitos → payaso, bolsitas → bolsa
  if (dim) out.add(dim[1] + dim[2]);
  if (tok.endsWith('es') && tok.length >= 6) out.add(tok.slice(0, -2)); // pistaches → pistach
  if (tok.endsWith('s')) out.add(tok.slice(0, -1)); // paletas → paleta
  out.delete(tok);
  return [...out];
}

/** Rango de marcas diacríticas combinantes (para quitar acentos en JS, igual que f_unaccent). */
const DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g');

/** Normaliza igual que `f_unaccent(lower(...))` en SQL: sin acentos + minúsculas. */
const norm = (s: string): string =>
  s.normalize('NFD').replace(DIACRITICS, '').toLowerCase().trim();

/**
 * Búsqueda "inteligente" compartida para cualquier buscador basado en Knex.
 *
 * Reemplaza el patrón ingenuo `ILIKE '%q%'` (un solo bloque, sensible a acentos, sin
 * tolerancia a typos) por una búsqueda que:
 *   · es insensible a ACENTOS       — `f_unaccent` (Puruándiro == puruandiro)
 *   · acepta MÚLTIPLES palabras en cualquier orden y campo — tokeniza y exige cada token (AND)
 *   · tolera TYPOS por token        — pg_trgm `word_similarity` (erejon ~ herrejon; tokens ≥ 4)
 *   · matchea NÚMEROS opcionalmente — monto/folio cuando el query es numérico
 *
 * MUTA el query builder añadiendo un `AND ( … )`. Es no-op si el query es vacío y NO ordena
 * (respeta el `ORDER BY` del caller). Requiere `public.f_unaccent` + `pg_trgm` en la DB
 * (migración `20260804170000_smart_search_extensions`).
 *
 * Los valores del query van SIEMPRE como bindings; las columnas se validan como identificadores.
 *
 * @example
 * applySmartSearch(qb, q.search, {
 *   columns: ['c.proveedor_nombre', 'c.proveedor_code', 'c.proveedor_rfc', 'c.folio'],
 *   numeric: ['c.monto'],
 * });
 */
export function applySmartSearch(
  qb: Knex.QueryBuilder,
  rawQuery: string | null | undefined,
  opts: SmartSearchOptions,
): void {
  const raw = (rawQuery ?? '').trim();
  if (!raw) return;

  const columns = (opts.columns || []).filter((c) => IDENT.test(c));
  const numeric = (opts.numeric || []).filter((c) => IDENT.test(c));
  if (!columns.length && !numeric.length) return;

  const threshold = opts.threshold ?? 0.35;
  const todos = norm(raw).split(/\s+/).filter(Boolean);
  const ignorar = new Set((opts.ignore ?? []).map(norm));
  const utiles = todos.filter((t) => !ignorar.has(t));
  const tokens = utiles.length ? utiles : todos;
  const hay = `public.f_unaccent(lower(concat_ws(' ', ${columns.join(', ')})))`;
  const isNumeric = /^[\d][\d.,\s-]*$/.test(raw);
  const digits = raw.replace(/[^\d]/g, '');

  qb.andWhere((top: Knex.QueryBuilder) => {
    // Camino de TEXTO: cada token debe aparecer (substring o, si es largo, por trigramas).
    if (columns.length && tokens.length) {
      top.orWhere((allTok: Knex.QueryBuilder) => {
        for (const tok of tokens) {
          allTok.andWhere((one: Knex.QueryBuilder) => {
            one.whereRaw(`${hay} LIKE ?`, [`%${tok}%`]);
            // Variantes que SUMAN (OR): singular/sin diminutivo y sinónimos de palabra completa.
            const formas = opts.stem ? [tok, ...stemVariants(tok)] : [tok];
            for (const v of formas) {
              if (v !== tok) one.orWhereRaw(`${hay} LIKE ?`, [`%${v}%`]);
              for (const syn of opts.synonyms?.[v] ?? []) {
                if (WORD.test(syn)) one.orWhereRaw(`${hay} ~ ?`, [`(\\m|[0-9])${syn}\\M`]);
              }
            }
            // Fuzzy (trigramas) SOLO para tokens de PALABRA (alfabéticos ≥ 4): los códigos con
            // dígitos (RFC/folio/monto) matchean por substring exacto; el fuzzy sobre ellos trae
            // ruido (p.ej. "herl690" pegaría con medio catálogo por trigramas compartidos).
            if (opts.fuzzy !== false && tok.length >= 4 && /^[a-z]+$/.test(tok)) {
              one.orWhereRaw(`word_similarity(?, ${hay}) >= ?`, [tok, threshold]);
            }
          });
        }
      });
    }
    // Camino NUMÉRICO: monto/folio por dígitos (respeta ceros a la izquierda del folio).
    if (isNumeric && digits && numeric.length) {
      top.orWhere((num: Knex.QueryBuilder) => {
        for (const c of numeric) num.orWhereRaw(`${c}::text LIKE ?`, [`%${digits}%`]);
      });
    }
  });
}

/** Escapa una palabra normalizada para meterla en una regex de Postgres (va como binding). */
const reEsc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `[BU.5.1]` Qué TAN BIEN coincide cada fila con lo que se escribió, para ORDENAR (el filtro sigue
 * siendo {@link applySmartSearch}). Devuelve una expresión SQL de 0 a 3, menor = mejor:
 *   · 0 — la frase tal cual, en palabras completas («el rey» → «… / 15 EL REY»)
 *   · 1 — todas las palabras útiles completas, en cualquier orden («vaso el rey» → «VASO FRUT … EL REY»)
 *   · 2 — todas las palabras útiles al INICIO de una palabra («rey» → «REYMA»)
 *   · 3 — el resto (dentro de otra palabra, sinónimo o trigramas)
 * Por qué: el filtro busca por substring y el orden lo ponía cada buscador (en el catálogo, lo más
 * vendido), así que «el rey» traía 10 REYMA antes que los productos El Rey (medido en Canindo el
 * 2026-11-17: 1 de los 12 primeros). Kepler busca la frase dentro de la descripción.
 * Va DESPUÉS de los aciertos exactos (clave, código de barras) y ANTES del orden de negocio del caller.
 * `null` = sin texto que calificar (el caller ordena como siempre).
 */
export function smartSearchRank(
  rawQuery: string | null | undefined,
  opts: Pick<SmartSearchOptions, 'columns' | 'ignore'>,
): { sql: string; bindings: string[] } | null {
  const columns = (opts.columns || []).filter((c) => IDENT.test(c));
  const todos = norm(rawQuery ?? '').split(/\s+/).filter(Boolean);
  if (!columns.length || !todos.length) return null;
  const ignorar = new Set((opts.ignore ?? []).map(norm));
  const utiles = todos.filter((t) => !ignorar.has(t));
  const tokens = utiles.length ? utiles : todos;
  const hay = `public.f_unaccent(lower(concat_ws(' ', ${columns.join(', ')})))`;
  // Una condición por palabra; los patrones (completa o al inicio) van en los bindings, en el mismo orden.
  const todas = tokens.map(() => `${hay} ~ ?`).join(' AND ');
  const sql = `(CASE WHEN ${hay} ~ ? THEN 0
                     WHEN ${todas} THEN 1
                     WHEN ${todas} THEN 2
                     ELSE 3 END)`;
  const bindings = [
    `\\m${todos.map(reEsc).join('\\s+')}\\M`,
    ...tokens.map((t) => `\\m${reEsc(t)}\\M`),
    ...tokens.map((t) => `\\m${reEsc(t)}`),
  ];
  return { sql, bindings };
}

/**
 * `[BU.6.1]` Las formas de partir una palabra pegada en dos que vale la pena probar («elrey» →
 * «el rey», «e lrey»…): cada mitad de 2 letras o más. Puro, para probarlo sin base.
 */
export function particionesDePalabra(tok: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (!/^[a-z]{5,}$/.test(tok)) return out;
  for (let i = 2; i <= tok.length - 2; i++) out.push([tok.slice(0, i), tok.slice(i)]);
  return out;
}

/**
 * `[BU.6.1]` Parecido por trigramas, la MISMA fórmula que `similarity()` de pg_trgm: cada palabra se
 * rellena con dos espacios adelante y uno atrás, se sacan sus tercias de letras y el parecido es
 * compartidas ÷ (todas las distintas). Valores medidos en prod (2026-11-17) que reproduce:
 * gomitas/gomtas 0.50 · mazapan/mazapna 0.45 · bubbaloo/bubaloo 0.70 · chamoy/chamoyy 0.67.
 */
export function similitudTrigramas(a: string, b: string): number {
  const tercias = (s: string): Set<string> => {
    const out = new Set<string>();
    for (const w of s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
      const p = `  ${w} `;
      for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3));
    }
    return out;
  };
  const A = tercias(a);
  const B = tercias(b);
  if (!A.size || !B.size) return 0;
  let comun = 0;
  for (const t of A) if (B.has(t)) comun++;
  return comun / (A.size + B.size - comun);
}

/**
 * `[BU.6.1]` «¿Quisiste decir…?»: corrige lo escrito contra el VOCABULARIO real del buscador (las
 * palabras de los nombres que puede encontrar, ya normalizadas), palabra por palabra:
 *   · la palabra existe tal cual → se queda;
 *   · si no, la del vocabulario más parecida (≥ umbral, 0.4): «gomtas» → «gomitas», «mazapna» → «mazapan»;
 *   · si no hay parecida y la palabra está pegada, se separa cuando sus dos mitades existen («elrey» →
 *     «el rey»). Va DESPUÉS de la parecida: un plural que no esté («mazapanes») no se parte en «mazapan es».
 * Números, códigos y palabras de menos de 3 letras no se tocan (un folio no se «corrige»).
 * Puro y en memoria: el vocabulario lo carga y guarda cada buscador (armarlo en cada consulta costaba
 * 420–900 ms en Canindo, 4,403 palabras). `null` = nada que corregir.
 */
export function corregirConVocabulario(
  rawQuery: string | null | undefined,
  vocabulario: ReadonlySet<string>,
  umbral = 0.4,
): string | null {
  const todos = norm(rawQuery ?? '').split(/\s+/).filter(Boolean);
  if (!todos.some((t) => /^[a-z]{3,}$/.test(t))) return null;
  const salida = todos.map((t) => {
    if (!/^[a-z]{3,}$/.test(t) || vocabulario.has(t)) return t;
    // La más parecida; en empate, la más corta y luego la primera en orden alfabético (como el ORDER BY medido).
    let mejor: string | null = null;
    let sim = -1;
    for (const w of vocabulario) {
      const s = similitudTrigramas(w, t);
      if (s < umbral) continue;
      if (s > sim || (mejor !== null && s === sim && (w.length < mejor.length || (w.length === mejor.length && w < mejor)))) {
        mejor = w;
        sim = s;
      }
    }
    if (mejor) return mejor;
    const partida = particionesDePalabra(t).find(([a, b]) => vocabulario.has(a) && vocabulario.has(b));
    return partida ? partida.join(' ') : t;
  });
  const sugerida = salida.join(' ');
  return sugerida !== todos.join(' ') ? sugerida : null;
}
