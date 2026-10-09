/**
 * Fase CP `[CP.8.2]` (ADR-040) — **El armador del asiento de egreso para ContPAQi.**
 *
 * Vive aparte del servicio y sin dependencias de Nest, por la misma razón que `poliza-txt.ts`:
 * decide sobre dinero y tiene que poder probarse sin DI. El smoke
 * `test-newdb-contpaqi-poliza-egreso.js` carga este archivo tal cual vía ts-node.
 *
 * ── La forma del asiento: MEDIDA, no supuesta ───────────────────────────────────────────────
 * Leída el 2026-10-08 de pólizas reales de `ctLUIS_FRANCISCO_LOPEZ_GUTIERREZ` (tipo 2, Egreso).
 * Son siempre tres renglones:
 *
 *     #1 CARGO  5200510001 RENTA BIENES INMUEBLES     135,000.00   <- subtotal
 *     #2 CARGO  1060000000 IVA ACREDITABLE             21,600.00   <- del CFDI
 *     #3 ABONO  1020220000 BBVA 0489396721            156,600.00   <- total
 *
 * ── ⭐ Por qué el IVA NO se calcula ──────────────────────────────────────────────────────────
 * Medido en "PAGO TRASLADO DE EFECTIVO": subtotal 134,082.29. Multiplicar por 0.16 da
 * **21,453.17**, y ContPAQi tiene asentado **21,453.18**. En otra póliza del mismo concepto la
 * diferencia son **2 centavos**. El IVA sale del CFDI —donde se calcula por concepto y se
 * redondea ahí—, no de multiplicar el total.
 *
 * Por eso `iva` es un parámetro OBLIGATORIO y este módulo **se niega a derivarlo**. Si lo
 * calculara, el asiento quedaría descuadrado por centavos y ContPAQi lo rechazaría. Esos
 * importes ya los tenemos: `fiscal.cfdis` guarda las bases gravables por impuesto y tasa
 * (Fase LC.1, 167,135 comprobantes).
 *
 * ── Lo que este módulo NO hace, a propósito ─────────────────────────────────────────────────
 * ⛔ No elige la cuenta: la recibe en `regla`, que sale de `contpaqi.account_rules` con su
 *    confianza medida. Elegir cuenta es política contable y la firma el contador.
 * ⛔ No serializa. El transporte (TXT hoy, SDK después) es otra capa — justamente para que
 *    cambiarlo no toque esta lógica.
 * ⛔ No redondea para que cuadre. Si no cuadra, **falla**: un asiento descuadrado que ContPAQi
 *    rechaza es infinitamente preferible a uno que acepta corrido de campo (`[LC.9]`).
 */

/** ContPAQi: 1 = Ingreso · 2 = Egreso · 3 = Diario. Verificado contra su catálogo. */
export const TIPO_POLIZA_EGRESO = 2;

/** `MovimientosPoliza.TipoMovto` — decodificado en CP.0 y re-verificado en vivo. */
export const CARGO = false;
export const ABONO = true;

export type EstadoRegla = 'derivada' | 'aprobada' | 'sin_regla';

/**
 * `[CP.8.19]` — **La cuenta de cargo no siempre la decide la categoría.** Derivado en
 * `[CP.8.18]` cruzando los egresos de CB contra los abonos a `102*` de ContPAQi:
 *
 *     compra_mercancia  65.1% toca 2120*    -> la decide el PROVEEDOR
 *     nomina            74.2% toca 215011*  -> la decide la SUCURSAL
 *     compra_tarjeta    83.3% toca 52*      -> la decide la CATEGORIA
 *     traspaso_*         4.0% toca 52*      -> no es un gasto: banco<->banco
 */
export type TipoRegla =
  | 'por_categoria'
  | 'por_proveedor'
  | 'por_sucursal'
  | 'no_aplica'
  | 'sin_medir';

export interface ReglaCuenta {
  categoria_code: string;
  cuenta_gasto: string | null;
  cuenta_iva: string;
  confianza_pct: number | null;
  estado: EstadoRegla;
  /** Ausente = `por_categoria`, que es como se comportaba el motor antes de `[CP.8.19]`. */
  tipo_regla?: TipoRegla;
  /** Para `por_proveedor` / `por_sucursal`: la familia donde resuelve (`2120`, `215011`). */
  cuenta_prefijo?: string | null;
}

export interface EntradaEgreso {
  regla: ReglaCuenta;
  /** Base gravable. En pesos, con 2 decimales. */
  subtotal: number;
  /** ⭐ El IVA **declarado por el CFDI**. Nunca derivado de `subtotal`. */
  iva: number;
  /** Total efectivamente pagado — el que salió del banco. */
  total: number;
  /** Cuenta contable del banco en ContPAQi (`102xxxxxxx`). Viene del crosswalk de CP.2. */
  cuenta_banco: string;
  concepto: string;
  /** `YYYY-MM-DD`. */
  fecha: string;
  /** `IdSegNeg`. 0 = sin segmento, que es lo que ContPAQi tiene en el 97.6% de los casos. */
  seg_negocio?: number;
}

export interface MovimientoAsiento {
  cuenta: string;
  abono: boolean;
  importe: number;
  concepto: string;
  seg_negocio: number;
}

export interface Asiento {
  tipo_poliza: number;
  fecha: string;
  concepto: string;
  movimientos: MovimientoAsiento[];
  total: number;
  /**
   * ⭐ Sólo en los pagos a proveedor. `'no_emitido'` significa que el asiento **cuadra pero le
   * falta una pata** — el traspaso de impuesto *por acreditar* → *acreditable*. Viaja con el
   * asiento para que el contador lo vea declarado y no lo descubra revisando.
   */
  iva_traspaso?: 'no_emitido';
  iva_traspaso_motivo?: string;
}

/** El motor no lanza `Error` pelado: el motivo es parte del dato y se guarda en el export. */
export class AsientoRechazado extends Error {
  constructor(readonly motivo: string, mensaje: string) {
    super(mensaje);
    this.name = 'AsientoRechazado';
  }
}

/** Centavos enteros. Comparar pesos en punto flotante es cómo se cuelan descuadres de 1 ¢. */
const cent = (n: number) => Math.round(Number(n) * 100);

/**
 * Arma el asiento de un egreso, o lo RECHAZA con motivo. Nunca devuelve algo a medias.
 *
 * Los cuatro rechazos son deliberados y cada uno corresponde a un modo de falla ya vivido:
 *  - `sin_regla`        — la categoría se midió y no concluyó. Asentarla sería inventar.
 *  - `regla_sin_cuenta` — `[LC.9]`: un nulo se vuelve espacios y tira el archivo entero.
 *  - `importe_invalido` — un importe no positivo no es un pago.
 *  - `descuadre`        — subtotal + IVA != total. Es LO que ContPAQi debe rechazar.
 */
export function armarAsientoEgreso(e: EntradaEgreso): Asiento {
  const { regla } = e;
  const tipo: TipoRegla = regla.tipo_regla ?? 'por_categoria';

  // ── `[CP.8.19]` El tipo de regla se evalúa ANTES que el estado ────────────────────────────
  // ⭐ Porque "ya se decidió que esto no genera póliza" y "falta decidir" son dos cosas
  // distintas y tienen que verse distinto. Si `no_aplica` cayera en el rechazo por `sin_regla`,
  // la bandeja mostraría trabajo pendiente donde no lo hay (misma lección que `[CP.8.1d]`).
  if (tipo === 'no_aplica') {
    throw new AsientoRechazado(
      'no_aplica',
      `"${regla.categoria_code}" no genera póliza de egreso: se midió y se decidió que no aplica.`,
    );
  }
  if (tipo === 'sin_medir') {
    throw new AsientoRechazado(
      'sin_medir',
      `"${regla.categoria_code}" no se midió: cero pareos en la ventana derivada. No es que no ` +
        'tenga regla, es que no se sabe.',
    );
  }
  if (tipo === 'por_sucursal') {
    // ⛔ Bloqueado por el DATO DE ENTRADA, no por falta de código: CB no trae centro de costo
    // por movimiento — es la misma razón por la que el armador manda `seg_negocio: 0`. Se
    // declara con ese motivo exacto para que nadie lo confunda con una regla sin firmar.
    throw new AsientoRechazado(
      'sin_centro_costo',
      `"${regla.categoria_code}" carga a ${regla.cuenta_prefijo ?? '215011'}* por SUCURSAL, y el ` +
        'movimiento bancario no trae centro de costo. Falta el dato de entrada, no la regla.',
    );
  }
  if (tipo === 'por_proveedor') {
    return armarPagoProveedor(e);
  }

  if (regla.estado === 'sin_regla') {
    throw new AsientoRechazado(
      'sin_regla',
      `La categoría "${regla.categoria_code}" no tiene regla concluyente` +
        (regla.confianza_pct != null ? ` (concentra ${regla.confianza_pct}%)` : ' (sin medir)') +
        '. Se declara, no se asienta.',
    );
  }
  if (!regla.cuenta_gasto) {
    throw new AsientoRechazado(
      'regla_sin_cuenta',
      `La regla "${regla.categoria_code}" está en estado "${regla.estado}" pero no trae cuenta de gasto.`,
    );
  }

  const sub = cent(e.subtotal);
  const iva = cent(e.iva);
  const tot = cent(e.total);

  if (sub <= 0 || tot <= 0) {
    throw new AsientoRechazado('importe_invalido', `Importes no positivos: subtotal ${e.subtotal}, total ${e.total}.`);
  }
  if (iva < 0) {
    throw new AsientoRechazado('importe_invalido', `IVA negativo: ${e.iva}.`);
  }
  // ⭐ Sin tolerancia. La tentación es admitir ±1 ¢ "porque el IVA redondea"; sería tapar
  // justamente el caso que descubrió que el IVA viene del CFDI y no de multiplicar.
  if (sub + iva !== tot) {
    throw new AsientoRechazado(
      'descuadre',
      `No cuadra: ${(sub / 100).toFixed(2)} + ${(iva / 100).toFixed(2)} = ` +
        `${((sub + iva) / 100).toFixed(2)}, pero el total es ${(tot / 100).toFixed(2)}.`,
    );
  }

  const seg = e.seg_negocio ?? 0;
  const movimientos: MovimientoAsiento[] = [
    { cuenta: regla.cuenta_gasto, abono: CARGO, importe: sub / 100, concepto: e.concepto, seg_negocio: seg },
  ];
  // El renglón de IVA sólo existe si hay IVA. Un gasto exento con un renglón en cero no es
  // "más completo": es un renglón que no ocurrió.
  if (iva > 0) {
    movimientos.push({
      cuenta: regla.cuenta_iva, abono: CARGO, importe: iva / 100, concepto: e.concepto, seg_negocio: 0,
    });
  }
  movimientos.push({
    cuenta: e.cuenta_banco, abono: ABONO, importe: tot / 100, concepto: e.concepto, seg_negocio: 0,
  });

  return {
    tipo_poliza: TIPO_POLIZA_EGRESO,
    fecha: e.fecha,
    concepto: e.concepto,
    movimientos,
    total: tot / 100,
  };
}

/**
 * `[CP.8.21]` — **El pago a proveedor: otra forma de asiento, medida en pólizas reales.**
 *
 * Pagar una factura **no es un gasto**: el gasto se reconoció al registrarla. El pago reduce la
 * cuenta por pagar del proveedor. Medido sobre las pólizas de egreso de 2026 con exactamente dos
 * renglones: el par es **cargo a la cuenta del tercero / abono al banco**, sin renglón de IVA
 * (27 pólizas con `2120*`, 670 con `2150*`, 117 con `5200*` — todas de dos renglones).
 *
 * ── ⛔⛔ Lo que este asiento NO emite, y es una ausencia que se DECLARA ──────────────────────
 * ContPAQi, al pagar, hace además el **traspaso del impuesto**: lo mueve de *por acreditar* a
 * *acreditable*, porque en México el IVA se acredita sobre lo efectivamente pagado. Medido en
 * las pólizas de egreso de 2026 que tocan `2120*`:
 *
 *     1060000000 IVA ACREDITABLE      cargo  +$6,640,268.98
 *     1470040000 IVA POR ACREDITAR    abono  -$6,559,315.64
 *     1470100000 IEPS ACREDITABLE     cargo +$17,050,851.50
 *     1470110000 IEPS POR ACREDITAR   abono -$17,428,970.80
 *
 * Los pares se cancelan entre sí: **no tocan el banco**. Pero emitirlos exige saber **qué
 * facturas** se están pagando, y eso hoy no lo tenemos: `bank_movements.client_uuid` parece un
 * UUID de CFDI y es la llave de idempotencia del importer — **0 de 55,648 cruzan con
 * `fiscal.cfdis`** (`[CP.8.7]`).
 *
 * ⭐ Por eso el asiento sale **cuadrado pero incompleto**, y lo dice: `iva_traspaso` viaja en
 * `no_emitido` con su motivo. Un asiento que cuadra y le falta una pata es exactamente lo que el
 * contador tiene que ver declarado — no descubrirlo al revisar.
 *
 * ⚠️ El camino para cerrarlo ya existe y es de otra fase: `kdxf` de Kepler casa pago→factura de
 * forma **estructural** (30,073 de 30,073, Fase ECA), y de la factura sale el UUID y su impuesto.
 */
function armarPagoProveedor(e: EntradaEgreso): Asiento {
  const { regla } = e;
  const cuenta = regla.cuenta_gasto;
  if (!cuenta) {
    throw new AsientoRechazado(
      'proveedor_sin_cuenta',
      `"${regla.categoria_code}" carga a ${regla.cuenta_prefijo ?? '2120'}* por PROVEEDOR y no se ` +
        'resolvió cuál. Ver `contpaqi.supplier_accounts` (veredicto `en_disputa` o `sin_proveedor`).',
    );
  }
  const tot = cent(e.total);
  if (tot <= 0) {
    throw new AsientoRechazado('importe_invalido', `Total no positivo: ${e.total}.`);
  }

  return {
    tipo_poliza: TIPO_POLIZA_EGRESO,
    fecha: e.fecha,
    concepto: e.concepto,
    // El cargo va por el TOTAL pagado, no por el subtotal: lo que se liquida es el adeudo
    // completo, impuesto incluido. El IVA ya se acreditó (o está por acreditarse) aparte.
    movimientos: [
      { cuenta, abono: CARGO, importe: tot / 100, concepto: e.concepto, seg_negocio: e.seg_negocio ?? 0 },
      { cuenta: e.cuenta_banco, abono: ABONO, importe: tot / 100, concepto: e.concepto, seg_negocio: 0 },
    ],
    total: tot / 100,
    iva_traspaso: 'no_emitido',
    iva_traspaso_motivo:
      'el traspaso impuesto-por-acreditar -> acreditable exige saber QUE facturas se pagan; ' +
      'el movimiento bancario no las trae (client_uuid no es UUID de CFDI)',
  };
}

/**
 * Verifica que un asiento ya armado cuadre. Se usa como última compuerta antes de entregarlo,
 * porque entre armarlo y mandarlo pueden mediar transformaciones (y ya pasó: `[LC.9]`
 * encontró que `setInclusion` limpiaba el hash pero no el contenido, y se servía el viejo).
 */
export function asientoCuadra(a: Asiento): boolean {
  let cargos = 0;
  let abonos = 0;
  for (const m of a.movimientos) {
    if (m.abono) abonos += cent(m.importe);
    else cargos += cent(m.importe);
  }
  return cargos === abonos && cargos === cent(a.total);
}

/**
 * `[CP.8.21]` — **El lote: la unidad de armado es (cuenta de banco × día), no el movimiento.**
 *
 * ── Por qué, medido ─────────────────────────────────────────────────────────────────────────
 * **ContPAQi agrupa.** De las 4,457 pólizas de egreso de 2026, **4,067 (91.2 %) tienen
 * exactamente UN renglón de banco** y varios cargos colgando de él: 7.3 renglones promedio en
 * compra de mercancía, 14.6 en tarjeta, 278 en comisiones.
 *
 * ⛔ Armar una póliza por movimiento produciría **4,727 pólizas donde la contadora hace ~500**:
 * un archivo que cuadra y que ella no reconoce como su trabajo. Eso no es un detalle estético —
 * es la diferencia entre un asiento que revisa y uno que rechaza.
 *
 * ⭐ Y de paso explica el 27.8 % de pareo de `[CP.8.18]`: los que casan 1:1 son justo aquellos
 * donde la póliza agrupó **un solo** movimiento. El 72 % restante no es ruido — son los lotes.
 *
 * ── Qué hace, y qué se niega a hacer ────────────────────────────────────────────────────────
 * Arma UNA póliza con los cargos de cada entrada y **un solo abono al banco por la suma**.
 * Las entradas que el armador rechaza **no tumban el lote**: salen con su motivo y el lote sigue
 * con las demás. Un lote que se cae entero porque una fila no tiene regla es un lote que nadie
 * puede usar hasta que el contador firme las 21 reglas.
 *
 * ⛔ Pero si una entrada trae **otro banco u otra fecha**, eso sí es error de programación y
 * lanza: significaría mezclar en una póliza cosas que ContPAQi no mezcla.
 */
export interface LoteArmado {
  asiento: Asiento | null;
  incluidas: number;
  rechazadas: { indice: number; motivo: string; mensaje: string }[];
}

export function armarLoteEgresos(
  cuentaBanco: string,
  fecha: string,
  entradas: EntradaEgreso[],
  concepto: string,
): LoteArmado {
  const rechazadas: LoteArmado['rechazadas'] = [];
  const movimientos: MovimientoAsiento[] = [];
  let totalCent = 0;
  let traspasoPendiente = 0;

  entradas.forEach((e, i) => {
    if (e.cuenta_banco !== cuentaBanco || e.fecha !== fecha) {
      throw new Error(
        `armarLoteEgresos: la entrada ${i} es de (${e.cuenta_banco}, ${e.fecha}) y el lote es de ` +
          `(${cuentaBanco}, ${fecha}). Mezclar bancos o fechas en una póliza no es lo que ContPAQi hace.`,
      );
    }
    try {
      const a = armarAsientoEgreso(e);
      if (a.iva_traspaso === 'no_emitido') traspasoPendiente += 1;
      // Se toman los CARGOS de cada asiento; el abono al banco se consolida al final.
      for (const m of a.movimientos) {
        if (!m.abono) movimientos.push(m);
      }
      totalCent += cent(a.total);
    } catch (err) {
      if (err instanceof AsientoRechazado) {
        rechazadas.push({ indice: i, motivo: err.motivo, mensaje: err.message });
      } else {
        throw err;
      }
    }
  });

  if (!movimientos.length) return { asiento: null, incluidas: 0, rechazadas };

  movimientos.push({
    cuenta: cuentaBanco, abono: ABONO, importe: totalCent / 100, concepto, seg_negocio: 0,
  });

  const asiento: Asiento = {
    tipo_poliza: TIPO_POLIZA_EGRESO,
    fecha,
    concepto,
    movimientos,
    total: totalCent / 100,
  };
  if (traspasoPendiente > 0) {
    asiento.iva_traspaso = 'no_emitido';
    asiento.iva_traspaso_motivo =
      `${traspasoPendiente} pago(s) a proveedor sin el traspaso de impuesto por-acreditar -> ` +
      'acreditable: falta saber que facturas se pagan';
  }

  // ⛔ Última compuerta. Si el lote no cuadra, NO se devuelve a medias: es un error de este
  // código, no un dato malo, y tiene que romper acá y no en el importador de ContPAQi.
  if (!asientoCuadra(asiento)) {
    throw new Error(
      `armarLoteEgresos: el lote (${cuentaBanco}, ${fecha}) no cuadra con ` +
        `${movimientos.length} renglones y total ${(totalCent / 100).toFixed(2)}.`,
    );
  }
  return { asiento, incluidas: entradas.length - rechazadas.length, rechazadas };
}
