/**
 * `[GX.39]` **La etapa de EJERCICIO de un gasto: lo que pasa DESPUES de que firmamos.**
 *
 * Pedido textual del usuario: *«cuando el usuario de aprobacion de gastos le de luz verde se
 * va a pasar el vale que mando el usuario a la seccion de ejercer, esto quiere decir que esta
 * pendiente a que aprueben el gasto en Kepler»*.
 *
 * ## Por que es una dimension APARTE y no un estado mas de `status`
 * `status` es **nuestro** tramite (recibida -> aprobada -> validada / rechazada) y de el
 * cuelgan la bandeja de Aprobacion, los KPI, la reapertura y el candado de `dueno-del-vale`.
 * El ejercicio es **de Kepler**: es otro sistema, con su propio reloj (medido abajo: de horas
 * a semanas). Meterlo en `status` haria que un hecho ajeno moviera nuestra maquina de estados
 * y que una bandeja nuestra dependiera de que el feed del ODS haya corrido.
 *
 * ## De donde sale, medido en prod el 2026-09-28 sobre 10,082 solicitudes X-A-15
 * Kepler **no marca** «ejercido» con una bandera: lo marca **creando otro documento**. El
 * gasto `X-A-10` apunta a su solicitud por `c39`, y esa es la senal:
 *
 *  · **8,899 de 8,899 gastos** nacen de una solicitud (`c37-c38 = 15-1`). El 100%.
 *  · **8,773 de 10,082 solicitudes** ya tienen su gasto.
 *  · El puente ya esta publicado: `analytics.expense_requests.aplicada` (vista derive-no-copy).
 *
 * ## Los dos testigos se ARBITRAN entre si (ADR-059), no se elige uno a ciegas
 * El estado propio de la solicitud (`c43`) y el puente `c39` se cruzaron:
 *
 * ```
 *   c43      con gasto   sin gasto
 *   F  7,949        7,949         0     <- «Aplicada, el dinero salio»
 *   A    929          645       284
 *   C    507          113       394
 *   N    697           66       631
 * ```
 *
 * **`F` acierta 7,949 de 7,949: cero falsos positivos.** Pero es SUFICIENTE, no NECESARIO —
 * hay 824 solicitudes con gasto que todavia no estan en `F` (el gasto existe, el documento no
 * se cerro). Por eso manda el **puente** (ve antes) y `c43` se conserva como el matiz.
 *
 * ## ⛔ El tercer estado: `sin_medir` (ADR-056)
 * Si el folio no esta en la vista —el feed no corrio, la solicitud es de una plaza que el ODS
 * todavia no trae— **no se puede decir `por_ejercer`**, porque eso AFIRMA que Kepler no lo
 * aplico. Un booleano no sabe decir «no se». Lo que no se pudo medir se declara.
 */

/** Nuestro tramite. Es el `status` de `finance.expense_proofs`. */
export type StatusVale = 'recibida' | 'aprobada' | 'revision' | 'validada' | 'rechazada';

/** El estado propio de la solicitud en Kepler (`kdm1.c43`), tal como lo publica la vista. */
export type EstadoKepler = 'N' | 'A' | 'F' | 'C';

export type EtapaEjercicio =
  /** Nuestro tramite sigue abierto. Kepler todavia no es asunto de nadie. */
  | 'en_captura'
  /** ⭐ Firmamos. Espera a que lo AUTORICEN en Kepler (la columna «Autorizado» sigue en `N`). */
  | 'por_ejercer'
  /**
   * ⭐ `[GX.43]` **Autorizado en Kepler**: en «Autorización de Sol Gasto» le pusieron la `A`.
   * A partir de acá el documento `XA1501-<folio>` es parte del expediente — es el papel con
   * el que Kepler dice que ese gasto quedó autorizado.
   */
  | 'autorizado'
  /** ⭐ Kepler ya genero el gasto: el dinero salio. */
  | 'ejercido'
  /** La solicitud se cancelo en Kepler. No hay nada que perseguir. */
  | 'cancelado_kepler'
  /** Lo frenamos nosotros. Nunca llega a Kepler. */
  | 'rechazada'
  /** ⛔ No se pudo medir. NO es «por ejercer»: es que no sabemos. */
  | 'sin_medir';

export interface EstadoEjercicio {
  status: StatusVale | string;
  /** `analytics.expense_requests.aplicada`. **`null` = no medido**, no «false». */
  kepler_aplicada?: boolean | null;
  /** `analytics.expense_requests.estado` (c43). `null` cuando la solicitud no esta en la vista. */
  kepler_estado?: EstadoKepler | string | null;
}

/** Los estados en que NUESTRO expediente ya cerro y la pelota esta del lado de Kepler. */
const CERRADOS = new Set(['validada']);

/**
 * ⚠️ `aprobada` y `revision` NO son `por_ejercer`. En `aprobada` el aprobador ya firmo pero
 * **falta la evidencia**, y en `revision` la evidencia esta sin revisar: el expediente nuestro
 * sigue abierto. Decir «por ejercer» ahi mandaria a esperar a Kepler por algo que todavia
 * depende de nosotros.
 */
export function etapaDeEjercicio(e: EstadoEjercicio): EtapaEjercicio {
  if (e.status === 'rechazada') return 'rechazada';
  if (!CERRADOS.has(String(e.status))) return 'en_captura';

  // Cerramos. A partir de aca todo depende de lo que diga Kepler — y de si lo sabemos.
  const medido = e.kepler_aplicada === true || e.kepler_aplicada === false;
  if (!medido && !e.kepler_estado) return 'sin_medir';

  if (e.kepler_aplicada === true) return 'ejercido';
  /**
   * ⚠️ Cancelada MANDA sobre el puente. Medido: **113 solicitudes canceladas tienen gasto**.
   * Son dos hechos ciertos a la vez (se genero el gasto, despues se cancelo el documento) y
   * el que importa para quien espera es el ultimo: no hay nada que perseguir. El detalle
   * muestra los dos, para que nadie tenga que adivinar cual leyo la pantalla.
   */
  if (e.kepler_estado === 'C') return 'cancelado_kepler';
  if (e.kepler_estado === 'F') return 'ejercido'; // el testigo que acierta 7,949 de 7,949
  /**
   * `[GX.43]` **La `A` es su propia etapa, no un «por ejercer» más.** Antes `N` y `A` caían
   * las dos acá y la persona no podía distinguir «nadie lo miró todavía» de «ya lo
   * autorizaron, falta que salga el dinero». Medido en prod: **929 solicitudes en `A`**, de
   * las cuales 645 ya tienen su gasto y **284 no** — o sea que la `A` NO implica ejercido, y
   * colapsarlas escondía justo a esas 284.
   */
  if (e.kepler_estado === 'A') return 'autorizado';
  if (!medido) return 'sin_medir';
  return 'por_ejercer';
}

/**
 * `[GX.48]` **La constancia de autorizacion de Kepler.**
 *
 * Pedido del usuario: *«cuando el vale sea autorizado en kepler debe generar un doc que es una
 * autorizacion de gasto (…) para agregarla al vale correspondiente de suite»*.
 *
 * ## ⛔ Ese documento NO existe en la base de Kepler. Medido.
 * Se buscó de cinco formas independientes el 2026-09-29, y ninguna lo encontró:
 *
 *  · Las **200 columnas** de `kdm1`, comparando las 697 solicitudes en `N` contra las 8,878
 *    en `A`/`F`: **lo unico que cambia al autorizar es `c43`**, de `N` a `A`. Una letra.
 *  · **Ninguna** columna de fecha se llena al autorizar.
 *  · `c30` (el area que autoriza) es **igual** antes y despues — se captura al levantar el
 *    vale, no al autorizarlo.
 *  · `kdm2` tiene **0 lineas** para estos doctypes: son solo cabecera.
 *  · **Cero columnas binarias** (`bytea`/`oid`) en las 241 tablas del ODS. Si Kepler guardara
 *    un archivo, estaria ahi.
 *  · `kdlogmov` (158,907 filas) registra **catalogos** (clientes, direcciones, bancos), no
 *    movimientos de `kdm1`: cero eventos de autorizacion.
 *
 * Si Kepler imprime una hoja, **la imprime y no la guarda**.
 *
 * ## Entonces la constancia se GENERA, no se jala — y dice de donde sale cada cosa
 * Reproduce la fila que se ve en la pantalla «Autorizacion de Sol Gasto» con los datos que
 * Kepler **si** tiene. Y lo que no tiene va en `no_consta`: declarado, no dibujado (ADR-056).
 *
 * ⛔ **No se guarda de nuestro lado.** Se deriva cada vez de la vista: si en Kepler cancelan
 * el vale, la constancia desaparece sola. Una copia seguiria afirmando una autorizacion que
 * ya no existe.
 */
export interface AutorizacionKepler {
  /** El identificador que muestra la columna `Documento`: `XA1501-0009008`. */
  documento: string;
  /** La letra tal cual la guarda Kepler, sin traducir: es lo que dice su pantalla. */
  autorizado: 'A' | 'F';
  /** Cómo se lee esa letra. */
  autorizado_label: string;
  monto: number;
  /**
   * ⚠️ Es la fecha **del documento**, no la de la autorizacion. Kepler no guarda cuando se
   * autorizo; llamarla «fecha de autorizacion» seria ponerle nombre de un dato que no hay.
   */
  fecha_documento: string | null;
  destinatario: string | null;
  concepto: string | null;
  /** `c30`. Sucio a proposito: conviven FINANZAS / DPTO FINANZAS / DEPARTAMENTO DE FINANSAS. */
  area_autoriza: string | null;
  /** ⛔ Lo que Kepler NO registra. Va en la constancia para que nadie lo dé por sabido. */
  no_consta: readonly string[];
}

/** Lo que Kepler no guarda de la autorizacion, y por eso ninguna constancia puede afirmarlo. */
export const NO_CONSTA_EN_KEPLER: readonly string[] = [
  'La fecha y hora en que se autorizó',
  'Quién la autorizó (sólo queda el área)',
];

/**
 * Arma la constancia. ⛔ `null` mientras el vale no esté autorizado: antes de la `A` no hay
 * autorizacion que constatar, y una constancia vacia se lee como que si la hubo.
 */
export function constanciaDeAutorizacion(d: {
  folio?: string | null;
  estado?: EstadoKepler | string | null;
  importe?: number | null;
  fecha?: string | null;
  destinatario?: string | null;
  concepto?: string | null;
  area_autoriza?: string | null;
}): AutorizacionKepler | null {
  const doc = documentoKepler(d.folio, d.estado);
  if (!doc) return null;
  const letra = d.estado === 'F' ? 'F' : 'A';
  return {
    documento: doc,
    autorizado: letra,
    autorizado_label: letra === 'F' ? 'Autorizado y aplicado — el dinero salió' : 'Autorizado',
    monto: Number(d.importe ?? 0),
    fecha_documento: d.fecha ?? null,
    destinatario: d.destinatario ?? null,
    concepto: d.concepto ?? null,
    area_autoriza: d.area_autoriza ?? null,
    no_consta: NO_CONSTA_EN_KEPLER,
  };
}

/** Lo que se le muestra a la persona. Corto: va en un chip. */
export const ETIQUETA_ETAPA: Record<EtapaEjercicio, string> = {
  en_captura: 'En tramite',
  por_ejercer: 'Por autorizar',
  autorizado: 'Autorizado en Kepler',
  ejercido: 'Ejercido',
  cancelado_kepler: 'Cancelado en Kepler',
  rechazada: 'Devuelto',
  sin_medir: 'Sin medir',
};

/** La frase larga: explica QUE se espera, que es lo que la persona viene a preguntar. */
export const EXPLICACION_ETAPA: Record<EtapaEjercicio, string> = {
  en_captura: 'Tu gasto esta en tramite con nosotros.',
  por_ejercer: 'Aprobado de este lado. Espera a que lo autoricen en Kepler.',
  autorizado: 'Autorizado en Kepler. Falta que salga el dinero.',
  ejercido: 'Tu gasto se aprobo y se ejercio: el dinero salio.',
  cancelado_kepler: 'La solicitud se cancelo en Kepler.',
  rechazada: 'Te lo devolvieron. Revisa el motivo y volve a mandarlo.',
  sin_medir: 'Todavia no podemos ver el estado en Kepler.',
};

/** ⭐ Las etapas que el usuario pidio ver como seccion propia, en el orden en que se leen. */
export const ETAPAS_VISIBLES: EtapaEjercicio[] = ['en_captura', 'por_ejercer', 'autorizado', 'ejercido'];

/**
 * `[GX.43]` **El documento con el que Kepler respalda la autorización.**
 *
 * Es lo que se ve en la pantalla «Autorización de Sol Gasto», columna `Documento`:
 * `XA1501-0009008`. No es un dato nuevo ni hace falta traerlo de ningún lado — se **deriva**
 * del tipo de documento y el folio que ya tenemos. `kdm1.c63` guarda literalmente el prefijo
 * `XA1501-`, así que esto reproduce lo que el ERP muestra, no lo inventa.
 *
 * ⛔ Devuelve `null` hasta que Kepler lo autoriza (`A`) o lo aplica (`F`): antes de eso el
 * documento existe pero **no respalda ninguna autorización**, y ponerlo en el expediente
 * diría que hay un permiso que nadie dio.
 */
export function documentoKepler(folio: string | null | undefined, estado?: EstadoKepler | string | null): string | null {
  const f = String(folio ?? '').trim();
  if (!f) return null;
  return estado === 'A' || estado === 'F' ? `XA1501-${f}` : null;
}

/** Un gasto ejercido es el unico que cierra la historia: ahi se avisa, y una sola vez. */
export function seDebeAvisar(etapa: EtapaEjercicio, yaAvisado: boolean): boolean {
  return etapa === 'ejercido' && !yaAvisado;
}
