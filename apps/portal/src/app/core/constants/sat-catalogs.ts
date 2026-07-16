/**
 * Catálogos SAT (subconjunto) para el form de facturación self-service del portal.
 * c_RegimenFiscal + c_UsoCFDI (CFDI 4.0). Duplicado compacto: el portal es una app
 * Nx separada de `view`; no comparte su constants. Etiqueta lista para dropdown.
 */

export interface SatCatItem { code: string; label: string; display: string; }

function cat(entries: Array<[string, string]>): SatCatItem[] {
  return entries.map(([code, label]) => ({ code, label, display: `${code} — ${label}` }));
}

export const SAT_REGIMENES: SatCatItem[] = cat([
  ['601', 'General de Ley Personas Morales'],
  ['603', 'Personas Morales con Fines no Lucrativos'],
  ['605', 'Sueldos y Salarios e Ingresos Asimilados'],
  ['606', 'Arrendamiento'],
  ['607', 'Régimen de Enajenación o Adquisición de Bienes'],
  ['608', 'Demás ingresos'],
  ['610', 'Residentes en el Extranjero sin Establecimiento Permanente'],
  ['611', 'Ingresos por Dividendos'],
  ['612', 'Personas Físicas con Actividades Empresariales y Profesionales'],
  ['614', 'Ingresos por intereses'],
  ['615', 'Ingresos por obtención de premios'],
  ['616', 'Sin obligaciones fiscales'],
  ['620', 'Sociedades Cooperativas de Producción'],
  ['621', 'Incorporación Fiscal'],
  ['622', 'Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras'],
  ['623', 'Opcional para Grupos de Sociedades'],
  ['624', 'Coordinados'],
  ['625', 'Actividades con ingresos por Plataformas Tecnológicas'],
  ['626', 'Régimen Simplificado de Confianza (RESICO)'],
]);

export const SAT_USOS_CFDI: SatCatItem[] = cat([
  ['G01', 'Adquisición de mercancías'],
  ['G02', 'Devoluciones, descuentos o bonificaciones'],
  ['G03', 'Gastos en general'],
  ['I01', 'Construcciones'],
  ['I02', 'Mobiliario y equipo de oficina por inversiones'],
  ['I03', 'Equipo de transporte'],
  ['I04', 'Equipo de cómputo y accesorios'],
  ['I08', 'Otra maquinaria y equipo'],
  ['D01', 'Honorarios médicos, dentales y gastos hospitalarios'],
  ['D10', 'Pagos por servicios educativos (colegiaturas)'],
  ['S01', 'Sin efectos fiscales'],
  ['CP01', 'Pagos'],
]);
