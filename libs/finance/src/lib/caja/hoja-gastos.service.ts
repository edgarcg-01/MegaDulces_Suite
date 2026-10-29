import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException,
} from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import {
  DIAS_RETIRO_HOJA, ZONAS_HOJA_GASTOS, diaMxDeInstante, folioHoja,
  type CerrarHojaInput, type ClaveZonaHoja, type HojaAbierta, type HojaGastos, type HojasDeGastos, type MedioPagoHoja,
  type MotivoHojaInput, type PagarHojaInput, type PagoDeHojaGastos, type PagoHojaResultado, type RenglonHoja,
  type ZonaHojaGastos,
} from '@megadulces/contracts';
import { consultasHoja } from './hoja-gastos.query';
import {
  armarHojaAbierta, cuadreDelRetiro, depositoDeHoja, instruccionDePago, retirosQueCuadran,
  type DepositoBancoHoja, type PagoDeZona, type RetiroLibreHoja,
} from './hoja-gastos.engine';
import { hojasInstaladas } from './hoja-gastos.gate';
import { redondea2, tomaDelRetiro } from './caja-lote.engine';
import { leerCandado } from './caja-candado.query';
import { CajaCustodiaService, sqlCustodiaCerrada, sqlDisponibleCaos } from './caja-custodia.service';
import { CashLedgerService } from './cash-ledger.service';
import { altaVinculoCaos } from '../caos/caos.service';

type Usuario = { id?: string; username?: string };

/** Las hojas cerradas que se muestran: las recientes, y las que siguen esperando firma o pago. */
const DIAS_HOJAS_CERRADAS = 45;
const RX_DIA = /^\d{4}-\d{2}-\d{2}$/;
const TIPO_RETIRO = 4;
const NO_INSTALADA = 'Las hojas de gastos todavía no están instaladas en esta base (migración 20261029143450).';

/** Un renglón de la hoja con su egreso del libro de Caja General, si ya entró. */
interface RenglonEnLibro {
  origen_ref: string;
  sucursal: string;
  fecha_pago: string;
  folio: string;
  ledger: {
    id: string; folio: string; tipo: string; monto: string | number; estado: string;
    origen_tipo: string | null; origen_efectivo: string | null; origen_ref: string | null; ligado: boolean;
  } | null;
}

/**
 * ⭐ `[CGA-A.65]` La hoja de gastos de zona: la abierta se ARMA de Kepler cada vez (no se guarda); la
 * cerrada guarda lo que una persona decidió. Todo lo que escribe vuelve a leer y a calcular en la
 * misma transacción, bajo candado: la pantalla manda qué pagos, quién y con qué retiro, nunca importes.
 *
 * ⭐ PAGAR es un solo acto (Edgar, 2026-10-29: *«debería pagarse todo con un solo movimiento y
 * vincularse»* · *«si no está aprobada no se puede pagar»*): la hoja aprobada pasa a pagada con UN
 * retiro de CAOS que la cuadra (o con el cajón, por excepción) y todos sus pagos quedan explicados
 * por él. No hay escritor nuevo del libro: lo que ya estaba capturado se liga con las reglas de
 * siempre (`altaVinculoCaos`) y lo que no, entra por el lote de siempre (`crearLote`) con ese retiro.
 */
@Injectable()
export class HojaGastosService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly ledger: CashLedgerService,
  ) {}

  /** ¿Está aplicada la migración de las hojas (`20261029143450`)? */
  static instalada(trx: Knex | Knex.Transaction): Promise<boolean> {
    return hojasInstaladas(trx);
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
      if (!(await HojaGastosService.instalada(trx))) throw new ConflictException(NO_INSTALADA);
      // El doble clic: la misma llave devuelve la misma hoja, no cierra otra.
      const ya = await trx('finance.expense_sheets').where({ tenant_id: tenantId, client_key: clientKey }).first('id', 'zona');
      if (ya) {
        if (ya.zona !== zona.clave) throw new ConflictException('Esa llave ya cerró una hoja de otra zona.');
        return this.una(trx, tenantId, String(ya.id));
      }
      // Un cierre a la vez por empresa: el número es consecutivo y un pago no entra en dos hojas.
      await trx.raw(`SELECT pg_advisory_xact_lock(hashtext(? || ':hoja-gastos'))`, [tenantId]);

      const filas = (await consultasHoja.pagos(trx, tenantId, [...zona.sucursales], zona.desde, { conHojas: true })) as PagoDeZona[];
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

  /**
   * ⭐ Pagar una hoja APROBADA, de un solo acto. Paso 1, en una transacción: la hoja pasa a pagada
   * con su retiro (o el cajón) y lo que ya estaba en el libro sin decir de dónde salió se liga a
   * ese retiro, en el orden de la hoja. Paso 2: lo que no estaba en el libro entra por el lote de
   * siempre con ese retiro (cada egreso toma lo suyo mientras alcance; la diferencia, del cajón).
   * Lo que el lote no pueda confirmar se dice y se reintenta con `capturar`.
   */
  async pagar(id: string, input: PagarHojaInput, user: Usuario): Promise<PagoHojaResultado> {
    const u = this.requireUser(user);
    const tenantId = this.tenantCtx.requireTenantId();
    const medio: MedioPagoHoja = input?.medio === 'cajon' ? 'cajon' : 'caos';
    const pedido = input?.medio === 'caos' ? { device: String(input.device ?? '').trim(), external_id: Number(input.external_id) } : null;
    if (medio === 'caos' && (!pedido?.device || !Number.isInteger(pedido.external_id) || pedido.external_id <= 0)) {
      throw new BadRequestException('Falta el retiro de CAOS que paga la hoja.');
    }

    const paso = await this.tk.run(async (trx) => {
      if (!(await HojaGastosService.instalada(trx))) throw new ConflictException(NO_INSTALADA);
      // Con la caja bloqueada (sin corte de ayer) el lote no guarda nada: se dice ANTES de marcarla pagada.
      const candado = await leerCandado(trx, tenantId, u.id);
      if (candado.bloqueado) throw new HttpException({ statusCode: HttpStatus.LOCKED, message: candado.texto, candado }, HttpStatus.LOCKED);

      const h = await trx('finance.expense_sheets').where({ tenant_id: tenantId, id }).forUpdate()
        .first('id', 'numero', 'estado', 'total', 'aprobada_por', 'zona');
      if (!h) throw new NotFoundException('Esa hoja no existe.');
      const folio = folioHoja(Number(h.numero));
      if (h.estado === 'cerrada') throw new ConflictException(`La hoja ${folio} todavía no está aprobada: sin aprobación no se paga.`);
      if (h.estado !== 'aprobada') throw new ConflictException(`La hoja ${folio} ya está ${h.estado}.`);
      if (String(h.aprobada_por) === u.id) throw new ForbiddenException('Quien aprobó la hoja no la paga: la paga otra persona.');
      const total = redondea2(Number(h.total));

      const renglones = await this.renglonesEnLibro(trx, tenantId, String(h.id), this.zona(String(h.zona)));
      const pagados = renglones.filter((x) => x.ledger && (x.ledger.ligado || x.ledger.origen_efectivo === 'cajon'));
      if (pagados.length) {
        throw new ConflictException(`${pagados.length === 1 ? 'Un pago' : `${pagados.length} pagos`} de la hoja ${folio} ya salieron de otro lado (${pagados.map((x) => x.ledger?.folio).join(', ')}): esta hoja no se puede pagar entera con un solo movimiento. Rechácenla para sacarlos.`);
      }
      const sinOrigen = renglones.filter((x) => x.ledger);
      if (medio === 'cajon' && sinOrigen.length) {
        throw new ConflictException(`${sinOrigen.length} ${sinOrigen.length === 1 ? 'pago ya está' : 'pagos ya están'} en el libro sin decir de dónde salió el dinero: esta hoja se paga con un retiro de CAOS.`);
      }

      let mov: { device: string; external_id: number; type_id: number; ref: string | null; libre: number } | null = null;
      let cajon = total;
      if (pedido) {
        const custodia = await CajaCustodiaService.hayCustodia(trx);
        const m = await trx('analytics.caos_cash_movements as m')
          .where({ 'm.tenant_id': tenantId, 'm.device': pedido.device, 'm.external_id': pedido.external_id })
          .first('m.device', 'm.external_id', 'm.type_id', 'm.ref', trx.raw('abs(m.total) AS total'),
            trx.raw(`${sqlDisponibleCaos('m')} AS libre`),
            trx.raw(`${custodia ? sqlCustodiaCerrada('m') : 'false'} AS cerrada`),
            trx.raw(`EXISTS (SELECT 1 FROM finance.cash_ledger c WHERE c.tenant_id = m.tenant_id AND c.origen_tipo = 'caos'
                AND c.origen_ref = m.device || '|' || m.external_id AND c.deleted_at IS NULL AND c.estado <> 'cancelado') AS capturado`));
        if (!m) throw new NotFoundException('Ese retiro de CAOS no existe.');
        if (Number(m.type_id) !== TIPO_RETIRO) throw new BadRequestException('Sólo un RETIRO de CAOS (Dispensar) paga la hoja.');
        if (m.cerrada) throw new ConflictException('Ese retiro tiene su custodia cerrada: ya no paga egresos.');
        if (m.capturado || Math.abs(Number(m.libre) - Number(m.total)) > 0.005) {
          throw new ConflictException(`El retiro «${m.ref ?? m.external_id}» ya explica otros egresos: la hoja se paga con un retiro entero, libre.`);
        }
        const otra = await trx('finance.expense_sheets').where({ tenant_id: tenantId, caos_device: m.device, caos_external_id: m.external_id }).first('numero');
        if (otra) throw new ConflictException(`Ese retiro ya pagó la hoja ${folioHoja(Number(otra.numero))}.`);
        const c = cuadreDelRetiro(total, Number(m.libre));
        if (!c.ok) throw new ConflictException(c.texto);
        cajon = c.cajon;
        mov = { device: String(m.device), external_id: Number(m.external_id), type_id: Number(m.type_id), ref: m.ref ?? null, libre: redondea2(Number(m.libre)) };
      }

      await trx('finance.expense_sheets').where({ id: h.id }).update({
        estado: 'pagada', medio, pagada_por: u.id, pagada_at: trx.fn.now(),
        caos_device: mov?.device ?? null, caos_external_id: mov?.external_id ?? null, caos_total: mov?.libre ?? null,
        cajon, updated_by: u.id,
      });

      // Lo capturado sin origen se liga al retiro de la hoja, con las reglas de siempre, en un solo fajo.
      let libre = mov?.libre ?? 0;
      let ligados = 0;
      for (const x of sinOrigen) {
        if (!mov || !x.ledger) break;
        const toma = tomaDelRetiro(Number(x.ledger.monto), libre);
        if (toma <= 0) break;
        await altaVinculoCaos(trx as Knex.Transaction, tenantId, x.ledger, mov, toma,
          { manual: true, via: 'hoja_gastos', hoja: folio, por: u.username ?? null }, { id: u.id });
        libre = redondea2(libre - toma);
        ligados++;
      }
      return { porCapturar: renglones.filter((x) => !x.ledger).map((x) => x.origen_ref), ligados, mov };
    });

    const lote = await this.capturarRefs(paso.porCapturar, medio, paso.mov, u);
    return this.resultado(tenantId, id, paso.ligados, lote);
  }

  /** Reintenta la captura de lo que el lote no pudo confirmar al pagar (casi siempre, la cuenta del beneficiario). */
  async capturar(id: string, user: Usuario): Promise<PagoHojaResultado> {
    const u = this.requireUser(user);
    const tenantId = this.tenantCtx.requireTenantId();
    const paso = await this.tk.run(async (trx) => {
      if (!(await HojaGastosService.instalada(trx))) throw new ConflictException(NO_INSTALADA);
      const h = await trx('finance.expense_sheets').where({ tenant_id: tenantId, id })
        .first('id', 'numero', 'estado', 'zona', 'medio', 'caos_device', 'caos_external_id');
      if (!h) throw new NotFoundException('Esa hoja no existe.');
      if (h.estado !== 'pagada') throw new ConflictException(`La hoja ${folioHoja(Number(h.numero))} no está pagada: primero se paga.`);
      const renglones = await this.renglonesEnLibro(trx, tenantId, String(h.id), this.zona(String(h.zona)));
      return {
        porCapturar: renglones.filter((x) => !x.ledger).map((x) => x.origen_ref),
        medio: h.medio as MedioPagoHoja,
        mov: h.medio === 'caos' ? { device: String(h.caos_device), external_id: Number(h.caos_external_id) } : null,
      };
    });
    const lote = await this.capturarRefs(paso.porCapturar, paso.medio, paso.mov, u);
    return this.resultado(tenantId, id, 0, lote);
  }

  // ── Lectura ─────────────────────────────────────────────────────────────────────────────────

  private async abierta(trx: Knex.Transaction, tenantId: string, zona: ZonaHojaGastos, instalada: boolean, datosAl: string | null) {
    const filas = (await consultasHoja.pagos(trx, tenantId, [...zona.sucursales], zona.desde, { conHojas: instalada })) as PagoDeZona[];
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
      .orWhereIn('s.estado', ['cerrada', 'aprobada'])));
  }

  private async leerHojas(trx: Knex.Transaction, tenantId: string, filtro: (q: Knex.QueryBuilder) => void): Promise<HojaGastos[]> {
    const q = trx('finance.expense_sheets as s')
      .leftJoin('identity.users as uc', 'uc.id', 's.cerrada_por')
      .leftJoin('identity.users as ua', 'ua.id', 's.aprobada_por')
      .leftJoin('identity.users as up', 'up.id', 's.pagada_por')
      .leftJoin('identity.users as ur', 'ur.id', trx.raw('coalesce(s.rechazada_por, s.cancelada_por)'))
      .where('s.tenant_id', tenantId)
      .orderBy('s.numero', 'desc').limit(200)
      .select('s.id', 's.numero', 's.zona', 's.estado', 's.total', 's.cerrada_por', 's.aprobada_por', 's.motivo',
        's.medio', 's.caos_device', 's.caos_external_id', 's.cajon',
        trx.raw(`to_char(s.venta_del_dia, 'YYYY-MM-DD') AS venta_del_dia`),
        's.cerrada_at', 's.aprobada_at', 's.pagada_at', trx.raw('coalesce(s.rechazada_at, s.cancelada_at) AS resuelta_at'),
        'uc.username as cerrada_por_nombre', 'ua.username as aprobada_por_nombre', 'up.username as pagada_por_nombre',
        'ur.username as resuelta_por_nombre');
    filtro(q);
    const filas = await q;
    if (!filas.length) return [];
    const ids = filas.map((f) => String(f.id));
    const lineas = await trx('finance.expense_sheet_lines').where('tenant_id', tenantId).whereIn('sheet_id', ids)
      .orderBy([{ column: 'sucursal', order: 'asc' }, { column: 'fecha_pago', order: 'asc' }, { column: 'folio', order: 'asc' }])
      .select('sheet_id', 'origen_ref', 'sucursal', 'doc_tipo', 'folio', 'beneficiario', 'clave', 'centro', 'clase', 'importe',
        trx.raw(`to_char(fecha_pago, 'YYYY-MM-DD') AS fecha_pago`), trx.raw(`to_char(fecha_captura, 'YYYY-MM-DD') AS fecha_captura`));

    const renglonesDe = (f: Record<string, unknown>): RenglonHoja[] => {
      const zona = this.zona(String(f['zona']));
      const orden = (s: string) => zona.sucursales.indexOf(s);
      return lineas.filter((l) => String(l.sheet_id) === String(f['id']))
        .map((l) => ({
          origen_ref: l.origen_ref, sucursal: l.sucursal, doc_tipo: l.doc_tipo, folio: l.folio, fecha_pago: l.fecha_pago,
          fecha_captura: l.fecha_captura, beneficiario: l.beneficiario, clave: l.clave, centro: l.centro,
          clase: l.clase, importe: redondea2(Number(l.importe)),
        }))
        .sort((a, b) => orden(a.sucursal) - orden(b.sucursal) || a.fecha_pago.localeCompare(b.fecha_pago) || a.folio.localeCompare(b.folio));
    };
    const renglones = new Map(filas.map((f) => [String(f.id), renglonesDe(f)]));
    const cuadran = await this.retirosQueLasCuadran(trx, tenantId, filas.filter((f) => f.estado === 'aprobada'), renglones);
    const pagos = await this.pagos(trx, tenantId, filas.filter((f) => f.estado === 'pagada'));

    return filas.map((f): HojaGastos => {
      const zona = this.zona(String(f.zona));
      const rs = renglones.get(String(f.id)) ?? [];
      const total = redondea2(Number(f.total));
      return {
        id: String(f.id), numero: Number(f.numero), folio: folioHoja(Number(f.numero)), zona: zona.clave, nombre_zona: zona.nombre,
        venta_del_dia: f.venta_del_dia, estado: f.estado, total, renglones: rs,
        por_sucursal: zona.sucursales.map((s) => {
          const xs = rs.filter((r) => r.sucursal === s);
          return { sucursal: s, renglones: xs.length, total: redondea2(xs.reduce((a, r) => a + r.importe, 0)) };
        }),
        cerrada_por: String(f.cerrada_por), cerrada_por_nombre: f.cerrada_por_nombre ?? null,
        cerrada_at: new Date(f.cerrada_at).toISOString(),
        aprobada_por: f.aprobada_por ? String(f.aprobada_por) : null,
        aprobada_por_nombre: f.aprobada_por_nombre ?? null,
        aprobada_at: f.aprobada_at ? new Date(f.aprobada_at).toISOString() : null,
        resuelta_por_nombre: f.resuelta_por_nombre ?? null,
        resuelta_at: f.resuelta_at ? new Date(f.resuelta_at).toISOString() : null,
        motivo: f.motivo ?? null,
        instruccion: instruccionDePago(total, Number(f.numero)),
        retiros_que_cuadran: cuadran.get(String(f.id)) ?? [],
        pago: pagos.get(String(f.id)) ?? null,
      };
    });
  }

  /**
   * Para cada hoja aprobada, los retiros de CAOS libres que la pagan entera: de su último pago (o
   * de su aprobación, si fue después) a `DIAS_RETIRO_HOJA` días; sin nada ligado, sin capturar
   * como movimiento propio, sin custodia cerrada y sin haber pagado otra hoja.
   */
  private async retirosQueLasCuadran(trx: Knex.Transaction, tenantId: string, aprobadas: Array<Record<string, unknown>>, renglones: Map<string, RenglonHoja[]>) {
    const out = new Map<string, ReturnType<typeof retirosQueCuadran>>();
    if (!aprobadas.length) return out;
    const ventana = aprobadas.map((h) => {
      const ultimo = (renglones.get(String(h['id'])) ?? []).map((r) => r.fecha_pago).sort().pop() ?? (diaMxDeInstante(h['cerrada_at']) as string);
      const aprobada = diaMxDeInstante(h['aprobada_at']) as string;
      return { h, desde: ultimo, hasta: aprobada > ultimo ? aprobada : ultimo };
    });
    const desde = ventana.map((v) => v.desde).sort()[0];
    const hasta = ventana.map((v) => v.hasta).sort().pop() as string;
    const custodia = await CajaCustodiaService.hayCustodia(trx);
    const q = trx('analytics.caos_cash_movements as m')
      .where('m.tenant_id', tenantId).where('m.type_id', TIPO_RETIRO)
      .where('m.occurred_at', '>=', trx.raw(`(?::date - 1)`, [desde]))
      // Un día de margen a cada lado por el huso: el motor recorta por el día de México.
      .where('m.occurred_at', '<', trx.raw(`(?::date + ?::int)`, [hasta, DIAS_RETIRO_HOJA + 2]))
      .whereRaw(`abs(abs(m.total) - ${sqlDisponibleCaos('m')}) < 0.005`)
      .whereRaw(`NOT EXISTS (SELECT 1 FROM finance.cash_ledger c WHERE c.tenant_id = m.tenant_id AND c.origen_tipo = 'caos'
          AND c.origen_ref = m.device || '|' || m.external_id AND c.deleted_at IS NULL AND c.estado <> 'cancelado')`)
      .whereRaw(`NOT EXISTS (SELECT 1 FROM finance.expense_sheets s WHERE s.tenant_id = m.tenant_id
          AND s.caos_device = m.device AND s.caos_external_id = m.external_id)`);
    if (custodia) q.whereRaw(`NOT ${sqlCustodiaCerrada('m')}`);
    const libres: RetiroLibreHoja[] = (await q.select('m.device', 'm.external_id', 'm.occurred_at', 'm.ref', trx.raw('abs(m.total) AS total')))
      .map((r) => ({ device: String(r.device), external_id: Number(r.external_id), occurred_at: new Date(r.occurred_at).toISOString(),
        dia: diaMxDeInstante(r.occurred_at) as string, ref: r.ref ?? null, total: redondea2(Number(r.total)) }));
    for (const v of ventana) {
      out.set(String(v.h['id']), retirosQueCuadran(Number(v.h['total']), Number(v.h['numero']), v.desde, v.hasta, libres));
    }
    return out;
  }

  /**
   * El pago de cada hoja pagada: con qué salió, lo que falta por entrar al libro y si el depósito
   * por su total ya llegó a la cuenta de reposición de su zona (una o dos partes, del día del pago a
   * siete días). Las hojas se recorren de la más vieja a la más nueva y un depósito sólo explica a una.
   */
  private async pagos(trx: Knex.Transaction, tenantId: string, pagadas: Array<Record<string, unknown>>): Promise<Map<string, PagoDeHojaGastos>> {
    const out = new Map<string, PagoDeHojaGastos>();
    if (!pagadas.length) return out;
    const conRetiro = pagadas.filter((h) => h['medio'] === 'caos');
    const retiros = conRetiro.length
      ? await trx('analytics.caos_cash_movements').where('tenant_id', tenantId)
        .whereRaw(`(device, external_id) IN (${conRetiro.map(() => '(?, ?)').join(', ')})`,
          conRetiro.flatMap((h) => [String(h['caos_device']), Number(h['caos_external_id'])]))
        .select('device', 'external_id', 'ref', 'occurred_at', trx.raw('abs(total) AS total'))
      : [];
    const retiroDe = new Map(retiros.map((r) => [`${r.device}|${Number(r.external_id)}`, r]));
    const faltan = await trx('finance.expense_sheet_lines as x')
      .whereIn('x.sheet_id', pagadas.map((h) => String(h['id']))).where('x.vigente', true)
      .whereRaw(`NOT EXISTS (SELECT 1 FROM finance.cash_ledger cl WHERE cl.tenant_id = x.tenant_id AND cl.origen_tipo = 'pago_proveedor'
          AND cl.deleted_at IS NULL AND cl.estado <> 'cancelado' AND cl.origen_ref = x.origen_ref)`)
      .groupBy('x.sheet_id').select('x.sheet_id', trx.raw('count(*)::int AS n'));
    const faltanDe = new Map(faltan.map((f) => [String(f.sheet_id), Number(f.n)]));

    const desde = pagadas.map((h) => diaMxDeInstante(h['pagada_at']) as string).sort()[0];
    const cuentas = new Map<ClaveZonaHoja, string[]>();
    for (const z of ZONAS_HOJA_GASTOS) {
      if (!z.cuenta_deposito) continue;
      const cs = (await trx('finance.bank_accounts').where('tenant_id', tenantId)
        .whereRaw('upper(btrim(bank)) = ?', [z.cuenta_deposito.banco.toUpperCase()])
        .where('account_label', z.cuenta_deposito.terminacion).select('id')).map((r) => String(r.id));
      cuentas.set(z.clave, cs);
    }
    const todas = [...new Set([...cuentas.values()].flat())];
    const depositos: Array<DepositoBancoHoja & { cuenta: string }> = todas.length
      ? (await trx('finance.bank_movements').where('tenant_id', tenantId).whereNull('deleted_at').where('amount_in', '>', 0)
        .whereIn('bank_account_id', todas).where('movement_date', '>=', trx.raw(`(?::date - 3)`, [desde]))
        .select(trx.raw('id::text AS id'), trx.raw(`to_char(movement_date, 'YYYY-MM-DD') AS dia`), 'amount_in', trx.raw('bank_account_id::text AS cuenta')))
        .map((d) => ({ id: d.id, dia: d.dia, importe: redondea2(Number(d.amount_in)), cuenta: d.cuenta }))
      : [];
    const usados = new Set<string>();

    for (const h of [...pagadas].sort((a, b) => Number(a['numero']) - Number(b['numero']))) {
      const zona = this.zona(String(h['zona']));
      const r = h['medio'] === 'caos' ? retiroDe.get(`${h['caos_device']}|${Number(h['caos_external_id'])}`) : null;
      const retiro = r ? { device: String(r.device), external_id: Number(r.external_id), ref: r.ref ?? null,
        total: redondea2(Number(r.total)), dia: diaMxDeInstante(r.occurred_at) as string } : null;
      // El depósito se busca desde el día del retiro (o del pago con el cajón).
      const ancla = retiro?.dia ?? (diaMxDeInstante(h['pagada_at']) as string);
      const deLaCuenta = new Set(cuentas.get(zona.clave) ?? []);
      let deposito: PagoDeHojaGastos['deposito'];
      if (!zona.cuenta_deposito || !deLaCuenta.size) {
        deposito = { estado: 'sin_medir', depositos: null,
          nota: zona.cuenta_deposito ? 'La cuenta de reposición de la zona no está en el catálogo de bancos.' : 'La cuenta donde se deposita la reposición de esta zona no está medida.' };
      } else {
        const libres = depositos.filter((d) => deLaCuenta.has(d.cuenta) && !usados.has(d.id));
        const dep = depositoDeHoja(Number(h['total']), ancla, libres);
        if (dep.estado === 'encontrado') dep.ids.forEach((i) => usados.add(i));
        deposito = dep.estado === 'encontrado'
          ? { estado: 'depositada', depositos: libres.filter((d) => dep.ids.includes(d.id)).map(({ id, dia, importe }) => ({ id, dia, importe })), nota: null }
          : dep.estado === 'ambiguo'
            ? { estado: 'ambiguo', depositos: null, nota: `Hay ${dep.opciones} formas de llegar al total con los depósitos de esos días: lo liga una persona.` }
            : { estado: 'no_aparece', depositos: null, nota: 'El depósito todavía no aparece en el estado de cuenta.' };
      }
      out.set(String(h['id']), {
        medio: h['medio'] as MedioPagoHoja, retiro, cajon: redondea2(Number(h['cajon'])),
        pagada_por_nombre: (h['pagada_por_nombre'] as string | null) ?? null,
        pagada_at: new Date(h['pagada_at'] as string).toISOString(),
        sin_capturar: faltanDe.get(String(h['id'])) ?? 0,
        deposito,
      });
    }
    return out;
  }

  // ── Ayudantes ───────────────────────────────────────────────────────────────────────────────

  /** Los renglones vigentes de una hoja, en su orden, con su egreso del libro si ya entró. */
  private async renglonesEnLibro(trx: Knex.Transaction, tenantId: string, sheetId: string, zona: ZonaHojaGastos): Promise<RenglonEnLibro[]> {
    const filas = await trx('finance.expense_sheet_lines as x')
      .joinRaw(`LEFT JOIN LATERAL (
          SELECT cl.id, cl.folio, cl.tipo, cl.monto, cl.estado, cl.origen_tipo, cl.origen_efectivo, cl.origen_ref,
                 EXISTS (SELECT 1 FROM finance.caos_cash_links kl
                          WHERE kl.tenant_id = cl.tenant_id AND kl.cash_ledger_id = cl.id AND kl.deleted_at IS NULL) AS ligado
            FROM finance.cash_ledger cl
           WHERE cl.tenant_id = x.tenant_id AND cl.origen_tipo = 'pago_proveedor' AND cl.deleted_at IS NULL
             AND cl.estado <> 'cancelado' AND cl.origen_ref = x.origen_ref
           LIMIT 1) lb ON true`)
      .where('x.tenant_id', tenantId).where('x.sheet_id', sheetId).where('x.vigente', true)
      .select('x.origen_ref', 'x.sucursal', 'x.folio', trx.raw(`to_char(x.fecha_pago, 'YYYY-MM-DD') AS fecha_pago`),
        trx.raw('lb.id AS l_id'), trx.raw('lb.folio AS l_folio'), trx.raw('lb.tipo AS l_tipo'), trx.raw('lb.monto AS l_monto'),
        trx.raw('lb.estado AS l_estado'), trx.raw('lb.origen_tipo AS l_origen_tipo'), trx.raw('lb.origen_efectivo AS l_origen_efectivo'),
        trx.raw('lb.origen_ref AS l_origen_ref'), trx.raw('lb.ligado AS l_ligado'));
    const orden = (s: string) => zona.sucursales.indexOf(s);
    return filas
      .map((f): RenglonEnLibro => ({
        origen_ref: String(f.origen_ref), sucursal: String(f.sucursal), fecha_pago: String(f.fecha_pago), folio: String(f.folio),
        ledger: f.l_id ? {
          id: String(f.l_id), folio: String(f.l_folio), tipo: String(f.l_tipo), monto: f.l_monto, estado: String(f.l_estado),
          origen_tipo: f.l_origen_tipo ?? null, origen_efectivo: f.l_origen_efectivo ?? null, origen_ref: f.l_origen_ref ?? null,
          ligado: f.l_ligado === true,
        } : null,
      }))
      .sort((a, b) => orden(a.sucursal) - orden(b.sucursal) || a.fecha_pago.localeCompare(b.fecha_pago) || a.folio.localeCompare(b.folio));
  }

  /** El lote de siempre, con el retiro de la hoja (o del cajón). Lo que no entró se dice con su motivo. */
  private async capturarRefs(refs: string[], medio: MedioPagoHoja, mov: { device: string; external_id: number } | null, u: { id: string; username?: string }) {
    if (!refs.length) return { capturados: 0, motivos: new Map<string, string | null>() };
    const r = await this.ledger.crearLote({
      items: refs.map((origen_ref) => ({ origen_ref })),
      ...(medio === 'caos' && mov ? { caos_retiro: { device: mov.device, external_id: mov.external_id } } : { origen_efectivo: 'cajon' as const }),
    }, u);
    return { capturados: r.guardados, motivos: new Map(r.filas.filter((f) => f.estado !== 'guardado').map((f) => [f.origen_ref, f.motivo ?? null])) };
  }

  /** La hoja como quedó, y lo que de verdad falta por entrar al libro (no lo que el lote creyó). */
  private async resultado(tenantId: string, id: string, ligados: number, lote: { capturados: number; motivos: Map<string, string | null> }): Promise<PagoHojaResultado> {
    return this.tk.run(async (trx) => {
      const hoja = await this.una(trx, tenantId, id);
      const faltan = (await this.renglonesEnLibro(trx, tenantId, id, this.zona(hoja.zona))).filter((x) => !x.ledger);
      return {
        hoja, ligados, capturados: lote.capturados,
        sin_capturar: faltan.map((x) => ({ origen_ref: x.origen_ref, motivo: lote.motivos.get(x.origen_ref) ?? null })),
      };
    });
  }

  private async resolver(id: string, u: { id: string }, accion: (trx: Knex.Transaction, h: { id: string; cerrada_por: string }) => Promise<void>): Promise<HojaGastos> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      if (!(await HojaGastosService.instalada(trx))) throw new ConflictException(NO_INSTALADA);
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
