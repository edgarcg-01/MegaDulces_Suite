/**
 * `[LE.3.4]` — Reconstruir la historia con las MISMAS reglas que registran el día de hoy, sobre un
 * libro en memoria (sin tocar la base), y compararla contra los testigos de la máquina.
 *
 * Sirve dos veces: (1) como medición en seco — ¿las reglas nuevas reproducen lo que la máquina
 * dijo que tenía? — y (2) como el armado de la carga real de la historia (LE.3.6), que registra
 * exactamente estos asientos.
 *
 * El libro en memoria aplica lo mismo que la base en lo que importa para la reconstrucción: suma
 * por cuenta y por pieza, y DECLARA (no rechaza) una cuenta física que quedaría negativa — en la
 * historia eso es un hallazgo, no un error de captura que se pueda devolver.
 */
import type { PiezasTexto } from '@megadulces/contracts';
import { type MovimientoCaos } from './identidad';
import { esSinRegla, movimientoCaos, type ClasificacionCaos, type Contexto, type Propuesta } from './reglas';

export interface LibroEnMemoria {
  saldos: Map<string, bigint>;
  piezas: Map<string, Map<string, bigint>>;
}

export const libroVacio = (): LibroEnMemoria => ({ saldos: new Map(), piezas: new Map() });

/** Aplica un asiento. Devuelve las piezas o saldos FÍSICOS que quedaron negativos (hallazgos). */
export function aplicar(libro: LibroEnMemoria, p: Propuesta): string[] {
  const fisicas = new Set(p.cuentas.filter((c) => c.class === 'fisica' || c.class === 'custodia' || c.class === 'transito').map((c) => c.code));
  const negativos: string[] = [];
  for (const l of p.asiento.lines) {
    const s = (libro.saldos.get(l.account) ?? 0n) + BigInt(l.amount_minor);
    libro.saldos.set(l.account, s);
    if (fisicas.has(l.account) && s < 0n) negativos.push(`${l.account} = ${s}`);
    for (const [k, v] of Object.entries(l.pieces ?? {})) {
      const porCuenta = libro.piezas.get(l.account) ?? new Map<string, bigint>();
      const n = (porCuenta.get(k) ?? 0n) + BigInt(v);
      porCuenta.set(k, n);
      libro.piezas.set(l.account, porCuenta);
      if (n < 0n) negativos.push(`${l.account} ${k} = ${n}`);
    }
  }
  return negativos;
}

export function piezasDe(libro: LibroEnMemoria, cuenta: string): PiezasTexto {
  const fuera: PiezasTexto = {};
  for (const [k, n] of [...(libro.piezas.get(cuenta) ?? new Map<string, bigint>())].sort(([a], [b]) => a.localeCompare(b))) {
    if (n !== 0n) fuera[k] = n.toString();
  }
  return fuera;
}

export interface PuntoDeControl {
  external_id: string;
  fecha: string;
  tipo: string;
  /** Lo que el libro reconstruido dice que hay en la bóveda en ese momento. */
  libro: PiezasTexto;
  /** Lo que la máquina dijo (la foto de «Fin de Día») o `{}` justo después de un vaciado. */
  testigo: PiezasTexto | null;
  cuadra: boolean | null;
}

export interface Reconstruccion {
  libro: LibroEnMemoria;
  asientos: Propuesta[];
  sinRegla: { external_id: string; motivo: string }[];
  negativos: { external_id: string; detalle: string[] }[];
  puntos: PuntoDeControl[];
}

const iguales = (a: PiezasTexto, b: PiezasTexto): boolean =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/**
 * Reproduce los movimientos de la máquina EN EL ORDEN DE SU NUMERACIÓN, desde una bóveda vacía.
 * Cada «Fin de Día» es un testigo (la máquina lee su contenido). Quien llama elige el punto de
 * partida: debe ser un momento en que un testigo dijo «cero» (en LE.3.4: después del vaciado #1607
 * del 15-oct, que vació lo mismo que leyó el «Fin de Día» #1606).
 *
 * ── Medido el 2026-10-27 (pg-prod, sólo lectura) ────────────────────────────────────────────
 *  · Desde el #1607, 46 movimientos hasta el inventario de casetes del 20-oct 10:04: el libro da
 *    {500: 507, 200: 383, 100: 252, 50: 46, 20: 121} = $360,020, IGUAL al testigo en las 5.
 *  · Desde el vaciado del 17-jun: los tramos al 7-jul y al 18-ago cierran en cero en las 5; entre
 *    el 18-ago y el 30-sep queda un residuo de $49,860 que nace de 3 «Contenido Modificado» sin
 *    piezas y del vaciado #1478 cuyo total no coincide con su desglose — un hallazgo, no una regla.
 */
export function reproducirCaos(movs: readonly MovimientoCaos[], ctx: Contexto,
  clasificar: (m: MovimientoCaos) => ClasificacionCaos | undefined = () => undefined): Reconstruccion {
  const r: Reconstruccion = { libro: libroVacio(), asientos: [], sinRegla: [], negativos: [], puntos: [] };
  const ordenados = [...movs].sort((a, b) => Number(a.external_id) - Number(b.external_id));
  for (const m of ordenados) {
    const fecha = new Date(m.occurred_at).toISOString();
    if (m.type_id === 2) {
      const foto: PiezasTexto = {};
      for (const p of m.piezas) foto[String(Math.abs(Number(p.denom)))] = String(p.quantity);
      const libro = piezasDe(r.libro, 'BOVEDA_CAOS');
      r.puntos.push({ external_id: String(m.external_id), fecha, tipo: 'fin_de_dia', libro, testigo: foto, cuadra: iguales(libro, foto) });
      continue;
    }
    const res = movimientoCaos(m, { ...ctx, valueAt: fecha }, clasificar(m));
    if (esSinRegla(res)) { r.sinRegla.push({ external_id: String(m.external_id), motivo: res.motivo }); continue; }
    r.asientos.push(res);
    const neg = aplicar(r.libro, res);
    if (neg.length) r.negativos.push({ external_id: String(m.external_id), detalle: neg });
    if (m.type_id === 5) {
      // Informativo, NO testigo: medido en LE.3.4 que hay vaciados parciales (8-sep: tres seguidos).
      r.puntos.push({ external_id: String(m.external_id), fecha, tipo: 'despues_de_vaciar', libro: piezasDe(r.libro, 'BOVEDA_CAOS'), testigo: null, cuadra: null });
    }
  }
  return r;
}

/** Diferencia por denominación (libro − testigo). Vacía = cuadra en todas. */
export function diferenciaContraTestigo(libro: PiezasTexto, testigo: PiezasTexto): Record<string, string> {
  const dif: Record<string, string> = {};
  for (const k of new Set([...Object.keys(libro), ...Object.keys(testigo)])) {
    const d = BigInt(libro[k] ?? '0') - BigInt(testigo[k] ?? '0');
    if (d !== 0n) dif[k] = d.toString();
  }
  return dif;
}
