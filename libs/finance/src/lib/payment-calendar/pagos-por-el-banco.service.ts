import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_NEW_DB, MiradaAlAviso, PgListenService, TenantContextService, TenantKnexService, todayMx } from '@megadulces/platform-core';
import { CANAL_BANCOS } from '../bank/aviso-bancos';
import { PaymentCalendarService } from './payment-calendar.service';
import { KeplerPagoSinkAdapter } from './kepler-pago/kepler-pago-sink.adapter';
import { escrituraDePagoEncendida } from './kepler-pago/pago-kepler.armador';
import { leerEntregaPagoKepler } from './kepler-pago/ensayo-ods.sql';
import { AUTOR_PAGO_POR_EL_BANCO } from './pago-por-el-banco';

/** Lo que se espera tras el primer aviso del banco antes de mirar: una carga trae varios avisos seguidos. */
const ESPERA_MS = 60_000;
/** Cuántos pagos se escriben en Kepler por pasada: una carga grande no detiene al worker. */
const MAXIMO_POR_PASADA = 50;
/** Marca del reclamo mientras se escribe: el pago ya no lo toma otra pasada. */
const ESCRIBIENDO = `${AUTOR_PAGO_POR_EL_BANCO}:escribiendo`;

export const EVENTO_ESCRITO_EN_KEPLER = 'escrito_en_kepler';
export const EVENTO_KEPLER_NO_ESCRITO = 'kepler_no_escrito';
export const EVENTO_KEPLER_INCIERTO = 'kepler_incierto';

/**
 * `[PGP.121]` **El banco dispara el pago, y el pago se escribe en Kepler.** Edgar, 2026-11-13 («hay que
 * encenderla»; disparador: el banco).
 *
 * ── Qué lo dispara, sin reloj ──────────────────────────────────────────────────────────────────────
 * Cada carga del estado de cuenta emite `bancos_movimientos` dentro de su transacción (`aviso-bancos.ts`). Al
 * aviso —y una vez al arrancar, porque `NOTIFY` no se guarda— corre una pasada por tenant:
 *   1. `PaymentCalendarService.pagarPorElBanco()`: los pagos pendientes cuya salida está en el banco quedan pagados,
 *      con la cuenta del movimiento (la regla y la bitácora viven allí).
 *   2. Con `KEPLER_PAGO_ESCRITURA=encendida`, los pagos probados por el banco que nadie ligó a Kepler se escriben
 *      como `X-D-26` (`KeplerPagoSinkAdapter`). La compuerta es el ensayo (`leerEntregaPagoKepler`): si Tesorería
 *      ya lo capturó, si el acreedor no es de compra, si la cuenta no resuelve en `kdb1`… no se escribe y la
 *      bitácora dice por qué (una vez por motivo, no en cada pasada).
 *
 * ── Para no escribir dos veces ─────────────────────────────────────────────────────────────────────
 * El pago se RECLAMA antes de escribir (`kepler_payment_linked_by`, atómico). Sólo se suelta cuando Kepler, leído
 * en vivo, dice que no tiene un `X-D-26` de la Suite con esa referencia. Si no se puede preguntar, el pago se queda
 * reclamado (`kepler_incierto`) y lo mira una persona: es preferible un pago sin escribir a uno escrito dos veces.
 *
 * Sólo escucha en el worker (`WORKER=true`). Se apaga entero con `DISABLE_PAGOS_POR_EL_BANCO=true`.
 */
@Injectable()
export class PagosPorElBancoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PagosPorElBancoService.name);
  private mirada: MiradaAlAviso | null = null;
  private dejarDeEscuchar: (() => void) | null = null;
  private avisos = 0;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly tenantCtx: TenantContextService,
    private readonly tk: TenantKnexService,
    private readonly calendario: PaymentCalendarService,
    private readonly kepler: KeplerPagoSinkAdapter,
    private readonly listen: PgListenService,
  ) {}

  onModuleInit(): void {
    if (process.env.DISABLE_PAGOS_POR_EL_BANCO === 'true') { this.logger.log('pagos por el banco APAGADO (DISABLE_PAGOS_POR_EL_BANCO)'); return; }
    if (process.env.WORKER !== 'true') { this.logger.log(`no escucho ${CANAL_BANCOS}: este proceso no es el worker (WORKER distinto de true)`); return; }
    // La firma cambia con cada aviso: cada carga del banco es una pasada (las de una misma ráfaga se juntan).
    this.mirada = new MiradaAlAviso(
      ESPERA_MS,
      async () => `${todayMx()}|${this.avisos}`,
      async (cambio) => { if (cambio) await this.correr(); },
      (e) => this.logger.error(`pagos por el banco: la pasada falló: ${(e as Error)?.message}`),
    );
    try {
      this.dejarDeEscuchar = this.listen.escuchar(CANAL_BANCOS, () => { this.avisos++; this.mirada?.avisar(); });
      this.logger.log(`escuchando ${CANAL_BANCOS} (sin reloj): paga lo que el banco prueba · escritura en Kepler ${escrituraDePagoEncendida(process.env) ? 'ENCENDIDA' : 'apagada'}`);
    } catch (e: unknown) {
      this.logger.error(`no se pudo escuchar ${CANAL_BANCOS}: ${(e as Error)?.message} — los pagos NO se van a marcar solos`);
    }
    this.mirada.avisar();
  }

  onModuleDestroy(): void {
    this.dejarDeEscuchar?.();
    this.dejarDeEscuchar = null;
    this.mirada?.detener();
  }

  /** Una pasada por tenant activo. Un tenant que falla no detiene a los demás. */
  async correr(): Promise<void> {
    const tenants: string[] = await this.knex('public.tenants').where({ activo: true }).pluck('id');
    for (const tenantId of tenants) {
      try {
        await this.tenantCtx.run({ tenantId, roleName: 'system' }, async () => {
          const r = await this.calendario.pagarPorElBanco();
          const n = r.sin_decidir;
          this.logger.log(`pagos por el banco ${r.hoy}: ${r.revisados} pendientes de días pasados · ${r.pagados} pagados ($${r.monto.toFixed(2)})`
            + ` · sin decidir: sin salida ${n.sin_salida}, varias cuentas ${n.varias_cuentas}, disputada ${n.disputada}, cheque/efectivo ${n.excluido}`);
          if (escrituraDePagoEncendida(process.env)) await this.escribirEnKepler(tenantId);
        });
      } catch (e: unknown) {
        this.logger.error(`pagos por el banco (tenant ${tenantId}): la pasada falló: ${(e as Error)?.message}`);
      }
    }
  }

  /** Los pagos probados por el banco que nadie ligó a Kepler, de a uno. Corre dentro del scope del tenant. */
  async escribirEnKepler(tenantId: string): Promise<{ escritos: number; no_escritos: number; inciertos: number }> {
    const out = { escritos: 0, no_escritos: 0, inciertos: 0 };
    const hoy = todayMx();
    const ids: string[] = await this.tk.run(async (trx) => trx('finance.payment_allocations')
      .where({ tenant_id: tenantId, status: 'executed' })
      .whereNotNull('paid_bank_movement_id').whereNull('kepler_payment_folio').whereNull('kepler_payment_linked_by')
      .where('paid_bank_date', '>=', `${hoy.slice(0, 4)}-01-01`)
      .orderBy('paid_bank_date').limit(MAXIMO_POR_PASADA).pluck('id'));
    for (const id of ids) {
      const r = await this.escribirUno(tenantId, id, hoy);
      if (r === 'escrito') out.escritos++; else if (r === 'incierto') out.inciertos++; else if (r === 'no_escrito') out.no_escritos++;
    }
    if (ids.length) this.logger.log(`Kepler: ${ids.length} pagos probados por el banco · ${out.escritos} escritos · ${out.no_escritos} no · ${out.inciertos} inciertos`);
    return out;
  }

  private async escribirUno(tenantId: string, id: string, hoy: string): Promise<'escrito' | 'no_escrito' | 'incierto' | 'ocupado'> {
    // El reclamo: atómico. Si otra pasada lo tomó, éste no hace nada.
    const tomado = await this.tk.run(async (trx) => trx('finance.payment_allocations')
      .where({ tenant_id: tenantId, id }).whereNull('kepler_payment_folio').whereNull('kepler_payment_linked_by')
      .update({ kepler_payment_linked_by: ESCRIBIENDO, kepler_payment_linked_at: trx.fn.now() }));
    if (!tomado) return 'ocupado';

    const lectura = await this.tk.run(async (trx) => leerEntregaPagoKepler(trx, tenantId, id, hoy));
    if (!lectura.ok) {
      await this.soltar(tenantId, id, { motivos: lectura.motivos });
      return 'no_escrito';
    }
    const e = lectura.entrega;
    // Antes de escribir: ¿ya hay un X-D-26 de la Suite con esta referencia? (un intento anterior que sí llegó)
    const antes = await this.kepler.foliosConReferencia(e.sucursal, e.referencia);
    if (antes === null) {
      await this.soltar(tenantId, id, { motivos: [`No se pudo preguntar a Kepler ${e.sucursal}: se reintenta con la siguiente carga del banco`] });
      return 'no_escrito';
    }
    if (antes.length) return this.ligar(tenantId, id, e.sucursal, null, antes, 'ya estaba en Kepler (un intento anterior llegó)');

    const r = await this.kepler.entregar(e);
    if (r.estado === 'escrito') return this.ligar(tenantId, id, r.kepler.sucursal, r.kepler.serie, r.kepler.folios, null);

    // «Rechazado» puede ser un COMMIT que llegó y cuya respuesta se perdió: se pregunta antes de soltar.
    const despues = await this.kepler.foliosConReferencia(e.sucursal, e.referencia);
    if (despues === null) {
      await this.historial(tenantId, id, EVENTO_KEPLER_INCIERTO, { motivo: r.motivo, nota: 'Kepler respondió con error y no se pudo confirmar si escribió: el pago queda reclamado hasta que una persona lo revise' });
      this.logger.error(`pago ${id}: Kepler incierto (${r.motivo}); queda reclamado`);
      return 'incierto';
    }
    if (despues.length) return this.ligar(tenantId, id, e.sucursal, null, despues, `Kepler respondió «${r.motivo}» pero el documento sí está`);
    await this.soltar(tenantId, id, { motivos: [r.motivo] });
    return 'no_escrito';
  }

  /** Liga el pago a su primer `X-D-26` (los demás, P7, quedan en la bitácora) y suelta el reclamo. */
  private async ligar(tenantId: string, id: string, sucursal: string, serie: string | null, folios: string[], nota: string | null): Promise<'escrito'> {
    const prefijo = `XD26${String(serie ?? '1').padStart(2, '0')}`;
    await this.tk.run(async (trx) => {
      await trx('finance.payment_allocations').where({ tenant_id: tenantId, id, kepler_payment_linked_by: ESCRIBIENDO }).update({
        kepler_payment_sucursal: sucursal, kepler_payment_doc_prefix: prefijo, kepler_payment_folio: folios[0],
        kepler_payment_linked_by: AUTOR_PAGO_POR_EL_BANCO, kepler_payment_linked_at: trx.fn.now(), updated_at: trx.fn.now(),
      });
      await this.historialEn(trx, tenantId, id, EVENTO_ESCRITO_EN_KEPLER, { sucursal, prefijo, folios, nota });
    });
    return 'escrito';
  }

  /** Suelta el reclamo (Kepler confirmó que no escribió) y deja el motivo, una vez por motivo. */
  private async soltar(tenantId: string, id: string, detalle: { motivos: string[] }): Promise<void> {
    await this.tk.run(async (trx) => {
      await trx('finance.payment_allocations').where({ tenant_id: tenantId, id, kepler_payment_linked_by: ESCRIBIENDO })
        .update({ kepler_payment_linked_by: null, kepler_payment_linked_at: null });
      const ultimo = await trx('finance.payment_allocation_history').where({ tenant_id: tenantId, allocation_id: id })
        .orderBy('created_at', 'desc').first('event', 'detail');
      const mismo = ultimo?.event === EVENTO_KEPLER_NO_ESCRITO
        && JSON.stringify((ultimo.detail as { motivos?: string[] })?.motivos ?? []) === JSON.stringify(detalle.motivos);
      if (!mismo) await this.historialEn(trx, tenantId, id, EVENTO_KEPLER_NO_ESCRITO, detalle);
    });
  }

  private async historial(tenantId: string, id: string, event: string, detail: Record<string, unknown>): Promise<void> {
    await this.tk.run(async (trx) => this.historialEn(trx, tenantId, id, event, detail));
  }

  private async historialEn(trx: Knex.Transaction, tenantId: string, id: string, event: string, detail: Record<string, unknown>): Promise<void> {
    await trx('finance.payment_allocation_history').insert({
      tenant_id: tenantId, allocation_id: id, event, status_from: 'executed', status_to: 'executed',
      created_by: AUTOR_PAGO_POR_EL_BANCO, detail: JSON.stringify({ regla: 'PGP.121', ...detail }),
    });
  }
}
