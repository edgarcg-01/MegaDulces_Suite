import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { diaMxDeInstante, type ReposicionSucursales } from '@megadulces/contracts';
import { armarReposicion } from './caja-reposicion.engine';
import { CajaCustodiaService } from './caja-custodia.service';
import {
  consultasReposicion, consultasAprobacion, entradaDeCrudos, aprobacionesDeCrudos, sumarDias,
  type DocCrudo, type EgresoCrudo, type RetiroCrudo, type VinculoCrudo,
  type PagoHoraCrudo, type SolicitudCruda, type ValeCrudo,
} from './caja-reposicion.query';
import { CashLedgerService } from './cash-ledger.service';

/** Días que se miran por defecto: la semana. La reposición de un día se arma al día siguiente. */
export const REPOSICION_VENTANA_DIAS = 7;
/** Tope de la ventana: un mes. Más que eso ya no es trabajo del día, es auditoría. */
export const REPOSICION_VENTANA_MAX_DIAS = 31;

const RX_DIA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ⭐ `[CGA-A.61]` Reposición por sucursal: lo LEE de la base (`consultasReposicion`) y se lo da al
 * motor (`caja-reposicion.engine.ts`), que decide qué se ve y qué se propone. Sólo lectura.
 */
@Injectable()
export class CajaReposicionService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly ledger: CashLedgerService,
  ) {}

  async reposicion(q: { desde?: string; hasta?: string } = {}): Promise<ReposicionSucursales> {
    const tenantId = this.tenantCtx.requireTenantId();
    const hoy = diaMxDeInstante(new Date()) as string;
    const hasta = q.hasta && RX_DIA.test(q.hasta) ? q.hasta : hoy;
    const desde = q.desde && RX_DIA.test(q.desde) ? q.desde : sumarDias(hasta, -(REPOSICION_VENTANA_DIAS - 1));
    if (desde > hasta) throw new BadRequestException('«Desde» va después de «hasta».');
    if (sumarDias(desde, REPOSICION_VENTANA_MAX_DIAS) <= hasta) {
      throw new BadRequestException(`La ventana es de ${REPOSICION_VENTANA_MAX_DIAS} días como máximo.`);
    }

    return this.tk.run(async (trx) => {
      const docs = (await consultasReposicion.docs(trx, tenantId, desde, hasta)) as DocCrudo[];
      const refs = [...new Set(docs.map((d) => d.origen_ref))];
      const egresos = (await consultasReposicion.egresos(trx, tenantId, desde, hasta, refs)) as EgresoCrudo[];
      const ids = egresos.map((g) => g.id);
      const vinculos = ids.length ? (await consultasReposicion.vinculos(trx, tenantId, ids)) as VinculoCrudo[] : [];
      const retiros = (await consultasReposicion.retiros(trx, tenantId, desde, hasta,
        await CajaCustodiaService.hayCustodia(trx))) as RetiroCrudo[];

      // `[CGA-A.62]` ¿Se aprobó antes de pagarse? La hora de cada pago, sus solicitudes y sus vales.
      const dias = [...new Set(docs.map((d) => d.fecha_captura).filter((x): x is string => !!x))];
      const sucursales = [...new Set(docs.map((d) => d.sucursal))];
      const horas = docs.length ? (await consultasAprobacion.pagosHora(trx, dias)) as PagoHoraCrudo[] : [];
      const solicitudes = docs.length
        ? (await consultasAprobacion.solicitudes(trx, tenantId, desde, hasta, sucursales)) as SolicitudCruda[] : [];
      const conFirma = await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'aprobado_at');
      const vales = solicitudes.length ? (await consultasAprobacion.vales(trx, tenantId, sucursales,
        [...new Set(solicitudes.map((s) => s.folio))], conFirma)) as ValeCrudo[] : [];
      const aprobaciones = aprobacionesDeCrudos(docs, horas, solicitudes, vales);

      return {
        // [CGA-A.65] Lo que espera su hoja de zona se repone con ella: aquí sólo se cuenta.
        ...armarReposicion({ ...entradaDeCrudos(desde, hasta, docs, egresos, vinculos, retiros), aprobaciones, apartarHojas: true }),
        datos_al: await this.ledger.frescuraCaja(trx),
        caos_al: await this.ledger.frescuraCaos(trx, tenantId),
      };
    });
  }
}
