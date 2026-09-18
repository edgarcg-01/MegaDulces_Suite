import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { buildFolio } from './caja-autofill.engine';

/**
 * CG.13 — El libro de caja. La plataforma como FUENTE PRINCIPAL del efectivo (ADR-070).
 *
 * Sustituye la captura de `Doctos` del Access `Control`. Lo que este servicio garantiza y
 * aquel no podía:
 *
 *   · El folio sale de una secuencia ATÓMICA de Postgres dentro de la misma transacción del
 *     INSERT. El Access lo calculaba con `DMax("IdDocto")+1` en el cliente, sin bloqueo, con
 *     5 capturistas sobre el mismo `.mdb` → 34 folios repetidos MEDIDOS.
 *   · El par (cuenta, concepto) de Kepler se VALIDA contra el catálogo vivo del ODS antes de
 *     guardar, y se guarda también el NOMBRE como snapshot: si mañana Kepler renombra el
 *     concepto, el movimiento viejo conserva lo que decía cuando se capturó.
 *   · El arqueo cuadra o no se guarda: `sum(denominación × piezas) + morralla = monto`.
 *
 * ⚠️ `TenantKnexService.run()` es obligatorio — las tablas tienen RLS FORZADO y una query
 * fuera de ese scope devuelve 0 filas sin error.
 */

export interface ConceptQuery { sucursal?: string; search?: string; limit?: number }

export interface LedgerQuery {
  from?: string; to?: string; tipo?: string; sucursal?: string;
  cuenta?: string; search?: string; limit?: number; offset?: number;
}

export interface DenominationInput { denominacion: number; piezas: number }

export interface CreateMovementInput {
  tipo: 'ingreso' | 'gasto' | 'deposito';
  fecha: string;
  hora?: string;
  sucursal: string;
  centro_costo?: string;
  kepler_cuenta: string;
  kepler_concepto: string;
  glosa: string;
  beneficiario?: string;
  beneficiario_rfc?: string;
  monto: number;
  morralla?: number;
  denominaciones?: DenominationInput[];
  origen_tipo?: string;
  origen_ref?: string;
  origen_uuid?: string;
  autofill?: Record<string, unknown>;
  client_uuid?: string;
  legacy_cuenta_access?: string;
}

/** Tolerancia del cuadre del arqueo: un centavo, por el redondeo de numeric. */
const ARQUEO_EPSILON = 0.005;

@Injectable()
export class CashLedgerService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Catálogo de conceptos para el selector de la captura. Lee la vista derivada del ODS
   * (`analytics.v_kepler_conceptos`), que NO tiene RLS → filtro de tenant explícito.
   *
   * El concepto es POR SUCURSAL a propósito: hay pares (cuenta, concepto) con nombre distinto
   * entre plazas, así que buscar sin sucursal devolvería nombres que no son los de su plaza.
   */
  async conceptos(q: ConceptQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    return this.tk.run(async (trx) => {
      let qb = trx('analytics.v_kepler_conceptos')
        .where('tenant_id', tenantId)
        .select('sucursal', 'cuenta', 'concepto', 'concepto_nombre', 'cuenta_mayor');
      if (q.sucursal) qb = qb.where('sucursal', q.sucursal);
      if (q.search) {
        const s = `%${q.search.trim()}%`;
        qb = qb.where((b: any) => b.whereILike('concepto_nombre', s).orWhereILike('cuenta', s).orWhereILike('concepto', s));
      }
      const rows = await qb.orderBy(['cuenta', 'concepto']).limit(limit);
      return { rows, limit };
    });
  }

  /**
   * Cobertura del catálogo y del mapa. Va a la pantalla SIEMPRE: sin esto, "0 conceptos"
   * (carril caído) es indistinguible de "no hay conceptos" (ADR-056).
   */
  async coverage() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const catalogo = await trx('analytics.v_kepler_conceptos_coverage')
        .where('tenant_id', tenantId)
        .select('sucursal', 'filas_origen', 'usables', 'sin_subcuenta', 'sin_codigo', 'sin_nombre')
        .orderBy('sucursal');
      const mapa = await trx('finance.v_caja_concept_map_coverage').select('*');
      return { catalogo, mapa };
    });
  }

  /** Resuelve el par contra el catálogo vivo. Devuelve los nombres para el snapshot. */
  private async resolveConcept(trx: any, tenantId: string, sucursal: string, cuenta: string, concepto: string) {
    const row = await trx('analytics.v_kepler_conceptos')
      .where({ tenant_id: tenantId, sucursal, cuenta, concepto })
      .first('cuenta', 'concepto', 'concepto_nombre', 'cuenta_mayor');
    if (!row) {
      throw new BadRequestException(
        `El par cuenta/concepto ${cuenta}/${concepto} no existe en el catálogo de Kepler para la sucursal ${sucursal}. `
        + 'No se guarda un movimiento con una cuenta que la contabilidad no reconoce.',
      );
    }
    const acc = await trx('finance.kepler_accounts')
      .where({ tenant_id: tenantId, cuenta })
      .first('cuenta_nombre');
    return { concepto_nombre: row.concepto_nombre as string, cuenta_nombre: (acc?.cuenta_nombre ?? null) as string | null };
  }

  /** Consecutivo atómico por (tenant, año, tipo). Corre DENTRO de la trx del INSERT. */
  private async nextFolio(trx: any, tenantId: string, tipo: string, year: number): Promise<string> {
    const r = await trx.raw(
      `INSERT INTO finance.cash_ledger_sequences (tenant_id, year, tipo, current_value)
       VALUES (?, ?, ?, 1)
       ON CONFLICT (tenant_id, year, tipo) DO UPDATE
         SET current_value = finance.cash_ledger_sequences.current_value + 1, updated_at = now()
       RETURNING current_value`,
      [tenantId, year, tipo],
    );
    return buildFolio(tipo, year, r.rows[0].current_value);
  }

  /** El arqueo cuadra o no se guarda. Que no cuadre es un error del capturista, no un aviso. */
  private assertArqueo(monto: number, morralla: number, dens: DenominationInput[]) {
    if (!dens?.length) return;
    const suma = dens.reduce((a, d) => a + Number(d.denominacion) * Number(d.piezas), 0) + Number(morralla || 0);
    const dif = Math.abs(suma - Number(monto));
    if (dif > ARQUEO_EPSILON) {
      throw new BadRequestException(
        `El desglose no cuadra con el monto: ${suma.toFixed(2)} contra ${Number(monto).toFixed(2)} (diferencia ${dif.toFixed(2)}).`,
      );
    }
  }

  /**
   * Registra un movimiento. TODO en una transacción: folio, validación del par contable,
   * cabecera y denominaciones. Si algo falla, el consecutivo tampoco avanza.
   */
  async create(input: CreateMovementInput, user: { id?: string; username?: string }) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!user?.id) {
      // §5.6 — el Access dejaba capturar como "Auxiliar": 1,625 movimientos sin persona.
      throw new BadRequestException('No se pudo identificar al usuario que captura.');
    }
    const dens = input.denominaciones ?? [];
    this.assertArqueo(input.monto, input.morralla ?? 0, dens);

    return this.tk.run(async (trx) => {
      // Idempotencia: el reintento del cliente devuelve el movimiento que ya se guardó,
      // no un 409 ni un duplicado.
      if (input.client_uuid) {
        const prev = await trx('finance.cash_ledger')
          .where({ tenant_id: tenantId, client_uuid: input.client_uuid }).first();
        if (prev) return { ...prev, idempotent_replay: true };
      }

      const snap = await this.resolveConcept(trx, tenantId, input.sucursal, input.kepler_cuenta, input.kepler_concepto);
      const year = Number(String(input.fecha).slice(0, 4));
      const folio = await this.nextFolio(trx, tenantId, input.tipo, year);

      const [mov] = await trx('finance.cash_ledger').insert({
        tenant_id: tenantId,
        folio,
        tipo: input.tipo,
        client_uuid: input.client_uuid ?? null,
        fecha: input.fecha,
        hora: input.hora ?? null,
        sucursal: input.sucursal,
        centro_costo: input.centro_costo ?? null,
        kepler_cuenta: input.kepler_cuenta,
        kepler_concepto: input.kepler_concepto,
        kepler_cuenta_nombre: snap.cuenta_nombre,
        kepler_concepto_nombre: snap.concepto_nombre,
        glosa: input.glosa,
        beneficiario: input.beneficiario ?? null,
        beneficiario_rfc: input.beneficiario_rfc ?? null,
        monto: input.monto,
        morralla: input.morralla ?? 0,
        origen_tipo: input.origen_tipo ?? null,
        origen_ref: input.origen_ref ?? null,
        origen_uuid: input.origen_uuid ?? null,
        autofill: input.autofill ? JSON.stringify(input.autofill) : null,
        legacy_cuenta_access: input.legacy_cuenta_access ?? null,
        created_by: user.id,
        created_by_username: user.username ?? null,
      }).returning('*');

      if (dens.length) {
        await trx('finance.cash_ledger_denominations').insert(
          dens.map((d) => ({ tenant_id: tenantId, cash_ledger_id: mov.id, denominacion: d.denominacion, piezas: d.piezas })),
        );
      }
      return mov;
    });
  }

  /** Lista paginada con KPIs del mismo filtro — el encabezado no puede contar otra cosa. */
  async list(q: LedgerQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    const offset = Math.max(Number(q.offset) || 0, 0);

    return this.tk.run(async (trx) => {
      const base = () => {
        let qb = trx('finance.cash_ledger').where('tenant_id', tenantId).whereNull('deleted_at');
        if (q.from) qb = qb.where('fecha', '>=', q.from);
        if (q.to) qb = qb.where('fecha', '<=', q.to);
        if (q.tipo) qb = qb.where('tipo', q.tipo);
        if (q.sucursal) qb = qb.where('sucursal', q.sucursal);
        if (q.cuenta) qb = qb.where('kepler_cuenta', q.cuenta);
        if (q.search) {
          const s = `%${q.search.trim()}%`;
          qb = qb.where((b: any) => b.whereILike('glosa', s).orWhereILike('beneficiario', s).orWhereILike('folio', s));
        }
        return qb;
      };

      const rows = await base()
        .orderBy([{ column: 'fecha', order: 'desc' }, { column: 'folio', order: 'desc' }])
        .limit(limit).offset(offset);

      const [kpi] = await base().select(
        trx.raw(`count(*)::int AS movimientos`),
        trx.raw(`coalesce(sum(monto) FILTER (WHERE tipo='ingreso'),0)::numeric AS ingresos`),
        trx.raw(`coalesce(sum(monto) FILTER (WHERE tipo='gasto'),0)::numeric AS gastos`),
        trx.raw(`coalesce(sum(monto) FILTER (WHERE tipo='deposito'),0)::numeric AS depositos`),
      );

      return { rows, kpi, limit, offset, has_more: rows.length === limit };
    });
  }

  async detail(id: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const mov = await trx('finance.cash_ledger').where({ tenant_id: tenantId, id }).first();
      if (!mov) throw new NotFoundException('Movimiento no encontrado');
      const denominaciones = await trx('finance.cash_ledger_denominations')
        .where({ tenant_id: tenantId, cash_ledger_id: id })
        .orderBy('denominacion', 'desc')
        .select('denominacion', 'piezas');
      const desglosado = denominaciones.reduce((a: number, d: any) => a + Number(d.denominacion) * Number(d.piezas), 0)
        + Number(mov.morralla || 0);
      return {
        ...mov,
        denominaciones,
        // El cuadre viaja con el detalle: la pantalla no lo recalcula por su cuenta.
        arqueo: denominaciones.length
          ? { desglosado, diferencia: Number((desglosado - Number(mov.monto)).toFixed(2)) }
          : null,
      };
    });
  }
}
