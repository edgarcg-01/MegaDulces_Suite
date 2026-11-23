import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import type { HrRegistroLegalDto, HrRegistroLegalFila } from '@megadulces/contracts';
import { RE_FECHA } from './logic/fechas';

/** Un año de conservación después de la baja (LFT 804-III) y margen: el periodo más largo que se pide de una vez. */
export const TOPE_DIAS_REGISTRO = 400;

const METODO: Record<number, string> = { 0: 'contraseña', 1: 'huella', 2: 'contraseña', 3: 'tarjeta', 4: 'tarjeta', 15: 'rostro' };
const TIPO: Record<number, string> = { 0: 'entrada', 1: 'salida', 2: 'sale a comer', 3: 'regresa de comer', 4: 'entra extra', 5: 'sale extra' };

/** Una celda de CSV: entre comillas si trae coma, comilla o salto. */
function celda(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * `[RH.15.9]` El CSV del registro y su huella. La huella es sha256 de las líneas de datos (encabezado incluido), y
 * va al final como comentario: quien recibe el archivo puede recalcularla sobre esas líneas y comprobar que no se
 * tocó. Pura: la prueba la ejercita sin base.
 */
export function csvDelRegistro(meta: { plaza: string; persona: string; desde: string; hasta: string; generado: string }, filas: HrRegistroLegalFila[]): { csv: string; sha256: string } {
  const lineas = [
    ['fecha', 'hora', 'instante_utc', 'reloj', 'metodo', 'tipo', 'origen', 'desfase_reloj_s'].join(','),
    ...filas.map((f) => [f.fecha, f.hora, f.instante, f.reloj, f.metodo, f.tipo, f.origen, f.desfase_s].map(celda).join(',')),
  ];
  const datos = lineas.join('\n') + '\n';
  const sha256 = createHash('sha256').update(datos, 'utf8').digest('hex');
  const cabeza = [
    `# Registro electrónico de la jornada (LFT art. 132 fr. XXXIV) · plaza ${meta.plaza} · persona ${meta.persona}`,
    `# Periodo ${meta.desde} a ${meta.hasta} · generado ${meta.generado} (hora de México) · ${filas.length} checadas tal como las entregó el reloj`,
  ];
  return { csv: `${cabeza.join('\n')}\n${datos}# sha256 de las líneas de datos: ${sha256}\n`, sha256 };
}

/**
 * Fase RH · `[RH.15.9]` — El registro de una persona para entregarlo a la autoridad (LFT 132-XXXIV: «entregar el
 * registro cuando la autoridad lo requiera»; 804-III: conservar y exhibir los controles de asistencia).
 *
 * Son las checadas TAL COMO LAS ENTREGÓ EL RELOJ (no las horas calculadas): hora, instante, reloj, método (huella,
 * rostro…), tipo, origen y el desfase del reloj al entregarlas. Por plaza y código: quien rota se exporta plaza por
 * plaza (el código es de la plaza). ⚠️ El formato oficial lo dirá la STPS (se espera para diciembre de 2026): este
 * CSV trae todo lo que hoy se sabe que piden y se ajusta cuando salga.
 */
@Injectable()
export class HrAttendanceRegistroService {
  constructor(private readonly tk: TenantKnexService, private readonly tenantCtx: TenantContextService) {}

  async registro(q: { site_code?: string; person_code?: string; date_from?: string; date_to?: string }): Promise<HrRegistroLegalDto> {
    const site = String(q.site_code || '').trim();
    const persona = String(q.person_code || '').trim();
    const desde = String(q.date_from || ''), hasta = String(q.date_to || '');
    if (!site || !persona || !RE_FECHA.test(desde) || !RE_FECHA.test(hasta)) {
      throw new BadRequestException('Faltan site_code, person_code, date_from y date_to (yyyy-MM-dd).');
    }
    if (hasta < desde) throw new BadRequestException('La fecha final es anterior a la inicial.');
    const dias = Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000);
    if (dias > TOPE_DIAS_REGISTRO) throw new BadRequestException(`El periodo es de más de ${TOPE_DIAS_REGISTRO} días: pídelo en dos partes.`);

    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const plaza = await trx('hr.attendance_sites').where({ code: site }).first<{ name: string } | undefined>('name');
      if (!plaza) throw new NotFoundException(`No existe la plaza «${site}».`);
      // Directo de la tabla (no de la vista que oculta lo ignorado): a la autoridad se le entrega todo lo que checó.
      const { rows } = await trx.raw<{ rows: Array<{ fecha: string; hora: string; instante: string; reloj: string; verify_mode: number | null;
        punch_type: number | null; source: string | null; desfase: number | null; nombre: string | null }> }>(`
        SELECT to_char(l.punched_local, 'YYYY-MM-DD') AS fecha, to_char(l.punched_local, 'HH24:MI:SS') AS hora,
               to_char(l.punched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS instante,
               d.serial_number || coalesce(' · ' || d.label, '') AS reloj, l.verify_mode, l.punch_type, l.source,
               ${await this.columnaDesfase(trx)} AS desfase, e.device_name AS nombre
          FROM hr.attendance_logs l
          JOIN hr.attendance_devices d ON d.tenant_id = l.tenant_id AND d.id = l.device_id
          LEFT JOIN hr.device_enrollments e ON e.tenant_id = l.tenant_id AND e.device_id = l.device_id AND e.device_user_id = l.device_user_id
         WHERE d.site_code = ? AND COALESCE(e.person_code, l.device_user_id) = ?
           AND l.punched_local >= ?::date AND l.punched_local < (?::date + 1)
         ORDER BY l.punched_local, d.serial_number`, [site, persona, desde, hasta]);
      const filas: HrRegistroLegalFila[] = rows.map((r) => ({
        fecha: r.fecha, hora: r.hora, instante: r.instante, reloj: r.reloj,
        metodo: r.verify_mode == null ? '' : (METODO[r.verify_mode] ?? `código ${r.verify_mode}`),
        tipo: r.punch_type == null ? '' : (TIPO[r.punch_type] ?? `código ${r.punch_type}`),
        origen: r.source ?? '', desfase_s: r.desfase,
      }));
      const generado = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Mexico_City', dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
      const nombre = rows.find((r) => r.nombre)?.nombre ?? null;
      const { csv, sha256 } = csvDelRegistro({ plaza: plaza.name, persona: nombre ? `${persona} (${nombre})` : persona, desde, hasta, generado }, filas);
      return { site_code: site, person_code: persona, persona_nombre: nombre, date_from: desde, date_to: hasta, generado, filas: filas.length, csv, sha256 };
    });
  }

  /** `clock_drift_seconds` existe desde `[RH.15.4]`; si la migración no está, se dice vacío (no medido), no 0. */
  private async columnaDesfase(trx: import('knex').Knex.Transaction): Promise<string> {
    const hay = (await trx.raw(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'hr'
      AND table_name = 'attendance_logs' AND column_name = 'clock_drift_seconds') AS hay`)).rows[0]?.hay;
    return hay ? 'l.clock_drift_seconds' : 'NULL::int';
  }
}
