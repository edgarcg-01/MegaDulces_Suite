// [E.23] Sesión psql persistente contra prod por el carril ssh → kubectl exec, SÓLO LECTURA.
// Correrlo solo ejecuta sus controles (valor conocido, error, recuperación, escritura rechazada):
//   node scripts/kepler/replay-cotizacion/psql-session.js
// `default_transaction_read_only = on` hace que cualquier escritura falle en el servidor.
const { spawn } = require('child_process');

const FIN = /(^|\n)__FIN__ (true|false) ?([^\n]*)\n/;

function abrir() {
  const remoto = 'export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; k3s kubectl -n prod exec -i deploy/pg-prod -- psql -U postgres -d railway -X -A -t -q';
  const p = spawn('ssh', ['-o', 'BatchMode=yes', 'superoot@192.168.0.222', remoto], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  let espera = null;
  // El fin de cada envío y si falló viajan en STDOUT (:ERROR / :LAST_ERROR_MESSAGE de psql):
  // stderr llega por otro canal, sin orden garantizado respecto de stdout.
  const revisar = () => {
    if (!espera) return;
    const m = FIN.exec(out);
    if (!m) return;
    const cuerpo = out.slice(0, m.index);
    out = out.slice(m.index + m[0].length);
    const r = espera;
    espera = null;
    if (m[2] === 'true') r.reject(new Error(m[3] || 'error sin mensaje'));
    else r.resolve(cuerpo.trim());
  };
  p.stdout.on('data', (b) => { out += b.toString('utf8'); revisar(); });
  p.stderr.on('data', (b) => { err = (err + b.toString('utf8')).slice(-4000); });
  p.on('exit', (c) => { if (espera) espera.reject(new Error('psql salió con ' + c + ': ' + err)); });
  let cola = Promise.resolve();
  const enviar = (texto) => {
    const t = cola.then(() => new Promise((resolve, reject) => {
      espera = { resolve, reject };
      p.stdin.write(texto + '\n\\echo __FIN__ :ERROR :LAST_ERROR_MESSAGE\n');
    }));
    cola = t.catch(() => undefined);
    return t;
  };
  const listo = enviar("SET default_transaction_read_only = on; SET statement_timeout = '60s'; SET application_name = 'replay-cotizacion-kepler';");
  return {
    listo,
    /** Corre un SELECT y devuelve sus filas como objetos (jsonb: números como número). */
    async filas(sql) {
      const r = await enviar('SELECT coalesce(jsonb_agg(to_jsonb(t)), \'[]\'::jsonb) FROM (' + sql + ') t;');
      return JSON.parse(r || '[]');
    },
    crudo(texto) { return enviar(texto); },
    cerrar() { p.stdin.end('\\q\n'); },
  };
}
module.exports = { abrir };

if (require.main === module) {
  (async () => {
    const s = abrir();
    await s.listo;
    console.log('CONTROL 1 (debe dar [{"x":1}]):', JSON.stringify(await s.filas('select 1 as x')));
    const t0 = Date.now();
    console.log('CONTROL 2 (89008 en 01, lista 55.93):', JSON.stringify(await s.filas("select sku, piece_price, unit_base from analytics.v_label_prices where sucursal='01' and sku='89008'")), Date.now() - t0, 'ms');
    try { await s.filas('select 1 from tabla_que_no_existe'); console.log('NEGATIVO FALLÓ: no lanzó'); } catch (e) { console.log('NEGATIVO ok, lanzó:', e.message); }
    console.log('CONTROL 3 tras error (debe dar [{"y":2}]):', JSON.stringify(await s.filas('select 2 as y')));
    try { await s.crudo('create temp table zz(a int);'); console.log('ESCRITURA NO RECHAZADA'); } catch (e) { console.log('ESCRITURA rechazada:', e.message); }
    s.cerrar();
  })().catch((e) => { console.error(e); process.exit(1); });
}
