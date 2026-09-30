import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import {
  calcularCorte, puedeAutorizar, puedeCerrar, puedeCancelarse, motivoCancelacionValido,
  buildFolioCorte, TEXTO_NO_AUTORIZA, TEXTO_NO_CIERRA,
  proyectarCiego, puedeRecontar, TEXTO_NO_RECUENTA,
  type ConteoDenominacion, type MovimientoDelCorte,
} from './cash-cut.engine';

/**
 * CG.15 — Corte de caja con doble llave, saldo y cancelación (ADR-070).
 *
 * Los SELECT y los UPDATE. La cuenta y el veredicto viven en `cash-cut.engine.ts` (puro, con
 * 26 pruebas). Acá sólo se traen filas, se llama al motor y se escribe.
 *
 * ⛔ La doble llave está en la DB (`cut_doble_llave_chk`). Lo de acá NO es la defensa: es para
 * devolver un 403 con su explicación en vez de dejar que el usuario choque con un 23514 de
 * Postgres. Si alguien borra este chequeo, el candado sigue puesto.
 */

export interface AbrirCorteInput { fecha: string; sucursal: string; fondo_inicial?: number; nota?: string }
export interface CerrarCorteInput { conteo?: ConteoDenominacion[]; morralla?: number; nota?: string }

interface Usuario { id?: string; username?: string }

/**
 * `[CG.26]` Los tipos de movimiento del cajero (CAOS / AST700), **medidos**, no supuestos.
 *
 * Al 2026-09-29 el feed trae SEIS y la conciliación miraba DOS:
 *
 *   | id | etiqueta              | movs |        monto | ¿se contaba? |
 *   |----|-----------------------|------|--------------|--------------|
 *   |  0 | Deposito              |  675 | $16,495,700  | sí           |
 *   |  4 | Dispensar             |  324 | $16,461,720  | sí           |
 *   |  8 | Dotar                 |   11 |  $1,500,120  | ⛔ NO         |
 *   |  5 | Vaciar Stocks         |    6 |  $2,350,370  | ⛔ NO         |
 *   |  7 | Cambio                |    4 |         $0   | ⛔ NO         |
 *   | 13 | Contenido Modificado  |    1 |        $20   | ⛔ NO         |
 *
 * ⛔ `Dotar` y `Vaciar Stocks` mueven efectivo REAL de la bóveda (la cargan desde afuera / la
 * vacían hacia afuera). Ignorarlos son **$3,850,510** que el cuadre no podía explicar. El último
 * fue el **2026-09-08**, así que no es historia vieja.
 *
 * ⚠️ Van en piernas SEPARADAS de depósito/dispensación a propósito: no son caja chica. Sumarlas
 * ahí haría que «caja chica conciliada» diera un número inventado.
 */
const CAOS = { DEPOSITO: 0, DISPENSAR: 4, VACIAR: 5, CAMBIO: 7, DOTAR: 8, CONTENIDO: 13 } as const;
const TIPOS_CONOCIDOS = Object.values(CAOS);

@Injectable()
export class CashCutService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private requireUser(u: Usuario): { id: string; username?: string } {
    if (!u?.id) throw new BadRequestException('No se pudo identificar al usuario.');
    return { id: u.id, username: u.username };
  }

  /** Consecutivo atómico del corte, dentro de la trx. Mismo patrón que el folio del libro. */
  private async nextFolio(trx: any, tenantId: string, year: number): Promise<string> {
    const r = await trx.raw(
      `INSERT INTO finance.cash_ledger_sequences (tenant_id, year, tipo, current_value)
       VALUES (?, ?, 'corte', 1)
       ON CONFLICT (tenant_id, year, tipo) DO UPDATE
         SET current_value = finance.cash_ledger_sequences.current_value + 1, updated_at = now()
       RETURNING current_value`, [tenantId, year]);
    return buildFolioCorte(year, r.rows[0].current_value);
  }

  /**
   * Movimientos que entran a un corte: los de la sucursal que todavía no tienen corte.
   *
   * CG.19 Capa 1 — trae `origen_tipo` para que el motor sepa qué parte del `esperado` viene de un
   * hecho de Kepler y qué parte la tecleó una persona. **No cambia la aritmética**: cambia lo que
   * el corte puede DECIR de sí mismo (`cobertura_ingreso`).
   */
  private async movimientosSueltos(trx: any, tenantId: string, sucursal: string): Promise<MovimientoDelCorte[]> {
    const rows = await trx('finance.cash_ledger')
      .where({ tenant_id: tenantId, sucursal })
      .whereNull('corte_id').whereNull('deleted_at')
      .select('tipo', 'monto', 'estado', 'origen_tipo');
    return rows.map((r: any) => ({ ...r, anclado: r.origen_tipo === 'cobro' }));
  }

  async abrir(input: AbrirCorteInput, user: Usuario) {
    const u = this.requireUser(user);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const abierto = await trx('finance.cash_ledger_cuts')
        .where({ tenant_id: tenantId, sucursal: input.sucursal, estado: 'borrador' }).first();
      if (abierto) {
        throw new BadRequestException(
          `La sucursal ${input.sucursal} ya tiene el corte ${abierto.folio} abierto. Cerralo antes de abrir otro.`);
      }
      const folio = await this.nextFolio(trx, tenantId, Number(String(input.fecha).slice(0, 4)));
      const [c] = await trx('finance.cash_ledger_cuts').insert({
        tenant_id: tenantId, folio, fecha: input.fecha, sucursal: input.sucursal,
        fondo_inicial: input.fondo_inicial ?? 0, nota: input.nota ?? null,
        created_by: u.id, created_by_username: u.username ?? null,
      }).returning('*');
      return c;
    });
  }

  /** Guarda el conteo (denominaciones + morralla + total) sobre el corte, dentro de la trx. */
  private async sellarConteo(trx: any, tenantId: string, id: string, t: { contado: number }, input: CerrarCorteInput) {
    await trx('finance.cash_ledger_cuts').where({ id }).update({
      contado: t.contado, morralla: input.morralla ?? 0, updated_at: trx.fn.now(),
    });
    await trx('finance.cash_ledger_cut_denominations').where({ tenant_id: tenantId, cut_id: id }).del();
    const piezas = (input.conteo ?? []).filter((d) => Number(d.piezas) > 0);
    if (piezas.length) {
      await trx('finance.cash_ledger_cut_denominations').insert(
        piezas.map((d) => ({ tenant_id: tenantId, cut_id: id, denominacion: d.denominacion, piezas: d.piezas })));
    }
  }

  /**
   * ⭐ CG.19 Capa 1b — **SELLAR Y REVELAR.** Era `previa()` y hacía lo contrario.
   *
   * El docstring viejo decía: *"el capturista ve la diferencia mientras cuenta"*. Ese era el
   * requisito y **se revierte a propósito**: ver la diferencia converger a cero mientras se teclea
   * convierte el arqueo en una transcripción del esperado. Se contaba hasta que diera.
   *
   * ⛔ **Y por eso esto GUARDA antes de revelar.** Un conteo que se revela sin sellarse no es
   * ciego: bastaba con mirar el resultado, corregir el conteo y volver a preguntar. El conteo se
   * escribe primero, y recién entonces se dice qué dio. Cambiarlo después exige `recontar()`, que
   * deja rastro.
   *
   * ⚠️ El endpoint tenía **cero llamadores** (verificado en `apps/view` y `libs/finance`): se
   * reusa en vez de inventar otro, y se le cambia el nombre porque `previa` ya no describe lo que
   * hace — un endpoint que miente es peor que uno que no existe.
   */
  async contar(id: string, input: CerrarCorteInput, user: Usuario) {
    const u = this.requireUser(user);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const c = await trx('finance.cash_ledger_cuts')
        .where({ tenant_id: tenantId, id }).forUpdate().first();
      if (!c) throw new NotFoundException('Corte no encontrado');
      if (c.estado !== 'borrador') throw new BadRequestException(TEXTO_NO_CIERRA['no_es_borrador']);
      // Sellar dos veces sin motivo sería recontar por la puerta de atrás.
      if (Number(c.contado ?? 0) > 0 || c.conteo_previo != null) {
        throw new BadRequestException(
          'Este corte ya tiene un conteo sellado. Para cambiarlo hay que recontar, y el reconteo pide motivo.',
        );
      }

      const movs = await this.movimientosSueltos(trx, tenantId, c.sucursal);
      const totales = calcularCorte({
        fondoInicial: Number(c.fondo_inicial), movimientos: movs,
        conteo: input.conteo, morralla: input.morralla ?? 0,
      });
      if (totales.veredicto === 'sin_contar') throw new BadRequestException(TEXTO_NO_CIERRA['sin_conteo']);

      await this.sellarConteo(trx, tenantId, id, totales, input);
      // Recién acá se revela: el conteo ya está escrito y no se puede retocar en silencio.
      return { corte_id: id, sellado_por: u.username ?? u.id, totales, puede_recontar: totales.veredicto !== 'cuadra' };
    });
  }

  /**
   * ⛔ **UNA sola vez, con motivo, y el primer conteo NO se borra.**
   *
   * Un reconteo ilimitado es un ajuste con otro nombre: se cuenta hasta que dé. El primero pasa a
   * `conteo_previo` con su razón escrita, y los dos quedan a la vista — que es todo el punto.
   */
  async recontar(id: string, input: CerrarCorteInput & { motivo?: string }, user: Usuario) {
    const u = this.requireUser(user);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const c = await trx('finance.cash_ledger_cuts')
        .where({ tenant_id: tenantId, id }).forUpdate().first();
      if (!c) throw new NotFoundException('Corte no encontrado');

      const movs = await this.movimientosSueltos(trx, tenantId, c.sucursal);
      const previos = await trx('finance.cash_ledger_cut_denominations')
        .where({ tenant_id: tenantId, cut_id: id }).select('denominacion', 'piezas');
      const totalesPrevios = calcularCorte({
        fondoInicial: Number(c.fondo_inicial), movimientos: movs,
        conteo: previos as ConteoDenominacion[], morralla: Number(c.morralla ?? 0),
      });

      const gate = puedeRecontar(c, totalesPrevios, input.motivo);
      if (!gate.ok) throw new BadRequestException(TEXTO_NO_RECUENTA[gate.motivo!]);

      // El primero se guarda ENTERO antes de que el segundo lo pise.
      await trx('finance.cash_ledger_cuts').where({ id }).update({
        conteo_previo: JSON.stringify({
          denominaciones: previos, morralla: Number(c.morralla ?? 0),
          contado: Number(c.contado ?? 0), sellado_at: c.updated_at, recontado_por: u.username ?? u.id,
        }),
        reconteo_motivo: String(input.motivo).trim(),
        updated_at: trx.fn.now(),
      });

      const totales = calcularCorte({
        fondoInicial: Number(c.fondo_inicial), movimientos: movs,
        conteo: input.conteo, morralla: input.morralla ?? 0,
      });
      if (totales.veredicto === 'sin_contar') throw new BadRequestException(TEXTO_NO_CIERRA['sin_conteo']);
      await this.sellarConteo(trx, tenantId, id, totales, input);

      return { corte_id: id, totales, conteo_previo_contado: Number(c.contado ?? 0), puede_recontar: false };
    });
  }

  /**
   * ⭐ ATAR PRIMERO, SUMAR DESPUÉS — y el orden no es preferencia, es la corrección de una carrera.
   *
   * Antes esto leía los movimientos sueltos, congelaba los totales y RECIÉN AL FINAL los ataba.
   * En READ COMMITTED el `UPDATE ... WHERE corte_id IS NULL` **re-evalúa su predicado al momento de
   * ejecutarse**, así que un `create()` que commiteara entre la lectura y la escritura quedaba
   * **atado al corte pero fuera de los totales firmados**: el corte declaraba contener movimientos
   * que no había sumado. Y no lo atrapaba nadie — `cut_cerrado_completo_chk` sólo exige `NOT NULL`
   * (ver la nota en `cash-cut.engine.ts`), así que la DB no repite la cuenta.
   *
   * Invirtiendo el orden el conjunto atado y el sumado son **el mismo por construcción**, sin
   * necesidad de SERIALIZABLE: lo que entre después simplemente queda suelto para el corte
   * siguiente, que es el comportamiento correcto.
   */
  async cerrar(id: string, input: CerrarCorteInput, user: Usuario) {
    const u = this.requireUser(user);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      // `forUpdate` sobre el CORTE: dos cierres simultáneos del mismo corte se serializan acá.
      const c = await trx('finance.cash_ledger_cuts')
        .where({ tenant_id: tenantId, id }).forUpdate().first();
      if (!c) throw new NotFoundException('Corte no encontrado');
      if (c.estado !== 'borrador') throw new BadRequestException(TEXTO_NO_CIERRA['no_es_borrador']);

      const base = () => trx('finance.cash_ledger')
        .where({ tenant_id: tenantId, sucursal: c.sucursal })
        .whereNull('corte_id').whereNull('deleted_at');

      // ⛔ Un movimiento CANCELADO entra al corte (se audita que se canceló) pero CONSERVA su
      // estado. Antes el UPDATE le pisaba `estado` a `'en_corte'`, y eso lo resucitaba: volvía a
      // contar en `finance.v_cash_ledger_balance` (que descuenta por `estado='cancelado'`) y dejaba
      // de poder cancelarse. Un movimiento cancelado no se des-cancela al cerrar la caja.
      await base().where('estado', 'cancelado').update({ corte_id: id, updated_at: trx.fn.now() });
      await base().whereNot('estado', 'cancelado')
        .update({ corte_id: id, estado: 'en_corte', updated_at: trx.fn.now() });

      // Ahora sí: se suma EXACTAMENTE lo que quedó atado. Si el gate falla, la trx revierte las dos
      // cosas juntas.
      const filas = await trx('finance.cash_ledger')
        .where({ tenant_id: tenantId, corte_id: id })
        .whereNull('deleted_at')
        .select('tipo', 'monto', 'estado', 'origen_tipo');
      // `anclado` viaja al motor para que el corte FIRMADO deje constancia de cuánto de su
      // esperado venía de Kepler. Es el dato que distingue un corte auditable de uno que sólo
      // repite lo que el capturista tecleó (regla M4).
      const movs: MovimientoDelCorte[] = filas.map((r: any) => ({ ...r, anclado: r.origen_tipo === 'cobro' }));

      const t = calcularCorte({
        fondoInicial: Number(c.fondo_inicial), movimientos: movs,
        conteo: input.conteo, morralla: input.morralla ?? 0,
      });

      const gate = puedeCerrar(c, u.id, t);
      if (!gate.ok) throw new BadRequestException(TEXTO_NO_CIERRA[gate.motivo!]);

      const [cerrado] = await trx('finance.cash_ledger_cuts').where({ id }).update({
        estado: 'cerrado',
        closed_by: u.id, closed_by_username: u.username ?? null, closed_at: trx.fn.now(),
        total_ingresos: t.ingresos, total_gastos: t.gastos, total_depositos: t.depositos,
        esperado: t.esperado, contado: t.contado, diferencia: t.diferencia,
        morralla: input.morralla ?? 0, nota: input.nota ?? c.nota, updated_at: trx.fn.now(),
      }).returning('*');

      const piezas = (input.conteo ?? []).filter((d) => Number(d.piezas) > 0);
      if (piezas.length) {
        await trx('finance.cash_ledger_cut_denominations').where({ tenant_id: tenantId, cut_id: id }).del();
        await trx('finance.cash_ledger_cut_denominations').insert(
          piezas.map((d) => ({ tenant_id: tenantId, cut_id: id, denominacion: d.denominacion, piezas: d.piezas })));
      }

      return { ...cerrado, totales: t };
    });
  }

  async autorizar(id: string, user: Usuario) {
    const u = this.requireUser(user);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const c = await trx('finance.cash_ledger_cuts').where({ tenant_id: tenantId, id }).first();
      if (!c) throw new NotFoundException('Corte no encontrado');

      const gate = puedeAutorizar(c, u.id);
      if (!gate.ok) {
        // 403 y no 400: no es que el dato esté mal, es que esta persona no puede.
        throw new ForbiddenException(TEXTO_NO_AUTORIZA[gate.motivo!]);
      }
      const [aut] = await trx('finance.cash_ledger_cuts').where({ id }).update({
        estado: 'autorizado',
        authorized_by: u.id, authorized_by_username: u.username ?? null, authorized_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      }).returning('*');
      return aut;
    });
  }

  async listar(q: { from?: string; to?: string; sucursal?: string; estado?: string; limit?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    return this.tk.run(async (trx) => {
      let qb = trx('finance.cash_ledger_cuts').where('tenant_id', tenantId);
      if (q.from) qb = qb.where('fecha', '>=', q.from);
      if (q.to) qb = qb.where('fecha', '<=', q.to);
      if (q.sucursal) qb = qb.where('sucursal', q.sucursal);
      if (q.estado) qb = qb.where('estado', q.estado);
      const rows = await qb.orderBy('fecha', 'desc').orderBy('folio', 'desc').limit(limit);
      return { rows, limit };
    });
  }

  /**
   * Saldo actual de la caja: fondo del corte abierto + efecto de sus movimientos.
   * Se DERIVA (vista con ventana), no se guarda — ver §CG.15 de la fase.
   *
   * ⛔ **CG.19 Capa 1b — ACÁ ESTABA LA FUGA DEL ARQUEO CIEGO.** Este endpoint devolvía
   * `totales` completo (con `esperado`) y la pantalla lo pintaba en el diálogo de cierre mientras
   * la persona teclea el conteo. Contar viendo el esperado no es contar: es transcribir.
   *
   * Ahora sólo lo ve quien **autoriza** (`FINANCE_CAJA_AUTORIZAR`), que es la segunda llave del
   * corte — la misma persona que ya no puede ser la que cerró. Quien captura cuenta a ciegas y lo
   * ve al guardar.
   *
   * ⚠️ `saldo` también se recorta: es literalmente `t.esperado` con otro nombre. Dejarlo hubiera
   * sido tapar el campo y publicarlo en el de al lado — que es como se rompen estos candados.
   */
  /**
   * CS.3.11 — Conciliación con el CAJERO (CAOS) para el corte de OFICINAS (sucursal 00, el único con
   * cajero). Desde que abrió el corte, cuánto se DEPOSITÓ en el cajero (salió de caja chica a la
   * bóveda) y cuánto se DISPENSÓ (entró a caja chica). Modelo «cajas separadas»: la caja chica es
   * efectivo suelto, el cajero es la bóveda. `null` si no es oficinas, no hay corte, o no está el feed.
   * ⚠️ CAOS no tiene columna sucursal (un solo dispositivo en oficinas): el filtro es sólo por período.
   * ⚠️ `abs(total)`: una dispensación puede venir con `total` negativo — acá interesa la MAGNITUD movida.
   */
  private async conciliacionCajero(trx: any, tenantId: string, sucursal: string, desde: string | Date | null) {
    if (sucursal !== '00' || !desde) return null;
    const existe = await trx.raw(`SELECT to_regclass('analytics.caos_cash_movements') AS t`);
    if (!existe.rows?.[0]?.t) return null; // el feed del cajero puede no estar en este entorno
    const [r] = await trx('analytics.caos_cash_movements')
      .where('tenant_id', tenantId)
      .where('occurred_at', '>=', desde)
      .select(
        trx.raw(`coalesce(sum(abs(total)) FILTER (WHERE type_id = ${CAOS.DEPOSITO}), 0)::numeric AS depositado`),
        trx.raw(`coalesce(sum(abs(total)) FILTER (WHERE type_id = ${CAOS.DISPENSAR}), 0)::numeric AS dispensado`),
        // ⛔ Lo que ANTES no se contaba. `Dotar` mete efectivo a la bóveda y `Vaciar Stocks` lo
        // saca, y los dos quedaban fuera del cuadre: medido, $1,500,120 + $2,350,370 = $3.85M
        // invisibles. No son caja chica (entran/salen por fuera), pero un cuadre que los ignora
        // no puede explicar por qué la bóveda cambió — y el último fue el 2026-09-08, no en 2024.
        trx.raw(`coalesce(sum(abs(total)) FILTER (WHERE type_id = ${CAOS.DOTAR}), 0)::numeric AS dotado`),
        trx.raw(`coalesce(sum(abs(total)) FILTER (WHERE type_id = ${CAOS.VACIAR}), 0)::numeric AS vaciado`),
        trx.raw(`count(*) FILTER (WHERE type_id NOT IN (${TIPOS_CONOCIDOS.join(',')}))::int AS otros_movs`),
        trx.raw(`coalesce(sum(abs(total)) FILTER (WHERE type_id NOT IN (${TIPOS_CONOCIDOS.join(',')})), 0)::numeric AS otros_monto`),
        trx.raw(`count(*)::int AS movimientos`),
      );
    return {
      depositado: Number(r?.depositado ?? 0),
      dispensado: Number(r?.dispensado ?? 0),
      // Las dos piernas que no son caja chica, expuestas APARTE en vez de sumadas: mezclarlas con
      // el depósito/dispensación haría que la caja chica conciliada diera cualquier cosa.
      dotado: Number(r?.dotado ?? 0),
      vaciado: Number(r?.vaciado ?? 0),
      // ⚠️ Un tipo de CAOS que no conocemos NO se suma a ninguna pierna: se DECLARA. Si mañana el
      // cajero emite un tipo nuevo, acá aparece con su monto en vez de desaparecer en silencio.
      otros: { movimientos: Number(r?.otros_movs ?? 0), monto: Number(r?.otros_monto ?? 0) },
      movimientos: Number(r?.movimientos ?? 0),
      desde: desde instanceof Date ? desde.toISOString() : String(desde),
    };
  }

  async saldo(sucursal: string, revela = false) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const abierto = await trx('finance.cash_ledger_cuts')
        .where({ tenant_id: tenantId, sucursal, estado: 'borrador' }).first();
      const movs = await this.movimientosSueltos(trx, tenantId, sucursal);
      const cajero = await this.conciliacionCajero(trx, tenantId, sucursal, abierto?.created_at ?? null);
      const t = calcularCorte({ fondoInicial: Number(abierto?.fondo_inicial ?? 0), movimientos: movs });
      return {
        sucursal,
        corte_abierto: abierto
          ? {
            id: abierto.id, folio: abierto.folio, fondo_inicial: Number(abierto.fondo_inicial),
            // Que ya se recontó NO es secreto: no revela el esperado y la pantalla necesita
            // saberlo para apagar el botón antes de que el usuario lo intente.
            ya_reconto: abierto.conteo_previo != null,
          }
          : null,
        // Sin corte abierto el "saldo" no tiene punto de partida: se declara, no se dibuja en 0.
        saldo: revela ? (abierto ? t.esperado : null) : null,
        // Se DICE que está oculto. Un `null` por candado y un `null` por "no hay corte" son cosas
        // distintas y no pueden leerse igual (ADR-056).
        saldo_oculto: !revela,
        sin_corte_abierto: !abierto,
        movimientos_sueltos: t.movimientos,
        totales: proyectarCiego(t, revela),
        // CS.3.11 — el movimiento del cajero (CAOS) en el período del corte, para conciliar la caja
        // chica contra la bóveda. Los montos son hechos del cajero (no gateados); la caja chica
        // conciliada la calcula el front sólo cuando `saldo` (esperado) se revela.
        cajero,
      };
    });
  }

  /**
   * ⭐ `[CG.26]` — **EL ARQUEO DE FIN DE JORNADA: ¿cuadró el día en caja general y en el cajero?**
   *
   * Pedido de Edgar (2026-09-29): *"un arqueo diario al finalizar la jornada para ver que todo
   * cuadró en caja general y CAOS"*.
   *
   * ── Por qué NO alcanzaba con lo que ya había ───────────────────────────────────────────────
   * El arqueo existente (`saldo`) es **del corte**, no del día: su ventana es
   * `occurred_at >= corte.created_at` **sin tope superior**, así que un corte abierto una semana
   * concilia una semana. Y sobre todo **exige que alguien haya abierto un corte**, y en prod hay
   * CERO cortes — o sea que hoy no existe forma de cerrar un día.
   *
   * Éste no depende de que haya corte. Si lo hay lo muestra; si no, el día igual se puede cuadrar.
   *
   * ── La jornada la declara el cajero, no nuestro calendario ────────────────────────────────
   * El día es `accounting_date` de CAOS, **no** `occurred_at`. Medido: viene poblado en
   * **1,021 de 1,021** filas y difiere del día natural de México en **1**. Esa fila es
   * precisamente un movimiento pasada la medianoche que pertenece a la jornada anterior — que es
   * lo que "fin de jornada" significa. `shift_id` NO sirve: está **100 % en NULL**.
   *
   * ── Qué se puede afirmar y qué no ─────────────────────────────────────────────────────────
   * ⛔ **CAOS no publica su contenido.** No hay columna de saldo, stacker ni denominación
   * (verificado: cero columnas que matcheen saldo/balance/bag/stacker/denom). Del cajero se
   * cuadra el **FLUJO** (lo que entró contra lo que salió), nunca "cuánto hay adentro".
   *
   * ⛔ **Y el flujo acumulado NO es el efectivo de la máquina.** Medido desde que arranca el feed:
   * entra $17,995,820 − sale $18,812,090 = **−$816,270**. Negativo, porque el cajero ya tenía
   * efectivo antes del 2026-05-27 y ese saldo inicial **no lo sabemos**. Por eso el neto se
   * publica como *movimiento del día* y el acumulado no se publica como saldo.
   *
   * ⚠️ **El cuadre contra Kepler no es de hoy, y no por culpa del feed.** El feed está al día (su
   * última captura es de hoy), pero el ERP tarda una **mediana de 3 días** en capturar el
   * documento: el efectivo de hoy aparece en Kepler recién dentro de unos días. Por eso la cola
   * del ERP no se usa acá para decir si el día cuadró.
   */
  async arqueoDelDia(fecha: string | undefined, sucursal: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const dia = String(
        fecha || (await trx.raw(`SELECT (now() AT TIME ZONE 'America/Mexico_City')::date::text d`)).rows[0].d,
      ).slice(0, 10);

      // ── 1. Caja general: lo que NUESTRO libro registró en esa jornada ────────────────────
      const [libro] = await trx('finance.cash_ledger')
        .where({ tenant_id: tenantId, sucursal, fecha: dia })
        .whereNull('deleted_at')
        .select(
          trx.raw(`count(*) FILTER (WHERE estado <> 'cancelado')::int AS movimientos`),
          trx.raw(`count(*) FILTER (WHERE estado = 'cancelado')::int AS cancelados`),
          trx.raw(`coalesce(sum(monto) FILTER (WHERE estado <> 'cancelado' AND tipo='ingreso'),0)::numeric AS ingresos`),
          trx.raw(`coalesce(sum(monto) FILTER (WHERE estado <> 'cancelado' AND tipo='gasto'),0)::numeric AS gastos`),
          trx.raw(`coalesce(sum(monto) FILTER (WHERE estado <> 'cancelado' AND tipo='deposito'),0)::numeric AS depositos`),
        );
      const ingresos = Number(libro?.ingresos ?? 0);
      const gastos = Number(libro?.gastos ?? 0);
      const depositos = Number(libro?.depositos ?? 0);

      // ── 2. El cajero (CAOS): la jornada COMPLETA, con los seis tipos ─────────────────────
      // ⚠️ CAOS no tiene columna de sucursal: es un único dispositivo, en oficinas. Para cualquier
      // otra sucursal se devuelve `null` y se DICE por qué, en vez de mostrar ceros que se leerían
      // como "el cajero no se movió".
      const hayCaos = (await trx.raw(`SELECT to_regclass('analytics.caos_cash_movements') AS t`))
        .rows?.[0]?.t;
      let cajero: Record<string, unknown> | null = null;
      if (hayCaos && sucursal === '00') {
        const porTipo = await trx('analytics.caos_cash_movements')
          .where({ tenant_id: tenantId, accounting_date: dia })
          .groupBy('type_id', 'type_label')
          .orderBy('type_id')
          .select(
            'type_id',
            trx.raw(`coalesce(type_label, '(tipo ' || type_id || ' sin etiqueta)') AS etiqueta`),
            trx.raw(`count(*)::int AS movimientos`),
            trx.raw(`coalesce(sum(abs(total)), 0)::numeric AS monto`),
            trx.raw(`(type_id NOT IN (${TIPOS_CONOCIDOS.join(',')})) AS desconocido`),
          );
        const suma = (ids: readonly number[]) => porTipo
          .filter((t: { type_id: number }) => ids.includes(Number(t.type_id)))
          .reduce((a: number, t: { monto: string }) => a + Number(t.monto), 0);
        // Entra a la bóveda: lo depositado (viene de caja chica) + lo dotado (viene de afuera).
        const entra = suma([CAOS.DEPOSITO, CAOS.DOTAR]);
        // Sale de la bóveda: lo dispensado (va a caja chica) + lo vaciado (se lo llevan afuera).
        const sale = suma([CAOS.DISPENSAR, CAOS.VACIAR]);
        const desconocidos = porTipo.filter((t: { desconocido: boolean }) => t.desconocido);
        const [ult] = await trx('analytics.caos_cash_movements')
          .where({ tenant_id: tenantId })
          .max({ al: 'occurred_at' });
        cajero = {
          por_tipo: porTipo.map((t: Record<string, unknown>) => ({
            type_id: Number(t['type_id']), etiqueta: t['etiqueta'],
            movimientos: Number(t['movimientos']), monto: Number(t['monto']),
            desconocido: !!t['desconocido'],
          })),
          entra, sale,
          // El movimiento NETO del día. NO es "lo que hay en el cajero": ver el encabezado.
          neto: Number((entra - sale).toFixed(2)),
          // Las cuatro piernas por separado, porque significan cosas distintas.
          depositado: suma([CAOS.DEPOSITO]), dispensado: suma([CAOS.DISPENSAR]),
          dotado: suma([CAOS.DOTAR]), vaciado: suma([CAOS.VACIAR]),
          movimientos: porTipo.reduce((a: number, t: { movimientos: number }) => a + Number(t.movimientos), 0),
          // Un tipo que no conocemos se DECLARA con su monto; nunca se reparte a una pierna.
          tipos_desconocidos: desconocidos.map((t: Record<string, unknown>) => ({
            type_id: Number(t['type_id']), etiqueta: t['etiqueta'], monto: Number(t['monto']),
          })),
          ultimo_movimiento: (ult as { al?: string } | undefined)?.al ?? null,
        };
      }

      const corte = await trx('finance.cash_ledger_cuts')
        .where({ tenant_id: tenantId, sucursal, estado: 'borrador' })
        .first('id', 'folio', 'fecha');

      // ── 3. Lo que NO se puede afirmar, dicho con nombre (ADR-056) ────────────────────────
      const no_medido: string[] = [];
      if (!hayCaos) {
        no_medido.push('El feed del cajero (CAOS) no está en este entorno: del día sólo se puede cuadrar la caja general.');
      } else if (sucursal !== '00') {
        no_medido.push(`El cajero (CAOS) es un único dispositivo en oficinas: la sucursal ${sucursal} no tiene cajero que cuadrar.`);
      } else {
        no_medido.push('Del cajero se cuadra el FLUJO del día, no su contenido: CAOS no publica cuánto efectivo tiene adentro.');
      }
      if (!corte) {
        no_medido.push('No hay corte abierto en esta sucursal, así que el día no se puede comparar contra un conteo físico: esto es el movimiento REGISTRADO, no un arqueo firmado.');
      }
      no_medido.push('La cola de Kepler no entra en este cuadre: el ERP tarda una mediana de 3 días en capturar el documento, así que el efectivo de hoy todavía no está allá.');
      if (cajero && (cajero['tipos_desconocidos'] as unknown[]).length > 0) {
        no_medido.push('El cajero reportó un tipo de movimiento que no conocemos: está listado aparte y NO se sumó a ninguna pierna.');
      }

      return {
        fecha: dia,
        sucursal,
        caja_general: {
          movimientos: Number(libro?.movimientos ?? 0),
          cancelados: Number(libro?.cancelados ?? 0),
          ingresos, gastos, depositos,
          // Lo que el día le dejó a la caja chica según el libro. Sin fondo inicial: eso compone el
          // `esperado` del corte y vive gateado en `saldo()` (CG.19, arqueo ciego).
          neto: Number((ingresos - gastos - depositos).toFixed(2)),
        },
        cajero,
        corte_abierto: corte
          ? { id: corte.id, folio: corte.folio, fecha: String(corte.fecha).slice(0, 10) }
          : null,
        no_medido,
      };
    });
  }

  /** Cancela un movimiento. No se borra: se marca, con motivo y autor. */
  async cancelarMovimiento(id: string, motivo: string, user: Usuario) {
    const u = this.requireUser(user);
    const tenantId = this.tenantCtx.requireTenantId();
    if (!motivoCancelacionValido(motivo)) {
      throw new BadRequestException('Explicá por qué se cancela, con al menos 5 caracteres.');
    }
    return this.tk.run(async (trx) => {
      const m = await trx('finance.cash_ledger').where({ tenant_id: tenantId, id }).first();
      if (!m) throw new NotFoundException('Movimiento no encontrado');

      let estadoCorte: string | null = null;
      if (m.corte_id) {
        const c = await trx('finance.cash_ledger_cuts').where({ tenant_id: tenantId, id: m.corte_id }).first();
        estadoCorte = c?.estado ?? null;
      }
      if (!puedeCancelarse(m, estadoCorte)) {
        throw new BadRequestException(
          m.estado === 'cancelado'
            ? 'Este movimiento ya está cancelado.'
            : 'Este movimiento ya entró a un corte cerrado: no se puede cancelar sin mover un cuadre que alguien firmó. Registrá un movimiento que lo corrija.');
      }
      const [cancelado] = await trx('finance.cash_ledger').where({ id }).update({
        estado: 'cancelado', cancel_reason: motivo.trim(),
        cancelled_by: u.id, cancelled_by_username: u.username ?? null,
        cancelled_at: trx.fn.now(), updated_at: trx.fn.now(),
      }).returning('*');
      return cancelado;
    });
  }
}
