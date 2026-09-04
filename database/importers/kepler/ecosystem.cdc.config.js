/**
 * ⛔ RETIRADO 2026-09-04 (OBS.7). Este ecosystem YA NO ARRANCA NADA — falla a propósito.
 *
 * Qué era: 7 consumidores `ods-cdc-wal.js --watch` (uno por sucursal 00-06) que leían el WAL de los
 * replicas locales `:5433/kepler_md_XX` y empujaban los cambios reales (I/U/D, incluido DELETE) a
 * `kepler_ods` en prod. Más `cdc-reconcile`, su red de seguridad.
 *
 * Por qué se retiró:
 *   · Los 7 estaban en `error` con el slot en `lost` desde el 2026-09-02 15:14 y nadie los levantó.
 *     Un stream de WAL no tiene reintento hacia atrás: cuando el slot se pierde, lo que pasó mientras
 *     tanto no vuelve nunca, así que "revivirlo" nunca fue tan barato como parecía.
 *   · El carril de poll (`replicate-ods-live` en Docker, `ops/ingest/docker-compose.yml`) entrega hoy
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
 * Dónde vive hoy la ingesta:  ops/ingest/docker-compose.yml
 *   docker compose -f ops/ingest/docker-compose.yml up -d
 *   docker compose -f ops/ingest/docker-compose.yml ps      # STATUS trae (healthy)/(unhealthy)
 */
throw new Error(
  'ecosystem.cdc.config.js está RETIRADO (OBS.7, 2026-09-04). La ingesta del ODS corre en Docker: ' +
  'docker compose -f ops/ingest/docker-compose.yml up -d. Levantarla también acá reintroduce el ' +
  'doble dueño del watermark y del latido, que es lo que dejó el carril 15 h colgado en verde.',
);
