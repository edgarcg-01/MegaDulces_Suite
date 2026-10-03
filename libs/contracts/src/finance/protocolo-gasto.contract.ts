/**
 * `[GX.59]` — **¿Este vale completó el protocolo?**
 *
 * ## ⛔ `[GX.65.2]` (2026-10-03) — la comprobación de Kepler DEJÓ de ser forzosa
 * Decisión del usuario al definir «Mis gastos» en 3 columnas: *«cuando un gasto no ocupa
 * comprobación, se pasa a gasto aprobado, a expediente sin pago, y cuando se señala esto es una
 * prefactura o cotización, todavía falta el comprobante, se pasan al cuadro de gastos
 * pendientes de comprobación»*. Manda sobre lo pedido el 2026-10-02 (abajo).
 *
 * La regla vigente: **completo = firmado + (si fue prefactura, su factura)**. La comprobación de
 * Kepler ya no entra. **Medido antes de cambiarlo (local, 156 expedientes): 18 pasan de
 * «incompleto» a «completo», 4 siguen incompletos (prefacturas que deben su factura), ninguno
 * empeora.** Lo de abajo queda como historia de por qué existió.
 *
 * ⚠️ `comprobacion_kepler` y `sin_medir` se CONSERVAN en los tipos sólo para no romper a quien
 * todavía los lee; la regla ya no produce ninguno de los dos. Se retiran al rehacer la pantalla
 * (`[GX.65.5]`).
 *
 * ---- Historia (GX.59, 2026-10-02) ----
 *
 * Pedido del usuario (2026-10-01): *«agregar forzosamente la comprobación, sólo así se podrá
 * tomar en cuenta que se completó el protocolo»*, con dos caminos: la **comprobación de
 * Kepler**, que es forzosa, y —si el vale se levantó con una cotización— la **factura del
 * gasto**.
 *
 * ## Qué es cada cosa, medido antes de escribir esto
 * · **La comprobación de Kepler NO se inventa acá.** Ya existe: módulo `expense-comprobaciones`
 *   (GX.8), tabla `finance.expense_comprobaciones`, atada al gasto `XA1001` de Kepler por
 *   `folio_solicitud`. Lo que faltaba no era el primitivo — era **exigirlo**.
 * · **La factura del gasto tampoco.** Es el `comprobante_*` que `[GX.55]` dejó subir después de
 *   aprobar, sobre el vale marcado `provisional`.
 *
 * ## ⛔ Lo que esta regla va a decir el primer día, y hay que saberlo antes de encenderla
 * Medido el 2026-10-01 contra la base: **`finance.expense_comprobaciones` tiene 0 filas** —
 * el módulo GX.8 se construyó y **nunca se usó**. O sea que con la comprobación forzosa, los
 * **155 expedientes** que existen quedan *incompletos*. No es un error de la regla: es el
 * estado real del trámite, y es justo lo que el usuario quiere ver. Lo que esta regla **no**
 * hace es disfrazarlo: cada vale dice QUÉ le falta, no un rojo mudo.
 *
 * ## ⚠️ Por qué el veredicto ENUMERA en vez de elegir
 * Un `switch` que devuelve una sola etapa tiene que ordenar dos preguntas distintas —«¿se
 * firmó?» y «¿se comprobó?»— y al ordenarlas le miente a una: un vale al que le faltan la
 * comprobación **y** la factura mostraría sólo la primera, y quien lo arregle volvería a verlo
 * rojo sin entender por qué. Acá la etapa es el titular y `faltan[]` es la lista completa.
 *
 * ## ⚠️ Y lo que no se pudo medir se DECLARA (ADR-056)
 * `comprobacion_kepler` en `null` significa **«no se preguntó»**, no «no la tiene». Un endpoint
 * que no haga el join devuelve `null`, y pintar eso como «falta» acusaría a 155 personas de no
 * comprobar por un `LEFT JOIN` que nadie escribió. Ese caso sale `sin_medir`.
 */

/** El titular del vale. `sin_medir` NO es un estado del trámite: es un estado de la medición. */
export type EtapaProtocolo =
  | 'en_captura'
  | 'rechazado'
  | 'incompleto'
  | 'completo'
  | 'sin_medir';

/**
 * Cada cosa que le falta al vale para cerrar el protocolo.
 * ⚠️ `comprobacion_kepler` está RETIRADO desde `[GX.65.2]`: la regla ya no lo produce.
 */
export type FaltaProtocoloId = 'firma' | 'comprobacion_kepler' | 'factura_del_gasto';

export interface FaltaProtocolo {
  id: FaltaProtocoloId;
  /** Frase corta, para el chip de la tabla. */
  label: string;
  /** Frase larga, para el panel del vale: qué hay que hacer y quién. */
  detalle: string;
}

export interface VeredictoProtocolo {
  etapa: EtapaProtocolo;
  /** Todo lo que falta, sin colapsar. Vacío cuando la etapa es `completo` o `rechazado`. */
  faltan: FaltaProtocolo[];
  /** `false` = no se pudo evaluar. Nunca se confunde con «le falta algo». */
  medido: boolean;
}

/** Lo que hace falta saber de un vale para juzgarlo. */
export interface EstadoProtocolo {
  /** `recibida` · `aprobada` · `revision` · `validada` · `rechazada`. */
  status?: string | null;
  /** `true` = se aprobó DEBIENDO el comprobante (fue cotización o prefactura) — `[GX.55]`. */
  provisional?: boolean | null;
  /** Los adjuntos del expediente, sólo por su rol. */
  archivos?: readonly { role?: string | null }[] | null;
  /**
   * ¿Hay una comprobación de Kepler (`XA1001`) ligada a este vale?
   * ⛔ `null`/`undefined` = **no se midió**. Ver el encabezado.
   */
  comprobacion_kepler?: boolean | null;
}

/** Estados en los que el vale ya pasó por la firma de quien autoriza. */
const FIRMADOS = new Set(['aprobada', 'revision', 'validada']);

const FALTA: Record<FaltaProtocoloId, Omit<FaltaProtocolo, 'id'>> = {
  firma: {
    label: 'Falta la firma',
    detalle: 'Todavía nadie lo revisó: está esperando en la bandeja de aprobación.',
  },
  comprobacion_kepler: {
    label: 'Falta la comprobación de Kepler',
    detalle: 'El gasto no tiene su comprobación (XA1001) capturada. Es obligatoria: sin ella el protocolo no cierra.',
  },
  factura_del_gasto: {
    label: 'Falta la factura del gasto',
    detalle: 'Se aprobó con una cotización o prefactura. Falta subir la factura de lo que se compró.',
  },
};

const falta = (id: FaltaProtocoloId): FaltaProtocolo => ({ id, ...FALTA[id] });

/** ¿El expediente ya trae el comprobante del gasto (no la cotización)? */
function tieneComprobante(e: EstadoProtocolo): boolean {
  return (e.archivos ?? []).some((f) => String(f?.role ?? '').startsWith('comprobante'));
}

/**
 * El veredicto del vale.
 *
 * Dos preguntas, en el orden del trámite —firma, factura— y las dos se evalúan **siempre**:
 * la lista sale completa aunque falten ambas.
 *
 * `[GX.65.2]` La comprobación de Kepler ya no se pregunta (ver el encabezado). Por eso el
 * veredicto siempre es `medido: true`: no queda nada que dependa de una consulta que pudo no
 * correr — firma, prefactura y archivos vienen del propio expediente.
 */
export function protocoloDelVale(e: EstadoProtocolo): VeredictoProtocolo {
  const status = String(e.status ?? '').trim();

  // Un rechazo cierra el trámite por otro lado: no «le falta» nada, se dijo que no.
  if (status === 'rechazada') return { etapa: 'rechazado', faltan: [], medido: true };

  const faltan: FaltaProtocolo[] = [];
  if (!FIRMADOS.has(status)) faltan.push(falta('firma'));

  // La factura sólo se le pide al que quedó debiendo: exigírsela a todos convertiría en
  // deudor a quien subió su ticket el primer día.
  if (e.provisional === true && !tieneComprobante(e)) faltan.push(falta('factura_del_gasto'));

  if (faltan.length === 0) return { etapa: 'completo', faltan, medido: true };

  /**
   * ⛔ **Sin firma, la etapa es `en_captura` — aunque falten las otras dos.**
   *
   * Acá decía `faltan.length === 1 && faltan[0].id === 'firma'`, y **estaba mal**. Lo destapó
   * el seed, no una prueba: de **78 vales esperando firma, sólo 1** salía «en captura»; los
   * otros 77 caían en «protocolo incompleto».
   *
   * La causa es de fondo, no de conteo: **un vale sin firmar no puede tener comprobación de
   * Kepler**, porque la comprobación es de un gasto YA ejercido. Sumarle ese faltante y
   * ascenderlo a «incompleto» es acusar a alguien de no hacer algo que todavía no puede
   * hacer — y, peor, mezcla en una sola bolsa al que no hizo nada con el que hizo todo menos
   * el último papel, que es justo la distinción que esta pantalla existe para mostrar.
   *
   * ⚠️ `faltan` **sigue enumerando todo**: la información no se pierde, cambia el titular.
   * La etapa dice DÓNDE está el trámite; la lista, qué le falta.
   */
  if (faltan.some((f) => f.id === 'firma')) {
    return { etapa: 'en_captura', faltan, medido: true };
  }
  return { etapa: 'incompleto', faltan, medido: true };
}

/** ¿Cerró el protocolo? Atajo para contar; el detalle vive en el veredicto. */
export function protocoloCompleto(e: EstadoProtocolo): boolean {
  return protocoloDelVale(e).etapa === 'completo';
}

/** Cómo se llama cada etapa en pantalla. */
export const ETAPA_PROTOCOLO_LABEL: Record<EtapaProtocolo, string> = {
  en_captura: 'En captura',
  rechazado: 'Rechazado',
  incompleto: 'Protocolo incompleto',
  completo: 'Protocolo completo',
  sin_medir: 'Sin medir',
};

/**
 * El orden en que se muestran. `completo` va ÚLTIMO y `sin_medir` primero, a propósito: una
 * tabla ordenada por etapa tiene que dejar arriba lo que alguien debe atender, y lo que nadie
 * pudo juzgar es lo primero que hay que destrabar — no lo último que se descubre.
 */
export const ORDEN_ETAPA_PROTOCOLO: EtapaProtocolo[] =
  ['sin_medir', 'incompleto', 'en_captura', 'rechazado', 'completo'];

// ─────────────────────────────────────────────────────────────────────────────
// La forma del borde HTTP de `GET /finance/expenses/proofs/expediente`.
// Vive acá y no en el servicio porque la leen los dos lados (ADR-052): si el
// frontend la copiara a mano, se separarían — es lo que pasó con el tipo de
// procedencia, copiado a los tres días de nacer.
// ─────────────────────────────────────────────────────────────────────────────

/** Un vale dentro del expediente de una persona. */
export interface ValeExpediente {
  id: string;
  folio_solicitud: string | null;
  sucursal: string | null;
  departamento: string | null;
  proveedor: string | null;
  clasificacion: string | null;
  status: string;
  importe: number;
  /** Se aprobó debiendo el comprobante (fue cotización o prefactura). */
  provisional: boolean;
  fecha_gasto: string | null;
  /** El día de México en que se levantó. */
  created_dia: string;
  motivo_rechazo: string | null;
  /** ⛔ `null` = NO se midió (la tabla de comprobaciones no existe en este entorno). */
  comprobacion_kepler: boolean | null;
  comprobacion_folio: string | null;
  /**
   * `[GX.62]` Los folios del **gasto `XA1001`** que nació de esta solicitud, por `c39`.
   *
   * ⚠️ Es una LISTA a propósito. Medido en `[GX.15]`: 8,705 solicitudes tienen 1 gasto, pero
   * **165 tienen 2, 10 tienen 3 y 2 tienen 4**. Un campo singular mostraría uno arbitrario y
   * escondería el resto sin un solo error.
   *
   * Vacío = Kepler todavía no lo ejerció (la solicitud está autorizada pero sin gasto).
   */
  gasto_folios: string[];
  /** Los roles de los adjuntos. Alcanza para decidir qué botón ofrecer, sin mandar URLs. */
  roles: string[];
  protocolo: VeredictoProtocolo;
}

/**
 * El expediente de UNA persona: quién es y todos sus vales.
 *
 * ## ⛔ Por qué hay `clave` y `username` por separado, medido antes de decidirlo
 * El pedido fue agrupar «por usuarios, con su nombre completo además de su username». Al
 * mirar los datos, **ninguno de los dos campos del expediente es un username confiable**:
 *
 *  · `expense_proofs.solicitante` es el **ÁREA** que trae Kepler (SISTEMAS, RRHH, LOGISTICA):
 *    de 155 filas, **1** coincide con un username. Agrupar por ahí da 19 cajones sin persona.
 *  · `expense_proofs.created_by` es quien capturó **acá**, y es el bueno — pero sólo **66 de
 *    155** traen un username; el resto trae el nombre tecleado («Leonardo Cazares»).
 *
 * Así que se agrupa por `created_by` y el username **se declara cuando existe**. Rellenarlo
 * con la clave fingiría un vínculo con el padrón que no hay, y es justo el dato que alguien
 * usaría para escribirle a esa persona.
 */
export interface PersonaExpediente {
  /** Lo que dice el dato, siempre: el valor de `created_by`. Nunca vacío. */
  clave: string;
  /** ⛔ `null` = la clave NO coincide con ningún usuario del padrón. */
  username: string | null;
  /** ⛔ `null` = no se pudo resolver un nombre en `identity.users`. */
  nombre: string | null;
  /** Las áreas de Kepler que aparecen en sus vales. Es otro dato, y no se mezcla con la persona. */
  areas: string[];
  total: number;
  monto: number;
  completos: number;
  /** Firmados a los que les falta la comprobación o la factura. */
  incompletos: number;
  /** Todavía esperan firma: no se les puede reclamar una comprobación que aún no procede. */
  en_captura: number;
  sin_medir: number;
  vales: ValeExpediente[];
}

export interface RespuestaExpediente {
  personas: PersonaExpediente[];
  total: {
    personas: number;
    vales: number;
    completos: number;
    incompletos: number;
    en_captura: number;
    sin_medir: number;
    monto: number;
  };
  /**
   * Cuántas de las personas quedaron SIN username del padrón. Va en el total para que la
   * pantalla pueda decir «12 de 19 no están ligadas a un usuario» en vez de mostrar 12 huecos
   * y dejar que cada quien suponga por qué.
   */
  personas_sin_usuario: number;
  /**
   * ⛔ `false` = la tabla de comprobaciones no existe acá, así que **ningún** vale puede salir
   * completo. La pantalla lo DICE en vez de pintar todo en rojo como si nadie comprobara.
   */
  comprobaciones_medidas: boolean;
  /** Se llegó al tope de filas: hay más de los que se están mostrando. */
  truncado: boolean;
}
