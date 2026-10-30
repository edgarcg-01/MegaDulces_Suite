import {
  SALIDAS_DE, denomDe, textoDocumento,
  type ClasePapel, type DocumentoArqueoInput, type DocumentoEnCaja, type NuevoArqueoCajaInput, type PiezaArqueoCaja,
  type ResumenApartado, type SalidaDocumento, type TipoArqueoCaja, type TipoDocumentoCaja,
} from '@megadulces/contracts';

/**
 * ⭐ `[CGS.42]` — **El arqueo completo de la caja, sin base de por medio.** Lo usa el servicio que
 * lo guarda; la prueba no necesita Postgres.
 *
 * Reemplaza lo que contaba el Access de Control (jubilado el 2026-10-22, Edgar): efectivo pieza por
 * pieza, caja fuerte, cheques, vales y papeles, y dólares con su tipo de cambio.
 *
 * ⚠️ Liberal con la forma, estricto con el significado (Postel): los renglones en 0 se ignoran,
 * pero una pieza que no existe en el catálogo, piezas con decimales o un tipo de cambio sin fuente
 * se rechazan con su frase — no se «corrigen».
 *
 * ⛔ **Un rubro vacío es «no se contó», no cero.** Si la persona no escribió cheques, se guarda
 * `null` y el arqueo queda incompleto; poner 0 afirmaría que se contó y no había.
 */

export type MotivoArqueoInvalido =
  | 'tipo' | 'sin_corte' | 'piezas_vacias' | 'denominacion' | 'piezas' | 'monto'
  | 'caja_fuerte_sin_fuente' | 'dolares_sin_cambio' | 'documentos_sin_detalle';

export const TEXTO_ARQUEO_INVALIDO: Record<MotivoArqueoInvalido, string> = {
  tipo: 'El arqueo es un recuento de un corte o un arqueo a media jornada.',
  sin_corte: 'El recuento tiene que decir qué corte se vuelve a contar.',
  piezas_vacias: 'Anota cuántas piezas contaste de cada billete y moneda. Si el cajón está vacío, escribe 0 en alguno y una nota.',
  denominacion: 'Esa pieza no existe en el catálogo de billetes y monedas.',
  piezas: 'Las piezas tienen que ser números enteros, cero o más.',
  monto: 'Los montos no pueden ser negativos.',
  caja_fuerte_sin_fuente: 'Di de dónde sale la cifra de la caja fuerte (la pantalla de la máquina o un conteo físico).',
  dolares_sin_cambio: 'Con dólares hace falta el tipo de cambio y de dónde salió (banco, DOF, Kepler…).',
  documentos_sin_detalle: 'Los cheques y los papeles se anotan uno por uno: su importe sale de sus renglones, no se teclea.',
};

export interface ArqueoValido {
  tipo: TipoArqueoCaja;
  corte_id: string | null;
  piezas: PiezaArqueoCaja[];
  morralla: number;
  efectivo: number;
  caja_fuerte: number | null;
  caja_fuerte_fuente: string | null;
  cheques: number | null;
  papeles: number | null;
  usd: number | null;
  tipo_cambio: number | null;
  tipo_cambio_fuente: string | null;
  nota: string | null;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
/** `null`/`undefined`/'' = no se contó; cualquier otro valor tiene que ser un número ≥ 0. */
const monto = (v: unknown): number | null | 'mal' => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? r2(n) : 'mal';
};
const texto = (v: unknown): string | null => {
  const s = v == null ? '' : String(v).trim();
  return s ? s : null;
};

export function validarArqueo(input: Partial<NuevoArqueoCajaInput> | null | undefined):
  { ok: true; arqueo: ArqueoValido } | { ok: false; motivo: MotivoArqueoInvalido } {
  const i = input ?? {};
  if (i.tipo !== 'recuento' && i.tipo !== 'intermedio') return { ok: false, motivo: 'tipo' };
  const corte_id = texto(i.corte_id);
  if (i.tipo === 'recuento' && !corte_id) return { ok: false, motivo: 'sin_corte' };

  if (!Array.isArray(i.piezas) || !i.piezas.length) return { ok: false, motivo: 'piezas_vacias' };
  const piezas: PiezaArqueoCaja[] = [];
  let suma = 0;
  for (const p of i.piezas as Array<Partial<PiezaArqueoCaja>>) {
    const d = denomDe(String(p?.denom_key ?? ''));
    if (!d) return { ok: false, motivo: 'denominacion' };
    const n = Number(p?.piezas);
    if (!Number.isInteger(n) || n < 0) return { ok: false, motivo: 'piezas' };
    if (n > 0) { piezas.push({ denom_key: d.key, piezas: n }); suma += d.valor * n; }
  }

  // ⛔ `[CGS.59]` Cheques y papeles ya no se teclean: salen de sus renglones (`validarDocumentos`).
  const tecleado = (v: unknown): boolean => v !== null && v !== undefined && v !== '';
  if (tecleado(i.cheques) || tecleado(i.papeles)) return { ok: false, motivo: 'documentos_sin_detalle' };

  const morralla = monto(i.morralla) ?? 0;
  const caja_fuerte = monto(i.caja_fuerte);
  const usd = monto(i.usd);
  // ⛔ El tipo de cambio NO se redondea a centavos: 19.101 → 19.10 movía $12.06 los dólares de A23706.
  const tcCrudo = i.tipo_cambio === null || i.tipo_cambio === undefined || (i.tipo_cambio as unknown) === '' ? null : Number(i.tipo_cambio);
  const tipo_cambio: number | null | 'mal' = tcCrudo === null ? null
    : Number.isFinite(tcCrudo) && tcCrudo >= 0 ? Math.round(tcCrudo * 10000) / 10000 : 'mal';
  if ([morralla, caja_fuerte, usd, tipo_cambio].includes('mal')) return { ok: false, motivo: 'monto' };

  const caja_fuerte_fuente = texto(i.caja_fuerte_fuente);
  if (caja_fuerte !== null && !caja_fuerte_fuente) return { ok: false, motivo: 'caja_fuerte_sin_fuente' };
  const tipo_cambio_fuente = texto(i.tipo_cambio_fuente);
  if (typeof usd === 'number' && usd > 0 && (!(typeof tipo_cambio === 'number' && tipo_cambio > 0) || !tipo_cambio_fuente)) {
    return { ok: false, motivo: 'dolares_sin_cambio' };
  }

  return {
    ok: true,
    arqueo: {
      tipo: i.tipo, corte_id,
      piezas: piezas.sort((a, b) => (denomDe(b.denom_key)?.valor ?? 0) - (denomDe(a.denom_key)?.valor ?? 0)),
      morralla: morralla as number,
      efectivo: r2(suma + (morralla as number)),
      caja_fuerte: caja_fuerte as number | null,
      caja_fuerte_fuente: caja_fuerte === null ? null : caja_fuerte_fuente,
      // Los pone el servicio con la suma de sus renglones (`validarDocumentos`).
      cheques: null,
      papeles: null,
      usd: usd as number | null,
      tipo_cambio: typeof usd === 'number' && usd > 0 ? (tipo_cambio as number) : null,
      tipo_cambio_fuente: typeof usd === 'number' && usd > 0 ? tipo_cambio_fuente : null,
      nota: texto(i.nota),
    },
  };
}

/** La suma en pesos de lo contado. `null` si falta algún rubro: lo que no se contó no se suma como cero. */
export function totalArqueo(a: {
  efectivo: number; caja_fuerte: number | null; cheques: number | null; papeles: number | null;
  usd: number | null; tipo_cambio: number | null;
}): number | null {
  if (a.caja_fuerte === null || a.cheques === null || a.papeles === null || a.usd === null) return null;
  const dolares = a.usd > 0 ? (a.tipo_cambio === null ? NaN : a.usd * a.tipo_cambio) : 0;
  if (!Number.isFinite(dolares)) return null;
  return r2(a.efectivo + a.caja_fuerte + a.cheques + a.papeles + dolares);
}

export type MotivoNoRecuenta = 'corte_abierto' | 'mismo_que_cerro';

export const TEXTO_NO_RECUENTA_CORTE: Record<MotivoNoRecuenta, string> = {
  corte_abierto: 'Ese corte todavía no se cierra: se recuenta lo que ya se contó y se selló.',
  mismo_que_cerro: 'Contaste o cerraste ese corte: el recuento lo hace otra persona, si no, no es testigo de nada.',
};

/**
 * `[CGS.42]` ¿Esta persona puede recontar este corte? Decisión de Edgar del 2026-10-22: **María
 * recuenta cada mañana, a ciegas**. Un recuento hecho por quien contó o cerró el corte no es un
 * segundo conteo: es el mismo conteo dos veces.
 */
export function puedeRecontarCorte(
  corte: { estado: string; created_by?: string | null; closed_by?: string | null },
  userId: string,
): { ok: true } | { ok: false; motivo: MotivoNoRecuenta } {
  if (corte.estado === 'borrador') return { ok: false, motivo: 'corte_abierto' };
  if (userId === corte.created_by || userId === corte.closed_by) return { ok: false, motivo: 'mismo_que_cerro' };
  return { ok: true };
}

// ── `[CGS.59]` Cheques y papeles, uno por uno ───────────────────────────────────────────────────

export type MotivoDocumentoInvalido =
  | 'forma' | 'falta_anterior' | 'pieza_desconocida' | 'pieza_repetida' | 'salida' | 'salida_sin_nota'
  | 'nuevo_salio' | 'monto' | 'cheque_incompleto' | 'papel_incompleto' | 'cheque_repetido' | 'fecha';

export const TEXTO_DOCUMENTO_INVALIDO: Record<MotivoDocumentoInvalido, string> = {
  forma: 'La lista de cheques o de papeles no se entiende.',
  falta_anterior: 'Marca cada documento que había en el arqueo anterior: si sigue en la caja o si salió.',
  pieza_desconocida: 'Ese documento no estaba en el arqueo anterior: vuelve a abrir «Contar la caja».',
  pieza_repetida: 'Un documento del arqueo anterior viene dos veces.',
  salida: 'Di por qué salió: un cheque se depositó o lo devolvió el banco; un papel lo pagaron o se comprobó.',
  salida_sin_nota: 'Con «otra cosa», escribe qué pasó con el documento.',
  nuevo_salio: 'Un documento nuevo no puede «salir»: si no está en la caja, no se anota.',
  monto: 'El importe de cada documento es mayor que cero, con centavos como mucho.',
  cheque_incompleto: 'Cada cheque nuevo lleva banco, número, de quién es e importe.',
  papel_incompleto: 'Cada papel nuevo dice si es vale o crédito, quién debe, por qué e importe.',
  cheque_repetido: 'Ese cheque (banco y número) ya está en la lista.',
  fecha: 'La fecha del documento no se entiende.',
};

/** Un renglón listo para guardar. `pieza` en `null` = nuevo: el servicio le da su identidad. */
export interface FilaDocumento {
  pieza: string | null;
  tipo: TipoDocumentoCaja;
  clase: ClasePapel | null;
  estado: 'esta' | 'salio';
  salida: SalidaDocumento | null;
  salida_nota: string | null;
  monto: number;
  banco: string | null;
  numero: string | null;
  de_quien: string;
  concepto: string | null;
  fecha: string | null;
}

const montoPositivo = (v: unknown): number | null => {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n) || n <= 0) return null;
  return Math.abs(n * 100 - Math.round(n * 100)) < 1e-6 ? r2(n) : null;
};
const fechaValida = (s: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const llaveCheque = (f: { banco: string | null; numero: string | null }): string =>
  `${String(f.banco ?? '').trim().toUpperCase()}|${String(f.numero ?? '').trim()}`;

/**
 * `[CGS.59]` Un apartado del arqueo (los cheques o los papeles) contra lo que había en el arqueo
 * anterior que lo contó. Edgar, 2026-10-30: «cuando hay un cheque, crédito o papel… cómo agregar
 * esos apartados».
 *
 *  · `null` = no se contó: el importe queda `null` y lo que había espera al siguiente conteo.
 *  · Cada documento que había se marca UNA vez: sigue (sus datos se copian; no se pueden cambiar)
 *    o salió, con su salida. Ninguno desaparece sin decir a dónde fue: eso arrastraba Control.
 *  · Uno nuevo lleva lo que lo identifica. El cheque, banco y número (y no se repite); el papel,
 *    si es vale o crédito, quién debe y por qué.
 *  · El importe del apartado es la suma de los que ESTÁN (la base lo vuelve a comprobar).
 *
 * El cheque puede venir con fecha futura (posfechado): sólo se valida que la fecha exista.
 */
export function validarDocumentos(
  tipo: TipoDocumentoCaja,
  anteriores: readonly DocumentoEnCaja[],
  entrada: readonly Partial<DocumentoArqueoInput>[] | null | undefined,
): { ok: true; total: number | null; filas: FilaDocumento[] } | { ok: false; motivo: MotivoDocumentoInvalido } {
  if (entrada === null || entrada === undefined) return { ok: true, total: null, filas: [] };
  if (!Array.isArray(entrada)) return { ok: false, motivo: 'forma' };
  const porPieza = new Map(anteriores.filter((a) => a.tipo === tipo).map((a) => [a.pieza, a]));
  const vistas = new Set<string>();
  const filas: FilaDocumento[] = [];

  for (const e of entrada as Array<Partial<DocumentoArqueoInput> | null>) {
    if (!e || typeof e !== 'object') return { ok: false, motivo: 'forma' };
    const pieza = texto(e.pieza);
    if (pieza) {
      const a = porPieza.get(pieza);
      if (!a) return { ok: false, motivo: 'pieza_desconocida' };
      if (vistas.has(pieza)) return { ok: false, motivo: 'pieza_repetida' };
      vistas.add(pieza);
      const datos = {
        pieza, tipo, clase: a.clase, monto: a.monto, banco: a.banco, numero: a.numero,
        de_quien: a.de_quien, concepto: a.concepto, fecha: a.fecha,
      };
      if (e.estado === 'esta') {
        if (texto(e.salida)) return { ok: false, motivo: 'salida' };
        filas.push({ ...datos, estado: 'esta', salida: null, salida_nota: null });
        continue;
      }
      if (e.estado !== 'salio') return { ok: false, motivo: 'salida' };
      const salida = e.salida as SalidaDocumento | null | undefined;
      if (!salida || !SALIDAS_DE[tipo].includes(salida)) return { ok: false, motivo: 'salida' };
      const nota = texto(e.salida_nota);
      if (salida === 'otro' && (!nota || nota.length < 3)) return { ok: false, motivo: 'salida_sin_nota' };
      filas.push({ ...datos, estado: 'salio', salida, salida_nota: nota });
      continue;
    }

    // Uno nuevo.
    if (e.estado !== 'esta') return { ok: false, motivo: 'nuevo_salio' };
    const monto = montoPositivo(e.monto);
    if (monto === null) return { ok: false, motivo: 'monto' };
    const fecha = texto(e.fecha);
    if (fecha && !fechaValida(fecha)) return { ok: false, motivo: 'fecha' };
    const de_quien = texto(e.de_quien);
    const concepto = texto(e.concepto);
    if (tipo === 'cheque') {
      const banco = texto(e.banco);
      const numero = texto(e.numero);
      if (!banco || banco.length < 2 || !numero || !de_quien || de_quien.length < 3) return { ok: false, motivo: 'cheque_incompleto' };
      filas.push({ pieza: null, tipo, clase: null, estado: 'esta', salida: null, salida_nota: null, monto, banco, numero, de_quien, concepto, fecha });
    } else {
      const clase = e.clase;
      if ((clase !== 'vale' && clase !== 'credito') || !de_quien || de_quien.length < 3 || !concepto || concepto.length < 3) {
        return { ok: false, motivo: 'papel_incompleto' };
      }
      filas.push({ pieza: null, tipo, clase, estado: 'esta', salida: null, salida_nota: null, monto, banco: null, numero: null, de_quien, concepto, fecha });
    }
  }

  if (vistas.size !== porPieza.size) return { ok: false, motivo: 'falta_anterior' };
  if (tipo === 'cheque') {
    const llaves = filas.map(llaveCheque);
    if (new Set(llaves).size !== llaves.length) return { ok: false, motivo: 'cheque_repetido' };
  }
  const total = r2(filas.filter((f) => f.estado === 'esta').reduce((s, f) => s + f.monto, 0));
  return { ok: true, total, filas };
}

/** `[CGS.59]` Lo que cambió en un apartado, para decirlo al guardar. */
export function resumenDocumentos(filas: readonly FilaDocumento[], total: number): ResumenApartado {
  return {
    total,
    siguen: filas.filter((f) => f.pieza !== null && f.estado === 'esta').length,
    entraron: filas.filter((f) => f.pieza === null).length,
    salieron: filas.filter((f) => f.estado === 'salio').map((f) => ({
      texto: textoDocumento(f), monto: f.monto, salida: f.salida as SalidaDocumento, nota: f.salida_nota,
    })),
  };
}
