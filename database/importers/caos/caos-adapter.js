/**
 * CS.1 — Adapter de CAOS (caja fuerte de efectivo, 192.168.0.110).
 *
 * CAOS no tiene API oficial documentada: expone los endpoints AJAX que consume su propio frontend.
 * Este adapter replica el login de sesión y los llama — el mismo patrón que `MagniTrackingAdapter`
 * para la flota (ADR-034: sin API oficial, un adapter replica la sesión). Cambiar de caja fuerte =
 * cambiar sólo este archivo.
 *
 * ── El login ────────────────────────────────────────────────────────────────────────────────────
 * `POST /adminlogin` con `part1`=usuario y `part2`=clave cifrada. La clave se cifra en el navegador
 * con una llave pública RSA (PKCS#1 v1.5) que vive en el script `/Script/Login/loginUtils.js` (la
 * const `pubKey`), que `/login` carga por `<script src>`. La leemos de ahí en cada arranque en vez
 * de hardcodearla: si CAOS rota su llave, el adapter la toma sola.
 * ⚠️ La constante de CAOS cierra con SEIS guiones (`-----END PUBLIC KEY------`): JSEncrypt lo tolera,
 * el `crypto` de Node no. Se normaliza.
 *
 * ── Resiliencia ──────────────────────────────────────────────────────────────────────────────────
 * Si un endpoint responde con el HTML del login (sesión expirada) o un no-2xx, se RELOGUEA y
 * reintenta UNA vez; si sigue fallando, LANZA — nunca devuelve `[]`, porque una lista vacía se
 * publicaría como "no hubo movimientos", que es la peor lectura para una caja (misma decisión que
 * `fetchObjects` en la flota).
 *
 * Credenciales SIEMPRE por env (nunca en repo): `CAOS_BASE_URL`, `CAOS_USER`, `CAOS_PASS`.
 */
'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');

const BASE = (process.env.CAOS_BASE_URL || 'http://192.168.0.110').replace(/\/+$/, '');
const USER = process.env.CAOS_USER || '';
const PASS = process.env.CAOS_PASS || '';

/** Petición HTTP cruda con jar de cookies manual (como el adapter de flota). */
function pedir(metodo, ruta, { cookie, body, contentType } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + ruta);
    const lib = u.protocol === 'https:' ? https : http;
    const datos = body == null ? null
      : (contentType === 'json' ? JSON.stringify(body) : new URLSearchParams(body).toString());
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: metodo,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(datos ? {
          'Content-Type': contentType === 'json' ? 'application/json' : 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(datos),
        } : {}),
      },
      timeout: 15000,
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({
        code: res.statusCode,
        headers: res.headers,
        setCookie: res.headers['set-cookie'] || [],
        body: b,
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`timeout ${metodo} ${ruta}`)));
    if (datos) req.write(datos);
    req.end();
  });
}

/** Une las cookies de un Set-Cookie en un header Cookie. */
function jar(setCookie) {
  return (setCookie || []).map((c) => c.split(';')[0]).join('; ');
}

class CaosAdapter {
  constructor() {
    this.cookie = null;
    this.providerName = 'caos';
  }

  isConfigured() {
    return Boolean(USER && PASS);
  }

  /** Abre sesión: lee la pubKey de /login, cifra la clave y postea a /adminlogin. */
  async ensureSession() {
    if (this.cookie) return;
    if (!this.isConfigured()) {
      throw new Error('CAOS sin credenciales (CAOS_USER / CAOS_PASS)');
    }
    // La const `pubKey` vive en el script que /login carga, no en el HTML. Se lee de ahí; si
    // algún día la inlinean en /login, el fallback la toma igual.
    let fuente = await pedir('GET', '/Script/Login/loginUtils.js');
    let m = /pubKey\s*=\s*"([^"]+)"/.exec(fuente.body);
    if (!m) {
      fuente = await pedir('GET', '/login');
      m = /pubKey\s*=\s*"([^"]+)"/.exec(fuente.body);
    }
    if (!m) throw new Error('no se encontró pubKey (¿cambió CAOS?)');
    const pem = m[1]
      .replace(/\\n/g, '\n')
      .replace(/-{5,}END PUBLIC KEY-{5,}/, '-----END PUBLIC KEY-----');

    const cifrada = crypto.publicEncrypt(
      { key: pem, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(PASS, 'utf8'),
    ).toString('base64');

    const r = await pedir('POST', '/adminlogin', { body: { part1: USER, part2: cifrada } });
    const cookie = jar(r.setCookie);
    // La respuesta del login es texto ("success"); una sesión válida deja cookie.
    if (r.code >= 400 || !cookie) {
      throw new Error(`login CAOS rechazado (HTTP ${r.code})`);
    }
    this.cookie = cookie;
  }

  /** Fuerza re-login la próxima vez (sesión expirada). */
  reset() { this.cookie = null; }

  /**
   * POST autenticado a un endpoint de reporte (JSON), con re-login y UN reintento si la sesión
   * expiró (la señal es que devuelve el HTML del login en vez de JSON).
   */
  async postReporte(ruta, body) {
    await this.ensureSession();
    let r = await pedir('POST', ruta, { cookie: this.cookie, body, contentType: 'json' });
    const expiro = (res) => res.code === 401 || res.code === 302
      || /<title>\s*CAOS\s*-\s*Login/i.test(res.body || '');
    if (expiro(r)) {
      this.reset();
      await this.ensureSession();
      r = await pedir('POST', ruta, { cookie: this.cookie, body, contentType: 'json' });
    }
    if (r.code < 200 || r.code >= 300) {
      throw new Error(`CAOS ${ruta} → HTTP ${r.code}`);
    }
    try {
      return JSON.parse(r.body);
    } catch {
      throw new Error(`CAOS ${ruta} no devolvió JSON (sesión rechazada tras re-login)`);
    }
  }

  /** Fecha 'YY/MM/DD' que espera getTransactions. */
  static ymd(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getFullYear() % 100)}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
  }

  /**
   * Lista de movimientos en un rango. Devuelve `transactions.compactTransactions[]`.
   * LANZA si la forma no es la esperada (no devuelve `[]` en un fallo).
   */
  async getTransactions({ from, to, userID = '', transactionTypes = [], devices = [] } = {}) {
    const j = await this.postReporte('/Reports/report-TransactionsList/getTransactions', {
      startDate: CaosAdapter.ymd(from),
      startTime: '00:00:00',
      endDate: CaosAdapter.ymd(to),
      endTime: '23:59:59',
      userID,
      transactionTypes,
      devices,
    });
    const arr = j && j.transactions && j.transactions.compactTransactions;
    if (!Array.isArray(arr)) {
      throw new Error('getTransactions: forma inesperada (sin transactions.compactTransactions)');
    }
    return arr;
  }

  /** Detalle de una transacción (denominaciones, cheques, tickets, ref). */
  async getTransactionDetails(transactionID) {
    const j = await this.postReporte('/Reports/report-TransactionsList/getTransactionDetails', { transactionID });
    const d = j && j.transactionDetails;
    if (!d) throw new Error(`getTransactionDetails(${transactionID}): sin transactionDetails`);
    return d;
  }

  /** Catálogo (tipos de transacción, dispositivos). Útil para el reporte y el mapeo de tipos. */
  async getConfiguration() {
    await this.ensureSession();
    let r = await pedir('GET', '/Reports/report-TransactionsList/getConfiguration', { cookie: this.cookie });
    if (r.code === 401 || r.code === 302 || /<title>\s*CAOS\s*-\s*Login/i.test(r.body || '')) {
      this.reset();
      await this.ensureSession();
      r = await pedir('GET', '/Reports/report-TransactionsList/getConfiguration', { cookie: this.cookie });
    }
    if (r.code < 200 || r.code >= 300) throw new Error(`getConfiguration → HTTP ${r.code}`);
    return JSON.parse(r.body);
  }
}

module.exports = { CaosAdapter };
