// `[SN.40]` Lo que esta persona abre de verdad — la forma del wire entre `GET /telemetry/suite/mios`
// y la fila «Tus accesos» de la landing (ADR-052 / ADR-056).
//
// ── POR QUÉ NACE ─────────────────────────────────────────────────────────────────────────
// El registro de clics existe desde el 2026-09-11 y hasta hoy **nadie lo leía**: medido el
// 2026-10-05 en prod, 3,677 aperturas de 84 personas y cero consumidores. Lo único que la
// pantalla mostraba parecido al uso —los chips de «Tus accesos»— salía de `localStorage`, o sea
// que vivía en UN navegador, se perdía al limpiar datos y decía *lo último que abriste*, no *lo
// que más usás*. Esto es el puente que faltaba.
//
// ── LA DECISIÓN QUE DEFINE ESTE CONTRATO: el arranque en frío ────────────────────────────
// Medido antes de diseñarlo, sobre los 90 días de prod:
//
//   · **64 de 148** personas activas no tienen un solo clic → con su propia historia la fila
//     saldría VACÍA.
//   · De las 84 que sí tienen, **sólo 15 llegan a 6 puertas distintas**; 41 tienen una o dos.
//
// O sea que para ~8 de cada 10 personas «lo que más usás» no alcanza a llenar la fila. Por eso
// el servidor completa con lo que abre **su puesto** y después **su departamento** — y existe
// `origen`: cuando la sugerencia no sale de vos, la pantalla **lo dice**. Un chip prestado que
// se presenta como propio es exactamente el «laberinto» que la crítica a la App Library de macOS
// describe: cosas en lugares sorprendentes, sin explicación.
//
// ⚠️ La cascada se apoya en que el puesto tenga compañeros que ya usen la suite, y eso **no es
// parejo**: `cajera` 10 de 14, `encargado_sucursal` 6 de 6, pero `vendedor_ruta` 2 de 25. Cuando
// no hay de dónde, se devuelven menos elementos — nunca se rellena con lo primero del mapa.
//
// ⛔ **Esto NO reordena la rejilla de espacios.** Es una fila de atajos aparte. Mover las tarjetas
// de abajo según el uso rompe la memoria espacial, que es el argumento con el que esta misma fase
// congeló su orden.

/** De dónde salió la sugerencia. Nunca se omite: es lo que distingue tu historia de la prestada. */
export type OrigenAcceso = 'mio' | 'puesto' | 'departamento';

/** Una puerta sugerida, con su evidencia. */
export interface AccesoMedido {
  /** El id de la entrada en `SUITE_SPACES`. El front lo casa contra el mapa que esa persona ve. */
  id: string;
  /**
   * Cuántas veces se abrió en la ventana. Con `origen: 'mio'` son **tus** aperturas; con los
   * otros dos, las del grupo — por eso el número no se pinta junto a un chip prestado.
   */
  clics: number;
  /** ISO de la última apertura, o `null` si no la hay. */
  ultimo_at: string | null;
  origen: OrigenAcceso;
  /**
   * Cuántas personas distintas del grupo la abren. Sólo tiene sentido en `puesto`/`departamento`;
   * en `mio` siempre es 1 y no se muestra.
   */
  personas: number;
}

/** La respuesta de `GET /telemetry/suite/mios`. */
export interface MisAccesos {
  /**
   * Cuándo se midió. No es la frescura del dato (los clics entran en vivo): es el sello que
   * permite distinguir «la medición no corrió» de «no hay nada que mostrar».
   */
  medido_at: string;
  /** Ventana de la medición, en días. */
  ventana_dias: number;
  /**
   * Cuántas puertas distintas abrió **esta persona**. Es la cifra que explica por qué la fila
   * trae prestados: `0` significa arranque en frío, no error.
   */
  propias: number;
  accesos: AccesoMedido[];
}

/** Cuántos atajos MUESTRA la landing. Vive acá para que los dos lados usen el mismo número. */
export const MAX_ACCESOS_SUGERIDOS = 6;

/**
 * Cuántos PIDE al servidor. Más de los que muestra, a propósito: el servidor no sabe qué puertas
 * ve cada quien —eso lo decide `visibleSuiteMap()` en el front, contra los permisos del token— así
 * que una sugerencia del puesto puede caer en una puerta que esta persona no tiene. Pidiendo el
 * doble, la fila sobrevive al filtro en vez de quedarse en dos chips.
 *
 * ⛔ La alternativa —resolver los permisos en el servidor— duplicaría `visibleSuiteMap()` del lado
 * del backend, que es justo el primitivo duplicado que ADR-056 manda no volver a crear.
 */
export const PEDIDO_ACCESOS = 12;

/** Ventana de medición. 90 días es también la retención de la tabla: pedir más devolvería menos. */
export const VENTANA_ACCESOS_DIAS = 90;
