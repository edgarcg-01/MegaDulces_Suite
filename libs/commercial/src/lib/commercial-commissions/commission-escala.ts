import type { Knex } from 'knex';

/**
 * `[RD.103.2]` — **La escala vigente es la de UNA familia.**
 *
 * Desde `[RD.103.1]` cada versión del tabulador dice de qué familia es (`ruta_directa` · `vecinal`
 * · `tlmk`). Cinco lugares elegían «la escala vigente» con la misma consulta y **sin mirar la
 * familia** (el motor, el alta de una versión, el padrón, los bonos y las nóminas): con una sola
 * escala en la tabla daba lo mismo, pero en cuanto exista la vecinal cualquiera de ellos podía
 * pagarle a Ruta Directa con el tabulador vecinal — gana la de `valid_from` más reciente.
 * Por eso vive en UN lugar y la familia es obligatoria.
 */
export const FAMILIAS_TABULADOR = ['ruta_directa', 'vecinal', 'tlmk'] as const;
export type FamiliaTabulador = (typeof FAMILIAS_TABULADOR)[number];

export function esFamiliaTabulador(x: unknown): x is FamiliaTabulador {
  return typeof x === 'string' && (FAMILIAS_TABULADOR as readonly string[]).includes(x);
}

/** Un código vecinal de Kepler (`2V001`). No decide la familia (D-V2): sólo obliga a declararla. */
export const CODIGO_VECINAL = /^[0-9]V[0-9]/;

/** Una fila de `commercial.commission_scales`. `numeric` llega de pg como string. */
export interface EscalaFila {
  id: string;
  tenant_id: string;
  code: string;
  nombre: string | null;
  valid_from: string | Date;
  valid_to: string | Date | null;
  familia: FamiliaTabulador;
  base_field: 'venta' | 'subtotal';
  gate_field: 'venta' | 'subtotal' | 'markup';
  share_supervisor_pct: string | number;
  piso_chofer_venta: string | number | null;
  notes: string | null;
}

/**
 * La versión vigente de `familia`. Con `onDate`, la que rige ese día; sin él, la abierta
 * (`valid_to IS NULL`). Devuelve `undefined` si no hay: cada llamador decide si eso es error.
 */
export async function escalaVigente(
  trx: Knex | Knex.Transaction,
  opts: { familia: FamiliaTabulador; onDate?: string | null },
): Promise<EscalaFila | undefined> {
  const q = trx('commercial.commission_scales')
    .whereNull('deleted_at')
    .where({ familia: opts.familia });
  if (opts.onDate) {
    q.where('valid_from', '<=', opts.onDate)
      .andWhere((b: Knex.QueryBuilder) => b.whereNull('valid_to').orWhere('valid_to', '>', opts.onDate as string));
  } else {
    q.whereNull('valid_to');
  }
  return q.orderBy('valid_from', 'desc').first();
}
