import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION, TenantContextService } from '@megadulces/platform-core';
import { DenueClientService, DenueUnit } from './denue-client.service';

type Status = 'candidate' | 'covered' | 'dismissed' | 'converted';

/**
 * Prospección de PdV con INEGI DENUE.
 *
 * Flujo: Cuantificar (planear) → cosechar (Buscar/BuscarAreaAct) → upsert →
 * dedup (JS, haversine + similitud de nombre) contra `stores` y
 * `commercial.customers` → scoring de whitespace → capa en el mapa.
 *
 * Conexión: KNEX_CONNECTION (superuser, bypassa RLS) + tenant_id EXPLÍCITO,
 * igual que CommercialMapService — porque el dedup cruza `stores` (search_path
 * legacy) y `commercial.customers`. RLS de las tablas prospect_* es defense-in-depth.
 */
@Injectable()
export class ProspectsService {
  private readonly logger = new Logger(ProspectsService.name);
  private static readonly UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  /** Distancia (m) bajo la cual un candidato se considera el mismo PdV que uno propio. */
  private static readonly NEAR_M = 60;
  private static readonly NEAR_HARD_M = 25; // tan cerca que ni el nombre importa
  private static readonly NAME_SIM_MIN = 0.55;

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly denue: DenueClientService,
    @Optional() private readonly tenantContext?: TenantContextService,
  ) {}

  private tenantId(user: any): string | undefined {
    return user?.tenant_id || this.tenantContext?.get()?.tenantId;
  }

  // ── Config ───────────────────────────────────────────────────────────────

  async getConfig(user: any) {
    const tenantId = this.tenantId(user);
    let row = await this.knex('commercial.prospect_sources')
      .where({ tenant_id: tenantId })
      .first();
    if (!row && tenantId) {
      [row] = await this.knex('commercial.prospect_sources')
        .insert({ tenant_id: tenantId })
        .returning('*');
    }
    return row || null;
  }

  async updateConfig(
    user: any,
    dto: {
      scian_codes?: string[];
      entidad?: string;
      municipios?: string[];
      default_radius_m?: number;
      center_lat?: number;
      center_lng?: number;
      max_radius_km?: number;
      active?: boolean;
    },
  ) {
    const tenantId = this.tenantId(user);
    await this.getConfig(user); // asegura que existe la fila
    const patch: any = { updated_at: this.knex.fn.now() };
    if (dto.scian_codes) patch.scian_codes = JSON.stringify(dto.scian_codes);
    if (dto.entidad !== undefined) patch.entidad = dto.entidad;
    if (dto.municipios) patch.municipios = JSON.stringify(dto.municipios);
    if (dto.default_radius_m != null)
      patch.default_radius_m = Math.min(Math.max(dto.default_radius_m, 100), 5000);
    if (dto.center_lat != null) patch.center_lat = dto.center_lat;
    if (dto.center_lng != null) patch.center_lng = dto.center_lng;
    if (dto.max_radius_km != null) patch.max_radius_km = Math.max(1, Math.round(dto.max_radius_km));
    if (dto.active != null) patch.active = dto.active;
    await this.knex('commercial.prospect_sources').where({ tenant_id: tenantId }).update(patch);
    return this.getConfig(user);
  }

  private scianCodes(cfg: any): string[] {
    const raw = cfg?.scian_codes;
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === 'string') {
      try {
        const p = JSON.parse(raw);
        return Array.isArray(p) ? p.map(String) : [];
      } catch {
        return [];
      }
    }
    return ['461160', '461110', '462112'];
  }

  // ── Planeación (Cuantificar) ──────────────────────────────────────────────

  /** Cuenta el universo DENUE por clase SCIAN dentro del área configurada. */
  async quantify(user: any) {
    if (!this.denue.enabled) return { enabled: false, items: [] as any[] };
    const cfg = await this.getConfig(user);
    const area = this.areaCode(cfg);
    const items: { scian: string; total: number }[] = [];
    for (const scian of this.scianCodes(cfg)) {
      const total = await this.denue.cuantificar(scian, area);
      items.push({ scian, total: total ?? 0 });
    }
    return { enabled: true, area, items };
  }

  private areaCode(cfg: any): string {
    const ent = (cfg?.entidad || '').trim();
    return ent && ent !== '00' ? ent : '0';
  }

  // ── Cosecha (ingesta) ─────────────────────────────────────────────────────

  /** Prospección en vivo: POIs DENUE a ≤radius de un punto, filtrados por SCIAN. */
  async ingestNearby(user: any, lat: number, lng: number, radius?: number) {
    if (!this.denue.enabled) return { enabled: false, fetched: 0, upserted: 0 };
    const tenantId = this.tenantId(user);
    const cfg = await this.getConfig(user);
    const r = Math.min(Math.max(radius || cfg?.default_radius_m || 1000, 100), 5000);
    const wanted = new Set(this.scianCodes(cfg));
    const units = await this.denue.buscar('todos', lat, lng, r);
    const filtered = units
      .filter((u) =>
        !wanted.size || wanted.has(u.scian) || [...wanted].some((c) => u.scian.startsWith(c)),
      )
      .filter((u) => this.passesGeo(cfg, u)); // entidad (ej. 16 Michoacán) + geocerca
    const upserted = await this.upsertUnits(tenantId, filtered);
    await this.dedup(user);
    await this.touchIngested(tenantId);
    return { enabled: true, fetched: units.length, matched_scian: filtered.length, upserted };
  }

  /** Cosecha sistemática por SCIAN dentro de entidad/municipio, paginada hasta agotar. */
  async ingestArea(user: any, entidad?: string, municipio?: string, maxPages = 20) {
    if (!this.denue.enabled) return { enabled: false, fetched: 0, upserted: 0 };
    const tenantId = this.tenantId(user);
    const cfg = await this.getConfig(user);
    const ent = (entidad || cfg?.entidad || '0').trim() || '0';
    const mun = (municipio || '0').trim() || '0';
    const PAGE = 100;
    let fetched = 0;
    let upserted = 0;
    for (const clase of this.scianCodes(cfg)) {
      for (let page = 0; page < maxPages; page++) {
        const ini = page * PAGE + 1;
        const fin = ini + PAGE - 1;
        const units = await this.denue.buscarAreaAct({ entidad: ent, municipio: mun, clase, ini, fin });
        if (!units.length) break;
        fetched += units.length;
        // Geocerca: la entidad ya la acota la API; aquí recortamos por distancia al centro.
        upserted += await this.upsertUnits(tenantId, units.filter((u) => this.passesGeo(cfg, u)));
        if (units.length < PAGE) break; // última página
      }
    }
    await this.dedup(user);
    await this.touchIngested(tenantId);
    return { enabled: true, fetched, upserted };
  }

  private async touchIngested(tenantId?: string) {
    if (!tenantId) return;
    await this.knex('commercial.prospect_sources')
      .where({ tenant_id: tenantId })
      .update({ last_ingested_at: this.knex.fn.now(), updated_at: this.knex.fn.now() });
  }

  /** UPSERT por (tenant, source, source_ref). Refresca last_seen_at. */
  private async upsertUnits(tenantId: string | undefined, units: DenueUnit[]): Promise<number> {
    if (!tenantId || !units.length) return 0;
    const rows = units
      .filter((u) => u.id)
      .map((u) => ({
        tenant_id: tenantId,
        source: 'denue',
        source_ref: u.id,
        nombre: u.nombre || null,
        razon_social: u.razon_social || null,
        scian: u.scian || null,
        scian_label: u.scian_label || null,
        estrato: u.estrato || null,
        tipo: u.tipo || null,
        lat: u.lat,
        lng: u.lng,
        calle: u.calle || null,
        num_ext: u.num_ext || null,
        colonia: u.colonia || null,
        cp: u.cp || null,
        municipio: u.municipio || null,
        entidad: u.entidad || null,
        telefono: u.telefono || null,
        email: u.email || null,
        web: u.web || null,
        raw: JSON.stringify(u.raw || {}),
        last_seen_at: this.knex.fn.now(),
        updated_at: this.knex.fn.now(),
      }));
    if (!rows.length) return 0;
    await this.knex('commercial.prospect_stores')
      .insert(rows)
      .onConflict(['tenant_id', 'source', 'source_ref'])
      .merge({
        nombre: this.knex.raw('EXCLUDED.nombre'),
        razon_social: this.knex.raw('EXCLUDED.razon_social'),
        scian: this.knex.raw('EXCLUDED.scian'),
        estrato: this.knex.raw('EXCLUDED.estrato'),
        tipo: this.knex.raw('EXCLUDED.tipo'),
        lat: this.knex.raw('EXCLUDED.lat'),
        lng: this.knex.raw('EXCLUDED.lng'),
        calle: this.knex.raw('EXCLUDED.calle'),
        colonia: this.knex.raw('EXCLUDED.colonia'),
        telefono: this.knex.raw('EXCLUDED.telefono'),
        email: this.knex.raw('EXCLUDED.email'),
        web: this.knex.raw('EXCLUDED.web'),
        raw: this.knex.raw('EXCLUDED.raw'),
        last_seen_at: this.knex.fn.now(),
        updated_at: this.knex.fn.now(),
      });
    return rows.length;
  }

  // ── Dedup + scoring ────────────────────────────────────────────────────────

  /**
   * Reclasifica prospectos contra `stores` + `commercial.customers`: covered si
   * hay un registro propio a < NEAR_M con nombre similar (o < NEAR_HARD_M sin
   * importar nombre). Calcula whitespace_score por distancia al cliente más
   * cercano + peso de SCIAN. NO toca los dismissed/converted (decisión humana).
   */
  async dedup(user: any): Promise<{ scanned: number; covered: number; candidate: number }> {
    const tenantId = this.tenantId(user);
    if (!tenantId) return { scanned: 0, covered: 0, candidate: 0 };

    const prospects = await this.knex('commercial.prospect_stores')
      .where({ tenant_id: tenantId })
      .whereIn('status', ['candidate', 'covered'])
      .whereNotNull('lat')
      .whereNotNull('lng')
      .select('id', 'nombre', 'lat', 'lng', 'scian');

    // Registros propios con coords (PdV auditados + clientes comerciales).
    const stores = await this.knex('stores')
      .where({ tenant_id: tenantId })
      .whereNull('deleted_at')
      .whereNotNull('latitud')
      .select('id', 'nombre', 'latitud as lat', 'longitud as lng');
    const customers = await this.knex('commercial.customers')
      .where({ tenant_id: tenantId })
      .whereNull('deleted_at')
      .whereNotNull('latitude')
      .select('id', 'name as nombre', 'latitude as lat', 'longitude as lng');

    const own = [
      ...stores.map((s: any) => ({ kind: 'store', id: s.id, nombre: s.nombre, lat: +s.lat, lng: +s.lng })),
      ...customers.map((c: any) => ({ kind: 'customer', id: c.id, nombre: c.nombre, lat: +c.lat, lng: +c.lng })),
    ].filter((o) => !isNaN(o.lat) && !isNaN(o.lng));

    let covered = 0;
    let candidate = 0;
    for (const p of prospects) {
      const plat = +p.lat;
      const plng = +p.lng;
      const pname = ProspectsService.norm(p.nombre);
      let best: { o: any; d: number; sim: number } | null = null;
      let nearestM = Infinity;
      for (const o of own) {
        const d = ProspectsService.haversine(plat, plng, o.lat, o.lng);
        if (d < nearestM) nearestM = d;
        if (d > ProspectsService.NEAR_M) continue;
        const sim = ProspectsService.nameSim(pname, ProspectsService.norm(o.nombre));
        const isMatch = d <= ProspectsService.NEAR_HARD_M || sim >= ProspectsService.NAME_SIM_MIN;
        if (isMatch && (!best || d < best.d)) best = { o, d, sim };
      }
      const patch: any = { updated_at: this.knex.fn.now() };
      if (best) {
        covered++;
        patch.status = 'covered';
        patch.matched_store_id = best.o.kind === 'store' ? best.o.id : null;
        patch.matched_customer_id = best.o.kind === 'customer' ? best.o.id : null;
        patch.match_distance_m = Math.round(best.d);
        patch.match_name_sim = Number(best.sim.toFixed(3));
        patch.nearest_customer_m = isFinite(nearestM) ? Math.round(nearestM) : null;
        patch.whitespace_score = 0;
      } else {
        candidate++;
        patch.status = 'candidate';
        patch.matched_store_id = null;
        patch.matched_customer_id = null;
        patch.match_distance_m = null;
        patch.match_name_sim = null;
        patch.nearest_customer_m = isFinite(nearestM) ? Math.round(nearestM) : null;
        patch.whitespace_score = ProspectsService.whitespace(
          isFinite(nearestM) ? nearestM : null,
          p.scian,
        );
      }
      await this.knex('commercial.prospect_stores').where({ id: p.id }).update(patch);
    }
    return { scanned: prospects.length, covered, candidate };
  }

  /** Score 0..100: más lejos del cliente más cercano = más whitespace; dulcería pondera. */
  private static whitespace(nearestM: number | null, scian: string | null): number {
    const dist = nearestM == null ? 1500 : Math.min(nearestM, 3000);
    const distPart = (dist / 3000) * 70; // 0..70
    const s = scian || '';
    const scianPart = s.startsWith('461160') ? 30 : s.startsWith('461110') ? 20 : 10; // dulce > abarrote > otros
    return Math.round(Math.min(100, distPart + scianPart) * 100) / 100;
  }

  // ── Lectura para el mapa ────────────────────────────────────────────────────

  async list(user: any, filters: { status?: Status; scian?: string; min_score?: number; limit?: number }) {
    const tenantId = this.tenantId(user);
    let q = this.knex('commercial.prospect_stores')
      .where({ tenant_id: tenantId })
      .whereNotNull('lat')
      .whereNotNull('lng');
    q = q.where('status', filters.status || 'candidate');
    if (filters.scian) q = q.where('scian', 'like', `${filters.scian}%`);
    if (filters.min_score != null) q = q.where('whitespace_score', '>=', filters.min_score);
    const rows = await q
      .orderBy('whitespace_score', 'desc')
      .limit(Math.min(filters.limit || 2000, 5000))
      .select(
        'id', 'nombre', 'razon_social', 'scian', 'estrato', 'tipo', 'lat', 'lng',
        'calle', 'num_ext', 'colonia', 'cp', 'municipio', 'entidad',
        'telefono', 'email', 'web', 'status', 'nearest_customer_m', 'whitespace_score',
      );
    return {
      total: rows.length,
      enabled: this.denue.enabled,
      prospects: rows.map((r: any) => ({
        ...r,
        lat: r.lat != null ? Number(r.lat) : null,
        lng: r.lng != null ? Number(r.lng) : null,
        direccion: [r.calle, r.num_ext, r.colonia, r.cp].filter(Boolean).join(' '),
      })),
    };
  }

  async counts(user: any) {
    const tenantId = this.tenantId(user);
    const rows = await this.knex('commercial.prospect_stores')
      .where({ tenant_id: tenantId })
      .groupBy('status')
      .select('status')
      .count<{ status: string; count: string }[]>('* as count');
    const out: Record<string, number> = { candidate: 0, covered: 0, dismissed: 0, converted: 0 };
    for (const r of rows as any[]) out[r.status] = Number(r.count);
    return out;
  }

  async dismiss(user: any, id: string) {
    const tenantId = this.tenantId(user);
    if (!ProspectsService.UUID_RE.test(id || '')) throw new NotFoundException('Prospecto no encontrado.');
    const n = await this.knex('commercial.prospect_stores')
      .where({ tenant_id: tenantId, id })
      .update({ status: 'dismissed', updated_at: this.knex.fn.now() });
    if (!n) throw new NotFoundException('Prospecto no encontrado.');
    return { ok: true };
  }

  /** Marca el prospecto como convertido (alta real la hace el FE vía endpoint de clientes). */
  async markConverted(user: any, id: string, customerId?: string) {
    const tenantId = this.tenantId(user);
    if (!ProspectsService.UUID_RE.test(id || '')) throw new NotFoundException('Prospecto no encontrado.');
    const patch: any = { status: 'converted', updated_at: this.knex.fn.now() };
    if (customerId && ProspectsService.UUID_RE.test(customerId)) patch.matched_customer_id = customerId;
    const n = await this.knex('commercial.prospect_stores')
      .where({ tenant_id: tenantId, id })
      .update(patch);
    if (!n) throw new NotFoundException('Prospecto no encontrado.');
    return { ok: true };
  }

  // ── Helpers de dedup ────────────────────────────────────────────────────────

  /**
   * Geocerca de la cosecha: el prospecto debe estar en la entidad configurada
   * (código en los 2 primeros díg del CLEE) Y dentro de `max_radius_km` del
   * centro (ej. Michoacán + 100 km de La Piedad). Cualquier filtro ausente no aplica.
   */
  private passesGeo(cfg: any, u: DenueUnit): boolean {
    const ent = (cfg?.entidad || '').trim();
    if (ent && ent !== '0' && ent !== '00') {
      const clee = String(u.id || '');
      if (!/^\d{2}/.test(clee) || clee.slice(0, 2) !== ent.padStart(2, '0')) return false;
    }
    const clat = cfg?.center_lat != null ? Number(cfg.center_lat) : null;
    const clng = cfg?.center_lng != null ? Number(cfg.center_lng) : null;
    const rkm = cfg?.max_radius_km != null ? Number(cfg.max_radius_km) : null;
    if (clat != null && clng != null && rkm && u.lat != null && u.lng != null) {
      if (ProspectsService.haversine(clat, clng, u.lat, u.lng) > rkm * 1000) return false;
    }
    return true;
  }

  private static haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  private static norm(s: string | null): string {
    return (s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/\b(la|el|los|las|de|del|y|tienda|abarrotes|miscelanea|dona|don|sa|cv)\b/g, ' ')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Coeficiente de Dice sobre bigramas — similitud 0..1 robusta a typos/orden. */
  private static nameSim(a: string, b: string): number {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const bigrams = (s: string) => {
      const out = new Map<string, number>();
      for (let i = 0; i < s.length - 1; i++) {
        const g = s.slice(i, i + 2);
        out.set(g, (out.get(g) || 0) + 1);
      }
      return out;
    };
    const A = bigrams(a);
    const B = bigrams(b);
    if (A.size === 0 || B.size === 0) return 0;
    let inter = 0;
    for (const [g, n] of A) inter += Math.min(n, B.get(g) || 0);
    return (2 * inter) / (a.length - 1 + (b.length - 1));
  }
}
