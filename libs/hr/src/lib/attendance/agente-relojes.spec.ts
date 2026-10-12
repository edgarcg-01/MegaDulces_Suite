/**
 * `[RH.1.3]` El lector de relojes (`database/importers/checadores/agente/`) y su manifiesto de k3s no se
 * desfasan entre sí ni con la entrada compatible de la API. Prueba PURA (sin base, sin relojes): corre en CI.
 *
 * Lo que defiende: que el pod nunca nazca encendido junto al agente de la laptop (un ZKTeco acepta UNA
 * sesión), que lea la configuración que el manifiesto le da, y que las rutas que pide existan en la API.
 */
import fs from 'fs';
import path from 'path';

const RAIZ = path.resolve(__dirname, '../../../../..');
const AGENTE = path.join(RAIZ, 'database/importers/checadores/agente');
const MANIFIESTO = fs.readFileSync(path.join(RAIZ, 'ops/k3s/29-hr-relojes.deployment.yaml'), 'utf8');
const { configDelEntorno } = require(path.join(AGENTE, 'config.js'));

describe('[RH.1.3] lector de relojes — configuración', () => {
  const base = { HR_AGENT_API_URL: 'http://api:10000/api/hr/attendance/ingest/mt/', HR_INGEST_KEY: 'k', HR_AGENT_DATA_DIR: '/datos' };

  it('toma del entorno la API (sin la diagonal final), la llave y el directorio de datos', () => {
    const c = configDelEntorno(base);
    expect([c.apiUrl, c.token, c.colaDb.replace(/\\/g, '/'), c.padronJson.replace(/\\/g, '/')])
      .toEqual(['http://api:10000/api/hr/attendance/ingest/mt', 'k', '/datos/cola.db', '/datos/padron.json']);
    expect(c.intervalos).toMatchObject({ backfillMin: 60, padronMin: 30, vigilanciaMin: 30 });
  });

  it('acota por sitio y por series cuando se piden', () => {
    const c = configDelEntorno({ ...base, HR_AGENT_SITE: 'cedis', HR_AGENT_SERIES: ' A1, B2 ,' });
    expect([c.sucursalId, c.relojes]).toEqual(['cedis', ['A1', 'B2']]);
  });

  it('⛔ NEGATIVA — sin API o sin llave no arranca, y dice qué falta', () => {
    expect(() => configDelEntorno({ HR_INGEST_KEY: 'k' })).toThrow(/HR_AGENT_API_URL/);
    expect(() => configDelEntorno({ HR_AGENT_API_URL: 'http://x' })).toThrow(/HR_INGEST_KEY/);
    expect(() => configDelEntorno({ ...base, HR_AGENT_API_URL: 'api:10000' })).toThrow(/http/);
  });

  it('un intervalo inválido cae a su valor por omisión, no a cero', () => {
    expect(configDelEntorno({ ...base, HR_AGENT_BACKFILL_MIN: '0' }).intervalos.backfillMin).toBe(60);
    expect(configDelEntorno({ ...base, HR_AGENT_BACKFILL_MIN: 'x' }).intervalos.backfillMin).toBe(60);
    expect(configDelEntorno({ ...base, HR_AGENT_BACKFILL_MIN: '90' }).intervalos.backfillMin).toBe(90);
  });
});

describe('[RH.1.3] lector de relojes — manifiesto, agente y API alineados', () => {
  it('⛔ nace FUERA del despliegue: preparado-externo (el deploy saltea «migracion: preparado»), singleton y Recreate', () => {
    expect(MANIFIESTO).toMatch(/^\s+migracion: preparado-externo$/m);
    expect(MANIFIESTO.includes('migracion: preparado')).toBe(true);   // la subcadena que busca ops/vl/deploy.sh
    expect(MANIFIESTO).toMatch(/^\s+singleton: "true"$/m);
    expect(MANIFIESTO).toMatch(/strategy:\s*\n\s+type: Recreate/);
    expect(MANIFIESTO).toMatch(/^\s+replicas: 1$/m);
  });

  it('le da al agente justo las variables que lee, y la llave sale de un secreto', () => {
    expect(MANIFIESTO).toContain('name: HR_AGENT_API_URL');
    expect(MANIFIESTO).toContain('name: HR_AGENT_DATA_DIR');
    expect(MANIFIESTO).toMatch(/secretRef:\s*\n\s+name: hr-relojes-env/);
    expect(MANIFIESTO).not.toMatch(/HR_INGEST_KEY\s*\n\s+value:/);   // nunca en el YAML
    const dir = /name: HR_AGENT_DATA_DIR\s*\n\s+value: (\S+)/.exec(MANIFIESTO)?.[1];
    expect(MANIFIESTO).toContain(`mountPath: ${dir}`);               // la cola vive en el volumen
    expect(MANIFIESTO).toContain('node database/importers/checadores/agente/index.js');
  });

  it('las rutas que pide el agente existen en la entrada compatible de la API', () => {
    const url = /name: HR_AGENT_API_URL\s*\n\s+value: (\S+)/.exec(MANIFIESTO)?.[1] ?? '';
    const prefijo = url.replace(/^https?:\/\/[^/]+\/api\//, '');      // hr/attendance/ingest/mt
    const controlador = fs.readFileSync(path.join(RAIZ, 'libs/hr/src/lib/attendance/attendance-ingest.controller.ts'), 'utf8');
    const compat = /@Controller\('([^']*\/mt\/checador\/ingesta)'\)/.exec(controlador)?.[1];
    expect(compat).toBe(`${prefijo}/checador/ingesta`);
    const enviar = fs.readFileSync(path.join(AGENTE, 'enviar.js'), 'utf8');
    for (const r of ["'/checador/ingesta'", '/checador/ingesta/relojes', "'/checador/ingesta/latido'", '/checador/ingesta/comandos']) {
      expect(enviar).toContain(r);
    }
    for (const ruta of ["@Post()", "@Post('latido')", "@Get('relojes')", "@Get('comandos')", "@Post('comandos/:id')"]) {
      expect(controlador).toContain(ruta);
    }
  });

  it('⛔ sin el origen «hr» ni el servicio de Windows, y con las dependencias fijadas en la imagen', () => {
    const archivos = fs.readdirSync(AGENTE);
    expect(archivos).not.toContain('origen-hr.js');
    expect(archivos).not.toContain('instalar-servicio.js');
    const todo = archivos.filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(AGENTE, f), 'utf8')).join('\n');
    expect(todo).not.toMatch(/require\(['"](\.\/origen-hr|node-windows|pg)['"]\)/);
    const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'ops/ingest/package.json'), 'utf8'));
    expect(pkg.dependencies['node-zklib']).toBe('1.3.0');
    expect(pkg.dependencies['better-sqlite3']).toBe('11.10.0');
  });
});
