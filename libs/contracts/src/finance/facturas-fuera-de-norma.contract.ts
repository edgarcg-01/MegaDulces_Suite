/**
 * `[PGP.229]` **La bandeja «Facturas fuera de norma»: lo que espera la decisión de Administración o Contabilidad.**
 *
 * Una factura recibida con uso S01 o con un régimen que no es 612 no se paga hasta que alguien con la llave
 * `FINANCE_CFDI_NORMA_DECIDIR` diga «se usa» o «no se usa», con su motivo (D-NF2: basta una firma; la llave va a
 * `contabilidad` y `direccion`). La regla vive en `norma-fiscal-cfdi.contract.ts`; aquí sólo la forma de la API.
 */
import { normaFiscalDelCfdi, type CfdiParaNorma, type MotivoNorma, type ReglaNorma } from './norma-fiscal-cfdi.contract';

export type DecisionNorma = 'se_usa' | 'no_se_usa';

/** El nombre en llano de cada regla (para el 409 y la pantalla). */
export const NOMBRE_DE_LA_REGLA: Readonly<Record<ReglaNorma, string>> = {
  cancelada: 'cancelada en el SAT',
  rol: 'factura emitida por nosotros',
  pue_mes_anterior: 'PUE de un mes anterior',
  sin_efectos_fiscales: 'uso S01 (sin efectos fiscales)',
  regimen: 'régimen distinto de 612',
  sin_verificar: 'sin verificar en el SAT',
};

/** Una decisión viva (no revocada) sobre UNA regla de UNA factura. */
export interface DecisionTomada {
  id: string;
  regla: ReglaNorma;
  decision: DecisionNorma;
  motivo: string;
  /** Usuario que decidió. */
  por: string;
  /** ISO. */
  cuando: string;
}

/** Un pago del Calendario, todavía sin pagar, que lleva esta factura. */
export interface PagoConLaFactura {
  allocation_id: string;
  /** El día en que sale (`YYYY-MM-DD`). */
  fecha: string;
  /** Folio del pago (`261128-01-03`); null mientras el día no se autoriza. */
  folio: string | null;
  autorizado: boolean;
}

export interface FacturaFueraDeNorma {
  /** Como está en `fiscal.cfdis` (en prod, en mayúsculas). */
  uuid: string;
  emisor_rfc: string;
  emisor_nombre: string | null;
  serie_folio: string | null;
  /** Día de emisión en México (`YYYY-MM-DD`), leído según su descarga. */
  fecha: string;
  total: number;
  metodo_pago: string | null;
  forma_pago: string | null;
  receptor_uso_cfdi: string | null;
  receptor_regimen: string | null;
  /** Todo lo que dice la norma al pagarla hoy, del más severo al aviso (también lo que no se autoriza). */
  motivos: MotivoNorma[];
  /** Las reglas que piden decisión y todavía no la tienen. Vacío = ya está decidida en todo lo que pide. */
  por_decidir: ReglaNorma[];
  decisiones: DecisionTomada[];
  /** Pagos pendientes del Calendario con esta factura, el más próximo primero. */
  pagos: PagoConLaFactura[];
}

export interface BandejaFueraDeNorma {
  /** Desde qué día se listan las facturas sin pago programado (las que están en un pago, de cualquier fecha). */
  desde: string;
  /** Primero las que ya están en un pago (el más próximo primero); luego la más nueva. */
  por_decidir: FacturaFueraDeNorma[];
  /** Decididas en todo lo que piden; la decisión más nueva primero. */
  decididas: FacturaFueraDeNorma[];
  /** Cuándo se leyó (ISO), para la edad del dato. */
  leido_en: string;
}

export interface DecidirNormaDto {
  regla: ReglaNorma;
  decision: DecisionNorma;
  /** De 3 a 300 caracteres; queda para todos. */
  motivo: string;
}

export interface RevocarDecisionNormaDto {
  /** Por qué se revoca, de 3 a 300 caracteres. */
  motivo: string;
}

// ─── El armado (puro: lo usa el servidor y lo prueban las unitarias) ─────────────────────────────

/** Una recibida tipo I como la lee la bandeja: lo que pide la regla más lo que se muestra. */
export interface CfdiDeLaBandeja extends CfdiParaNorma {
  emisor_nombre: string | null;
  serie_folio: string | null;
  /** Día de emisión (`YYYY-MM-DD`). */
  fecha: string;
  total: number;
}

/** Las facturas sin pago programado se listan desde el 1-ene del año anterior (las de un pago, de cualquier fecha). */
export function desdeDeLaBandeja(hoy: string): string {
  return `${Number(hoy.slice(0, 4)) - 1}-01-01`;
}

/**
 * `[PGP.229]` **La bandeja, sobre lo leído.** Una factura entra si alguna regla le pide decisión (S01, régimen) o si
 * ya tiene una decisión viva; lo demás (el IMSS, la comisión del banco, el traslado, la que no dice régimen) no.
 * La norma se calcula como al pagarla: contra el pago más próximo, o contra hoy si no está en ninguno.
 */
export function armarBandejaFueraDeNorma(e: {
  cfdis: readonly CfdiDeLaBandeja[];
  /** Por UUID en minúsculas. */
  decisiones: ReadonlyMap<string, readonly DecisionTomada[]>;
  /** Por UUID en minúsculas. */
  pagos: ReadonlyMap<string, readonly PagoConLaFactura[]>;
  hoy: string;
  leido_en: string;
}): BandejaFueraDeNorma {
  const porDecidir: FacturaFueraDeNorma[] = [];
  const decididas: FacturaFueraDeNorma[] = [];
  const vistas = new Set<string>();
  for (const c of e.cfdis) {
    const llave = String(c.uuid).trim().toLowerCase();
    if (vistas.has(llave)) continue;
    vistas.add(llave);
    const decisiones = [...(e.decisiones.get(llave) ?? [])];
    const pagos = [...(e.pagos.get(llave) ?? [])].sort((a, b) => a.fecha.localeCompare(b.fecha));
    const norma = normaFiscalDelCfdi({
      cfdi: c, uso: 'pago', fecha_operacion: pagos[0]?.fecha ?? e.hoy, hoy: e.hoy,
      autorizaciones: decisiones.map((d) => ({ regla: d.regla, decision: d.decision, por: d.por })),
    });
    const pendientes = norma.motivos.filter((m) => m.veredicto === 'requiere_autorizacion').map((m) => m.regla);
    if (!pendientes.length && !decisiones.length) continue;
    const fila: FacturaFueraDeNorma = {
      uuid: c.uuid, emisor_rfc: String(c.emisor_rfc ?? '').trim().toUpperCase(), emisor_nombre: c.emisor_nombre, serie_folio: c.serie_folio,
      fecha: c.fecha, total: Number(c.total), metodo_pago: c.metodo_pago, forma_pago: c.forma_pago,
      receptor_uso_cfdi: c.receptor_uso_cfdi, receptor_regimen: c.receptor_regimen,
      motivos: norma.motivos, por_decidir: pendientes, decisiones, pagos,
    };
    (pendientes.length ? porDecidir : decididas).push(fila);
  }
  // Primero lo que ya está en un pago (el que sale antes); luego la más nueva.
  porDecidir.sort((a, b) => {
    const pa = a.pagos[0]?.fecha ?? '';
    const pb = b.pagos[0]?.fecha ?? '';
    if (pa && pb && pa !== pb) return pa.localeCompare(pb);
    if (!!pa !== !!pb) return pa ? -1 : 1;
    return b.fecha.localeCompare(a.fecha) || a.uuid.localeCompare(b.uuid);
  });
  const ultima = (f: FacturaFueraDeNorma) => f.decisiones.reduce((m, d) => (d.cuando > m ? d.cuando : m), '');
  decididas.sort((a, b) => ultima(b).localeCompare(ultima(a)) || a.uuid.localeCompare(b.uuid));
  return { desde: desdeDeLaBandeja(e.hoy), por_decidir: porDecidir, decididas, leido_en: e.leido_en };
}
