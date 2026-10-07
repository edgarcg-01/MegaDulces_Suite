/**
 * `[GX.20]` — **Las tres bandejas del día.** Función pura.
 *
 * La pantalla de Aprobación es **el día del gasto**, partido por **la decisión** que se tomó
 * sobre cada expediente: lo que todavía espera una, lo aprobado y lo rechazado.
 *
 * Vive aparte del servicio, sin knex, porque es la parte que decide **en qué bandeja cae
 * cada expediente** — y eso se prueba sin levantar una base. Mismo criterio que
 * `aprobacion-agrupar.ts`, que agrupa lo que ya cayó en la bandeja de entrada.
 *
 * ## Qué significa cada bandeja
 * | Bandeja | Estados | Qué es |
 * |---|---|---|
 * | `entrada` | `recibida` | Llegó y **nadie decidió todavía**. |
 * | `aprobados` | `aprobada`, `revision`, `validada` | Tiene luz verde, en cualquier momento del cierre. |
 * | `rechazados` | `rechazada` | Se dijo que no, con su motivo. |
 *
 * ## ⚠️ El corte es la DECISIÓN, no el avance del trámite
 * Los tres estados de `aprobados` son el mismo hecho —se autorizó el gasto— en tres momentos
 * distintos: falta ejercerlo (`aprobada`), volvió con evidencia que no cuadró (`revision`), o
 * ya cerró (`validada`). El renglón dice en cuál está; la bandeja dice que **la decisión fue
 * que sí**. Separarlos en pestañas distintas partiría en tres una sola respuesta.
 *
 * ## ⛔ Un estado que no conozco NO se reparte: se declara
 * Si mañana aparece un estado nuevo en la tabla, cae en `sin_etapa`. Repartirlo «porque no es
 * ninguno de los otros» haría desaparecer trabajo pendiente sin que nadie se entere — y la
 * suma de las bandejas dejaría de dar el total del día, que es el número que se mira primero.
 * Para que igual se VEA, `visibleEn()` lo deja entrar a la bandeja de entrada: es la que
 * significa «alguien tiene que mirar esto». Es una **red**, no una clasificación.
 */

/** Las bandejas. `sin_etapa` no es una pestaña: es una declaración. */
export type EtapaGasto = 'entrada' | 'aprobados' | 'rechazados' | 'sin_etapa';

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
 * El mapa es explícito —no un `switch` con `default`— para que agregar un estado a la tabla
 * y olvidarse de esta línea salga a la luz como `sin_etapa` en vez de esconderse.
 */
const ETAPA_POR_ESTADO: Readonly<Record<string, EtapaGasto>> = {
  recibida: 'entrada',
  // Los tres son «se aprobó», en tres momentos del cierre. Ver el doc de arriba.
  aprobada: 'aprobados',
  revision: 'aprobados',
  validada: 'aprobados',
  rechazada: 'rechazados',
};

export function etapaDe(status: string | null | undefined): EtapaGasto {
  const s = String(status ?? '').trim().toLowerCase();
  return ETAPA_POR_ESTADO[s] ?? 'sin_etapa';
}

/**
 * `[GX.67]` Los estados que **ya tienen una decisión** tomada.
 *
 * ⚠️ Se DERIVA del mapa de arriba, no se escribe a mano. El consumidor es un `WHERE ... NOT
 * IN` del servicio: con la lista copiada, agregar un estado al mapa y olvidarse del SQL
 * dejaría un expediente decidido colándose en la bandeja de entrada —o peor, uno pendiente
 * desapareciendo de ella— sin que nada se queje. Es el defecto que ADR-056 llama «un
 * primitivo duplicado a mano»; acá hay UNA fuente y las dos lecturas salen de ella.
 */
export const ESTADOS_DECIDIDOS: readonly string[] = Object.freeze(
  Object.keys(ETAPA_POR_ESTADO).filter((e) => ETAPA_POR_ESTADO[e] !== 'entrada'),
);

/**
 * ¿Este expediente todavía **espera una decisión**?
 *
 * Es el complemento exacto de `ESTADOS_DECIDIDOS`, y por eso `sin_etapa` cuenta como que SÍ
 * espera: un estado que el servidor no reconoce es trabajo que alguien tiene que mirar, no
 * trabajo terminado. Misma red que `visibleEn()`, misma razón.
 */
export function esperaDecision(status: string | null | undefined): boolean {
  return etapaDe(status) !== 'aprobados' && etapaDe(status) !== 'rechazados';
}

/**
 * Las pestañas, en el orden en que se leen. **Particionan el día**: cada expediente se ve en
 * una y sólo una.
 */
export const PESTANAS = ['entrada', 'aprobados', 'rechazados'] as const;
export type Pestana = (typeof PESTANAS)[number];

/**
 * ¿Este expediente se ve en esta pestaña?
 *
 * ⛔ **`sin_etapa` entra por la bandeja de entrada, y NO es un descuido.** Sin esta línea, un
 * estado que el servidor no reconoce no saldría en ninguna de las tres — o sea que el
 * expediente no existiría en la aplicación. Entra por la bandeja que significa «alguien tiene
 * que mirar esto», y la pantalla lo marca «estado desconocido». Es una red, no una
 * clasificación: verlo con un aviso es peor que verlo bien, pero mucho mejor que no verlo.
 */
export function visibleEn(pestana: Pestana, status: string | null | undefined): boolean {
  const e = etapaDe(status);
  return pestana === 'entrada' ? e === 'entrada' || e === 'sin_etapa' : e === pestana;
}

const vacia = (): ConteoEtapa => ({ n: 0, monto: 0 });

/**
 * Cuenta y suma el día por bandeja.
 *
 * ⚠️ El monto se redondea **al final de cada bandeja**, no en cada suma: redondear en cada
 * paso corre el total unos centavos y el encabezado deja de cuadrar con la suma de las
 * pestañas — que es exactamente la clase de descuadre que hace desconfiar de la pantalla.
 */
export function particionarDelDia(filas: readonly ExpedienteDelDia[]): ParticionDelDia {
  const lista = filas ?? [];
  const etapas: Record<EtapaGasto, ConteoEtapa> = {
    entrada: vacia(), aprobados: vacia(), rechazados: vacia(), sin_etapa: vacia(),
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
 * silencio haría que un parámetro roto se vea igual que un día sin movimiento, y quien mira
 * creería que no se levantó nada.
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
