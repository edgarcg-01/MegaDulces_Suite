import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { JobQueueService } from '../jobs/job-queue.service';
import { SolicitaParams } from './sat-ws.types';

export interface CrearSolicitudInput {
  rfcSolicitante: string;
  rol: 'emitidas' | 'recibidas';
  tipo?: 'CFDI' | 'Metadata';
  fechaIni: string; // YYYY-MM-DD
  fechaFin: string;
}

/**
 * FISCAL.4 — Orquestación/persistencia de la descarga masiva. Crea la solicitud
 * y arranca el pipeline encolando en fiscal.jobs (FISCAL.3). Los handlers viven
 * en DescargaOrchestratorService. Lectura para la bandeja de descargas.
 */
@Injectable()
export class DescargaService {
  private readonly logger = new Logger(DescargaService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly jobs: JobQueueService,
  ) {}

  /** Crea la solicitud (estado 'nueva') y encola el primer paso del pipeline. */
  async crear(input: CrearSolicitudInput, userId?: string): Promise<{ id: string }> {
    const tenantId = this.tenantCtx.requireTenantId();
    const rfc = input.rfcSolicitante.trim().toUpperCase();
    const id = await this.tk.run(async (trx) => {
      const [row] = await trx('fiscal.download_requests').insert({
        tenant_id: tenantId, rfc_solicitante: rfc, tipo_solicitud: input.tipo ?? 'CFDI',
        rol: input.rol, fecha_ini: input.fechaIni, fecha_fin: input.fechaFin, estado: 'nueva', requested_by: userId ?? null,
      }).returning('id');
      return row.id as string;
    });
    await this.jobs.enqueue(tenantId, { queue: 'sat', type: 'sat.solicitud', payload: { requestId: id }, dedupKey: `sat.solicitud:${id}` });
    this.logger.log(`Solicitud de descarga ${id} creada (${rfc} ${input.rol} ${input.fechaIni}..${input.fechaFin}).`);
    return { id };
  }

  list(estado?: string, limit = 100) {
    return this.tk.run(async (trx) => {
      let q = trx('fiscal.download_requests').select('*').orderBy('created_at', 'desc').limit(Math.min(limit, 500));
      if (estado) q = q.where({ estado });
      return q;
    });
  }

  get(id: string) {
    return this.tk.run(async (trx) => {
      const req = await trx('fiscal.download_requests').where({ id }).first();
      const packages = req ? await trx('fiscal.download_packages').where({ request_id: id }).select('*') : [];
      return { ...req, packages };
    });
  }
}
