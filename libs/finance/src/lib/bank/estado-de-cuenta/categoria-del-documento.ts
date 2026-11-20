import type { Knex } from 'knex';
import { categoriaDelDocumento } from './clasificador';

/**
 * `[BFU.2.10]` **Al casar un movimiento del banco con su documento de Kepler, la categoría sale del documento.**
 *
 * ⛔ El hueco (medido en prod el 2026-11-20, 265 movimientos de noviembre sin categoría, todos retiros): la categoría
 * de un renglón del banco se pone al entrar la descarga (`alimentarDesdeElBanco`), cuando todavía no hay pareo. El
 * motor de conciliación casa después y nunca escribía la categoría: **145 de los 265 ya estaban casados** con su
 * documento. El documento acierta 99 % (ago–oct, contra la categoría del libro; `clasificador.ts`), pero esa fuente
 * sólo se usaba para comparar contra el libro.
 *
 * Qué toca y qué no (sólo renglones de la descarga, `sync_source = 'banco'`):
 *  - sin categoría y `classified_by = 'banco'` → si el documento la dice, se pone con `classified_by = 'documento'`;
 *  - `classified_by = 'documento'` → se recalcula: si el pareo cambió, cambia; si ya no hay pareo o el documento no
 *    la dice, vuelve a «sin categoría» (`banco`): la categoría vive mientras viva su evidencia;
 *  - lo puesto a mano (`manual`), por regla (`rule`) o por el texto del banco: NO se toca.
 *
 * Del pareo se usa el documento de mayor importe (el mismo criterio que la comparación contra el libro).
 */

export interface FilaParaCategorizar {
  id: string;
  category_id: string | null;
  classified_by: string | null;
  doc_tipo: string | null;
  entidad: string | null;
  beneficiario: string | null;
}

export interface CambioDeCategoria { id: string; category_id: string | null; classified_by: 'documento' | 'banco' }

/** El plan, puro: qué movimientos cambian de categoría. `categorias` = código → id; un código sin id no se escribe. */
export function planCategoriaDelDocumento(filas: readonly FilaParaCategorizar[], categorias: ReadonlyMap<string, string>): CambioDeCategoria[] {
  const out: CambioDeCategoria[] = [];
  for (const f of filas) {
    const codigo = f.doc_tipo ? categoriaDelDocumento(f.doc_tipo, f.entidad, f.beneficiario) : null;
    const catId = codigo ? categorias.get(codigo) ?? null : null;
    if (f.classified_by === 'banco') {
      if (f.category_id === null && catId) out.push({ id: f.id, category_id: catId, classified_by: 'documento' });
    } else if (f.classified_by === 'documento') {
      if (!catId) out.push({ id: f.id, category_id: null, classified_by: 'banco' });
      else if (catId !== f.category_id) out.push({ id: f.id, category_id: catId, classified_by: 'documento' });
    }
  }
  return out;
}

/**
 * La entidad y el nombre congelado del documento de Kepler de un pareo `r`, desde la vista derivada del ODS. Sin ODS
 * (CI, desarrollo) la vista no trae esas columnas y van nulas: se pierde la señal de proveedor/nómina, no la consulta.
 */
export async function columnasDelDocumento(trx: Knex | Knex.Transaction): Promise<{ entidad: string; beneficiario: string }> {
  const cols = new Set<string>((await trx.raw(`select column_name from information_schema.columns
    where table_schema = 'analytics' and table_name = 'kepler_bank_movements' and column_name in ('entidad_code', 'beneficiario')`))
    .rows.map((r: { column_name: string }) => r.column_name));
  const de = (col: string) => cols.has(col)
    ? `(select kb.${col} from analytics.kepler_bank_movements kb
         where kb.sucursal = r.kepler_sucursal and kb.doc_tipo = r.kepler_doc_tipo and kb.folio = r.kepler_doc_folio limit 1)`
    : 'null::text';
  return { entidad: de('entidad_code'), beneficiario: de('beneficiario') };
}

/** Escribe la categoría del documento en los movimientos dados (dentro de la transacción del motor). */
export async function categorizarPorDocumento(
  trx: Knex.Transaction, movimientos: readonly string[], opts: { soloContar?: boolean } = {},
): Promise<{ puestas: number; cambiadas: number; quitadas: number }> {
  const res = { puestas: 0, cambiadas: 0, quitadas: 0 };
  if (!movimientos.length) return res;
  const { entidad, beneficiario } = await columnasDelDocumento(trx);
  const categorias = new Map<string, string>((await trx('finance.movement_categories').select('id', 'code'))
    .map((c: { id: string; code: string }) => [c.code, c.id]));
  const filas: FilaParaCategorizar[] = [];
  for (let i = 0; i < movimientos.length; i += 2000) {
    const lote = movimientos.slice(i, i + 2000);
    const r = await trx.raw(`
      select bm.id, bm.category_id, bm.classified_by, k.doc_tipo, k.entidad, k.beneficiario
        from finance.bank_movements bm
        left join lateral (
          select r.kepler_doc_tipo as doc_tipo, ${entidad} as entidad, ${beneficiario} as beneficiario
            from finance.bank_recon_matches r where r.bank_movement_id = bm.id
           order by r.kepler_amount desc nulls last, r.kepler_doc_folio limit 1) k on true
       where bm.id = any(?::uuid[]) and bm.deleted_at is null and bm.sync_source = 'banco'
         and (bm.classified_by = 'documento' or (bm.classified_by = 'banco' and bm.category_id is null))`, [lote]);
    filas.push(...(r.rows as FilaParaCategorizar[]));
  }
  const plan = planCategoriaDelDocumento(filas, categorias);
  const antes = new Map(filas.map((f) => [f.id, f]));
  for (const c of plan) {
    const f = antes.get(c.id)!;
    if (c.category_id === null) res.quitadas++;
    else if (f.category_id === null) res.puestas++;
    else res.cambiadas++;
  }
  if (opts.soloContar) return res;
  const grupos = new Map<string, CambioDeCategoria[]>();
  for (const c of plan) {
    const k = `${c.category_id ?? ''}|${c.classified_by}`;
    grupos.set(k, [...(grupos.get(k) ?? []), c]);
  }
  for (const cs of Array.from(grupos.values())) {
    for (let i = 0; i < cs.length; i += 500) {
      await trx('finance.bank_movements').whereIn('id', cs.slice(i, i + 500).map((c) => c.id))
        .update({ category_id: cs[0].category_id, classified_by: cs[0].classified_by, updated_at: trx.fn.now() });
    }
  }
  return res;
}
