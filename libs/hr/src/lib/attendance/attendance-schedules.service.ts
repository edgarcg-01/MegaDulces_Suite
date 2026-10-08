import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import * as reader from './attendance-reader';

/**
 * Fase RH · `[RH.1.5]` — los HORARIOS: el de cada sitio (`hr.work_schedules`, antes
 * `horarios_sucursal`) y el que RH le asigna a una persona (`hr.person_schedules`, antes
 * `horarios_confirmados`).
 *
 * El de la persona MANDA sobre cualquier deducción: hay quien llega 8 minutos antes todos los
 * días y no es retardo, y eso no lo revela el dato, lo tiene que decir RH. Se le pone a una
 * persona o a varias de un jalón (un departamento entero) y luego se ajusta una por una; quitarlo
 * la regresa al horario deducido de sus checadas.
 *
 * Las validaciones son las de `router.ts::errorDeHorario` de Mega Talento, con el mismo texto.
 */

const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const aMin = (h: string): number => { const [a, b] = h.split(':').map(Number); return a * 60 + b; };

export interface HorarioPersonaDto {
  site_code?: string;
  person_codes?: unknown;
  starts_at?: string;
  ends_at?: string;
  lunch_minutes?: unknown;
  works_saturday?: boolean;
  saturday_starts_at?: string;
  saturday_ends_at?: string;
}

/** Devuelve el error en palabras de RH, o null si el horario está bien. */
export function errorDeHorario(b: HorarioPersonaDto): string | null {
  if (!RE_HORA.test(String(b.starts_at || '')) || !RE_HORA.test(String(b.ends_at || ''))) {
    return 'La entrada y la salida deben venir como HH:MM (por ejemplo 08:00 y 18:00).';
  }
  const ent = aMin(String(b.starts_at)), sal = aMin(String(b.ends_at));
  if (sal <= ent) return 'La salida tiene que ser después de la entrada.';
  const com = Number(b.lunch_minutes);
  if (!Number.isInteger(com) || com < 0 || com > 180) return 'La comida va de 0 a 180 minutos.';
  if (sal - ent - com < 60) return 'Con esa comida no le queda ni una hora de trabajo: revisa las horas.';
  if (b.works_saturday) {
    if (!RE_HORA.test(String(b.saturday_starts_at || '')) || !RE_HORA.test(String(b.saturday_ends_at || ''))) {
      return 'El sábado necesita su hora de entrada y de salida.';
    }
    if (aMin(String(b.saturday_ends_at)) <= aMin(String(b.saturday_starts_at))) return 'La salida del sábado tiene que ser después de su entrada.';
  }
  return null;
}

export interface HorarioSitioDto {
  site_code?: string;
  name?: string;
  weekdays?: unknown;
  starts_at?: string;
  ends_at?: string;
  lunch_starts_at?: string | null;
  lunch_ends_at?: string | null;
  tolerance_minutes?: unknown;
  is_active?: boolean;
}

function validarHorarioSitio(h: HorarioSitioDto): Record<string, unknown> {
  const nombre = String(h.name || '').trim();
  if (!h.site_code || !nombre) throw new BadRequestException('Faltan el sitio y el nombre del horario.');
  if (!RE_HORA.test(String(h.starts_at || '')) || !RE_HORA.test(String(h.ends_at || ''))) {
    throw new BadRequestException('La entrada y la salida deben venir como HH:MM.');
  }
  const dias = Array.isArray(h.weekdays) ? [...new Set(h.weekdays.map(Number))] : [];
  if (dias.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new BadRequestException('Los días van de 0 (domingo) a 6 (sábado).');
  const ci = h.lunch_starts_at || null, cf = h.lunch_ends_at || null;
  if ((ci === null) !== (cf === null)) throw new BadRequestException('La comida lleva hora de inicio y de fin, o ninguna.');
  if (ci && cf && (!RE_HORA.test(ci) || !RE_HORA.test(cf))) throw new BadRequestException('La comida debe venir como HH:MM.');
  const tol = Number(h.tolerance_minutes ?? 0);
  if (!Number.isInteger(tol) || tol < 0 || tol > 120) throw new BadRequestException('La tolerancia va de 0 a 120 minutos.');
  return {
    site_code: h.site_code, name: nombre, weekdays: dias.sort(), starts_at: h.starts_at, ends_at: h.ends_at,
    lunch_starts_at: ci, lunch_ends_at: cf, tolerance_minutes: tol, is_active: h.is_active !== false,
  };
}

@Injectable()
export class HrAttendanceSchedulesService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private quien(): { id: string | null; nombre: string | null } {
    const c = this.tenantCtx.get();
    return { id: c?.userId ?? null, nombre: c?.username ?? null };
  }

  async horariosDeSitio(siteCode: string): Promise<unknown[]> {
    if (!siteCode) throw new BadRequestException('Falta site_code.');
    return this.tk.run(this.tenantCtx.requireTenantId(), (trx) => reader.horariosDelSitio(trx, siteCode));
  }

  async crearHorarioDeSitio(h: HorarioSitioDto): Promise<unknown> {
    const v = validarHorarioSitio(h);
    const q = this.quien();
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      if (!(await reader.sitioExiste(trx, String(v['site_code'])))) throw new NotFoundException(`No existe el sitio de checado "${v['site_code']}".`);
      const [r] = await trx('hr.work_schedules')
        .insert({ ...v, tenant_id: this.tenantCtx.requireTenantId(), created_by: q.id, updated_by: q.id }).returning('id');
      return { id: typeof r === 'object' ? (r as { id: string }).id : r, ...v };
    });
  }

  async actualizarHorarioDeSitio(id: string, h: HorarioSitioDto): Promise<unknown> {
    const v = validarHorarioSitio(h);
    const q = this.quien();
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const n = await trx('hr.work_schedules').where({ id }).update({ ...v, updated_by: q.id, updated_at: trx.fn.now() });
      if (!n) throw new NotFoundException('Horario no encontrado.');
      return { id, ...v };
    });
  }

  /**
   * Mega Talento lo BORRABA. Aquí se desactiva: un horario de sitio puede estar referido por el
   * horario de una persona, y borrarlo le cambiaría en silencio contra qué se mide.
   */
  async desactivarHorarioDeSitio(id: string): Promise<{ ok: true }> {
    const q = this.quien();
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const n = await trx('hr.work_schedules').where({ id }).update({ is_active: false, updated_by: q.id, updated_at: trx.fn.now() });
      if (!n) throw new NotFoundException('Horario no encontrado.');
      return { ok: true as const };
    });
  }

  /** Le pone (o cambia) su horario completo a una o varias personas del sitio. */
  async asignar(b: HorarioPersonaDto): Promise<{ ok: true; guardados: number }> {
    const site = String(b.site_code || '').trim();
    const codigos = Array.isArray(b.person_codes)
      ? [...new Set(b.person_codes.map((c) => String(c).trim()).filter(Boolean))] : [];
    if (!site || !codigos.length) throw new BadRequestException('Faltan el sitio y a quién se le pone el horario.');
    if (codigos.length > 500) throw new BadRequestException('Son demasiadas personas de una vez.');
    const err = errorDeHorario(b);
    if (err) throw new BadRequestException(err);
    const q = this.quien();
    const sabado = !!b.works_saturday;
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      if (!(await reader.sitioExiste(trx, site))) throw new NotFoundException(`No existe el sitio de checado "${site}".`);
      const filas = codigos.map((c) => ({
        tenant_id: this.tenantCtx.requireTenantId(), site_code: site, person_code: c,
        shift_starts: trx.raw('ARRAY[?::time]', [String(b.starts_at)]),
        ends_at: b.ends_at, lunch_minutes: Number(b.lunch_minutes), works_saturday: sabado,
        saturday_starts_at: sabado ? b.saturday_starts_at : null, saturday_ends_at: sabado ? b.saturday_ends_at : null,
        note: 'Horario asignado desde la Suite', confirmed_by: q.id, confirmed_by_name: q.nombre,
      }));
      const r = await trx('hr.person_schedules').insert(filas)
        .onConflict(['tenant_id', 'site_code', 'person_code'])
        .merge(Object.fromEntries([
          ...['shift_starts', 'ends_at', 'lunch_minutes', 'works_saturday', 'saturday_starts_at',
            'saturday_ends_at', 'note', 'confirmed_by', 'confirmed_by_name'].map((c) => [c, trx.raw(`EXCLUDED.${c}`)]),
          ['updated_at', trx.fn.now()],
        ]))
        .returning('id');
      return { ok: true as const, guardados: r.length };
    });
  }

  /** La persona vuelve a medirse con el horario deducido de sus checadas. */
  async quitar(b: { site_code?: string; person_codes?: unknown }): Promise<{ ok: true; quitados: number }> {
    const site = String(b.site_code || '').trim();
    const codigos = Array.isArray(b.person_codes) ? b.person_codes.map((c) => String(c).trim()).filter(Boolean) : [];
    if (!site || !codigos.length) throw new BadRequestException('Faltan el sitio y a quién se le quita el horario.');
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const n = await trx('hr.person_schedules').where({ site_code: site }).whereIn('person_code', codigos).del();
      return { ok: true as const, quitados: n };
    });
  }
}
