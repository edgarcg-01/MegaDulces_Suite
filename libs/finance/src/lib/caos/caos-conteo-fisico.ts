import { DENOMINACIONES_CAOS, type CaosConteoPieza } from '@megadulces/contracts';

/**
 * `[CGS.22]` La aritmética del conteo físico de la caja fuerte. Pura: la prueba no necesita base.
 *
 * ⚠️ Liberal con la forma, estricto con el significado (Postel): se ignoran los renglones en 0,
 * pero una denominación que la máquina no maneja, o piezas negativas o con decimales, se rechazan
 * con su frase — no se «corrigen».
 */
export type MotivoConteoInvalido = 'vacio' | 'denominacion' | 'piezas';

export const TEXTO_CONTEO_INVALIDO: Record<MotivoConteoInvalido, string> = {
  vacio: 'Anota cuántas piezas contaste de cada billete. Si la caja fuerte está vacía, escribe 0 en alguno y una nota.',
  denominacion: `La caja fuerte sólo maneja billetes de ${DENOMINACIONES_CAOS.map((d) => `$${d}`).join(', ')}.`,
  piezas: 'Las piezas tienen que ser números enteros, cero o más.',
};

export function validarConteo(piezas: unknown): { ok: true; piezas: CaosConteoPieza[]; total: number } | { ok: false; motivo: MotivoConteoInvalido } {
  if (!Array.isArray(piezas) || !piezas.length) return { ok: false, motivo: 'vacio' };
  const limpias: CaosConteoPieza[] = [];
  for (const p of piezas as Array<Record<string, unknown>>) {
    const denominacion = Number(p?.['denominacion']);
    const n = Number(p?.['piezas']);
    if (!DENOMINACIONES_CAOS.includes(denominacion)) return { ok: false, motivo: 'denominacion' };
    if (!Number.isInteger(n) || n < 0) return { ok: false, motivo: 'piezas' };
    if (n > 0) limpias.push({ denominacion, piezas: n });
  }
  // Todo en cero es válido (caja fuerte vacía): se declara con el renglón en 0, no con la lista vacía.
  limpias.sort((a, b) => b.denominacion - a.denominacion);
  const total = Math.round(limpias.reduce((a, p) => a + p.denominacion * p.piezas, 0) * 100) / 100;
  return { ok: true, piezas: limpias, total };
}

/** `null` = no había contra qué comparar: la diferencia NO es cero, no se midió (ADR-056). */
export function diferenciaContra(total: number, referencia: number | null): number | null {
  if (referencia == null) return null;
  return Math.round((total - referencia) * 100) / 100;
}
