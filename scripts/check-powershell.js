#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `npm run check:powershell` — un `.ps1` que NO COMPILA no llega a producción.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * El 2026-09-22 se midió que el respaldo diario de prod llevaba **12 días sin producir un solo
 * archivo**. No estaba deshabilitado ni fallaba a mitad: `scripts/backup-db.ps1` tenía un
 * ParserError en la línea 233 —`"…el piso es $MinTables: no parece prod"`, donde los dos puntos
 * pegados al nombre hacen que PowerShell lea la variable como CALIFICADA POR UNIDAD (`$env:X`)—
 * y un ParserError **no falla esa línea: hace que el archivo entero no compile**. El script no
 * ejecutaba ni su primera instrucción.
 *
 * Tres propiedades lo volvieron invisible, y ninguna es exótica:
 *   1. El Programador de Windows reportaba `LastTaskResult = 1` y `NumberOfMissedRuns = 0`:
 *      desde ahí se lee "la tarea corre", que era cierto, y no "el respaldo existe".
 *   2. El único latido `backup_prod` que llegó a escribirse lo puso la **prueba de
 *      instrumentación** del sprint que introdujo el bug — un `ok` que quedó 11 días en verde.
 *   3. `db-health` SÍ tenía el umbral bien puesto (`warnH 26 / critH 50`) y la alarma estaba en
 *      crítico desde el 13-sep. Lo que no existe es el canal: `WATCHDOG_WEBHOOK_URL` nunca se
 *      configuró y el propio watchdog lo declara — `canal externo: NINGUNO`.
 *
 * O sea: la detección funcionó y el aviso no salió del edificio. Esta compuerta ataca el eslabón
 * ANTERIOR — que el archivo roto ni siquiera pueda llegar —, que es el único de los cuatro que
 * se puede cerrar sin comprar ni configurar nada.
 *
 * ⛔ No es un caso aislado: 26 `.ps1` versionados, y varios corren **desatendidos en cajas de
 * sucursal** (`wincaja-store-agent.ps1`, `deploy-wincaja-agent.ps1`). Ahí un ParserError es
 * exactamente el mismo modo de falla, sin nadie mirando la pantalla.
 *
 * ── Qué comprueba, y qué NO ─────────────────────────────────────────────────────────────────
 * Comprueba SINTAXIS (que el archivo compile), no comportamiento. Es barato y atrapa la clase
 * entera de fallas "el script no arrancó". Un `.ps1` que parsea igual puede estar mal.
 *
 * ── Los tres códigos de salida ──────────────────────────────────────────────────────────────
 *   0  todos parsean
 *   1  alguno NO parsea (o la prueba negativa no atrapó el defecto que debía atrapar)
 *   2  NO MEDIDO — no hay PowerShell en esta máquina
 *
 * El 2 existe por ADR-056: lo que no se pudo medir se DECLARA, nunca se dibuja como verde. Para
 * `check-all.js` cualquier cosa distinta de 0 es rojo, que es lo correcto — una compuerta que no
 * corrió no es una compuerta que pasó.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sh = (cmd, args, opts) =>
  spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26, ...opts });

/** `pwsh` (7+, multiplataforma) antes que `powershell` (5.1, sólo Windows). Los dos sirven. */
function buscarPowerShell() {
  for (const exe of ['pwsh', 'powershell']) {
    const r = sh(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major']);
    if (r.status === 0 && /^\d+/.test((r.stdout || '').trim())) {
      return { exe, version: (r.stdout || '').trim().split(/\r?\n/)[0] };
    }
  }
  return null;
}

/**
 * Parsea N archivos en UNA sola invocación. Arrancar PowerShell cuesta ~1 s, así que un proceso
 * por archivo convertiría una compuerta de segundos en una de medio minuto — y una compuerta
 * lenta se termina salteando.
 *
 * ⚠️ Las rutas viajan por stdin, NO como argumentos: una ruta con espacios o comillas dentro de
 * un `-Command` es una inyección esperando a pasar, y este repo tiene rutas con espacios.
 */
function parsear(ps, archivos) {
  // `script` se define antes de usarse en el spawn de abajo.
  const script = `
    $ErrorActionPreference = 'Stop'
    $salida = @()
    foreach ($linea in $input) {
      $ruta = $linea.Trim()
      if (-not $ruta) { continue }
      $errs = $null; $tok = $null
      try {
        [void][System.Management.Automation.Language.Parser]::ParseFile($ruta, [ref]$tok, [ref]$errs)
      } catch {
        $salida += "ERR|$ruta|0|no se pudo leer: $($_.Exception.Message)"
        continue
      }
      if ($errs -and $errs.Count -gt 0) {
        foreach ($e in $errs) {
          $msg = ($e.Message -replace '[\\r\\n]+', ' ')
          $salida += "ERR|$ruta|$($e.Extent.StartLineNumber)|$msg"
        }
      } else {
        $salida += "OK|$ruta|0|"
      }
    }
    $salida -join "\`n"
  `;
  // ⛔ El script va como ARGUMENTO de `-Command` y las rutas por stdin (`$input`).
  // `-Command -` significa "leé el COMANDO de stdin", que es otra cosa: con esa forma
  // PowerShell tomaba cada ruta como si fuera una instrucción y devolvía cero veredictos —
  // o sea, la compuerta habría salido VERDE sobre 26 archivos sin mirar ninguno.
  // Lo atrapó la prueba negativa de abajo en la primera corrida, que es para lo que está.
  const r = sh(ps.exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: archivos.join('\n'),
  });
  const filas = `${r.stdout || ''}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('OK|') || l.startsWith('ERR|'))
    .map((l) => {
      const [tipo, ruta, linea, ...resto] = l.split('|');
      return { tipo, ruta, linea: Number(linea) || 0, msg: resto.join('|') };
    });
  return { filas, crudo: `${r.stdout || ''}${r.stderr || ''}`, status: r.status, script };
}

// Para que `parsear` pueda reusar el script sin duplicarlo, lo invocamos igual en los dos casos.
function correr(ps, archivos) {
  return parsear(ps, archivos);
}

/**
 * ⭐ PRUEBA NEGATIVA. Una compuerta sin prueba negativa es una intención: si `parsear` devolviera
 * siempre vacío —porque cambió el nombre del tipo, porque `$input` dejó de llegar, porque la
 * salida se serializa distinto— esta compuerta se pondría VERDE sobre 26 archivos rotos y se
 * leería igual que "no hay problemas".
 *
 * Así que antes de juzgar nada, se le da de comer el defecto EXACTO que motivó el gate y se
 * exige que lo encuentre. Si no lo encuentra, el gate se declara roto — no verde.
 */
function pruebaNegativa(ps) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chk-ps-'));
  const cebo = path.join(dir, 'cebo-parser-error.ps1');
  // El mismo defecto del 2026-09-22: dos puntos pegados al nombre de la variable.
  fs.writeFileSync(cebo, '$MinTables = 400\nWrite-Output "el piso es $MinTables: no parece prod"\n', 'utf8');
  const sano = path.join(dir, 'cebo-sano.ps1');
  fs.writeFileSync(sano, '$MinTables = 400\nWrite-Output "el piso es ${MinTables}: ok"\n', 'utf8');
  try {
    const { filas } = correr(ps, [cebo, sano]);
    const atrapoElMalo = filas.some((f) => f.tipo === 'ERR' && f.ruta === cebo);
    const dejoPasarElBueno = filas.some((f) => f.tipo === 'OK' && f.ruta === sano);
    return { atrapoElMalo, dejoPasarElBueno, filas };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── main ────────────────────────────────────────────────────────────────────────────────────
const ps = buscarPowerShell();
if (!ps) {
  console.log('⚠️  NO MEDIDO — no hay `pwsh` ni `powershell` en esta máquina.');
  console.log('   Los 26 `.ps1` del repo NO se comprobaron. Esto no es verde: es una medición');
  console.log('   que no se pudo hacer (ADR-056). En Linux: `snap install powershell --classic`.');
  process.exit(2);
}

const listados = sh('git', ['ls-files', '*.ps1']);
const archivos = `${listados.stdout || ''}`
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean)
  .filter((f) => fs.existsSync(f))
  .map((f) => path.resolve(f));

if (!archivos.length) {
  console.log('⚠️  NO MEDIDO — `git ls-files *.ps1` no devolvió ningún archivo.');
  console.log('   Cero archivos y cero errores se imprimen igual; por eso esto no sale en verde.');
  process.exit(2);
}

const neg = pruebaNegativa(ps);
if (!neg.atrapoElMalo || !neg.dejoPasarElBueno) {
  console.log('⛔ LA COMPUERTA ESTÁ ROTA — no se juzga ningún archivo del repo.');
  console.log(`   cebo con ParserError detectado: ${neg.atrapoElMalo ? 'sí' : 'NO'}`);
  console.log(`   cebo sano aceptado:             ${neg.dejoPasarElBueno ? 'sí' : 'NO'}`);
  console.log('   Un gate que no atrapa su propio caso testigo saldría verde sobre archivos rotos.');
  process.exit(1);
}

const { filas } = correr(ps, archivos);
const vistos = new Set(filas.map((f) => f.ruta));
const noJuzgados = archivos.filter((a) => !vistos.has(a));
const errores = filas.filter((f) => f.tipo === 'ERR');

const rel = (p) => path.relative(process.cwd(), p).replace(/\\/g, '/');

if (errores.length) {
  console.log(`⛔ ${errores.length} error(es) de parseo en ${new Set(errores.map((e) => e.ruta)).size} archivo(s):\n`);
  for (const e of errores) console.log(`   ${rel(e.ruta)}:${e.linea}  ${e.msg}`);
  console.log('\n   Un ParserError NO falla esa línea: el archivo entero no compila y el script');
  console.log('   no ejecuta ni su primera instrucción. Si eso corre en una tarea programada,');
  console.log('   la tarea "corre" todos los días y no hace absolutamente nada.');
}

if (noJuzgados.length) {
  console.log(`\n⚠️  ${noJuzgados.length} archivo(s) NO devolvieron veredicto (ni OK ni ERR):`);
  for (const a of noJuzgados) console.log(`   ${rel(a)}`);
  console.log('   Una fila ausente no es un archivo sano. Se cuenta como rojo.');
}

if (!errores.length && !noJuzgados.length) {
  console.log(`✅ ${archivos.length} archivos .ps1 parsean (${ps.exe} ${ps.version}), prueba negativa incluida.`);
}

process.exit(errores.length || noJuzgados.length ? 1 : 0);
