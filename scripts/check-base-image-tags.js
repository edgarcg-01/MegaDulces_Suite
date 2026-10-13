#!/usr/bin/env node
/**
 * `[DEPLOY.2]` — LAS IMÁGENES QUE NO LLEVAN CÓDIGO DE LA APP NO SE ETIQUETAN CON EL COMMIT.
 *
 * ── POR QUÉ EXISTE ESTO, MEDIDO EN PROD EL 2026-10-13 ─────────────────────────────────
 *
 * `52-pg-prod.deployment.yaml` y `44-caddy.deployment.yaml` pedían
 * `localhost:5000/trade-prod-{pg,caddy}:__COMMIT__`. El aplicador hace
 * `sed s/__COMMIT__/$COMMIT/g` sobre CADA manifiesto, así que en cada despliegue esas dos
 * imágenes cambiaban de tag → cambiaba la plantilla del Pod → y las dos son
 * `replicas: 1` + `Recreate`, o sea: **se mata la única y después se levanta otra**.
 *
 * Resultado medido: cada despliegue reiniciaba la BASE DE DATOS y la PUERTA DE ENTRADA.
 *
 *   · `pg-prod` y `caddy` tenían 11 ReplicaSets, uno por despliegue, con las horas
 *     coincidiendo una a una con el log de `auto-deploy`.
 *   · El respaldo del 12-oct murió con `FATAL: terminating connection due to administrator
 *     command` **5 segundos** después de que un despliegue recreara Postgres.
 *   · `pg_postmaster_start_time()` seguía al minuto de cada despliegue.
 *
 * ⭐ Y el control que prueba que era evitable: `redis`, en el mismo clúster y con la misma
 * estrategia `Recreate`, lleva **1 solo ReplicaSet en 5 días** — porque su manifiesto NO
 * lleva `__COMMIT__`.
 *
 * ── QUÉ COMPRUEBA ─────────────────────────────────────────────────────────────────────
 *
 * Que el tag escrito en el manifiesto siga siendo el hash de las entradas REALES de esa
 * imagen. Si alguien toca `Dockerfile.pg` o `pgbackrest.conf` y no bumpea el tag, el
 * despliegue seguiría sirviendo la imagen vieja **sin un solo error** — que es justo la
 * falla silenciosa que un tag fijo introduce si nadie la vigila.
 *
 * ⚠️ El hash cubre SÓLO lo que la imagen copia del repo. Se verificó leyendo cada
 * Dockerfile: `caddy` no copia NINGÚN archivo del repo (es `FROM caddy:2` + el binario que
 * compila su propia etapa builder), así que su única entrada es el Dockerfile.
 *
 * ⛔ Lo que esto NO cubre, y se declara: un cambio en la imagen BASE de upstream
 * (`pgvector/pgvector:pg18`, `caddy:2`) no mueve el hash. Son tags móviles de terceros;
 * fijarlos por digest es otra decisión, aparte de ésta.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const RAIZ = path.resolve(__dirname, '..');

/**
 * Imagen → los archivos del repo que entran en ella.
 * Derivado de leer `FROM`/`COPY` de cada Dockerfile, no de suponerlo.
 */
const BASES = {
  'trade-prod-pg': ['ops/prod/Dockerfile.pg', 'ops/prod/pgbackrest.conf'],
  'trade-prod-caddy': ['ops/prod/Dockerfile.caddy'],
  'trade-prod-backup': [
    'ops/prod/Dockerfile.backup',
    'ops/prod/backup-prod.sh',
    'ops/prod/pgbackrest-run.sh',
    'ops/prod/pgbackrest.conf',
    'ops/prod/crontab.backup',
  ],
};

/** El tag estable de una imagen base: 12 hex del sha256 de sus entradas, en orden. */
function tagDe(imagen, raiz = RAIZ) {
  const entradas = BASES[imagen];
  if (!entradas) throw new Error(`imagen base desconocida: ${imagen}`);
  const h = crypto.createHash('sha256');
  for (const rel of entradas) {
    const abs = path.join(raiz, rel);
    if (!fs.existsSync(abs)) throw new Error(`falta una entrada de ${imagen}: ${rel}`);
    // Se normaliza CRLF→LF: el repo se clona en Windows y en Linux, y el tag tiene que
    // ser el MISMO en los dos o el despliegue reconstruiría por el final de línea.
    const bytes = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
    h.update(rel).update('\0').update(bytes).update('\0');
  }
  return `base-${h.digest('hex').slice(0, 12)}`;
}

/** Lee de un manifiesto las imágenes `localhost:5000/<img>:<tag>` que declara. */
function imagenesDe(texto) {
  const out = [];
  const re = /^[ \t]*image:[ \t]*localhost:5000\/([A-Za-z0-9._-]+):([A-Za-z0-9._-]+)/gm;
  let m;
  while ((m = re.exec(texto)) !== null) out.push({ imagen: m[1], tag: m[2] });
  return out;
}

let OK = 0;
let MAL = 0;
function af(cond, msg) {
  if (cond) { OK++; console.log(`  ✔ ${msg}`); } else { MAL++; console.log(`  ✖ ${msg}`); }
}

/**
 * Pruebas del propio candado, con las NEGATIVAS primero.
 *
 * Un candado sin prueba negativa es una intención: si `tagDe` devolviera una constante, todo
 * seguiría en verde para siempre y nadie se enteraría de que dejó de vigilar.
 */
function pruebas() {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'basetag-'));
  const escribir = (rel, txt) => {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, txt);
  };

  escribir('ops/prod/Dockerfile.pg', 'FROM pgvector/pgvector:pg18\n');
  escribir('ops/prod/pgbackrest.conf', '[global]\nrepo1-path=/var/lib/pgbackrest\n');
  const t1 = tagDe('trade-prod-pg', tmp);

  af(/^base-[0-9a-f]{12}$/.test(t1), 'el tag tiene la forma base-<12 hex>');
  af(tagDe('trade-prod-pg', tmp) === t1, 'es determinista: dos corridas dan el mismo tag');

  // ⛔ LA NEGATIVA QUE IMPORTA: si cambia una entrada, el tag TIENE que moverse. Sin esto el
  // candado sería decorativo y prod serviría la imagen vieja en silencio.
  escribir('ops/prod/pgbackrest.conf', '[global]\nrepo1-path=/otro/lado\n');
  af(tagDe('trade-prod-pg', tmp) !== t1, 'cambiar pgbackrest.conf MUEVE el tag');

  escribir('ops/prod/pgbackrest.conf', '[global]\nrepo1-path=/var/lib/pgbackrest\n');
  af(tagDe('trade-prod-pg', tmp) === t1, 'y volver atrás devuelve el tag original');

  escribir('ops/prod/Dockerfile.pg', 'FROM pgvector/pgvector:pg18\nRUN echo hola\n');
  af(tagDe('trade-prod-pg', tmp) !== t1, 'cambiar el Dockerfile también MUEVE el tag');

  // El repo se clona en Windows y en Linux: si el final de línea moviera el tag, el despliegue
  // reconstruiría la base de datos según en qué máquina se corriera el candado.
  escribir('ops/prod/Dockerfile.pg', 'FROM pgvector/pgvector:pg18\r\nRUN echo hola\r\n');
  const tCRLF = tagDe('trade-prod-pg', tmp);
  escribir('ops/prod/Dockerfile.pg', 'FROM pgvector/pgvector:pg18\nRUN echo hola\n');
  af(tagDe('trade-prod-pg', tmp) === tCRLF, 'CRLF y LF dan el MISMO tag');

  // Un archivo ausente se DECLARA, no se hashea como vacío: hashear la ausencia daría un tag
  // estable y falso justo cuando falta una entrada.
  fs.rmSync(path.join(tmp, 'ops/prod/pgbackrest.conf'));
  let tiro = false;
  try { tagDe('trade-prod-pg', tmp); } catch { tiro = true; }
  af(tiro, 'si falta una entrada, falla en vez de inventar un tag');

  // El parser: un tag MENCIONADO EN UN COMENTARIO no cuenta — el comentario no levanta un pod.
  const conComentario = [
    '          # image: localhost:5000/trade-prod-pg:base-000000000000',
    '          image: localhost:5000/trade-prod-pg:base-abcdef123456',
  ].join('\n');
  const halladas = imagenesDe(conComentario);
  af(halladas.length === 1 && halladas[0].tag === 'base-abcdef123456',
    'el parser ignora la imagen comentada y toma la real');

  af(imagenesDe('    image: localhost:5000/trade-prod-api:__COMMIT__')[0].tag === '__COMMIT__',
    'y sí ve las que siguen con __COMMIT__ (las que SÍ llevan código)');

  fs.rmSync(tmp, { recursive: true, force: true });
}

function revisar() {
  const dir = path.join(RAIZ, 'ops/k3s');
  const fallas = [];
  const vistas = [];

  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.yaml'))) {
    const texto = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const { imagen, tag } of imagenesDe(texto)) {
      if (!BASES[imagen]) continue; // no es una imagen base: lleva código, va con __COMMIT__
      vistas.push({ f, imagen, tag });

      if (tag === '__COMMIT__') {
        fallas.push(
          `${f} · ${imagen} sigue con :__COMMIT__ — se recrea en CADA despliegue, y no lleva `
            + `código de la app. Poné :${tagDe(imagen)}`,
        );
        continue;
      }
      const esperado = tagDe(imagen);
      if (tag !== esperado) {
        fallas.push(
          `${f} · ${imagen} dice :${tag} y sus entradas hashean :${esperado} — `
            + `cambió ${BASES[imagen].join(', ')} y nadie bumpeó el tag. `
            + `Sin esto prod seguiría sirviendo la imagen VIEJA sin ningún error.`,
        );
      }
    }
  }

  for (const { f, imagen, tag } of vistas) {
    const rota = fallas.some((x) => x.startsWith(`${f} · ${imagen} `));
    af(!rota, rota ? `${f} · ${imagen}` : `${f} · ${imagen}:${tag}`);
  }
  for (const f of fallas) console.log(`     ↳ ${f}`);

  // ⛔ Cero manifiestos no es "todo bien": es que el candado dejó de encontrar lo que vigila
  // (alguien renombró un archivo, cambió el formato del `image:`). Se DECLARA, no se aprueba.
  if (!vistas.length) {
    console.log('  ⚠️ NO MEDIDO: ningún manifiesto declara una imagen base conocida.');
    MAL++;
  }
}

module.exports = { tagDe, imagenesDe, BASES };

if (require.main === module) {
  pruebas();
  revisar();
  console.log(`\n=== ${OK} ✔ · ${MAL} ✖ ===`);
  process.exit(MAL ? 1 : 0);
}
