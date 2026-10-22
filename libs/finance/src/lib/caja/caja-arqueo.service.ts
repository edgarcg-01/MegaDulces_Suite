import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { SUCURSAL_CAJA_GENERAL, type ArqueoCajaDto, type ArqueoGuardadoDto, type NuevoArqueoCajaInput } from '@megadulces/contracts';
import { validarArqueo, totalArqueo, puedeRecontarCorte, TEXTO_ARQUEO_INVALIDO, TEXTO_NO_RECUENTA_CORTE } from './caja-arqueo.engine';

interface Usuario { id?: string; username?: string }

const n = (v: unknown): number | null => (v == null ? null : Number(v));

/** Un renglón de `analytics.v_caja_arqueos` en la forma de la API. */
export function aArqueoDto(r: Record<string, unknown>): ArqueoCajaDto {
  const base = {
    efectivo: Number(r['efectivo'] ?? 0),
    caja_fuerte: n(r['caja_fuerte']), cheques: n(r['cheques']), papeles: n(r['papeles']),
    usd: n(r['usd']), tipo_cambio: n(r['tipo_cambio']),
  };
  const dia = r['dia'] instanceof Date ? (r['dia'] as Date).toISOString().slice(0, 10) : String(r['dia'] ?? '').slice(0, 10);
  return {
    origen: r['origen'] === 'control' ? 'control' : 'suite',
    folio: String(r['folio']),
    at: new Date(r['at'] as string).toISOString(),
    dia,
    tipo: r['tipo'] as ArqueoCajaDto['tipo'],
    completo: r['completo'] === true,
    ...base,
    tipo_cambio_fuente: (r['tipo_cambio_fuente'] ?? null) as string | null,
    quien: (r['quien'] ?? null) as string | null,
    corte_id: (r['corte_id'] ?? null) as string | null,
    nota: (r['nota'] ?? null) as string | null,
    total_mxn: totalArqueo(base),
  };
}

/**
 * ⭐ `[CGS.45]` **El arqueo completo de la caja en la Suite** — lo que contaba el Access de Control,
 * jubilado el 2026-10-22 (Edgar: «lo jubilemos de por vida»).
 *
 * Dos usos: el **recuento** de la supervisora cada mañana, a ciegas, del corte que cerró la caja
 * (decisión de Edgar del 22-oct), y el **arqueo intermedio** a cualquier hora. Los dos cuentan los
 * cinco rubros: efectivo pieza por pieza, caja fuerte, cheques, vales y papeles, y dólares.
 *
 * ⛔ Ciego: el recuento no ve lo que selló el corte hasta guardar. Contar viendo la cifra a la que
 * hay que llegar no es contar.
 *
 * Servicio aparte de `CashCutService` a propósito: el corte ya carga su propio ciclo, y esto sólo
 * LEE el corte que se recuenta.
 */
@Injectable()
export class CajaArqueoService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Los arqueos, de la Suite y del histórico de Control, del más nuevo al más viejo. */
  async listar(q: { limit?: number }): Promise<{ rows: ArqueoCajaDto[]; limit: number; fuente: string }> {
    const limit = Math.min(Math.max(Number(q?.limit) || 30, 1), 200);
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      if (!(await this.hayVista(trx))) return { rows: [], limit, fuente: 'analytics.v_caja_arqueos (no existe en este entorno)' };
      const rows: Array<Record<string, unknown>> = await trx('analytics.v_caja_arqueos').orderBy('at', 'desc').limit(limit);
      return { rows: rows.map(aArqueoDto), limit, fuente: 'analytics.v_caja_arqueos' };
    });
  }

  async registrar(body: Partial<NuevoArqueoCajaInput>, user: Usuario): Promise<ArqueoGuardadoDto> {
    if (!user?.id) throw new BadRequestException('No se pudo identificar quién contó.');
    const v = validarArqueo(body);
    if (!v.ok) throw new BadRequestException(TEXTO_ARQUEO_INVALIDO[v.motivo]);
    const a = v.arqueo;
    const tenantId = this.tenantCtx.requireTenantId();

    return this.tk.run(async (trx) => {
      let corte: Record<string, unknown> | undefined;
      if (a.corte_id) {
        corte = await trx('finance.cash_ledger_cuts').where({ tenant_id: tenantId, id: a.corte_id }).first();
        if (!corte) throw new NotFoundException('El corte que se quiere recontar no existe.');
        if (a.tipo === 'recuento') {
          const gate = puedeRecontarCorte(corte as { estado: string; created_by?: string | null; closed_by?: string | null }, user.id!);
          if (!gate.ok) throw new ForbiddenException(TEXTO_NO_RECUENTA_CORTE[gate.motivo]);
        }
      }
      const [r] = await trx('finance.cash_arqueos').insert({
        tenant_id: tenantId,
        sucursal: (corte?.['sucursal'] as string | undefined) ?? SUCURSAL_CAJA_GENERAL,
        tipo: a.tipo,
        corte_id: a.corte_id,
        piezas: JSON.stringify(a.piezas),
        morralla: a.morralla,
        efectivo: a.efectivo,
        caja_fuerte: a.caja_fuerte,
        caja_fuerte_fuente: a.caja_fuerte_fuente,
        cheques: a.cheques,
        papeles: a.papeles,
        usd: a.usd,
        tipo_cambio: a.tipo_cambio,
        tipo_cambio_fuente: a.tipo_cambio_fuente,
        nota: a.nota,
        created_by: user.id,
        created_by_username: user.username ?? null,
      }).returning('*');

      const arqueo = aArqueoDto({
        ...r, origen: 'suite', folio: r.id, at: r.counted_at,
        dia: (await trx.raw(`SELECT to_char((?::timestamptz AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS d`, [r.counted_at])).rows[0].d,
        completo: r.caja_fuerte != null && r.cheques != null && r.papeles != null && r.usd != null,
        quien: r.created_by_username,
      });
      // Recién ahora se revela contra qué se comparó.
      const contra_corte = a.tipo === 'recuento' && corte
        ? {
          folio: String(corte['folio']),
          contado: n(corte['contado']),
          diferencia: corte['contado'] == null ? null : Math.round((a.efectivo - Number(corte['contado'])) * 100) / 100,
        }
        : null;
      return { arqueo, contra_corte };
    });
  }

  private async hayVista(trx: Knex.Transaction): Promise<boolean> {
    return (await trx.raw(`SELECT to_regclass('analytics.v_caja_arqueos') IS NOT NULL AS t`)).rows[0]?.t === true;
  }
}
