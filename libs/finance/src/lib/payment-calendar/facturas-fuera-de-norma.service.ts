import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantContextService, TenantKnexService, todayMx } from '@megadulces/platform-core';
import {
  ESTADOS_DIA_AUTORIZADO, NOMBRE_DE_LA_REGLA, armarBandejaFueraDeNorma, desdeDeLaBandeja,
  type BandejaFueraDeNorma, type CfdiDeLaBandeja, type DecidirNormaDto, type DecisionTomada, type PagoConLaFactura,
  type RevocarDecisionNormaDto,
} from '@megadulces/contracts';
import { REGLAS_AUTORIZABLES, normaFiscalDelCfdi, type ReglaNorma } from '@megadulces/contracts/finance/norma-fiscal-cfdi';

import { leerCfdiDeFacturas } from './cfdi-factura.sql';
import { sqlDiaDelCfdi } from '../shared/dia-del-cfdi.sql';
import { leerDecisionesNorma } from '../shared/norma-fiscal-autorizaciones.sql';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `[PGP.229]` Las recibidas tipo I no canceladas que PODRÍAN pedir decisión (superconjunto: la regla decide en TS,
 * anexo NF §3 cuidado 3): S01 o régimen ≠ 612 desde `desde`, más las que ya tienen decisión o están en un pago.
 * Parámetros: `[tenant, desde, uuids en minúsculas]`.
 */
export const SQL_CFDIS_DE_LA_BANDEJA = `
SELECT c.uuid::text AS uuid, upper(btrim(c.emisor_rfc)) AS emisor_rfc, c.emisor_nombre,
       nullif(concat_ws('-', nullif(btrim(c.serie), ''), nullif(btrim(c.folio), '')), '') AS serie_folio,
       ${sqlDiaDelCfdi('c')} AS fecha, c.total::float8 AS total, c.metodo_pago, c.forma_pago, c.estatus_sat,
       c.receptor_uso_cfdi, c.receptor_regimen, c.emisor_regimen, c.tipo_comprobante, c.rol
  FROM fiscal.cfdis c
 WHERE c.tenant_id = ? AND c.rol = 'recibidas' AND c.tipo_comprobante = 'I' AND c.estatus_sat IS DISTINCT FROM 'cancelado'
   AND ((c.fecha >= ?::date AND (upper(btrim(c.receptor_uso_cfdi)) = 'S01' OR btrim(c.receptor_regimen) <> '612'))
        OR lower(c.uuid) = ANY(?::text[]))`;

/** Los renglones de pagos del Calendario que todavía no salen (para ligarles su CFDI). Parámetros: `[tenant]`. */
export const SQL_RENGLONES_POR_PAGAR = `
SELECT i.id AS item_id, a.id AS allocation_id, to_char(l.lot_date, 'YYYY-MM-DD') AS fecha, a.folio,
       (a.authorized_at IS NOT NULL OR l.status = ANY(?::text[])) AS autorizado
  FROM finance.payment_allocation_items i
  JOIN finance.payment_allocations a ON a.id = i.allocation_id
  JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
 WHERE a.tenant_id = ? AND a.status = 'pending'
   AND i.obligation_source IN ('supplier_payable', 'kepler_payable')`;

/** Una sola recibida tipo I por UUID (cualquier estatus: la cancelada se dice). Parámetros: `[tenant, uuid en minúsculas]`. */
const SQL_UNA_RECIBIDA = `${SQL_CFDIS_DE_LA_BANDEJA.split('WHERE')[0]}
 WHERE c.tenant_id = ? AND c.rol = 'recibidas' AND c.tipo_comprobante = 'I' AND lower(c.uuid) = ?
 LIMIT 1`;

function motivoValido(v: unknown, que: string): string {
  const m = String(v ?? '').trim().replace(/\s+/g, ' ');
  // Caracteres reales, como `length()` de Postgres (un emoji son dos unidades de JavaScript).
  const n = [...m].length;
  if (n < 3 || n > 300) throw new BadRequestException(`Escribe el motivo ${que} (de 3 a 300 letras): queda para todos`);
  return m;
}

function fechaCorta(iso: string): string {
  return new Date(iso).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * `[PGP.229]` **La bandeja «Facturas fuera de norma»** (anexo NF): lo que espera la decisión de Administración o
 * Contabilidad, y decidir o revocar. La regla vive en `libs/contracts` (`normaFiscalDelCfdi`) y el armado también
 * (`armarBandejaFueraDeNorma`); aquí sólo se lee y se escribe.
 *
 * - Lo que está en un pago del Calendario sale de la MISMA liga que la pantalla del Calendario (`[PGP.108]`,
 *   `leerCfdiDeFacturas`): de cualquier fecha, para que nada de lo que el freno detiene quede sin salida.
 * - Decidir revisa con la regla que esa factura PIDA decisión por esa regla: no se decide lo que no la pide
 *   (el IMSS, la comisión del banco, una cancelada).
 */
@Injectable()
export class FacturasFueraDeNormaService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async bandeja(hoy: string = todayMx()): Promise<BandejaFueraDeNorma> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const decisiones = await leerDecisionesNorma(trx, tenantId, null);
      const pagos = await this.pagosPorUuid(trx, tenantId);
      const uuids = [...new Set([...decisiones.keys(), ...pagos.keys()])];
      const cfdis = (await trx.raw(SQL_CFDIS_DE_LA_BANDEJA, [tenantId, desdeDeLaBandeja(hoy), uuids])).rows as CfdiDeLaBandeja[];
      return armarBandejaFueraDeNorma({ cfdis, decisiones, pagos, hoy, leido_en: new Date().toISOString() });
    });
  }

  async decidir(uuid: string, dto: DecidirNormaDto, quien: string, hoy: string = todayMx()): Promise<DecisionTomada> {
    const tenantId = this.tenantCtx.requireTenantId();
    const u = this.uuid(uuid);
    const regla = dto?.regla as ReglaNorma;
    if (!REGLAS_AUTORIZABLES.has(regla)) throw new BadRequestException('Di qué se decide: el uso S01 o el régimen');
    const decision = dto?.decision;
    if (decision !== 'se_usa' && decision !== 'no_se_usa') throw new BadRequestException('Di si la factura se usa o no se usa');
    const motivo = motivoValido(dto?.motivo, 'de la decisión');
    const actor = this.actor(quien);
    return this.tk.run(async (trx) => {
      const c = (await trx.raw(SQL_UNA_RECIBIDA, [tenantId, u])).rows[0] as CfdiDeLaBandeja | undefined;
      if (!c) throw new NotFoundException('No encuentro esa factura recibida');
      const vivas = (await leerDecisionesNorma(trx, tenantId, [u])).get(u) ?? [];
      const ya = vivas.find((d) => d.regla === regla);
      if (ya) {
        throw new ConflictException(`Ya la decidió ${ya.por} el ${fechaCorta(ya.cuando)} (${ya.decision === 'se_usa' ? 'se usa' : 'no se usa'}): revócala para cambiarla`);
      }
      const norma = normaFiscalDelCfdi({ cfdi: c, uso: 'pago', fecha_operacion: hoy, hoy, autorizaciones: vivas });
      if (norma.motivos.some((m) => m.regla === 'cancelada')) throw new ConflictException('El SAT la tiene cancelada: no se decide, pide la que la sustituye');
      if (!norma.motivos.some((m) => m.regla === regla && m.veredicto === 'requiere_autorizacion')) {
        throw new ConflictException(`Esta factura no pide decisión por ${NOMBRE_DE_LA_REGLA[regla]}`);
      }
      try {
        const [fila] = await trx('finance.cfdi_norm_authorizations').insert({
          tenant_id: tenantId, cfdi_uuid: u, norm_rule: regla, decision, reason: motivo, created_by: actor, updated_by: actor,
        }).returning(['id', 'created_at']);
        return { id: String(fila.id), regla, decision, motivo, por: actor, cuando: new Date(fila.created_at).toISOString() };
      } catch (e: unknown) {
        const code = (e as { code?: string })?.code;
        if (code === '23505') throw new ConflictException('Otra persona la acaba de decidir: vuelve a cargar la bandeja');
        if (code === '23514') throw new BadRequestException('La decisión o el motivo no son válidos');
        throw e;
      }
    });
  }

  async revocar(id: string, dto: RevocarDecisionNormaDto, quien: string): Promise<{ id: string; revocada: true }> {
    const tenantId = this.tenantCtx.requireTenantId();
    const decisionId = this.uuid(id);
    const motivo = motivoValido(dto?.motivo, 'de la revocación');
    const actor = this.actor(quien);
    return this.tk.run(async (trx) => {
      const n = await trx('finance.cfdi_norm_authorizations')
        .where({ tenant_id: tenantId, id: decisionId }).whereNull('revoked_at')
        .update({ revoked_at: trx.fn.now(), revoked_by: actor, revoke_reason: motivo, updated_at: trx.fn.now(), updated_by: actor });
      if (!n) throw new NotFoundException('Esa decisión no existe o ya se revocó');
      return { id: decisionId, revocada: true as const };
    });
  }

  /** Por UUID en minúsculas, los pagos del Calendario que todavía no salen y llevan esa factura. */
  private async pagosPorUuid(trx: Knex.Transaction, tenantId: string): Promise<Map<string, PagoConLaFactura[]>> {
    const renglones = (await trx.raw(SQL_RENGLONES_POR_PAGAR, [[...ESTADOS_DIA_AUTORIZADO], tenantId])).rows as {
      item_id: string; allocation_id: string; fecha: string; folio: string | null; autorizado: boolean;
    }[];
    const out = new Map<string, PagoConLaFactura[]>();
    if (!renglones.length) return out;
    const ligados = await leerCfdiDeFacturas(trx, tenantId, renglones.map((r) => r.item_id));
    for (const r of renglones) {
      const l = ligados.get(r.item_id);
      if (l?.estado !== 'unico' || !l.cfdi) continue;
      const llave = l.cfdi.uuid.toLowerCase();
      const lista = out.get(llave) ?? [];
      if (!lista.some((p) => p.allocation_id === r.allocation_id)) {
        lista.push({ allocation_id: r.allocation_id, fecha: r.fecha, folio: r.folio, autorizado: !!r.autorizado });
      }
      out.set(llave, lista);
    }
    return out;
  }

  private uuid(v: unknown): string {
    const u = String(v ?? '').trim().toLowerCase();
    if (!UUID.test(u)) throw new BadRequestException('El UUID no es válido');
    return u;
  }

  private actor(quien: string): string {
    const a = String(quien ?? '').trim();
    if (!a) throw new BadRequestException('No se sabe quién decide: la sesión no trae usuario');
    return a;
  }
}
