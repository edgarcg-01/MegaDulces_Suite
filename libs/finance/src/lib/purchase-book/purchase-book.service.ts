import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * Fase LC (ADR-052) — El trámite mensual del libro de compras.
 *
 * Antes: la contadora armaba un Excel a mano, lo convertía a TXT y lo subía a ContPAQi.
 * No quedaba registro de qué se entregó ni cuándo, y por eso julio y agosto de 2026 se
 * cayeron sin que nadie lo notara hasta mirar la balanza.
 *
 * Ahora el trámite se lleva aquí y a ContPAQi solo va el TXT:
 *   1. se ve el mes con sus facturas y su cuadre
 *   2. se decide qué entra (mientras LC.2 siga abierto, lo decide una persona)
 *   3. se genera el archivo, que queda firmado por su hash
 *   4. se marca entregado y, cuando se confirma contra la póliza real, aplicado
 *
 * **No escribimos en ContPAQi** (ADR-040): esto produce un archivo, el trámite de subirlo
 * lo sigue haciendo contabilidad.
 */

/** Cuentas de impuesto acreditable — son fijas, no dependen del proveedor. */
const CTA_IVA = '1470040000';
const CTA_IEPS = '1470110000';
/** ContPAQi: 3 = Diario. Verificado contra su catálogo `TiposPolizas`. */
const TIPO_POLIZA_DIARIO = '3';

export type ImpuestosModo = 'global' | 'por-cuenta';
export type EstadoRun = 'borrador' | 'generado' | 'entregado' | 'aplicado' | 'cancelado';

export interface FacturaMes {
  uuid: string;
  emisor_rfc: string;
  emisor_nombre: string;
  serie: string | null;
  folio: string | null;
  fecha: string;
  total: number;
  iva: number;
  ieps: number;
  /** Subtotal de lo gravado a 16%, NETO de descuento. Ver `subtotal_iva_16` del feed. */
  subtotal16: number;
  /** Lo que va a la cuenta de compras exentas, por diferencia contra el total. */
  base_exenta: number;
  ieps_por_cuota: boolean;
  account_suffix: string | null;
  supplier_name: string | null;
  cuenta_proveedor: string | null;
  cuenta_compra_exenta: string | null;
  cuenta_compra_iva: string | null;
  cuenta_existe: boolean;
  incluida: boolean;
  motivo_exclusion: string | null;
  /** Ya está asociada a una póliza en ContPAQi, según el ADD. */
  aso_contabilidad: boolean | null;
}

export interface Movimiento {
  cuenta: string;
  referencia: string;
  abono: boolean;
  importe: number;
  concepto: string;
}

const r2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;
const padR = (s: unknown, n: number) => String(s ?? '').slice(0, n).padEnd(n, ' ');
const padL = (s: unknown, n: number) => String(s ?? '').slice(0, n).padStart(n, ' ');
/** ContPAQi pide entre 1 y 2 decimales: `6.5` y `6.53` valen, `6` no. */
const impTxt = (n: number) => (Number.isInteger(r2(n)) ? `${r2(n)}.0` : r2(n).toFixed(2));

@Injectable()
export class PurchaseBookService {
  private readonly logger = new Logger(PurchaseBookService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly ctx: TenantContextService,
  ) {}

  private mesValido(anioMes: string) {
    if (!/^\d{4}-\d{2}$/.test(anioMes || '')) throw new BadRequestException('mes inválido, se espera YYYY-MM');
    return anioMes;
  }

  /** Último día del mes: el asiento siempre va fechado ahí. */
  private finDeMes(anioMes: string): Date {
    const [y, m] = anioMes.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0));
  }

  // ── El tablero: en qué va cada mes ────────────────────────────────────────────────────
  /**
   * Un renglón por mes con CFDIs recibidos, aunque nunca se haya armado la póliza. Así
   * un mes sin trámite se ve como hueco en vez de desaparecer de la lista, que es
   * justamente lo que pasó con julio y agosto.
   */
  async listMeses(limit = 24) {
    return this.tk.run(async (knex) => {
      const { rows } = await knex.raw(
        `WITH meses AS (
           SELECT to_char(fecha, 'YYYY-MM') AS anio_mes,
                  count(*)      AS cfdis,
                  sum(total)    AS total_cfdis
             FROM fiscal.cfdis
            WHERE tenant_id = current_tenant_id()
              AND source = 'contpaqi_add' AND tipo_comprobante = 'I'
            GROUP BY 1
         )
         SELECT m.anio_mes, m.cfdis, m.total_cfdis,
                r.id AS run_id, r.estado, r.facturas, r.renglones, r.total_cargos,
                r.generado_at, r.entregado_at, r.aplicado_at, r.archivo_hash,
                p.patas_en_contpaqi, p.total_en_contpaqi
           FROM meses m
           LEFT JOIN finance.purchase_book_runs r
             ON r.tenant_id = current_tenant_id() AND r.anio_mes = m.anio_mes AND r.deleted_at IS NULL
           LEFT JOIN LATERAL (
             SELECT count(*) AS patas_en_contpaqi,
                    sum(importe) FILTER (WHERE cargo_abono = 'A') AS total_en_contpaqi
               FROM analytics.gl_poliza_lines l
              WHERE l.tenant_id = current_tenant_id() AND l.source = 'contpaqi'
                AND l.tipo_pol = ? AND l.folio = '1' AND l.anio_mes = m.anio_mes
           ) p ON true
          ORDER BY m.anio_mes DESC
          LIMIT ?`,
        [TIPO_POLIZA_DIARIO, limit],
      );
      return rows.map((r: Record<string, unknown>) => ({
        anio_mes: r['anio_mes'],
        cfdis: Number(r['cfdis']),
        total_cfdis: r2(r['total_cfdis']),
        estado: (r['estado'] as string) ?? 'sin_iniciar',
        run_id: r['run_id'],
        facturas: r['facturas'] ? Number(r['facturas']) : null,
        renglones: r['renglones'] ? Number(r['renglones']) : null,
        total_cargos: r['total_cargos'] ? r2(r['total_cargos']) : null,
        generado_at: r['generado_at'], entregado_at: r['entregado_at'], aplicado_at: r['aplicado_at'],
        // Lo que ContPAQi tiene HOY para ese mes. Si está en cero y el mes tiene CFDIs,
        // la póliza no existe — es la señal que faltaba.
        patas_en_contpaqi: Number(r['patas_en_contpaqi'] ?? 0),
        total_en_contpaqi: r2(r['total_en_contpaqi']),
      }));
    });
  }

  // ── El mes: sus facturas y su cuadre ──────────────────────────────────────────────────
  async getMes(anioMes: string): Promise<{ mes: string; run: Record<string, unknown> | null; facturas: FacturaMes[]; resumen: Record<string, number>; bloqueantes: string[]; avisos: string[] }> {
    this.mesValido(anioMes);
    return this.tk.run(async (knex) => {
      const run = await knex('finance.purchase_book_runs')
        .where({ anio_mes: anioMes }).whereNull('deleted_at').first();

      // Un RFC puede tener más de una cuenta en el mapa; DISTINCT ON evita duplicar la
      // factura por el join. Se prefiere la cuenta que ya se usó en pólizas reales.
      const { rows } = await knex.raw(
        `SELECT DISTINCT ON (upper(f.uuid))
                upper(f.uuid) AS uuid, f.emisor_rfc, f.emisor_nombre, f.serie, f.folio,
                f.fecha, f.total,
                coalesce((f.impuestos->>'iva_trasladado')::numeric, 0)  AS iva,
                coalesce((f.impuestos->>'ieps_trasladado')::numeric, 0) AS ieps,
                coalesce((f.impuestos->>'subtotal_iva_16')::numeric, 0) AS subtotal16,
                (f.impuestos->'traslados' @> '[{"tipo_factor":"Cuota"}]') AS ieps_por_cuota,
                a.account_suffix, a.supplier_name, a.cuenta_proveedor,
                a.cuenta_compra_exenta, a.cuenta_compra_iva,
                coalesce(a.proveedor_existe, false) AS cuenta_existe,
                i.incluida, i.motivo
           FROM fiscal.cfdis f
           LEFT JOIN finance.gl_supplier_accounts a
             ON a.tenant_id = f.tenant_id AND a.rfc = f.emisor_rfc AND a.deleted_at IS NULL
           LEFT JOIN finance.purchase_book_run_items i
             ON i.tenant_id = f.tenant_id AND i.run_id = ? AND i.cfdi_uuid = upper(f.uuid)
          WHERE f.tenant_id = current_tenant_id()
            AND f.source = 'contpaqi_add' AND f.tipo_comprobante = 'I'
            AND to_char(f.fecha, 'YYYY-MM') = ?
          ORDER BY upper(f.uuid), a.usado_en_asiento DESC NULLS LAST, a.account_suffix`,
        [run?.id ?? null, anioMes],
      );

      const facturas: FacturaMes[] = rows.map((r: Record<string, unknown>) => {
        const total = r2(r['total']), iva = r2(r['iva']), ieps = r2(r['ieps']);
        const subtotal16 = r2(r['subtotal16']);
        return {
          uuid: String(r['uuid']),
          emisor_rfc: String(r['emisor_rfc'] ?? ''),
          emisor_nombre: String(r['emisor_nombre'] ?? ''),
          serie: (r['serie'] as string) ?? null,
          folio: (r['folio'] as string) ?? null,
          fecha: String(r['fecha']).slice(0, 10),
          total, iva, ieps, subtotal16,
          base_exenta: r2(total - iva - ieps - subtotal16),
          ieps_por_cuota: r['ieps_por_cuota'] === true,
          account_suffix: (r['account_suffix'] as string) ?? null,
          supplier_name: (r['supplier_name'] as string) ?? null,
          cuenta_proveedor: (r['cuenta_proveedor'] as string) ?? null,
          cuenta_compra_exenta: (r['cuenta_compra_exenta'] as string) ?? null,
          cuenta_compra_iva: (r['cuenta_compra_iva'] as string) ?? null,
          cuenta_existe: r['cuenta_existe'] === true,
          // Default: entra si su proveedor está en el catálogo de compras. Es lo único que
          // hoy sabemos del criterio con evidencia — las 1,555 facturas de ene–jun del
          // libro son 100% de proveedores del catálogo (cobertura total). NO es suficiente
          // (hay 2,068 CFDIs más de esos mismos proveedores que no entraron), por eso la
          // decisión final la sigue tomando una persona; pero arrancar con las 645 de gasto
          // y servicio marcadas dejaría el mes bloqueado desde el primer clic.
          // Cuando LC.2 responda, este default se reemplaza por la regla real.
          incluida: r['incluida'] === null || r['incluida'] === undefined
            ? r['cuenta_existe'] === true
            : r['incluida'] === true,
          motivo_exclusion: (r['motivo'] as string) ?? null,
          aso_contabilidad: null,
        };
      });

      const dentro = facturas.filter((f) => f.incluida);
      const resumen = {
        cfdis_del_mes: facturas.length,
        incluidas: dentro.length,
        excluidas: facturas.length - dentro.length,
        total: r2(dentro.reduce((a, f) => a + f.total, 0)),
        subtotal_exento: r2(dentro.reduce((a, f) => a + f.base_exenta, 0)),
        subtotal_gravado: r2(dentro.reduce((a, f) => a + f.subtotal16, 0)),
        iva: r2(dentro.reduce((a, f) => a + f.iva, 0)),
        ieps: r2(dentro.reduce((a, f) => a + f.ieps, 0)),
        total_todas: r2(facturas.reduce((a, f) => a + f.total, 0)),
      };

      // Dos listas distintas, y la diferencia importa: los BLOQUEANTES son renglones que
      // ContPAQi rechazaría, así que apagan el botón de generar. Los AVISOS son cosas que
      // merecen una mirada pero se postean sin problema. Mezclarlos deja el mes trabado
      // por una nota informativa, que es justo lo que pasó con "IEPS por cuota" en julio.
      const bloqueantes: string[] = [];
      const avisos: string[] = [];
      const sinMapa = dentro.filter((f) => !f.account_suffix);
      const ctaMala = dentro.filter((f) => f.account_suffix && !f.cuenta_existe);
      const sinCta502 = dentro.filter((f) => f.subtotal16 > 0.004 && !f.cuenta_compra_iva);
      const negativas = dentro.filter((f) => f.base_exenta < -0.004);
      const cuota = dentro.filter((f) => f.ieps_por_cuota);
      if (sinMapa.length) bloqueantes.push(`${sinMapa.length} factura(s) de un RFC que no está en el mapa de cuentas`);
      if (ctaMala.length) bloqueantes.push(`${ctaMala.length} factura(s) con una cuenta que no existe en ContPAQi`);
      if (sinCta502.length) bloqueantes.push(`${sinCta502.length} factura(s) con base gravada pero sin cuenta de compras c/IVA`);
      if (negativas.length) bloqueantes.push(`${negativas.length} factura(s) con base exenta negativa — revisar descuentos`);
      if (cuota.length) avisos.push(`${cuota.length} factura(s) con IEPS por cuota: el Excel las capturaba en cero`);

      return { mes: anioMes, run: run ?? null, facturas, resumen, bloqueantes, avisos };
    });
  }

  // ── Decidir qué entra ─────────────────────────────────────────────────────────────────
  /** Excluye (o vuelve a incluir) facturas del mes. Mientras LC.2 esté abierto, esto es
   *  el criterio: lo pone una persona y queda registrado con su motivo. */
  async setInclusion(anioMes: string, uuids: string[], incluida: boolean, motivo?: string) {
    this.mesValido(anioMes);
    if (!Array.isArray(uuids) || !uuids.length) throw new BadRequestException('sin facturas que marcar');
    const userId = this.ctx.get()?.userId ?? null;
    return this.tk.run(async (knex) => {
      const run = await this.ensureRun(knex, anioMes);
      if (run.estado === 'aplicado') throw new BadRequestException('el mes ya está aplicado; no se puede cambiar');
      const filas = uuids.map((u) => ({
        tenant_id: run.tenant_id, run_id: run.id, cfdi_uuid: String(u).toUpperCase(),
        incluida, motivo: incluida ? null : (motivo ?? null), origen: 'manual', created_by: userId,
      }));
      await knex('finance.purchase_book_run_items').insert(filas)
        .onConflict(['tenant_id', 'run_id', 'cfdi_uuid'])
        .merge(['incluida', 'motivo', 'origen']);
      // Cambió el contenido: lo generado antes ya no corresponde.
      if (run.estado === 'generado') {
        await knex('finance.purchase_book_runs').where({ id: run.id })
          .update({ estado: 'borrador', archivo_hash: null, updated_at: knex.fn.now(), updated_by: userId });
      }
      return { ok: true, afectadas: filas.length };
    });
  }

  private async ensureRun(knex: any, anioMes: string) {
    const existente = await knex('finance.purchase_book_runs')
      .where({ anio_mes: anioMes }).whereNull('deleted_at').first();
    if (existente) return existente;
    const [creado] = await knex('finance.purchase_book_runs')
      .insert({
        tenant_id: knex.raw('current_tenant_id()'), anio_mes: anioMes, estado: 'borrador',
        folio_poliza: 1, fecha_poliza: this.finDeMes(anioMes).toISOString().slice(0, 10),
        concepto: `REGISTRO DE COMPRAS DEL MES ${anioMes}`,
        created_by: this.ctx.get()?.userId ?? null,
      })
      .returning('*');
    return creado;
  }

  // ── El archivo ────────────────────────────────────────────────────────────────────────
  /**
   * Arma los movimientos del asiento. Por factura: cargo a compras exentas, cargo a
   * compras c/IVA y abono al proveedor. Los impuestos, global o por cuenta.
   *
   * Cuidado con dos cosas que ya costaron caro:
   *  - lo que va a la cuenta `502` es el SUBTOTAL gravado, no la base fiscal del IVA —
   *    esa base incluye al IEPS y lo contaría dos veces;
   *  - ese subtotal va NETO de descuento, o la base exenta sale negativa.
   */
  construirMovimientos(facturas: FacturaMes[], modo: ImpuestosModo, conUuid: boolean): Movimiento[] {
    const movs: Movimiento[] = [];
    const ivaPorCuenta = new Map<string, number>();
    const iepsPorCuenta = new Map<string, number>();

    for (const f of [...facturas].sort((a, b) => (a.fecha < b.fecha ? -1 : 1))) {
      const ref = String(f.folio ?? '').slice(0, 10);
      const concepto = conUuid ? f.uuid : '';
      if (f.base_exenta > 0.004) {
        movs.push({ cuenta: f.cuenta_compra_exenta!, referencia: ref, abono: false, importe: f.base_exenta, concepto });
      }
      if (f.subtotal16 > 0.004) {
        movs.push({ cuenta: f.cuenta_compra_iva!, referencia: ref, abono: false, importe: f.subtotal16, concepto });
      }
      movs.push({ cuenta: f.cuenta_proveedor!, referencia: ref, abono: true, importe: f.total, concepto });
      if (f.iva > 0.004) ivaPorCuenta.set(f.account_suffix!, r2((ivaPorCuenta.get(f.account_suffix!) ?? 0) + f.iva));
      if (f.ieps > 0.004) iepsPorCuenta.set(f.account_suffix!, r2((iepsPorCuenta.get(f.account_suffix!) ?? 0) + f.ieps));
    }

    if (modo === 'por-cuenta') {
      for (const [suf, monto] of [...ivaPorCuenta].sort()) {
        movs.push({ cuenta: CTA_IVA, referencia: suf, abono: false, importe: monto, concepto: 'IVA acreditable' });
      }
      for (const [suf, monto] of [...iepsPorCuenta].sort()) {
        movs.push({ cuenta: CTA_IEPS, referencia: suf, abono: false, importe: monto, concepto: 'IEPS acreditable' });
      }
    } else {
      const iva = r2([...ivaPorCuenta.values()].reduce((a, b) => a + b, 0));
      const ieps = r2([...iepsPorCuenta.values()].reduce((a, b) => a + b, 0));
      if (iva > 0.004) movs.push({ cuenta: CTA_IVA, referencia: '', abono: false, importe: iva, concepto: '' });
      if (ieps > 0.004) movs.push({ cuenta: CTA_IEPS, referencia: '', abono: false, importe: ieps, concepto: '' });
    }
    return movs;
  }

  /** Layout de longitud fija de ContPAQi. Ver el detalle en el doc de la fase. */
  construirTxt(anioMes: string, folio: number, concepto: string, movs: Movimiento[]): string {
    const d = this.finDeMes(anioMes);
    const fecha = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    const header = [
      padR('P', 2), padL(fecha, 8), padL(TIPO_POLIZA_DIARIO, 4), padL(String(folio), 9), padL('1', 1),
      padR('0', 10), padR(concepto, 100), padL('11', 2), padL('0', 1), padL('0', 1),
    ].join(' ');
    const lineas = movs.map((m) => [
      padR('M', 2), padR(m.cuenta, 30), padR(m.referencia, 10), padL(m.abono ? '1' : '0', 1),
      padR(impTxt(m.importe), 20), padR('0', 10), padR('0.0', 20), padR(m.concepto, 100), padR('', 10),
    ].join(' '));
    return [header, ...lineas].join('\r\n') + '\r\n';
  }

  /** Genera el archivo del mes y deja la corrida en `generado`, firmada por su hash. */
  async generar(anioMes: string, opts: { impuestos?: ImpuestosModo; uuid?: boolean } = {}) {
    this.mesValido(anioMes);
    const modo: ImpuestosModo = opts.impuestos === 'por-cuenta' ? 'por-cuenta' : 'global';
    const conUuid = opts.uuid !== false;
    const { facturas, resumen, bloqueantes } = await this.getMes(anioMes);
    const dentro = facturas.filter((f) => f.incluida);
    if (!dentro.length) throw new BadRequestException('el mes no tiene facturas incluidas');

    // Frenos duros: mejor no entregar archivo que entregar uno que ContPAQi va a rechazar.
    const rechazables = dentro.filter((f) => !f.account_suffix || !f.cuenta_existe
      || (f.subtotal16 > 0.004 && !f.cuenta_compra_iva) || f.base_exenta < -0.004);
    if (rechazables.length) {
      throw new BadRequestException(
        `${rechazables.length} factura(s) no se pueden postear: ${bloqueantes.join(' · ')}. Resuélvelo o exclúyelas.`,
      );
    }

    const movs = this.construirMovimientos(dentro, modo, conUuid);
    const cargos = r2(movs.filter((m) => !m.abono).reduce((a, m) => a + m.importe, 0));
    const abonos = r2(movs.filter((m) => m.abono).reduce((a, m) => a + m.importe, 0));
    if (Math.abs(r2(cargos - abonos)) >= 0.01) {
      throw new BadRequestException(`la póliza no cuadra: cargos ${cargos} vs abonos ${abonos}`);
    }

    return this.tk.run(async (knex) => {
      const run = await this.ensureRun(knex, anioMes);
      if (run.estado === 'aplicado') throw new BadRequestException('el mes ya está aplicado');
      const concepto = run.concepto || `REGISTRO DE COMPRAS DEL MES ${anioMes}`;
      const txt = this.construirTxt(anioMes, run.folio_poliza ?? 1, concepto, movs);
      const hash = createHash('sha256').update(txt, 'latin1').digest('hex');
      const nombre = `poliza-compras-${anioMes}.txt`;
      const userId = this.ctx.get()?.userId ?? null;

      await knex('finance.purchase_book_runs').where({ id: run.id }).update({
        estado: 'generado', facturas: dentro.length, renglones: movs.length + 1,
        total_cargos: cargos, total_abonos: abonos,
        subtotal_exento: resumen['subtotal_exento'], subtotal_gravado: resumen['subtotal_gravado'],
        total_iva: resumen['iva'], total_ieps: resumen['ieps'],
        archivo_hash: hash, archivo_nombre: nombre,
        impuestos_modo: modo, incluye_uuid: conUuid,
        generado_at: knex.fn.now(), generado_by: userId,
        updated_at: knex.fn.now(), updated_by: userId,
      });
      this.logger.log(`Póliza ${anioMes}: ${dentro.length} facturas · ${movs.length} movimientos · ${cargos}`);
      return { anio_mes: anioMes, nombre, hash, facturas: dentro.length, renglones: movs.length + 1, cargos, abonos, txt };
    });
  }

  /** Mueve el trámite. `entregado` = se le pasó a quien lo sube; `aplicado` = ya está en ContPAQi. */
  async marcar(anioMes: string, estado: Extract<EstadoRun, 'entregado' | 'aplicado' | 'cancelado'>, datos: { entregado_a?: string; notas?: string } = {}) {
    this.mesValido(anioMes);
    return this.tk.run(async (knex) => {
      const run = await knex('finance.purchase_book_runs')
        .where({ anio_mes: anioMes }).whereNull('deleted_at').first();
      if (!run) throw new NotFoundException(`no hay corrida para ${anioMes}`);
      if (estado !== 'cancelado' && run.estado === 'borrador') {
        throw new BadRequestException('genera el archivo antes de mover el trámite');
      }
      const userId = this.ctx.get()?.userId ?? null;
      const patch: Record<string, unknown> = { estado, updated_at: knex.fn.now(), updated_by: userId };
      if (estado === 'entregado') { patch['entregado_at'] = knex.fn.now(); patch['entregado_by'] = userId; patch['entregado_a'] = datos.entregado_a ?? null; }
      if (estado === 'aplicado') { patch['aplicado_at'] = knex.fn.now(); patch['aplicado_by'] = userId; }
      if (datos.notas) patch['notas'] = datos.notas;
      await knex('finance.purchase_book_runs').where({ id: run.id }).update(patch);
      return { ok: true, anio_mes: anioMes, estado };
    });
  }

  /**
   * LC.7 — compara lo que se entregó contra la póliza que quedó en ContPAQi. Se compara
   * el multiset `(cuenta, cargo/abono, importe)`: si algo se editó a mano al subirlo,
   * aparece aquí.
   */
  async cuadrarContraContpaqi(anioMes: string) {
    this.mesValido(anioMes);
    const { facturas } = await this.getMes(anioMes);
    return this.tk.run(async (knex) => {
      const run = await knex('finance.purchase_book_runs')
        .where({ anio_mes: anioMes }).whereNull('deleted_at').first();
      const dentro = facturas.filter((f) => f.incluida && f.account_suffix && f.cuenta_existe);
      const movs = this.construirMovimientos(dentro, (run?.impuestos_modo as ImpuestosModo) ?? 'global', false);

      const { rows } = await knex.raw(
        `SELECT cuenta, cargo_abono, importe FROM analytics.gl_poliza_lines
          WHERE tenant_id = current_tenant_id() AND source = 'contpaqi'
            AND tipo_pol = ? AND folio = ? AND anio_mes = ?`,
        [TIPO_POLIZA_DIARIO, String(run?.folio_poliza ?? 1), anioMes],
      );

      const clave = (c: string, ab: string, i: number) => `${c}|${ab}|${Math.round(i * 100)}`;
      const gen = new Map<string, number>(); const real = new Map<string, number>();
      movs.forEach((m) => { const k = clave(m.cuenta, m.abono ? 'A' : 'C', m.importe); gen.set(k, (gen.get(k) ?? 0) + 1); });
      rows.forEach((m: Record<string, unknown>) => {
        const k = clave(String(m['cuenta']), String(m['cargo_abono']), Number(m['importe']));
        real.set(k, (real.get(k) ?? 0) + 1);
      });
      let casan = 0, soloNuestro = 0, soloContpaqi = 0;
      for (const k of new Set([...gen.keys(), ...real.keys()])) {
        const g = gen.get(k) ?? 0, a = real.get(k) ?? 0;
        casan += Math.min(g, a); soloNuestro += Math.max(0, g - a); soloContpaqi += Math.max(0, a - g);
      }
      return {
        anio_mes: anioMes,
        patas_nuestras: movs.length,
        patas_en_contpaqi: rows.length,
        casan, solo_nuestro: soloNuestro, solo_contpaqi: soloContpaqi,
        // Sin póliza del lado de ContPAQi el mes simplemente no se subió.
        existe_en_contpaqi: rows.length > 0,
      };
    });
  }
}
