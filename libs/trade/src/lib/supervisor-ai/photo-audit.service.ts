import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION, TenantContextService } from '@megadulces/platform-core';

/**
 * Horus — Capa de VISIÓN (Sprint H2.2).
 *
 * Claude Haiku MIRA cada foto de exhibición (Cloudinary) y devuelve un veredicto
 * ESTRUCTURADO (¿es un anaquel?, marca propia/competencia visible, calidad de
 * ejecución, quiebre de stock, calidad de foto). El motor (FindingsEngine) decide
 * los hallazgos sobre esos hechos — el LLM nunca decide ni sanciona (ADR-016/020).
 *
 * Cruce clave: `declared_own` (perteneceMegaDulces de la captura) vs lo observado.
 * `mismatch=true` (gating duro) cuando se declaró propio pero la foto, siendo un
 * anaquel legible, solo muestra competencia → semilla de fraude para H2.4.
 *
 * Costo acotado: incremental (dedup por photo_key, salta lo ya analizado), tope por
 * corrida (MAX_PER_RUN), concurrencia limitada. Sin ANTHROPIC_API_KEY → no-op
 * graciosa (retryable). Lee/escribe vía KNEX_CONNECTION + tenant explícito.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PER_RUN = 12; // tope de fotos por corrida on-demand (control de costo/latencia)
const CONCURRENCY = 4;
const MAX_IMAGE_BYTES = 4_500_000; // límite práctico de la API de visión
const SCAN_WINDOW_DAYS = 45;
const ALLOWED_MEDIA = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

type Verdict = {
  is_shelf: boolean | null;
  own_brand_visible: boolean | null;
  competitor_visible: boolean | null;
  shelf_quality: number | null;
  out_of_stock: boolean | null;
  photo_quality: string | null;
  notes: string | null;
};

@Injectable()
export class PhotoAuditService {
  private readonly logger = new Logger(PhotoAuditService.name);
  private readonly endpoint = 'https://api.anthropic.com/v1/messages';
  private readonly model = 'claude-haiku-4-5-20251001';
  private readonly apiKey = process.env.ANTHROPIC_API_KEY || '';
  private readonly timeoutMs = 30_000;

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    @Optional() private readonly tenantContext?: TenantContextService,
  ) {}

  private tenantId(user: any): string | undefined {
    return user?.tenant_id || this.tenantContext?.get()?.tenantId;
  }

  private static parseArray(v: any): any[] {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
      try {
        const p = JSON.parse(v);
        return Array.isArray(p) ? p : [];
      } catch {
        return [];
      }
    }
    return [];
  }

  /**
   * Escanea (incremental + acotado) las fotos de exhibición no analizadas y
   * persiste el veredicto. Devuelve stats. Lo invoca /vision/scan y el cron.
   */
  async scanForTenant(
    tenantId: string,
    opts: { max?: number } = {},
  ): Promise<{ analyzed: number; skipped: number; errors: number; candidates: number; reason?: string }> {
    if (!tenantId) return { analyzed: 0, skipped: 0, errors: 0, candidates: 0, reason: 'no_tenant' };
    if (!this.apiKey) {
      return { analyzed: 0, skipped: 0, errors: 0, candidates: 0, reason: 'no_api_key' };
    }
    const max = Math.max(1, Math.min(opts.max || MAX_PER_RUN, 50));

    const caps = await this.knex('daily_captures as dc')
      .where('dc.tenant_id', tenantId)
      .whereRaw(`dc.hora_inicio >= now() - interval '${SCAN_WINDOW_DAYS} days'`)
      .orderBy('dc.hora_inicio', 'desc')
      .select('dc.id', 'dc.exhibiciones');

    // Aplana a fotos candidatas (con fotoUrl).
    const candidates: {
      capture_id: string;
      idx: number;
      foto_url: string;
      foto_public_id: string | null;
      declared_own: boolean | null;
      photo_key: string;
    }[] = [];
    for (const c of caps) {
      const exhibs = PhotoAuditService.parseArray(c.exhibiciones);
      exhibs.forEach((e: any, idx: number) => {
        if (!e || typeof e.fotoUrl !== 'string' || !/^https?:\/\//.test(e.fotoUrl)) return;
        const publicId = typeof e.fotoPublicId === 'string' ? e.fotoPublicId : null;
        candidates.push({
          capture_id: c.id,
          idx,
          foto_url: e.fotoUrl,
          foto_public_id: publicId,
          declared_own: typeof e.perteneceMegaDulces === 'boolean' ? e.perteneceMegaDulces : null,
          photo_key: publicId || `${c.id}:${idx}`,
        });
      });
    }

    // Incremental: salta lo ya analizado OK.
    const done = new Set<string>(
      (
        await this.knex('commercial.capture_vision')
          .where({ tenant_id: tenantId, status: 'analyzed' })
          .select('photo_key')
      ).map((r: any) => r.photo_key),
    );
    const pending = candidates.filter((c) => !done.has(c.photo_key)).slice(0, max);

    let analyzed = 0;
    let errors = 0;
    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      const chunk = pending.slice(i, i + CONCURRENCY);
      const rows = await Promise.all(chunk.map((cand) => this.analyzeOne(tenantId, cand)));
      const valid = rows.filter(Boolean) as any[];
      for (const r of valid) {
        if (r.status === 'analyzed') analyzed++;
        else errors++;
      }
      if (valid.length) {
        await this.knex('commercial.capture_vision')
          .insert(valid)
          .onConflict(['tenant_id', 'photo_key'])
          .merge([
            'capture_id',
            'exhibition_idx',
            'foto_url',
            'foto_public_id',
            'declared_own',
            'is_shelf',
            'own_brand_visible',
            'competitor_visible',
            'shelf_quality',
            'out_of_stock',
            'photo_quality',
            'mismatch',
            'verdict',
            'model',
            'status',
            'error',
            'analyzed_at',
            'updated_at',
          ]);
      }
    }

    return { analyzed, skipped: candidates.length - pending.length, errors, candidates: candidates.length };
  }

  private async analyzeOne(tenantId: string, cand: any): Promise<any | null> {
    const base = {
      tenant_id: tenantId,
      capture_id: cand.capture_id,
      photo_key: String(cand.photo_key).slice(0, 200),
      exhibition_idx: cand.idx,
      foto_url: cand.foto_url,
      foto_public_id: cand.foto_public_id,
      declared_own: cand.declared_own,
      model: this.model,
      analyzed_at: this.knex.fn.now(),
      updated_at: this.knex.fn.now(),
    };
    try {
      const img = await this.fetchImage(cand.foto_url);
      const v = await this.callVision(img.base64, img.mediaType);
      if (!v) throw new Error('sin veredicto');
      const mismatch =
        v.is_shelf === true &&
        (v.photo_quality === 'good' || v.photo_quality === 'blurry') &&
        cand.declared_own === true &&
        v.own_brand_visible === false &&
        v.competitor_visible === true;
      return {
        ...base,
        is_shelf: v.is_shelf,
        own_brand_visible: v.own_brand_visible,
        competitor_visible: v.competitor_visible,
        shelf_quality: v.shelf_quality != null ? Math.max(0, Math.min(1, v.shelf_quality)) : null,
        out_of_stock: v.out_of_stock,
        photo_quality: v.photo_quality ? String(v.photo_quality).slice(0, 12) : null,
        mismatch,
        verdict: JSON.stringify(v),
        status: 'analyzed',
        error: null,
      };
    } catch (e: any) {
      return { ...base, status: 'error', error: String(e?.message || e).slice(0, 300), verdict: '{}' };
    }
  }

  private async fetchImage(url: string): Promise<{ base64: string; mediaType: string }> {
    const ctrl = new AbortController();
    const tId = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`fetch imagen ${res.status}`);
      let mediaType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!ALLOWED_MEDIA.includes(mediaType)) mediaType = 'image/jpeg';
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error('imagen demasiado grande');
      return { base64: buf.toString('base64'), mediaType };
    } finally {
      clearTimeout(tId);
    }
  }

  private async callVision(base64: string, mediaType: string): Promise<Verdict | null> {
    const ctrl = new AbortController();
    const tId = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 512,
          tool_choice: { type: 'tool', name: 'audit_exhibition_photo' },
          tools: [
            {
              name: 'audit_exhibition_photo',
              description:
                'Audita la foto de una exhibición de dulces en una tienda. Devolvé SOLO lo que REALMENTE ves en la imagen; no inventes ni asumas.',
              input_schema: {
                type: 'object',
                properties: {
                  is_shelf: {
                    type: 'boolean',
                    description: '¿La foto muestra una exhibición/anaquel de productos? false si es selfie, recibo, persona, o imagen no relacionada.',
                  },
                  own_brand_visible: { type: 'boolean', description: '¿Se ven productos de dulces (marca propia)?' },
                  competitor_visible: { type: 'boolean', description: '¿Se ven productos de marcas competidoras?' },
                  shelf_quality: {
                    type: 'number',
                    description: 'Calidad de ejecución 0..1 (orden, llenado, visibilidad de marca). 0 = pésima, 1 = excelente.',
                  },
                  out_of_stock: { type: 'boolean', description: '¿Hay huecos o espacios vacíos notorios (quiebre de stock)?' },
                  photo_quality: { type: 'string', enum: ['good', 'blurry', 'dark', 'unusable'] },
                  notes: { type: 'string', description: 'Observación breve, máx 1 frase en español.' },
                },
                required: ['is_shelf', 'photo_quality'],
              },
            },
          ],
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
                {
                  type: 'text',
                  text: 'Sos un supervisor de trade marketing auditando la ejecución en punto de venta. Analizá esta foto de una exhibición de dulces y completá la herramienta audit_exhibition_photo con lo que REALMENTE ves.',
                },
              ],
            },
          ],
        }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(tId);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic ${res.status}: ${body.slice(0, 160)}`);
    }
    const json = (await res.json()) as { content: Array<{ type: string; name?: string; input?: any }> };
    const tool = json.content?.find((c) => c.type === 'tool_use' && c.name === 'audit_exhibition_photo');
    if (!tool) return null;
    const i = tool.input || {};
    return {
      is_shelf: typeof i.is_shelf === 'boolean' ? i.is_shelf : null,
      own_brand_visible: typeof i.own_brand_visible === 'boolean' ? i.own_brand_visible : null,
      competitor_visible: typeof i.competitor_visible === 'boolean' ? i.competitor_visible : null,
      shelf_quality: typeof i.shelf_quality === 'number' ? i.shelf_quality : null,
      out_of_stock: typeof i.out_of_stock === 'boolean' ? i.out_of_stock : null,
      photo_quality: typeof i.photo_quality === 'string' ? i.photo_quality : null,
      notes: typeof i.notes === 'string' ? i.notes.slice(0, 300) : null,
    };
  }

  /** Lista veredictos (flagged primero: mismatch, no-anaquel, stockout). */
  async listVision(filters: { capture_id?: string; flagged?: boolean }, user: any) {
    const tenantId = this.tenantId(user);
    let q = this.knex('commercial.capture_vision as cv')
      .leftJoin('daily_captures as dc', 'dc.id', 'cv.capture_id')
      .leftJoin('stores as s', 's.id', 'dc.store_id')
      .select(
        'cv.*',
        this.knex.ref('dc.captured_by_username').as('captured_by'),
        this.knex.ref('s.nombre').as('store_name'),
      );
    if (tenantId) q = q.where('cv.tenant_id', tenantId);
    if (filters.capture_id && UUID_RE.test(filters.capture_id)) q = q.where('cv.capture_id', filters.capture_id);
    if (filters.flagged) {
      q = q.where((b) =>
        b.where('cv.mismatch', true).orWhere('cv.out_of_stock', true).orWhere('cv.is_shelf', false),
      );
    }
    q = q
      .orderByRaw('(cv.mismatch IS TRUE) DESC, (cv.is_shelf IS FALSE) DESC, (cv.out_of_stock IS TRUE) DESC')
      .orderBy('cv.analyzed_at', 'desc')
      .limit(100);
    const rows = await q;
    return { rows, total: rows.length };
  }

  /** Cobertura de visión: cuántas fotos hay vs analizadas + banderas. */
  async coverage(user: any) {
    const tenantId = this.tenantId(user);
    if (!tenantId) return { photos_total: 0, analyzed: 0, is_shelf: 0, out_of_stock: 0, mismatch: 0, unusable: 0, has_api_key: !!this.apiKey };

    const caps = await this.knex('daily_captures as dc')
      .where('dc.tenant_id', tenantId)
      .whereRaw(`dc.hora_inicio >= now() - interval '${SCAN_WINDOW_DAYS} days'`)
      .select('dc.exhibiciones');
    let photosTotal = 0;
    for (const c of caps) {
      for (const e of PhotoAuditService.parseArray(c.exhibiciones)) {
        if (e && typeof e.fotoUrl === 'string' && /^https?:\/\//.test(e.fotoUrl)) photosTotal++;
      }
    }

    const agg = await this.knex('commercial.capture_vision')
      .where({ tenant_id: tenantId, status: 'analyzed' })
      .select(
        this.knex.raw('count(*)::int as analyzed'),
        this.knex.raw('count(*) FILTER (WHERE is_shelf IS TRUE)::int as is_shelf'),
        this.knex.raw('count(*) FILTER (WHERE out_of_stock IS TRUE)::int as out_of_stock'),
        this.knex.raw('count(*) FILTER (WHERE mismatch IS TRUE)::int as mismatch'),
        this.knex.raw(`count(*) FILTER (WHERE photo_quality = 'unusable' OR is_shelf IS FALSE)::int as unusable`),
      )
      .first();

    return {
      photos_total: photosTotal,
      analyzed: Number(agg?.analyzed || 0),
      is_shelf: Number(agg?.is_shelf || 0),
      out_of_stock: Number(agg?.out_of_stock || 0),
      mismatch: Number(agg?.mismatch || 0),
      unusable: Number(agg?.unusable || 0),
      has_api_key: !!this.apiKey,
    };
  }

  /**
   * Motor de findings de VISIÓN (source='vision'). Agrega los veredictos (30d) por
   * tienda (stockout) y por colaborador (mismatch, fotos inválidas) y emite hallazgos
   * deterministas. Respeta decisiones humanas y auto-resuelve lo que ya no aplica.
   */
  async generateVisionFindings(tenantId: string): Promise<{ open: number; resolved: number }> {
    if (!tenantId) return { open: 0, resolved: 0 };

    const rows = await this.knex('commercial.capture_vision as cv')
      .leftJoin('daily_captures as dc', 'dc.id', 'cv.capture_id')
      .where({ 'cv.tenant_id': tenantId, 'cv.status': 'analyzed' })
      .whereRaw("cv.analyzed_at >= now() - interval '30 days'")
      .select(
        'cv.capture_id',
        'cv.is_shelf',
        'cv.out_of_stock',
        'cv.mismatch',
        'cv.photo_quality',
        'dc.user_id',
        'dc.store_id',
        'dc.captured_by_username',
      );

    const storeRows = await this.knex('stores')
      .where('tenant_id', tenantId)
      .whereNull('deleted_at')
      .select('id', 'nombre');
    const storeName = new Map<string, string>();
    storeRows.forEach((s: any) => storeName.set(s.id, s.nombre));

    type Agg = { stockout: number; mismatch: number; invalid: number; total: number; sample: string | null; label: string | null };
    const byStore = new Map<string, Agg>();
    const byCollab = new Map<string, Agg>();
    const ensure = (m: Map<string, Agg>, k: string, label: string | null): Agg => {
      let a = m.get(k);
      if (!a) {
        a = { stockout: 0, mismatch: 0, invalid: 0, total: 0, sample: null, label };
        m.set(k, a);
      }
      return a;
    };

    for (const r of rows) {
      if (r.store_id) {
        const a = ensure(byStore, r.store_id, storeName.get(r.store_id) || 'Tienda');
        a.total++;
        if (r.out_of_stock === true) {
          a.stockout++;
          a.sample = a.sample || r.capture_id;
        }
      }
      if (r.user_id) {
        const a = ensure(byCollab, r.user_id, r.captured_by_username || 'Colaborador');
        a.total++;
        if (r.mismatch === true) {
          a.mismatch++;
          a.sample = a.sample || r.capture_id;
        }
        if (r.is_shelf === false || r.photo_quality === 'unusable') a.invalid++;
      }
    }

    const findings: any[] = [];
    const add = (
      type: string,
      severity: string,
      subjectType: string,
      subjectId: string,
      label: string | null,
      captureId: string | null,
      score: number,
      evidence: any,
    ) => {
      findings.push({
        tenant_id: tenantId,
        dedup_key: `${type}:${subjectType}:${subjectId}`,
        finding_type: type,
        severity,
        subject_type: subjectType,
        subject_id: subjectId,
        label: label ? String(label).slice(0, 160) : null,
        capture_id: captureId && UUID_RE.test(captureId) ? captureId : null,
        score: Math.round(score * 100) / 100,
        evidence: JSON.stringify(evidence),
        source: 'vision',
        status: 'open',
      });
    };

    for (const [storeId, a] of byStore) {
      if (a.stockout >= 1) {
        add('vision_stockout', a.stockout >= 3 ? 'critical' : 'warn', 'store', storeId, a.label, a.sample, a.stockout, {
          stockout_photos: a.stockout,
          analyzed: a.total,
        });
      }
    }
    for (const [userId, a] of byCollab) {
      if (a.mismatch >= 1) {
        add('vision_mismatch', 'critical', 'collaborator', userId, a.label, a.sample, a.mismatch, {
          mismatch_photos: a.mismatch,
          analyzed: a.total,
        });
      }
      if (a.total >= 3 && a.invalid / a.total >= 0.4) {
        add('vision_invalid', 'warn', 'collaborator', userId, a.label, null, a.invalid, {
          invalid_photos: a.invalid,
          analyzed: a.total,
          pct: Math.round((a.invalid / a.total) * 100),
        });
      }
    }

    const keys = findings.map((f) => f.dedup_key);
    if (findings.length > 0) {
      await this.knex('commercial.supervisor_findings')
        .insert(findings)
        .onConflict(['tenant_id', 'dedup_key'])
        .merge({
          severity: this.knex.raw('EXCLUDED.severity'),
          label: this.knex.raw('EXCLUDED.label'),
          capture_id: this.knex.raw('EXCLUDED.capture_id'),
          score: this.knex.raw('EXCLUDED.score'),
          evidence: this.knex.raw('EXCLUDED.evidence'),
          status: this.knex.raw(
            `CASE WHEN commercial.supervisor_findings.status IN ('dismissed','confirmed') THEN commercial.supervisor_findings.status ELSE 'open' END`,
          ),
          updated_at: this.knex.fn.now(),
        });
    }

    const resolved = await this.knex('commercial.supervisor_findings')
      .where({ tenant_id: tenantId, source: 'vision', status: 'open' })
      .modify((qb) => {
        if (keys.length) qb.whereNotIn('dedup_key', keys);
      })
      .update({ status: 'resolved', updated_at: this.knex.fn.now() });

    return { open: findings.length, resolved: Number(resolved) || 0 };
  }
}
