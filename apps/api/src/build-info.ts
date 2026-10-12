/**
 * `[VL.11.C]` De qué build salió este proceso — UNA sola respuesta, para los tres que preguntan.
 *
 * ⛔ **El defecto que cierra.** Había tres lectores del mismo dato y cada uno se comportaba
 * distinto, así que "qué versión está corriendo" tenía tres respuestas simultáneas:
 *
 *   | Quién | Leía | Resultado on-prem |
 *   |---|---|---|
 *   | `app.controller.ts` (`/api/health`) | `RAILWAY_… ?? GIT_… ?? 'unknown'` | **`""`** |
 *   | `otel.ts` (versión del servicio) | sólo `RAILWAY_…` | `'dev'` |
 *   | `instrument.ts` (release de Sentry) | sólo `RAILWAY_…` | `undefined` |
 *
 * Las dos fallas son distintas y las dos importan:
 *
 * 1. **`??` es *nullish*, no *falsy*.** Una cadena **vacía** no es `null` ni `undefined`, así
 *    que `"" ?? 'unknown'` devuelve `""` — el respaldo nunca entra. Y `""` es exactamente lo
 *    que produce Compose al interpolar una variable que nadie definió. Medido dos veces el
 *    2026-09-22: `/api/health` respondió `{"commit": ""}`. ⚠️ Un campo con el valor equivocado
 *    es peor que uno ausente: nadie lo reporta, porque el endpoint sigue devolviendo 200.
 *
 * 2. **`RAILWAY_GIT_COMMIT_SHA` lo inyecta Railway y on-prem no existe.** Fuera de Railway,
 *    OTel etiquetaba cada traza como `dev` y Sentry no tenía `release` — o sea que un error
 *    de producción no se podía atribuir a un build.
 *
 * ⚠️ **Por qué vive acá y no en `libs/`** (ADR-056 pide que un primitivo compartido suba a
 * `libs/`): `instrument.ts` tiene que correr ANTES que cualquier otro módulo para que Sentry
 * alcance a instrumentar, e importar `@megadulces/platform-core` desde ahí ejecutaría media
 * plataforma antes de tiempo. Por eso este archivo **no importa nada** — es la única forma de
 * que los tres lo compartan. Queda declarado: si algún día otro `app` necesita lo mismo,
 * sube a `libs/` con su propia prueba.
 */

/** Trata `''` y `'   '` como ausencia. Es la mitad del arreglo. */
function noVacio(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/**
 * El commit del build que está corriendo, o `'unknown'` — **nunca una cadena vacía**.
 *
 * Orden: lo que inyecta Railway → lo que hornea nuestro Dockerfile (`ARG GIT_COMMIT_SHA`,
 * que `deploy.sh construir()` pasa) → `'unknown'`. El valor horneado es el piso: sobrevive a
 * un `docker compose up` a mano, que es donde el esquema anterior se caía.
 */
export function commitDelBuild(): string {
  return (
    noVacio(process.env.RAILWAY_GIT_COMMIT_SHA) ??
    noVacio(process.env.GIT_COMMIT_SHA) ??
    'unknown'
  );
}

/**
 * Igual que `commitDelBuild()` pero devuelve `undefined` cuando no se sabe, para los
 * consumidores que prefieren omitir el campo antes que publicar la palabra `unknown`
 * (el `release` de Sentry: un release literalmente llamado "unknown" agrupa mal los errores).
 */
export function commitDelBuildOpcional(): string | undefined {
  const c = commitDelBuild();
  return c === 'unknown' ? undefined : c;
}

/**
 * `[DBH.4]` **El ASUNTO del commit horneado, o `undefined`.**
 *
 * Lo pide `/admin/db-health`, donde la pregunta real es *«¿ya subió mi cambio?»*: un hash de ocho
 * caracteres no la contesta sin irse a `git log` a traducirlo; el asunto sí.
 *
 * ⚠️ **Devuelve `undefined`, no `'unknown'`, y la diferencia importa.** El SHA siempre existe —si
 * falta es una falla y vale la pena que se lea `unknown`—, pero el asunto puede faltar
 * legítimamente: un `docker build` a mano no pasa el `ARG`. Quien lo consume debe caer al SHA, que
 * es información verdadera, en vez de pintar la palabra «unknown» donde se espera una frase.
 *
 * ⚠️ Se recorta a 200 caracteres. Un asunto de commit convencional no llega ni a la mitad, pero
 * esto viaja en una variable de entorno de un contenedor y de ahí a una pantalla: si alguien pega
 * un cuerpo entero, que no reviente el renglón.
 *
 * ⛔ No se intenta leerlo de git: **dentro del contenedor no hay repositorio.** Es el mismo motivo
 * por el que el SHA se hornea en la imagen (ver arriba).
 */
export function asuntoDelBuild(): string | undefined {
  const s = noVacio(process.env.GIT_COMMIT_SUBJECT);
  return s === undefined ? undefined : s.slice(0, 200);
}
