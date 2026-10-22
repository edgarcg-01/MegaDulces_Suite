import { denomDe, type NuevoArqueoCajaInput, type PiezaArqueoCaja, type TipoArqueoCaja } from '@megadulces/contracts';

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
  | 'caja_fuerte_sin_fuente' | 'dolares_sin_cambio';

export const TEXTO_ARQUEO_INVALIDO: Record<MotivoArqueoInvalido, string> = {
  tipo: 'El arqueo es un recuento de un corte o un arqueo a media jornada.',
  sin_corte: 'El recuento tiene que decir qué corte se vuelve a contar.',
  piezas_vacias: 'Anota cuántas piezas contaste de cada billete y moneda. Si el cajón está vacío, escribe 0 en alguno y una nota.',
  denominacion: 'Esa pieza no existe en el catálogo de billetes y monedas.',
  piezas: 'Las piezas tienen que ser números enteros, cero o más.',
  monto: 'Los montos no pueden ser negativos.',
  caja_fuerte_sin_fuente: 'Di de dónde sale la cifra de la caja fuerte (la pantalla de la máquina o un conteo físico).',
  dolares_sin_cambio: 'Con dólares hace falta el tipo de cambio y de dónde salió (banco, DOF, Kepler…).',
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

  const morralla = monto(i.morralla) ?? 0;
  const caja_fuerte = monto(i.caja_fuerte);
  const cheques = monto(i.cheques);
  const papeles = monto(i.papeles);
  const usd = monto(i.usd);
  // ⛔ El tipo de cambio NO se redondea a centavos: 19.101 → 19.10 movía $12.06 los dólares de A23706.
  const tcCrudo = i.tipo_cambio === null || i.tipo_cambio === undefined || (i.tipo_cambio as unknown) === '' ? null : Number(i.tipo_cambio);
  const tipo_cambio: number | null | 'mal' = tcCrudo === null ? null
    : Number.isFinite(tcCrudo) && tcCrudo >= 0 ? Math.round(tcCrudo * 10000) / 10000 : 'mal';
  if ([morralla, caja_fuerte, cheques, papeles, usd, tipo_cambio].includes('mal')) return { ok: false, motivo: 'monto' };

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
      cheques: cheques as number | null,
      papeles: papeles as number | null,
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
