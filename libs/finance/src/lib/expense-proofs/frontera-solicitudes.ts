import type { Knex } from 'knex';

/**
 * `[GX.107]` — **La fecha del documento de Kepler se MUESTRA; no decide si una solicitud aparece.**
 *
 * ## El defecto (reportado el 2026-11-10)
 * Alguien capturó en Kepler una solicitud con la fecha de una póliza vieja (enero) y no le salió en
 * la Suite: Capturar gasto, Mis gastos y el buscador la recortaban por la fecha del DOCUMENTO
 * (`fecha` = `kdm1.c9`, la que se teclea) «desde que arrancó la Suite».
 *
 * ## La regla (decidida el 2026-11-10: «esa fecha sólo muéstrala»; sin migraciones)
 * «Desde que arrancó la Suite» se cuenta por la **fecha efectiva**: la más nueva entre la del
 * documento y la de CAPTURA (`capturado_at`, que la vista ya publica: `kdm1.c68`, «la que sirve
 * para ventanas» según `docs/ERP_KEPLER.md`; medido en prod: llena en las 12,487 solicitudes).
 * Así entra lo capturado después del arranque aunque el documento diga enero, y lo que de verdad
 * es de antes de la Suite sigue fuera (`[GX.95]`).
 *
 *  · **Por folio exacto** (Capturar gasto y el buscador) se compara contra el folio TAL COMO VIENE
 *    (`r.folio = ANY(...)`, con sus ceros): casa con `idx_kdm1_xa_doc` (medido en prod con PG 18:
 *    25–45 ms). La igualdad numérica de antes (`regexp_replace(...)::bigint = ?`) no casa con ningún
 *    índice de folio.
 *    ⛔ Acotado a la fecha efectiva, NO de cualquier fecha: sin tope, el folio exacto dejaba ver por
 *    folio las 8,323 solicitudes de antes de la Suite (medido en prod, auditoría del 2026-11-10),
 *    también a quien no tiene áreas y podía recorrerlas una por una.
 *  · **Lo asignado en Mis gastos**: la misma fecha efectiva, contra el arranque de SU sucursal.
 *
 * ⛔ Es un `greatest`, nunca sólo la captura: `greatest` ignora el NULL, así que sin `c68` decide la
 * fecha del documento como antes, y nada de lo que hoy se ve desaparece.
 */

/** Hasta cuántos caracteres se rellena con ceros un folio tecleado (los de Kepler miden 7). */
const LARGO_MAXIMO_FOLIO = 10;

/**
 * Las formas en que Kepler puede tener guardado el folio que se tecleó: el número tal cual y con
 * ceros a la izquierda hasta 10 caracteres. `10570` → `10570`, `010570`, `0010570`, … Así la
 * igualdad es de texto (casa con el índice) y sigue sin importar cuántos ceros traiga el folio.
 * Lo que no es un número entero positivo no tiene candidatos.
 */
export function candidatosDeFolio(n: number | null | undefined): string[] {
  if (n === null || n === undefined || !Number.isSafeInteger(n) || n <= 0) return [];
  const base = String(n);
  const out: string[] = [];
  for (let largo = base.length; largo <= Math.max(LARGO_MAXIMO_FOLIO, base.length); largo++) out.push(base.padStart(largo, '0'));
  return out;
}

/** El folio exacto, por texto: el parámetro es `candidatosDeFolio(n)`. */
export const SQL_FOLIO_EXACTO = 'r.folio = ANY(?::text[])';

/** La fecha efectiva de una solicitud: la más nueva entre la del documento y la de captura. */
export const SQL_FECHA_EFECTIVA = 'greatest(r.fecha, r.capturado_at::date)';

/** Desde `?` por la fecha efectiva. */
export const SQL_DESDE_EFECTIVA = `${SQL_FECHA_EFECTIVA} >= ?::date`;

/** Lo más reciente primero por la fecha efectiva: lo capturado hoy con fecha vieja no se va al fondo. */
export const SQL_MAS_RECIENTE_PRIMERO = `${SQL_FECHA_EFECTIVA} DESC NULLS LAST`;

/**
 * Lo asignado en Mis gastos: desde que la Suite arrancó en SU sucursal (su primer vale, `[GX.95]`),
 * por la fecha efectiva. Correlacionada: no usa índices de fecha (tampoco antes).
 */
export const SQL_DESDE_SU_SUCURSAL =
  `${SQL_FECHA_EFECTIVA} >= (SELECT min(p0.created_at)::date FROM finance.expense_proofs p0 `
  + 'WHERE p0.tenant_id = r.tenant_id AND p0.sucursal = r.sucursal)';

/**
 * El folio exacto, desde el arranque por la fecha efectiva. Para Capturar gasto (una rama de su O)
 * y el buscador. El folio primero: es lo que deja usar el índice; la fecha filtra lo poco que trae.
 */
export function folioExactoDesde(qb: Knex.QueryBuilder, candidatos: readonly string[], desde: string): Knex.QueryBuilder {
  return qb.whereRaw(SQL_FOLIO_EXACTO, [[...candidatos]]).whereRaw(SQL_DESDE_EFECTIVA, [desde]);
}

/**
 * El buscador: lo del arranque para acá por la fecha del documento (con su índice), O el folio
 * exacto desde el arranque por la fecha efectiva. Se arma DENTRO de su propio grupo: suelto, el O
 * se comería el filtro de tenant y el de canceladas.
 */
export function desdeOFolioExacto(qb: Knex.QueryBuilder, desde: string, candidatos: readonly string[]): Knex.QueryBuilder {
  return qb.where((d) => {
    d.where('r.fecha', '>=', desde);
    if (candidatos.length) d.orWhere((f) => { folioExactoDesde(f, candidatos, desde); });
  });
}

/**
 * La MISMA regla de «desde el arranque» para lo que ya llegó del servidor (días `YYYY-MM-DD`): entra
 * si la fecha del documento o la de captura son desde el arranque. Sin fecha o sin ventana no se
 * recorta, como antes.
 */
export function entraDesde(
  fecha: string | null | undefined,
  capturado: string | null | undefined,
  desde: string | null | undefined,
): boolean {
  if (!desde || !fecha) return true;
  return fecha >= desde || (!!capturado && capturado >= desde);
}
