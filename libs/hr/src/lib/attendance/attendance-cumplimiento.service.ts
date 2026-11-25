import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import type { HrCumplimientoDto } from '@megadulces/contracts';
import { RE_FECHA } from './logic/fechas';

/** `[RH.15.7]` Días después de la baja en que una huella que sigue en el reloj pasa a «pendiente de quitar». */
export const DIAS_PARA_QUITAR_HUELLA = 7;
/** `[RH.15.8]` Lo mínimo que se conservan las checadas después de la baja (LFT 804-III: el último año y uno más). */
export const MESES_CONSERVAR = 12;
/** `[RH.15.0]` Sin checar en estos días, una persona activa se lista: o no vino, o no está registrando su jornada. */
export const DIAS_SIN_REGISTRO = 7;

/** `[RH.15.8]` La fecha hasta la que se conservan las checadas: la baja + `MESES_CONSERVAR`. */
export function conservarHasta(bajaYmd: string): string {
  const d = new Date(`${bajaYmd}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + MESES_CONSERVAR);
  return d.toISOString().slice(0, 10);
}

/**
 * Fase RH · `[RH.15.0]` `[RH.15.7]` `[RH.15.8]` — Cumplimiento de una plaza: lo que la ley pide y hoy no
 * se veía en ningún lado.
 *
 *  · `[RH.15.7]` Huellas de personas dadas de baja que el reloj todavía tiene. Sólo se AVISA: quitarlas del reloj es una
 *    orden a un equipo de producción y la aprueba Edgar. Nada se borra desde aquí.
 *  · `[RH.15.8]` Hasta cuándo se conservan sus checadas: la baja + 1 año (LFT 804-III). Informativo: nada se borra solo.
 *  · `[RH.15.0]` Personas activas que no checaron en una semana: la ley pide registrar la jornada de CADA trabajador.
 *    Sin la nómina no se distingue a quien no vino de quien trabaja sin checar (ruta, chofer): se lista y RH decide.
 *
 * ⚠️ La fecha de baja es la última actualización de su ficha inactiva en la plaza (`person_site_profiles.updated_at`):
 * si alguien edita esa ficha después, la fecha se corre. Se dice así en pantalla.
 *
 * `[RH.15.6]` El aviso de privacidad por la huella NO vive aquí (2026-11-23): cuando Legal entregue el texto, se extiende
 * el registro de avisos que ya existe en Mesa de Servicio (`servicedesk.privacy_notices` / `privacy_acceptances`) en vez
 * de abrir un segundo registro.
 */
@Injectable()
export class HrAttendanceCumplimientoService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async estado(q: { site_code?: string; hoy?: string }): Promise<HrCumplimientoDto> {
    const site = String(q.site_code || '').trim();
    if (!site) throw new BadRequestException('Falta site_code.');
    const hoy = RE_FECHA.test(String(q.hoy || '')) ? String(q.hoy) : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());

    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      if (!(await trx('hr.attendance_sites').where({ code: site }).first('code'))) throw new NotFoundException(`No existe la plaza «${site}».`);

      // Las personas de la plaza, con su nombre, si el reloj las tiene y cuándo checaron por última vez.
      const { rows } = await trx.raw<{ rows: Array<{ codigo: string; nombre: string | null; activo: boolean; baja: string | null;
        en_reloj: boolean; ultima: string | null }> }>(`
        SELECT p.person_code AS codigo,
               COALESCE(max(u.nombre), max(e.device_name)) AS nombre,
               p.is_active AS activo,
               CASE WHEN p.is_active THEN NULL ELSE to_char(p.updated_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') END AS baja,
               bool_or(coalesce(e.is_present, false)) AS en_reloj,
               (SELECT max(v.work_date) FROM hr.v_site_punches v WHERE v.site_code = p.site_code AND v.person_code = p.person_code) AS ultima
          FROM hr.person_site_profiles p
          LEFT JOIN hr.device_enrollments e
            ON e.tenant_id = p.tenant_id AND COALESCE(e.person_code, e.device_user_id) = p.person_code
           AND e.device_id IN (SELECT d.id FROM hr.attendance_devices d WHERE d.site_code = p.site_code)
          LEFT JOIN identity.users u ON u.tenant_id = e.tenant_id AND u.id = e.user_id
         WHERE p.site_code = ?
         GROUP BY p.site_code, p.person_code, p.is_active, p.updated_at
         ORDER BY 2 NULLS LAST, 1`, [site]);

      const nombre = (r: { codigo: string; nombre: string | null }) => r.nombre || `Persona ${r.codigo}`;
      const diasDesde = (ymd: string) => Math.floor((Date.parse(`${hoy}T00:00:00Z`) - Date.parse(`${ymd}T00:00:00Z`)) / 86_400_000);
      const activos = rows.filter((r) => r.activo);
      const bajas = rows.filter((r) => !r.activo && r.baja);

      return {
        site_code: site, hoy,
        huellasDeBajas: bajas.filter((r) => r.en_reloj).map((r) => ({
          codigo: r.codigo, nombre: nombre(r), baja: r.baja!, dias: diasDesde(r.baja!), pendiente: diasDesde(r.baja!) >= DIAS_PARA_QUITAR_HUELLA,
        })),
        conservar: bajas.map((r) => ({ codigo: r.codigo, nombre: nombre(r), baja: r.baja!, hasta: conservarHasta(r.baja!) }))
          .sort((a, b) => a.hasta.localeCompare(b.hasta)),
        sinRegistro: activos.filter((r) => !r.ultima || diasDesde(r.ultima) >= DIAS_SIN_REGISTRO)
          .map((r) => ({ codigo: r.codigo, nombre: nombre(r), ultima: r.ultima })),
      };
    });
  }
}
