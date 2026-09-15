import { Injectable, BadRequestException, ForbiddenException, NotFoundException, Logger, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import { TenantKnexService, TenantContextService, ObjectStorageService, LlmExtractorService } from '@megadulces/platform-core';
import { ExpenseProofsGateway } from './expense-proofs.gateway';
import { PROOF_FILE_ROLES, ProofFileRole, ProofFile, EXPENSE_CLASIFICACIONES, ExpenseClasificacion, requiereEvidencia } from './expense-proofs.service';

/**
 * GX.9 — Captura de gasto **por link**, desde el celular y sin cuenta.
 *
 * Por qué existe: el orden real de los hechos es al revés del que el sistema exigía. El
 * trabajador recibe la solicitud firmada en papel, gasta, junta tickets — y recién después
 * alguien en oficina lo captura en Kepler. Como `folio_solicitud` era NOT NULL, no había
 * dónde guardar la evidencia mientras tanto y la foto se quedaba en el celular.
 *
 * El link es **por persona, reutilizable y revocable**, no por gasto. Un link de un solo uso
 * lo tendría que emitir alguien de oficina cada vez, y el punto es justamente que en oficina
 * todavía no saben que el gasto ocurrió. Además es lo único que cierra el lazo del rechazo:
 * el trabajador necesita un lugar donde enterarse de que le devolvieron un ticket.
 *
 * Reglas duras de la superficie pública:
 *   · **Sólo escribe, y sólo lee lo suyo.** No lista gastos de la empresa, no consulta Kepler,
 *     no devuelve nada que no haya subido ese mismo link.
 *   · **Nunca se auto-valida**, aunque el OCR cuadre al centavo. Lo revisa un humano. El
 *     cuadre igual corre y se guarda, para que quien revise lo vea hecho.
 *   · La **autoridad es la fila**, no el JWT: persona, vigencia y revocación se releen de
 *     `finance.expense_capture_links` en CADA uso, así revocar surte efecto al instante.
 */

/** Lo que el token carga. Deliberadamente mínimo: el resto se relee de la DB. */
interface CaptureTokenPayload { t: 'expense_capture'; lid: string; tenant_id: string; }

export interface IssueLinkDto { persona?: string; sucursal?: string; nota?: string; expires_at?: string; }

export interface CaptureSubmitDto {
  importe?: number;
  concepto?: string;
  beneficiario?: string;
  sucursal?: string;
  fecha_gasto?: string;
  clasificacion?: string;
  /** Motivo, obligatorio cuando el gasto es `no_comprobable`. */
  comentarios?: string;
  files?: ProofFile[];
  /** Huella de la captura: si la cámara fue en vivo o se cayó al selector de archivos. */
  camera?: 'live' | 'file';
  captured_at?: string;
  user_agent?: string;
}

/** Fila viva del link, ya validada (no revocada, no vencida). */
interface LiveLink { id: string; tenantId: string; persona: string; sucursal: string | null; }

@Injectable()
export class ExpenseCaptureLinksService {
  private readonly logger = new Logger(ExpenseCaptureLinksService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly jwt: JwtService,
    private readonly storage: ObjectStorageService,
    private readonly ocr: LlmExtractorService,
    @Optional() private readonly gateway?: ExpenseProofsGateway,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // Lado interno: emitir, listar, revocar
  // ══════════════════════════════════════════════════════════════════════════

  /** Emite el link de una persona. Devuelve la URL ya armada para copiar y mandar. */
  async issue(dto: IssueLinkDto, actor?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    const persona = (dto.persona || '').trim().replace(/\s+/g, ' ');
    if (!persona) throw new BadRequestException('¿a nombre de quién es el link?');

    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.expense_capture_links')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          persona: persona.toUpperCase(),
          sucursal: (dto.sucursal || '').trim() || null,
          nota: (dto.nota || '').trim() || null,
          expires_at: dto.expires_at || null,
          created_by: actor || null,
        })
        .returning(['id', 'persona', 'sucursal', 'expires_at']);

      this.logger.log(`link de captura emitido para ${row.persona} por ${actor || '?'}`);
      return { ...row, ...this.linkUrl(row.id, tenantId) };
    });
  }

  /** Los links emitidos, con cuántas capturas trajo cada uno. */
  async list() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const rows = await trx('finance.expense_capture_links as l')
        .leftJoin('finance.expense_proofs as p', 'p.capture_link_id', 'l.id')
        .groupBy('l.id')
        .orderBy('l.created_at', 'desc')
        .select('l.id', 'l.persona', 'l.sucursal', 'l.nota', 'l.expires_at', 'l.revoked_at',
          'l.last_used_at', 'l.uses', 'l.created_by', 'l.created_at',
          trx.raw('COUNT(p.id)::int AS capturas'),
          trx.raw(`COUNT(p.id) FILTER (WHERE p.folio_solicitud IS NULL)::int AS sin_casar`));
      return rows.map((r: any) => ({
        ...r,
        vigente: !r.revoked_at && (!r.expires_at || new Date(r.expires_at) > new Date()),
        ...this.linkUrl(r.id, tenantId),
      }));
    });
  }

  /** Revocar es un UPDATE: surte efecto en el siguiente uso, sin esperar a que expire el JWT. */
  async revoke(id: string, actor?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.expense_capture_links')
        .where({ id }).whereNull('revoked_at')
        .update({ revoked_at: trx.fn.now(), updated_at: trx.fn.now() })
        .returning(['id', 'persona']);
      if (!row) throw new NotFoundException('link no encontrado o ya revocado');
      this.logger.log(`link de ${row.persona} revocado por ${actor || '?'}`);
      return row;
    });
  }

  /**
   * El token firmado + la URL para compartir. `APP_PUBLIC_URL` es el origen desde el que
   * el trabajador abre el celular; en local cae al dev server.
   */
  private linkUrl(linkId: string, tenantId: string) {
    const payload: CaptureTokenPayload = { t: 'expense_capture', lid: linkId, tenant_id: tenantId };
    // Vigencia larga a propósito: la autoridad real es `revoked_at`/`expires_at` de la fila,
    // que se relee en cada uso. Un JWT corto obligaría a re-emitir el link cada semana.
    const token = this.jwt.sign(payload, { expiresIn: '365d' });
    const base = (process.env.APP_PUBLIC_URL || 'http://localhost:4200').replace(/\/+$/, '');
    return { token, url: `${base}/captura/${token}` };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Lado público: el celular del trabajador
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Verifica el token y **relee la fila**. Que el JWT sea válido no alcanza: el link pudo
   * revocarse o vencerse después de firmarlo.
   */
  private async resolveLink(token: string): Promise<LiveLink> {
    let payload: CaptureTokenPayload;
    try {
      payload = this.jwt.verify<CaptureTokenPayload>(token);
    } catch {
      throw new ForbiddenException('este link ya no sirve');
    }
    if (payload?.t !== 'expense_capture' || !payload.lid || !payload.tenant_id) {
      throw new ForbiddenException('este link ya no sirve');
    }

    const row = await this.tenantCtx.run({ tenantId: payload.tenant_id }, () =>
      this.tk.run(async (trx) =>
        trx('finance.expense_capture_links').where({ id: payload.lid })
          .first('id', 'persona', 'sucursal', 'revoked_at', 'expires_at')));

    if (!row) throw new ForbiddenException('este link ya no sirve');
    if (row.revoked_at) throw new ForbiddenException('este link fue dado de baja — pedí uno nuevo');
    if (row.expires_at && new Date(row.expires_at) <= new Date()) {
      throw new ForbiddenException('este link ya venció — pedí uno nuevo');
    }
    return { id: row.id, tenantId: payload.tenant_id, persona: row.persona, sucursal: row.sucursal };
  }

  /** Corre `fn` dentro del scope de tenant del link (la ruta pública no lo hereda del JWT). */
  private inScope<T>(link: LiveLink, fn: () => Promise<T>): Promise<T> {
    return this.tenantCtx.run({ tenantId: link.tenantId, username: `link:${link.persona}` }, fn);
  }

  /**
   * Lo que ve el trabajador al abrir el link: quién es, a qué sucursal tira por default, el
   * catálogo de sucursales para poder corregirla, y **sus propias capturas anteriores** con
   * su estado. Eso último es lo que cierra el lazo del rechazo.
   *
   * NO devuelve nada de la empresa: ni gastos ajenos, ni Kepler, ni importes de nadie más.
   */
  async context(token: string) {
    const link = await this.resolveLink(token);
    return this.inScope(link, () => this.tk.run(async (trx) => {
      const sucursales = await trx('commercial.warehouses')
        .whereNull('deleted_at').orderBy('code')
        .select('code', 'name');

      const mias = await trx('finance.expense_proofs')
        .where({ capture_link_id: link.id })
        .orderBy('created_at', 'desc').limit(20)
        .select('id', 'folio_solicitud', 'status', 'proveedor', 'comentarios',
          'motivo_rechazo', 'revision_nota', 'created_at',
          trx.raw('importe::numeric AS importe'),
          trx.raw(`to_char(fecha_gasto,'YYYY-MM-DD') AS fecha_gasto`));

      return {
        persona: link.persona,
        sucursal: link.sucursal,
        sucursales: sucursales.map((s: any) => ({ code: s.code, label: s.name ? `${s.code} · ${s.name}` : s.code })),
        capturas: mias.map((m: any) => ({
          ...m,
          importe: Number(m.importe) || 0,
          // Lo que el trabajador necesita saber, en su idioma — no el estado interno.
          estado: this.estadoEnLlano(m.status, m.folio_solicitud),
        })),
      };
    }));
  }

  /** El estado del expediente dicho para quien lo subió, no para el contador. */
  private estadoEnLlano(status: string, folio: string | null): string {
    if (status === 'rechazada') return 'Te lo devolvieron — hay que corregirlo';
    if (status === 'validada') return 'Aceptado';
    if (status === 'revision') return 'En revisión';
    if (!folio) return 'Recibido — falta ligarlo a su solicitud';
    return 'Recibido';
  }

  /** Sube UN archivo desde el link. Mismo bucket y mismos roles que la captura interna. */
  async uploadFile(token: string, dataUri: string, role: string): Promise<ProofFile> {
    const link = await this.resolveLink(token);
    if (!dataUri) throw new BadRequestException('archivo requerido');
    if (!PROOF_FILE_ROLES.includes(role as ProofFileRole)) throw new BadRequestException(`role inválido: ${role}`);
    return this.inScope(link, async () => {
      try {
        const f = await this.storage.putFile(dataUri, `finance/${link.tenantId}/expense-proofs`);
        return { role, url: f.key, public_id: f.key, kind: f.kind };
      } catch (e: any) {
        if (e?.status === 400) throw e;
        this.logger.error(`link ${link.persona}: fallo subiendo ${role}: ${e?.message || e}`);
        throw new BadRequestException('no se pudo subir el archivo');
      }
    });
  }

  /**
   * Alta del expediente desde el link. Queda **sin folio** (`folio_solicitud IS NULL`) hasta
   * que en oficina lo casen con su solicitud XA1501.
   *
   * El cuadre por visión corre contra el importe que **declaró** quien sube — que es lo único
   * contra qué cuadrar sin folio, y sirve: caza que el ticket no diga lo que dijo que dice.
   * El cuadre bueno (contra Kepler) corre después, al casar.
   */
  async submit(token: string, dto: CaptureSubmitDto) {
    const link = await this.resolveLink(token);

    const importe = Number(dto.importe) || 0;
    if (!(importe > 0)) throw new BadRequestException('¿de cuánto fue el gasto?');
    const concepto = (dto.concepto || '').trim();
    if (!concepto) throw new BadRequestException('contá en una línea de qué fue el gasto');
    const beneficiario = (dto.beneficiario || '').trim();
    if (!beneficiario) throw new BadRequestException('¿a quién le pagaste?');
    const sucursal = (dto.sucursal || link.sucursal || '').trim();
    if (!sucursal) throw new BadRequestException('¿de qué sucursal es el gasto?');

    const clasificacion = (dto.clasificacion || '').trim() as ExpenseClasificacion;
    if (!EXPENSE_CLASIFICACIONES.includes(clasificacion)) {
      throw new BadRequestException('elegí qué tipo de gasto es');
    }
    const lleva = requiereEvidencia(clasificacion);
    const motivo = (dto.comentarios || '').trim();
    if (!lleva && !motivo) throw new BadRequestException('contá por qué no hay comprobante');

    const files = (Array.isArray(dto.files) ? dto.files : []).filter((f) => f && f.url && f.role);
    const roles = new Set(files.map((f) => f.role));
    // La solicitud firmada respalda la salida de dinero: va en los TRES tipos de gasto.
    if (!roles.has('solicitud_kepler')) {
      throw new BadRequestException('falta la foto de la solicitud firmada');
    }
    if (lleva && !files.some((f) => String(f.role).startsWith('comprobante'))) {
      throw new BadRequestException('falta la foto del ticket');
    }

    // Visión contra el importe DECLARADO. Fuera de la transacción: es I/O de segundos.
    const ocr = lleva ? await this.leerTicket(link, files, importe) : null;

    return this.inScope(link, () => this.tk.run(async (trx) => {
      const [row] = await trx('finance.expense_proofs')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          solicitante: link.persona,
          departamento: null,
          sucursal,
          fecha_gasto: dto.fecha_gasto || trx.raw('CURRENT_DATE'),
          folio_solicitud: null,          // ← sin casar todavía; ésa es la novedad
          proveedor: beneficiario,
          importe,
          clasificacion,
          comprobacion_nota: lleva ? null : motivo,
          comentarios: motivo || concepto,
          files: JSON.stringify(files),
          // Aunque el OCR cuadre al centavo NO se cierra solo: superficie pública, la ve un
          // humano. El cuadre se guarda igual, para que quien revise lo encuentre hecho.
          status: 'recibida',
          monto_ocr: ocr?.usado ?? null,
          monto_match: ocr ? ocr.match : null,
          revision_nota: ocr && !ocr.match ? ocr.nota : null,
          origen: 'link',
          capture_link_id: link.id,
          capture_meta: JSON.stringify({
            captured_at: dto.captured_at || new Date().toISOString(),
            camera: dto.camera === 'live' ? 'live' : 'file',
            user_agent: (dto.user_agent || '').slice(0, 300),
            hashes: files.map((f) => this.hashKey(f)),
          }),
          created_by: `link:${link.persona}`,
        })
        .returning(['id', 'status']);

      await trx('finance.expense_capture_links').where({ id: link.id })
        .update({ uses: trx.raw('uses + 1'), last_used_at: trx.fn.now(), updated_at: trx.fn.now() });

      this.logger.log(`captura por link de ${link.persona}: ${beneficiario} ${importe} [${clasificacion}] · ${files.length} fotos`);
      // El aviso al tablero es el mismo que ya usa la captura interna.
      try {
        this.gateway?.emitChange(link.tenantId, {
          action: 'captured', folio_solicitud: '(sin folio)', status: row.status,
          solicitante: link.persona, sucursal, importe, actor: `link:${link.persona}`,
        });
      } catch { /* el aviso no debe tumbar la captura */ }

      return { id: row.id, status: row.status, estado: this.estadoEnLlano(row.status, null) };
    }));
  }

  /** Lee el ticket con Claude Vision y lo cuadra contra el importe esperado. */
  private async leerTicket(link: LiveLink, files: ProofFile[], esperado: number) {
    const comp = files.find((f) => f.role === 'comprobante_1') || files.find((f) => String(f.role).startsWith('comprobante'));
    const key = comp?.public_id || comp?.url || '';
    if (!key || !process.env.ANTHROPIC_API_KEY) return null;
    try {
      const dataUri = await this.inScope(link, () => this.storage.getDataUri(key));
      if (!dataUri) return null;
      const m = /^data:([^;,]+)[;,]/.exec(dataUri);
      const mediaType = (m ? m[1] : 'image/jpeg').toLowerCase();
      const f = await this.ocr.extractExpenseReceipt(dataUri.replace(/^data:[^,]*,/, ''), mediaType as any);
      const legible = f.legible && (f.total != null || f.subtotal != null);
      const tol = Math.max(1, Math.abs(esperado) * 0.01);
      let usado: number | null = null; let match = false;
      for (const v of [f.total, f.subtotal]) {
        if (v != null && Number.isFinite(v)) { usado = usado ?? v; if (Math.abs(v - esperado) <= tol) { usado = v; match = true; break; } }
      }
      const fmt = (v: number | null) => (v == null ? '—' : `$${(Number(v) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`);
      return {
        usado, match: legible && match,
        nota: !legible ? 'Foto ilegible — validar a mano'
          : `Declaró ${fmt(esperado)} y el ticket dice ${fmt(usado)}`,
      };
    } catch (e: any) {
      this.logger.warn(`visión falló en captura por link: ${e?.message || e}`);
      return null;
    }
  }

  /** Huella del archivo, para cazar el mismo ticket subido dos veces. */
  private hashKey(f: ProofFile): string {
    return createHash('sha256').update(String(f.public_id || f.url)).digest('hex').slice(0, 16);
  }
}
