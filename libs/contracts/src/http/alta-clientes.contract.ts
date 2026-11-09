// `[ALC]` Alta de clientes: la constancia del SAT, la ficha de Kepler y la solicitud de alta.
//
// Plan: docs/IMPLEMENTACION/FASES/FASE_ALC_ALTA_DE_CLIENTES.md.
//
// ⛔ La constancia NO se exige para facturar (CFF 83 fr. IX, 2026): sólo prellena. Todo lo que trae
// se puede capturar a mano y vale lo mismo (`origen: 'manual'`).
// D1-a (Francisco, 2026-11-04): la Suite arma la ficha en el orden de la forma `md_cat_cli_sc.kpl`
// para copiarla casilla por casilla y la liga cuando la clave aparece en el ODS.
// D1-b `[ALC.2.8]` (Francisco, 2026-11-07: «preparamos todo para que la escritura directa llegue bien
// y Edgar sólo haga la configuración final»): la Suite escribe `kdud` + `kdfedir` en las 10 bases,
// APAGADA por default detrás de cuatro candados (ver `kepler-cliente-sink.adapter.ts`).

export type TipoPersona = 'fisica' | 'moral';

// ── La constancia (lo que imprimió el SAT, sin corregir nada) ──────────────────────────────
export interface RegimenDeConstancia {
  descripcion: string;
  /** ISO `AAAA-MM-DD`. */
  desde: string | null;
  hasta: string | null;
  /** Sin fecha de fin, o con fecha de fin posterior a la emisión. */
  vigente: boolean;
}

export interface DomicilioDeConstancia {
  codigo_postal: string | null;
  tipo_vialidad: string | null;
  vialidad: string | null;
  numero_exterior: string | null;
  numero_interior: string | null;
  colonia: string | null;
  localidad: string | null;
  municipio: string | null;
  entidad: string | null;
  entre_calle: string | null;
  y_calle: string | null;
}

export interface ConstanciaSituacionFiscal {
  tipo: TipoPersona;
  rfc: string;
  curp: string | null;
  nombre: string | null;
  primer_apellido: string | null;
  segundo_apellido: string | null;
  razon_social: string | null;
  regimen_capital: string | null;
  nombre_comercial: string | null;
  /** Como va en el CFDI 4.0: nombre y apellidos, o la razón social SIN régimen de capital. */
  nombre_fiscal: string;
  estatus_padron: string | null;
  inicio_operaciones: string | null;
  ultimo_cambio_estado: string | null;
  domicilio: DomicilioDeConstancia;
  regimenes: RegimenDeConstancia[];
  emitida_el: string | null;
  lugar_emision: string | null;
  id_cif: string | null;
}

export type MotivoConstanciaIlegible =
  | 'no_es_pdf' | 'cifrado' | 'sin_texto' | 'fuente_no_soportada' | 'ilegible' | 'no_es_constancia' | 'sin_rfc';

export type LecturaConstancia =
  | { ok: true; constancia: ConstanciaSituacionFiscal; faltantes: string[]; avisos: string[] }
  | { ok: false; motivo: MotivoConstanciaIlegible; detalle: string };

// ── La ficha de Kepler (forma «Datos del cliente», tabla `kdud`) ───────────────────────────
/** Casillas de la forma con su columna y su largo máximo en Kepler (diccionario de formas). */
export const CASILLAS_KEPLER = {
  nombre: { columna: 'c3', largo: 100, rotulo: 'Nombre' },
  direccion_1: { columna: 'c4', largo: 40, rotulo: 'Dirección (renglón 1)' },
  direccion_2: { columna: 'c5', largo: 40, rotulo: 'Dirección (renglón 2)' },
  estado: { columna: 'c6', largo: 40, rotulo: 'Estado' },
  codigo_postal: { columna: 'c27', largo: 5, rotulo: 'Código postal' },
  telefono_1: { columna: 'c7', largo: 14, rotulo: 'Tel .1' },
  telefono_2: { columna: 'c8', largo: 14, rotulo: 'Tel .2' },
  telefono_3: { columna: 'c9', largo: 14, rotulo: 'Tel .3' },
  rfc: { columna: 'c10', largo: 13, rotulo: 'RFC' },
  curp: { columna: 'c30', largo: 20, rotulo: 'CURP' },
  email: { columna: 'c11', largo: 60, rotulo: 'Email' },
} as const;
export type CasillaKepler = keyof typeof CASILLAS_KEPLER;

export type FichaKeplerCliente = Record<CasillaKepler, string>;

/** Una casilla cuyo valor completo no cabe: se muestra lo que entra, nunca se corta en silencio. */
export interface CasillaRecortada {
  casilla: CasillaKepler;
  completo: string;
  cabe: string;
  largo: number;
}

export interface ArmadoDeFicha {
  ficha: FichaKeplerCliente;
  recortes: CasillaRecortada[];
}

// ── Validación (la misma regla en la pantalla y en el servidor) ─────────────────────────────
export type GravedadHallazgo = 'bloquea' | 'aviso';

export interface HallazgoAlta {
  campo: string;
  gravedad: GravedadHallazgo;
  mensaje: string;
}

/** Un cliente de Kepler que ya tiene ese RFC (o un nombre muy parecido, si el RFC es genérico). */
export interface PosibleDuplicado {
  clave: string;
  nombre: string;
  rfc: string | null;
  /** Sucursales de Kepler donde existe esa clave. */
  sucursales: string[];
  por: 'rfc' | 'nombre';
}

// ── Catálogos que pide la forma ─────────────────────────────────────────────────────────────
export interface OpcionCatalogo {
  clave: string;
  nombre: string;
}

export interface RegimenFiscalOpcion {
  clave: string;
  descripcion: string;
  persona_fisica: boolean;
  persona_moral: boolean;
}

/** `[ALC.3.6]` Uso de CFDI (`kdfe33satuso`): `regimenes` = con qué regímenes del receptor lo admite el SAT (`c7`). */
export interface UsoCfdiOpcion {
  clave: string;
  descripcion: string;
  regimenes: string[];
}

/**
 * `[ALC.3.6]` Lo que la sucursal ya dice de la cartera, para no teclearlo (medido en `kdud`, 2026-11-07):
 * la zona de la sucursal, su grupo de «venta de piso» y, por grupo, el vendedor que más usan sus
 * fichas (p. ej. el piso de Morelia Abastos lleva el mismo vendedor en 168 de 178 fichas).
 * `null` = la sucursal no implica nada (CEDIS atiende las tres zonas): se elige.
 */
export interface SugeridosCartera {
  zona: string | null;
  grupo_piso: string | null;
  vendedor_por_grupo: Record<string, string>;
}

/** `GET /commercial/customer-onboarding/catalogs?branch=` */
export interface CatalogosAlta {
  branch: string;
  sucursales: OpcionCatalogo[];
  vendedores: OpcionCatalogo[];
  grupos: OpcionCatalogo[];
  zonas: OpcionCatalogo[];
  regimenes: RegimenFiscalOpcion[];
  /** `[ALC.3.6]` Catálogos del SAT que Kepler guarda por cliente en `kdfedir` (ALC.0.8). */
  usos_cfdi: UsoCfdiOpcion[];
  formas_pago: OpcionCatalogo[];
  sugeridos: SugeridosCartera;
}

/**
 * `GET /commercial/customer-onboarding/postal-code/:cp` `[ALC.3.4]` — lo que se sabe de un código
 * postal sin teclearlo: el estado (catálogo del SAT en el ODS, como lo escribe Kepler) y cómo
 * escriben el renglón 2 (colonia, municipio) las fichas de Kepler con ese CP. No hay catálogo de
 * colonias en el ODS: son SUGERENCIAS que la persona elige, nunca se llenan solas.
 */
export interface CodigoPostalAlta {
  codigo_postal: string;
  /** `null` si el CP no está en el catálogo del SAT. */
  estado: string | null;
  sugerencias_direccion_2: { texto: string; fichas: number }[];
}

/**
 * `[ALC.3.5]` Dónde está el cliente. `direccion` = la buscó el geocodificador con el domicilio;
 * `mapa` = la persona movió el punto; `gps` = el teléfono, parado en la tienda (trae precisión).
 */
export interface UbicacionAlta {
  lat: number;
  lng: number;
  origen: 'direccion' | 'gps' | 'mapa';
  /** Metros, sólo del GPS. */
  precision_m?: number | null;
}

// ── La solicitud de alta ────────────────────────────────────────────────────────────────────
export type EstadoSolicitudAlta =
  | 'credito_por_aprobar'   // pidió crédito, plazo o descuento: espera a Crédito y Cobranza
  | 'lista_para_kepler'     // de contado, o con el crédito resuelto: falta capturarla en Kepler
  | 'ligada'                // ya tiene su clave de Kepler
  | 'cancelada';

export type OrigenSolicitudAlta = 'constancia' | 'manual';

/** Lo que captura la pantalla. Con o sin constancia, los mismos campos. */
export interface SolicitudAltaBody {
  branch: string;
  origen: OrigenSolicitudAlta;
  /** Llave del PDF guardado por `POST …/constancia` (sólo con `origen: 'constancia'`). */
  constancia_key?: string | null;
  tipo_persona: TipoPersona;
  rfc: string;
  curp?: string | null;
  nombre_fiscal: string;
  regimen_capital?: string | null;
  nombre_comercial?: string | null;
  regimen_fiscal: string;
  codigo_postal_fiscal: string;
  /** `[ALC.3.6]` Uso de CFDI (`kdfedir.c16`). Vacío → el servidor pone el de costumbre (S01 sin RFC, G01 con RFC). */
  uso_cfdi?: string | null;
  /** `[ALC.3.6]` Forma de pago (`kdfedir.c14`). Vacío → 01 de contado, 99 con crédito (lo medido). */
  forma_pago?: string | null;
  ficha: FichaKeplerCliente;
  vendedor_code?: string | null;
  grupo_code?: string | null;
  zona_code?: string | null;
  credito_solicitado?: number;
  plazo_dias?: number;
  descuento_pct?: number;
  comentarios?: string | null;
  /** Cliente de la Suite que se completa (p. ej. un `V-…` del vendedor). */
  customer_id?: string | null;
  /** `[ALC.3.5]` Dónde está el cliente. Opcional. */
  ubicacion?: UbicacionAlta | null;
  /**
   * El RFC ya tiene ficha en Kepler y aun así se pide otra (p. ej. otra sucursal de entrega).
   * Sin esto, el servidor responde 409 con los duplicados: nunca se duplica sin que alguien lo diga.
   */
  confirmar_duplicado?: boolean;
}

export interface DecisionCredito {
  decision: 'aprobado' | 'rechazado';
  por: string;
  por_nombre: string | null;
  el: string;
  motivo: string;
  credito_aprobado: number;
  plazo_aprobado: number;
  descuento_aprobado: number;
}

export interface SolicitudAlta {
  id: string;
  folio: string;
  estado: EstadoSolicitudAlta;
  origen: OrigenSolicitudAlta;
  branch: string;
  tipo_persona: TipoPersona;
  rfc: string;
  curp: string | null;
  nombre_fiscal: string;
  regimen_capital: string | null;
  nombre_comercial: string | null;
  regimen_fiscal: string;
  codigo_postal_fiscal: string;
  /** `null` en solicitudes anteriores a `[ALC.3.6]`. */
  uso_cfdi: string | null;
  forma_pago: string | null;
  ficha: FichaKeplerCliente;
  vendedor_code: string | null;
  grupo_code: string | null;
  zona_code: string | null;
  credito_solicitado: number;
  plazo_dias: number;
  descuento_pct: number;
  comentarios: string | null;
  credito: DecisionCredito | null;
  constancia_key: string | null;
  constancia_emitida_el: string | null;
  customer_id: string | null;
  ubicacion: UbicacionAlta | null;
  erp_customer_code: string | null;
  ligada_el: string | null;
  creada_por: string | null;
  creada_por_nombre: string | null;
  creada_el: string;
  /**
   * Sólo en «lista para Kepler»: fichas de Kepler (su sucursal) con el mismo RFC propio. Si ya la
   * capturaron allá, ligarla es un clic. La bandeja NO liga sola: ligar escribe y lo firma alguien.
   */
  coincidencias_kepler: CoincidenciaKepler[];
  /** `true` si quien la creó tiene la llave de crédito y la decisión fue suya (se dice en pantalla). */
  credito_decidido_por_quien_la_creo: boolean;
  /** `[ALC.2.8]` La escritura directa en Kepler (D1-b): `null` si nunca se intentó. */
  kepler: EscrituraKeplerSolicitud | null;
}

// ── `[ALC.1.6]`/`[ALC.2.8]` La escritura directa en Kepler (D1-b) ────────────────────────────
//
// Medido el 2026-11-07 con la clave 21054 (dada de alta en Kepler desde el concentrador):
// la ficha `kdud` llegó IDÉNTICA a las 9 bases (00…08) y los datos fiscales `kdfedir` sólo a la 08.
// La forma `md_cat_cli.kpl` no replica en la base: si el servidor es el concentrador (`pv_suc_ip.c6
// = 'SC'`) la librería del cliente `pv_sc_lib` repite cada escritura en las sucursales. Escribir
// directo en una base NO propaga: la Suite escribe en las 10 (concentrador + 9).

/** Una casilla de Kepler en el plan: la columna, su rótulo de pantalla y el valor que se escribe. */
export interface ColumnaPlanKepler {
  columna: string;
  rotulo: string;
  valor: string;
}

/** Un servidor de Kepler para la escritura: ¿tiene conexión configurada? (sin conectarse). */
export interface ServidorEscrituraKepler {
  /** `SC` = concentrador; `00`…`08` = sucursales. */
  servidor: string;
  configurado: boolean;
  motivo: string | null;
}

/** `GET /commercial/customer-onboarding/:id/kepler` — lo que se escribiría, sin escribir nada. */
export interface PlanAltaKepler {
  /** La clave que seguiría hoy según el ODS; al escribir se vuelve a calcular contra las 10 bases vivas. */
  clave_propuesta: string | null;
  /**
   * `contado` = `1xxxx`/`2xxxx`/`3xxxx` · `credito` = `CR1###`/`CR2###`/`CR3###` (Francisco, 2026-11-08:
   * «CR1001: crédito, zona La Piedad, consecutivo»); su consecutivo también cuenta las `C1xxx` viejas.
   */
  serie: { tipo: 'contado' | 'credito'; zona: string; patron: string } | null;
  /** Ya reservada por un intento anterior (se reusa: el reintento no inventa otra clave). */
  clave_reservada: string | null;
  kdud: ColumnaPlanKepler[];
  kdfedir: ColumnaPlanKepler[];
  hallazgos: HallazgoAlta[];
  servidores: ServidorEscrituraKepler[];
  /** `null` = se puede pulsar; si no, por qué no (interruptor apagado, servidores sin configurar, tope del día…). */
  bloqueo_escritura: string | null;
  /** ¿Quien consulta tiene la llave `COMMERCIAL_ALTA_CLIENTES_KEPLER`? */
  puede_escribir: boolean;
  /** Última escritura del maestro de clientes en el ODS: de qué tan fresca es la clave propuesta. */
  kepler_as_of: string | null;
}

export type EstadoServidorAlta = 'escrita' | 'ya_estaba' | 'rechazada';

export interface ResultadoServidorAlta {
  servidor: string;
  estado: EstadoServidorAlta;
  motivo: string | null;
}

export interface EscrituraKeplerSolicitud {
  clave: string;
  /** Cuando las 10 bases quedaron con la ficha; `null` si alguna falló (se reintenta con la MISMA clave). */
  escrita_el: string | null;
  intentada_el: string | null;
  intentada_por_nombre: string | null;
  servidores: ResultadoServidorAlta[];
}

/** `POST /commercial/customer-onboarding/constancia` — el PDF, en data URI. */
export interface SubirConstanciaBody {
  pdf: string;
  branch?: string | null;
}

export interface SubirConstanciaRespuesta {
  lectura: LecturaConstancia;
  /** `null` si la lectura falló o el almacén no está configurado (se dice en `aviso_guardado`). */
  constancia_key: string | null;
  aviso_guardado: string | null;
  /** Prellenado de la forma (sólo con lectura `ok`). */
  armado: ArmadoDeFicha | null;
  /** Sólo si la constancia trae UN régimen vigente; con dos o más, elige la persona. */
  regimen_sugerido: string | null;
  /** Claves del catálogo de los regímenes vigentes de la constancia (para ofrecerlos primero). */
  regimenes_vigentes: string[];
  hallazgos: HallazgoAlta[];
  duplicados: PosibleDuplicado[];
}

/** `POST /commercial/customer-onboarding/validate` — revisar antes de guardar. */
export interface RevisionAlta {
  hallazgos: HallazgoAlta[];
  duplicados: PosibleDuplicado[];
  recortes: CasillaRecortada[];
}

export interface CrearSolicitudRespuesta {
  solicitud: SolicitudAlta;
  revision: RevisionAlta;
}

/** `POST /commercial/customer-onboarding/:id/credit` */
export interface DecidirCreditoBody {
  decision: 'aprobado' | 'rechazado';
  motivo: string;
  credito_aprobado?: number;
  plazo_aprobado?: number;
  descuento_aprobado?: number;
}

/** `POST /commercial/customer-onboarding/:id/link` — la clave que Kepler le dio. */
export interface LigarSolicitudBody {
  erp_customer_code: string;
}

/** La ficha de Kepler encontrada para ligar: lo que dice Kepler contra lo que se capturó. */
export interface CoincidenciaKepler {
  clave: string;
  nombre: string;
  rfc: string | null;
  sucursales: string[];
  coincide_rfc: boolean;
}

export interface BandejaAlta {
  /** `'todos'` = sin recorte de sucursal; `'propios'` = las sucursales de tu alcance. */
  alcance: 'todos' | 'propios' | 'ninguno';
  solicitudes: SolicitudAlta[];
  conteo: Record<EstadoSolicitudAlta, number>;
  /** Si se topó el máximo, se dice (no se esconde). */
  truncada: boolean;
  /** ¿Quien consulta puede decidir crédito? (para mostrar u ocultar la acción). */
  puede_aprobar_credito: boolean;
  /** Última escritura del maestro de clientes de Kepler en el ODS (frescura de las coincidencias). */
  kepler_as_of: string | null;
}
