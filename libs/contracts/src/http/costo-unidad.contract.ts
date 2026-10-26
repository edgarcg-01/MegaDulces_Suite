/**
 * `[FCU]` Costo por unidad — lo que hace la hoja «TRANSPORTES 2026 - COSTOS DE TRANSPORTE», en el
 * sistema. Plan: `docs/IMPLEMENTACION/FASES/FASE_FC_ANEXO_COSTO_POR_UNIDAD_2026-10-26.md`.
 *
 * Regla de la fase (Edgar, 2026-10-26): «TODO DEBE TENER PANTALLA». Cada renglón de la hoja es un
 * rubro de aquí; lo que viene de Kepler se ve hasta su renglón, lo que no existe en ninguna fuente
 * se captura, y lo que todavía no se puede medir se DICE (`sin_dato` / `sin_medir`), nunca $0.
 *
 * Lo que vive aquí es lo que usan el servidor y la pantalla: los rubros con sus conceptos de Kepler,
 * los cortes de la hoja, la reposición, el reparto de la nómina administrativa y los avisos.
 */

/** Cómo agrupa la hoja sus renglones. `fuera_de_hoja` = lo que la hoja no trae y Kepler sí. */
export type GrupoRubro = 'fijos' | 'variables' | 'administrativos' | 'fuera_de_hoja';

export const GRUPO_RUBRO_LABEL: Record<GrupoRubro, string> = {
  fijos: 'Gastos fijos',
  variables: 'Gastos variables',
  administrativos: 'Gastos administrativos',
  fuera_de_hoja: 'No estaban en la hoja',
};

/** De dónde sale el real de un rubro. */
export type FuenteRubro = 'kepler' | 'captura' | 'guias' | 'kepler_o_ficha';

export interface RubroCostoUnidad {
  codigo: RubroCodigo;
  /** Como lo escribe la hoja. */
  etiqueta: string;
  grupo: GrupoRubro;
  /** Conceptos de gasto de Kepler (X-A-10, `kdm6.c12`) que lo forman. */
  conceptos: readonly string[];
  fuente: FuenteRubro;
  /** Qué explica la pantalla cuando alguien pregunta «¿de dónde sale?». */
  de_donde: string;
}

/**
 * Los rubros, en el orden de la hoja. ⚠️ Mismas claves que el CHECK de
 * `logistics.fleet_cost_budget.rubro` (migración `20261026161917_fcu_costo_unidad_esquema.js`).
 * Los conceptos se midieron en el catálogo de Kepler (`analytics.v_kepler_conceptos`) el 2026-10-26.
 */
export const RUBROS_COSTO_UNIDAD = [
  { codigo: 'placas_refrendo_verificacion', etiqueta: 'Placas, refrendo y verificación', grupo: 'fijos', conceptos: ['101', '109', '241', '300'], fuente: 'kepler',
    de_donde: 'Gastos de Kepler: refrendo de placas (101), verificación (109), tenencia (241) y trámite vehicular (300).' },
  { codigo: 'arrendamiento_depreciacion', etiqueta: 'Arrendamiento / depreciación', grupo: 'fijos', conceptos: ['115'], fuente: 'kepler_o_ficha',
    de_donde: 'Arrendada: la renta pagada en Kepler (115). Propia: la depreciación de la ficha (valor de compra − residual, entre la vida útil).' },
  { codigo: 'pension', etiqueta: 'Pensión', grupo: 'fijos', conceptos: ['205'], fuente: 'kepler', de_donde: 'Gastos de Kepler: pensión de vehículo (205).' },
  { codigo: 'gps_magnitracking', etiqueta: 'GPS Magnitracking', grupo: 'fijos', conceptos: ['209'], fuente: 'kepler', de_donde: 'Gastos de Kepler: GPS (209), salvo los de Salvador.' },
  { codigo: 'gps_salvador', etiqueta: 'GPS Salvador', grupo: 'fijos', conceptos: ['209'], fuente: 'kepler', de_donde: 'Gastos de Kepler: GPS (209) cuyo texto o proveedor dice «SALVADOR».' },
  { codigo: 'seguro', etiqueta: 'Seguro del vehículo', grupo: 'fijos', conceptos: ['111'], fuente: 'kepler', de_donde: 'Gastos de Kepler: seguro de vehículos (111), lo pagado en el periodo.' },
  { codigo: 'comisiones', etiqueta: 'Comisiones', grupo: 'fijos', conceptos: [], fuente: 'guias',
    de_donde: 'Las guías de Kepler de esta unidad, a la tarifa de su ruta para el chofer (la misma regla de Pagos de viaje). No incluye ayudantes: Kepler no los registra.' },
  { codigo: 'salarios', etiqueta: 'Salarios', grupo: 'fijos', conceptos: [], fuente: 'captura', de_donde: 'El salario mensual del chofer capturado en la ficha (no está en Kepler).' },
  { codigo: 'mtto_preventivo', etiqueta: 'Servicio y mantenimiento preventivo', grupo: 'variables', conceptos: ['076', '240', '267'], fuente: 'kepler',
    de_donde: 'Gastos de Kepler: servicio de motor (076), mantenimiento vehicular (240) y mantenimiento de motor (267).' },
  { codigo: 'reparaciones', etiqueta: 'Reparaciones generales', grupo: 'variables', conceptos: ['068', '188', '099', '156', '024', '255', '309'], fuente: 'kepler',
    de_donde: 'Gastos de Kepler: reparación de motor (068, 188), eléctrico (099), carrocería (156), suspensión y frenos (024), refacciones (255) y grúa (309).' },
  { codigo: 'neumaticos', etiqueta: 'Neumáticos', grupo: 'variables', conceptos: ['044', '045', '200', '025'], fuente: 'kepler',
    de_donde: 'Gastos de Kepler: llanta nueva (045, 200), parchado (044) y talacha (025).' },
  { codigo: 'lubricantes', etiqueta: 'Lubricantes', grupo: 'variables', conceptos: ['022'], fuente: 'kepler', de_donde: 'Gastos de Kepler: aceites y lubricantes (022).' },
  { codigo: 'gastos_directos', etiqueta: 'Gastos directos', grupo: 'administrativos', conceptos: [], fuente: 'captura',
    de_donde: 'Los gastos directos administrativos del mes, capturados en Nómina administrativa y repartidos entre las unidades.' },
  { codigo: 'sueldos_admin', etiqueta: 'Sueldos administrativos', grupo: 'administrativos', conceptos: [], fuente: 'captura',
    de_donde: 'La nómina administrativa de Logística del mes, capturada y repartida entre las unidades (por km o en partes iguales).' },
  { codigo: 'combustible', etiqueta: 'Combustible', grupo: 'fuera_de_hoja', conceptos: ['038'], fuente: 'kepler', de_donde: 'Gastos de Kepler: combustible logístico (038).' },
  { codigo: 'casetas', etiqueta: 'Casetas', grupo: 'fuera_de_hoja', conceptos: ['122', '123'], fuente: 'kepler', de_donde: 'Gastos de Kepler: casetas de arrastre (122) y de entrega (123).' },
  { codigo: 'multas', etiqueta: 'Multas', grupo: 'fuera_de_hoja', conceptos: ['135'], fuente: 'kepler', de_donde: 'Gastos de Kepler: multa vehículo (135).' },
] as const;

export type RubroCodigo = (typeof RUBROS_COSTO_UNIDAD)[number]['codigo'];

/** Todos los conceptos de Kepler que forman algún rubro (para leer la vista de una sola vez). */
export const CONCEPTOS_DE_FLOTA: readonly string[] = [...new Set(RUBROS_COSTO_UNIDAD.flatMap((r) => [...r.conceptos]))];

/** El rubro de un renglón de Kepler. `null` = el concepto no es de flota. */
export function rubroDeLinea(concepto: string, texto = '', proveedor = ''): RubroCodigo | null {
  const c = String(concepto ?? '').trim();
  if (c === '209') return /SALVADOR/i.test(`${texto} ${proveedor}`) ? 'gps_salvador' : 'gps_magnitracking';
  return RUBROS_COSTO_UNIDAD.find((r) => (r.conceptos as readonly string[]).includes(c))?.codigo ?? null;
}

// ── Los cortes de la hoja ──────────────────────────────────────────────────────────────────

/** Las columnas de la hoja: anual, 6 meses, 4 meses, por mes, «por periodo» (13 al año), por día. */
export type CorteCodigo = 'anual' | 'seis_meses' | 'cuatro_meses' | 'mes' | 'periodo_28' | 'catorcena' | 'dia';

export const CORTES_COSTO_UNIDAD: ReadonlyArray<{ codigo: CorteCodigo; etiqueta: string; porAnio: number }> = [
  { codigo: 'anual', etiqueta: 'Anual', porAnio: 1 },
  { codigo: 'seis_meses', etiqueta: '6 meses', porAnio: 2 },
  { codigo: 'cuatro_meses', etiqueta: '4 meses', porAnio: 3 },
  { codigo: 'mes', etiqueta: 'Por mes', porAnio: 12 },
  { codigo: 'periodo_28', etiqueta: 'Por periodo (28 días)', porAnio: 13 },
  { codigo: 'catorcena', etiqueta: 'Por catorcena', porAnio: 26 },
  { codigo: 'dia', etiqueta: 'Por día', porAnio: 365 },
];

const redondea = (n: number) => Math.round(n * 100) / 100;

/** Un monto ANUAL expresado en el corte (como las columnas de la hoja: anual ÷ 2, ÷ 3, ÷ 12, ÷ 13, ÷ 365). */
export function anualEnCorte(anual: number, corte: CorteCodigo): number {
  const c = CORTES_COSTO_UNIDAD.find((x) => x.codigo === corte);
  if (!c) throw new Error(`corte desconocido: ${corte}`);
  return redondea(anual / c.porAnio);
}

/**
 * Un monto de un RANGO de `dias` llevado al corte (equivalente): así un real de 40 días se compara
 * «por mes» contra el presupuesto por mes. `null` si no hay días.
 */
export function rangoEnCorte(monto: number, dias: number, corte: CorteCodigo): number | null {
  if (!(dias > 0)) return null;
  return anualEnCorte((monto * 365) / dias, corte);
}

/** $/km: `null` cuando no hay km (no se divide entre un supuesto ni entre cero). */
export function porKm(monto: number | null, km: number | null): number | null {
  if (monto == null || km == null || !(km > 0)) return null;
  return redondea(monto / km);
}

// ── Reposición: la tabla lateral de la hoja ───────────────────────────────────────────────

export interface ParametrosReposicion {
  /** Valor de la unidad hoy (o lo que costaría comprarla). */
  valor: number;
  /** Cuánto sube cada año reponerla. La hoja usa 5 %. */
  incremento: number;
  /** Cuánto pierde de valor cada año la unidad. La hoja usa 10 % (le queda el 90 %). */
  depreciacion: number;
  /** Km que recorre al año. */
  km_anio: number;
  anios: number;
}

export interface AnioReposicion {
  anio: number;
  /** Lo que costaría reponerla ese año: valor × (1 + incremento)^(año − 1). */
  valor_reposicion: number;
  /** Lo que vale la unidad ese año: valor × (1 − depreciación)^año. */
  valor_residual: number;
  /** Reposición − residual. */
  perdida_acumulada: number;
  /** Lo que se suma ese año a la pérdida (el año 1, toda). */
  perdida_del_anio: number;
  /** Pérdida del año ÷ km del año. */
  por_km: number | null;
}

/**
 * Reproduce la tabla lateral de la hoja (verificado contra sus cifras: valor $1,650,000, 5 %, km
 * 80,000 → año 1: residual $1,485,000, pérdida $165,000, $2.06/km; año 2: reposición $1,732,500,
 * residual $1,336,500, pérdida del año $231,000, $2.89/km).
 */
export function simularReposicion(p: ParametrosReposicion): AnioReposicion[] {
  const out: AnioReposicion[] = [];
  if (!(p.valor > 0) || !(p.anios > 0)) return out;
  let previa = 0;
  for (let n = 1; n <= Math.min(Math.floor(p.anios), 30); n++) {
    const valor_reposicion = redondea(p.valor * (1 + p.incremento) ** (n - 1));
    const valor_residual = redondea(p.valor * (1 - p.depreciacion) ** n);
    const perdida_acumulada = redondea(valor_reposicion - valor_residual);
    const perdida_del_anio = redondea(perdida_acumulada - previa);
    out.push({ anio: n, valor_reposicion, valor_residual, perdida_acumulada, perdida_del_anio, por_km: porKm(perdida_del_anio, p.km_anio) });
    previa = perdida_acumulada;
  }
  return out;
}

/** Depreciación ANUAL en línea recta de una unidad propia. `null` = falta un dato de la ficha. */
export function depreciacionAnual(f: { purchase_value: number | null; residual_value: number | null; useful_life_years: number | null }): number | null {
  if (f.purchase_value == null || !(Number(f.useful_life_years) > 0)) return null;
  return redondea((Number(f.purchase_value) - Number(f.residual_value ?? 0)) / Number(f.useful_life_years));
}

// ── Reparto de la nómina administrativa ───────────────────────────────────────────────────

export type MetodoReparto = 'km' | 'partes_iguales';

export const METODO_REPARTO_LABEL: Record<MetodoReparto, string> = {
  km: 'Por km recorridos',
  partes_iguales: 'En partes iguales',
};

export interface ParteDeReparto {
  vehicle_id: string;
  /** `null` = no le tocó porque no tiene km con qué repartir (se dice, no se pinta $0). */
  monto: number | null;
  razon: string;
}

/**
 * Reparte un monto entre unidades. Por km: en proporción a sus km; la que no tiene km queda FUERA y
 * se dice. Si ninguna tiene km, nadie recibe nada y todas lo dicen. Partes iguales: entre todas.
 * El último centavo se le ajusta a la de mayor parte, para que la suma cuadre exacta.
 */
export function repartir(total: number, unidades: Array<{ vehicle_id: string; km: number | null }>, metodo: MetodoReparto): ParteDeReparto[] {
  if (!unidades.length) return [];
  if (metodo === 'partes_iguales') {
    const cada = Math.floor((total / unidades.length) * 100) / 100;
    const partes = unidades.map((u) => ({ vehicle_id: u.vehicle_id, monto: cada, razon: `1/${unidades.length} en partes iguales` }));
    partes[0].monto = redondea(partes[0].monto + (total - cada * unidades.length));
    return partes;
  }
  const conKm = unidades.filter((u) => u.km != null && u.km > 0);
  const sumaKm = conKm.reduce((a, u) => a + Number(u.km), 0);
  if (!sumaKm) return unidades.map((u) => ({ vehicle_id: u.vehicle_id, monto: null, razon: 'Ninguna unidad tiene km en el periodo: no hay con qué repartir' }));
  const partes: ParteDeReparto[] = unidades.map((u) => (u.km != null && u.km > 0
    ? { vehicle_id: u.vehicle_id, monto: Math.floor(((total * Number(u.km)) / sumaKm) * 100) / 100, razon: `${Math.round(Number(u.km)).toLocaleString('en-US')} de ${Math.round(sumaKm).toLocaleString('en-US')} km` }
    : { vehicle_id: u.vehicle_id, monto: null, razon: 'Sin km en el periodo (sin GPS ni lectura de odómetro): no entra al reparto' }));
  const repartido = partes.reduce((a, x) => a + (x.monto ?? 0), 0);
  const mayor = partes.filter((x) => x.monto != null).sort((a, b) => Number(b.monto) - Number(a.monto))[0];
  if (mayor) mayor.monto = redondea(Number(mayor.monto) + (total - repartido));
  return partes;
}

// ── Lo que viaja por la API ───────────────────────────────────────────────────────────────

/** De dónde sale una cifra. `sin_dato` = falta capturarla; `sin_medir` = todavía no hay regla. */
export type Procedencia = 'kepler' | 'captura' | 'calculado' | 'sin_dato' | 'sin_medir';

export const PROCEDENCIA_LABEL: Record<Procedencia, string> = {
  kepler: 'Kepler',
  captura: 'Capturado',
  calculado: 'Calculado',
  sin_dato: 'Falta capturar',
  sin_medir: 'Sin medir',
};

export type EstadoLineaFlota = 'confirmado' | 'sugerido' | 'ambiguo' | 'sin_unidad' | 'no_es_flota';

export const ESTADO_LINEA_FLOTA_LABEL: Record<EstadoLineaFlota, string> = {
  confirmado: 'Confirmado',
  sugerido: 'Sugerido por el texto',
  ambiguo: 'Nombra dos unidades',
  sin_unidad: 'Sin unidad',
  no_es_flota: 'No es de flota',
};

export type Propiedad = 'propia' | 'arrendada';
export type AreaFlota = 'transportes' | 'reparto' | 'telemarketing' | 'ventas' | 'administracion' | 'otra';

export const AREA_FLOTA_LABEL: Record<AreaFlota, string> = {
  transportes: 'Transportes',
  reparto: 'Reparto',
  telemarketing: 'Telemarketing',
  ventas: 'Ventas',
  administracion: 'Administración',
  otra: 'Otra',
};

/** La ficha: lo que la hoja trae en su encabezado de cada unidad, y lo que le faltaba. */
export interface FichaUnidad {
  vehicle_id: string;
  /** Número de la hoja: «UNIDAD 1». */
  economic_number: string | null;
  display_name: string | null;
  plate: string;
  /** La placa con que Kepler la tiene, si es otra (la diferencia es el dato). */
  plate_kepler: string | null;
  kepler_code: string | null;
  vin: string | null;
  year: number | null;
  brand: string | null;
  model: string | null;
  fleet_area: AreaFlota | null;
  ownership: Propiedad | null;
  purchase_value: number | null;
  purchase_date: string | null;
  useful_life_years: number | null;
  residual_value: number | null;
  insurance_carrier: string | null;
  insurance_policy: string | null;
  insurance_premium: number | null;
  insurance_expires_on: string | null;
  /** `null` también cuando quien consulta no puede ver salarios (`salario_visible = false`). */
  driver_monthly_salary: number | null;
  salario_visible: boolean;
  budget_km_year: number | null;
  kepler_aliases: string[];
  tiene_gps: boolean;
  notes: string | null;
}

/** Lo que se puede editar de la ficha (lo demás viene de Kepler o del GPS). */
export type CambiosFicha = Partial<Pick<FichaUnidad,
  'economic_number' | 'display_name' | 'vin' | 'year' | 'fleet_area' | 'ownership' | 'purchase_value' | 'purchase_date'
  | 'useful_life_years' | 'residual_value' | 'insurance_carrier' | 'insurance_policy' | 'insurance_premium'
  | 'insurance_expires_on' | 'driver_monthly_salary' | 'budget_km_year' | 'kepler_aliases'>>;

export type TipoAviso = 'seguro_vencido' | 'seguro_por_vencer' | 'sin_fecha_seguro' | 'sin_km' | 'gps_parcial'
  | 'sin_guias' | 'sin_presupuesto' | 'por_confirmar';

export interface AvisoUnidad {
  tipo: TipoAviso;
  severidad: 'alta' | 'media' | 'baja';
  texto: string;
}

/** Un renglón de rubro: presupuesto contra real en el periodo, y de dónde sale cada uno. */
export interface RenglonRubro {
  rubro: RubroCodigo;
  etiqueta: string;
  grupo: GrupoRubro;
  /** Presupuesto anual del rubro (la hoja). `null` = sin presupuesto. */
  presupuesto_anual: number | null;
  /** Presupuesto prorrateado a los días del periodo. */
  presupuesto: number | null;
  real: number | null;
  procedencia: Procedencia;
  /** Del real, cuánto viene de renglones SUGERIDOS por el texto (todavía sin confirmar). */
  sugerido: number;
  /** Renglones de Kepler o guías que lo forman. */
  renglones: number;
  /** Explicación en llano: cómo salió el real o por qué falta. */
  calculo: string;
}

export interface KmDeUnidad {
  km: number | null;
  fuente: 'gps' | 'odometro' | null;
  /** Días del periodo con GPS (para saber si el km es parcial). */
  dias_gps: number;
}

export interface UnidadCosto {
  vehicle_id: string;
  economic_number: string | null;
  nombre: string;
  plate: string;
  fleet_area: AreaFlota | null;
  km: KmDeUnidad;
  guias: number;
  presupuesto: number | null;
  real: number;
  /** Del real, cuánto es sugerido sin confirmar. */
  sugerido: number;
  /** Rubros con real `sin_dato` o `sin_medir`: el total NO los incluye. */
  rubros_sin_dato: number;
  por_km_real: number | null;
  por_km_presupuesto: number | null;
  rubros: RenglonRubro[];
  avisos: AvisoUnidad[];
}

export interface PeriodoCosto {
  desde: string;
  hasta: string;
  dias: number;
}

export interface ResumenCostoUnidad {
  periodo: PeriodoCosto;
  unidades: UnidadCosto[];
  /** Gastos de flota del periodo que nadie ha confirmado, por estado (para la bandeja). */
  pendientes: Record<'sugerido' | 'ambiguo' | 'sin_unidad', { renglones: number; importe: number }>;
  /** Nómina administrativa: meses del periodo sin capturar. */
  meses_sin_nomina: string[];
  leido_at: string;
}

export interface LineaGastoFlota {
  linea_clave: string;
  sucursal: string;
  folio: string;
  renglon: number;
  fecha: string;
  concepto: string;
  rubro: RubroCodigo | null;
  importe: number;
  centro: string | null;
  cabecera: string;
  texto: string;
  proveedor: string;
  estado: EstadoLineaFlota;
  vehicle_id: string | null;
  sugerido_vehicle_id: string | null;
  candidatos: number;
}

export interface GuiaDeUnidad {
  sucursal: string;
  guia: string;
  fecha: string;
  ruta: string | null;
  comision_chofer: number | null;
}

export interface LecturaOdometro {
  id: string;
  read_on: string;
  odometer_km: number;
  notes: string | null;
}

export interface DetalleUnidadCosto {
  ficha: FichaUnidad;
  unidad: UnidadCosto;
  lineas: LineaGastoFlota[];
  guias: GuiaDeUnidad[];
  km_por_mes: Array<{ mes: string; km: number; fuente: 'gps' | 'odometro' }>;
  lecturas: LecturaOdometro[];
  periodo: PeriodoCosto;
  leido_at: string;
}

/** `quitar` = deshacer lo que decidió una persona (el renglón vuelve a sugerido, ambiguo o sin unidad). */
export interface AsignacionGasto {
  linea_clave: string;
  decision: 'unidad' | 'no_es_flota' | 'quitar';
  vehicle_id: string | null;
}

/** La forma de `linea_clave` (sucursal|c1|serie|folio|renglón de un X-A-10 de Kepler). */
export const LINEA_CLAVE_RE = /^\d{2}\|\d{2}\|\d+\|[A-Z0-9-]{1,20}\|\d+$/;

/**
 * Los centros de costo donde Logística carga el gasto de su flotilla («LOGISTICA GENERAL» y
 * «SERVICIO DE FLETES TRANSPORTES»). La bandeja muestra por defecto lo sin unidad de estos centros;
 * lo demás sin unidad es, casi todo, de otras flotillas (reparto, ventas, oficinas).
 */
export const CENTROS_DE_LOGISTICA: readonly string[] = ['1-08-12-00', '1-09-63'];

/** Normaliza un alias como lo compara la vista: MAYÚSCULAS, sin acentos, un solo espacio. */
export function normalizarAlias(a: string): string {
  return String(a ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
}

export interface PresupuestoUnidad {
  vehicle_id: string;
  economic_number: string | null;
  nombre: string;
  montos: Partial<Record<RubroCodigo, number>>;
  total: number;
}

export interface PresupuestoAnio {
  anio: number;
  unidades: PresupuestoUnidad[];
}

export interface CeldaPresupuesto {
  vehicle_id: string;
  rubro: RubroCodigo;
  /** `null` = quitar la celda. */
  amount: number | null;
}

export interface NominaAdministrativaMes {
  year_month: string;
  sueldos_admin: number;
  gastos_directos: number;
  metodo: MetodoReparto;
  notes: string | null;
}

/** Avisos de la ficha y del periodo, en llano. `hoy` en YYYY-MM-DD (hora de México). */
export function avisosDeUnidad(
  u: { ficha: Pick<FichaUnidad, 'insurance_expires_on'>; km: KmDeUnidad; guias: number; dias: number; tienePresupuesto: boolean; sugerido: number },
  hoy: string,
): AvisoUnidad[] {
  const out: AvisoUnidad[] = [];
  const vence = u.ficha.insurance_expires_on;
  if (!vence) out.push({ tipo: 'sin_fecha_seguro', severidad: 'media', texto: 'Sin fecha de vencimiento del seguro en la ficha' });
  else if (vence < hoy) out.push({ tipo: 'seguro_vencido', severidad: 'alta', texto: `Seguro vencido el ${vence}` });
  else {
    const dias = Math.round((Date.parse(`${vence}T00:00:00Z`) - Date.parse(`${hoy}T00:00:00Z`)) / 86400000);
    if (dias <= 30) out.push({ tipo: 'seguro_por_vencer', severidad: 'alta', texto: `El seguro vence en ${dias} día${dias === 1 ? '' : 's'} (${vence})` });
  }
  if (u.km.km == null) out.push({ tipo: 'sin_km', severidad: 'media', texto: 'Sin km en el periodo: no tiene GPS ligado ni lectura de odómetro' });
  else if (u.km.fuente === 'gps' && u.km.dias_gps < u.dias) out.push({ tipo: 'gps_parcial', severidad: 'baja', texto: `GPS en ${u.km.dias_gps} de ${u.dias} días: los km pueden quedar cortos` });
  if (u.guias === 0) out.push({ tipo: 'sin_guias', severidad: 'media', texto: 'Sin guías de embarque en el periodo' });
  if (!u.tienePresupuesto) out.push({ tipo: 'sin_presupuesto', severidad: 'baja', texto: 'Sin presupuesto del año' });
  if (u.sugerido > 0) out.push({ tipo: 'por_confirmar', severidad: 'baja', texto: `$${u.sugerido.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} sugeridos por el texto de Kepler, sin confirmar` });
  return out;
}
