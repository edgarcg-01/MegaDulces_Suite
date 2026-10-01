/* eslint-disable no-console */
/**
 * [INFRA.4] EL CANDADO DE LA PARTICION DE CARRILES DEL ODS -- con sus pruebas NEGATIVAS.
 *
 * QUE PROTEGE. Dos contenedores shipean el mismo ODS desde las mismas 9 replicas:
 *   ods-live-hot    @15 s  -- KP_ODS_TABLES = el set caliente (venta, movimientos, catalogos)
 *   ods-live-mirror @300 s -- KP_ODS_TABLES = "*" (todo md.*) MENOS ODS_EXCLUDE_TABLES
 *
 * La particion no la impone ningun codigo: la impone que las DOS listas se escriban a mano,
 * coherentes entre si, en el mismo archivo. Y el estado del CDC es COMPARTIDO y no tiene una
 * sola columna que diga que carril lo escribio:
 *
 *     ods.ctl     ON CONFLICT (table_name)            -- replicate-ods-live.js
 *     ods.shadow  ON CONFLICT (table_name, pk_text)   -- replicate-ods-live.js
 *
 * O sea que si una tabla cae en los DOS carriles, el de 15 s y el de 300 s se pisan el
 * watermark: uno graba un ctid viejo encima del nuevo y las filas del medio NO se vuelven a
 * mirar. No hay excepcion, no hay reintento y el log no dice nada -- el mismo modo de falla que
 * ya costo seis dias de precios viejos en la Fase OBS.
 *
 * Y en el otro sentido: una tabla EXCLUIDA del espejo que tampoco este en el caliente no la
 * entrega NADIE. Eso puede ser deliberado (hay un caso vivo, kdib), pero tiene que estar
 * DECLARADO aca con su motivo -- un hueco sin declarar se lee exactamente igual que uno
 * decidido.
 *
 * POR QUE AHORA. El comentario de ops/vl/docker-compose.yml ya habia nombrado esto "el hallazgo
 * grande" (la lista copiada a mano en cuatro lugares) y lo dejo abierto, con la advertencia de
 * que tocar el reparto sin una prueba que compare el conjunto embarcado es como se pierde una
 * sucursal en silencio. [INFRA.3] retiro la cuarta copia (el default del script). Esta es la
 * prueba que faltaba para las dos que QUEDAN, que son las que de verdad embarcan.
 *
 * El matcher de globs se IMPORTA de produccion (__test._globs/_lits/matchesGlob). Reimplementar
 * aca la regla de kdc2-asterisco seria la quinta copia a mano de lo mismo, que es lo que esta
 * fase esta retirando.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { _globs, _lits, matchesGlob } = require('../importers/kepler/replicate-ods-live').__test;

const COMPOSE = path.join(__dirname, '../../ops/vl/docker-compose.yml');
const SHIPPER = path.join(__dirname, '../importers/kepler/replicate-ods-live.js');

/**
 * HUECOS DECLARADOS: tabla excluida del espejo y AUSENTE del caliente => nadie la entrega.
 * Agregar una entrada aca es una decision, no un tramite: se escribe el motivo medido.
 */
const HUECOS_DECLARADOS = {
  kdib: 'destino inexistente: to_regclass(kepler_ods.kdib) da NULL en prod (medido 2026-09-24, '
      + '[CT.3]). En la FUENTE si existe (md.kdib esta en las replicas), asi que no es un nombre '
      + 'mal escrito: es una tabla que nunca pudo entregar. Estuvo en el carril de 15 s sin una '
      + 'sola mencion en 441 lineas de log -- no fallaba, CALLABA.',
};

let ok = 0, fail = 0, nm = 0;
const A = (cond, msg) => {
  if (cond) { ok++; console.log('  ✔ ' + msg); } else { fail++; console.log('  ✖ ' + msg); }
};
const NM = (msg) => { nm++; console.log('  — NO MEDIDO: ' + msg); };

/** Lee el bloque environment de un servicio del compose. Falla FUERTE si no lo encuentra. */
function envDeServicio(texto, servicio) {
  const lineas = texto.split(/\r?\n/);
  const i = lineas.findIndex((l) => l === '  ' + servicio + ':');
  if (i < 0) {
    throw new Error('[INFRA.4] no encontre el servicio ' + servicio + ' en ' + COMPOSE
      + ' -- si lo renombraron, este candado quedaria mirando al vacio, y un no-op se lee igual que verde');
  }
  const env = {};
  for (let j = i + 1; j < lineas.length; j++) {
    const l = lineas[j];
    if (l.trim() !== '' && /^\s{0,2}\S/.test(l)) break;
    const m = l.match(/^ {6}([A-Z_][A-Z0-9_]*):\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return env;
}

const tok = (v) => String(v === undefined || v === null ? '' : v)
  .split(',').map((s) => s.trim()).filter(Boolean);

/** La lista (literales + globs) CUBRE este nombre? Misma semantica que produccion. */
const cubre = (lista, nombre) => new Set(_lits(lista)).has(nombre) || matchesGlob(nombre, _globs(lista));

(async () => {
  console.log('\n=== [INFRA.4] particion de carriles del ODS ===\n');

  const texto = fs.readFileSync(COMPOSE, 'utf8');
  const hot = envDeServicio(texto, 'ods-live-hot');
  const mirror = envDeServicio(texto, 'ods-live-mirror');

  const HOT = tok(hot.KP_ODS_TABLES);
  const HASH = tok(hot.ODS_HASH_TABLES);
  const EXC = tok(mirror.ODS_EXCLUDE_TABLES);

  console.log('0) las dos listas se leyeron de verdad  <- sin esto el candado es un no-op');
  A(HOT.length > 0, 'ods-live-hot declara KP_ODS_TABLES (' + HOT.length + ' entradas)');
  A(EXC.length > 0, 'ods-live-mirror declara ODS_EXCLUDE_TABLES (' + EXC.length + ' entradas)');
  A(mirror.KP_ODS_TABLES === '*',
    'el espejo esta en ALL_MODE (KP_ODS_TABLES="*"); si no, excluir no significa lo mismo');

  console.log('\n1) SIN TRASLAPE: todo lo del caliente esta excluido del espejo');
  const traslape = HOT.filter((t) => !cubre(EXC, t));
  A(traslape.length === 0,
    traslape.length === 0
      ? 'ningun carril pisa al otro (' + HOT.length + ' tablas del hot, todas excluidas del espejo)'
      : 'DOBLE SHIP en: ' + traslape.join(', ') + ' -- se pisan ods.ctl y pierden filas sin avisar');

  console.log('\n2) HUECOS DECLARADOS: lo excluido que nadie entrega tiene motivo escrito');
  const huecos = EXC.filter((t) => !cubre(HOT, t));
  for (const h of huecos) {
    const declarado = Object.prototype.hasOwnProperty.call(HUECOS_DECLARADOS, h);
    A(declarado, h + ': excluida del espejo y ausente del caliente => NADIE la entrega'
      + (declarado ? ' (declarado)' : ' -- SIN DECLARAR en HUECOS_DECLARADOS'));
  }
  if (!huecos.length) console.log('  (no hay huecos: cada tabla excluida del espejo la entrega el caliente)');

  console.log('\n3) La lista de huecos NO se pudre  <- negativa');
  for (const d of Object.keys(HUECOS_DECLARADOS)) {
    A(huecos.includes(d), d + ' sigue siendo un hueco real; si se arreglo, sacarlo de HUECOS_DECLARADOS');
  }

  console.log('\n4) ODS_HASH_TABLES es un FILTRO, no agrega nada  <- el bug de [CT.3]');
  const inertes = HASH.filter((t) => !cubre(HOT, t));
  A(inertes.length === 0,
    inertes.length === 0
      ? 'las ' + HASH.length + ' del carril hash estan en la maestra'
      : 'INERTES (en ODS_HASH_TABLES pero NO en KP_ODS_TABLES, no shipean nada): ' + inertes.join(', '));

  console.log('\n5) El shipper NO tiene lista por defecto  <- negativa, [INFRA.3]');
  const env = Object.assign({}, process.env);
  delete env.KP_ODS_TABLES;
  const r = spawnSync(process.execPath, [SHIPPER], { env, encoding: 'utf8', timeout: 30000 });
  const salida = String(r.stdout || '') + String(r.stderr || '');
  A(r.status === 1, 'sin KP_ODS_TABLES sale con codigo 1 (fue: ' + r.status + ')');
  A(/SIN TABLAS que procesar/.test(salida), 'y lo DICE, en vez de shipear un conjunto plausible');
  A(/--tables=/.test(salida) && !/--only/.test(salida),
    'el mensaje nombra la bandera que EXISTE (--tables=), no una inventada');

  console.log('\n6) Los huecos declarados, medidos contra prod');
  const url = process.env.DATABASE_URL_NEW;
  if (!url) {
    NM('sin DATABASE_URL_NEW no se puede comprobar que el destino de los huecos falte de verdad');
  } else {
    const { Client } = require('pg');
    const c = new Client({ connectionString: url, connectionTimeoutMillis: 8000, statement_timeout: 8000 });
    let conectado = false;
    try {
      await c.connect();
      conectado = true;
      for (const d of Object.keys(HUECOS_DECLARADOS)) {
        const q = await c.query("SELECT to_regclass('kepler_ods.' || $1) AS dest", [d]);
        A(q.rows[0].dest === null,
          d + ': su destino kepler_ods.' + d + ' sigue sin existir en prod (por eso el hueco es inocuo)');
      }
    } catch (e) {
      NM('no pude consultar prod (' + String(e.message).slice(0, 70) + ')');
    } finally {
      if (conectado) { try { await c.end(); } catch (_) { /* cerrar es best-effort */ } }
    }
  }

  console.log('\n7) Las reglas se rompen a proposito  <- negativas en memoria');
  // Se mide el DELTA contra el estado real, no un absoluto: si el compose ya estuviera roto,
  // un absoluto daria rojo aca tambien y taparia cual es la falla de verdad.
  const HOT_MALO = HOT.concat(['kdpord']);
  A(HOT_MALO.filter((t) => !cubre(EXC, t)).length - traslape.length === 1,
    'meter kdpord en el caliente sin excluirlo del espejo => la regla 1 suma exactamente 1 violacion');
  const EXC_MALO = EXC.concat(['kdlogmov']);
  const sinDeclararAhora = huecos.filter((t) => !HUECOS_DECLARADOS[t]).length;
  A(EXC_MALO.filter((t) => !cubre(HOT, t)).filter((t) => !HUECOS_DECLARADOS[t]).length
      - sinDeclararAhora === 1,
    'excluir kdlogmov del espejo sin ponerlo en el caliente => la regla 2 suma exactamente 1 hueco');
  A(cubre(EXC, 'kdc2601') && cubre(HOT, 'kdc2601'),
    'el glob kdc2-asterisco cubre una poliza mensual concreta en las DOS listas');
  A(!cubre(HOT, 'kdib'), 'y NO cubre de mas: kdib no entra al caliente por parecerse a nada');

  console.log('\n=== ' + ok + ' ✔ · ' + fail + ' ✖ · ' + nm + ' no medido ===\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
