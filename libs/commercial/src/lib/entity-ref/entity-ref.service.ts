import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService, Permission } from '@megadulces/platform-core';
import { EntityKind, RefField, RefRelation, RefResult, makeRef, parseRef } from './entity-ref.types';

/**
 * Resolvedor universal de referencias — el backend de "todo es clickeable".
 *
 * Una sola entrada (`resolve(ref)`) que, dado el ref de cualquier registro de la cadena
 * de compra, devuelve SIEMPRE la misma forma: encabezado, campos con su columna de
 * origen, y relaciones que a su vez son refs. El panel del front no sabe de tablas: sabe
 * de refs. Agregar una entidad nueva = un caso más acá, cero cambios en la UI.
 *
 * `analytics.*` NO tiene RLS -> filtro `tenant_id` EXPLICITO en cada query (patrón de la casa).
 * Las fechas salen con `to_char`: son columnas `date` y pg las devuelve como Date en hora
 * local; al serializar a JSON se corren un día en MX. Acá viajan como texto y no hay duda.
 *
 * Permisos: el controller exige un permiso base para entrar, y acá se filtra POR ENTIDAD.
 * Un enlace que el rol no puede abrir no se pinta — mostrarlo y que reviente en 403 es peor
 * que no mostrarlo, y se deja constancia en `notes`.
 */

/** Categorías de ajuste que son beneficio negociado, no un problema (mismo criterio que Compras 360). */
const COMERCIAL_CATS = ['descuento_comercial', 'pronto_pago', 'apoyo_marca'];

/** Permisos que habilitan cada tipo — basta con UNO (any-of). */
const KIND_PERMS: Record<EntityKind, string[]> = {
  ent: [Permission.COMPRAS_360_VER, Permission.COMPRAS_ENTRADAS_VER],
  lin: [Permission.COMPRAS_360_VER, Permission.COMPRAS_ENTRADAS_VER],
  adj: [Permission.COMPRAS_DESCUENTOS_VER],
  pay: [Permission.FINANCE_PAYMENTS_VER],
  prov: [Permission.COMPRAS_PROVEEDORES_VER, Permission.COMPRAS_360_VER, Permission.COMPRAS_ENTRADAS_VER],
  sku: [Permission.COMPRAS_360_VER, Permission.COMPRAS_ENTRADAS_VER],
  pdoc: [Permission.COMPRAS_360_VER, Permission.COMPRAS_ENTRADAS_VER, Permission.COMPRAS_ORDENES_VER],
};

const KIND_LABEL: Record<EntityKind, string> = {
  ent: 'Orden de entrada', lin: 'Renglón', adj: 'Ajuste de compra',
  pay: 'Pago a proveedor', prov: 'Proveedor', sku: 'Producto', pdoc: 'Documento de compra',
};

/** Los dos papeles de arriba de la cadena, que ahora SÍ tienen documento detrás. */
const PDOC_LABEL: Record<string, string> = { XA3501: 'Orden de compra', XA3701: 'Vale de entrada' };

/** Ventana (días) para los vínculos que Kepler no codifica y hay que estimar. */
const HEURISTIC_WINDOW = 30;
/** Tope de filas por bloque de relaciones — el panel es para orientarse, no para exportar. */
const REL_LIMIT = 20;

export interface RefCaller {
  /** Mapa fresco de permisos del rol (lo adjunta RolesGuard al request). */
  perms: Record<string, boolean>;
  /** admin/superadmin de plataforma: pasa todo. */
  isAdmin: boolean;
}

const n = (v: any): number => Number(v) || 0;

@Injectable()
export class EntityRefService {
  private readonly logger = new Logger(EntityRefService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * ¿Está el espejo de OC/vales en ESTA base?
   *
   * La migración que lo crea puede no haber corrido todavía en un ambiente (prod va por
   * delante del código en un deploy, y la cola de knex se traba con facilidad). Sin esta
   * comprobación, la consulta tira 42P01 y se lleva puesta la ficha ENTERA de la entrada
   * —no solo el enlace a la OC—, que es un 500 en la cara del usuario por una tabla que
   * simplemente todavía no existe. Con esto, la ficha abre igual y lo declara en `notes`.
   *
   * Se cachea solo el SÍ: si todavía no está, se vuelve a preguntar (`to_regclass` es
   * trivial) para que aparezca sola en cuanto la migración corra, sin reiniciar la api.
   */
  private purchaseDocsReady = false;
  private async hasPurchaseDocs(trx: any): Promise<boolean> {
    if (this.purchaseDocsReady) return true;
    const [r]: any[] = await trx.select(trx.raw(`to_regclass('analytics.erp_purchase_docs') IS NOT NULL AS ok`));
    this.purchaseDocsReady = r?.ok === true;
    return this.purchaseDocsReady;
  }

  private can(kind: EntityKind, caller: RefCaller): boolean {
    if (caller.isAdmin) return true;
    return KIND_PERMS[kind].some((p) => caller.perms?.[p] === true);
  }

  async resolve(ref: string, caller: RefCaller): Promise<RefResult> {
    const { kind, parts } = parseRef(ref);
    if (!this.can(kind, caller)) {
      throw new ForbiddenException(`Tu rol no puede abrir ${KIND_LABEL[kind].toLowerCase()}.`);
    }
    const tenantId = this.tenantCtx.requireTenantId();
    const out = await this.tk.run(async (trx: any) => {
      switch (kind) {
        case 'ent': return this.entrada(trx, tenantId, parts[0], parts[1], parts[2]);
        case 'lin': return this.linea(trx, tenantId, parts[0], parts[1], parts[2]);
        case 'adj': return this.ajuste(trx, tenantId, parts[0], parts[1], parts[2]);
        case 'pay': return this.pago(trx, tenantId, parts[0], parts[1], parts[2]);
        case 'prov': return this.proveedor(trx, tenantId, parts[0]);
        case 'pdoc': return this.purchaseDoc(trx, tenantId, parts[0], parts[1], parts[2]);
        default: return this.producto(trx, tenantId, parts[0]);
      }
    });
    return this.applyPerms({ ...out, ref, kind }, caller);
  }

  /** Saca del panel los enlaces que este rol no puede abrir, y lo dice al pie. */
  private applyPerms(r: RefResult, caller: RefCaller): RefResult {
    if (caller.isAdmin) return r;
    // Array + indexOf en vez de Set: el bundle de la api pasa por webpack, y ahí el
    // spread de un Set se downlevelea mal (queda `[Set]` en vez de sus elementos).
    const blocked: string[] = [];
    const relations = r.relations.filter((rel) => {
      const k = String(rel.ref.split(':')[0]) as EntityKind;
      if (this.can(k, caller)) return true;
      const label = KIND_LABEL[k] ?? k;
      if (blocked.indexOf(label) < 0) blocked.push(label);
      return false;
    });
    const notes = r.notes.slice();
    if (blocked.length) notes.push(`Se ocultaron enlaces que tu rol no puede abrir: ${blocked.join(', ').toLowerCase()}.`);
    return { ...r, relations, notes };
  }

  // -- Entrada (analytics.erp_goods_receipts) --------------------------------
  private async entrada(trx: any, tenantId: string, sucursal: string, docPrefix: string, folio: string): Promise<RefResult> {
    const [e]: any[] = await trx('analytics.erp_goods_receipts')
      .select('sucursal', 'folio', 'doc_prefix', 'proveedor_code', 'proveedor_nombre', 'proveedor_rfc',
        'oc_folio', 'vale_folio', 'concepto', 'monto', 'source_branch', 'dup_of_sucursal', 'dup_of_folio',
        trx.raw(`to_char(receipt_date,'YYYY-MM-DD') AS receipt_date`))
      .where({ tenant_id: tenantId, sucursal, doc_prefix: docPrefix, folio })
      .limit(1);
    if (!e) throw new NotFoundException(`No existe la orden de entrada ${sucursal}/${folio}.`);

    const fields: RefField[] = [
      { label: 'Fecha', value: e.receipt_date, kind: 'date', source: 'erp_goods_receipts.receipt_date' },
      { label: 'Sucursal', value: e.sucursal, kind: 'mono' },
      { label: 'Documento', value: `${e.doc_prefix} ${e.folio}`, kind: 'mono', source: 'kdm1 (Aplica Orden Entrada)' },
      { label: 'Proveedor', value: e.proveedor_nombre || e.proveedor_code },
      { label: 'RFC', value: e.proveedor_rfc, kind: 'mono' },
      { label: 'OC', value: e.oc_folio, kind: 'mono', source: 'X-A-35' },
      { label: 'Vale', value: e.vale_folio, kind: 'mono', source: 'X-A-37' },
      { label: 'Concepto', value: e.concepto },
      { label: 'Total compra', value: n(e.monto), kind: 'money', source: 'kdm1.c16 (con IVA)' },
      { label: 'Origen del feed', value: e.source_branch, kind: 'mono' },
    ];

    const notes: string[] = [];
    const relations: RefRelation[] = [];

    if (e.proveedor_code) {
      relations.push({ ref: makeRef('prov', e.proveedor_code), group: 'Proveedor',
        label: e.proveedor_nombre || e.proveedor_code, sub: e.proveedor_rfc || e.proveedor_code });
    }
    // ER.7 — la OC y el vale ya son documentos, no texto. Se resuelven contra el espejo
    // (misma sucursal) y solo se ofrece el enlace si la fila EXISTE: un enlace muerto es
    // peor que ningún enlace.
    const pdocsReady = await this.hasPurchaseDocs(trx);
    if (!pdocsReady && (e.oc_folio || e.vale_folio)) {
      notes.push('El espejo de órdenes de compra y vales todavía no está en esta base (falta correr su importer/migración), así que la OC y el vale se muestran como texto y no se pueden abrir.');
    }
    for (const [folio, doctype, group] of pdocsReady ? [
      [e.oc_folio, 'XA3501', 'Orden de compra'],
      [e.vale_folio, 'XA3701', 'Vale de entrada'],
    ] as [string | null, string, string][] : []) {
      if (!folio) continue;
      const [d]: any[] = await trx('analytics.erp_purchase_docs')
        .select('folio', 'monto', trx.raw(`to_char(doc_date,'YYYY-MM-DD') AS doc_date`))
        .where({ tenant_id: tenantId, doctype, sucursal, folio }).limit(1);
      if (d) {
        relations.push({ ref: makeRef('pdoc', doctype, sucursal, folio), group,
          label: `${group} ${folio}`, sub: d.doc_date, amount: n(d.monto) });
      } else {
        notes.push(`El folio ${folio} de ${group.toLowerCase()} no está en el espejo de documentos de compra — puede ser de otra sucursal o faltar en el feed.`);
      }
    }

    // Renglones (kdm2) — cada uno con su ref.
    const lineas: any[] = await trx('analytics.erp_goods_receipt_lines')
      .select('linea', 'sku', 'nombre', 'cantidad', 'unidad', 'costo_unitario', 'importe')
      .where({ tenant_id: tenantId, sucursal, folio })
      .orderByRaw('linea::text ASC').limit(REL_LIMIT);
    const [agg]: any[] = await trx('analytics.erp_goods_receipt_lines')
      .where({ tenant_id: tenantId, sucursal, folio })
      .select(trx.raw('count(*)::int AS nlin'), trx.raw('COALESCE(sum(importe),0)::numeric AS sumlin'));
    for (const l of lineas) {
      relations.push({ ref: makeRef('lin', sucursal, folio, l.linea), group: 'Renglones',
        label: l.nombre || l.sku || `Renglón ${l.linea}`,
        sub: `${l.sku ?? 's/SKU'} · ${n(l.cantidad)} ${l.unidad ?? ''}`.trim(), amount: n(l.importe) });
    }
    if (n(agg?.nlin) > REL_LIMIT) notes.push(`Se listan ${REL_LIMIT} de ${n(agg.nlin)} renglones.`);
    if (n(agg?.nlin) > 0) {
      fields.push({ label: 'Σ renglones (subtotal)', value: n(agg.sumlin), kind: 'money', source: 'Σ erp_goods_receipt_lines.importe' });
      fields.push({ label: 'Renglones', value: n(agg.nlin), kind: 'qty' });
    }

    // Ajustes: primero los ligados por folio exacto; si no hay, la ventana heurística.
    const exactos: any[] = await trx('analytics.erp_purchase_adjustments')
      .select('doctype', 'sucursal', 'folio', 'monto', 'motivo', 'categoria',
        trx.raw(`to_char(adjustment_date,'YYYY-MM-DD') AS adjustment_date`))
      .where({ tenant_id: tenantId, entrada_folio: folio }).orderBy('adjustment_date', 'desc').limit(REL_LIMIT);
    for (const a of exactos) {
      relations.push({ ref: makeRef('adj', a.doctype, a.sucursal, a.folio), group: 'Ajustes ligados',
        label: a.categoria || a.motivo || a.doctype, sub: `${a.doctype} · ${a.adjustment_date ?? ''}`.trim(),
        amount: n(a.monto), date: a.adjustment_date });
    }
    if (!exactos.length && e.proveedor_code && e.receipt_date) {
      const cerca: any[] = await trx('analytics.erp_purchase_adjustments')
        .select('doctype', 'sucursal', 'folio', 'monto', 'motivo', 'categoria',
          trx.raw(`to_char(adjustment_date,'YYYY-MM-DD') AS adjustment_date`))
        .where({ tenant_id: tenantId, proveedor_code: e.proveedor_code })
        .whereRaw(`adjustment_date BETWEEN ?::date - INTERVAL '15 days' AND ?::date + INTERVAL '15 days'`, [e.receipt_date, e.receipt_date])
        .orderBy('adjustment_date', 'desc').limit(REL_LIMIT);
      for (const a of cerca) {
        relations.push({ ref: makeRef('adj', a.doctype, a.sucursal, a.folio), group: 'Ajustes cercanos (estimado)',
          label: a.categoria || a.motivo || a.doctype, sub: `${a.doctype} · ${a.adjustment_date ?? ''}`.trim(),
          amount: n(a.monto), date: a.adjustment_date, heuristic: true });
      }
      if (cerca.length) notes.push('Los ajustes cercanos se listan por proveedor y ventana de ±15 días: Kepler no liga la nota a la entrada, así que el vínculo es una estimación.');
    }

    // Pago: sin liga estructural (RE.8). Se declara como candidato, nunca como "el pago".
    if (e.proveedor_code && e.receipt_date) {
      const pagos: any[] = await trx('analytics.erp_supplier_payments')
        .select('sucursal', 'folio', 'doc_prefix', 'monto', 'metodo_pago',
          trx.raw(`to_char(pago_date,'YYYY-MM-DD') AS pago_date`))
        .where({ tenant_id: tenantId, proveedor_code: e.proveedor_code })
        .whereRaw(`pago_date BETWEEN ?::date AND ?::date + (? || ' days')::interval`, [e.receipt_date, e.receipt_date, HEURISTIC_WINDOW])
        .orderBy('pago_date', 'asc').limit(REL_LIMIT);
      for (const p of pagos) {
        relations.push({ ref: makeRef('pay', p.sucursal, p.doc_prefix, p.folio), group: 'Pagos candidatos (estimado)',
          label: `${p.metodo_pago ?? 'pago'} ${p.folio}`, sub: p.pago_date, amount: n(p.monto), date: p.pago_date, heuristic: true });
      }
      if (pagos.length) notes.push(`Kepler no liga el pago (X-D-26) a la recepción. Se listan los pagos del mismo proveedor dentro de ${HEURISTIC_WINDOW} días — hay que confirmarlo a mano.`);
    }

    // Copia CEDIS (RE.12): misma recepción, otra póliza.
    const twins: any[] = await trx('analytics.erp_goods_receipts')
      .select('sucursal', 'folio', 'doc_prefix', 'monto', trx.raw(`to_char(receipt_date,'YYYY-MM-DD') AS receipt_date`))
      .where({ tenant_id: tenantId, dup_of_sucursal: sucursal, dup_of_folio: folio }).limit(REL_LIMIT);
    for (const t of twins) {
      relations.push({ ref: makeRef('ent', t.sucursal, t.doc_prefix, t.folio), group: 'Copia CEDIS',
        label: `${t.sucursal}/${t.folio}`, sub: t.receipt_date, amount: n(t.monto) });
    }
    if (e.dup_of_folio) {
      relations.push({ ref: makeRef('ent', e.dup_of_sucursal, 'XA2001', e.dup_of_folio), group: 'Recepción canónica',
        label: `${e.dup_of_sucursal}/${e.dup_of_folio}`, sub: 'Esta fila es la copia CEDIS' });
      notes.push('Este registro es la copia CEDIS de otra recepción: la canónica es la de la sucursal.');
    }

    return {
      ref: '', kind: 'ent',
      title: `Entrada ${e.folio}`,
      subtitle: `${e.sucursal} · ${e.proveedor_nombre || e.proveedor_code || 's/proveedor'}`,
      badges: [
        { text: e.doc_prefix, tone: 'muted', title: 'Tipo de documento en Kepler' },
        ...(e.dup_of_folio ? [{ text: 'Copia CEDIS', tone: 'warn' as const }] : []),
      ],
      fields, relations, notes,
    };
  }

  // -- Renglón (analytics.erp_goods_receipt_lines) ---------------------------
  private async linea(trx: any, tenantId: string, sucursal: string, folio: string, linea: string): Promise<RefResult> {
    const [l]: any[] = await trx('analytics.erp_goods_receipt_lines')
      .select('linea', 'sku', 'nombre', 'cantidad', 'unidad', 'costo_unitario', 'importe')
      .where({ tenant_id: tenantId, sucursal, folio, linea }).limit(1);
    if (!l) throw new NotFoundException(`No existe el renglón ${linea} de ${sucursal}/${folio}.`);

    const relations: RefRelation[] = [
      { ref: makeRef('ent', sucursal, 'XA2001', folio), group: 'Documento', label: `Entrada ${folio}`, sub: `Sucursal ${sucursal}` },
    ];
    const notes: string[] = [];

    if (l.sku) {
      relations.push({ ref: makeRef('sku', l.sku), group: 'Producto', label: l.nombre || l.sku, sub: l.sku });
      // Últimas compras del mismo SKU: para saber si el costo de este renglón está fuera de línea.
      const otras: any[] = await trx('analytics.erp_goods_receipt_lines as gl')
        .join('analytics.erp_goods_receipts as g', function (this: any) {
          this.on('g.tenant_id', 'gl.tenant_id').andOn('g.sucursal', 'gl.sucursal').andOn('g.folio', 'gl.folio');
        })
        .select('gl.sucursal', 'gl.folio', 'gl.linea', 'gl.costo_unitario', 'gl.cantidad', 'g.proveedor_nombre',
          trx.raw(`to_char(g.receipt_date,'YYYY-MM-DD') AS receipt_date`))
        .where('gl.tenant_id', tenantId).where('gl.sku', l.sku)
        .whereNot((w: any) => w.where('gl.sucursal', sucursal).andWhere('gl.folio', folio))
        .orderBy('g.receipt_date', 'desc').limit(10);
      for (const o of otras) {
        relations.push({ ref: makeRef('lin', o.sucursal, o.folio, o.linea), group: 'Otras compras del mismo producto',
          label: `${o.receipt_date ?? ''} · ${o.proveedor_nombre ?? ''}`.trim(),
          sub: `costo ${n(o.costo_unitario).toFixed(4)} · ${n(o.cantidad)} pz`, amount: n(o.costo_unitario), date: o.receipt_date });
      }
    } else {
      notes.push('El renglón no trae SKU: no se puede abrir el producto ni comparar el costo contra otras compras.');
    }

    return {
      ref: '', kind: 'lin',
      title: l.nombre || l.sku || `Renglón ${l.linea}`,
      subtitle: `Entrada ${folio} · renglón ${l.linea}`,
      badges: l.sku ? [{ text: l.sku, tone: 'muted' }] : [{ text: 'Sin SKU', tone: 'warn' }],
      fields: [
        { label: 'SKU', value: l.sku, kind: 'mono', source: 'kdm2.c3' },
        { label: 'Descripción', value: l.nombre },
        { label: 'Cantidad', value: n(l.cantidad), kind: 'qty', source: 'kdm2.c8' },
        { label: 'Unidad', value: l.unidad, kind: 'mono' },
        { label: 'Costo unitario', value: n(l.costo_unitario), kind: 'money', source: 'kdm2.c9' },
        { label: 'Importe', value: n(l.importe), kind: 'money', source: 'cantidad × costo' },
      ],
      relations, notes,
    };
  }

  // -- Ajuste (analytics.erp_purchase_adjustments) ---------------------------
  private async ajuste(trx: any, tenantId: string, doctype: string, sucursal: string, folio: string): Promise<RefResult> {
    const [a]: any[] = await trx('analytics.erp_purchase_adjustments')
      .select('doctype', 'sucursal', 'folio', 'proveedor_code', 'proveedor_nombre', 'proveedor_rfc',
        'factura_ref', 'entrada_folio', 'monto', 'iva', 'motivo', 'categoria', 'categoria_source', 'source_branch',
        trx.raw(`to_char(adjustment_date,'YYYY-MM-DD') AS adjustment_date`))
      .where({ tenant_id: tenantId, doctype, sucursal, folio }).limit(1);
    if (!a) throw new NotFoundException(`No existe el ajuste ${doctype} ${sucursal}/${folio}.`);

    const esComercial = COMERCIAL_CATS.includes(String(a.categoria || ''));
    const relations: RefRelation[] = [];
    const notes: string[] = [];

    if (a.proveedor_code) {
      relations.push({ ref: makeRef('prov', a.proveedor_code), group: 'Proveedor',
        label: a.proveedor_nombre || a.proveedor_code, sub: a.proveedor_rfc || a.proveedor_code });
    }
    if (a.entrada_folio) {
      const [e]: any[] = await trx('analytics.erp_goods_receipts')
        .select('sucursal', 'folio', 'doc_prefix', 'monto', trx.raw(`to_char(receipt_date,'YYYY-MM-DD') AS receipt_date`))
        .where({ tenant_id: tenantId, folio: a.entrada_folio }).limit(1);
      if (e) {
        relations.push({ ref: makeRef('ent', e.sucursal, e.doc_prefix, e.folio), group: 'Entrada ligada',
          label: `Entrada ${e.folio}`, sub: `${e.sucursal} · ${e.receipt_date ?? ''}`.trim(), amount: n(e.monto) });
      } else {
        notes.push(`El ajuste apunta a la entrada ${a.entrada_folio}, que no está en el feed de recepciones.`);
      }
    } else {
      notes.push('El ajuste no trae folio de entrada: Kepler no lo ligó a ninguna recepción.');
    }

    return {
      ref: '', kind: 'adj',
      title: `${doctype === 'XD55' ? 'Nota de crédito' : 'Devolución'} ${a.folio}`,
      subtitle: `${a.sucursal} · ${a.proveedor_nombre || a.proveedor_code || ''}`,
      badges: [
        { text: doctype, tone: 'muted' },
        { text: esComercial ? 'Comercial' : 'Operativo', tone: esComercial ? 'ok' : 'warn',
          title: esComercial ? 'Beneficio negociado (descuento, pronto pago, apoyo de marca)' : 'Algo salió mal (faltante, mal estado, factura duplicada…)' },
      ],
      fields: [
        { label: 'Fecha', value: a.adjustment_date, kind: 'date', source: 'erp_purchase_adjustments.adjustment_date' },
        { label: 'Tipo', value: doctype === 'XD55' ? 'X-D-55 Nota de crédito' : 'X-D-40 Devolución de compra', kind: 'mono' },
        { label: 'Motivo', value: a.motivo, source: 'kdm1.c24' },
        { label: 'Categoría', value: a.categoria, source: `clasificación ${a.categoria_source ?? 'n/d'}` },
        { label: 'Monto', value: n(a.monto), kind: 'money' },
        { label: 'IVA', value: n(a.iva), kind: 'money' },
        { label: 'Factura ref.', value: a.factura_ref, kind: 'mono' },
        { label: 'Entrada ligada', value: a.entrada_folio, kind: 'mono' },
      ],
      relations, notes,
    };
  }

  // -- Pago (analytics.erp_supplier_payments) --------------------------------
  private async pago(trx: any, tenantId: string, sucursal: string, docPrefix: string, folio: string): Promise<RefResult> {
    const [p]: any[] = await trx('analytics.erp_supplier_payments')
      .select('sucursal', 'folio', 'doc_prefix', 'proveedor_code', 'proveedor_nombre', 'proveedor_rfc',
        'concepto', 'monto', 'metodo_pago', 'descuento', 'source_branch',
        trx.raw(`to_char(pago_date,'YYYY-MM-DD') AS pago_date`))
      .where({ tenant_id: tenantId, sucursal, doc_prefix: docPrefix, folio }).limit(1);
    if (!p) throw new NotFoundException(`No existe el pago ${docPrefix} ${sucursal}/${folio}.`);

    const relations: RefRelation[] = [];
    const notes = ['Kepler no liga el pago a la recepción. Las entradas de abajo son las del mismo proveedor en la ventana previa — candidatas, no confirmadas.'];

    if (p.proveedor_code) {
      relations.push({ ref: makeRef('prov', p.proveedor_code), group: 'Proveedor',
        label: p.proveedor_nombre || p.proveedor_code, sub: p.proveedor_rfc || p.proveedor_code });
      if (p.pago_date) {
        const ents: any[] = await trx('analytics.erp_goods_receipts')
          .select('sucursal', 'folio', 'doc_prefix', 'monto', trx.raw(`to_char(receipt_date,'YYYY-MM-DD') AS receipt_date`))
          .where({ tenant_id: tenantId, proveedor_code: p.proveedor_code })
          .whereRaw(`dup_of_folio IS NULL`)
          .whereRaw(`receipt_date BETWEEN ?::date - (? || ' days')::interval AND ?::date`, [p.pago_date, HEURISTIC_WINDOW * 3, p.pago_date])
          .orderBy('receipt_date', 'desc').limit(REL_LIMIT);
        for (const e of ents) {
          relations.push({ ref: makeRef('ent', e.sucursal, e.doc_prefix, e.folio), group: 'Entradas candidatas (estimado)',
            label: `Entrada ${e.folio}`, sub: `${e.sucursal} · ${e.receipt_date ?? ''}`.trim(), amount: n(e.monto), date: e.receipt_date, heuristic: true });
        }
      }
    }

    return {
      ref: '', kind: 'pay',
      title: `Pago ${p.folio}`,
      subtitle: `${p.metodo_pago ?? ''} · ${p.proveedor_nombre || p.proveedor_code || ''}`.trim(),
      badges: [{ text: p.doc_prefix, tone: 'muted' }, { text: p.metodo_pago ?? 'n/d', tone: 'info' }],
      fields: [
        { label: 'Fecha', value: p.pago_date, kind: 'date' },
        { label: 'Método', value: p.metodo_pago, source: 'kdmm.c31' },
        { label: 'Monto', value: n(p.monto), kind: 'money' },
        { label: 'Descuento aplicado', value: n(p.descuento), kind: 'money', source: 'kdmm.c84 (pronto pago)' },
        { label: 'Concepto', value: p.concepto },
        { label: 'Sucursal', value: p.sucursal, kind: 'mono' },
      ],
      relations, notes,
    };
  }

  // -- Proveedor (agregado sobre analytics.erp_*) ----------------------------
  private async proveedor(trx: any, tenantId: string, code: string): Promise<RefResult> {
    const [g]: any[] = await trx('analytics.erp_goods_receipts')
      .select(trx.raw(`(array_agg(proveedor_nombre ORDER BY receipt_date DESC NULLS LAST))[1] AS nombre`),
        trx.raw(`(array_agg(proveedor_rfc ORDER BY receipt_date DESC NULLS LAST))[1] AS rfc`),
        trx.raw(`count(*)::int AS n_entradas`), trx.raw(`COALESCE(sum(monto),0)::numeric AS compras`),
        trx.raw(`to_char(min(receipt_date),'YYYY-MM-DD') AS primera`),
        trx.raw(`to_char(max(receipt_date),'YYYY-MM-DD') AS ultima`))
      .where({ tenant_id: tenantId, proveedor_code: code }).whereRaw('dup_of_folio IS NULL');
    const [aj]: any[] = await trx('analytics.erp_purchase_adjustments')
      .select(trx.raw(`count(*)::int AS n`), trx.raw(`COALESCE(sum(monto),0)::numeric AS total`),
        trx.raw(`COALESCE(sum(monto) FILTER (WHERE categoria = ANY(?)),0)::numeric AS comercial`, [COMERCIAL_CATS]),
        trx.raw(`COALESCE(sum(monto) FILTER (WHERE categoria IS NULL OR NOT (categoria = ANY(?))),0)::numeric AS operativo`, [COMERCIAL_CATS]))
      .where({ tenant_id: tenantId, proveedor_code: code });
    const [pg]: any[] = await trx('analytics.erp_supplier_payments')
      .select(trx.raw(`count(*)::int AS n`), trx.raw(`COALESCE(sum(monto),0)::numeric AS total`),
        trx.raw(`COALESCE(sum(descuento),0)::numeric AS descuento`))
      .where({ tenant_id: tenantId, proveedor_code: code });

    if (!n(g?.n_entradas) && !n(aj?.n) && !n(pg?.n)) {
      throw new NotFoundException(`No hay movimientos del proveedor ${code}.`);
    }
    const nombre = g?.nombre || code;
    const rfc: string | null = g?.rfc || null;

    const [pol]: any[] = await trx('commercial.supplier_discount_policy')
      .select('expected_discount_rate', 'discount_days', 'discount_type', 'source', 'active')
      .where({ tenant_id: tenantId, proveedor_code: code }).limit(1);

    const notes: string[] = [];
    const badges: RefResult['badges'] = [{ text: code, tone: 'muted' }];

    // Listas negras del SAT (69-B). Solo se puede chequear si el feed trae RFC.
    if (rfc) {
      const listas: any[] = await trx('fiscal.sat_list_rfcs')
        .select('lista', 'situacion', trx.raw(`to_char(fecha_publicacion,'YYYY-MM-DD') AS fecha_publicacion`))
        .where('rfc', rfc).limit(5);
      for (const l of listas) {
        badges.push({ text: `${l.lista}${l.situacion ? ' · ' + l.situacion : ''}`, tone: 'danger',
          title: `Publicado ${l.fecha_publicacion ?? 's/f'}` });
      }
    } else {
      notes.push('El proveedor no trae RFC en el feed: no se pudo revisar contra las listas del SAT (69-B).');
    }

    const fields: RefField[] = [
      { label: 'Código', value: code, kind: 'mono', source: 'kdm1.c10 (contabilidad)' },
      { label: 'RFC', value: rfc, kind: 'mono' },
      { label: 'Compras acumuladas', value: n(g?.compras), kind: 'money', source: 'Σ erp_goods_receipts.monto' },
      { label: 'Recepciones', value: n(g?.n_entradas), kind: 'qty' },
      { label: 'Primera compra', value: g?.primera ?? null, kind: 'date' },
      { label: 'Última compra', value: g?.ultima ?? null, kind: 'date' },
      { label: 'Ajustes (total)', value: n(aj?.total), kind: 'money', source: `${n(aj?.n)} documentos X-D-40/55` },
      { label: 'Ajuste comercial', value: n(aj?.comercial), kind: 'money' },
      { label: 'Ajuste operativo', value: n(aj?.operativo), kind: 'money' },
      { label: 'Pagado', value: n(pg?.total), kind: 'money', source: `${n(pg?.n)} pagos X-D-26/25/60` },
      { label: 'Descuento por pronto pago', value: n(pg?.descuento), kind: 'money', source: 'Σ kdmm.c84' },
    ];
    if (pol) {
      fields.push({ label: 'Descuento esperado', value: n(pol.expected_discount_rate), kind: 'pct',
        source: `política ${pol.source ?? ''} ${pol.active ? '' : '(inactiva)'}`.trim() });
      if (pol.discount_days != null) fields.push({ label: 'Días de descuento', value: n(pol.discount_days), kind: 'qty' });
    }

    // El catálogo de compras (lead time, mínimo en cajas) vive en OTRO espacio de códigos
    // — verificado: 0 de 328 proveedores de movimientos empatan con catalog.suppliers.code.
    // Decirlo es más útil que inventar un cruce por nombre.
    notes.push('Tiempo de entrega y mínimo de pedido no se muestran acá: viven en el catálogo de compras, que usa otro código de proveedor (el de inventario) y todavía no tiene crosswalk con el código contable de los movimientos.');

    const relations: RefRelation[] = [];
    const ents: any[] = await trx('analytics.erp_goods_receipts')
      .select('sucursal', 'folio', 'doc_prefix', 'monto', trx.raw(`to_char(receipt_date,'YYYY-MM-DD') AS receipt_date`))
      .where({ tenant_id: tenantId, proveedor_code: code }).whereRaw('dup_of_folio IS NULL')
      .orderBy('receipt_date', 'desc').limit(REL_LIMIT);
    for (const e of ents) {
      relations.push({ ref: makeRef('ent', e.sucursal, e.doc_prefix, e.folio), group: 'Últimas recepciones',
        label: `Entrada ${e.folio}`, sub: `${e.sucursal} · ${e.receipt_date ?? ''}`.trim(), amount: n(e.monto), date: e.receipt_date });
    }
    const ajs: any[] = await trx('analytics.erp_purchase_adjustments')
      .select('doctype', 'sucursal', 'folio', 'monto', 'motivo', 'categoria', trx.raw(`to_char(adjustment_date,'YYYY-MM-DD') AS adjustment_date`))
      .where({ tenant_id: tenantId, proveedor_code: code }).orderBy('adjustment_date', 'desc').limit(REL_LIMIT);
    for (const a of ajs) {
      relations.push({ ref: makeRef('adj', a.doctype, a.sucursal, a.folio), group: 'Ajustes',
        label: a.categoria || a.motivo || a.doctype, sub: `${a.doctype} · ${a.adjustment_date ?? ''}`.trim(),
        amount: n(a.monto), date: a.adjustment_date });
    }
    const pays: any[] = await trx('analytics.erp_supplier_payments')
      .select('sucursal', 'folio', 'doc_prefix', 'monto', 'metodo_pago', trx.raw(`to_char(pago_date,'YYYY-MM-DD') AS pago_date`))
      .where({ tenant_id: tenantId, proveedor_code: code }).orderBy('pago_date', 'desc').limit(REL_LIMIT);
    for (const p of pays) {
      relations.push({ ref: makeRef('pay', p.sucursal, p.doc_prefix, p.folio), group: 'Pagos',
        label: `${p.metodo_pago ?? 'pago'} ${p.folio}`, sub: p.pago_date, amount: n(p.monto), date: p.pago_date });
    }

    return { ref: '', kind: 'prov', title: nombre, subtitle: rfc || code, badges, fields, relations, notes };
  }

  // -- OC / Vale (analytics.erp_purchase_docs) -------------------------------
  private async purchaseDoc(trx: any, tenantId: string, doctype: string, sucursal: string, folio: string): Promise<RefResult> {
    if (!(await this.hasPurchaseDocs(trx))) {
      throw new NotFoundException('El espejo de órdenes de compra y vales todavía no existe en esta base — falta correr su migración e importer.');
    }
    const [d]: any[] = await trx('analytics.erp_purchase_docs')
      .select('doctype', 'sucursal', 'folio', 'proveedor_code', 'proveedor_nombre', 'proveedor_rfc',
        'concepto', 'condicion_pago', 'referencia', 'monto', 'ref_doctype', 'ref_folio', 'source_branch',
        trx.raw(`to_char(doc_date,'YYYY-MM-DD') AS doc_date`),
        trx.raw(`to_char(due_date,'YYYY-MM-DD') AS due_date`))
      .where({ tenant_id: tenantId, doctype, sucursal, folio }).limit(1);
    const kindLabel = PDOC_LABEL[doctype] ?? 'Documento de compra';
    if (!d) throw new NotFoundException(`No existe ${kindLabel.toLowerCase()} ${sucursal}/${folio}.`);

    const notes: string[] = [];
    const relations: RefRelation[] = [];

    if (d.proveedor_code) {
      relations.push({ ref: makeRef('prov', d.proveedor_code), group: 'Proveedor',
        label: d.proveedor_nombre || d.proveedor_code, sub: d.proveedor_rfc || d.proveedor_code });
    }

    // Hacia arriba: el vale apunta a SU orden de compra (liga estructural c37/c39, no estimada).
    if (d.ref_folio && d.ref_doctype === '35') {
      const [oc]: any[] = await trx('analytics.erp_purchase_docs')
        .select('folio', 'monto', trx.raw(`to_char(doc_date,'YYYY-MM-DD') AS doc_date`))
        .where({ tenant_id: tenantId, doctype: 'XA3501', sucursal, folio: d.ref_folio }).limit(1);
      if (oc) {
        relations.push({ ref: makeRef('pdoc', 'XA3501', sucursal, oc.folio), group: 'Orden de compra',
          label: `Orden de compra ${oc.folio}`, sub: oc.doc_date, amount: n(oc.monto) });
      } else {
        notes.push(`El vale apunta a la orden de compra ${d.ref_folio}, que no está en el espejo.`);
      }
    }

    // Hacia abajo: los vales que aterrizaron esta OC.
    if (doctype === 'XA3501') {
      const vales: any[] = await trx('analytics.erp_purchase_docs')
        .select('folio', 'monto', trx.raw(`to_char(doc_date,'YYYY-MM-DD') AS doc_date`))
        .where({ tenant_id: tenantId, doctype: 'XA3701', sucursal, ref_folio: folio })
        .orderBy('doc_date', 'asc').limit(REL_LIMIT);
      for (const v of vales) {
        relations.push({ ref: makeRef('pdoc', 'XA3701', sucursal, v.folio), group: 'Vales de esta orden',
          label: `Vale ${v.folio}`, sub: v.doc_date, amount: n(v.monto) });
      }
      if (!vales.length) notes.push('Ningún vale de entrada referencia esta orden de compra: puede estar pendiente de recibir, o haberse cancelado.');
    }

    // Las recepciones que citan este documento — cierra la cadena hasta el papel firmado.
    const col = doctype === 'XA3501' ? 'oc_folio' : 'vale_folio';
    const ents: any[] = await trx('analytics.erp_goods_receipts')
      .select('sucursal', 'folio', 'doc_prefix', 'monto', trx.raw(`to_char(receipt_date,'YYYY-MM-DD') AS receipt_date`))
      .where({ tenant_id: tenantId, sucursal }).where(col, folio)
      .orderBy('receipt_date', 'desc').limit(REL_LIMIT);
    let recibido = 0;
    for (const e of ents) {
      recibido += n(e.monto);
      relations.push({ ref: makeRef('ent', e.sucursal, e.doc_prefix, e.folio), group: 'Recepciones',
        label: `Entrada ${e.folio}`, sub: e.receipt_date, amount: n(e.monto), date: e.receipt_date });
    }

    // Renglones: el salto útil es al producto, no a una ficha del renglón de la OC.
    const lineas: any[] = await trx('analytics.erp_purchase_doc_lines')
      .select('linea', 'sku', 'nombre', 'cantidad', 'unidad', 'costo_unitario', 'importe')
      .where({ tenant_id: tenantId, doctype, sucursal, folio })
      .orderByRaw('linea::text ASC').limit(REL_LIMIT);
    const [lagg]: any[] = await trx('analytics.erp_purchase_doc_lines')
      .where({ tenant_id: tenantId, doctype, sucursal, folio })
      .select(trx.raw('count(*)::int AS nlin'), trx.raw('COALESCE(sum(importe),0)::numeric AS sumlin'));
    for (const l of lineas) {
      if (!l.sku) continue;
      relations.push({ ref: makeRef('sku', l.sku), group: 'Lo que se pidió',
        label: l.nombre || l.sku, sub: `${n(l.cantidad)} ${l.unidad ?? ''} × ${n(l.costo_unitario).toFixed(4)}`.trim(), amount: n(l.importe) });
    }
    if (n(lagg?.nlin) > REL_LIMIT) notes.push(`Se listan ${REL_LIMIT} de ${n(lagg.nlin)} renglones.`);

    const fields: RefField[] = [
      { label: 'Fecha', value: d.doc_date, kind: 'date', source: 'kdm1.c9' },
      { label: 'Vence', value: d.due_date, kind: 'date', source: 'kdm1.c18' },
      { label: 'Sucursal', value: d.sucursal, kind: 'mono' },
      { label: 'Proveedor', value: d.proveedor_nombre || d.proveedor_code },
      { label: 'RFC', value: d.proveedor_rfc, kind: 'mono' },
      { label: 'Condición de pago', value: d.condicion_pago, source: 'kdm1.c30' },
      { label: 'Referencia', value: d.referencia, kind: 'mono', source: 'kdm1.c11' },
      { label: 'Concepto', value: d.concepto },
      { label: 'Importe del documento', value: n(d.monto), kind: 'money', source: 'kdm1.c16' },
      { label: 'Renglones', value: n(lagg?.nlin), kind: 'qty' },
      { label: 'Σ renglones', value: n(lagg?.sumlin), kind: 'money', source: 'Σ erp_purchase_doc_lines.importe' },
      { label: 'Origen del feed', value: d.source_branch, kind: 'mono' },
    ];

    // Pedido vs recibido: la razón de ser de poder abrir la OC. Solo cuando hay recepciones
    // ligadas; el avance se calcula sobre IMPORTES, que es lo que se puede comparar sin
    // resolver unidades (una OC en cajas y una entrada en piezas no se restan).
    const badges: RefResult['badges'] = [{ text: kindLabel, tone: 'muted' }];
    if (ents.length) {
      fields.push({ label: 'Recibido contra este documento', value: recibido, kind: 'money', source: `${ents.length} recepción(es)` });
      const pct = n(d.monto) ? (recibido / n(d.monto)) * 100 : 0;
      const cerrado = Math.abs(recibido - n(d.monto)) <= 1;
      badges.push({ text: cerrado ? 'Surtida' : `${pct.toFixed(0)}% surtido`,
        tone: cerrado ? 'ok' : (pct > 100 ? 'danger' : 'warn'),
        title: `Recibido ${recibido.toFixed(2)} contra ${n(d.monto).toFixed(2)} del documento` });
      if (pct > 100) notes.push('Se recibió MÁS de lo que dice el documento. Puede ser una recepción parcial mal ligada, o una entrega de más que nadie ajustó.');
      notes.push('El avance compara IMPORTES, no piezas: el documento y la recepción pueden estar en unidades distintas (caja vs pieza) y restarlas daría un número falso.');
    }

    return {
      ref: '', kind: 'pdoc',
      title: `${kindLabel} ${d.folio}`,
      subtitle: `${d.sucursal} · ${d.proveedor_nombre || d.proveedor_code || 's/proveedor'}`,
      badges, fields, relations, notes,
    };
  }

  // -- Producto (inventory.products + compras) -------------------------------
  private async producto(trx: any, tenantId: string, sku: string): Promise<RefResult> {
    const [p]: any[] = await trx('inventory.products')
      .select('sku', 'nombre', 'descripcion', 'categoria', 'subfamilia', 'codigo_barras',
        'unidad_compra', 'unidad_venta', 'factor_compra', 'factor_venta')
      .where('sku', sku).limit(1);

    const [c]: any[] = await trx('analytics.erp_goods_receipt_lines')
      .select(trx.raw(`count(*)::int AS n`), trx.raw(`COALESCE(sum(cantidad),0)::numeric AS piezas`),
        trx.raw(`COALESCE(sum(importe),0)::numeric AS importe`),
        trx.raw(`MIN(costo_unitario)::numeric AS costo_min`), trx.raw(`MAX(costo_unitario)::numeric AS costo_max`))
      .where({ tenant_id: tenantId, sku });

    if (!p && !n(c?.n)) throw new NotFoundException(`No existe el producto ${sku}.`);

    const notes: string[] = [];
    if (!p) notes.push('El SKU aparece en compras pero no está en el catálogo de productos.');

    const relations: RefRelation[] = [];
    const lins: any[] = await trx('analytics.erp_goods_receipt_lines as gl')
      .join('analytics.erp_goods_receipts as g', function (this: any) {
        this.on('g.tenant_id', 'gl.tenant_id').andOn('g.sucursal', 'gl.sucursal').andOn('g.folio', 'gl.folio');
      })
      .select('gl.sucursal', 'gl.folio', 'gl.linea', 'gl.costo_unitario', 'gl.cantidad', 'g.proveedor_nombre',
        trx.raw(`to_char(g.receipt_date,'YYYY-MM-DD') AS receipt_date`))
      .where('gl.tenant_id', tenantId).where('gl.sku', sku)
      .orderBy('g.receipt_date', 'desc').limit(REL_LIMIT);
    for (const l of lins) {
      relations.push({ ref: makeRef('lin', l.sucursal, l.folio, l.linea), group: 'Compras de este producto',
        label: `${l.receipt_date ?? ''} · ${l.proveedor_nombre ?? ''}`.trim(),
        sub: `${n(l.cantidad)} pz · costo ${n(l.costo_unitario).toFixed(4)}`, amount: n(l.costo_unitario), date: l.receipt_date });
    }

    // Lo que se PIDIÓ de este producto (OC/vale), no solo lo que llegó.
    const pedidos: any[] = !(await this.hasPurchaseDocs(trx)) ? [] : await trx('analytics.erp_purchase_doc_lines as pl')
      .join('analytics.erp_purchase_docs as pd', function (this: any) {
        this.on('pd.tenant_id', 'pl.tenant_id').andOn('pd.doctype', 'pl.doctype')
          .andOn('pd.sucursal', 'pl.sucursal').andOn('pd.folio', 'pl.folio');
      })
      .select('pd.doctype', 'pd.sucursal', 'pd.folio', 'pd.proveedor_nombre', 'pl.cantidad', 'pl.unidad', 'pl.importe',
        trx.raw(`to_char(pd.doc_date,'YYYY-MM-DD') AS doc_date`))
      .where('pl.tenant_id', tenantId).where('pl.sku', sku).where('pd.doctype', 'XA3501')
      .orderBy('pd.doc_date', 'desc').limit(10);
    for (const o of pedidos) {
      relations.push({ ref: makeRef('pdoc', o.doctype, o.sucursal, o.folio), group: 'Órdenes de compra que lo pidieron',
        label: `${o.doc_date ?? ''} · ${o.proveedor_nombre ?? ''}`.trim(),
        sub: `OC ${o.folio} · ${n(o.cantidad)} ${o.unidad ?? ''}`.trim(), amount: n(o.importe), date: o.doc_date });
    }

    return {
      ref: '', kind: 'sku',
      title: p?.nombre || sku,
      subtitle: p?.categoria || null,
      badges: [{ text: sku, tone: 'muted' }],
      fields: [
        { label: 'SKU', value: sku, kind: 'mono' },
        { label: 'Descripción', value: p?.descripcion ?? null },
        { label: 'Categoría', value: p?.categoria ?? null },
        { label: 'Subfamilia', value: p?.subfamilia ?? null },
        { label: 'Código de barras', value: p?.codigo_barras ?? null, kind: 'mono' },
        { label: 'Unidad de compra', value: p?.unidad_compra ?? null, kind: 'mono' },
        { label: 'Factor de compra', value: p?.factor_compra != null ? n(p.factor_compra) : null, kind: 'qty' },
        { label: 'Veces comprado', value: n(c?.n), kind: 'qty', source: 'renglones en erp_goods_receipt_lines' },
        { label: 'Piezas compradas', value: n(c?.piezas), kind: 'qty' },
        { label: 'Importe comprado', value: n(c?.importe), kind: 'money' },
        { label: 'Costo mín · máx', value: n(c?.n) ? `${n(c?.costo_min).toFixed(4)} · ${n(c?.costo_max).toFixed(4)}` : null, kind: 'mono' },
      ],
      relations, notes,
    };
  }
}
