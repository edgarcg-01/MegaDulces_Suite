import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PgListenService } from '@megadulces/platform-core';
import { CaosGateway } from './caos.gateway';

/** Canal Postgres que emite el importer `import-caos-movements.js` tras cada ciclo con novedad. */
export const CANAL_CAOS = 'caos_movimientos';

/**
 * CS.2 — Puente `NOTIFY` de Postgres → WebSocket, para que el reporte de CAOS se entere al momento
 * de un depósito/dispensación nuevo sin poleo (mismo mecanismo de CG.23.2).
 *
 * ⚠️ El aviso trae la FIRMA, no las filas: `NOTIFY` no se persiste, y un aviso que llevara el dato
 * volvería un socket caído en un movimiento perdido. La pantalla compara la firma y va a buscar.
 */
@Injectable()
export class CaosRealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CaosRealtimeService.name);
  private dejarDeEscuchar: (() => void) | null = null;

  constructor(
    private readonly listen: PgListenService,
    private readonly gateway: CaosGateway,
  ) {}

  onModuleInit(): void {
    try {
      this.dejarDeEscuchar = this.listen.escuchar(CANAL_CAOS, (payload) => this.reenviar(payload));
      this.logger.log(`Escuchando ${CANAL_CAOS} → WS /caos`);
    } catch (e: unknown) {
      this.logger.warn(`No se pudo escuchar ${CANAL_CAOS}: ${(e as Error)?.message}`);
    }
  }

  onModuleDestroy(): void {
    this.dejarDeEscuchar?.();
    this.dejarDeEscuchar = null;
  }

  private reenviar(payload: string): void {
    let d: Record<string, unknown>;
    try { d = JSON.parse(payload || '{}'); }
    catch { this.logger.warn(`payload de ${CANAL_CAOS} no es JSON; descartado`); return; }
    const tenantId = typeof d['tenant_id'] === 'string' ? d['tenant_id'] : null;
    if (!tenantId) { this.logger.warn(`payload de ${CANAL_CAOS} sin tenant_id; descartado`); return; }
    this.gateway.emitChange(tenantId, {
      device: d['device'] == null ? null : String(d['device']),
      filas: Number.isFinite(Number(d['filas'])) ? Number(d['filas']) : null,
      max_id: Number.isFinite(Number(d['max_id'])) ? Number(d['max_id']) : null,
      firma: d['firma'] == null ? null : String(d['firma']),
      datos_al: d['datos_al'] == null ? null : String(d['datos_al']),
    });
  }
}
