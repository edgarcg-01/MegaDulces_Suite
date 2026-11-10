import * as crypto from 'node:crypto';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantKnexService, TenantContextService, todayMx } from '@megadulces/platform-core';
import { leerEstadoDeCuenta, type Banco, type EstadoDeCuentaLeido, type MovimientoBanco } from './lectores';
import { cierreDelDia, type RenglonDelLibro } from './saldo-del-libro';
import { compararContraElLibro, type ClasificarSinLibro, type CuentaContraElLibro, type RenglonComparable } from './contra-el-libro';
import { clasificarRenglon } from './clasificador';
import { classifyWith, compileRules } from '../classify-rules';

/**
 * `[CB.58]` Subir el estado de cuenta descargado de la banca, en dos pasos: REVISAR (no escribe)
 * y CONFIRMAR (escribe sólo si la revisión no tiene motivos de bloqueo).
 *
 * Escribe en `finance.bank_statement_files/lines` (CB.56), NO en `bank_movements`: durante el mes
 * en paralelo el libro y el banco conviven y se comparan (CB.60); los lectores de `bank_movements`
 * no ven nada de esto, así que ningún total sale doble.
 *
 * La cuenta: Santander la trae en el archivo; BBVA, Banorte y BanBajío no. Entonces la elige quien
 * sube y el sistema la ATESTIGUA: el saldo inicial del archivo debe ser el último saldo conocido
 * de esa cuenta (así se identificó BB 4166 en las muestras del 2026-11-05). Si no hay con qué
 * comparar, se acepta y queda declarado `sin_testigo`, nunca como comprobado.
 */

/** El banco que detecta el lector → el `bank` de `finance.bank_accounts` (medido en prod). */
const BANCO_EN_CUENTAS: Readonly<Record<Banco, string>> = {
  santander: 'SANTANDER', banorte: 'BANORTE', bbva: 'BBVA', banbajio: 'BBAJIO', banamex: 'BANAMEX',
};

export type ComoSeFijoLaCuenta = 'en_archivo' | 'saldo_continuo' | 'sin_testigo';

export interface SubirEstadoDeCuentaBody {
  file_base64?: string;
  file_name?: string;
  /** Obligatoria si el archivo no trae la cuenta (todos menos Santander). */
  bank_account_id?: string;
  /** Sin testigo (nada termina en el saldo inicial), la persona confirma a mano que la cuenta es ésa. */
  aceptar_sin_testigo?: boolean;
}

export interface CuentaCandidata {
  id: string;
  alias: string;
  saldo_conocido: number | null;
  /** El saldo inicial del archivo es exactamente su último saldo conocido. */
  coincide: boolean;
}

export interface RevisionEstadoDeCuenta {
  banco: Banco;
  archivo: string | null;
  cuenta_en_archivo: string | null;
  cliente_en_archivo: string | null;
  cuenta: { id: string; alias: string } | null;
  como_se_fijo: ComoSeFijoLaCuenta | null;
  candidatas: CuentaCandidata[];
  desde: string | null;
  hasta: string | null;
  movimientos: number;
  nuevos: number;
  ya_cargados: number;
  saldo_inicial: number | null;
  saldo_final: number | null;
  total_abonos: number;
  total_cargos: number;
  cuadra: boolean;
  eslabones_rotos: number[];
  totales_declarados_coinciden: boolean | null;
  no_leidos: { linea: number; motivo: string }[];
  /** Si hay motivos, `confirmar` se niega. Cada motivo es una frase para la pantalla. */
  motivos_bloqueo: string[];
  puede_confirmar: boolean;
  /** Este MISMO archivo (por su sha1) ya se guardó: confirmar no escribe nada nuevo. */
  ya_subido: { archivo_id: string; subido_el: string; subido_por: string | null } | null;
}

/** `GET statement-files`: la lista (con tope) y, aparte, cada cuenta de banco activa con hasta dónde llega. */
export interface ArchivosDelBanco {
  archivos: Record<string, unknown>[];
  /** Cuántos archivos hay en total: si es mayor que `archivos.length`, la lista está recortada. */
  total: number;
  tope: number;
  cuentas: { id: string; bank: string; alias: string; hasta: string | null; archivos: number; sin_testigo: number; con_lector: boolean }[];
}

const pesos = (centavos: number) => Math.round(centavos) / 100;

/** La misma línea bajada en dos archivos que se enciman produce la misma llave. */
export function llaveDeLinea(cuentaId: string, m: MovimientoBanco): string {
  const concepto = m.concepto.replace(/\s+/g, ' ').trim().toUpperCase();
  return crypto.createHash('sha1')
    .update([cuentaId, m.fecha, m.cargo_centavos, m.abono_centavos, m.saldo_centavos, concepto].join('|'))
    .digest('hex');
}

/** ¿La cuenta del archivo (p. ej. `65507301604`) es esta cuenta (`account_label` = `1604`)? */
export function cuentaCoincide(numeroEnArchivo: string, accountLabel: string): boolean {
  const n = numeroEnArchivo.replace(/\D/g, '');
  const l = accountLabel.replace(/\D/g, '');
  return l.length >= 3 && n.endsWith(l);
}

@Injectable()
export class EstadoDeCuentaService {
  private readonly logger = new Logger(EstadoDeCuentaService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private decodificar(body: SubirEstadoDeCuentaBody): Buffer {
    const b64 = String(body?.file_base64 || '').replace(/^data:[^,]*,/, '');
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) throw new BadRequestException('archivo vacío');
    return buf;
  }

  /** Último saldo conocido ANTES del primer día del archivo: primero el banco, si no, el libro. */
  private async saldoConocido(trx: Knex.Transaction, cuentaId: string, antesDe: string): Promise<number | null> {
    // El saldo al cierre del último día: el renglón cronológicamente último (`seq`) del archivo más reciente.
    const delBanco = await trx('finance.bank_statement_lines')
      .where({ bank_account_id: cuentaId }).andWhere('movement_date', '<', antesDe)
      .orderBy([{ column: 'movement_date', order: 'desc' }, { column: 'created_at', order: 'desc' }, { column: 'seq', order: 'desc' }])
      .first('running_balance');
    if (delBanco) return Number(delBanco.running_balance);
    // El libro no guarda el orden dentro del día: el cierre se reconstruye por la cadena de saldos.
    const ultimoDia = await trx('finance.bank_movements')
      .where({ bank_account_id: cuentaId }).whereNull('deleted_at').whereNotNull('running_balance')
      .andWhere('movement_date', '<', antesDe).first(trx.raw("to_char(max(movement_date), 'YYYY-MM-DD') as d"));
    if (!ultimoDia?.d) return null;
    const delDia: RenglonDelLibro[] = await trx('finance.bank_movements')
      .where({ bank_account_id: cuentaId, movement_date: ultimoDia.d }).whereNull('deleted_at')
      .select('amount_in', 'amount_out', 'running_balance');
    return cierreDelDia(delDia);
  }

  private async revisarEn(trx: Knex.Transaction, leido: EstadoDeCuentaLeido, body: SubirEstadoDeCuentaBody, sha1: string): Promise<RevisionEstadoDeCuenta & { _lineas: { m: MovimientoBanco; llave: string; existe: boolean }[] }> {
    const motivos: string[] = [];
    const ctl = leido.control;
    const desde = leido.movimientos[0]?.fecha ?? null;
    const hasta = leido.movimientos[leido.movimientos.length - 1]?.fecha ?? null;
    const inicial = ctl ? pesos(ctl.saldo_inicial_centavos) : null;

    const cuentasDelBanco: { id: string; alias: string | null; account_label: string }[] = await trx('finance.bank_accounts')
      .where({ bank: BANCO_EN_CUENTAS[leido.banco], kind: 'bank', active: true })
      .select('id', 'alias', 'account_label').orderBy('account_label');
    const candidatas: CuentaCandidata[] = [];
    if (desde) {
      for (const c of cuentasDelBanco) {
        const saldo = await this.saldoConocido(trx, c.id, desde);
        candidatas.push({ id: c.id, alias: c.alias || c.account_label, saldo_conocido: saldo, coincide: saldo !== null && inicial !== null && Math.round(saldo * 100) === Math.round(inicial * 100) });
      }
    }

    let cuenta: { id: string; alias: string } | null = null;
    let como: ComoSeFijoLaCuenta | null = null;
    if (leido.cuenta) {
      const enArchivo = cuentasDelBanco.filter((c) => cuentaCoincide(leido.cuenta!, c.account_label));
      if (enArchivo.length !== 1) motivos.push(`la cuenta del archivo (${leido.cuenta}) no corresponde a una sola cuenta ${BANCO_EN_CUENTAS[leido.banco]} registrada`);
      else {
        cuenta = { id: enArchivo[0].id, alias: enArchivo[0].alias || enArchivo[0].account_label };
        como = 'en_archivo';
        if (body.bank_account_id && body.bank_account_id !== cuenta.id) motivos.push(`el archivo es de la cuenta ${cuenta.alias}, no de la elegida`);
      }
    } else if (body.bank_account_id) {
      const elegida = cuentasDelBanco.find((c) => c.id === body.bank_account_id);
      if (!elegida) motivos.push(`la cuenta elegida no es una cuenta ${BANCO_EN_CUENTAS[leido.banco]} activa: el archivo es de ${BANCO_EN_CUENTAS[leido.banco]}`);
      else {
        cuenta = { id: elegida.id, alias: elegida.alias || elegida.account_label };
        const cand = candidatas.find((c) => c.id === elegida.id);
        const otraCoincide = candidatas.find((c) => c.coincide && c.id !== elegida.id);
        if (cand?.coincide) como = 'saldo_continuo';
        else if (otraCoincide) motivos.push(`el saldo inicial ($${inicial}) es el último saldo conocido de ${otraCoincide.alias}, no de ${cuenta.alias}`);
        else como = 'sin_testigo';
      }
    } else {
      motivos.push('el archivo no dice de qué cuenta es: elige la cuenta');
    }

    if (!leido.movimientos.length) motivos.push('el archivo no trae movimientos');
    if (leido.no_leidos.length) motivos.push(`${leido.no_leidos.length} renglón(es) no se pudieron leer`);
    if (ctl && !ctl.cuadra) motivos.push(`el saldo no encadena en ${ctl.eslabones_rotos.length} renglón(es): falta o sobra algo en la descarga`);
    if (leido.declarado?.coinciden === false) motivos.push('los totales que declara el banco no coinciden con los movimientos leídos');
    const hoy = todayMx();
    const futuros = leido.movimientos.filter((m) => m.fecha > hoy).length;
    if (futuros) motivos.push(`${futuros} movimiento(s) con fecha posterior a hoy`);

    const lineas = cuenta ? leido.movimientos.map((m) => ({ m, llave: llaveDeLinea(cuenta!.id, m), existe: false })) : [];
    if (cuenta && lineas.length) {
      const ya = new Set<string>((await trx('finance.bank_statement_lines')
        .where({ bank_account_id: cuenta.id }).whereIn('line_key', lineas.map((l) => l.llave)).select('line_key'))
        .map((r: { line_key: string }) => r.line_key));
      for (const l of lineas) l.existe = ya.has(l.llave);
    }
    const yaCargados = lineas.filter((l) => l.existe).length;
    const previo = await trx('finance.bank_statement_files').where({ file_sha1: sha1 }).first('id', 'created_at', 'created_by');

    return {
      banco: leido.banco, archivo: body.file_name ?? null, cuenta_en_archivo: leido.cuenta, cliente_en_archivo: leido.cliente,
      cuenta, como_se_fijo: como, candidatas, desde, hasta,
      movimientos: leido.movimientos.length, nuevos: lineas.length ? lineas.length - yaCargados : 0, ya_cargados: yaCargados,
      saldo_inicial: inicial, saldo_final: ctl ? pesos(ctl.saldo_final_centavos) : null,
      total_abonos: ctl ? pesos(ctl.abonos_centavos) : 0, total_cargos: ctl ? pesos(ctl.cargos_centavos) : 0,
      cuadra: !!ctl?.cuadra, eslabones_rotos: ctl?.eslabones_rotos ?? [],
      totales_declarados_coinciden: leido.declarado?.coinciden ?? null,
      no_leidos: leido.no_leidos.map(({ linea, motivo }) => ({ linea, motivo })),
      motivos_bloqueo: motivos, puede_confirmar: motivos.length === 0 && !!cuenta && !!como,
      ya_subido: previo ? { archivo_id: previo.id, subido_el: new Date(previo.created_at).toISOString(), subido_por: previo.created_by ?? null } : null,
      _lineas: lineas,
    };
  }

  private async leer(buf: Buffer): Promise<EstadoDeCuentaLeido> {
    let leido: EstadoDeCuentaLeido | null;
    try { leido = await leerEstadoDeCuenta(buf); } catch { throw new BadRequestException('no se pudo leer el archivo'); }
    if (!leido) throw new BadRequestException('formato no reconocido: no es una descarga de Santander, Banorte, BBVA ni BanBajío');
    return leido;
  }

  /** Paso 1: qué entraría, sin escribir nada. */
  async revisar(body: SubirEstadoDeCuentaBody): Promise<RevisionEstadoDeCuenta> {
    this.tenantCtx.requireTenantId();
    const buf = this.decodificar(body);
    const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
    const leido = await this.leer(buf);
    const { _lineas, ...rev } = await this.tk.run((trx) => this.revisarEn(trx, leido, body, sha1));
    void _lineas;
    return rev;
  }

  /** Paso 2: escribe el archivo y sus renglones nuevos. El mismo archivo dos veces no duplica nada. */
  async confirmar(body: SubirEstadoDeCuentaBody, actor?: string): Promise<RevisionEstadoDeCuenta & { archivo_id: string; ya_existia: boolean }> {
    const tenantId = this.tenantCtx.requireTenantId();
    const buf = this.decodificar(body);
    const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
    const leido = await this.leer(buf);
    return this.tk.run(async (trx) => {
      const { _lineas, ...rev } = await this.revisarEn(trx, leido, body, sha1);
      if (rev.ya_subido) return { ...rev, archivo_id: rev.ya_subido.archivo_id, ya_existia: true };
      if (rev.como_se_fijo === 'sin_testigo' && body.aceptar_sin_testigo !== true) {
        throw new BadRequestException({ message: 'el estado de cuenta no se puede guardar', motivos: [`no hay con qué comprobar que el archivo es de ${rev.cuenta?.alias}: confírmalo antes de guardar`] });
      }
      if (!rev.puede_confirmar || !rev.cuenta || !rev.como_se_fijo || !rev.desde || !rev.hasta || rev.saldo_inicial === null || rev.saldo_final === null) {
        throw new BadRequestException({ message: 'el estado de cuenta no se puede guardar', motivos: rev.motivos_bloqueo });
      }
      const [archivo] = await trx('finance.bank_statement_files').insert({
        tenant_id: tenantId, bank_account_id: rev.cuenta.id, bank: rev.banco, file_name: body.file_name ?? null, file_sha1: sha1,
        date_from: rev.desde, date_to: rev.hasta, lines_in_file: rev.movimientos, lines_new: rev.nuevos,
        opening_balance: rev.saldo_inicial, closing_balance: rev.saldo_final, total_in: rev.total_abonos, total_out: rev.total_cargos,
        balance_ok: rev.cuadra, declared_ok: rev.totales_declarados_coinciden, account_check: rev.como_se_fijo,
        created_by: actor ?? null, updated_by: actor ?? null,
      }).returning('id');
      const archivoId = (archivo?.id ?? archivo) as string;
      const filas = _lineas.map((l, seq) => ({ ...l, seq })).filter((l) => !l.existe).map(({ m, llave, seq }) => ({
        tenant_id: tenantId, file_id: archivoId, bank_account_id: rev.cuenta!.id, line_no: m.linea, seq,
        movement_date: m.fecha, movement_time: m.hora, concept: m.concepto,
        amount_in: pesos(m.abono_centavos), amount_out: pesos(m.cargo_centavos), running_balance: pesos(m.saldo_centavos),
        reference: m.referencia, tracking_key: m.clave_rastreo, counterparty_account: m.contraparte_cuenta,
        counterparty_rfc: m.contraparte_rfc, counterparty_name: m.contraparte_nombre, raw_line: m.texto_original,
        line_key: llave, created_by: actor ?? null, updated_by: actor ?? null,
      }));
      let insertadas = 0;
      for (let i = 0; i < filas.length; i += 500) {
        const r = await trx('finance.bank_statement_lines').insert(filas.slice(i, i + 500))
          .onConflict(['tenant_id', 'bank_account_id', 'line_key']).ignore().returning('id');
        insertadas += r.length;
      }
      if (insertadas !== rev.nuevos) {
        await trx('finance.bank_statement_files').where({ id: archivoId }).update({ lines_new: insertadas, updated_at: trx.fn.now() });
      }
      this.logger.log(`[CB.58] ${rev.banco} ${rev.cuenta.alias} ${rev.desde}..${rev.hasta}: ${insertadas} nuevos de ${rev.movimientos} (${rev.como_se_fijo})`);
      return { ...rev, nuevos: insertadas, ya_cargados: rev.movimientos - insertadas, archivo_id: archivoId, ya_existia: false };
    });
  }

  /**
   * Lo que ya se subió (del más reciente al más viejo, con tope declarado) y, aparte y SIN tope, hasta
   * dónde llega cada cuenta de banco activa: el resumen no puede salir de una lista recortada.
   */
  async archivos(limit = 100): Promise<ArchivosDelBanco> {
    this.tenantCtx.requireTenantId();
    const tope = Math.min(Math.max(1, limit), 500);
    return this.tk.run(async (trx) => {
      const archivos = await trx('finance.bank_statement_files as f')
        .join('finance.bank_accounts as a', 'a.id', 'f.bank_account_id')
        .select('f.id', 'f.bank', 'a.alias', 'a.account_label', 'f.file_name',
          // La fecha como texto: sin setTypeParser, un `date` llega como Date y el JSON lo corre de día.
          trx.raw("to_char(f.date_from, 'YYYY-MM-DD') as date_from"), trx.raw("to_char(f.date_to, 'YYYY-MM-DD') as date_to"),
          'f.lines_in_file', 'f.lines_new', 'f.opening_balance', 'f.closing_balance', 'f.total_in', 'f.total_out',
          'f.balance_ok', 'f.declared_ok', 'f.account_check', 'f.created_at', 'f.created_by')
        .orderBy('f.created_at', 'desc').limit(tope);
      const [{ n }] = await trx('finance.bank_statement_files').count('* as n');
      const conLector = Object.values(BANCO_EN_CUENTAS);
      const cuentas = await trx('finance.bank_accounts as a')
        .leftJoin('finance.bank_statement_files as f', 'f.bank_account_id', 'a.id')
        .where({ 'a.kind': 'bank', 'a.active': true })
        .groupBy('a.id', 'a.bank', 'a.alias', 'a.account_label')
        .select('a.id', 'a.bank', trx.raw('coalesce(a.alias, a.account_label) as alias'),
          trx.raw("to_char(max(f.date_to), 'YYYY-MM-DD') as hasta"), trx.raw('count(f.id)::int as archivos'),
          trx.raw("count(f.id) FILTER (WHERE f.account_check = 'sin_testigo')::int as sin_testigo"))
        .orderBy('alias');
      return {
        archivos, total: Number(n), tope,
        cuentas: cuentas.map((c: { id: string; bank: string; alias: string; hasta: string | null; archivos: number; sin_testigo: number }) =>
          ({ ...c, con_lector: conLector.includes(c.bank) })),
      };
    });
  }

  /**
   * `[CB.60]` Cada cuenta con descarga, contra el libro, día por día (ver `contra-el-libro.ts`). Sólo lee.
   * La ventana va por la fecha del movimiento (últimos `dias`); el libro se lee 3 días más atrás
   * porque el pareo con fecha distinta lo necesita.
   */
  async contraElLibro(dias = 45, hoy = todayMx()): Promise<{ desde: string; cuentas: (CuentaContraElLibro & { id: string; alias: string })[] }> {
    this.tenantCtx.requireTenantId();
    const ventana = Math.min(Math.max(1, Math.trunc(dias) || 45), 120);
    const d = new Date(`${hoy}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ventana);
    const desde = d.toISOString().slice(0, 10);
    return this.tk.run(async (trx) => {
      const banco = await trx('finance.bank_statement_lines')
        .where('movement_date', '>=', desde)
        .select('id', 'bank_account_id', trx.raw("to_char(movement_date, 'YYYY-MM-DD') as fecha"), 'amount_in', 'amount_out', 'running_balance', 'concept as concepto');
      const ids = Array.from(new Set(banco.map((b: { bank_account_id: string }) => b.bank_account_id)));
      if (!ids.length) return { desde, cuentas: [] };
      // [CB.61] Cada renglón del libro trae su categoría y el documento de Kepler con que casó (el de
      // mayor importe), con la entidad del documento: con eso se clasifica el renglón del banco sin M/C.
      // La entidad vive en la vista derivada del ODS; sin ODS (CI, desarrollo) la vista no la tiene y
      // va nula: el renglón pierde la señal de proveedor/nómina, no la consulta.
      const conEntidad = (await trx.raw(`select 1 from information_schema.columns
        where table_schema = 'analytics' and table_name = 'kepler_bank_movements' and column_name = 'entidad_code'`)).rows.length > 0;
      const entidad = conEntidad
        ? `(select kb.entidad_code from analytics.kepler_bank_movements kb
             where kb.sucursal = r.kepler_sucursal and kb.doc_tipo = r.kepler_doc_tipo and kb.folio = r.kepler_doc_folio limit 1)`
        : 'null::text';
      const libro = await trx('finance.bank_movements as bm')
        .leftJoin('finance.movement_categories as mc', 'mc.id', 'bm.category_id')
        .joinRaw(`left join lateral (
            select r.kepler_doc_tipo as doc_tipo, ${entidad} as entidad
              from finance.bank_recon_matches r where r.bank_movement_id = bm.id
             order by r.kepler_amount desc limit 1) k on true`)
        .whereIn('bm.bank_account_id', ids).whereNull('bm.deleted_at')
        .andWhere('bm.movement_date', '>=', trx.raw("?::date - 3", [desde]))
        .select('bm.id', 'bm.bank_account_id', trx.raw("to_char(bm.movement_date, 'YYYY-MM-DD') as fecha"), 'bm.amount_in', 'bm.amount_out',
          'bm.running_balance', 'bm.concept as concepto', 'mc.code as categoria', 'k.doc_tipo', 'k.entidad');
      const reglas = compileRules(await trx('finance.bank_classify_rules').where({ active: true })
        .select('priority', 'match_type', 'match_code', 'match_concept', 'category_code'));
      const reglaDelLibro = (concepto: string) => classifyWith(reglas, '', '', concepto);
      const clasificar: ClasificarSinLibro = (b, par) => clasificarRenglon(
        { amount_in: b.amount_in, amount_out: b.amount_out, concepto: b.concepto, doc_tipo: par.doc_tipo, entidad: par.entidad }, reglaDelLibro);
      const alias = new Map<string, string>((await trx('finance.bank_accounts').whereIn('id', ids)
        .select('id', trx.raw('coalesce(alias, account_label) as alias'))).map((a: { id: string; alias: string }) => [a.id, a.alias]));
      const de = (rows: (RenglonComparable & { bank_account_id: string })[], id: string) => rows.filter((r) => r.bank_account_id === id);
      return {
        desde,
        cuentas: ids.map((id) => ({ id, alias: alias.get(id) ?? id, ...compararContraElLibro(de(banco, id), de(libro, id), clasificar) }))
          .sort((a, b) => a.alias.localeCompare(b.alias)),
      };
    });
  }
}
