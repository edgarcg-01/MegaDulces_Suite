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
  async saldo(sucursal: string, revela = false) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const abierto = await trx('finance.cash_ledger_cuts')
        .where({ tenant_id: tenantId, sucursal, estado: 'borrador' }).first();
      const movs = await this.movimientosSueltos(trx, tenantId, sucursal);
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
