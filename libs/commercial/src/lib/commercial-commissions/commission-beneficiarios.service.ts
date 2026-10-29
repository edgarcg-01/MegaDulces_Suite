import type { Knex } from 'knex';
import { Injectable, Logger, BadRequestException, ConflictException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * `[RD.100]` — **La nómina de banco del supervisor se configura desde la pantalla.**
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────────────────
 * D3 (Edgar, 2026-10-29): al supervisor se le paga **20 % de las comisiones de sus rutas + sus
 * bonos − su nómina de banco**, y «todo se tiene que poder configurar». El 20 % ya vive en el
 * tabulador (`share_supervisor_pct`) y los bonos en `commission_bonuses`; la nómina vive en
 * `commission_beneficiary_config`, que tenía **0 filas y ningún camino para escribirla**. Con la
 * tabla vacía el motor declara el neto como no calculable (`[RD.91]`), así que sin esto el neto
 * del supervisor no podía existir nunca.
 *
 * ── Las reglas ───────────────────────────────────────────────────────────────────────────
 * **1. Cada cambio es una VERSIÓN, con su fecha.** Fijar una nómina nueva cierra la vigente
 * (`valid_to = valid_from` de la nueva) y abre otra. Así una quincena vieja se recalcula con la
 * nómina que tenía entonces, no con la de hoy. Si la fecha coincide con la de la versión
 * vigente, se corrige esa misma fila.
 *
 * **2. El nombre tiene que existir en el padrón**, escrito igual: el motor cruza la deducción con
 * `supervisor_nombre` de `commission_route_config` por texto. Un nombre que no está ahí no se
 * descontaría nunca y nadie lo vería.
 *
 * **3. No se mete una versión DETRÁS de otra.** Una fecha anterior a la de la versión vigente
 * reescribiría la historia en medio; se rechaza.
 *
 * **4. La escala se resuelve sola** (la columna es NOT NULL con FK), pero la deducción NO depende
 * de ella: `deducciones()` ya no filtra por escala.
 */
@Injectable()
export class CommissionBeneficiariosService {
  private readonly logger = new Logger(CommissionBeneficiariosService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Un renglón por supervisor del padrón, con la nómina vigente HOY (o `null`: sin configurar)
   * y su historia. Los supervisores salen del padrón, no de esta tabla: el que falta configurar
   * tiene que verse.
   */
  async listar(): Promise<SupervisorNomina[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(
        `WITH sup AS (
           SELECT c.supervisor_nombre AS nombre,
                  array_agg(DISTINCT c.route_code ORDER BY c.route_code) AS rutas,
                  bool_or(c.activo) AS activo
             FROM commercial.commission_route_config c
            WHERE c.tenant_id = ? AND c.deleted_at IS NULL
              AND btrim(coalesce(c.supervisor_nombre, '')) <> ''
            GROUP BY c.supervisor_nombre
         )
         SELECT s.nombre, s.rutas, s.activo,
                v.id, v.nomina_banco::float8 AS nomina_banco,
                to_char(v.valid_from, 'YYYY-MM-DD') AS valid_from, v.notes,
                v.updated_at, v.updated_by,
                coalesce((
                  SELECT json_agg(json_build_object(
                           'nomina_banco', h.nomina_banco::float8,
                           'valid_from', to_char(h.valid_from, 'YYYY-MM-DD'),
                           'valid_to', to_char(h.valid_to, 'YYYY-MM-DD'),
                           'notes', h.notes) ORDER BY h.valid_from DESC)
                    FROM commercial.commission_beneficiary_config h
                   WHERE h.tenant_id = ? AND h.beneficiario = 'supervisor'
                     AND h.nombre = s.nombre AND h.deleted_at IS NULL), '[]'::json) AS historia
           FROM sup s
           LEFT JOIN LATERAL (
             SELECT b.* FROM commercial.commission_beneficiary_config b
              WHERE b.tenant_id = ? AND b.beneficiario = 'supervisor' AND b.nombre = s.nombre
                AND b.deleted_at IS NULL AND b.valid_from <= current_date
                AND (b.valid_to IS NULL OR b.valid_to > current_date)
              ORDER BY b.valid_from DESC LIMIT 1
           ) v ON true
          ORDER BY s.activo DESC, s.nombre`, [tenantId, tenantId, tenantId]);
      return rows as SupervisorNomina[];
    });
  }

  /** Fija la nómina de banco de un supervisor a partir de una fecha. Ver las reglas arriba. */
  async fijar(dto: FijarNomina): Promise<SupervisorNomina[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    const userId = this.tenantCtx.get()?.userId ?? null;
    const nombre = String(dto?.nombre ?? '').trim();
    const monto = Number(dto?.nomina_banco);
    const desde = String(dto?.valid_from ?? '').trim();
    if (!nombre) throw new BadRequestException('nombre requerido');
    if (dto?.nomina_banco == null || !Number.isFinite(monto) || monto < 0) {
      throw new BadRequestException(
        'nomina_banco requerida y no negativa. Es lo que se le resta al supervisor cada quincena; '
        + 'si no tiene, va en 0 explícitamente.');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) {
      throw new BadRequestException(
        'valid_from requerida (AAAA-MM-DD): el primer día de la primera quincena en que aplica.');
    }

    await this.tk.run(async (trx) => {
      // ── Regla 2: el nombre tiene que estar en el padrón, escrito igual ───────────────────
      const enPadron = await trx('commercial.commission_route_config')
        .where({ tenant_id: tenantId, supervisor_nombre: nombre }).whereNull('deleted_at').first();
      if (!enPadron) {
        throw new BadRequestException(
          `«${nombre}» no es supervisor de ninguna ruta del padrón. El motor cruza la deducción por `
          + 'el nombre exacto: con otro nombre no se descontaría nunca. Corregí el padrón primero.');
      }

      // `to_char` en la base: `pg` entrega un `date` como `Date` y compararlo como texto en JS
      // corre el día en hora de México (LC.16).
      const vigente: { id: string; notes: string | null; desde: string } | undefined =
        await trx('commercial.commission_beneficiary_config')
          .where({ tenant_id: tenantId, beneficiario: 'supervisor', nombre })
          .whereNull('deleted_at').whereNull('valid_to')
          .orderBy('valid_from', 'desc')
          .first('id', 'notes', trx.raw(`to_char(valid_from, 'YYYY-MM-DD') AS desde`));
      const vDesde = vigente?.desde ?? null;

      // ── Regla 3: no se mete una versión detrás de la vigente ───────────────────────────
      if (vDesde && desde < vDesde) {
        throw new ConflictException(
          `La nómina vigente de ${nombre} empieza el ${vDesde}; una versión desde el ${desde} `
          + 'quedaría metida detrás y cambiaría quincenas en medio. Usá una fecha igual o posterior.');
      }

      if (vigente && vDesde === desde) {
        await trx('commercial.commission_beneficiary_config').where({ id: vigente.id })
          .update({ nomina_banco: monto, notes: dto.notes ?? vigente.notes,
            updated_at: trx.fn.now(), updated_by: userId });
      } else {
        if (vigente) {
          await trx('commercial.commission_beneficiary_config').where({ id: vigente.id })
            .update({ valid_to: desde, updated_at: trx.fn.now(), updated_by: userId });
        }
        await trx('commercial.commission_beneficiary_config').insert({
          tenant_id: tenantId,
          scale_id: await this.escalaVigente(trx, desde),
          beneficiario: 'supervisor',
          nombre,
          nomina_banco: monto,
          valid_from: desde,
          notes: dto.notes ?? null,
          created_by: userId,
          updated_by: userId,
        });
      }
      this.logger.log(`[RD.100] nómina de ${nombre}: $${monto} desde ${desde} por ${userId}`);
    });
    return this.listar();
  }

  // ── Internos ───────────────────────────────────────────────────────────────────────────

  private async escalaVigente(trx: Knex.Transaction, onDate: string): Promise<string> {
    const escala = await trx('commercial.commission_scales')
      .whereNull('deleted_at')
      .where('valid_from', '<=', onDate)
      .andWhere((b: Knex.QueryBuilder) => b.whereNull('valid_to').orWhere('valid_to', '>', onDate))
      .orderBy('valid_from', 'desc').first();
    if (!escala) {
      throw new ConflictException(`No hay tabulador vigente al ${onDate}. Creá la escala primero.`);
    }
    return escala.id as string;
  }
}

export interface SupervisorNomina {
  nombre: string;
  rutas: string[];
  activo: boolean;
  /** `null` = sin configurar a hoy: el motor declara su neto como no calculable. */
  id: string | null;
  nomina_banco: number | null;
  valid_from: string | null;
  notes: string | null;
  updated_at: string | null;
  updated_by: string | null;
  historia: { nomina_banco: number; valid_from: string; valid_to: string | null; notes: string | null }[];
}

export interface FijarNomina {
  nombre: string;
  nomina_banco: number;
  valid_from: string;
  notes?: string | null;
}
