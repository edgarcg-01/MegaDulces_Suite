import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { FINANCE_FINDINGS_SINK_PORT, CAJA_VENTANA_DIAS, type FinanceFindingsSinkPort } from '@megadulces/contracts';
import { CajaGateway } from './caja.gateway';
import { buildFolio } from './caja-autofill.engine';
import {
  esConfirmable, cuentaPorRegla, resumirLote, evaluarDescuadre, rankearFrecuentes,
  TEXTO_NO_CONFIRMABLE, FRECUENTE_MIN_USOS,
  type MapaRuta, type ReglaGasto, type Confirmable, type ClaseDescuadre,
  type FilaLote, type ResumenLote, type Descuadre,
} from './caja-lote.engine';
import {
  rankearCaos, type GastoCtx as CaosGastoCtx, type CaosCandidato as CaosCand, type PatronAprendido,
} from './caja-caos-match.engine';

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
  /**
   * CG.21 — Lo que la persona CONTÓ, cuando difiere del documento del ERP.
   *
   * ⭐ Campo propio y explícito a propósito. Si se dedujera de que `monto` no coincide con el
   * documento, "conté distinto" y "el front mandó mal el importe" serían el mismo síntoma — y sólo
   * uno de los dos se arregla en el código. Cuando viene, MANDA sobre el importe de Kepler y la
   * diferencia se levanta como hallazgo; nunca se rechaza el efectivo.
   */
  monto_contado?: number;
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

/**
 * Los `origen_tipo` que anclan a un documento de Kepler y por lo tanto **toman de ahí el importe**.
 *
 * ⚠️ Los dos ya los admite `cash_ledger_origen_chk` (`20260918150000:134`), así que el egreso entra
 * sin cirugía de constraint. Los otros valores del CHECK (`cfdi`, `recepcion`, `banco`, `manual`)
 * NO anclan: se guardan como vienen porque no hay vista que los resuelva todavía, y tratarlos como
 * anclados los haría fallar con "no existe en Kepler" sobre un documento que sí existe.
 */
const ORIGEN_ANCLADO = ['cobro', 'pago_proveedor'];

/** La clase de hallazgo que le toca a cada signo. Ver `ClaseDescuadre`. */
const CLASE_DESCUADRE: Record<string, ClaseDescuadre> = { ingreso: 'caja_entrega', gasto: 'caja_egreso' };

@Injectable()
export class CashLedgerService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    // CG.20 — `@Optional()` a propósito: si Maat está apagado, el descuadre no se registra pero el
    // efectivo SÍ. Un hallazgo que no se pudo guardar no puede impedir que el dinero entre al libro.
    @Optional() @Inject(FINANCE_FINDINGS_SINK_PORT) private readonly findingsSink?: FinanceFindingsSinkPort,
    // CG.23.2 — Igual de opcional, y por el mismo motivo: si el canal en vivo no está montado,
    // las demás pantallas se enteran en su repaso lento. Un aviso que no se pudo emitir no puede
    // impedir que el efectivo entre al libro.
    @Optional() private readonly caja?: CajaGateway,
  ) {}

  /**
   * Avisa a las pantallas abiertas que el libro cambió. Best-effort y sin firma: el aviso del
   * carril trae la del corte de Kepler, y ésta es la otra mitad —lo que se guardó acá—, que la
   * pantalla resuelve yendo a buscar. Nunca tira: envolver en try/catch a propósito, porque
   * este llamado ocurre DESPUÉS de que el dinero ya quedó registrado.
   */
  private avisarLibro(tenantId: string): void {
    try { this.caja?.emitChange(tenantId, { origen: 'libro', filas: null, max_folio: null, max_captura: null, datos_al: null }); }
    catch { /* el aviso es un extra; el movimiento ya está guardado */ }
  }

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
      // CG.19 Capa 1 / CG.21 — qué proporción del movimiento descansa en un hecho de Kepler y cuánta
      // en un teclado. Va SIEMPRE, por el mismo motivo que las otras dos: sin este número, una caja
      // 100% capturada a mano se ve idéntica a una anclada al ERP (ADR-056).
      //
      // ⚠️ Ahora POR TIPO. La vista vieja (`v_caja_ingreso_cobertura`) filtraba `tipo='ingreso'` y
      // el egreso anclado le quedaba invisible — o sea, habría publicado "sin cobertura" justo
      // sobre la mitad que esta fase vino a anclar.
      const anclaje = await trx('finance.v_caja_cobertura')
        .orderBy([{ column: 'mes', order: 'desc' }, { column: 'sucursal', order: 'asc' }, { column: 'tipo', order: 'asc' }])
        .limit(72)
        .select('*');
      // `ingreso` se conserva con su forma exacta —incluido el nombre `ingresos` de la columna—
      // para no romper a la pantalla desplegada mientras el front migra. Renombrar la columna acá
      // habría dejado el KPI en blanco sin ningún error visible, que es peor que romperlo.
      const ingreso = anclaje
        .filter((r: any) => r.tipo === 'ingreso')
        .map((r: any) => ({ ...r, ingresos: r.movimientos }));
      return { catalogo, mapa, anclaje, ingreso };
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
  private async resolveMovimiento(trx: any, tenantId: string, origenRef: string) {
    const row = await trx('finance.v_caja_movimientos_pendientes')
      .where({ tenant_id: tenantId, origen_ref: origenRef })
      .first('origen_ref', 'folio', 'doc_tipo', 'sucursal', 'clave_banco', 'caja_nombre', 'fecha_valor',
        'tipo', 'origen_tipo', 'entidad_code', 'beneficiario', 'concepto', 'monto');
    if (row) return row;

    // ⚠️ Se busca por `origen_ref` SOLO, sin `origen_tipo`: la llave ya lleva el `doc_tipo`, así que
    // es única de por sí, y preguntar además por el tipo haría que un egreso aplicado se reportara
    // como "no existe en Kepler" — el mensaje equivocado, que manda a la persona a buscar un
    // problema de integración donde sólo hay trabajo repetido.
    const aplicado = await trx('finance.cash_ledger')
      .where({ tenant_id: tenantId, origen_ref: origenRef })
      .whereNotNull('origen_tipo')
      .whereNull('deleted_at').whereNot('estado', 'cancelado')
      .first('folio', 'fecha', 'created_by_username');
    if (aplicado) {
      throw new BadRequestException(
        `Ese documento de Kepler ya se registró en la caja con el folio ${aplicado.folio}`
        + `${aplicado.created_by_username ? ` (lo capturó ${aplicado.created_by_username})` : ''}. `
        + 'Un mismo documento no puede entrar dos veces: si el anterior está mal, cancelalo y volvé a registrarlo.',
      );
    }
    throw new BadRequestException(
      `El documento ${origenRef} no está entre los movimientos de caja de Kepler. `
      + 'No se registra efectivo contra un documento que el ERP no tiene.',
    );
  }

  /**
   * Las reglas vivas de clasificación (`finance.caja_classify_rules`), en orden de prioridad.
   *
   * ⭐ Se traen como DATOS y el patrón se evalúa **en JS** (`cuentaPorRegla`), nunca con `~` en
   * SQL: `knex.raw` se come los `?` y un cuantificador dentro de un regex ya costó una columna
   * entera en `20260819220000`. Acá el patrón jamás toca el SQL.
   */
  private async reglasDeGasto(trx: any, tenantId: string): Promise<ReglaGasto[]> {
    return trx('finance.caja_classify_rules')
      .where({ tenant_id: tenantId, active: true })
      .whereNull('suppressed_at')
      .orderBy([{ column: 'priority', order: 'asc' }, { column: 'id', order: 'asc' }])
      .select('id', 'priority', 'match_tipo', 'match_glosa', 'match_beneficiario',
        'kepler_cuenta', 'kepler_concepto');
  }

  /**
   * CG.22.6 — **Declara a qué cuenta va un beneficiario, de la mano de quien captura.**
   *
   * ⭐ Por qué acá y no en una pantalla de administración: medido el 2026-09-22, `caja_classify_rules`
   * tiene **0 filas en prod** y `route_customer_map` tampoco tiene ninguna ruta firmada — pero el
   * problema no era que nadie las hubiera cargado: **NO EXISTÍA NINGUNA PANTALLA para cargarlas**.
   * Las tablas estaban, el motor las leía, y no había por dónde entrar un solo renglón. Por eso la
   * bandeja publicaba «0 de 8 se confirman» y no había forma de mejorar ese número.
   *
   * La propia migración que creó la tabla ya lo había anticipado: *"Las reglas nacen de CG.17
   * midiendo contra los 12,253 movimientos ya capturados, **o de la mano de quien captura**"*.
   * Esto es esa segunda vía: la persona está mirando el movimiento, con el beneficiario delante,
   * y acaba de elegir la cuenta para ESE documento. Preguntarle si vale de ahora en adelante es
   * el momento con más contexto que va a haber.
   *
   * ⛔ El patrón se ANCLA y se ESCAPA. `aplicaPatron` corre `new RegExp(patron,'i').test(texto)`:
   * sin anclar, un beneficiario corto como "CAJA" clasificaría media bandeja; sin escapar, un
   * nombre con paréntesis o `+` sería un regex distinto del que la persona creyó declarar — o uno
   * inválido, que `aplicaPatron` descarta en silencio.
   */
  async declararCuentaDeBeneficiario(
    input: { beneficiario?: string; kepler_cuenta?: string; kepler_concepto?: string; sucursal?: string; nota?: string },
    user: { id?: string; username?: string },
  ) {
    const tenantId = this.tenantCtx.requireTenantId();
    const beneficiario = String(input.beneficiario ?? '').trim();
    const cuenta = String(input.kepler_cuenta ?? '').trim();
    const concepto = String(input.kepler_concepto ?? '').trim();
    if (!beneficiario) throw new BadRequestException('Sin beneficiario no hay a quién declararle una cuenta.');
    if (!cuenta || !concepto) throw new BadRequestException('El par cuenta/concepto va COMPLETO: media cuenta no contabiliza nada.');

    return this.tk.run(async (trx) => {
      // El par tiene que existir en el catálogo VIVO, igual que al registrar un movimiento: una
      // regla que apunta a una cuenta inexistente clasificaría hacia la nada, y en lote.
      await this.resolveConcept(trx, tenantId, String(input.sucursal ?? '00'), cuenta, concepto);

      const patron = `^${beneficiario.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;

      const ya = await trx('finance.caja_classify_rules')
        .where({ tenant_id: tenantId, match_beneficiario: patron, active: true })
        .whereNull('suppressed_at')
        .first('id', 'kepler_cuenta', 'kepler_concepto');
      if (ya) {
        if (ya.kepler_cuenta === cuenta && ya.kepler_concepto === concepto) {
          return { creada: false, motivo: 'ya_declarada', id: ya.id };
        }
        throw new BadRequestException(
          `«${beneficiario}» ya está declarado a ${ya.kepler_cuenta} / ${ya.kepler_concepto}. `
          + 'Cambiar una regla viva es una decisión aparte: se edita la que existe, no se apila otra encima.',
        );
      }

      // Se agrega AL FINAL. Como el patrón es exacto por beneficiario, dos reglas no se pisan;
      // y si alguna vez se siembran patrones amplios, los específicos ya declarados siguen ganando.
      const top = await trx('finance.caja_classify_rules')
        .where({ tenant_id: tenantId }).max({ p: 'priority' }).first();
      const priority = Number(top?.p ?? 0) + 10;

      const [row] = await trx('finance.caja_classify_rules')
        .insert({
          tenant_id: tenantId,
          priority,
          match_beneficiario: patron,
          kepler_cuenta: cuenta,
          kepler_concepto: concepto,
          note: String(input.nota ?? '').trim() || `Declarada al capturar, por ${user?.username ?? 'sin usuario'}`,
          created_by: user?.username ?? user?.id ?? null,
        })
        .returning(['id', 'priority']);
      return { creada: true, id: row.id, priority: row.priority, patron };
    });
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

    const creado = await this.tk.run(async (trx) => {
      // Idempotencia: el reintento del cliente devuelve el movimiento que ya se guardó,
      // no un 409 ni un duplicado.
      if (input.client_uuid) {
        const prev = await trx('finance.cash_ledger')
          .where({ tenant_id: tenantId, client_uuid: input.client_uuid }).first();
        if (prev) return { ...prev, idempotent_replay: true };
      }

      // ⭐ El monto del documento MANDA sobre el del formulario…
      const anclado = ORIGEN_ANCLADO.includes(String(input.origen_tipo)) && !!input.origen_ref;
      const doc = anclado ? await this.resolveMovimiento(trx, tenantId, input.origen_ref as string) : null;

      // …salvo que alguien haya CONTADO. 🔴 Acá había un bug: la decisión de Edigar fue "acepta el
      // efectivo y levanta un hallazgo", y `crearLote` mandaba lo contado en `monto` — pero esta
      // línea lo pisaba con el importe del ERP, así que **lo contado nunca llegaba al libro**, sólo
      // al hallazgo. La caja guardaba lo que decía Kepler y la diferencia se evaporaba.
      //
      // El conteo viaja en un campo PROPIO y explícito. No se deduce de que `monto` difiera: eso
      // volvería indistinguible "conté distinto" de "el front mandó mal el importe", y una de las
      // dos hay que ir a arreglarla al código.
      const contado = Number(input.monto_contado);
      const hayConteo = doc != null && Number.isFinite(contado) && contado > 0;
      const monto = hayConteo ? contado : (doc ? Number(doc.monto) : Number(input.monto));
      const montoDiscrepa = doc != null && !hayConteo
        && Math.abs(Number(input.monto || 0) - monto) > ARQUEO_EPSILON;

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

      // Con el documento atado, el capturista no tiene que escribir el motivo: ya está en el ERP.
      const glosa = input.glosa?.trim()
        || (doc ? `${doc.doc_tipo} ${doc.folio} · ${doc.beneficiario || doc.entidad_code || 'sin beneficiario'}`.slice(0, 200) : '');

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
        beneficiario: input.beneficiario ?? (doc?.beneficiario ?? null),
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
    // CG.23.2 — Las demás pantallas abiertas se enteran. Va DESPUÉS de la transacción a
    // propósito: avisar de algo que todavía puede revertirse haría que otro capturista viera
    // aparecer un movimiento que nunca existió.
    this.avisarLibro(tenantId);
    return creado;
  }

  /**
   * CG.19/CG.21 — **Movimientos recientes de la caja, los DOS signos, listos para confirmar.**
   *
   * Es el cambio de forma que pidió Edgar: en vez de que el capturista teclee fecha, motivo y
   * monto, se le muestran los documentos que Kepler YA registró y él **confirma cuáles pasaron por
   * la caja**. El registro precede al dinero, y el valor se toma del ERP.
   *
   * ⭐ La fuente es `finance.v_caja_movimientos_pendientes`, que filtra por `tipo_cuenta='caja'` —
   * o sea por `kdm1.c45`, la cuenta por la que salió el dinero. Reemplaza al filtro anterior
   * (`tipo_cuenta='ruta'`, un regex sobre el NOMBRE del cliente), que estaba respondiendo una
   * pregunta parecida pero distinta: *"¿el cliente parece una ruta?"* en vez de *"¿el dinero entró
   * a la caja?"*. Medido, esa diferencia costaba **38 de 330 cobros invisibles (11.5 %)** — los de
   * Morelia (`2-32-321`, `2-32-RV01`), que empiezan con dígito y el regex nunca matcheó.
   *
   * ⚠️ Lo que NO está en esta lista no deja de existir: es el movimiento que sí se captura a mano.
   * Por eso `coverage()` publica la proporción — una lista corta no puede leerse como "ya está
   * todo cubierto".
   */
  /**
   * Cuándo se armó la foto que la bandeja está leyendo.
   *
   * ⚠️ Va en su propia consulta y con `catch → null` a propósito: en este proyecto el código
   * desplegado puede ir POR DELANTE de las migraciones, así que seleccionar `refrescado_en` en la
   * consulta principal tumbaría la bandeja entera en el hueco entre un deploy y su migración.
   * Sin medición se devuelve `null` — que la pantalla declara como "sin medir", nunca como fresco.
   */
  private async frescuraCaja(trx: any): Promise<string | null> {
    try {
      // [CG.22.4] La edad sale del LATIDO, no de una columna del matview.
      //
      // Antes se leía `max(refrescado_en)` de `analytics.mv_caja_movimientos`, y esa columna tuvo
      // que retirarse: al cambiar en cada pasada hacía que `REFRESH ... CONCURRENTLY` viera el
      // 100 % de las filas como distintas y reescribiera la tabla entera cada minuto — 12,294
      // DELETE+INSERT para 0 cambios reales y 12.3 GB de WAL por día.
      //
      // `analytics.cron_run_log` es la fuente correcta y no un reemplazo de apuro: es append-only,
      // la escribe el trigger `trg_cron_run_log`, y **sólo registra estados terminales** (su propio
      // comentario: "'running' es un estado, no un hecho consumado"). Verificado en prod: 1,411
      // filas para `mv_caja_refresh`, todas `ok`; sin RLS; `app_runtime` puede leerla; y el índice
      // `ix_crl_job (tenant_id, job_key, finished_at DESC)` la resuelve en 4 páginas / 0.045 ms.
      //
      // ⭐ Y da una respuesta MEJOR que la columna: si el refresh falla una hora, devuelve el
      // último cierre bueno — o sea "estos datos son de hace 1 h", que es información. La columna
      // habría devuelto la hora del último refresh exitoso también, pero sólo mientras el matview
      // existiera; acá ni siquiera hace falta que exista.
      const r = await trx('analytics.cron_run_log')
        .where({
          tenant_id: this.tenantCtx.requireTenantId(),
          job_key: 'mv_caja_refresh',
          status: 'ok',
        })
        .max({ al: 'finished_at' })
        .first();
      return (r as { al?: string } | undefined)?.al ?? null;
    } catch {
      return null;
    }
  }

  async movimientosPendientes(q: {
    tipo?: string; caja?: string; sucursal?: string; from?: string; to?: string; search?: string; limit?: number;
  }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    return this.tk.run(async (trx) => {
      // ⭐ Ventana por default. Medido en prod: sin ella la bandeja lista **12,160 movimientos, el
      // más viejo de 2025-01-01**, porque `finance.cash_ledger` está vacío y entonces "pendiente"
      // es todo lo que Kepler registró desde que hay ODS. Es cierto y es inútil como cola de
      // trabajo. Se puede pedir explícitamente un `from` anterior; el default no lo hace.
      const desde = q.from
        || new Date(Date.now() - CAJA_VENTANA_DIAS * 86400000).toISOString().slice(0, 10);

      const filtros = (b: any) => {
        let x = b.where('tenant_id', tenantId);
        if (q.tipo) x = x.where('tipo', q.tipo);
        if (q.caja) x = x.where('clave_banco', q.caja);
        if (q.sucursal) x = x.where('sucursal', q.sucursal);
        return x;
      };

      // Lo que la ventana DEJA FUERA se cuenta y se publica. Una bandeja acotada que no dice
      // dónde cortó es indistinguible de una bandeja vacía (ADR-056).
      const atras: any = await filtros(trx('finance.v_caja_movimientos_pendientes'))
        .where('fecha_valor', '<', desde)
        .count({ n: '*' }).sum({ monto: 'monto' }).first();

      let qb = filtros(trx('finance.v_caja_movimientos_pendientes'))
        .where('fecha_valor', '>=', desde);
      if (q.to) qb = qb.where('fecha_valor', '<=', q.to);
      if (q.search) {
        // `%` y `_` escapados: sin esto, buscar "100%" devuelve TODO y la persona cree que filtró.
        const s = `%${String(q.search).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        qb = qb.where((b: any) => b
          .whereRaw(`beneficiario ILIKE ? ESCAPE '\\'`, [s])
          .orWhereRaw(`entidad_code ILIKE ? ESCAPE '\\'`, [s])
          .orWhereRaw(`concepto ILIKE ? ESCAPE '\\'`, [s])
          .orWhereRaw(`folio ILIKE ? ESCAPE '\\'`, [s]));
      }
      const rows = await qb
        // ⛔ CG.23.1 — El orden salía INVERSO para lo que la bandeja es: una cola de trabajo.
        //
        // Era `fecha_valor DESC, doc_tipo ASC, folio DESC`. Con la ventana en **1 día** TODAS las
        // filas comparten `fecha_valor`, así que el criterio que mandaba de verdad era el
        // segundo: `doc_tipo ASC` — un orden **alfabético**, que no tiene nada que ver con el
        // tiempo. Un movimiento recién llegado no aparecía arriba: caía al fondo de su grupo de
        // doc_tipo (`U-A-5` ordena antes que `X-D-26`), o sea justo donde nadie está mirando.
        //
        // Ahora manda la CAPTURA (`kdm1.c68`: cuándo Kepler lo registró), que es lo más cerca de
        // "cuándo llegó" que da la fuente — `fecha_valor` es cuándo VALE el dinero, que para una
        // cola de trabajo es otra pregunta. `doc_tipo` baja a desempate.
        //
        // `NULLS LAST`: sin él, un `c68` vacío se iría al tope en DESC y una fila SIN fecha de
        // captura encabezaría la bandeja como si fuera la más nueva.
        //
        // El orden queda TOTAL a propósito (`clave_banco` al final): sin desempate estable no se
        // puede demostrar que una optimización posterior no movió filas de lugar.
        .orderByRaw('fecha_captura DESC NULLS LAST, fecha_valor DESC, folio DESC, doc_tipo ASC, clave_banco ASC')
        .limit(limit)
        .select('origen_ref', 'tipo', 'origen_tipo', 'clave_banco', 'caja_nombre', 'sucursal',
          'doc_tipo', 'folio', 'fecha_valor', 'entidad_code', 'beneficiario', 'concepto', 'metodo', 'monto');

      const conCuenta = await this.resolverCuentas(trx, tenantId, rows);
      return {
        rows: conCuenta, limit, has_more: rows.length === limit,
        // ⭐ CG.22.3 — DE CUÁNDO es este dato. La lista sale de `analytics.mv_caja_movimientos`,
        // materializado por costo (415 ms → 0.4 ms, medido). Un matview que dejó de refrescarse
        // no da error: sirve la foto vieja, y una bandeja de caja congelada se lee como "no hay
        // trabajo pendiente". Por eso la edad viaja CON el dato y la pantalla la declara.
        datos_al: await this.frescuraCaja(trx),
        // Cuántas de las que se ven se pueden confirmar sin tocar nada. Sin este número, una lista
        // llena de filas no confirmables se lee igual que una lista lista para un clic (ADR-056).
        confirmables: conCuenta.filter((r: any) => r.confirmable).length,
        desde,
        ventana_dias: q.from ? null : CAJA_VENTANA_DIAS,
        // El rezago histórico, DECLARADO. No es trabajo del día: es una decisión de hasta dónde
        // se migra lo que el Access ya registró. Que se vea evita que alguien crea que no existe.
        fuera_de_ventana: { movimientos: Number(atras?.n ?? 0), monto: Number(atras?.monto ?? 0) },
      };
    });
  }

  /**
   * CS.3 — Movimientos de CAOS (caja fuerte) PENDIENTES de capturar en el libro, con sus
   * denominaciones ya contadas por la máquina, para autorrellenar el arqueo.
   *
   * Es la segunda fuente de la bandeja (la primera son los documentos de Kepler). Convive con
   * aquélla; el capturista elige. ⚠️ NO se deduplica contra Kepler por fila: la medición dio 0% de
   * llave común (bulto vs individual). Cada fuente se captura una vez por su propia identidad:
   * `origen_ref = 'device|external_id'`, `origen_tipo='caos'`, y el candado `ux_cash_ledger_origen_vivo`
   * garantiza el "una vez". El cuadre de control CS.4 es la red de seguridad contra superposición.
   *
   * Sólo Depósito (type_id 0 → `ingreso`) y Dispensar (4 → `gasto`): son los eventos de efectivo del
   * libro. Dotar/Cambio/Vaciar son operaciones internas de la máquina, no asientos de caja.
   *
   * `analytics.caos_cash_movements` NO tiene RLS (espejo de feed) → filtro de tenant explícito.
   */
  async caosCapturables(q: { from?: string; to?: string; tipo?: string; search?: string; limit?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    const desde = q.from || new Date(Date.now() - CAJA_VENTANA_DIAS * 86400000).toISOString().slice(0, 10);
    return this.tk.run(async (trx) => {
      let qb = trx('analytics.caos_cash_movements as m')
        .where('m.tenant_id', tenantId)
        .whereIn('m.type_id', [0, 4])
        .where('m.occurred_at', '>=', desde)
        // Anti ya-capturado: excluye lo que ya tiene fila viva en el libro con esa identidad CAOS.
        .whereNotExists((sub: any) => sub
          .select(trx.raw('1'))
          .from('finance.cash_ledger as l')
          .whereRaw(`l.tenant_id = m.tenant_id
             AND l.origen_tipo = 'caos'
             AND l.origen_ref = m.device || '|' || m.external_id
             AND l.deleted_at IS NULL AND l.estado <> 'cancelado'`));
      // CS.3.3 — excluye lo ya ENLAZADO a un gasto (consumido). Guarda: la tabla puede no existir
      // todavía si el código va por delante de su migración.
      if (await this.tablaCaosLinks(trx)) qb = qb.whereNotExists((sub: any) => sub
        .select(trx.raw('1')).from('finance.caos_cash_links as k')
        .whereRaw(`k.tenant_id = m.tenant_id AND k.caos_device = m.device
           AND k.caos_external_id = m.external_id AND k.deleted_at IS NULL`));
      if (q.to) qb = qb.where('m.occurred_at', '<=', new Date(new Date(q.to).getTime() + 86400000).toISOString().slice(0, 10));
      if (q.tipo === 'ingreso') qb = qb.where('m.type_id', 0);
      if (q.tipo === 'gasto') qb = qb.where('m.type_id', 4);
      if (q.search) {
        const s = `%${String(q.search).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        qb = qb.where((b: any) => b
          .whereRaw(`m.ref ILIKE ? ESCAPE '\\'`, [s])
          .orWhereRaw(`m.user_external ILIKE ? ESCAPE '\\'`, [s]));
      }
      const movs = await qb
        .orderBy([{ column: 'm.occurred_at', order: 'desc' }, { column: 'm.external_id', order: 'desc' }])
        .limit(limit)
        .select('m.id', 'm.device', 'm.external_id', 'm.type_id', 'm.type_label', 'm.occurred_at',
          'm.accounting_date', 'm.user_external', 'm.total', 'm.ref', 'm.sucursal');

      // Denominaciones de cada movimiento (una consulta, no N).
      const ids = movs.map((r: any) => r.id);
      const dens = ids.length
        ? await trx('analytics.caos_cash_denominations')
          .where('tenant_id', tenantId).whereIn('movement_id', ids)
          .select('movement_id', 'denom', 'quantity')
        : [];
      const porMov = new Map<string, Array<{ denominacion: number; piezas: number }>>();
      for (const d of dens as any[]) {
        const arr = porMov.get(d.movement_id) || [];
        arr.push({ denominacion: Number(d.denom), piezas: Number(d.quantity) });
        porMov.set(d.movement_id, arr);
      }

      const rows = movs.map((m: any) => ({
        origen_ref: `${m.device}|${m.external_id}`,
        external_id: Number(m.external_id),
        device: m.device,
        tipo: m.type_id === 0 ? 'ingreso' : 'gasto',
        type_label: m.type_label,
        occurred_at: m.occurred_at,
        fecha_valor: String(m.occurred_at).slice(0, 10),
        sucursal: m.sucursal || '00',
        user_external: m.user_external,
        ref: m.ref,
        monto: Number(m.total),
        // Sólo billetes 500/200/100/50/20 (los que la máquina cuenta). La morralla va a mano.
        denominaciones: porMov.get(m.id) || [],
      }));

      return { rows, limit, has_more: movs.length === limit, desde, datos_al: await this.frescuraCaos(trx, tenantId) };
    });
  }

  /** ¿Existe ya `finance.caos_cash_links`? El código puede ir por delante de su migración. Cacheado. */
  private caosLinksTabla: boolean | null = null;
  private async tablaCaosLinks(trx: any): Promise<boolean> {
    if (this.caosLinksTabla !== null) return this.caosLinksTabla;
    try {
      const r = await trx.raw(`SELECT to_regclass('finance.caos_cash_links') AS t`);
      this.caosLinksTabla = !!(r?.rows?.[0]?.t);
    } catch { this.caosLinksTabla = false; }
    return this.caosLinksTabla;
  }

  /**
   * CS.3.3 — PROPONE qué retiros del cajero (CAOS) pudieron pagar el gasto que se está capturando.
   *
   * El "detecta automático" hecho honesto: rankea las dispensaciones SIN consumir por los patrones
   * MEDIDOS (mismo día ≫ ±días · ref↔beneficiario · monto ≤ gasto) y por lo APRENDIDO
   * (`v_caos_link_patterns`), y devuelve el top con score + motivos + confianza. NO aplica nada: el
   * humano confirma con un toque (1 de 3 "matches" por monto es falso — medido). Excluye lo ya
   * capturado (`cash_ledger` origen='caos') y lo ya enlazado (`caos_cash_links`).
   *
   * Para un gasto busca DISPENSACIONES (type 4); para un ingreso, DEPÓSITOS (0). Ventana ±7 días
   * (la señal vive en ±3; el ranking penaliza lo lejano). `analytics.*` sin RLS → tenant explícito.
   */
  async caosCandidatos(q: { fecha?: string; monto?: number; beneficiario?: string; concepto?: string; sucursal?: string; tipo?: string; limit?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const fecha = (q.fecha || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const limit = Math.min(Math.max(Number(q.limit) || 8, 1), 50);
    const typeId = q.tipo === 'ingreso' ? 0 : 4;
    const t0 = Date.parse(`${fecha}T00:00:00Z`);
    const desde = new Date(t0 - 7 * 86400000).toISOString().slice(0, 10);
    const hasta = new Date(t0 + 8 * 86400000).toISOString().slice(0, 10); // +7d, exclusivo (+1)
    return this.tk.run(async (trx) => {
      let qb = trx('analytics.caos_cash_movements as m')
        .where('m.tenant_id', tenantId)
        .where('m.type_id', typeId)
        .where('m.occurred_at', '>=', desde)
        .where('m.occurred_at', '<', hasta)
        .whereNotExists((sub: any) => sub.select(trx.raw('1')).from('finance.cash_ledger as l')
          .whereRaw(`l.tenant_id = m.tenant_id AND l.origen_tipo='caos'
             AND l.origen_ref = m.device || '|' || m.external_id
             AND l.deleted_at IS NULL AND l.estado <> 'cancelado'`));
      // Guarda: excluye lo ya enlazado sólo si la tabla existe (código puede ir por delante de la mig).
      if (await this.tablaCaosLinks(trx)) qb = qb.whereNotExists((sub: any) => sub
        .select(trx.raw('1')).from('finance.caos_cash_links as k')
        .whereRaw(`k.tenant_id = m.tenant_id AND k.caos_device = m.device
           AND k.caos_external_id = m.external_id AND k.deleted_at IS NULL`));
      const movs = await qb
        .orderBy([{ column: 'm.occurred_at', order: 'desc' }])
        .limit(200) // candidatos crudos; el ranking recorta a `limit`
        .select('m.id', 'm.device', 'm.external_id', 'm.type_label', 'm.occurred_at',
          'm.accounting_date', 'm.user_external', 'm.total', 'm.ref', 'm.sucursal');

      const ids = movs.map((r: any) => r.id);
      const dens = ids.length
        ? await trx('analytics.caos_cash_denominations').where('tenant_id', tenantId).whereIn('movement_id', ids)
          .select('movement_id', 'denom', 'quantity')
        : [];
      const porMov = new Map<string, Array<{ denominacion: number; piezas: number }>>();
      for (const d of dens as any[]) {
        const a = porMov.get(d.movement_id) || [];
        a.push({ denominacion: Number(d.denom), piezas: Number(d.quantity) });
        porMov.set(d.movement_id, a);
      }
      const candidatos: CaosCand[] = movs.map((m: any) => ({
        origen_ref: `${m.device}|${m.external_id}`, external_id: Number(m.external_id), device: m.device,
        type_label: m.type_label, fecha_valor: String(m.accounting_date || m.occurred_at).slice(0, 10),
        sucursal: m.sucursal || '00', user_external: m.user_external, ref: m.ref, monto: Number(m.total),
        denominaciones: porMov.get(m.id) || [],
      }));

      // Lo APRENDIDO: si la vista aún no existe (deploy por delante de la migración), se sigue sin ella.
      let aprendido: Map<string, PatronAprendido> | undefined;
      try {
        const pat = await trx('analytics.v_caos_link_patterns').where('tenant_id', tenantId)
          .select('ref_norm', 'casos', 'cuenta_tipica', 'concepto_tipico', 'beneficiario_tipico');
        aprendido = new Map(pat.map((p: any) => [p.ref_norm, {
          ref_norm: p.ref_norm, casos: Number(p.casos), cuenta_tipica: p.cuenta_tipica,
          concepto_tipico: p.concepto_tipico, beneficiario_tipico: p.beneficiario_tipico,
        }]));
      } catch { aprendido = undefined; }

      const g: CaosGastoCtx = {
        monto: q.monto != null ? Number(q.monto) : null, fecha,
        beneficiario: q.beneficiario, concepto: q.concepto, sucursal: q.sucursal,
      };
      const rows = rankearCaos(g, candidatos, aprendido).slice(0, limit);
      return { rows, fecha, datos_al: await this.frescuraCaos(trx, tenantId) };
    });
  }

  /** Edad del espejo de CAOS (para declarar frescura). `null` si no se puede medir. */
  private async frescuraCaos(trx: any, tenantId: string): Promise<string | null> {
    try {
      const r = await trx('analytics.caos_cash_movements').where('tenant_id', tenantId).max({ al: 'synced_at' }).first();
      return r?.al ? new Date(r.al).toISOString() : null;
    } catch { return null; }
  }

  /**
   * Las cajas de efectivo que Kepler declara, **con su volumen medido**.
   *
   * ⭐ Sale del catálogo (`analytics.v_kepler_cajas`, `kdb1.c3='EFECTIVO'`) y no de los
   * movimientos, a propósito: armarla con los movimientos volvería **invisible a la caja
   * dormida**, y una caja que no se usa no puede verse igual que una que no existe (ADR-056).
   *
   * Medido a 180 días: `0011 CAJA GENERAL` 9,142 documentos; `0010 PADRE HIDALGO` 1; y `0030`,
   * `0040`, `0050` **cero**. Cada una viaja con su cuenta y su conteo para que la pantalla lo diga
   * en vez de fingir que las cinco operan.
   */
  async cajas(q: { dias?: number } = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    const dias = Math.min(Math.max(Number(q.dias) || 180, 1), 730);
    return this.tk.run(async (trx) => {
      const cat = await trx('analytics.v_kepler_cajas')
        .where('tenant_id', tenantId)
        .orderBy('clave')
        .select('clave', 'nombre', 'cuenta_contable');
      const vol = await trx('analytics.kepler_bank_movements')
        .where('tenant_id', tenantId).andWhere('tipo_cuenta', 'caja')
        .andWhereRaw(`fecha_valor >= (now()::date - ${dias})`)
        .groupBy('clave_banco')
        .select('clave_banco')
        .count({ documentos: '*' });
      const m = new Map(vol.map((v: any) => [String(v.clave_banco), Number(v.documentos)]));
      return {
        rows: cat.map((c: any) => ({ ...c, documentos: m.get(String(c.clave)) ?? 0 })),
        ventana_dias: dias,
      };
    });
  }

  /** Compatibilidad: la ruta vieja `GET /ingresos-pendientes` sigue respondiendo lo mismo. */
  async ingresosPendientes(q: { sucursal?: string; tipo_cuenta?: string; from?: string; to?: string; search?: string; limit?: number }) {
    return this.movimientosPendientes({ ...q, tipo: 'ingreso' });
  }

  /**
   * ⭐ La cuenta contable, resuelta por el CAMINO QUE LE TOCA A CADA SIGNO.
   *
   * · **Ingreso** → `finance.route_customer_map`, llave exacta por `cliente_code`. La ruta es una
   *   identidad declarada y firmada; no se adivina de un texto que llega en tres formas distintas
   *   para la misma ruta ("26 Ruta 26", "RUTA 21", "Ventas PH 26/08 RD 21").
   * · **Egreso** → `finance.caja_classify_rules`. Medido: **229 acreedores distintos** en 180 días,
   *   de los cuales el top 50 cubre el **86 % de los documentos y el 65 % del dinero**, y el top 80
   *   el **92 % / 72 %**. Es un sembrado humano de una tarde, no un mapa infinito.
   *
   * ⛔ Lo que no resuelve **cae a captura manual con su motivo**, nunca a una cuenta por descarte.
   * ⚠️ `GG015` (caja chica Morelia) usa varias cuentas distintas — viáticos, limpieza,
   * mantenimiento — mientras `CB013 BOTANAS PAU` usa siempre la misma. Sólo se declara regla donde
   * el beneficiario DETERMINA la cuenta; los multi-cuenta se quedan en manual a propósito.
   */
  private async resolverCuentas(trx: any, tenantId: string, rows: any[]) {
    const hayIngreso = rows.some((r) => r.tipo === 'ingreso');
    const hayGasto = rows.some((r) => r.tipo !== 'ingreso');
    const mapa = hayIngreso
      ? await this.mapaDeRutas(trx, tenantId, rows.filter((r) => r.tipo === 'ingreso').map((r) => r.entidad_code))
      : new Map<string, MapaRuta>();
    const reglas = hayGasto ? await this.reglasDeGasto(trx, tenantId) : [];

    // CS.3.1b — Piso de resolución: la contra-cuenta del PROPIO documento (su póliza de Kepler),
    // traída por página. Sólo se usa cuando regla/ruta NO resolvieron. Su cuenta es AUTORITATIVA
    // (lo que Kepler posteó) → la pantalla la muestra BLOQUEADA. El concepto se fija si la cuenta
    // tiene uno solo; si tiene varios, queda una elección ACOTADA a esa cuenta (no un buscador en
    // blanco). Medido: contra limpia 99.75%, la consulta batch 19 ms/100 docs.
    const contra = await this.contraDeDocumentos(trx, tenantId, rows);
    const paresCuenta = new Map<string, { sucursal: string; cuenta: string }>();
    for (const r of rows) {
      const cc = contra.get(this.claveDoc(r));
      if (cc && cc.contra_n === 1 && cc.contra_cuenta) {
        paresCuenta.set(`${r.sucursal}|${cc.contra_cuenta}`, { sucursal: String(r.sucursal), cuenta: cc.contra_cuenta });
      }
    }
    const conceptos = await this.conceptosDeCuenta(trx, tenantId, [...paresCuenta.values()]);

    return rows.map((r: any) => {
      const v: Confirmable = r.tipo === 'ingreso'
        ? esConfirmable(
            { origen_ref: r.origen_ref, cliente_code: r.entidad_code, monto: Number(r.monto) },
            mapa.get(String(r.entidad_code ?? '')) ?? null)
        : cuentaPorRegla(
            { tipo: r.tipo, glosa: r.concepto, beneficiario: r.beneficiario ?? r.entidad_code, monto: Number(r.monto) },
            reglas);
      if (v.ok) {
        return { ...r, confirmable: true, kepler_cuenta: v.kepler_cuenta, kepler_concepto: v.kepler_concepto,
          cuenta_fuente: r.tipo === 'ingreso' ? 'ruta' : 'regla' };
      }
      // Piso CS.3.1b — la contra del propio documento, cuando regla/ruta no alcanzaron.
      const cc = contra.get(this.claveDoc(r));
      if (cc && cc.contra_n === 1 && cc.contra_cuenta) {
        const cs = conceptos.get(`${r.sucursal}|${cc.contra_cuenta}`) ?? [];
        if (cs.length === 1) {
          return { ...r, confirmable: true, kepler_cuenta: cc.contra_cuenta, kepler_concepto: cs[0].concepto,
            kepler_cuenta_nombre: cc.contra_cuenta_nombre, cuenta_fuente: 'documento' };
        }
        // La CUENTA es autoritativa (del documento) → se bloquea. El CONCEPTO es una elección
        // acotada a esa cuenta (o manual, si la cuenta no está en el catálogo de conceptos). NO es
        // "faltan datos": el dato de Kepler ya está, sólo se afina el concepto.
        return { ...r, confirmable: false, kepler_cuenta: cc.contra_cuenta, kepler_concepto: null,
          kepler_cuenta_nombre: cc.contra_cuenta_nombre, cuenta_fuente: 'documento', cuenta_bloqueada: true,
          conceptos_cuenta: cs, motivo: 'elegir_concepto',
          motivo_texto: cs.length
            ? `La cuenta ${cc.contra_cuenta} viene del documento; elegí el concepto (${cs.length} ${cs.length === 1 ? 'opción' : 'opciones'}).`
            : `La cuenta ${cc.contra_cuenta} viene del documento; falta el concepto.` };
      }
      // Lo que no se puede confirmar viaja con su MOTIVO y sin cuenta. Mandar la fila sin decir
      // por qué la deja fuera obliga a la pantalla a adivinar, y adivinar acá es inventar una
      // cuenta contable.
      return { ...r, confirmable: false, kepler_cuenta: null, kepler_concepto: null,
        motivo: v.motivo, motivo_texto: TEXTO_NO_CONFIRMABLE[v.motivo] };
    });
  }

  /** CS.3.1b — Llave del documento de caja = la misma que la póliza usa (doc_tipo COMPACTO). */
  private claveDoc(r: { sucursal: any; doc_tipo: any; folio: any }): string {
    return `${r.sucursal}|${this.tipoPolCompacto(r.doc_tipo)}|${r.folio}`;
  }

  /**
   * doc_tipo (`X-D-26`) → tipo_pol compacto de la póliza (`XD2601`). Formato Kepler:
   * `c2 c3 lpad(c4,2) c5`, y para estos doctypes de caja `c5='01'`. Verificado en prod:
   * XD2601 / XD6001 / XD2501 / XA4501 / UA0501.
   */
  private tipoPolCompacto(docTipo: any): string {
    const p = String(docTipo ?? '').split('-');
    if (p.length < 3) return '';
    return p[0] + p[1] + String(p[2]).padStart(2, '0') + '01';
  }

  /**
   * CS.3.1b — La contra-cuenta del propio documento, por página (batch). Medido 19 ms / 100 docs
   * contra `analytics.v_caja_doc_contracuenta`. `contra_n>1` (split) NO se usa: se declara y cae a
   * manual, nunca se inventa una sola cuenta para una póliza repartida.
   */
  private async contraDeDocumentos(trx: any, tenantId: string, rows: any[]) {
    const m = new Map<string, { contra_n: number; contra_cuenta: string; contra_cuenta_nombre: string | null }>();
    const tuplas = rows
      .map((r) => [String(r.sucursal), this.tipoPolCompacto(r.doc_tipo), String(r.folio)] as [string, string, string])
      .filter((t) => t[1]);
    if (!tuplas.length) return m;
    const filas = await trx('analytics.v_caja_doc_contracuenta')
      .where('tenant_id', tenantId)
      .whereIn(['sucursal', 'tipo_pol', 'folio'], tuplas)
      .select('sucursal', 'tipo_pol', 'folio', 'contra_n', 'contra_cuenta', 'contra_cuenta_nombre');
    for (const f of filas as any[]) {
      m.set(`${f.sucursal}|${f.tipo_pol}|${f.folio}`,
        { contra_n: Number(f.contra_n), contra_cuenta: f.contra_cuenta, contra_cuenta_nombre: f.contra_cuenta_nombre });
    }
    return m;
  }

  /** CS.3.1b — Los conceptos válidos de cada (sucursal, cuenta), para la elección acotada. */
  private async conceptosDeCuenta(trx: any, tenantId: string, pares: Array<{ sucursal: string; cuenta: string }>) {
    const m = new Map<string, Array<{ concepto: string; concepto_nombre: string | null }>>();
    if (!pares.length) return m;
    const filas = await trx('analytics.v_kepler_conceptos')
      .where('tenant_id', tenantId)
      .whereIn(['sucursal', 'cuenta'], pares.map((p) => [p.sucursal, p.cuenta]))
      .select('sucursal', 'cuenta', 'concepto', 'concepto_nombre')
      .orderBy(['cuenta', 'concepto']);
    for (const f of filas as any[]) {
      const k = `${f.sucursal}|${f.cuenta}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push({ concepto: f.concepto, concepto_nombre: f.concepto_nombre });
    }
    return m;
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
   * ⭐ CG.20/CG.21 — **Confirmar N movimientos de un golpe, entren o salgan.**
   *
   * Es el cambio que pidió Edgar: *"mientras menos clic mejor"*. La persona ya no captura fecha,
   * contraparte, cuenta, concepto ni monto — sólo marca lo que pasó por la caja y, si contó
   * distinto de lo que dice el ERP, escribe lo contado.
   *
   * ⚠️ El arqueo es **asimétrico a propósito**: el ingreso se cuenta (el efectivo está enfrente y
   * puede no coincidir), el egreso lo manda el documento (ya salió por lo que decía el pago). El
   * input existe para los dos, pero en el egreso nace vacío — mismo motor, sin rama nueva.
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
        const pend = await this.tk.run(async (trx) => trx('finance.v_caja_movimientos_pendientes')
          .where({ tenant_id: tenantId, origen_ref: it.origen_ref })
          .first('origen_ref', 'tipo', 'origen_tipo', 'sucursal', 'clave_banco', 'doc_tipo', 'folio',
            'fecha_valor', 'entidad_code', 'beneficiario', 'concepto', 'monto'));

        if (!pend) {
          filas.push({ origen_ref: it.origen_ref, estado: 'duplicado',
            motivo: 'Ese documento ya no está pendiente: o se aplicó antes, o el ERP ya no lo tiene.' });
          continue;
        }

        // La cuenta se resuelve por el camino del signo — el mismo de la bandeja, para que lo que
        // se ve en pantalla y lo que se guarda no puedan divergir.
        const [conCuenta] = await this.tk.run(async (trx) => this.resolverCuentas(trx, tenantId, [pend]));
        if (!conCuenta.confirmable) {
          filas.push({ origen_ref: it.origen_ref, estado: 'no_confirmable', motivo: conCuenta.motivo_texto });
          continue;
        }

        // ⭐ Lo CONTADO manda sobre el documento (decisión de Edgar): el efectivo NUNCA se rechaza.
        // Viaja en `monto_contado`, un campo propio — antes se mandaba en `monto` y `create()` lo
        // pisaba con el importe del ERP, así que lo contado no llegaba al libro.
        const contado = Number(it.monto_contado);
        const hayConteo = Number.isFinite(contado) && contado > 0;
        const clase = CLASE_DESCUADRE[String(pend.tipo)] ?? 'caja_entrega';
        const d = evaluarDescuadre(pend.origen_ref, Number(pend.monto), hayConteo ? contado : Number(pend.monto), clase);

        const mov: any = await this.create({
          tipo: pend.tipo,
          // La fecha del documento, no la de hoy: `fecha_valor` es cuándo Kepler fechó el hecho.
          fecha: it.fecha || String(pend.fecha_valor).slice(0, 10),
          sucursal: it.sucursal || pend.sucursal,
          kepler_cuenta: conCuenta.kepler_cuenta,
          kepler_concepto: conCuenta.kepler_concepto,
          glosa: `${pend.doc_tipo} ${pend.folio} · ${pend.beneficiario || pend.entidad_code || 'sin beneficiario'}`.slice(0, 200),
          beneficiario: pend.beneficiario ?? null,
          monto: Number(pend.monto),
          monto_contado: hayConteo ? contado : undefined,
          origen_tipo: pend.origen_tipo,
          origen_ref: pend.origen_ref,
          client_uuid: it.client_uuid,
        }, user);

        montos.set(it.origen_ref, Number(mov.monto));
        filas.push({ origen_ref: it.origen_ref, estado: 'guardado', folio: mov.folio });

        if (d.hay) await this.empujarDescuadre(tenantId, pend, d, clase);
      } catch (e: any) {
        if (e?.code === '23505') {
          filas.push({ origen_ref: it.origen_ref, estado: 'duplicado',
            motivo: 'Otra persona confirmó este mismo documento. No entra dos veces.' });
        } else {
          // Se reporta el mensaje, NO se traga: una fila que falló en silencio se lee como guardada.
          filas.push({ origen_ref: it.origen_ref, estado: 'rechazado', motivo: String(e?.message ?? e).slice(0, 200) });
        }
      }
    }
    // CG.23.2 — Mismo aviso que en la captura suelta: confirmar un lote cambia la bandeja de
    // todos, y quien la tenga abierta al lado no puede quedarse con filas que ya no están.
    this.avisarLibro(tenantId);
    return resumirLote(filas, montos);
  }

  /**
   * La diferencia entre el cobro del ERP y lo contado se levanta como hallazgo.
   *
   * ⚠️ Se enchufa por el port (`FINANCE_FINDINGS_SINK_PORT`) y es `@Optional()`: si Maat está
   * apagado esto es un **no-op** y la captura sigue. Un hallazgo que no se pudo registrar no puede
   * tumbar el registro del dinero — el efectivo ya entró.
   */
  private async empujarDescuadre(tenantId: string, pend: any, d: Descuadre, clase: ClaseDescuadre = 'caja_entrega') {
    if (!this.findingsSink?.pushFindings) return;
    const esIngreso = clase === 'caja_entrega';
    const rule_key = esIngreso ? 'caja_entrega_difiere' : 'caja_egreso_difiere';
    try {
      await this.findingsSink.pushFindings(tenantId, [{
        rule_key,
        clase: 'error_captura',
        // El contrato del port sólo admite info|warn|critical. Un faltante grande es `critical`;
        // uno chico sigue siendo `warn` y NUNCA `info`: un descuadre de caja no es una nota.
        severity: Math.abs(d.diferencia) >= 1000 ? 'critical' : 'warn',
        score: Math.min(1, Math.abs(d.diferencia) / 1000),
        titulo: `${pend.doc_tipo ?? ''} ${pend.folio}: ${d.diferencia > 0 ? 'sobra' : 'falta'} ${Math.abs(d.diferencia).toFixed(2)}`.trim(),
        resumen: d.resumen,
        entity: { tipo: clase, origen_ref: pend.origen_ref, sucursal: pend.sucursal, caja: pend.clave_banco ?? null },
        periodo: String(pend.fecha_valor ?? pend.cobro_date ?? '').slice(0, 7) || null,
        importe: Math.abs(d.diferencia),
        evidencia: {
          origen_ref: pend.origen_ref, folio: pend.folio, doc_tipo: pend.doc_tipo ?? null,
          contraparte: pend.beneficiario ?? pend.entidad_code ?? null,
          monto_documento: Number(pend.monto), diferencia: d.diferencia,
        },
        dedup_key: d.dedup_key,
      }], [{
        rule_key,
        clase: 'error_captura',
        nombre: esIngreso ? 'Entrega de caja distinta del cobro de Kepler' : 'Egreso de caja distinto del pago de Kepler',
        descripcion: esIngreso
          ? 'Lo contado al recibir la entrega no coincide con el importe del cobro registrado en el ERP.'
          : 'Lo que salió de la caja no coincide con el importe del pago registrado en el ERP.',
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
   * 🔴 **CORREGIDO en CG.21.** Acá decía *"el gasto NO se deriva de Kepler — no está ahí"*. Era
   * falso: está entero, y el discriminante es `kdm1.c45` (la cuenta por la que salió el dinero,
   * `0011 CAJA GENERAL` en `kdb1`). Cobertura medida sobre 5 meses cerrados: **$44,108,221.92 en
   * la caja contra $44,123,427.09 en Kepler = 100 %**. El gasto se **confirma** desde la bandeja.
   *
   * Estos chips quedan para lo que de verdad no tiene documento, y siguen sin anclaje ni árbitro:
   * bajan los clics, no vuelven auditable el dato. Se dice para que nadie lo lea como lo otro.
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
