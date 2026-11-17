#!/usr/bin/env node
'use strict';
/**
 * `[P2.6.13]` Alta en lote de las cuentas de PROMOTORÍA de marca (gente de un proveedor en la
 * sucursal): sólo Caducidades, en las sucursales de su zona.
 *
 * Decisiones de David:
 *   · 2026-11-09: sin migración ni perfil nuevo («usa la tabla de usuarios que ya tenemos»).
 *   · 2026-11-17: UNA cuenta por MARCA y ZONA (la comparten las promotoras de esa marca; el sistema
 *     sabe la marca, no la persona) · sólo Caducidades (sin Levantamiento) · acceso a TODAS las
 *     sucursales de su zona · contraseña común · sin limitar por marca por ahora (la tabla de
 *     marcas mezcla marcas y razones sociales: 12 de 40 coinciden exacto). ⚠️ Sin marcas, cada
 *     cuenta ve en Caducidades las hojas de toda su zona, también las de otras marcas.
 *
 * Cada cuenta va con el perfil `etiquetas_anaquel` —el más chico que existe— y sus PERMISOS
 * PROPIOS (`identity.user_permissions`, los mismos de /admin/users):
 *   · de más:  COMMERCIAL_EXPIRY_CAPTURAR (sin `_VER`: ése abre el expediente de todas las marcas);
 *   · de menos: todo lo demás que traiga el perfil hoy (se lee de la API, no se escribe a mano).
 * Y su ALCANCE PROPIO de sucursal (`identity.user_scopes`, warehouse = listed con las de su zona):
 * Caducidades le ofrece elegir entre ellas y no le deja escribir fuera.
 * Después de cada alta se comprueba lo EFECTIVO (permisos y sucursales); si no cuadra, se para.
 * ⚠️ Si alguien le agrega una llave al perfil `etiquetas_anaquel`, las promotoras la heredan:
 *    re-correr este script con la misma entrada la vuelve a quitar (retoma las que ya existen).
 *
 * ⛔ Va por la API, no por INSERT: así cada alta pasa por las mismas validaciones, el hash de la
 *    contraseña y la bitácora de identidad que el alta desde /admin/users.
 * ⛔ El archivo de entrada trae NOMBRES DE PERSONAS: vive fuera del repo (es público) y nunca se
 *    commitea. Lo mismo el de salida, que trae contraseñas.
 *
 * Entrada (CSV, UTF-8, con encabezado):
 *   nombre,sucursal[,sucursales][,marcas][,username][,plaza][,puesto]
 *   · sucursal   = código de 2 dígitos (02, 07, 05…): la de su ficha
 *   · sucursales = opcional, códigos separados por «|» (01|02|03|04): su alcance; si falta, sólo `sucursal`
 *   · marcas     = opcional, nombres EXACTOS de `/admin/promotores` separados por «|»; vacío = sin limitar
 *   · username   = opcional; si falta, sale de nombre + primer apellido (`maria_lopez`)
 *   · plaza y puesto sólo se reportan
 *
 * Uso:
 *   API_URL=https://megadulcessuite.com/api API_TOKEN=<token de un admin> PASSWORD_INICIAL=<común> \
 *     node database/scripts/alta-promotoras-marca.js <entrada.csv> [--aplicar] [--solo <username>] [--salida <contraseñas.csv>]
 *
 *   Sin --aplicar sólo REVISA: sucursales, marcas, usuario repetido. No escribe nada.
 *   --solo <username>: aplica sólo esa cuenta (para entrar con ella y verla antes de crear el resto).
 *   Contraseña: PASSWORD_INICIAL (una para todas) o, si falta, una aleatoria por persona que se
 *   escribe en --salida (obligatorio en ese caso). Nunca se imprime. Todas nacen con
 *   must_change_password = true.
 *   ⚠️ Hoy la web NO obliga a cambiarla al entrar ni hay pantalla para cambiarla uno mismo
 *   (medido 2026-11-09): una contraseña común queda común hasta que un admin la cambie.
 *
 * Idempotente: una cuenta que ya existe no se crea otra vez. Si ya es promotora (perfil base y
 * departamento `externo`) se RETOMA: se le vuelven a fijar permisos y marcas. Si es de alguien más
 * (otra persona con el mismo usuario), es error: nunca se le tocan los permisos a un empleado.
 * Necesita: USUARIOS_GESTIONAR (crear y permisos propios), USUARIOS_VER y
 * COMMERCIAL_PROMOTERS_GESTIONAR (marcas). Sólo se concede lo que quien lo corre ya tiene.
 */
const fs = require('fs');
const crypto = require('crypto');

const PERFIL_BASE = 'etiquetas_anaquel';
const DEPARTAMENTO = 'externo';
/** Lo único que debe quedarle a una cuenta de promotoría (2026-11-17: sólo Caducidades). */
const EFECTIVOS = ['COMMERCIAL_EXPIRY_CAPTURAR'];
const NOTA = '[P2.6.13] promotoría de marca: sólo Caducidades, sucursales de su zona';

/**
 * Los permisos propios que dejan a la persona con exactamente `EFECTIVOS`, a partir de los del
 * perfil (`del_puesto`): conceder lo que falta, quitar lo que sobra.
 */
function overridesPara(delPuesto) {
  const puesto = new Set(delPuesto);
  return [
    ...EFECTIVOS.filter((k) => !puesto.has(k)).map((k) => ({ permission_key: k, allow: true, nota: NOTA })),
    ...[...puesto].filter((k) => !EFECTIVOS.includes(k)).sort().map((k) => ({ permission_key: k, allow: false, nota: NOTA })),
  ];
}

/** ¿Lo efectivo es exactamente lo que debe ser? */
function quedoBien(efectivos) {
  return JSON.stringify([...efectivos].sort()) === JSON.stringify([...EFECTIVOS].sort());
}

function argumentos(argv) {
  const a = { entrada: null, aplicar: false, salida: null, solo: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--aplicar') a.aplicar = true;
    else if (argv[i] === '--salida') a.salida = argv[++i];
    else if (argv[i] === '--solo') a.solo = String(argv[++i] || '').toLowerCase();
    else if (!a.entrada) a.entrada = argv[i];
  }
  return a;
}

/** CSV simple con comillas dobles ("a, b" y "" como comilla). */
function leerCsv(texto) {
  // Cada renglón guarda la línea del ARCHIVO donde empieza: con renglones vacíos en medio, el
  // reporte tiene que apuntar a donde la persona lo va a buscar.
  const filas = [];
  let fila = [], campo = '', comillas = false, linea = 1, inicio = 1;
  const cerrar = () => { fila.push(campo); campo = ''; if (fila.some((x) => x.trim() !== '')) filas.push({ inicio, celdas: fila }); fila = []; };
  const t = texto.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (comillas) {
      if (c === '"' && t[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') comillas = false;
      else { if (c === '\n') linea++; campo += c; }
    } else if (c === '"') comillas = true;
    else if (c === ',') { fila.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      cerrar();
      linea++;
      inicio = linea;
    } else campo += c;
  }
  cerrar();
  const [enc, ...datos] = filas;
  const cols = enc.celdas.map((x) => x.trim().toLowerCase());
  return datos.map((f) => ({ linea: f.inicio, ...Object.fromEntries(cols.map((k, j) => [k, (f.celdas[j] ?? '').trim()])) }));
}

const sinAcentos = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** «María José López Pérez» → `maria_lopez` (primer nombre + primer apellido; ver `usuarioDe`). */
function usuarioDe(nombre) {
  const p = sinAcentos(nombre).toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (p.length < 2) return null;
  // Dos palabras = nombre y apellido; tres o más: el apellido es la penúltima (nombre(s) + 2 apellidos).
  const apellido = p.length >= 3 ? p[p.length - 2] : p[1];
  return `${p[0]}_${apellido}`;
}

function contrasenaAleatoria() {
  // 10 caracteres sin los que se confunden al dictarlos (0/O, 1/l/I).
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(10), (b) => abc[b % abc.length]).join('');
}

async function api(metodo, ruta, cuerpo) {
  const r = await fetch(`${process.env.API_URL.replace(/\/$/, '')}${ruta}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${process.env.API_TOKEN}`, 'Content-Type': 'application/json' },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const texto = await r.text();
  let json = null;
  try { json = texto ? JSON.parse(texto) : null; } catch { /* respuesta no JSON */ }
  if (!r.ok) {
    const m = json?.message;
    throw new Error(`${metodo} ${ruta} → ${r.status} ${Array.isArray(m) ? m.join('; ') : m || texto.slice(0, 160)}`);
  }
  return json;
}

async function main() {
  const a = argumentos(process.argv);
  if (!a.entrada) throw new Error('Falta el archivo de entrada. Uso: node database/scripts/alta-promotoras-marca.js <entrada.csv> [--aplicar] [--salida <archivo>]');
  if (!process.env.API_URL || !process.env.API_TOKEN) throw new Error('Faltan API_URL y API_TOKEN en el entorno.');
  const comun = process.env.PASSWORD_INICIAL || null;
  if (comun && comun.length < 6) throw new Error('PASSWORD_INICIAL necesita al menos 6 caracteres (lo exige el alta).');
  if (a.aplicar && !comun && !a.salida) throw new Error('Sin PASSWORD_INICIAL, las contraseñas son aleatorias: indica --salida <archivo> para guardarlas.');

  const filas = leerCsv(fs.readFileSync(a.entrada, 'utf8'));
  console.log(`${filas.length} renglón(es) en la entrada · ${a.aplicar ? 'APLICAR' : 'sólo revisar (sin --aplicar no se escribe nada)'}`);

  // Catálogos de referencia, una vez.
  const sucursales = new Set((await api('GET', '/commercial/warehouses')).map((w) => String(w.code)));
  const cacheMarca = new Map();
  async function marcaId(nombre) {
    const clave = sinAcentos(nombre).toUpperCase();
    if (!cacheMarca.has(clave)) {
      const hits = await api('GET', `/commercial/promoter-brands/brands?search=${encodeURIComponent(nombre)}`);
      const exactas = (hits || []).filter((b) => sinAcentos(String(b.nombre)).toUpperCase() === clave);
      cacheMarca.set(clave, exactas.length === 1 ? exactas[0].id : null);
    }
    return cacheMarca.get(clave);
  }
  async function existe(username) {
    const r = await api('GET', `/users?search=${encodeURIComponent(username)}&page_size=50`);
    return (r?.rows ?? r ?? []).find((u) => String(u.username).toLowerCase() === username.toLowerCase()) ?? null;
  }

  const plan = [];
  const vistos = new Set();
  for (const f of filas) {
    const errores = [];
    if (!f.nombre) errores.push('sin nombre');
    const username = (f.username || usuarioDe(f.nombre || '') || '').toLowerCase();
    if (!/^[a-z0-9._-]{3,64}$/.test(username)) errores.push(`usuario inválido «${username}»`);
    if (vistos.has(username)) errores.push(`usuario repetido en la entrada «${username}»`);
    vistos.add(username);
    if (!sucursales.has(f.sucursal)) errores.push(`sucursal «${f.sucursal}» no existe`);
    const alcance = alcanceDe(f);
    for (const s of alcance) if (!sucursales.has(s)) errores.push(`sucursal del alcance «${s}» no existe`);
    if (!alcance.includes(f.sucursal)) errores.push(`la sucursal de su ficha (${f.sucursal}) no está en su alcance (${alcance.join('|')})`);
    const nombresMarca = (f.marcas || '').split('|').map((x) => x.trim()).filter(Boolean);
    const brandIds = [];
    for (const m of nombresMarca) {
      const id = await marcaId(m);
      if (id) brandIds.push(id); else errores.push(`marca «${m}» no existe con ese nombre exacto (o hay varias)`);
    }
    const ya = errores.length ? null : await existe(username);
    // Una cuenta que ya existe sólo se retoma si YA es promotora; si es de otra persona, no se toca.
    if (ya && !esPromotora(ya)) errores.push(`el usuario «${username}» ya es de otra persona (${ya.role_name ?? '¿perfil?'}): pon otro en la columna username`);
    plan.push({ ...f, username, alcance, brandIds, errores, ya });
  }

  for (const p of plan) {
    const estado = p.errores.length ? `✗ ${p.errores.join(' · ')}` : p.ya ? '~ ya es promotora: se le vuelven a fijar permisos, sucursales y marcas' : '+ se crea';
    console.log(`  L${p.linea} ${p.username.padEnd(26)} ${p.alcance.join('|').padEnd(12)} ${String(p.brandIds.length).padStart(2)} marca(s)  ${estado}`);
  }
  if (a.solo && !plan.some((p) => p.username === a.solo)) throw new Error(`--solo ${a.solo}: no está en la entrada.`);
  const conError = plan.filter((p) => p.errores.length).length;
  const listos = plan.filter((p) => !p.errores.length && (!a.solo || p.username === a.solo));
  const nuevos = listos.filter((p) => !p.ya).length;
  console.log(`\n${nuevos} por crear · ${listos.length - nuevos} por retomar · ${conError} con error`);
  if (!a.aplicar) return;
  if (conError) throw new Error('Hay renglones con error: corrígelos antes de aplicar (no se crea nada a medias).');

  const salida = [];
  let hechos = 0;
  try {
    for (const p of listos) {
      try {
        let id = p.ya?.id;
        if (!id) {
          const password = comun || contrasenaAleatoria();
          const u = await api('POST', '/users', {
            username: p.username, password, nombre: p.nombre, role_name: PERFIL_BASE, department_code: DEPARTAMENTO,
            warehouse_code: p.sucursal, must_change_password: true,
          });
          id = u.id;
          // Se anota EN CUANTO existe la cuenta: si lo de abajo falla, la contraseña no se pierde.
          if (!comun) salida.push([p.nombre, p.username, password, p.sucursal, p.plaza || '', p.puesto || '']);
        }
        const antes = await api('GET', `/users/${id}/permissions`);
        await api('PUT', `/users/${id}/permissions`, { overrides: overridesPara(antes.del_puesto ?? []) });
        const despues = await api('GET', `/users/${id}/permissions`);
        if (!quedoBien(despues.efectivos ?? [])) {
          throw new Error(`quedó con ${JSON.stringify(despues.efectivos)}; debía quedar sólo con ${EFECTIVOS.join(' + ')}`);
        }
        // Sucursales de su zona: alcance propio `listed`. Se comprueba leyendo lo efectivo.
        await api('PUT', `/users/${id}/scope/warehouse`, { mode: 'listed', values: p.alcance, nota: NOTA });
        const sc = await api('GET', `/users/${id}/scope`);
        const efectivas = sucursalesEfectivas(sc);
        if (JSON.stringify(efectivas) !== JSON.stringify([...p.alcance].sort())) {
          throw new Error(`quedó con sucursales ${JSON.stringify(efectivas)}; debían ser ${p.alcance.join('|')}`);
        }
        // Sin marcas = sin limitar (se borra cualquier marca vieja); con marcas = sólo ésas.
        await api('PUT', `/commercial/promoter-brands/${id}`, { brand_ids: p.brandIds });
        hechos++;
        console.log(`  ✓ ${p.username} ${p.ya ? 'retomada' : 'creada'}: ${EFECTIVOS.join(' + ')} · sucursales ${p.alcance.join('|')} · ${p.brandIds.length} marca(s)`);
      } catch (e) {
        // Se para en el primer error: lo hecho queda, re-correr lo retoma y se sabe dónde quedó.
        console.log(`  ✗ ${p.username}: ${e.message}`);
        break;
      }
    }
  } finally {
    if (salida.length) {
      const csv = ['nombre,usuario,contrasena,sucursal,plaza,puesto', ...salida.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(','))].join('\n');
      fs.writeFileSync(a.salida, csv + '\n', { mode: 0o600 });
      console.log(`\nContraseñas en ${a.salida} (${salida.length}). Entrégalas por un canal privado y BORRA el archivo.`);
    }
  }
  console.log(`\n${hechos} de ${listos.length} lista(s).`);
  if (hechos < listos.length) process.exitCode = 1;
}

/** Una cuenta que este script puede retomar: ya tiene el perfil base y el departamento de externos. */
function esPromotora(u) {
  return u.role_name === PERFIL_BASE && u.department_code === DEPARTAMENTO;
}

/** Sucursales del alcance pedido: la columna `sucursales` («01|02»), o sólo la de su ficha. Ordenadas, sin repetir. */
function alcanceDe(f) {
  const lista = String(f.sucursales || f.sucursal || '').split('|').map((x) => x.trim()).filter(Boolean);
  return [...new Set(lista)].sort();
}

/**
 * Las sucursales que el servidor dice que la cuenta tiene, de `GET /users/:id/scope`. Acepta las
 * dos formas en que puede venir la dimensión (objeto por dimensión o lista de dimensiones) y, si
 * no la encuentra, devuelve [] para que la comprobación falle en vez de dar por bueno algo no leído.
 */
function sucursalesEfectivas(sc) {
  const dims = sc?.dims ?? sc?.dimensions ?? sc?.scope ?? sc;
  const w = Array.isArray(dims) ? dims.find((d) => (d.dimension ?? d.code) === 'warehouse') : dims?.warehouse;
  const vals = w?.valuesWrite?.length ? w.valuesWrite : (w?.values ?? []);
  return [...new Set((vals || []).map(String))].sort();
}

if (require.main === module) {
  main().catch((e) => { console.error(`ERROR ${e.message}`); process.exit(1); });
}
module.exports = { leerCsv, usuarioDe, contrasenaAleatoria, overridesPara, quedoBien, esPromotora, alcanceDe, sucursalesEfectivas };
