import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService, ObjectStorageService, applySmartSearch } from '@megadulces/platform-core';
import type {
  DeudaProgramableResponse, ProgramarDocumentoDto, ProgramarDocumentoResultado, ProveedorSelectorOpcion,
} from '@megadulces/contracts';
import { armarDeudaProgramable, NOMBRE_DOCUMENTO_CXP, type FilaDeudaCruda } from './deuda-programable.engine';
// `[PGP.119]` El anticipo pedido en la Suite: la regla (contrato) y sus lecturas (SQL medido en prod).
import {
  digitosClabe, estadoCuentaAnticipo, etapaDeSolicitud, faltaSolicitudAnticipo, llaveOcKepler, MARCA_CANCELADO, numeroDeCuentaValido, parearSolicitudes, tipoDeAcreedor, warehouseName,
  type AnticipoOcKeplerRow, type AnticipoProveedorRow, type AnticipoSolicitadoRow, type AnticipoSolicitudBody, type CandidatoAnticipoKepler,
  type AnticipoKeplerSinSolicitudRow, type ObligacionCancelada, type RefOcKepler,
} from '@megadulces/contracts';
import { SQL_ANTICIPOS_KEPLER_MERCANCIA, SQL_ANTICIPOS_SOLICITADOS, SQL_ANTICIPO_OCS_KEPLER } from './anticipo-solicitado.sql';

/** `[PGP.127]` La cotización: PDF o foto, hasta 10 MB (la ruta tiene su parser de 16 MB en `main.ts`). */
const TIPOS_COTIZACION = /^data:(application\/pdf|image\/(png|jpe?g|webp|heic|heif))[;,]/i;
const MAX_COTIZACION_BYTES = 10 * 1024 * 1024;
/** `[PGP.127]` Dónde viven las cotizaciones: una carpeta por tenant. La llave que manda el cliente tiene que ser de aquí. */
const carpetaCotizaciones = (tenantId: string) => `commercial/${tenantId}/anticipos`;

/** `[PGP.127]` Lo que el pedido hizo con la cuenta, para que la pantalla lo diga sin adivinar. */
export type ResultadoCuentaAnticipo = 'aprobada' | 'pedida' | 'ya_pedida' | 'efectivo';

export interface CreateSupplierObligationDto {
  supplier_id: string;
  purchase_order_id?: string | null;
  goods_receipt_id?: string | null;
  invoice_folio?: string | null;
  concept?: string | null;
  original_amount: number;
  original_due_date?: string | null;
  negotiated_date?: string | null;
  notes?: string | null;
}

/** `[PGP.6]` El nombre del documento, del mapa compartido del motor. */
const nombreDocumentoCxp = (tipo: number, sub: number): string =>
  NOMBRE_DOCUMENTO_CXP[`${tipo}/${sub}`] ?? `Documento ${tipo}/${sub}`;

/** Hoy en hora de México: la fecha de corte de «vencido» que publica el universo. */
const SQL_HOY = `SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS al`;

/**
 * `[PGP.6]` La deuda viva de mercancía por documento, marcando cuál ya es obligación.
 *
 * El HAVING count(*) = 1 descarta los folios que aparecen con dos documentos distintos en la
 * misma sucursal: ahi no se puede saber cual se esta programando, y adivinar seria peor que
 * dejarlo fuera. Es el mismo criterio que usa TP.15.
 *
 * Orden: primero lo que no es dudoso (anterior_al_corte al final), despues lo mas vencido, y a
 * igualdad de dias lo de mas monto. Es el orden en que conviene decidir.
 */
const SQL_DEUDA_PROGRAMABLE = `
  WITH doc AS (
    SELECT p.sucursal, p.proveedor, max(p.proveedor_nombre) AS proveedor_nombre,
           min(p.doc_tipo) AS doc_tipo, min(p.doc_sub) AS doc_sub, p.folio,
           to_char(min(p.vencimiento), 'YYYY-MM-DD') AS vencimiento,
           min(p.dias_vencido) AS dias_vencido,
           bool_or(p.anterior_al_corte) AS anterior_al_corte,
           sum(p.pendiente) AS pendiente
      FROM analytics.v_supplier_payables p
     WHERE p.pendiente > 0 AND p.proveedor LIKE 'C%'
     GROUP BY p.sucursal, p.proveedor, p.folio
    HAVING count(*) = 1
  )
  SELECT d.sucursal, d.proveedor, d.proveedor_nombre, d.doc_tipo, d.doc_sub, d.folio,
         d.vencimiento, d.dias_vencido, d.anterior_al_corte, d.pendiente,
         s.id AS supplier_id,
         (o.id IS NOT NULL) AS programado
    FROM doc d
    LEFT JOIN catalog.suppliers s
           ON btrim(s.code) = btrim(d.proveedor) AND s.tenant_id = ?
    LEFT JOIN commercial.supplier_payment_obligations o
           ON o.tenant_id = ? AND o.status <> 'cancelled'
          AND o.kepler_sucursal = d.sucursal AND o.kepler_folio = d.folio
          AND o.kepler_doc_tipo = d.doc_tipo AND o.kepler_doc_sub = d.doc_sub
   ORDER BY d.anterior_al_corte ASC, d.dias_vencido DESC NULLS LAST, d.pendiente DESC`;

/**
 * `[PGP.6]` El saldo VIVO de un documento, leido en el momento de crear la obligacion.
 * Es la unica fuente del importe: el payload no lo trae.
 */
const SQL_SALDO_DOCUMENTO = `
  SELECT sum(p.pendiente) AS pendiente,
         to_char(min(p.vencimiento), 'YYYY-MM-DD') AS vencimiento
    FROM analytics.v_supplier_payables p
   WHERE p.sucursal = ? AND btrim(p.proveedor) = ? AND p.doc_tipo = ? AND p.doc_sub = ?
     AND btrim(p.folio) = ? AND p.pendiente > 0`;

/**
 * Fase TP.1 — Compras: obligaciones a proveedor de mercancía (ADR-064). La "cuenta por pagar"
 * que RA.15 no modela (esa cadena trackea unidades/costo pactado, no saldo con vencimiento
 * negociable). Opcionalmente ligada a `purchase_orders`/`goods_receipts`. El Calendario de Pagos
 * de Finanzas SOLO lee de acá.
 */
@Injectable()
export class SupplierPaymentObligationsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    // `[PGP.127]` La cotización del anticipo (bucket privado; se abre con URL firmada). Viene de `CloudinaryModule`.
    private readonly storage: ObjectStorageService,
  ) {}

  /**
   * `[PGP.6]` **La deuda viva que todavía no está programada**, para elegir qué pagar.
   *
   * No copia nada: lee el pendiente del ODS y marca cuál ya tiene obligación. La obligación se
   * crea de a una, en `programarDocumento()`.
   *
   * ⛔⛔ **Acá NO se filtra por sucursal, y no es un olvido.** Medido contra prod el 2026-10-22,
   * tres corridas de cada una: esta misma consulta sin filtro de sucursal cuesta **450–550 ms**;
   * agregándole `AND sucursal = <la del CEDIS>` cuesta **43.6–47.7 s**, y filtrando por sucursal
   * **afuera** de la vista cuesta **42.7–52.8 s**. O sea ~90x, y no es el predicado empujado
   * (afuera tarda igual). La causa exacta queda **NO DETERMINADA** y declarada en el plan de
   * fase; lo que está medido es que por ese camino no se pasa. Si alguna vez hace falta acotar
   * por sucursal, se acota **en TS sobre el resultado**, nunca en el SQL.
   *
   * ⚠️ **DEUDA DECLARADA, con nombre: esta consulta cuesta ~770 ms** sobre los 1,733 documentos
   * vivos, y el techo del proyecto para una pantalla es 500 ms. El costo **no es de esta
   * consulta**: medido por partes, `analytics.v_supplier_payables` sola ya cuesta 450–550 ms y
   * los joins agregan ~100 ms. Acelerarlo es trabajo sobre la vista —que tiene otros cuatro
   * consumidores— y va **aparte**, no escondido acá: optimizar es un commit distinto de cambiar
   * alcance de negocio. Mientras tanto la pantalla pagina y lo dice.
   */
  async listDeudaProgramable(q: { limit?: number }): Promise<DeudaProgramableResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(Math.max(Math.trunc(Number(q.limit ?? 100)) || 100, 1), 1000);
    return this.tk.run(async (trx) => {
      const [{ rows: hoy }, r] = await Promise.all([
        trx.raw(SQL_HOY),
        trx.raw(SQL_DEUDA_PROGRAMABLE, [tenantId, tenantId]),
      ]);
      const filas: FilaDeudaCruda[] = r.rows ?? [];
      return armarDeudaProgramable(filas, { limit, al: String(hoy[0].al).slice(0, 10) });
    });
  }

  /**
   * `[PGP.6]` **Programa un documento del pendiente vivo**: crea su obligación para que el
   * Calendario pueda asignarle un día.
   *
   * ⭐⭐ **El importe NO viene del cliente: se lee del ODS dentro de la misma transacción.** Si
   * viniera en el payload, la pantalla podría mandar uno que ya no es cierto y nadie lo notaría
   * hasta pagar de más. `[TP.15]` midió esa trampa por la otra puerta: copiando el importe de la
   * entrega, **21 de 38 documentos ya no debían nada y 2 debían menos**.
   *
   * ⛔ Y no se crea una segunda obligación para el mismo documento: lo impide el índice
   * `ux_spo_kepler_doc` (`[PGP.5]`), y acá se devuelve `ya_existia` en vez de un error — dos
   * personas eligiendo la misma factura a la vez es un caso normal, no una falla.
   */
  async programarDocumento(dto: ProgramarDocumentoDto, username: string): Promise<ProgramarDocumentoResultado> {
    if (!dto?.sucursal?.trim()) throw new BadRequestException('sucursal es requerida');
    if (!dto?.proveedor?.trim()) throw new BadRequestException('proveedor es requerido');
    if (!dto?.folio?.trim()) throw new BadRequestException('folio es requerido');
    if (!Number.isFinite(Number(dto.doc_tipo)) || !Number.isFinite(Number(dto.doc_sub))) {
      throw new BadRequestException('doc_tipo y doc_sub son requeridos (la coordenada del documento en Kepler)');
    }
    const tenantId = this.tenantCtx.requireTenantId();
    const args = [tenantId, dto.sucursal.trim(), dto.proveedor.trim(), Number(dto.doc_tipo), Number(dto.doc_sub), dto.folio.trim()];

    return this.tk.run(async (trx) => {
      const supplier = await trx('catalog.suppliers')
        .where({ tenant_id: tenantId })
        .whereRaw('btrim(code) = ?', [dto.proveedor.trim()])
        .first('id', 'name');
      if (!supplier) {
        throw new NotFoundException(
          `El acreedor ${dto.proveedor} no está en el catálogo de la suite: no se le puede crear una obligación. Se da de alta en Compras primero.`,
        );
      }

      const { rows: saldo } = await trx.raw(SQL_SALDO_DOCUMENTO, args.slice(1));
      if (saldo.length === 0 || !(Number(saldo[0].pendiente) > 0)) {
        // ⛔ Sin saldo NO es un error: el documento se pagó entre que se pintó la lista y el clic.
        return { resultado: 'sin_saldo', obligacion_id: null, importe: null, vencimiento: null };
      }
      const doc = saldo[0];

      const ya = await trx('commercial.supplier_payment_obligations')
        .where({ tenant_id: tenantId, kepler_sucursal: dto.sucursal.trim(), kepler_folio: dto.folio.trim(),
                 kepler_doc_tipo: Number(dto.doc_tipo), kepler_doc_sub: Number(dto.doc_sub) })
        .whereNot('status', 'cancelled')
        .first('id', 'original_amount', 'original_due_date');
      if (ya) {
        return {
          resultado: 'ya_existia', obligacion_id: ya.id,
          importe: Number(ya.original_amount),
          vencimiento: ya.original_due_date ? String(ya.original_due_date).slice(0, 10) : null,
        };
      }

      const [row] = await trx('commercial.supplier_payment_obligations')
        .insert({
          tenant_id: tenantId,
          supplier_id: supplier.id,
          invoice_folio: dto.folio.trim(),
          concept: `${nombreDocumentoCxp(Number(dto.doc_tipo), Number(dto.doc_sub))} ${dto.sucursal.trim()}-${dto.folio.trim()}`,
          original_amount: Number(doc.pendiente),
          original_due_date: doc.vencimiento ?? null,
          notes: dto.motivo?.trim() || 'Programado desde el pendiente vivo de Kepler',
          // Elegir el documento para pagarlo ES la autorización para programarlo (ADR-064),
          // igual que aceptar el renglón de entrega lo es en `[TP.15]`.
          authorized_by: username, authorized_at: trx.fn.now(), created_by: username,
          kepler_sucursal: dto.sucursal.trim(), kepler_doc_tipo: Number(dto.doc_tipo),
          kepler_doc_sub: Number(dto.doc_sub), kepler_folio: dto.folio.trim(),
        })
        .returning(['id', 'original_amount', 'original_due_date']);

      return {
        resultado: 'creada', obligacion_id: row.id,
        importe: Number(row.original_amount),
        vencimiento: row.original_due_date ? String(row.original_due_date).slice(0, 10) : null,
      };
    });
  }

  async list(q: { status?: string; search?: string; dueFrom?: string; dueTo?: string; supplier_id?: string; onlyCritical?: boolean }) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const b = trx('commercial.supplier_payment_obligations as o')
        .join('catalog.suppliers as s', 's.id', 'o.supplier_id')
        .select('o.*', 's.name as supplier_name', 's.code as supplier_code', 's.is_critical as supplier_critical', 's.critical_reason as supplier_critical_reason',
          trx.raw('(o.original_amount - o.reserved_amount - o.paid_amount) AS available_amount'));
      if (q.status) b.where('o.status', q.status); else b.whereNotIn('o.status', ['cancelled']);
      if (q.supplier_id) b.where('o.supplier_id', q.supplier_id);
      if (q.onlyCritical) b.where('s.is_critical', true);
      // `[BU.2.8]` Motor único `applySmartSearch`: proveedor + folio + concepto + monto en una sola
      // consulta multi-palabra. El monto va también en `columns` para que pegue dentro de una
      // búsqueda mixta (la vía numérica sólo se activa si TODA la consulta es número).
      if (q.search?.trim()) applySmartSearch(b, q.search, {
        columns: ['s.name', 'o.invoice_folio', 'o.concept', 'o.original_amount'],
        numeric: ['o.original_amount'],
      });
      if (q.dueFrom) b.where('o.original_due_date', '>=', q.dueFrom);
      if (q.dueTo) b.where('o.original_due_date', '<=', q.dueTo);
      return b.orderByRaw('o.original_due_date ASC NULLS LAST');
    });
  }

  async get(id: string) {
    this.tenantCtx.requireTenantId();
    const row = await this.tk.run((trx) => trx('commercial.supplier_payment_obligations').where({ id }).first());
    if (!row) throw new NotFoundException('Obligación a proveedor no encontrada');
    return row;
  }

  async create(dto: CreateSupplierObligationDto, username: string) {
    if (!dto.supplier_id) throw new BadRequestException('supplier_id es requerido');
    if (!(Number(dto.original_amount) > 0)) throw new BadRequestException('original_amount debe ser > 0');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const supplier = await trx('catalog.suppliers').where({ tenant_id: tenantId, id: dto.supplier_id }).first();
      if (!supplier) throw new NotFoundException('Proveedor no encontrado');
      const [row] = await trx('commercial.supplier_payment_obligations').insert({
        tenant_id: tenantId,
        supplier_id: dto.supplier_id,
        purchase_order_id: dto.purchase_order_id ?? null,
        goods_receipt_id: dto.goods_receipt_id ?? null,
        invoice_folio: dto.invoice_folio ?? null,
        concept: dto.concept ?? null,
        original_amount: dto.original_amount,
        original_due_date: dto.original_due_date ?? null,
        negotiated_date: dto.negotiated_date ?? null,
        notes: dto.notes ?? null,
        authorized_by: username,
        created_by: username,
      }).returning('*');
      return row;
    });
  }

  /**
   * `[PGP.119]` Los proveedores que pueden recibir anticipo: de mercancía (código `C…`, D2) y activos.
   * Busca por nombre o código con el motor único (`applySmartSearch`).
   */
  async anticipoProveedores(search?: string): Promise<AnticipoProveedorRow[]> {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      // `[PGP.155.2]` Con su último movimiento en Kepler, como el buscador de «Cuentas de pago» (`[PGP.154]`): sin
      // él, VUMERSOFT salía dos veces (`CD004` y `CV10`) y nada decía cuál es el que se usa. Los que tienen
      // movimiento van primero. Lateral: 11 ms contra 41 ms de agrupar todo `kdxe` (medido en prod, 2026-11-18).
      const b = trx('catalog.suppliers as s')
        // `btrim` sólo del lado del catálogo (revisión independiente): `kdxe.c2` llega limpio del ODS (0 con espacios,
        // medido 2026-11-18) y `btrim(k.c2)` mata el índice — 59 ms contra 7.4 s, mismos renglones (prod, sólo lectura).
        .joinRaw('LEFT JOIN LATERAL (SELECT max(k.c7) AS ultimo FROM kepler_ods.kdxe k WHERE k.c2 = btrim(s.code)) m ON true')
        .select('s.id', trx.raw('btrim(s.code) AS code'), 's.name', trx.raw(`to_char(m.ultimo, 'YYYY-MM-DD') AS ultimo_movimiento`))
        .where('s.activo', true).whereRaw(`btrim(s.code) LIKE 'C%'`);
      if (search?.trim()) applySmartSearch(b, search, { columns: ['s.name', 's.code'] });
      return b.orderByRaw('m.ultimo IS NULL, s.name').limit(30);
    });
  }

  /**
   * `[PGP.127]` D11 — **Las OC de Kepler (`X-A-35`) del proveedor**, pendientes o recibidas en parte, con los
   * anticipos ya pedidos sobre cada una (el tope, D6). Antes eran las OC de la Suite, que dejaron de nacer
   * el 26-oct (D21 de PQ).
   */
  async anticipoOcs(supplierId: string): Promise<AnticipoOcKeplerRow[]> {
    if (!/^[0-9a-f-]{36}$/i.test(String(supplierId ?? ''))) throw new BadRequestException('supplier_id inválido');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const sup = await trx('catalog.suppliers').where({ tenant_id: tenantId, id: supplierId }).first('code');
      if (!sup) throw new NotFoundException('Proveedor no encontrado');
      return this.leerOcsKepler(trx, tenantId, String(sup.code ?? '').trim(), null);
    });
  }

  /** `[PGP.127]` La MISMA lectura para la lista y para verificar al pedir (`llaves` = sólo ésas). */
  private async leerOcsKepler(trx: Knex.Transaction, tenantId: string, codigo: string, llaves: string[] | null): Promise<AnticipoOcKeplerRow[]> {
    const json = llaves ? JSON.stringify(llaves) : null;
    const { rows } = await trx.raw(SQL_ANTICIPO_OCS_KEPLER, [codigo, json, json, tenantId]);
    return (rows as AnticipoOcKeplerRow[]).map((r) => ({ ...r, total: Number(r.total), pedidos: (r.pedidos ?? []).map((p) => ({ id: p.id, monto: Number(p.monto) })) }));
  }

  /**
   * `[PGP.127]` D10 — **sube la cotización** al almacenamiento privado y devuelve su llave. El pedido la
   * cita después; el servidor sólo acepta llaves de la carpeta de anticipos de ESTE tenant.
   */
  async subirCotizacion(dataUri: string): Promise<{ key: string; kind: 'pdf' | 'image' }> {
    const tenantId = this.tenantCtx.requireTenantId();
    const raw = String(dataUri ?? '');
    if (!raw) throw new BadRequestException('Falta el archivo de la cotización.');
    if (!TIPOS_COTIZACION.test(raw)) throw new BadRequestException('La cotización tiene que ser PDF o foto (JPG, PNG, WEBP o HEIC).');
    const bytes = Math.floor((raw.length - raw.indexOf(',') - 1) * 3 / 4);
    if (bytes > MAX_COTIZACION_BYTES) throw new BadRequestException('La cotización pesa más de 10 MB: escanéala más ligera o mándala en foto.');
    try {
      return await this.storage.putFile(raw, carpetaCotizaciones(tenantId));
    } catch (e: unknown) {
      if ((e as { status?: number } | null)?.status === 400) throw e;
      throw new BadRequestException('No se pudo guardar la cotización. Intenta de nuevo.');
    }
  }

  /** `[PGP.127]` La cotización de un anticipo, con URL firmada de 10 minutos (Compras y el Calendario). */
  async cotizacionUrl(obligationId: string): Promise<{ url: string; kind: string | null }> {
    if (!/^[0-9a-f-]{36}$/i.test(String(obligationId ?? ''))) throw new BadRequestException('id inválido');
    const tenantId = this.tenantCtx.requireTenantId();
    const row = await this.tk.run((trx) => trx('commercial.supplier_payment_obligations')
      .where({ tenant_id: tenantId, id: obligationId, nature: 'anticipo' }).first('quote_file_key', 'quote_file_kind'));
    if (!row) throw new NotFoundException('Anticipo no encontrado.');
    if (!row.quote_file_key) throw new NotFoundException('Este anticipo se pidió sin cotización (antes de que se exigiera).');
    const url = await this.storage.signedUrl(row.quote_file_key);
    if (!url) throw new BadRequestException('El almacenamiento de archivos no está disponible: no se puede abrir la cotización.');
    return { url, kind: row.quote_file_kind ?? null };
  }

  /**
   * `[PGP.119]` **Pedir un anticipo.** Nace una obligación de pago de naturaleza `anticipo`: entra al
   * Calendario como cualquier otra y sale por el carril de siempre (Dirección autoriza el pago, D1).
   * El servidor revisa con la MISMA regla que la pantalla (`faltaSolicitudAnticipo`) y lee la OC de la
   * base —total y lo ya anticipado— dentro de la transacción, con la OC bloqueada: dos solicitudes a la
   * vez sobre la misma OC no pasan juntas del tope.
   */
  async crearAnticipo(dto: AnticipoSolicitudBody, username: string): Promise<{ obligation_id: string; monto: number; concepto: string; cuenta: ResultadoCuentaAnticipo }> {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!/^[0-9a-f-]{36}$/i.test(String(dto?.supplier_id ?? ''))) throw new BadRequestException('Elige el proveedor.');
    // `[PGP.127]` La cotización tiene que ser una llave que subió ESTE tenant a la carpeta de anticipos:
    // con una llave ajena, la URL firmada abriría el documento de otro.
    const cot = dto.cotizacion ?? null;
    if (cot && (!String(cot.key ?? '').startsWith(`${carpetaCotizaciones(tenantId)}/`) || String(cot.key).includes('..') || !['pdf', 'image'].includes(String(cot.kind)))) {
      throw new BadRequestException('La cotización no es válida: súbela otra vez.');
    }
    // `[PGP.127]` Las OC llegan como referencia; se vuelven a leer de Kepler (no se le cree al cliente).
    const refs: RefOcKepler[] = (Array.isArray(dto.kepler_ocs) ? dto.kepler_ocs : [])
      .map((o) => ({ sucursal: String(o?.sucursal ?? '').trim(), serie: String(o?.serie ?? '').trim(), folio: String(o?.folio ?? '').trim() }));
    if (refs.length > 20) throw new BadRequestException('Son demasiadas órdenes para un anticipo (máximo 20).');
    const llaves = [...new Set(refs.map(llaveOcKepler))].sort();
    return this.tk.run(async (trx) => {
      const supplier = await trx('catalog.suppliers').where({ tenant_id: tenantId, id: dto.supplier_id }).first();
      if (!supplier) throw new NotFoundException('Proveedor no encontrado');
      if (!supplier.activo) throw new BadRequestException('El proveedor está inactivo.');
      // Gasto o tarjeta se dicen ANTES de buscar sus OC: si no, el aviso sería «la OC no es de este proveedor».
      if (tipoDeAcreedor(String(supplier.code ?? '').trim()) !== 'mercancia') {
        throw new BadRequestException(faltaSolicitudAnticipo({ supplier_code: String(supplier.code ?? '').trim(), sucursal: null, monto: 0, motivo: null, ocs: [], cotizacion: false, cuenta: null }) ?? 'Sólo se da anticipo a proveedores de mercancía.');
      }
      // `[PGP.127]` Un candado por OC, en orden: dos pedidos a la vez sobre la misma OC no pasan juntos del tope.
      for (const k of llaves) await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`pgp127:oc:${tenantId}:${k}`]);
      const ocs = llaves.length ? await this.leerOcsKepler(trx, tenantId, String(supplier.code ?? '').trim(), llaves) : [];
      if (ocs.length !== llaves.length) {
        const vistas = new Set(ocs.map(llaveOcKepler));
        const falta = llaves.filter((k) => !vistas.has(k)).map((k) => k.split('|')[2]).join(', ');
        throw new BadRequestException(`La OC ${falta} no es de este proveedor o ya no está pendiente en Kepler: vuelve a elegirla.`);
      }
      let oc: { id: string; folio: string; total: number; anticipado: number; sucursal: string | null } | null = null;
      if (dto.purchase_order_id) {
        const po = await trx('commercial.purchase_orders').where({ tenant_id: tenantId, id: dto.purchase_order_id }).forUpdate().first();
        if (!po) throw new NotFoundException('La orden de compra no existe.');
        if (po.supplier_id !== dto.supplier_id) throw new BadRequestException(`La OC ${po.folio} es de otro proveedor.`);
        if (!['open', 'partial'].includes(po.estado)) throw new BadRequestException(`La OC ${po.folio} ya no está abierta (${po.estado}).`);
        const { rows: [ya] } = await trx.raw(
          `SELECT coalesce(sum(original_amount), 0)::float8 AS anticipado FROM commercial.supplier_payment_obligations
            WHERE purchase_order_id = ? AND nature = 'anticipo' AND status <> 'cancelled'`, [po.id]);
        oc = { id: po.id, folio: po.folio, total: Number(po.total_cost ?? 0), anticipado: Number(ya.anticipado), sucursal: null };
      }
      const code = String(supplier.code ?? '').trim();
      // `[PGP.127]` La MISMA regla que la pantalla, ahora con las OC leídas de Kepler, la cotización y la cuenta.
      const falta = faltaSolicitudAnticipo({
        supplier_code: code, sucursal: dto.sucursal, monto: dto.monto, motivo: dto.motivo, fecha: dto.fecha ?? null, oc,
        ocs, cotizacion: !!cot, cuenta: dto.cuenta ?? null,
      });
      if (falta) throw new BadRequestException(falta);
      const monto = Math.round(Number(dto.monto) * 100) / 100;
      const sucursal = String(dto.sucursal).trim();
      const motivo = String(dto.motivo).trim();
      const { clabe, cuenta, resultado } = await this.cuentaDelAnticipo(trx, tenantId, supplier, dto, cot!, username);
      const folios = ocs.map((o) => o.folio).join(', ');
      const concepto = `Anticipo · OC ${folios}${oc ? ` · OC Suite ${oc.folio}` : ''} · ${warehouseName(sucursal)}`;
      const [row] = await trx('commercial.supplier_payment_obligations').insert({
        tenant_id: tenantId, supplier_id: dto.supplier_id, purchase_order_id: oc?.id ?? null,
        nature: 'anticipo', concept: concepto, original_amount: monto,
        original_due_date: dto.fecha || trx.raw(`(now() AT TIME ZONE 'America/Mexico_City')::date`),
        notes: motivo,
        // Pedirlo es autorizar que se PROGRAME (ADR-064, como aceptar una entrega); el pago lo autoriza Dirección.
        authorized_by: username, authorized_at: trx.fn.now(), created_by: username,
        // El X-D-60 se capturará en esta sucursal; su folio se parea al leer (el CHECK exige folio vacío).
        kepler_sucursal: sucursal, kepler_doc_tipo: 60, kepler_doc_sub: 1, kepler_folio: null,
        // `[PGP.127]` Los papeles del pedido: la cotización, sus OC de Kepler y la CLABE a la que se paga.
        quote_file_key: cot!.key, quote_file_kind: cot!.kind,
        kepler_ocs: JSON.stringify(ocs.map((o) => ({ sucursal: o.sucursal, serie: o.serie, folio: o.folio }))),
        payee_clabe: clabe,
        // `[PGP.155]` La cuenta sin CLABE (mismo banco). Sólo se escribe si hay: un anticipo con CLABE o en
        // efectivo no depende de que la migración `pgp155` ya esté aplicada.
        ...(cuenta ? { payee_account_number: cuenta } : {}),
      }).returning(['id', 'original_amount']);
      return { obligation_id: row.id, monto: Number(row.original_amount), concepto, cuenta: resultado };
    });
  }

  /**
   * `[PGP.127]` D12 — **la cuenta a la que se paga el anticipo.** Es el mismo flujo de alta de cuentas
   * (`[TP.7]`, ADR-064): la CLABE que no está aprobada queda PEDIDA y la aprueba Dirección
   * (`FINANCE_PAYMENT_CALENDAR_AUTORIZAR`); este método nunca da de alta una cuenta. La cotización viaja
   * como su respaldo, para que quien aprueba vea de dónde salió la CLABE.
   *
   * ⚠️ Es el gemelo de `registrarDesdePago` (`[PGP.46]`, libs/finance): la misma idempotencia —una CLABE
   * ya activa no se pide; una ya pedida no se pide dos veces—. Vive aquí porque `commercial` no puede
   * importar `finance` (lint:boundary) y porque tiene que ir en la MISMA transacción que el anticipo.
   */
  private async cuentaDelAnticipo(
    trx: Knex.Transaction, tenantId: string, supplier: { id: string; name: string },
    dto: AnticipoSolicitudBody, cot: { key: string; kind: string }, username: string,
  ): Promise<{ clabe: string | null; cuenta: string | null; resultado: ResultadoCuentaAnticipo }> {
    const c = dto.cuenta!;
    if (c.tipo === 'efectivo') return { clabe: null, cuenta: null, resultado: 'efectivo' };
    if (c.tipo === 'aprobada') {
      const acc = await trx('commercial.supplier_payment_accounts')
        .where({ tenant_id: tenantId, id: c.account_id, supplier_id: supplier.id, status: 'activa' }).first('clabe', 'account_number');
      if (!acc) throw new BadRequestException('La cuenta elegida no es de este proveedor o ya no está activa: vuelve a elegirla.');
      const clabe = digitosClabe(acc.clabe);
      if (clabe.length === 18) return { clabe, cuenta: null, resultado: 'aprobada' };
      // `[PGP.155]` Sin CLABE: la cuenta del mismo banco (VUMERSOFT, BBVA a BBVA). Dirección ya la aprobó.
      const cuenta = digitosClabe(acc.account_number);
      if (numeroDeCuentaValido(cuenta)) return { clabe: null, cuenta, resultado: 'aprobada' };
      throw new BadRequestException('Esa cuenta no tiene CLABE ni un número de cuenta que se pueda usar: captura la de la cotización.');
    }
    // La cuenta nueva de la cotización: CLABE o número de cuenta. Si ya está activa, se reconoce; si ya está
    // pedida, no se pide otra vez; si no, nace su solicitud de alta y la aprueba Dirección.
    const porClabe = c.tipo === 'nueva';
    const valor = digitosClabe(porClabe ? c.clabe : c.tipo === 'nueva_cuenta' ? c.cuenta : '');
    const res = (resultado: ResultadoCuentaAnticipo) => ({ clabe: porClabe ? valor : null, cuenta: porClabe ? null : valor, resultado });
    // El número de cuenta se compara por sus dígitos: en el catálogo puede estar con espacios o guiones.
    const activa = await trx('commercial.supplier_payment_accounts').where({ tenant_id: tenantId, supplier_id: supplier.id, status: 'activa' })
      .andWhere((q) => (porClabe ? q.where('clabe', valor) : q.whereRaw(`regexp_replace(coalesce(account_number, ''), '\\D', '', 'g') = ?`, [valor])))
      .first('id');
    if (activa) return res('aprobada');
    const pedida = await trx('commercial.supplier_payment_account_change_requests').where({ tenant_id: tenantId, supplier_id: supplier.id, status: 'pending_approval' })
      .andWhere((q) => (porClabe ? q.where('proposed_clabe', valor) : q.whereRaw(`regexp_replace(coalesce(proposed_account_number, ''), '\\D', '', 'g') = ?`, [valor])))
      .first('id');
    if (pedida) return res('ya_pedida');
    await trx('commercial.supplier_payment_account_change_requests').insert({
      tenant_id: tenantId, supplier_id: supplier.id, account_id: null, deactivate: false,
      proposed_bank_name: String(c.banco).trim(),
      proposed_account_number: porClabe ? null : valor, proposed_clabe: porClabe ? valor : null, proposed_alias: null,
      proposed_attachment_url: cot.key, proposed_attachment_kind: cot.kind, proposed_es_favorita: false,
      reason: `Anticipo a ${supplier.name}: ${porClabe ? 'CLABE' : 'número de cuenta (mismo banco)'} de su cotización, capturado al pedir el anticipo.`, requested_by: username,
    });
    return res('pedida');
  }

  /**
   * `[PGP.119]` **El seguimiento de los anticipos pedidos** (180 días): su pago del Calendario y el
   * `X-D-60` de Kepler con que se ligan. La etapa la decide el contrato (`etapaDeSolicitud`): lo que dice
   * Kepler manda sobre lo que dice la Suite.
   */
  async listAnticiposSolicitados(): Promise<AnticipoSolicitadoRow[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      type Cruda = Omit<AnticipoSolicitadoRow, 'kepler' | 'posibles' | 'etapa' | 'cuenta'> & {
        candidatos: CandidatoAnticipoKepler[]; tenant_id?: string;
        payee_clabe: string | null; payee_cuenta: string | null; banco_aprobada: string | null; solicitud_estado: string | null; solicitud_banco: string | null;
      };
      const rows = (await trx.raw(SQL_ANTICIPOS_SOLICITADOS, [tenantId])).rows as Cruda[];
      const pareo = parearSolicitudes(rows);
      return rows.map(({ candidatos, tenant_id, payee_clabe, payee_cuenta, banco_aprobada, solicitud_estado, solicitud_banco, ...r }) => {
        void candidatos; void tenant_id;
        const p = pareo.get(r.obligation_id) ?? { kepler: null, posibles: 0 };
        const fila = { ...r, monto: Number(r.monto), pagado: Number(r.pagado), disponible: Number(r.disponible), kepler: p.kepler, posibles: p.posibles };
        // `[PGP.127]` La cuenta se deriva aquí, con la regla del contrato: nunca se guarda su estado.
        // `[PGP.155]` Con CLABE o, sin ella, con el número de cuenta del mismo banco.
        const cuenta = {
          estado: estadoCuentaAnticipo({ payee_clabe, payee_cuenta, tiene_cotizacion: !!r.tiene_cotizacion, banco_aprobada, solicitud_estado }),
          clabe: payee_clabe, numero: payee_cuenta ?? null, banco: banco_aprobada ?? solicitud_banco ?? null,
        };
        return { ...fila, cubierto_el: r.cubierto_el ?? null, ocs: r.ocs ?? [], cuenta, etapa: etapaDeSolicitud(fila) };
      });
    });
  }

  /**
   * `[PGP.144]` **Lo que Kepler tiene sin solicitud en la Suite**: los `X-D-60` de mercancía de `dias` atrás (30,
   * 90 o 180) que no están pareados con ninguna solicitud. Es el otro lado del embudo: anticipos que se pagaron
   * fuera de él. El pareo es el MISMO del seguimiento (`parearSolicitudes`): un `X-D-60` ligado a una solicitud
   * cancelada sí cuenta como sin solicitud.
   */
  async anticiposKeplerSinSolicitud(dias?: number | string): Promise<AnticipoKeplerSinSolicitudRow[]> {
    const d = [30, 90, 180].includes(Number(dias)) ? Number(dias) : 90;
    const tenantId = this.tenantCtx.requireTenantId();
    // La llave lleva al ACREEDOR, como el pareo (acreedor + sucursal): sin él, el pareado de un proveedor
    // escondía el X-D-60 de otro con el mismo folio en esa sucursal (revisión del PR).
    const llave = (sucursal: string, acreedor: string, folio: string) => `${sucursal}|${String(acreedor ?? '').trim().toUpperCase()}|${String(folio ?? '').trim()}`;
    const pareados = new Set((await this.listAnticiposSolicitados())
      .filter((s) => s.kepler && s.sucursal).map((s) => llave(s.sucursal!, s.proveedor, s.kepler!.folio)));
    return this.tk.run(async (trx) => {
      const { rows: [c] } = await trx.raw(`SELECT ((now() AT TIME ZONE 'America/Mexico_City')::date - ?::int)::text AS desde`, [d]);
      const { rows } = await trx.raw(SQL_ANTICIPOS_KEPLER_MERCANCIA, [tenantId, c.desde]);
      return (rows as AnticipoKeplerSinSolicitudRow[])
        .filter((k) => !pareados.has(llave(k.sucursal, k.proveedor, k.folio)))
        .map((k) => ({ ...k, importe: Number(k.importe), remanente: Number(k.remanente) }));
    });
  }

  cancel(id: string, reason: string | undefined, username: string): Promise<ObligacionCancelada> {
    return this.cancelar(id, reason, username, false);
  }

  /**
   * `[PGP.142]` La cancelación que pueden usar Finanzas y Compras (D14): la MISMA de abajo, pero sólo acepta
   * anticipos. Con un id de otra obligación responde «no encontrado», como si no existiera: esa puerta no
   * cancela facturas ni obligaciones de Compras.
   */
  async cancelAnticipo(id: string, reason: string | undefined, username: string): Promise<ObligacionCancelada> {
    if (!/^[0-9a-f-]{36}$/i.test(String(id ?? ''))) throw new BadRequestException('id de anticipo inválido');
    return this.cancelar(id, reason, username, true);
  }

  private async cancelar(id: string, reason: string | undefined, username: string, soloAnticipo: boolean): Promise<ObligacionCancelada> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      // `[PGP.126]` `forUpdate`: si el Calendario le está apartando un pago a la vez, se espera y se ve.
      const row = await trx('commercial.supplier_payment_obligations').where({ tenant_id: tenantId, id }).forUpdate().first();
      if (!row) throw new NotFoundException('Obligación a proveedor no encontrada');
      if (soloAnticipo && row.nature !== 'anticipo') throw new NotFoundException('Anticipo no encontrado');
      // `[PGP.126]` El anticipo pedido en la Suite se cancela desde su submódulo: con razón (sus notas son
      // su motivo y la razón queda junto a él) y una sola vez.
      if (row.nature === 'anticipo') {
        if (row.status === 'cancelled') throw new BadRequestException('El anticipo ya estaba cancelado.');
        if (String(reason ?? '').trim().length < 3) throw new BadRequestException('Di por qué se cancela el anticipo (queda en su historia).');
      }
      if (Number(row.reserved_amount) > 0 || Number(row.paid_amount) > 0) {
        throw new BadRequestException('No se puede cancelar: tiene pagos reservados o ejecutados. Reprograma/cancela esos pagos primero.');
      }
      const [updated] = await trx('commercial.supplier_payment_obligations').where({ tenant_id: tenantId, id })
        .update({ status: 'cancelled', notes: reason ? `${row.notes ?? ''}\n${MARCA_CANCELADO}${String(reason).trim()}`.trim() : row.notes, updated_by: username, updated_at: trx.fn.now() })
        .returning('*');
      return updated;
    });
  }

  /**
   * Búsqueda ligera de proveedores para los selectores de *Pago a proveedor*.
   *
   * `[PGP.154]` Sólo ofrece los que existen en el catálogo de proveedores de Kepler (`kdxd`): 547 de
   * los 1,354 activos de `catalog.suppliers` no existen ahí (son los de la importación vieja de
   * líneas) y salían como el mismo proveedor repetido. Cada opción trae su clave y su último
   * movimiento en Kepler (`kdxe`) para distinguir dos fichas con el mismo nombre (`CD004` / `CV10`
   * VUMERSOFT). Las que tienen movimiento van primero. Medido el 2026-11-18: 20–37 ms.
   */
  async searchSuppliers(search?: string): Promise<ProveedorSelectorOpcion[]> {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const mov = trx('kepler_ods.kdxe').select('c2').max({ ultimo: 'c7' }).groupBy('c2').as('m');
      const b = trx('catalog.suppliers as s')
        // `[PGP.155.2]` `btrim` del lado del catálogo, como el resto del repo; NO del lado del ODS (mata el índice: ver
        // `anticipoProveedores`). `kdxd.c2` y `kdxe.c2` llegan limpios (0 con espacios, medido 2026-11-18).
        .leftJoin(mov, function () { this.on('m.c2', '=', trx.raw('btrim(s.code)')); })
        .select('s.id', 's.name', 's.code', 's.is_critical', 's.critical_reason',
          trx.raw(`to_char(m.ultimo, 'YYYY-MM-DD') as ultimo_movimiento`))
        .where('s.activo', true)
        .whereExists(trx('kepler_ods.kdxd as k').select(trx.raw('1')).whereRaw('k.c2 = btrim(s.code)'));
      if (search?.trim()) b.andWhereILike('s.name', `%${search.trim()}%`);
      return b.orderByRaw('m.ultimo is null, s.name').limit(50);
    });
  }

  /**
   * Marca/desmarca un proveedor como crítico, SIEMPRE con motivo — nunca se infiere del importe
   * (regla explícita del pedido). Vive acá (no en `commercial-replenishment.service.ts`, código
   * vivo de RA en producción) para no arriesgar ese archivo bajo este cambio.
   */
  async setSupplierCritical(supplierId: string, isCritical: boolean, reason: string | undefined, username: string) {
    if (isCritical && !reason?.trim()) throw new BadRequestException('Marcar un proveedor como crítico requiere un motivo');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      // NOTA: catalog.suppliers.updated_by es uuid (no texto) — no se toca desde acá, donde
      // solo tenemos el username. El motivo queda igual en critical_reason (auditable).
      const n = await trx('catalog.suppliers').where({ tenant_id: tenantId, id: supplierId })
        .update({ is_critical: isCritical, critical_reason: isCritical ? reason!.trim() : null, updated_at: trx.fn.now() });
      if (!n) throw new NotFoundException('Proveedor no encontrado');
      return trx('catalog.suppliers').where({ tenant_id: tenantId, id: supplierId }).select('id', 'name', 'is_critical', 'critical_reason').first();
    });
  }
}
