/* eslint-disable no-console */
/**
 * Barrido de red para checadores ZKTeco (puerto 4370).
 *
 * Por qué existe como script y no como diagnóstico desechable: el descubrimiento de
 * la Fase CH (2026-08-17) encontró **3 equipos que nadie tenía inventariados** y dejó
 * **2 declarados sin aparecer**. Ese barrido se hizo a mano y se perdió; esto lo deja
 * repetible.
 *
 * Lecciones que están cableadas acá:
 *  1. **Barrer TCP no alcanza.** Los MB160 viejos contestan por TCP y UDP, pero el
 *     UDP es el que no deja huecos (y el túnel a sucursales pierde paquetes → varias
 *     rondas). Se barren los dos transportes.
 *  2. **Un puerto abierto no es un ZK.** Se manda un CONNECT del protocolo propietario
 *     y se exige respuesta con el header 0x50 0x50 0x82 0x7d.
 *  3. **Comm key ≠ 0 se ve igual que "no hay equipo"** si solo se prueba la 0: el
 *     equipo responde `ACK_UNAUTH` y un scanner ingenuo lo descarta. Se prueban varias
 *     (`--keys`, default `0,1234`).
 *  4. **La IP no es identidad**: el reporte identifica por `serial` (varios equipos
 *     traen el default de fábrica 192.168.1.201 en su campo IPAddress).
 *
 * Uso:
 *   node database/importers/checadores/scan-network.js                  # subredes conocidas + las 2 perdidas
 *   node database/importers/checadores/scan-network.js --subnets=30,10  # solo esas
 *   node database/importers/checadores/scan-network.js --only=192.168.30.253 --keys=0,1234,123456
 *   node database/importers/checadores/scan-network.js --full           # 192.168.0-60 (lento)
 *
 * Flags: --subnets=a,b  --only=ip[,ip]  --keys=0,1234  --timeout=1500  --conc=64
 *        --rounds=3 (rondas UDP)  --no-udp  --no-tcp  --full  --json
 */

const net = require('net');
const dgram = require('dgram');
const path = require('path');
const { ZKClient } = require('./zk-client');

// ── protocolo mínimo para el sondeo (mismo header que zk-client) ───────────────
const START = Buffer.from([0x50, 0x50, 0x82, 0x7d]);
const CMD_CONNECT = 1000;

function checksum(p) {
  let chk = 0, i = 0;
  while (i < p.length - 1) { chk += p.readUInt16LE(i); if (chk > 0xffff) chk -= 0xffff; i += 2; }
  if (i === p.length - 1) chk += p[p.length - 1];
  while (chk > 0xffff) chk -= 0xffff;
  return (~chk) & 0xffff;
}

function connectPacket() {
  const buf = Buffer.alloc(8);
  buf.writeUInt16LE(CMD_CONNECT, 0);
  buf.writeUInt16LE(0, 2);
  buf.writeUInt16LE(0, 4);
  buf.writeUInt16LE(0, 6);
  buf.writeUInt16LE(checksum(buf), 2);
  const hdr = Buffer.alloc(8);
  START.copy(hdr, 0);
  hdr.writeUInt32LE(buf.length, 4);
  return Buffer.concat([hdr, buf]);
}

const looksZk = (buf) => !!buf && buf.length >= 8 && buf.subarray(0, 4).equals(START);

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
};
const has = (name) => argv.includes(`--${name}`);

const KNOWN_SUBNETS = [0, 11, 13, 30, 32, 40, 42, 44, 50, 54];
const TIMEOUT = Number(flag('timeout', 1500));
const CONC = Number(flag('conc', 64));
const ROUNDS = Number(flag('rounds', 3));
const KEYS = String(flag('keys', '0,1234')).split(',').map((k) => Number(k.trim())).filter((k) => Number.isFinite(k));
const DO_TCP = !has('no-tcp');
const DO_UDP = !has('no-udp');
const ONLY = flag('only') ? String(flag('only')).split(',').map((s) => s.trim()).filter(Boolean) : null;

let subnets;
if (has('full')) subnets = Array.from({ length: 61 }, (_, i) => i);
else if (flag('subnets')) subnets = String(flag('subnets')).split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
else subnets = KNOWN_SUBNETS.concat([10]); // 10 = la subred que el operador declaró y no apareció

const targets = ONLY || subnets.flatMap((s) => Array.from({ length: 254 }, (_, i) => `192.168.${s}.${i + 1}`));

// ── sondeos ───────────────────────────────────────────────────────────────────
/** TCP: abre y manda CONNECT. Devuelve 'zk' | 'open' (puerto abierto, no ZK) | null. */
function probeTcp(ip) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let answered = false;
    const done = (v) => { if (!answered) { answered = true; sock.destroy(); resolve(v); } };
    sock.setTimeout(TIMEOUT);
    sock.on('connect', () => sock.write(connectPacket()));
    sock.on('data', (d) => done(looksZk(d) ? 'zk' : 'open'));
    sock.on('timeout', () => done(sock.connecting ? null : 'open')); // conectó pero no habló ZK
    sock.on('error', () => done(null));
    sock.connect(4370, ip);
  });
}

/** UDP: manda CONNECT y espera header ZK. Los MB160 viejos aparecen solo así. */
function probeUdp(ip) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let answered = false;
    const done = (v) => { if (!answered) { answered = true; try { sock.close(); } catch { /* ya cerrado */ } resolve(v); } };
    sock.on('message', (msg) => done(looksZk(msg) ? 'zk' : null));
    sock.on('error', () => done(null));
    sock.send(connectPacket(), 4370, ip, (err) => { if (err) done(null); });
    setTimeout(() => done(null), TIMEOUT);
  });
}

async function pool(items, worker, conc) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  }));
  return out;
}

/** Identifica el equipo probando cada comm key hasta que una entre. */
async function identify(ip) {
  for (const commKey of KEYS) {
    const zk = new ZKClient({ ip, commKey, timeout: 12000 });
    try {
      await zk.connect();
      let info = {};
      try { info = await zk.getInfo(); } catch { /* algunos firmwares 2018 no traen todo */ }
      await zk.disconnect().catch(() => {});
      return {
        ok: true, commKey,
        serial: info.serial_number || null,
        model: info.model || info.platform || null,
        firmware: info.firmware || null,
        // El equipo reporta su propia IP y MIENTE seguido (default de fábrica
        // 192.168.1.201): se muestra para detectar ese caso, no para identificar.
        reported_ip: info.reported_ip || null,
        users: info.user_count ?? null,
        logs: info.record_count ?? null,
        device_time: info.device_time || null,
      };
    } catch (e) {
      const msg = String(e.message || e);
      await zk.disconnect?.().catch(() => {});
      if (/comm key/i.test(msg)) continue;                 // key equivocada → probar la siguiente
      return { ok: false, commKey, error: msg };
    }
  }
  return { ok: false, error: `ninguna comm key entró (probadas: ${KEYS.join(', ')})` };
}

(async () => {
  const inv = require('./devices');
  const known = new Map(inv.filter((d) => d.serial).map((d) => [d.serial, d]));
  const knownIps = new Set(inv.map((d) => d.ip));

  console.log(`Barrido ZK 4370 — ${targets.length} IPs · TCP:${DO_TCP ? 'sí' : 'no'} UDP:${DO_UDP ? `sí (${ROUNDS} rondas)` : 'no'} · keys: ${KEYS.join(',')} · timeout ${TIMEOUT}ms · conc ${CONC}`);
  if (!ONLY) console.log(`Subredes: ${subnets.map((s) => `192.168.${s}.x`).join(' ')}`);

  const hits = new Map(); // ip → Set(transporte)

  if (DO_TCP) {
    const t0 = Date.now();
    const res = await pool(targets, probeTcp, CONC);
    res.forEach((v, i) => {
      if (!v) return;
      if (!hits.has(targets[i])) hits.set(targets[i], new Set());
      hits.get(targets[i]).add(v === 'zk' ? 'tcp' : 'tcp(puerto abierto, sin protocolo ZK)');
    });
    console.log(`  TCP: ${[...hits.keys()].length} candidato(s) en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  if (DO_UDP) {
    for (let round = 1; round <= ROUNDS; round++) {
      const t0 = Date.now();
      const res = await pool(targets, probeUdp, CONC);
      let nuevos = 0;
      res.forEach((v, i) => {
        if (v !== 'zk') return;
        if (!hits.has(targets[i])) { hits.set(targets[i], new Set()); nuevos++; }
        hits.get(targets[i]).add('udp');
      });
      console.log(`  UDP ronda ${round}: +${nuevos} nuevo(s) · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
  }

  const found = [...hits.keys()].sort((a, b) => {
    const p = (ip) => ip.split('.').map((n) => String(n).padStart(3, '0')).join('');
    return p(a) < p(b) ? -1 : 1;
  });
  console.log(`\n${found.length} host(es) respondieron en 4370.\n`);

  const report = [];
  for (const ip of found) {
    const transports = [...hits.get(ip)].join(' + ');
    const id = await identify(ip);
    const tag = id.ok
      ? (known.has(id.serial) ? 'INVENTARIADO' : '*** NUEVO ***')
      : (knownIps.has(ip) ? 'inventariado, no autenticó' : 'responde, no autenticó');
    console.log(`${ip.padEnd(16)} ${transports}`);
    if (id.ok) {
      console.log(`   ${tag} serial=${id.serial} model=${id.model} fw=${id.firmware || '?'} usuarios=${id.users} checadas=${id.logs} commKey=${id.commKey}`);
      if (id.reported_ip && id.reported_ip !== ip) console.log(`   nota: el equipo se reporta en ${id.reported_ip} (no es identidad)`);
      if (id.device_time) console.log(`   hora del reloj: ${id.device_time}`);
      const prev = known.get(id.serial);
      if (prev && prev.ip !== ip) console.log(`   ⚠ cambió de IP: el inventario lo tiene en ${prev.ip}`);
    } else {
      console.log(`   ${tag} — ${id.error}`);
    }
    report.push({ ip, transports, ...id });
  }

  // qué del inventario NO apareció
  // Solo cuenta como "no respondió" lo que de verdad se escaneó: con --only el
  // universo son esas IPs, no todo el inventario (si no, el reporte miente).
  const scanned = new Set(targets);
  const seenSerials = new Set(report.filter((r) => r.serial).map((r) => r.serial));
  const missing = inv
    .filter((d) => scanned.has(d.ip))
    .filter((d) => (d.serial ? !seenSerials.has(d.serial) : !found.includes(d.ip)));
  if (missing.length) {
    console.log(`\nDel inventario NO respondieron ${missing.length}:`);
    for (const d of missing) console.log(`  ${d.ip.padEnd(16)} ${d.serial || '(sin serie: declarado por el operador)'}`);
  }

  if (has('json')) {
    const out = path.join(__dirname, '.scan-4370.json');
    require('fs').writeFileSync(out, JSON.stringify({ scanned: targets.length, found: report, missing }, null, 2));
    console.log(`\n→ ${out}`);
  }
})().catch((e) => { console.error('ERROR fatal:', e.message); process.exit(1); });
