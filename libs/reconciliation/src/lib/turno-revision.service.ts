import type { Knex } from 'knex';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import {
  ACCIONES_REVISION, CAUSAS_REVISION, NOTA_REVISION_MAX, NOTA_REVISION_MIN, REVISION_DIAS_MAX,
  type ArqueoRevisionAccionDto, type ArqueoRevisionDiaDto, type ArqueoRevisionEvento, type ArqueoRevisionFirmaDia,
  type ArqueoRevisionJustificacion, type ArqueoRevisionJustificarDto, type ArqueoRevisionResp,
  type ArqueoRevisionResumen, type ArqueoRevisionSucursal, type ArqueoRevisionTurno,
} from '@megadulces/contracts/http/arqueo-cajas';
import { BlindCountService } from './blind-count.service';
import {
  MARCA_CERRADO, MARCA_DIA, PREFIJO_ACCION, RULE_KEY_DIA, RULE_KEY_REVISION, type FilaHistorial, type TurnoBase,
  claveDia, claveTurno, descuadraRetiros, diasEntre, estadoDe, historialDe, puedeCerrar, resumenCajeras, resumenDias,
  totalesRetiros, turnosCerrados, ultimaCausa,
} from './turno-revision';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

const REGLAS = {
  [RULE_KEY_REVISION]: {
    nombre: 'Turno sin verificar (lo justifica la encargada)',
    descripcion: '[SM.55] Turno cerrado cuyos retiros de la Suite no empatan con los de Kepler (sin contar o de más). '
      + 'No la corre el escáner: la encargada la justifica en /tienda/arqueo/revision («Retiros por revisar»).',
  },
  [RULE_KEY_DIA]: {
    nombre: 'Día de caja revisado por la encargada',
    descripcion: '[SM.55] La encargada firma que revisó los turnos de un día de su sucursal. No la corre el escáner.',
  },
} as const;

interface Caso { status: string; filas: FilaHistorial[] }

/**
 * [SM.55] Revisión de turnos: la encargada ve los turnos cerrados de su sucursal, justifica los
 * que quedaron con retiros o cajón sin contar, registra qué hizo y los cierra; y firma cada día.
 *
 * ── Dónde se guarda (ADR-056: no se inventa otra bandeja)
 *
 * En el motor de hallazgos que ya existe, sin migración:
 *  - Cada turno con algo que revisar es un hallazgo `turno_sin_verificar` en
 *    `reconciliation.discrepancies` (una fila por turno, por `dedup_key`). Su historial son las
 *    filas de `reconciliation.discrepancy_feedback`: la causa (`no_capturado`…), cada acción
 *    (`accion:hablo_cajera`…) y el cierre (`cerrado`). Veredicto siempre `util`: el turno SÍ quedó
 *    sin verificar; con `falso` la precisión de la regla caería y se auto-suprimiría.
 *  - La firma del día es un hallazgo `dia_revisado` con sus filas `dia_revisado`.
 *  - Las dos reglas se registran con `enabled = false` (el escáner nocturno no las corre) y los
 *    estados quedan en `confirmado` / `corregido`: la bandeja `/almacen/cuadre` solo enseña
 *    `nuevo`/`en_revision`, así que esto no le agrega ruido.
 *
 * La LISTA no sale de esas tablas: se calcula al momento con `cajasDelDia`, la misma liga conteo ↔
 * turno que «Sucursales y sus cajas». Si la cajera cuenta tarde y el turno ya cuadra, deja de
 * pedirse solo.
 */
@Injectable()
export class TurnoRevisionService {
  private readonly logger = new Logger(TurnoRevisionService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly blind: BlindCountService,
  ) {}

  /** Todos los turnos cerrados de `desde` a `hasta`, con su estado, y el control por día y por cajera. */
  async pendientes(desde: string, hasta: string, warehouseCodes: string[] | null): Promise<ArqueoRevisionResp> {
    const dias = this.rango(desde, hasta);
    const base: TurnoBase[] = [];
    for (const f of dias) base.push(...turnosCerrados(await this.blind.cajasDelDia(f, warehouseCodes)));

    const clavesDia = [...new Set(base.map((t) => claveDia(t.warehouse_code, t.fecha)))];
    const casos = await this.leerCasos([...base.filter((t) => t.motivos.length).map((t) => t.clave), ...clavesDia]);

    const turnos: ArqueoRevisionTurno[] = base.map((t) => {
      const historial = historialDe(casos.get(t.clave)?.filas ?? []);
      return { ...t, historial, justificacion: ultimaCausa(historial), estado: estadoDe(t.motivos, historial) };
    });
    const orden: Record<string, number> = { por_justificar: 0, en_seguimiento: 1, cerrado: 2, cuadra: 3 };
    turnos.sort((a, b) => orden[a.estado] - orden[b.estado]
      || b.fecha.localeCompare(a.fecha)
      || a.warehouse_code.localeCompare(b.warehouse_code)
      || a.caja.localeCompare(b.caja, 'es', { numeric: true })
      || String(a.hora_apertura ?? '').localeCompare(String(b.hora_apertura ?? '')));

    const firmas = new Map<string, ArqueoRevisionFirmaDia>();
    for (const k of clavesDia) {
      const ult = [...(casos.get(k)?.filas ?? [])].filter((f) => f.causa === MARCA_DIA)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
      if (ult) firmas.set(k, { por: ult.created_by, por_nombre: ult.nombre, at: new Date(ult.created_at).toISOString(), nota: ult.nota });
    }
    const diasResumen = resumenDias(turnos, firmas);

    const suc = new Map<string, ArqueoRevisionSucursal>();
    const s0 = (t: { warehouse_code: string; warehouse_nombre?: string | null }): ArqueoRevisionSucursal =>
      suc.get(t.warehouse_code) ?? {
        warehouse_code: t.warehouse_code, nombre: t.warehouse_nombre ?? null, total: 0, justificados: 0,
        pendientes: 0, en_seguimiento: 0, cerrados: 0, dias_sin_revisar: 0,
      };
    for (const t of turnos) {
      const s = s0(t);
      if (t.estado !== 'cuadra') {
        s.total++;
        if (t.estado === 'por_justificar') s.pendientes++; else s.justificados++;
        if (t.estado === 'en_seguimiento') s.en_seguimiento++;
        if (t.estado === 'cerrado') s.cerrados++;
      }
      suc.set(t.warehouse_code, s);
    }
    for (const d of diasResumen) if (!d.revisado) { const s = s0(d); s.dias_sin_revisar++; suc.set(d.warehouse_code, s); }

    // Al final a propósito: es la única lectura que se traga su propio error (devuelve «desconocido»).
    const ods = await this.blind.frescuraOds();
    return {
      desde, hasta, datos_al: ods.datos_al, frescura: ods.status, turnos, dias: diasResumen,
      cajeras: resumenCajeras(turnos),
      totales: totalesRetiros(turnos),
      sucursales: [...suc.values()].sort((a, b) => a.warehouse_code.localeCompare(b.warehouse_code)),
    };
  }

  /** Lo justo para el aviso de las pestañas. */
  async resumen(desde: string, hasta: string, warehouseCodes: string[] | null): Promise<ArqueoRevisionResumen> {
    const r = await this.pendientes(desde, hasta, warehouseCodes);
    return {
      desde, hasta,
      por_justificar: r.turnos.filter((t) => t.estado === 'por_justificar').length,
      en_seguimiento: r.turnos.filter((t) => t.estado === 'en_seguimiento').length,
      dias_sin_revisar: r.dias.filter((d) => !d.revisado).length,
    };
  }

  /** La encargada deja por escrito qué pasó. Se puede corregir la causa mientras no esté cerrado. */
  async justificar(dto: ArqueoRevisionJustificarDto, username?: string): Promise<ArqueoRevisionJustificacion> {
    const causa = String(dto?.causa ?? '').trim();
    if (!CAUSAS_REVISION.some((c) => c.value === causa)) {
      throw new BadRequestException(`Elige la causa (${CAUSAS_REVISION.map((c) => c.value).join(' | ')}).`);
    }
    const nota = this.nota(dto?.nota, true);
    const { turno, caso } = await this.turnoVigente(dto);
    if (caso && historialDe(caso.filas).some((e) => e.tipo === 'cerrado')) {
      throw new BadRequestException('Este turno ya está cerrado: su revisión no se puede cambiar.');
    }
    const actor = username?.trim() || null;
    const fb = await this.tk.run(async (trx) => {
      const id = await this.upsertCaso(trx, turno, 'confirmado', causa);
      return this.agregar(trx, id, causa, nota, actor);
    });
    this.logger.log(`[SM.55] ${turno.clave} causa ${causa} por ${actor ?? 'sin usuario'}`);
    return { causa, nota: nota ?? '', por: actor, por_nombre: fb.nombre, at: fb.at };
  }

  /** Qué se hizo después de saber la causa; con `cerrar` el caso queda cerrado y ya no se edita. */
  async accion(dto: ArqueoRevisionAccionDto, username?: string): Promise<ArqueoRevisionEvento[]> {
    const accion = String(dto?.accion ?? '').trim();
    if (!ACCIONES_REVISION.some((a) => a.value === accion)) {
      throw new BadRequestException(`Elige qué se hizo (${ACCIONES_REVISION.map((a) => a.value).join(' | ')}).`);
    }
    const nota = this.nota(dto?.nota, true);
    const cerrar = dto?.cerrar === true;
    const { turno, caso } = await this.turnoVigente(dto);
    const h = historialDe(caso?.filas ?? []);
    if (h.some((e) => e.tipo === 'cerrado')) throw new BadRequestException('Este turno ya está cerrado.');
    if (!h.some((e) => e.tipo === 'causa')) throw new BadRequestException('Primero di qué pasó (la causa); después lo que se hizo.');
    if (cerrar && !puedeCerrar(h, true)) throw new BadRequestException('No se puede cerrar todavía.');
    const actor = username?.trim() || null;
    await this.tk.run(async (trx) => {
      const id = await this.upsertCaso(trx, turno, cerrar ? 'corregido' : 'confirmado', null);
      await this.agregar(trx, id, PREFIJO_ACCION + accion, nota, actor);
      if (cerrar) await this.agregar(trx, id, MARCA_CERRADO, null, actor);
    });
    this.logger.log(`[SM.55] ${turno.clave} acción ${accion}${cerrar ? ' + cerrado' : ''} por ${actor ?? 'sin usuario'}`);
    const despues = await this.leerCasos([turno.clave]);
    return historialDe(despues.get(turno.clave)?.filas ?? []);
  }

  /**
   * La encargada firma que revisó un día de su sucursal. Solo un día que ya terminó, y solo si
   * ningún turno de ese día quedó sin causa: firmar con pendientes sería firmar que no se revisó.
   */
  async marcarDia(dto: ArqueoRevisionDiaDto, username?: string): Promise<ArqueoRevisionFirmaDia> {
    const warehouse = String(dto?.warehouse_code ?? '').trim();
    const fecha = String(dto?.fecha ?? '').trim();
    if (!warehouse) throw new BadRequestException('Falta la sucursal.');
    if (!FECHA.test(fecha)) throw new BadRequestException("fecha va como 'YYYY-MM-DD'.");
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    if (fecha >= hoy) throw new BadRequestException('Solo se firma un día que ya terminó.');
    const nota = this.nota(dto?.nota, false);

    const turnos = turnosCerrados(await this.blind.cajasDelDia(fecha, [warehouse]));
    if (!turnos.length) throw new BadRequestException('Ese día no tiene turnos cerrados en Kepler.');
    const casos = await this.leerCasos(turnos.filter((t) => t.motivos.length).map((t) => t.clave));
    const sinCausa = turnos.filter((t) => estadoDe(t.motivos, historialDe(casos.get(t.clave)?.filas ?? [])) === 'por_justificar');
    if (sinCausa.length) {
      throw new BadRequestException(`Faltan ${sinCausa.length} turno(s) por justificar ese día (cajas ${sinCausa.map((t) => t.caja).join(', ')}).`);
    }
    const actor = username?.trim() || null;
    const tenantId = this.tenantCtx.requireTenantId();
    const fb = await this.tk.run(async (trx) => {
      await this.registrarRegla(trx, tenantId, RULE_KEY_DIA);
      const [d] = await trx('reconciliation.discrepancies')
        .insert({
          tenant_id: tenantId, rule_key: RULE_KEY_DIA, plano: 'caja', severity: 'info', status: 'confirmado',
          titulo: `Día revisado · suc ${warehouse} · ${fecha}`, resumen: `${turnos.length} turnos cerrados`,
          entity: JSON.stringify({ warehouse_code: warehouse, fecha }), periodo: fecha, importe: 0,
          evidencia: JSON.stringify({ turnos: turnos.length, con_problema: turnos.filter((t) => t.motivos.length).length }),
          dedup_key: claveDia(warehouse, fecha),
        })
        .onConflict(['tenant_id', 'dedup_key'])
        .merge({ last_seen: trx.fn.now(), updated_at: trx.fn.now() })
        .returning(['id']);
      return this.agregar(trx, d.id as string, MARCA_DIA, nota, actor);
    });
    this.logger.log(`[SM.55] día ${warehouse} ${fecha} revisado por ${actor ?? 'sin usuario'}`);
    return { por: actor, por_nombre: fb.nombre, at: fb.at, nota };
  }

  // ── Piezas ───────────────────────────────────────────────────────────────────

  private rango(desde: string, hasta: string): string[] {
    if (!FECHA.test(desde) || !FECHA.test(hasta)) throw new BadRequestException("desde y hasta van como 'YYYY-MM-DD'.");
    const dias = diasEntre(desde, hasta);
    if (!dias.length) throw new BadRequestException('desde no puede ser posterior a hasta.');
    if (dias.length > REVISION_DIAS_MAX) throw new BadRequestException(`Máximo ${REVISION_DIAS_MAX} días por consulta.`);
    return dias;
  }

  private nota(v: unknown, obligatoria: boolean): string | null {
    const n = String(v ?? '').trim();
    if (!n && !obligatoria) return null;
    if (n.length < NOTA_REVISION_MIN) {
      throw new BadRequestException(`Escribe qué pasó (mínimo ${NOTA_REVISION_MIN} letras): es lo que justifica el turno.`);
    }
    if (n.length > NOTA_REVISION_MAX) throw new BadRequestException(`La nota admite hasta ${NOTA_REVISION_MAX} letras.`);
    return n;
  }

  /**
   * El turno tiene que estar por revisar HOY, con los datos de hoy: no se justifica un turno
   * inventado ni uno que ya cuadró. De paso, sus montos quedan como evidencia.
   */
  private async turnoVigente(dto: { warehouse_code?: string; fecha?: string; caja?: string; folio?: string } | undefined) {
    const warehouse = String(dto?.warehouse_code ?? '').trim();
    const caja = String(dto?.caja ?? '').trim();
    const folio = String(dto?.folio ?? '').trim();
    const fecha = String(dto?.fecha ?? '').trim();
    if (!warehouse || !caja || !folio) throw new BadRequestException('Falta la sucursal, la caja o el folio del turno.');
    if (!FECHA.test(fecha)) throw new BadRequestException("fecha va como 'YYYY-MM-DD'.");
    const turno = turnosCerrados(await this.blind.cajasDelDia(fecha, [warehouse]))
      .find((t) => t.caja === caja && t.folio === folio && descuadraRetiros(t.motivos));
    // Solo se justifica lo que rompe el empate de retiros con Kepler; el cajón sin contar es dato, no caso.
    if (!turno) throw new BadRequestException('Ese turno no tiene retiros por revisar: ya empatan con Kepler, sigue abierto o no existe en Kepler.');
    const caso = (await this.leerCasos([turno.clave])).get(turno.clave) ?? null;
    return { turno, caso };
  }

  private async registrarRegla(trx: Knex.Transaction, tenantId: string, rule: keyof typeof REGLAS): Promise<void> {
    await trx('reconciliation.rule_registry')
      .insert({ tenant_id: tenantId, rule_key: rule, plano: 'caja', enabled: false, params: {}, ...REGLAS[rule] })
      .onConflict(['tenant_id', 'rule_key']).ignore();
  }

  /** Crea o actualiza el hallazgo del turno y devuelve su id. `causa` null = no la toca. */
  private async upsertCaso(trx: Knex.Transaction, turno: TurnoBase, status: string, causa: string | null): Promise<string> {
    const tenantId = this.tenantCtx.requireTenantId();
    await this.registrarRegla(trx, tenantId, RULE_KEY_REVISION);
    const importe = Math.abs(turno.retiros_diferencia);
    const evidencia = JSON.stringify(turno);
    const fila = {
      tenant_id: tenantId, rule_key: RULE_KEY_REVISION, plano: 'caja',
      severity: turno.motivos.includes('retiros_sin_contar') ? 'warn' : 'info',
      status,
      titulo: `Turno sin verificar · suc ${turno.warehouse_code} caja ${turno.caja} · ${turno.fecha}`,
      resumen: turno.motivos.join(', '),
      entity: JSON.stringify({
        warehouse_code: turno.warehouse_code, caja: turno.caja, folio: turno.folio, fecha: turno.fecha, cajero_code: turno.cajero_code,
      }),
      periodo: turno.fecha,
      esperado: turno.retirado_kepler, observado: turno.retiros_contados, diferencia: turno.retiros_diferencia, importe,
      causa_probable: turno.motivos.join(','), causa_confirmada: causa, evidencia,
      dedup_key: turno.clave,
    };
    const merge: Record<string, unknown> = {
      status, observado: fila.observado, diferencia: fila.diferencia, importe, evidencia,
      last_seen: trx.fn.now(), updated_at: trx.fn.now(),
    };
    if (causa) merge['causa_confirmada'] = causa;
    const [d] = await trx('reconciliation.discrepancies').insert(fila).onConflict(['tenant_id', 'dedup_key']).merge(merge).returning(['id']);
    return d.id as string;
  }

  private async agregar(trx: Knex.Transaction, discrepancyId: string, causa: string, nota: string | null, actor: string | null) {
    const tenantId = this.tenantCtx.requireTenantId();
    const [fb] = await trx('reconciliation.discrepancy_feedback')
      // clock_timestamp(), no now(): now() es la hora de INICIO de la transacción, así que la acción y el
      // cierre que se guardan juntos quedaban con la misma hora y el historial salía en desorden (lo cazó la prueba).
      .insert({ tenant_id: tenantId, discrepancy_id: discrepancyId, verdict: 'util', causa, nota, created_by: actor, created_at: trx.raw('clock_timestamp()') })
      .returning(['created_at']);
    const quien = actor
      ? await trx('users').where('tenant_id', tenantId).whereRaw('upper(username) = upper(?)', [actor]).first('nombre')
      : undefined;
    return { at: new Date(fb.created_at as string | Date).toISOString(), nombre: (quien?.nombre as string | undefined) ?? null };
  }

  /** El estado y el historial completo de cada caso (por `dedup_key`). */
  private async leerCasos(claves: string[]): Promise<Map<string, Caso>> {
    const out = new Map<string, Caso>();
    if (!claves.length) return out;
    const tenantId = this.tenantCtx.requireTenantId();
    const rows = await this.tk.run(async (trx: Knex.Transaction) => (await trx.raw(
      `SELECT d.dedup_key, d.status, fb.causa, fb.nota, fb.created_by, fb.created_at, u.nombre
         FROM reconciliation.discrepancies d
         LEFT JOIN reconciliation.discrepancy_feedback fb ON fb.tenant_id = d.tenant_id AND fb.discrepancy_id = d.id
         LEFT JOIN users u ON u.tenant_id = d.tenant_id AND upper(u.username) = upper(fb.created_by)
        WHERE d.tenant_id = ? AND d.rule_key IN (?, ?) AND d.dedup_key = ANY(?::text[])
        ORDER BY d.dedup_key, fb.created_at`,
      [tenantId, RULE_KEY_REVISION, RULE_KEY_DIA, claves],
    )).rows as Array<FilaHistorial & { dedup_key: string; status: string }>);
    for (const r of rows) {
      const c = out.get(r.dedup_key) ?? { status: r.status, filas: [] };
      if (r.created_at) c.filas.push({ causa: r.causa, nota: r.nota, created_by: r.created_by, nombre: r.nombre, created_at: r.created_at });
      out.set(r.dedup_key, c);
    }
    return out;
  }
}
