/**
 * `[PGP.97]` **Lo que salió del banco a un proveedor, contra Kepler y contra el programa de pagos.**
 *
 * Pedido de Francisco (2026-11-07): *«utiliza el workbook de bancos para identificar lo que se pagó
 * fuera de programa y está pendiente de elaborar el pago en Kepler, para que sirva de guía al área
 * de pagos a proveedor; la meta es que el 100 % de los pagos pasen por el programa de pagos»*.
 *
 * Para cada salida del workbook (`finance.bank_movements`) que es pago a proveedor, esta regla
 * contesta dos preguntas y las cruza:
 *
 * |                       | ya está en Kepler          | falta en Kepler                      |
 * |-----------------------|----------------------------|--------------------------------------|
 * | **pasó por el programa** | el cierre normal (`[PGP.94]`) | lo que O3 va a escribir solo         |
 * | **fuera del programa**   | lo que se regulariza       | ⭐ **la guía**: elaborar el pago en Kepler |
 *
 * Todo lo que sigue se midió en prod (sólo lectura) el 2026-11-07, octubre completo, con control
 * placebo; los scripts viven fuera del repo (`C:\DEV\_tmp\pgp97\`), las cifras con nombres no.
 *
 * - **Qué salida es pago a proveedor** ({@link esSalidaAProveedor}): la columna M del libro que
 *   Tesorería teclea (`raw_type = 'C'`), el código 510/501 o la categoría `compra_mercancia`.
 *   Contra un pago `X-D` de acreedor `C%` en Kepler: 98.0 % de precisión, 97.6 % de cobertura;
 *   con las fechas corridas 35 días casa 0 de 244.
 * - **El par salida ↔ pago de Kepler** ({@link parear}): misma cuenta de tesorería, ±$1, ±5 días,
 *   uno a uno. 239 de 244; 231 el mismo día. Placebo −35/−60/+35 días: 0 de 244. La tolerancia de
 *   $1 no es holgura: 52 de 241 pagos difieren del banco por centavos (máximo $0.21).
 * - **Una transferencia, varios documentos**: Kepler a veces captura UNA transferencia como un
 *   documento por sucursal (8 de un mismo acreedor sumaban $6,400.03 contra $6,400.00 del banco) o
 *   como transferencia más anticipo. Esos se parean juntos (misma cuenta, mismo acreedor, ±1 día).
 * - **Otra cuenta** (±$1, ±3 días, cualquier cuenta): 259 de 264 contra 4–6 de 264 del placebo.
 *   Con ~2 % de ruido de fondo sirve para **proponer** «corregir la cuenta en Kepler», no para
 *   afirmarlo solo.
 * - **Cuánto esperar antes de decir «falta»** ({@link ESPERA_CAPTURA_DIAS}): de la fecha del pago
 *   a su captura en Kepler (`kdm1.c68`), p50 2 días, p90 6, **p95 7**.
 * - **«Pasó por el programa»** ({@link estadoPrograma}): alguna factura que el pago saldó (`kdxf`)
 *   estaba en una partida del Calendario para ese día ±3, dada de alta a más tardar ese día y
 *   VIGENTE EL DÍA DEL PAGO. 49 contra 4 (Calendario corrido 7 días) y 0 (+7). ⛔ Que hoy esté
 *   cancelada no la saca: Tesorería cancela lo que Kepler ya pagó («quitar lo saldado», `[PGP.51]`)
 *   y eso NO es «se quitó del programa».
 * - **A quién se le pagó**, cuando Kepler todavía no lo dice ({@link sugerirAcreedor}): nombre e
 *   importe juntos («fuerte») 126 de 126 contra 1 de 289 con el placebo; una sola señal («débil»)
 *   acierta 82 %.
 *
 * ⛔ **Un renglón «falta» es una guía, no una orden de capturar.** El motor de conciliación dejaba
 * 7 de 12 salidas «sin casar» que sí tenían su pago en Kepler: usarlo de guía pedía capturar dos
 * veces. Esta regla parea por su cuenta contra lo que Kepler tiene HOY.
 *
 * ⛔ Lo que no se pudo medir se DECLARA (ADR-056): días sin estado de cuenta cargado, días sin
 * movimientos, fechas imposibles y cuentas sin puente a Kepler salen como `no_medido`, nunca como
 * «0 pendientes» ni como «captura doble».
 */

// ─── Constantes medidas ─────────────────────────────────────────────────────────────────────────

/** ±$1 entre el banco y el pago de Kepler: 52 de 241 difieren por centavos; placebo 0 de 244. */
export const TOLERANCIA_IMPORTE = 1;
/** Ventana del par en la misma cuenta: 231 de 239 caen el mismo día, el resto entre −1 y +2. */
export const VENTANA_MISMA_CUENTA_DIAS = 5;
/** Ventana del par en otra cuenta, más corta porque ahí hay ~2 % de ruido de fondo. */
export const VENTANA_OTRA_CUENTA_DIAS = 3;
/** Ventana para juntar varios documentos de Kepler de UNA transferencia (mismo acreedor y cuenta). */
export const VENTANA_VARIOS_DOCUMENTOS_DIAS = 1;
/** Tope de documentos que se prueban juntos (8 por sucursal es el máximo visto). */
export const TOPE_VARIOS_DOCUMENTOS = 10;
/** Días desde la salida antes de decir «falta en Kepler»: el p95 de la captura (`c68 − c7`). */
export const ESPERA_CAPTURA_DIAS = 7;
/** Holgura entre el día programado y el día del pago para decir «pasó por el programa». */
export const HOLGURA_PROGRAMA_DIAS = 3;
/** Sin pago en Kepler, una partida por el mismo importe en esta ventana es indicio de programa (6/6, placebo 0). */
export const VENTANA_PROGRAMA_POR_IMPORTE_DIAS = 7;
/** Un envío devuelto: abono `DS` del mismo importe en la misma cuenta, de 0 a 1 día después. */
export const VENTANA_DEVUELTO_DIAS = 1;
/**
 * Un pago de Kepler sólo se declara «sin salida en el banco» si el workbook de su cuenta llega por
 * lo menos estos días DESPUÉS de su fecha: el banco puede cargarlo uno o dos días tarde. Medido
 * sep–oct: con 0 días quedaban 35 pagos ($6.3 M) como falsos «sin salida»; con 3, ninguno de ese tipo.
 */
export const MARGEN_SIN_SALIDA_DIAS = 3;
/**
 * Hasta dónde una diferencia contra el pago del acreedor ese día es «corregir el importe» (el caso
 * medido: $300 de $42,558, 0.7 %). Más allá no se propone corregir: se avisa que no cuadra.
 * ⚠️ NO MEDIDO como precisión: hay un solo caso de corrección real en octubre.
 */
export const DIFERENCIA_CORREGIBLE_PCT = 2;

// ─── Entradas ───────────────────────────────────────────────────────────────────────────────────

/** Una salida viva del workbook de bancos (`finance.bank_movements`, `amount_out > 0`). */
export interface SalidaBancaria {
  id: string;
  cuenta_id: string;
  /** Cómo la conoce Tesorería (`bank_accounts.alias`). */
  cuenta: string;
  /** El puente a la cuenta de tesorería de Kepler (`analytics.kepler_bank_movements.account_label`). */
  account_label: string | null;
  fecha: string;
  importe: number;
  /** Columna M del libro: la que marca el pago a proveedor (`'C'`). */
  raw_type: string | null;
  /** Columna C del libro (`'510'` = transferencia a tercero). */
  raw_code: string | null;
  /** `finance.movement_categories.code`. */
  categoria: string | null;
  concepto: string | null;
}

/** Un abono del workbook; sólo interesan los `DS` (envío devuelto). */
export interface AbonoBancario { id: string; cuenta_id: string; fecha: string; importe: number; raw_type: string | null }

/** Un pago con dinero de Kepler (`X-D-25/26/60` vigente) visto desde tesorería. */
export interface PagoKeplerBanco {
  /** `sucursal|doc_tipo|folio`: única en 2026 (0 de 28,566 repetidas). */
  id: string;
  sucursal: string;
  /** `'X-D-26'`. */
  doc_tipo: string;
  folio: string;
  account_label: string | null;
  /** El nombre de la cuenta de tesorería en Kepler (`kdb1`): «SANTANDER 2169», «DEVOLUCIONES», «FACTORAJE»… */
  banco_nombre: string | null;
  /** `kdb1`: `banco`, `caja` o `puente`. */
  tipo_cuenta: string | null;
  /** Fecha valor (`kdm1.c9`). */
  fecha: string;
  /** Fecha en que se capturó (`kdm1.c68`). */
  fecha_captura: string | null;
  importe: number;
  acreedor: string | null;
  acreedor_nombre: string | null;
  /** Llaves canónicas (`keplerPayableId`) de las facturas que saldó, por `kdxf`. */
  facturas: string[];
}

/** Una partida (pago) del Calendario con las llaves de sus facturas. */
export interface PartidaDelPrograma {
  id: string;
  /** `payment_allocations.status`. */
  estado: string;
  /** Día del lote. */
  dia: string;
  /** Día en que se dio de alta (hora de México). */
  alta: string;
  /**
   * Día en que se canceló (hora de México), si está cancelada. Sale de `updated_at`: una partida
   * cancelada ya no se puede tocar, así que su última modificación ES la baja. No hay bitácora.
   */
  baja: string | null;
  monto: number;
  facturas: string[];
}

// ─── Fechas ─────────────────────────────────────────────────────────────────────────────────────

/** Días entre dos fechas `YYYY-MM-DD` (b − a). */
export function difDias(a: string, b: string): number {
  return Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

const r2 = (n: number) => Math.round(n * 100) / 100;

// ─── Qué es pago a proveedor ────────────────────────────────────────────────────────────────────

/** La salida la marcó Tesorería como pago a proveedor (regla C ∪ categoría). */
export function esSalidaAProveedor(s: Pick<SalidaBancaria, 'raw_type' | 'raw_code' | 'categoria'>): boolean {
  const m = (s.raw_type ?? '').trim().toUpperCase();
  const c = (s.raw_code ?? '').trim();
  return m === 'C' || c === '510' || c === '501' || s.categoria === 'compra_mercancia';
}

/** Acreedor de compra (mercancía): su código empieza con `C`. Gasto es `G`, financiero `A`. */
export function esAcreedorDeCompra(acreedor: string | null | undefined): boolean {
  return /^C/i.test((acreedor ?? '').trim());
}

/**
 * Las salidas que el banco devolvió (el mismo importe regresó como abono `DS` a la misma cuenta,
 * de 0 a 1 día después). No son pago: salen del universo antes de parear. Medido: 6 en octubre y
 * la foto de noviembre; una de $323 mil se pareaba por error con un pago que en realidad casaba
 * con el reenvío.
 */
export function salidasDevueltas(salidas: readonly SalidaBancaria[], abonos: readonly AbonoBancario[]): Set<string> {
  const out = new Set<string>();
  const ordenadas = [...salidas].sort((a, b) => a.fecha.localeCompare(b.fecha) || a.id.localeCompare(b.id));
  for (const ab of abonos) {
    if ((ab.raw_type ?? '').trim().toUpperCase() !== 'DS' || !(ab.importe > 0)) continue;
    const s = ordenadas.find((x) => !out.has(x.id) && x.cuenta_id === ab.cuenta_id
      && Math.abs(x.importe - ab.importe) < 0.01
      && difDias(x.fecha, ab.fecha) >= 0 && difDias(x.fecha, ab.fecha) <= VENTANA_DEVUELTO_DIAS);
    if (s) out.add(s.id);
  }
  return out;
}

// ─── El par salida ↔ pago(s) de Kepler ──────────────────────────────────────────────────────────

export type ModoPar = 'misma_cuenta' | 'otra_cuenta' | 'varios_documentos';
export interface ParSalidaPago {
  salida_id: string;
  /** Uno, o varios si Kepler capturó la transferencia en varios documentos. */
  pago_ids: string[];
  modo: ModoPar;
  /** Lo que suma Kepler menos lo que salió del banco. */
  dif_importe: number;
  /** Días del pago de Kepler (el primero) contra la salida. */
  dif_dias: number;
}

/** Varios documentos que suman `meta` ±$1 (2 a {@link TOPE_VARIOS_DOCUMENTOS}), el menor número primero. */
function documentosQueSuman(cands: readonly PagoKeplerBanco[], meta: number): PagoKeplerBanco[] | null {
  const it = [...cands].sort((a, b) => b.importe - a.importe || a.id.localeCompare(b.id)).slice(0, 16);
  const r: { mejor: PagoKeplerBanco[] | null } = { mejor: null };
  const elegidos: PagoKeplerBanco[] = [];
  const buscar = (desde: number, suma: number): void => {
    if (elegidos.length >= 2 && Math.abs(suma - meta) <= TOLERANCIA_IMPORTE) {
      if (!r.mejor || elegidos.length < r.mejor.length) r.mejor = [...elegidos];
      return;
    }
    if (elegidos.length >= TOPE_VARIOS_DOCUMENTOS || (r.mejor && elegidos.length + 1 >= r.mejor.length)) return;
    for (let i = desde; i < it.length; i++) {
      if (suma + it[i].importe > meta + TOLERANCIA_IMPORTE) continue;
      elegidos.push(it[i]);
      buscar(i + 1, suma + it[i].importe);
      elegidos.pop();
    }
  };
  buscar(0, 0);
  return r.mejor;
}

/**
 * Parea cada salida con su pago de Kepler (o sus documentos) y cada pago con UNA salida (codicioso).
 *
 * 1. Misma cuenta (±$1, ±5 días); eligen antes las salidas a proveedor, luego gana el menor Δ de
 *    importe y luego el menor Δ de días.
 * 2. Sólo para las salidas a proveedor que quedaron solas: varios documentos del MISMO acreedor en
 *    la misma cuenta, ±1 día, que juntos suman la salida (Kepler la capturó por sucursal, o como
 *    transferencia más anticipo).
 * 3. Sólo para las que siguen solas: cualquier cuenta (±$1, ±3 días): «capturado con la cuenta
 *    equivocada».
 *
 * Se parean TODAS las salidas (no sólo las de proveedor) para que un gasto del mismo importe no le
 * robe el pago a un proveedor ni al revés.
 */
export function parear(salidas: readonly SalidaBancaria[], pagos: readonly PagoKeplerBanco[], devueltas: ReadonlySet<string> = new Set()): Map<string, ParSalidaPago> {
  const pares = new Map<string, ParSalidaPago>();
  const usados = new Set<string>();
  const vivas = salidas.filter((s) => !devueltas.has(s.id));
  const porCuenta = new Map<string, PagoKeplerBanco[]>();
  for (const p of pagos) {
    if (!p.account_label || !(p.importe > 0)) continue;
    const arr = porCuenta.get(p.account_label) ?? [];
    arr.push(p);
    porCuenta.set(p.account_label, arr);
  }

  type Arista = { s: SalidaBancaria; p: PagoKeplerBanco; w: [number, number, number, string, string]; dd: number };
  const tomar = (aristas: Arista[], modo: ModoPar) => {
    aristas.sort((x, y) => x.w[0] - y.w[0] || x.w[1] - y.w[1] || x.w[2] - y.w[2] || x.w[3].localeCompare(y.w[3]) || x.w[4].localeCompare(y.w[4]));
    for (const a of aristas) {
      if (pares.has(a.s.id) || usados.has(a.p.id)) continue;
      pares.set(a.s.id, { salida_id: a.s.id, pago_ids: [a.p.id], modo, dif_importe: r2(a.p.importe - a.s.importe), dif_dias: a.dd });
      usados.add(a.p.id);
    }
  };
  // El importe se descarta ANTES que la fecha: con 92 días, calcular fechas de todos los pares
  // costaba 5.6 s; así, 0.18 s (medido por la revisión, mismos 6,551 pares).
  const arista = (s: SalidaBancaria, p: PagoKeplerBanco, ventana: number): Arista | null => {
    const di = Math.abs(p.importe - s.importe);
    if (di > TOLERANCIA_IMPORTE) return null;
    const dd = difDias(s.fecha, p.fecha);
    if (Math.abs(dd) > ventana) return null;
    return { s, p, dd, w: [esSalidaAProveedor(s) ? 0 : 1, di, Math.abs(dd), s.id, p.id] };
  };

  const misma: Arista[] = [];
  for (const s of vivas) {
    if (!s.account_label) continue;
    for (const p of porCuenta.get(s.account_label) ?? []) { const a = arista(s, p, VENTANA_MISMA_CUENTA_DIAS); if (a) misma.push(a); }
  }
  tomar(misma, 'misma_cuenta');

  // Varios documentos de UNA transferencia.
  const solas = vivas.filter((s) => !pares.has(s.id) && esSalidaAProveedor(s) && s.account_label)
    .sort((a, b) => b.importe - a.importe || a.id.localeCompare(b.id));
  for (const s of solas) {
    const porAcreedor = new Map<string, PagoKeplerBanco[]>();
    for (const p of porCuenta.get(s.account_label as string) ?? []) {
      if (usados.has(p.id) || !p.acreedor || p.importe > s.importe + TOLERANCIA_IMPORTE) continue;
      if (Math.abs(difDias(s.fecha, p.fecha)) > VENTANA_VARIOS_DOCUMENTOS_DIAS) continue;
      const arr = porAcreedor.get(p.acreedor) ?? [];
      arr.push(p);
      porAcreedor.set(p.acreedor, arr);
    }
    for (const acr of [...porAcreedor.keys()].sort()) {
      const docs = documentosQueSuman(porAcreedor.get(acr) as PagoKeplerBanco[], s.importe);
      if (!docs) continue;
      const orden = [...docs].sort((a, b) => a.fecha.localeCompare(b.fecha) || b.importe - a.importe || a.id.localeCompare(b.id));
      pares.set(s.id, {
        salida_id: s.id, pago_ids: orden.map((d) => d.id), modo: 'varios_documentos',
        dif_importe: r2(orden.reduce((t, d) => t + d.importe, 0) - s.importe), dif_dias: difDias(s.fecha, orden[0].fecha),
      });
      for (const d of orden) usados.add(d.id);
      break;
    }
  }

  const otra: Arista[] = [];
  const libres = pagos.filter((p) => !usados.has(p.id) && p.importe > 0);
  for (const s of vivas) {
    if (pares.has(s.id) || !esSalidaAProveedor(s)) continue;
    for (const p of libres) {
      if (p.account_label && p.account_label === s.account_label) continue;
      const a = arista(s, p, VENTANA_OTRA_CUENTA_DIAS); if (a) otra.push(a);
    }
  }
  tomar(otra, 'otra_cuenta');
  return pares;
}

// ─── ¿Pasó por el programa? ─────────────────────────────────────────────────────────────────────

export type EstadoProgramaSalida =
  /** Una factura que saldó estaba en una partida de ese día ±3, dada de alta antes y vigente al pagar. */
  | 'en_programa'
  /** Sin pago en Kepler todavía, pero hay una partida vigente del mismo acreedor por el mismo importe (±$1, ±7 días): indicio. */
  | 'probable_en_programa'
  /** La partida existe pero se dio de alta DESPUÉS de pagar: se programó para cuadrar, no para decidir. */
  | 'regularizada'
  /** Sus facturas estaban en una partida (dada de alta antes de pagar) de otro día, fuera de ±3. */
  | 'programada_otro_dia'
  /** Estaba en una partida que se canceló ANTES (o el mismo día) de pagar: se quitó del programa y se pagó igual. */
  | 'quitada_del_programa'
  /** El pago no saldó ninguna factura (anticipo `X-D-60`): hoy el Calendario no programa anticipos. */
  | 'sin_factura'
  /** Ninguna de sus facturas estaba en el Calendario antes de pagar. */
  | 'no_programada'
  /** Sin pago en Kepler no se conocen sus facturas, y no hay partida de ese acreedor por ese importe. NO es «nunca estuvo». */
  | 'sin_partida_por_importe';

/** ¿Cuenta para la meta «el 100 % pasa por el programa»? Sólo lo programado antes de pagar. */
export function cuentaComoPrograma(e: EstadoProgramaSalida): boolean {
  return e === 'en_programa' || e === 'probable_en_programa';
}

export interface ProgramaDeLaSalida { estado: EstadoProgramaSalida; partida_id: string | null; dia: string | null }

/** ¿La partida estaba viva el día del pago? Cancelada DESPUÉS de pagar (la limpieza de lo saldado) cuenta como viva. */
function vivaAlPagar(p: PartidaDelPrograma, fechaPago: string): boolean {
  return p.estado !== 'cancelled' || (p.baja !== null && p.baja > fechaPago);
}

/** El estado del programa de un pago que Kepler YA tiene, por las facturas que saldó. */
export function estadoPrograma(pago: Pick<PagoKeplerBanco, 'fecha' | 'facturas'>, partidas: readonly PartidaDelPrograma[]): ProgramaDeLaSalida {
  if (!pago.facturas.length) return { estado: 'sin_factura', partida_id: null, dia: null };
  const mias = new Set(pago.facturas);
  const suyas = partidas.filter((p) => p.facturas.some((f) => mias.has(f)));
  const lejania = (p: PartidaDelPrograma) => Math.abs(difDias(pago.fecha, p.dia));
  const porCercania = (a: PartidaDelPrograma, b: PartidaDelPrograma) => lejania(a) - lejania(b) || a.id.localeCompare(b.id);
  const altaAntes = (p: PartidaDelPrograma) => p.alta <= pago.fecha;
  const vivas = suyas.filter((p) => vivaAlPagar(p, pago.fecha)).sort(porCercania);
  const cerca = vivas.filter((p) => lejania(p) <= HOLGURA_PROGRAMA_DIAS);
  const antes = cerca.find(altaAntes);
  if (antes) return { estado: 'en_programa', partida_id: antes.id, dia: antes.dia };
  if (cerca.length) return { estado: 'regularizada', partida_id: cerca[0].id, dia: cerca[0].dia };
  const otroDia = vivas.find(altaAntes);
  if (otroDia) return { estado: 'programada_otro_dia', partida_id: otroDia.id, dia: otroDia.dia };
  const quitada = suyas.filter((p) => !vivaAlPagar(p, pago.fecha) && altaAntes(p)).sort(porCercania)[0];
  if (quitada) return { estado: 'quitada_del_programa', partida_id: quitada.id, dia: quitada.dia };
  return { estado: 'no_programada', partida_id: null, dia: null };
}

/**
 * Sin pago en Kepler no se sabe qué facturas saldó: el indicio es una partida del MISMO acreedor
 * (alguna de sus facturas es del acreedor sugerido) por el mismo importe (±$1) a ±7 días, que no
 * esté ya explicando otro pago. Sin acreedor no se afirma nada.
 */
export function programaPorImporte(
  s: Pick<SalidaBancaria, 'fecha' | 'importe'>, partidas: readonly PartidaDelPrograma[],
  facturasDelAcreedor: ReadonlySet<string> | null, partidasUsadas: ReadonlySet<string> = new Set(),
): ProgramaDeLaSalida {
  const sinPartida: ProgramaDeLaSalida = { estado: 'sin_partida_por_importe', partida_id: null, dia: null };
  if (!facturasDelAcreedor || !facturasDelAcreedor.size) return sinPartida;
  const cand = partidas
    .filter((x) => !partidasUsadas.has(x.id) && Math.abs(x.monto - s.importe) <= TOLERANCIA_IMPORTE
      && Math.abs(difDias(s.fecha, x.dia)) <= VENTANA_PROGRAMA_POR_IMPORTE_DIAS
      && x.facturas.some((f) => facturasDelAcreedor.has(f)))
    .sort((a, b) => Math.abs(a.monto - s.importe) - Math.abs(b.monto - s.importe) || Math.abs(difDias(s.fecha, a.dia)) - Math.abs(difDias(s.fecha, b.dia)) || a.id.localeCompare(b.id));
  const viva = cand.find((x) => vivaAlPagar(x, s.fecha));
  if (viva) return { estado: 'probable_en_programa', partida_id: viva.id, dia: viva.dia };
  const quitada = cand.find((x) => x.alta <= s.fecha);
  if (quitada) return { estado: 'quitada_del_programa', partida_id: quitada.id, dia: quitada.dia };
  return sinPartida;
}

// ─── A quién se le pagó (cuando Kepler todavía no lo dice) ──────────────────────────────────────

/**
 * Ruido societario y palabras operativas que no identifican a nadie. Es la lista del motor de
 * conciliación (`finance-bank.service.ts`, `STOP_TOKENS`) — ⚠️ deuda con nombre (ADR-056): las dos
 * copias deben unificarse en ésta.
 */
const PALABRAS_VACIAS = new Set(['SA', 'DE', 'CV', 'SAPI', 'SAB', 'SC', 'SRL', 'RL', 'SOFOM', 'ENR', 'SOF', 'THE', 'DEL', 'LA', 'EL', 'LOS', 'LAS', 'Y', 'PAGO', 'SPEI', 'TRANSFERENCIA',
  'NOMINA', 'GASTO', 'GASTOS', 'ABONO', 'PRESTAMO', 'RETIRO', 'DEPOSITO', 'COMPRA', 'VENTA', 'COMISION', 'CONSUMO', 'CONSUMOS', 'REEMBOLSO', 'ANTICIPO', 'VIATICOS', 'TRASPASO', 'INTERES', 'INTERESES', 'CAPITAL', 'SUELDO', 'FINIQUITO', 'FACTURA', 'DOMICILIACION', 'SERVICIO', 'SERVICIOS']);

/** Mayúsculas, sin acentos ni signos, espacios simples: la llave del diccionario. */
export function normalizarConcepto(s: string | null | undefined): string {
  return String(s ?? '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
/** Las palabras que sí nombran a alguien (4 letras o más, sin ruido). */
export function palabrasDeNombre(s: string | null | undefined): Set<string> {
  return new Set(normalizarConcepto(s).split(' ').filter((w) => w.length >= 4 && !PALABRAS_VACIAS.has(w)));
}
/** Parecido entre dos nombres: palabras compartidas sobre las del nombre más corto. */
export function parecidoDeNombre(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / Math.min(a.size, b.size);
}

export type NivelAtribucion = 'fuerte' | 'debil' | 'ninguno';

/** Una factura viva (`v_supplier_payables`) que este pago podría saldar. */
export interface FacturaViva { id: string; acreedor: string; sucursal: string; doc_tipo: number; doc_sub: number; folio: string; fecha: string; pendiente: number }

export interface AcreedorSugerido {
  acreedor: string | null;
  nombre: string | null;
  nivel: NivelAtribucion;
  /** Por qué, en palabras: «nombre e importe», «sólo el nombre», «sólo el importe»… */
  porque: string;
  /** Otros acreedores que el nombre o el importe también apuntan (empates o conflicto), con su nombre si se conoce. */
  candidatos: { acreedor: string; nombre: string | null }[];
  /** Las facturas vivas del acreedor sugerido que suman el importe (1 a 4), si las hay. */
  facturas: FacturaViva[];
}

export interface FuentesDeAtribucion {
  /** Concepto normalizado → acreedor → veces que ese concepto pagó a ese acreedor (180 días). */
  diccionario: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Acreedores de compra con su nombre (`kdxd`). */
  catalogo: readonly { acreedor: string; nombre: string }[];
  /** Facturas vivas por acreedor. */
  facturasPorAcreedor: ReadonlyMap<string, readonly FacturaViva[]>;
}

const centavos = (n: number) => Math.round(n * 100);
/**
 * Tope de facturas que se COMBINAN (pares, tríos, cuartetos) por acreedor. La factura sola se busca
 * en toda la lista. No se recorta por antigüedad: el acreedor más grande paga lo más viejo (sus
 * facturas pagadas estaban en las posiciones 2 a 38 de 145), y la lista más larga medida es de 359.
 */
const TOPE_FACTURAS_COMBINACION = 400;

/** 1 a 4 facturas que suman el importe al centavo (±1 ¢), o `null`. Primero la combinación más corta. */
export function facturasQueSuman(facturas: readonly FacturaViva[], importe: number): FacturaViva[] | null {
  const meta = centavos(importe);
  const vivas = facturas.filter((f) => f.pendiente > 0.009);
  const cerca = (v: number) => Math.abs(v - meta) <= 1;
  for (const f of vivas) if (cerca(centavos(f.pendiente))) return [f];
  const it = vivas.slice(0, TOPE_FACTURAS_COMBINACION);
  const c = it.map((f) => centavos(f.pendiente));
  const pares = new Map<number, [number, number][]>();
  for (let i = 0; i < it.length; i++) for (let j = i + 1; j < it.length; j++) {
    const s = c[i] + c[j];
    if (cerca(s)) return [it[i], it[j]];
    const l = pares.get(s) ?? []; l.push([i, j]); pares.set(s, l);
  }
  for (let k = 0; k < it.length; k++) for (let d = -1; d <= 1; d++) {
    for (const [i, j] of pares.get(meta - c[k] + d) ?? []) if (i !== k && j !== k) return [it[i], it[j], it[k]];
  }
  for (const [s, l] of pares) for (let d = -1; d <= 1; d++) {
    for (const [i, j] of l) for (const [a, b] of pares.get(meta - s + d) ?? []) {
      if (a !== i && a !== j && b !== i && b !== j) return [it[i], it[j], it[a], it[b]];
    }
  }
  return null;
}

const UMBRAL_NOMBRE = 0.5;

/**
 * Los acreedores que el NOMBRE apunta: por el diccionario (el mismo concepto ya les pagó; sólo si
 * apunta a uno) y por el catálogo (el más parecido, con al menos la mitad de las palabras; si
 * empatan varios, van en `empates`). Lo usa {@link sugerirAcreedor} y el servicio, para saber de
 * qué acreedores pedir facturas vivas sin traer la deuda entera.
 */
export function candidatosDeNombre(concepto: string | null | undefined, f: Pick<FuentesDeAtribucion, 'diccionario' | 'catalogo'>): { nombres: string[]; empates: string[] } {
  const veces = f.diccionario.get(normalizarConcepto(concepto));
  const porDiccionario = veces && veces.size === 1 ? [...veces.keys()][0] : null;
  const mias = palabrasDeNombre(concepto);
  let mejor: string[] = [];
  let puntaje = 0;
  if (mias.size) {
    for (const c of f.catalogo) {
      const p = parecidoDeNombre(mias, palabrasDeNombre(c.nombre));
      if (p > puntaje) { puntaje = p; mejor = [c.acreedor]; } else if (p === puntaje && p > 0) mejor.push(c.acreedor);
    }
  }
  const porCatalogo = puntaje >= UMBRAL_NOMBRE && mejor.length === 1 ? mejor[0] : null;
  const empates = puntaje >= UMBRAL_NOMBRE && mejor.length > 1 ? mejor : [];
  return { nombres: [...new Set([porDiccionario, porCatalogo].filter((x): x is string => !!x))], empates };
}

/**
 * Propone a quién se le pagó una salida que Kepler todavía no tiene.
 *
 * Señales (medidas sobre octubre, entrenando con julio a septiembre):
 * - **nombre por diccionario**: el mismo concepto ya pagó a ese acreedor (99.4 %, placebo 1.2 %);
 * - **nombre por catálogo**: el concepto se parece al nombre del acreedor en `kdxd` (95.1 %, placebo 1.0 %);
 * - **importe**: el pendiente de UNA factura viva al centavo (93 de 108, placebo 0). La suma de
 *   2 a 4 facturas **sólo confirma** un nombre: usada para buscar es ruido (57.8 % contra 42.6 %).
 *
 * «Fuerte» = un solo nombre y el importe lo confirma (126/126). «Débil» = una sola señal (82 %).
 */
export function sugerirAcreedor(s: Pick<SalidaBancaria, 'concepto' | 'importe'>, f: FuentesDeAtribucion): AcreedorSugerido {
  const nombreDe = new Map(f.catalogo.map((c) => [c.acreedor, c.nombre]));
  const { nombres, empates } = candidatosDeNombre(s.concepto, f);

  // Importe: una sola factura viva al centavo, en TODOS los acreedores de compra.
  const porUnaFactura = new Set<string>();
  for (const [acr, fs] of f.facturasPorAcreedor) if (fs.some((x) => Math.abs(centavos(x.pendiente) - centavos(s.importe)) <= 1)) porUnaFactura.add(acr);
  const confirma = (acr: string) => facturasQueSuman(f.facturasPorAcreedor.get(acr) ?? [], s.importe);

  const sale = (acreedor: string | null, nivel: NivelAtribucion, porque: string, facturas: FacturaViva[] | null, otros: string[] = []): AcreedorSugerido => ({
    acreedor, nombre: acreedor ? nombreDe.get(acreedor) ?? null : null, nivel, porque,
    candidatos: otros.filter((x) => x !== acreedor).map((x) => ({ acreedor: x, nombre: nombreDe.get(x) ?? null })),
    facturas: facturas ?? [],
  });

  if (nombres.length === 1) {
    const fs = confirma(nombres[0]);
    if (fs) return sale(nombres[0], 'fuerte', 'nombre e importe', fs);
  }
  if (!nombres.length && empates.length) {
    const ok = empates.map((a) => [a, confirma(a)] as const).filter(([, fs]) => fs);
    if (ok.length === 1) return sale(ok[0][0], 'fuerte', 'nombre (empatado) e importe', ok[0][1], empates);
  }
  const unaFactura = porUnaFactura.size === 1 ? [...porUnaFactura][0] : null;
  if (unaFactura && nombres.includes(unaFactura)) return sale(unaFactura, 'fuerte', 'nombre e importe', confirma(unaFactura), nombres);
  if (unaFactura && !nombres.length && !empates.length) return sale(unaFactura, 'debil', 'sólo el importe (una factura)', confirma(unaFactura));
  if (nombres.length === 1) return sale(nombres[0], 'debil', 'sólo el nombre', null);
  if (nombres.length > 1) return sale(null, 'debil', 'el nombre apunta a varios acreedores', null, nombres);
  if (empates.length) return sale(null, 'debil', 'el nombre empata con varios acreedores', null, empates);
  if (porUnaFactura.size > 1) return sale(null, 'debil', 'el importe casa con facturas de varios acreedores', null, [...porUnaFactura]);
  return sale(null, 'ninguno', 'sin señal de nombre ni de importe', null);
}

// ─── La guía ────────────────────────────────────────────────────────────────────────────────────

/** Qué tiene Kepler de una salida a proveedor. */
export type EstadoKeplerSalida =
  /** Su pago está, en la misma cuenta (en uno o en varios documentos). */
  | 'registrado'
  /** Está, pero capturado con otra cuenta de tesorería: corregir la cuenta en Kepler. */
  | 'otra_cuenta'
  /** Kepler tiene un pago del acreedor sugerido en la misma cuenta (±1 día) con un importe POCO distinto: corregir el importe. */
  | 'importe_distinto'
  /** No está, y todavía no pasa la espera normal de captura. */
  | 'en_espera'
  /** No está, y ya pasó la espera: elaborar el pago en Kepler. */
  | 'falta';

export type CuadranteSalida = 'en_programa_en_kepler' | 'fuera_en_kepler' | 'en_programa_falta' | 'fuera_falta';

/** Un documento de Kepler de la fila. */
export interface PagoDelPar {
  id: string; sucursal: string; doc_tipo: string; folio: string; fecha: string; fecha_captura: string | null;
  account_label: string | null; banco_nombre: string | null; importe: number; acreedor: string | null; acreedor_nombre: string | null;
}

export interface FilaSalidaProveedor {
  salida: SalidaBancaria;
  /** La marcó Tesorería con otra categoría, pero su pago en Kepler es de un acreedor de compra. */
  mal_clasificada: boolean;
  estado_kepler: EstadoKeplerSalida;
  /** Días desde la salida hasta hoy. */
  dias: number;
  /** Los documentos de Kepler de esta salida: ninguno, uno, o varios si Kepler la partió. */
  documentos: PagoDelPar[];
  /** Lo que suman los documentos menos lo que salió del banco. `null` sin documentos. */
  dif_importe: number | null;
  /** Días del primer documento contra la salida. `null` sin documentos. */
  dif_dias: number | null;
  programa: ProgramaDeLaSalida;
  cuadrante: CuadranteSalida;
  /** Qué hay que corregir en Kepler, si algo. */
  corregir: 'cuenta' | 'importe' | null;
  /**
   * Sin pago en Kepler, pero Kepler tiene un pago del acreedor sugerido ese día en esa cuenta con un
   * importe MUY distinto: se avisa (para no capturar dos veces) sin proponer corregir nada.
   */
  no_cuadra: PagoDelPar | null;
  /** Sólo sin pago en Kepler: a quién se le pagó, con su nivel de evidencia. */
  sugerido: AcreedorSugerido | null;
}

export interface UniversoMetrica { pagos: number; monto: number; pagos_en_programa: number; monto_en_programa: number; pagos_sin_factura: number; monto_sin_factura: number }
/** `banco` · `caja` · `otra` (puente: factoraje, devoluciones, ajustes): por la cuenta de tesorería del pago. */
export type UniversoPago = 'banco' | 'caja' | 'otra';

export interface EntradaGuia {
  hoy: string;
  desde: string;
  hasta: string;
  /** Salidas de cuentas de banco; puede traer días alrededor de la ventana para parear bien los bordes. */
  salidas: readonly SalidaBancaria[];
  abonos: readonly AbonoBancario[];
  /** Pagos de Kepler; puede traer días alrededor de la ventana. */
  pagos: readonly PagoKeplerBanco[];
  partidas: readonly PartidaDelPrograma[];
  /** Último día cubierto por el workbook, por `account_label`. */
  cubreHasta: ReadonlyMap<string, string | null>;
  /** `account_label|YYYY-MM-DD` de los días con al menos un movimiento (entrada o salida) en el workbook. */
  diasConMovimientos: ReadonlySet<string>;
}

export interface MontoContado { pagos: number; monto: number }

export interface GuiaCalculada {
  filas: FilaSalidaProveedor[];
  /** Pagos de compra en cuentas de banco cuyo día el workbook SÍ tiene, sin salida que les corresponda. */
  kepler_sin_salida: PagoKeplerBanco[];
  /** Pagos de compra en cuentas de banco cuyo día el workbook no tiene (o no tiene movimientos): no se puede decir si salieron. */
  kepler_sin_cobertura: MontoContado;
  /** De lo anterior, por cuenta y día, para decirlo en palabras. */
  sin_cobertura_por_dia: { account_label: string | null; fecha: string; pagos: number; monto: number }[];
  /** Pagos de compra que salieron por una cuenta puente de Kepler (no es banco ni caja) y no se contrastaron con ninguna salida. */
  otra_sin_contraste: MontoContado & { por_cuenta: { cuenta: string; pagos: number; monto: number }[] };
  /** Pagos de compra por banco FUERA del programa que no tienen renglón aquí (sin salida, o día sin cubrir): la diferencia entre la lista y la meta. */
  kepler_fuera_sin_fila: { sin_salida: MontoContado; sin_cobertura: MontoContado };
  metrica: Record<UniversoPago, UniversoMetrica>;
  fuera_del_universo: { gasto: MontoContado; devueltas: MontoContado };
}

const dentro = (f: string, e: Pick<EntradaGuia, 'desde' | 'hasta'>) => f >= e.desde && f <= e.hasta;

/** El pareo de una entrada, para calcularlo una sola vez (es lo caro). */
export interface PareoCalculado { devueltas: Set<string>; pares: Map<string, ParSalidaPago> }
export function parearEntrada(e: EntradaGuia): PareoCalculado {
  const devueltas = salidasDevueltas(e.salidas, e.abonos);
  return { devueltas, pares: parear(e.salidas, e.pagos, devueltas) };
}

/** Las salidas a proveedor (en la ventana) que Kepler no tiene: las que necesitan atribución. */
export function salidasSinPago(e: EntradaGuia, pareo: PareoCalculado = parearEntrada(e)): SalidaBancaria[] {
  return e.salidas.filter((s) => dentro(s.fecha, e) && !pareo.devueltas.has(s.id) && !pareo.pares.has(s.id) && esSalidaAProveedor(s));
}

const universoDe = (tipoCuenta: string | null): UniversoPago => (tipoCuenta === 'banco' ? 'banco' : tipoCuenta === 'caja' ? 'caja' : 'otra');
const delPar = (p: PagoKeplerBanco): PagoDelPar => ({
  id: p.id, sucursal: p.sucursal, doc_tipo: p.doc_tipo, folio: p.folio, fecha: p.fecha, fecha_captura: p.fecha_captura,
  account_label: p.account_label, banco_nombre: p.banco_nombre, importe: p.importe, acreedor: p.acreedor, acreedor_nombre: p.acreedor_nombre,
});

/** Arma la guía completa. `fuentes` sólo hace falta si hay salidas sin pago ({@link salidasSinPago}). */
export function armarGuia(e: EntradaGuia, fuentes: FuentesDeAtribucion | null, pareo: PareoCalculado = parearEntrada(e)): GuiaCalculada {
  const { devueltas: dev, pares } = pareo;
  const pagoPorId = new Map(e.pagos.map((p) => [p.id, p]));
  const usados = new Set([...pares.values()].flatMap((p) => p.pago_ids));
  const fuera = { gasto: { pagos: 0, monto: 0 }, devueltas: { pagos: 0, monto: 0 } };
  const filas: FilaSalidaProveedor[] = [];
  const partidasUsadas = new Set<string>();
  const pendientes: SalidaBancaria[] = [];

  // Primero lo que Kepler sí tiene: así se sabe qué partidas ya explican un pago.
  for (const s of e.salidas) {
    if (!dentro(s.fecha, e)) continue;
    if (dev.has(s.id)) { if (esSalidaAProveedor(s)) { fuera.devueltas.pagos++; fuera.devueltas.monto += s.importe; } continue; }
    const par = pares.get(s.id);
    const docs = par ? par.pago_ids.map((id) => pagoPorId.get(id)).filter((p): p is PagoKeplerBanco => !!p) : [];
    if (!docs.length) { if (esSalidaAProveedor(s)) pendientes.push(s); continue; }
    if (!esAcreedorDeCompra(docs[0].acreedor)) { if (esSalidaAProveedor(s)) { fuera.gasto.pagos++; fuera.gasto.monto += s.importe; } continue; }
    const programa = estadoPrograma({ fecha: docs[0].fecha, facturas: [...new Set(docs.flatMap((d) => d.facturas))] }, e.partidas);
    if (programa.partida_id && cuentaComoPrograma(programa.estado)) partidasUsadas.add(programa.partida_id);
    filas.push({
      salida: s, mal_clasificada: !esSalidaAProveedor(s),
      estado_kepler: par!.modo === 'otra_cuenta' ? 'otra_cuenta' : 'registrado', dias: difDias(s.fecha, e.hoy),
      documentos: docs.map(delPar), dif_importe: par!.dif_importe, dif_dias: par!.dif_dias,
      programa, cuadrante: cuentaComoPrograma(programa.estado) ? 'en_programa_en_kepler' : 'fuera_en_kepler',
      corregir: par!.modo === 'otra_cuenta' ? 'cuenta' : null, no_cuadra: null, sugerido: null,
    });
  }

  for (const s of pendientes) {
    const dias = difDias(s.fecha, e.hoy);
    const sugerido = fuentes ? sugerirAcreedor(s, fuentes) : { acreedor: null, nombre: null, nivel: 'ninguno' as const, porque: 'sin fuentes de atribución', candidatos: [], facturas: [] };
    // El concepto ya le pagó antes a un acreedor que no es de compra (el pago de una tarjeta de crédito
    // es gasto, `G…`): no es de esta guía. Se cuenta aparte para que no desaparezca en silencio.
    if (sugerido.acreedor && !esAcreedorDeCompra(sugerido.acreedor)) { fuera.gasto.pagos++; fuera.gasto.monto += s.importe; continue; }
    // ¿Kepler tiene un pago del acreedor sugerido, en la misma cuenta, ±1 día, por otro importe?
    const cercano = sugerido.acreedor && s.account_label
      ? e.pagos.filter((x) => !usados.has(x.id) && x.account_label === s.account_label && x.acreedor === sugerido.acreedor && Math.abs(difDias(s.fecha, x.fecha)) <= 1)
        .sort((a, b) => Math.abs(a.importe - s.importe) - Math.abs(b.importe - s.importe) || a.id.localeCompare(b.id))[0] ?? null
      : null;
    if (cercano && Math.abs(cercano.importe - s.importe) <= (DIFERENCIA_CORREGIBLE_PCT / 100) * s.importe) {
      usados.add(cercano.id);
      const programa = estadoPrograma(cercano, e.partidas);
      filas.push({
        salida: s, mal_clasificada: false, estado_kepler: 'importe_distinto', dias,
        documentos: [delPar(cercano)], dif_importe: r2(cercano.importe - s.importe), dif_dias: difDias(s.fecha, cercano.fecha),
        programa, cuadrante: cuentaComoPrograma(programa.estado) ? 'en_programa_en_kepler' : 'fuera_en_kepler',
        corregir: 'importe', no_cuadra: null, sugerido,
      });
      continue;
    }
    const delAcreedor = sugerido.acreedor && fuentes ? new Set((fuentes.facturasPorAcreedor.get(sugerido.acreedor) ?? []).map((x) => x.id)) : null;
    const programa = programaPorImporte(s, e.partidas, delAcreedor, partidasUsadas);
    if (programa.partida_id && programa.estado === 'probable_en_programa') partidasUsadas.add(programa.partida_id);
    filas.push({
      salida: s, mal_clasificada: false, estado_kepler: dias > ESPERA_CAPTURA_DIAS ? 'falta' : 'en_espera', dias,
      documentos: [], dif_importe: null, dif_dias: null,
      programa, cuadrante: cuentaComoPrograma(programa.estado) ? 'en_programa_falta' : 'fuera_falta',
      corregir: null, no_cuadra: cercano ? delPar(cercano) : null, sugerido,
    });
  }

  // Lado Kepler: la métrica de la meta, los pagos sin salida y lo que no se pudo contrastar.
  const vacia = (): UniversoMetrica => ({ pagos: 0, monto: 0, pagos_en_programa: 0, monto_en_programa: 0, pagos_sin_factura: 0, monto_sin_factura: 0 });
  const metrica: Record<UniversoPago, UniversoMetrica> = { banco: vacia(), caja: vacia(), otra: vacia() };
  const sinSalida: PagoKeplerBanco[] = [];
  const sinCobertura = { pagos: 0, monto: 0 };
  const porDia = new Map<string, { account_label: string | null; fecha: string; pagos: number; monto: number }>();
  const otra = { pagos: 0, monto: 0, cuentas: new Map<string, { pagos: number; monto: number }>() };
  const fueraSinFila = { sin_salida: { pagos: 0, monto: 0 }, sin_cobertura: { pagos: 0, monto: 0 } };
  for (const p of e.pagos) {
    if (!dentro(p.fecha, e) || p.fecha > e.hoy || !esAcreedorDeCompra(p.acreedor) || !(p.importe > 0)) continue;
    const universo = universoDe(p.tipo_cuenta);
    const m = metrica[universo];
    const g = estadoPrograma(p, e.partidas);
    const enPrograma = cuentaComoPrograma(g.estado);
    m.pagos++; m.monto += p.importe;
    if (enPrograma) { m.pagos_en_programa++; m.monto_en_programa += p.importe; }
    if (g.estado === 'sin_factura') { m.pagos_sin_factura++; m.monto_sin_factura += p.importe; }
    if (usados.has(p.id)) continue;
    if (universo === 'otra') {
      otra.pagos++; otra.monto += p.importe;
      const k = p.banco_nombre || p.account_label || 'sin nombre';
      const c = otra.cuentas.get(k) ?? { pagos: 0, monto: 0 };
      c.pagos++; c.monto += p.importe; otra.cuentas.set(k, c);
      continue;
    }
    if (universo !== 'banco') continue;
    const cubre = p.account_label ? e.cubreHasta.get(p.account_label) ?? null : null;
    const visto = !!cubre && difDias(p.fecha, cubre) >= MARGEN_SIN_SALIDA_DIAS && e.diasConMovimientos.has(`${p.account_label}|${p.fecha}`);
    if (visto) {
      sinSalida.push(p);
      if (!enPrograma) { fueraSinFila.sin_salida.pagos++; fueraSinFila.sin_salida.monto += p.importe; }
    } else {
      sinCobertura.pagos++; sinCobertura.monto += p.importe;
      const k = `${p.account_label ?? ''}|${p.fecha}`;
      const d = porDia.get(k) ?? { account_label: p.account_label, fecha: p.fecha, pagos: 0, monto: 0 };
      d.pagos++; d.monto += p.importe; porDia.set(k, d);
      if (!enPrograma) { fueraSinFila.sin_cobertura.pagos++; fueraSinFila.sin_cobertura.monto += p.importe; }
    }
  }
  for (const u of Object.values(metrica)) { u.monto = r2(u.monto); u.monto_en_programa = r2(u.monto_en_programa); u.monto_sin_factura = r2(u.monto_sin_factura); }
  for (const x of [fuera.gasto, fuera.devueltas, sinCobertura, fueraSinFila.sin_salida, fueraSinFila.sin_cobertura]) x.monto = r2(x.monto);
  filas.sort((a, b) => b.salida.fecha.localeCompare(a.salida.fecha) || b.salida.importe - a.salida.importe);
  return {
    filas,
    kepler_sin_salida: sinSalida.sort((a, b) => b.fecha.localeCompare(a.fecha) || b.importe - a.importe),
    kepler_sin_cobertura: sinCobertura,
    sin_cobertura_por_dia: [...porDia.values()].map((d) => ({ ...d, monto: r2(d.monto) })).sort((a, b) => a.fecha.localeCompare(b.fecha) || String(a.account_label).localeCompare(String(b.account_label))),
    otra_sin_contraste: {
      pagos: otra.pagos, monto: r2(otra.monto),
      por_cuenta: [...otra.cuentas.entries()].map(([cuenta, v]) => ({ cuenta, pagos: v.pagos, monto: r2(v.monto) })).sort((a, b) => b.monto - a.monto),
    },
    kepler_fuera_sin_fila: fueraSinFila,
    metrica, fuera_del_universo: fuera,
  };
}

// ─── Palabras para la pantalla ──────────────────────────────────────────────────────────────────

const TEXTO_PROGRAMA: Record<EstadoProgramaSalida, string> = {
  en_programa: 'Pasó por el programa',
  probable_en_programa: 'Probablemente en el programa (mismo acreedor e importe)',
  regularizada: 'Se programó después de pagar',
  programada_otro_dia: 'Programada para otro día',
  quitada_del_programa: 'Se quitó del programa y se pagó igual',
  sin_factura: 'Anticipo: no salda ninguna factura',
  no_programada: 'No estaba en el programa',
  sin_partida_por_importe: 'Sin partida de ese acreedor por ese importe (sin el pago en Kepler no se conocen sus facturas)',
};
export function textoPrograma(e: EstadoProgramaSalida): string { return TEXTO_PROGRAMA[e]; }

const TEXTO_KEPLER: Record<EstadoKeplerSalida, string> = {
  registrado: 'En Kepler',
  otra_cuenta: 'En Kepler con otra cuenta',
  importe_distinto: 'En Kepler con otro importe',
  en_espera: 'Aún no en Kepler (en espera)',
  falta: 'Falta en Kepler',
};
export function textoKepler(e: EstadoKeplerSalida): string { return TEXTO_KEPLER[e]; }
