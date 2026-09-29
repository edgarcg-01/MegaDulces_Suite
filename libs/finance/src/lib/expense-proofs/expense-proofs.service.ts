import { Inject, Injectable, BadRequestException, NotFoundException, Logger, Optional } from '@nestjs/common';
import { ExpenseProofsGateway } from './expense-proofs.gateway';
import { Knex } from 'knex';
import { TenantKnexService, TenantContextService, CloudinaryService, ObjectStorageService, LlmExtractorService, isPlatformAdminRole, Permission } from '@megadulces/platform-core';
// [GX.14] La compuerta y el catalogo de formas de pago viven en libs/contracts: los lee
// este servicio (que devuelve el 400) y el boton del frontend. Una sola regla, no dos.
import { FINANCE_NOTIFIER_PORT, type FinanceNotifierPort, esFormaPagoValida, exigeDetalle, faltaParaMandar, type EstadoAporte } from '@megadulces/contracts';
// [GX.17] La agrupacion de la pantalla de Aprobacion vive aparte, sin knex, porque decide
// QUE VE quien firma y eso se prueba sin base.
import { agruparParaAprobacion, type AgrupadoAprobacion, type ExpedientePendiente } from './aprobacion-agrupar';
// [GX.29] Las reglas de la reapertura viven aparte, sin knex: deciden quien puede tocar
// dinero ya aprobado, y eso se prueba sin levantar una base.
import {
  KIND_REAPERTURA, SQL_OCULTA_RECHAZOS_VIEJOS, puedeAutorizarReapertura, puedePedirReapertura,
  type ValeParaReabrir,
} from './reapertura';
// `[GX.30]` La forma de lo que sale por el cable vive en `libs/contracts`: acá y en el
// frontend estaba escrita dos veces a mano, que es como se desincroniza sin que nadie vea.
import type {
  ReaperturaDecidida, ReaperturaPendiente, SolicitudReaperturaCreada,
} from '@megadulces/contracts';
// `[GX.39]` La etapa de EJERCICIO (lo que pasa despues de que firmamos, del lado de Kepler)
// se decide con la MISMA funcion que lee el chip del frontend. Ver el contrato.
import {
  ETIQUETA_ETAPA, EXPLICACION_ETAPA, etapaDeEjercicio,
  type EstadoKepler, type EtapaEjercicio,
} from '@megadulces/contracts';
// `[GX.41]` A quien le toca un vale de Kepler lo decide UNA funcion, compartida con el
// frontend: la caja «Solicita» trae un username nuestro y tiene que casar exacto.
import { LARGO_MINIMO_USUARIO, normalizarUsuarioKepler, type ValeAsignado } from '@megadulces/contracts';
import {
  diaValido, etapaDe, hoyMx, particionarDelDia,
  type EtapaGasto, type ParticionDelDia,
} from './etapas-del-dia';
import {
  mesValido, rangoDelMes, totalDelMes,
  type CalendarioDelMes, type DiaDelCalendario,
} from './calendario-gastos';

/**
 * GX.7 — Solicitud de autorización de gastos (reembolso). Captura de la solicitud
 * de reembolso ligada por folio a la solicitud de Kepler (XA1501), con múltiples
 * adjuntos. Vive en `finance.expense_proofs`; NO escribe a Kepler (se concilia por
 * folio). Flujo `recibida → validada | rechazada`.
 */

/**
 * Roles de archivo fijos (herencia del Google Form).
 *
 * `solicitud_kepler` es la solicitud **firmada**. No se pide para leerle los datos —esos
 * ya los tenemos de Kepler por folio— sino porque la firma es la evidencia de que alguien
 * autorizó. Por eso es OPCIONAL: lo que no puede faltar es el comprobante del gasto.
 */
/**
 * [GX.23] Un gasto puede llevar VARIAS evidencias: el vale de ida y el de vuelta, el
 * ticket y su detalle, dos cotizaciones que se compararon. Antes cabian dos
 * comprobantes y una cotizacion, y la pantalla solo dejaba subir uno de cada.
 *
 * La lista es CERRADA a proposito, con un tope explicito (4 y 3), en vez de aceptar
 * `comprobante_<n>` por patron: el rol viaja en un JSONB sin CHECK, asi que la unica
 * barrera contra un rol inventado es esta lista. Un patron abierto no seria barrera.
 */
export const PROOF_FILE_ROLES = ['comprobante_1', 'comprobante_2', 'comprobante_3', 'comprobante_4',
  'solicitud_kepler', 'cotizacion', 'cotizacion_2', 'cotizacion_3',
  'evidencia_1', 'evidencia_2', 'evidencia_3'] as const;
export type ProofFileRole = (typeof PROOF_FILE_ROLES)[number];

/**
 * Naturaleza del gasto — decide si la EVIDENCIA (factura/ticket) es obligatoria.
 * `fiscal` y `no_fiscal_comprobable` la exigen; `no_comprobable` cierra sin foto pero
 * con motivo. La comprobación XA1001 vive SIEMPRE en Kepler y es otra cosa.
 */
export const EXPENSE_CLASIFICACIONES = ['fiscal', 'no_fiscal_comprobable', 'no_comprobable'] as const;
export type ExpenseClasificacion = (typeof EXPENSE_CLASIFICACIONES)[number];
/**
 * ¿Este gasto debe llevar **evidencia** (factura/ticket) adjunta? Todo salvo lo declarado
 * no_comprobable.
 *
 * ⚠️ Esto condiciona la EVIDENCIA del gasto, **nunca la solicitud firmada**: esa se sube
 * siempre, sea el gasto fiscal, no fiscal o no comprobable (es la autorización que respalda
 * la salida de dinero). Ver `REQUEST_ROLE`.
 */
export function requiereEvidencia(c?: string | null): boolean {
  return c === 'fiscal' || c === 'no_fiscal_comprobable';
}
/** El archivo de evidencia que puede faltar (condicional a la clasificación). */
const EVIDENCE_ROLE: ProofFileRole = 'comprobante_1';
/**
 * `[GX.33]` Lo que se le dice a quien autoriza cuando la visión NO pudo leer el
 * comprobante. Se DECLARA en vez de callar: un expediente sin aviso se lee como «lo
 * miraron y estaba bien», y acá nadie lo miró.
 */
const AVISO_ILEGIBLE = 'No se pudo leer el comprobante automáticamente — revíselo a mano.';

const money = (v: number | null) => (v == null ? '—'
  : `$${(Number(v) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/**
 * `[GX.33]` El tipo REAL del archivo, desde su data URI. `putFile` sólo sabe de pdf e
 * imagen, así que todo lo demás volvía como `image` y el visor lo pintaba con `<img>`.
 */
function tipoDeArchivo(dataUri: string): 'pdf' | 'image' | 'otro' {
  const ct = (/^data:([^;,]+)[;,]/.exec(dataUri || '')?.[1] || '').toLowerCase();
  if (ct === 'application/pdf') return 'pdf';
  if (ct.startsWith('image/')) return 'image';
  return 'otro';
}

/** La solicitud de gasto firmada. Respaldo de los expedientes anteriores a GX.18. */
const REQUEST_ROLE: ProofFileRole = 'solicitud_kepler';

/**
 * `[GX.31]` **¿Este archivo respalda que alguien autorizó la salida de dinero?**
 *
 * Son dos, y conviven a propósito: `solicitud_kepler` es el papel que se subía hasta
 * GX.17 y que los expedientes viejos traen; el `comprobante*` es la foto del vale
 * autorizado que la captura toma desde GX.18. Aceptar sólo uno rompe una de las dos
 * mitades del historial — y el que se rompía era el de hoy.
 *
 * ⚠️ No mira `live`: eso lo juzga `faltaParaMandar` al CREAR, que es donde se puede
 * exigir. Acá, con el expediente ya guardado, repetirlo dejaría sin aprobar lo que el
 * propio sistema aceptó — un gasto trabado para siempre, sin nadie que pueda destrabarlo.
 */
function tieneRespaldo(f: { role?: unknown; url?: unknown }): boolean {
  const role = String(f?.role || '');
  return !!f?.url && (role === REQUEST_ROLE || role.startsWith('comprobante'));
}

export interface ProofFile {
  role: string; url: string; public_id?: string; kind?: string; name?: string;
  /**
   * `[GX.14]` `true` si la foto salio de la camara abierta en la pantalla, no de un archivo.
   *
   * ⚠️ Es una DECLARACION DEL CLIENTE, no una prueba: quien quiera falsificarla puede.
   * Lo que logra es que la interfaz no ofrezca otro camino y que quien revisa vea de donde
   * salio cada archivo. Volverlo demostrable del lado del servidor exige otra cosa (canal de
   * camara con sesion, o EXIF contra la hora) y NO esta hecho — se declara en vez de aparentar.
   */
  live?: boolean;
  /** Cuando se tomo, en ISO. Lo pone el cliente junto con `live`. */
  captured_at?: string;
}

/**
 * Clave de un expediente contra Kepler. **El folio NO alcanza**: en Kepler es único por
 * SUCURSAL, no global. Medido en prod (2026-09-15): de 9,831 solicitudes hay 9,458 folios
 * distintos pero 9,831 pares `(sucursal, folio)` — o sea **373 folios viven en más de una
 * sucursal** (el `0000002` está en cuatro: 00, 02, 03 y 04).
 *
 * Buscar sólo por folio hacía dos daños silenciosos: el indicador del tablero se encendía en
 * la fila de otra plaza, y `lookupSolicitud` tomaba una fila arbitraria — de ahí salen el
 * IMPORTE y el solicitante con los que se cuadra contra Kepler.
 *
 * Se usa `|` como separador porque el folio de Kepler es `[0-9]` con ceros a la izquierda y
 * la sucursal es de 2 dígitos: ninguno de los dos puede contenerlo.
 */
export function proofKey(sucursal: string | null | undefined, folio: string | null | undefined): string {
  return `${(sucursal ?? '').trim()}|${(folio ?? '').trim()}`;
}

/**
 * `[GX.17]` Lo que devuelve `porAprobar()`: los grupos + las filas con sus archivos ya
 * firmados. Se declara en vez de inferirse porque cruza el boundary REST (ADR-052) y es
 * lo que el frontend de Aprobación tipa del otro lado.
 */
export interface ExpedienteParaAprobar extends ExpedientePendiente {
  concepto: string | null;
  forma_pago_detalle: string | null;
  comentarios: string | null;
  created_by: string | null;
  files: ProofFile[];
}

export interface RespuestaPorAprobar extends AgrupadoAprobacion {
  filas: ExpedienteParaAprobar[];
}

/**
 * `[GX.20]` Un expediente del dia, con todo lo que la pantalla necesita para decir **que
 * falta y de quien**. Extiende el de aprobacion: es el mismo expediente, en cualquier etapa.
 */
export interface ExpedienteDelDiaDetallado extends ExpedienteParaAprobar {
  /** El estado crudo de la tabla. La etapa se deriva de el, pero el estado se muestra. */
  status: string;
  etapa: EtapaGasto;
  /** Hora de captura (`HH:MM`, Mexico). El dia ya viene en `created_at`. */
  created_hora: string;
  motivo_rechazo: string | null;
  revision_nota: string | null;
  validated_by: string | null;
  validated_at: string | null;
  /** Este gasto debe llevar evidencia? Derivado de la clasificacion. */
  requiere_evidencia: boolean;
  /** Ya la subieron? Es lo que separa "falta ejercer" de "falta firmar el cierre". */
  tiene_evidencia: boolean;
}

/** `[GX.20]` Lo que devuelve `delDia()`. Cruza el boundary REST (ADR-052), asi que se declara. */
export interface RespuestaDelDia extends ParticionDelDia {
  /** El dia que se esta mirando (`YYYY-MM-DD`, Mexico). */
  fecha: string;
  es_hoy: boolean;
  /** Hoy en Mexico, para que la pantalla no lo calcule con el reloj del navegador. */
  hoy: string;
  /** La fecha que pidieron cuando era ilegible y se cayo a hoy. `null` = todo en orden. */
  fecha_pedida: string | null;
  filas: ExpedienteDelDiaDetallado[];
  /** Los grupos por departamento de lo que espera decision ESE dia (la bandeja de entrada). */
  entrada: AgrupadoAprobacion;
  /** Lo que espera firma y NO cayo en este dia. El dia filtra lo que se lee, no lo que existe. */
  pendientes_fuera_del_dia: { n: number; monto: number };
}

/** Lo que el tablero necesita saber de un folio sin abrir el expediente. */
export interface ProofByFolio {
  id: string;
  status: string;
  /** ¿Está la evidencia del gasto (factura/ticket)? Obligatoria salvo no_comprobable. */
  comprobante: boolean;
  /** ¿Está la solicitud firmada? Aporta la firma, no los datos. */
  solicitud: boolean;
  /** Naturaleza del gasto: fiscal / no_fiscal_comprobable / no_comprobable. `null` = sin clasificar. */
  clasificacion: string | null;
  /** Derivado de la clasificación: ¿este gasto debe llevar evidencia adjunta? */
  requiere_evidencia: boolean;
  /** (XA1001, dormante) Lo declaraba quien valida. `null` = nadie lo dijo. */
  tiene_comprobacion: boolean | null;
  comprobacion_nota: string | null;
}

export interface CreateExpenseProofDto {
  solicitante?: string;
  departamento?: string;
  departamento_code?: string;
  sucursal?: string;
  fecha_gasto?: string;
  folio_solicitud?: string;
  proveedor?: string;
  importe?: number;
  comentarios?: string;
  /** Naturaleza del gasto — decide si la evidencia es obligatoria (ver ExpenseClasificacion). */
  clasificacion?: string;
  /** `[GX.14]` Cómo se pagó: id del catálogo cerrado (`FORMAS_PAGO`). Obligatorio. */
  forma_pago?: string;
  /** `[GX.14]` El dato que pide la forma elegida (caja, últimos 4, referencia, cheque). */
  forma_pago_detalle?: string;
  files?: ProofFile[];
  // `[GX.32]` Se fueron `monto_ocr`, `subtotal_ocr` y `receipt_legible`: los mandaba la
  // vista previa por visión, que ya no existe. Un campo del borde que nadie llena es un
  // contrato que miente — el siguiente que lo lea va a creer que trae algo.
}

/**
 * `[GX.39]` La fila cruda del listado. Estaba tipada `any` — y el `any` no es cosmetico aca:
 * es la fila que despues entra a `conEtapa()`, que decide si un gasto dice «ejercido». Con
 * `any`, un `folio_solicitud` mal escrito compila y la etapa sale `sin_medir` para todos sin
 * que nada se queje.
 */
interface FilaDeGasto {
  status?: string;
  folio_solicitud?: string | null;
  sucursal?: string | null;
  importe?: unknown;
  monto_ocr?: unknown;
  files?: unknown;
  [k: string]: unknown;
}

/** `files` viaja como jsonb: knex lo entrega ya parseado o como texto, segun el driver. */
function archivosDe(v: unknown): ProofFile[] {
  if (typeof v === 'string') { try { return JSON.parse(v || '[]') as ProofFile[]; } catch { return []; } }
  return Array.isArray(v) ? (v as ProofFile[]) : [];
}

export interface ListExpenseProofsQuery {
  status?: string;
  folio_solicitud?: string;
  search?: string;
  from?: string;
  to?: string;
  /** Sólo lo que capturó este usuario (para la vista del capturista). */
  mine?: string;
  /**
   * `[GX.27]` Un día de calendario **de México** (`YYYY-MM-DD`).
   *
   * ⚠️ Es distinto de `from`/`to`, que comparan `created_at` contra un string suelto y por eso
   * arrastran el corrimiento de zona: `'2026-09-26'` es medianoche **UTC**, o sea las 18:00 del
   * 25 en México. Para «lo del día 26» eso mete seis horas del día anterior y pierde seis del
   * propio. `dia` se resuelve como rango en hora de México.
   */
  dia?: string;
  limit?: number;
}

@Injectable()
export class ExpenseProofsService {
  private readonly logger = new Logger(ExpenseProofsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly cloudinary: CloudinaryService,
    private readonly storage: ObjectStorageService,
    // `[GX.33]` Vuelve el lector, pero **sólo para avisar**: ver `leerParaAvisar()`.
    private readonly ocr: LlmExtractorService,
    @Optional() private readonly gateway?: ExpenseProofsGateway,
    /**
     * `[GX.26]` El canal que llega a la CAMPANA de quien levanto el gasto. `@Optional`
     * como manda el port: si no hay binding, la decision se guarda igual y el aviso no
     * sale -- nunca al reves.
     */
    @Optional() @Inject(FINANCE_NOTIFIER_PORT) private readonly notifier?: FinanceNotifierPort,
  ) {}

  /** Aviso WS al autorizador (best-effort; nunca rompe la operación). */
  private emit(action: 'captured' | 'validated' | 'rejected',
    row: { folio_solicitud: string; status?: string | null; solicitante?: string | null; importe?: number | null; sucursal?: string | null },
    actor?: string): void {
    try {
      const tenantId = this.tenantCtx.requireTenantId();
      this.gateway?.emitChange(tenantId, {
        action, folio_solicitud: row.folio_solicitud, status: row.status ?? null,
        solicitante: row.solicitante ?? null, sucursal: row.sucursal ?? null,
        importe: row.importe == null ? null : Number(row.importe), actor: actor ?? null,
      });
    } catch { /* el aviso no debe tumbar la operación */ }
  }

  /**
   * `[GX.26]` **El aviso a QUIEN LEVANTO el gasto.**
   *
   * El `emit` de arriba avisa al AUTORIZADOR que llego algo. Este es el camino de vuelta:
   * la persona que tomo la foto mandó el vale y se quedo sin saber en que quedo. Ahora le
   * llega a su campana cuando se aprueba o se rechaza, con el motivo si lo hubo.
   *
   * ⚠️ Va a SU cuarto, no al del tenant: «tu vale fue rechazado» es de una persona, y
   * mandarselo a los 166 seria ruido para 165 y una fuga para el dueño.
   *
   * ⛔ Los expedientes que entraron por LINK no tienen a quien avisarle: su `created_by`
   * es `link:<quien firmo>`, que no es un usuario de la app. Se DECLARA en el log en vez
   * de intentar adivinar a quien mandarselo.
   */
  private avisarAlSolicitante(
    decision: 'aprobado' | 'rechazado',
    row: { folio_solicitud?: string | null; created_by?: string | null; proveedor?: string | null;
           importe?: number | null; motivo_rechazo?: string | null },
  ): void {
    try {
      const quien = String(row.created_by || '').trim();
      if (!quien) return;
      if (quien.startsWith('link:')) {
        this.logger.debug(`sin aviso: ${row.folio_solicitud} lo levanto un link (${quien}), no un usuario`);
        return;
      }
      const tenantId = this.tenantCtx.requireTenantId();
      const folio = row.folio_solicitud || 'sin folio';
      const monto = row.importe == null ? '' : ` · $${Number(row.importe).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;
      const aprobado = decision === 'aprobado';
      void this.notifier?.notify?.(tenantId, {
        key: `vale_${decision}:${folio}`,
        type: 'vale_resuelto',
        severity: aprobado ? 'info' : 'warn',
        title: aprobado ? `Aprobaron tu vale ${folio}` : `Rechazaron tu vale ${folio}`,
        message: aprobado
          ? `${row.proveedor || 'Sin proveedor'}${monto}`
          : `${row.proveedor || 'Sin proveedor'}${monto} — ${row.motivo_rechazo || 'sin motivo declarado'}`,
        route: '/finanzas/gastos-historial',
        para_usuario: quien,
        data: { folio_solicitud: folio, decision, importe: row.importe ?? null },
      });
    } catch { /* el aviso no debe tumbar la decision */ }
  }

  /**
   * `[GX.29]` Lee el vale + el estado que Kepler le puso, que es lo que las reglas de
   * reapertura necesitan. Dos viajes y no un JOIN porque `analytics.expense_requests` es
   * una VISTA sobre el ODS y cruzarla con la tabla sale caro (medido en GX.15: >90 s).
   */
  private async valeParaReabrir(trx: Knex.Transaction, id: string): Promise<ValeParaReabrir | null> {
    const v = await trx('finance.expense_proofs').where({ id })
      .first('id', 'status', 'validated_by', 'created_by', 'folio_solicitud', 'sucursal');
    if (!v) return null;
    let estadoKepler: string | null = null;
    if (v.folio_solicitud) {
      const sol = await trx('analytics.expense_requests')
        .where({ tenant_id: this.tenantCtx.requireTenantId(), folio: v.folio_solicitud })
        .modify((qb: Knex.QueryBuilder) => { if (v.sucursal) qb.where('sucursal', v.sucursal); })
        .first('estado');
      estadoKepler = sol?.estado ?? null;
    }
    return { ...v, estado_kepler: estadoKepler };
  }

  /**
   * `[GX.29]` **El capturista pide que le reabran su vale.**
   *
   * No lo reabre: deja una solicitud que decide quien lo aprobo. Vive en
   * `finance.proposed_actions`, el molde que ya existia para «alguien propone, otro
   * decide, nada se ejecuta solo» — no se invento una tabla para lo mismo.
   */
  async solicitarReapertura(id: string, actor: string, motivo: string): Promise<SolicitudReaperturaCreada> {
    const tenantId = this.tenantCtx.requireTenantId();
    const razon = String(motivo || '').trim();
    if (razon.length < 10) throw new BadRequestException('Contá en una frase qué vas a agregar: quien autoriza decide con eso.');
    return this.tk.run(async (trx) => {
      const vale = await this.valeParaReabrir(trx, id);
      const v = puedePedirReapertura(vale, actor);
      if (!v.puede) throw new BadRequestException(v.explicacion);

      // Una sola solicitud viva por vale: pedirlo tres veces no lo hace mas urgente, y le
      // llena la bandeja a quien decide con el mismo caso repetido.
      const yaHay = await trx('finance.proposed_actions')
        .where({ tenant_id: tenantId, kind: KIND_REAPERTURA, estado: 'pending_approval' })
        .whereRaw("payload->>'proof_id' = ?", [id]).first('id');
      if (yaHay) throw new BadRequestException('Ya hay una solicitud esperando respuesta para este vale.');

      const [row] = await trx('finance.proposed_actions').insert({
        tenant_id: trx.raw('public.current_tenant_id()'),
        kind: KIND_REAPERTURA,
        titulo: `Reabrir el vale ${vale!.id}`,
        descripcion: razon,
        payload: JSON.stringify({ proof_id: id, aprobador: vale!.validated_by, solicita: actor }),
        estado: 'pending_approval',
        origen: 'humano',
        created_by: actor || null,
      }).returning(['id']);

      // Le llega a QUIEN APROBO, a su campana. No al area: es su firma la que se toca.
      void this.notifier?.notify?.(tenantId, {
        key: `reapertura:${id}`,
        type: 'vale_resuelto',
        severity: 'warn',
        title: 'Te piden reabrir un vale que aprobaste',
        message: razon,
        route: '/finanzas/aprobacion-gastos',
        para_usuario: vale!.validated_by || '',
        data: { proof_id: id, solicitud_id: row.id },
      });
      this.logger.log(`reapertura solicitada para ${id} por ${actor} → decide ${vale!.validated_by}`);
      return { id: row.id, estado: 'pending_approval' };
    });
  }

  /** `[GX.29]` Las solicitudes de reapertura que le toca decidir a ESTA persona. */
  async reaperturasPendientes(actor: string): Promise<ReaperturaPendiente[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!String(actor || '').trim()) return [];
    return this.tk.run(async (trx) => trx('finance.proposed_actions as a')
      .join('finance.expense_proofs as p', trx.raw("p.id::text = a.payload->>'proof_id'"))
      .where({ 'a.tenant_id': tenantId, 'a.kind': KIND_REAPERTURA, 'a.estado': 'pending_approval' })
      .where('p.validated_by', actor)
      .orderBy('a.created_at', 'desc')
      .select('a.id', 'a.descripcion as motivo', 'a.created_by as solicita', 'a.created_at',
        'p.id as proof_id', 'p.folio_solicitud', 'p.proveedor', 'p.status',
        trx.raw('p.importe::numeric AS importe')));
  }

  /**
   * `[GX.29]` **Quien aprobo decide.** Si acepta, el vale vuelve a la bandeja del dia.
   *
   * ⛔ Vuelve el MISMO expediente, con `vuelta + 1` — no se crea uno nuevo. Un registro
   * nuevo contaria ese dinero dos veces en el total del dia, en el historial y en lo que
   * se le reporta a Direccion, y duplicaria el folio de Kepler de este lado.
   *
   * ⛔ Y vuelve a `recibida`, que es el estado que la bandeja ya lista: se ve como algo
   * nuevo que atender sin inventar un sexto estado que todas las consultas tendrian que
   * aprender. Al agregar la evidencia hay que autorizarlo otra vez, que es el pedido.
   */
  async decidirReapertura(solicitudId: string, actor: string, aprueba: boolean, nota?: string): Promise<ReaperturaDecidida> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const sol = await trx('finance.proposed_actions')
        .where({ id: solicitudId, tenant_id: tenantId, kind: KIND_REAPERTURA, estado: 'pending_approval' })
        .first('id', 'payload', 'descripcion', 'created_by');
      if (!sol) throw new BadRequestException('Esa solicitud ya no está esperando respuesta.');
      const payload = typeof sol.payload === 'string' ? JSON.parse(sol.payload || '{}') : (sol.payload || {});
      const proofId = String(payload.proof_id || '');

      const vale = await this.valeParaReabrir(trx, proofId);
      const v = puedeAutorizarReapertura(vale, actor);
      if (!v.puede) throw new BadRequestException(v.explicacion);

      await trx('finance.proposed_actions').where({ id: solicitudId }).update({
        estado: aprueba ? 'approved' : 'rejected',
        decided_by: actor || null, decided_at: trx.fn.now(),
        resultado: String(nota || '').trim() || null, updated_at: trx.fn.now(),
      });

      if (aprueba) {
        await trx('finance.expense_proofs').where({ id: proofId }).update({
          status: 'recibida',
          vuelta: trx.raw('COALESCE(vuelta, 1) + 1'),
          reabierto_por: actor || null, reabierto_at: trx.fn.now(),
          reapertura_motivo: sol.descripcion || null,
          updated_at: trx.fn.now(),
        });
      }

      void this.notifier?.notify?.(tenantId, {
        key: `reapertura_resuelta:${proofId}`,
        type: 'vale_resuelto',
        severity: aprueba ? 'info' : 'warn',
        title: aprueba ? 'Te reabrieron el vale' : 'No te reabrieron el vale',
        message: aprueba
          ? 'Agregá la evidencia y mandalo otra vez: hay que autorizarlo de nuevo.'
          : (String(nota || '').trim() || 'Sin motivo declarado.'),
        route: '/finanzas/gastos',
        para_usuario: String(sol.created_by || ''),
        data: { proof_id: proofId },
      });
      this.logger.log(`reapertura ${aprueba ? 'concedida' : 'negada'} para ${proofId} por ${actor}`);
      return { proof_id: proofId, reabierto: aprueba };
    });
  }

  /**
   * Catálogo canónico de departamentos = dimensión `dpto` del ERP
   * (analytics.expense_entries), deduplicada por código y sin ruido. Cada uno con
   * su `sucursal` derivada del código (o "Oficinas / Corporativo").
   */
  async departamentos(): Promise<{ code: string; nombre: string; sucursal: string }[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const rows = await trx
        .with('ranked', (qb) => {
          qb.from('analytics.expense_entries')
            .where('tenant_id', tenantId)
            .whereNotNull('dpto').whereNotNull('dpto_nombre')
            .whereNot('dpto', 'S/A')
            .whereRaw(`dpto_nombre NOT ILIKE '%NO USAR%'`)
            .whereRaw(`dpto_nombre NOT ILIKE 'TRASPASO%'`)
            .whereRaw(`dpto_nombre NOT ILIKE 'SIN ASIGNAR%'`)
            .groupBy('dpto', 'dpto_nombre')
            .select('dpto', 'dpto_nombre', trx.raw('COUNT(*) AS n'),
              trx.raw('row_number() OVER (PARTITION BY dpto ORDER BY COUNT(*) DESC) AS rn'));
        })
        .from('ranked').where('rn', 1)
        .orderBy('dpto_nombre')
        .select('dpto AS code', 'dpto_nombre AS nombre');
      return rows.map((r: any) => ({ code: r.code, nombre: r.nombre, sucursal: this.deriveSucursal(r.code) }));
    });
  }

  /** Plaza/sucursal a partir del código dpto Kepler `1-RR-SS-XX`. Corporativo → "Oficinas / Corporativo". */
  private deriveSucursal(code: string): string {
    const seg = String(code || '').split('-');
    const rr = seg[1] || '';
    if (['09', '10', '11', '90'].includes(rr)) return 'Oficinas / Corporativo';
    if (rr === '08') return 'CEDIS / Logística';
    const PLAZA: Record<string, string> = {
      '10': 'Padre Hidalgo', '40': 'Ocho Esquinas', '42': 'La Piedad Abastos', '44': 'Yurécuaro',
      '30': 'Morelia Abastos', '32': 'Morelia Madero', '35': 'Bodega Casahuates', '88': 'Deliciate',
      '50': 'Canindo', '54': 'Zamora Centro', '53': 'Zamora Centro',
    };
    // seg[2] normal (1-RR-SS-XX); fallback para códigos malformados tipo "142-00" (seg[0]="142" → "42").
    return PLAZA[seg[2] || ''] || PLAZA[(seg[0] || '').replace(/^1/, '')] || 'Otra';
  }

  /**
   * Sube UN archivo a Cloudinary (comprobante/solicitud/evidencia). Se llama una
   * vez por archivo para no rebasar el límite de body (hasta 6 × 10MB por form).
   */
  async uploadFile(dataUri: string, role: string, sello?: { live?: boolean; captured_at?: string }): Promise<ProofFile> {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!dataUri) throw new BadRequestException('archivo requerido');
    if (!PROOF_FILE_ROLES.includes(role as ProofFileRole)) throw new BadRequestException(`role inválido: ${role}`);
    try {
      const f = await this.storage.putFile(dataUri, `finance/${tenantId}/expense-proofs`);
      // [GX.14] El sello viaja CON el archivo, no en una tabla aparte: quien revisa abre el
      // expediente y ve de donde salio cada foto sin tener que cruzar nada.
      // `[GX.33]` El tipo se deduce del ARCHIVO, no del almacenamiento. `putFile` sólo
      // distingue pdf/imagen, así que un `.docx` volvía como `image` y el visor lo pintaba
      // con `<img>`: un recuadro roto que se lee como «el archivo no existe».
      const out: ProofFile = { role, url: f.key, public_id: f.key, kind: tipoDeArchivo(dataUri) };
      if (sello?.live === true) { out.live = true; out.captured_at = sello.captured_at || new Date().toISOString(); }
      return out;
    } catch (e: any) {
      if (e?.status === 400) throw e; // "no configurado"
      this.logger.error(`fallo subiendo ${role}: ${e?.message || e}`);
      throw new BadRequestException('no se pudo subir el archivo');
    }
  }

  /**
   * `[GX.33]` **La visión vuelve, y esta vez sólo AVISA.**
   *
   * ## El contrato, que es lo que cambió
   * Antes decidía: si el monto cuadraba, el expediente cerraba solo en `validada` y
   * quedaba firmado `validated_by: 'Claude Vision'`. Eso se retiró en `[GX.32]` y **no
   * vuelve**. Lo que vuelve es la lectura, con tres reglas duras:
   *
   *   1. **Nunca decide el estado.** Quién cierra y en qué estado lo sigue resolviendo
   *      una persona; esto sólo escribe una leyenda.
   *   2. **Nunca frena.** Si no hay API key, si el archivo no se puede leer, si el modelo
   *      falla o si lo que subieron no es una imagen — el gasto se manda igual. Cualquier
   *      excepción se traga acá: pedido explícito del usuario.
   *   3. **Lo que no pudo leer se DECLARA.** No devuelve `null` en silencio: dice «no se
   *      pudo leer» para que quien autoriza sepa que nadie miró ese número (ADR-056).
   *
   * ⚠️ Corre FUERA de la transacción: es I/O de segundos contra un modelo.
   */
  private async leerParaAvisar(files: ProofFile[], esperado: number): Promise<string | null> {
    const comp = files.find((f) => String(f.role).startsWith('comprobante') && f.url);
    if (!comp) return null;                       // sin comprobante no hay nada que leer
    if (!process.env.ANTHROPIC_API_KEY) return null;  // sin lector no se inventa un aviso
    // Sólo se le pide a una imagen o a un PDF. Un `.docx` no es ilegible: es otra cosa.
    if (comp.kind && comp.kind !== 'image' && comp.kind !== 'pdf') return null;
    try {
      const key = comp.public_id || comp.url || '';
      const dataUri = key ? await this.storage.getDataUri(key) : null;
      if (!dataUri) return AVISO_ILEGIBLE;
      const m = /^data:([^;,]+)[;,]/.exec(dataUri);
      const mediaType = (m ? m[1] : 'image/jpeg').toLowerCase();
      const f = await this.ocr.extractExpenseReceipt(dataUri.replace(/^data:[^,]*,/, ''), mediaType as never);
      const legible = f.legible && (f.total != null || f.subtotal != null);
      if (!legible) return AVISO_ILEGIBLE;
      if (!(esperado > 0)) return null;           // sin importe esperado no hay con qué comparar
      const tol = Math.max(1, Math.abs(esperado) * 0.01);  // $1 o 1%, para redondeo e IVA
      const candidatos = [f.total, f.subtotal].filter((v): v is number => v != null && Number.isFinite(v));
      if (candidatos.some((v) => Math.abs(v - esperado) <= tol)) return null;  // cuadra: sin ruido
      const usado = candidatos[0] ?? null;
      return `⚠ El comprobante dice ${money(usado)} y la solicitud ${money(esperado)}`
        + ` (difieren ${money(Math.abs((usado ?? 0) - esperado))}). Reviselo antes de autorizar.`;
    } catch (e) {
      // ⛔ Que la visión falle NO puede impedir levantar un gasto. Se declara y sigue.
      this.logger.warn(`visión falló (el gasto sigue): ${(e as Error)?.message || e}`);
      return AVISO_ILEGIBLE;
    }
  }

  /**
   * `[GX.32]` **Acá vivía el cuadre por visión, y se retiró por pedido del usuario.**
   *
   * Eran cuatro piezas: `tolerancia()` ($1 o 1% del importe), `montoCuadra()` (total o
   * subtotal contra la solicitud), `serverReadReceipt()` (Claude Vision releía en el
   * servidor el comprobante ya subido, para no confiar en el `monto_ocr` del cliente) y
   * `validatePhoto()` (la vista previa «cuadra / en revisión» que el front mostraba al
   * adjuntar la foto).
   *
   * ⛔ Se van **enteras**, no se dejan muertas: un método sin quien lo llame se lee como
   * que el mecanismo sigue vivo, y el siguiente que pase lo vuelve a cablear.
   *
   * ⚠️ Lo que NO se fue: las columnas `monto_ocr`, `monto_match` y `revision_nota`. Hay
   * expedientes cerrados con esos números y borrarlas reescribiría el historial — se
   * conservan, dejan de escribirse, y el módulo hermano `expense-comprobaciones` (GX.8)
   * mantiene su propio `validate-photo`, que es otra pantalla y no se tocó.
   */
  /** Alta del expediente de gasto (con los archivos ya subidos vía uploadFile). */
  async create(dto: CreateExpenseProofDto, actor?: string) {
    this.tenantCtx.requireTenantId();
    const req = (v?: string) => (v || '').trim();
    const folioSolicitud = req(dto.folio_solicitud);
    const files = Array.isArray(dto.files) ? dto.files.filter((f) => f && f.url && f.role) : [];
    if (!folioSolicitud) throw new BadRequestException('folio de la solicitud requerido');

    // Clasificación del gasto: decide si la evidencia (factura/ticket) es obligatoria.
    const clasificacion = req(dto.clasificacion) as ExpenseClasificacion | '';
    if (!clasificacion || !EXPENSE_CLASIFICACIONES.includes(clasificacion as ExpenseClasificacion)) {
      throw new BadRequestException('clasificación del gasto requerida (fiscal / no_fiscal_comprobable / no_comprobable)');
    }
    const llevaEvidencia = requiereEvidencia(clasificacion);
    const motivo = req(dto.comentarios);

    // La solicitud ya subida a Kepler ES la fuente de verdad: trae solicitante,
    // beneficiario, sucursal, fecha e importe. Pedirlos otra vez en el formulario era
    // hacer teclear lo que el sistema ya sabe —y abría la puerta a que la captura
    // contradiga a Kepler—. Lo que de verdad falta aportar es la evidencia.
    // Lo que venga en el DTO sigue mandando: permite capturar una solicitud que todavía
    // no llegó por el feed.
    const sol = await this.lookupSolicitud(folioSolicitud, req(dto.sucursal));
    const solicitante = req(dto.solicitante) || req(sol?.solicitante) || actor || '';
    const proveedor = req(dto.proveedor) || req(sol?.beneficiario);
    // `departamento` solo servía para derivar la sucursal; si la solicitud ya la trae,
    // exigirlo era un trámite. Se guarda la sucursal, que es el dato que importa.
    const sucursal = req(dto.sucursal) || req(sol?.sucursal);
    const departamento = req(dto.departamento) || (sucursal ? `Sucursal ${sucursal}` : '');
    if (!solicitante) throw new BadRequestException('solicitante requerido (no vino en la solicitud ni en el formulario)');
    if (!proveedor) throw new BadRequestException('proveedor requerido (no vino en la solicitud ni en el formulario)');
    if (!departamento) throw new BadRequestException('departamento o sucursal requerido');

    // `[GX.31]` **El respaldo de la salida de dinero sigue siendo obligatorio — cambió
    // cuál es.** Hasta GX.17 era el archivo `solicitud_kepler`, que se subía en un paso
    // propio. GX.18 retiró ese paso por pedido del usuario y lo reemplazó por la FOTO EN
    // VIVO del vale autorizado, que ahora se toma en los tres tipos de gasto.
    //
    // ⛔ El candado viejo quedó en pie y **dejó la captura inutilizable**: ninguna
    // pantalla adjuntaba ya ese rol, así que todo POST moría en este 400. Medido contra
    // la API con exactamente lo que manda hoy la captura.
    //
    // ⚠️ Y su reemplazo NO estaba cubierto: `faltaParaMandar` sólo exige la foto cuando
    // `exige_evidencia` es true, y GX.19 fija la captura en `no_comprobable` — o sea que
    // quitar el candado a secas dejaba crear un gasto SIN NINGÚN documento. Por eso la
    // foto se exige ahora SIEMPRE (ver `exige_evidencia: true` abajo), y no por la
    // clasificación: lo que la clasificación decide es qué CLASE de papel es, no si hay.
    //
    // Los expedientes viejos conservan su `solicitud_kepler` y se siguen aprobando: las
    // puertas de `approve()` y `validate()` aceptan cualquiera de los dos respaldos.
    // GX.11 — la EVIDENCIA vuelve a exigirse en la captura. El diseño de «dos momentos»
    // (mig 20260827120000) la difería hasta después de aprobar, y existía para el caso
    // *pedir dinero → gastar → comprobar*. Decisión del PM (2026-09-15): acá el expediente
    // SIEMPRE se captura después de gastar, así que el ticket ya existe al capturar y
    // diferirlo sólo creaba expedientes a medias esperando a alguien.
    //
    // `addEvidence()` y el estado 'aprobada' se conservan: hay expedientes en prod parados
    // en ese punto y quitarlos los dejaría sin forma de cerrarse.
    if (llevaEvidencia && !files.some((f) => String(f.role).startsWith('comprobante'))) {
      throw new BadRequestException('falta la evidencia del gasto (el ticket o la factura)');
    }
    // No comprobable: no se exige foto, pero sí el motivo — si no, el «no» no se audita.
    if (!llevaEvidencia && !motivo) {
      throw new BadRequestException('un gasto no comprobable exige un motivo (por qué no lleva evidencia)');
    }

    // [GX.14] LA COMPUERTA. Las dos cosas que quien gastó tiene que aportar y que Kepler no
    // pide: cómo se pagó, y la foto TOMADA EN VIVO. La regla no se escribe acá — vive en
    // `faltaParaMandar()` (libs/contracts), que es la MISMA que enciende el botón del frontend.
    // Escrita dos veces, se separan: es el defecto que ADR-056 midió ocho veces.
    //
    // Que el botón esté apagado no es un control, es una cortesía. El control es este 400.
    const formaPago = req(dto.forma_pago);
    const formaPagoDetalle = req(dto.forma_pago_detalle);
    const faltan = faltaParaMandar({
      forma_pago: formaPago,
      forma_pago_detalle: formaPagoDetalle,
      archivos: files,
      // `[GX.31]` SIEMPRE, no `llevaEvidencia`. La foto del vale autorizado es el
      // respaldo de que alguien autorizó la salida de dinero, y eso no depende de que
      // el gasto lleve factura. Con `llevaEvidencia` acá, un `no_comprobable` —que es
      // lo que la captura genera desde GX.19— pasaba sin una sola imagen.
      //
      // ⚠️ Es además lo que el FRONTEND ya hacía: su `llevaEvidencia` es
      // `!!clasificacion()`, no `requiereEvidencia(...)`, así que su compuerta pedía la
      // foto y la del servidor no. Las dos reglas escritas distinto se separan, que es
      // justo lo que esta función existe para evitar.
      exige_evidencia: true,
    } satisfies EstadoAporte);
    if (faltan.length) throw new BadRequestException(faltan.map((f) => f.motivo).join('; '));

    return this.tk.run(async (trx) => {
      // Importe esperado = el de la solicitud Kepler (XA1501, fuente de verdad); si no se
      // encuentra, cae al del DTO (auto-rellenado por el front desde la misma solicitud).
      const solRow = await trx('analytics.expense_requests')
        .where({ tenant_id: this.tenantCtx.requireTenantId(), folio: folioSolicitud })
        .first(trx.raw('importe::numeric AS importe'));
      const importe = Number(solRow?.importe) || Number(dto.importe) || 0;

      // Dos momentos: la captura SIEMPRE entra como 'recibida' (esperando aprobación). El
      // cuadre por visión y la evidencia vienen después, al subirla (ver addEvidence).
      const [row] = await trx('finance.expense_proofs')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          solicitante, departamento, departamento_code: req(dto.departamento_code) || null,
          sucursal: sucursal || null,
          fecha_gasto: dto.fecha_gasto || solRow?.fecha || null,
          folio_solicitud: folioSolicitud, proveedor,
          importe,
          clasificacion,
          forma_pago: formaPago,
          // El detalle sólo se guarda si la forma elegida lo pide: guardarlo para `vales`
          // dejaría un texto que después nadie sabe cómo leer.
          forma_pago_detalle: exigeDetalle(formaPago) ? formaPagoDetalle : null,
          // El motivo de un no_comprobable vive en comprobacion_nota (campo de "por qué falta").
          comprobacion_nota: llevaEvidencia ? null : motivo,
          files: JSON.stringify(files),
          comentarios: motivo || null,
          status: 'recibida',
          created_by: actor || null,
          // `[GX.34]` Quien SUBE la evidencia se queda con el vale. En este camino es la
          // misma persona que lo levanta, pero se escribe igual: así la regla es UNA
          // —«es tuyo si subiste su evidencia»— y no «depende de por dónde entró».
          ...(files.some((f) => String(f.role).startsWith('comprobante'))
            ? { evidencia_por: actor || null, evidencia_at: trx.fn.now() }
            : {}),
        })
        .returning(['id', 'folio_solicitud', 'status']);
      this.logger.log(`solicitud de gasto folio ${row.folio_solicitud} [${clasificacion}/${formaPago}] capturada → recibida · ${files.length} archivos (${files.filter((f) => f.live).length} en vivo), por ${actor || '?'}`);
      this.emit('captured', { folio_solicitud: row.folio_solicitud, status: row.status, solicitante, importe: dto.importe, sucursal: dto.sucursal }, actor);
      return row;
    });
  }

  /**
   * MOMENTO 2 — el aprobador APRUEBA la solicitud ya capturada (recibida).
   *   - no_comprobable → cierra en 'validada' (no hay evidencia que pedir; la aprobación ES
   *     la validación). Exige el motivo, que ya venía de la captura.
   *   - comprobable    → pasa a 'aprobada': recién ahí el capturista puede subir la evidencia.
   * En ambos casos la solicitud firmada es obligatoria (respalda la salida de dinero).
   * Puede RECLASIFICAR si el capturista se equivocó de naturaleza.
   */
  async approve(id: string, actor?: string, dto?: { clasificacion?: string; comprobacion_nota?: string;
    /**
     * [GX.30] **Apruebo, pero esto es provisional.** La evidencia que trae el vale es una
     * prefactura o una cotizacion, no el comprobante: el dinero sale y queda una DEUDA
     * documental declarada, con su fecha esperada.
     *
     * No es un error ni una excepcion -- es el curso normal de ese tipo de gasto. Lo que
     * cambia es que ahora se puede CONTAR: cuanto dinero esta aprobado sin comprobar y
     * desde cuando. Sin la marca, un vale asi era indistinguible de uno cerrado con su
     * factura, y ese numero no se podia contestar.
     */
    provisional?: boolean; comprobante_esperado_at?: string }): Promise<{ id: string; status: string }> {
    this.tenantCtx.requireTenantId();
    const clasIn = (dto?.clasificacion || '').trim();
    if (clasIn && !EXPENSE_CLASIFICACIONES.includes(clasIn as ExpenseClasificacion)) {
      throw new BadRequestException('clasificación inválida');
    }
    const notaIn = (dto?.comprobacion_nota || '').trim();
    const prov = dto?.provisional === true;
    const esperado = String(dto?.comprobante_esperado_at || '').trim() || null;
    if (esperado && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(esperado)) {
      throw new BadRequestException('La fecha esperada va como YYYY-MM-DD.');
    }

    // Lee el estado actual + guardas FUERA de la trx pesada (la visión es I/O de segundos).
    const base = await this.tk.run(async (trx) => {
      const clasCol = await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'clasificacion');
      const cur: any = await trx('finance.expense_proofs').where({ id }).where('status', 'recibida')
        .first('folio_solicitud', 'files', trx.raw('importe::numeric AS importe'),
          ...(clasCol ? ['clasificacion', 'comprobacion_nota'] : []));
      return { cur, clasCol };
    });
    if (!base.cur) throw new BadRequestException('solicitud no encontrada o no está en estado por aprobar');

    const finalClas = clasIn || (base.clasCol ? base.cur.clasificacion : null);
    const files: any[] = typeof base.cur.files === 'string' ? JSON.parse(base.cur.files || '[]') : (base.cur.files || []);
    // `[GX.31]` Cualquiera de los DOS respaldos: la solicitud firmada de los expedientes
    // viejos, o la foto del vale autorizado de los nuevos. Exigir sólo el primero dejaba
    // sin aprobar todo lo que se levante desde GX.18 para adelante.
    const hasRequest = files.some((f) => tieneRespaldo(f));
    if (!hasRequest) throw new BadRequestException('no se puede aprobar sin el respaldo de la autorización (la solicitud firmada o la foto del vale autorizado)');

    const lleva = requiereEvidencia(finalClas);
    const motivo = notaIn || (base.clasCol ? (base.cur.comprobacion_nota || '') : '');
    if (!lleva && !motivo) throw new BadRequestException('un gasto no comprobable exige un motivo');
    const hasEvidence = files.some((f) => String(f?.role || '').startsWith('comprobante') && f?.url);

    // Estado destino:
    //   no comprobable            → validada (la aprobación ES la validación).
    //   comprobable SIN evidencia → aprobada (el capturista la sube luego).
    //   comprobable CON evidencia → validada. **La cierra quien firma**, que la está
    //     mirando en ese momento: es el camino "captura todo de una".
    //
    // `[GX.32]` Acá corría el cuadre por visión (Claude Vision leía la foto y comparaba
    // el monto) y de ahí salía `validada` o `revision`. Se retiró por pedido del usuario.
    // ⛔ Y con él se va el `validated_by: 'Claude Vision'`: **ninguna decisión sobre
    // dinero queda firmada por una máquina**. Cierra la persona que aprobó, con su nombre.
    let nextStatus: string;
    if (!lleva) {
      nextStatus = 'validada';
    } else if (!hasEvidence) {
      nextStatus = 'aprobada';
    } else {
      nextStatus = 'validada';
    }

    // `[GX.33]` La visión mira el comprobante y deja su leyenda para quien firma. NO toca
    // `nextStatus`: esa decisión ya está tomada arriba, por la persona.
    const aviso = hasEvidence ? await this.leerParaAvisar(files, Number(base.cur.importe) || 0) : null;

    return this.tk.run(async (trx) => {
      const cierra = nextStatus === 'validada';
      const [row] = await trx('finance.expense_proofs').where({ id }).where('status', 'recibida')
        .update({
          status: nextStatus, updated_at: trx.fn.now(),
          validated_by: cierra ? (actor || null) : null,
          validated_at: cierra ? trx.fn.now() : null,
          motivo_rechazo: null,
          // `[GX.33]` La leyenda de la visión, si tuvo algo que decir. `null` cuando el
          // comprobante cuadró — no se escribe «todo bien»: un aviso que siempre aparece
          // deja de leerse, y el silencio acá significa «la visión no objetó nada».
          revision_nota: aviso,
          ...(base.clasCol ? { clasificacion: finalClas || null, comprobacion_nota: !lleva ? motivo : null } : {}),
          // [GX.30] La marca y su fecha. Sin fecha la deuda no envejece y nadie la reclama
          // nunca: por eso, marcado como provisional y sin fecha, se pone a 15 dias.
          provisional: prov,
          comprobante_esperado_at: prov
            ? (esperado || trx.raw("(now() + interval '15 days')::date"))
            : null,
        })
        .returning(['id', 'status']);
      if (!row) throw new BadRequestException('solicitud no encontrada o no está en estado por aprobar');
      const [full] = await trx('finance.expense_proofs').where({ id })
        .select('folio_solicitud', 'status', 'solicitante', 'importe', 'sucursal', 'proveedor', 'created_by');
      if (full) this.emit(cierra ? 'validated' : 'captured', full, actor);
      // `[GX.26]` Se avisa cuando la decision CIERRA el vale. Aprobar un gasto comprobable
      // no lo cierra -- deja al capturista con algo mas que hacer (subir la evidencia), y ese
      // aviso es otro mensaje, no este. Avisar «aprobado» ahi diria que ya termino.
      if (full && cierra) this.avisarAlSolicitante('aprobado', full);
      this.logger.log(`solicitud de gasto folio ${base.cur.folio_solicitud} aprobada [${finalClas}] → ${nextStatus}, por ${actor || '?'}`);
      return row;
    });
  }

  /**
   * MOMENTO 3 — el capturista sube la EVIDENCIA de un gasto ya APROBADO y comprobable.
   * `[GX.32]` Queda en 'revision' — la mira una persona. El cuadre por visión se retiró.
   * Sólo aplica sobre 'aprobada' comprobable (no_comprobable ya cerró al aprobar).
   */
  async addEvidence(id: string, dto: CreateExpenseProofDto, actor?: string) {
    this.tenantCtx.requireTenantId();
    const nuevos = Array.isArray(dto.files) ? dto.files.filter((f) => f && f.url && f.role) : [];
    // [GX.14] Se reusa la MISMA compuerta de la captura, no una copia. Acá la forma de
    // pago ya se declaró al crear el expediente, así que sólo se juzga la evidencia — por
    // eso entra un `forma_pago` válido de relleno y el faltante de ese tipo se descarta.
    //
    // ⚠️ Sin esta puerta, la de `create()` sería decorativa: bastaba con esperar la
    // aprobación y subir por acá cualquier archivo.
    const faltanEv = faltaParaMandar({
      forma_pago: 'efectivo',
      forma_pago_detalle: 'n/a',
      archivos: nuevos,
      exige_evidencia: true,
    } satisfies EstadoAporte).filter((f) => f.id === 'evidencia' || f.id === 'evidencia_en_vivo');
    if (faltanEv.length) throw new BadRequestException(faltanEv.map((f) => f.motivo).join('; '));

    // Datos base + guardas FUERA de la trx pesada (la visión es I/O de segundos).
    const base = await this.tk.run(async (trx) => {
      const clasCol = await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'clasificacion');
      const cur: any = await trx('finance.expense_proofs').where({ id }).where('status', 'aprobada')
        .first('folio_solicitud', 'files', trx.raw('importe::numeric AS importe'), ...(clasCol ? ['clasificacion'] : []));
      return { cur, clasificacion: clasCol ? cur?.clasificacion : null };
    });
    if (!base.cur) throw new BadRequestException('el gasto no está aprobado y a la espera de evidencia');
    if (!requiereEvidencia(base.clasificacion)) {
      throw new BadRequestException('este gasto no lleva evidencia (no comprobable)');
    }
    const prev: any[] = typeof base.cur.files === 'string' ? JSON.parse(base.cur.files || '[]') : (base.cur.files || []);
    const files = [...prev, ...nuevos];
    const importe = Number(base.cur.importe) || Number(dto.importe) || 0;

    /**
     * `[GX.32]` **Acá la evidencia SIEMPRE pasa por un humano.**
     *
     * Antes la leía Claude Vision y, si el monto cuadraba, cerraba sola en `validada`.
     * Retirada la visión, cerrar sola dejaría que **quien gastó cierre su propio
     * expediente**: esta evidencia llega DESPUÉS de aprobar y nadie la miró todavía.
     *
     * Por eso queda en `revision`, que es el estado que la pantalla de Aprobación ya
     * sabe resolver con «Dar por comprobado». ⚠️ Cambia lo que ese estado SIGNIFICA:
     * era «el cuadre no dio» y pasa a ser «falta que alguien la mire». No se inventó un
     * sexto estado para lo mismo — las consultas y la bandeja ya lo listan.
     */
    const status = 'revision';
    // `[GX.33]` La leyenda base dice QUÉ falta hacer; si la visión objeta algo, se suma.
    // Las dos cosas caben en el mismo renglón porque quien revisa lee una sola línea.
    const aviso = await this.leerParaAvisar(nuevos, importe);
    const revisionNota = ['Evidencia subida por quien capturó — falta que alguien la revise', aviso]
      .filter(Boolean).join(' · ');

    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.expense_proofs').where({ id }).where('status', 'aprobada')
        .update({
          files: JSON.stringify(files),
          status,
          revision_nota: revisionNota,
          // Nadie la validó todavía: el expediente espera a una persona.
          validated_by: null,
          validated_at: null,
          // `[GX.34]` **Acá el vale cambia de manos.** Este es el camino que `created_by`
          // no cubría: el gasto se aprobó sin comprobante y lo sube alguien después —
          // puede no ser quien lo levantó, y hasta hoy esa persona no lo veía en ningún
          // lado. ⛔ `created_by` NO se toca: es el rastro de quién levantó el gasto.
          evidencia_por: actor || null,
          evidencia_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        })
        .returning(['id', 'folio_solicitud', 'status']);
      if (!row) throw new BadRequestException('el gasto no está aprobado y a la espera de evidencia');
      this.logger.log(`evidencia de gasto folio ${row.folio_solicitud} → ${status}, por ${actor || '?'}`);
      const [full] = await trx('finance.expense_proofs').where({ id })
        .select('folio_solicitud', 'status', 'solicitante', 'importe', 'sucursal');
      if (full) this.emit('captured', full, actor);
      return row;
    });
  }

  /** Bandeja + KPIs por estado. */
  /**
   * `[GX.39]` **Lo que Kepler dice de estos folios.** Una sola consulta para toda la pagina.
   *
   * ⛔ **No copia nada.** Lee la vista `analytics.expense_requests` (derive-no-copy sobre
   * `kepler_ods.kdm1`, fresca sin mantenimiento) en el momento. Materializar `aplicada` en
   * nuestra tabla seria una segunda forma del mismo dato — lo que GOTCHAS 32 prohibe.
   *
   * ⚠️ Devuelve `null` —no `false`— para el folio que no encuentra. La diferencia es toda la
   * fase: `false` afirma que Kepler NO lo aplico, `null` dice que no lo sabemos, y el
   * contrato traduce eso a `sin_medir` en vez de a `por_ejercer`.
   */
  private async keplerPorFolio(
    trx: Knex, filas: { folio_solicitud?: string | null; sucursal?: string | null }[],
  ): Promise<Map<string, { aplicada: boolean | null; estado: EstadoKepler | null }>> {
    const vacio = new Map<string, { aplicada: boolean | null; estado: EstadoKepler | null }>();
    const folios = [...new Set(filas.map((f) => String(f.folio_solicitud || '').trim()).filter(Boolean))];
    if (!folios.length) return vacio;

    // La vista no existe donde no hay ODS (una maquina sin replica). Ahi todo queda `sin_medir`,
    // que es la verdad: no hay con que medirlo.
    const reg = await trx.raw(`SELECT to_regclass('analytics.expense_requests') t`);
    if (!reg.rows[0]?.t) return vacio;

    const vistas: { folio: string; sucursal: string; aplicada: boolean | null; estado: string | null }[] =
      await trx('analytics.expense_requests')
        .where('tenant_id', this.tenantCtx.requireTenantId())
        .whereIn('folio', folios)
        .select('folio', 'sucursal', 'aplicada', 'estado');

    const porFolio = new Map<string, typeof vistas>();
    for (const v of vistas) {
      const k = String(v.folio).trim();
      if (!porFolio.has(k)) porFolio.set(k, []);
      (porFolio.get(k) as typeof vistas).push(v);
    }

    const out = vacio;
    for (const f of filas) {
      const folio = String(f.folio_solicitud || '').trim();
      const suc = String(f.sucursal || '').trim();
      const cands = porFolio.get(folio);
      if (!cands?.length) continue;
      /**
       * ⚠️ **373 folios viven en mas de una plaza.** Con la sucursal a mano se cruza exacto;
       * sin ella, si hay una sola candidata se usa, y si hay varias **no se elige ninguna**:
       * tomar una arbitraria diria «ejercido» leyendo el gasto de otra tienda.
       */
      const hit = suc ? cands.find((c) => String(c.sucursal).trim() === suc)
                      : (cands.length === 1 ? cands[0] : undefined);
      if (!hit) continue;
      out.set(this.claveKepler(folio, suc), {
        aplicada: hit.aplicada === null || hit.aplicada === undefined ? null : !!hit.aplicada,
        estado: (hit.estado || null) as EstadoKepler | null,
      });
    }
    return out;
  }

  private claveKepler(folio: string, sucursal?: string | null): string {
    return `${String(folio || '').trim()}|${String(sucursal || '').trim()}`;
  }

  /** Le pega la etapa a cada fila. Los tres campos viajan juntos: el chip, el texto y la clave. */
  private conEtapa<T extends { status?: string; folio_solicitud?: string | null; sucursal?: string | null }>(
    filas: T[], kepler: Map<string, { aplicada: boolean | null; estado: EstadoKepler | null }>,
  ): (T & { etapa: EtapaEjercicio; etapa_label: string; etapa_explicacion: string })[] {
    return filas.map((r) => {
      const k = kepler.get(this.claveKepler(String(r.folio_solicitud || ''), r.sucursal));
      const etapa = etapaDeEjercicio({
        status: String(r.status || ''),
        kepler_aplicada: k ? k.aplicada : null,
        kepler_estado: k ? k.estado : null,
      });
      return { ...r, etapa, etapa_label: ETIQUETA_ETAPA[etapa], etapa_explicacion: EXPLICACION_ETAPA[etapa] };
    });
  }

  async list(q: ListExpenseProofsQuery) {
    this.tenantCtx.requireTenantId();
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 200));
    return this.tk.run(async (trx) => {
      const b = trx('finance.expense_proofs')
        .select('id', 'solicitante', 'departamento', 'departamento_code', 'sucursal',
          'fecha_gasto', 'folio_solicitud', 'proveedor',
          trx.raw('importe::numeric AS importe'), trx.raw('monto_ocr::numeric AS monto_ocr'), 'monto_match', 'revision_nota',
          'files', 'comentarios', 'status',
          // `[GX.27]` La forma de pago viaja porque el visor del vale la muestra. Sin ella,
          // el visor diría «sin forma de pago» en un vale que SI la tiene -- que es afirmar
          // algo falso, no omitir un dato.
          // Lo mismo vale para la clasificacion: sin ella el visor decia «sin clasificar»
          // en un vale que SI estaba clasificado. Medido en pantalla.
          'forma_pago', 'forma_pago_detalle', 'clasificacion',
          'validated_by', 'validated_at', 'motivo_rechazo', 'created_by', 'created_at')
        .orderBy('created_at', 'desc').limit(limit);
      /**
       * `[GX.35]` **Los filtros, en UN solo lugar.** Antes vivían pegados al query de las
       * filas y los contadores se calculaban con `groupBy` sobre la tabla PELADA — sin
       * `mine`, sin la regla de los rechazos, sin nada. Medido en «Mis gastos» de
       * `demo_captura`: 21 vales propios y el encabezado decía **77 esperando firma, 30
       * aprobados, 16 devueltos** — los del tenant entero.
       *
       * ⛔ Es justo lo que el usuario pidió que no pasara («no deben aparecer los de
       * todos»), y es peor que una lista mal filtrada: la lista se ve y se puede contar,
       * el número grande de arriba se cree.
       *
       * Se aplica a los dos. Que se puedan separar otra vez cuesta borrar una llamada.
       */
      const filtros = (qb: Knex.QueryBuilder): Knex.QueryBuilder => {
        if (q.status) qb.where('status', q.status);
      // [GX.29] Un rechazo deja de verse a las 24 h. Se DERIVA de la hora del rechazo, no
      // de un flag: un flag necesita un proceso que lo prenda, y uno que falla en silencio
      // deja vales visibles creyendo que se ocultaron. ⚠️ Ocultar NO es borrar: la fila queda.
        qb.whereRaw(SQL_OCULTA_RECHAZOS_VIEJOS);
      // `[GX.27]` El día, como RANGO en hora de México -- no envolviendo la columna en
      // `to_char`, que anularía el índice de `created_at`.
        const dia = diaValido(q.dia);
        if (dia) {
          qb.whereRaw(`created_at >= (?::date)::timestamp AT TIME ZONE 'America/Mexico_City'`, [dia])
            .whereRaw(`created_at <  ((?::date) + interval '1 day')::timestamp AT TIME ZONE 'America/Mexico_City'`, [dia]);
        }
        if (q.folio_solicitud) qb.where('folio_solicitud', q.folio_solicitud.trim());
      // `[GX.34]` Es MÍO si lo levanté **o** si subí su evidencia. El `OR` no es una
      // concesión: sin la primera mitad, un vale aprobado que espera que YO suba su
      // comprobante desaparecería de mi lista justo cuando me toca actuar; sin la
      // segunda, el que sube la evidencia de un vale ajeno (o de uno capturado por link,
      // cuyo `created_by` es `link:NOMBRE` y no es un usuario) no lo ve en ningún lado.
        if (q.mine) qb.where((w: Knex.QueryBuilder) => w.where('created_by', q.mine).orWhere('evidencia_por', q.mine));
        if (q.from) qb.where('created_at', '>=', q.from);
        if (q.to) qb.where('created_at', '<=', `${q.to} 23:59:59`);
        if (q.search) {
          const s = `%${q.search.trim()}%`;
          qb.where((w: Knex.QueryBuilder) => w.whereILike('proveedor', s).orWhereILike('folio_solicitud', s).orWhereILike('solicitante', s));
        }
        return qb;
      };
      filtros(b);
      const crudas = await Promise.all((await b).map(async (r: FilaDeGasto) => ({
        ...r, importe: Number(r.importe), monto_ocr: r.monto_ocr == null ? null : Number(r.monto_ocr),
        files: await this.storage.signFiles(archivosDe(r.files)), // URL prefirmada (bucket privado)
      })));
      // `[GX.39]` La etapa de ejercicio, derivada en vivo de la vista. Una consulta por pagina.
      const rows = this.conEtapa(crudas, await this.keplerPorFolio(trx, crudas));

      const agg = await filtros(trx('finance.expense_proofs'))
        .groupBy('status').select('status', trx.raw('COUNT(*)::int AS n'));
      const by = Object.fromEntries(agg.map((r: Record<string, unknown>) => [String(r.status), Number(r.n)]));
      /**
       * ⚠️ `total` es el total que CUMPLE el filtro, no el largo de la página. Antes era
       * `rows.length`, o sea el `limit`: a quien tenía 340 gastos le decía «200».
       */
      const total = Object.values(by).reduce((a: number, n) => a + Number(n), 0);
      /**
       * `[GX.39]` Los contadores de ejercicio se cuentan **sobre las filas de la pagina**, no
       * con un `groupBy` propio, y por eso viajan aparte de `kpis`: la etapa no es una columna
       * de la tabla — sale de cruzar con Kepler, y cruzar los miles de folios del tenant para
       * pintar tres numeros costaria mas de lo que vale.
       *
       * ⚠️ Van declarados como lo que son (`de_la_pagina`), para que nadie los lea como el
       * total del universo. Es la trampa que GX.35 ya cobro una vez con estos mismos KPI.
       */
      const porEtapa: Record<string, number> = {};
      for (const r of rows) porEtapa[r.etapa] = (porEtapa[r.etapa] || 0) + 1;
      return {
        kpis: { total, recibidas: by['recibida'] || 0, validadas: by['validada'] || 0, rechazadas: by['rechazada'] || 0, en_revision: by['revision'] || 0 },
        etapas_de_la_pagina: porEtapa,
        rows,
      };
    });
  }

  /**
   * `[GX.27]` **El mes del historial**: cuántos levantamientos hubo cada día y cuánto sumaron.
   *
   * Es lo que dibuja el calendario. Devuelve **sólo los días con movimiento** — la rejilla
   * pinta los vacíos igual, y mandar 30 ceros por la red no agrega información.
   *
   * ⚠️ El corte del mes va en hora de **México**: un gasto levantado el 30 a las 20:00 de acá
   * ya es día 1 en UTC, y con el corte en UTC el total de octubre se comería el último día de
   * septiembre.
   *
   * ⚠️ `mine` NO es un filtro opcional de conveniencia: es el alcance. Cuando viene, la
   * consulta se acota a esa persona; cuando no, devuelve el de toda la empresa — y eso lo
   * decide el controller, que es quien sabe si hay god-mode.
   */
  async calendarioMes(mesPedido: string | undefined, opts: { mine?: string } = {}): Promise<CalendarioDelMes> {
    const tenantId = this.tenantCtx.requireTenantId();
    const pedido = mesPedido == null || String(mesPedido).trim() === '' ? null : String(mesPedido).trim();
    const mes = mesValido(pedido) ?? hoyMx().slice(0, 7);
    const { desde, hasta } = rangoDelMes(mes);

    return this.tk.run(async (trx) => {
      interface FilaCruda { dia: string; n: number; monto: string | number }
      const b = trx('finance.expense_proofs')
        .where({ tenant_id: tenantId })
        .whereRaw(`created_at >= (?::date)::timestamp AT TIME ZONE 'America/Mexico_City'`, [desde])
        .whereRaw(`created_at <  (?::date)::timestamp AT TIME ZONE 'America/Mexico_City'`, [hasta])
        .groupByRaw(`to_char(created_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD')`)
        .orderByRaw('1 ASC')
        .select(
          trx.raw(`to_char(created_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS dia`),
          trx.raw('COUNT(*)::int AS n'),
          trx.raw('COALESCE(SUM(importe), 0)::numeric AS monto'));
      // `[GX.34]` Mismo criterio que la lista: el calendario de «Míos» y «Mis gastos»
      // tienen que contar lo mismo, o el mes dice 6 y la lista muestra 8.
      if (opts.mine) b.where((w: Knex.QueryBuilder) => w.where('created_by', opts.mine).orWhere('evidencia_por', opts.mine));

      const filas: FilaCruda[] = await b;
      const dias: DiaDelCalendario[] = filas.map((f) => ({
        dia: f.dia,
        n: Number(f.n) || 0,
        monto: Math.round((Number(f.monto) || 0) * 100) / 100,
      }));

      return {
        mes,
        // No-null = el mes que pidieron era ilegible y se cayó al actual. La pantalla lo dice.
        mes_pedido: pedido != null && mesValido(pedido) == null ? pedido : null,
        dias,
        total: totalDelMes(dias),
        alcance: opts.mine ? 'mios' : 'todos',
      };
    });
  }

  /**
   * Una solicitud con sus adjuntos RE-FIRMADOS al momento de abrirla.
   *
   * La lista firma con TTL de 10 min. Quien revisa trabaja la bandeja un rato largo,
   * así que al abrir la fila 20 minutos después la URL ya venció y el archivo daba
   * error de firma — se veía como "no existe la imagen". Acá se firma de nuevo, y con
   * más aire (30 min) porque el visor queda abierto mientras se decide.
   */
  async detail(id: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const tieneCol = await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'tiene_comprobacion');
      const clasCol = await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'clasificacion');
      const r: any = await trx('finance.expense_proofs')
        .where({ id })
        .first(...(tieneCol ? ['tiene_comprobacion', 'comprobacion_nota'] : []),
          ...(clasCol ? ['clasificacion'] : []),
          'id', 'solicitante', 'departamento', 'departamento_code', 'sucursal',
          'fecha_gasto', 'folio_solicitud', 'proveedor',
          trx.raw('importe::numeric AS importe'), trx.raw('monto_ocr::numeric AS monto_ocr'), 'monto_match', 'revision_nota',
          'files', 'comentarios', 'status',
          'validated_by', 'validated_at', 'motivo_rechazo', 'created_by', 'created_at');
      if (!r) throw new NotFoundException('solicitud de reembolso no encontrada');
      const files = typeof r.files === 'string' ? JSON.parse(r.files || '[]') : (r.files || []);
      // `[GX.39]` La etapa de ejercicio + el documento que Kepler genera al aplicar el gasto.
      const [conEtapa] = this.conEtapa([r], await this.keplerPorFolio(trx, [r]));
      const gasto_kepler = await this.gastoEnKepler(trx, r.folio_solicitud, r.sucursal);
      /**
       * `[GX.40]` El candidato a factura. Se busca con los datos del GASTO de Kepler (que trae
       * el RFC), no con los del expediente nuestro: el proveedor que escribio el capturista es
       * texto libre y el importe del vale puede diferir del documento contable.
       */
      const cfdi_sugerido = gasto_kepler
        ? await this.cfdiCandidato(trx, gasto_kepler.rfc, gasto_kepler.importe, gasto_kepler.fecha)
        : null;
      return {
        ...conEtapa,
        importe: Number(r.importe),
        monto_ocr: r.monto_ocr == null ? null : Number(r.monto_ocr),
        requiere_evidencia: requiereEvidencia(clasCol ? r.clasificacion : null),
        files: await this.storage.signFiles(files, 1800),
        gasto_kepler,
        cfdi_sugerido,
        // El front no puede distinguir "no adjuntaron nada" de "hay archivo pero no lo
        // puedo servir" si sólo recibe una url rota. Se lo decimos explícito.
        storage_ok: this.storage.isConfigured(),
      };
    });
  }

  /**
   * `[GX.39]` **El documento que Kepler genera cuando aprueban el gasto.**
   *
   * Pedido del usuario: *«jalar esa factura o ese documento que genera y agregarlo al gasto
   * como un tipo de expediente»*. Medido el 2026-09-28 en prod: lo que Kepler genera es el
   * **gasto `X-A-10`**, que apunta a nuestra solicitud por `c39`. Existe en el 100% de los
   * casos aplicados (8,899 de 8,899 gastos vienen de una solicitud).
   *
   * ⛔ **No es el CFDI, y eso hay que decirlo en vez de dibujarlo.** Kepler **no guarda el
   * UUID fiscal** — verificado dos veces de forma independiente: en MAT.1 (2026-07-17,
   * `fiscal.cfdi_assignments`) y otra vez acá, barriendo toda la familia `kdfe33*`, que
   * timbra **solo ventas** (genero U) y no contiene **ni un** gasto `X-A-10` ni una solicitud
   * `X-A-15`. Ademas solo el **36% de los gastos trae RFC** (3,203 de 8,899), asi que ni
   * siquiera se podria buscar el comprobante del proveedor para los otros dos tercios. Lo que
   * se publica es lo que existe; el CFDI se declara como hueco, no se inventa.
   *
   * Sale de `analytics.expense_documents` — vista derive-no-copy, cero materializacion.
   */
  private async gastoEnKepler(
    trx: Knex, folio?: string | null, sucursal?: string | null,
  ): Promise<{
    doc_tipo: string; doc_folio: string; fecha: string | null; importe: number; iva: number;
    concepto: string | null; beneficiario: string | null; rfc: string | null; clase: string | null;
    cfdi_disponible: false; cfdi_motivo: string;
  } | null> {
    const f = String(folio || '').trim();
    if (!f) return null;
    const reg = await trx.raw(`SELECT to_regclass('analytics.expense_documents') t`);
    if (!reg.rows[0]?.t) return null;
    const suc = String(sucursal || '').trim();
    const d: Record<string, unknown> | undefined = await trx('analytics.expense_documents')
      .where('tenant_id', this.tenantCtx.requireTenantId())
      .where('solicitud_folio', f)
      // ⚠️ Misma trampa que en `lookupSolicitud`: sin la sucursal, `.first()` toma una fila
      // arbitraria entre las plazas que comparten el folio y se muestra el gasto de otra tienda.
      .modify((qb: Knex.QueryBuilder) => { if (suc) qb.where('sucursal', suc); })
      .orderBy('fecha', 'desc')
      .first('doc_tipo', 'doc_folio', 'concepto', 'beneficiario', 'rfc', 'clase',
        trx.raw(`to_char(fecha,'YYYY-MM-DD') AS fecha`),
        trx.raw('importe::numeric AS importe'), trx.raw('iva::numeric AS iva'));
    if (!d) return null;
    return {
      doc_tipo: String(d['doc_tipo']), doc_folio: String(d['doc_folio']),
      fecha: (d['fecha'] as string) ?? null,
      importe: Number(d['importe'] ?? 0), iva: Number(d['iva'] ?? 0),
      concepto: (d['concepto'] as string) ?? null, beneficiario: (d['beneficiario'] as string) ?? null,
      rfc: (d['rfc'] as string) ?? null, clase: (d['clase'] as string) ?? null,
      cfdi_disponible: false,
      cfdi_motivo: 'Kepler no guarda el UUID fiscal del gasto (verificado). El CFDI del proveedor, cuando existe, se casa aparte por RFC e importe.',
    };
  }

  /**
   * `[GX.41]` ⭐ **Los vales que Kepler le asigna a esta persona por la caja «Solicita».**
   *
   * Pedido textual: *«lo que vas a leer en ese campo es un username, el cual debera coincidir
   * con alguno de nuestros usuarios en suite (…) va a aparecer ese vale en la seccion de "Mis
   * Gastos" en el perfil del usuario que vinculaste»*.
   *
   * ## No crea nada: DERIVA
   * Estos vales **no tienen expediente nuestro todavia**. No se insertan filas en
   * `expense_proofs` para «reservarlos» — eso seria materializar un documento que ya vive en
   * Kepler, y ademas dejaria basura el dia que el vale se cancele alla. Se leen en vivo de
   * `analytics.expense_requests` (vista derive-no-copy) y se vuelven expediente **recien
   * cuando la persona les sube la evidencia**, por el camino normal (`create`).
   *
   * ## ⛔ El que YA capturo no se muestra dos veces
   * El `NOT EXISTS` cruza por **folio + sucursal**, no por folio solo: 373 folios viven en mas
   * de una plaza y excluir por folio pelado le escondería a alguien el vale de su tienda
   * porque otra ya lo capturo. Verificado en prod: los 9 expedientes que existen casan por el
   * par exacto.
   *
   * ## ⚠️ Lo que se deja afuera, con motivo
   * Los **cancelados** en Kepler (`estado = 'C'`). Un vale cancelado en la lista de «te toca
   * subir la evidencia» es ruido, y una lista con ruido ensena a ignorarla. Lo aplicado SI se
   * muestra: puede seguir necesitando su comprobante.
   */
  async valesAsignados(username?: string, limit = 50): Promise<ValeAsignado[]> {
    this.tenantCtx.requireTenantId();
    /**
     * ⚠️ El username, NO `full_name`. `created_by` guarda `full_name || username` porque es
     * lo que se le muestra a una persona; la caja de Kepler trae el **usuario**. Mezclarlos
     * haria que a quien tiene nombre completo cargado no le llegara ningun vale, en silencio.
     */
    const u = normalizarUsuarioKepler(username);
    if (u.length < LARGO_MINIMO_USUARIO) return [];

    return this.tk.run(async (trx) => {
      const reg = await trx.raw(`SELECT to_regclass('analytics.expense_requests') t`);
      if (!reg.rows[0]?.t) return [];

      const rows: Record<string, unknown>[] = await trx('analytics.expense_requests as r')
        .where('r.tenant_id', this.tenantCtx.requireTenantId())
        /**
         * La vista YA publica `solicitante` normalizado. Se vuelve a normalizar igual: asi la
         * igualdad no depende de una decision interna de la vista, que puede cambiar sin que
         * nadie toque este archivo. No cuesta un indice — sobre una vista de `kepler_ods` no
         * hay ninguno que perder.
         */
        .whereRaw(`upper(regexp_replace(btrim(r.solicitante),'\s+',' ','g')) = ?`, [u])
        .whereRaw(`coalesce(btrim(r.estado),'') <> 'C'`)
        .whereNotExists(function () {
          this.select(trx.raw('1')).from('finance.expense_proofs as p')
            .whereRaw('p.tenant_id = r.tenant_id')
            .whereRaw('p.folio_solicitud = r.folio')
            .whereRaw('p.sucursal = r.sucursal');
        })
        .orderBy('r.fecha', 'desc')
        .limit(Math.min(200, Math.max(1, Number(limit) || 50)))
        .select('r.sucursal', 'r.folio', 'r.solicitante', 'r.beneficiario', 'r.concepto',
          'r.estado', 'r.aplicada', trx.raw(`to_char(r.fecha,'YYYY-MM-DD') AS fecha`),
          trx.raw('r.importe::numeric AS importe'));

      return rows.map((r): ValeAsignado => ({
        sucursal: String(r['sucursal'] ?? ''),
        folio: String(r['folio'] ?? ''),
        fecha: (r['fecha'] as string) ?? null,
        importe: Number(r['importe'] ?? 0),
        solicita: (r['solicitante'] as string) ?? null,
        // El destinatario sale del MISMO vale de Kepler, como pidio el usuario.
        destinatario: (r['beneficiario'] as string) ?? null,
        concepto: (r['concepto'] as string) ?? null,
        estado: (r['estado'] as string) ?? null,
        aplicada: r['aplicada'] === null || r['aplicada'] === undefined ? null : !!r['aplicada'],
        vinculado_por: 'solicita',
      }));
    });
  }

  /**
   * `[GX.40]` **El CFDI del gasto: SUGERENCIA, nunca hecho.**
   *
   * Pedido del usuario: *«jalar esa factura o ese documento que genera y agregarlo al gasto
   * como un tipo de expediente»*. Se puede — pero no desde Kepler, y no para todos. Medido el
   * 2026-09-29 en prod, y estos numeros son el contrato de esta funcion:
   *
   * ```
   *   de 8,899 gastos X-A-10
   *     3,203 (36.0%)  traen RFC del beneficiario
   *     2,163 (24.3%)  el emisor esta en fiscal.cfdis
   *     1,596 (17.9%)  hay un CFDI con el mismo importe (±$1)
   *       880 ( 9.9%)  ...y fecha dentro de 5 dias
   *       743 ( 8.4%)  UN SOLO candidato: sin ambiguedad
   * ```
   *
   * ⛔ **Kepler no guarda el UUID fiscal** — barrido el 2026-09-29: las 200 columnas de
   * `kdm1` para `X-A-15` dan **37 con dato y ninguna con UUID**; `kdm2` tiene **0 lineas**
   * para estos documentos; la familia `kdfe33*` timbra **solo ventas** (genero U). Ya estaba
   * verificado en MAT.1 (2026-07-17). Asi que el enlace es **heuristico** y por eso se
   * devuelve como candidato con su motivo, no como dato del expediente (ADR-016: el motor
   * sugiere, la persona confirma).
   *
   * ⚠️ **Con mas de un candidato NO se elige.** Elegir el primero seria pegarle al gasto la
   * factura equivocada del proveedor correcto — un error que se ve bien y nadie audita.
   *
   * ⚠️ Y el «documento» son **datos, no un archivo**: de 168,245 CFDIs, **0 tienen PDF** y
   * 1,015 XML (0.6%). Lo que se adjunta es el UUID + serie/folio + emisor + total.
   */
  private async cfdiCandidato(
    trx: Knex, rfc?: string | null, importe?: number | null, fecha?: string | null,
  ): Promise<{
    estado: 'unico' | 'ambiguo' | 'sin_candidato' | 'sin_rfc' | 'sin_fuente';
    motivo: string;
    cfdi: { uuid: string; serie: string | null; folio: string | null; emisor: string | null;
            total: number; fecha: string | null; estatus_sat: string | null; tiene_xml: boolean } | null;
    otros: number;
  }> {
    const nada = (estado: 'sin_rfc' | 'sin_fuente' | 'sin_candidato', motivo: string) =>
      ({ estado, motivo, cfdi: null, otros: 0 });

    const r = String(rfc || '').trim().toUpperCase();
    // ⚠️ Sin RFC no se busca por nombre: dos proveedores distintos se llaman parecido y el
    // 64% de los gastos no lo trae. Se DECLARA el motivo en vez de devolver vacio a secas.
    if (!r) return nada('sin_rfc', 'El gasto no trae el RFC del proveedor (lo trae el 36% en Kepler), asi que no hay por donde buscar su factura.');
    if (!Number(importe) || !fecha) return nada('sin_rfc', 'Falta el importe o la fecha del gasto para poder cuadrar una factura.');

    const reg = await trx.raw(`SELECT to_regclass('fiscal.cfdis') t`);
    if (!reg.rows[0]?.t) return nada('sin_fuente', 'No hay CFDI cargados en esta base.');

    const cands: Record<string, unknown>[] = await trx('fiscal.cfdis')
      .where('tenant_id', this.tenantCtx.requireTenantId())
      .whereRaw('upper(emisor_rfc) = ?', [r])
      .whereRaw('abs(total - ?::numeric) <= 1', [Number(importe)])
      .whereRaw(`abs(fecha::date - ?::date) <= 5`, [fecha])
      .orderByRaw(`abs(fecha::date - ?::date) ASC`, [fecha])
      .limit(5)
      .select('uuid', 'serie', 'folio', 'emisor_nombre', 'estatus_sat',
        trx.raw('total::numeric AS total'), trx.raw(`to_char(fecha,'YYYY-MM-DD') AS fecha`),
        trx.raw('(xml IS NOT NULL) AS tiene_xml'));

    if (!cands.length) {
      return nada('sin_candidato', 'Ninguna factura de ese proveedor cuadra con el importe y la fecha del gasto.');
    }
    const c = cands[0];
    const uno = {
      uuid: String(c['uuid']), serie: (c['serie'] as string) ?? null, folio: (c['folio'] as string) ?? null,
      emisor: (c['emisor_nombre'] as string) ?? null, total: Number(c['total'] ?? 0),
      fecha: (c['fecha'] as string) ?? null, estatus_sat: (c['estatus_sat'] as string) ?? null,
      tiene_xml: !!c['tiene_xml'],
    };
    if (cands.length > 1) {
      // ⛔ Se devuelve el mas cercano en fecha pero MARCADO como ambiguo, para que la pantalla
      // lo muestre como «hay N que cuadran» y no como la factura del gasto.
      return { estado: 'ambiguo', otros: cands.length - 1, cfdi: uno,
        motivo: `Hay ${cands.length} facturas de ese proveedor que cuadran. Ninguna se da por buena sin que alguien la confirme.` };
    }
    return { estado: 'unico', otros: 0, cfdi: uno,
      motivo: 'Una sola factura de ese proveedor cuadra en importe y fecha. Falta que alguien la confirme.' };
  }

  /**
   * `[GX.14]` El ALCANCE de quien pregunta: ¿ve todo, o sólo lo suyo?
   *
   * Estaba escrito adentro de `searchSolicitudes`. Lo saqué porque el resumen necesita
   * exactamente el mismo recorte, y copiarlo habría dejado dos alcances que se separan
   * — justo el defecto que ADR-056 mide. Las `claves` son los nombres normalizados
   * (áreas asignadas + el propio) contra los que se compara `expense_requests.solicitante`.
   *
   * PÚBLICO desde `[GX.15]`: lo consume también `ExpedienteGastoService`, porque el recorte
   * por áreas es la regla que decide quién abre el gasto ajeno y dos copias se separan.
   *
   * `veTodo=false` y `claves=[]` NO significa «todo»: significa que quien llama tiene que
   * exigir folio exacto o devolver vacío. Cada llamador lo decide y lo dice.
   */
  async alcanceDelUsuario(
    trx: any,
    user?: { sub?: string; role_name?: string; permissions?: Record<string, boolean> },
  ): Promise<{ veTodo: boolean; claves: string[] }> {
    const veTodo = isPlatformAdminRole(user?.role_name) || user?.permissions?.[Permission.FINANCE_EXPENSES_VER_ALL] === true;
    const claves: string[] = [];
    if (!veTodo && user?.sub) {
      const u = await trx('users').where({ id: user.sub }).first('nombre', 'finance_expense_area_ids');
      const norm = (v: any) => String(v ?? '').trim().replace(/\s+/g, ' ').toUpperCase() || null;
      const ids: string[] = Array.isArray(u?.finance_expense_area_ids) ? u.finance_expense_area_ids.filter(Boolean) : [];
      const areas = ids.length ? (await trx('finance.expense_areas').whereIn('id', ids).pluck('norm_key')).map(norm).filter(Boolean) : [];
      const n = norm(u?.nombre);
      for (const k of [...areas, ...(n ? [n] : [])]) if (k && claves.indexOf(k) === -1) claves.push(k);
    }
    return { veTodo, claves };
  }

  /**
   * Busca la SOLICITUD (XA1501) contra la que se va a subir el comprobante.
   *
   * Antes el capturista buscaba el GASTO (XA1001) y su captura caía en otra tabla, en
   * paralelo al tablero. Una sola llave: la solicitud.
   *
   * El folio se resuelve por VALOR NUMÉRICO, no por sufijo: el capturista teclea los
   * últimos dígitos ("23", "8489") y eso casa con `0000023` / `0008489`. Hacerlo con
   * `right(folio,4)` funcionaría hoy y empezaría a devolver el documento equivocado en
   * cuanto el consecutivo del CEDIS pase de 9,999 — va en 8,489.
   *
   * Alcance: con áreas asignadas se busca dentro de ellas. SIN áreas (hoy: los 113
   * usuarios) no se devuelve el catálogo entero ni se bloquea todo — se exige folio
   * EXACTO. Así el capturista sube lo que le dieron sin poder pasear por el gasto ajeno.
   */
  async searchSolicitudes(term: string, limit = 20, user?: { sub?: string; role_name?: string; permissions?: Record<string, boolean> }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const q = String(term || '').trim();
    // Un solo digito vale si es numero: la igualdad de folio es exacta y no genera ruido.
    // Para texto si se piden 2, porque ahi es LIKE.
    if (!q.length || (q.length < 2 && !/^[0-9]+$/.test(q))) return [];
    const lim = Math.min(50, Math.max(1, Number(limit) || 20));
    return this.tk.run(async (trx) => {
      const { veTodo, claves } = await this.alcanceDelUsuario(trx, user);
      const cols = await trx.raw(`SELECT 1 FROM information_schema.columns
        WHERE table_schema='analytics' AND table_name='expense_requests' AND column_name='acreedor'`);
      const conAcreedor = (cols.rows || []).length > 0;
      const soloNumeros = /^\d+$/.test(q);
      const b = trx('analytics.expense_requests as r').where('r.tenant_id', tenantId).where('r.estado', '<>', 'C');
      // [GX.14] El monto también busca — pero SÓLO dentro del alcance.
      // El folio numérico se permite sin áreas a propósito («subí lo que te dieron»); abrir
      // el monto con la misma manga dejaría pescar el gasto ajeno tecleando cifras hasta
      // que caiga algo. Por eso el monto cuelga de `veTodo || claves.length` y el folio no.
      const montoBuscable = (veTodo || claves.length > 0) && Number(q) > 0;
    /**
     * `[GX.18]` **Sólo las solicitudes de HOY.** Pedido del usuario: el levantamiento se hace
     * el mismo día, así que una solicitud vieja en el desplegable es ruido — y peor, invita a
     * capturar contra el folio equivocado cuando dos se parecen.
     *
     * El día es el de México, no el del servidor: `fecha` es un `date` de Kepler y a las 19:00
     * de Morelia ya es el día siguiente en UTC. Con `current_date` pelado, media tarde de
     * trabajo desaparecería del buscador.
     */
    b.andWhereRaw("r.fecha = (now() AT TIME ZONE 'America/Mexico_City')::date");
      if (soloNumeros) {
        // Igualdad numérica: '23' encuentra '0000023' y nada más.
        b.andWhere((w: any) => {
          w.whereRaw("NULLIF(regexp_replace(r.folio,'[^0-9]','','g'),'')::bigint = ?", [Number(q)]);
          /**
           * `[GX.17]` **Y las coincidencias PARCIALES, para quien ya puede ver su cartera.**
           *
           * Con sólo la igualdad, teclear `9843` devuelve como mucho UNA fila —la del folio
           * `0009843`— y para cualquier otra cosa el desplegable sale vacío. Reportado tal
           * cual: «al buscarlo quiero que desglose los que coincidan». El texto de ayuda
           * («con los últimos dígitos basta») describía el relleno con ceros, no una búsqueda
           * parcial: `199` no encontraba `0071199`, y eso se lee como que el buscador no anda.
           *
           * ⛔ Cuelga de `veTodo || claves.length` A PROPÓSITO. La igualdad exacta se permite
           * SIN áreas asignadas («subí lo que te dieron») justamente porque no deja pescar:
           * hay que saber el folio. Abrir el parcial con esa misma manga dejaría teclear `1`
           * y enumerar el gasto ajeno. Quien no tiene áreas sigue con la igualdad de antes.
           */
          if (veTodo || claves.length) w.orWhereILike('r.folio', `%${q}%`);
          if (montoBuscable) w.orWhereRaw('round(r.importe::numeric) = ?', [Math.round(Number(q))]);
        });
      } else if (veTodo || claves.length) {
        // [GX.14] Antes sólo beneficiario. Se suman CONCEPTO y CUENTA porque es como la
        // gente busca de verdad («maniobras», «GG014»), y los dos campos ya viajan en el
        // SELECT de abajo — mostrarlos y no dejar buscarlos era el defecto.
        b.andWhere((w: any) => {
          w.whereILike('r.beneficiario', `%${q}%`);
          if (conAcreedor) w.orWhereILike('r.acreedor', `%${q}%`);
          w.orWhereILike('r.concepto', `%${q}%`);
          w.orWhereILike('r.cuenta_clave', `%${q}%`);
        });
      } else {
        return []; // sin áreas y sin folio: no se pasea el gasto ajeno
      }
      if (!veTodo && claves.length) {
        b.whereRaw("upper(regexp_replace(btrim(r.solicitante),'\\s+',' ','g')) = ANY(?::text[])", [claves]);
      }
      const rows = await b
        .orderBy('r.fecha', 'desc').limit(lim)
        /**
         * [GX.21] Se suman las columnas que la vista YA calculaba y nadie pedia: el RFC,
         * el IVA, quien autoriza, la referencia y la cuenta contable. Son para la vista
         * previa del alta -- «todos los datos que se jalan de Kepler».
         *
         * No cuesta una consulta mas: `analytics.expense_requests` las trae en la misma
         * fila. Lo que costaba era NO traerlas: la pantalla mostraba cinco campos de una
         * solicitud que tiene quince, y nadie podia comprobar que fuera la correcta.
         */
        .select('r.folio', 'r.sucursal', 'r.fecha', 'r.solicitante', 'r.concepto', 'r.estado', 'r.aplicada',
          'r.rfc', 'r.autoriza', 'r.referencia', 'r.cuenta_clave', 'r.usuario', 'r.forma_pago',
          trx.raw('r.importe::numeric AS importe'), trx.raw('r.iva::numeric AS iva'),
          trx.raw(conAcreedor ? 'COALESCE(r.acreedor, r.beneficiario) AS beneficiario' : 'r.beneficiario AS beneficiario'));
      return rows.map((r: any) => ({ ...r, importe: Number(r.importe) || 0 }));
    });
  }

  /**
   * `[GX.14]` **Resumen de lo que ESTA persona pidió.** Lo que en el tablero de Finanzas
   * es la vista de toda la empresa, acá es la de quien gasta: cuánto pidió, en qué quedó,
   * a quién, y — el dato que justifica la fase — cuántas veces declaró cómo lo pagó.
   *
   * Sale de `analytics.expense_requests` (la vista viva sobre Kepler), no de los
   * expedientes: lo que hay que resumir es **lo que pidió**, exista expediente o no.
   *
   * ⚠️ **Alcance.** Se recorta con la MISMA regla que la búsqueda (`alcanceDelUsuario`).
   * Quien no tiene áreas asignadas ni nombre que casar **no recibe ceros**: recibe
   * `medido: false` con el motivo. Un cero aquí se leería como «no pediste nada», que es
   * una afirmación distinta de «no puedo saberlo» (ADR-056).
   */
  async resumenDelSolicitante(
    periodo: '12m' | 'mes',
    user?: { sub?: string; role_name?: string; permissions?: Record<string, boolean> },
  ) {
    const tenantId = this.tenantCtx.requireTenantId();
    const meses = periodo === 'mes' ? 0 : 12;
    return this.tk.run(async (trx) => {
      const { veTodo, claves } = await this.alcanceDelUsuario(trx, user);
      const vacio = {
        periodo, medido: false as const,
        motivo: 'no hay cómo saber cuáles solicitudes son tuyas: tu usuario no tiene áreas de gasto asignadas ni un nombre que case con el solicitante de Kepler',
        totales: null, por_mes: [], por_estado: [], top_beneficiarios: [], forma_pago: null, evidencia: null,
      };
      if (!veTodo && claves.length === 0) return vacio;

      // Base común: el periodo y el recorte por solicitante. `estado <> 'C'` NO se aplica
      // acá: una cancelada también es algo que pediste, y el desglose la muestra aparte.
      const base = () => {
        const b = trx('analytics.expense_requests as r').where('r.tenant_id', tenantId);
        if (periodo === 'mes') b.whereRaw("r.fecha >= date_trunc('month', current_date)");
        else b.whereRaw(`r.fecha >= current_date - interval '${meses} months'`);
        b.whereRaw('r.fecha <= current_date');
        if (!veTodo) b.whereRaw("upper(regexp_replace(btrim(r.solicitante),'\s+',' ','g')) = ANY(?::text[])", [claves]);
        return b;
      };

      const [tot] = await base().select(
        trx.raw('COUNT(*)::int AS n'),
        trx.raw('COALESCE(SUM(r.importe),0)::numeric AS monto'),
        trx.raw('AVG(NULLIF(r.importe,0))::numeric AS promedio'),
        trx.raw('MAX(r.importe)::numeric AS mayor'),
        // El hallazgo: cuántas de sus propias solicitudes traen `forma_pago` en Kepler.
        trx.raw("COUNT(*) FILTER (WHERE NULLIF(btrim(r.forma_pago),'') IS NOT NULL)::int AS con_forma_pago"),
      );

      // Siempre 7 meses de barras, aunque el periodo sea el mes: la tendencia es lo que
      // se lee de un vistazo, y recortarla a una sola barra no dice nada.
      const porMes = await trx('analytics.expense_requests as r')
        .where('r.tenant_id', tenantId)
        .whereRaw("r.fecha >= date_trunc('month', current_date) - interval '6 months'")
        .whereRaw('r.fecha <= current_date')
        .modify((b: any) => { if (!veTodo) b.whereRaw("upper(regexp_replace(btrim(r.solicitante),'\s+',' ','g')) = ANY(?::text[])", [claves]); })
        .groupByRaw("to_char(r.fecha,'YYYY-MM')")
        .orderByRaw("to_char(r.fecha,'YYYY-MM')")
        .select(trx.raw("to_char(r.fecha,'YYYY-MM') AS mes"), trx.raw('COUNT(*)::int AS n'), trx.raw('COALESCE(SUM(r.importe),0)::numeric AS monto'));

      const porEstado = await base().groupBy('r.estado').orderByRaw('SUM(r.importe) DESC NULLS LAST')
        .select('r.estado', trx.raw('COUNT(*)::int AS n'), trx.raw('COALESCE(SUM(r.importe),0)::numeric AS monto'));

      const topBenef = await base().whereRaw("NULLIF(btrim(r.beneficiario),'') IS NOT NULL")
        .groupBy('r.beneficiario').orderByRaw('SUM(r.importe) DESC NULLS LAST').limit(6)
        .select('r.beneficiario', trx.raw('COUNT(*)::int AS n'), trx.raw('COALESCE(SUM(r.importe),0)::numeric AS monto'));

      // Evidencia: cuántos de SUS folios ya tienen expediente en la Suite. Se cruza por el
      // par (sucursal, folio) — el folio solo NO identifica: es único por sucursal (GX.11).
      const [ev] = await base()
        .leftJoin('finance.expense_proofs as p', function (this: any) {
          this.on('p.folio_solicitud', '=', 'r.folio').andOn('p.sucursal', '=', 'r.sucursal');
        })
        .select(trx.raw('COUNT(DISTINCT (r.sucursal, r.folio))::int AS total'),
                trx.raw('COUNT(DISTINCT (r.sucursal, r.folio)) FILTER (WHERE p.id IS NOT NULL)::int AS con_expediente'));

      const ESTADO_LABEL: Record<string, string> = {
        F: 'Aplicada — el dinero salió', A: 'Autorizada, sin ejercer', N: 'Por ejercer', C: 'Cancelada',
      };
      const num = (v: any) => (v == null ? null : Number(v));
      const mesActual = new Date().toISOString().slice(0, 7);

      return {
        periodo, medido: true as const, motivo: null,
        alcance: veTodo ? 'todo' : `${claves.length} clave(s) de solicitante`,
        totales: {
          n: Number(tot?.n) || 0,
          monto: Number(tot?.monto) || 0,
          // NULL, no 0: sin solicitudes no hay promedio ni máximo que publicar.
          promedio: num(tot?.promedio),
          mayor: num(tot?.mayor),
        },
        por_mes: porMes.map((m: any) => ({ mes: m.mes, n: Number(m.n), monto: Number(m.monto), en_curso: m.mes === mesActual })),
        por_estado: porEstado.map((e: any) => ({ estado: e.estado, label: ESTADO_LABEL[e.estado] || e.estado, n: Number(e.n), monto: Number(e.monto) })),
        top_beneficiarios: topBenef.map((b: any) => ({ beneficiario: b.beneficiario, n: Number(b.n), monto: Number(b.monto) })),
        // Los dos huecos que la fase existe para cerrar, con su denominador a la vista.
        forma_pago: { declarada: Number(tot?.con_forma_pago) || 0, total: Number(tot?.n) || 0 },
        evidencia: { con_expediente: Number(ev?.con_expediente) || 0, total: Number(ev?.total) || 0 },
      };
    });
  }

  /**
   * `[GX.17]` **Lo que espera luz verde**, agrupado por fecha y por departamento.
   *
   * Alimenta la pantalla de Aprobación. Devuelve los expedientes en `recibida` — el estado
   * en el que `create()` los deja — enriquecidos con el área de la solicitud de Kepler,
   * porque el `departamento` que capturó la persona muchas veces es una plaza (`Sucursal
   * 00`) y no un departamento.
   *
   * ⚠️ El cruce con la solicitud va por `(sucursal, folio)`, nunca por folio solo: en
   * Kepler el folio es único por plaza (GX.11, donde ya costó: 373 folios viven en más de
   * una). Y va en un SEGUNDO viaje, no en un JOIN: `expense_requests` es una vista sobre el
   * ODS y unirla contra una tabla nuestra es lo que la Fase GX.15 midió pasarse de 90 s.
   */
  async porAprobar(limit = 500): Promise<RespuestaPorAprobar> {
    const tenantId = this.tenantCtx.requireTenantId();
    const lim = Math.min(2000, Math.max(1, Number(limit) || 500));

    return this.tk.run(async (trx) => {
      // La forma que devuelve el SELECT de abajo. Tipada a mano y no con `any`: el gate
      // del boundary lo prohíbe, y con razón — `any` acá dejaría pasar un campo renombrado
      // sin que nada se queje hasta que la pantalla muestre `undefined`.
      interface FilaCruda {
        id: string; folio_solicitud: string; sucursal: string | null;
        fecha_gasto: string | null; created_dia: string; created_at: string | Date;
        departamento: string | null; proveedor: string | null; clasificacion: string | null;
        forma_pago: string | null; forma_pago_detalle: string | null;
        files: string | ProofFile[] | null; comentarios: string | null;
        created_by: string | null; importe: string | number;
      }
      const filas: FilaCruda[] = await trx('finance.expense_proofs')
        .where({ tenant_id: tenantId, status: 'recibida' })
        .orderBy('created_at', 'desc')
        .limit(lim)
        // ⚠️ `to_char` y NO la columna cruda. `pg` devuelve `date`/`timestamptz` como objeto
        // `Date`, y `String(fecha).slice(0,10)` sobre eso da **«Thu Sep 24»** — no una fecha, y
        // con el día corrido por zona horaria (un `2026-09-15` UTC se lee 14 en MX). Es la misma
        // trampa que la Fase LC.16 pagó en el respaldo, el CSV y el orden de un TXT entregado.
        // En la lista de selección `to_char` es gratis; lo que anula un índice es envolverla en
        // el WHERE.
        .select('id', 'folio_solicitud', 'sucursal', 'departamento',
          'proveedor', 'clasificacion', 'forma_pago', 'forma_pago_detalle', 'files', 'comentarios',
          'created_by', trx.raw('importe::numeric AS importe'),
          trx.raw(`to_char(fecha_gasto, 'YYYY-MM-DD') AS fecha_gasto`),
          trx.raw(`to_char(created_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS created_dia`),
          trx.raw('created_at'));

      if (!filas.length) {
        return { total: 0, monto_total: 0, por_fecha: [], por_departamento: [], filas: [] };
      }

      // Segundo viaje: el area de la solicitud, por (sucursal, folio).
      const porSucursal = new Map<string, Set<string>>();
      for (const f of filas) {
        const suc = String(f.sucursal ?? '');
        // ⚠️ Hay expedientes SIN folio: son las «capturas sin folio» (alguien subió el
        // comprobante antes de que existiera la solicitud en Kepler). Sin este filtro se
        // pediría `folio = 'null'` al ODS — una consulta que nunca casa y que ensucia el
        // universo. Quedan igual en la bandeja: lo que no tienen es área.
        const folio = f.folio_solicitud ? String(f.folio_solicitud).trim() : '';
        if (!suc || !folio) continue;
        if (!porSucursal.has(suc)) porSucursal.set(suc, new Set());
        porSucursal.get(suc)!.add(folio);
      }
      /** Lo que se necesita de la solicitud de Kepler: el área y el concepto. */
      interface SolicitudMinima { sucursal: string; folio: string; solicitante: string | null; concepto: string | null; estado: string | null }
      const sol = new Map<string, SolicitudMinima>();
      for (const [suc, folios] of porSucursal) {
        if (!suc) continue; // sin sucursal no hay llave: se queda sin area, y se declara
        const rows = await trx('analytics.expense_requests')
          .where({ tenant_id: tenantId, sucursal: suc })
          .whereRaw('folio = ANY(?::text[])', [[...folios]])
          .select('sucursal', 'folio', 'solicitante', 'concepto', 'estado');
        for (const r of rows) sol.set(`${r.sucursal}|${r.folio}`, r);
      }

      const pendientes: ExpedientePendiente[] = filas.map((f) => {
        const arch: ProofFile[] = typeof f.files === 'string' ? JSON.parse(f.files || '[]') : (f.files ?? []);
        const s = sol.get(`${f.sucursal}|${f.folio_solicitud}`);
        return {
          id: f.id,
          folio_solicitud: f.folio_solicitud,
          sucursal: f.sucursal,
          fecha_gasto: f.fecha_gasto ?? null,
          // Ya viene como `YYYY-MM-DD` desde la DB, en hora de México.
          created_at: f.created_dia,
          importe: Number(f.importe) || 0,
          departamento: f.departamento,
          solicitante: s?.solicitante ?? null,
          proveedor: f.proveedor,
          clasificacion: f.clasificacion,
          forma_pago: f.forma_pago ?? null,
          // [GX.14] Que exista una foto no basta: lo que distingue es el sello de camara.
          evidencia_en_vivo: arch.some((a) => String(a?.role ?? '').startsWith('comprobante') && a?.live === true),
        };
      });

      const agrupado = agruparParaAprobacion(pendientes);
      // Las filas van firmadas: quien aprueba tiene que poder ABRIR la foto, no solo contarla.
      const detalladas = await Promise.all(filas.map(async (f, i) => ({
        ...pendientes[i],
        concepto: sol.get(`${f.sucursal}|${f.folio_solicitud}`)?.concepto ?? null,
        forma_pago_detalle: f.forma_pago_detalle ?? null,
        comentarios: f.comentarios ?? null,
        created_by: f.created_by ?? null,
        // Se tipa ANTES de firmar: `signFiles` es generico y preserva lo que recibe, asi
        // que un `JSON.parse` sin tipo le haria perder `role` y `live` en el camino.
        files: await this.storage.signFiles(
          (typeof f.files === 'string' ? JSON.parse(f.files || '[]') : (f.files ?? [])) as ProofFile[], 1800),
      })));

      return { ...agrupado, filas: detalladas };
    });
  }

  /**
   * `[GX.20]` **El dia del gasto.** Todo lo que se levanto un dia, partido en las tres
   * pestanas de la pantalla de Aprobacion: *Aprobar*, *Ejercer* y *Todos*.
   *
   * ## (!) El dia es el de CAPTURA, y el de Mexico
   * "Los levantamientos que se hicieron al dia" habla de cuando se **levanto** el
   * expediente (`created_at`), no de cuando ocurrio el gasto (`fecha_gasto`) -- que puede
   * ser de la semana pasada y que cada renglon muestra aparte, justo porque no coinciden.
   *
   * El corte se hace contra el dia de **Mexico**: a las 20:00 de aca ya es el dia siguiente
   * en UTC, y un gasto levantado de noche no apareceria en "hoy".
   *
   * (X) El filtro va como **rango de timestamps**, no envolviendo la columna en `to_char`:
   * envolverla anula el indice de `created_at` y obliga a leer la tabla entera. Es la otra
   * mitad de la trampa de `porAprobar` -- ahi `to_char` es gratis porque esta en la lista
   * de seleccion, aca seria carisimo porque estaria en el `WHERE`.
   *
   * ## (X) Acotar por dia NO puede esconder lo que espera firma
   * Una pantalla que solo mire "hoy" haria desaparecer el expediente que nadie aprobo
   * anteayer. Por eso la respuesta trae `pendientes_fuera_del_dia` con lo que quedo afuera
   * del rango, y la pantalla lo dice con su monto. El dia filtra lo que se LEE, nunca lo
   * que existe.
   *
   * (!) El rail de dias que acompanaba a este numero se retiro de la pantalla, y con el la
   * consulta que lo alimentaba: un payload que nadie lee es una consulta que nadie paga.
   */
  async delDia(fecha?: string, limit = 500): Promise<RespuestaDelDia> {
    const tenantId = this.tenantCtx.requireTenantId();
    const lim = Math.min(2000, Math.max(1, Number(limit) || 500));
    const hoy = hoyMx();
    // Una fecha ilegible NO se convierte en "hoy" en silencio: se declara en `fecha_pedida`
    // para que la pantalla pueda decir que el parametro venia roto.
    const pedida = fecha == null || String(fecha).trim() === '' ? null : String(fecha).trim();
    const dia = diaValido(pedida) ?? hoy;

    return this.tk.run(async (trx) => {
      interface FilaCruda {
        id: string; folio_solicitud: string | null; sucursal: string | null;
        fecha_gasto: string | null; created_dia: string; created_hora: string;
        departamento: string | null; proveedor: string | null; clasificacion: string | null;
        forma_pago: string | null; forma_pago_detalle: string | null;
        files: string | ProofFile[] | null; comentarios: string | null;
        created_by: string | null; importe: string | number; status: string;
        motivo_rechazo: string | null; revision_nota: string | null;
        validated_by: string | null; validated_at: string | Date | null;
      }

      // El dia de Mexico como rango de timestamps: [00:00, 00:00 del siguiente).
      const desde = trx.raw(`(?::date)::timestamp AT TIME ZONE 'America/Mexico_City'`, [dia]);
      const hasta = trx.raw(`((?::date) + interval '1 day')::timestamp AT TIME ZONE 'America/Mexico_City'`, [dia]);

      const filas: FilaCruda[] = await trx('finance.expense_proofs')
        .where({ tenant_id: tenantId })
        .where('created_at', '>=', desde)
        .where('created_at', '<', hasta)
        .orderBy('created_at', 'desc')
        .limit(lim)
        .select('id', 'folio_solicitud', 'sucursal', 'departamento', 'proveedor', 'clasificacion',
          'forma_pago', 'forma_pago_detalle', 'files', 'comentarios', 'created_by', 'status',
          'motivo_rechazo', 'revision_nota', 'validated_by', 'validated_at',
          trx.raw('importe::numeric AS importe'),
          trx.raw(`to_char(fecha_gasto, 'YYYY-MM-DD') AS fecha_gasto`),
          trx.raw(`to_char(created_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS created_dia`),
          trx.raw(`to_char(created_at AT TIME ZONE 'America/Mexico_City', 'HH24:MI') AS created_hora`));

      // Lo que espera firma y NO cayo en el dia que se mira. Sin este numero, un expediente
      // parado hace un mes no existe en ninguna pantalla.
      const [fuera] = await trx('finance.expense_proofs')
        .where({ tenant_id: tenantId, status: 'recibida' })
        .where((w) => w.where('created_at', '<', desde).orWhere('created_at', '>=', hasta))
        .select(trx.raw('COUNT(*)::int AS n'), trx.raw('COALESCE(SUM(importe), 0)::numeric AS monto'));

      const particion = particionarDelDia(filas.map((f) => ({
        id: f.id, status: f.status, importe: Number(f.importe) || 0,
      })));

      const base = {
        ...particion,
        fecha: dia,
        es_hoy: dia === hoy,
        hoy,
        // No-null = la fecha pedida era ilegible y se cayo a hoy. La pantalla lo dice.
        fecha_pedida: pedida != null && diaValido(pedida) == null ? pedida : null,
        pendientes_fuera_del_dia: {
          n: Number(fuera?.n) || 0,
          monto: Math.round((Number(fuera?.monto) || 0) * 100) / 100,
        },
      };

      if (!filas.length) {
        return { ...base, filas: [], entrada: { total: 0, monto_total: 0, por_fecha: [], por_departamento: [] } };
      }

      // Segundo viaje: el area y el concepto de la solicitud de Kepler, por (sucursal, folio).
      // Mismo criterio que `porAprobar`: sin folio no hay llave, y no se inventa.
      const porSucursal = new Map<string, Set<string>>();
      for (const f of filas) {
        const suc = String(f.sucursal ?? '');
        const folio = f.folio_solicitud ? String(f.folio_solicitud).trim() : '';
        if (!suc || !folio) continue;
        if (!porSucursal.has(suc)) porSucursal.set(suc, new Set());
        porSucursal.get(suc)!.add(folio);
      }
      interface SolicitudMinima { sucursal: string; folio: string; solicitante: string | null; concepto: string | null }
      const sol = new Map<string, SolicitudMinima>();
      for (const [suc, folios] of porSucursal) {
        if (!suc) continue;
        const rows = await trx('analytics.expense_requests')
          .where({ tenant_id: tenantId, sucursal: suc })
          .whereRaw('folio = ANY(?::text[])', [[...folios]])
          .select('sucursal', 'folio', 'solicitante', 'concepto');
        for (const r of rows) sol.set(`${r.sucursal}|${r.folio}`, r);
      }

      const detalladas: ExpedienteDelDiaDetallado[] = await Promise.all(filas.map(async (f) => {
        const arch: ProofFile[] = typeof f.files === 'string' ? JSON.parse(f.files || '[]') : (f.files ?? []);
        const s = sol.get(`${f.sucursal}|${f.folio_solicitud}`);
        const clasificacion = f.clasificacion ?? null;
        return {
          id: f.id,
          folio_solicitud: f.folio_solicitud ?? '',
          sucursal: f.sucursal,
          fecha_gasto: f.fecha_gasto ?? null,
          created_at: f.created_dia,
          created_hora: f.created_hora,
          importe: Number(f.importe) || 0,
          departamento: f.departamento,
          solicitante: s?.solicitante ?? null,
          concepto: s?.concepto ?? null,
          proveedor: f.proveedor,
          clasificacion,
          forma_pago: f.forma_pago ?? null,
          forma_pago_detalle: f.forma_pago_detalle ?? null,
          comentarios: f.comentarios ?? null,
          created_by: f.created_by ?? null,
          status: f.status,
          etapa: etapaDe(f.status),
          motivo_rechazo: f.motivo_rechazo ?? null,
          revision_nota: f.revision_nota ?? null,
          validated_by: f.validated_by ?? null,
          validated_at: f.validated_at == null ? null : String(f.validated_at),
          requiere_evidencia: requiereEvidencia(clasificacion),
          // Lo que decide si "Ejercer" ya tiene con que cerrarse. Que exista un comprobante
          // de la captura no alcanza: la evidencia del gasto es otro rol de archivo.
          tiene_evidencia: arch.some((a) => String(a?.role ?? '').startsWith('evidencia') && !!a?.url),
          evidencia_en_vivo: arch.some((a) => String(a?.role ?? '').startsWith('comprobante') && a?.live === true),
          files: await this.storage.signFiles(arch, 1800),
        };
      }));

      // Los grupos por departamento de la bandeja de entrada. Quien autoriza no revisa
      // renglones sueltos: revisa "lo de Logistica". Se reusa el agrupador de GX.17.
      const entrada = agruparParaAprobacion(
        detalladas.filter((d) => d.etapa === 'entrada').map((d) => ({
          id: d.id, folio_solicitud: d.folio_solicitud, sucursal: d.sucursal,
          fecha_gasto: d.fecha_gasto, created_at: d.created_at, importe: d.importe,
          departamento: d.departamento, solicitante: d.solicitante, proveedor: d.proveedor,
          clasificacion: d.clasificacion, forma_pago: d.forma_pago,
          evidencia_en_vivo: d.evidencia_en_vivo,
        })));

      return { ...base, filas: detalladas, entrada };
    });
  }

  /**
   * (C) Mapa folio_solicitud → EXPEDIENTE, para el tablero de /finanzas/gastos.
   *
   * Devuelve el id (para poder resolver desde donde se ve), el estado, y qué documentos
   * hay. Sin los documentos el tablero no puede separar «falta el comprobante» de «falta
   * la solicitud firmada» de «falta la comprobación», que para quien aprueba son tres
   * pendientes distintos con tres acciones distintas.
   */
  async statusByFolio(): Promise<Record<string, ProofByFolio>> {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const tieneCol = await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'tiene_comprobacion');
      const clasCol = await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'clasificacion');
      const rows = await trx
        .with('ranked', (qb: any) => {
          qb.from('finance.expense_proofs')
            // GX.9 — desde que el folio es NULLable, los expedientes capturados por link y
            // todavía SIN CASAR caerían todos en la misma partición `null` y `rn=1` elegiría
            // uno arbitrario entre ellos, que además entraría al mapa bajo la clave `null`.
            // El mapa es folio→expediente: lo que no tiene folio no le pertenece.
            .whereNotNull('folio_solicitud')
            .select('id', 'folio_solicitud', 'sucursal', 'status', 'files',
              ...(tieneCol ? ['tiene_comprobacion', 'comprobacion_nota'] : []),
              ...(clasCol ? ['clasificacion'] : []),
              // Particiona por el par, no por el folio: el folio se repite entre sucursales
              // y `rn=1` elegiría el expediente de otra plaza. Ver `proofKey`.
              trx.raw('row_number() OVER (PARTITION BY sucursal, folio_solicitud ORDER BY created_at DESC) AS rn'));
        })
        .from('ranked').where('rn', 1).select('*');
      return Object.fromEntries(rows.map((r: any) => {
        // La clave del mapa es `sucursal|folio` — ver `proofKey`.
        const files: any[] = typeof r.files === 'string' ? JSON.parse(r.files || '[]') : (r.files || []);
        const rol = (p: string) => files.some((f) => String(f?.role || '').startsWith(p) && f?.url);
        const clasificacion = clasCol ? (r.clasificacion || null) : null;
        return [proofKey(r.sucursal, r.folio_solicitud), {
          id: r.id,
          status: r.status,
          comprobante: rol('comprobante'),
          solicitud: rol('solicitud_kepler'),
          clasificacion,
          requiere_evidencia: requiereEvidencia(clasificacion),
          tiene_comprobacion: tieneCol ? r.tiene_comprobacion : null,
          comprobacion_nota: tieneCol ? (r.comprobacion_nota || null) : null,
        }];
      }));
    });
  }

  /**
   * Estado del expediente de UN folio, para la vista del capturista (que puede no tener
   * FINANCE_EXPENSES_VER, y por eso no puede pedir el mapa completo). Devuelve el último
   * expediente del folio o null. Con esto la captura sabe en qué momento está: sin
   * expediente → capturar solicitud; 'aprobada' comprobable → subir evidencia; 'recibida'
   * → esperando aprobación; cerrada → nada que hacer.
   */
  async proofByFolio(folio: string, sucursal?: string): Promise<ProofByFolio | null> {
    this.tenantCtx.requireTenantId();
    const f = String(folio || '').trim();
    if (!f) return null;
    return this.tk.run(async (trx) => {
      const clasCol = await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'clasificacion');
      const tieneCol = await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'tiene_comprobacion');
      const suc = String(sucursal || '').trim();
      const r: any = await trx('finance.expense_proofs')
        .where('folio_solicitud', f)
        // Sin sucursal se cae a la vieja búsqueda ambigua (373 folios viven en más de una
        // plaza). Se acepta por compatibilidad —el capturista puede teclear sólo el folio—
        // pero quien la llame con la sucursal a mano DEBE pasarla.
        .modify((qb: any) => { if (suc) qb.where('sucursal', suc); })
        .orderBy('created_at', 'desc')
        .first('id', 'status', 'files',
          ...(tieneCol ? ['tiene_comprobacion', 'comprobacion_nota'] : []),
          ...(clasCol ? ['clasificacion'] : []));
      if (!r) return null;
      const files: any[] = typeof r.files === 'string' ? JSON.parse(r.files || '[]') : (r.files || []);
      const rol = (p: string) => files.some((x) => String(x?.role || '').startsWith(p) && x?.url);
      const clasificacion = clasCol ? (r.clasificacion || null) : null;
      return {
        id: r.id, status: r.status,
        comprobante: rol('comprobante'), solicitud: rol('solicitud_kepler'),
        clasificacion, requiere_evidencia: requiereEvidencia(clasificacion),
        tiene_comprobacion: tieneCol ? r.tiene_comprobacion : null,
        comprobacion_nota: tieneCol ? (r.comprobacion_nota || null) : null,
      };
    });
  }

  /**
   * La solicitud tal como la subieron a Kepler. Es la fuente de verdad de los datos de
   * cabecera; el formulario solo aporta la evidencia. Devuelve null si el feed todavía no
   * la trajo — en ese caso el DTO tiene que traer los datos.
   */
  private async lookupSolicitud(folio: string, sucursal?: string) {
    const suc = String(sucursal || '').trim();
    return this.tk.run(async (trx) =>
      trx('analytics.expense_requests')
        .where({ tenant_id: this.tenantCtx.requireTenantId(), folio })
        // ⚠️ De acá salen el IMPORTE y el solicitante contra los que se cuadra. Sin la
        // sucursal, `.first()` toma una fila arbitraria entre las plazas que comparten el
        // folio y el cuadre corre contra el dinero de otra tienda.
        .modify((qb: any) => { if (suc) qb.where('sucursal', suc); })
        .first('solicitante', 'beneficiario', 'sucursal', 'concepto',
          trx.raw(`to_char(fecha,'YYYY-MM-DD') AS fecha`), trx.raw('importe::numeric AS importe')),
    ) as Promise<{ solicitante?: string; beneficiario?: string; sucursal?: string; concepto?: string; fecha?: string; importe?: number } | undefined>;
  }

  /**
   * El aprobador valida el expediente. Puede RECLASIFICAR el gasto (si el capturista se
   * equivocó de naturaleza): al hacerlo se re-aplica la regla de evidencia. No se puede
   * validar un gasto comprobable sin su evidencia, ni cerrar un no_comprobable sin motivo.
   */
  async validate(id: string, actor?: string, dto?: { clasificacion?: string; comprobacion_nota?: string }) {
    this.tenantCtx.requireTenantId();
    const clasIn = (dto?.clasificacion || '').trim();
    if (clasIn && !EXPENSE_CLASIFICACIONES.includes(clasIn as ExpenseClasificacion)) {
      throw new BadRequestException('clasificación inválida');
    }
    const notaIn = (dto?.comprobacion_nota || '').trim();
    return this.tk.run(async (trx) => {
      const clasCol = await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'clasificacion');
      const cur: any = await trx('finance.expense_proofs').where({ id }).whereIn('status', ['aprobada', 'rechazada', 'revision'])
        .first('folio_solicitud', 'files', ...(clasCol ? ['clasificacion', 'comprobacion_nota'] : []));
      if (!cur) throw new BadRequestException('solicitud no encontrada o ya validada');

      const finalClas = clasIn || (clasCol ? cur.clasificacion : null);
      const files: any[] = typeof cur.files === 'string' ? JSON.parse(cur.files || '[]') : (cur.files || []);
      // `[GX.31]` El respaldo es obligatorio SIEMPRE (los 3 tipos): el gate del que cierra
      // debe ser el mismo que el de la captura, o un expediente sin respaldo se colaría
      // por API. Vale cualquiera de los dos — ver `tieneRespaldo`.
      const hasRequest = files.some((f) => tieneRespaldo(f));
      if (!hasRequest) {
        throw new BadRequestException('no se puede validar sin el respaldo de la autorización (la solicitud firmada o la foto del vale autorizado)');
      }
      const hasEvidence = files.some((f) => String(f?.role || '').startsWith('comprobante') && f?.url);
      if (requiereEvidencia(finalClas) && !hasEvidence) {
        throw new BadRequestException('no se puede validar un gasto comprobable sin su evidencia adjunta');
      }
      const motivo = notaIn || (clasCol ? (cur.comprobacion_nota || '') : '');
      if (finalClas === 'no_comprobable' && !motivo) {
        throw new BadRequestException('un gasto no comprobable exige un motivo');
      }

      const [row] = await trx('finance.expense_proofs').where({ id }).whereIn('status', ['aprobada', 'rechazada', 'revision'])
        .update({
          status: 'validada', validated_by: actor || null, validated_at: trx.fn.now(),
          motivo_rechazo: null, revision_nota: null, updated_at: trx.fn.now(),
          // Sonda: sin la migración de clasificación se valida igual, sin perder la acción.
          ...(clasCol ? { clasificacion: finalClas || null, comprobacion_nota: finalClas === 'no_comprobable' ? motivo : null } : {}),
        })
        .returning(['id', 'status']);
      if (!row) throw new BadRequestException('solicitud no encontrada o ya validada');
      const [full] = await trx('finance.expense_proofs').where({ id })
        .select('folio_solicitud', 'status', 'solicitante', 'importe', 'sucursal', 'proveedor', 'created_by');
      if (full) this.emit('validated', full, actor);
      // `[GX.26]` Y el camino de vuelta: a quien levanto el gasto, a su campana.
      if (full) this.avisarAlSolicitante('aprobado', full);
      return row;
    });
  }

  /** Rechaza (con motivo). */
  async reject(id: string, actor?: string, motivo?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.expense_proofs').where({ id }).whereIn('status', ['recibida', 'aprobada', 'validada', 'revision'])
        .update({ status: 'rechazada', validated_by: actor || null, validated_at: trx.fn.now(), motivo_rechazo: (motivo || '').trim() || 'rechazada', updated_at: trx.fn.now() })
        .returning(['id', 'status']);
      if (!row) throw new BadRequestException('solicitud no encontrada o ya rechazada');
      const [full] = await trx('finance.expense_proofs').where({ id })
        .select('folio_solicitud', 'status', 'solicitante', 'importe', 'sucursal', 'proveedor', 'created_by', 'motivo_rechazo');
      if (full) this.emit('rejected', full, actor);
      // `[GX.26]` El rechazo SIEMPRE viaja con su motivo: un «te lo rechazaron» sin por que
      // obliga a la persona a ir a preguntar, que es justo lo que el aviso deberia evitar.
      if (full) this.avisarAlSolicitante('rechazado', full);
      return row;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GX.9 — Capturas SIN FOLIO (llegadas por link) y su casamiento
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Los expedientes capturados en campo que todavía no se ligaron a su solicitud XA1501.
   * No aparecen en el tablero de `/finanzas/gastos` por construcción: ese tablero se
   * arma desde las filas de Kepler, y éstos todavía no tienen una.
   */
  async sinFolio(q?: { search?: string; limit?: number }) {
    this.tenantCtx.requireTenantId();
    const limit = Math.min(500, Math.max(1, Number(q?.limit) || 200));
    return this.tk.run(async (trx) => {
      const base = () => {
        const b = trx('finance.expense_proofs as p').whereNull('p.folio_solicitud');
        const s = (q?.search || '').trim();
        if (s) {
          b.andWhere((w: any) => w
            .whereILike('p.proveedor', `%${s}%`)
            .orWhereILike('p.solicitante', `%${s}%`)
            .orWhereILike('p.comentarios', `%${s}%`));
        }
        return b;
      };

      const k: any = await base().first(
        trx.raw('COUNT(*)::int AS total'),
        trx.raw('COALESCE(SUM(p.importe),0)::numeric AS importe'),
        trx.raw(`COUNT(*) FILTER (WHERE p.origen='link')::int AS por_link`),
        trx.raw(`COUNT(*) FILTER (WHERE p.monto_match IS FALSE)::int AS no_cuadran`),
      );

      const rows = await base()
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', 'p.tenant_id').andOn('w.code', 'p.sucursal');
        })
        .orderBy('p.created_at', 'desc').limit(limit)
        .select('p.id', 'p.solicitante', 'p.sucursal', 'w.name as sucursal_nombre', 'p.proveedor',
          'p.comentarios', 'p.clasificacion', 'p.status', 'p.origen', 'p.files',
          'p.monto_match', 'p.revision_nota', 'p.created_at', 'p.capture_meta',
          trx.raw('p.importe::numeric AS importe'),
          trx.raw('p.monto_ocr::numeric AS monto_ocr'),
          trx.raw(`to_char(p.fecha_gasto,'YYYY-MM-DD') AS fecha_gasto`));

      return {
        kpis: {
          total: Number(k?.total || 0),
          importe: Number(k?.importe || 0),
          por_link: Number(k?.por_link || 0),
          no_cuadran: Number(k?.no_cuadran || 0),
        },
        rows: rows.map((r: any) => {
          const files: any[] = typeof r.files === 'string' ? JSON.parse(r.files || '[]') : (r.files || []);
          const meta = typeof r.capture_meta === 'string' ? JSON.parse(r.capture_meta || '{}') : (r.capture_meta || {});
          return {
            ...r, files: undefined, capture_meta: undefined,
            importe: Number(r.importe) || 0,
            monto_ocr: r.monto_ocr == null ? null : Number(r.monto_ocr),
            fotos: files.length,
            // `[GX.31]` Antes `tiene_solicitud`, y miraba SÓLO la solicitud firmada: desde
            // GX.18 la foto del vale autoriza igual, así que el chip que colgaba de esto
            // marcaba «sin firmada» a expedientes perfectamente aprobables.
            tiene_respaldo: files.some((f) => tieneRespaldo(f)),
            camara: meta.camera ?? null,
            captured_at: meta.captured_at ?? null,
          };
        }),
      };
    });
  }

  /**
   * Casa una captura de campo con su solicitud de Kepler. Es un UPDATE sobre el MISMO
   * expediente — no se mueve la fila a otro lado: siempre fue el mismo expediente, sólo que
   * hasta ahora no sabíamos a qué folio pertenecía.
   *
   * Al casar pasan dos cosas que importan:
   *   1. El importe pasa a ser el de **Kepler** (la fuente de verdad). El que declaró quien
   *      capturó se guarda en `capture_meta.importe_declarado` — si no coinciden, eso es
   *      justamente lo que hay que ver, y borrarlo sería perder la evidencia.
   *   2. Se recorre el cuadre por visión contra ese importe real. El cuadre de la captura
   *      era contra lo declarado, que es lo único que había sin folio.
   *
   * No cambia el `status`: sigue esperando aprobación como cualquier expediente capturado.
   */
  async match(id: string, folio: string, actor?: string) {
    this.tenantCtx.requireTenantId();
    const f = String(folio || '').trim();
    if (!f) throw new BadRequestException('folio requerido');

    const cur: any = await this.tk.run(async (trx) =>
      trx('finance.expense_proofs').where({ id }).whereNull('folio_solicitud')
        .first('id', 'files', 'clasificacion', 'capture_meta', 'sucursal', trx.raw('importe::numeric AS importe')));
    if (!cur) throw new BadRequestException('esta captura no existe o ya fue casada');

    // La sucursal sale de la captura: el trabajador la declaró al subir. Sin ella, el folio
    // podría resolver a la solicitud de otra plaza.
    const sol = await this.lookupSolicitud(f, cur.sucursal);
    if (!sol) throw new BadRequestException(`la solicitud ${f} no aparece en Kepler${cur.sucursal ? ` para la sucursal ${cur.sucursal}` : ''}`);

    const declarado = Number(cur.importe) || 0;
    const real = Number(sol.importe) || 0;
    const files: ProofFile[] = typeof cur.files === 'string' ? JSON.parse(cur.files || '[]') : (cur.files || []);

    // `[GX.32]` Acá corría el cuadre por visión contra el importe de Kepler. Se retiró con
    // el resto. ⚠️ La brecha entre lo declarado y lo que dice Kepler NO se pierde: se sigue
    // guardando en `capture_meta.importe_declarado` y sale en el log de abajo, que es lo que
    // de verdad importaba de este cuadre — el número de la foto era el intermediario.
    const nota = requiereEvidencia(cur.clasificacion) && files.length
      ? 'Casada sin cuadre automático — falta que alguien revise la evidencia'
      : null;

    return this.tk.run(async (trx) => {
      const meta = typeof cur.capture_meta === 'string' ? JSON.parse(cur.capture_meta || '{}') : (cur.capture_meta || {});
      const [row] = await trx('finance.expense_proofs').where({ id }).whereNull('folio_solicitud')
        .update({
          folio_solicitud: f,
          importe: real || declarado,
          solicitante: trx.raw('COALESCE(NULLIF(?, \'\'), solicitante)', [sol.solicitante || '']),
          fecha_gasto: sol.fecha || trx.raw('fecha_gasto'),
          revision_nota: nota,
          capture_meta: JSON.stringify({
            ...meta,
            importe_declarado: declarado,
            casado_por: actor || null,
            casado_at: new Date().toISOString(),
          }),
          updated_at: trx.fn.now(),
        })
        .returning(['id', 'folio_solicitud', 'status']);
      if (!row) throw new BadRequestException('esta captura no existe o ya fue casada');

      const brecha = real && Math.abs(real - declarado) > 0.5
        ? ` · declaró ${declarado} y Kepler dice ${real}` : '';
      this.logger.log(`captura ${id} casada con ${f} por ${actor || '?'}${brecha}`);
      const [full] = await trx('finance.expense_proofs').where({ id })
        .select('folio_solicitud', 'status', 'solicitante', 'importe', 'sucursal');
      if (full) this.emit('captured', full, actor);
      return { ...row, importe_declarado: declarado, importe_kepler: real };
    });
  }
}
