import { Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { solicitudKepler, type EstadoKepler, type KeplerDelVale, type ResultadoAutorizacionSuite } from '@megadulces/contracts';

/**
 * Tope de vales por consulta. Van en la URL: 200 UUID son ~7.4 KB, debajo de lo que aceptan el
 * túnel y Caddy. La pantalla pide en tandas de 150.
 */
export const MAX_VALES_KEPLER = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ESTADOS: readonly string[] = ['N', 'A', 'F', 'C'];

/**
 * `[PGP.79]` **La solicitud de Kepler de cada vale, para la pantalla que firma.** Dos cosas:
 * en qué estado la tiene Kepler HOY (la vista viva `analytics.expense_requests`, sobre el ODS) y
 * qué hizo la Suite al firmar (`expense_proofs.kepler_authorization_*`).
 *
 * Aparte de `ExpenseProofsService` a propósito: es una lectura de dos tablas que no necesita nada
 * de aquél, y así la pantalla la pide para las filas que YA tiene, de cualquier lista.
 *
 * Dos viajes y no un JOIN: la vista es sobre el ODS y el cruce va por `(sucursal, folio)` —el folio
 * no es único entre plazas—, igual que `delDia()`.
 */
@Injectable()
export class AutorizacionKeplerLecturaService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async porVales(idsCrudos: readonly string[]): Promise<Record<string, KeplerDelVale>> {
    const tenantId = this.tenantCtx.requireTenantId();
    const ids = [...new Set(idsCrudos.map((s) => String(s).trim()).filter((s) => UUID.test(s)))].slice(0, MAX_VALES_KEPLER);
    if (!ids.length) return {};
    return this.tk.run(async (trx) => {
      const conSuite = await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'kepler_authorization_status');
      const vales: Record<string, unknown>[] = await trx('finance.expense_proofs')
        .where({ tenant_id: tenantId }).whereIn('id', ids)
        .select('id', 'sucursal', 'folio_solicitud', 'aprobado_por',
          ...(conSuite ? ['kepler_authorization_status', 'kepler_authorization_at', 'kepler_authorization_note'] : []));

      const porSucursal = new Map<string, Set<string>>();
      for (const v of vales) {
        const suc = String(v['sucursal'] ?? '');
        const folio = String(v['folio_solicitud'] ?? '').trim();
        if (!suc || !folio) continue;
        if (!porSucursal.has(suc)) porSucursal.set(suc, new Set());
        porSucursal.get(suc)!.add(folio);
      }
      const estado = new Map<string, string>();
      const hayVista = (await trx.raw(`SELECT to_regclass('analytics.expense_requests') t`)).rows?.[0]?.t;
      if (hayVista) {
        for (const [suc, folios] of porSucursal) {
          const rows: { folio: string; estado: string | null }[] = await trx('analytics.expense_requests')
            .where({ tenant_id: tenantId, sucursal: suc })
            .whereRaw('folio = ANY(?::text[])', [[...folios]])
            .select('folio', 'estado');
          for (const r of rows) if (r.estado) estado.set(`${suc}|${r.folio}`, String(r.estado).trim());
        }
      }

      const out: Record<string, KeplerDelVale> = {};
      for (const v of vales) {
        const folio = String(v['folio_solicitud'] ?? '').trim();
        const e = estado.get(`${v['sucursal']}|${folio}`);
        const res = conSuite ? (v['kepler_authorization_status'] as ResultadoAutorizacionSuite | null) : null;
        const at = v['kepler_authorization_at'];
        out[String(v['id'])] = {
          solicitud: solicitudKepler(folio),
          // ⛔ Fuera de la vista NO es «sin autorizar»: es no medido.
          estado: e && ESTADOS.includes(e) ? (e as EstadoKepler) : null,
          suite: res ? {
            resultado: res,
            at: at ? new Date(at as string).toISOString() : null,
            nota: (v['kepler_authorization_note'] as string | null) ?? null,
            firmo: (v['aprobado_por'] as string | null) ?? null,
          } : null,
        };
      }
      return out;
    });
  }
}
