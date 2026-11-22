import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Knex } from 'knex';
import { PDFDocument } from 'pdf-lib';
import { ObjectStorageService, TenantContextService, TenantKnexService, origenPublicoParaEnlace } from '@megadulces/platform-core';
import { nombreTipoPagoKepler, tipoPagoKepler } from '@megadulces/contracts';
import {
  CANALES_AVISO, asuntoDelAviso, enmascarar, faltantesDelAviso, ligaCorreo, ligaWhatsApp, normalizarCorreo, normalizarWhatsApp, textoDelAviso,
  type AplicacionDelAviso, type AvisoDePago, type AvisoDePagoCreado, type AvisoEnviado, type CanalAviso, type CrearAvisoDePago, type FacturaDelAviso,
} from '@megadulces/contracts/finance/aviso-de-pago';
import { htmlAPdf, logoParaDocumentos } from '../shared/chromium-pdf';
import { anexarPdfs, type PdfEvidencia } from '../expense-dossier/evidencias-pdf';
import { SQL_CIERRE_KEPLER, type FilaCierreKepler } from './cierre-kepler.sql';
import { SQL_LLAVES_DE_RENGLONES, leerCfdiDeFacturas } from './cfdi-factura.sql';
import {
  SQL_ACREEDOR_DEL_AVISO, SQL_AVISOS_DEL_PAGO, SQL_COMPROBANTE_DEL_AVISO, SQL_FACTURAS_DEL_AVISO, SQL_PAGO_DEL_AVISO,
  SQL_REFERENCIAS_DE_APLICACIONES, SQL_RENGLONES_DEL_AVISO,
} from './aviso-de-pago.sql';
import { htmlDelAviso } from './aviso-de-pago.html';

/** Lo que va firmado en la liga que abre el proveedor: el aviso y su tenant. La autoridad real es la fila (`revoked_at`). */
interface TokenAviso { t: 'payment_notice'; tenant_id: string; n: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIPOS_NOTA = new Set(['nota_credito', 'devolucion']);
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * `[PGP.193]` + `[PGP.194]` **El aviso de pago al proveedor** (anexo AV; DA3 de Francisco, 2026-11-21).
 *
 * Arma el desglose de UN pago en los documentos del proveedor (referencia, UUID, notas de crédito y devoluciones que
 * Kepler aplicó), le anexa el PDF de la transferencia y lo sirve por una liga personal, como el estado de cuenta de
 * clientes (`[CC.20.2]`): un JWT con el id del aviso; la fila en `finance.payment_notices` es la autoridad (se revoca).
 *
 * ⛔ Sólo de un pago PAGADO (`executed`): avisar de un pago que no salió sería afirmar lo que no es.
 * ⛔ No manda nada solo: genera la liga y el mensaje, y quien presiona el botón lo envía desde su WhatsApp o su correo.
 *    Queda el registro de quién, cuándo, por dónde y a quién (lo que lee `[PGP.195]` para «Por notificar»).
 * ⛔ Lo que no se sabe se declara en el aviso (`faltantes`): un pago sin comprobante, una factura sin CFDI.
 */
@Injectable()
export class AvisoDePagoService {
  private readonly logger = new Logger(AvisoDePagoService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly jwt: JwtService,
    @Optional() private readonly storage?: ObjectStorageService,
  ) {}

  /** ¿Ya se aplicó la migración de `[PGP.193]`? Sin ella el aviso se ve, pero no se manda ni se recuerda el contacto. */
  private async tablasListas(trx: Knex | Knex.Transaction): Promise<boolean> {
    const { rows: [r] } = await trx.raw(`SELECT to_regclass('finance.payment_notices') IS NOT NULL AND to_regclass('finance.supplier_collection_contacts') IS NOT NULL AS ok`);
    return r?.ok === true;
  }

  /** El aviso de un pago, para el diálogo. */
  async datos(allocationId: string): Promise<AvisoDePago> {
    return (await this.leer(allocationId)).aviso;
  }

  private async leer(allocationId: string): Promise<{ aviso: AvisoDePago; archivo: string | null; listas: boolean }> {
    if (!UUID.test(allocationId || '')) throw new BadRequestException('Pago inválido.');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const pago = (await trx.raw(SQL_PAGO_DEL_AVISO, [tenantId, allocationId])).rows[0] as {
        id: string; status: string; importe: number; metodo: string | null; dia: string; destino_texto: string | null;
        origen_banco: string | null; origen_alias: string | null; origen_cuenta: string | null; destino_clabe: string | null; destino_numero: string | null;
      } | undefined;
      if (!pago) throw new NotFoundException('Ese pago no existe.');
      const comp = (await trx.raw(SQL_COMPROBANTE_DEL_AVISO, [tenantId, allocationId])).rows[0] as {
        id: string; rastreo: string | null; fecha: string | null; cuenta_origen: string | null; cuenta_destino: string | null;
        files: unknown;
      } | undefined;
      const renglones = (await trx.raw(SQL_RENGLONES_DEL_AVISO, [tenantId, allocationId])).rows as { item_id: string; pagado: number; descuento: number }[];
      const ids = renglones.map((x) => x.item_id);
      const llaves = ids.length ? (await trx.raw(SQL_LLAVES_DE_RENGLONES, [tenantId, ids])).rows as { item_id: string; oid: string | null }[] : [];
      const oidDe = new Map(llaves.map((l) => [l.item_id, l.oid]));
      const oids = [...new Set(llaves.map((l) => l.oid).filter((o): o is string => !!o))];
      const docs = oids.length ? (await trx.raw(SQL_FACTURAS_DEL_AVISO, [oids])).rows as {
        oid: string; sucursal: string; acreedor: string; doc_tipo: number; doc_sub: number; folio: string; referencia: string | null; importe: number; fecha: string | null;
      }[] : [];
      const docDe = new Map(docs.map((d) => [d.oid, d]));
      // El CFDI y el nombre del acreedor salen de `analytics.v_supplier_rfc`. Sin la vista (algunos entornos de desarrollo)
      // no se miden y se DICE, como el REP de `[PGP.109]`: no se troncha el aviso por un dato que se puede declarar.
      const { rows: [vista] } = await trx.raw(`SELECT to_regclass('analytics.v_supplier_rfc') IS NOT NULL AS ok`);
      const conRfc = vista?.ok === true;
      const cfdis = conRfc && ids.length ? await leerCfdiDeFacturas(trx, tenantId, ids) : new Map();

      // Lo que Kepler aplicó a cada factura (la MISMA lectura del cierre): aquí sólo cuentan notas y devoluciones.
      const aplic = oids.length ? (await trx.raw(SQL_CIERRE_KEPLER, [oids, tenantId])).rows as FilaCierreKepler[] : [];
      const notas = aplic.filter((x) => x.p_tipo != null && x.p_sub != null && x.p_folio && TIPOS_NOTA.has(tipoPagoKepler(x.p_tipo, x.p_sub)));
      const refs = notas.length ? (await trx.raw(SQL_REFERENCIAS_DE_APLICACIONES, [
        notas.map((x) => String(x.psuc)), notas.map((x) => Number(x.p_tipo)), notas.map((x) => Number(x.p_sub)), notas.map((x) => String(x.p_folio)),
      ] as Knex.RawBinding[])).rows as { sucursal: string; tipo: number; sub: number; folio: string; referencia: string | null }[] : [];
      const refDe = new Map(refs.map((x) => [`${x.sucursal}|${x.tipo}|${x.sub}|${x.folio}`, x.referencia]));
      const notasDe = new Map<string, AplicacionDelAviso[]>();
      for (const x of notas) {
        const lista = notasDe.get(x.obligation_id) ?? [];
        lista.push({
          nombre: nombreTipoPagoKepler(tipoPagoKepler(x.p_tipo as number, x.p_sub as number)),
          documento: `X-D-${x.p_tipo} ${x.p_folio}`,
          referencia: refDe.get(`${x.psuc}|${x.p_tipo}|${x.p_sub}|${x.p_folio}`) ?? null,
          fecha: x.fecha, importe: r2(Number(x.aplicado) || 0),
        });
        notasDe.set(x.obligation_id, lista);
      }

      const acreedores = [...new Set(docs.map((d) => d.acreedor).filter(Boolean))];
      const acre = conRfc && acreedores.length ? (await trx.raw(SQL_ACREEDOR_DEL_AVISO, [acreedores])).rows as { proveedor_code: string; proveedor_nombre: string | null; rfc: string | null }[] : [];
      const codigo = acreedores[0] ?? null;
      const proveedorFila = acre.find((x) => x.proveedor_code === codigo) ?? acre[0];
      const emisorFila = await trx('fiscal.issuer_config').where({ tenant_id: tenantId, active: true }).orderBy('is_default', 'desc').first('rfc', 'tax_name');

      const listas = await this.tablasListas(trx);
      const contactoFila = listas && codigo
        ? await trx('finance.supplier_collection_contacts').where({ tenant_id: tenantId, proveedor_code: codigo }).first('contact_name', 'email', 'whatsapp')
        : null;
      const avisos = listas ? (await trx.raw(SQL_AVISOS_DEL_PAGO, [tenantId, allocationId])).rows as AvisoEnviado[] : [];

      const facturas: FacturaDelAviso[] = renglones.map((x) => {
        const oid = oidDe.get(x.item_id) ?? null;
        const doc = oid ? docDe.get(oid) : undefined;
        const c = cfdis.get(x.item_id);
        return {
          referencia: doc?.referencia ?? null,
          documento: doc ? `X-A-${doc.doc_tipo} ${doc.folio}` : null,
          uuid: c?.cfdi?.uuid ?? null,
          metodo: c?.metodo ?? null,
          fecha: c?.cfdi?.fecha ? String(c.cfdi.fecha).slice(0, 10) : doc?.fecha ?? null,
          total: c?.cfdi ? Number(c.cfdi.total) : (doc ? Number(doc.importe) : null),
          notas: oid ? notasDe.get(oid) ?? [] : [],
          descuento: r2(Number(x.descuento) || 0),
          pagado: r2(Number(x.pagado) || 0),
        };
      });

      const origen = pago.origen_cuenta || pago.origen_banco
        ? [pago.origen_alias || pago.origen_banco, enmascarar(pago.origen_cuenta)].filter(Boolean).join(' ')
        : enmascarar(comp?.cuenta_origen);
      const destino = enmascarar(pago.destino_clabe || pago.destino_numero || pago.destino_texto || comp?.cuenta_destino);
      const archivos = Array.isArray(comp?.files) ? comp?.files as { role?: string; url?: string }[] : typeof comp?.files === 'string' ? JSON.parse(comp.files) as { role?: string; url?: string }[] : [];
      const archivo = archivos.find((f) => f.role === 'comprobante')?.url ?? archivos[0]?.url ?? null;

      const motivo = pago.status === 'executed' ? null
        : pago.status === 'pending' ? 'El pago todavía no está marcado pagado: el aviso se manda cuando el dinero ya salió.'
          : pago.status === 'failed' ? 'Este pago rebotó: no hay pago que avisar.' : 'Este pago está cancelado.';
      const base = {
        rastreo: comp?.rastreo ?? null, comprobante_id: comp?.id ?? null, facturas,
      };
      const aviso: AvisoDePago = {
        pago_id: allocationId,
        emisor: emisorFila?.rfc && emisorFila?.tax_name ? { nombre: String(emisorFila.tax_name).trim(), rfc: String(emisorFila.rfc).trim().toUpperCase() } : null,
        proveedor: { codigo, nombre: proveedorFila?.proveedor_nombre?.trim() || codigo || 'Proveedor', rfc: proveedorFila?.rfc?.trim() || null },
        fecha_pago: comp?.fecha ?? (pago.status === 'executed' ? pago.dia : null),
        importe: r2(Number(pago.importe) || 0),
        origen: origen || null, destino,
        contacto: contactoFila ? { nombre: contactoFila.contact_name ?? null, email: contactoFila.email ?? null, whatsapp: contactoFila.whatsapp ?? null } : null,
        avisos,
        faltantes: [
          ...faltantesDelAviso(base),
          ...(conRfc ? [] : ['No se midió el CFDI ni el nombre del proveedor: falta la vista de RFC de acreedores en este entorno.']),
        ],
        se_puede: !motivo && listas,
        motivo: motivo ?? (listas ? null : 'Falta aplicar la migración de los avisos (PGP.193): el aviso se ve, pero todavía no se puede mandar.'),
        ...base,
      };
      return { aviso, archivo, listas };
    });
  }

  /**
   * Genera la liga del aviso y deja el registro (`payment_notices`) y el contacto (`supplier_collection_contacts`).
   * Devuelve el mensaje listo para WhatsApp o el correo: quien presiona el botón es quien lo envía.
   */
  async crear(allocationId: string, dto: CrearAvisoDePago, actor: string | undefined, origin?: string): Promise<AvisoDePagoCreado> {
    const canal = dto?.canal as CanalAviso;
    if (!CANALES_AVISO.includes(canal)) throw new BadRequestException('Canal inválido: whatsapp, correo o liga.');
    const email = dto.email ? normalizarCorreo(dto.email) : null;
    if (dto.email && !email) throw new BadRequestException('El correo no tiene forma de correo (nombre@dominio.com).');
    const whatsapp = dto.whatsapp ? normalizarWhatsApp(dto.whatsapp) : null;
    if (dto.whatsapp && !whatsapp) throw new BadRequestException('El WhatsApp debe ser un número de México de 10 dígitos.');
    const nombre = (dto.nombre ?? '').trim().slice(0, 120) || null;
    if (!actor) throw new ForbiddenException('No se pudo identificar quién avisa.');

    const { aviso, listas } = await this.leer(allocationId);
    if (!listas) throw new ServiceUnavailableException(aviso.motivo);
    if (!aviso.se_puede) throw new BadRequestException(aviso.motivo);
    const tenantId = this.tenantCtx.requireTenantId();
    const avisoId = await this.tk.run(async (trx) => {
      if (aviso.proveedor.codigo && (email || whatsapp || nombre)) {
        await trx.raw(`
          INSERT INTO finance.supplier_collection_contacts (tenant_id, proveedor_code, contact_name, email, whatsapp, created_by, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (tenant_id, proveedor_code) DO UPDATE SET
            contact_name = coalesce(EXCLUDED.contact_name, finance.supplier_collection_contacts.contact_name),
            email = coalesce(EXCLUDED.email, finance.supplier_collection_contacts.email),
            whatsapp = coalesce(EXCLUDED.whatsapp, finance.supplier_collection_contacts.whatsapp),
            updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [tenantId, aviso.proveedor.codigo, nombre, email, whatsapp, actor, actor]);
      }
      const destino = canal === 'whatsapp' ? whatsapp ?? aviso.contacto?.whatsapp ?? null : canal === 'correo' ? email ?? aviso.contacto?.email ?? null : null;
      // `clock_timestamp()`, no `now()`: dos avisos en la misma transacción quedarían empatados en el historial.
      const [row] = await trx('finance.payment_notices').insert({
        tenant_id: tenantId, allocation_id: allocationId, canal, destino, created_by: actor, created_at: trx.raw('clock_timestamp()'),
      }).returning(['id']);
      return row.id as string;
    });

    const token = this.jwt.sign({ t: 'payment_notice', tenant_id: tenantId, n: avisoId } satisfies TokenAviso, { expiresIn: '400d' });
    const url = `${origenPublicoParaEnlace(origin)}/api/finance/payment-notice/${token}/aviso.pdf`;
    const texto = textoDelAviso(aviso, url);
    this.logger.log(`[PGP.194] aviso ${avisoId} · pago ${allocationId} · ${canal} · por ${actor}`);
    return {
      aviso_id: avisoId, url,
      whatsapp_url: ligaWhatsApp(whatsapp ?? aviso.contacto?.whatsapp ?? null, texto),
      mailto: ligaCorreo(email ?? aviso.contacto?.email ?? null, asuntoDelAviso(aviso), texto),
    };
  }

  /** El PDF del aviso con el comprobante de la transferencia anexo. */
  async pdf(allocationId: string): Promise<{ pdf: Buffer; nombre: string }> {
    const { aviso, archivo } = await this.leer(allocationId);
    let anexo: PdfEvidencia | null = null;
    if (archivo) {
      const uri = this.storage ? await this.storage.getDataUri(archivo) : null;
      const m = uri ? /^data:application\/pdf;base64,(.+)$/i.exec(uri) : null;
      if (m) {
        try {
          const bytes = new Uint8Array(Buffer.from(m[1], 'base64'));
          const paginas = (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount();
          anexo = { etiqueta: 'Comprobante de la transferencia', bytes, paginas };
        } catch (e) {
          this.logger.warn(`[PGP.194] el comprobante de ${allocationId} no se pudo abrir: ${(e as Error).message}`);
        }
      }
      if (!anexo) aviso.faltantes = [...aviso.faltantes, 'El PDF de la transferencia no se pudo anexar (no se pudo bajar o abrir): pídelo a Tesorería.'];
    }
    const principal = await htmlAPdf(htmlDelAviso(aviso, logoParaDocumentos(), !!anexo));
    const pdf = anexo ? Buffer.from(await anexarPdfs(new Uint8Array(principal), [anexo], `Aviso de pago ${aviso.fecha_pago ?? ''}`.trim())) : principal;
    const nombre = `aviso-de-pago-${(aviso.proveedor.codigo || 'proveedor').replace(/[^\w-]/g, '')}-${aviso.fecha_pago ?? 'sin-fecha'}.pdf`;
    return { pdf, nombre };
  }

  /** El PDF desde la liga del proveedor: el token dice qué aviso y de qué tenant; la fila dice si sigue vigente. */
  async pdfDeLaLiga(token: string): Promise<{ pdf: Buffer; nombre: string }> {
    let p: TokenAviso;
    try { p = this.jwt.verify<TokenAviso>(token); } catch { throw new ForbiddenException('Esta liga ya no sirve. Pide el aviso otra vez a Mega Dulces.'); }
    if (p?.t !== 'payment_notice' || !p.tenant_id || !p.n || !UUID.test(p.n)) throw new ForbiddenException('Esta liga ya no sirve. Pide el aviso otra vez a Mega Dulces.');
    return this.tenantCtx.run({ tenantId: p.tenant_id, username: `proveedor:aviso:${p.n}` }, async () => {
      const fila = await this.tk.run((trx) => trx('finance.payment_notices').where({ tenant_id: p.tenant_id, id: p.n }).first('allocation_id', 'revoked_at'));
      if (!fila || fila.revoked_at) throw new ForbiddenException('Este aviso ya no está disponible. Pide uno nuevo a Mega Dulces.');
      return this.pdf(String(fila.allocation_id));
    });
  }
}
