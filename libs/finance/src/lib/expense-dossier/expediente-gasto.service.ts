import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService, ObjectStorageService } from '@megadulces/platform-core';
import { ExpenseProofsService } from '../expense-proofs/expense-proofs.service';

/**
 * `[GX.15]` — **El expediente del gasto: los cuatro eslabones en un solo lugar.**
 *
 * Hoy la historia de un gasto vive repartida y hay que cruzar tres pantallas para armarla:
 *
 * | # | Eslabón | Dónde vive | De quién es |
 * |---|---|---|---|
 * | 1 | La solicitud `XA1501` | `analytics.expense_requests` (vista viva sobre Kepler) | Kepler |
 * | 2 | El expediente (forma de pago + fotos) | `finance.expense_proofs` | nuestro |
 * | 3 | El gasto aplicado `XA1001` | `analytics.expense_documents` | Kepler |
 * | 4 | La comprobación | `finance.expense_comprobaciones` | nuestro |
 *
 * La asociación **ya existía en Kepler y es limpia**: medido en prod el 2026-09-24, los
 * **9,073 gastos aplicados traen el folio de su solicitud en `c39` — el 100%**. No hubo
 * que decodificar nada ni inventar una tabla puente.
 *
 * ## ⚠️ Un gasto NO es uno solo — y por eso `gastos` es una lista
 * La tentación es modelar solicitud → gasto como 1:1, porque el 96% lo es. Medido:
 * **8,705 solicitudes tienen 1 gasto, 165 tienen 2, 10 tienen 3 y 2 tienen 4.** Con un
 * `1:1` esas **177** mostrarían un gasto arbitrario (el que devolviera el motor primero) y
 * esconderían el resto sin un solo error en el log. El `aplicada` booleano de
 * `expense_requests` tampoco miente, pero tampoco lo cuenta: es un `EXISTS`.
 *
 * ## ⚠️ Se consulta SIEMPRE por folio, nunca de corrido
 * Cruzar las dos vistas sobre toda la historia **no termina**: la medición del 2026-09-24
 * pasó de 5 minutos sin devolver (son vistas sobre el ODS, sin índices propios). Acotado a
 * un `(sucursal, folio)` la misma cadena resuelve en **287 ms**. Por eso acá no hay ningún
 * método que liste expedientes «de todos»: lo que lista es la bandeja existente, y esto
 * arma UNO.
 *
 * ## ⚠️ El folio no identifica nada por sí solo
 * En Kepler el folio es único **por sucursal**. La llave de todo este archivo es el par
 * `(sucursal, folio)`, igual que en `proofKey()` (GX.11, donde ya costó: 373 folios viven
 * en más de una plaza). Y ojo: el folio del gasto (`0008602`) **no es** el de su solicitud
 * (`0009678`) — son series distintas.
 */

/** En qué punto del trámite está el gasto. Se deriva, no se guarda. */
export type EtapaExpediente =
  | 'sin_solicitud'
  | 'por_autorizar'
  | 'autorizada_sin_gasto'
  | 'gastada_sin_comprobar'
  | 'comprobada_sin_validar'
  | 'cerrada'
  | 'cancelada';

export const ETAPA_LABEL: Record<EtapaExpediente, string> = {
  sin_solicitud: 'No hay solicitud con ese folio',
  por_autorizar: 'Por autorizar en Kepler',
  autorizada_sin_gasto: 'Autorizada — el gasto todavía no se aplica',
  gastada_sin_comprobar: 'Gastada — falta la comprobación',
  comprobada_sin_validar: 'Comprobada — falta que Finanzas la valide',
  cerrada: 'Cerrada',
  cancelada: 'Cancelada en Kepler',
};

export interface ExpedienteGasto {
  sucursal: string;
  folio_solicitud: string;
  solicitud: Record<string, unknown> | null;
  expediente: Record<string, unknown> | null;
  gastos: Record<string, unknown>[];
  comprobaciones: Record<string, unknown>[];
  tramite: { etapa: EtapaExpediente; label: string; falta: string[] };
  /** Cuándo se armó. Un expediente es una foto, y la foto lleva su hora. */
  generado_at: string;
}

/** Lo que la derivación de etapa necesita saber. Nada de knex: se prueba sin base. */
export interface EntradaEtapa {
  /** Estado en Kepler: F aplicada · A autorizada · N por ejercer · C cancelada. */
  estado?: string | null;
  expediente?: { forma_pago?: string | null; files?: { role?: string }[] } | null;
  gastos: unknown[];
  comprobaciones: { status?: string | null }[];
  sumaGastos: number;
  solImporte: number;
}

/** Tolerancia del cuadre: $1 o 1% (la misma que ya usan proofs y comprobaciones). */
export function cuadraImporte(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1, Math.abs(a) * 0.01);
}

/**
 * En qué punto está el trámite, y qué falta. **Función pura**: es la regla que decide qué
 * se le dice a la persona, y se prueba sin levantar una base.
 *
 * ⚠️ El ORDEN de las preguntas importa. `cancelada` va primero porque una solicitud
 * cancelada CON gasto aplicado existe — 116 medidas en prod — y decirle a alguien «falta
 * comprobar» de algo que se canceló lo manda a perseguir un trámite que no existe.
 */
export function derivarEtapa(e: EntradaEtapa): { etapa: EtapaExpediente; label: string; falta: string[] } {
  const falta: string[] = [];
  const gastos = e.gastos || [];
  const comps = e.comprobaciones || [];
  const etapa: EtapaExpediente = (() => {
    if (e.estado === 'C') return 'cancelada';
    if (!gastos.length) return e.estado === 'A' || e.estado === 'F' ? 'autorizada_sin_gasto' : 'por_autorizar';
    if (!comps.length) return 'gastada_sin_comprobar';
    if (comps.some((c) => c?.status === 'validada')) return 'cerrada';
    return 'comprobada_sin_validar';
  })();

  if (!e.expediente) falta.push('el expediente propio: la forma de pago y la foto del comprobante');
  else {
    if (!e.expediente.forma_pago) falta.push('cómo se pagó (el expediente es anterior a que se pidiera)');
    if (!(e.expediente.files || []).some((f) => String(f?.role || '').startsWith('comprobante'))) {
      falta.push('la foto del comprobante en el expediente');
    }
  }
  if (etapa === 'gastada_sin_comprobar') falta.push('la comprobación del gasto');
  if (etapa === 'comprobada_sin_validar') falta.push('que Finanzas valide la comprobación');
  // El descuadre se DECLARA, no se corrige solo: con varios gastos la pregunta es la SUMA.
  if (gastos.length && !cuadraImporte(e.sumaGastos, e.solImporte)) {
    falta.push(`lo aplicado (${e.sumaGastos.toFixed(2)}) no cuadra con lo solicitado (${e.solImporte.toFixed(2)})`);
  }
  return { etapa, label: ETAPA_LABEL[etapa], falta };
}

@Injectable()
export class ExpedienteGastoService {
  private readonly logger = new Logger(ExpedienteGastoService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly storage: ObjectStorageService,
    /**
     * Sólo por `alcanceDelUsuario()`. Se INYECTA en vez de copiarse: el recorte por áreas
     * es la regla que decide quién puede ver el gasto ajeno, y dos copias de eso se
     * separan como cualquier otra.
     */
    private readonly proofs: ExpenseProofsService,
  ) {}

  private parseFiles(v: unknown): { url?: string; public_id?: string; role?: string; live?: boolean; captured_at?: string }[] {
    return typeof v === 'string' ? JSON.parse((v as string) || '[]') : ((v as any[]) || []);
  }

  /** Delega en la función pura: un solo cuadre, no dos. */
  private cuadra(a: number, b: number): boolean {
    return cuadraImporte(a, b);
  }

  /**
   * El expediente completo de una solicitud.
   *
   * `user` acota: quien no tiene alcance sobre el área del gasto no lo abre. Se resuelve
   * con el MISMO `alcanceDelUsuario` que la búsqueda — si esa regla cambia, cambia acá.
   */
  async expediente(
    sucursal: string,
    folio: string,
    user?: { sub?: string; role_name?: string; permissions?: Record<string, boolean> },
  ): Promise<ExpedienteGasto> {
    const tenantId = this.tenantCtx.requireTenantId();
    const suc = String(sucursal || '').trim();
    const fol = String(folio || '').trim();
    if (!suc || !fol) throw new NotFoundException('hace falta la sucursal y el folio de la solicitud');

    return this.tk.run(async (trx) => {
      const { veTodo, claves } = await this.proofs.alcanceDelUsuario(trx, user);

      // ── 1 · La solicitud (Kepler XA1501) ──────────────────────────────────────────
      const s: any = await trx('analytics.expense_requests')
        .where({ tenant_id: tenantId, sucursal: suc, folio: fol })
        .first('folio', 'sucursal', 'fecha', 'solicitante', 'beneficiario', 'acreedor', 'acreedor_rfc',
          'concepto', 'estado', 'cuenta_clave', 'forma_pago', 'autoriza', 'referencia', 'aplicada',
          trx.raw('importe::numeric AS importe'), trx.raw('iva::numeric AS iva'));

      if (!s) {
        // No se inventa un expediente vacío: si la solicitud no existe, el folio está mal
        // o es de otra plaza (el folio es único por sucursal, no global).
        throw new NotFoundException(`no hay solicitud ${fol} en la sucursal ${suc}`);
      }

      // El recorte por áreas se aplica DESPUÉS de encontrarla, para poder distinguir
      // «no existe» de «no te toca»: son dos respuestas distintas para quien pregunta.
      if (!veTodo) {
        const norm = (v: unknown) => String(v ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
        if (!claves.length || !claves.includes(norm(s.solicitante))) {
          throw new NotFoundException(`la solicitud ${fol} no está dentro de tu alcance`);
        }
      }

      // ── 2 · El expediente propio (GX.7–GX.14) ─────────────────────────────────────
      const p: any = await trx('finance.expense_proofs')
        .where({ tenant_id: tenantId, sucursal: suc, folio_solicitud: fol })
        .orderBy('created_at', 'desc')
        .first('id', 'status', 'clasificacion', 'forma_pago', 'forma_pago_detalle', 'files',
          'comentarios', 'comprobacion_nota', 'monto_match', 'created_by', 'created_at',
          'validated_by', 'validated_at', 'motivo_rechazo', trx.raw('monto_ocr::numeric AS monto_ocr'));

      // ── 3 · Los gastos aplicados (Kepler XA1001) — 0..n, ver el encabezado ────────
      const gastosRaw: any[] = await trx('analytics.expense_documents')
        .where({ tenant_id: tenantId, sucursal: suc, doc_tipo: 'XA1001', solicitud_folio: fol })
        .orderBy('fecha', 'asc')
        .select('doc_folio', 'fecha', 'fecha_doc', 'beneficiario', 'rfc', 'concepto', 'area', 'usuario',
          trx.raw('importe::numeric AS importe'), trx.raw('iva::numeric AS iva'));

      const solImporte = Number(s.importe) || 0;
      const gastos = gastosRaw.map((g) => ({
        ...g,
        importe: Number(g.importe),
        iva: g.iva == null ? null : Number(g.iva),
        // Cuadre de ESTE gasto contra la solicitud. Con varios gastos la pregunta útil es
        // la suma (abajo); esta columna igual sirve para ver cuál se pasó.
        cuadra_con_solicitud: this.cuadra(Number(g.importe), solImporte),
      }));
      const sumaGastos = gastos.reduce((a, g) => a + Number(g.importe), 0);

      // ── 4 · Las comprobaciones propias, por folio de GASTO ────────────────────────
      const folios = gastos.map((g: any) => g.doc_folio).filter(Boolean);
      const compsRaw: any[] = folios.length
        ? await trx('finance.expense_comprobaciones')
          .where('tenant_id', tenantId)
          .whereIn('folio_gasto', folios)
          .orderBy('created_at', 'desc')
          .select('id', 'folio_gasto', 'folio_comprobacion', 'fecha_comprobacion', 'status', 'files',
            'proveedor', 'comentarios', 'revision_nota', 'monto_match', 'created_by', 'created_at',
            'validated_by', 'validated_at', 'motivo_rechazo', trx.raw('importe::numeric AS importe'),
            trx.raw('monto_ocr::numeric AS monto_ocr'))
        : [];

      // Las URLs del bucket son privadas: se firman al armar el expediente. 30 min, el
      // mismo aire que el detalle, porque el PDF se arma y se lee sin prisa.
      const expediente = p
        ? { ...p, importe_ocr: p.monto_ocr == null ? null : Number(p.monto_ocr), files: await this.storage.signFiles(this.parseFiles(p.files), 1800) }
        : null;
      const comprobaciones = await Promise.all(compsRaw.map(async (c) => ({
        ...c,
        importe: c.importe == null ? null : Number(c.importe),
        monto_ocr: c.monto_ocr == null ? null : Number(c.monto_ocr),
        files: await this.storage.signFiles(this.parseFiles(c.files), 1800),
      })));

      const tramite = derivarEtapa({ estado: s.estado, expediente, gastos, comprobaciones, sumaGastos, solImporte });

      return {
        sucursal: suc,
        folio_solicitud: fol,
        solicitud: { ...s, importe: solImporte, iva: s.iva == null ? null : Number(s.iva) },
        expediente,
        gastos,
        comprobaciones,
        tramite,
        generado_at: new Date().toISOString(),
      };
    });
  }


  /**
   * `[GX.15]` **Lo que ya se puede comprobar**: las solicitudes de esta persona que Kepler
   * ya autorizó **y** que ya tienen su gasto aplicado, sin comprobación todavía.
   *
   * Es la respuesta a «cuando en Kepler se lo autoricen, tenerle disponible su
   * comprobación»: no hace falta que nadie avise ni que corra un proceso — en cuanto el
   * `XA1001` aparece en el ODS, la fila aparece acá con todo lo que la comprobación
   * necesita ya resuelto (folio del gasto, importe, beneficiario).
   *
   * ⚠️ **Acotado por ventana de días a propósito.** Sin el acote esto cruza las dos vistas
   * sobre toda la historia, que es justo la consulta que no terminó en 5 minutos.
   */
  async listasParaComprobar(
    user?: { sub?: string; role_name?: string; permissions?: Record<string, boolean> },
    dias = 90,
    limit = 200,
  ) {
    const tenantId = this.tenantCtx.requireTenantId();
    const ventana = Math.min(365, Math.max(1, Number(dias) || 90));
    const lim = Math.min(500, Math.max(1, Number(limit) || 200));

    return this.tk.run(async (trx) => {
      const { veTodo, claves } = await this.proofs.alcanceDelUsuario(trx, user);
      if (!veTodo && !claves.length) {
        // Sin alcance NO se devuelve la bandeja de la empresa ni una lista vacía a secas:
        // vacío sin motivo se lee como «no tenés nada pendiente», que es otra afirmación.
        return {
          medido: false,
          motivo: 'tu usuario no tiene áreas de gasto asignadas ni un nombre que case con el solicitante de Kepler',
          ventana_dias: ventana, rows: [],
        };
      }

      // ⚠️ DOS VIAJES, no un JOIN, y en ESTE orden. Medido contra prod el 2026-09-24:
      //   · unir `expense_documents` con `expense_requests` (las dos son vistas sobre el
      //     ODS, sin índices propios): **se pasa de 90 s y lo cancela el timeout**.
      //   · separado: 905 ms + 311 ms = **1.2 s**.
      //
      // Y se arranca por las SOLICITUDES, no por los gastos. Al revés también responde,
      // pero el recorte por persona sólo se puede aplicar del lado de la solicitud: con
      // el gasto primero hay que topar el primer viaje (medido: 3,000 filas en 90 días,
      // tope alcanzado) y el recorte ocurre después, así que a quien sólo ve lo suyo le
      // pueden faltar filas sin que nada lo avise. Arrancando acá, el universo ya viene
      // recortado y completo.
      //
      // ⚠️ La ventana es sobre la fecha de la SOLICITUD, no la del gasto (en los datos
      // suelen ser el mismo día). Un gasto aplicado tarde sobre una solicitud vieja cae
      // fuera; se dice acá y viaja en la respuesta como `ventana_dias`.
      const solicitudes: any[] = await trx('analytics.expense_requests')
        .where('tenant_id', tenantId)
        .whereRaw('fecha >= current_date - ?::int', [ventana])
        .whereRaw('fecha <= current_date')
        .whereNot('estado', 'C') // cancelada en Kepler no se comprueba: se canceló
        .modify((b: any) => {
          if (!veTodo) b.whereRaw("upper(regexp_replace(btrim(solicitante),'\s+',' ','g')) = ANY(?::text[])", [claves]);
        })
        .select('sucursal', 'folio', 'estado', 'solicitante', trx.raw('importe::numeric AS importe'));

      if (!solicitudes.length) return { medido: true, motivo: null, ventana_dias: ventana, rows: [] };

      const sols = new Map<string, any>();
      const porSucursal = new Map<string, Set<string>>();
      for (const r of solicitudes) {
        sols.set(`${r.sucursal}|${r.folio}`, r);
        if (!porSucursal.has(r.sucursal)) porSucursal.set(r.sucursal, new Set());
        porSucursal.get(r.sucursal)!.add(r.folio);
      }

      // Segundo viaje: los gastos de ESOS folios que todavía no tienen comprobación. El
      // anti-join sí va en SQL — es contra una tabla nuestra, con índices.
      const gastos: any[] = [];
      for (const [suc, folios] of porSucursal) {
        const q = await trx('analytics.expense_documents as g')
          .where({ 'g.tenant_id': tenantId, 'g.sucursal': suc, 'g.doc_tipo': 'XA1001' })
          .whereRaw('g.solicitud_folio = ANY(?::text[])', [[...folios]])
          .whereNotExists(function (this: any) {
            this.select(trx.raw('1')).from('finance.expense_comprobaciones as c')
              .whereRaw('c.tenant_id = g.tenant_id').whereRaw('c.folio_gasto = g.doc_folio');
          })
          .orderBy('g.fecha', 'desc')
          .select('g.sucursal', 'g.doc_folio', 'g.fecha', 'g.beneficiario', 'g.concepto', 'g.area',
            'g.solicitud_folio', trx.raw('g.importe::numeric AS importe'));
        gastos.push(...q);
      }

      const rows = gastos
        .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)))
        .slice(0, lim)
        .map((g) => {
          const s: any = sols.get(`${g.sucursal}|${g.solicitud_folio}`);
          const solImporte = s?.importe == null ? null : Number(s.importe);
          return {
            sucursal: g.sucursal,
            folio_gasto: g.doc_folio,
            fecha_gasto: g.fecha,
            beneficiario: g.beneficiario,
            concepto: g.concepto,
            area: g.area,
            solicitud_folio: g.solicitud_folio,
            solicitud_estado: s?.estado ?? null,
            solicitante: s?.solicitante ?? null,
            importe: Number(g.importe),
            solicitud_importe: solImporte,
            cuadra_con_solicitud: solImporte == null ? null : this.cuadra(Number(g.importe), solImporte),
          };
        });

      return { medido: true, motivo: null, ventana_dias: ventana, rows };
    });
  }
}
