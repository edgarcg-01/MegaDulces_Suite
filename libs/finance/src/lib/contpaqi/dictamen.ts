/**
 * `[CP.8.95]` — **El dictamen: ¿esta póliza va a entrar bien a ContPAQi, y es la que contabilidad habría hecho?**
 *
 * Puro: sin base, sin Nest. Recibe la póliza tal como sale del armado (`construirLotes`) y el contexto ya leído,
 * y devuelve hallazgos. Lo usa quien arma el archivo ANTES de entregarlo; no corrige nada.
 *
 * ── Severidad y veredicto ───────────────────────────────────────────────────────────────────
 *   bloquea  no debe salir en el archivo: ContPAQi la rechazaría, la asentaría mal o la duplicaría.
 *   revisar  puede salir, pero alguien la mira antes: hay una señal MEDIDA de que contabilidad la asienta
 *            distinto, o algo que el dictamen no pudo comprobar.
 *   aviso    se dice y no frena.
 * El veredicto es el de la peor: `bloqueada` · `revisar` · `lista`.
 *
 * ⛔ Lo que no se pudo comprobar NO pasa en verde (ADR-056): si falta una fuente del contexto, la regla que la
 * necesita sale como hallazgo `*_no_medido` en `revisar`; nunca se omite en silencio.
 *
 * ── Perspectivas ────────────────────────────────────────────────────────────────────────────
 *   aritmetica  cuadra, importes válidos, centavos enteros
 *   catalogo    la cuenta existe en ContPAQi, es afectable, no está de baja, cumple la máscara 3-3-4
 *   fecha       válida, dentro del periodo del archivo, no futura, en un ejercicio abierto de ContPAQi
 *   formato     lo que el archivo (latin1, campos de 100) no puede escribir
 *   cfdi        UUID bien formado, conocido, no cancelado, nuestro, en pesos, sin retenciones, de un emisor
 *   proveedor   el RFC de los CFDI es el de la cuenta del proveedor; el emisor no está en la lista 69-B
 *   duplicado   ya la capturó contabilidad · el CFDI ya está en otra póliza · repetido en el mismo archivo · la
 *               réplica que lo dice tiene más de un día
 *   criterio    señales de que contabilidad la asienta distinto
 *
 * ── Lo que se midió antes de escribir las reglas de criterio ─────────────────────────────────
 * Ene–sep 2026: 990 pólizas armadas comparables con las de contabilidad, 98 distintas (9.9 %). Llevar notas de
 * crédito marca 213 con 56 distintas (26 %, todas las 26 diferencias por nota); un anticipo por aplicar marca 54
 * con 14 (26 %, 10 de las 12 por anticipo). ⛔ Se descartaron, medidas: «2120 sin provisión» (11 %, sin señal,
 * 606 falsas alarmas) y «tres o más facturas» (13 %). El complemento de pago (PPD sin REP) no hace mala a la
 * póliza: lo cubre el detector fiscal `ppd_sin_rep`, no se duplica aquí.
 */
import { asientoCuadra, type Asiento } from './poliza-egreso';

export type Severidad = 'bloquea' | 'revisar' | 'aviso';
export type Perspectiva =
  | 'aritmetica' | 'catalogo' | 'fecha' | 'formato' | 'cfdi' | 'proveedor' | 'duplicado' | 'criterio';
export type Veredicto = 'lista' | 'revisar' | 'bloqueada';

export interface Hallazgo {
  /** Código estable: la pantalla y las métricas cuentan por él. */
  regla: string;
  perspectiva: Perspectiva;
  severidad: Severidad;
  /** En llano, para quien decide si la póliza sale. */
  mensaje: string;
}

export interface Dictamen {
  clave: string;
  veredicto: Veredicto;
  hallazgos: Hallazgo[];
}

/** La póliza tal como sale del armado: el asiento y los UUID que viajan en sus renglones `AD`. */
export interface PolizaADictaminar {
  clave: string;
  asiento: Asiento & { redondeo?: number };
  uuids?: string[];
}

export interface CuentaDelCatalogo {
  afectable: boolean;
  baja: boolean;
}

/** Lo que el dictamen necesita de un CFDI (`fiscal.cfdis`). */
export interface CfdiDelContexto {
  /** `tipo_comprobante`: I factura · E nota · P complemento de pago · T traslado · N nómina. */
  tipo: string | null;
  emisor_rfc: string | null;
  receptor_rfc: string | null;
  total: number;
  /** `YYYY-MM-DD` del comprobante. */
  fecha: string | null;
  moneda: string | null;
  /** `total_retenidos`. El armado no asienta retenciones. */
  retenidos: number;
  /** `estatus_sat`: `vigente`, `cancelado`; cualquier otro valor = no consultado. */
  estatus_sat: string | null;
  /** `cancel_sustitucion_uuid`: el CFDI que sustituye a uno cancelado. */
  sustituto: string | null;
  /** Trae traslados de IVA al 0 % y al 16 % a la vez. */
  mixta: boolean;
  /** De una nota (E): el `TipoRelacion` del XML. `null` = el XML no lo trae y el armado decidió sin él. */
  relacion: string | null;
}

/** Una póliza que contabilidad ya capturó en ContPAQi (`analytics.gl_poliza_lines`). */
export interface PolizaDeElla {
  /** `ejercicio|periodo|tipo|folio`. */
  k: string;
  fecha: string;
  renglones: { cuenta: string; abono: boolean; importe: number }[];
}

export interface ContextoDictamen {
  /** `YYYY-MM` del archivo. */
  periodo: string;
  /** `YYYY-MM-DD` en la Ciudad de México. */
  hoy: string;
  /** El RFC de la empresa, receptora de lo que se paga. Sale de los datos: nunca se escribe en el código. */
  rfcEmpresa: string | null;
  /** `analytics.contpaqi_accounts`, por código. */
  catalogo: Map<string, CuentaDelCatalogo> | null;
  /** `fiscal.cfdis`, por UUID en mayúsculas. */
  cfdis: Map<string, CfdiDelContexto> | null;
  /** Pólizas de egreso que contabilidad ya capturó, del periodo con ±3 días a las orillas. */
  polizasDeElla: PolizaDeElla[] | null;
  /**
   * UUID → claves de pólizas de EGRESO de contabilidad que ya lo llevan asociado (cualquier mes). `[CP.9.4]` De la
   * réplica de ContPAQi (los tres caminos de asociación, a nivel movimiento y póliza) unida al staging.
   */
  uuidEnEgresos: Map<string, string[]> | null;
  /**
   * `[CP.9.4]` `YYYY-MM-DD` de la sincronía más vieja de las tablas de asociación de la réplica: lo que contabilidad
   * asoció después no se ve en `uuidEnEgresos`. `null` = no se supo.
   */
  asociacionesAl: string | null;
  /**
   * `[CP.9.4]` Los ejercicios de ContPAQi (`analytics.v_contpaqi_ejercicio`): cerrado = tiene póliza de cierre. ⛔ El
   * cierre no impide capturar (después del de 2024 entraron 24 pólizas): por eso es «revisar» y no «bloquea».
   */
  ejercicios: Map<number, { cerrado: boolean }> | null;
  /**
   * Provisiones de contabilidad (diario, abono a 2120): `cuenta|centavos` → fechas. ⛔ Por cuenta e importe y NO
   * por UUID: sus renglones de provisión no llevan UUID (0 de 2,331 en ene–sep 2026). Es la llave del armado.
   */
  provisiones: Map<string, string[]> | null;
  /** Saldo de anticipo por aplicar (1050 + sufijo del proveedor) al iniciar el periodo, por sufijo. */
  anticipos: Map<string, number> | null;
  /** Cuenta de proveedor (2120…) → RFC que la respaldan (`supplier_accounts` confirmado o por UUID). */
  rfcDeCuenta: Map<string, Set<string>> | null;
  /** RFC en la lista 69-B del SAT como presunto o definitivo. */
  efos: Set<string> | null;
}

const UUID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
const CUENTA_RE = /^\d{10}$/;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Las cuentas que llevan el sufijo de 6 dígitos del proveedor (`pago-proveedor.ts`, FAMILIA). */
const CUENTA_DE_PROVEEDOR = /^(2120|5010|5020|5050|5060|5070|5080)(\d{6})$/;
/** Ancho de los campos de concepto del layout (`poliza-txt.ts`): lo que pasa de ahí se recorta. */
const LARGO_CONCEPTO = 100;
/** Lo que el archivo (latin1, una póliza por renglón) puede escribir tal cual. */
const TEXTO_VALIDO = /^[\x20-\x7E\xA0-\xFF]*$/;
/** Días alrededor de la fecha del banco en que se busca la póliza de contabilidad (`[CP.8.81]`). */
const VENTANA_DIAS = 3;
/** Un redondeo de más de esto ya no es centavo de captura. */
const REDONDEO_MAX = 1;
/** Menos de un peso de anticipo es residuo, no algo que contabilidad vaya a aplicar. */
const ANTICIPO_MIN = 1;

const esBanco = (c: string) => c.startsWith('102');
const esProveedor = (c: string) => c.startsWith('2120');
/** Cuentas que no identifican al tercero (banco e impuestos): no sirven para desempatar. */
const esGenerica = (c: string) => esBanco(c) || c.startsWith('106') || c.startsWith('147');
const cent = (n: unknown) => Math.round(Number(n) * 100);
const pesos = (centavos: number) =>
  (centavos / 100).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
const lista = (xs: string[], max = 4) => (xs.length > max ? `${xs.slice(0, max).join(', ')} y ${xs.length - max} más` : xs.join(', '));
const dias = (a: string, b: string) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86400000);

const h = (regla: string, perspectiva: Perspectiva, severidad: Severidad, mensaje: string): Hallazgo =>
  ({ regla, perspectiva, severidad, mensaje });

const ORDEN: Record<Severidad, number> = { bloquea: 0, revisar: 1, aviso: 2 };

export function veredictoDe(hallazgos: Hallazgo[]): Veredicto {
  if (hallazgos.some((x) => x.severidad === 'bloquea')) return 'bloqueada';
  if (hallazgos.some((x) => x.severidad === 'revisar')) return 'revisar';
  return 'lista';
}

/** La pata de banco de un egreso: el único abono a 102. `null` si no hay exactamente una. */
function pataDeBanco(a: Asiento): { cuenta: string; importe: number } | null {
  const bancos = a.movimientos.filter((m) => m.abono && esBanco(String(m.cuenta)));
  return bancos.length === 1 ? { cuenta: String(bancos[0].cuenta), importe: Number(bancos[0].importe) } : null;
}

function aritmetica(a: Asiento, out: Hallazgo[]): void {
  const movs = a.movimientos ?? [];
  if (movs.length < 2) {
    out.push(h('sin_renglones', 'aritmetica', 'bloquea',
      `La póliza trae ${movs.length} renglón(es): un asiento necesita al menos un cargo y un abono.`));
    return;
  }
  const invalidos = movs.filter((m) => !Number.isFinite(Number(m.importe)) || Number(m.importe) <= 0).length;
  if (invalidos) {
    out.push(h('importe_invalido', 'aritmetica', 'bloquea',
      `${invalidos} renglón(es) con importe cero, negativo o que no es número.`));
  }
  const fraccion = movs.filter((m) => Math.abs(Number(m.importe) * 100 - Math.round(Number(m.importe) * 100)) > 1e-6).length;
  if (fraccion) {
    out.push(h('fraccion_de_centavo', 'aritmetica', 'bloquea',
      `${fraccion} renglón(es) con fracciones de centavo: el archivo los redondea y la póliza dejaría de cuadrar.`));
  }
  if (!asientoCuadra(a)) {
    let cargos = 0;
    let abonos = 0;
    for (const m of movs) { if (m.abono) abonos += cent(m.importe); else cargos += cent(m.importe); }
    out.push(h('descuadre', 'aritmetica', 'bloquea',
      `Cargos ${pesos(cargos)} contra abonos ${pesos(abonos)} (total declarado ${pesos(cent(a.total))}): `
      + 'ContPAQi rechaza un asiento que no cuadra.'));
  }
  if (a.tipo_poliza === 2 && !pataDeBanco(a)) {
    const n = movs.filter((m) => m.abono && esBanco(String(m.cuenta))).length;
    out.push(h('pata_de_banco', 'criterio', 'revisar',
      `Un egreso lleva un solo abono al banco y éste trae ${n}: así no lo asienta contabilidad.`));
  }
}

function catalogo(a: Asiento, ctx: ContextoDictamen, out: Hallazgo[]): void {
  const cuentas = [...new Set(a.movimientos.map((m) => String(m.cuenta)))];
  const malFormadas = cuentas.filter((c) => !CUENTA_RE.test(c));
  if (malFormadas.length) {
    out.push(h('cuenta_mal_formada', 'catalogo', 'bloquea',
      `Cuenta(s) que no cumplen la máscara de 10 dígitos (3-3-4): ${lista(malFormadas)}.`));
  }
  if (!ctx.catalogo) {
    out.push(h('catalogo_no_medido', 'catalogo', 'revisar',
      'No se leyó el catálogo de cuentas de ContPAQi: no se comprobó que las cuentas existan y sean afectables.'));
    return;
  }
  const cat = ctx.catalogo;
  const bien = cuentas.filter((c) => CUENTA_RE.test(c));
  const inexistentes = bien.filter((c) => !cat.has(c));
  const noAfectables = bien.filter((c) => cat.get(c) && !cat.get(c)!.afectable);
  const deBaja = bien.filter((c) => cat.get(c)?.baja);
  if (inexistentes.length) {
    out.push(h('cuenta_inexistente', 'catalogo', 'bloquea',
      `Cuenta(s) que no existen en el catálogo de ContPAQi: ${lista(inexistentes)}. La importación la rechaza.`));
  }
  if (noAfectables.length) {
    out.push(h('cuenta_no_afectable', 'catalogo', 'bloquea',
      `Cuenta(s) de mayor, no afectables: ${lista(noAfectables)}. Sólo se asienta en cuentas de último nivel.`));
  }
  if (deBaja.length) {
    out.push(h('cuenta_de_baja', 'catalogo', 'bloquea', `Cuenta(s) dadas de baja en ContPAQi: ${lista(deBaja)}.`));
  }
}

function fecha(a: Asiento, ctx: ContextoDictamen, out: Hallazgo[]): void {
  const f = String(a.fecha ?? '');
  const t = Date.parse(`${f}T12:00:00Z`);
  if (!FECHA_RE.test(f) || Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== f) {
    out.push(h('fecha_invalida', 'fecha', 'bloquea', `La fecha «${f}» no es una fecha válida.`));
    return;
  }
  if (f.slice(0, 7) !== ctx.periodo) {
    out.push(h('fecha_fuera_del_periodo', 'fecha', 'bloquea',
      `La póliza es del ${f} y el archivo es de ${ctx.periodo}: ContPAQi la asentaría en otro periodo.`));
  }
  if (f > ctx.hoy) {
    out.push(h('fecha_futura', 'fecha', 'bloquea', `La póliza está fechada el ${f}, después de hoy (${ctx.hoy}).`));
  }
  // `[CP.9.4]` El ejercicio. Todo «revisar»: ContPAQi acepta pólizas en un ejercicio cerrado, y uno que falta en la
  // réplica puede ser que contabilidad no lo creó o que la réplica no está al día.
  const ej = Number(f.slice(0, 4));
  if (!ctx.ejercicios) {
    out.push(h('ejercicio_no_medido', 'fecha', 'revisar',
      'No se leyeron los ejercicios de ContPAQi: no se comprobó que el de la póliza esté abierto.'));
  } else if (!ctx.ejercicios.has(ej)) {
    out.push(h('ejercicio_inexistente', 'fecha', 'revisar',
      `El ejercicio ${ej} no está en la réplica de ContPAQi: o contabilidad no lo ha creado, o la réplica no está al día.`));
  } else if (ctx.ejercicios.get(ej)!.cerrado) {
    out.push(h('ejercicio_cerrado', 'fecha', 'revisar',
      `El ejercicio ${ej} ya tiene póliza de cierre en ContPAQi: entregarle una póliza obliga a rehacer el cierre.`));
  }
}

function formato(a: Asiento, out: Hallazgo[]): void {
  const textos = [a.concepto, ...a.movimientos.map((m) => m.concepto)].map((t) => String(t ?? ''));
  const invalidos = textos.filter((t) => !TEXTO_VALIDO.test(t)).length;
  if (invalidos) {
    out.push(h('caracter_invalido', 'formato', 'bloquea',
      `${invalidos} concepto(s) traen caracteres que el archivo no puede escribir (fuera de latin1, saltos de línea o `
      + 'tabuladores): el renglón saldría corrido y ContPAQi leería mal los campos.'));
  }
  const largos = textos.filter((t) => t.length > LARGO_CONCEPTO).length;
  if (largos) {
    out.push(h('concepto_recortado', 'formato', 'aviso',
      `${largos} concepto(s) pasan de ${LARGO_CONCEPTO} caracteres: el archivo los recorta.`));
  }
}

interface CfdiConUuid extends CfdiDelContexto { uuid: string }

function cfdis(p: PolizaADictaminar, ctx: ContextoDictamen, out: Hallazgo[]): CfdiConUuid[] {
  const uuids = [...new Set((p.uuids ?? []).map((u) => String(u).toUpperCase()))];
  if (!uuids.length) return [];
  const malFormados = uuids.filter((u) => !UUID_RE.test(u));
  if (malFormados.length) {
    out.push(h('uuid_mal_formado', 'cfdi', 'bloquea',
      `${malFormados.length} UUID que no miden 36 o no son hexadecimales: ContPAQi no los puede asociar.`));
  }
  if (!ctx.cfdis) {
    out.push(h('cfdi_no_medido', 'cfdi', 'revisar',
      'No se leyeron los CFDI: no se comprobó que estén vigentes, que sean de la empresa ni de quién son.'));
    return [];
  }
  const cfdiMap = ctx.cfdis;
  const desconocidos = uuids.filter((u) => UUID_RE.test(u) && !cfdiMap.has(u));
  if (desconocidos.length) {
    out.push(h('cfdi_desconocido', 'cfdi', 'revisar',
      `${desconocidos.length} UUID que no están en los CFDI descargados: no se puede comprobar qué amparan.`));
  }
  const cs: CfdiConUuid[] = uuids.filter((u) => cfdiMap.has(u)).map((u) => ({ uuid: u, ...cfdiMap.get(u)! }));
  for (const c of cs.filter((x) => x.estatus_sat === 'cancelado')) {
    out.push(h('cfdi_cancelado', 'cfdi', 'bloquea',
      `El CFDI ${c.uuid} está cancelado ante el SAT: no se asocia un comprobante cancelado`
      + (c.sustituto ? `; el proveedor lo sustituyó por ${String(c.sustituto).toUpperCase()}.` : '.')));
  }
  const sinEstatus = cs.filter((c) => c.estatus_sat !== 'vigente' && c.estatus_sat !== 'cancelado').length;
  if (sinEstatus) {
    out.push(h('cfdi_sin_estatus_sat', 'cfdi', 'aviso',
      `${sinEstatus} de ${cs.length} CFDI sin estatus del SAT consultado: no se sabe si siguen vigentes.`));
  }
  if (!ctx.rfcEmpresa) {
    out.push(h('rfc_empresa_no_medido', 'cfdi', 'revisar', 'No se sabe el RFC de la empresa: no se comprobó que los CFDI sean suyos.'));
  } else {
    const ajenos = cs.filter((c) => c.receptor_rfc && c.receptor_rfc !== ctx.rfcEmpresa).length;
    if (ajenos) {
      out.push(h('cfdi_de_otro_receptor', 'cfdi', 'bloquea',
        `${ajenos} CFDI emitido(s) a otro RFC: no son gasto de la empresa.`));
    }
  }
  const tipos = cs.filter((c) => c.tipo !== 'I' && c.tipo !== 'E');
  if (tipos.length) {
    out.push(h('cfdi_tipo_inesperado', 'cfdi', 'revisar',
      `${tipos.length} CFDI que no son factura ni nota (tipo ${lista([...new Set(tipos.map((c) => String(c.tipo)))])}).`));
  }
  const otraMoneda = cs.filter((c) => c.moneda && c.moneda !== 'MXN');
  if (otraMoneda.length) {
    out.push(h('cfdi_en_otra_moneda', 'cfdi', 'revisar',
      `${otraMoneda.length} CFDI en ${lista([...new Set(otraMoneda.map((c) => String(c.moneda)))])}: el armado no convierte tipo de cambio.`));
  }
  const conRetencion = cs.filter((c) => Number(c.retenidos) > 0).length;
  if (conRetencion) {
    out.push(h('cfdi_con_retencion', 'cfdi', 'revisar',
      `${conRetencion} CFDI con retenciones de ISR o IVA: el armado no asienta la retención.`));
  }
  const emisores = [...new Set(cs.map((c) => c.emisor_rfc).filter((r): r is string => !!r))];
  if (emisores.length > 1) {
    out.push(h('cfdi_de_varios_emisores', 'cfdi', 'revisar',
      `Los CFDI de un mismo pago son de ${emisores.length} emisores distintos: un pago es a un proveedor.`));
  }
  return cs;
}

function proveedor(p: PolizaADictaminar, cs: CfdiConUuid[], ctx: ContextoDictamen, out: Hallazgo[]): void {
  const emisores = [...new Set(cs.map((c) => c.emisor_rfc).filter((r): r is string => !!r))];
  if (!emisores.length) return;
  if (!ctx.efos) {
    out.push(h('efos_no_medido', 'proveedor', 'revisar', 'No se leyó la lista 69-B del SAT: no se comprobó al emisor.'));
  } else {
    const enLista = emisores.filter((r) => ctx.efos!.has(r));
    if (enLista.length) {
      out.push(h('emisor_en_69b', 'proveedor', 'revisar',
        `El emisor ${lista(enLista)} está en la lista 69-B del SAT (operaciones presuntamente inexistentes): `
        + 'sus facturas no son deducibles hasta que se aclare.'));
    }
  }
  const cuentasProv = [...new Set(p.asiento.movimientos.map((m) => String(m.cuenta)).filter(esProveedor))];
  if (!cuentasProv.length) return;
  if (!ctx.rfcDeCuenta) {
    out.push(h('proveedor_no_medido', 'proveedor', 'revisar',
      'No se leyó a quién pertenece cada cuenta de proveedor: no se comprobó que sea la del emisor.'));
    return;
  }
  for (const cuenta of cuentasProv) {
    const rfcs = ctx.rfcDeCuenta.get(cuenta);
    if (rfcs && rfcs.size && !emisores.some((r) => rfcs.has(r))) {
      out.push(h('proveedor_rfc_distinto', 'proveedor', 'revisar',
        `La cuenta ${cuenta} es de ${lista([...rfcs], 2)} y los CFDI son de ${lista(emisores, 2)}: se asentaría a otro proveedor.`));
    }
  }
}

/**
 * Los sufijos de 6 dígitos del proveedor: los de las cuentas del asiento (2120/50x0) y, para un gasto (52xx, sin
 * sufijo), los de las cuentas 2120 que respaldan al RFC emisor.
 */
function sufijosDe(p: PolizaADictaminar, cs: CfdiConUuid[], ctx: ContextoDictamen): string[] {
  const s = new Set(p.asiento.movimientos.map((m) => String(m.cuenta).match(CUENTA_DE_PROVEEDOR)?.[2]).filter((x): x is string => !!x));
  const emisores = new Set(cs.map((c) => c.emisor_rfc).filter(Boolean));
  if (ctx.rfcDeCuenta && emisores.size) {
    for (const [cuenta, rfcs] of ctx.rfcDeCuenta) {
      if ([...rfcs].some((r) => emisores.has(r))) {
        const m = cuenta.match(CUENTA_DE_PROVEEDOR);
        if (m) s.add(m[2]);
      }
    }
  }
  return [...s];
}

function criterio(p: PolizaADictaminar, cs: CfdiConUuid[], ctx: ContextoDictamen, out: Hallazgo[]): void {
  const a = p.asiento;
  if (a.iva_traspaso === 'no_emitido') {
    out.push(h('iva_traspaso_pendiente', 'criterio', 'revisar',
      `Cuadra, pero le falta el traspaso del IVA por acreditar a acreditable${a.iva_traspaso_motivo ? `: ${a.iva_traspaso_motivo}` : ''}.`));
  }
  const redondeo = Math.abs(cent(a.redondeo ?? 0));
  if (redondeo > 0) {
    out.push(h('redondeo', 'criterio', redondeo > REDONDEO_MAX * 100 ? 'revisar' : 'aviso',
      `Lleva ${pesos(redondeo)} a redondeo para cuadrar contra el banco.`));
  }
  const notas = cs.filter((c) => c.tipo === 'E');
  if (notas.length) {
    const sinRelacion = notas.filter((c) => !c.relacion).length;
    out.push(h('lleva_notas', 'criterio', 'revisar',
      `Lleva ${notas.length} nota(s) de crédito: es donde más difiere contabilidad (1 de cada 4 pagos con notas, `
      + 'ene–sep 2026), casi siempre por descuento contra devolución'
      + (sinRelacion ? `, y ${sinRelacion} no dicen en su XML cuál de las dos es.` : '.')));
  }
  if (cs.some((c) => c.mixta)) {
    out.push(h('factura_mixta', 'criterio', 'aviso',
      'Hay facturas con conceptos al 0 % y al 16 %: la base del 16 % sale del IVA, como lo hace contabilidad en la mayoría.'));
  }
  const sufijos = sufijosDe(p, cs, ctx);
  if (sufijos.length) {
    if (!ctx.anticipos) {
      out.push(h('anticipo_no_medido', 'criterio', 'revisar',
        'No se leyeron los anticipos de los proveedores: no se comprobó si contabilidad aplicaría uno en este pago.'));
    } else {
      const saldo = Math.max(...sufijos.map((s) => ctx.anticipos!.get(s) ?? 0));
      if (saldo >= ANTICIPO_MIN) {
        out.push(h('anticipo_por_aplicar', 'criterio', 'revisar',
          `El proveedor tiene ${pesos(cent(saldo))} de anticipo por aplicar (1050): contabilidad suele aplicar parte en el `
          + 'pago, y este asiento no lo hace.'));
      }
    }
  }
  const facturas = cs.filter((c) => c.tipo === 'I');
  if (!facturas.length || !sufijos.length) return;
  if (!ctx.provisiones) {
    out.push(h('provision_no_medida', 'criterio', 'revisar',
      'No se leyeron las provisiones de contabilidad: no se comprobó si las facturas ya estaban provisionadas.'));
    return;
  }
  // La provisión de la factura: misma cuenta 2120 del proveedor y mismo importe, entre su mes y el pago.
  const provisionadas = facturas.filter((f) => sufijos.some((s) => (ctx.provisiones!.get(`2120${s}|${cent(f.total)}`) ?? [])
    .some((fp) => fp <= String(a.fecha) && fp >= `${String(f.fecha ?? '').slice(0, 7)}-01`))).length;
  if (provisionadas && !a.movimientos.some((m) => !m.abono && esProveedor(String(m.cuenta)))) {
    out.push(h('doble_registro', 'criterio', 'revisar',
      `${provisionadas} factura(s) parecen provisionadas por contabilidad (misma cuenta e importe) y aquí se cargan a `
      + 'compra o gasto: si la provisión es suya, el gasto quedaría dos veces.'));
  }
}

/** Los hallazgos de una póliza sola (sin mirar el resto del archivo ni lo que capturó contabilidad). */
export function dictaminar(p: PolizaADictaminar, ctx: ContextoDictamen): Dictamen {
  const out: Hallazgo[] = [];
  aritmetica(p.asiento, out);
  catalogo(p.asiento, ctx, out);
  fecha(p.asiento, ctx, out);
  formato(p.asiento, out);
  const cs = cfdis(p, ctx, out);
  proveedor(p, cs, ctx, out);
  criterio(p, cs, ctx, out);
  return { clave: p.clave, veredicto: veredictoDe(out), hallazgos: out };
}

/**
 * Las pólizas de un archivo, cada una con lo suyo y con lo que sólo se ve mirando todas:
 *  - **ya la capturó contabilidad** (misma cuenta de banco e importe en ±3 días): entregarla la duplicaría. Una
 *    póliza de ella se usa una sola vez; si hay dos candidatas que no se distinguen, se pide revisar.
 *  - **el CFDI ya está en otra póliza de egreso de ella**: pago parcial o pago duplicado.
 *  - **el mismo CFDI o la misma pata de banco en dos pólizas del archivo**.
 */
export function dictaminarArchivo(ps: PolizaADictaminar[], ctx: ContextoDictamen): Dictamen[] {
  const orden = [...ps].sort((x, y) => String(x.asiento.fecha).localeCompare(String(y.asiento.fecha)) || x.clave.localeCompare(y.clave));
  const dictamenes = new Map(orden.map((p) => [p.clave, dictaminar(p, ctx)]));
  const agrega = (clave: string, x: Hallazgo) => dictamenes.get(clave)!.hallazgos.push(x);

  // El mismo CFDI en dos pólizas del archivo. Puede ser un pago en parcialidades (3 de los 6 casos de ene–sep
  // 2026 son iguales a como lo asentó contabilidad), así que se revisa, no se bloquea.
  const porUuid = new Map<string, string[]>();
  for (const p of orden) {
    for (const u of new Set((p.uuids ?? []).map((x) => String(x).toUpperCase()))) {
      porUuid.set(u, [...(porUuid.get(u) ?? []), p.clave]);
    }
  }
  for (const [u, claves] of porUuid) {
    if (claves.length < 2) continue;
    for (const c of claves) {
      agrega(c, h('uuid_repetido_en_archivo', 'duplicado', 'revisar',
        `El CFDI ${u} va en ${claves.length} pólizas de este archivo: ¿pago en parcialidades o pago duplicado?`));
    }
  }

  // La misma pata de banco (cuenta, importe, día) en dos pólizas del archivo.
  const porPata = new Map<string, string[]>();
  for (const p of orden) {
    const b = pataDeBanco(p.asiento);
    if (!b) continue;
    const k = `${b.cuenta}|${cent(b.importe)}|${p.asiento.fecha}`;
    porPata.set(k, [...(porPata.get(k) ?? []), p.clave]);
  }
  for (const claves of porPata.values()) {
    if (claves.length < 2) continue;
    for (const c of claves) {
      agrega(c, h('banco_repetido_en_archivo', 'duplicado', 'revisar',
        'Otra póliza del archivo sale del mismo banco, el mismo día y por el mismo importe: ¿son dos pagos o uno repetido?'));
    }
  }

  // Lo que contabilidad ya capturó.
  const suya = new Map<string, string>();
  if (!ctx.polizasDeElla) {
    for (const p of orden) {
      agrega(p.clave, h('captura_previa_no_medida', 'duplicado', 'revisar',
        'No se leyeron las pólizas que ya capturó contabilidad: no se comprobó que ésta no esté ya en ContPAQi.'));
    }
  } else {
    const porBanco = new Map<string, { k: string; fecha: string; cuentas: Set<string>; usada: boolean }[]>();
    for (const r of ctx.polizasDeElla) {
      const cuentas = new Set(r.renglones.map((x) => String(x.cuenta)).filter((c) => !esGenerica(c)));
      for (const x of r.renglones) {
        if (!x.abono || !esBanco(String(x.cuenta))) continue;
        const k = `${x.cuenta}|${cent(x.importe)}`;
        porBanco.set(k, [...(porBanco.get(k) ?? []), { k: r.k, fecha: r.fecha, cuentas, usada: false }]);
      }
    }
    for (const p of orden) {
      const b = pataDeBanco(p.asiento);
      if (!b) continue;
      const libres = (porBanco.get(`${b.cuenta}|${cent(b.importe)}`) ?? [])
        .filter((x) => !x.usada && Math.abs(dias(x.fecha, p.asiento.fecha)) <= VENTANA_DIAS);
      let c = libres.filter((x) => x.fecha === p.asiento.fecha);
      if (!c.length) c = libres;
      if (c.length > 1) {
        const propias = new Set(p.asiento.movimientos.map((m) => String(m.cuenta)).filter((x) => !esGenerica(x)));
        const conCuenta = c.filter((x) => [...propias].some((cu) => x.cuentas.has(cu)));
        if (conCuenta.length >= 1) c = conCuenta;
      }
      if (c.length === 1) {
        c[0].usada = true;
        suya.set(p.clave, c[0].k);
        agrega(p.clave, h('ya_capturada', 'duplicado', 'bloquea',
          `Contabilidad ya la capturó: póliza ${c[0].k.split('|').slice(-1)[0]} del ${c[0].fecha}, misma cuenta de banco e importe. `
          + 'Entregarla la duplicaría.'));
      } else if (c.length > 1) {
        agrega(p.clave, h('posible_ya_capturada', 'duplicado', 'revisar',
          `Hay ${c.length} pólizas de contabilidad con la misma cuenta de banco e importe en ±${VENTANA_DIAS} días: no se distingue si ésta ya está.`));
      }
    }
  }

  // El CFDI ya está en OTRA póliza de egreso de contabilidad.
  if (ctx.uuidEnEgresos) {
    // `[CP.9.4]` Lo asociado después de la última sincronía de la réplica no se ve: con más de un día, se dice.
    const rancia = ctx.asociacionesAl === null ? null : dias(ctx.hoy, ctx.asociacionesAl) > 1;
    for (const p of orden) {
      const propia = suya.get(p.clave);
      const otras = [...new Set((p.uuids ?? []).map((x) => String(x).toUpperCase()))]
        .flatMap((u) => (ctx.uuidEnEgresos!.get(u) ?? []).filter((k) => k !== propia).map((k) => ({ u, k })));
      if (otras.length) {
        agrega(p.clave, h('cfdi_ya_pagado', 'duplicado', 'revisar',
          `${new Set(otras.map((x) => x.u)).size} CFDI ya está(n) en otra póliza de egreso de contabilidad: ¿pago parcial o pago duplicado?`));
      }
      if (!(p.uuids ?? []).length) continue;
      if (rancia === null) {
        agrega(p.clave, h('replica_no_medido', 'duplicado', 'revisar',
          'No se supo hasta cuándo está al día la réplica de ContPAQi: un CFDI asociado hace poco podría no verse.'));
      } else if (rancia) {
        agrega(p.clave, h('replica_rancia', 'duplicado', 'revisar',
          `La réplica de ContPAQi tiene las asociaciones al ${ctx.asociacionesAl}: lo que contabilidad asoció después no se ve aquí.`));
      }
    }
  } else {
    for (const p of orden.filter((x) => (x.uuids ?? []).length)) {
      agrega(p.clave, h('pago_previo_no_medido', 'duplicado', 'revisar',
        'No se leyó en qué pólizas de egreso ya están los CFDI: no se comprobó que no se hayan pagado antes.'));
    }
  }

  return ps.map((p) => {
    const d = dictamenes.get(p.clave)!;
    d.hallazgos.sort((x, y) => ORDEN[x.severidad] - ORDEN[y.severidad]);
    return { ...d, veredicto: veredictoDe(d.hallazgos) };
  });
}

/** Cuántas pólizas en cada veredicto y cuántas veces salió cada regla: para la cabecera y para medir. */
export function resumenDictamen(ds: Dictamen[]): {
  polizas: number;
  por_veredicto: Record<Veredicto, number>;
  por_regla: Record<string, { severidad: Severidad; polizas: number }>;
} {
  const por_veredicto: Record<Veredicto, number> = { lista: 0, revisar: 0, bloqueada: 0 };
  const por_regla: Record<string, { severidad: Severidad; polizas: number }> = {};
  for (const d of ds) {
    por_veredicto[d.veredicto] += 1;
    for (const r of new Set(d.hallazgos.map((x) => x.regla))) {
      const sev = d.hallazgos.find((x) => x.regla === r)!.severidad;
      por_regla[r] = { severidad: sev, polizas: (por_regla[r]?.polizas ?? 0) + 1 };
    }
  }
  return { polizas: ds.length, por_veredicto, por_regla };
}
