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
