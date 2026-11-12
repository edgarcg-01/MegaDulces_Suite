/**
 * `[OPS.ING.1]` La ingesta (y el lector de relojes en ella) se despliega DESDE md, detrás del vigía, con imágenes que
 * construye el CI — ya no desde una laptop. Prueba sin base ni clúster: corre en CI (necesita `sh` y `git`).
 *
 * Lo que defiende:
 *  1. La etiqueta es el hash de lo que la imagen COPIA: cambiar el lector mueve SÓLO `trade-relojes`; cambiar un
 *     importer del ODS mueve SÓLO `trade-ingest`. Si no, un despliegue le cortaría la sesión a los relojes por un
 *     cambio ajeno (o reiniciaría el ODS por uno del lector).
 *  2. ⛔ `desplegar-ingesta.sh` NO despliega un commit que la API no sirve, y sin el testigo de la API no hace nada.
 *  3. CI, manifiestos, el vigía y el guion nombran las mismas imágenes.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const RAIZ = path.resolve(__dirname, '../../../../..');
const leer = (rel: string) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const ETIQUETA = path.join(RAIZ, 'ops/prod/etiqueta-imagen.sh');
const DESPLEGAR = path.join(RAIZ, 'ops/prod/desplegar-ingesta.sh');
const DOCKERFILES = { 'trade-ingest': 'ops/ingest/Dockerfile', 'trade-relojes': 'ops/relojes/Dockerfile' } as const;

function correr(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
  if (r.error) throw r.error;
  return r;
}
const git = (cwd: string, ...args: string[]) => {
  const r = correr('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...args], cwd);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** Un repo de juguete con los Dockerfiles REALES y un archivo por cada fuente que copian. */
function repoDeJuguete() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etiqueta-'));
  const escribir = (rel: string, txt: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), txt);
  };
  for (const df of Object.values(DOCKERFILES)) {
    const texto = leer(df);
    escribir(df, texto);
    for (const linea of texto.split(/\r?\n/)) {
      const m = /^COPY\s+(.*)$/.exec(linea);
      if (!m || /--from/.test(linea)) continue;
      const args = m[1].split(/\s+/).filter((a) => a && !a.startsWith('--'));
      for (const fuente of args.slice(0, -1)) {
        // Un archivo (tiene extensión o es package.json) se escribe tal cual; un directorio lleva un archivo adentro.
        if (/\.[a-z]+$/i.test(path.basename(fuente)) || /crontab\./.test(fuente)) escribir(fuente, `// ${fuente}\n`);
        else escribir(`${fuente}/x.js`, `// ${fuente}\n`);
      }
    }
  }
  escribir('database/importers/kepler/replicate-ods-live.js', '// ods\n');
  escribir('database/importers/checadores/zk-client.js', '// utilidad vieja\n');
  escribir('database/importers/checadores/agente/reloj.js', '// lector v1\n');
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  return { dir, escribir };
}
function etiquetas(dir: string) {
  const out: Record<string, string> = {};
  for (const [img, df] of Object.entries(DOCKERFILES)) {
    const r = correr('sh', [ETIQUETA, df, 'HEAD'], dir);
    if (r.status !== 0) throw new Error(`etiqueta de ${img}: ${r.stderr}`);
    out[img] = r.stdout.trim();
  }
  return out;
}

describe('[OPS.ING.1] etiqueta por contenido — el lector y el ODS no se reinician entre sí', () => {
  let repo: ReturnType<typeof repoDeJuguete>;
  let base: Record<string, string>;
  beforeAll(() => { repo = repoDeJuguete(); base = etiquetas(repo.dir); });
  afterAll(() => fs.rmSync(repo.dir, { recursive: true, force: true }));
  const cambiar = (rel: string, txt: string) => { repo.escribir(rel, txt); git(repo.dir, 'commit', '-qam', rel); };

  it('tiene la forma e-<12 hex> y es determinista', () => {
    expect(base['trade-ingest']).toMatch(/^e-[0-9a-f]{12}$/);
    expect(base['trade-relojes']).toMatch(/^e-[0-9a-f]{12}$/);
    expect(etiquetas(repo.dir)).toEqual(base);
  });

  it('⛔ cambiar el lector mueve SÓLO trade-relojes', () => {
    cambiar('database/importers/checadores/agente/reloj.js', '// lector v2\n');
    const t = etiquetas(repo.dir);
    expect(t['trade-relojes']).not.toBe(base['trade-relojes']);
    expect(t['trade-ingest']).toBe(base['trade-ingest']);
    base = t;
  });

  it('⛔ cambiar un importer del ODS mueve SÓLO trade-ingest', () => {
    cambiar('database/importers/kepler/replicate-ods-live.js', '// ods v2\n');
    const t = etiquetas(repo.dir);
    expect(t['trade-ingest']).not.toBe(base['trade-ingest']);
    expect(t['trade-relojes']).toBe(base['trade-relojes']);
    base = t;
  });

  it('lo que ninguna imagen copia (checadores fuera del agente) no mueve ninguna', () => {
    cambiar('database/importers/checadores/zk-client.js', '// utilidad v2\n');
    expect(etiquetas(repo.dir)).toEqual(base);
  });

  it('cambiar el Dockerfile mueve su etiqueta', () => {
    cambiar('ops/relojes/Dockerfile', `${leer('ops/relojes/Dockerfile')}# otro\n`);
    expect(etiquetas(repo.dir)['trade-relojes']).not.toBe(base['trade-relojes']);
  });

  it('⛔ una entrada que falta FALLA en vez de inventar una etiqueta', () => {
    fs.rmSync(path.join(repo.dir, 'database/importers/checadores/agente'), { recursive: true, force: true });
    git(repo.dir, 'add', '-A');
    git(repo.dir, 'commit', '-qm', 'sin agente');
    const r = correr('sh', [ETIQUETA, DOCKERFILES['trade-relojes'], 'HEAD'], repo.dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/falta la entrada database\/importers\/checadores\/agente/);
  });
});

describe('[OPS.ING.1] desplegar-ingesta.sh — sólo el commit que sirve la API', () => {
  let stubs: string;
  let marcas: string;
  const HEAD9 = git(RAIZ, 'rev-parse', 'HEAD').slice(0, 9);

  beforeAll(() => {
    stubs = fs.mkdtempSync(path.join(os.tmpdir(), 'stubs-'));
    marcas = path.join(stubs, 'llamadas.txt');
    const stub = (nombre: string, cuerpo: string) => {
      fs.writeFileSync(path.join(stubs, nombre), `#!/bin/sh\n${cuerpo}\n`);
      fs.chmodSync(path.join(stubs, nombre), 0o755);
    };
    // curl: la API contesta lo que diga SIRVE; el registro "tiene" todo.
    stub('curl', `case "$*" in *health*) [ -n "$SIRVE" ] && printf '{"status":"ok","commit":"%s"}' "$SIRVE" || exit 7 ;; *) exit 0 ;; esac`);
    stub('docker', `echo "docker $*" >> "${marcas}"`);
    stub('k3s', `echo "k3s $*" >> "${marcas}"`);
  });
  afterAll(() => fs.rmSync(stubs, { recursive: true, force: true }));

  const desplegar = (args: string[], sirve: string) => {
    if (fs.existsSync(marcas)) fs.rmSync(marcas);
    const env = { ...process.env, PATH: `${stubs}${path.delimiter}${process.env.PATH}`, SIRVE: sirve,
      HOME: stubs, AUTO_DEPLOY_IMAGENES: 'ghcr' };
    const r = correr('sh', [DESPLEGAR, ...args], RAIZ, env);
    const llamadas = fs.existsSync(marcas) ? fs.readFileSync(marcas, 'utf8') : '';
    return { ...r, llamadas };
  };

  it('⛔ la API sirve OTRO commit: se niega y no toca ni docker ni el clúster', () => {
    const r = desplegar([], 'aaaaaaaaa');
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/la API sirve aaaaaaaaa/);
    expect(r.llamadas).toBe('');
  });

  it('⛔ sin el testigo de la API (no contesta) tampoco hace nada', () => {
    const r = desplegar([], '');
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/sin ese testigo NO se despliega/);
    expect(r.llamadas).toBe('');
  });

  it('⛔ piden un commit distinto del checkout: se niega', () => {
    const r = desplegar(['bbbbbbbbb'], HEAD9);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/piden bbbbbbbbb/);
    expect(r.llamadas).toBe('');
  });

  it('control: con la API en este commit, aplica los manifiestos de ingesta con etiqueta por contenido', () => {
    const r = desplegar([HEAD9], HEAD9);
    expect(r.stdout).not.toMatch(/FALLO/);
    expect(r.status).toBe(0);
    expect(r.llamadas).toMatch(/k3s kubectl apply -f -/);
    expect(r.llamadas).not.toMatch(/^docker (pull|build)/m);   // el registro "ya las tiene": no se trae nada
  });
});

describe('[OPS.ING.1] CI, manifiestos, vigía y guion nombran lo mismo', () => {
  const k3s = fs.readdirSync(path.join(RAIZ, 'ops/k3s')).filter((f) => f.endsWith('.yaml'));
  const ingesta = k3s.map((f) => leer(`ops/k3s/${f}`)).filter((t) => /namespace: ingesta/.test(t));
  const piden = new Set(ingesta.flatMap((t) => [...t.matchAll(/image:\s*localhost:5000\/([A-Za-z0-9._-]+):__COMMIT__/g)].map((m) => m[1])));

  it('los manifiestos de ingesta piden exactamente trade-ingest y trade-relojes; el lector, la suya', () => {
    expect([...piden].sort()).toEqual(['trade-ingest', 'trade-relojes']);
    expect(leer('ops/k3s/29-hr-relojes.deployment.yaml')).toContain('image: localhost:5000/trade-relojes:__COMMIT__');
  });

  it('cada imagen tiene Dockerfile en el guion y se construye en el CI', () => {
    const guion = leer('ops/prod/desplegar-ingesta.sh');
    const ci = leer('.github/workflows/imagenes.yml');
    for (const img of piden) {
      const df = DOCKERFILES[img as keyof typeof DOCKERFILES];
      expect(guion).toMatch(new RegExp(`${img}\\)\\s+echo ${df.replace(/\//g, '\\/')}`));
      expect(ci).toMatch(new RegExp(`imagen: ${img}\\s*\\n\\s*dockerfile: ${df.replace(/\//g, '\\/')}`));
    }
    expect(ci).toContain('org.opencontainers.image.revision=${{ steps.sello.outputs.sha }}');   // md la verifica
  });

  it('⛔ el lector fuera de trade-ingest, y su imagen sólo con el agente y sus dos dependencias', () => {
    expect(leer('ops/ingest/Dockerfile')).toMatch(/^RUN rm -rf \.\/database\/importers\/checadores$/m);
    expect(leer('ops/relojes/Dockerfile')).toMatch(/^COPY database\/importers\/checadores\/agente /m);
    const deps = JSON.parse(leer('ops/relojes/package.json')).dependencies;
    expect(deps).toEqual({ 'node-zklib': '1.3.0', 'better-sqlite3': '11.10.0' });
    const ing = JSON.parse(leer('ops/ingest/package.json')).dependencies;
    expect(ing['node-zklib']).toBeUndefined();
  });

  it('⛔ el vigía despliega la ingesta en sus dos salidas, y no trata sus imágenes como de prod', () => {
    const auto = leer('ops/prod/auto-deploy.sh');
    expect(auto.match(/^\s*(\[ "\$SECO" = 1 \] \|\| )?desplegar_ingesta$/gm)?.length).toBe(2);
    expect(auto).toMatch(/_mf_prod=\$\(grep -l 'namespace: prod'/);
    expect(auto).not.toMatch(/grep -v '\^trade-ingest\$'/);
  });

  it('⛔ la laptop ya no construye la ingesta: deploy.sh sólo le pide a md', () => {
    const vl = leer('ops/vl/deploy.sh');
    expect(vl).toMatch(/--k3s\|--todo\)\s+pedir_a_md ;;/);
    expect(vl).not.toMatch(/^\s+--k3s\)\s+verificar_limpio; construir/m);
  });
});
