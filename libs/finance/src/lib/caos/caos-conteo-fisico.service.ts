import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import type { CaosConteoFisicoDto, CaosConteoPieza } from '@megadulces/contracts';
import { CaosService } from './caos.service';
import { validarConteo, diferenciaContra, TEXTO_CONTEO_INVALIDO } from './caos-conteo-fisico';

interface Usuario { id?: string; sub?: string; userId?: string; username?: string }

/**
 * ⭐ `[CGS.22]` **El conteo físico de la caja fuerte.**
 *
 * Medido el 2026-10-21: **0 conteos físicos en toda la historia**. El saldo de CAOS sólo lo
 * afirmaba la propia máquina. Esto guarda lo que una persona contó, a ciegas, y lo compara contra
 * la referencia del MOMENTO (que se guarda: la de la máquina cambia con el siguiente movimiento).
 *
 * ⚠️ Servicio aparte de `CaosService` a propósito: esa clase ya tiene su propio ciclo de cambios, y
 * esto sólo LEE su `saldo()` como referencia — no le agrega responsabilidad.
 */
@Injectable()
export class CaosConteoFisicoService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly caos: CaosService,
  ) {}

  /** El último conteo físico, o `null` si nunca se contó (o la tabla todavía no existe). */
  async ultimo(): Promise<CaosConteoFisicoDto | null> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const hay = (await trx.raw(`SELECT to_regclass('finance.caos_conteos_fisicos') IS NOT NULL AS t`)).rows[0]?.t === true;
      if (!hay) return null;
      const r = await trx('finance.caos_conteos_fisicos').where({ tenant_id: tenantId })
        .orderBy('created_at', 'desc').first();
      return r ? aDto(r) : null;
    });
  }

  /**
   * Guarda el conteo y RECIÉN ENTONCES revela la referencia y la diferencia: es ciego como el
   * arqueo del cajón. La referencia es el saldo que la pantalla de CAOS publica en ese instante.
   */
  async registrar(body: { piezas?: unknown; nota?: string }, user: Usuario): Promise<CaosConteoFisicoDto> {
    const uid = user?.id ?? user?.sub ?? user?.userId;
    if (!uid) throw new BadRequestException('No se pudo identificar quién contó.');
    const v = validarConteo(body?.piezas);
    if (!v.ok) throw new BadRequestException(TEXTO_CONTEO_INVALIDO[v.motivo]);
    const tenantId = this.tenantCtx.requireTenantId();

    // La referencia se toma FUERA de la escritura: `saldo()` abre su propia transacción.
    const ref = await this.caos.saldo().catch(() => null);
    const referencia = ref?.saldo?.total ?? null;

    return this.tk.run(async (trx) => {
      const dev = await trx('analytics.caos_cash_movements').where({ tenant_id: tenantId })
        .orderBy('occurred_at', 'desc').first('device');
      const [r] = await trx('finance.caos_conteos_fisicos').insert({
        tenant_id: tenantId,
        device: dev?.device ?? null,
        piezas: JSON.stringify(v.piezas),
        total: v.total,
        referencia_total: referencia,
        referencia_origen: ref?.saldo?.origen ?? null,
        referencia_parcial: ref?.saldo?.parcial ?? null,
        diferencia: diferenciaContra(v.total, referencia),
        nota: String(body?.nota ?? '').trim() || null,
        created_by: uid,
        created_by_username: user?.username ?? null,
      }).returning('*');
      return aDto(r);
    });
  }
}

function aDto(r: Record<string, unknown>): CaosConteoFisicoDto {
  const num = (v: unknown): number | null => (v == null ? null : Number(v));
  const piezas = (typeof r['piezas'] === 'string' ? JSON.parse(r['piezas'] as string) : r['piezas']) as CaosConteoPieza[];
  return {
    id: String(r['id']),
    contado_at: new Date(r['created_at'] as string).toISOString(),
    contado_por: (r['created_by_username'] ?? null) as string | null,
    piezas: (piezas ?? []).map((p) => ({ denominacion: Number(p.denominacion), piezas: Number(p.piezas) })),
    total: Number(r['total']),
    referencia_total: num(r['referencia_total']),
    referencia_origen: (r['referencia_origen'] ?? null) as string | null,
    referencia_parcial: (r['referencia_parcial'] ?? null) as boolean | null,
    diferencia: num(r['diferencia']),
    nota: (r['nota'] ?? null) as string | null,
  };
}
