/**
 * ⛔ RETIRADO 2026-09-04 (OBS.8). Este ecosystem YA NO ARRANCA NADA — falla a propósito.
 *
 * Qué era: 7 consumidores `ods-cdc-wal.js --watch` (uno por sucursal 00-06) que leían el WAL de los
 * replicas locales `:5433/kepler_md_XX` y empujaban los cambios reales (I/U/D, incluido DELETE) a
 * `kepler_ods` en prod. Más `cdc-reconcile`, su red de seguridad.
 *
 * Por qué se retiró:
 *   · Los 7 estaban en `error` con el slot en `lost` desde el 2026-09-02 15:14 y nadie los levantó.
 *     Un stream de WAL no tiene reintento hacia atrás: cuando el slot se pierde, lo que pasó mientras
 *     tanto no vuelve nunca, así que "revivirlo" nunca fue tan barato como parecía.
 *   · El carril de poll (`replicate-ods-live` en Docker, `ops/vl/docker-compose.yml`) entrega hoy
 *     las 7 ramas con 9-30 s de rezago, que es para lo que existía el CDC.
 *   · Y sobre todo: mientras esto vivía en PM2 **y** en Docker **y** en una tarea de Windows, el mismo
 *     carril tenía TRES dueños peleando el mismo watermark (`ods.ctl`/`ods.shadow`) y escribiendo el
 *     MISMO renglón de `analytics.cron_runs` — que sólo tiene PRIMARY KEY (tenant_id, job_key), sin
 *     host. Resultado medido el 2026-09-04: el contenedor llevaba 15 h colgado y salía `healthy`
 *     porque la tarea de Windows le prestaba el pulso desde otra máquina. Regla que sale de ahí:
 *     **un carril = UN dueño**, y ese dueño es Docker.
 *
 * Los slots `ods_cdc_00..06` y la publication `ods_cdc_pub` ya fueron dropeados de los replicas
 * (retenían 0 bytes, sin riesgo de disco). `ods-cdc-wal.js` se conserva: es el decodificador de WAL
 * y sabe recrear su propio slot si algún día se decide volver.
 *
 * Lo que se PIERDE al retirarlo: sólo el WAL propagaba DELETE. Eso ahora lo cubre
 * `reconcile-ods-window.js`, que además de faltantes detecta SOBRANTES (llaves que siguen en el ODS y
 * ya no están en el replica) y los REPORTA — borrar en el ODS necesita autorización explícita.
 *
 * Dónde vive hoy la ingesta:  ops/vl/docker-compose.yml, en el servidor `md` (192.168.0.222).
 *   ops/vl/deploy.sh --estado     # qué corre allá y con qué versión, carril por carril
 *   ops/vl/deploy.sh --todo       # reconstruye la imagen y recrea LOS OCHO carriles
 *
 * ⛔ [CT.2 2026-09-24] ESTE BLOQUE DECÍA `ops/ingest/docker-compose.yml`, Y ERA MANDAR A LA
 * TRAMPA. Ese archivo declaraba los MISMOS `container_name` con el MISMO `ODS_HB_KEY` que los de
 * `ops/vl` — o sea que seguir la instrucción de un mensaje de retiro levantaba exactamente el
 * doble dueño que el mensaje advierte. Se borró en CT.2; el stack de `.249` está jubilado desde
 * el 2026-09-12. El único freno que fallaba bien te derivaba al pozo.
 */
throw new Error(
  'ecosystem.cdc.config.js está RETIRADO (OBS.8, 2026-09-04). La ingesta del ODS corre en Docker ' +
  'en el servidor `md`: ops/vl/deploy.sh --todo. Levantarla también acá reintroduce el doble ' +
  'dueño del watermark y del latido, que es lo que dejó el carril 15 h colgado en verde.',
);
