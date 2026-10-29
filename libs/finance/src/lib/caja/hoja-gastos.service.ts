import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import {
  ZONAS_HOJA_GASTOS, diaMxDeInstante, folioHoja,
  type CerrarHojaInput, type ClaveZonaHoja, type HojaAbierta, type HojaGastos, type HojasDeGastos, type MotivoHojaInput,
  type PagoDeHojaGastos, type RenglonHoja, type ZonaHojaGastos,
} from '@megadulces/contracts';
import { consultasHoja } from './hoja-gastos.query';
import {
  armarHojaAbierta, depositoDeHoja, instruccionDePago, retirosDeHoja,
  type DepositoBancoHoja, type PagoDeZona, type RetiroCaosHoja,
} from './hoja-gastos.engine';
import { redondea2 } from './caja-lote.engine';
import { CashLedgerService } from './cash-ledger.service';

type Usuario = { id?: string; username?: string };

/** Las hojas cerradas que se muestran: las recientes, y las que siguen esperando firma de finanzas. */
const DIAS_HOJAS_CERRADAS = 45;
const RX_DIA = /^\d{4}-\d{2}-\d{2}$/;
const TIPO_RETIRO = 4;

/**
 * ⭐ `[CGA-A.65]` La hoja de gastos de zona: la abierta se ARMA de Kepler cada vez (no se guarda) y la
 * cerrada guarda lo que una persona decidió. Todo lo que escribe vuelve a leer y a calcular en la
 * misma transacción, bajo candado: la pantalla manda qué pagos y quién, nunca importes ni totales.
 *
 * ⛔ No escribe en el libro viejo de Caja General (LE.0.4): el retiro y el depósito se RECONOCEN
 * (CAOS y el estado de cuenta), no se asientan aquí.
 */
@Injectable()
export class HojaGastosService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly ledger: CashLedgerService,
  ) {}

  /** ¿Está aplicada la migración de las hojas (`20261029143450`)? */
  static async instalada(trx: Knex | Knex.Transaction): Promise<boolean> {
    const r = await trx.raw(`SELECT to_regclass('finance.expense_sheets') IS NOT NULL AS ok`);
    return r.rows?.[0]?.ok === true;
  }

  async hojas(): Promise<HojasDeGastos> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const instalada = await HojaGastosService.instalada(trx);
      const datosAl = await this.ledger.frescuraCaja(trx);
      const abiertas: HojaAbierta[] = [];
      for (const z of ZONAS_HOJA_GASTOS) abiertas.push(await this.abierta(trx, tenantId, z, instalada, datosAl));
      return {
        abiertas,
        cerradas: instalada ? await this.cerradas(trx, tenantId) : [],
        instalada,
        datos_al: datosAl,
        caos_al: await this.ledger.frescuraCaos(trx, tenantId),
      };
    });
  }

  async cerrar(zonaClave: string, input: CerrarHojaInput, user: Usuario): Promise<HojaGastos> {
    const u = this.requireUser(user);
    const tenantId = this.tenantCtx.requireTenantId();
    const zona = this.zona(zonaClave);
    const refs = Array.isArray(input?.origen_refs) ? [...new Set(input.origen_refs.map((r) => String(r)))] : [];
    if (!refs.length) throw new BadRequestException('Una hoja sin pagos no se cierra: elige al menos uno.');
    const venta = String(input?.venta_del_dia ?? '');
    const hoy = diaMxDeInstante(new Date()) as string;
    if (!RX_DIA.test(venta) || venta > hoy) {
      throw new BadRequestException('La venta del día es una fecha (AAAA-MM-DD) y no puede ser futura.');
    }
    const clientKey = String(input?.client_key ?? '').trim();
    if (clientKey.length < 8 || clientKey.length > 200) throw new BadRequestException('Falta la llave de la pantalla (client_key).');

    return this.tk.run(async (trx) => {
      if (!(await HojaGastosService.instalada(trx))) {
        throw new ConflictException('Las hojas de gastos todavía no están instaladas en esta base (migración 20261029143450).');
      }
      // El doble clic: la misma llave devuelve la misma hoja, no cierra otra.
      const ya = await trx('finance.expense_sheets').where({ tenant_id: tenantId, client_key: clientKey }).first('id', 'zona');
      if (ya) {
        if (ya.zona !== zona.clave) throw new ConflictException('Esa llave ya cerró una hoja de otra zona.');
        return this.una(trx, tenantId, String(ya.id));
      }
      // Un cierre a la vez por empresa: el número es consecutivo y un pago no entra en dos hojas.
      await trx.raw(`SELECT pg_advisory_xact_lock(hashtext(? || ':hoja-gastos'))`, [tenantId]);

      const filas = (await consultasHoja.pagos(trx, tenantId, [...zona.sucursales], zona.desde,
        { soloPendientes: true, conHojas: true })) as PagoDeZona[];
      const abierta = armarHojaAbierta(zona, filas, null);
      const porRef = new Map(abierta.renglones.map((r) => [r.origen_ref, r]));
      const ajenos = refs.filter((r) => !porRef.has(r));
      if (ajenos.length) {
        throw new ConflictException(`La hoja cambió mientras la veías (${ajenos.length} ${ajenos.length === 1 ? 'pago ya no está' : 'pagos ya no están'} en la hoja abierta): vuelve a cargarla.`);
      }
      const renglones = refs.map((r) => porRef.get(r) as RenglonHoja);
      const total = redondea2(renglones.reduce((a, r) => a + r.importe, 0));
      const max = await trx('finance.expense_sheets').where({ tenant_id: tenantId }).max({ n: 'numero' }).first();
      const numero = Number(max?.n ?? 0) + 1;
      const [hoja] = await trx('finance.expense_sheets').insert({
        tenant_id: tenantId, numero, zona: zona.clave, venta_del_dia: venta, total, renglones: renglones.length,
        client_key: clientKey, cerrada_por: u.id, created_by: u.id, updated_by: u.id,
      }).returning('id');
      await trx('finance.expense_sheet_lines').insert(renglones.map((r) => ({
        tenant_id: tenantId, sheet_id: hoja.id, origen_ref: r.origen_ref, sucursal: r.sucursal, doc_tipo: r.doc_tipo,
        folio: r.folio, fecha_pago: r.fecha_pago, fecha_captura: r.fecha_captura, beneficiario: r.beneficiario,
        clave: r.clave, centro: r.centro, clase: r.clase, importe: r.importe, created_by: u.id, updated_by: u.id,
      })));
      return this.una(trx, tenantId, String(hoja.id));
    });
  }

  async aprobar(id: string, user: Usuario): Promise<HojaGastos> {
    const u = this.requireUser(user);
    return this.resolver(id, u, async (trx, h) => {
      if (h.cerrada_por === u.id) throw new ForbiddenException('Quien cerró la hoja no la aprueba: la firma otra persona.');
      await trx('finance.expense_sheets').where({ id: h.id })
        .update({ estado: 'aprobada', aprobada_por: u.id, aprobada_at: trx.fn.now(), updated_by: u.id });
    });
  }

  async rechazar(id: string, input: MotivoHojaInput, user: Usuario): Promise<HojaGastos> {
    const u = this.requireUser(user);
    const motivo = this.motivo(input);
    return this.resolver(id, u, async (trx, h) => {
      if (h.cerrada_por === u.id) throw new ForbiddenException('Quien cerró la hoja no la rechaza: si se equivocó, la cancela.');
      await trx('finance.expense_sheets').where({ id: h.id })
        .update({ estado: 'rechazada', rechazada_por: u.id, rechazada_at: trx.fn.now(), motivo, updated_by: u.id });
      // Sus pagos vuelven a la hoja abierta.
      await trx('finance.expense_sheet_lines').where({ sheet_id: h.id }).update({ vigente: false, updated_by: u.id });
    });
  }

  async cancelar(id: string, input: MotivoHojaInput, user: Usuario): Promise<HojaGastos> {
    const u = this.requireUser(user);
    const motivo = this.motivo(input);
    return this.resolver(id, u, async (trx, h) => {
      await trx('finance.expense_sheets').where({ id: h.id })
        .update({ estado: 'cancelada', cancelada_por: u.id, cancelada_at: trx.fn.now(), motivo, updated_by: u.id });
      await trx('finance.expense_sheet_lines').where({ sheet_id: h.id }).update({ vigente: false, updated_by: u.id });
    });
  }

  // ── Lectura ─────────────────────────────────────────────────────────────────────────────────

  private async abierta(trx: Knex.Transaction, tenantId: string, zona: ZonaHojaGastos, instalada: boolean, datosAl: string | null) {
    const filas = (await consultasHoja.pagos(trx, tenantId, [...zona.sucursales], zona.desde,
      { soloPendientes: true, conHojas: instalada })) as PagoDeZona[];
    return armarHojaAbierta(zona, filas, datosAl);
  }

  private async una(trx: Knex.Transaction, tenantId: string, id: string): Promise<HojaGastos> {
    const [h] = await this.leerHojas(trx, tenantId, (q) => q.where('s.id', id));
    if (!h) throw new NotFoundException('Esa hoja no existe.');
    return h;
  }

  private cerradas(trx: Knex.Transaction, tenantId: string): Promise<HojaGastos[]> {
    return this.leerHojas(trx, tenantId, (q) => q.where((w) => w
      .where('s.cerrada_at', '>=', trx.raw(`now() - interval '${DIAS_HOJAS_CERRADAS} days'`))
      .orWhere('s.estado', 'cerrada')));
  }

  private async leerHojas(trx: Knex.Transaction, tenantId: string, filtro: (q: Knex.QueryBuilder) => void): Promise<HojaGastos[]> {
    const q = trx('finance.expense_sheets as s')
      .leftJoin('identity.users as uc', 'uc.id', 's.cerrada_por')
      .leftJoin('identity.users as ua', 'ua.id', 's.aprobada_por')
      .leftJoin('identity.users as ur', 'ur.id', trx.raw('coalesce(s.rechazada_por, s.cancelada_por)'))
      .where('s.tenant_id', tenantId)
      .orderBy('s.numero', 'desc').limit(200)
      .select('s.id', 's.numero', 's.zona', 's.estado', 's.total', 's.cerrada_por', 's.motivo',
        trx.raw(`to_char(s.venta_del_dia, 'YYYY-MM-DD') AS venta_del_dia`),
        's.cerrada_at', 's.aprobada_at', trx.raw('coalesce(s.rechazada_at, s.cancelada_at) AS resuelta_at'),
        'uc.username as cerrada_por_nombre', 'ua.username as aprobada_por_nombre', 'ur.username as resuelta_por_nombre');
    filtro(q);
    const filas = await q;
    if (!filas.length) return [];
    const ids = filas.map((f) => String(f.id));
    const lineas = await trx('finance.expense_sheet_lines').where('tenant_id', tenantId).whereIn('sheet_id', ids)
      .orderBy([{ column: 'sucursal', order: 'asc' }, { column: 'fecha_pago', order: 'asc' }, { column: 'folio', order: 'asc' }])
      .select('sheet_id', 'origen_ref', 'sucursal', 'doc_tipo', 'folio', 'beneficiario', 'clave', 'centro', 'clase', 'importe',
        trx.raw(`to_char(fecha_pago, 'YYYY-MM-DD') AS fecha_pago`), trx.raw(`to_char(fecha_captura, 'YYYY-MM-DD') AS fecha_captura`));
    const pagos = await this.pagos(trx, tenantId, filas.filter((f) => f.estado === 'aprobada'));

    return filas.map((f): HojaGastos => {
      const zona = this.zona(String(f.zona));
      const orden = (s: string) => zona.sucursales.indexOf(s);
      const renglones: RenglonHoja[] = lineas.filter((l) => String(l.sheet_id) === String(f.id))
        .map((l) => ({
          origen_ref: l.origen_ref, sucursal: l.sucursal, doc_tipo: l.doc_tipo, folio: l.folio, fecha_pago: l.fecha_pago,
          fecha_captura: l.fecha_captura, beneficiario: l.beneficiario, clave: l.clave, centro: l.centro,
          clase: l.clase, importe: redondea2(Number(l.importe)),
        }))
        .sort((a, b) => orden(a.sucursal) - orden(b.sucursal) || a.fecha_pago.localeCompare(b.fecha_pago) || a.folio.localeCompare(b.folio));
      const total = redondea2(Number(f.total));
      return {
        id: String(f.id), numero: Number(f.numero), folio: folioHoja(Number(f.numero)), zona: zona.clave, nombre_zona: zona.nombre,
        venta_del_dia: f.venta_del_dia, estado: f.estado, total, renglones,
        por_sucursal: zona.sucursales.map((s) => {
          const xs = renglones.filter((r) => r.sucursal === s);
          return { sucursal: s, renglones: xs.length, total: redondea2(xs.reduce((a, r) => a + r.importe, 0)) };
        }),
        cerrada_por: String(f.cerrada_por), cerrada_por_nombre: f.cerrada_por_nombre ?? null,
        cerrada_at: new Date(f.cerrada_at).toISOString(),
        aprobada_por_nombre: f.aprobada_por_nombre ?? null,
        aprobada_at: f.aprobada_at ? new Date(f.aprobada_at).toISOString() : null,
        resuelta_por_nombre: f.resuelta_por_nombre ?? null,
        resuelta_at: f.resuelta_at ? new Date(f.resuelta_at).toISOString() : null,
        motivo: f.motivo ?? null,
        instruccion: instruccionDePago(total, Number(f.numero)),
        pago: pagos.get(String(f.id)) ?? null,
      };
    });
  }

  /**
   * El pago de cada hoja aprobada, RECONOCIDO (no asentado): el retiro de CAOS cuya referencia
   * nombra su folio, y el depósito que suma su total en la cuenta de reposición de su zona. Las
   * hojas se recorren de la más vieja a la más nueva y un depósito sólo explica a una.
   */
  private async pagos(trx: Knex.Transaction, tenantId: string, aprobadas: Array<Record<string, unknown>>): Promise<Map<string, PagoDeHojaGastos>> {
    const out = new Map<string, PagoDeHojaGastos>();
    if (!aprobadas.length) return out;
    const desde = aprobadas.map((h) => diaMxDeInstante(h['cerrada_at']) as string).sort()[0];
    const retiros: RetiroCaosHoja[] = (await trx('analytics.caos_cash_movements')
      .where({ tenant_id: tenantId, type_id: TIPO_RETIRO })
      .where('occurred_at', '>=', trx.raw(`(?::date - 1)`, [desde]))
      .whereRaw(`ref ~* 'hg'`)
      .select('device', 'external_id', 'occurred_at', 'ref', trx.raw('abs(total) AS total')))
      .map((r) => ({ device: r.device, external_id: Number(r.external_id), occurred_at: new Date(r.occurred_at).toISOString(),
        ref: r.ref, total: redondea2(Number(r.total)) }));

    const cuentas = new Map<ClaveZonaHoja, string[]>();
    for (const z of ZONAS_HOJA_GASTOS) {
      if (!z.cuenta_deposito) continue;
      const ids = (await trx('finance.bank_accounts').where('tenant_id', tenantId)
        .whereRaw('upper(btrim(bank)) = ?', [z.cuenta_deposito.banco.toUpperCase()])
        .where('account_label', z.cuenta_deposito.terminacion).select('id')).map((r) => String(r.id));
      cuentas.set(z.clave, ids);
    }
    const todas = [...new Set([...cuentas.values()].flat())];
    const depositos: Array<DepositoBancoHoja & { cuenta: string }> = todas.length
      ? (await trx('finance.bank_movements').where('tenant_id', tenantId).whereNull('deleted_at').where('amount_in', '>', 0)
        .whereIn('bank_account_id', todas).where('movement_date', '>=', trx.raw(`(?::date - 1)`, [desde]))
        .select(trx.raw('id::text AS id'), trx.raw(`to_char(movement_date, 'YYYY-MM-DD') AS dia`), 'amount_in', trx.raw('bank_account_id::text AS cuenta')))
        .map((d) => ({ id: d.id, dia: d.dia, importe: redondea2(Number(d.amount_in)), cuenta: d.cuenta }))
      : [];
    const usados = new Set<string>();

    for (const h of [...aprobadas].sort((a, b) => Number(a['numero']) - Number(b['numero']))) {
      const numero = Number(h['numero']);
      const zona = this.zona(String(h['zona']));
      const suyos = retirosDeHoja(numero, retiros);
      const retiro = suyos[0] ?? null;
      const ancla = retiro ? (diaMxDeInstante(retiro.occurred_at) as string) : (diaMxDeInstante(h['aprobada_at']) as string);
      const deLaCuenta = new Set(cuentas.get(zona.clave) ?? []);
      let pago: PagoDeHojaGastos;
      if (!zona.cuenta_deposito || !deLaCuenta.size) {
        pago = { estado: retiro ? 'deposito_sin_medir' : 'sin_retiro', retiro: null, retiros_extra: 0, depositos: null,
          nota: zona.cuenta_deposito ? 'La cuenta de reposición de la zona no está en el catálogo de bancos.' : 'La cuenta donde se deposita la reposición de esta zona no está medida.' };
      } else {
        const libres = depositos.filter((d) => deLaCuenta.has(d.cuenta) && !usados.has(d.id));
        const dep = depositoDeHoja(Number(h['total']), ancla, libres);
        if (dep.estado === 'encontrado') dep.ids.forEach((i) => usados.add(i));
        pago = {
          estado: dep.estado === 'encontrado' ? 'depositada' : dep.estado === 'ambiguo' ? 'deposito_ambiguo' : retiro ? 'retiro_recibido' : 'sin_retiro',
          retiro: null, retiros_extra: 0,
          depositos: dep.estado === 'encontrado' ? libres.filter((d) => dep.ids.includes(d.id)).map(({ id, dia, importe }) => ({ id, dia, importe })) : null,
          nota: dep.estado === 'ambiguo' ? `Hay ${dep.opciones} formas de llegar al total con los depósitos de esos días: lo liga una persona.`
            : dep.estado === 'no_encontrado' ? (retiro ? 'El depósito todavía no aparece en el estado de cuenta.' : `Ningún retiro de CAOS dice ${folioHoja(numero)} en su referencia.`)
            : (retiro ? null : `El depósito llegó, pero ningún retiro de CAOS dice ${folioHoja(numero)}.`),
        };
      }
      pago.retiro = retiro ? { device: retiro.device, external_id: retiro.external_id, ref: retiro.ref, total: retiro.total,
        dia: diaMxDeInstante(retiro.occurred_at) as string } : null;
      pago.retiros_extra = Math.max(0, suyos.length - 1);
      out.set(String(h['id']), pago);
    }
    return out;
  }

  // ── Ayudantes ───────────────────────────────────────────────────────────────────────────────

  private async resolver(id: string, u: { id: string }, accion: (trx: Knex.Transaction, h: { id: string; cerrada_por: string }) => Promise<void>): Promise<HojaGastos> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      if (!(await HojaGastosService.instalada(trx))) {
        throw new ConflictException('Las hojas de gastos todavía no están instaladas en esta base (migración 20261029143450).');
      }
      const h = await trx('finance.expense_sheets').where({ tenant_id: tenantId, id }).forUpdate().first('id', 'estado', 'cerrada_por', 'numero');
      if (!h) throw new NotFoundException('Esa hoja no existe.');
      if (h.estado !== 'cerrada') throw new ConflictException(`La hoja ${folioHoja(Number(h.numero))} ya está ${h.estado}.`);
      await accion(trx, { id: String(h.id), cerrada_por: String(h.cerrada_por) });
      return this.una(trx, tenantId, String(h.id));
    });
  }

  private zona(clave: string): ZonaHojaGastos {
    const z = ZONAS_HOJA_GASTOS.find((x) => x.clave === clave);
    if (!z) throw new BadRequestException(`No hay una zona «${clave}» que se reponga por hoja.`);
    return z;
  }

  private motivo(input: MotivoHojaInput): string {
    const m = String(input?.motivo ?? '').trim();
    if (m.length < 10) throw new BadRequestException('Di por qué, en al menos 10 letras.');
    return m;
  }

  private requireUser(user: Usuario): { id: string; username?: string } {
    if (!user?.id) throw new ForbiddenException('Sin usuario no se firma.');
    return { id: user.id, username: user.username };
  }
}
