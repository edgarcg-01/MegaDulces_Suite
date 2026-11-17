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

  /**
   * ⚠️ Cancelada MANDA sobre el puente. Medido: **113 solicitudes canceladas tienen gasto**.
   * Son dos hechos ciertos a la vez (se genero el gasto, despues se cancelo el documento) y
   * el que importa para quien espera es el ultimo: no hay nada que perseguir. El detalle
   * muestra los dos, para que nadie tenga que adivinar cual leyo la pantalla.
   *
   * `[GX.93]` ⛔ Esta linea iba DESPUES de `kepler_aplicada === true`, asi que la cancelada con
   * gasto salia «ejercido» — lo contrario de lo que dice el parrafo de arriba. Medido en prod el
   * 2026-11-05: **24 vales revisados** decian «ejercido» con nota verde y a la vez seguian en
   * «Falta el gasto en Kepler». Ninguna prueba cubria la cancelada CON gasto.
   */
  if (e.kepler_estado === 'C') return 'cancelado_kepler';
  if (e.kepler_aplicada === true) return 'ejercido';
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

/**
 * `[GX.92]` **¿El ciclo de un vale ya terminó?** — UNA regla, para «Mis gastos» y para la cola de
 * quien aprueba.
 *
 * Termina cuando está **revisado** (`validada`) y además Kepler dijo la última palabra:
 *  · **aplicó su gasto** `XA1001` (la regla de `[GX.77]`), o
 *  · **canceló la solicitud** (`cancelado_kepler`): ya no va a haber gasto que esperar.
 *
 * ⛔ El defecto que corrige, medido en prod el 2026-11-05: la regla vivía SÓLO en la pantalla y
 * pedía el gasto a secas, así que **32 vales revisados con la solicitud cancelada** se quedaban
 * para siempre en «Falta el gasto en Kepler» — esperando algo que no iba a llegar. Y 24 de ellos
 * decían además «ejercido» (ver el orden corregido en `etapaDeEjercicio`).
 */
export interface ValeParaCierre {
  status?: string | null;
  etapa?: EtapaEjercicio | string | null;
  gasto_folios?: readonly string[] | null;
}

/** Por qué cerró: lo que la pantalla dice al pie del vale cerrado. */
export type MotivoDeCierre = 'gasto_aplicado' | 'cancelada_en_kepler';

export function motivoDeCierre(v: ValeParaCierre): MotivoDeCierre | null {
  if (v.status !== 'validada') return null;
  if ((v.gasto_folios?.length ?? 0) > 0) return 'gasto_aplicado';
  if (v.etapa === 'cancelado_kepler') return 'cancelada_en_kepler';
  return null;
}

export function cicloCerrado(v: ValeParaCierre): boolean {
  return motivoDeCierre(v) !== null;
}

export const ETIQUETA_CIERRE: Record<MotivoDeCierre, string> = {
  gasto_aplicado: 'Gasto aplicado en Kepler',
  cancelada_en_kepler: 'Solicitud cancelada en Kepler',
};

/**
 * `[GX.96]` **A qué espera un vale revisado que todavía no cierra.** Todo lo que queda es de
 * Kepler — o sea de quien opera Kepler, no de quien capturó, que no puede hacer nada.
 *
 * Medido en prod el 2026-11-05: 38 autorizados sin gasto y 24 sin autorizar; 13 con más de 30
 * días, y sólo los veía quien los capturó.
 */
export type EsperaKepler = 'falta_autorizar' | 'falta_generar_gasto' | 'aplicada_sin_ligar' | 'sin_medir';

export function esperaDeKepler(v: ValeParaCierre): EsperaKepler | null {
  if (v.status !== 'validada' || cicloCerrado(v)) return null;
  switch (v.etapa) {
    case 'autorizado': return 'falta_generar_gasto';
    case 'por_ejercer': return 'falta_autorizar';
    // Kepler dice que hay gasto (o que el dinero salió) y no encontramos el `XA1001` ligado.
    case 'ejercido': return 'aplicada_sin_ligar';
    default: return 'sin_medir';
  }
}

export const ETIQUETA_ESPERA_KEPLER: Record<EsperaKepler, string> = {
  falta_autorizar: 'Falta que la autoricen en Kepler',
  falta_generar_gasto: 'Autorizada: falta generar el gasto en Kepler',
  aplicada_sin_ligar: 'Kepler dice aplicada, pero el gasto no aparece',
  sin_medir: 'No se pudo leer su estado en Kepler',
};

/**
 * `[GX.96]` **El hallazgo**: la solicitud se canceló en Kepler DESPUÉS de generar su gasto.
 * Decisión del usuario (2026-11-06): el vale se cierra igual, pero quien aprueba lo revisa —
 * alguien tiene que confirmar si salió dinero. Es el mismo criterio de `[GX.85]` con el rechazo
 * que Kepler pagó: lo raro se mira, no se tapa solo. Medido: 24 casos el 2026-11-05.
 */
export function esHallazgoCanceladaConGasto(kepler_estado: string | null | undefined, kepler_aplicada: boolean | null | undefined): boolean {
  return solicitudCanceladaEnKepler(kepler_estado) && kepler_aplicada === true;
}

/**
 * `[PGP.123]` G.UI.1c — ¿Kepler canceló la solicitud del vale (`c43` = C)? Con su gasto generado o sin él: las dos van
 * a «Canceladas en Kepler» (pedido de Francisco, 2026-11-16), no a la cola de lo que espera a Kepler.
 */
export function solicitudCanceladaEnKepler(kepler_estado: string | null | undefined): boolean {
  return String(kepler_estado ?? '').trim() === 'C';
}

/**
 * `[PGP.123]` G.UI.1d — **La pista de una cancelada**: lo que la Suite averigua sola para que una persona sólo decida
 * (pedido de Francisco, 2026-11-16: «la Suite lo contesta sola y una persona lo confirma»). La calcula el servidor, en lote.
 *
 * Medido en prod el 2026-11-16 (43 canceladas): de las 29 con gasto, 14 se pagaron en efectivo según el vale y sólo 1
 * tiene un pago aplicado en Kepler; de las 14 sin gasto, 2 tienen una recaptura clara, 1 varias iguales (un gasto que
 * se repite) y 11 ninguna; en 2 con gasto la recaptura ya tiene su propio vale (el viejo puede estar repetido).
 */
export interface PistaCancelada {
  /** La forma de pago que declaró el vale (`efectivo`, `transferencia`…). */
  forma_pago: string | null;
  /** Los pagos (`X-D-26`, `kdm5`) aplicados a los gastos de esa solicitud, aunque estén cancelados. `null` = no se midió. */
  pagos: { folio: string; gasto_folio: string; aplicado: number; fecha: string | null; cancelado: boolean }[] | null;
  /**
   * Solicitudes vivas de la misma sucursal y acreedor, con el mismo total al centavo y fecha cercana, que pueden ser su
   * recaptura. `con_vale` = ya tienen su propio vale en la Suite. `null` = no se midió.
   */
  recapturas: { folio: string; estado: string; fecha: string | null; con_vale: boolean }[] | null;
  /**
   * El gasto (`X-A-10`) que SIGUE vivo sobre la solicitud cancelada. `null` = ninguno vivo; ausente = no se sabe (un
   * servidor anterior). ⛔ Con un gasto vivo no se liga el vale a otra solicitud: el gasto ya está en Kepler y la
   * recaptura tendría el suyo (revisión independiente, 2026-11-17).
   */
  gasto_vivo?: string | null;
}

export type TonoDeLaPista = 'neutro' | 'warn' | 'bad';
/** Lo que se le ofrece a la persona: ligar el vale a su recaptura, o rechazarlo por repetido. `null` = sólo revisar. */
export type AccionDeLaCancelada = { tipo: 'ligar'; folio: string } | { tipo: 'repetido'; folio: string } | null;

/** Dónde buscar un pago que Kepler no tiene, según la forma de pago que declaró el vale. */
const SIN_PAGO_SEGUN_FORMA: Readonly<Record<string, string>> = {
  transferencia: 'Sin pago en Kepler; el vale dice transferencia: búscala en el banco',
  cheque: 'Sin pago en Kepler; el vale dice cheque: búscalo en el banco',
  tarjeta: 'Sin pago en Kepler; el vale dice tarjeta: búscalo en su estado de cuenta',
};

const pesos2 = (n: number): string => `$${(Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const diaCorto = (f: string | null): string => (f && /^\d{4}-\d{2}-\d{2}/.test(f) ? `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(2, 4)}` : 's/f');

/**
 * Las palabras de la pista, en llano, y lo que se ofrece. Primero el dinero (lo que pregunta la lista), después la
 * recaptura. ⛔ «Sin pago en Kepler» no es «no salió dinero»: un vale en efectivo salió de caja aunque Kepler no tenga el
 * pago, y uno por transferencia hay que buscarlo en el banco.
 */
export function lecturaDeLaCancelada(p: PistaCancelada | null | undefined): { dinero: string; recaptura: string | null; tono: TonoDeLaPista; accion: AccionDeLaCancelada } {
  if (!p) return { dinero: 'No se pudo averiguar qué pasó con el dinero: revísalo en Kepler', recaptura: null, tono: 'warn', accion: null };
  const vivos = (p.pagos ?? []).filter((x) => !x.cancelado);
  const forma = String(p.forma_pago ?? '').trim().toLowerCase();
  let dinero: string;
  let tono: TonoDeLaPista = 'neutro';
  if (vivos.length) {
    const x = vivos[0];
    const mas = vivos.length > 1 ? ` (y ${vivos.length - 1} pago${vivos.length > 2 ? 's' : ''} más)` : '';
    dinero = `Kepler lo pagó: XD2601-${x.folio} · ${pesos2(x.aplicado)} · ${diaCorto(x.fecha)}${mas}`;
    tono = 'bad';
  } else if (p.pagos === null) {
    dinero = 'No se pudieron leer los pagos de Kepler';
    tono = 'warn';
  } else if (forma === 'efectivo') {
    dinero = 'Pagado en efectivo según el vale: salió de caja, y Kepler no tiene el pago';
  } else {
    dinero = SIN_PAGO_SEGUN_FORMA[forma] ?? 'Sin pago en Kepler, y el vale no dice cómo se pagó: revísalo';
    tono = 'warn';
  }
  const rs = p.recapturas;
  if (!rs || !rs.length) return { dinero, recaptura: rs === null ? null : 'Sin recaptura con el mismo acreedor y total', tono, accion: null };
  const libres = rs.filter((r) => !r.con_vale);
  if (libres.length === 1) {
    const r = libres[0];
    const recaptura = `Posible recaptura: XA1501-${r.folio} (${r.estado === 'N' ? 'sin autorizar' : r.estado === 'A' ? 'autorizada' : 'aplicada'}, ${diaCorto(r.fecha)}), mismo acreedor y total`;
    // ⛔ Sólo se ofrece ligar si se SABE que la cancelada ya no tiene gasto vivo: con uno vivo, el gasto quedaría dos
    // veces en Kepler. Sin el dato (un servidor anterior), tampoco.
    if (p.gasto_vivo) {
      return { dinero, recaptura: `${recaptura}; pero su gasto sigue vivo en Kepler (X-A-10 ${p.gasto_vivo}): ligarla duplicaría el gasto`, tono: tono === 'bad' ? 'bad' : 'warn', accion: null };
    }
    return { dinero, recaptura, tono, accion: p.gasto_vivo === null ? { tipo: 'ligar', folio: r.folio } : null };
  }
  if (libres.length > 1) return { dinero, recaptura: `${libres.length} solicitudes del mismo acreedor y total: no se sabe cuál la reemplaza`, tono, accion: null };
  const r = rs[0];
  return { dinero, recaptura: `La recaptura XA1501-${r.folio} ya tiene su vale: éste puede estar repetido`, tono: tono === 'bad' ? 'bad' : 'warn', accion: { tipo: 'repetido', folio: r.folio } };
}

/**
 * `[PGP.123]` G.UI.1b — **Qué le falta en Kepler a un vale ya resuelto en la Suite que no tiene su gasto ligado**, con
 * las MISMAS reglas que «Esperan a Kepler» (`esperaDeKepler`, `esHallazgoCanceladaConGasto`): el Expediente y la cola
 * dicen lo mismo del mismo vale.
 *
 * ⛔ Una solicitud cancelada NO «espera su gasto». Medido el 2026-11-16 (copia local): el Expediente decía «Falta el
 * gasto en Kepler» en 38 vales cuya solicitud Kepler ya había cancelado (25 con su gasto generado, la pregunta de
 * GX.96; 13 sin él). `null` = no aplica: el vale no está validado.
 */
export type FaltaEnKepler = EsperaKepler | 'cancelada_con_gasto' | 'cancelada';

export function faltaEnKepler(e: EstadoEjercicio): FaltaEnKepler | null {
  if (e.status !== 'validada') return null;
  if (esHallazgoCanceladaConGasto(e.kepler_estado, e.kepler_aplicada)) return 'cancelada_con_gasto';
  const etapa = etapaDeEjercicio(e);
  if (etapa === 'cancelado_kepler') return 'cancelada';
  return esperaDeKepler({ status: 'validada', etapa, gasto_folios: [] });
}

/** Las palabras de cada caso. Las esperas son las de la cola; «el gasto» se dice corto, como lo dice el Expediente. */
export const ETIQUETA_FALTA_EN_KEPLER: Readonly<Record<FaltaEnKepler, string>> = {
  falta_generar_gasto: 'Falta el gasto en Kepler',
  falta_autorizar: ETIQUETA_ESPERA_KEPLER.falta_autorizar,
  aplicada_sin_ligar: ETIQUETA_ESPERA_KEPLER.aplicada_sin_ligar,
  sin_medir: ETIQUETA_ESPERA_KEPLER.sin_medir,
  cancelada_con_gasto: 'Se canceló en Kepler con su gasto ya generado: ¿salió dinero?',
  cancelada: 'Solicitud cancelada en Kepler',
};

/**
 * `[PGP.123]` G.UI.2 — **El monto de un vale cuya solicitud Kepler canceló.** `finance.v_expense_proofs.importe`
 * antepone el total de la solicitud de Kepler, y Kepler lo deja en 0 al cancelarla: el vale salía en «$0.00». Su monto es
 * el capturado; lo de Kepler va como nota (`kepler`, `null` si coincide). Sin lo capturado, se queda lo de Kepler: no
 * se inventa. Medido el 2026-11-16 (copia local): 38 vales, $332,537.10 capturados, salían en $0.00.
 */
export function importeDelVale(v: {
  importe: number | string | null;
  importe_capturado?: number | string | null;
  kepler_estado?: string | null;
}): { importe: number; kepler: number | null } {
  const kepler = Math.round((Number(v.importe) || 0) * 100) / 100;
  const capturado = v.importe_capturado == null ? NaN : Math.round(Number(v.importe_capturado) * 100) / 100;
  if (String(v.kepler_estado ?? '').trim() !== 'C' || !Number.isFinite(capturado)) return { importe: kepler, kepler: null };
  return { importe: capturado, kepler: capturado === kepler ? null : kepler };
}

/**
 * `[PGP.79]` **Para UBICAR la solicitud en Kepler**, en cualquier estado: `XA1501-<folio>` es como
 * la busca quien abre Kepler. No es `documentoKepler()`: aquél sólo existe cuando la solicitud ya
 * RESPALDA una autorización (A/F); éste es el nombre del documento, esté como esté.
 */
export function solicitudKepler(folio: string | null | undefined): string | null {
  const f = String(folio ?? '').trim();
  return f ? `XA1501-${f}` : null;
}

/** `[PGP.79]` Lo que la Suite hizo en Kepler al firmar el vale (`kdm1.c43 N → A`). */
export type ResultadoAutorizacionSuite = 'escrito' | 'ya_estaba' | 'no_escrito';

/** `[PGP.79]` La solicitud de Kepler de UN vale, como la lee `/finanzas/aprobacion-gastos`. */
export interface KeplerDelVale {
  /** `XA1501-<folio>` para ubicarla; `null` si el vale no trae folio. */
  solicitud: string | null;
  /** `c43` hoy, de la vista viva. ⛔ `null` = no está en la vista: NO MEDIDO, no «sin autorizar». */
  estado: EstadoKepler | null;
  /** Lo que la Suite intentó al firmar. `null` = no se intentó (firma anterior a PGP.79, o la escritura apagada). */
  suite: { resultado: ResultadoAutorizacionSuite; at: string | null; nota: string | null; firmo: string | null } | null;
  /**
   * `[PGP.122]` El vale NACIÓ en la Suite (`origen = 'solicitud'`): su solicitud no existe en Kepler hasta firmarlo, y
   * aquí va cómo va su escritura (`kepler_request_status`). Ausente = el vale no nació en la Suite.
   */
  nace_en_la_suite?: { status: string | null; nota: string | null; siguiente: string | null; intentos: number } | null;
}

/**
 * `[PGP.122]` La pastilla de la solicitud que nace en la Suite. Antes de firmarla no es «sin folio» (no le falta
 * nada): al firmarla se escribe. Después, el estado de la escritura; si ya la ve la réplica, manda su estado.
 */
function lecturaDeLaSuite(k: KeplerDelVale, status: StatusVale | string): { texto: string; tono: TonoKepler } {
  const n = k.nace_en_la_suite!;
  if (status === 'recibida') return { texto: 'Nace en la Suite: al firmarla se escribe en Kepler', tono: 'neutro' };
  if (k.estado === 'C') return { texto: 'Kepler: cancelada', tono: 'bad' };
  switch (n.status) {
    case 'written': case 'seen_in_ods': return { texto: 'Kepler: escrita por la Suite', tono: 'ok' };
    case 'writing': return { texto: 'Kepler: escribiéndose', tono: 'neutro' };
    case 'pending': return { texto: 'Kepler: por escribir', tono: 'warn' };
    case 'retry': return { texto: 'Kepler: se reintenta sola', tono: 'warn' };
    case 'in_doubt': return { texto: 'Kepler: en duda (se pregunta antes de reintentar)', tono: 'warn' };
    case 'stuck': return { texto: 'Kepler: no se pudo escribir', tono: 'bad' };
    case 'rejected_by_kepler': return { texto: 'Kepler: no la aceptó', tono: 'bad' };
    case 'cancelled': return { texto: 'Kepler: no se escribirá (se rechazó aquí)', tono: 'neutro' };
    default: return { texto: 'Kepler: sin medir', tono: 'neutro' };
  }
}

/** `[PGP.122]` La explicación de la solicitud que nace en la Suite, para el detalle: qué pasó y qué hacer. */
function explicacionDeLaSuite(k: KeplerDelVale, status: StatusVale | string): string {
  const n = k.nace_en_la_suite!;
  const nota = n.nota ? ` ${n.nota}.` : '';
  if (status === 'recibida') return 'Esta solicitud nació en la Suite: todavía no existe en Kepler. Al firmarla, la Suite la escribe en Kepler ya autorizada, con su folio.';
  if (k.estado === 'C') return `La Suite la escribió y en Kepler está CANCELADA (${k.solicitud ?? 'sin folio'}).`;
  switch (n.status) {
    case 'written': case 'seen_in_ods': return `La Suite la escribió en Kepler ya autorizada: ${k.solicitud ?? 'folio por confirmar'}${n.status === 'seen_in_ods' ? ', y la réplica ya la ve' : ''}.`;
    case 'writing': return 'Se está escribiendo en Kepler en este momento.';
    case 'pending': return `Firmada; todavía no se escribe en Kepler.${nota} Se escribe sola en cuanto el servidor de esa sucursal esté encendido.`;
    case 'retry': return `Kepler no la recibió y se reintenta sola${n.siguiente ? ' (siguiente intento programado)' : ''}.${nota}`;
    case 'in_doubt': return `No se sabe si llegó a Kepler: antes de reintentar se le pregunta por su marca, para no escribirla dos veces.${nota}`;
    case 'stuck': return `No se pudo escribir después de ${n.intentos} intentos.${nota} Cuando se corrija, «Reintentar en Kepler».`;
    case 'rejected_by_kepler': return `Kepler no la aceptó.${nota} Cuando se corrija (catálogo, acreedor), «Reintentar en Kepler».`;
    case 'cancelled': return 'Se rechazó en la Suite antes de escribirse: no se escribirá en Kepler.';
    default: return 'No se puede decir cómo va su escritura en Kepler.';
  }
}

export type TonoKepler = 'ok' | 'warn' | 'bad' | 'neutro';

/**
 * `[PGP.79]` **Qué dice la pastilla de Kepler en el renglón.** Una sola frase y su tono; el color
 * nunca va solo (la frase lo dice). Regla única para el renglón y el detalle.
 *
 *  · Lo que la Suite NO pudo escribir manda sobre todo: es lo único que alguien tiene que ir a ver.
 *  · `N` en un vale ya aprobado es aviso: la firma de aquí no llegó a Kepler (firma vieja, o apagado).
 *  · `C` es rojo: Kepler la canceló, y aprobarla aquí no la autoriza allá.
 */
export function lecturaKepler(k: KeplerDelVale | null | undefined, status: StatusVale | string): { texto: string; tono: TonoKepler } {
  if (k?.nace_en_la_suite) return lecturaDeLaSuite(k, status);
  if (!k || !k.solicitud) return { texto: 'Kepler: sin folio', tono: 'warn' };
  if (k.suite?.resultado === 'no_escrito' && k.estado !== 'A' && k.estado !== 'F') return { texto: 'Kepler: no se pudo autorizar', tono: 'bad' };
  switch (k.estado) {
    case 'A': return { texto: k.suite?.resultado === 'escrito' ? 'Kepler: autorizada por la Suite' : 'Kepler: autorizada', tono: 'ok' };
    case 'F': return { texto: 'Kepler: aplicada', tono: 'ok' };
    case 'C': return { texto: 'Kepler: cancelada', tono: 'bad' };
    case 'N': return status === 'recibida'
      ? { texto: 'Kepler: sin autorizar', tono: 'neutro' }
      : { texto: 'Kepler: sin autorizar', tono: 'warn' };
    default: return { texto: 'Kepler: sin medir', tono: 'neutro' };
  }
}

/**
 * `[PGP.79]` **La misma lectura, en una frase para el detalle del vale**: qué pasó y, si hace
 * falta, qué hacer. `cuando` llega ya formateada (hora de México) por quien la pinta.
 */
export function explicacionKepler(k: KeplerDelVale, status: StatusVale | string, cuando: string | null): string {
  if (k.nace_en_la_suite) return explicacionDeLaSuite(k, status);
  const quien = k.suite?.firmo ? ` · firmó ${k.suite.firmo}` : '';
  const hora = cuando ? ` el ${cuando}` : '';
  if (k.suite?.resultado === 'no_escrito' && k.estado !== 'A' && k.estado !== 'F') {
    return `Al aprobar, la Suite no pudo autorizarla en Kepler${hora}: ${k.suite.nota || 'sin motivo registrado'}. Autorízala en Kepler o avisa a Sistemas con el folio.`;
  }
  if (k.suite?.resultado === 'escrito') return `La Suite la autorizó en Kepler al aprobar${hora}${quien}.`;
  if (k.suite?.resultado === 'ya_estaba') {
    return `Al aprobar${hora}, Kepler ya la tenía ${k.suite.nota?.endsWith('F') ? 'aplicada' : 'autorizada'}: no hubo nada que escribir.`;
  }
  switch (k.estado) {
    case null: return 'No aparece en la réplica de Kepler: no se puede decir en qué estado está.';
    case 'C': return status === 'recibida'
      ? 'Kepler la tiene cancelada: aprobar aquí no la autoriza allá.'
      : 'Kepler la tiene cancelada.';
    case 'N': return status === 'recibida'
      ? 'Al aprobar, la Suite la autoriza en Kepler.'
      : 'Se aprobó aquí sin que la Suite la autorizara en Kepler (la firma es de antes, o la escritura estaba apagada): allá sigue sin autorizar.';
    case 'A': return 'Kepler la tiene autorizada.';
    case 'F': return 'Kepler ya la aplicó: el dinero salió.';
    default: return '';
  }
}

/**
 * `[PGP.123]` G.UI.1e — **Cerrar el caso de una cancelada** (pedido de Francisco, 2026-11-16: «una persona lo confirma»).
 * Tres salidas: ligar el vale a su recaptura (la que propone la pista, una sola y libre), rechazarlo por repetido (el
 * rechazo de siempre, con su motivo) o «Ya lo revisé», con lo que se hizo o por qué se queda así.
 */
export const NOTA_REVISION_MIN = 3;
export const NOTA_REVISION_MAX = 500;

/** La nota de «Ya lo revisé»: lo que se hizo o por qué se queda así. `null` = válida; si no, por qué no. */
export function faltaEnLaNotaDeRevision(nota: unknown): string | null {
  // Por CARACTERES, como el CHECK de la base (`char_length`): `.length` cuenta unidades UTF-16 y «👍👍» medía 4, pasaba
  // aquí y la base la rechazaba con un 500 (revisión independiente, 2026-11-17).
  const n = [...String(nota ?? '').trim()].length;
  if (n < NOTA_REVISION_MIN) return 'Escribe qué se hizo o por qué se queda así';
  if (n > NOTA_REVISION_MAX) return `La nota es de hasta ${NOTA_REVISION_MAX} letras`;
  return null;
}

/** Quién cerró el caso de una cancelada, cuándo y qué escribió. Lo trae la cola en las canceladas ya revisadas. */
export interface RevisionDeCancelada {
  por: string | null;
  /** ISO. */
  at: string;
  nota: string;
}

/** Lo que contestan `POST …/:id/cancelada/revisar` y `POST …/:id/cancelada/ligar`. */
export interface CanceladaResuelta {
  id: string;
  /** `revisada` = «Ya lo revisé»; `ligada` = el vale quedó ligado a su recaptura (`folio_solicitud`). */
  resultado: 'revisada' | 'ligada';
  folio_solicitud: string | null;
  por: string | null;
  nota: string | null;
}