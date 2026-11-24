/**
 * `[BFU.7.6]` **La cobertura del motor de categoría, para la API**: de los renglones de la descarga del banco de un
 * periodo, cuántos tienen categoría y, de los que no, **por qué y de quién** — y que las partes sumen el total.
 *
 * El motor guarda el motivo al correr (`category_reason`); «Kepler todavía no lo tiene» depende del DÍA, así que se
 * recalcula al leer: pasado el plazo de captura (`PLAZO_DE_CAPTURA` días hábiles) pasa a «Kepler no lo tiene» y al
 * área, aunque el motor no haya vuelto a correr.
 *
 * Un renglón sin categoría y SIN motivo (lo puso una persona sin categoría, o el motor todavía no lo evaluó) no se
 * esconde ni se reparte: va aparte, en `sin_motivo`.
 */
import { diasHabiles, PLAZO_DE_CAPTURA, RESPONSABLE, type MotivoSinCategoria, type Responsable } from './motor-de-categoria';

/** Un grupo leído de la base: renglones del mismo estado, motivo, responsable y día. */
export interface FilaDeCobertura {
  con_categoria: boolean;
  motivo: string | null;
  responsable: string | null;
  /** `YYYY-MM-DD` del movimiento (`null` si no tiene: entonces no se recalcula). */
  fecha: string | null;
  n: number | string;
  monto: number | string | null;
  /** `[BFU.4.5.2]` El área dueña de la categoría (`movement_categories.owner_department_code`); `null` = «Otros». */
  area?: string | null;
  /** `[BFU.4.5.2]` `true` si el dinero entra (depósito). Decide a quién va un «área» sin nombre. */
  entra?: boolean | null;
}

export interface PorResolver { motivo: MotivoSinCategoria | string; responsable: Responsable | string; n: number; monto: number }

/**
 * `[BFU.4.5.2]` A quién le toca cada renglón. `area` es un código de `identity.departments` o uno de estos grupos
 * DECLARADOS (no se reparten en silencio):
 *   · `otros` — con categoría, pero la categoría no tiene área (BFU.4.5.1, Edgar 2026-11-24); los atiende Tesorería;
 *   · `por_asignar` — un RETIRO que Kepler no tiene, sin Calendario ni acreedor que diga de quién es: Tesorería lo asigna;
 *   · `quien_captura` — un DEPÓSITO que Kepler no tiene: va a quien captura los depósitos de esa cuenta
 *     (`analytics.v_kepler_deposit_capturers`, D18), una persona y no un departamento;
 *   · `en_plazo` — Kepler todavía puede capturarlo (D13): de nadie todavía;
 *   · `sin_motivo` — sin categoría y sin motivo: el motor no lo decidió.
 */
export interface CoberturaPorArea {
  area: string;
  /** Departamento que responde por el grupo cuando no es un área (`otros`, `por_asignar` → `tesoreria`); `null` si no hay. */
  atiende: string | null;
  n: number;
  monto: number;
  /** De esos, los que no tienen categoría: lo que el área tiene que resolver. */
  sin_categoria: { n: number; monto: number };
}

const ATIENDE: Record<string, string | null> = { otros: 'tesoreria', por_asignar: 'tesoreria', quien_captura: null, en_plazo: null, sin_motivo: null };

/** El área de un renglón SIN categoría, por su responsable (ya recalculado el plazo) y la dirección del dinero. */
function areaDelResponsable(responsable: string, entra: boolean | null | undefined): string {
  if (responsable === 'nadie_todavia') return 'en_plazo';
  if (responsable === 'area') return entra === true ? 'quien_captura' : 'por_asignar';
  return responsable; // tesoreria · contabilidad · sistemas: son códigos de identity.departments
}

export interface CoberturaDeCategoria {
  /** Renglones de la descarga del banco en el periodo (el universo del motor). */
  evaluados: number;
  con_categoria: { n: number; monto: number };
  /** Sin categoría, por motivo y responsable; el de más dinero primero. */
  por_resolver: PorResolver[];
  /** Sin categoría y sin motivo: no lo decidió el motor. Se declara aparte. */
  sin_motivo: { n: number; monto: number };
  /**
   * Los renglones agrupados contra un conteo INDEPENDIENTE del universo (otra consulta). Si no casan, el agrupado
   * perdió renglones (una fecha nula, un JOIN de más). `null` = no se midió.
   */
  suma_cuadra: boolean | null;
  /** Cuántos «todavía no» ya pasaron el plazo al leer (y por eso se cuentan como «no lo tiene»). */
  vencidos_al_leer: number;
  /** `[BFU.4.5.2]` Todos los renglones, por área: la suma de `n` es `evaluados`. El de más dinero primero. */
  por_area: CoberturaPorArea[];
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export function coberturaDeCategoria(filas: readonly FilaDeCobertura[], hoy: string, totalIndependiente?: number | null): CoberturaDeCategoria {
  let evaluados = 0, vencidos = 0;
  const con = { n: 0, monto: 0 }, sinMotivo = { n: 0, monto: 0 };
  const grupos = new Map<string, PorResolver>();
  const areas = new Map<string, CoberturaPorArea>();
  const sumarArea = (area: string, n: number, monto: number, conCategoria: boolean) => {
    const a = areas.get(area) ?? { area, atiende: area in ATIENDE ? ATIENDE[area] : area, n: 0, monto: 0, sin_categoria: { n: 0, monto: 0 } };
    a.n += n; a.monto += monto;
    if (!conCategoria) { a.sin_categoria.n += n; a.sin_categoria.monto += monto; }
    areas.set(area, a);
  };
  for (const f of filas) {
    const n = Number(f.n || 0), monto = Number(f.monto || 0);
    evaluados += n;
    if (f.con_categoria) { con.n += n; con.monto += monto; sumarArea(f.area || 'otros', n, monto, true); continue; }
    if (!f.motivo) { sinMotivo.n += n; sinMotivo.monto += monto; sumarArea('sin_motivo', n, monto, false); continue; }
    let motivo = f.motivo, responsable = f.responsable || RESPONSABLE[motivo as MotivoSinCategoria] || 'sistemas';
    if (motivo === 'kepler_aun_no_lo_tiene' && f.fecha && diasHabiles(f.fecha, hoy) > PLAZO_DE_CAPTURA) {
      motivo = 'kepler_no_lo_tiene'; responsable = RESPONSABLE.kepler_no_lo_tiene; vencidos += n;
    }
    const k = `${motivo}|${responsable}`;
    const g = grupos.get(k) ?? { motivo, responsable, n: 0, monto: 0 };
    g.n += n; g.monto += monto; grupos.set(k, g);
    sumarArea(areaDelResponsable(responsable, f.entra), n, monto, false);
  }
  const por_resolver = Array.from(grupos.values()).map((g) => ({ ...g, monto: r2(g.monto) }))
    .sort((a, b) => b.monto - a.monto || b.n - a.n);
  const por_area = Array.from(areas.values())
    .map((a) => ({ ...a, monto: r2(a.monto), sin_categoria: { n: a.sin_categoria.n, monto: r2(a.sin_categoria.monto) } }))
    .sort((a, b) => b.monto - a.monto || b.n - a.n);
  return {
    evaluados,
    con_categoria: { n: con.n, monto: r2(con.monto) },
    por_resolver,
    sin_motivo: { n: sinMotivo.n, monto: r2(sinMotivo.monto) },
    suma_cuadra: totalIndependiente == null ? null : Number(totalIndependiente) === evaluados,
    vencidos_al_leer: vencidos,
    por_area,
  };
}
