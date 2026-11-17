/**
 * `[PGP.122]` — **La solicitud de gasto nace en la Suite.** Las reglas que leen la pantalla y el
 * servidor: qué entra (alcance), qué fechas lleva, cómo se escribe en Kepler lo que la ampara y qué
 * falta para poder pedirla.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_PGP_ANEXO_SOLICITUD_DE_GASTO.md` (anexo S de PGP).
 *
 * ## Por qué vive aquí
 * La misma respuesta la necesitan el botón «Pedir» (que se enciende o no) y el `400` del servidor (que
 * lo impide de verdad). Escrita dos veces se separa — el defecto que ADR-056 midió ocho veces.
 *
 * ## Decisiones que codifica (Francisco, 2026-11-14)
 *  · **DS3 — alcance v1:** acreedores de gasto operativo `G…` (incluidos `GNF…`, viáticos y arrastre).
 *    Fuera: nómina `GN001`, comisiones bancarias `GB…` (las arma el estado de cuenta, CB.62), tarjetas
 *    `TC…`, préstamos `A…`, compras `C…` y sucursales `TI…`; y los renglones a SUA (601-015), impuestos
 *    (761–763), activo fijo (150) y capital de créditos (210). Lo de fuera se sigue capturando en Kepler.
 *    Medido (30 días al 13-nov): 960 de 1,394 solicitudes entran, $5.07 M.
 *  · **DS15 — dos fechas:** la **fecha de solicitud** (va a «Fecha», `kdm1.c9`) y la **fecha del
 *    documento que ampara el gasto** (Kepler no tiene campo: va en un renglón de comentario `AMPARA …`,
 *    `kdm1.c25`, y su folio en la referencia `c11`; el gasto X-A-10 hereda los dos: 99.7 % y 100 %).
 *  · **El principio:** la Suite llena y la persona valida. Esta compuerta no pide nada que una fuente
 *    (el CFDI del SAT, el lector del ticket, el hábito del acreedor) ya contestó.
 */

import { faltaParaMandar, type EvidenciaAdjunta } from './aporte-solicitante.contract';
import { clabeValida } from './clabe.contract';

/** `finance.expense_proofs.origen` del vale que nació como solicitud en la Suite (sin folio de Kepler). */
export const ORIGEN_SOLICITUD_SUITE = 'solicitud' as const;

// ── Alcance (DS3) ───────────────────────────────────────────────────────────────────────────

export type Alcance = { dentro: true } | { dentro: false; motivo: string };

/**
 * ¿Este acreedor (`kdxd.c2`) entra en la primera versión? La clave de Kepler ya codifica la clase:
 * `G` + inicial del nombre (o `GF`/`GNF` + inicial). `GN001` es la nómina; las demás `GN…` son
 * proveedores cuyo nombre empieza con N (medido en `kdxd`, 2026-11-15).
 */
export function alcanceDelAcreedor(clave: string | null | undefined): Alcance {
  const c = String(clave ?? '').trim().toUpperCase();
  if (!c) return { dentro: false, motivo: 'Falta el acreedor' };
  if (c === 'GN001') return { dentro: false, motivo: 'La nómina (GN001) tiene su propio flujo: se sigue capturando en Kepler' };
  if (c.startsWith('GB')) return { dentro: false, motivo: 'Las comisiones bancarias (GB…) las arma el estado de cuenta: no se piden aquí' };
  if (!c.startsWith('G')) return { dentro: false, motivo: `El acreedor ${c} no es de gasto (G…): tarjetas, préstamos, compras y sucursales se capturan en Kepler` };
  return { dentro: true };
}

/** Las cuentas que NO son gasto aunque pasen por una solicitud: se capturan en Kepler. */
export const CUENTAS_FUERA_DE_ALCANCE: ReadonlyArray<{ prefijo: string; que: string }> = [
  { prefijo: '601-015', que: 'SUA' },
  { prefijo: '761', que: 'impuestos' },
  { prefijo: '762', que: 'impuestos' },
  { prefijo: '763', que: 'impuestos sobre nómina' },
  { prefijo: '150', que: 'activo fijo' },
  { prefijo: '210', que: 'capital de créditos' },
];

/** El motivo si la cuenta (`kdco.c3` del concepto) queda fuera; `null` si entra. */
export function cuentaFueraDeAlcance(cuenta: string | null | undefined): string | null {
  const c = String(cuenta ?? '').trim();
  if (!c) return null;
  const f = CUENTAS_FUERA_DE_ALCANCE.find((x) => c === x.prefijo || c.startsWith(`${x.prefijo}-`));
  return f ? `La cuenta ${c} es de ${f.que}, no de gasto: ese renglón se captura en Kepler` : null;
}

/** El nombre de un concepto de Kepler para compararlo entre servidores: mayúsculas, sin el punto final ni espacios de más. */
function nombreDeConcepto(n: string | null | undefined): string {
  return String(n ?? '').trim().toUpperCase().replace(/\.+$/, '').replace(/\s+/g, ' ');
}

/** El rubro de una cuenta contable: lo anterior al primer `-` (`606-014` → `606`; `102-0142` → `102`; `102` → `102`). */
export function rubroDeCuenta(cuenta: string | null | undefined): string {
  return String(cuenta ?? '').trim().split('-')[0];
}

/**
 * `[PGP.122]` R14 (anexo S §16) — **La cuenta del concepto en ESTE servidor, contra la de CEDIS (00).** Hay nueve catálogos
 * de conceptos (`kdco`), uno por servidor, y el escritor escribe la cuenta del servidor. Medido el 2026-11-17: el 074
 * «Capitán de marca» va a 102 (caja y bancos) en 01, 06, 07 y 08 y a 606-014 (gasto) en 00, y desde el 2-oct mandó
 * $25,900 fuera de resultados.
 *
 * Devuelve el motivo si el concepto NO se puede pedir aquí, o `null`:
 *  · otro RUBRO que el de 00 → bloquea: el gasto cambia de naturaleza (caja en vez de gasto). Lo corrige Contabilidad;
 *  · el mismo rubro con otra subcuenta (`102-0142` contra `102-0042`, la caja propia de una sucursal) → entra;
 *  · el mismo CÓDIGO con otro NOMBRE es otro concepto, no el mismo mal configurado → entra. Medido: el 246 es «TRASPASO
 *    SALIDA» (515-002) en 00 y «DEGUSTACION A CLIENTES» (606-006) en 02, 04 y 05; compararlos por código bloqueaba de más;
 *  · 00 no tiene ese concepto, o le falta la cuenta, o es la propia 00 → no hay contra qué comparar: entra.
 */
export function conceptoDistintoDeCedis(
  c: { codigo: string; nombre?: string | null; cuenta: string | null | undefined },
  enCedis: { nombre?: string | null; cuenta: string | null | undefined } | null | undefined,
  sucursal: string,
): string | null {
  const aqui = String(c.cuenta ?? '').trim();
  const cedis = String(enCedis?.cuenta ?? '').trim();
  if (sucursal === '00' || !aqui || !cedis) return null;
  if (nombreDeConcepto(c.nombre) !== nombreDeConcepto(enCedis?.nombre)) return null;
  if (rubroDeCuenta(aqui) === rubroDeCuenta(cedis)) return null;
  const nombre = String(c.nombre ?? '').trim().replace(/\.$/, '');
  return `${nombre ? `${nombre} (${c.codigo})` : `El concepto ${c.codigo}`} va a la cuenta ${aqui} en el Kepler de esta sucursal y a ${cedis} en CEDIS: `
    + `no se puede pedir hasta que Contabilidad corrija el catálogo`;
}

// ── Lo que se captura ───────────────────────────────────────────────────────────────────────

/** Qué papel ampara el gasto. La cotización ampara el «Pedir» (antes de gastar). */
export type TipoComprobante = 'cfdi' | 'ticket' | 'cotizacion';
export const TIPOS_COMPROBANTE: ReadonlyArray<{ id: TipoComprobante; label: string; en_kepler: string }> = [
  { id: 'cfdi', label: 'Factura (CFDI)', en_kepler: 'CFDI' },
  { id: 'ticket', label: 'Ticket o nota', en_kepler: 'TICKET' },
  { id: 'cotizacion', label: 'Cotización', en_kepler: 'COTIZACION' },
];

export interface ComprobanteDeLaSolicitud {
  tipo: TipoComprobante;
  /** Serie-folio de la factura o folio del ticket, si lo tiene. */
  folio?: string | null;
  /** `YYYY-MM-DD`: la fecha del documento que ampara el gasto. */
  fecha?: string | null;
  /** UUID del CFDI cuando se casó con el SAT (`fiscal.cfdis`). Con él, el SAT es la evidencia. */
  uuid?: string | null;
}

/** Un renglón: lo que va a `kdm6`. La cuenta NO se captura: sale del concepto en el catálogo del servidor. */
export interface RenglonDeLaSolicitud {
  /** `kdco.c1` (≤ 10). */
  concepto: string;
  /** `kdcp.c1` (≤ 10). */
  proyecto: string;
  /** `kdc3.c1` (≤ 10). */
  departamento: string;
  /** Subtotal SIN IVA del renglón (`kdm6.c11`). */
  importe: number;
  /** La cuenta del concepto (`kdco.c3`), si ya se conoce: sirve para avisar el alcance antes del servidor. */
  cuenta?: string | null;
}

/** Lo que hay capturado hasta ahora, para preguntarle a la compuerta qué falta. */
export interface EstadoSolicitudGasto {
  sucursal?: string | null;
  acreedor?: string | null;
  renglones?: readonly RenglonDeLaSolicitud[] | null;
  /** IVA de TODA la solicitud (Kepler lo lleva en la cabecera, `kdm1.c14`). */
  iva?: number | null;
  /** `YYYY-MM-DD`. La pone el servidor (hoy en México); la pantalla la manda para avisar antes. */
  fecha_solicitud?: string | null;
  comprobante?: ComprobanteDeLaSolicitud | null;
  forma_pago?: string | null;
  forma_pago_detalle?: string | null;
  archivos?: readonly EvidenciaAdjunta[] | null;
  /** Obligatorio sólo cuando la fecha del documento lo pide (`avisoDeFechas`). */
  motivo_fecha?: string | null;
  /** S.17 (DS31): opcional; si viene, se valida su forma (la CLABE con su dígito de control, el correo). */
  pago?: InformacionDePago | null;
}

// ── Montos ──────────────────────────────────────────────────────────────────────────────────

export const TASA_IVA = 0.16;
/** El máximo de renglones medido en una X-A-15 real (120 días, 5,224 solicitudes): 31. */
export const MAX_RENGLONES = 31;

const cent = (n: unknown): number => Math.round(Number(n) * 100);

/** Subtotal, IVA y total en pesos, sumados en centavos. Kepler: `c16 = Σ kdm6.c11 + c14 − c15` (99.6 %). */
export function totalesDeLaSolicitud(renglones: readonly Pick<RenglonDeLaSolicitud, 'importe'>[], iva: number | null | undefined): { subtotal: number; iva: number; total: number } {
  const s = renglones.reduce((a, r) => a + cent(r.importe), 0);
  const i = cent(iva ?? 0);
  return { subtotal: s / 100, iva: i / 100, total: (s + i) / 100 };
}

// ── Fechas (DS15) ──────────────────────────────────────────────────────────────────────────

/** Un comprobante más viejo que esto pide motivo (medido: el 98.7–99.1 % de lo que se ejecuta llega en ≤ 30 días). */
export const DIAS_MAXIMOS_COMPROBANTE = 30;

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `YYYY-MM-DD` que existe en el calendario. `Date.parse('2026-02-30')` NO falla (se corre al 2-mar): sin esto una
 * fecha imposible pasaba la compuerta y reventaba el INSERT con un 500, o llegaba como texto a `c24`.
 */
export function fechaReal(d: string | null | undefined): boolean {
  const v = String(d ?? '').trim();
  if (!FECHA.test(v)) return false;
  const t = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === v;
}
const dias = (a: string, b: string): number => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

/** `dd/mm/aaaa` desde `YYYY-MM-DD` (como Kepler y como la gente escribe la fecha en el comentario). */
export function fechaCorta(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

export type AvisoFechas =
  | { ok: true; retroactiva: boolean }
  | { ok: false; bloquea: boolean; motivo: string };

/**
 * Qué dicen las dos fechas juntas. `retroactiva` = el gasto ya se hizo antes de pedirlo (el modo
 * dominante: 1,415 de 2,005 vales desde octubre ya traen comprobante). Se acepta y se rotula (DS6).
 *  · documento futuro → bloquea (no existe un ticket de mañana);
 *  · más de 30 días antes, o de otro año → pide motivo (los proyectos son anuales).
 */
export function avisoDeFechas(fechaDocumento: string | null | undefined, fechaSolicitud: string | null | undefined): AvisoFechas {
  const d = String(fechaDocumento ?? '').trim();
  const s = String(fechaSolicitud ?? '').trim();
  if (!fechaReal(d)) return { ok: false, bloquea: true, motivo: 'Falta la fecha del documento que ampara el gasto, o no existe (YYYY-MM-DD)' };
  if (!fechaReal(s)) return { ok: false, bloquea: true, motivo: 'Falta la fecha de solicitud, o no existe (YYYY-MM-DD)' };
  const atras = dias(d, s);
  if (atras < 0) return { ok: false, bloquea: true, motivo: `El documento es del ${fechaCorta(d)}, posterior a la solicitud (${fechaCorta(s)})` };
  if (d.slice(0, 4) !== s.slice(0, 4)) return { ok: false, bloquea: false, motivo: `El documento es de ${d.slice(0, 4)} y la solicitud de ${s.slice(0, 4)}: escribe por qué se registra hasta ahora` };
  if (atras > DIAS_MAXIMOS_COMPROBANTE) return { ok: false, bloquea: false, motivo: `El documento tiene ${atras} días (más de ${DIAS_MAXIMOS_COMPROBANTE}): escribe por qué se registra hasta ahora` };
  return { ok: true, retroactiva: atras > 0 };
}

// ── S.17 · La base: en qué servidor de Kepler se pide (DS27) ─────────────────────────────────

/** Cómo quedó decidida la base de quien pide, para decirlo en pantalla. */
export type AlcanceDeLaBase = 'todas' | 'varias' | 'una' | 'sin_almacen' | 'ninguna';

/** El alcance de almacén de quien pide, como lo resuelve el servidor (ScopeService, área `finanzas`, ADR-050). */
export interface AlmacenesDeQuienPide {
  modo: 'all' | 'listed' | 'own' | 'none';
  valores: readonly string[];
  /** `false` = su alcance es «el suyo» y su ficha no dice cuál: no se puede resolver. */
  resoluble: boolean;
}

/**
 * `[PGP.122]` S.17 (DS27, Francisco 2026-11-16) — **En qué bases puede pedir esta persona:** las abiertas que son
 * suyas. Con UNA, la base queda fija y no se pregunta; con varias o todas, se elige (sin preselección: a quien maneja
 * dos, proponerle la última es la forma de pedir en la equivocada).
 *
 * ⛔ Sin almacén en su ficha (alcance «el suyo» sin valor) o sin alcance, **ninguna**: no se abren todas. La bandeja
 * del SAT ya le contesta 403 con la misma regla, y abrir las nueve sería ver y pedir de más. Medido 2026-11-16: 2
 * personas que piden gastos están así; las arregla Sistemas asignándoles sus almacenes.
 */
export function basesDeQuienPide(abiertas: readonly string[], a: AlmacenesDeQuienPide | null | undefined): { bases: string[]; alcance: AlcanceDeLaBase } {
  const ab = [...new Set(abiertas.map((s) => String(s ?? '').trim()).filter(Boolean))].sort();
  if (!a || a.modo === 'none') return { bases: [], alcance: 'ninguna' };
  if (a.modo === 'all') return { bases: ab, alcance: 'todas' };
  if (!a.resoluble) return { bases: [], alcance: 'sin_almacen' };
  const mios = new Set(a.valores.map((v) => String(v ?? '').trim()).filter(Boolean));
  if (!mios.size) return { bases: [], alcance: 'sin_almacen' };
  return { bases: ab.filter((s) => mios.has(s)), alcance: mios.size > 1 ? 'varias' : 'una' };
}

// ── S.17 · El plazo (DS30) ───────────────────────────────────────────────────────────────────

/**
 * Los plazos a un toque, en días; `0` = de contado. Medido 2026-11-16 en 4,413 X-A-15 desde agosto: el 88.0 % se
 * pide para el mismo día, el 7.3 % a 1–7 días y el 1.5 % a 8–30.
 */
export const PLAZOS_DE_PAGO: readonly number[] = [0, 7, 15, 30];
/** Un plazo más largo que esto se pide con «Otra fecha» (y se revisa). */
export const PLAZO_MAXIMO_DIAS = 120;

const masDias = (iso: string, n: number): string => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * La fecha de pago (`kdm1.c18`, que el X-A-10 vuelve el vencimiento de la CxP) para un plazo. De contado = hoy. Con
 * días, desde la fecha del documento si se da (una factura a 30 días vence 30 días después de emitida) y si no, desde
 * hoy. Si ya venció, la fecha es HOY y `vencio` dice cuándo: el servidor descarta una fecha pasada (la deja en la de
 * solicitud) y la pantalla lo dice en vez de esconderlo.
 */
export function fechaDePago(p: { dias: number; desde?: string | null; hoy: string }): { fecha: string; vencio: string | null; desde: 'documento' | 'hoy' } {
  const d = Math.max(0, Math.min(PLAZO_MAXIMO_DIAS, Math.round(Number(p.dias) || 0)));
  if (d === 0) return { fecha: p.hoy, vencio: null, desde: 'hoy' };
  const conDocumento = fechaReal(p.desde);
  const fecha = masDias(conDocumento ? String(p.desde) : p.hoy, d);
  return fecha < p.hoy
    ? { fecha: p.hoy, vencio: fecha, desde: conDocumento ? 'documento' : 'hoy' }
    : { fecha, vencio: null, desde: conDocumento ? 'documento' : 'hoy' };
}

// ── S.17 · La información de pago (DS31) ─────────────────────────────────────────────────────

/**
 * A dónde se paga y a quién se le manda el comprobante. Opcional: se agrega con «(+) Agregar información de pago».
 * Medido 2026-11-16: ningún catálogo tiene la CLABE de los acreedores de gasto (ni Kepler ni la Suite); el correo,
 * Kepler lo tiene en 16 de 342 (`kdxd.c11`).
 */
export interface InformacionDePago {
  /** CLABE (18), tarjeta (16 o 19) o número de cuenta; se guarda sólo con dígitos. */
  cuenta?: string | null;
  banco?: string | null;
  /** A dónde se manda el comprobante del pago. */
  correo?: string | null;
}

export type TipoDeCuenta = 'clabe' | 'tarjeta' | 'cuenta';
export const LARGO_BANCO = 40;
export const LARGO_CORREO = 120;

/**
 * La cuenta limpia (sólo dígitos) y su tipo, o por qué no es una cuenta; `null` si viene vacía. Se aceptan espacios y
 * guiones al teclearla. La CLABE se revisa con su dígito de control (Banxico): caza el error de dedo, no el de
 * persona. No se exige un largo por banco (Azteca usa 14): de 10 a 19 dígitos.
 */
export function cuentaDePago(texto: string | null | undefined): { ok: true; cuenta: string; tipo: TipoDeCuenta } | { ok: false; motivo: string } | null {
  const t = String(texto ?? '').replace(/[\s-]/g, '');
  if (!t) return null;
  if (!/^\d+$/.test(t)) return { ok: false, motivo: 'La cuenta lleva sólo números: una CLABE de 18, una tarjeta de 16 o el número de cuenta' };
  if (t.length < 10 || t.length > 19) return { ok: false, motivo: `La cuenta tiene ${t.length} dígitos: una CLABE lleva 18, una tarjeta 16 y una cuenta de 10 a 14` };
  if (t.length === 18) return clabeValida(t) ? { ok: true, cuenta: t, tipo: 'clabe' } : { ok: false, motivo: 'La CLABE no cuadra con su dígito de control: revisa los 18 dígitos' };
  return { ok: true, cuenta: t, tipo: t.length === 16 || t.length === 19 ? 'tarjeta' : 'cuenta' };
}

const CORREO = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;.]{2,}$/;

/** ¿Tiene forma de correo? (una sola dirección: con varias, ¿a cuál se manda?) */
export function correoValido(texto: string | null | undefined): boolean {
  const t = String(texto ?? '').trim();
  return t.length <= LARGO_CORREO && CORREO.test(t);
}

/** ¿Trae algo la información de pago? (lo que viene vacío no se guarda) */
export function hayInformacionDePago(p: InformacionDePago | null | undefined): boolean {
  return !!(String(p?.cuenta ?? '').trim() || String(p?.banco ?? '').trim() || String(p?.correo ?? '').trim());
}

// ── Cómo queda en Kepler (DS10, DS15) ────────────────────────────────────────────────────────

/** `kdm1.c25`, 60 caracteres: el renglón de comentario donde va la fecha del documento. */
export const LARGO_C25 = 60;
/** `kdm1.c11`, 20 caracteres: la referencia, donde va el folio del comprobante (es el uso de hoy). */
export const LARGO_C11 = 20;
/** `kdm1.c24`, 60 caracteres: el comentario que se ve en la pantalla de Kepler. */
export const LARGO_C24 = 60;

/**
 * `AMPARA CFDI F-393/7537 DEL 09/11/2026` — formato confirmado por Francisco (2026-11-14). Si no cabe,
 * se recorta el FOLIO, nunca la fecha. `null` si falta la fecha (sin fecha no hay qué escribir).
 */
export function lineaAmpara(c: ComprobanteDeLaSolicitud | null | undefined): string | null {
  if (!c || !fechaReal(c.fecha)) return null;
  const tipo = TIPOS_COMPROBANTE.find((t) => t.id === c.tipo)?.en_kepler ?? 'DOCUMENTO';
  const cola = ` DEL ${fechaCorta(String(c.fecha))}`;
  const cabeza = `AMPARA ${tipo} `;
  const folio = String(c.folio ?? '').replace(/\s+/g, ' ').trim() || 'S/F';
  const cabe = LARGO_C25 - cabeza.length - cola.length;
  return `${cabeza}${folio.slice(0, Math.max(3, cabe)).trimEnd()}${cola}`;
}

/** El folio del comprobante en la referencia (`c11`), recortado a lo que cabe. */
export function referenciaDelComprobante(c: ComprobanteDeLaSolicitud | null | undefined): string {
  return String(c?.folio ?? '').replace(/\s+/g, ' ').trim().slice(0, LARGO_C11).trimEnd();
}

/**
 * El comentario de Kepler (`c24`), armado: lo que la gente hoy teclea a mano (el 28.9 % trae periodo y
 * el 16.9 % una unidad) sale de campos. Sin acentos ni recorte aquí: eso lo hace quien escribe en Kepler.
 */
export function comentarioDeLaSolicitud(p: { concepto?: string | null; del?: string | null; al?: string | null; unidad?: string | null; nota?: string | null }): string {
  const partes: string[] = [];
  if (String(p.nota ?? '').trim()) partes.push(String(p.nota).trim());
  else if (String(p.concepto ?? '').trim()) partes.push(String(p.concepto).trim());
  const del = String(p.del ?? ''), al = String(p.al ?? '');
  if (fechaReal(del) && fechaReal(al)) partes.push(`DEL ${fechaCorta(del).slice(0, 5)} AL ${fechaCorta(al).slice(0, 5)}`);
  else if (fechaReal(del)) partes.push(`DEL ${fechaCorta(del)}`);
  if (String(p.unidad ?? '').trim()) partes.push(String(p.unidad).trim());
  return partes.join(' ');
}

// ── La compuerta ─────────────────────────────────────────────────────────────────────────────

export type FaltanteSolicitudId =
  | 'acreedor' | 'alcance' | 'renglones' | 'renglon' | 'importe' | 'iva'
  | 'comprobante' | 'fecha_documento' | 'motivo_fecha'
  | 'forma_pago' | 'forma_pago_detalle' | 'evidencia'
  | 'pago_cuenta' | 'pago_banco' | 'pago_correo';

export interface FaltanteSolicitud {
  id: FaltanteSolicitudId;
  /** Frase corta para el botón o la lista. */
  label: string;
  /** Frase larga para el `400`. */
  motivo: string;
}

const LARGO_CLAVE = 10;

/** RFC sin guiones, espacios ni puntos, en mayúsculas. */
export function rfcLimpio(rfc: string | null | undefined): string {
  return String(rfc ?? '').toUpperCase().replace(/[\s.\-_]/g, '');
}

/**
 * ¿La factura (RFC del emisor) puede ser de este acreedor (RFC en `kdxd.c10`)? ERP_KEPLER §3.z.4: el RFC del
 * catálogo de Kepler está mal capturado a menudo (dedazos, guiones, cero por letra). Se acepta igual, a ≤ 2
 * ediciones, o si el catálogo no trae un RFC con forma de RFC (entonces no hay con qué contradecir).
 * Medido 2026-11-15: la regla de ≤ 2 ediciones no dio un solo falso positivo contra 165 acreedores de RFC conocido.
 */
export function rfcCompatible(rfcCatalogo: string | null | undefined, rfcFactura: string | null | undefined): boolean {
  const a = rfcLimpio(rfcCatalogo);
  const b = rfcLimpio(rfcFactura);
  if (!/^[A-ZÑ&0-9]{12,13}$/.test(a)) return true;
  if (!b) return false;
  if (a === b) return true;
  // Levenshtein acotado: con más de 2 de diferencia de largo ya no cabe.
  if (Math.abs(a.length - b.length) > 2) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] <= 2;
}

/** ¿La evidencia es el CFDI del SAT? Con el UUID casado no hace falta foto: el SAT es el papel. */
export function evidenciaEsElSat(c: ComprobanteDeLaSolicitud | null | undefined): boolean {
  return c?.tipo === 'cfdi' && /^[0-9A-Fa-f-]{32,36}$/.test(String(c.uuid ?? '').trim());
}

/** Qué falta para poder PEDIR (mandar a firma). Lista vacía = se puede. El orden es el de la pantalla. */
export function faltaParaPedir(e: EstadoSolicitudGasto): FaltanteSolicitud[] {
  const no: FaltanteSolicitud[] = [];
  const acreedor = String(e.acreedor ?? '').trim();
  if (!acreedor) {
    no.push({ id: 'acreedor', label: 'A quién se le paga', motivo: 'falta el acreedor (a quién se le paga)' });
  } else {
    const a = alcanceDelAcreedor(acreedor);
    if (!a.dentro) no.push({ id: 'alcance', label: 'Fuera de la primera versión', motivo: a.motivo });
    else if (acreedor.length > 7) no.push({ id: 'acreedor', label: 'A quién se le paga', motivo: `La clave de acreedor «${acreedor}» no cabe en Kepler (7 caracteres)` });
  }

  const renglones = e.renglones ?? [];
  if (!renglones.length) no.push({ id: 'renglones', label: 'Qué se compró', motivo: 'falta al menos un renglón (concepto, proyecto, departamento e importe)' });
  if (renglones.length > MAX_RENGLONES) no.push({ id: 'renglones', label: 'Qué se compró', motivo: `${renglones.length} renglones: el máximo es ${MAX_RENGLONES}` });
  renglones.forEach((r, i) => {
    const n = i + 1;
    for (const [campo, nombre] of [['concepto', 'el concepto'], ['proyecto', 'el proyecto'], ['departamento', 'el departamento']] as const) {
      const v = String(r[campo] ?? '').trim();
      if (!v) no.push({ id: 'renglon', label: `Renglón ${n}`, motivo: `al renglón ${n} le falta ${nombre}` });
      else if (v.length > LARGO_CLAVE) no.push({ id: 'renglon', label: `Renglón ${n}`, motivo: `en el renglón ${n}, ${nombre} «${v}» no cabe en Kepler (${LARGO_CLAVE})` });
    }
    if (!(Number(r.importe) > 0) || cent(r.importe) / 100 !== Number(r.importe)) {
      no.push({ id: 'importe', label: `Renglón ${n}`, motivo: `el importe del renglón ${n} tiene que ser mayor que cero y con centavos (dos decimales)` });
    }
    const fuera = cuentaFueraDeAlcance(r.cuenta);
    if (fuera) no.push({ id: 'alcance', label: `Renglón ${n}`, motivo: fuera });
  });

  const t = totalesDeLaSolicitud(renglones, e.iva);
  const iva = Number(e.iva ?? 0);
  if (!(iva >= 0) || cent(iva) / 100 !== iva) no.push({ id: 'iva', label: 'El IVA', motivo: 'el IVA tiene que ser cero o positivo, con dos decimales' });
  else if (cent(iva) > Math.round(cent(t.subtotal) * TASA_IVA) + 100) {
    no.push({ id: 'iva', label: 'El IVA', motivo: `el IVA (${t.iva.toFixed(2)}) es mayor que el 16 % del subtotal (${t.subtotal.toFixed(2)})` });
  }

  const c = e.comprobante;
  if (!c || !TIPOS_COMPROBANTE.some((x) => x.id === c.tipo)) {
    no.push({ id: 'comprobante', label: 'Qué documento lo ampara', motivo: 'falta decir qué documento ampara el gasto (factura, ticket o cotización)' });
  } else {
    const f = avisoDeFechas(c.fecha, e.fecha_solicitud);
    if (!f.ok && f.bloquea) no.push({ id: 'fecha_documento', label: 'La fecha del documento', motivo: f.motivo });
    else if (!f.ok && !String(e.motivo_fecha ?? '').trim()) no.push({ id: 'motivo_fecha', label: 'Por qué hasta ahora', motivo: f.motivo });
  }

  /**
   * Cómo se pagó y el archivo: la MISMA regla del vale de hoy (`faltaParaMandar`), no una copia. Su
   * faltante `concepto` (texto libre) no aplica: aquí el concepto es el renglón, ya revisado arriba.
   * Con el CFDI casado al SAT no se pide foto: el documento fiscal ES la evidencia.
   * DS17: la solicitud se paga DESPUÉS de pedirse, así que la referencia o el cheque no se exigen (llegan al
   * pagar, como en la nómina de GX.111); si se escriben, se valida su forma.
   */
  for (const f of faltaParaMandar({
    forma_pago: e.forma_pago, forma_pago_detalle: e.forma_pago_detalle, archivos: e.archivos,
    exige_evidencia: !evidenciaEsElSat(c), concepto: 'renglones', se_paga_despues: true,
  })) {
    if (f.id === 'forma_pago' || f.id === 'forma_pago_detalle' || f.id === 'evidencia') no.push({ id: f.id, label: f.label, motivo: f.motivo });
  }

  // S.17 (DS31): la información de pago es opcional; lo que se escribió tiene que tener forma (va al banco).
  const p = e.pago;
  if (p) {
    const c = cuentaDePago(p.cuenta);
    if (c && !c.ok) no.push({ id: 'pago_cuenta', label: 'La cuenta', motivo: c.motivo });
    if (String(p.banco ?? '').trim().length > LARGO_BANCO) no.push({ id: 'pago_banco', label: 'El banco', motivo: `El nombre del banco pasa de ${LARGO_BANCO} letras` });
    const correo = String(p.correo ?? '').trim();
    if (correo && !correoValido(correo)) no.push({ id: 'pago_correo', label: 'El correo', motivo: `«${correo.slice(0, 60)}» no es un correo: escribe una sola dirección, con @ y su dominio` });
  }
  return no;
}

/** ¿Se puede pedir? */
export function puedePedir(e: EstadoSolicitudGasto): boolean {
  return faltaParaPedir(e).length === 0;
}

// ── La API (`/finance/expenses/solicitudes`) ─────────────────────────────────────────────────

/**
 * De dónde salió un dato prellenado. Se guarda para medir la automatización (anexo, métrica 2). `catalogo` = del
 * catálogo de acreedores de Kepler (`kdxd`: los días de crédito y el correo, S.17).
 */
export type FuenteDelDato = 'cfdi' | 'ticket' | 'habito' | 'catalogo' | 'sesion' | 'persona';

/** Un archivo ya subido (`POST /finance/expenses/proofs/upload`), como lo guarda el vale. */
export interface ArchivoDeLaSolicitud {
  role: string; url: string; public_id?: string; kind?: string; name?: string; live?: boolean; captured_at?: string;
}

/** `POST /finance/expenses/solicitudes` — lo que manda la pantalla «Pedir» o «Registrar». */
export interface CrearSolicitudGastoDto {
  /**
   * UUID que la pantalla genera UNA vez por solicitud y repite si reintenta: si la respuesta se perdió y ya se
   * guardó, el servidor devuelve la misma en lugar de crear otra (idempotencia). Es el id del vale.
   */
  id_cliente?: string | null;
  sucursal: string;
  acreedor: string;
  renglones: RenglonDeLaSolicitud[];
  iva: number;
  comprobante: ComprobanteDeLaSolicitud;
  forma_pago: string;
  forma_pago_detalle?: string | null;
  files?: ArchivoDeLaSolicitud[];
  /** Nota libre; si viene, es el comentario de Kepler (`c24`). Si no, se arma del concepto, periodo y unidad. */
  comentario?: string | null;
  periodo_del?: string | null;
  periodo_al?: string | null;
  unidad?: string | null;
  /** `YYYY-MM-DD`: la fecha de pago (`c18`). S.17: la calcula el plazo (`fechaDePago`). */
  necesita_para?: string | null;
  motivo_fecha?: string | null;
  /** S.17 (DS31): a dónde se paga y a quién se manda el comprobante. Opcional. */
  pago?: InformacionDePago | null;
  /** Procedencia de cada dato prellenado, por campo (`acreedor`, `concepto`, `importe`, …). */
  fuentes?: Record<string, FuenteDelDato>;
}

export interface DuplicadoProbable {
  /** Dónde está la otra: un vale de la Suite o una solicitud ya capturada en Kepler. */
  donde: 'suite' | 'kepler';
  id: string | null;
  folio: string | null;
  fecha: string;
  total: number;
}

export interface SolicitudGastoCreada {
  id: string;
  status: string;
  kepler_request_status: string;
  total: number;
  retroactiva: boolean;
  /**
   * Mismo acreedor e importe el mismo día. ⚠️ Medido: con sólo acreedor + importe el ruido es del 50 %
   * (395 pares contra 197 de un placebo): es un AVISO para que la persona confirme, no un bloqueo.
   */
  duplicados: DuplicadoProbable[];
}

export interface AcreedorDeGasto {
  clave: string;
  nombre: string;
  rfc: string | null;
  /** Solicitudes de ese acreedor en la sucursal, 180 días: los frecuentes van primero. */
  usos: number;
}

export interface ConceptoDeGasto {
  codigo: string;
  nombre: string;
  /** `kdco.c3` del servidor. */
  cuenta: string;
  /** `null` si entra; el motivo si la cuenta es de SUA, impuestos, activo o capital. */
  fuera_de_alcance: string | null;
  /**
   * R14: `null` si entra; el motivo si en este servidor la cuenta es de OTRO rubro que en CEDIS (`conceptoDistintoDeCedis`).
   * La pantalla lo muestra (no lo esconde) y el servidor rechaza pedir con él. Opcional: un servidor viejo no lo manda.
   */
  distinto_de_cedis?: string | null;
}

/** `GET /finance/expenses/solicitudes/catalogo?sucursal=` — lo que la pantalla ofrece para elegir. */
export interface CatalogoDeLaSolicitud {
  sucursal: string;
  conceptos: ConceptoDeGasto[];
  proyectos: Array<{ codigo: string; nombre: string }>;
  departamentos: Array<{ codigo: string; nombre: string }>;
}

/** `GET /finance/expenses/solicitudes/precarga?sucursal=&acreedor=` — «como la última vez», con su origen. */
export interface PrecargaDeLaSolicitud {
  acreedor: AcreedorDeGasto | null;
  alcance: Alcance;
  /** Los 3 conceptos más usados con ese acreedor en la sucursal (el 1º acierta el 73.4 %). */
  conceptos: Array<ConceptoDeGasto & { usos: number }>;
  /** El último renglón con ese acreedor: proyecto y departamento (`fuente: 'habito'`). */
  ultimo: { concepto: string; proyecto: string; departamento: string; fecha: string } | null;
  /** La forma de pago del último vale a ese acreedor. */
  forma_pago: string | null;
  /**
   * S.17 (DS30): el plazo propuesto en días (0 = de contado): `catalogo` = los días de crédito del acreedor en Kepler
   * (`kdxd.c16`, sólo 12 de 223 lo tienen); `habito` = el de su última solicitud en la sucursal. `null` = sin dato.
   */
  plazo?: { dias: number; fuente: 'catalogo' | 'habito' } | null;
  /**
   * S.17 (DS31): la información de pago propuesta, cada dato con su origen: el correo de Kepler (`kdxd.c11`) o el de
   * la última solicitud de la Suite; la cuenta y el banco, sólo de la última solicitud de la Suite (ningún catálogo
   * tiene la CLABE). `null` = nada que proponer.
   */
  pago?: { cuenta: string | null; banco: string | null; correo: string | null; fuente_cuenta: 'habito' | null; fuente_correo: 'catalogo' | 'habito' | null } | null;
}

/**
 * `GET /finance/expenses/solicitudes/disponibilidad?sucursal=` — ¿la puerta «Pedir o registrar» está abierta en
 * esa sucursal? Sólo cuando la escritura en Kepler está encendida DE PUNTA A PUNTA (bandera, plantilla y conexión
 * del servidor, interruptor y la migración): si no, lo pedido en la Suite nunca llegaría a Kepler y Finanzas no
 * podría aplicar el gasto. La puerta se abre sucursal por sucursal, conforme se enciende cada servidor.
 */
export interface DisponibilidadDeLaSolicitud {
  sucursal: string;
  disponible: boolean;
  /** Por qué no, en el orden en que hay que resolverlo (vacío si está disponible). */
  motivos: string[];
}

/**
 * `POST /finance/expenses/solicitudes/leer-comprobante` — lo que la Suite sacó sola de la foto: el lector
 * propone (GX.33: nunca decide), y con el RFC busca al acreedor en el catálogo y la factura en el SAT.
 */
export interface LecturaDelComprobante {
  /** `false` = no se pudo leer: la persona captura a mano (no se inventa nada). */
  legible: boolean;
  motivo: string | null;
  leido: { total: number | null; subtotal: number | null; iva: number | null; fecha: string | null; folio: string | null; rfc: string | null; comercio: string | null } | null;
  /** El acreedor del catálogo de esa sucursal con ese RFC, si es UNO (con dos o más se pregunta). */
  acreedor: AcreedorDeGasto | null;
  /**
   * La factura recibida del SAT con ese RFC, total ±$1 y fecha ±5 días, si es UNA. Trae `descuento` y `retenidos`
   * porque la solicitud sólo modela importe + IVA: si `subtotal − descuento + iva ≠ total` (retenciones o impuestos
   * locales), la pantalla NO la usa como certeza (`cfdiCuadra`).
   */
  cfdi: { uuid: string; folio: string | null; fecha: string; subtotal: number; descuento: number; iva: number; retenidos: number; total: number } | null;
}

/**
 * ¿La factura del SAT se puede usar tal cual como importe + IVA? Sólo si `subtotal − descuento + IVA = total` (±1¢).
 * Con retenciones o impuestos locales no: la solicitud no los modela y Kepler recibiría otro total.
 */
export function cfdiCuadra(c: { subtotal: number; descuento?: number | null; iva: number; total: number } | null | undefined): boolean {
  if (!c) return false;
  return Math.abs(cent(Number(c.subtotal) - Number(c.descuento ?? 0) + Number(c.iva)) - cent(c.total)) <= 1;
}

/** Por vale: cómo va su escritura en Kepler (para la tarjeta del vale y Aprobación). */
export interface EstadoKeplerDeLaSolicitud {
  id: string;
  status: string | null;
  folio: string | null;
  nota: string | null;
  intentos: number;
  siguiente: string | null;
}

/**
 * `GET …/solicitudes/abiertas` — las bases donde ESTA persona puede pedir hoy: las abiertas (la misma regla que
 * `disponibilidad`) que son suyas (S.17, `basesDeQuienPide`).
 */
export interface SucursalesAbiertasDeLaSolicitud {
  sucursales: string[];
  /** Cómo se decidió, para decirlo cuando no hay ninguna (S.17). Un servidor anterior no lo manda. */
  alcance?: AlcanceDeLaBase;
}

/** `GET …/solicitudes/:id/detalle` — lo que se escribe en Kepler al firmarla, para que quien firma lo vea antes. */
export interface DetalleDeLaSolicitud {
  id: string;
  sucursal: string;
  acreedor: { clave: string; nombre: string | null };
  renglones: Array<{ linea: number; concepto: string; nombre: string | null; cuenta: string | null; proyecto: string; departamento: string; importe: number }>;
  iva: number;
  total: number;
  documento: { tipo: string | null; folio: string | null; fecha: string | null; uuid: string | null };
  fecha_solicitud: string | null;
  /** S.17: la fecha de pago pedida (`c18`); `null` = de contado (la de solicitud). */
  necesita_para?: string | null;
  /** S.17 (DS31): a dónde se paga y a quién se manda el comprobante; `null` si no se capturó. */
  pago?: InformacionDePago | null;
}
