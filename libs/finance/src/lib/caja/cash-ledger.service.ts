import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { FINANCE_FINDINGS_SINK_PORT, type FinanceFindingsSinkPort } from '@megadulces/contracts';
import { buildFolio } from './caja-autofill.engine';
import {
  esConfirmable, resumirLote, evaluarDescuadre, rankearFrecuentes,
  TEXTO_NO_CONFIRMABLE, FRECUENTE_MIN_USOS,
  type MapaRuta, type FilaLote, type ResumenLote, type Descuadre,
} from './caja-lote.engine';

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
    // CG.20 — `@Optional()` a propósito: si Maat está apagado, el descuadre no se registra pero el
    // efectivo SÍ. Un hallazgo que no se pudo guardar no puede impedir que el dinero entre al libro.
    @Optional() @Inject(FINANCE_FINDINGS_SINK_PORT) private readonly findingsSink?: FinanceFindingsSinkPort,
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
      // CG.19 Capa 1 — qué proporción del ingreso descansa en un hecho de Kepler y cuánta en un
      // teclado. Va SIEMPRE, por el mismo motivo que las otras dos: sin este número, una caja
      // 100% capturada a mano se ve idéntica a una anclada al ERP (ADR-056).
      const ingreso = await trx('finance.v_caja_ingreso_cobertura')
        .orderBy([{ column: 'mes', order: 'desc' }, { column: 'sucursal', order: 'asc' }])
        .limit(24)
        .select('*');
      return { catalogo, mapa, ingreso };
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
   * CG.19 Capa 1 — **El valor se TOMA de Kepler.**
   *
   * Cuando el movimiento viene anclado a un cobro del ERP, el monto **no se acepta del cliente**:
   * se lee de `finance.v_caja_ingresos_pendientes` (vista viva sobre `analytics.erp_collections`).
   * Si el capturista manda otra cifra, se ignora — y si difiere, se dice, porque un front que
   * manda un monto distinto del documento es un bug que hay que ver, no un dato que hay que
   * aceptar.
   *
   * ⚠️ La vista ya excluye lo aplicado, así que "no encontrado" tiene DOS causas muy distintas y
   * se separan a propósito: un cobro que no existe es un error de integración; uno ya aplicado es
   * una persona repitiendo trabajo, y merece otro mensaje.
   *
   * ⚠️ No hay `FOR UPDATE` posible sobre una vista del ODS. La carrera la corta el índice único
   * `ux_cash_ledger_origen_vivo` (23505), que se traduce abajo. El candado es el índice; esto es
   * para que el usuario vea una frase en vez de un error de Postgres.
   */
  private async resolveCobro(trx: any, tenantId: string, origenRef: string) {
    const row = await trx('finance.v_caja_ingresos_pendientes')
      .where({ tenant_id: tenantId, origen_ref: origenRef })
      .first('origen_ref', 'folio', 'sucursal', 'cobro_date', 'cliente_code', 'cliente_nombre', 'concepto', 'monto', 'tipo_cuenta');
    if (row) return row;

    const aplicado = await trx('finance.cash_ledger')
      .where({ tenant_id: tenantId, origen_tipo: 'cobro', origen_ref: origenRef })
      .whereNull('deleted_at').whereNot('estado', 'cancelado')
      .first('folio', 'fecha', 'created_by_username');
    if (aplicado) {
      throw new BadRequestException(
        `Ese cobro de Kepler ya se registró en la caja con el folio ${aplicado.folio}`
        + `${aplicado.created_by_username ? ` (lo capturó ${aplicado.created_by_username})` : ''}. `
        + 'Un mismo cobro no puede entrar dos veces: si el anterior está mal, cancelalo y volvé a registrarlo.',
      );
    }
    throw new BadRequestException(
      `El cobro ${origenRef} no existe en Kepler. No se registra efectivo contra un documento que el ERP no tiene.`,
    );
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

    return this.tk.run(async (trx) => {
      // Idempotencia: el reintento del cliente devuelve el movimiento que ya se guardó,
      // no un 409 ni un duplicado.
      if (input.client_uuid) {
        const prev = await trx('finance.cash_ledger')
          .where({ tenant_id: tenantId, client_uuid: input.client_uuid }).first();
        if (prev) return { ...prev, idempotent_replay: true };
      }

      // ⭐ El monto del documento MANDA sobre el del formulario.
      const anclado = input.origen_tipo === 'cobro' && !!input.origen_ref;
      const cobro = anclado ? await this.resolveCobro(trx, tenantId, input.origen_ref as string) : null;
      const monto = cobro ? Number(cobro.monto) : Number(input.monto);
      const montoDiscrepa = cobro != null && Math.abs(Number(input.monto || 0) - monto) > ARQUEO_EPSILON;

      // ⚠️ El arqueo se comprueba contra el monto RESUELTO, no contra el que llegó. Si se validara
      // antes (como estaba), un movimiento anclado podría guardarse con un desglose que cuadra
      // contra la cifra del formulario y NO contra la del documento.
      this.assertArqueo(monto, input.morralla ?? 0, dens);

      // La fecha NO se toma del cobro a propósito: `cobro_date` es cuándo Kepler registró el
      // documento y `fecha` es cuándo entró el efectivo a la caja. Son dos hechos distintos y
      // confundirlos volvería a meter la fecha del ERP en un arqueo físico.
      const snap = await this.resolveConcept(trx, tenantId, input.sucursal, input.kepler_cuenta, input.kepler_concepto);
      const year = Number(String(input.fecha).slice(0, 4));
      const folio = await this.nextFolio(trx, tenantId, input.tipo, year);

      // Con el cobro atado, el capturista no tiene que escribir el motivo: ya está en el documento.
      const glosa = input.glosa?.trim()
        || (cobro ? `Cobro ${cobro.folio} · ${cobro.cliente_nombre || cobro.cliente_code || 'cliente'}`.slice(0, 200) : '');

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
        glosa,
        beneficiario: input.beneficiario ?? (cobro?.cliente_nombre ?? null),
        beneficiario_rfc: input.beneficiario_rfc ?? null,
        monto,
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
      // Que el monto del formulario NO coincidiera con el del documento se DICE. Es un dato de
      // diagnóstico, no un error: el que manda es el de Kepler y ya se guardó ése. Si esto aparece
      // seguido, el front está mandando una cifra propia y hay que ir a verlo.
      return montoDiscrepa
        ? { ...mov, monto_origen: 'kepler', monto_enviado: Number(input.monto), monto_aplicado: monto }
        : mov;
    });
  }

  /**
   * CG.19 Capa 1 — **Ingresos recientes que se pueden entregar y arquear.**
   *
   * Es el cambio de forma que pidió Edgar: en vez de que el capturista teclee fecha, motivo y
   * monto, se le muestran los cobros que Kepler YA registró y él **elige cuál está entregando**.
   * El registro precede al dinero, y el valor se toma del ERP.
   *
   * ⚠️ Lo que NO está en esta lista no deja de existir: es justamente el ingreso que todavía se
   * captura a mano (~40-45% del total, medido). Por eso `coverage()` publica la proporción — una
   * lista corta no puede leerse como "ya está todo cubierto".
   */
  async ingresosPendientes(q: { sucursal?: string; tipo_cuenta?: string; from?: string; to?: string; search?: string; limit?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    return this.tk.run(async (trx) => {
      let qb = trx('finance.v_caja_ingresos_pendientes').where('tenant_id', tenantId);
      if (q.sucursal) qb = qb.where('sucursal', q.sucursal);
      if (q.tipo_cuenta) qb = qb.where('tipo_cuenta', q.tipo_cuenta);
      if (q.from) qb = qb.where('cobro_date', '>=', q.from);
      if (q.to) qb = qb.where('cobro_date', '<=', q.to);
      if (q.search) {
        // `%` y `_` escapados: sin esto, buscar "100%" devuelve TODO y la persona cree que filtró.
        const s = `%${String(q.search).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        qb = qb.where((b: any) => b
          .whereRaw(`cliente_nombre ILIKE ? ESCAPE '\\'`, [s])
          .orWhereRaw(`cliente_code ILIKE ? ESCAPE '\\'`, [s])
          .orWhereRaw(`folio ILIKE ? ESCAPE '\\'`, [s]));
      }
      const rows = await qb
        .orderBy([{ column: 'cobro_date', order: 'desc' }, { column: 'folio', order: 'desc' }])
        .limit(limit)
        .select('origen_ref', 'sucursal', 'folio', 'cobro_date', 'cliente_code', 'cliente_nombre',
          'concepto', 'monto', 'tipo_cuenta', 'forma_pago');

      // ⭐ CG.20 — la CUENTA CONTABLE también viene resuelta, para que no quede ni un campo por
      // elegir. Sale del mapa DECLARADO (`finance.route_customer_map`), nunca de un regex sobre
      // el nombre: ese texto llega en dos formas para la misma ruta ("26 Ruta 26", "RUTA 21",
      // "Ventas PH 26/08 RD 21") y es justo lo que la regla M3 prohíbe usar para mover dinero.
      const mapa = await this.mapaDeRutas(trx, tenantId, rows.map((r: any) => r.cliente_code));
      const conCuenta = rows.map((r: any) => {
        const v = esConfirmable({ origen_ref: r.origen_ref, cliente_code: r.cliente_code, monto: Number(r.monto) },
          mapa.get(String(r.cliente_code ?? '')) ?? null);
        return v.ok
          ? { ...r, confirmable: true, kepler_cuenta: v.kepler_cuenta, kepler_concepto: v.kepler_concepto }
          // Lo que no se puede confirmar viaja con su MOTIVO y sin cuenta. Mandar la fila sin decir
          // por qué la deja fuera obliga a la pantalla a adivinar, y adivinar acá es inventar una
          // cuenta contable.
          : { ...r, confirmable: false, kepler_cuenta: null, kepler_concepto: null,
              motivo: v.motivo, motivo_texto: TEXTO_NO_CONFIRMABLE[v.motivo] };
      });
      return {
        rows: conCuenta, limit, has_more: rows.length === limit,
        // Cuántas de las que se ven se pueden confirmar sin tocar nada. Sin este número, una lista
        // llena de filas no confirmables se lee igual que una lista lista para un clic (ADR-056).
        confirmables: conCuenta.filter((r: any) => r.confirmable).length,
      };
    });
  }

  /**
   * El mapa declarado ruta → (cliente, cuenta), indexado por `cliente_code`.
   *
   * ⚠️ Se busca por `cliente_code` (el código del ERP) y no por `route_code`, porque es lo que el
   * cobro trae. La fila del mapa liga los dos; acá sólo se lee.
   */
  private async mapaDeRutas(trx: any, tenantId: string, codigos: Array<string | null>) {
    const lista = [...new Set(codigos.filter(Boolean).map(String))];
    const m = new Map<string, MapaRuta>();
    if (!lista.length) return m;
    const filas = await trx('finance.route_customer_map')
      .where('tenant_id', tenantId).whereIn('cliente_code', lista)
      .select('cliente_code', 'confirmed_at', 'kepler_cuenta', 'kepler_concepto');
    filas.forEach((f: any) => m.set(String(f.cliente_code), f));
    return m;
  }

  /**
   * ⭐ CG.20 — **Confirmar N entregas de un golpe.**
   *
   * Es el cambio que pidió Edgar: *"mientras menos clic mejor"*. La persona ya no captura fecha,
   * cliente, cuenta, concepto ni monto — sólo marca las entregas que llegaron y, si contó distinto
   * de lo que dice el ERP, escribe lo contado.
   *
   * ⛔ **Cada fila va en SU PROPIA transacción, a propósito.** Si todo el lote fuera una sola trx,
   * confirmar 12 entregas y perderlas porque la tercera ya estaba aplicada convertiría el lote en
   * un castigo — y la persona volvería a capturar de a una, que es exactamente lo que esta fase
   * viene a eliminar. `create()` ya es atómico por movimiento (folio + concepto + denominaciones);
   * acá sólo se envuelve y se reporta por fila.
   *
   * ⚠️ El `23505` NO es un error de nadie: es `ux_cash_ledger_origen_vivo` haciendo su trabajo
   * cuando dos personas confirman el mismo cobro. Se reporta como `duplicado`, separado del
   * rechazo.
   */
  async crearLote(
    input: { items: Array<{ origen_ref: string; monto_contado?: number; fecha?: string; sucursal?: string; client_uuid?: string }> },
    user: { id?: string; username?: string },
  ): Promise<ResumenLote> {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!user?.id) throw new BadRequestException('No se pudo identificar al usuario que confirma.');
    const items = (input?.items ?? []).filter((i) => i && i.origen_ref);
    if (!items.length) throw new BadRequestException('No se marcó ninguna entrega.');

    const filas: FilaLote[] = [];
    const montos = new Map<string, number>();

    for (const it of items) {
      try {
        const pend = await this.tk.run(async (trx) => trx('finance.v_caja_ingresos_pendientes')
          .where({ tenant_id: tenantId, origen_ref: it.origen_ref })
          .first('origen_ref', 'sucursal', 'folio', 'cobro_date', 'cliente_code', 'cliente_nombre', 'concepto', 'monto'));

        if (!pend) {
          filas.push({ origen_ref: it.origen_ref, estado: 'duplicado',
            motivo: 'Ese cobro ya no está pendiente: o se aplicó antes, o el ERP ya no lo tiene.' });
          continue;
        }

        const mapa = await this.tk.run(async (trx) =>
          (await this.mapaDeRutas(trx, tenantId, [pend.cliente_code])).get(String(pend.cliente_code ?? '')) ?? null);
        const v = esConfirmable({ origen_ref: pend.origen_ref, cliente_code: pend.cliente_code, monto: Number(pend.monto) }, mapa);
        if (!v.ok) {
          filas.push({ origen_ref: it.origen_ref, estado: 'no_confirmable', motivo: TEXTO_NO_CONFIRMABLE[v.motivo] });
          continue;
        }

        // Lo CONTADO manda sobre el documento (decisión de Edgar). `create()` releería el monto del
        // ERP, así que la entrega con diferencia se registra sin `origen_tipo` y se liga por
        // `origen_uuid` — el documento queda trazado y el candado del duplicado se aplica igual.
        const contado = Number(it.monto_contado);
        const hayConteo = Number.isFinite(contado) && contado > 0;
        const d = evaluarDescuadre(pend.origen_ref, Number(pend.monto), hayConteo ? contado : Number(pend.monto));

        const mov: any = await this.create({
          tipo: 'ingreso',
          fecha: it.fecha || String(pend.cobro_date).slice(0, 10),
          sucursal: it.sucursal || pend.sucursal,
          kepler_cuenta: v.kepler_cuenta,
          kepler_concepto: v.kepler_concepto,
          glosa: `Entrega ${pend.folio} · ${pend.cliente_nombre || pend.cliente_code || 'ruta'}`.slice(0, 200),
          beneficiario: pend.cliente_nombre ?? null,
          monto: hayConteo ? contado : Number(pend.monto),
          origen_tipo: 'cobro',
          origen_ref: pend.origen_ref,
          client_uuid: it.client_uuid,
        }, user);

        montos.set(it.origen_ref, Number(mov.monto));
        filas.push({ origen_ref: it.origen_ref, estado: 'guardado', folio: mov.folio });

        if (d.hay) await this.empujarDescuadre(tenantId, pend, d);
      } catch (e: any) {
        if (e?.code === '23505') {
          filas.push({ origen_ref: it.origen_ref, estado: 'duplicado',
            motivo: 'Otra persona confirmó este mismo cobro. No entra dos veces.' });
        } else {
          // Se reporta el mensaje, NO se traga: una fila que falló en silencio se lee como guardada.
          filas.push({ origen_ref: it.origen_ref, estado: 'rechazado', motivo: String(e?.message ?? e).slice(0, 200) });
        }
      }
    }
    return resumirLote(filas, montos);
  }

  /**
   * La diferencia entre el cobro del ERP y lo contado se levanta como hallazgo.
   *
   * ⚠️ Se enchufa por el port (`FINANCE_FINDINGS_SINK_PORT`) y es `@Optional()`: si Maat está
   * apagado esto es un **no-op** y la captura sigue. Un hallazgo que no se pudo registrar no puede
   * tumbar el registro del dinero — el efectivo ya entró.
   */
  private async empujarDescuadre(tenantId: string, pend: any, d: Descuadre) {
    if (!this.findingsSink?.pushFindings) return;
    try {
      await this.findingsSink.pushFindings(tenantId, [{
        rule_key: 'caja_entrega_difiere',
        clase: 'error_captura',
        // El contrato del port sólo admite info|warn|critical. Un faltante grande es `critical`;
        // uno chico sigue siendo `warn` y NUNCA `info`: un descuadre de caja no es una nota.
        severity: Math.abs(d.diferencia) >= 1000 ? 'critical' : 'warn',
        score: Math.min(1, Math.abs(d.diferencia) / 1000),
        titulo: `Entrega ${pend.folio}: ${d.diferencia > 0 ? 'sobra' : 'falta'} ${Math.abs(d.diferencia).toFixed(2)}`,
        resumen: d.resumen,
        entity: { tipo: 'caja_entrega', origen_ref: pend.origen_ref, sucursal: pend.sucursal },
        periodo: String(pend.cobro_date ?? '').slice(0, 7) || null,
        importe: Math.abs(d.diferencia),
        evidencia: {
          origen_ref: pend.origen_ref, folio: pend.folio,
          cliente: pend.cliente_nombre ?? pend.cliente_code,
          monto_cobro: Number(pend.monto), diferencia: d.diferencia,
        },
        dedup_key: d.dedup_key,
      }], [{
        rule_key: 'caja_entrega_difiere', clase: 'error_captura',
        nombre: 'Entrega de caja distinta del cobro de Kepler',
        descripcion: 'Lo contado al recibir la entrega no coincide con el importe del cobro registrado en el ERP.',
      }]);
    } catch { /* el hallazgo nunca rompe a la captura */ }
  }

  /**
   * ⭐ CG.20 — **Los gastos que se repiten se ofrecen, no se reescriben.**
   *
   * Medido en 30 días: **562 de 978 gastos (57 %)** caen en un par (cuenta, concepto) que ya se usó
   * 3+ veces — `nom 35 efectivo` 27×, `bot pau` 26×, `recoleccion` 20×. Y `Krmn` tecleó **61 gastos
   * en una hora**. Un toque en un chip llena cuenta, concepto y beneficiario; sólo queda el importe.
   *
   * ⛔ **El gasto NO se deriva de Kepler — no está ahí**, y por eso acá no hay anclaje ni árbitro.
   * Esto baja los clics; no vuelve auditable el dato. Se dice para que nadie lo lea como lo otro.
   *
   * Se aprende del propio libro (`finance.cash_ledger`), que es lo que esa persona ya capturó.
   */
  async frecuentes(q: { tipo?: string; sucursal?: string; limit?: number }, user: { id?: string }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(Math.max(Number(q.limit) || 12, 1), 40);
    return this.tk.run(async (trx) => {
      let qb = trx('finance.cash_ledger')
        .where({ tenant_id: tenantId, tipo: q.tipo || 'gasto' })
        .whereNull('deleted_at').whereNot('estado', 'cancelado')
        .whereNotNull('kepler_cuenta').whereNotNull('kepler_concepto');
      if (q.sucursal) qb = qb.where('sucursal', q.sucursal);
      // Sólo lo que ESA persona usa: los chips de otro capturista son ruido, y peor, son una
      // sugerencia de mandar dinero a una cuenta que no es la suya.
      if (user?.id) qb = qb.where('created_by', user.id);

      const usos = await qb
        .groupBy('kepler_cuenta', 'kepler_concepto', 'glosa', 'beneficiario')
        .select('kepler_cuenta', 'kepler_concepto', 'glosa', 'beneficiario')
        .count({ usos: '*' })
        .max({ ultimo_uso: 'fecha' })
        .orderBy('usos', 'desc')
        .limit(200);

      const rows = rankearFrecuentes(usos.map((u: any) => ({ ...u, usos: Number(u.usos) })), limit);
      return {
        rows, limit,
        // Cuántos gastos del periodo caen en un par repetido. Sin esto, una lista de 3 chips se lee
        // igual tanto si la persona repite todo como si nunca repite nada.
        medido: { pares_con_soporte: rows.length, minimo_usos: FRECUENTE_MIN_USOS },
      };
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
