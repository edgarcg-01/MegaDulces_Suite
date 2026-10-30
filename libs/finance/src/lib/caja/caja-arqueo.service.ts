import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import {
  SUCURSAL_CAJA_GENERAL,
  type ApartadoEnCaja, type ArqueoCajaDto, type ArqueoGuardadoDto, type DocumentosEnCajaDto,
  type NuevoArqueoCajaInput, type ResumenApartado, type TipoDocumentoCaja,
} from '@megadulces/contracts';
import {
  validarArqueo, validarDocumentos, resumenDocumentos, totalArqueo, puedeRecontarCorte,
  TEXTO_ARQUEO_INVALIDO, TEXTO_DOCUMENTO_INVALIDO, TEXTO_NO_RECUENTA_CORTE, type FilaDocumento,
} from './caja-arqueo.engine';
import { traducirErrorDeCaja } from './caja-errores';
import {
  hayDocumentosDeArqueo, huellaDeDocumentosDeMovimiento, piezasEnCaja,
} from './caja-arqueo-documentos.query';

interface Usuario { id?: string; username?: string }

const n = (v: unknown): number | null => (v == null ? null : Number(v));
const r2 = (x: number): number => Math.round(x * 100) / 100;

/** Un renglón de `analytics.v_caja_arqueos` en la forma de la API. */
export function aArqueoDto(r: Record<string, unknown>): ArqueoCajaDto {
  const base = {
    efectivo: Number(r['efectivo'] ?? 0),
    caja_fuerte: n(r['caja_fuerte']), cheques: n(r['cheques']), papeles: n(r['papeles']),
    usd: n(r['usd']), tipo_cambio: n(r['tipo_cambio']),
  };
  const dia = r['dia'] instanceof Date ? (r['dia'] as Date).toISOString().slice(0, 10) : String(r['dia'] ?? '').slice(0, 10);
  return {
    origen: r['origen'] === 'control' ? 'control' : 'suite',
    folio: String(r['folio']),
    at: new Date(r['at'] as string).toISOString(),
    dia,
    tipo: r['tipo'] as ArqueoCajaDto['tipo'],
    completo: r['completo'] === true,
    ...base,
    tipo_cambio_fuente: (r['tipo_cambio_fuente'] ?? null) as string | null,
    quien: (r['quien'] ?? null) as string | null,
    corte_id: (r['corte_id'] ?? null) as string | null,
    nota: (r['nota'] ?? null) as string | null,
    total_mxn: totalArqueo(base),
  };
}

/**
 * ⭐ `[CGS.45]` **El arqueo completo de la caja en la Suite** — lo que contaba el Access de Control,
 * jubilado el 2026-10-22 (Edgar: «lo jubilemos de por vida»).
 *
 * Dos usos: el **recuento** de la supervisora cada mañana, a ciegas, del corte que cerró la caja
 * (decisión de Edgar del 22-oct), y el **arqueo intermedio** a cualquier hora. Los dos cuentan los
 * cinco rubros: efectivo pieza por pieza, caja fuerte, cheques, vales y papeles, y dólares.
 *
 * ⛔ Ciego: el recuento no ve lo que selló el corte hasta guardar. Contar viendo la cifra a la que
 * hay que llegar no es contar.
 *
 * ⭐ `[CGS.59]` Los cheques y los papeles se cuentan **uno por uno**: lo que había en el último
 * arqueo que contó su apartado se marca (sigue o salió, y por qué) y lo nuevo entra con su detalle.
 * Su importe es la suma de los renglones que están; la base lo vuelve a comprobar al confirmar.
 *
 * Servicio aparte de `CashCutService` a propósito: el corte ya carga su propio ciclo, y esto sólo
 * LEE el corte que se recuenta.
 */
@Injectable()
export class CajaArqueoService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Los arqueos, de la Suite y del histórico de Control, del más nuevo al más viejo. */
  async listar(q: { limit?: number }): Promise<{ rows: ArqueoCajaDto[]; limit: number; fuente: string }> {
    const limit = Math.min(Math.max(Number(q?.limit) || 30, 1), 200);
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      if (!(await this.hayVista(trx))) return { rows: [], limit, fuente: 'analytics.v_caja_arqueos (no existe en este entorno)' };
      const rows: Array<Record<string, unknown>> = await trx('analytics.v_caja_arqueos').orderBy('at', 'desc').limit(limit);
      return { rows: rows.map(aArqueoDto), limit, fuente: 'analytics.v_caja_arqueos' };
    });
  }

  /**
   * `[CGS.59]` Lo que la pantalla pide marcar al contar: los cheques y los papeles que estaban en el
   * último arqueo que contó cada apartado, y la llave (`base`) contra dos conteos a la vez.
   */
  async documentosEnCaja(): Promise<DocumentosEnCajaDto> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const vacio: ApartadoEnCaja = { desde: null, piezas: [], sin_detalle: null };
      if (!(await hayDocumentosDeArqueo(trx))) return { instalado: false, base: null, cheques: vacio, papeles: vacio };
      const control = await this.ultimoDeControl(trx);
      return {
        instalado: true,
        base: await this.llave(trx, tenantId),
        cheques: await this.apartado(trx, tenantId, 'cheque', control),
        papeles: await this.apartado(trx, tenantId, 'papel', control),
      };
    });
  }

  async registrar(body: Partial<NuevoArqueoCajaInput>, user: Usuario): Promise<ArqueoGuardadoDto> {
    if (!user?.id) throw new BadRequestException('No se pudo identificar quién contó.');
    const v = validarArqueo(body);
    if (!v.ok) throw new BadRequestException(TEXTO_ARQUEO_INVALIDO[v.motivo]);
    const a = v.arqueo;
    const tenantId = this.tenantCtx.requireTenantId();
    const docs = body.documentos ?? null;
    const cuentaDocumentos = !!docs && (docs.cheques != null || docs.papeles != null);

    return this.tk.run(async (trx) => {
      let corte: Record<string, unknown> | undefined;
      if (a.corte_id) {
        corte = await trx('finance.cash_ledger_cuts').where({ tenant_id: tenantId, id: a.corte_id }).first();
        if (!corte) throw new NotFoundException('El corte que se quiere recontar no existe.');
        if (a.tipo === 'recuento') {
          const gate = puedeRecontarCorte(corte as { estado: string; created_by?: string | null; closed_by?: string | null }, user.id!);
          if (!gate.ok) throw new ForbiddenException(TEXTO_NO_RECUENTA_CORTE[gate.motivo]);
        }
      }

      // ── `[CGS.59]` Los apartados, contra lo que había ──────────────────────────────────────
      let filas: FilaDocumento[] = [];
      const resumen: { cheques: ResumenApartado | null; papeles: ResumenApartado | null } = { cheques: null, papeles: null };
      if (cuentaDocumentos && docs) {
        if (!(await hayDocumentosDeArqueo(trx))) {
          throw new BadRequestException('Los cheques y papeles uno por uno todavía no están instalados en esta base (falta la migración [CGS.59]).');
        }
        // Dos arqueos a la vez se forman: el segundo ve lo que guardó el primero, o se rechaza.
        // `[CGS.60]` Lo mismo si mientras tanto entró o salió un cheque o papel con un movimiento.
        await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 59))', [`cash_arqueos:${tenantId}`]);
        if ((docs.base ?? null) !== (await this.llave(trx, tenantId))) {
          throw new ConflictException('Alguien guardó un arqueo o movió un cheque o papel mientras contabas: vuelve a abrir «Contar la caja» para ver lo que hay ahora.');
        }
        const control = await this.ultimoDeControl(trx);
        for (const [tipo, entrada, campo] of [['cheque', docs.cheques, 'cheques'], ['papel', docs.papeles, 'papeles']] as const) {
          const ap = await this.apartado(trx, tenantId, tipo, control);
          const r = validarDocumentos(tipo, ap.piezas, entrada);
          if (!r.ok) throw new BadRequestException(TEXTO_DOCUMENTO_INVALIDO[r.motivo]);
          a[campo] = r.total;
          if (r.total !== null) resumen[campo] = resumenDocumentos(r.filas, r.total);
          filas = filas.concat(r.filas);
        }
      }

      const [r] = await trx('finance.cash_arqueos').insert({
        tenant_id: tenantId,
        sucursal: (corte?.['sucursal'] as string | undefined) ?? SUCURSAL_CAJA_GENERAL,
        tipo: a.tipo,
        corte_id: a.corte_id,
        piezas: JSON.stringify(a.piezas),
        morralla: a.morralla,
        efectivo: a.efectivo,
        caja_fuerte: a.caja_fuerte,
        caja_fuerte_fuente: a.caja_fuerte_fuente,
        cheques: a.cheques,
        papeles: a.papeles,
        usd: a.usd,
        tipo_cambio: a.tipo_cambio,
        tipo_cambio_fuente: a.tipo_cambio_fuente,
        nota: a.nota,
        created_by: user.id,
        created_by_username: user.username ?? null,
      }).returning('*');

      if (filas.length) {
        await trx('finance.cash_arqueo_documentos').insert(filas.map((f) => ({
          tenant_id: tenantId,
          arqueo_id: r.id,
          pieza: f.pieza ?? randomUUID(),
          tipo: f.tipo,
          clase: f.clase,
          estado: f.estado,
          salida: f.salida,
          salida_nota: f.salida_nota,
          monto: f.monto,
          banco: f.banco,
          numero: f.numero,
          de_quien: f.de_quien,
          concepto: f.concepto,
          fecha: f.fecha,
          created_by: user.id,
          created_by_username: user.username ?? null,
        })));
      }
      // La regla «el importe es la suma de sus renglones» es un trigger diferido: se comprueba aquí
      // y no al confirmar, para que un rechazo salga con su frase y no como un error de COMMIT.
      await trx.raw('SET CONSTRAINTS ALL IMMEDIATE');

      const arqueo = aArqueoDto({
        ...r, origen: 'suite', folio: r.id, at: r.counted_at,
        dia: (await trx.raw(`SELECT to_char((?::timestamptz AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS d`, [r.counted_at])).rows[0].d,
        completo: r.caja_fuerte != null && r.cheques != null && r.papeles != null && r.usd != null,
        quien: r.created_by_username,
      });
      // Recién ahora se revela contra qué se comparó.
      const contra_corte = a.tipo === 'recuento' && corte
        ? {
          folio: String(corte['folio']),
          contado: n(corte['contado']),
          diferencia: corte['contado'] == null ? null : Math.round((a.efectivo - Number(corte['contado'])) * 100) / 100,
        }
        : null;
      return { arqueo, contra_corte, documentos: resumen };
    }).catch((e: unknown) => {
      if (e instanceof HttpException) throw e;
      return traducirErrorDeCaja(e);
    });
  }

  private async hayVista(trx: Knex.Transaction): Promise<boolean> {
    return (await trx.raw(`SELECT to_regclass('analytics.v_caja_arqueos') IS NOT NULL AS t`)).rows[0]?.t === true;
  }

  /**
   * La llave contra dos conteos a la vez: el último arqueo de la Suite (de cualquier apartado) y,
   * `[CGS.60]`, la huella de los movimientos con cheques o papeles. Si cualquiera cambió entre abrir
   * y guardar, la lista de «lo que había» ya no es la de ahora.
   */
  private async llave(trx: Knex.Transaction, tenantId: string): Promise<string | null> {
    const r = await trx('finance.cash_arqueos').where({ tenant_id: tenantId })
      .orderBy([{ column: 'counted_at', order: 'desc' }, { column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
      .first('id');
    const huella = await huellaDeDocumentosDeMovimiento(trx, tenantId);
    if (!r && !huella) return null;
    return `${r ? String(r.id) : ''}|${huella}`;
  }

  /** El último arqueo de Control (histórico congelado), si la réplica existe en este entorno. */
  private async ultimoDeControl(trx: Knex.Transaction): Promise<{ at: string; cheques: number | null; papeles: number | null } | null> {
    if (!(await this.hayVista(trx))) return null;
    const r = (await trx.raw(`SELECT at, cheques, papeles FROM analytics.v_caja_arqueos
                                WHERE origen = 'control' ORDER BY at DESC LIMIT 1`)).rows[0];
    return r ? { at: new Date(r.at).toISOString(), cheques: n(r.cheques), papeles: n(r.papeles) } : null;
  }

  /**
   * `[CGS.59]` Lo que hay en un apartado: los renglones que ESTÁN en el último arqueo de la Suite
   * que lo contó, cada uno con el día en que se vio por primera vez, y `[CGS.60]` lo que entró o salió
   * después con un movimiento. Lo declarado sin detalle (un arqueo de antes de los renglones, o
   * Control si la Suite nunca lo contó) se devuelve aparte para mostrarlo, no para arrastrarlo.
   */
  private async apartado(trx: Knex.Transaction, tenantId: string, tipo: TipoDocumentoCaja,
    control: { at: string; cheques: number | null; papeles: number | null } | null): Promise<ApartadoEnCaja> {
    const campo = tipo === 'cheque' ? 'cheques' : 'papeles';
    const { ultimo, propios, piezas } = await piezasEnCaja(trx, tenantId, tipo);
    if (!ultimo) {
      const deControl = control?.[campo];
      return {
        desde: null, piezas,
        sin_detalle: deControl != null && deControl > 0 && control ? { monto: deControl, origen: 'control', at: control.at } : null,
      };
    }
    const suma = r2(propios.reduce((s, p) => s + p.monto, 0));
    return {
      desde: { arqueo_id: ultimo.id, at: ultimo.counted_at, quien: ultimo.quien },
      piezas,
      // Un arqueo guardado antes de los renglones declara un importe sin detalle.
      sin_detalle: Math.abs(ultimo.total - suma) > 0.005 ? { monto: ultimo.total, origen: 'suite', at: ultimo.counted_at } : null,
    };
  }
}
