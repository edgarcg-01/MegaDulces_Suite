/**
 * `[ECA.1]` Motor del Estado de cuenta de acreedores â€” la lÃ³gica pura, sin base de datos.
 *
 * â”€â”€ LO QUE SE MIDIÃ“ ANTES DE ESCRIBIR ESTO (prod, 2026-10-07) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * Â· Kepler guarda las cuentas por pagar en `kdxe` y el casamiento en `kdxf`. De 30,073
 *   aplicaciones, las 30,073 van de un cargo `D` (pago, nota de crÃ©dito) a un abono `A`
 *   (factura). Contra el reporte "Estado de cuenta del proveedor" de Kepler para Mondelez
 *   (CM009, ago-2026) cuadran los 5 documentos y sus 8 aplicaciones al centavo.
 * Â· La clave del proveedor ya dice quÃ© es: `C*` mercancÃ­a (337), `G*` gasto (301). El Grupo de
 *   Kepler (`kdxd.c13`) sÃ³lo estÃ¡ capturado en 43 de 777 proveedores, asÃ­ que NO puede ser la
 *   Ãºnica regla. Y el grupo 120 ("instituciones financieras") tiene a los bancos `GB*`, cuyos
 *   documentos son comisiones ("IVA SER BANCA", $48): eso es Servicios, no deuda.
 * Â· La deuda financiera vive en claves propias: `A*` prÃ©stamos de personas, `B.B.FAC` factoraje
 *   Financiera BajÃ­o, `TC*` tarjetas de crÃ©dito, y STM Financial (grupo 140).
 * Â· `TI*` son las sucursales dadas de alta como proveedor: traspasos internos, no deuda.
 * Â· La rÃ©plica de la sucursal 03 arrastra 734 renglones de la 02 â†’ se filtra `c1 = sucursal`.
 */
import type {
  AcreedorAplicacion, AcreedorCalendario, AcreedorDocEstado, AcreedorDocProgramado, AcreedorDocumento,
  AcreedorPagoSinAplicar, AcreedorTipo,
} from '@megadulces/contracts';

/**
 * Nombres de los grupos de proveedor de Kepler (`kdxd.c13`). El catálogo de nombres NO llega al ODS,
 * así que se DEDUJERON (2026-10-07): `c13` trae exactamente 11 códigos, los mismos 11 del combo
 * "Grupo" de la pantalla de proveedores y en el mismo orden, y cada uno cuadra con quién lo tiene
 * (001 = Mondelez/Hershey/Effem, 002 = Bolsas de los Altos, 100 = Cyberpuerta, 120 = los bancos,
 * 130 = AT&T y contadores, 140 = STM Financial). Un código nuevo se muestra como "Grupo NNN".
 * Si en Kepler se crea o renombra un grupo, actualizar aquí.
 */
export const GRUPOS_KEPLER: Readonly<Record<string, string>> = {
  '001': 'Proveedores AMDIVED',
  '002': 'Proveedor de plásticos estratégico',
  '003': 'Proveedor de materias primas',
  '004': 'Compras mercancías para venta',
  '005': 'Productos de limpieza',
  '100': 'Venta equipos de cómputo',
  '101': 'Equipo de empaque flexible',
  '102': 'Compra de electrodomésticos',
  '120': 'Instituciones financieras',
  '130': 'Proveedores de servicios especializados',
  '140': 'Financiamiento vehicular',
};
export const nombreGrupo = (g: string | null | undefined): string | null =>
  g ? GRUPOS_KEPLER[g] ?? `Grupo ${g}` : null;

/** Grupos de Kepler (`kdxd.c13`) que son deuda financiera. 140 = "Financiamiento vehicular". */
export const GRUPOS_FINANCIEROS: readonly string[] = ['140'];
/**
 * Prefijos de clave que son deuda financiera. Al dar de alta en Kepler un crÃ©dito bancario
 * (Banorte, BBVA, BajÃ­oâ€¦), usar una de estas claves o un grupo de `GRUPOS_FINANCIEROS`.
 */
export const PREFIJOS_FINANCIEROS: readonly string[] = ['A', 'TC', 'B.B.'];
/** Hasta el 30-sep-2026 el 00 concentrÃ³; desde el 1-oct cada sucursal opera su propio Kepler. */
export const CORTE_CONCENTRADOR = '2026-10-01';
/** Diferencias de centavos por redondeo no cambian el estado de un documento. */
export const TOLERANCIA = 0.01;

export const r2 = (n: unknown): number => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Tipo de acreedor. El orden importa: internos primero (una sucursal nunca es deuda), luego lo
 * financiero (que puede venir por grupo aunque la clave sea `G*`, como STM Financial `GS012`),
 * y sÃ³lo al final la clave de compra/gasto.
 */
export function clasificarAcreedor(codigo: string, grupo: string | null | undefined): AcreedorTipo {
  const c = (codigo || '').trim().toUpperCase();
  const g = (grupo || '').trim();
  if (c.startsWith('TI')) return 'interno';
  if ((g && GRUPOS_FINANCIEROS.includes(g)) || PREFIJOS_FINANCIEROS.some((p) => c.startsWith(p))) return 'financiero';
  if (c.startsWith('C')) return 'mercancia';
  if (c.startsWith('G')) return 'servicios';
  return 'sin_clasificar';
}

export function estadoDocumento(importe: number, aplicado: number): AcreedorDocEstado {
  const saldo = r2(importe - aplicado);
  if (saldo < -TOLERANCIA) return 'sobreaplicado';
  if (saldo <= TOLERANCIA) return 'pagado';
  if (aplicado > TOLERANCIA) return 'parcial';
  return 'pendiente';
}

/** Kepler escribe "sin fecha" como 1800-01-01. */
export const fechaOnull = (f: string | null | undefined): string | null => (f && f >= '1900-01-01' ? f : null);

/** Documento crudo de `kdxe` (Postgres devuelve `numeric` como texto). */
export interface DocCrudo {
  sucursal: string;
  naturaleza: string;
  tipo_doc: string | number;
  sub: string | number;
  folio: string;
  documento: string | null;
  fecha: string | null;
  vence: string | null;
  referencia: string | null;
  importe: string | number;
  /** `[ECA.7]` Cancelado en Kepler (`kdm1.c43='C'`). */
  cancelado: boolean;
}

/** AplicaciÃ³n cruda de `kdxf`: el cargo `pago_*` se aplicÃ³ al abono `doc_*`. */
export interface AplicacionCruda {
  sucursal: string;
  doc_tipo: string | number;
  doc_sub: string | number;
  doc_folio: string;
  pago_tipo: string | number;
  pago_sub: string | number;
  pago_folio: string;
  pago_documento: string | null;
  pago_fecha: string | null;
  pago_referencia: string | null;
  importe: string | number;
  /**
   * `[ECA.7]` El cargo o el abono está cancelado en Kepler (`kdm1.c43='C'`). Kepler deja el importe
   * del documento cancelado en cero pero la aplicación sigue en `kdxf` (medido 2026-10-10: 319
   * aplicaciones de 187 cargos cancelados, $10.99M en 63 acreedores) — contarla rebaja dos veces.
   */
  cancelado: boolean;
}

const clave = (sucursal: string, tipo: string | number, sub: string | number, folio: string): string =>
  `${sucursal}|${Number(tipo)}|${Number(sub)}|${(folio || '').trim()}`;

export interface EstadoArmado {
  documentos: AcreedorDocumento[];
  pagos_sin_aplicar: AcreedorPagoSinAplicar[];
}

/**
 * Arma el estado de cuenta: cada abono con sus cargos debajo, y aparte los cargos con remanente.
 * `hoy` (AAAA-MM-DD) decide quÃ© estÃ¡ vencido. Todos los documentos van; el filtro de pendientes
 * o de periodo lo aplica quien llama, para que los totales salgan del mismo cÃ¡lculo.
 */
export function armarEstado(docs: DocCrudo[], apps: AplicacionCruda[], hoy: string): EstadoArmado {
  const porDoc = new Map<string, AcreedorAplicacion[]>();
  const aplicadoPorPago = new Map<string, number>();
  for (const a of apps) {
    const kd = clave(a.sucursal, a.doc_tipo, a.doc_sub, a.doc_folio);
    const lista = porDoc.get(kd) ?? [];
    lista.push({
      sucursal: a.sucursal,
      documento: a.pago_documento || `Tipo ${Number(a.pago_tipo)}`,
      tipo_doc: Number(a.pago_tipo),
      folio: (a.pago_folio || '').trim(),
      fecha: fechaOnull(a.pago_fecha),
      referencia: a.pago_referencia?.trim() || null,
      importe: r2(a.importe),
      cancelado: !!a.cancelado,
    });
    porDoc.set(kd, lista);
    // Una aplicación cancelada se muestra, pero no consume el pago.
    if (a.cancelado) continue;
    const kp = clave(a.sucursal, a.pago_tipo, a.pago_sub, a.pago_folio);
    aplicadoPorPago.set(kp, r2((aplicadoPorPago.get(kp) ?? 0) + r2(a.importe)));
  }

  const documentos: AcreedorDocumento[] = [];
  const pagos: AcreedorPagoSinAplicar[] = [];
  for (const d of docs) {
    const k = clave(d.sucursal, d.tipo_doc, d.sub, d.folio);
    const importe = r2(d.importe);
    const base = {
      sucursal: d.sucursal,
      documento: d.documento || `Tipo ${Number(d.tipo_doc)}`,
      tipo_doc: Number(d.tipo_doc),
      folio: (d.folio || '').trim(),
      fecha: fechaOnull(d.fecha),
      referencia: d.referencia?.trim() || null,
      importe,
    };
    if (d.naturaleza === 'A') {
      // Mismo orden que el reporte de Kepler: por fecha y, el mismo dÃ­a, la transferencia (26)
      // antes que las notas de crÃ©dito (55).
      const aplicaciones = (porDoc.get(k) ?? []).sort((x, y) =>
        (x.fecha ?? '').localeCompare(y.fecha ?? '') || x.tipo_doc - y.tipo_doc || x.folio.localeCompare(y.folio));
      const vence = fechaOnull(d.vence);
      if (d.cancelado) {
        documentos.push({
          ...base, sub: Number(d.sub), vence, aplicado: 0, saldo: 0, estado: 'cancelado', vencido: false, cancelado: true,
          aplicaciones: aplicaciones.map((a) => ({ ...a, cancelado: true })),
          programado: [],
        });
        continue;
      }
      const aplicado = r2(aplicaciones.reduce((t, a) => t + (a.cancelado ? 0 : a.importe), 0));
      const saldo = r2(importe - aplicado);
      documentos.push({
        ...base, sub: Number(d.sub), vence, aplicado, saldo,
        estado: estadoDocumento(importe, aplicado),
        vencido: saldo > TOLERANCIA && !!vence && vence < hoy,
        cancelado: false,
        aplicaciones,
        programado: [],
      });
    } else if (!d.cancelado) {
      const aplicado = aplicadoPorPago.get(k) ?? 0;
      const remanente = r2(importe - aplicado);
      if (remanente > TOLERANCIA) pagos.push({ ...base, aplicado, remanente });
    }
  }
  documentos.sort((x, y) => (x.fecha ?? '').localeCompare(y.fecha ?? '') || x.sucursal.localeCompare(y.sucursal) || x.folio.localeCompare(y.folio));
  pagos.sort((x, y) => (x.fecha ?? '').localeCompare(y.fecha ?? '') || x.folio.localeCompare(y.folio));
  return { documentos, pagos_sin_aplicar: pagos };
}

/** `[ECA.8]` Un renglón de la consulta del Calendario: una factura dentro de un pago. */
export interface ProgramadoCrudo {
  sucursal: string;
  tipo_doc: string | number;
  sub: string | number;
  folio: string;
  allocation_id: string;
  fecha: string;
  estado: string;
  cubierto: string | number;
  facturas_en_pago: string | number;
  total_pago: string | number;
  creado_por: string | null;
  pagado_el: string | null;
  metodo: string | null;
  banco: string | null;
  referencia: string | null;
  /** `payment_allocations.kepler_payment_folio`: el pago de Kepler ligado, si ya se ligó. */
  kepler_folio: string | null;
}

/** Folios de Kepler comparables: sin espacios ni ceros a la izquierda (`0016796` = `16796`). */
const folioComparable = (f: string | null | undefined): string => (f ?? '').trim().replace(/^0+(?=.)/, '');

/**
 * `[ECA.8]` **Cada factura dice en qué pago del Calendario está.**
 *
 * Caso que lo motivó (2026-11-09): Tesorería buscaba en el Calendario facturas que no salían, y no
 * salían porque YA estaban programadas — la lista de «agregar» sólo ofrece disponible > 0. GS011
 * tenía 3 en el pago del 13/11; DAMEX 0009775 estaba en un pago del 07/11 que pasó sin pagarse.
 *
 * Se casa por la clave natural de Kepler (sucursal, tipo, subtipo, folio), la misma que arma la llave
 * del Calendario: medido, 323/323 facturas derivadas y 12/12 capturadas casan.
 * ⛔ Sólo `pending` y `executed`: un pago cancelado o rebotado no aparta nada.
 */
export function adjuntarProgramado(documentos: AcreedorDocumento[], filas: ProgramadoCrudo[], hoy: string): void {
  const porDoc = new Map<string, AcreedorDocProgramado[]>();
  for (const f of filas) {
    if (f.estado !== 'pending' && f.estado !== 'executed') continue;
    const k = clave(f.sucursal, f.tipo_doc, f.sub, f.folio);
    const lista = porDoc.get(k) ?? [];
    lista.push({
      allocation_id: f.allocation_id,
      fecha: f.fecha,
      estado: f.estado === 'executed' ? 'ejecutado' : 'pendiente',
      dia_pasado: f.estado === 'pending' && f.fecha < hoy,
      cubierto: r2(f.cubierto),
      facturas_en_pago: Number(f.facturas_en_pago) || 1,
      total_pago: r2(f.total_pago),
      creado_por: f.creado_por,
      pagado_el: f.estado === 'executed' ? f.pagado_el : null,
      metodo: f.metodo,
      banco: f.banco,
      referencia: f.referencia?.trim() || null,
      kepler_folio: f.kepler_folio?.trim() || null,
      aplicado_en_kepler: false,
    });
    porDoc.set(k, lista);
  }
  for (const d of documentos) {
    const p = porDoc.get(clave(d.sucursal, d.tipo_doc, d.sub, d.folio)) ?? [];
    // Revisión independiente: un pago ejecutado que Kepler YA aplicó a esta factura ya está dentro
    // de su saldo. Se reconoce porque su folio ligado aparece entre las aplicaciones vivas de Kepler.
    const aplicados = new Set(d.aplicaciones.filter((a) => !a.cancelado).map((a) => folioComparable(a.folio)));
    for (const x of p) x.aplicado_en_kepler = x.estado === 'ejecutado' && !!x.kepler_folio && aplicados.has(folioComparable(x.kepler_folio));
    d.programado = p.sort((x, y) => x.fecha.localeCompare(y.fecha));
  }
}

/**
 * `[ECA.8]` Lo que el Calendario aparta del acreedor, sobre los documentos mostrados. Lo EJECUTADO no
 * suma a «programado»: ya salió del banco, sólo falta que Kepler lo aplique.
 */
export function calendarioDe(documentos: AcreedorDocumento[]): AcreedorCalendario {
  let programado = 0, docs = 0, sinProgramar = 0;
  for (const d of documentos) {
    if (d.cancelado) continue;
    const pend = d.programado.filter((p) => p.estado === 'pendiente').reduce((t, p) => t + p.cubierto, 0);
    // Lo ejecutado que Kepler ya aplicó ya bajó el saldo: restarlo otra vez lo contaría dos veces.
    const ejec = d.programado.filter((p) => p.estado === 'ejecutado' && !p.aplicado_en_kepler).reduce((t, p) => t + p.cubierto, 0);
    if (pend > 0) docs++;
    programado += pend;
    if (d.saldo > TOLERANCIA) sinProgramar += Math.max(d.saldo - pend - ejec, 0);
  }
  return { medido: true, programado: r2(programado), documentos: docs, sin_programar: r2(sinProgramar) };
}

/** Totales del estado de cuenta sobre lo que se va a mostrar. */
export function totalesEstado(documentos: AcreedorDocumento[], pagos: AcreedorPagoSinAplicar[]) {
  const importe = r2(documentos.reduce((t, d) => t + d.importe, 0));
  const aplicado = r2(documentos.reduce((t, d) => t + d.aplicado, 0));
  const pendiente = r2(documentos.reduce((t, d) => t + Math.max(d.saldo, 0), 0));
  const vencido = r2(documentos.reduce((t, d) => t + (d.vencido ? d.saldo : 0), 0));
  const pagos_sin_aplicar = r2(pagos.reduce((t, p) => t + p.remanente, 0));
  // Un documento sobreaplicado (saldo negativo) es dinero a favor: resta del saldo aunque no
  // cuente como "pendiente".
  const saldoDocs = r2(documentos.reduce((t, d) => t + d.saldo, 0));
  return { importe, aplicado, pendiente, vencido, pagos_sin_aplicar, saldo: r2(saldoDocs - pagos_sin_aplicar) };
}
