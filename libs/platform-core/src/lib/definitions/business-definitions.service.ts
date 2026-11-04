import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import {
  resolverDefinicion, validarRespuesta,
  type ActualizarDefinicion, type ContestarDefinicion, type DefinicionResuelta, type DefinicionVista,
  type EstadoDefinicion, type OpcionDefinicion, type PersonaAsignable, type RespuestaDefinicion,
  type TipoDefinicion,
} from '@megadulces/contracts';
import { TenantKnexService } from '../database/tenant-knex.service';
import { TenantContextService } from '../tenant/tenant-context.service';

/**
 * `[DP.2.1]` `[DP.2.2]` — Definiciones de negocio: leer, repartir y contestar (Fase DP).
 *
 * La pregunta vive en `platform.business_definitions` y sus respuestas en
 * `platform.business_definition_answers` (migración `20261103153257`). Este servicio es el ÚNICO
 * camino que escribe en las dos.
 *
 * ── Las tres reglas que hace cumplir ─────────────────────────────────────────────────────
 *  1. **La contesta su dueño.** `assigned_to` = quien pide, o 403. No hay «contestar por otro»:
 *     quien reparte (GESTIONAR) se la asigna y la contesta como dueño, y así la respuesta dice
 *     de verdad quién la dio.
 *  2. **Contestar no pisa: versiona** (D3). Cada respuesta es una fila con vigencia y motivo; la
 *     que rige a una fecha la decide `resolverDefinicion()` del contrato — la misma función que
 *     leen la pantalla y los consumidores, para que no haya dos reglas.
 *  3. **Lo que nadie contestó se DECLARA** `sin_definir` (ADR-056). La propuesta (`suggested_*`)
 *     viaja aparte y nunca se devuelve como valor.
 *
 * Las formas (`DefinicionVista`, los bodies) viven en `@megadulces/contracts`: la pantalla las importa
 * de ahí y un cambio de forma truena al compilar, no en pantalla.
 */

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FilaDef {
  id: string; key: string; area: string; consumer: string; question: string; decides: string;
  value_type: TipoDefinicion; choices: OpcionDefinicion[] | null; unit: string | null;
  config_route: string | null; suggested_value: unknown; suggested_source: string | null;
  status: EstadoDefinicion; assigned_to: string | null; due_at: Date | string | null;
  answered_at: Date | string | null; discard_reason: string | null; asignado_nombre: string | null;
}
interface FilaResp {
  id: string; definition_id: string; value: unknown; valid_from: string; note: string;
  answered_by: string; answered_at: Date | string;
}

const iso = (v: Date | string | null | undefined): string | null => (v == null ? null : new Date(v).toISOString());

@Injectable()
export class BusinessDefinitionsService {
  private readonly logger = new Logger(BusinessDefinitionsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Todas las preguntas (de un consumidor, si se pide), con la respuesta que rige hoy. */
  async listar(consumer?: string): Promise<DefinicionVista[]> {
    return this.tk.run(async (trx) => this.leer(trx, { consumer }));
  }

  /** Las preguntas a nombre de quien pide: su bandeja. Abiertas primero, por plazo. */
  async mias(): Promise<DefinicionVista[]> {
    const userId = this.requireUser();
    return this.tk.run(async (trx) => this.leer(trx, { assignedTo: userId }));
  }

  /**
   * La respuesta que rige a una fecha, para un consumidor del servidor (el motor de comisiones).
   * `null` si la key no existe: eso es un error de quien la pide, no «sin definir».
   */
  async resolver(key: string, fecha: string): Promise<DefinicionResuelta | null> {
    if (!FECHA.test(fecha)) throw new BadRequestException('fecha tiene que ser AAAA-MM-DD');
    return this.tk.run(async (trx) => {
      const [d] = await this.leer(trx, { key, fecha });
      return d ? d.vigente : null;
    });
  }

  /** Contesta una pregunta. Sólo su dueño. Devuelve la pregunta con la respuesta que rige hoy. */
  async contestar(id: string, body: ContestarDefinicion): Promise<DefinicionVista> {
    const userId = this.requireUser();
    if (!UUID.test(id ?? '')) throw new BadRequestException('id inválido');
    if (!body || !FECHA.test(body.valid_from ?? '') || Number.isNaN(Date.parse(body.valid_from))) {
      throw new BadRequestException('valid_from tiene que ser una fecha AAAA-MM-DD');
    }
    const note = (body.note ?? '').trim();
    if (!note) throw new BadRequestException('El motivo es obligatorio: dice por qué se decidió así.');

    return this.tk.run(async (trx) => {
      const def = await trx('platform.business_definitions')
        .where({ id }).whereNull('deleted_at').forUpdate().first();
      if (!def) throw new NotFoundException('La pregunta no existe');
      if (def.status === 'descartada') {
        throw new ConflictException('La pregunta está descartada: ya no se contesta.');
      }
      if (def.assigned_to !== userId) {
        throw new ForbiddenException(def.assigned_to
          ? 'La contesta su dueño. Para contestarla tú, que quien reparte te la asigne.'
          : 'La pregunta no tiene dueño todavía: primero hay que asignarla.');
      }
      const motivo = validarRespuesta({ value_type: def.value_type, choices: def.choices }, body.value);
      if (motivo) throw new BadRequestException(`La respuesta ${motivo}.`);

      await trx('platform.business_definition_answers').insert({
        tenant_id: def.tenant_id, definition_id: id, value: JSON.stringify(body.value),
        valid_from: body.valid_from, note, answered_by: userId,
      });
      await trx('platform.business_definitions').where({ id }).update({
        status: 'respondida', answered_at: trx.fn.now(), answered_by: userId,
        updated_at: trx.fn.now(), updated_by: userId,
      });
      this.logger.log(`[DP] ${def.key} contestada por ${userId} (rige desde ${body.valid_from})`);
      const [vista] = await this.leer(trx, { id });
      return vista;
    });
  }

  /** Reparte (dueño, plazo) o descarta. GESTIONAR: el controlador ya lo exigió. */
  async actualizar(id: string, body: ActualizarDefinicion): Promise<DefinicionVista> {
    const userId = this.requireUser();
    if (!UUID.test(id ?? '')) throw new BadRequestException('id inválido');
    const b = body ?? {};
    const quiere = (k: keyof ActualizarDefinicion) => Object.prototype.hasOwnProperty.call(b, k);
    if (!quiere('assigned_to') && !quiere('due_at') && !quiere('discard_reason')) {
      throw new BadRequestException('Nada que cambiar: manda assigned_to, due_at o discard_reason.');
    }
    if (quiere('assigned_to') && b.assigned_to !== null && !UUID.test(b.assigned_to ?? '')) {
      throw new BadRequestException('assigned_to tiene que ser el id de una persona, o null');
    }
    if (quiere('due_at') && b.due_at !== null && Number.isNaN(Date.parse(b.due_at ?? ''))) {
      throw new BadRequestException('due_at tiene que ser una fecha, o null');
    }

    return this.tk.run(async (trx) => {
      const def = await trx('platform.business_definitions')
        .where({ id }).whereNull('deleted_at').forUpdate().first();
      if (!def) throw new NotFoundException('La pregunta no existe');

      const patch: Record<string, unknown> = { updated_at: trx.fn.now(), updated_by: userId };
      if (quiere('assigned_to')) {
        if (b.assigned_to) {
          const persona = await trx('identity.users')
            .where({ id: b.assigned_to }).whereNull('deleted_at').first('id', 'activo');
          if (!persona) throw new BadRequestException('Esa persona no está en el padrón.');
          if (persona.activo === false) throw new BadRequestException('Esa persona está dada de baja.');
          Object.assign(patch, { assigned_to: b.assigned_to, assigned_by: userId, assigned_at: trx.fn.now() });
        } else {
          Object.assign(patch, { assigned_to: null, assigned_by: null, assigned_at: null });
        }
      }
      if (quiere('due_at')) patch['due_at'] = b.due_at ?? null;
      if (quiere('discard_reason')) {
        const reason = (b.discard_reason ?? '').trim();
        if (!reason) throw new BadRequestException('Descartar exige el motivo.');
        // ⛔ Una contestada no se descarta: escondería una regla que ya rige y que alguien usa.
        if (def.status !== 'pendiente') {
          throw new ConflictException(`La pregunta está ${def.status}: sólo se descarta una pendiente.`);
        }
        Object.assign(patch, { status: 'descartada', discarded_at: trx.fn.now(), discard_reason: reason });
      }
      await trx('platform.business_definitions').where({ id }).update(patch);
      const [vista] = await this.leer(trx, { id });
      return vista;
    });
  }

  /**
   * A quién se le puede asignar una pregunta: personas internas activas. Va aquí y no en el padrón
   * de `/admin/users` para que repartir no exija `USUARIOS_VER`, que es otra facultad.
   */
  async asignables(): Promise<PersonaAsignable[]> {
    return this.tk.run(async (trx) => {
      const filas = await trx('identity.users')
        .whereNull('deleted_at').where({ kind: 'interno' }).whereNot('activo', false)
        .select('id', trx.raw(`COALESCE(NULLIF(btrim(nombre), ''), username) AS nombre`),
          trx.raw('position_code AS puesto'))
        .orderByRaw(`COALESCE(NULLIF(btrim(nombre), ''), username)`);
      return filas as PersonaAsignable[];
    });
  }

  // ── Internos ─────────────────────────────────────────────────────────────────────────

  private requireUser(): string {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) throw new ForbiddenException('Hace falta una sesión con persona.');
    return userId;
  }

  /** La lectura común: preguntas + todas sus respuestas, resueltas con la regla del contrato. */
  private async leer(
    trx: any,
    f: { consumer?: string; assignedTo?: string; id?: string; key?: string; fecha?: string },
  ): Promise<DefinicionVista[]> {
    // El «hoy» sale de la base y en hora de México: `new Date()` es UTC y adelanta el día de noche.
    const { rows: [h] } = await trx.raw(
      `SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS hoy`);
    const fecha = f.fecha ?? h.hoy;

    const q = trx('platform.business_definitions as d')
      .leftJoin('identity.users as u', function (this: any) {
        this.on('u.id', '=', 'd.assigned_to').andOn('u.tenant_id', '=', 'd.tenant_id');
      })
      .whereNull('d.deleted_at')
      .select('d.id', 'd.key', 'd.area', 'd.consumer', 'd.question', 'd.decides', 'd.value_type', 'd.choices',
        'd.unit', 'd.config_route', 'd.suggested_value', 'd.suggested_source', 'd.status', 'd.assigned_to',
        'd.due_at', 'd.answered_at', 'd.discard_reason',
        trx.raw(`COALESCE(NULLIF(btrim(u.nombre), ''), u.username) AS asignado_nombre`))
      .orderByRaw(`CASE d.status WHEN 'pendiente' THEN 0 WHEN 'respondida' THEN 1 ELSE 2 END, d.due_at NULLS LAST, d.key`);
    if (f.consumer) q.where('d.consumer', f.consumer);
    if (f.assignedTo) q.where('d.assigned_to', f.assignedTo);
    if (f.id) q.where('d.id', f.id);
    if (f.key) q.where('d.key', f.key);
    const defs = (await q) as FilaDef[];
    if (!defs.length) return [];

    const resps = (await trx('platform.business_definition_answers')
      .whereIn('definition_id', defs.map((d) => d.id))
      .select('id', 'definition_id', 'value', 'answered_by', 'note', 'answered_at',
        trx.raw(`to_char(valid_from, 'YYYY-MM-DD') AS valid_from`))) as FilaResp[];
    const porDef = new Map<string, RespuestaDefinicion[]>();
    for (const r of resps) {
      const lista = porDef.get(r.definition_id) ?? [];
      lista.push({ ...r, answered_at: iso(r.answered_at) as string });
      porDef.set(r.definition_id, lista);
    }

    return defs.map((d) => {
      const propias = porDef.get(d.id) ?? [];
      return {
        id: d.id, key: d.key, area: d.area, consumer: d.consumer, question: d.question, decides: d.decides,
        value_type: d.value_type, choices: d.choices, unit: d.unit, config_route: d.config_route,
        suggested_value: d.suggested_value, suggested_source: d.suggested_source, status: d.status,
        assigned_to: d.assigned_to, due_at: iso(d.due_at), answered_at: iso(d.answered_at),
        discard_reason: d.discard_reason, asignado_nombre: d.asignado_nombre,
        vigente: resolverDefinicion({ id: d.id, status: d.status }, propias, fecha),
        respuestas: propias.length,
      };
    });
  }
}
