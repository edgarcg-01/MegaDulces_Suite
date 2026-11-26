import { BadRequestException, ForbiddenException, Injectable, Logger, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Knex } from 'knex';
import {
  TenantKnexService, TenantContextService, ObjectStorageService, OcrReadingsService, DepositSlipFields, todayMx,
  origenPublicoParaEnlace,
} from '@megadulces/platform-core';
import { CollectionDepositsService } from './collection-deposits.service';
import { CobranzaGateway } from './cobranza.gateway';
import {
  FichaEnBanco, FilaFichaEnBanco, clasificarFichaEnBanco, marcarDisputas, sqlFichaEnBanco,
} from './ficha-en-banco';

/**
 * `[CC.20]` **El cliente sube su ficha de depósito desde su enlace personal.** Edgar, 2026-11-17: «lo más práctico y
 * lo más fácil posible»; canal = enlace personal sin contraseña (por WhatsApp y como QR en el estado de cuenta); lo
 * recibe Cobranza en su bandeja y lo ve el vendedor en la cartera.
 *
 * Medido ese día: 2,722 cobros / $48.5M en 30 días, y la ficha capturada EN OFICINA (fase CC) tiene 0 filas en su
 * historia; el portal B2B, 3 sesiones en 30 días. Por eso entra el cliente, sin cuenta.
 *
 * ── El enlace ───────────────────────────────────────────────────────────────────────────────────────────────────
 * Un JWT SIN ESTADO con (sucursal, cliente, versión): se puede poner en el mensaje de WhatsApp y en el PDF sin escribir
 * nada al abrir la ficha. `finance.customer_deposit_links` guarda sólo la versión vigente (dar de baja = subir la
 * versión) y el uso; sin renglón = versión 1. Mismo molde que la captura de gastos por enlace (GX.9).
 *
 * ── Las reglas de la superficie pública (sostenerlas si alguien agrega un endpoint) ────────────────────────────
 *  · **Sólo escribe fichas de SU cuenta y sólo lee lo suyo**: su nombre y sus fichas anteriores con su estado. Ni
 *    saldos, ni Kepler, ni nada de otros clientes (el enlace se puede reenviar).
 *  · **Nunca aplica un cobro**: la ficha entra como «recibido» y la revisa Cobranza. No hay validar aquí.
 *  · **Imagen o PDF, con tope de tamaño**, y límite de peticiones propio en el controlador.
 *  · **El OCR es una propuesta**: lo que se guarda como lectura sale del servidor (por la huella del archivo), nunca
 *    del navegador; lo que el cliente teclea va aparte, como lo que DECLARA.
 */

const TIPOS_OK = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
/** ~8 MB del archivo (el base64 pesa 4/3). Una foto de celular comprimida en el navegador pesa ~0.3 MB. */
const MAX_BASE64 = Math.ceil((8 * 1024 * 1024 * 4) / 3);
const MAX_ARCHIVOS = 3;

interface TokenDeposito { t: 'customer_deposit'; tenant_id: string; s: string; c: string; v: number }
export interface CuentaDeposito { tenantId: string; sucursal: string; cliente: string }
export interface ArchivoFicha { url: string; kind?: string; sha256?: string; role?: string }
/** Una ficha anterior del cliente, tal como la ve él en su enlace. */
export interface FichaDelCliente {
  id: string; status: string; motivo_rechazo: string | null; monto: number | null;
  fecha: string | null; enviado: string; aplicado: boolean;
}
export interface ContextoDepositoResp { cliente: string; sucursal: string | null; fichas: FichaDelCliente[] }
export interface EnvioFichaResp { id: string; status: string; ya_estaba: boolean }
export type LecturaFichaResp = DepositSlipFields & { ocr_status: string; sha256: string };
/** Una ficha en la bandeja de Cobranza. */
export interface FichaEnBandeja {
  id: string; status: string; cuenta_sucursal: string | null; cliente_code: string | null; cliente_nombre: string | null;
  files: ArchivoFicha[]; sucursal: string | null; folio: string | null; monto: number | null; fecha: string | null;
  nota: string | null; ocr_monto: number | null; ocr_fecha: string | null; ocr_banco: string | null;
  ocr_referencia: string | null; ocr_status: string | null; monto_match: boolean | null; motivo_rechazo: string | null;
  validated_by: string | null; validated_at: string | null; enviado: string;
  /** `[CC.21]` ¿Entró al banco? Sólo para las que esperan revisión; `null` = no se pudo medir (se dice en pantalla). */
  banco?: FichaEnBanco | null;
}
export interface BandejaResp {
  estado: string; por_estado: Record<string, number>; fichas: FichaEnBandeja[];
  /** `[CC.21]` false si la consulta al banco falló: la pantalla dice «no se pudo revisar el banco», no «no aparece». */
  banco_medido: boolean;
}
export interface AbonoDeclaradoResp { ok: boolean; bank_movement_id: string; customer_code: string | null }
export interface CobroCandidato { cliente_code: string | null; del_cliente: boolean; [k: string]: unknown }
export interface CambioFichaResp { id: string; status: string }

/** `[CC.31]` Una factura viva del cliente, como la ve quien va a capturar el cobro en Kepler. */
export interface FacturaQueCuadra {
  doc_code: string; folio: string; importe: number; saldo: number;
  fecha: string | null; vencimiento: string | null;
}
/**
 * `[CC.31]` Qué factura cuadra con el depósito. `modo` dice **cuánta confianza tiene la propuesta**, que es la
 * diferencia entre ayudar y afirmar: `exacta` (una, al centavo) · `una_de_varias` (hay empate, elige la persona) ·
 * `parcial` (ninguna sola cuadra; van las más viejas para que decida).
 */
export interface FacturasQueCuadran {
  modo: 'exacta' | 'una_de_varias' | 'parcial';
  monto: number;
  facturas: FacturaQueCuadra[];
}
/** Cuántas facturas se ofrecen cuando ninguna cuadra sola: las más viejas, que es por donde se cobra. */
export const FACTURAS_SI_NO_CUADRA = 6;

/**
 * `[CC.31]` La decisión, **pura**: de las facturas vivas del cliente y el importe del depósito, cuál proponer.
 *
 * ⛔ **El centavo manda.** Una factura «cuadra» si su saldo **es** el importe, no si se le parece: proponer por
 * cercanía sería el cruce por importe sin control negativo, que ya costó antes. Y **nunca se propone una
 * combinación** de dos facturas que sumen el importe — que dos sumen lo mismo no prueba nada.
 *
 * El `modo` existe para que la pantalla diga **cuánta confianza tiene** la propuesta, en vez de afirmar siempre.
 */
export function elegirFacturasQueCuadran(monto: number, vivas: FacturaQueCuadra[]): FacturasQueCuadran {
  const lista = (vivas ?? []).filter((v) => Number.isFinite(v?.saldo));
  if (!Number.isFinite(monto) || monto <= 0) return { modo: 'parcial', monto: monto || 0, facturas: [] };
  const cuadran = lista.filter((v) => Math.abs(v.saldo - monto) <= 0.005);
  if (cuadran.length === 1) return { modo: 'exacta', monto, facturas: cuadran };
  if (cuadran.length > 1) return { modo: 'una_de_varias', monto, facturas: cuadran };
  return { modo: 'parcial', monto, facturas: lista.slice(0, FACTURAS_SI_NO_CUADRA) };
}
const mensajeDe = (e: unknown): string => (e as { message?: string } | null)?.message || String(e);

export interface EnvioFichaDto {
  files?: ArchivoFicha[];
  monto?: number | string;
  fecha?: string;
  nota?: string;
}

@Injectable()
export class CustomerDepositsService {
  private readonly logger = new Logger(CustomerDepositsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly jwt: JwtService,
    private readonly storage: ObjectStorageService,
    private readonly readings: OcrReadingsService,
    private readonly deposits: CollectionDepositsService,
    @Optional() private readonly gateway?: CobranzaGateway,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════
  // Lado interno: el enlace de una cuenta
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════

  /**
   * La URL del enlace de una cuenta. No escribe nada: la versión se lee (sin renglón = 1). La llaman la ficha de
   * cartera, el mensaje de WhatsApp y el PDF del estado de cuenta. Siempre con una base que abre desde internet (`[CC.20.1]`).
   */
  async enlaceDe(sucursal: string, cliente: string, origin?: string): Promise<string | null> {
    const tenantId = this.tenantCtx.requireTenantId();
    const s = (sucursal || '').trim(); const c = (cliente || '').trim();
    if (!s || !c) return null;
    // `[CC.20.1]` El cliente abre desde su celular: nunca la IP de la oficina (ver `origenPublicoParaEnlace`).
    const base = origenPublicoParaEnlace(origin);
    const v = await this.versionDe(tenantId, s, c);
    if (v == null) return null; // dado de baja sin versión nueva: no se emite
    const payload: TokenDeposito = { t: 'customer_deposit', tenant_id: tenantId, s, c, v };
    // Vigencia larga a propósito: la autoridad real es la versión de la fila, que se relee en cada uso.
    const token = this.jwt.sign(payload, { expiresIn: '400d' });
    return `${base}/deposito/${token}`;
  }

  /** Da de baja los enlaces de una cuenta (todos los que se hayan mandado): sube la versión. */
  async renovar(sucursal: string, cliente: string, actor?: string): Promise<{ version: number }> {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const r = await trx.raw(`
        INSERT INTO finance.customer_deposit_links (tenant_id, sucursal, cliente_code, version, created_by, updated_by)
        VALUES (current_tenant_id(), ?, ?, 2, ?, ?)
        ON CONFLICT (tenant_id, sucursal, cliente_code)
        DO UPDATE SET version = finance.customer_deposit_links.version + 1, revoked_at = NULL,
                      updated_by = EXCLUDED.updated_by, updated_at = now()
        RETURNING version`, [sucursal, cliente, actor || null, actor || null]);
      return { version: r.rows[0].version };
    });
  }

  private async versionDe(tenantId: string, s: string, c: string): Promise<number | null> {
    const row = await this.tenantCtx.run({ tenantId }, () => this.tk.run(async (trx) => {
      const hay = (await trx.raw(`SELECT to_regclass('finance.customer_deposit_links') IS NOT NULL AS ok`)).rows[0]?.ok;
      if (!hay) return { version: 1, revoked_at: null };
      return trx('finance.customer_deposit_links').where({ sucursal: s, cliente_code: c }).first('version', 'revoked_at');
    }));
    if (!row) return 1;
    return row.revoked_at ? null : Number(row.version) || 1;
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════
  // Lado público: el celular del cliente
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════

  /** Verifica el token y relee la versión vigente: un JWT válido no alcanza (pudo darse de baja). */
  private async resolver(token: string): Promise<CuentaDeposito> {
    let p: TokenDeposito;
    try { p = this.jwt.verify<TokenDeposito>(token); } catch { throw new ForbiddenException('Este enlace ya no sirve. Pide uno nuevo a tu vendedor o a Cobranza.'); }
    if (p?.t !== 'customer_deposit' || !p.tenant_id || !p.s || !p.c) {
      throw new ForbiddenException('Este enlace ya no sirve. Pide uno nuevo a tu vendedor o a Cobranza.');
    }
    const vigente = await this.versionDe(p.tenant_id, p.s, p.c);
    if (vigente == null || vigente !== Number(p.v || 1)) {
      throw new ForbiddenException('Este enlace fue reemplazado por uno nuevo. Usa el último que te mandamos.');
    }
    return { tenantId: p.tenant_id, sucursal: p.s, cliente: p.c };
  }

  /**
   * `[CC.20.2]` Corre `fn` con la cuenta del enlace (token revalidado contra la versión vigente) y en su tenant. Lo usa el
   * PDF del estado de cuenta que el cliente descarga desde su enlace: vive en `customer-ledger`, que ya importa este
   * módulo, así que la autorización se queda aquí y el documento no sabe de tokens.
   */
  async conCuentaDelEnlace<T>(token: string, fn: (sucursal: string, cliente: string) => Promise<T>): Promise<T> {
    const cta = await this.resolver(token);
    return this.enCuenta(cta, () => fn(cta.sucursal, cta.cliente));
  }

  private enCuenta<T>(cta: CuentaDeposito, fn: () => Promise<T>): Promise<T> {
    return this.tenantCtx.run({ tenantId: cta.tenantId, username: `cliente:${cta.sucursal}/${cta.cliente}` }, fn);
  }

  /**
   * Lo que ve el cliente al abrir: su nombre y SUS fichas anteriores con su estado (y el motivo si se rechazó: es lo
   * que cierra el lazo). Nada de saldos ni de nadie más. Cuenta el uso del enlace.
   */
  async contexto(token: string): Promise<ContextoDepositoResp> {
    const cta = await this.resolver(token);
    return this.enCuenta(cta, () => this.tk.run(async (trx) => {
      const cli = await trx('analytics.erp_customers').where({ erp_code: cta.cliente }).first('name');
      const suc = await trx('commercial.warehouses').where({ code: cta.sucursal }).whereNull('deleted_at').first('name');
      const fichas = await trx('finance.collection_deposits')
        .where({ origen: 'cliente', cuenta_sucursal: cta.sucursal, cliente_code: cta.cliente })
        .orderBy('created_at', 'desc').limit(10)
        .select('id', 'status', 'motivo_rechazo', trx.raw('reported_monto::numeric AS monto'),
          trx.raw('reported_fecha::text AS fecha'), trx.raw('created_at::text AS enviado'), trx.raw('folio IS NOT NULL AS aplicado'));
      await trx.raw(`
        INSERT INTO finance.customer_deposit_links (tenant_id, sucursal, cliente_code, uses, last_used_at)
        VALUES (current_tenant_id(), ?, ?, 1, now())
        ON CONFLICT (tenant_id, sucursal, cliente_code)
        DO UPDATE SET uses = finance.customer_deposit_links.uses + 1, last_used_at = now()`, [cta.sucursal, cta.cliente]);
      return {
        cliente: cli?.name || cta.cliente,
        sucursal: suc?.name || null,
        fichas: (fichas as FichaDelCliente[]).map((f) => ({ ...f, monto: f.monto != null ? Number(f.monto) : null })),
      };
    }));
  }

  /** Valida lo que sube un desconocido: tipo y tamaño. */
  private validarArchivo(dataUri: string): void {
    const m = /^data:([^;,]+)[;,]/.exec(dataUri || '');
    const tipo = (m?.[1] || '').toLowerCase();
    if (!TIPOS_OK.includes(tipo)) throw new BadRequestException('Sube una foto o un PDF de tu ficha.');
    if (dataUri.length > MAX_BASE64) throw new BadRequestException('El archivo es muy grande (máximo 8 MB).');
  }

  /** Sube UNA foto o PDF. De a uno: una falla de red en el celular no tira las demás. */
  async subir(token: string, dataUri: string): Promise<ArchivoFicha> {
    const cta = await this.resolver(token);
    this.validarArchivo(dataUri);
    return this.enCuenta(cta, async () => {
      try {
        const f = await this.storage.putFile(dataUri, `finance/${cta.tenantId}/customer-deposits`);
        return { url: f.key, kind: f.kind, role: 'deposito' };
      } catch (e: unknown) {
        if ((e as { status?: number })?.status === 400) throw e;
        this.logger.error(`ficha de ${cta.sucursal}/${cta.cliente}: fallo subiendo: ${mensajeDe(e)}`);
        throw new BadRequestException('No se pudo subir la foto. Revisa tu señal y vuelve a intentar.');
      }
    });
  }

  /** Lee la ficha (monto, fecha, banco, referencia) para llenarle los campos. Es una PROPUESTA editable. */
  async leer(token: string, dataUri: string): Promise<LecturaFichaResp> {
    const cta = await this.resolver(token);
    this.validarArchivo(dataUri);
    return this.enCuenta(cta, () => this.deposits.runOcr(dataUri));
  }

  /**
   * Envía la ficha. Entra como `recibido`, sin folio (todavía no hay cobro en Kepler), y avisa a Cobranza.
   * La misma foto o la misma referencia bancaria enviada dos veces no crea dos fichas: devuelve la que ya estaba.
   */
  async enviar(token: string, dto: EnvioFichaDto): Promise<EnvioFichaResp> {
    const cta = await this.resolver(token);
    const files = (Array.isArray(dto.files) ? dto.files : []).filter((f) => f && typeof f.url === 'string' && f.url)
      .slice(0, MAX_ARCHIVOS)
      .map((f) => ({ role: 'deposito', url: f.url, kind: f.kind, sha256: f.sha256 }));
    if (!files.length) throw new BadRequestException('Falta la foto de tu ficha.');
    // Cada archivo tiene que ser uno que subió ESTA cuenta, no una ruta inventada.
    const prefijo = `finance/${cta.tenantId}/customer-deposits/`;
    if (files.some((f) => !f.url.startsWith(prefijo))) throw new BadRequestException('Archivo no válido.');
    const monto = Number(String(dto.monto ?? '').replace(/[$,\s]/g, ''));
    if (!isFinite(monto) || monto <= 0) throw new BadRequestException('Escribe el monto que depositaste.');
    if (monto > 50_000_000) throw new BadRequestException('Revisa el monto.');
    const fecha = (dto.fecha || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || isNaN(Date.parse(fecha))) throw new BadRequestException('Escribe la fecha del depósito.');
    const dias = (Date.parse(fecha) - Date.parse(todayMx())) / 86_400_000;
    if (dias > 1) throw new BadRequestException('La fecha del depósito no puede ser futura.');
    if (dias < -180) throw new BadRequestException('Ese depósito tiene más de seis meses: llámale a Cobranza.');
    const nota = (dto.nota || '').trim().slice(0, 500) || null;

    return this.enCuenta(cta, async () => {
      // La lectura que se guarda sale del SERVIDOR: por la huella del archivo; si cayó en otro proceso, se vuelve a
      // leer el archivo ya guardado. Nunca la del navegador.
      let lectura: (DepositSlipFields & { ocr_status?: string }) | null = null;
      const sha = files.find((f) => f.sha256)?.sha256;
      const rec = this.readings.recall<DepositSlipFields>(cta.tenantId, sha);
      if (rec) lectura = { ...rec.fields, ocr_status: rec.status };
      else {
        try {
          const uri = await this.storage.getDataUri(files[0].url);
          if (uri) lectura = await this.deposits.runOcr(uri);
        } catch (e: unknown) { this.logger.warn(`ficha de ${cta.sucursal}/${cta.cliente}: sin lectura (${mensajeDe(e)})`); }
      }
      const ref = (lectura?.referencia || '').replace(/\D/g, '') || null;

      const res = await this.tk.run(async (trx) => {
        // Doble envío: la MISMA foto, o la misma referencia bancaria POR EL MISMO MONTO (±$1), de esta cuenta y viva → la que
        // ya estaba. ⚠️ La referencia sola no alcanza (medido en la prueba de punta a punta del 2026-11-17): dos depósitos
        // distintos con la misma referencia leída se fundían en uno, y el segundo nunca llegaba a Cobranza.
        const previa = await trx('finance.collection_deposits')
          .where({ origen: 'cliente', cuenta_sucursal: cta.sucursal, cliente_code: cta.cliente })
          .whereNot('status', 'rechazado')
          .where((q: Knex.QueryBuilder) => {
            if (ref) q.orWhere((r: Knex.QueryBuilder) => r.where('ref_norm', ref).whereRaw('abs(reported_monto - ?::numeric) <= 1', [monto]));
            if (sha) q.orWhereRaw(`files @> ?::jsonb`, [JSON.stringify([{ sha256: sha }])]);
            if (!ref && !sha) q.whereRaw('false');
          })
          .first('id', 'status');
        if (previa) return { id: previa.id, status: previa.status, ya_estaba: true };
        const cli = await trx('analytics.erp_customers').where({ erp_code: cta.cliente }).first('name');
        const [row] = await trx('finance.collection_deposits').insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          origen: 'cliente',
          sucursal: cta.sucursal, cuenta_sucursal: cta.sucursal, folio: null,
          cliente_code: cta.cliente, cliente_nombre: cli?.name || null,
          files: JSON.stringify(files),
          ocr_monto: lectura?.monto ?? null, ocr_fecha: lectura?.fecha || null, ocr_banco: lectura?.banco || null,
          ocr_cuenta_dest: lectura?.cuenta_dest || null, ocr_referencia: lectura?.referencia || null,
          ocr_ordenante: lectura?.ordenante || null, ocr_metodo: lectura?.metodo || null,
          ocr_raw: lectura ? JSON.stringify(lectura) : null,
          ocr_status: lectura?.ocr_status || 'pendiente',
          // ¿Lo que dice la ficha cuadra con lo que el cliente declaró? (tolerancia de redondeo, $1)
          monto_match: lectura?.monto != null ? Math.abs(Number(lectura.monto) - monto) <= 1 : null,
          reported_monto: monto, reported_fecha: fecha, reported_nota: nota,
          status: 'recibido',
          created_by: `cliente:${cta.sucursal}/${cta.cliente}`,
        }).returning(['id', 'status']);
        return { id: row.id, status: row.status, ya_estaba: false, cliente_nombre: cli?.name || cta.cliente };
      });
      if (!res.ya_estaba) {
        try {
          this.gateway?.emitChange(cta.tenantId, {
            action: 'reported', sucursal: cta.sucursal, folio: '', status: 'recibido',
            cliente: (res as { cliente_nombre?: string }).cliente_nombre || cta.cliente, monto, actor: 'cliente',
          });
        } catch (e: unknown) { this.logger.warn(`aviso a Cobranza falló: ${mensajeDe(e)}`); }
        this.logger.log(`ficha del cliente ${cta.sucursal}/${cta.cliente}: $${monto} del ${fecha} (lectura ${lectura?.ocr_status || 'ninguna'})`);
      }
      return { id: res.id, status: res.status, ya_estaba: res.ya_estaba };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════
  // Bandeja de Cobranza
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════

  /** Las fichas que subieron los clientes. Por default las que esperan revisión, la más vieja primero. */
  async bandeja(q: { estado?: string; limit?: number }): Promise<BandejaResp> {
    this.tenantCtx.requireTenantId();
    const estado = q.estado === 'todas' ? null : (q.estado || 'recibido');
    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 500);
    return this.tk.run(async (trx) => {
      const base = trx('finance.collection_deposits').where({ origen: 'cliente' });
      const conteo = await base.clone().select('status').count('* as n').groupBy('status');
      let qb = base.clone();
      if (estado) qb = qb.where('status', estado);
      const rows = await qb
        .orderBy('created_at', estado === 'recibido' ? 'asc' : 'desc').limit(limit)
        .select('id', 'status', 'cuenta_sucursal', 'cliente_code', 'cliente_nombre', 'files', 'sucursal', 'folio',
          trx.raw('reported_monto::numeric AS monto'), trx.raw('reported_fecha::text AS fecha'), 'reported_nota AS nota',
          trx.raw('ocr_monto::numeric AS ocr_monto'), trx.raw('ocr_fecha::text AS ocr_fecha'), 'ocr_banco', 'ocr_referencia',
          'ocr_status', 'monto_match', 'motivo_rechazo', 'validated_by', trx.raw('validated_at::text AS validated_at'),
          trx.raw('created_at::text AS enviado'));
      for (const r of rows) {
        r.files = await this.storage.signFiles(typeof r.files === 'string' ? JSON.parse(r.files || '[]') : (r.files || []));
        r.monto = r.monto != null ? Number(r.monto) : null;
        r.ocr_monto = r.ocr_monto != null ? Number(r.ocr_monto) : null;
      }
      const porEstado: Record<string, number> = { recibido: 0, validado: 0, rechazado: 0 };
      for (const c of conteo as Array<{ status: string; n: string | number }>) porEstado[c.status] = Number(c.n) || 0;
      // [CC.21] ¿Entró al banco? Sólo las que esperan revisión: las demás ya se decidieron.
      const porRevisar = (rows as FichaEnBandeja[]).filter((r) => r.status === 'recibido').map((r) => r.id);
      let bancoMedido = true;
      if (porRevisar.length) {
        try {
          const mapa = await trx.transaction((sp) => this.bancoDe(sp, porRevisar)); // SAVEPOINT: un error no aborta la bandeja
          for (const r of rows as FichaEnBandeja[]) if (mapa.has(r.id)) r.banco = mapa.get(r.id) || null;
        } catch (e: unknown) {
          bancoMedido = false;
          this.logger.warn(`bandeja: no se pudo revisar el banco (${mensajeDe(e).split(' - ').pop()})`); // knex antepone el SQL entero
        }
      }
      return { estado: estado || 'todas', por_estado: porEstado, fichas: rows, banco_medido: bancoMedido };
    });
  }

  /**
   * `[CC.21]` El cruce de cada ficha con el estado de cuenta y con el cobro que la conciliación ya le ligó. Ver
   * `ficha-en-banco.ts` (qué se cruza y lo medido). Se deriva al leer: cuando se sube el estado de cuenta, la siguiente
   * lectura ya lo ve, sin proceso de por medio.
   */
  private async bancoDe(trx: Knex.Transaction, ids: string[]): Promise<Map<string, FichaEnBanco>> {
    const fuente = `
      SELECT d.id::text AS id, d.cliente_code, d.reported_monto::numeric AS monto, d.ocr_monto::numeric AS monto_alt,
             COALESCE(d.reported_fecha, d.ocr_fecha)::date AS fecha, d.ocr_cuenta_dest AS cuenta_dest
        FROM finance.collection_deposits d
       WHERE d.origen = 'cliente' AND d.id = ANY(?::uuid[])`;
    const r = await trx.raw(sqlFichaEnBanco(fuente), [ids]);
    const datos = await trx('finance.collection_deposits').whereIn('id', ids)
      .select('id', trx.raw('COALESCE(reported_fecha, ocr_fecha)::text AS fecha'), trx.raw('COALESCE(reported_monto, ocr_monto)::numeric AS monto'));
    const porId = new Map((datos as Array<{ id: string; fecha: string | null; monto: string | null }>).map((d) => [d.id, d]));
    const mapa = new Map<string, FichaEnBanco>();
    for (const fila of r.rows as FilaFichaEnBanco[]) {
      const d = porId.get(fila.id);
      const abonos = (fila.abonos || []).map((a) => ({ ...a, monto: Number(a.monto) }));
      mapa.set(fila.id, clasificarFichaEnBanco({ ...fila, abonos }, d?.fecha || null, d?.monto != null ? Number(d.monto) : null));
    }
    marcarDisputas(mapa);
    return mapa;
  }

  /**
   * `[CC.21]` El dinero entró al banco y Kepler todavía no tiene el cobro: se declara el abono como de ESTE cliente,
   * por el camino que ya existe (`declararCliente`, «Depósitos sin cobro»), para que quien capture el cobro sepa de
   * quién es. ⛔ El abono NO viene del navegador: se vuelve a cruzar aquí y tiene que ser el único de la ficha.
   */
  async declararAbono(id: string, actor?: string): Promise<AbonoDeclaradoResp> {
    this.tenantCtx.requireTenantId();
    const { ficha, banco } = await this.tk.run(async (trx) => {
      const f = await trx('finance.collection_deposits').where({ id, origen: 'cliente' }).first('id', 'status', 'cliente_code');
      if (!f) throw new BadRequestException('ficha no encontrada');
      // Contra TODAS las que esperan revisión, no sólo ésta: la disputa (dos fichas, un abono) sólo se ve entre varias.
      // Cazado en la prueba de punta a punta: con [id] solo, la segunda ficha declaraba el abono de la primera.
      const pendientes: string[] = await trx('finance.collection_deposits')
        .where({ origen: 'cliente', status: 'recibido' }).orderBy('created_at', 'desc').limit(500).pluck('id');
      const mapa = await this.bancoDe(trx, pendientes.includes(id) ? pendientes : [id, ...pendientes]);
      return { ficha: f as { id: string; status: string; cliente_code: string | null }, banco: mapa.get(id) || null };
    });
    if (ficha.status !== 'recibido') throw new BadRequestException('sólo una ficha por revisar');
    if (!banco || banco.estado !== 'sin_aplicar' || banco.abonos.length !== 1) {
      throw new BadRequestException('la ficha ya no tiene un único abono sin cobro: vuelve a cargar la bandeja');
    }
    if (banco.disputado_con) throw new BadRequestException('otra ficha apunta al mismo abono: revísalas juntas');
    const abono = banco.abonos[0];
    if (abono.declarado && abono.declarado !== ficha.cliente_code) {
      throw new BadRequestException(`ese abono ya está declarado como del cliente ${abono.declarado}`);
    }
    const res = await this.deposits.declararCliente(abono.id, {
      customer_code: ficha.cliente_code, nota: `Ficha que subió el cliente (${id})`,
    }, actor);
    return { ok: res.ok, bank_movement_id: res.bank_movement_id, customer_code: res.customer_code };
  }

  /** Cobros de Kepler que pueden ser esta ficha: mismo monto (±$1) alrededor de la fecha; los del cliente primero. */
  async candidatos(id: string): Promise<{ cobros: CobroCandidato[] }> {
    this.tenantCtx.requireTenantId();
    const f = await this.tk.run(async (trx) => trx('finance.collection_deposits').where({ id, origen: 'cliente' })
      .first('cliente_code', trx.raw('COALESCE(ocr_monto, reported_monto)::numeric AS monto'),
        trx.raw('COALESCE(ocr_fecha, reported_fecha)::text AS fecha')));
    if (!f) throw new BadRequestException('ficha no encontrada');
    const { cobros } = await this.deposits.matchCobrosByOcr({ monto: Number(f.monto), fecha: f.fecha, limit: 20 });
    const lista = cobros as Array<{ cliente_code: string | null } & Record<string, unknown>>;
    const propios = lista.filter((c) => c.cliente_code === f.cliente_code).map((c) => ({ ...c, del_cliente: true }));
    const otros = lista.filter((c) => c.cliente_code !== f.cliente_code).map((c) => ({ ...c, del_cliente: false }));
    return { cobros: [...propios, ...otros] };
  }

  /**
   * `[CC.31]` **Qué factura del cliente cuadra con este depósito** — para que quien lo capture en Kepler no tenga
   * que buscarla. El cobro lo sigue capturando una persona (`CC.26`: el timbre lo pone el programa de Kepler
   * llamando al PAC, y escribir las tablas lo saltea); lo que la Suite quita del medio es **el trabajo de buscar**.
   *
   * ⭐ Vale la pena porque el cruce acierta seguido: medido el 2026-11-26 sobre los cobros de octubre y noviembre,
   * **59 % paga UNA sola factura** y **84 % paga una o dos**.
   *
   * Tres niveles, y **cada uno dice cuál es**:
   *  1. `exacta` — una factura cuyo saldo es el importe al centavo. Es la del caso que destapó esto.
   *  2. `una_de_varias` — hay más de una que cuadra: se ofrecen todas, no se elige por la Suite.
   *  3. `parcial` — ninguna cuadra sola; se devuelven las vivas más viejas para que la persona decida.
   * ⛔ Nunca se propone una combinación de facturas: sumar dos que casualmente dan el importe es el cruce por
   * importe sin control negativo, y eso ya costó antes.
   */
  async facturasQueCuadran(id: string): Promise<FacturasQueCuadran> {
    this.tenantCtx.requireTenantId();
    const f = await this.tk.run(async (trx) => trx('finance.collection_deposits')
      .where({ id, origen: 'cliente' })
      .first('cliente_code', 'sucursal', trx.raw('COALESCE(ocr_monto, reported_monto)::numeric AS monto')));
    if (!f) throw new BadRequestException('ficha no encontrada');
    const cliente = String((f as { cliente_code: string | null }).cliente_code ?? '').trim();
    const monto = Number((f as { monto: string }).monto);
    if (!cliente || !Number.isFinite(monto)) return { modo: 'parcial', monto: monto || 0, facturas: [] };

    const vivas = await this.tk.run(async (trx) => (await trx.raw(
      `SELECT doc_code, btrim(folio) AS folio, round(importe::numeric, 2)::float8 AS importe,
              round(saldo_documento::numeric, 2)::float8 AS saldo, fecha::text AS fecha, vencimiento::text AS vencimiento
         FROM analytics.customer_receivables_current
        WHERE tenant_id = current_tenant_id() AND cliente_code = ? AND sucursal = ?
          AND cargo_abono = 'C' AND saldo_documento > 0.004
        ORDER BY fecha`, [cliente, (f as { sucursal: string }).sucursal])).rows as FacturaQueCuadra[]);

    return elegirFacturasQueCuadran(monto, vivas);
  }

  /**
   * Cobranza liga la ficha al cobro que registró en Kepler: queda `validado`, con el folio del cobro (de la sucursal
   * del cobro, que puede no ser la de la cuenta) y su cuadre de monto.
   */
  async ligar(id: string, dto: { sucursal?: string; folio?: string }, actor?: string): Promise<CambioFichaResp> {
    const tenantId = this.tenantCtx.requireTenantId();
    const sucursal = (dto.sucursal || '').trim(); const folio = (dto.folio || '').trim();
    if (!sucursal || !folio) throw new BadRequestException('elige el cobro de Kepler');
    const out = await this.tk.run(async (trx) => {
      const cobro = await trx('analytics.erp_collections').where({ tenant_id: tenantId, sucursal, folio })
        .first('doc_prefix', 'cobro_date', trx.raw('monto::numeric AS monto'), 'cliente_nombre');
      if (!cobro) throw new BadRequestException(`el cobro ${sucursal}/${folio} no está en el espejo de Kepler`);
      const [row] = await trx('finance.collection_deposits')
        .where({ id, origen: 'cliente' }).whereIn('status', ['recibido', 'rechazado'])
        .update({
          sucursal, folio, doc_prefix: cobro.doc_prefix || 'UA0501', cobro_date: cobro.cobro_date,
          cobro_monto: cobro.monto,
          monto_match: trx.raw('abs(COALESCE(ocr_monto, reported_monto) - ?::numeric) <= 1', [cobro.monto]),
          status: 'validado', validated_by: actor || null, validated_at: trx.fn.now(), motivo_rechazo: null,
          linked_at: trx.fn.now(), linked_by: actor || null, updated_at: trx.fn.now(),
        })
        .returning(['id', 'status', 'cliente_nombre', trx.raw('reported_monto::numeric AS monto')]);
      if (!row) throw new BadRequestException('la ficha no existe o ya está ligada');
      return row;
    });
    try {
      this.gateway?.emitChange(tenantId, { action: 'validated', sucursal, folio, status: 'validado', cliente: out.cliente_nombre, monto: Number(out.monto) || null, actor: actor || null });
    } catch { /* aviso best-effort */ }
    return { id: out.id, status: out.status };
  }

  /** Rechaza con un motivo que el CLIENTE va a leer en su enlace. */
  async rechazar(id: string, motivo: string | undefined, actor?: string): Promise<CambioFichaResp> {
    const m = (motivo || '').trim();
    if (m.length < 3) throw new BadRequestException('escribe el motivo: el cliente lo va a leer');
    const own = await this.tk.run(async (trx) => trx('finance.collection_deposits').where({ id, origen: 'cliente' }).first('id', 'status'));
    if (!own) throw new BadRequestException('ficha no encontrada');
    // Sólo lo que espera revisión. Una ficha ya ligada a un cobro no se rechaza desde aquí (medido en la prueba de punta
    // a punta: el rechazo caía sobre una ficha validada y la desligaba del cobro en silencio).
    if (own.status !== 'recibido') throw new BadRequestException('sólo se rechaza una ficha que está por revisar');
    return this.deposits.reject(id, actor, m);
  }
}
