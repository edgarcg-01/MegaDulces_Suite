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
  AcreedorAplicacion, AcreedorDocEstado, AcreedorDocumento, AcreedorPagoSinAplicar, AcreedorTipo,
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
    });
    porDoc.set(kd, lista);
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
      const aplicado = r2(aplicaciones.reduce((t, a) => t + a.importe, 0));
      const saldo = r2(importe - aplicado);
      const vence = fechaOnull(d.vence);
      documentos.push({
        ...base, vence, aplicado, saldo,
        estado: estadoDocumento(importe, aplicado),
        vencido: saldo > TOLERANCIA && !!vence && vence < hoy,
        aplicaciones,
      });
    } else {
      const aplicado = aplicadoPorPago.get(k) ?? 0;
      const remanente = r2(importe - aplicado);
      if (remanente > TOLERANCIA) pagos.push({ ...base, aplicado, remanente });
    }
  }
  documentos.sort((x, y) => (x.fecha ?? '').localeCompare(y.fecha ?? '') || x.sucursal.localeCompare(y.sucursal) || x.folio.localeCompare(y.folio));
  pagos.sort((x, y) => (x.fecha ?? '').localeCompare(y.fecha ?? '') || x.folio.localeCompare(y.folio));
  return { documentos, pagos_sin_aplicar: pagos };
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
