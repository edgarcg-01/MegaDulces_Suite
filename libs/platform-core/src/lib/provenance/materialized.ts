/**
 * [CPU.2] «Preferí la copia materializada, y DECLARÁ su edad» — el primitivo, compartido.
 *
 * ── POR QUÉ VIVE ACÁ ─────────────────────────────────────────────────────────────────────
 * Nació como método privado `unitTruthRel()` en `commercial-bi-almacen.service.ts` (WMS-BI.4.3) y
 * estaba bien hecho: elegía la MV si existía, caía a la vista viva si no, y publicaba la edad en la
 * respuesta en vez de dejar al consumidor suponer que era en vivo. El problema es el de siempre
 * (ADR-056): **vivía en UNA rebanada**. Medido el 2026-09-25, `commercial-analytics.service.ts`
 * tenía la vista viva CLAVADA A MANO en tres lugares (3524, 4380, 4905) con la MV ya poblada al
 * lado — 6,242 llamadas en 21 h a 1.55 s cada una = **9,694 s de CPU, el 16.4 % de todo el SQL de
 * producción**, re-derivando 180,272 filas que ya estaban materializadas.
 *
 * ⭐ El número que explica por qué duele tanto: un scan COMPLETO de la vista cuesta **1.32 s** y una
 * llamada FILTRADA por SKU cuesta **1.55 s**. Filtrar no ahorra nada — el filtro cae sobre
 * `btrim(columna)`, que ningún índice común atiende, así que cada llamada paga la derivación
 * entera. No es una caché que evita trabajo repetido: es la diferencia entre derivar una vez y
 * derivar 6,242 veces.
 *
 * ── LO QUE ESTE PRIMITIVO NO HACE ────────────────────────────────────────────────────────
 * ⚠️ NO vuelve fresco un dato viejo. Elegir la MV cambia el costo y **también la EDAD**; por eso
 * devuelve las dos cosas juntas y nunca la relación sola. Si la MV se refresca de noche, lo que se
 * publica es de anoche — la procedencia lo dice, no lo arregla. Arreglarlo es cadencia de refresco,
 * que es una decisión aparte y con su propia medición.
 */

/** De dónde salió el dato y de cuándo es. `refreshed_at: null` con `source: 'view'` = es en vivo. */
export interface MaterializedProvenance {
  source: 'mv' | 'view';
  /** `now()` de la última materialización. `null` si se leyó la vista viva o no se pudo medir. */
  refreshed_at: string | null;
}

export interface MaterializedChoice {
  /** La relación a consultar, ya resuelta. Siempre calificada por esquema. */
  rel: string;
  provenance: MaterializedProvenance;
}

const IDENT = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
const COL = /^[a-z_][a-z0-9_]*$/;

/**
 * Caché de existencia, a nivel proceso.
 *
 * ⚠️ El `true` se cachea PARA SIEMPRE y el `false` con vencimiento, y la asimetría es a propósito:
 * una MV no desaparece sola, pero sí APARECE — cuando se aplica su migración en un entorno donde el
 * código ya está desplegado. La versión anterior (un `boolean | undefined` de instancia) cacheaba el
 * `false` de por vida, así que tras aplicar la migración había que REINICIAR la API para que dejara
 * de leer la vista lenta. Nadie iba a acordarse de eso.
 */
const existeCache = new Map<string, { ok: boolean; hasta: number }>();
const NO_EXISTE_TTL_MS = 60_000;

/** Para no repetir el mismo `warn` en cada request cuando falta la migración. */
const yaAvisado = new Set<string>();

/**
 * Elige entre la copia materializada y la vista viva, y devuelve con qué se quedó.
 *
 * @param trx   Transacción o conexión suelta de knex. Soporta las dos (ver abajo).
 * @param mv    Relación materializada, `esquema.nombre`.
 * @param view  Vista canónica de la que la MV es copia, `esquema.nombre`.
 * @param opts.refreshedAtCol  Columna con el sello de materialización. Default `refreshed_at`.
 * @param opts.logger  Para avisar UNA vez que falta la migración.
 */
export async function preferMaterialized(
  trx: any,
  mv: string,
  view: string,
  opts?: { refreshedAtCol?: string; logger?: { warn: (m: string) => void } },
): Promise<MaterializedChoice> {
  const col = opts?.refreshedAtCol ?? 'refreshed_at';
  if (!IDENT.test(mv) || !IDENT.test(view) || !COL.test(col)) {
    throw new Error(`preferMaterialized: identificador inválido (${mv} / ${view} / ${col})`);
  }

  const hit = existeCache.get(mv);
  let existe = hit && (hit.ok || hit.hasta > Date.now()) ? hit.ok : undefined;
  if (existe === undefined) {
    existe = !!(await trx.raw(`SELECT to_regclass(?) IS NOT NULL AS ok`, [mv]))?.rows?.[0]?.ok;
    existeCache.set(mv, { ok: existe, hasta: Date.now() + NO_EXISTE_TTL_MS });
  }

  if (!existe) {
    if (opts?.logger && !yaAvisado.has(mv)) {
      yaAvisado.add(mv);
      opts.logger.warn(
        `${mv} no existe: se lee la vista viva ${view} (correcta, pero paga la derivación completa `
        + `en cada llamada). Falta aplicar su migración.`);
    }
    return { rel: view, provenance: { source: 'view', refreshed_at: null } };
  }

  return { rel: mv, provenance: { source: 'mv', refreshed_at: await materializedAt(trx, mv, col) } };
}

/**
 * El sello de la última materialización.
 *
 * ⚠️ `LIMIT 1`, NO `max()`. Todas las filas de la MV traen el MISMO valor (es el `now()` de la
 * transacción del REFRESH), así que agregarlas sería escanear los 106 MB de `mv_unit_truth` para
 * obtener un dato que está en cualquier fila. `tableAt()` de `freshness.ts` NO sirve acá por eso
 * mismo: hace `max()`, que es correcto para una tabla que se escribe fila por fila y desperdicio
 * para una copia que se reescribe entera.
 */
async function materializedAt(trx: any, mv: string, col: string): Promise<string | null> {
  const leer = async (t: any) =>
    (await t.raw(`SELECT ${col}::text AS t FROM ${mv} LIMIT 1`))?.rows?.[0]?.t ?? null;

  // ── LA MEDICIÓN NO PUEDE TUMBAR LO QUE MIDE ────────────────────────────────────────────
  // `trx` llega de dos formas y hay que sobrevivir a ambas (misma lección que `tableAt`):
  //   (a) transacción del reporte → un error acá abortaría la transacción ENTERA. El SAVEPOINT lo
  //       contiene: se revierte solo el accesorio y el reporte sigue.
  //   (b) conexión suelta en autocommit → `SAVEPOINT` falla con 25P01 y tumbaba el endpoint.
  if (!trx.isTransaction) {
    try { return await trx.transaction(leer); } catch { return null; }
  }
  await trx.raw('SAVEPOINT vp_materialized');
  try {
    const at = await leer(trx);
    await trx.raw('RELEASE SAVEPOINT vp_materialized');
    return at;
  } catch {
    await trx.raw('ROLLBACK TO SAVEPOINT vp_materialized').catch(() => undefined);
    return null; // no se pudo medir — nunca se reporta como fresco (ADR-056, regla 2)
  }
}
