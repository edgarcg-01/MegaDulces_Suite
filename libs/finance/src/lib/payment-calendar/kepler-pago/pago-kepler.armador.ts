import { clabeDeTexto } from '@megadulces/contracts/finance/clabe';
import { movimientosDePoliza, type MovimientoCuenta, type PolizaKepler } from '../../shared/kepler-contable';

/**
 * `[PGP.71]` — **El pago `X-D-26` en el idioma de Kepler, armado sin tocar Kepler.**
 *
 * Plan: [`FASE_PGP_PAGO_A_PROVEEDOR.md`](../../../../../../docs/IMPLEMENTACION/FASES/FASE_PGP_PAGO_A_PROVEEDOR.md)
 * §4 «C0 de O3 re-medido (2026-11-04)». Todo lo que está aquí sale de medir 471 pagos por
 * transferencia de oficinas (`00`, agosto–noviembre 2026) en `kepler_ods`; cada regla trae su cifra.
 *
 * Es la capa C1: funciones puras. Quien escribe (el adapter de C2) lee lo vivo de Kepler —la
 * plantilla, el saldo de cada factura, el proveedor— y le pasa aquí los datos; esto devuelve QUÉ
 * escribir en cada tabla o POR QUÉ no se puede. Sin base de datos a propósito: un doble de Knex no
 * ejecuta SQL, y la regla se prueba sola en `pago-kepler.armador.spec.ts`.
 *
 * ── Lo que escribe un pago (medido) ─────────────────────────────────────────────────────────
 *
 * | Tabla | Qué | Cómo |
 * |---|---|---|
 * | `md.kdm1` | el documento `X-D-26` | se CLONA una plantilla y se pisan los campos de abajo |
 * | `md.kdxe` | su renglón de cuentas por pagar (`c3='D'`) | se clona el de la plantilla |
 * | `md.kdxf` | una aplicación por factura | se construye: 11 columnas, todas conocidas |
 * | `md.kdxe` | ⛔ el SALDO de cada factura (`c20`) | **UPDATE** `c20 = c20 − aplicado` |
 * | `md.kdm5` | un renglón por factura (`[PGP.106]`) | se construye: sus 14 columnas |
 * | `md.kdc2AAMM` | la póliza `E` del mes (`[PGP.106]`) | se CLONA el renglón de la póliza de la plantilla |
 * | `md.kdxg` | acumulado del acreedor (`[PGP.106]`) | **UPDATE** abonos del mes + fechas |
 * | `md.kdc126` | acumulado de 201 y 102 (`[PGP.106]`) | **UPDATE** cargos/abonos del mes, los dos juegos |
 *
 * ⛔⛔ La cuarta fila es la que el plan del 22-oct no tenía: Kepler **guarda** el saldo de la
 * factura en `kdxe.c20` (2,072 de 2,081 facturas abiertas lo traen igual a importe − aplicado;
 * control placebo contra otra factura del mismo acreedor: 45 de 1,223). Escribir el pago sin bajar
 * ese saldo deja la factura debiéndose en Kepler aunque el pago exista. Por eso el permiso que se
 * pide incluye `UPDATE (c20)` sobre `md.kdxe`.
 *
 * ⚠️ Lo que NO se pudo derivar se DECLARA, no se inventa:
 *  - `c86` (últimos dígitos de la cuenta destino): no hay CLABE de proveedor en el ODS y el banco
 *    no la repite (5 de 402 descripciones). Se escribe vacío, que Kepler ya acepta (lo trae vacío
 *    en el pago de factoraje medido). Pregunta abierta a Tesorería.
 *  - Facturas con conceptos distintos (`c12`): 64 de 471 pagos; Kepler elige uno y en 31 de esos
 *    64 no es el de la factura mayor. Aquí se RECHAZA y se pide partir el pago.
 */

/** Quién capturó (`kdm1.c67`): lo escribió la Suite, no una persona. Mismo valor que la requisición (`[KR.17]`). */
export const CAPTURISTA_SUITE = 'SUITE';
/** La cuenta de tesorería de Caja General (`c45 = '0011'`). El efectivo espera el dictamen de Contabilidad (D1). */
export const C45_CAJA_GENERAL = '0011';

/**
 * `c12` (concepto del catálogo `kdxv`) → `c48` (la sucursal en texto). Kepler la captura a mano y
 * con dedazos («PADRE GODALGO», «MORELIA ABASTODS»); medido sobre 471 pagos: C-001 → CEDIS en 254,
 * C-002 → PADRE HIDALGO en 35, C-010 → MORELIA ABASTOS en 83, C-020 → CANINDO en 42, C-003 → 8 ESQUINAS
 * en 10. C-004, C-005, C-011 y C-021 casi no aparecen: su nombre sale del propio `kdxv`.
 */
export const SUCURSAL_DEL_CONCEPTO: Readonly<Record<string, string>> = Object.freeze({
  'C-001': 'CEDIS',
  'C-002': 'PADRE HIDALGO',
  'C-003': '8 ESQUINAS',
  'C-004': 'LA PIEDAD ABASTOS',
  'C-005': 'YURECUARO',
  'C-010': 'MORELIA ABASTOS',
  'C-011': 'MORELIA MADERO',
  'C-020': 'CANINDO',
  'C-021': 'ZAMORA CENTRO',
});

/** Una factura que el pago salda, con lo que Kepler tiene HOY de ella (lo lee el adapter en vivo). */
export interface FacturaAPagar {
  /** `kdxe.c1`: el almacén. ⚠️ En las tablas de detalle `c1` es el almacén, no la sucursal. */
  almacen: string;
  /** `kdxe.c4` / `c5` / `c6`: tipo, subtipo y folio del documento que sube la deuda (`c3='A'`). */
  tipo: number;
  subtipo: number;
  folio: string;
  /** `kdxe.c18`: el concepto del catálogo `kdxv` (`C-001`…). */
  concepto: string;
  /** `kdxe.c20`: el saldo vivo. */
  saldo: number;
  /** `kdxe.c16`: la referencia de la factura (`0-F9760`), que el pago repite en su renglón `kdm5.c14` (511 de 524). */
  referencia: string;
  /** Lo que este pago le aplica. */
  aplicado: number;
  /** `kdm1.c14` / `c15` / `c16` de la factura: IVA, IEPS y total, para el IVA proporcional. */
  iva: number;
  ieps: number;
  total: number;
}

/** El acreedor, con sus datos fiscales del último `X-D-26` suyo (98.9 % igual) o, si no hay, de `kdxd`. */
export interface ProveedorKepler {
  /** `kdxd.c2` = `kdm1.c10`. Sólo proveedores de compra (`C…`): el alcance de D1. */
  codigo: string;
  rfc: string;
  nombre: string;
  /** `kdm1.c33` / `c34` / `c35`: domicilio, como lo escribió el pago anterior. */
  domicilio: [string, string, string];
  /** `kdxd.c16`: días de crédito → `kdm1.c17` (463 de 471). `null` si no se conoce. */
  dias: number | null;
}

export interface PagoKeplerEntrada {
  /** El servidor (`md_NN`). Cada sucursal paga en el suyo: los nueve tienen su serie `XD2601-`. */
  sucursal: string;
  /** `YYYY-MM-DD`: el día en que el banco confirmó el pago. */
  fecha: string;
  /** `HH:MM`, hora de México (`kdm1.c69`). */
  hora: string;
  /** `kdm1.c11` = `kdxe.c16` (471 de 471): la referencia. La Suite pone su folio del pago. */
  referencia: string;
  importe: number;
  /** `kdm1.c45` = `kdxe.c22` (471 de 471): la cuenta de tesorería de `kdb1` por la que salió. */
  cuentaTesoreria: string;
  /** El destino como lo preparó Tesorería (texto libre con la CLABE). */
  destino: string | null;
  proveedor: ProveedorKepler;
  facturas: FacturaAPagar[];
}

type Valor = string | number;

export interface PlanPagoKepler {
  /** Columnas que se pisan en el clon de la plantilla `kdm1` (el folio `c6` lo pone el adapter, `MAX+1`). */
  kdm1: Record<string, Valor>;
  /** Columnas que se pisan en el clon del renglón `kdxe` de la plantilla (sin `c6`). */
  kdxe: Record<string, Valor>;
  /** Las aplicaciones `kdxf`, completas salvo `c6` (el folio del pago). */
  kdxf: Record<string, Valor>[];
  /** Cuánto baja el saldo (`kdxe.c20`) de cada factura. El adapter exige `c20 >= menos` en el mismo UPDATE. */
  saldos: { almacen: string; acreedor: string; tipo: number; subtipo: number; folio: string; menos: number }[];
  /** `[PGP.106]` Un renglón `kdm5` por factura, completos salvo `c6` (el folio del pago). Las 14 columnas de la tabla. */
  kdm5: Record<string, Valor>[];
  /**
   * `[PGP.106]` La póliza `E` del pago: un cargo `201` por factura (renglones 1..N) y el abono `102` por el total
   * (renglón N+1), con el nombre del acreedor y la referencia del pago. Medido: 131 de 131 pagos de octubre.
   */
  poliza: PolizaKepler;
  /** `[PGP.106]` Lo que el pago suma a los acumulados: el del acreedor (`kdxg`) y el de cada cuenta (`kdc126`). */
  acumulados: { anio: number; mes: number; acreedor: string; abonoAcreedor: number; cuentas: MovimientoCuenta[] };
}

/** `[PGP.106]` Las cuentas de la póliza del pago a proveedor (131 de 131 en octubre). */
export const CUENTA_PROVEEDORES = '201';
export const CUENTA_BANCOS = '102';

export type ResultadoArmado = { ok: true; plan: PlanPagoKepler } | { ok: false; motivos: string[] };

/**
 * `[PGP.111]` P8 (Edgar, 2026-11-10): la factura de GASTO (`10-1`) de un acreedor de compra no trae concepto, y Tesorería
 * le pone `007` «GASTOS GENERALES» (40 de 43 pagos en 120 días, medido 2026-11-10). ⚠️ Pendiente de que Contabilidad
 * lo confirme: el ensayo lo avisa.
 */
export const CONCEPTO_GASTOS_GENERALES = '007';
/** El concepto (`c12`) con el que se paga UNA factura: el suyo (`kdxe.c18`, P6: manda la factura); sin él, si es de gasto, `007` (P8). */
export function conceptoDeFactura(f: Pick<FacturaAPagar, 'concepto' | 'tipo'>): string {
  const c = (f.concepto ?? '').trim();
  return c || (Number(f.tipo) === 10 ? CONCEPTO_GASTOS_GENERALES : '');
}

const r2 = (v: number): number => Math.round(v * 100) / 100;
const CENTAVO = 0.005;

/**
 * El IVA y el IEPS que el pago cubre, como los guarda Kepler: proporcionales a lo aplicado de cada
 * factura. Medido en 471 de 471 pagos (170 con IVA distinto de cero): `c81` es el IVA redondeado a
 * centavos, `c82` el mismo sin redondear (casa a 0.0001) y `c84` el IEPS.
 */
export function ivaProporcional(facturas: Pick<FacturaAPagar, 'aplicado' | 'iva' | 'ieps' | 'total'>[]): { c81: number; c82: number; c84: number } {
  let iva = 0, ieps = 0;
  for (const f of facturas) {
    if (!(f.total > 0)) continue;
    iva += f.aplicado * (f.iva / f.total);
    ieps += f.aplicado * (f.ieps / f.total);
  }
  // `c82` sin redondear a centavos, pero sin el ruido del punto flotante: Kepler guarda hasta 10
  // decimales (`516.8179558203`, `26338.261978402`).
  return { c81: r2(iva), c82: Math.round(iva * 1e10) / 1e10, c84: r2(ieps) };
}

/** Arma el pago o dice, con todas sus letras, por qué no se puede. Fail-closed: un motivo basta. */
export function armarPagoKepler(e: PagoKeplerEntrada): ResultadoArmado {
  const motivos: string[] = [];
  const prov = e.proveedor;

  if (!/^\d{2}$/.test(e.sucursal)) motivos.push(`Sucursal Kepler inválida «${e.sucursal}»`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.fecha)) motivos.push(`Fecha inválida «${e.fecha}»`);
  if (!/^C/.test(prov.codigo ?? '')) motivos.push(`El acreedor ${prov.codigo || '(vacío)'} no es un proveedor de compra (C…): por ahora sólo se escriben ésos`);
  const c45 = (e.cuentaTesoreria ?? '').trim();
  if (!c45) motivos.push('Sin cuenta de tesorería de Kepler (kdm1.c45): no se sabe de qué banco salió');
  else if (c45 === C45_CAJA_GENERAL) motivos.push('Sale de Caja General: el efectivo espera el dictamen de Contabilidad (D1)');
  if (!e.facturas.length) motivos.push('El pago no salda ninguna factura');

  for (const f of e.facturas) {
    const id = `${f.tipo}-${f.subtipo}-${f.folio}`;
    if (f.almacen !== e.sucursal) motivos.push(`La factura ${id} es del almacén ${f.almacen} y el pago se escribe en el servidor ${e.sucursal}`);
    if (!(f.aplicado > 0)) motivos.push(`La factura ${id} no recibe nada de este pago`);
    if (f.aplicado > f.saldo + CENTAVO) motivos.push(`La factura ${id} debe ${f.saldo.toFixed(2)} en Kepler y el pago le aplica ${f.aplicado.toFixed(2)}`);
  }
  const suma = e.facturas.reduce((s, f) => s + f.aplicado, 0);
  if (Math.abs(suma - e.importe) > CENTAVO) motivos.push(`El importe del pago (${e.importe.toFixed(2)}) no es la suma de lo aplicado (${suma.toFixed(2)})`);
  // `[PGP.106]` La póliza carga cada factura a centavos y abona el total a centavos: si los redondeos no suman lo
  // mismo, la póliza de Kepler quedaría descuadrada. No se escribe.
  else if (Math.round(e.facturas.reduce((s, f) => s + Math.round(f.aplicado * 100), 0)) !== Math.round(e.importe * 100)) {
    motivos.push(`Lo aplicado a cada factura, a centavos, no suma el importe del pago (${e.importe.toFixed(2)}): la póliza quedaría descuadrada`);
  }

  const conceptos = [...new Set(e.facturas.map(conceptoDeFactura))];
  if (conceptos.length > 1) motivos.push(`Las facturas traen conceptos distintos (${conceptos.join(', ')}) y Kepler pide uno por pago: pártelo en un pago por concepto`);
  const concepto = conceptos[0] ?? '';
  if (conceptos.length === 1 && !concepto) motivos.push('La factura no trae concepto (kdxe.c18): Kepler no sabría a qué sucursal cargar la compra');

  if (motivos.length) return { ok: false, motivos };

  const clabe = clabeDeTexto(e.destino);
  const { c81, c82, c84 } = ivaProporcional(e.facturas);
  const importe = r2(e.importe);
  // La póliza: el nombre y la referencia son los del documento (`kdm1.c32` / `c11`), igual en los N+1 renglones.
  const asiento = (c10: number, c3: string, c4: 'C' | 'A', monto: number): Record<string, Valor> =>
    ({ c10, c3, c4, c5: monto, c9: monto, c6: prov.nombre, c7: e.referencia, c14: e.sucursal, c23: '0' });
  const poliza: PolizaKepler = {
    tipo: 'E', fecha: e.fecha,
    renglones: [
      ...e.facturas.map((f, i) => asiento(i + 1, CUENTA_PROVEEDORES, 'C', r2(f.aplicado))),
      asiento(e.facturas.length + 1, CUENTA_BANCOS, 'A', importe),
    ],
  };

  return {
    ok: true,
    plan: {
      kdm1: {
        c9: e.fecha, c68: e.fecha, c69: e.hora, c67: CAPTURISTA_SUITE,
        c10: prov.codigo, c22: prov.rfc, c32: prov.nombre,
        c33: prov.domicilio[0], c34: prov.domicilio[1], c35: prov.domicilio[2],
        c11: e.referencia, c12: concepto, c48: SUCURSAL_DEL_CONCEPTO[concepto] ?? '',
        c16: importe, c42: importe, c43: 'N', c45: c45, c31: 'Tra',
        ...(prov.dias == null ? {} : { c17: prov.dias }),
        c81, c82, c84,
        // El código de banco es lo que la CLABE dice por definición (3 primeros dígitos, ABM).
        c85: clabe ? clabe.slice(0, 3) : '', c86: '',
        c19: '', c20: '', c24: '',
      },
      kdxe: {
        c2: prov.codigo, c7: e.fecha, c11: importe, c17: importe, c16: e.referencia, c18: concepto, c20: 0, c22: c45,
      },
      kdxf: e.facturas.map((f) => ({
        c1: e.sucursal, c2: prov.codigo, c3: e.fecha, c4: 26, c5: 1,
        c7: f.tipo, c8: f.subtipo, c9: f.folio, c10: r2(f.aplicado), c11: r2(f.aplicado),
      })),
      saldos: e.facturas.map((f) => ({ almacen: f.almacen, acreedor: prov.codigo, tipo: f.tipo, subtipo: f.subtipo, folio: f.folio, menos: r2(f.aplicado) })),
      kdm5: e.facturas.map((f, i) => ({
        c1: e.sucursal, c2: 'X', c3: 'D', c4: 26, c5: 1, c7: i + 1,
        c8: 'A', c9: f.tipo, c10: f.subtipo, c11: f.folio, c12: r2(f.aplicado), c13: r2(f.aplicado), c14: (f.referencia ?? '').trim(),
      })),
      poliza,
      acumulados: {
        anio: Number(e.fecha.slice(0, 4)), mes: Number(e.fecha.slice(5, 7)),
        acreedor: prov.codigo, abonoAcreedor: importe, cuentas: movimientosDePoliza(poliza),
      },
    },
  };
}

/** Un `X-D-26` de un pago partido por concepto. */
export interface PlanPorConcepto { concepto: string; importe: number; facturas: string[]; plan: PlanPagoKepler }
export type ResultadoArmadoVarios = { ok: true; planes: PlanPorConcepto[] } | { ok: false; motivos: string[] };

/**
 * `[PGP.111]` P7 (Edgar, 2026-11-10): **un pago con facturas de varias sucursales sale como un `X-D-26` por concepto.**
 * Kepler pide un concepto por documento y ya admite UNA transferencia capturada como varios documentos (medido en
 * `[PGP.97]`: el banco se parea con «varios documentos» del mismo acreedor y cuenta, ±1 día). Antes se rechazaba
 * («pártelo»), y Tesorería, a mano, ponía `C-001` en 61 de 95 (cargaba a CEDIS compras de otras sucursales).
 * Cada documento lleva el importe de SUS facturas y la misma referencia; con un solo concepto es exactamente
 * `armarPagoKepler`. Un motivo de cualquiera de las partes detiene todas: no se escribe medio pago.
 */
export function armarPagosKepler(e: PagoKeplerEntrada): ResultadoArmadoVarios {
  const grupos = new Map<string, FacturaAPagar[]>();
  for (const f of e.facturas) {
    const c = conceptoDeFactura(f);
    grupos.set(c, [...(grupos.get(c) ?? []), f]);
  }
  if (grupos.size <= 1) {
    const r = armarPagoKepler(e);
    if (!r.ok) return r;
    return { ok: true, planes: [{ concepto: String(r.plan.kdm1['c12']), importe: r2(e.importe), facturas: e.facturas.map((f) => `${f.tipo}-${f.subtipo}-${f.folio}`), plan: r.plan }] };
  }
  const suma = e.facturas.reduce((s, f) => s + f.aplicado, 0);
  if (Math.abs(suma - e.importe) > CENTAVO) {
    return { ok: false, motivos: [`El importe del pago (${e.importe.toFixed(2)}) no es la suma de lo aplicado (${suma.toFixed(2)})`] };
  }
  const planes: PlanPorConcepto[] = [];
  const motivos: string[] = [];
  for (const [concepto, facturas] of [...grupos].sort(([a], [b]) => a.localeCompare(b))) {
    const importe = r2(facturas.reduce((s, f) => s + f.aplicado, 0));
    const r = armarPagoKepler({ ...e, importe, facturas });
    if (!r.ok) { motivos.push(...r.motivos.map((m) => `${concepto || '(sin concepto)'}: ${m}`)); continue; }
    planes.push({ concepto, importe, facturas: facturas.map((f) => `${f.tipo}-${f.subtipo}-${f.folio}`), plan: r.plan });
  }
  return motivos.length ? { ok: false, motivos } : { ok: true, planes };
}

/** Lo que la Suite sabe del pago, para decidir si se puede escribir en Kepler (E3.3). */
export interface PagoSuite {
  status: string;
  payment_method: string | null;
  /** `finance.bank_accounts.kind` de la cuenta de origen. */
  origen_kind: string | null;
  /** `payment_allocations.kepler_payment_folio`: ya ligado a un `X-D-26` (escrito o capturado a mano). */
  kepler_payment_folio: string | null;
  lot_status: string;
  items: { obligation_source: string; branch_code: string | null; kepler_saldada?: boolean | null }[];
  /**
   * `[PGP.104]` El estado de `validarPagos` (`[PGP.103]`): F2 de Edgar (2026-11-09) — a Kepler sólo va
   * lo que prueban el estado de cuenta Y el comprobante. Null = no se validó.
   */
  validacion_estado: string | null;
  /**
   * `[PGP.121]` Edgar, 2026-11-13: **el banco dispara**. Un pago que el estado de cuenta probó (`paid_bank_movement_id`)
   * ya no necesita el día autorizado ni la validación con comprobante: la salida del banco es el hecho.
   */
  probado_por_el_banco?: boolean;
}

const LOTES_FIRMADOS = new Set(['released', 'executing', 'closed']);

/**
 * `[PGP.71]` E3.3 — **No se escribe a Kepler lo que no esté autorizado y marcado pagado.** Devuelve
 * los motivos; vacío = se puede. Va aparte del armador porque es una regla de la Suite (estado del
 * pago) y aquélla es una regla de Kepler (forma del documento).
 */
export function motivosParaNoEscribir(p: PagoSuite): string[] {
  const m: string[] = [];
  if (!p.probado_por_el_banco && !LOTES_FIRMADOS.has(p.lot_status)) m.push('El día no está autorizado');
  if (p.status !== 'executed') m.push('El pago no está marcado como pagado');
  if (!p.probado_por_el_banco && p.validacion_estado !== 'validado') m.push('El pago no está validado con el estado de cuenta y su comprobante');
  if (p.payment_method !== 'transferencia') m.push('Por ahora sólo se escriben transferencias (D1)');
  if (p.origen_kind !== 'bank') m.push('La cuenta de origen no es una cuenta bancaria');
  if (p.kepler_payment_folio) m.push(`Ya está ligado al pago ${p.kepler_payment_folio} de Kepler: escribirlo otra vez lo duplicaría`);
  if (!p.items.length) m.push('El pago no tiene facturas');
  if (p.items.some((i) => i.obligation_source !== 'kepler_payable')) m.push('Trae renglones que no son facturas de Kepler');
  if (new Set(p.items.map((i) => i.branch_code)).size > 1) m.push('Trae facturas de más de una sucursal: cada sucursal paga en su servidor');
  if (p.items.some((i) => i.kepler_saldada)) m.push('Kepler ya no debe alguna de sus facturas');
  return m;
}

/**
 * `[PGP.71]` E3.5 — **El interruptor.** Apagado salvo que diga exactamente `encendida`: una variable
 * vacía, mal escrita o ausente deja la escritura APAGADA. Es el cuarto candado; los otros tres son el
 * `GRANT` en Kepler, la conexión `KEPLER_PUSH_URL_NN` y este estado del pago.
 */
export function escrituraDePagoEncendida(env: Readonly<Record<string, string | undefined>>): boolean {
  return (env['KEPLER_PAGO_ESCRITURA'] ?? '').trim() === 'encendida';
}
