import type { Logger } from '@nestjs/common';

/**
 * `[VSO.1/VSO.8]` EL RESOLVEDOR DEL CANAL DEL SELL-OUT, en un solo archivo.
 *
 * El dato vive en `analytics.sellout_channel_map` (una fila por `(fuente, canal crudo)` con su
 * canal de NEGOCIO, rótulo, orden y la evidencia que lo decide). Acá vive la LECTURA de ese dato,
 * que es lo único que los consumidores necesitan compartir.
 *
 * ── Por qué no se queda adentro de un service ────────────────────────────────────────────────
 * Nació privado en `commercial-analytics.service.ts` y a las pocas horas hizo falta en el chat del
 * sell-out, que consultaba el canal CRUDO: preguntarle "cuánto vendió mayoreo" le devolvía sólo la
 * pierna Wincaja, y un `dim=channel` listaba `credito` y `mayoreo` como dos miembros distintos del
 * mismo canal. Copiar la lógica allá habría reconstruido, en un día, la misma divergencia que este
 * resolvedor vino a eliminar — que es literalmente ADR-056: *un primitivo no cierra hasta que vive
 * en un lugar compartido*.
 *
 * ⚠️ El respaldo degradado NO es la fuente. Existe para que un destino sin la tabla siga
 * respondiendo en vez de reventar; si se usa, un canal nuevo vuelve a quedar sin rótulo, y quien
 * lo detecta es `database/tests/test-newdb-sellout-channel-parity.js`.
 */

const LABELS_FALLBACK: Record<string, string> = {
  mostrador: 'Mostrador',
  preventa: 'Vecinal',
  ruta: 'Ruta',
  mayoreo: 'Mayoreo',
  credito: 'Mayoreo',
  contado_nf: 'Mostrador',
  otro: 'Otro',
};
const ORDEN_FALLBACK: Record<string, number> = {
  mostrador: 0, preventa: 1, ruta: 2, mayoreo: 3, credito: 3, otro: 4,
};
/** Canal de negocio al que pertenece cada canal crudo, cuando no hay tabla que preguntar. */
const CANON_FALLBACK: Record<string, string> = {
  mostrador: 'mostrador', contado_nf: 'mostrador',
  preventa: 'preventa', ruta: 'ruta',
  mayoreo: 'mayoreo', credito: 'mayoreo',
};

/** Lo que el resto del código usa para hablar de canales del sell-out. */
export interface SelloutChannelMap {
  /** (fuente, canal crudo) → canal de NEGOCIO. Desconocido → el crudo, nunca se descarta. */
  canon(source: unknown, raw: unknown): string;
  /** rótulo de pantalla de un canal de NEGOCIO. */
  label(canonical: string): string;
  /** orden de pantalla de un canal de NEGOCIO. */
  orden(canonical: string): number;
  /** canales de negocio que existen, en orden — la lista que puede ofrecer un filtro. */
  canales(): { value: string; label: string }[];
  /** canales CRUDOS que componen estos canales de negocio — para filtrar en SQL sin perder ninguno. */
  raws(canonicals: string[]): string[];
  /** normaliza lo que llega por querystring; acepta el vocabulario viejo (`credito` → `mayoreo`). */
  normalize(v: unknown): string;
  /** true si el mapa salió de la DB; false si es el respaldo degradado. */
  fromDb: boolean;
}

/**
 * Lee `analytics.sellout_channel_map`. Son 9 filas: se lee una vez por request y se resuelve en
 * Node, NO con un join en las piernas del pivote — `selloutPivotLeg` está afinado para ser
 * INDEX-ONLY (medido: FULL 7-10 s vs LEAN 3.8 s del full-year) y `source` no está en el índice
 * covering, así que un join lo mandaría al heap.
 *
 * El lookup acepta `(fuente, crudo)` y también el crudo a secas, porque hay call-sites donde la
 * fuente no viaja (los árboles agregan por canal). Que eso sea válido NO se asume: el candado
 * verifica que ningún canal crudo caiga en dos canales de negocio distintos según la fuente.
 */
export async function loadSelloutChannelMap(trx: any, tenantId: string, logger?: Logger): Promise<SelloutChannelMap> {
  let rows: { source: string; raw_channel: string; canonical_channel: string; label: string; orden: number }[] = [];
  try {
    rows = await trx('analytics.sellout_channel_map').where('tenant_id', tenantId)
      .select('source', 'raw_channel', 'canonical_channel', 'label', 'orden');
  } catch {
    rows = [];
  }
  const fromDb = rows.length > 0;
  if (!fromDb && logger) {
    logger.warn('[VSO.1] analytics.sellout_channel_map vacío o ausente — el canal cae al respaldo degradado; correr la migración 20260928190000');
  }
  const byPair = new Map<string, string>();   // 'source:raw' → canónico
  const byRaw = new Map<string, string>();    // 'raw'        → canónico
  const labels = new Map<string, string>();
  const ordenes = new Map<string, number>();
  for (const r of rows) {
    byPair.set(`${r.source}:${r.raw_channel}`, r.canonical_channel);
    byRaw.set(String(r.raw_channel), r.canonical_channel);
    labels.set(r.canonical_channel, r.label);
    ordenes.set(r.canonical_channel, Number(r.orden) || 0);
  }
  // ⚠️ Un canal crudo que el mapa no explica se devuelve TAL CUAL, nunca se descarta: preferimos
  // una columna con rótulo feo a dinero que desaparece (ADR-056 R4). Quien lo detecta y lo nombra
  // con su monto es `analytics.v_sellout_channel_coverage`.
  const canon = (source: unknown, raw: unknown): string => {
    const k = String(raw ?? '');
    if (!k) return k;
    return byPair.get(`${source}:${k}`) ?? byRaw.get(k) ?? CANON_FALLBACK[k] ?? k;
  };
  const label = (c: string) => labels.get(c) ?? LABELS_FALLBACK[c] ?? c;
  const orden = (c: string) => ordenes.get(c) ?? ORDEN_FALLBACK[c] ?? 99;
  const canales = () => {
    const vistos: string[] = [];
    const fuente = fromDb ? rows.map((r) => r.canonical_channel) : Object.values(CANON_FALLBACK);
    // dedup sin spread de Set: el bundle webpack de la API lo downlevelea mal (ver bc6799da).
    for (const v of fuente) if (vistos.indexOf(v) < 0) vistos.push(v);
    return vistos.sort((a, b) => orden(a) - orden(b)).map((v) => ({ value: v, label: label(v) }));
  };
  // El querystring viejo manda `credito` para Mayoreo (y hay enlaces guardados). Se acepta y se
  // traduce; romperlos no aporta nada y esconde el cambio detrás de un filtro que "no hace nada".
  const normalize = (v: unknown) => canon(undefined, String(v ?? '').trim().toLowerCase());
  // Los crudos que componen un canal de negocio. Se usa para acotar EN SQL sin enumerar a mano
  // (enumerar a mano es exactamente lo que dejó a `mayoreo` fuera del árbol).
  const raws = (canonicals: string[]): string[] => {
    const want = new Set(canonicals);
    const src = fromDb
      ? rows.map((r) => ({ raw: String(r.raw_channel), canon: String(r.canonical_channel) }))
      : Object.entries(CANON_FALLBACK).map(([raw, c]) => ({ raw, canon: c }));
    const out: string[] = [];
    for (const x of src) if (want.has(x.canon) && out.indexOf(x.raw) < 0) out.push(x.raw);
    return out;
  };
  return { canon, label, orden, canales, raws, normalize, fromDb };
}
