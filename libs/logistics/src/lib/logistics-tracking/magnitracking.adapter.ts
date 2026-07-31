import { Injectable, Logger } from '@nestjs/common';
import * as https from 'https';
import {
  FleetObject,
  FleetObjectStatus,
  FleetProviderPort,
  ProviderOperator,
  ProviderTravel,
} from './fleet-provider.port';

/**
 * LT.7 — Adaptador MagniTracking sobre la API OFICIAL (OpenAPI v2, JWT Bearer).
 *
 * Reemplaza el reverse-engineering del portal. Flujo:
 *   1) POST /api/v1/endpoints/auth.php  (grant_type=password, client_id, user, pass)
 *      → access_token (Bearer). Se cachea hasta su expiración.
 *   2) GET  /api/v1/endpoints/locations.php?imei=*&sensors=true  → flota en vivo.
 *   3) GET  /api/v1/endpoints/operators.php   → operadores (chofer/vendedor).
 *   4) GET  /api/v1/endpoints/travels.php     → rutas: no_planeacion ↔ operador ↔ IMEI.
 *
 * Credenciales SIEMPRE por env (nunca en repo):
 *   MAGNI_BASE_URL (default https://magnitracking.net), MAGNI_API_CLIENT_ID,
 *   MAGNI_USER, MAGNI_PASS.
 *
 * Si NO hay MAGNI_API_CLIENT_ID cae al scraping de sesión legacy (fallback) para
 * no romper prod hasta que la API key esté configurada.
 */
@Injectable()
export class MagniTrackingAdapter implements FleetProviderPort {
  readonly providerName = 'magnitracking';
  private readonly logger = new Logger(MagniTrackingAdapter.name);

  private readonly baseUrl = (process.env.MAGNI_BASE_URL || 'https://magnitracking.net').replace(/\/$/, '');
  private readonly clientId = process.env.MAGNI_API_CLIENT_ID || '';
  private readonly user = process.env.MAGNI_USER || '';
  private readonly pass = process.env.MAGNI_PASS || '';

  // Token OAuth cacheado.
  private token = '';
  private tokenExpEpochMs = 0;
  // Sesión legacy (fallback scraping).
  private cookies = new Map<string, string>();
  private loggedIn = false;

  private get useOfficialApi(): boolean {
    return Boolean(this.clientId && this.user && this.pass);
  }

  isConfigured(): boolean {
    return Boolean(this.user && this.pass);
  }

  // ── API oficial ──────────────────────────────────────────────────────────

  async fetchObjects(): Promise<FleetObject[]> {
    if (!this.isConfigured()) {
      throw new Error('MagniTracking sin credenciales (MAGNI_USER / MAGNI_PASS)');
    }
    if (!this.useOfficialApi) return this.fetchObjectsLegacy();

    const token = await this.ensureToken();
    const res = await fetch(`${this.baseUrl}/api/v1/endpoints/locations.php?imei=*&sensors=true`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const json = await res.json().catch(() => null);
    const data = json?.data;
    if (!data || typeof data !== 'object') return [];
    return Object.entries(data).map(([imei, v]) => this.normalizeLocation(imei, v));
  }

  async fetchOperators(): Promise<ProviderOperator[]> {
    if (!this.useOfficialApi) return [];
    const token = await this.ensureToken();
    const res = await fetch(`${this.baseUrl}/api/v1/endpoints/operators.php`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const json = await res.json().catch(() => null);
    const arr: any[] = Array.isArray(json?.data) ? json.data : [];
    return arr
      .filter((o) => o?.id_operator)
      .map((o) => ({ id: String(o.id_operator), name: (o.nombre || '').toString(), contact: o.contacto || undefined, groupName: o.group_name || undefined }));
  }

  async fetchTravels(): Promise<ProviderTravel[]> {
    if (!this.useOfficialApi) return [];
    const token = await this.ensureToken();
    // travels.php pide body JSON en un GET (no estándar) → https.request lo permite.
    const today = this.todayMx();
    const from = this.addDaysMx(today, -14);
    const body = { 'status-ruta': 'En ruta', 'num-pagina': 1, 'fecha-inicio': from, 'fecha-fin': today };
    const json = await this.getWithBody('/api/v1/endpoints/travels.php', token, body);
    const raw = json?.data;
    const arr: any[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return arr
      .filter((t) => t?.no_planeacion)
      .map((t) => ({
        noPlaneacion: String(t.no_planeacion),
        operatorId: t.id_operator ? String(t.id_operator) : undefined,
        imei: t.imei ? String(t.imei) : undefined,
        origen: t.origen || undefined,
        destino: t.destino || undefined,
        status: t.status || undefined,
        fechaSalida: t.fecha_salida || undefined,
        fechaLlegada: t.fecha_llegada || undefined,
      }));
  }

  private async ensureToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpEpochMs - 60_000) return this.token;
    const res = await fetch(`${this.baseUrl}/api/v1/endpoints/auth.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: this.clientId,
        username: this.user,
        password: this.pass,
      }).toString(),
    });
    const json = await res.json().catch(() => null);
    const token = json?.data?.access_token || json?.access_token;
    if (!token) throw new Error(`Auth MagniTracking falló: ${JSON.stringify(json).slice(0, 160)}`);
    // expires_in puede ser epoch absoluto (ej. 1750399443) o segundos relativos.
    const exp = Number(json?.data?.expires_in || json?.expires_in || 0);
    this.tokenExpEpochMs = exp > 1_000_000_000 ? exp * 1000 : Date.now() + (exp || 3600) * 1000;
    this.token = token;
    this.logger.log('Token MagniTracking obtenido (API oficial)');
    return token;
  }

  private normalizeLocation(imei: string, v: any): FleetObject {
    const num = (x: any): number | undefined => {
      const n = Number(x);
      return Number.isFinite(n) ? n : undefined;
    };
    const capturedAt = this.toIso(v?.dt_tracker);
    const speed = num(v?.speed) ?? 0;
    const ageMin = capturedAt ? (Date.now() - new Date(capturedAt).getTime()) / 60000 : Infinity;
    return {
      imei,
      name: (v?.name || '').toString().trim(),
      plate: v?.plate ? String(v.plate).trim() : undefined,
      status: this.deriveStatus(speed, ageMin),
      statusText: undefined,
      protocol: undefined,
      odometer: num(v?.odometer),
      capturedAt,
      lat: num(v?.lat),
      lng: num(v?.lng),
      altitude: num(v?.altitude),
      heading: num(v?.angle),
      speedKmh: speed,
      ignition: v?.ign !== undefined ? String(v.ign) === '1' : undefined,
    };
  }

  /** Sin campo `st` en la API oficial → estado derivado de velocidad + antigüedad. */
  private deriveStatus(speedKmh: number, ageMin: number): FleetObjectStatus {
    if (!Number.isFinite(ageMin) || ageMin > 30) return 'offline';
    if (speedKmh > 3) return 'moving';
    return 'stopped';
  }

  /** GET con body JSON (travels.php lo requiere) vía https.request. */
  private getWithBody(path: string, token: string, bodyObj: Record<string, any>): Promise<any> {
    const payload = JSON.stringify(bodyObj);
    const u = new URL(this.baseUrl + path);
    return new Promise((resolve) => {
      const req = https.request(
        {
          method: 'GET',
          hostname: u.hostname,
          path: u.pathname + u.search,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            Accept: 'application/json',
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
        },
      );
      req.on('error', (e) => { this.logger.warn(`travels.php error: ${e.message}`); resolve(null); });
      req.write(payload);
      req.end();
    });
  }

  private todayMx(): string {
    return new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
  }
  private addDaysMx(ymd: string, days: number): string {
    const d = new Date(`${ymd}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  /**
   * dt_tracker viene como "YYYY-MM-DD HH:mm:ss" en hora local MX. México abolió
   * el horario de verano en 2022 → offset fijo -06:00 todo el año.
   */
  private toIso(dt: any): string | undefined {
    if (!dt || typeof dt !== 'string') return undefined;
    const m = dt.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (!m) return undefined;
    return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}-06:00`;
  }

  // ── Fallback: scraping de sesión legacy (mientras no haya API key) ─────────

  private async fetchObjectsLegacy(): Promise<FleetObject[]> {
    await this.ensureSession();
    let raw = await this.loadObjectData();
    if (!raw || typeof raw !== 'object') {
      this.loggedIn = false;
      await this.ensureSession();
      raw = await this.loadObjectData();
    }
    if (!raw || typeof raw !== 'object') return [];
    return Object.entries(raw).map(([imei, v]) => this.normalizeLegacy(imei, v));
  }

  private async ensureSession(): Promise<void> {
    if (this.loggedIn) return;
    const seed = await fetch(`${this.baseUrl}/index.php`);
    this.absorbCookies(seed);
    const res = await this.post('/api/v1/fn_connect.php', {
      cmd: 'login', username: this.user, password: this.pass, remember_me: 'false', mobile: 'false',
    });
    const text = await res.text();
    if (!/LOGIN_TRACKING|true/i.test(text)) throw new Error(`Login MagniTracking falló: ${text.slice(0, 120)}`);
    this.loggedIn = true;
    this.logger.log('Sesión MagniTracking iniciada (fallback scraping)');
  }

  private async loadObjectData(): Promise<Record<string, any> | null> {
    const res = await this.post('/api/v1/main/fn_objects.php', { cmd: 'load_object_data' });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return null; }
  }

  private async post(path: string, body: Record<string, string>): Promise<Response> {
    const res = await fetch(this.baseUrl + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Cookie: this.cookieHeader(),
        Origin: this.baseUrl,
      },
      body: new URLSearchParams(body).toString(),
    });
    this.absorbCookies(res);
    return res;
  }

  private absorbCookies(res: Response): void {
    const setCookies: string[] =
      typeof (res.headers as any).getSetCookie === 'function' ? (res.headers as any).getSetCookie() : [];
    for (const c of setCookies) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private normalizeLegacy(imei: string, v: any): FleetObject {
    const d: any[] = (v?.d && v.d[0]) || [];
    const sensors: Record<string, any> = d[7] && typeof d[7] === 'object' ? d[7] : {};
    const num = (x: any): number | undefined => {
      const n = Number(x);
      return Number.isFinite(n) ? n : undefined;
    };
    return {
      imei,
      name: (v?.name || '').toString().trim(),
      status: this.mapStatusLegacy(v?.st),
      statusText: v?.ststr || undefined,
      simNumber: v?.sim_number || undefined,
      protocol: v?.p || undefined,
      odometer: num(v?.o),
      capturedAt: this.toIso(d[1]),
      lat: num(d[2]),
      lng: num(d[3]),
      altitude: num(d[4]),
      heading: num(d[5]),
      speedKmh: num(d[6]),
      ignition: sensors.acc !== undefined ? String(sensors.acc) === '1' : undefined,
    };
  }

  private mapStatusLegacy(st: any): FleetObjectStatus {
    switch (st) {
      case 'm': return 'moving';
      case 's': return 'stopped';
      case 'off': return 'offline';
      default: return 'unknown';
    }
  }
}
