import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Knex } from 'knex';
import { CANAL_FUENTE_KEPLER, KNEX_NEW_DB, MiradaAlAviso, PgListenService, TenantContextService, todayMx } from '@megadulces/platform-core';
import { CANAL_BANCOS } from '../bank/aviso-bancos';
import { PaymentCalendarService } from './payment-calendar.service';

/** Lo que se espera tras el primer aviso de Kepler antes de mirar: los avisos de en medio se absorben. */
const ESPERA_MS = 60_000;

/**
 * `[PGP.117]` **A la semana, el pago que nadie pagó se libera solo, sin reloj.** Edgar, 2026-11-12. `[PGP.204]` Se
 * bajó a un día y se regresó a la semana el mismo 2026-11-23: ver `DIAS_PARA_LIBERAR`.
 *
 * ── Qué lo dispara ──────────────────────────────────────────────────────────────────────────
 * Lo mismo que a la descarga del SAT (`[PGP.110c]`): `caja_fuente` suena con cada documento que
 * cambia de verdad en Kepler, y los pagos a proveedor son documentos de Kepler. La firma de la mirada
 * es el DÍA: el primer aviso de cada día corre una pasada y los demás de ese día no hacen nada. Al
 * arrancar mira una vez (NOTIFY no se guarda). Re-correr el mismo día no libera nada nuevo.
 * `[PGP.202]` También `bancos_movimientos` (la descarga o el libro que entran a Bancos): lo que frena una liberación
 * es casi siempre que el banco todavía no cubre esos días, y es justo ese aviso el que lo cambia. La firma pasa a ser
 * el día + cuántos avisos del banco van. ⚠️ Una descarga que sólo alarga la cobertura sin movimientos nuevos no avisa:
 * ésa espera al primer aviso de Kepler del día siguiente.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 * Por cada tenant activo, `PaymentCalendarService.liberarVencidos()` dentro de su scope: la regla
 * (`decidirVencido`), la escritura y la bitácora viven allí. Aquí sólo se escucha y se registra en el
 * log cuántos se liberaron y por qué se conservó el resto.
 *
 * Sólo escucha en el worker (`WORKER=true`), como `[PGP.110c]` y el apareo de entradas.
 * Se apaga con `DISABLE_PAGOS_VENCIDOS=true`.
 */
@Injectable()
export class PagosVencidosService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PagosVencidosService.name);
  private mirada: MiradaAlAviso | null = null;
  private dejarDeEscuchar: (() => void) | null = null;
  /** `[PGP.132]` La pasada de «lo que Kepler ya pagó»: con cada aviso (la firma cambia), no una vez al día. */
  private miradaKepler: MiradaAlAviso | null = null;
  private avisosKepler = 0;
  /** `[PGP.202]` Los avisos del banco: cada uno puede cubrir los días que faltaban para liberar. */
  private avisosBanco = 0;
  private dejarDeEscucharBanco: (() => void) | null = null;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly tenantCtx: TenantContextService,
    private readonly calendario: PaymentCalendarService,
    private readonly listen: PgListenService,
  ) {}

  onModuleInit(): void {
    if (process.env.DISABLE_PAGOS_VENCIDOS === 'true') { this.logger.log('liberación de pagos vencidos APAGADA (DISABLE_PAGOS_VENCIDOS)'); return; }
    if (process.env.WORKER !== 'true') { this.logger.log(`no escucho ${CANAL_FUENTE_KEPLER}: este proceso no es el worker (WORKER distinto de true)`); return; }
    this.mirada = new MiradaAlAviso(
      ESPERA_MS,
      async () => `${todayMx()}|${this.avisosBanco}`,
      async (cambio) => { if (cambio) await this.liberarHoy(); },
      (e) => this.logger.error(`pagos vencidos: la pasada falló, no se liberó nada: ${(e as Error)?.message}`),
    );
    try {
      this.dejarDeEscuchar = this.listen.escuchar(CANAL_FUENTE_KEPLER, () => { this.avisosKepler++; this.miradaKepler?.avisar(); this.mirada?.avisar(); });
      this.logger.log(`escuchando ${CANAL_FUENTE_KEPLER} (sin reloj): libera a la semana los pagos que nadie pagó, en cuanto el banco lo confirma`);
    } catch (e: unknown) {
      this.logger.error(`no se pudo escuchar ${CANAL_FUENTE_KEPLER}: ${(e as Error)?.message} — los pagos vencidos NO se van a liberar`);
    }
    try {
      this.dejarDeEscucharBanco = this.listen.escuchar(CANAL_BANCOS, () => { this.avisosBanco++; this.mirada?.avisar(); });
    } catch (e: unknown) {
      this.logger.error(`no se pudo escuchar ${CANAL_BANCOS}: ${(e as Error)?.message} — los pagos vencidos esperan al aviso de Kepler del día`);
    }
    this.mirada.avisar();
    if (process.env.DISABLE_PAGOS_POR_KEPLER === 'true') { this.logger.log('pagos por Kepler APAGADO (DISABLE_PAGOS_POR_KEPLER)'); return; }
    this.miradaKepler = new MiradaAlAviso(
      ESPERA_MS,
      async () => `${todayMx()}|${this.avisosKepler}`,
      async (cambio) => { if (cambio) await this.pagarPorKeplerAhora(); },
      (e) => this.logger.error(`pagos por Kepler: la pasada falló: ${(e as Error)?.message}`),
    );
    this.miradaKepler.avisar();
  }

  onModuleDestroy(): void {
    this.dejarDeEscuchar?.();
    this.dejarDeEscuchar = null;
    this.dejarDeEscucharBanco?.();
    this.dejarDeEscucharBanco = null;
    this.mirada?.detener();
    this.miradaKepler?.detener();
  }

  /** Una pasada por tenant activo. Un tenant que falla no detiene a los demás. */
  /**
   * `[PGP.132]` Lo que Tesorería ya pagó en Kepler queda pagado en la Suite (y lo pagado por el banco o el comprobante,
   * ligado a esa captura). Un tenant que falla no detiene a los demás.
   */
  async pagarPorKeplerAhora(): Promise<number> {
    const tenants: string[] = await this.knex('public.tenants').where({ activo: true }).pluck('id');
    let pagados = 0;
    for (const tenantId of tenants) {
      try {
        const r = await this.tenantCtx.run({ tenantId, roleName: 'system' }, () => this.calendario.pagarPorKepler());
        pagados += r.pagados;
        if (r.pagados || r.ligados) {
          this.logger.log(`pagos por Kepler: ${r.revisados} sin ligar · ${r.pagados} pagados (${r.monto.toFixed(2)}, ${r.sin_autorizar} sin autorizar en la Suite) · ${r.ligados} ligados a la captura de Tesorería`);
        }
      } catch (e: unknown) {
        this.logger.error(`pagos por Kepler (tenant ${tenantId}): la pasada falló: ${(e as Error)?.message}`);
      }
      // [PGP.148] D19 (b): con el mismo aviso de Kepler (una nota, devolución o pago nuevo), el pago SIN autorizar de un
      // día por venir baja solo a lo que su factura debe hoy. Se apaga con DISABLE_AJUSTE_AL_SALDO=true.
      if (process.env.DISABLE_AJUSTE_AL_SALDO !== 'true') {
        try {
          const a = await this.tenantCtx.run({ tenantId, roleName: 'system' }, () => this.calendario.ajustarLosQueDebenMenos());
          if (a.ajustados.length || a.fallidos) {
            this.logger.log(`ajuste al saldo de Kepler: ${a.revisados} pagos revisados · ${a.ajustados.length} ajustados ($${a.monto.toFixed(2)} menos)`
              + ` · ${a.omitidas} facturas para una persona · ${a.fallidos} fallidos${a.ajustados.length ? ` · ${a.ajustados.join(', ')}` : ''}`);
          }
        } catch (e: unknown) {
          this.logger.error(`ajuste al saldo de Kepler (tenant ${tenantId}): la pasada falló, no se ajustó nada: ${(e as Error)?.message}`);
        }
      }
    }
    return pagados;
  }

  async liberarHoy(): Promise<number> {
    const tenants: string[] = await this.knex('public.tenants').where({ activo: true }).pluck('id');
    let liberados = 0;
    for (const tenantId of tenants) {
      try {
        const r = await this.tenantCtx.run({ tenantId, roleName: 'system' }, () => this.calendario.liberarVencidos());
        liberados += r.liberados;
        const c = r.conservados;
        this.logger.log(`pagos vencidos ${r.hoy}: ${r.revisados} con su día hace una semana o más · ${r.liberados} liberados ($${r.monto_liberado.toFixed(2)})`
          + ` · conservados: Kepler pagado ${c.kepler_pagado}, Kepler a medias ${c.kepler_en_parte}, sin medir en Kepler ${c.kepler_sin_medir},`
          + ` banco ${c.banco}, banco sin medir ${c.banco_sin_medir}, ligados ${c.ligado}, cheques emitidos ${c.cheque_emitido}`
          + (r.ids_liberados.length ? ` · liberados: ${r.ids_liberados.join(', ')}` : '')
          // [PGP.149] Lo que una pasada anterior soltó habiendo salido del banco.
          + (r.ids_regresados?.length ? ` · regresados a pendientes porque salieron del banco: ${r.ids_regresados.join(', ')}` : '')
          + (r.reprogramados_tras_liberar?.length ? ` · ⚠ salieron del banco y sus facturas ya están en otro pago (revisar): ${r.reprogramados_tras_liberar.join(', ')}` : ''));
      } catch (e: unknown) {
        this.logger.error(`pagos vencidos (tenant ${tenantId}): la pasada falló, no se liberó nada: ${(e as Error)?.message}`);
      }
    }
    return liberados;
  }
}
