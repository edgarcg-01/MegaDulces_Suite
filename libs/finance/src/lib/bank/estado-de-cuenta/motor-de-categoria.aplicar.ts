import type { Knex } from 'knex';
import { todayMx } from '@megadulces/platform-core';
import { leerReglaDelLibro } from './descarga-en-movimientos.query';
import { leerEvidenciaDeKepler } from './evidencia-de-kepler.query';
import type { MapaDeCuentas } from './cuenta-de-kepler';
import { decidirCategoria, type DecisionDelMotor, type MotivoSinCategoria, type MovimientoParaElMotor } from './motor-de-categoria';

/**
 * `[BFU.7.4]` Aplica el motor de categoría (`motor-de-categoria.ts`) a los renglones de la DESCARGA del banco dados, en la
 * transacción de quien llama (la conciliación, `runMatchTreasury`: el pareo y la categoría cambian juntos, por evento).
 *
 * Es dueño de la categoría de todo renglón de la descarga (`sync_source = 'banco'`) que no puso una persona: la
 * recalcula cada vez y escribe SÓLO lo que cambió (categoría, procedencia, motivo, evidencia). Lo del libro y lo manual
 * no se toca. En seco (`soloContar`) cuenta lo que haría sin escribir.
 */

export interface ResultadoDelMotor {
  evaluados: number;
  categorizados: number;
  /** Cuántos quedan sin categoría, por motivo: la otra mitad del 100 %. */
  sin_categoria: Partial<Record<MotivoSinCategoria, number>>;
  por_fuente: Record<string, number>;
  cambios: number;
  hay_ods: boolean;
}

/** La entidad y el nombre congelado del documento de un pareo `r`, de la vista derivada del ODS (nulos sin ODS). */
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

/** JSON con las llaves ordenadas: `jsonb` las reordena al guardar y un texto distinto haría reescribir la fila en cada corrida. */
export function canonico(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonico).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonico(o[k])}`).join(",")}}`;
}

async function leerMapa(trx: Knex.Transaction): Promise<MapaDeCuentas> {
  if (!(await trx.raw(`select to_regclass('finance.category_kepler_accounts') is not null as ok`)).rows[0]?.ok) return [];
  return (await trx('finance.category_kepler_accounts').select('account_prefix', 'category_code'))
    .map((r: { account_prefix: string; category_code: string }) => [r.account_prefix, r.category_code] as const);
}

async function conColumnasDelMotor(trx: Knex.Transaction): Promise<boolean> {
  return (await trx.raw(`select count(*)::int n from information_schema.columns where table_schema = 'finance'
    and table_name = 'bank_movements' and column_name in ('category_reason', 'category_evidence')`)).rows[0].n === 2;
}

export async function aplicarMotorDeCategoria(
  trx: Knex.Transaction, movimientos: readonly string[],
  opts: { hoy?: string; pistas?: ReadonlyMap<string, 'pareo_pendiente' | 'kepler_en_otra_cuenta'>; soloContar?: boolean } = {},
): Promise<ResultadoDelMotor> {
  const res: ResultadoDelMotor = { evaluados: 0, categorizados: 0, sin_categoria: {}, por_fuente: {}, cambios: 0, hay_ods: true };
  if (!movimientos.length) return res;
  const columnas = await conColumnasDelMotor(trx);
  const { entidad, beneficiario } = await columnasDelDocumento(trx);
  const filas: (MovimientoParaElMotor & { category_id: string | null; category_reason: string | null; category_evidence: unknown })[] = [];
  for (let i = 0; i < movimientos.length; i += 2000) {
    const r = await trx.raw(`
      select bm.id::text as id, to_char(bm.movement_date, 'YYYY-MM-DD') as fecha, bm.amount_in, bm.amount_out, bm.concept as concepto,
             bm.classified_by, bm.category_id::text as category_id,
             ${columnas ? 'bm.category_reason, bm.category_evidence' : 'null::text as category_reason, null::jsonb as category_evidence'},
             k.doc_tipo, k.entidad, k.beneficiario, k.pase
        from finance.bank_movements bm
        left join lateral (
          select r.kepler_doc_tipo as doc_tipo, ${entidad} as entidad, ${beneficiario} as beneficiario, r.matched_by as pase
            from finance.bank_recon_matches r where r.bank_movement_id = bm.id
           order by r.kepler_amount desc nulls last, r.kepler_doc_folio limit 1) k on true
       where bm.id = any(?::uuid[]) and bm.deleted_at is null and bm.sync_source = 'banco'
         and coalesce(bm.classified_by, 'banco') <> 'manual'`, [movimientos.slice(i, i + 2000)]);
    for (const f of r.rows) {
      filas.push({ ...f, pareo: f.doc_tipo ? { doc_tipo: f.doc_tipo, entidad: f.entidad, beneficiario: f.beneficiario, pase: f.pase } : null });
    }
  }
  res.evaluados = filas.length;
  if (!filas.length) return res;
  const { hay_ods, evidencia } = await leerEvidenciaDeKepler(trx, filas.map((f) => f.id));
  res.hay_ods = hay_ods;
  const ctx = { mapa: await leerMapa(trx), hoy: opts.hoy ?? todayMx(), hayOds: hay_ods, reglaDelLibro: await leerReglaDelLibro(trx) };
  const categorias = new Map<string, string>((await trx('finance.movement_categories').select('id', 'code'))
    .map((c: { id: string; code: string }) => [c.code, c.id]));

  const cambios: { id: string; cat: string | null; por: string; motivo: string | null; ev: string }[] = [];
  for (const f of filas) {
    const d = decidirCategoria({ ...f, kepler: evidencia.get(f.id) ?? null, pista: opts.pistas?.get(f.id) ?? null }, ctx) as DecisionDelMotor;
    // Una categoría que el catálogo no tiene NO se escribe como null mudo: se declara.
    const catId = d.categoria ? categorias.get(d.categoria) ?? null : null;
    const motivo: string | null = d.categoria ? (catId ? null : 'cuenta_sin_categoria') : d.motivo;
    const por = d.evidencia.fuente === 'documento' && catId ? 'documento' : 'banco';
    if (catId) { res.categorizados++; res.por_fuente[d.evidencia.fuente ?? '?'] = (res.por_fuente[d.evidencia.fuente ?? '?'] ?? 0) + 1; }
    else res.sin_categoria[motivo as MotivoSinCategoria] = (res.sin_categoria[motivo as MotivoSinCategoria] ?? 0) + 1;
    // Los días hábiles deciden el motivo pero no se guardan: cambian solos cada día y harían reescribir la fila.
    const { dias_habiles: _dias, ...guardada } = d.evidencia;
    void _dias;
    const ev = canonico({ ...guardada, responsable: d.categoria ? null : d.responsable });
    const igual = f.category_id === catId && (f.classified_by ?? 'banco') === por
      && (!columnas || ((f.category_reason ?? null) === motivo && canonico(f.category_evidence ?? null) === ev));
    if (!igual) cambios.push({ id: f.id, cat: catId, por, motivo, ev });
  }
  res.cambios = cambios.length;
  if (opts.soloContar || !cambios.length) return res;
  for (let i = 0; i < cambios.length; i += 1000) {
    const c = cambios.slice(i, i + 1000);
    await trx.raw(`
      update finance.bank_movements bm
         set category_id = u.cat, classified_by = u.por, updated_at = now()
             ${columnas ? ', category_reason = u.motivo, category_evidence = u.ev' : ''}
        from unnest(?::uuid[], ?::uuid[], ?::text[], ?::text[], ?::jsonb[]) as u(id, cat, por, motivo, ev)
       where bm.id = u.id`,
    // Los nulos viajan en el arreglo: knex los tipa como `Value` (sin `null` dentro de un arreglo), por eso el cast.
    [c.map((x) => x.id), c.map((x) => x.cat), c.map((x) => x.por), c.map((x) => x.motivo), c.map((x) => x.ev)] as unknown as Knex.Value[]);
  }
  return res;
}
