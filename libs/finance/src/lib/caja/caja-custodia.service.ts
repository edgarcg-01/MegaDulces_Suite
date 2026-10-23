import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { SUCURSAL_CAJA_GENERAL, diaDeFecha } from '@megadulces/contracts';
import { traducirErrorDeCaja } from './caja-errores';
import { hoyMx } from './caja-jornadas.query';
import {
  saldoDeRetiro, piernasDeCustodia, saldoPorResponsable,
  type RetiroCaos, type CustodiaRetiro, type EnlaceRetiro, type PiernasCustodia, type SaldoRetiro,
  type DestinoRetiro, type CierreCustodia,
} from './caja-custodia.engine';

/** Tipos de CAOS que usa la custodia. Los mismos de `CAOS` en `cash-cut.service`. */
const TIPO_DEPOSITO = 0;
const TIPO_RETIRO = 4;

/**
 * `[CGA-A.51]` Plazo de una custodia antes de quedar VENCIDA. ⚠️ Decisión pendiente de Edgar
 * (24 / 48 / 72 h): mientras no la tome, 72 h, y la respuesta dice de dónde salió.
 */
export function plazoCustodiaHoras(): { horas: number; origen: 'env' | 'pendiente_de_decidir' } {
  const n = Number(process.env['CAJA_CUSTODIA_PLAZO_HORAS']);
  return Number.isFinite(n) && n > 0 ? { horas: n, origen: 'env' } : { horas: 72, origen: 'pendiente_de_decidir' };
}

/**
 * `[CGA-A.51]` Desde qué jornada un retiro SIN clasificar frena el corte. Sin fecha, no frena
 * nada: prenderlo sin la pantalla de clasificar dejaría a la caja sin poder cerrar ningún día.
 * La fecha la decide Edgar (día de arranque, con arqueo completo a dos personas).
 */
export function arranqueCustodia(): string | null {
  const d = String(process.env['CAJA_CUSTODIA_DESDE'] ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/**
 * `[CGA-A.51]` Lo que le queda a un movimiento de CAOS (alias `m`): lo que salió menos lo ya
 * enlazado. UNA sola expresión para las consultas que ofrecen retiros — si cada una la escribiera
 * a su modo, una ofrecería lo que la otra ya consumió.
 */
export function sqlDisponibleCaos(m = 'm'): string {
  return `(abs(${m}.total) - coalesce((SELECT sum(abs(k.monto_enlazado)) FROM finance.caos_cash_links k
      WHERE k.tenant_id = ${m}.tenant_id AND k.caos_device = ${m}.device
        AND k.caos_external_id = ${m}.external_id AND k.deleted_at IS NULL), 0))`;
}

/** `[CGA-A.51]` El movimiento (alias `m`) es una custodia ya cerrada: no recibe más gastos. */
export function sqlCustodiaCerrada(m = 'm'): string {
  return `EXISTS (SELECT 1 FROM finance.caos_retiro_custodia c
      WHERE c.tenant_id = ${m}.tenant_id AND c.caos_device = ${m}.device
        AND c.caos_external_id = ${m}.external_id AND c.deleted_at IS NULL AND c.cierre_tipo IS NOT NULL)`;
}

/** `[CGA-A.51]` El movimiento (alias `m`) ya está clasificado (cajón o custodia). */
export function sqlRetiroClasificado(m = 'm'): string {
  return `EXISTS (SELECT 1 FROM finance.caos_retiro_custodia c
      WHERE c.tenant_id = ${m}.tenant_id AND c.caos_device = ${m}.device
        AND c.caos_external_id = ${m}.external_id AND c.deleted_at IS NULL)`;
}

export interface ClasificarRetiroInput {
  device: string;
  external_id: number;
  destino: DestinoRetiro;
  /** Quién se lo lleva. Si no viene, el operador que lo sacó de la máquina. */
  responsable?: string | null;
  nota?: string | null;
}

export interface CerrarCustodiaInput {
  tipo: CierreCustodia;
  /** Sólo `regreso_caos`: el depósito de la máquina que lo regresó. Su monto es el del cierre. */
  deposito_external_id?: number | null;
  nota?: string | null;
}

export interface RetiroConSaldo extends SaldoRetiro {
  custodia_id: string | null;
  dia: string;
  at: string;
  operador: string | null;
  ref: string | null;
  destino: DestinoRetiro | null;
  cierre: CustodiaRetiro['cierre'];
}

export interface CustodiaListado {
  desde: string;
  hasta: string;
  plazo_horas: number;
  plazo_origen: 'env' | 'pendiente_de_decidir';
  /** `null` = el freno del corte está apagado (no hay día de arranque). */
  arranque: string | null;
  /** `false` si la migración todavía no está aplicada: no se dibuja como «nada a cargo». */
  medido: boolean;
  retiros: RetiroConSaldo[];
  por_responsable: ReturnType<typeof saldoPorResponsable>;
}

interface Usuario { id?: string; username?: string }

const r2 = (n: number): number => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * ⭐ `[CGA-A.51]` El retiro de CAOS que se lleva una persona: clasificarlo, verlo con lo que le
 * queda, y cerrarlo. La aritmética vive en `caja-custodia.engine.ts` (ADR-101); acá se lee, se
 * llama y se escribe.
 *
 * ⛔ Dos reglas que no viven en la base porque dependen del CORTE, no de la fila:
 *   · un retiro no se clasifica si el corte de su jornada ya cerró (ese corte ya lo contó como
 *     cajón, y cambiarlo después movería una cifra firmada);
 *   · un sobrante no se entrega al cajón si el corte de HOY ya cerró.
 */
@Injectable()
export class CajaCustodiaService {
  private readonly logger = new Logger(CajaCustodiaService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private conFrase<T>(p: Promise<T>): Promise<T> {
    return p.catch((e: unknown) => traducirErrorDeCaja(e));
  }

  private requireUser(u: Usuario | null | undefined): { id: string; username: string | null } {
    if (!u?.id) throw new BadRequestException('No se pudo identificar quién hace el movimiento.');
    return { id: u.id, username: u.username ?? null };
  }

  /** ¿Existe la tabla? El código puede ir por delante de su migración. */
  static async hayCustodia(trx: Knex | Knex.Transaction): Promise<boolean> {
    const r = await trx.raw(`SELECT to_regclass('finance.caos_retiro_custodia') AS t`);
    return !!r.rows?.[0]?.t;
  }

  /** ¿El corte de la Caja General de ese día ya está cerrado? */
  private async corteCerrado(trx: Knex.Transaction, tenantId: string, dia: string): Promise<string | null> {
    const c = await trx('finance.cash_ledger_cuts')
      .where({ tenant_id: tenantId, sucursal: SUCURSAL_CAJA_GENERAL })
      .whereRaw('fecha = ?::date', [dia])
      .whereNot('estado', 'borrador')
      .first('folio');
    return c?.folio ?? null;
  }

  // ── Lectura ───────────────────────────────────────────────────────────────────────────────

  /**
   * Los retiros de un rango, con su clasificación y lo que le queda a cada uno. Los retiros en
   * custodia que siguen abiertos entran SIEMPRE, aunque sean de antes del rango: una deuda vieja
   * no desaparece porque se mire otra semana.
   */
  async listar(q: { from?: string; to?: string } = {}): Promise<CustodiaListado> {
    const tenantId = this.tenantCtx.requireTenantId();
    const plazo = plazoCustodiaHoras();
    return this.tk.run(async (trx) => {
      const hoy = await hoyMx(trx);
      const hasta = diaDeFecha(q.to) ?? hoy;
      const desde = diaDeFecha(q.from) ?? hasta;
      const base = { desde, hasta, plazo_horas: plazo.horas, plazo_origen: plazo.origen, arranque: arranqueCustodia() };
      if (!(await CajaCustodiaService.hayCustodia(trx))) {
        return { ...base, medido: false, retiros: [], por_responsable: [] };
      }
      const filas = await trx('analytics.caos_cash_movements as m')
        .leftJoin('finance.caos_retiro_custodia as c', function (this: Knex.JoinClause) {
          this.on('c.tenant_id', 'm.tenant_id').andOn('c.caos_device', 'm.device')
            .andOn('c.caos_external_id', 'm.external_id').andOnNull('c.deleted_at');
        })
        .where('m.tenant_id', tenantId).where('m.type_id', TIPO_RETIRO)
        .where((b: Knex.QueryBuilder) => b
          .whereRaw(`coalesce(m.accounting_date, (m.occurred_at AT TIME ZONE 'America/Mexico_City')::date) BETWEEN ?::date AND ?::date`, [desde, hasta])
          .orWhere((o: Knex.QueryBuilder) => o.where('c.destino', 'custodia').whereNull('c.cierre_tipo')))
        .orderBy('m.occurred_at', 'desc')
        .select(
          'm.device', 'm.external_id', 'm.total', 'm.ref', 'm.user_external', 'm.occurred_at',
          trx.raw(`to_char(coalesce(m.accounting_date, (m.occurred_at AT TIME ZONE 'America/Mexico_City')::date), 'YYYY-MM-DD') AS dia`),
          'c.id as custodia_id', 'c.destino', 'c.responsable', 'c.cierre_tipo', 'c.cierre_monto',
          trx.raw(`to_char(c.cierre_dia, 'YYYY-MM-DD') AS cierre_dia`), 'c.cierre_caos_external_id',
        );
      const { retiros, custodias } = aHechos(filas);
      const enlaces = await enlacesDe(trx, tenantId, retiros);
      const ahora = new Date().toISOString();
      const porLlave = new Map(custodias.map((c) => [`${c.device}|${c.external_id}`, c]));
      const conSaldo: RetiroConSaldo[] = retiros.map((r, i) => {
        const c = porLlave.get(`${r.device}|${r.external_id}`) ?? null;
        return {
          ...saldoDeRetiro(r, c, enlaces, ahora, plazo.horas),
          custodia_id: filas[i].custodia_id ?? null, dia: r.dia, at: r.at, operador: r.operador,
          ref: filas[i].ref ?? null, destino: c?.destino ?? null, cierre: c?.cierre ?? null,
        };
      });
      return { ...base, medido: true, retiros: conSaldo, por_responsable: saldoPorResponsable(conSaldo) };
    });
  }

  /** Ver `piernasDeCustodiaDeLaJornada`: el corte la llama sin inyectar este servicio. */
  piernasDeLaJornada(trx: Knex.Transaction, tenantId: string, dia: string): Promise<PiernasCustodia | null> {
    return piernasDeCustodiaDeLaJornada(trx, tenantId, dia);
  }

  // ── Escritura ─────────────────────────────────────────────────────────────────────────────

  /** A dónde fue un retiro. Se puede corregir mientras no tenga gastos ni cierre y su corte siga abierto. */
  async clasificar(input: ClasificarRetiroInput, user: Usuario): Promise<{ custodia_id: string }> {
    const u = this.requireUser(user);
    const tenantId = this.tenantCtx.requireTenantId();
    if (input?.destino !== 'cajon' && input?.destino !== 'custodia') {
      throw new BadRequestException('El destino del retiro es «cajon» o «custodia».');
    }
    const externalId = Number(input.external_id);
    if (!input.device || !Number.isFinite(externalId)) throw new BadRequestException('Falta el retiro de CAOS (equipo y número).');

    return this.conFrase(this.tk.run(async (trx) => {
      if (!(await CajaCustodiaService.hayCustodia(trx))) {
        throw new ConflictException('La custodia de retiros todavía no está instalada en esta base (migración 20261023162138).');
      }
      await this.candado(trx, tenantId, input.device, externalId);
      const m = await trx('analytics.caos_cash_movements')
        .where({ tenant_id: tenantId, device: input.device, external_id: externalId })
        .first('type_id', 'user_external', trx.raw(`to_char(coalesce(accounting_date, (occurred_at AT TIME ZONE 'America/Mexico_City')::date), 'YYYY-MM-DD') AS dia`));
      if (!m) throw new NotFoundException('Ese movimiento de CAOS no existe (o todavía no llega del equipo).');
      if (Number(m.type_id) !== TIPO_RETIRO) throw new BadRequestException('Sólo un retiro (Dispensar) de CAOS se clasifica.');
      const folio = await this.corteCerrado(trx, tenantId, m.dia);
      if (folio) {
        throw new BadRequestException(`El corte de ese día (${folio}) ya cerró y contó este retiro como efectivo del cajón: ya no se reclasifica.`);
      }
      const responsable = input.destino === 'custodia'
        ? (String(input.responsable ?? '').trim() || m.user_external || '')
        : null;
      if (input.destino === 'custodia' && !responsable) {
        throw new BadRequestException('Un retiro a cargo de alguien necesita el nombre de esa persona.');
      }

      const viva = await trx('finance.caos_retiro_custodia')
        .where({ tenant_id: tenantId, caos_device: input.device, caos_external_id: externalId })
        .whereNull('deleted_at').forUpdate().first();
      if (viva) {
        if (viva.cierre_tipo) throw new BadRequestException('Ese retiro ya se cerró: no se reclasifica.');
        const conGastos = await trx('finance.caos_cash_links')
          .where({ tenant_id: tenantId, caos_device: input.device, caos_external_id: externalId })
          .whereNull('deleted_at').first('id');
        if (conGastos && viva.destino === 'custodia' && input.destino === 'cajon') {
          throw new BadRequestException('Ese retiro ya tiene gastos pagados con él: suéltalos antes de mandarlo al cajón.');
        }
        await trx('finance.caos_retiro_custodia').where({ id: viva.id }).update({
          destino: input.destino, responsable, nota: input.nota?.trim() || viva.nota,
          updated_by: u.id, updated_at: trx.fn.now(),
        });
        return { custodia_id: viva.id as string };
      }
      const [c] = await trx('finance.caos_retiro_custodia').insert({
        tenant_id: tenantId, caos_device: input.device, caos_external_id: externalId,
        destino: input.destino, responsable, nota: input.nota?.trim() || null,
        created_by: u.id, created_by_username: u.username,
      }).returning('id');
      this.logger.log(`[CGA-A.51] retiro ${input.device}|${externalId} → ${input.destino}${responsable ? ` a cargo de ${responsable}` : ''}`);
      return { custodia_id: String((c as { id?: string } | undefined)?.id ?? c) };
    }));
  }

  /**
   * Cierra una custodia. El monto NO se teclea: es lo que le queda al retiro (o, en un regreso a
   * CAOS, lo que contó la máquina en ese depósito, que tiene que ser exactamente lo que le queda).
   */
  async cerrar(custodiaId: string, input: CerrarCustodiaInput, user: Usuario): Promise<{ custodia_id: string; tipo: CierreCustodia; monto: number; dia: string }> {
    const u = this.requireUser(user);
    const tenantId = this.tenantCtx.requireTenantId();
    const tipo = input?.tipo;
    if (tipo !== 'regreso_caos' && tipo !== 'cajon' && tipo !== 'faltante') {
      throw new BadRequestException('Una custodia se cierra regresando a CAOS, entregando al cajón, o como faltante.');
    }
    if (tipo === 'faltante' && String(input.nota ?? '').trim().length < 12) {
      throw new BadRequestException('Un faltante necesita decir qué pasó (al menos 12 caracteres).');
    }

    return this.conFrase(this.tk.run(async (trx) => {
      if (!(await CajaCustodiaService.hayCustodia(trx))) {
        throw new ConflictException('La custodia de retiros todavía no está instalada en esta base (migración 20261023162138).');
      }
      const c0 = await trx('finance.caos_retiro_custodia').where({ tenant_id: tenantId, id: custodiaId }).whereNull('deleted_at').first();
      if (!c0) throw new NotFoundException('Esa custodia no existe.');
      // El mismo candado que toman los enlaces: nadie carga un gasto mientras se cierra.
      await this.candado(trx, tenantId, c0.caos_device, Number(c0.caos_external_id));
      const c = await trx('finance.caos_retiro_custodia').where({ id: custodiaId }).forUpdate().first();
      if (c.destino !== 'custodia') throw new BadRequestException('Ese retiro fue al cajón: no hay custodia que cerrar.');
      if (c.cierre_tipo) throw new BadRequestException('Esa custodia ya está cerrada.');

      const m = await trx('analytics.caos_cash_movements')
        .where({ tenant_id: tenantId, device: c.caos_device, external_id: c.caos_external_id }).first('total');
      const enlazado = await trx('finance.caos_cash_links as k')
        .join('finance.cash_ledger as l', 'l.id', 'k.cash_ledger_id')
        .where({ 'k.tenant_id': tenantId, 'k.caos_device': c.caos_device, 'k.caos_external_id': c.caos_external_id })
        .whereNull('k.deleted_at').whereNull('l.deleted_at').whereNot('l.estado', 'cancelado')
        .first(trx.raw('coalesce(sum(abs(k.monto_enlazado)), 0) AS s'));
      const queda = r2(Math.abs(Number(m?.total ?? 0)) - Number(enlazado?.s ?? 0));
      if (queda <= 0.005) throw new BadRequestException('A ese retiro no le queda nada: ya se explicó entero con sus gastos.');

      const hoy = await hoyMx(trx);
      let monto = queda;
      let depositoId: number | null = null;
      if (tipo === 'regreso_caos') {
        depositoId = Number(input.deposito_external_id);
        if (!Number.isFinite(depositoId)) throw new BadRequestException('Falta el depósito de CAOS con el que regresó.');
        const d = await trx('analytics.caos_cash_movements')
          .where({ tenant_id: tenantId, device: c.caos_device, external_id: depositoId })
          .first('type_id', 'total', trx.raw(`to_char(coalesce(accounting_date, (occurred_at AT TIME ZONE 'America/Mexico_City')::date), 'YYYY-MM-DD') AS dia`));
        if (!d || Number(d.type_id) !== TIPO_DEPOSITO) throw new BadRequestException('Ese movimiento de CAOS no es un depósito.');
        if (Math.abs(Math.abs(Number(d.total)) - queda) > 0.005) {
          throw new BadRequestException(
            `El depósito trae $${Math.abs(Number(d.total)).toFixed(2)} y al retiro le quedan $${queda.toFixed(2)}. El regreso tiene que ser exacto; si no, cierra la diferencia al cajón o como faltante.`);
        }
        const hayAtribucion = !!(await trx.raw(`SELECT to_regclass('finance.caos_ingreso_atribucion') AS t`)).rows?.[0]?.t;
        const yaUsado = hayAtribucion && await trx('finance.caos_ingreso_atribucion')
          .where({ tenant_id: tenantId, caos_device: c.caos_device, caos_external_id: depositoId })
          .whereNull('deleted_at').first('id');
        if (yaUsado) {
          throw new BadRequestException('Ese depósito ya se repartió a cobros de Kepler: no puede ser el regreso de un retiro. Al depositar un regreso, pon «regreso» en la referencia de CAOS.');
        }
        monto = r2(Math.abs(Number(d.total)));
        // El regreso entra al corte del día en que la MÁQUINA lo recibió.
        return this.escribirCierre(trx, c.id, tipo, monto, d.dia, depositoId, input.nota, u);
      }
      if (tipo === 'cajon') {
        const folio = await this.corteCerrado(trx, tenantId, hoy);
        if (folio) throw new BadRequestException(`El corte de hoy (${folio}) ya cerró: el sobrante se entrega al cajón en la jornada abierta.`);
      }
      return this.escribirCierre(trx, c.id, tipo, monto, hoy, null, input.nota, u);
    }));
  }

  private async escribirCierre(
    trx: Knex.Transaction, id: string, tipo: CierreCustodia, monto: number, dia: string,
    depositoId: number | null, nota: string | null | undefined, u: { id: string; username: string | null },
  ) {
    await trx('finance.caos_retiro_custodia').where({ id }).update({
      cierre_tipo: tipo, cierre_monto: monto, cierre_dia: dia, cierre_caos_external_id: depositoId,
      cierre_nota: nota?.trim() || null, cerrado_by: u.id, cerrado_by_username: u.username,
      cerrado_at: trx.fn.now(), updated_by: u.id, updated_at: trx.fn.now(),
    });
    this.logger.log(`[CGA-A.51] custodia ${id} cerrada: ${tipo} $${monto.toFixed(2)} (${dia})`);
    return { custodia_id: id, tipo, monto, dia };
  }

  /** El MISMO candado de aviso que toma `finance.caos_link_no_excede()`. */
  private async candado(trx: Knex.Transaction, tenantId: string, device: string, externalId: number): Promise<void> {
    await trx.raw(`SELECT pg_advisory_xact_lock(hashtextextended(?::text || '|' || ?::text || '|' || ?::text, 50))`,
      [tenantId, device, String(externalId)]);
  }
}

/** Una fila de las consultas de retiros (movimiento de CAOS + su clasificación, si tiene). */
interface FilaRetiro {
  device: string; external_id: string | number; total: string | number; ref: string | null;
  user_external: string | null; occurred_at: string | Date; dia: string;
  custodia_id: string | null; destino: DestinoRetiro | null; responsable: string | null;
  cierre_tipo: CierreCustodia | null; cierre_monto: string | number | null; cierre_dia: string | null;
  cierre_caos_external_id: string | number | null;
}

/** Filas de la consulta → los hechos del motor. */
function aHechos(filas: FilaRetiro[]): { retiros: RetiroCaos[]; custodias: CustodiaRetiro[] } {
  const retiros: RetiroCaos[] = [];
  const custodias: CustodiaRetiro[] = [];
  for (const f of filas) {
    const external_id = Number(f.external_id);
    retiros.push({
      device: f.device, external_id, total: Number(f.total), dia: f.dia,
      at: new Date(f.occurred_at).toISOString(), operador: f.user_external ?? null,
    });
    if (f.destino) {
      custodias.push({
        device: f.device, external_id, destino: f.destino, responsable: f.responsable ?? null,
        cierre: f.cierre_tipo ? {
          tipo: f.cierre_tipo, monto: Number(f.cierre_monto), dia: f.cierre_dia ?? '',
          deposito_external_id: f.cierre_caos_external_id != null ? Number(f.cierre_caos_external_id) : null,
        } : null,
      });
    }
  }
  return { retiros, custodias };
}

/** Los enlaces vivos de esos retiros, con la jornada del GASTO. */
async function enlacesDe(trx: Knex.Transaction, tenantId: string, retiros: RetiroCaos[]): Promise<EnlaceRetiro[]> {
  if (!retiros.length) return [];
  const ids = retiros.map((r) => r.external_id);
  const rows = await trx('finance.caos_cash_links as k')
    .join('finance.cash_ledger as l', 'l.id', 'k.cash_ledger_id')
    .where('k.tenant_id', tenantId).whereNull('k.deleted_at')
    .whereNull('l.deleted_at').whereNot('l.estado', 'cancelado')
    .whereIn('k.caos_external_id', ids)
    .select('k.caos_device', 'k.caos_external_id', 'k.cash_ledger_id', 'k.monto_enlazado',
      trx.raw(`to_char(l.fecha, 'YYYY-MM-DD') AS dia_gasto`));
  return rows.map((k: { caos_device: string; caos_external_id: string | number; cash_ledger_id: string; monto_enlazado: string | number; dia_gasto: string }) => ({
    device: k.caos_device, external_id: Number(k.caos_external_id), cash_ledger_id: k.cash_ledger_id,
    monto: Number(k.monto_enlazado), dia_gasto: k.dia_gasto,
  }));
}

/**
 * Las cuatro piernas que el CORTE de una jornada necesita (ver `piernasDeCustodia`). `null` si
 * la tabla no existe: el corte queda exactamente como en `[CG.96]`.
 */
export async function piernasDeCustodiaDeLaJornada(trx: Knex.Transaction, tenantId: string, dia: string): Promise<PiernasCustodia | null> {
  if (!(await CajaCustodiaService.hayCustodia(trx))) return null;
  // Los retiros de la jornada + los retiros en custodia que tienen un gasto o un cierre ese día.
  const filas = await trx('analytics.caos_cash_movements as m')
    .leftJoin('finance.caos_retiro_custodia as c', function (this: Knex.JoinClause) {
      this.on('c.tenant_id', 'm.tenant_id').andOn('c.caos_device', 'm.device')
        .andOn('c.caos_external_id', 'm.external_id').andOnNull('c.deleted_at');
    })
    .where('m.tenant_id', tenantId).where('m.type_id', TIPO_RETIRO)
    .where((b: Knex.QueryBuilder) => b
      .whereRaw(`m.accounting_date = ?::date`, [dia])
      .orWhereRaw(`c.cierre_dia = ?::date`, [dia])
      .orWhereExists((s: Knex.QueryBuilder) => s.select(trx.raw('1'))
        .from('finance.caos_cash_links as k').join('finance.cash_ledger as l', 'l.id', 'k.cash_ledger_id')
        .whereRaw(`k.tenant_id = m.tenant_id AND k.caos_device = m.device AND k.caos_external_id = m.external_id
           AND k.deleted_at IS NULL AND l.deleted_at IS NULL AND l.estado <> 'cancelado' AND l.fecha = ?::date`, [dia])))
    .select(
      'm.device', 'm.external_id', 'm.total', 'm.ref', 'm.user_external', 'm.occurred_at',
      trx.raw(`to_char(m.accounting_date, 'YYYY-MM-DD') AS dia`),
      'c.id as custodia_id', 'c.destino', 'c.responsable', 'c.cierre_tipo', 'c.cierre_monto',
      trx.raw(`to_char(c.cierre_dia, 'YYYY-MM-DD') AS cierre_dia`), 'c.cierre_caos_external_id',
    );
  const { retiros, custodias } = aHechos(filas);
  const enlaces = await enlacesDe(trx, tenantId, retiros);
  return piernasDeCustodia(dia, retiros, custodias, enlaces);
}
