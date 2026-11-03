import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import type {
  LevantamientoPeldano, RevisionBandeja, RevisionDecisionDto, RevisionDecisionRespuesta, RevisionFicha, RevisionMotivo,
} from '@megadulces/contracts';
import { ObjectStorageService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { kdiiPorSku } from '../shared/kdii-lectura';
import type { KdiiFila } from '../shared/kdii-codigo';
import { decidirRevision, ESTADOS_EN_REVISION, motivosDeRevision, type FotoFicha } from './levantamiento.rules';
import type { Quien } from './levantamiento.service';

const MOTIVOS: RevisionMotivo[] = ['sin_analizar', 'caras_saltadas', 'entro_por_busqueda', 'foto_repetida'];
/** Las URL firmadas viven 15 min: alcanzan para revisar una página, no para publicar con ellas. */
const TTL_FOTO = 900;

interface FilaRevision {
  id: string;
  sku: string;
  branch_code: string;
  status: string;
  photos: FotoFicha[];
  sheet: {
    principal?: LevantamientoPeldano;
    peldanos?: Record<string, { codigo_escaneado?: string | null }>;
    /** Quien TERMINÓ la captura (NP.7.L.2): el crédito y el «capturó» de la bandeja. */
    capturo?: { by?: string; username?: string | null; at?: string };
  };
  created_by_username: string | null;
  created_at: string | Date;
}

/** Motivos de una ficha: los de las fotos (§10b.3 punto 4) y, si nadie la leyó todavía, «sin analizar». */
export function motivosDeFicha(f: Pick<FilaRevision, 'status' | 'photos' | 'sheet'>): RevisionMotivo[] {
  const p = f.sheet?.principal ?? null;
  const deFotos = p ? (motivosDeRevision(f.photos ?? [], p) as RevisionMotivo[]) : [];
  return [...(f.status === 'fotos_tomadas' ? (['sin_analizar'] as RevisionMotivo[]) : []), ...deFotos];
}

/**
 * `[NP.7.L.3b]` La bandeja «por revisar» de Catálogo: lo levantado que espera a una persona. En el piloto
 * es TODO (la IA está apagada, D6). Una decisión por ficha: publicar, pedir otra foto o descartar.
 * ⚠️ No filtra por sucursal: Catálogo revisa la red entera. ⚠️ «Confirmar hallazgo» (NP.7.L.3c) todavía no.
 */
@Injectable()
export class RevisionService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly storage: ObjectStorageService,
  ) {}

  async bandeja(f: { branch?: string | null; reason?: string | null; limit?: number; offset?: number }): Promise<RevisionBandeja> {
    const lim = Math.min(Math.max(Math.trunc(Number(f.limit) || 30), 1), 100);
    const off = Math.max(Math.trunc(Number(f.offset) || 0), 0);
    const motivo = MOTIVOS.includes(f.reason as RevisionMotivo) ? (f.reason as RevisionMotivo) : null;
    const branch = String(f.branch ?? '').trim() || null;
    const tenant = this.tenantCtx.requireTenantId();

    const { todas, kdii, sucursales } = await this.tk.run(async (trx) => {
      const q = trx('catalog.product_sheets')
        .where({ tenant_id: tenant, origin: 'levantamiento' }).whereIn('status', [...ESTADOS_EN_REVISION])
        .whereNull('deleted_at').whereNull('superseded_at')
        // Por llegada a revisión (cuando se TERMINÓ la captura), no por cuándo se creó la fila: una recaptura
        // no se cuela al frente de la cola.
        .orderByRaw("coalesce((sheet #>> '{capturo,at}')::timestamptz, created_at) ASC, id ASC")
        .select('id', 'sku', 'branch_code', 'status', 'photos', 'sheet', 'created_by_username', 'created_at');
      if (branch) q.where({ branch_code: branch });
      const filas = (await q) as FilaRevision[];
      const porSucursal = new Map<string, string[]>();
      for (const x of filas) porSucursal.set(x.branch_code, [...(porSucursal.get(x.branch_code) ?? []), x.sku]);
      const kd = new Map<string, KdiiFila>();
      for (const [suc, skus] of porSucursal) {
        for (const k of await kdiiPorSku(trx, suc, [...new Set(skus)], { tresCompleta: true })) kd.set(`${suc}|${k.sku}`, k);
      }
      const w = (await trx('commercial.warehouses').whereNull('deleted_at').whereIn('kepler_code', [...porSucursal.keys()])
        .select('kepler_code', 'name')) as Array<{ kepler_code: string; name: string }>;
      return { todas: filas, kdii: kd, sucursales: new Map(w.map((x) => [x.kepler_code, x.name])) };
    });

    // El conteo es de TODA la bandeja, no de la página: si no, el número de arriba no se puede recorrer.
    const conMotivos = todas.map((x) => ({ x, m: motivosDeFicha(x) }));
    const counts = Object.fromEntries(MOTIVOS.map((m) => [m, conMotivos.filter((c) => c.m.includes(m)).length])) as Record<RevisionMotivo, number>;
    const filtradas = motivo ? conMotivos.filter((c) => c.m.includes(motivo)) : conMotivos;
    const pagina = filtradas.slice(off, off + lim);

    const rows: RevisionFicha[] = [];
    for (const { x, m } of pagina) {
      const k = kdii.get(`${x.branch_code}|${x.sku}`) ?? null;
      const p = x.sheet?.principal ?? null;
      const etiqueta = !k || !p ? { label: null, factor: null, codes: [] as string[] } : p === 'base'
        ? { label: k.u1, factor: 1, codes: k.base }
        : p === 'dos' ? { label: k.u2, factor: k.f2, codes: k.dos } : { label: k.u3, factor: k.f3, codes: k.tres };
      const fotos = (x.photos ?? []).filter((ph) => ph.peldano === p);
      rows.push({
        id: x.id, sku: x.sku, name: k?.nombre ?? null,
        branch_code: x.branch_code, branch_name: sucursales.get(x.branch_code) ?? null,
        rung: p, unit_label: etiqueta.label, unit_factor: etiqueta.factor == null ? null : Number(etiqueta.factor),
        scanned_code: (p && x.sheet?.peldanos?.[p]?.codigo_escaneado) || null,
        kepler_codes: (etiqueta.codes ?? []).filter((c): c is string => !!c && !!String(c).trim()),
        status: x.status, reasons: m,
        captured_by: x.sheet?.capturo?.username ?? x.created_by_username, captured_at: new Date(x.sheet?.capturo?.at ?? x.created_at).toISOString(),
        photos: await Promise.all(fotos.map(async (ph) => ({
          face: ph.cara,
          url: ph.storage_key ? await this.storage.signedUrl(ph.storage_key, TTL_FOTO) : null,
          skipped_reason: ph.saltada_motivo ?? null,
          sharpness: ph.calidad?.nitidez ?? null,
        }))),
      });
    }
    return { counts, total: filtradas.length, total_all: todas.length, rows };
  }

  /**
   * Una decisión, con candado de fila: dos revisores no deciden la misma ficha dos veces (el segundo ve
   * «ya no está en revisión»). Cada decisión queda en `sheet.revisiones` (quién, cuándo, nota).
   * ⛔ Nadie PUBLICA lo que capturó: `compras` y `gerente_compras` también levantan (L.7b), y su
   * publicación sumaría en su propia semana. Otra persona de Catálogo la revisa.
   */
  async decidir(quien: Quien, id: string, dto: RevisionDecisionDto): Promise<RevisionDecisionRespuesta> {
    const nota = String(dto?.note ?? '').trim().slice(0, 500);
    const tenant = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx: Knex.Transaction) => {
      const f = await trx('catalog.product_sheets').where({ id, tenant_id: tenant, origin: 'levantamiento' }).whereNull('deleted_at')
        .forUpdate().first('status', 'created_by', 'photos', trx.raw(`sheet #>> '{capturo,by}' AS capturo`));
      if (!f) throw new NotFoundException('No encontramos esa ficha.');
      const r = decidirRevision(f.status, String(dto?.decision ?? ''), nota);
      if (!r.ok) throw (ESTADOS_EN_REVISION.includes(f.status) ? new BadRequestException(r.motivo) : new ConflictException(r.motivo));
      const suya = String(f.capturo ?? f.created_by ?? '') === quien.userId
        || ((f.photos ?? []) as Array<{ captured_by?: string | null }>).some((p) => p.captured_by === quien.userId);
      if (dto.decision === 'publicar' && suya) {
        throw new ForbiddenException('No puedes publicar lo que tú levantaste: que lo revise otra persona de Catálogo.');
      }
      const ahora = new Date().toISOString();
      const registro = { decision: dto.decision, by: quien.userId, by_username: quien.username, at: ahora, note: nota || null };
      await trx.raw(
        `UPDATE catalog.product_sheets
            SET status = coalesce(?, status),
                sheet = jsonb_set(
                          CASE WHEN ? = 'publicar' THEN jsonb_set(sheet, '{publicada}', ?::jsonb, true) ELSE sheet END,
                          '{revisiones}', coalesce(sheet->'revisiones', '[]'::jsonb) || ?::jsonb, true),
                deleted_at = CASE WHEN ? THEN now() ELSE deleted_at END,
                deleted_by = CASE WHEN ? THEN ?::uuid ELSE deleted_by END,
                updated_at = now(), updated_by = ?, updated_by_username = ?
          WHERE id = ? AND tenant_id = ?`,
        [r.status, dto.decision, JSON.stringify({ by: quien.userId, at: ahora }), JSON.stringify([registro]),
          r.borrar, r.borrar, quien.userId, quien.userId, quien.username, id, tenant],
      );
      return { id, status: r.borrar ? 'descartada' : String(r.status) };
    });
  }
}
