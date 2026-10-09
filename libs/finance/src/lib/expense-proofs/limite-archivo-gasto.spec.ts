import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_ARCHIVO_GASTO_BYTES, MAX_ARCHIVO_GASTO_MB, bytesDelCuerpoConArchivo } from '@megadulces/contracts';

/**
 * `[GX.79]` Candado del **tope de 20 MB** para la evidencia de un gasto.
 *
 * El archivo viaja en base64 dentro de un JSON (~4/3 de su peso). Lo revisan la pantalla, la API
 * y el proxy; si uno se queda atrás, el archivo rebota sin decir por qué. Este candado LEE la
 * configuración real de la API y de nginx — no una copia del número.
 */
const RAIZ = join(__dirname, '..', '..', '..', '..', '..');
const leer = (rel: string) => readFileSync(join(RAIZ, rel), 'utf8');
const MB = 1024 * 1024;

/** ¿Un límite de `bytes` deja pasar el cuerpo con el archivo más grande permitido? */
const alcanza = (bytes: number) => bytes >= bytesDelCuerpoConArchivo(MAX_ARCHIVO_GASTO_BYTES);

describe('[GX.79] el tope de la evidencia de un gasto', () => {
  it('es de 20 MB', () => {
    expect(MAX_ARCHIVO_GASTO_MB).toBe(20);
    expect(MAX_ARCHIVO_GASTO_BYTES).toBe(20 * MB);
  });

  it('la API acepta el cuerpo con un archivo de 20 MB en base64', () => {
    const m = /app\.use\('\/api\/finance\/expenses\/proofs',\s*json\(\{\s*limit:\s*'(\d+)mb'/.exec(leer('apps/api/src/main.ts'));
    expect(m).not.toBeNull();
    expect(alcanza(Number(m?.[1]) * MB)).toBe(true);
  });

  it('el proxy (nginx) acepta el mismo cuerpo', () => {
    const m = /client_max_body_size\s+(\d+)m;/.exec(leer('nginx.conf'));
    expect(m).not.toBeNull();
    expect(alcanza(Number(m?.[1]) * MB)).toBe(true);
  });

  /** ⛔ Prueba negativa del candado: el límite viejo de la API (16 MB) NO alcanza para 20 MB. */
  it('⛔ el límite anterior de la API (16 MB) no alcanzaría', () => {
    expect(alcanza(16 * MB)).toBe(false);
  });

  /** Las dos pantallas que suben evidencia usan el tope compartido, no un 10 MB escrito a mano. */
  it('las pantallas usan el tope compartido', () => {
    for (const rel of [
      'apps/view/src/app/modules/finanzas/components/expense-evidence-dialog.component.ts',
      'apps/view/src/app/modules/finanzas/pages/finanzas-capturar-gasto.component.ts',
    ]) {
      const src = leer(rel);
      expect(src).toContain('MAX_ARCHIVO_GASTO_BYTES');
      expect(src).not.toMatch(/10 \* 1024 \* 1024|10485760/);
    }
  });
});
