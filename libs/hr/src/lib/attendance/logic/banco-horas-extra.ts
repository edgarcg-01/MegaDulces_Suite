import type {
  HrAjusteHorasExtraDto, HrBancoHorasExtraDto, HrDiaHorasExtraDto, HrPersonaHorasExtraDto, HrUsoHorasExtraDto,
} from '@megadulces/contracts';
import { EXTRA_BLOQUE_MIN, type AsistenciaPersonas } from './asistencia-persona';
import { diasEntre } from './fechas';

/**
 * Fase RH · `[RH.1.10]` — BANCO DE HORAS EXTRA. Traslado de `mega-talento-90/api/src/agente-horarios/
 * horas-extra.ts` @ ee4ff38 (08/10/2026). Lógica PURA: recibe el cálculo de asistencia y los ajustes.
 *
 * Lo que cada persona GANA quedándose después de su hora de salida (bloques de 30 min) y lo que USA
 * cuando RH captura «Uso de horas extra». El saldo es ganadas − usadas + ajustes, contado desde
 * `HORAS_EXTRA_DESDE`: antes de esa fecha no había banco, y contar meses atrás daría saldos que nadie
 * autorizó. No se guarda: una checada que llega tarde o un «Horario distinto» capturado después
 * corrigen el saldo solos. Lo único guardado son los AJUSTES de RH (`hr.overtime_adjustments`).
 */
export const HORAS_EXTRA_DESDE = process.env['HR_OVERTIME_SINCE'] || '2026-09-24';

/** Un ajuste vigente (no anulado), como lo lee el servicio. */
export interface AjusteLeido {
  id: string;
  personCode: string;
  fecha: string;
  minutos: number;
  motivo: string;
  creadoPor: string;
  creadoEn: string;
}

export function bancoHorasExtra(p: {
  siteCode: string; desde: string; hasta: string; codigo?: string;
  asistencia: AsistenciaPersonas | null; ajustes: AjusteLeido[];
}): HrBancoHorasExtraDto {
  const { siteCode, desde, hasta, codigo } = p;
  const vacio: HrBancoHorasExtraDto = { sucursalId: siteCode, desde, hasta, bloqueMin: EXTRA_BLOQUE_MIN, sinHorarioFijo: 0, personas: [] };
  if (hasta < desde || !p.asistencia) return vacio;

  const porCodigo = new Map<string, HrAjusteHorasExtraDto[]>();
  for (const a of p.ajustes) {
    if (a.fecha > hasta) continue;
    if (!porCodigo.has(a.personCode)) porCodigo.set(a.personCode, []);
    (porCodigo.get(a.personCode) as HrAjusteHorasExtraDto[]).push({
      id: a.id, fecha: a.fecha, minutos: a.minutos, motivo: a.motivo, creadoPor: a.creadoPor, creadoEn: a.creadoEn,
    });
  }

  const personas: HrPersonaHorasExtraDto[] = [];
  let sinHorarioFijo = 0;
  for (const per of p.asistencia.personas) {
    if (!codigo && !per.horasExtraSegun && per.registrado) sinHorarioFijo++;
    if (codigo && per.codigo !== codigo) continue;
    const ganadas: HrDiaHorasExtraDto[] = [];
    for (const s of per.semanas) for (const d of s.dias) {
      if (d.extraMin) {
        ganadas.push({ fecha: d.fecha, entrada: d.entrada ?? null, salida: d.salida ?? null, salidaEsperada: d.salidaEsperada ?? null, extraMin: d.extraMin });
      }
    }
    // El uso sale de las incidencias, no de los días armados: quien usó horas un día que no checó
    // también las gastó.
    const usos: HrUsoHorasExtraDto[] = per.incidencias
      .filter((i) => i.tipo === 'horas_extra' && Number(i.minutos) > 0)
      .map((i) => {
        const ini = i.desde > desde ? i.desde : desde;
        const fin = i.hasta < hasta ? i.hasta : hasta;
        const dias = fin >= ini ? diasEntre(ini, fin) : 0;
        return { id: i.id, desde: i.desde, hasta: i.hasta, minutos: Number(i.minutos), dias, totalMin: dias * Number(i.minutos), nota: i.nota || '' };
      })
      .filter((u) => u.dias > 0);
    const ganadasMin = ganadas.reduce((t, x) => t + x.extraMin, 0);
    const usadasMin = usos.reduce((t, x) => t + x.totalMin, 0);
    const susAjustes = porCodigo.get(per.codigo) || [];
    const ajustesMin = susAjustes.reduce((t, x) => t + x.minutos, 0);
    if (!per.horasExtraSegun && !ganadasMin && !usadasMin && !susAjustes.length) continue;
    personas.push({
      codigo: per.codigo, nombreCompleto: per.nombreCompleto, departamento: per.departamento,
      segun: per.horasExtraSegun, salida: per.salida,
      ganadasMin, usadasMin, ajustesMin, saldoMin: ganadasMin - usadasMin + ajustesMin,
      ganadas, usos, ajustes: susAjustes,
    });
  }
  personas.sort((x, y) => y.saldoMin - x.saldoMin || x.nombreCompleto.localeCompare(y.nombreCompleto, 'es'));
  return { ...vacio, sinHorarioFijo, personas };
}

/** Valida un ajuste antes de escribirlo; devuelve el error en palabras de RH o null. */
export function errorDeAjuste(a: { site_code?: unknown; person_code?: unknown; minutes?: unknown; reason?: unknown; effective_date?: unknown }): string | null {
  if (!String(a.site_code ?? '').trim() || !String(a.person_code ?? '').trim()) return 'Faltan el sitio y la persona.';
  const m = Math.round(Number(a.minutes));
  if (!Number.isFinite(m) || m === 0 || Math.abs(m) > 100000) return 'Indica cuántas horas suma o resta (distinto de cero).';
  if (String(a.reason ?? '').trim().length < 5) return 'Escribe el motivo del ajuste (por ejemplo, "saldo que traía al 23 de septiembre").';
  if (a.effective_date != null && a.effective_date !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(a.effective_date))) return 'La fecha debe venir como yyyy-MM-dd.';
  return null;
}
