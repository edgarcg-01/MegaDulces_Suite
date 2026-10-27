import { BadRequestException } from '@nestjs/common';
import {
  avisosDeUnidad, depreciacionAnual, GRUPO_RUBRO_LABEL, porKm, repartir, RUBROS_COSTO_UNIDAD,
  type AvisoUnidad, type FichaUnidad, type KmDeUnidad, type LineaGastoFlota, type MetodoReparto, type PeriodoCosto,
  type RenglonRubro, type RubroCodigo, type UnidadCosto,
} from '@megadulces/contracts';

/**
 * `[FCU.1]` Cómo se arma el costo de una unidad en un periodo. Funciones puras: el servicio lee la
 * base y les pasa los datos; aquí no hay SQL.
 */

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const DIA_MS = 86400000;
const redondea = (n: number) => Math.round(n * 100) / 100;
const pesos = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Hoy en hora de México (YYYY-MM-DD). */
export function hoyMx(ahora = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ahora);
}

/** El periodo pedido, validado. Sin fechas: del 1 del mes en curso a hoy. Máximo 366 días. */
export function periodoDe(desde: string | undefined, hasta: string | undefined, hoy: string): PeriodoCosto {
  const d = desde || `${hoy.slice(0, 8)}01`;
  const h = hasta || hoy;
  if (!FECHA.test(d) || !FECHA.test(h)) throw new BadRequestException('Las fechas van como AAAA-MM-DD.');
  if (d > h) throw new BadRequestException('«Desde» no puede ser después de «hasta».');
  const dias = Math.round((Date.parse(`${h}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / DIA_MS) + 1;
  if (dias > 366) throw new BadRequestException('El periodo es de máximo un año.');
  return { desde: d, hasta: h, dias };
}

const diasDelAnio = (anio: number) => ((anio % 4 === 0 && anio % 100 !== 0) || anio % 400 === 0 ? 366 : 365);
const diasDelMes = (ym: string) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
const traslape = (a1: string, a2: string, b1: string, b2: string) => {
  const ini = a1 > b1 ? a1 : b1;
  const fin = a2 < b2 ? a2 : b2;
  return ini > fin ? 0 : Math.round((Date.parse(`${fin}T00:00:00Z`) - Date.parse(`${ini}T00:00:00Z`)) / DIA_MS) + 1;
};

/** Cuántos días del periodo caen en cada año. */
export function diasPorAnio(p: PeriodoCosto): Array<{ anio: number; dias: number }> {
  const out: Array<{ anio: number; dias: number }> = [];
  for (let a = Number(p.desde.slice(0, 4)); a <= Number(p.hasta.slice(0, 4)); a++) {
    const dias = traslape(p.desde, p.hasta, `${a}-01-01`, `${a}-12-31`);
    if (dias) out.push({ anio: a, dias });
  }
  return out;
}

/** Los meses que toca el periodo, con cuántos de sus días caen dentro. */
export function mesesDelPeriodo(p: PeriodoCosto): Array<{ ym: string; dias: number; diasMes: number }> {
  const out: Array<{ ym: string; dias: number; diasMes: number }> = [];
  let y = Number(p.desde.slice(0, 4));
  let m = Number(p.desde.slice(5, 7));
  for (;;) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    if (ym > p.hasta.slice(0, 7)) break;
    const diasMes = diasDelMes(ym);
    const dias = traslape(p.desde, p.hasta, `${ym}-01`, `${ym}-${String(diasMes).padStart(2, '0')}`);
    if (dias) out.push({ ym, dias, diasMes });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

/** Un monto anual prorrateado a los días del periodo, año por año. */
export function anualAlPeriodo(porAnio: Map<number, number>, p: PeriodoCosto): number | null {
  let total = 0;
  let alguno = false;
  for (const { anio, dias } of diasPorAnio(p)) {
    const a = porAnio.get(anio);
    if (a == null) continue;
    alguno = true;
    total += (a * dias) / diasDelAnio(anio);
  }
  return alguno ? redondea(total) : null;
}

/** Lo que el servicio junta para una unidad. */
export interface DatosUnidad {
  ficha: FichaUnidad;
  /** Renglones de Kepler del periodo que van a esta unidad (confirmados o sugeridos). */
  lineas: Pick<LineaGastoFlota, 'rubro' | 'importe' | 'estado'>[];
  /** Presupuesto anual por rubro y año. */
  presupuesto: Map<RubroCodigo, Map<number, number>>;
  km: KmDeUnidad;
  /** Comisión del chofer por la tarifa de la ruta, de cada guía del periodo (`null` = ruta sin tarifa). */
  comisiones: Array<number | null>;
  /** Lo que le toca del reparto de la nómina administrativa del periodo. `null` = no se pudo repartir. */
  nomina: { sueldos_admin: number | null; gastos_directos: number | null; razon: string } | null;
}

/** El costo de una unidad en el periodo: un renglón por rubro de la hoja, con su procedencia. */
export function armarUnidad(d: DatosUnidad, p: PeriodoCosto, hoy: string, verSalarios: boolean): UnidadCosto {
  const f = d.ficha;
  const rubros: RenglonRubro[] = RUBROS_COSTO_UNIDAD.map((r) => {
    const presAnual = d.presupuesto.get(r.codigo);
    const anioActual = Number(p.hasta.slice(0, 4));
    const base = {
      rubro: r.codigo, etiqueta: r.etiqueta, grupo: r.grupo,
      presupuesto_anual: presAnual?.get(anioActual) ?? null,
      presupuesto: presAnual ? anualAlPeriodo(presAnual, p) : null,
      sugerido: 0, renglones: 0,
    };
    const deKepler = d.lineas.filter((l) => l.rubro === r.codigo);
    const sumaKepler = redondea(deKepler.reduce((a, l) => a + Number(l.importe), 0));
    const sugeridoKepler = redondea(deKepler.filter((l) => l.estado === 'sugerido').reduce((a, l) => a + Number(l.importe), 0));

    switch (r.fuente) {
      case 'kepler':
        return { ...base, real: sumaKepler, procedencia: 'kepler', sugerido: sugeridoKepler, renglones: deKepler.length,
          calculo: deKepler.length
            ? `${deKepler.length} gasto${deKepler.length === 1 ? '' : 's'} de Kepler en el periodo${sugeridoKepler ? ` (${pesos(sugeridoKepler)} sugeridos por el texto, sin confirmar)` : ''}`
            : 'Ningún gasto de Kepler del periodo nombra esta unidad (revisa la bandeja «Gastos sin unidad»)' };
      case 'kepler_o_ficha': {
        const dep = f.ownership === 'propia' ? depreciacionAnual(f) : null;
        const depPeriodo = dep != null ? redondea((dep * p.dias) / 365) : 0;
        if (!deKepler.length && dep == null) {
          // Arrendada sin pagos que la nombren: no es $0 (la renta existe), es que no se pudo atribuir.
          return { ...base, real: null, procedencia: f.ownership === 'arrendada' ? 'sin_medir' : 'sin_dato',
            calculo: f.ownership === 'propia' ? 'Propia: falta valor de compra y vida útil en la ficha para calcular la depreciación'
              : f.ownership === 'arrendada' ? 'Arrendada: ningún pago de renta en Kepler (115) en el periodo nombra esta unidad'
                : 'Falta decir en la ficha si es propia (para su depreciación) o arrendada (su renta en Kepler)' };
        }
        const partes: string[] = [];
        if (deKepler.length) partes.push(`renta en Kepler ${pesos(sumaKepler)}`);
        if (dep != null) partes.push(`depreciación ${pesos(dep)} al año × ${p.dias} días = ${pesos(depPeriodo)}`);
        return { ...base, real: redondea(sumaKepler + depPeriodo), procedencia: deKepler.length ? 'kepler' : 'calculado',
          sugerido: sugeridoKepler, renglones: deKepler.length, calculo: partes.join(' + ') };
      }
      case 'guias': {
        const n = d.comisiones.length;
        const sinTarifa = d.comisiones.filter((c) => c == null).length;
        const suma = redondea(d.comisiones.reduce<number>((a, c) => a + (c ?? 0), 0));
        if (!n) return { ...base, real: 0, procedencia: 'calculado', calculo: 'Sin guías de embarque en el periodo' };
        return { ...base, real: suma, procedencia: 'calculado', renglones: n,
          calculo: `${n} guía${n === 1 ? '' : 's'} × la tarifa de su ruta para el chofer`
            + (sinTarifa ? ` · ${sinTarifa} con ruta sin tarifa (no suman)` : '')
            + ' · sin ayudantes (Kepler no los registra) · por guía, no por viaje (regla pendiente con Logística)' };
      }
      case 'captura': {
        if (r.codigo === 'salarios') {
          if (!verSalarios) return { ...base, presupuesto_anual: null, presupuesto: null, real: null, procedencia: 'restringido', calculo: 'Restringido: sólo quien gestiona Costo por unidad ve salarios' };
          if (f.driver_monthly_salary == null) return { ...base, real: null, procedencia: 'sin_dato', calculo: 'Falta el salario mensual del chofer en la ficha' };
          const real = redondea((Number(f.driver_monthly_salary) * 12 * p.dias) / 365);
          return { ...base, real, procedencia: 'captura', calculo: `${pesos(Number(f.driver_monthly_salary))} al mes (ficha) × ${p.dias} días` };
        }
        const llave = r.codigo === 'sueldos_admin' ? 'sueldos_admin' : 'gastos_directos';
        if (llave === 'sueldos_admin' && !verSalarios) return { ...base, presupuesto_anual: null, presupuesto: null, real: null, procedencia: 'restringido', calculo: 'Restringido: sólo quien gestiona Costo por unidad ve la nómina administrativa' };
        if (!d.nomina) return { ...base, real: null, procedencia: 'sin_dato', calculo: 'Falta capturar la nómina administrativa del periodo' };
        const v = d.nomina[llave];
        return { ...base, real: v, procedencia: v == null ? 'sin_dato' : 'captura', calculo: d.nomina.razon };
      }
    }
  });

  const real = redondea(rubros.reduce((a, r) => a + (r.real ?? 0), 0));
  const presupuestos = rubros.filter((r) => r.presupuesto != null);
  const presupuesto = presupuestos.length ? redondea(presupuestos.reduce((a, r) => a + Number(r.presupuesto), 0)) : null;
  const presupuestoAnual = rubros.reduce((a, r) => a + (r.presupuesto_anual ?? 0), 0);
  const sugerido = redondea(rubros.reduce((a, r) => a + r.sugerido, 0));
  const avisos: AvisoUnidad[] = avisosDeUnidad({
    ficha: f, km: d.km, guias: d.comisiones.length, dias: p.dias, tienePresupuesto: presupuestos.length > 0, sugerido,
  }, hoy);
  return {
    vehicle_id: f.vehicle_id,
    economic_number: f.economic_number,
    nombre: f.display_name || [f.brand, f.model].filter(Boolean).join(' ') || f.plate,
    plate: f.plate,
    fleet_area: f.fleet_area,
    km: d.km,
    guias: d.comisiones.length,
    presupuesto,
    real,
    sugerido,
    // Lo restringido no es «sin dato»: existe, sólo que no se muestra a quien consulta.
    rubros_sin_dato: rubros.filter((r) => r.procedencia === 'sin_dato' || r.procedencia === 'sin_medir').length,
    por_km_real: porKm(real, d.km.km),
    // El $/km de la hoja: su total anual entre sus km por año.
    por_km_presupuesto: presupuestoAnual > 0 ? porKm(presupuestoAnual, f.budget_km_year) : null,
    rubros,
    avisos,
  };
}

/** La etiqueta del grupo, para la pantalla. */
export const grupoLabel = (g: RenglonRubro['grupo']) => GRUPO_RUBRO_LABEL[g];

/**
 * El reparto de la nómina administrativa del periodo, mes por mes: lo capturado del mes, a los días
 * del periodo, repartido entre las unidades por SUS km de ese mes (o en partes iguales).
 */
export function repartoDeNomina(
  meses: Array<{ ym: string; dias: number; diasMes: number }>,
  nomina: Map<string, { sueldos_admin: number; gastos_directos: number; metodo: MetodoReparto }>,
  kmPorMes: Map<string, Map<string, number>>,
  unidades: string[],
): { porUnidad: Map<string, { sueldos_admin: number | null; gastos_directos: number | null; razon: string }>; mesesSinNomina: string[] } {
  const porUnidad = new Map<string, { sueldos_admin: number | null; gastos_directos: number | null; razon: string }>();
  const mesesSinNomina = meses.filter((m) => !nomina.has(m.ym)).map((m) => m.ym);
  const capturados = meses.filter((m) => nomina.has(m.ym));
  if (!capturados.length) return { porUnidad, mesesSinNomina };
  const razones = new Map<string, string[]>();
  for (const id of unidades) { porUnidad.set(id, { sueldos_admin: 0, gastos_directos: 0, razon: '' }); razones.set(id, []); }
  for (const m of capturados) {
    const n = nomina.get(m.ym)!;
    const factor = m.dias / m.diasMes;
    const km = unidades.map((id) => ({ vehicle_id: id, km: kmPorMes.get(m.ym)?.get(id) ?? null }));
    const sueldos = repartir(redondea(n.sueldos_admin * factor), km, n.metodo);
    const directos = repartir(redondea(n.gastos_directos * factor), km, n.metodo);
    for (const id of unidades) {
      const u = porUnidad.get(id)!;
      const s = sueldos.find((x) => x.vehicle_id === id);
      const g = directos.find((x) => x.vehicle_id === id);
      u.sueldos_admin = s?.monto == null || u.sueldos_admin == null ? null : redondea(u.sueldos_admin + s.monto);
      u.gastos_directos = g?.monto == null || u.gastos_directos == null ? null : redondea(u.gastos_directos + g.monto);
      razones.get(id)!.push(`${m.ym}: ${s?.razon ?? '—'}${m.dias < m.diasMes ? ` (${m.dias} de ${m.diasMes} días)` : ''}`);
    }
  }
  for (const id of unidades) {
    const u = porUnidad.get(id)!;
    u.razon = `Nómina administrativa repartida · ${razones.get(id)!.join(' · ')}${mesesSinNomina.length ? ` · sin capturar: ${mesesSinNomina.join(', ')}` : ''}`;
  }
  return { porUnidad, mesesSinNomina };
}
