/**
 * `[PGP.210]` **El contrato que sustenta un cargo del banco** (anexo CR §3.1, DCR2 de Francisco: «la Suite debe llevar esos
 * contratos; todos los cargos tienen que estar sustentados por contratos»).
 *
 * Un contrato dice quién cobra, desde qué cuenta, qué días y cuánto, y si ya lo confirmó Tesorería (DCR1: «el sistema
 * propone, Tesorería confirma»). Si cobra varios conceptos (capital + interés + IVA), cada concepto es un renglón; un
 * renglón «por tabla» lleva su tabla de amortización (DCR8).
 *
 * Aquí viven el vocabulario (las listas que aceptan los CHECK de `finance.charge_contracts`, `_lines` y `_schedule`: la
 * prueba exige que sean las mismas) y las reglas puras: cómo se clasifica una serie del banco, cómo se agrupan las
 * propuestas y qué le falta a un contrato para confirmarse. La lectura y la escritura viven en `libs/finance`.
 */

export type TipoContratoCargo =
  | 'arrendamiento' | 'credito' | 'seguro' | 'fonacot' | 'cuota_comision' | 'servicio' | 'nomina' | 'por_clasificar';
export type EstadoContratoCargo = 'propuesto' | 'confirmado' | 'terminado' | 'cancelado';
export type OrigenContratoCargo = 'historia' | 'manual';
export type CadenciaContratoCargo = 'mensual' | 'semanal';
export type ConceptoRenglonCargo = 'renta' | 'capital' | 'interes' | 'iva' | 'seguro' | 'comision' | 'otro';
export type ReglaImporteCargo = 'fijo' | 'tabla' | 'estimado';

/** `por_clasificar` sólo vive en una propuesta (o en una cancelada): para confirmar hay que decir qué es. */
export const TIPOS_CONTRATO_CARGO: readonly TipoContratoCargo[] = ['arrendamiento', 'credito', 'seguro', 'fonacot', 'cuota_comision', 'servicio', 'nomina', 'por_clasificar'];
export const ESTADOS_CONTRATO_CARGO: readonly EstadoContratoCargo[] = ['propuesto', 'confirmado', 'terminado', 'cancelado'];
export const ORIGENES_CONTRATO_CARGO: readonly OrigenContratoCargo[] = ['historia', 'manual'];
export const CADENCIAS_CONTRATO_CARGO: readonly CadenciaContratoCargo[] = ['mensual', 'semanal'];
export const CONCEPTOS_RENGLON_CARGO: readonly ConceptoRenglonCargo[] = ['renta', 'capital', 'interes', 'iva', 'seguro', 'comision', 'otro'];
export const REGLAS_IMPORTE_CARGO: readonly ReglaImporteCargo[] = ['fijo', 'tabla', 'estimado'];

export const NOMBRE_TIPO_CONTRATO_CARGO: Record<TipoContratoCargo, string> = {
  arrendamiento: 'Arrendamiento', credito: 'Crédito', seguro: 'Seguro', fonacot: 'FONACOT', cuota_comision: 'Cuota de comisión',
  servicio: 'Servicio', nomina: 'Nómina', por_clasificar: 'Por clasificar',
};

// ─── Clasificar una serie del banco (lo que propone el detector, [PGP.209]) ─────────────────────

export interface ClasificacionDeSerie { tipo: TipoContratoCargo; concepto: ConceptoRenglonCargo; porque: string }

/**
 * Reglas EXPLÍCITAS por la cabeza del concepto con que el banco cobra (medidas el 2026-11-25 sobre las 47 series
 * vigentes: 33 se clasifican, 14 quedan por clasificar). Lo que no casa con ninguna queda `por_clasificar`: el concepto
 * del banco no dice qué es (la domiciliación de una arrendadora y la de un seguro se ven iguales), y adivinarlo es lo
 * que la regla 10 prohíbe.
 */
const POR_CABEZA: readonly { re: RegExp; tipo: TipoContratoCargo; concepto: ConceptoRenglonCargo; porque: string }[] = [
  { re: /^PAGO DE CAPITAL$/, tipo: 'credito', concepto: 'capital', porque: 'el banco lo cobra como «pago de capital»' },
  { re: /^PAGO DE INTERESES$/, tipo: 'credito', concepto: 'interes', porque: 'el banco lo cobra como «pago de intereses»' },
  { re: /^INTERESES NO REALES$/, tipo: 'credito', concepto: 'interes', porque: 'el banco lo cobra como «intereses no reales» del crédito' },
  { re: /^PAGO DE IVA$/, tipo: 'credito', concepto: 'iva', porque: 'el banco lo cobra como «pago de IVA» junto con el crédito' },
  { re: /^(IVA|I V A|COBRO IVA)\b/, tipo: 'cuota_comision', concepto: 'iva', porque: 'es el IVA de una comisión del banco' },
  { re: /^(COM|COMISION|CUOTA|RENTA TERMINAL|SERV BANCA|ADMINISTRACION RENTA|FACTURACION PENALIZACION)\b/, tipo: 'cuota_comision', concepto: 'comision', porque: 'es una comisión fija del banco' },
];

export function clasificarSerie(cabeza: string, categoria: string | null): ClasificacionDeSerie {
  const c = String(cabeza ?? '').trim().toUpperCase();
  const porCabeza = POR_CABEZA.find((r) => r.re.test(c));
  if (porCabeza && porCabeza.tipo === 'credito') return { tipo: porCabeza.tipo, concepto: porCabeza.concepto, porque: porCabeza.porque };
  if (categoria === 'comision_bancaria') return { tipo: 'cuota_comision', concepto: 'comision', porque: 'Bancos la clasificó como comisión bancaria' };
  if (categoria === 'iva_acreditable') return { tipo: 'cuota_comision', concepto: 'iva', porque: 'Bancos la clasificó como IVA acreditable de una comisión' };
  if (porCabeza) return { tipo: porCabeza.tipo, concepto: porCabeza.concepto, porque: porCabeza.porque };
  return { tipo: 'por_clasificar', concepto: 'otro', porque: 'el concepto del banco no dice qué es: lo clasifica Tesorería al confirmar' };
}

/** El número del crédito en el concepto (la primera corrida de 6 dígitos o más), o `null`. */
export function numeroDeCredito(concepto: string | null | undefined): string | null {
  return /\d{6,}/.exec(String(concepto ?? ''))?.[0] ?? null;
}

/** Una serie vigente de `finance.v_recurring_bank_charges`, con lo que hace falta para proponerla. */
export interface SerieParaProponer {
  series_key: string;
  rule: 'fixed_amount' | 'variable_amount';
  bank_account_id: string;
  concept_head: string;
  latest_concept: string | null;
  category_code: string | null;
  months: number;
  charges: number;
  charges_per_month: number;
  fixed_amount: number | null;
  last_amount: number;
  min_amount: number;
  max_amount: number;
  first_charge_date: string;
  last_charge_date: string;
  min_day: number;
  max_day: number;
  movement_dates: string[];
}

export interface RenglonPropuesto {
  concepto: ConceptoRenglonCargo;
  descripcion: string;
  cabeza_banco: string;
  regla_importe: ReglaImporteCargo;
  importe_fijo: number | null;
  cargos_por_periodo: number;
  series_key: string;
}

export interface EvidenciaDeSerie {
  series_key: string;
  regla: 'fixed_amount' | 'variable_amount';
  meses: number;
  cargos: number;
  primero: string;
  ultimo: string;
  importe_fijo: number | null;
  ultimo_importe: number;
  minimo: number;
  maximo: number;
  fechas: string[];
  porque: string;
}

export interface PropuestaDeContrato {
  tipo: TipoContratoCargo;
  acreedor: string;
  bank_account_id: string;
  dia_desde: number;
  dia_hasta: number;
  inicio: string;
  renglones: RenglonPropuesto[];
  evidencia: EvidenciaDeSerie[];
}

/**
 * Las propuestas de contrato que salen de las series del banco. Una por serie, salvo el crédito: capital, interés e IVA
 * con el MISMO número de crédito en la misma cuenta son UN contrato con varios renglones (no se adivina: el número lo
 * trae el concepto del banco). El acreedor es provisional (lo corrige Tesorería al confirmar).
 */
export function agruparPropuestas(series: readonly SerieParaProponer[]): PropuestaDeContrato[] {
  const grupos = new Map<string, { clas: ClasificacionDeSerie; s: SerieParaProponer }[]>();
  for (const s of series) {
    const clas = clasificarSerie(s.concept_head, s.category_code);
    const num = clas.tipo === 'credito' ? numeroDeCredito(s.latest_concept) : null;
    const llave = num ? `${s.bank_account_id}|credito|${num}` : `serie|${s.series_key}`;
    grupos.set(llave, [...(grupos.get(llave) ?? []), { clas, s }]);
  }
  const ORDEN: Record<ConceptoRenglonCargo, number> = { capital: 1, interes: 2, iva: 3, renta: 4, seguro: 5, comision: 6, otro: 7 };
  return Array.from(grupos.entries()).map(([llave, miembros]) => {
    const m = [...miembros].sort((a, b) => ORDEN[a.clas.concepto] - ORDEN[b.clas.concepto] || a.s.concept_head.localeCompare(b.s.concept_head));
    const num = llave.includes('|credito|') ? llave.split('|')[2] : null;
    const primero = m[0];
    return {
      tipo: primero.clas.tipo,
      acreedor: num ? `Crédito ${num}` : (primero.s.latest_concept?.trim() || primero.s.concept_head).slice(0, 200),
      bank_account_id: primero.s.bank_account_id,
      dia_desde: Math.min(...m.map((x) => x.s.min_day)),
      dia_hasta: Math.max(...m.map((x) => x.s.max_day)),
      inicio: m.map((x) => x.s.first_charge_date).sort()[0],
      renglones: m.map(({ clas, s }) => ({
        concepto: clas.concepto,
        descripcion: s.concept_head,
        cabeza_banco: s.concept_head,
        regla_importe: s.rule === 'fixed_amount' ? 'fijo' as const : 'estimado' as const,
        importe_fijo: s.rule === 'fixed_amount' ? Number(s.fixed_amount) : null,
        cargos_por_periodo: s.rule === 'fixed_amount' ? Math.max(1, s.charges_per_month) : 1,
        series_key: s.series_key,
      })),
      evidencia: m.map(({ clas, s }) => ({
        series_key: s.series_key, regla: s.rule, meses: s.months, cargos: s.charges, primero: s.first_charge_date, ultimo: s.last_charge_date,
        importe_fijo: s.fixed_amount === null ? null : Number(s.fixed_amount), ultimo_importe: Number(s.last_amount),
        minimo: Number(s.min_amount), maximo: Number(s.max_amount), fechas: [...s.movement_dates], porque: clas.porque,
      })),
    };
  });
}

// ─── El cargo automático y su contrato ([PGP.212]) ─────────────────────────────────────────────

/**
 * Por qué un cargo automático del banco está (o no) sustentado por un contrato (anexo CR §3.4). Sólo `con_contrato` lo
 * sustenta; los demás son un hallazgo para Tesorería, no un gasto que se da por bueno.
 */
export type MotivoCargoAutomatico =
  | 'con_contrato' | 'sin_contrato' | 'propuesta_sin_confirmar' | 'propuesta_rechazada' | 'fuera_de_vigencia' | 'importe_distinto';
export const MOTIVOS_CARGO_AUTOMATICO: readonly MotivoCargoAutomatico[] = ['con_contrato', 'sin_contrato', 'propuesta_sin_confirmar', 'propuesta_rechazada', 'fuera_de_vigencia', 'importe_distinto'];
export const TEXTO_MOTIVO_CARGO_AUTOMATICO: Record<MotivoCargoAutomatico, string> = {
  con_contrato: 'Lo sustenta un contrato confirmado.',
  sin_contrato: 'Ningún contrato lo cita: falta su contrato.',
  propuesta_sin_confirmar: 'Hay un contrato propuesto que Tesorería no ha confirmado.',
  propuesta_rechazada: 'Tesorería rechazó la propuesta: el cargo sigue sin contrato.',
  fuera_de_vigencia: 'Su contrato no estaba vigente ese día.',
  importe_distinto: 'El banco cobró un importe distinto al del contrato.',
};

// ─── El cargo de cada mes ([PGP.211]) ──────────────────────────────────────────────────────────

/**
 * Los subtipos de `finance.financial_commitments` (= su CHECK). Los cuatro de TP.1 y los que trae el contrato. El capital
 * de un crédito es `amortizacion`; su interés y el IVA del interés, `interes`.
 */
export type SubtipoCompromiso =
  | 'factoraje' | 'interes' | 'amortizacion' | 'otro' | 'arrendamiento' | 'seguro' | 'cuota_comision' | 'servicio' | 'fonacot' | 'nomina';
export const SUBTIPOS_COMPROMISO: readonly SubtipoCompromiso[] = ['factoraje', 'interes', 'amortizacion', 'otro', 'arrendamiento', 'seguro', 'cuota_comision', 'servicio', 'fonacot', 'nomina'];

export function subtipoDelCargo(tipo: TipoContratoCargo, concepto: ConceptoRenglonCargo): SubtipoCompromiso {
  if (tipo === 'credito') return concepto === 'capital' ? 'amortizacion' : concepto === 'interes' || concepto === 'iva' ? 'interes' : 'otro';
  if (tipo === 'por_clasificar') return 'otro';
  return tipo;
}

/** El periodo (YYYY-MM) de una fecha. */
export const periodoDe = (fecha: string): string => fecha.slice(0, 7);

/** Los `meses` periodos desde el de `hoy` (el de hoy y los siguientes). */
export function periodosDelHorizonte(hoy: string, meses: number): string[] {
  const [a, m] = hoy.slice(0, 7).split('-').map(Number);
  return Array.from({ length: Math.max(0, meses) }, (_, k) => {
    const n = (m - 1) + k;
    return `${a + Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`;
  });
}

/** El día `dia` del periodo, sin pasarse del último día del mes (el 31 de noviembre es el 30). */
export function fechaEsperadaDelPeriodo(periodo: string, dia: number): string {
  const [a, m] = periodo.split('-').map(Number);
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return `${periodo}-${String(Math.min(Math.max(1, dia), ultimo)).padStart(2, '0')}`;
}

/** Quién autoriza el cargo de cada mes (DCR5: «la firma es la del contrato»): se guarda en `authorized_by`. */
export const autorizadoPorContrato = (contratoId: string): string => `contrato:${contratoId}`;

// ─── El ciclo de vida ──────────────────────────────────────────────────────────────────────────

const TRANSICIONES: Record<EstadoContratoCargo, readonly EstadoContratoCargo[]> = {
  propuesto: ['confirmado', 'cancelado'],
  confirmado: ['terminado'],
  terminado: [],
  cancelado: [],
};

/** Propuesto → confirmado o cancelado (rechazado); confirmado → terminado. Terminado y cancelado no cambian. */
export function transicionPermitida(de: EstadoContratoCargo, a: EstadoContratoCargo): boolean {
  return TRANSICIONES[de]?.includes(a) ?? false;
}

/**
 * DCR11 (Francisco, 2026-11-26): el PDF del contrato es obligatorio para confirmar estos tipos. Una cuota de comisión
 * no tiene contrato aparte (es el de la cuenta); servicio y nómina tampoco lo exigen.
 */
export const TIPOS_CON_DOCUMENTO: readonly TipoContratoCargo[] = ['arrendamiento', 'credito', 'seguro', 'fonacot'];

export interface ContratoParaRevisar {
  tipo: TipoContratoCargo;
  acreedor: string;
  cadencia: CadenciaContratoCargo;
  dia_desde: number;
  dia_hasta: number;
  inicio: string | null;
  fin: string | null;
  /** Ya tiene (o trae al confirmar) el PDF del contrato. */
  tiene_documento: boolean;
}
export interface RenglonParaRevisar {
  descripcion: string;
  regla_importe: ReglaImporteCargo;
  importe_fijo: number | null;
  /** Cuántas filas tiene su tabla de amortización. */
  filas_de_tabla: number;
}

/** Los días válidos: del 1 al 31 del mes (mensual) o del 1 (lunes) al 7 (domingo) de la semana (semanal). */
export function diaValido(cadencia: CadenciaContratoCargo, dia: number): boolean {
  return Number.isInteger(dia) && dia >= 1 && dia <= (cadencia === 'semanal' ? 7 : 31);
}

/**
 * Lo que le falta a un contrato para confirmarse, en llano. Vacío = se puede confirmar. Las mismas guardas que los CHECK
 * de la base, más las que la base no puede ver (que esté clasificado, que su tabla no esté vacía).
 */
export function problemasParaConfirmar(c: ContratoParaRevisar, renglones: readonly RenglonParaRevisar[]): string[] {
  const p: string[] = [];
  if (c.tipo === 'por_clasificar') p.push('Falta decir qué es: arrendamiento, crédito, seguro, FONACOT, cuota de comisión, servicio o nómina.');
  if (!String(c.acreedor ?? '').trim()) p.push('Falta el acreedor.');
  if (TIPOS_CON_DOCUMENTO.includes(c.tipo) && !c.tiene_documento) {
    p.push('Falta el PDF del contrato: arrendamiento, crédito, seguro y FONACOT lo llevan para confirmarse.');
  }
  if (!diaValido(c.cadencia, c.dia_desde) || !diaValido(c.cadencia, c.dia_hasta)) {
    p.push(c.cadencia === 'semanal' ? 'Los días de cobro van del 1 (lunes) al 7 (domingo).' : 'Los días de cobro van del 1 al 31.');
  }
  if (c.inicio && c.fin && c.fin < c.inicio) p.push('El contrato termina antes de empezar.');
  if (!renglones.length) p.push('Falta al menos un concepto de cobro.');
  for (const r of renglones) {
    if (r.regla_importe === 'fijo' && !(Number(r.importe_fijo) > 0)) p.push(`«${r.descripcion}» es de importe fijo y no tiene importe.`);
    if (r.regla_importe === 'tabla' && !(r.filas_de_tabla > 0)) p.push(`«${r.descripcion}» se cobra por tabla y su tabla está vacía.`);
  }
  return p;
}
