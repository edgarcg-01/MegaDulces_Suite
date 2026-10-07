/**
 * Catálogos SAT para CFDI 4.0 (subconjunto usado en la UI).
 * Fuente: catálogos oficiales c_RegimenFiscal y c_UsoCFDI del SAT.
 * Reusable por el form de cliente (datos fiscales) y el tab Facturar.
 */

export interface SatCatItem {
  code: string;
  label: string;
  /** Etiqueta lista para dropdown: "601 — General de Ley Personas Morales". */
  display: string;
}

function cat(entries: Array<[string, string]>): SatCatItem[] {
  return entries.map(([code, label]) => ({ code, label, display: `${code} — ${label}` }));
}

/** c_RegimenFiscal — régimen fiscal del receptor/emisor. */
export const SAT_REGIMENES: SatCatItem[] = cat([
  ['601', 'General de Ley Personas Morales'],
  ['603', 'Personas Morales con Fines no Lucrativos'],
  ['605', 'Sueldos y Salarios e Ingresos Asimilados a Salarios'],
  ['606', 'Arrendamiento'],
  ['607', 'Régimen de Enajenación o Adquisición de Bienes'],
  ['608', 'Demás ingresos'],
  ['610', 'Residentes en el Extranjero sin Establecimiento Permanente en México'],
  ['611', 'Ingresos por Dividendos (socios y accionistas)'],
  ['612', 'Personas Físicas con Actividades Empresariales y Profesionales'],
  ['614', 'Ingresos por intereses'],
  ['615', 'Régimen de los ingresos por obtención de premios'],
  ['616', 'Sin obligaciones fiscales'],
  ['620', 'Sociedades Cooperativas de Producción que optan por diferir sus ingresos'],
  ['621', 'Incorporación Fiscal'],
  ['622', 'Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras'],
  ['623', 'Opcional para Grupos de Sociedades'],
  ['624', 'Coordinados'],
  ['625', 'Actividades Empresariales con ingresos a través de Plataformas Tecnológicas'],
  ['626', 'Régimen Simplificado de Confianza (RESICO)'],
]);

/** c_UsoCFDI — uso del CFDI declarado por el receptor (CFDI 4.0). */
export const SAT_USOS_CFDI: SatCatItem[] = cat([
  ['G01', 'Adquisición de mercancías'],
  ['G02', 'Devoluciones, descuentos o bonificaciones'],
  ['G03', 'Gastos en general'],
  ['I01', 'Construcciones'],
  ['I02', 'Mobiliario y equipo de oficina por inversiones'],
  ['I03', 'Equipo de transporte'],
  ['I04', 'Equipo de cómputo y accesorios'],
  ['I05', 'Dados, troqueles, moldes, matrices y herramental'],
  ['I06', 'Comunicaciones telefónicas'],
  ['I07', 'Comunicaciones satelitales'],
  ['I08', 'Otra maquinaria y equipo'],
  ['D01', 'Honorarios médicos, dentales y gastos hospitalarios'],
  ['D02', 'Gastos médicos por incapacidad o discapacidad'],
  ['D03', 'Gastos funerales'],
  ['D04', 'Donativos'],
  ['D05', 'Intereses reales pagados por créditos hipotecarios'],
  ['D06', 'Aportaciones voluntarias al SAR'],
  ['D07', 'Primas por seguros de gastos médicos'],
  ['D08', 'Gastos de transportación escolar obligatoria'],
  ['D09', 'Depósitos en cuentas para el ahorro / planes de pensiones'],
  ['D10', 'Pagos por servicios educativos (colegiaturas)'],
  ['S01', 'Sin efectos fiscales'],
  ['CP01', 'Pagos'],
  ['CN01', 'Nómina'],
]);
