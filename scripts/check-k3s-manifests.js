#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * [K3S.4] EL CANDADO DE LOS MANIFIESTOS — con sus pruebas NEGATIVAS.
 *
 * QUÉ PROTEGE. Los defaults de Kubernetes están elegidos para servicios web sin estado, y los
 * carriles de ingesta son lo contrario: singletons con estado compartido y sin dimensión de
 * dueño. Tres defaults, aplicados tal cual, pierden datos o los esconden:
 *
 *   · `Deployment.strategy` = **RollingUpdate** con `maxSurge 25%` → con `replicas: 1` levanta el
 *     pod nuevo ANTES de matar el viejo. Dos shippers a la vez se pisan `ods.ctl` —que llavea
 *     sólo `(table_name)`— y las filas del medio no se vuelven a mirar. Sin error y sin log.
 *   · `CronJob.concurrencyPolicy` = **Allow** → una corrida larga se solapa con la siguiente.
 *     Dos reconciliadores propagando DELETE sobre las mismas tablas.
 *   · `Job.backoffLimit` = **6** → un trabajo que propaga DELETE se reintenta solo seis veces.
 *
 * Y una cuarta que no es un default sino una tentación: ponerle `livenessProbe` a un Job. Ya
 * costó **505 reinicios en 7 días** en Compose, porque la sonda de ENTREGA mataba al proceso que
 * producía justo lo que la sonda exigía. En K8s el mismo error se escribe `activeDeadlineSeconds`.
 *
 * NO valida sintaxis de Kubernetes —para eso está `kubectl --dry-run`— sino las DECISIONES que
 * este sistema ya pagó por aprender. Parser mínimo y deliberado: si no entiende un manifiesto,
 * FALLA en vez de aprobarlo (un candado que no entiende y calla se lee igual que uno que pasó).
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'ops', 'k3s');

let ok = 0; let fail = 0; let nm = 0;
const A = (cond, msg) => {
  if (cond) { ok++; console.log('  ✔ ' + msg); } else { fail++; console.log('  ✖ ' + msg); }
};
const NM = (msg) => { nm++; console.log('  — NO MEDIDO: ' + msg); };

/**
 * Parser mínimo de los campos que importan. No es YAML completo a propósito: sólo busca
 * `clave: valor` con su indentación, que es todo lo que estas reglas necesitan.
 * Devuelve los documentos separados por `---`.
 */
function documentos(texto) {
  return texto.split(/^---\s*$/m)
    .map((d) => d.split(/\r?\n/).filter((l) => !/^\s*#/.test(l) && l.trim() !== ''))
    .filter((ls) => ls.length);
}
/**
 * ⚠️ El comentario AL FINAL DE LA LÍNEA se recorta antes de leer el valor. La primera versión no
 * lo hacía y el candado se puso rojo sobre sus propios manifiestos, que estaban bien: leía
 * `replicas: 1  # ⛔ NUNCA subir` como el valor `"1  # ⛔ NUNCA subir"`. Las reglas eran
 * correctas —las cinco negativas pasaban— y el parser no. Se recorta sólo cuando el `#` viene
 * precedido de espacio, para no mutilar un valor que lo contenga pegado.
 */
const campo = (lineas, clave) => {
  const re = new RegExp('^\\s*' + clave + ':\\s*(.+?)\\s*$');
  for (const l of lineas) {
    const m = l.match(re);
    if (m) return m[1].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
  }
  return null;
};
const tiene = (lineas, clave) => lineas.some((l) => new RegExp('^\\s*' + clave + ':').test(l));

/** Las reglas, aplicadas a UN documento. Devuelve [{ok, msg}]. */
function revisar(doc, archivo) {
  const kind = campo(doc, 'kind');
  const nombre = campo(doc, 'name') || '(sin nombre)';
  const et = `${archivo} · ${kind} ${nombre}`;
  const r = [];

  if (kind === 'Deployment') {
    const replicas = campo(doc, 'replicas');
    const strategy = campo(doc, 'type');
    r.push([replicas === '1', `${et}: replicas=1 (es ${replicas}) — más de uno se pisa ods.ctl`]);
    r.push([strategy === 'Recreate',
      `${et}: strategy=Recreate (es ${strategy || 'AUSENTE → el default es RollingUpdate'}) `
      + '— RollingUpdate solapa dos shippers y pierde filas en silencio']);
  }

  if (kind === 'CronJob') {
    const conc = campo(doc, 'concurrencyPolicy');
    const backoff = campo(doc, 'backoffLimit');
    const tz = campo(doc, 'timeZone');
    r.push([conc === 'Forbid',
      `${et}: concurrencyPolicy=Forbid (es ${conc || 'AUSENTE → el default es Allow'})`]);
    r.push([backoff === '0',
      `${et}: backoffLimit=0 (es ${backoff || 'AUSENTE → el default es 6'}) `
      + '— reintentar solo un job que propaga DELETE es correrlo de nuevo entero']);
    r.push([!!tz, `${et}: declara timeZone (${tz || 'AUSENTE → correría en UTC, 6 h corrido'})`]);
    // La trampa que no es un default, sino una tentación.
    r.push([!tiene(doc, 'livenessProbe') && !tiene(doc, 'activeDeadlineSeconds'),
      `${et}: SIN livenessProbe ni activeDeadlineSeconds — un Job termina o falla; matarlo a `
      + 'mitad es el footgun que costó 505 reinicios en 7 días']);
    // Si el carril late, su llave tiene que ser propia.
    if (/reconcile/.test(String(nombre))) {
      r.push([doc.some((l) => /ODS_RECONCILE_HB_KEY/.test(l)),
        `${et}: declara ODS_RECONCILE_HB_KEY propia — sin ella pisa el renglón de otro carril`]);
      r.push([doc.some((l) => /--apply/.test(l)),
        `${et}: lleva --apply — sin él no late ([OBS.13]) y queda mudo pareciendo que corre`]);
    }
  }

  // [K3S.7] Una `livenessProbe` que corre `health.js` SIN `ODS_HB_KEY` es decorativa: el script
  // imprime «sin ODS_HB_URL/ODS_HB_KEY — no se evalúa» y **sale 0**, así que el pod queda healthy
  // pase lo que pase. ⚠️ `ODS_RECONCILE_HB_KEY` NO sirve: esa la lee el reconciliador para elegir
  // SU renglón, no el chequeo. Se descubrió ejecutando la sonda a mano en vez de esperar sus 20
  // min de `initialDelay`, y venía así desde Compose — o sea que el defecto no lo trajo K3s.
  if (kind === 'Deployment' && doc.some((l) => /health\.js/.test(l))) {
    r.push([doc.some((l) => /ODS_HB_KEY/.test(l)),
      `${et}: la sonda corre health.js y declara ODS_HB_KEY — sin ella sale 0 SIEMPRE `
      + '(ODS_RECONCILE_HB_KEY no cuenta: la lee el reconciliador, no el chequeo)']);
  }

  if (kind === 'Service') {
    // El puente de nombres: un Service sin selector NECESITA sus Endpoints, o resuelve a nada.
    r.push([!tiene(doc, 'selector'),
      `${et}: sin selector (el puente a Postgres del host se declara con Endpoints a mano)`]);
  }
  return r;
}

(async () => {
  console.log('\n=== [K3S.4] candado de los manifiestos de ingesta ===\n');

  if (!fs.existsSync(DIR)) {
    console.log(`  ✖ no existe ${DIR}`);
    process.exit(1);
  }
  const archivos = fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();

  console.log('0) hay manifiestos que revisar  ← sin esto el candado es un no-op');
  A(archivos.length > 0, `${archivos.length} manifiesto(s) en ops/k3s/`);

  const kinds = [];
  console.log('\n1) las reglas, documento por documento');
  for (const f of archivos) {
    for (const doc of documentos(fs.readFileSync(path.join(DIR, f), 'utf8'))) {
      const kind = campo(doc, 'kind');
      if (!kind) { fail++; console.log(`  ✖ ${f}: un documento SIN kind — el candado no lo entiende, y no lo aprueba`); continue; }
      kinds.push(kind);
      for (const [cond, msg] of revisar(doc, f)) A(cond, msg);
    }
  }

  console.log('\n2) el Service sin selector tiene sus Endpoints  ← si no, resuelve a NADA');
  const svc = []; const eps = [];
  for (const f of archivos) {
    for (const doc of documentos(fs.readFileSync(path.join(DIR, f), 'utf8'))) {
      const k = campo(doc, 'kind'); const n = campo(doc, 'name');
      if (k === 'Service') svc.push(n);
      if (k === 'Endpoints') eps.push(n);
    }
  }
  for (const s of svc) {
    A(eps.includes(s), `Service '${s}' tiene Endpoints con el MISMO nombre (si no, el DNS devuelve vacío)`);
  }

  console.log('\n3) cobertura: ¿qué carriles de Compose todavía no tienen manifiesto?');
  const compose = path.join(__dirname, '..', 'ops', 'vl', 'docker-compose.yml');
  if (!fs.existsSync(compose)) {
    NM('no encontré ops/vl/docker-compose.yml para comparar');
  } else {
    const txt = fs.readFileSync(compose, 'utf8');
    const enCompose = [...txt.matchAll(/^\s{4}container_name:\s*(\S+)\s*$/gm)].map((m) => m[1])
      .filter((n) => /^(ods-|feeds-|store-)/.test(n) && n !== 'ods-autoheal');
    const nombres = [];
    for (const f of archivos) {
      for (const doc of documentos(fs.readFileSync(path.join(DIR, f), 'utf8'))) {
        const k = campo(doc, 'kind');
        if (k === 'Deployment' || k === 'CronJob') nombres.push(campo(doc, 'name'));
      }
    }
    const faltan = enCompose.filter((c) => !nombres.includes(c));
    // ⚠️ NO es una falla: la migración es por etapas y lo que falta se DECLARA, que es
    // distinto de que nadie lo haya mirado. Lo que sería falla es que el número no se vea.
    console.log(`  ⓘ ${nombres.length} de ${enCompose.length} carriles con manifiesto`);
    if (faltan.length) console.log(`     pendientes: ${faltan.join(', ')}`);
    A(enCompose.length > 0, 'se pudo leer la lista de carriles de Compose para comparar');
  }

  console.log('\n4) ⛔ Ningún carril vive en los DOS mundos  ← el riesgo propio de migrar');
  // Durante la migración conviven Compose y K3s. Si un carril queda en los dos, los dos escriben
  // el MISMO renglón de `analytics.cron_runs` (comparten `ODS_RECONCILE_HB_KEY`/`ODS_HB_KEY`) y se
  // lo pisan — la falla que la guarda de dueño de `health.js` detecta, causada por nosotros.
  // Se compara contra `SERVICIOS_DEF` de `ops/vl/deploy.sh`, que es lo que `--todo` levanta.
  const deploySh = path.join(__dirname, '..', 'ops', 'vl', 'deploy.sh');
  if (!fs.existsSync(deploySh)) {
    NM('no encontré ops/vl/deploy.sh para comparar los dos mundos');
  } else {
    const m = fs.readFileSync(deploySh, 'utf8').match(/^SERVICIOS_DEF="([^"]*)"/m);
    if (!m) {
      NM('no pude leer SERVICIOS_DEF de ops/vl/deploy.sh (¿cambió de forma?)');
    } else {
      const enCompose = m[1].split(/\s+/).filter(Boolean);
      const enK3s = [];
      for (const f of archivos) {
        for (const doc of documentos(fs.readFileSync(path.join(DIR, f), 'utf8'))) {
          const k = campo(doc, 'kind');
          if (k === 'Deployment' || k === 'CronJob') enK3s.push(campo(doc, 'name'));
        }
      }
      // ⚠️ Tener MANIFIESTO no es estar MIGRADO, y confundirlos hacía que el candado marcara
      // como peligro algo que no lo era: `ods-live-hot` tiene su YAML escrito y sigue corriendo
      // —correctamente— en Compose. Por eso cada manifiesto declara su estado en la etiqueta
      // `migracion`, y la regla se aplica a lo que DICE, no a que el archivo exista:
      //    migrado   → el carril ya corre en K3s  ⇒ NO puede seguir en SERVICIOS_DEF
      //    preparado → el YAML está escrito y sin aplicar ⇒ SÍ debe seguir en SERVICIOS_DEF
      // La trampa que esto cierra: un `kubectl apply -f ops/k3s/` aplicaría también los
      // `preparado` y crearía el doble-corredor al instante, en silencio.
      const migrados = []; const preparados = []; const sinMarca = [];
      for (const f of archivos) {
        for (const doc of documentos(fs.readFileSync(path.join(DIR, f), 'utf8'))) {
          const k = campo(doc, 'kind');
          if (k !== 'Deployment' && k !== 'CronJob') continue;
          const n = campo(doc, 'name'); const est = campo(doc, 'migracion');
          if (est === 'migrado') migrados.push(n);
          else if (est === 'preparado') preparados.push(n);
          else sinMarca.push(n);
        }
      }
      A(sinMarca.length === 0,
        sinMarca.length === 0
          ? 'los manifiestos declaran su estado de migración'
          : `SIN etiqueta 'migracion': ${sinMarca.join(', ')} — no se puede decidir si es peligro o no`);
      const dobles = migrados.filter((n) => enCompose.includes(n));
      A(dobles.length === 0,
        dobles.length === 0
          ? `ninguno de los ${migrados.length} MIGRADO(s) sigue en SERVICIOS_DEF`
          : `EN LOS DOS MUNDOS: ${dobles.join(', ')} — se pisarían el renglón de cron_runs`);
      const huerfanos = preparados.filter((n) => !enCompose.includes(n));
      A(huerfanos.length === 0,
        huerfanos.length === 0
          ? `los ${preparados.length} PREPARADO(s) siguen corriendo en Compose, como corresponde`
          : `NO LOS CORRE NADIE: ${huerfanos.join(', ')} — marcados 'preparado' pero fuera de Compose`);
      console.log(`  ⓘ migrados: ${migrados.join(', ') || 'ninguno'}`);
      console.log(`  ⓘ preparados (YAML escrito, todavía en Compose): ${preparados.join(', ') || 'ninguno'}`);
    }
  }

  console.log('\n5) Las reglas se rompen a propósito  ← negativas en memoria');
  const malo1 = ['kind: Deployment', 'name: x', 'replicas: 2', 'type: Recreate'];
  A(revisar(malo1, 'test').some(([c, m]) => !c && /replicas=1/.test(m)), 'replicas=2 se detecta');
  const malo2 = ['kind: Deployment', 'name: x', 'replicas: 1'];
  A(revisar(malo2, 'test').some(([c, m]) => !c && /RollingUpdate/.test(m)),
    'strategy AUSENTE se detecta (es el caso peligroso: nadie lo escribió mal, lo omitió)');
  const malo3 = ['kind: CronJob', 'name: y', 'concurrencyPolicy: Allow', 'backoffLimit: 0', 'timeZone: X'];
  A(revisar(malo3, 'test').some(([c, m]) => !c && /concurrencyPolicy/.test(m)), 'concurrencyPolicy=Allow se detecta');
  const malo4 = ['kind: CronJob', 'name: ods-reconcile-z', 'concurrencyPolicy: Forbid',
    'backoffLimit: 0', 'timeZone: X', 'livenessProbe:', 'ODS_RECONCILE_HB_KEY', '--apply'];
  A(revisar(malo4, 'test').some(([c, m]) => !c && /SIN livenessProbe/.test(m)),
    'un Job con livenessProbe se detecta (el footgun de los 505 reinicios)');
  const bueno = ['kind: Deployment', 'name: x', 'replicas: 1', 'type: Recreate'];
  A(revisar(bueno, 'test').every(([c]) => c), 'y NO marca de más: un manifiesto correcto pasa limpio');

  console.log(`\n=== ${ok} ✔ · ${fail} ✖ · ${nm} no medido ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
