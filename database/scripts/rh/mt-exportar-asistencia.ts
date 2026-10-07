/**
 * Fase RH · `[RH.1.8]` (preparación) — exporta la asistencia por persona TAL COMO LA CALCULA
 * MEGA TALENTO, para compararla contra la Suite (`paridad-mega-talento.db.spec.ts`).
 *
 * Corre el código de Mega Talento, no una copia: se ejecuta DESDE su carpeta `api`, con su `tsx`
 * y sus dependencias, contra su base en SÓLO LECTURA (aborta si la sesión no lo confirma).
 *
 *   cd <mega-talento>/api
 *   DATABASE_URL="<url>?options=-c%20default_transaction_read_only%3Don" \
 *   MT_API_DIR="$PWD" npx tsx <suite>/database/scripts/rh/mt-exportar-asistencia.ts \
 *     --rangos=2026-09-17:2026-09-23,2026-09-24:2026-09-30 --salida=/ruta/mt-asistencia.json
 *
 * Sin `--sitios` toma todos los sitios con checadas. `generado` es la hora de la BASE al empezar:
 * la carga la usa para no traer checadas que llegaron después (si no, el número de hoy cambia
 * entre una foto y la otra).
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

type Asistencia = (p: { sucursalId: string; desde: string; hasta: string; soloPromotoras?: boolean }) => Promise<unknown>;

const arg = (n: string): string | undefined => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');

async function main(): Promise<void> {
  const dir = process.env['MT_API_DIR'];
  if (!dir) throw new Error('Falta MT_API_DIR (la carpeta api de Mega Talento).');
  const salida = arg('salida');
  const rangos = (arg('rangos') || '').split(',').filter(Boolean).map((r) => r.split(':') as [string, string]);
  if (!salida || !rangos.length) throw new Error('Faltan --salida y --rangos=desde:hasta[,…].');

  const db = await import(pathToFileURL(path.join(dir, 'src/db.ts')).href) as { pool: { query: (s: string) => Promise<{ rows: Array<Record<string, string>> }>; end: () => Promise<void> } };
  const ro = (await db.pool.query('SHOW default_transaction_read_only')).rows[0]['default_transaction_read_only'];
  if (ro !== 'on') throw new Error('La conexión a Mega Talento NO está en sólo lectura: no sigo.');
  const generado = (await db.pool.query(`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`)).rows[0]['t'];

  const sitios = arg('sitios')?.split(',').filter(Boolean)
    ?? (await db.pool.query(`SELECT DISTINCT sucursal_id FROM checadas ORDER BY 1`)).rows.map((r) => r['sucursal_id']);
  const { asistenciaPersonas } = await import(pathToFileURL(path.join(dir, 'src/agente-horarios/asistencia-personas.ts')).href) as { asistenciaPersonas: Asistencia };

  const resultados: Array<{ sitio: string; desde: string; hasta: string; soloPromotoras: boolean; ms: number; datos: unknown }> = [];
  for (const sitio of sitios) {
    for (const [desde, hasta] of rangos) {
      for (const soloPromotoras of [false, true]) {
        const t0 = Date.now();
        const datos = await asistenciaPersonas({ sucursalId: sitio, desde, hasta, soloPromotoras });
        resultados.push({ sitio, desde, hasta, soloPromotoras, ms: Date.now() - t0, datos });
        console.log(`${sitio} ${desde}..${hasta}${soloPromotoras ? ' (promotoras)' : ''}: ${Date.now() - t0} ms`);
      }
    }
  }
  fs.writeFileSync(salida, JSON.stringify({ generado, rangos, sitios, resultados }));
  console.log(`\n${resultados.length} cálculos → ${salida} (base de Mega Talento a las ${generado})`);
  await db.pool.end();
}

main().catch((e) => { console.error('ERROR:', e instanceof Error ? e.message : e); process.exit(1); });
