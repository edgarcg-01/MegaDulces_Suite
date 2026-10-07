/* eslint-disable no-console */
/**
 * Cliente del protocolo nativo ZKTeco (TCP 4370) — sin dependencias.
 *
 * Los MB360 de la red no exponen API; hablan el protocolo binario propietario
 * de ZK. Este módulo lo implementa: handshake con comm key, lectura de
 * parámetros, usuarios y checadas (datasets grandes vía DATA_WRRQ + READ_BUFFER).
 *
 * Decode verificado en vivo 2026-08-17 contra 7 equipos (93,957 checadas):
 *   - registro de usuario  = 72 bytes: uid(2) priv(1) pwd(8) name(24) card(4) pad group(7) pad user_id(24)
 *   - registro de checada  = 40 bytes: uid(2) user_id(24) status(1) ts(4) punch(1) pad(8)
 *   - timestamp = entero empacado propietario (ver decodeTime), hora LOCAL sin zona
 *
 * Uso:
 *   const { ZKClient } = require('./zk-client');
 *   const zk = new ZKClient({ ip, port, commKey });
 *   await zk.connect();
 *   const info = await zk.getInfo();
 *   const users = await zk.getUsers();
 *   const logs  = await zk.getAttendance();
 *   await zk.disconnect();
 */

const net = require('net');

const CMD = {
  CONNECT: 1000, EXIT: 1001, AUTH: 1102,
  ACK_OK: 2000, ACK_ERROR: 2001, ACK_UNAUTH: 2005,
  PREPARE_DATA: 1500, DATA: 1501, FREE_DATA: 1502, DATA_WRRQ: 1503, READ_BUFFER: 1504,
  OPTIONS_RRQ: 11, ATTLOG_RRQ: 13, USERTEMP_RRQ: 9,
  GET_TIME: 201, GET_FREE_SIZES: 50, GET_VERSION: 1100,
};
const START = Buffer.from([0x50, 0x50, 0x82, 0x7d]);
const FCT_USER = 5;

/** Privilegios ZK. */
const PRIVILEGE = { 0: 'usuario', 2: 'registrador', 6: 'supervisor', 14: 'admin' };
/** Método de verificación con el que se identificó la persona. */
const VERIFY = { 0: 'password', 1: 'huella', 2: 'password', 3: 'tarjeta', 4: 'tarjeta', 15: 'rostro' };
/** Tipo de marcaje configurado en el equipo. */
const PUNCH = { 0: 'entrada', 1: 'salida', 2: 'salida_comida', 3: 'entrada_comida', 4: 'entrada_extra', 5: 'salida_extra' };

function checksum(p) {
  let chk = 0, i = 0;
  while (i < p.length - 1) { chk += p.readUInt16LE(i); if (chk > 0xffff) chk -= 0xffff; i += 2; }
  if (i === p.length - 1) chk += p[p.length - 1];
  while (chk > 0xffff) chk -= 0xffff;
  return (~chk) & 0xffff;
}

function makePacket(command, sessionId, replyId, data = Buffer.alloc(0)) {
  const buf = Buffer.alloc(8 + data.length);
  buf.writeUInt16LE(command, 0);
  buf.writeUInt16LE(0, 2);
  buf.writeUInt16LE(sessionId, 4);
  buf.writeUInt16LE(replyId, 6);
  data.copy(buf, 8);
  buf.writeUInt16LE(checksum(buf), 2);
  const hdr = Buffer.alloc(8);
  START.copy(hdr, 0);
  hdr.writeUInt32LE(buf.length, 4);
  return Buffer.concat([hdr, buf]);
}

/** Ofuscación de la comm key que exige el equipo antes de aceptar comandos. */
function makeCommKey(key, sessionId, ticks = 50) {
  let k = 0;
  for (let i = 0; i < 32; i++) k = ((key & (1 << i)) ? (k << 1 | 1) : (k << 1)) >>> 0;
  k = (k + sessionId) >>> 0;
  const b = Buffer.alloc(4); b.writeUInt32LE(k, 0);
  b[0] ^= 0x5a; b[1] ^= 0x4b; b[2] ^= 0x53; b[3] ^= 0x4f;   // 'Z','K','S','O'
  const sw = Buffer.from([b[2], b[3], b[0], b[1]]);           // swap de words de 16 bits
  const B = ticks & 0xff;
  return Buffer.from([sw[0] ^ B, sw[1] ^ B, B, sw[3] ^ B]);
}

/**
 * Decodifica el entero de fecha propietario de ZK a hora de pared LOCAL.
 * Devuelve string 'YYYY-MM-DD HH:mm:ss' (naive: el equipo no reporta zona).
 */
function decodeTime(t) {
  const s = t % 60; t = Math.floor(t / 60);
  const mi = t % 60; t = Math.floor(t / 60);
  const h = t % 24; t = Math.floor(t / 24);
  const d = (t % 31) + 1; t = Math.floor(t / 31);
  const mo = (t % 12) + 1; t = Math.floor(t / 12);
  const p = (n) => String(n).padStart(2, '0');
  return `${t + 2000}-${p(mo)}-${p(d)} ${p(h)}:${p(mi)}:${p(s)}`;
}

const cstr = (buf) => buf.toString('latin1').split('\x00')[0].trim();

class ZKClient {
  constructor({ ip, port = 4370, commKey = 0, timeout = 20000 }) {
    this.ip = ip; this.port = port; this.commKey = commKey; this.timeout = timeout;
    this.sessionId = 0; this.replyId = 0;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
  }

  // ── transporte ────────────────────────────────────────────────────────
  _openSocket() {
    return new Promise((resolve, reject) => {
      this.sock = net.createConnection({ host: this.ip, port: this.port });
      const onErr = (e) => reject(new Error(`no conecta a ${this.ip}:${this.port} — ${e.message}`));
      this.sock.setTimeout(this.timeout);
      this.sock.once('connect', () => { this.sock.off('error', onErr); resolve(); });
      this.sock.once('error', onErr);
      this.sock.on('timeout', () => this.sock.destroy(new Error('socket inactivo')));
      this.sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this._drain(); });
      this.sock.on('error', (e) => this._failAll(e));
      this.sock.on('close', () => this._failAll(new Error('conexión cerrada por el equipo')));
    });
  }

  _drain() {
    while (this.waiters.length && this.buf.length >= this.waiters[0].need) {
      const w = this.waiters.shift();
      const out = this.buf.subarray(0, w.need);
      this.buf = this.buf.subarray(w.need);
      clearTimeout(w.timer);
      w.resolve(out);
    }
  }

  _failAll(err) {
    const ws = this.waiters.splice(0);
    for (const w of ws) { clearTimeout(w.timer); w.reject(err); }
  }

  _readBytes(need, ms) {
    return new Promise((resolve, reject) => {
      const w = { need, resolve, reject, timer: null };
      w.timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`timeout esperando ${need} bytes del equipo`));
      }, ms || this.timeout);
      this.waiters.push(w);
      this._drain();
    });
  }

  async _readReply(ms) {
    const hdr = await this._readBytes(8, ms);
    if (!hdr.subarray(0, 4).equals(START)) throw new Error('header TCP ZK inválido: ' + hdr.toString('hex'));
    const pkt = await this._readBytes(hdr.readUInt32LE(4), ms);
    return { code: pkt.readUInt16LE(0), sessionId: pkt.readUInt16LE(4), data: pkt.subarray(8) };
  }

  async _send(command, data = Buffer.alloc(0), ms) {
    this.replyId = (this.replyId + 1) & 0xffff;
    this.sock.write(makePacket(command, this.sessionId, this.replyId, data));
    return this._readReply(ms);
  }

  // ── sesión ────────────────────────────────────────────────────────────
  async connect() {
    await this._openSocket();
    this.replyId = 0;
    this.sock.write(makePacket(CMD.CONNECT, 0, 0));
    let r = await this._readReply();
    this.sessionId = r.sessionId;
    if (r.code === CMD.ACK_UNAUTH) r = await this._send(CMD.AUTH, makeCommKey(this.commKey, this.sessionId));
    if (r.code !== CMD.ACK_OK) {
      throw new Error(r.code === CMD.ACK_UNAUTH
        ? `comm key incorrecta (probada: ${this.commKey})`
        : `el equipo rechazó la conexión (code=${r.code})`);
    }
    return this;
  }

  async disconnect() {
    try { await this._send(CMD.EXIT, Buffer.alloc(0), 5000); } catch { /* el equipo ya cerró */ }
    if (this.sock) this.sock.destroy();
  }

  // ── lecturas ──────────────────────────────────────────────────────────
  async param(name) {
    try {
      const r = await this._send(CMD.OPTIONS_RRQ, Buffer.from(name + '\x00', 'ascii'), 8000);
      if (r.code !== CMD.ACK_OK) return null;
      const s = cstr(r.data);
      const v = s.includes('=') ? s.split('=').slice(1).join('=') : s;
      return v.trim() || null;
    } catch { return null; }
  }

  /** Identidad + capacidad + hora del equipo. */
  async getInfo() {
    const info = {
      model: await this.param('~DeviceName'),
      serial_number: await this.param('~SerialNumber'),
      platform: await this.param('~Platform'),
      mac: await this.param('MAC'),
      reported_ip: await this.param('IPAddress'),
      device_id: await this.param('DeviceID'),
      firmware: null, device_time: null,
      user_count: null, record_count: null,
      capacity_users: null, capacity_records: null,
    };
    try {
      const r = await this._send(CMD.GET_VERSION, Buffer.alloc(0), 8000);
      info.firmware = cstr(r.data) || null;
    } catch { /* opcional */ }
    try {
      const r = await this._send(CMD.GET_TIME, Buffer.alloc(0), 8000);
      info.device_time = decodeTime(r.data.readUInt32LE(0));
    } catch { /* opcional */ }
    try {
      const r = await this._send(CMD.GET_FREE_SIZES, Buffer.alloc(0), 8000);
      const d = r.data;
      const at = (i) => (d.length >= (i + 1) * 4 ? d.readInt32LE(i * 4) : null);
      info.user_count = at(4);
      info.record_count = at(8);
      info.capacity_users = at(15);
      info.capacity_records = at(16);
    } catch { /* opcional */ }
    return info;
  }

  /** Lee un dataset grande. El equipo puede mandarlo de golpe o por chunks. */
  async _readWithBuffer(command, fct = 0) {
    const cs = Buffer.alloc(11);
    cs.writeUInt8(1, 0); cs.writeUInt16LE(command, 1); cs.writeInt32LE(fct, 3); cs.writeInt32LE(0, 7);
    const r = await this._send(CMD.DATA_WRRQ, cs, 30000);
    if (r.code === CMD.DATA) return r.data;               // dataset chico: vino inline
    if (r.code !== CMD.ACK_OK) throw new Error(`DATA_WRRQ rechazado (code=${r.code})`);

    const size = r.data.readUInt32LE(1);
    const MAX = 0xffc0;
    let out = Buffer.alloc(0);
    while (out.length < size) {
      const chunk = Math.min(MAX, size - out.length);
      const req = Buffer.alloc(8);
      req.writeInt32LE(out.length, 0); req.writeInt32LE(chunk, 4);
      this.replyId = (this.replyId + 1) & 0xffff;
      this.sock.write(makePacket(CMD.READ_BUFFER, this.sessionId, this.replyId, req));
      const rr = await this._readReply(60000);
      if (rr.code === CMD.DATA) {
        out = Buffer.concat([out, rr.data]);
      } else if (rr.code === CMD.PREPARE_DATA) {
        const declared = rr.data.readUInt32LE(0);
        let got = Buffer.alloc(0);
        while (got.length < declared) {
          const p = await this._readReply(60000);
          if (p.code === CMD.DATA) got = Buffer.concat([got, p.data]);
          else if (p.code === CMD.ACK_OK) break;
          else throw new Error(`chunk inesperado (code=${p.code})`);
        }
        out = Buffer.concat([out, got.subarray(0, declared)]);
        await this._readReply(10000).catch(() => {});      // ACK de cierre
      } else throw new Error(`READ_BUFFER rechazado (code=${rr.code})`);
    }
    await this._send(CMD.FREE_DATA, Buffer.alloc(0), 8000).catch(() => {});
    return out;
  }

  /** Usuarios enrolados. Registro de 72 bytes. */
  async getUsers() {
    const body = (await this._readWithBuffer(CMD.USERTEMP_RRQ, FCT_USER)).subarray(4);
    const out = [];
    for (let i = 0; i + 72 <= body.length; i += 72) {
      const r = body.subarray(i, i + 72);
      const userId = cstr(r.subarray(48, 72));
      if (!userId) continue;                               // slot vacío
      out.push({
        device_uid: r.readUInt16LE(0),
        privilege: r[2],
        role: PRIVILEGE[r[2]] || `otro_${r[2]}`,
        has_password: !!cstr(r.subarray(3, 11)),
        device_name: cstr(r.subarray(11, 35)),
        card: r.readUInt32LE(35) || null,
        group_id: cstr(r.subarray(40, 47)) || null,
        device_user_id: userId,
      });
    }
    return out;
  }

  /** Checadas. Registro de 40 bytes. `punched_local` es hora de pared sin zona. */
  async getAttendance() {
    const body = (await this._readWithBuffer(CMD.ATTLOG_RRQ)).subarray(4);
    const out = [];
    for (let i = 0; i + 40 <= body.length; i += 40) {
      const r = body.subarray(i, i + 40);
      const userId = cstr(r.subarray(2, 26));
      if (!userId) continue;
      out.push({
        device_uid: r.readUInt16LE(0),
        device_user_id: userId,
        verify_mode: r[26],
        verify_label: VERIFY[r[26]] || null,
        punched_local: decodeTime(r.readUInt32LE(27)),
        punch_type: r[31],
        punch_label: PUNCH[r[31]] || null,
      });
    }
    return out;
  }
}

module.exports = { ZKClient, decodeTime, PRIVILEGE, VERIFY, PUNCH };
