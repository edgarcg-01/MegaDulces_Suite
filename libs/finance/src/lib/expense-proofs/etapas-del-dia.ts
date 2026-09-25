/**
 * `[GX.20]` — **Las tres etapas del día.** Función pura.
 *
 * La pantalla de Aprobación dejó de ser «lo que espera firma» y pasó a ser **el día del
 * gasto**: todo lo que se levantó ese día, partido en lo que cada quien tiene que hacer
 * con ello — *Aprobar*, *Ejercer*, *Todos*.
 *
 * Vive aparte del servicio, sin knex, porque es la parte que decide **en qué bandeja cae
 * cada expediente** — y eso se prueba sin levantar una base. Mismo criterio que
 * `aprobacion-agrupar.ts`, que agrupa lo que ya cayó en *Aprobar*.
 *
 * ## Qué significa cada etapa
 * | Etapa | Estados | Qué falta, y de quién |
 * |---|---|---|
 * | `aprobar` | `recibida` | Alguien tiene que dar la luz verde. **De quien firma.** |
 * | `ejercer` | `aprobada`, `revision` | Ya hay luz verde y el gasto todavía no cierra. |
 * | `cerrado` | `validada`, `rechazada` | Ya no hay nada que hacer. Queda para leer. |
 *
 * ## ⚠️ `revision` está en *Ejercer*, no en *Cerrado*
 * `revision` es el expediente que volvió con su evidencia y **el cuadre por visión no dio**
 * (`addEvidence`). Sigue abierto, y la acción que lo cierra —`validate()`— la tiene la
 * misma persona que firma. Dejarlo en *Cerrado* lo sacaría de la vista de quien debe
 * resolverlo, que es la forma más silenciosa de que un expediente se quede parado.
 *
 * ## ⛔ Un estado que no conozco NO se reparte: se declara
 * Si mañana aparece un estado nuevo en la tabla, cae en `sin_etapa` y la pantalla lo
 * muestra marcado. Meterlo en *Cerrado* «porque no es ninguno de los otros» haría
 * desaparecer trabajo pendiente sin que nadie se entere — y la suma de las etapas dejaría
 * de dar el total del día, que es justo el número que se mira primero.
 */

/** Las bandejas de la pantalla. `sin_etapa` no es una pestaña: es una declaración. */
export type EtapaGasto = 'aprobar' | 'ejercer' | 'cerrado' | 'sin_etapa';

/** Lo que la partición necesita de cada expediente. Nada más. */
export interface ExpedienteDelDia {
  id: string;
  status: string | null;
  importe: number;
}

export interface ConteoEtapa {
  n: number;
  monto: number;
}

export interface ParticionDelDia {
  total: number;
  monto_total: number;
  /** Siempre las cuatro claves, aunque valgan cero: una bandeja ausente no se lee como vacía. */
  etapas: Record<EtapaGasto, ConteoEtapa>;
}

/**
 * En qué bandeja cae un estado.
 *
 * El mapa es explícito —no un `switch` con `default`— para que agregar un estado a la
 * tabla y olvidarse de esta línea salga a la luz como `sin_etapa` en vez de esconderse.
 */
const ETAPA_POR_ESTADO: Readonly<Record<string, EtapaGasto>> = {
  recibida: 'aprobar',
  aprobada: 'ejercer',
  revision: 'ejercer',
  validada: 'cerrado',
  rechazada: 'cerrado',
};

export function etapaDe(status: string | null | undefined): EtapaGasto {
  const s = String(status ?? '').trim().toLowerCase();
  return ETAPA_POR_ESTADO[s] ?? 'sin_etapa';
}

/**
 * Las pestañas, en el orden en que se leen. Son las **tres etapas del trámite**, y
 * **particionan el día**: cada expediente se ve en una y sólo una.
 *
 * ⚠️ Antes la tercera era `todos` (el día entero, sin filtrar). Se cambió por pedido del
 * usuario (2026-09-25): la tercera es **lo ya resuelto** — rechazados y aprobados.
 */
export const PESTANAS = ['aprobar', 'ejercer', 'cerrado'] as const;
export type Pestana = (typeof PESTANAS)[number];

/**
 * ¿Este expediente se ve en esta pestaña?
 *
 * ⛔ **`sin_etapa` cae en `cerrado`, y NO es un descuido.** Al irse la pestaña «Todos» se fue
 * el único lugar donde un estado que no conocemos seguía siendo visible; sin esta línea, un
 * estado nuevo en la tabla desaparecería de las tres pestañas — o sea de la aplicación
 * entera. Cae en la última y la pantalla lo marca «estado desconocido»: se lo ve, con su
 * aviso, en vez de no existir. Es una red, no una clasificación.
 */
export function visibleEn(pestana: Pestana, status: string | null | undefined): boolean {
  const e = etapaDe(status);
  return pestana === 'cerrado' ? (e === 'cerrado' || e === 'sin_etapa') : e === pestana;
}

const vacia = (): ConteoEtapa => ({ n: 0, monto: 0 });

/**
 * Cuenta y suma el día por etapa.
 *
 * ⚠️ El monto se redondea **al final de cada bandeja**, no en cada suma: redondear en cada
 * paso corre el total unos centavos y el encabezado deja de cuadrar con la suma de las
 * pestañas — que es exactamente la clase de descuadre que hace desconfiar de la pantalla
 * entera.
 */
export function particionarDelDia(filas: readonly ExpedienteDelDia[]): ParticionDelDia {
  const lista = filas ?? [];
  const etapas: Record<EtapaGasto, ConteoEtapa> = {
    aprobar: vacia(), ejercer: vacia(), cerrado: vacia(), sin_etapa: vacia(),
  };

  for (const f of lista) {
    const e = etapas[etapaDe(f?.status)];
    e.n += 1;
    e.monto += Number(f?.importe) || 0;
  }

  const centavos = (v: number) => Math.round(v * 100) / 100;
  for (const k of Object.keys(etapas) as EtapaGasto[]) etapas[k].monto = centavos(etapas[k].monto);

  return {
    total: lista.length,
    monto_total: centavos(lista.reduce((a, f) => a + (Number(f?.importe) || 0), 0)),
    etapas,
  };
}

/**
 * El día que se está mirando, validado.
 *
 * Devuelve `null` —no «hoy»— cuando lo que llega no tiene forma de fecha. Caer a hoy en
 * silencio haría que un parámetro roto se vea igual que un día sin movimiento, y quien
 * mira creería que no se levantó nada.
 */
export function diaValido(v: unknown): string | null {
  const t = String(v ?? '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  // `2026-02-31` pasa el regex y no existe. Se comprueba contra el calendario.
  const d = new Date(`${t}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t ? null : t;
}

/** Hoy en hora de México, como `YYYY-MM-DD`. El día del gasto no es el día UTC. */
export function hoyMx(ahora: Date = new Date()): string {
  // `en-CA` da `YYYY-MM-DD`, que es el formato con el que viaja la fecha en todo el repo.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(ahora);
}
