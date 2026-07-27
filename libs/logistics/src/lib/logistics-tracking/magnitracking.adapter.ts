import { Injectable, Logger } from '@nestjs/common';
import {
  FleetObject,
  FleetObjectStatus,
  FleetProviderPort,
} from './fleet-provider.port';

/**
 * LT.0 — Adaptador MagniTracking (white-label de GPS-Server.net v4).
 *
 * NO hay API oficial: se replica el flujo de la web (reverse-engineered y
 * verificado 2026-07-27):
 *   1) GET  /index.php                → cookie anónima PHPSESSID
 *   2) POST /api/v1/fn_connect.php     cmd=login...   → autentica esa sesión
 *      (éxito = texto "LOGIN_TRACKING"). session fixation: la misma PHPSESSID
 *      queda autenticada.
 *   3) POST /api/v1/main/fn_objects.php  cmd=load_object_data → flota en vivo.
 *
 * Credenciales SIEMPRE por env (nunca en repo):
 *   MAGNI_BASE_URL (default https://magnitracking.net), MAGNI_USER, MAGNI_PASS.
 *
 * Formato de posición del proveedor (array `d[0]`):
 *   [dt_server, dt_tracker, lat, lng, altitud, rumbo, velocidad, {sensores}]
 * `st`: m=movimiento, s=detenido, off=fuera de línea.
 */
@Injectable()
export class MagniTrackingAdapter implements FleetProviderPort {
  readonly providerName = 'magnitracking';
  private readonly logger = new Logger(MagniTrackingAdapter.name);

  private readonly baseUrl = (process.env.MAGNI_BASE_URL || 'https://magnitracking.net').replace(/\/$/, '');
  private readonly user = process.env.MAGNI_USER || '';
  private readonly pass = process.env.MAGNI_PASS || '';

  private cookies = new Map<string, string>();
  private loggedIn = false;

  isConfigured(): boolean {
    return Boolean(this.user && this.pass);
  }

  async fetchObjects(): Promise<FleetObject[]> {
    if (!this.isConfigured()) {
      throw new Error('MagniTracking sin credenciales (MAGNI_USER / MAGNI_PASS)');
    }
    await this.ensureSession();
    let raw = await this.loadObjectData();
    // Reintento único: si la sesión expiró, el endpoint devuelve algo no-JSON
    // o vacío → re-login y una segunda pasada.
    if (!raw || typeof raw !== 'object') {
      this.loggedIn = false;
      await this.ensureSession();
      raw = await this.loadObjectData();
    }
    if (!raw || typeof raw !== 'object') return [];
    return Object.entries(raw).map(([imei, v]) => this.normalize(imei, v));
  }

  // ── flujo HTTP ─────────────────────────────────────────────────────────────

  private async ensureSession(): Promise<void> {
    if (this.loggedIn) return;
    // 1) semilla de cookie anónima
    const seed = await fetch(`${this.baseUrl}/index.php`);
    this.absorbCookies(seed);
    // 2) login
    const res = await this.post('/api/v1/fn_connect.php', {
      cmd: 'login',
      username: this.user,
      password: this.pass,
      remember_me: 'false',
      mobile: 'false',
    });
    const text = await res.text();
    if (!/LOGIN_TRACKING|true/i.test(text)) {
      throw new Error(`Login MagniTracking falló: ${text.slice(0, 120)}`);
    }
    this.loggedIn = true;
    this.logger.log('Sesión MagniTracking iniciada');
  }

  private async loadObjectData(): Promise<Record<string, any> | null> {
    const res = await this.post('/api/v1/main/fn_objects.php', {
      cmd: 'load_object_data',
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
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
    // Node 18+: getSetCookie() devuelve el array de Set-Cookie.
    const setCookies: string[] =
      typeof (res.headers as any).getSetCookie === 'function'
        ? (res.headers as any).getSetCookie()
        : [];
    for (const c of setCookies) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  // ── normalización ────────────────────────────────────────────────────────

  private normalize(imei: string, v: any): FleetObject {
    const d: any[] = (v?.d && v.d[0]) || [];
    const sensors: Record<string, any> = d[7] && typeof d[7] === 'object' ? d[7] : {};
    const num = (x: any): number | undefined => {
      const n = Number(x);
      return Number.isFinite(n) ? n : undefined;
    };
    return {
      imei,
      name: (v?.name || '').toString().trim(),
      status: this.mapStatus(v?.st),
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
      ignition:
        sensors.acc !== undefined ? String(sensors.acc) === '1' : undefined,
    };
  }

  private mapStatus(st: any): FleetObjectStatus {
    switch (st) {
      case 'm':
        return 'moving';
      case 's':
        return 'stopped';
      case 'off':
        return 'offline';
      default:
        return 'unknown';
    }
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
}
