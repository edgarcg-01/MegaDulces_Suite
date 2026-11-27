import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_NEW_DB, MiradaAlAviso, PgListenService, TenantContextService, todayMx } from '@megadulces/platform-core';
import { CANAL_BANCOS } from '../bank/aviso-bancos';
import { AUTOR_CARGOS_DEL_BANCO, ChargeContractsService } from './charge-contracts.service';

/** Lo que se espera tras el primer aviso del banco antes de mirar: una carga trae varios avisos seguidos. */
const ESPERA_MS = 60_000;

/**
 * `[PGP.213]` **Los cargos del banco, con cada carga del banco** (anexo CR §3.3: «quién llama a generar y cerrar cada día»).
 *
 * ── Qué lo dispara, sin reloj ──────────────────────────────────────────────────────────────────────
 * Edgar: «ningún cron» en el Calendario (`[PGP.117]`, `[PGP.121]`). Cada carga del estado de cuenta emite
 * `bancos_movimientos` (`aviso-bancos.ts`); al aviso —y una vez al arrancar, porque `NOTIFY` no se guarda— corre una pasada
 * por tenant (`ChargeContractsService.pasada`): proponer lo nuevo que ve el banco (DCR1) → recalcular el interés de un
 * crédito un día antes (`[PGP.219]`) → programar el cargo de cada mes de lo confirmado (DCR5) → cerrar lo que el banco ya
 * cobró, por la liga de `[PGP.212]`. Todo es idempotente: dos avisos seguidos dan las mismas filas.
 *
 * ── Junto a `[PGP.121]` ───────────────────────────────────────────────────────────────────────────
 * `PagosPorElBancoService` escucha el mismo canal y cierra por importe (±$1, ±3 días). No se pisan: lo que él cierra
 * queda `executed` y esta pasada ya no lo toma; lo que él deja (cobro tarde, dos cargos iguales el mismo día = «disputada»)
 * lo cierra esta pasada por su contrato. El orden entre los dos oyentes NO está fijo (declarado).
 *
 * Sólo escucha en el worker (`WORKER=true`). Se apaga entero con `DISABLE_CARGOS_DEL_BANCO=true`.
 */
@Injectable()
export class CargosDelBancoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CargosDelBancoService.name);
  private mirada: MiradaAlAviso | null = null;
  private dejarDeEscuchar: (() => void) | null = null;
  private avisos = 0;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly tenantCtx: TenantContextService,
    private readonly contratos: ChargeContractsService,
    private readonly listen: PgListenService,
  ) {}

  onModuleInit(): void {
    if (process.env.DISABLE_CARGOS_DEL_BANCO === 'true') { this.logger.log('cargos del banco APAGADO (DISABLE_CARGOS_DEL_BANCO)'); return; }
    if (process.env.WORKER !== 'true') { this.logger.log(`no escucho ${CANAL_BANCOS}: este proceso no es el worker (WORKER distinto de true)`); return; }
    this.mirada = new MiradaAlAviso(
      ESPERA_MS,
      async () => `${todayMx()}|${this.avisos}`,
      async (cambio) => { if (cambio) await this.correr(); },
      (e) => this.logger.error(`cargos del banco: la pasada falló: ${(e as Error)?.message}`),
    );
    try {
      this.dejarDeEscuchar = this.listen.escuchar(CANAL_BANCOS, () => { this.avisos++; this.mirada?.avisar(); });
    } catch (e: unknown) {
      this.logger.error(`no se pudo escuchar ${CANAL_BANCOS}: ${(e as Error)?.message} — los cargos de los contratos NO se van a programar ni cerrar solos`);
    }
    this.logger.log(`escuchando ${CANAL_BANCOS} (sin reloj): propone, programa y cierra los cargos de los contratos`);
    this.mirada.avisar();
  }

  onModuleDestroy(): void {
    this.dejarDeEscuchar?.();
    this.dejarDeEscuchar = null;
    this.mirada?.detener();
  }

  /** Una pasada por tenant activo. Un tenant que falla no detiene a los demás; cada paso que falla se dice. */
  async correr(): Promise<void> {
    const tenants: string[] = await this.knex('public.tenants').where({ activo: true }).pluck('id');
    for (const tenantId of tenants) {
      try {
        const r = await this.tenantCtx.run({ tenantId, roleName: 'system' }, () => this.contratos.pasada(AUTOR_CARGOS_DEL_BANCO));
        const p = r.propuesta;
        this.logger.log(`cargos del banco ${r.hoy}: ${p ? `${p.contratos} propuestas nuevas (${p.series} series, ${p.ya_citadas} ya citadas)` : 'proponer sin correr'}`
          + ` · ${r.recalculados ?? '—'} intereses recalculados · ${r.cargos ? `${r.cargos.generados} cargos programados, ${r.cargos.ya_estaban} ya estaban, ${r.cargos.omitidos.length} omitidos` : 'programar sin correr'}`
          + ` · ${r.cerrados ?? '—'} cerrados, ${r.esperando ?? '—'} esperando al banco`);
        for (const f of r.fallas) this.logger.error(`cargos del banco (tenant ${tenantId}): ${f}`);
      } catch (e: unknown) {
        this.logger.error(`cargos del banco (tenant ${tenantId}): la pasada falló: ${(e as Error)?.message}`);
      }
    }
  }
}
