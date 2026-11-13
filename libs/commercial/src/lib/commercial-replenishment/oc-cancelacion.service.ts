import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ScopeService, TenantContextService, TenantKnexService, todayMx } from '@megadulces/platform-core';
import type { OcCancelacionDto } from '@megadulces/contracts';

import { KeplerOcCancelAdapter } from './kepler-oc-cancel.adapter';
import { motivoValido } from './kepler-oc-cancelacion';
import { CAPTURISTA_SUITE, horaMx } from './kepler-requisition-sink.adapter';
import { filtroSucursalOc } from './oc-abiertas';

const AREA = 'compras';
const TABLA = 'commercial.purchase_order_cancellations';

/**
 * `[PQ.110]` — **Cancelar desde la Suite una OC de Kepler pendiente y sin vale.**
 *
 * Candados, en orden (cada uno rechaza con su porqué y sin tocar Kepler):
 *  1. la llave `COMPRAS_OC_CANCELAR` (en el controlador) y el alcance por sucursal (como `oc-abiertas`);
 *  2. el motivo (≥ 10 letras);
 *  3. el interruptor `kepler_push_switch` tipo `cancela_oc` de ESA sucursal, y su tope diario;
 *  4. la regla y los permisos de Kepler (en el adaptador, dentro de su transacción).
 *
 * Todo intento que llega a Kepler queda en `purchase_order_cancellations`, cancelado o rechazado, con
 * lo que Kepler pierde al cancelar (capturista, fecha y hora originales).
 *
 * ⚠️ Kepler y la Suite son dos bases: si Kepler confirma y el registro de la Suite falla, la OC queda
 * cancelada sin renglón aquí. Se deja en el log de error TODO lo que el renglón iba a guardar.
 */
@Injectable()
export class OcCancelacionService {
  private readonly logger = new Logger(OcCancelacionService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
    private readonly kepler: KeplerOcCancelAdapter,
  ) {}

  async cancelar(sucursal: string, folio: string, body: { motivo?: unknown }): Promise<OcCancelacionDto> {
    const s = String(sucursal ?? '').trim();
    const f = String(folio ?? '').trim();
    if (!/^\d{2}$/.test(s)) throw new BadRequestException('sucursal inválida');
    if (!/^[A-Za-z0-9-]{1,30}$/.test(f)) throw new BadRequestException('folio inválido');
    const m = motivoValido(typeof body?.motivo === 'string' ? body.motivo : null);
    if (!m.ok) throw new BadRequestException(m.motivo);

    const tenantId = this.tenantCtx.requireTenantId();
    const alcance = filtroSucursalOc(
      await this.scope.readParam({ warehouse_codes: s }, 'warehouse', 'compras/oc-abiertas', AREA));
    if (!(alcance.todas || alcance.codigos.includes(s))) throw new NotFoundException('Orden de compra no encontrada');

    const hoy = todayMx();
    const previo = await this.tk.run(async (trx) => {
      if (!(await trx.raw(`SELECT to_regclass(?) AS t`, [TABLA])).rows[0]?.t) {
        throw new ServiceUnavailableException('Cancelar OC todavía no está habilitado: falta aplicar la migración 20261113142557.');
      }
      const sw = await trx('commercial.kepler_push_switch').where({ tenant_id: tenantId, sucursal: s, tipo: 'cancela_oc' }).first();
      const ya = await trx(TABLA).where({ tenant_id: tenantId, sucursal: s, oc_folio: f, estado: 'cancelada' }).whereNull('deleted_at').first('id');
      const n = await trx(TABLA)
        .where({ tenant_id: tenantId, sucursal: s, estado: 'cancelada' }).whereNull('deleted_at')
        .whereRaw(`(created_at AT TIME ZONE 'America/Mexico_City')::date = ?::date`, [hoy])
        .count<{ n: string }[]>('* as n');
      return { sw, ya: !!ya, hoyN: Number(n[0]?.n ?? 0) };
    });
    if (previo.ya) throw new ConflictException(`La OC ${f} de la sucursal ${s} ya se canceló desde la Suite`);
    if (!previo.sw?.encendida) {
      throw new ServiceUnavailableException(`Cancelar OC en Kepler está apagado para la sucursal ${s}: ciérrala en Kepler a mano`);
    }
    const tope = previo.sw.tope_dia === null || previo.sw.tope_dia === undefined ? null : Number(previo.sw.tope_dia);
    if (tope !== null && previo.hoyN >= tope) {
      throw new ServiceUnavailableException(`La sucursal ${s} ya canceló hoy ${previo.hoyN} OC desde la Suite (tope ${tope}): ciérrala en Kepler a mano`);
    }

    const ctx = this.tenantCtx.get();
    const userId = ctx?.userId ?? null;
    const username = ctx?.username ?? null;
    const r = await this.kepler.cancelar({ sucursal: s, folio: f, capturista: CAPTURISTA_SUITE, fecha: hoy, hora: horaMx() });

    const fila = {
      tenant_id: tenantId, sucursal: s, oc_folio: f, motivo: m.valor, estado: r.estado,
      rechazo: r.estado === 'rechazada' ? (r.motivo ?? 'Kepler no la canceló') : null,
      kepler_original: r.original ? JSON.stringify(r.original) : null,
      requisicion_folio: r.original?.origen_tipo === '30' ? r.original.origen_folio : null,
      requisicion_reabierta: !!r.requisicion,
      created_by: userId, created_by_username: username, updated_by: userId,
    };
    let creada: string = new Date().toISOString();
    try {
      const [row] = await this.tk.run((trx) => trx(TABLA).insert(fila).returning(['created_at']));
      creada = new Date(row.created_at).toISOString();
    } catch (e) {
      this.logger.error(`[PQ.110] OC ${s}|${f} ${r.estado} en Kepler pero NO quedó registrada en la Suite: ${(e as Error).message} — ${JSON.stringify(fila)}`);
    }
    this.logger.log(`[PQ.110] OC ${s}|${f}: ${r.estado}${r.motivo ? ` (${r.motivo})` : ''} por ${username ?? userId ?? 'system'}`);
    return {
      sucursal: s, folio: f, estado: r.estado, rechazo: fila.rechazo,
      requisicion_reabierta: r.requisicion?.folio ?? null, cancelada_por: username, cancelada_en: creada,
    };
  }
}
