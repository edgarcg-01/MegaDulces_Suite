import { Injectable, Logger } from '@nestjs/common';
import * as https from 'https';
import {
  FleetAccountResult,
  FleetFetchResult,
  FleetObject,
  FleetObjectStatus,
  FleetHistoryPoint,
  FleetProviderPort,
  ProviderOperator,
  ProviderTravel,
} from './fleet-provider.port';

/**
 * LT.9 — Una cuenta del proveedor con su PROPIA sesión. El cookie jar y el token
 * NO se comparten entre cuentas: GPS-Server.net identifica la sesión por cookie,
 * así que un jar único haría que el login de la segunda cuenta pisara el de la
 * primera y las dos consultas devolvieran la misma flota (o ninguna).
 */
interface MagniAccount {
  label: string;
  user: string;
  pass: string;
  cookies: Map<string, string>;
  loggedIn: boolean;
  token: string;
  tokenExpEpochMs: number;
}

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
 * LT.9 — VARIAS CUENTAS. La flota no cabe en una sola cuenta del proveedor: se
 * leen `MAGNI_USER`/`MAGNI_PASS` y además `MAGNI_USER2..9`/`MAGNI_PASS2..9`, y
 * se devuelve la UNIÓN deduplicada por IMEI. Medido 2026-09-17: cuenta 1 = 49
 * camionetas de ruta/reparto, cuenta 2 = 7 unidades pesadas (HINO, FREIGHTLINER,
 * 3× INTERNATIONAL), 2 IMEIs en ambas → 54 dispositivos únicos.
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
  private readonly accounts: MagniAccount[] = readAccountsFromEnv();

  private get useOfficialApi(): boolean {
    return Boolean(this.clientId && this.accounts.length);
  }

  isConfigured(): boolean {
    return this.accounts.length > 0;
  }

  /** Etiquetas de las cuentas configuradas (para logs y diagnóstico). */
  get accountLabels(): string[] {
    return this.accounts.map((a) => a.label);
  }

  // ── API oficial ──────────────────────────────────────────────────────────

  async fetchObjects(): Promise<FleetObject[]> {
    return (await this.fetchObjectsDetailed()).objects;
  }

  /**
   * LT.9 — Recorre TODAS las cuentas configuradas y devuelve la unión.
   *
   * Una cuenta caída NO tumba a las demás (se sigue publicando lo que sí llegó),
   * pero queda declarada en `accounts` y el tracker que dejó de reportar envejece
   * solo → la alerta de "sin señal" lo levanta. Si fallan TODAS sí tira: entregar
   * cero en silencio es el modo de falla que este carril ya vivió.
   */
  async fetchObjectsDetailed(): Promise<FleetFetchResult> {
    if (!this.isConfigured()) {
      throw new Error('MagniTracking sin credenciales (MAGNI_USER / MAGNI_PASS)');
    }
    const accounts: FleetAccountResult[] = [];
    const merged = new Map<string, FleetObject>();

    for (const acc of this.accounts) {
      try {
        const objs = this.useOfficialApi
          ? await this.fetchObjectsApi(acc)
          : await this.fetchObjectsLegacy(acc);
        accounts.push({ label: acc.label, ok: true, count: objs.length });
        for (const o of objs) mergeFreshest(merged, o);
      } catch (e: any) {
        const error = (e?.message || String(e)).split('\n')[0].slice(0, 160);
        accounts.push({ label: acc.label, ok: false, count: 0, error });
        this.logger.error(`cuenta ${acc.label} falló: ${error}`);
        acc.loggedIn = false; // fuerza re-login limpio en la próxima pasada
        acc.token = '';
      }
    }

    if (!accounts.some((a) => a.ok)) {
      throw new Error(
        `todas las cuentas MagniTracking fallaron: ${accounts.map((a) => `${a.label}=${a.error}`).join(' · ')}`,
      );
    }
    return { objects: Array.from(merged.values()), accounts };
  }

  /** API oficial: una cuenta. */
  private async fetchObjectsApi(acc: MagniAccount): Promise<FleetObject[]> {
    const token = await this.ensureToken(acc);
    const res = await fetch(`${this.baseUrl}/api/v1/endpoints/locations.php?imei=*&sensors=true`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    // Sin este chequeo un 401 (token vencido, cuenta suspendida) se leía como
    // `data` ausente y salía como flota vacía, indistinguible de "no hay unidades".
    if (!res.ok) throw new Error(`locations.php HTTP ${res.status}`);
    const json = await res.json().catch(() => null);
    const data = json?.data;
    if (!data || typeof data !== 'object') throw new Error('locations.php sin `data` utilizable');
    return Object.entries(data).map(([imei, v]) => ({
      ...this.normalizeLocation(imei, v),
      account: acc.label,
    }));
  }

  async fetchOperators(): Promise<ProviderOperator[]> {
    if (!this.useOfficialApi) return [];
    const out = new Map<string, ProviderOperator>();
    for (const acc of this.accounts) {
      for (const o of await this.fetchOperatorsOne(acc)) if (!out.has(o.id)) out.set(o.id, o);
    }
    return Array.from(out.values());
  }

  private async fetchOperatorsOne(acc: MagniAccount): Promise<ProviderOperator[]> {
    const token = await this.ensureToken(acc);
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
    const out: ProviderTravel[] = [];
    const vistos = new Set<string>();
    for (const acc of this.accounts) {
      for (const t of await this.fetchTravelsOne(acc)) {
        const k = `${t.noPlaneacion}|${t.imei ?? ''}`;
        if (!vistos.has(k)) { vistos.add(k); out.push(t); }
      }
    }
    return out;
  }

  private async fetchTravelsOne(acc: MagniAccount): Promise<ProviderTravel[]> {
    const token = await this.ensureToken(acc);
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

  /**
   * Histórico de recorrido (backfill). GET history.php?imei=&from=&to=&sensors=false.
   * `from`/`to` en "YYYY-MM-DD HH:MM:SS" hora local MX. Devuelve todos los fixes
   * con coordenadas del rango. Requiere API oficial (el fallback no lo soporta).
   */
  async fetchHistory(imeis: string[], from: string, to: string): Promise<FleetHistoryPoint[]> {
    if (!this.useOfficialApi) return [];
    // Un IMEI vive en UNA cuenta; se pregunta a todas y se une (la que no lo
    // tiene simplemente no lo devuelve). Dedupe por (imei, instante).
    const out = new Map<string, FleetHistoryPoint>();
    for (const acc of this.accounts) {
      for (const p of await this.fetchHistoryOne(acc, imeis, from, to)) {
        out.set(`${p.imei}|${p.capturedAt}`, p);
      }
    }
    return Array.from(out.values());
  }

  private async fetchHistoryOne(
    acc: MagniAccount,
    imeis: string[],
    from: string,
    to: string,
  ): Promise<FleetHistoryPoint[]> {
    const token = await this.ensureToken(acc);
    const imei = (imeis && imeis.length ? imeis.join(',') : '*');
    const qs = new URLSearchParams({ imei, from, to, sensors: 'false' }).toString();
    const res = await fetch(`${this.baseUrl}/api/v1/endpoints/history.php?${qs}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const json = await res.json().catch(() => null);
    const arr: any[] = Array.isArray(json?.data) ? json.data : [];
    const num = (x: any): number | undefined => { const n = Number(x); return Number.isFinite(n) ? n : undefined; };
    const out: FleetHistoryPoint[] = [];
    for (const r of arr) {
      const capturedAt = this.toIso(r?.dt_tracker);
      const lat = num(r?.lat), lng = num(r?.lng);
      if (!capturedAt || lat == null || lng == null) continue;
      out.push({
        imei: String(r?.imei ?? '').trim(),
        capturedAt,
        lat, lng,
        speedKmh: num(r?.speed),
        heading: num(r?.angle),
        altitude: num(r?.altitude),
        odometer: num(r?.odometer),
      });
    }
    return out;
  }

  private async ensureToken(acc: MagniAccount): Promise<string> {
    if (acc.token && Date.now() < acc.tokenExpEpochMs - 60_000) return acc.token;
    const res = await fetch(`${this.baseUrl}/api/v1/endpoints/auth.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: this.clientId,
        username: acc.user,
        password: acc.pass,
      }).toString(),
    });
    const json = await res.json().catch(() => null);
    const token = json?.data?.access_token || json?.access_token;
    if (!token) throw new Error(`Auth MagniTracking falló: ${JSON.stringify(json).slice(0, 160)}`);
    // expires_in puede ser epoch absoluto (ej. 1750399443) o segundos relativos.
    const exp = Number(json?.data?.expires_in || json?.expires_in || 0);
    acc.tokenExpEpochMs = exp > 1_000_000_000 ? exp * 1000 : Date.now() + (exp || 3600) * 1000;
    acc.token = token;
    this.logger.log(`Token MagniTracking obtenido (API oficial, cuenta ${acc.label})`);
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

  private async fetchObjectsLegacy(acc: MagniAccount): Promise<FleetObject[]> {
    await this.ensureSession(acc);
    let raw = await this.loadObjectData(acc);
    if (!raw || typeof raw !== 'object') {
      acc.loggedIn = false;
      await this.ensureSession(acc);
      raw = await this.loadObjectData(acc);
    }
    // Antes devolvía [] acá: una sesión rota se publicaba como "flota vacía". Con
    // dos cuentas eso sería peor todavía (la mitad de la flota desapareciendo sin
    // que nada falle), así que se declara como falla DE ESA cuenta.
    if (!raw || typeof raw !== 'object') {
      throw new Error('fn_objects no devolvió objeto tras re-login (sesión rechazada)');
    }
    return Object.entries(raw).map(([imei, v]) => ({
      ...this.normalizeLegacy(imei, v),
      account: acc.label,
    }));
  }

  private async ensureSession(acc: MagniAccount): Promise<void> {
    if (acc.loggedIn) return;
    acc.cookies.clear(); // jar limpio: una cookie vieja de otra sesión hace fallar el login
    const seed = await fetch(`${this.baseUrl}/index.php`);
    this.absorbCookies(acc, seed);
    const res = await this.post(acc, '/api/v1/fn_connect.php', {
      cmd: 'login', username: acc.user, password: acc.pass, remember_me: 'false', mobile: 'false',
    });
    const text = await res.text();
    if (!/LOGIN_TRACKING|true/i.test(text)) throw new Error(`Login MagniTracking falló: ${text.slice(0, 120)}`);
    acc.loggedIn = true;
    this.logger.log(`Sesión MagniTracking iniciada (fallback scraping, cuenta ${acc.label})`);
  }

  private async loadObjectData(acc: MagniAccount): Promise<Record<string, any> | null> {
    const res = await this.post(acc, '/api/v1/main/fn_objects.php', { cmd: 'load_object_data' });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return null; }
  }

  private async post(acc: MagniAccount, path: string, body: Record<string, string>): Promise<Response> {
    const res = await fetch(this.baseUrl + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Cookie: this.cookieHeader(acc),
        Origin: this.baseUrl,
      },
      body: new URLSearchParams(body).toString(),
    });
    this.absorbCookies(acc, res);
    return res;
  }

  private absorbCookies(acc: MagniAccount, res: Response): void {
    const setCookies: string[] =
      typeof (res.headers as any).getSetCookie === 'function' ? (res.headers as any).getSetCookie() : [];
    for (const c of setCookies) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) acc.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  private cookieHeader(acc: MagniAccount): string {
    return Array.from(acc.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
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
      // `i` = RALENTÍ (motor encendido, sin desplazarse). No estaba mapeado y caía
      // en 'unknown', que significa "no sabemos" — y sí sabíamos: lo dice el propio
      // proveedor en `ststr` ("Ralenti 2 H 8 Min 57 S", speed=0, acc=1), que ya
      // veníamos guardando en `last_status_text`. Para el mapa y las alertas es una
      // unidad detenida; el matiz sigue vivo en `last_status_text` + `last_ignition`.
      case 'i': return 'stopped';
      case 'off': return 'offline';
      default: return 'unknown';
    }
  }
}

// ── helpers de cuentas ───────────────────────────────────────────────────────

/**
 * LT.9 — Lee las cuentas del entorno: el par base `MAGNI_USER`/`MAGNI_PASS` y
 * después `MAGNI_USER2..9`/`MAGNI_PASS2..9`. Solo entran los pares COMPLETOS:
 * media credencial suelta produciría un login fallido cada minuto contra el
 * proveedor, con la cuenta compartida de por medio.
 */
function readAccountsFromEnv(): MagniAccount[] {
  const out: MagniAccount[] = [];
  const add = (label: string, user?: string, pass?: string) => {
    if (!user || !pass) return;
    out.push({ label, user, pass, cookies: new Map(), loggedIn: false, token: '', tokenExpEpochMs: 0 });
  };
  add('MAGNI_USER', process.env.MAGNI_USER, process.env.MAGNI_PASS);
  for (let i = 2; i <= 9; i++) {
    add(`MAGNI_USER${i}`, process.env[`MAGNI_USER${i}`], process.env[`MAGNI_PASS${i}`]);
  }
  return out;
}

/**
 * Une por IMEI quedándose con la lectura MÁS FRESCA. Las cuentas se traslapan a
 * propósito (medido: 2 de 54 dispositivos están dados de alta en ambas y devuelven
 * el mismo fix al segundo); el desempate por `capturedAt` hace que el resultado no
 * dependa del orden en que se leyeron las cuentas.
 */
function mergeFreshest(map: Map<string, FleetObject>, o: FleetObject): void {
  if (!o.imei) return;
  const prev = map.get(o.imei);
  if (!prev) { map.set(o.imei, o); return; }
  const a = prev.capturedAt ? Date.parse(prev.capturedAt) : -1;
  const b = o.capturedAt ? Date.parse(o.capturedAt) : -1;
  if (b > a) map.set(o.imei, o);
}
