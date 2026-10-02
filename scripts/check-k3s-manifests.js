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
    if (m) {
      const v = m[1].replace(/\s+#.*$/, '').trim();
      // ⚠️ Un valor que abre llave NO es un valor: es un mapa en línea. La primera versión
      // devolvía `{ name: redis, namespace: prod }` como si fuera el nombre, y el candado
      // reportaba «Service (sin nombre)» sobre manifiestos correctos.
      if (!v.startsWith('{')) return v.replace(/^["']|["']$/g, '');
    }
    // YAML admite las dos formas, y los manifiestos del repo usan las dos:
    //   metadata:\n  name: redis        ← bloque
    //   metadata: { name: redis, ... }  ← en línea
    const inl = l.match(new RegExp('[{,]\\s*' + clave + ':\\s*([^,}]+)'));
    if (inl) return inl[1].trim().replace(/^["']|["']$/g, '');
  }
  return null;
};
/** ¿Existe la clave, en bloque o en línea? (distinto de leer su valor) */
const tieneClave = (lineas, clave) => lineas.some((l) =>
  new RegExp('^\\s*' + clave + ':').test(l) || new RegExp('[{,]\\s*' + clave + ':').test(l));
const tiene = (lineas, clave) => lineas.some((l) => new RegExp('^\\s*' + clave + ':').test(l));

/** Las reglas, aplicadas a UN documento. Devuelve [{ok, msg}]. */
function revisar(doc, archivo) {
  const kind = campo(doc, 'kind');
  const nombre = campo(doc, 'name') || '(sin nombre)';
  const et = `${archivo} · ${kind} ${nombre}`;
  const r = [];

  if (kind === 'Deployment') {
    // ⭐ [K3S.19] EL INVARIANTE NO ES «TODO ES SINGLETON», y la primera versión de esta regla lo
    // confundía: marcaba en rojo al `api`, que legítimamente tiene DOS réplicas y DEBE usar
    // RollingUpdate —ésa es justamente la razón de migrarlo—. El invariante real es:
    //
    //     lo que comparte estado SIN DUEÑO se corre de a uno; lo apátrida, no.
    //
    // Los carriles del ODS escriben `ods.ctl`, que llavea sólo `(table_name)`: dos copias se
    // pisan y pierden filas. El `api` no comparte nada de eso. Por eso cada Deployment DECLARA
    // su naturaleza en la etiqueta `singleton`, y la regla sigue a lo que dice — no al revés.
    // Y la etiqueta es OBLIGATORIA: omitirla no puede significar «no es singleton», porque
    // justo lo que se quiere evitar es que alguien agregue un carril sin pensarlo.
    const singleton = campo(doc, 'singleton');
    r.push([singleton === 'true' || singleton === 'false',
      `${et}: declara la etiqueta singleton (es ${singleton === null ? 'AUSENTE' : singleton})`
      + ' — sin ella no se puede decidir si replicarlo pierde datos']);
    if (singleton === 'true') {
      const replicas = campo(doc, 'replicas');
      const strategy = campo(doc, 'type');
      r.push([replicas === '1', `${et}: SINGLETON con replicas=1 (es ${replicas}) — más de uno se pisa ods.ctl`]);
      r.push([strategy === 'Recreate',
        `${et}: SINGLETON con strategy=Recreate (es ${strategy || 'AUSENTE → el default es RollingUpdate'}) `
        + '— RollingUpdate solapa dos y pierde filas en silencio']);
    } else if (singleton === 'false') {
      // El caso contrario también se candadea: si algo apátrida quedó en 1 réplica, no hay
      // despliegue sin caída y la migración no compró lo que decía comprar.
      const replicas = campo(doc, 'replicas');
      r.push([Number(replicas) >= 2,
        `${et}: apátrida con replicas>=2 (es ${replicas}) — con una sola no hay deploy sin caída`]);
    }
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

  // ⛔ [K3S.21] LA IMAGEN PROPIA SE NOMBRA POR COMMIT, NUNCA "latest".
  //
  // Esta regla NO existía, y por eso nadie vio lo que pasó el 2026-10-01: los DOCE manifiestos
  // decían "<imagen>:latest" con imagePullPolicy IfNotPresent, que es exactamente la
  // combinación que hace que el kubelet NO vuelva a jalar nunca. Los pods quedaron 36 commits
  // atrás y le sirvieron ese build a los usuarios internos durante horas — con TODOS los
  // rótulos en verde: el pod Running, la sonda 200, y verificar.sh midiendo el :8080 de
  // Docker, que sí estaba al día. El rótulo no era el veredicto.
  //
  // Con el tag por commit la obsolescencia deja de ser improbable y pasa a ser IMPOSIBLE: si
  // el commit cambia, el tag cambia, y un tag distinto obliga a crear un pod nuevo. Y si la
  // imagen no está publicada, falla A LA VISTA (ImagePullBackOff) en vez de servir algo viejo
  // en silencio — que es la única clase de falla aceptable acá.
  //
  // "__COMMIT__" es un marcador que sustituye el despliegue. Aplicar el manifiesto crudo a
  // mano falla ruidosamente, y eso es deliberado: no hay camino silencioso.
  const imagenes = doc
    .filter((l) => /^\s*image:/.test(l))
    .map((l) => l.replace(/^\s*image:\s*/, '').trim());
  for (const img of imagenes) {
    // busybox, redis y demás públicas se jalan de Docker Hub y no son nuestras: no aplican.
    if (!/trade-(ingest|prod-)/.test(img)) continue;
    r.push([img.startsWith('localhost:5000/'),
      `${et}: imagen propia servida por el registry local (es "${img}") — sin registry hay `
      + 'que importarla a mano con sudo, y lo que se hace a mano se olvida']);
    r.push([/:__COMMIT__$/.test(img),
      `${et}: imagen propia etiquetada por commit, no latest (es "${img}") — `
      + 'latest con IfNotPresent es cómo los pods quedaron 36 commits atrás']);
  }

  if (kind === 'Service') {
    // ⚠️ HAY DOS CLASES DE Service y la primera versión las trataba igual, marcando en rojo a
    // los normales. Un Service CON selector encuentra sus pods solo; uno SIN selector es un
    // PUENTE a algo de afuera del clúster y necesita sus `Endpoints` escritos a mano, o el DNS
    // resuelve a nada. Sólo a ésos se les exige el par, abajo en el bloque 2.
    const esPuente = !tieneClave(doc, 'selector');
    console.log(`  ⓘ ${et}: ${esPuente ? 'PUENTE (sin selector) → necesita Endpoints' : 'normal (con selector)'}`);
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
      // ⛔ [K3S.40] UN `ExternalName` NO LLEVA Endpoints — ni puede. Esta regla nació cuando
      // "Service sin selector" sólo podía significar "puente con Endpoints a mano", y al
      // aparecer el primer ExternalName empezó a exigirle algo imposible: marcaba en rojo un
      // manifiesto correcto. Es la misma familia que las otras compuertas de hoy, al revés —
      // no se quedó sin sujeto, se quedó con un modelo del mundo que ya no era el único.
      // ⭐ Un `type:` que no se mira es un supuesto: "sin selector" ya no implica "puente".
      const tipo = campo(doc, 'type');
      if (k === 'Service' && !tieneClave(doc, 'selector') && tipo !== 'ExternalName') svc.push(n);
      if (k === 'Service' && tipo === 'ExternalName') {
        A(!!campo(doc, 'externalName'),
          `Service '${n}' es ExternalName y declara externalName (sin él resuelve a nada)`);
      }
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
  // ⛔ [K3S.22] SE LEEN LOS DOS deploy.sh, NO UNO SOLO. Hasta el 2026-10-01 esta regla miraba
  // únicamente `ops/vl/deploy.sh` (la ingesta). Para `api`, `portal`, `vendor`, `worker` y
  // `redis` —que viven en `ops/prod/deploy.sh`— comparaba contra una lista donde NUNCA podían
  // aparecer: pasaba EN EL VACÍO. Los cinco estaban marcados `migrado` mientras servían
  // producción desde Compose, y el candado decía ✔ igual.
  // ⭐ Una regla que no puede fallar no es una regla; es una afirmación con forma de prueba.
  const deployShs = [
    path.join(__dirname, '..', 'ops', 'vl', 'deploy.sh'),
    path.join(__dirname, '..', 'ops', 'prod', 'deploy.sh'),
  ];
  const sinArchivo = deployShs.filter((p) => !fs.existsSync(p));
  if (sinArchivo.length) {
    NM(`no encontré ${sinArchivo.join(', ')} para comparar los dos mundos`);
  } else {
    const listas = deployShs.map((p) => ({
      ruta: p, m: fs.readFileSync(p, 'utf8').match(/^SERVICIOS_DEF="([^"]*)"/m),
    }));
    const ilegibles = listas.filter((x) => !x.m).map((x) => path.basename(path.dirname(x.ruta)));
    if (ilegibles.length) {
      NM(`no pude leer SERVICIOS_DEF de: ${ilegibles.join(', ')} (¿cambió de forma?)`);
    } else {
      const enCompose = listas.flatMap((x) => x.m[1].split(/\s+/)).filter(Boolean);
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
      // ⛔ [K3S.21] UN ARCHIVO NO MEZCLA LOS DOS ESTADOS. El despliegue (`aplicar_k3s` en
      // ops/vl/deploy.sh) filtra POR ARCHIVO: si un .yaml contiene 'migracion: preparado' se
      // saltea ENTERO. Con los dos estados en el mismo archivo, el `migrado` dejaría de
      // aplicarse EN SILENCIO — o, al revés, un `preparado` se aplicaría y crearía el
      // doble-corredor. Esta regla es lo único que vuelve válido a aquel filtro; sin ella,
      // el deploy estaría suponiendo.
      const mezclados = [];
      for (const f of archivos) {
        const estados = new Set();
        for (const doc of documentos(fs.readFileSync(path.join(DIR, f), 'utf8'))) {
          const k = campo(doc, 'kind');
          if (k !== 'Deployment' && k !== 'CronJob') continue;
          const est = campo(doc, 'migracion');
          if (est) estados.add(est);
        }
        if (estados.size > 1) mezclados.push(`${f} (${[...estados].join(' + ')})`);
      }
      A(mezclados.length === 0,
        mezclados.length === 0
          ? 'ningún archivo mezcla migrado con preparado — el filtro por archivo del deploy es válido'
          : `MEZCLAN ESTADOS: ${mezclados.join(', ')} — aplicar_k3s saltearía el archivo ENTERO`);
      console.log(`  ⓘ migrados: ${migrados.join(', ') || 'ninguno'}`);
      console.log(`  ⓘ preparados (YAML escrito, todavía en Compose): ${preparados.join(', ') || 'ninguno'}`);
    }
  }

  console.log('\n5) ⛔ El manifiesto no DERIVA del compose que reemplaza');
  // ⚠️ Migrar duplica el entorno: la lista de tablas del ODS ya vivía copiada a mano en varios
  // lugares (`[INFRA.3]`/`[INFRA.4]`) y un manifiesto de K3s suma UNA MÁS. Si el día de mañana
  // alguien toca la del compose y no la del manifiesto, el carril migrado embarca un conjunto
  // distinto del que el repo cree — y eso se ve exactamente igual que embarcar bien.
  // Se comparan las variables que deciden QUÉ se embarca, no todas: las de cadencia y latido
  // cambian legítimamente entre mundos.
  const CRITICAS = ['KP_ODS_TABLES', 'ODS_EXCLUDE_TABLES', 'ODS_HASH_TABLES'];
  const composeTxt = fs.existsSync(path.join(__dirname, '..', 'ops', 'vl', 'docker-compose.yml'))
    ? fs.readFileSync(path.join(__dirname, '..', 'ops', 'vl', 'docker-compose.yml'), 'utf8') : null;
  if (!composeTxt) {
    NM('sin el compose no se puede comparar la deriva del entorno');
  } else {
    const lineasC = composeTxt.split(/\r?\n/);
    /** El valor de una variable dentro del servicio `svc` del compose. */
    const envCompose = (svc, clave) => {
      const i = lineasC.findIndex((l) => l === `  ${svc}:`);
      if (i < 0) return undefined;
      for (let j = i + 1; j < lineasC.length; j++) {
        if (lineasC[j].trim() !== '' && /^\s{0,2}\S/.test(lineasC[j])) break;
        const m = lineasC[j].match(new RegExp('^\\s+' + clave + ':\\s*(.+?)\\s*$'));
        if (m) return m[1].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
      }
      return undefined;
    };
    let comparadas = 0;
    for (const f of archivos) {
      for (const doc of documentos(fs.readFileSync(path.join(DIR, f), 'utf8'))) {
        const k = campo(doc, 'kind');
        if (k !== 'Deployment' && k !== 'CronJob') continue;
        const n = campo(doc, 'name');
        for (const v of CRITICAS) {
          // en el manifiesto la forma es `- name: X` / `value: Y`
          const idx = doc.findIndex((l) => new RegExp(`- name: ${v}\\s*$`).test(l));
          if (idx < 0) continue;
          const val = (doc[idx + 1] || '').match(/^\s*value:\s*(.+?)\s*$/);
          const enManifiesto = val ? val[1].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '') : null;
          const enCompose2 = envCompose(n, v);
          comparadas++;
          A(enCompose2 !== undefined && enManifiesto === enCompose2,
            enCompose2 === undefined
              ? `${n}.${v}: está en el manifiesto y NO en el compose — no se puede comparar`
              : `${n}.${v} coincide con el compose (${String(enManifiesto).slice(0, 40)}…)`);
        }
      }
    }
    if (!comparadas) console.log('  ⓘ ningún manifiesto declara listas de tablas todavía');
  }


  console.log('\n5bis) ⛔ ¿Quién CONSTRUYE y PUBLICA lo que K3s consume?');
  // ⛔⛔ ESTA SECCIÓN EXISTE POR UNA CAÍDA DE 32 MINUTOS — 2026-10-01, 21:06 a 21:38.
  //
  // `caddy` migró al clúster y su manifiesto pasó a pedir `localhost:5000/trade-prod-caddy`
  // etiquetada por commit. Los DOS publicadores —`publicar_prod` de ops/prod/deploy.sh y el
  // bloque [K3S.24] de auto-deploy.sh— llevaban una lista A MANO de las cuatro apps, y nadie
  // la extendió. Cada despliegue le pedía al clúster una imagen que el registry no tenía.
  //
  // ⭐ Lo que lo volvió caída y no "despliegue fallido": `caddy` es `Recreate`. El pod viejo
  // muere ANTES de crear el nuevo. De los 9 deployments de prod, CINCO son `Recreate`.
  //
  // La regla: toda imagen propia que un manifiesto de prod consume tiene que tener un
  // Dockerfile declarado en auto-deploy.sh. Si no, el carril que despliega 7 veces al día no
  // sabe construirla — y publicar lo que no se construyó es imposible.
  const imgsProd = new Set();
  for (const f of archivos) {
    const txt = fs.readFileSync(path.join(DIR, f), 'utf8');
    if (!/^\s*namespace:\s*prod\s*$/m.test(txt)) continue;
    for (const m of txt.matchAll(/image:\s*localhost:5000\/([A-Za-z0-9._-]+):__COMMIT__/g)) {
      imgsProd.add(m[1]);
    }
  }
  const rutaAuto = path.join(__dirname, '..', 'ops', 'prod', 'auto-deploy.sh');
  const rutaAplicar = path.join(__dirname, '..', 'ops', 'prod', 'aplicar-k3s-prod.sh');
  /** ¿auto-deploy sabe construir esta imagen? O es una de las cuatro apps, o tiene Dockerfile. */
  const APPS = ['trade-prod-api', 'trade-prod-worker', 'trade-prod-portal', 'trade-prod-vendor'];
  // El mapa imagen -> Dockerfile de auto-deploy.sh tiene la forma  <imagen>) _df=<ruta>.
  // Se compara por LINEA y sin exigir el espaciado: la primera version pedia un espacio exacto
  // y dio un falso rojo sobre trade-prod-pg, que SI estaba mapeado pero alineado en columna.
  const sabeConstruir = (img, txt) => APPS.includes(img)
    || txt.split(String.fromCharCode(10)).some((l) => {
      const t = l.trim();
      return t.startsWith(img + ')') && t.includes('_df=');
    });

  if (!fs.existsSync(rutaAuto)) {
    NM('no encontré ops/prod/auto-deploy.sh para comprobar quién construye');
  } else if (imgsProd.size === 0) {
    NM('ningún manifiesto de prod consume imágenes del registry local (¿cambió la forma?)');
  } else {
    const txtAuto = fs.readFileSync(rutaAuto, 'utf8');
    const huerfanas = [...imgsProd].filter((i) => !sabeConstruir(i, txtAuto));
    A(huerfanas.length === 0,
      huerfanas.length === 0
        ? `las ${imgsProd.size} imágenes que prod consume tienen quién las construya: ${[...imgsProd].join(', ')}`
        : `NADIE LAS CONSTRUYE: ${huerfanas.join(', ')} — el pod las va a pedir y el registry no las va a tener`);
  }

  // ⭐ Y el freno de último recurso: que el prevuelo siga ahí. Un candado que comprueba listas
  // no sirve si mañana alguien quita la comprobación de registry ANTES del apply: aplicar el
  // manifiesto ya alcanza para matar al pod que estaba sirviendo.
  if (!fs.existsSync(rutaAplicar)) {
    NM('no encontré ops/prod/aplicar-k3s-prod.sh para comprobar el prevuelo');
  } else {
    const txtAp = fs.readFileSync(rutaAplicar, 'utf8');
    const iPrevuelo = txtAp.indexOf('/v2/');
    // ⚠️ Contra el apply REAL, no contra la mencion en un comentario: la cabecera del guion
    //    habla de 'kubectl apply -f ops/k3s/' y la primera version de esta regla la tomo por
    //    el comando, dando un rojo sobre un prevuelo que estaba bien puesto.
    const iApply = txtAp.indexOf('kubectl apply -f -');
    A(iPrevuelo > 0 && iApply > 0 && iPrevuelo < iApply,
      iPrevuelo < 0
        ? 'aplicar-k3s-prod.sh YA NO consulta el registry: volvió el defecto del 2026-10-01'
        : iPrevuelo > iApply
          ? 'el prevuelo quedó DESPUÉS del apply — comprobar después de matar al pod no sirve'
          : 'el prevuelo consulta el registry ANTES de aplicar nada');
  }

  console.log('\n6) Las reglas se rompen a propósito  ← negativas en memoria');
  const malo1 = ['kind: Deployment', 'name: x', 'singleton: "true"', 'replicas: 2', 'type: Recreate'];
  A(revisar(malo1, 'test').some(([c, m]) => !c && /replicas=1/.test(m)), 'replicas=2 se detecta');
  const malo2 = ['kind: Deployment', 'name: x', 'singleton: "true"', 'replicas: 1'];
  A(revisar(malo2, 'test').some(([c, m]) => !c && /RollingUpdate/.test(m)),
    'strategy AUSENTE se detecta (es el caso peligroso: nadie lo escribió mal, lo omitió)');
  const malo3 = ['kind: CronJob', 'name: y', 'concurrencyPolicy: Allow', 'backoffLimit: 0', 'timeZone: X'];
  A(revisar(malo3, 'test').some(([c, m]) => !c && /concurrencyPolicy/.test(m)), 'concurrencyPolicy=Allow se detecta');
  const malo4 = ['kind: CronJob', 'name: ods-reconcile-z', 'concurrencyPolicy: Forbid',
    'backoffLimit: 0', 'timeZone: X', 'livenessProbe:', 'ODS_RECONCILE_HB_KEY', '--apply'];
  A(revisar(malo4, 'test').some(([c, m]) => !c && /SIN livenessProbe/.test(m)),
    'un Job con livenessProbe se detecta (el footgun de los 505 reinicios)');
  // ⛔ [K3S.21] Las negativas de la regla de imagen. Sin ellas la regla sería una INTENCIÓN:
  // nació pasando limpia sobre los 12 manifiestos que yo mismo acababa de corregir, y ése es
  // justamente el caso que no prueba nada.
  const malo5 = ['kind: Deployment', 'name: x', 'singleton: "false"', 'replicas: 2',
    'image: localhost:5000/trade-prod-api:latest'];
  A(revisar(malo5, 'test').some(([c, m]) => !c && /etiquetada por commit/.test(m)),
    'una imagen propia con latest se detecta (el defecto que dejó a los pods 36 commits atrás)');
  const malo6 = ['kind: Deployment', 'name: x', 'singleton: "false"', 'replicas: 2',
    'image: trade-ingest:__COMMIT__'];
  A(revisar(malo6, 'test').some(([c, m]) => !c && /registry local/.test(m)),
    'una imagen propia SIN el registry se detecta — volvería al import a mano con sudo');
  // ⭐ El control que impide que la regla se vuelva ruido: lo público NO es nuestro.
  const publicas = ['kind: Deployment', 'name: x', 'singleton: "true"', 'replicas: 1',
    'type: Recreate', 'image: busybox:1.36', 'image: redis:7-alpine'];
  A(revisar(publicas, 'test').every(([c]) => c),
    'y NO marca a busybox ni redis: se jalan de Docker Hub y no las construimos nosotros');

  // ⛔ [K3S.41] Las negativas de la regla 5bis. Nacio en VERDE sobre los dos publicadores que
  // yo mismo acababa de corregir, que es exactamente el caso que no prueba nada — y de hecho
  // la primera version dio DOS falsos rojos (espaciado del mapa, y la mencion de kubectl apply
  // dentro de un comentario). Se rompe a proposito para ver el rojo.
  A(!sabeConstruir('trade-prod-nueva', 'trade-prod-caddy) _df=ops/prod/Dockerfile.caddy'),
    'una imagen que ningun Dockerfile construye se detecta (el defecto que tiro el sitio 32 min)');
  A(sabeConstruir('trade-prod-pg', '    trade-prod-pg)    _df=ops/prod/Dockerfile.pg ;;'),
    'y el mapa se reconoce aunque este alineado en columna — el falso rojo que dio esta regla');
  A(sabeConstruir('trade-prod-api', 'sin mapa alguno'),
    'y las cuatro apps no exigen mapa: salen del Dockerfile unificado por --target');

  const bueno = ['kind: Deployment', 'name: x', 'singleton: "true"', 'replicas: 1', 'type: Recreate'];
  A(revisar(bueno, 'test').every(([c]) => c), 'y NO marca de más: un manifiesto correcto pasa limpio');

  console.log(`\n=== ${ok} ✔ · ${fail} ✖ · ${nm} no medido ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
