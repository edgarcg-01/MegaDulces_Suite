# Runbook — llevar la Mesa de Servicio a producción

> Fase MS · ADR-081 · `[MS.4]` · escrito el 2026-10-02.
> **Estado al escribirlo: NADA de esto se ha aplicado a producción.** Lo que sigue es el plan, con los
> comandos y lo que cada paso debe mostrar. Cada ⛔ tiene un incidente real detrás en otro runbook.
>
> Se apoya en [`ops/prod/RUNBOOK-despliegue.md`](../../../ops/prod/RUNBOOK-despliegue.md) (la mecánica del
> despliegue automático) y lo **corrige donde quedó viejo**: ese runbook habla de `docker exec prod-api`,
> pero desde `[K3S.28-33]` prod corre en **K3s** (namespace `prod`; todos los manifiestos están
> `migracion: migrado`). El camino vigente para migrar es el de
> [`03_LOG_REVISIONES.md`](../03_LOG_REVISIONES.md) §«El camino nuevo».

---

## 0. El orden, en una línea

**Medir → migrar (4 archivos, uno por uno) → recién entonces mergear a `main` → configurar → repartir a
las personas → pedir re-login → verificar.** Mergear antes de migrar no rompe nada (el despliegue se frena
solo, §3), pero deja a `main` detenido hasta que alguien migre.

Todo lo que trae la fase es **aditivo**: un schema nuevo (`servicedesk`), dos columnas opcionales en
`identity.users` y claves nuevas en `role_permissions`. Código viejo corriendo contra la base nueva no se entera.

---

## 1. Antes de tocar nada: medir lo que este plan supone

Cinco cosas que el plan **asume** y que desde desarrollo **no se pudieron leer**. Se miden con
`sh ~/ops/prod/pgprod.sh` en `md` (sólo lectura):

```sh
ssh superoot@192.168.0.222
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
```

| # | Qué se mide | Cómo | Por qué importa |
|---|---|---|---|
| 1 | **¿Existe el rol `sistemas`?** | `sh ~/ops/prod/pgprod.sh -At -c "select role_name from identity.role_permissions where role_name in ('sistemas','superadmin') and deleted_at is null"` | La migración de permisos reparte `ATENDER`/`COORDINAR` **sólo** a `superadmin` y `sistemas`. En desarrollo `sistemas` NO existe (sólo `retirado_sistemas`). Si tampoco existe en prod, Jorge, Edgar y Frank no atienden hasta que se les asigne por persona (§5). |
| 2 | **A cuántas personas alcanza `REPORTAR`** | consulta de abajo | Se reparte a todo rol que no sea cliente, dispositivo o retirado. Hay que saber el número **antes**. |
| 3 | **¿Cuántos tenants hay?** | `select count(*) from identity.tenants` | La siembra de cola/categorías/plazos corre por tenant. |
| 4 | **¿Corren los `@Cron` en los pods `api`?** | `k3s kubectl -n prod exec deploy/api -c api -- printenv DISABLE_CRONS` | El manifiesto del `api` **no** fija `DISABLE_CRONS` (sólo lo fijaba Compose). Si viene vacío, el barrido del SLA corre en el worker **y** en las 2 réplicas. Es seguro —lleva candado por tenant en la base— pero conviene saberlo: ver §8. |
| 5 | **¿Hay SMTP y bucket en el secreto?** | `k3s kubectl -n prod get secret prod-env -o json \| node -e "const s=JSON.parse(require('fs').readFileSync(0));console.log(Object.keys(s.data).filter(k=>/^(SMTP_|S3_|AWS_)/.test(k)))"` | **Sólo los nombres, nunca los valores.** Sin `S3_*` las fotos fallan con 400; sin `SMTP_*` el correo queda `skipped`. |

```sql
-- #2: cuántas personas activas recibe cada rol (la migración imprime lo mismo al terminar)
SELECT rp.role_name, count(u.id) FILTER (WHERE u.activo AND u.deleted_at IS NULL) AS personas
  FROM identity.role_permissions rp
  LEFT JOIN identity.users u ON u.tenant_id = rp.tenant_id AND u.role_name = rp.role_name
 WHERE rp.deleted_at IS NULL AND rp.role_name NOT LIKE 'retirado%'
   AND rp.role_name NOT IN ('customer_b2b','servicio','checador_kiosco','verificador_precios','etiquetas_tienda')
 GROUP BY 1 ORDER BY 2 DESC;
```

Y la línea base de migraciones, para saber que las 4 **no** están ya:

```sql
SELECT name FROM public.knex_migrations WHERE name LIKE '20261002%' ORDER BY name;   -- debe volver vacío
```

---

## 2. Migrar — cuatro archivos, en este orden, uno por uno

| Orden | Archivo | Qué hace | Ojo |
|---|---|---|---|
| 1 | `20261002100000_servicedesk_catalogos.js` | Schema `servicedesk`; colas, categorías, plazos y ajustes; **siembra por tenant** (cola TI, 12 categorías, 4 plazos, escalación **apagada**) | idempotente (`ON CONFLICT DO NOTHING`) |
| 2 | `20261002110000_servicedesk_requests.js` | Tickets, hilo, adjuntos, tiempo y folio; RLS forzado; sin `DELETE` para `app_runtime` sobre el registro | depende de la 1 |
| 3 | `20261002160000_servicedesk_notificaciones.js` | `identity.users.email` y `.phone` + preferencias y log de avisos | ⛔ **toca `identity.users`, tabla caliente** — ver abajo |
| 4 | `20261002170000_servicedesk_permisos.js` | Reparte `SERVICIO_REPORTAR/ATENDER/COORDINAR` en `role_permissions` | imprime a cuántas personas alcanza; guarda el motivo si falta el rol `sistemas` |

```sh
# En tu máquina (rama con los 4 archivos y el aplicador):
for f in 20261002100000_servicedesk_catalogos 20261002110000_servicedesk_requests \
         20261002160000_servicedesk_notificaciones 20261002170000_servicedesk_permisos; do
  scp database/migrations-newdb/$f.js superoot@192.168.0.222:/tmp/
done
scp database/scripts/apply-one-migration-prod.js superoot@192.168.0.222:/tmp/

# En md — un pod api cualquiera que NO se esté muriendo:
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
POD=$(k3s kubectl -n prod get pods -l app=api --field-selector=status.phase=Running -o name | head -1)
for f in 20261002100000_servicedesk_catalogos 20261002110000_servicedesk_requests \
         20261002160000_servicedesk_notificaciones 20261002170000_servicedesk_permisos; do
  k3s kubectl -n prod cp /tmp/$f.js ${POD#pod/}:/app/database/migrations-newdb/$f.js -c api
done
k3s kubectl -n prod cp /tmp/apply-one-migration-prod.js ${POD#pod/}:/app/database/scripts/apply-one-migration-prod.js -c api

# Ver qué considera pendiente (debe listar SÓLO estas 4 de la fase; si lista otras, NO son tuyas):
k3s kubectl -n prod exec ${POD#pod/} -c api -- node /app/database/scripts/apply-one-migration-prod.js --list

# Una por una, y leer la salida de cada una antes de pasar a la siguiente:
k3s kubectl -n prod exec ${POD#pod/} -c api -- node /app/database/scripts/apply-one-migration-prod.js 20261002100000_servicedesk_catalogos.js
```

**Qué debe mostrar cada una** (si no coincide, parar):
1. `[MS.1.1] servicedesk: N tenant(s) · cola TI + 12 categorías + 4 plazos + ajustes (escalamiento APAGADO)`
2. `[MS.1.2] servicedesk: requests + request_messages + request_attachments + work_log + request_sequences`
3. `[MS.1.3] identity.users.email/phone + servicedesk.notification_prefs + notification_log`
4. `[MS.1.4] permisos repartidos — REPORTAR: … · ATENDER: … · COORDINAR: …` y tres líneas «→ N rol(es) · N persona(s) activa(s)». **Contrastar `REPORTAR` con la medición #2 de §1.**

⛔ **Nunca `migrate:latest`** (hay dos `knex_migrations` y reaplicaría ~800). **Nunca desde tu máquina sin
`PROD_DB_URL`**: el `FLEET_DB_URL` del `.env` sigue apuntando a Railway; el aplicador tiene candado de identidad
del clúster, pero el candado frena el daño, no la causa.

⚠️ **La migración 3 hace `ALTER TABLE` sobre `identity.users`**, de la que cuelga el login. Lleva
`SET LOCAL lock_timeout = '3s'`: si no consigue el lock en 3 s **falla limpio** en vez de encolar a todos detrás
(así se tumbó el login una vez con `role_permissions`, GOTCHAS §38). Si falla por eso: **reintentar en un momento
de poca actividad**, no subir el timeout. Las columnas son `NULL` sin default (cambio de catálogo, no reescribe).

⚠️ **«migration directory is corrupt»**: a la imagen del pod le faltan migraciones que la tabla ya registra. El
error las nombra una por una; se copian al pod igual que arriba (ya están aplicadas, knex sólo necesita verlas).

**Verificación después de las 4:**
```sql
SELECT count(*) FROM information_schema.tables WHERE table_schema = 'servicedesk';        -- 11
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
 WHERE relnamespace = 'servicedesk'::regnamespace AND relkind = 'r';                       -- todas t / t
SELECT priority, first_response_minutes, resolution_minutes, clock FROM servicedesk.sla_policies ORDER BY 2;
SELECT escalation_enabled FROM servicedesk.settings;                                       -- false, en cada tenant
```

---

## 3. Cuándo mergear a `main`

`auto-deploy.sh` **se frena solo** si `origin/main` trae migraciones que prod no tiene (compuerta 2). Eso no es
una falla: es el carril funcionando. Por eso el orden recomendado es **migrar primero** (§2) y mergear después:
el despliegue baja el código en la siguiente corrida (cada 5 min) con las compuertas de arranque, commit servido y
humo del login.

Si se mergea antes: `main` queda frenado hasta que se apliquen las 4. No pasa nada malo, sólo no sale.

⚠️ La clasificación `clasificar-migraciones.awk` distingue una migración «pendiente» de un nombre viejo ya
aplicado por **contenido** (blob de git). Estas 4 son nuevas de verdad; si la compuerta reporta **más** de 4, las
otras son de otra sesión y **no te toca aplicarlas**.

---

## 4. Configuración que la fase **no** instala

Todo se lee de `process.env` desde el secreto `prod-env` de K3s (`envFrom` en `api` y `worker`).

| Qué | Variables | Sin esto | Estado |
|---|---|---|---|
| **Bucket de fotos y PDF** | `S3_BUCKET`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` (o los `AWS_*`) | Crear un ticket **con adjuntos** devuelve 400 «Almacenamiento no configurado»; **sin adjuntos funciona normal** | **No medido en prod** (medición #5) |
| **Correo** | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | El aviso por correo queda `skipped / smtp_no_configurado` en `notification_log`. La campana **sí** funciona | CLAUDE.md lo da por sin configurar (OBS.0.2) |
| **WhatsApp** | — | **No se enciende en esta fase**: un aviso iniciado por el negocio exige plantilla aprobada por Meta (P5). Queda `skipped / whatsapp_no_configurado` para quien lo activó | Decisión pendiente |
| Apagar el barrido | `ENABLE_SERVICE_DESK_SLA=false` | — | Interruptor de emergencia, no de uso normal |

⛔ **Cómo se actualiza el secreto `prod-env` en K3s NO está documentado en el repo** (`make-prod-env.js` lo generaba
para Compose, y ese script advierte que `JWT_SECRET` de prod contiene un salto de línea que cambiarlo **desloguea a
todo el mundo**). Antes de agregar variables, confirmar el procedimiento con quien operó el corte a K3s. **No se
improvisa con `kubectl edit secret`**: un secreto reescrito mal tumba `api` y `worker` a la vez.

---

## 5. Repartir a las personas (P4)

`REPORTAR` llega solo con la migración 4. **Atender y coordinar es decisión de negocio** y por eso la migración sólo
lo da a `superadmin` y `sistemas`. Las tres personas definidas:

| Persona | Área | Hace falta |
|---|---|---|
| Jorge Rubio | Sistemas | `SERVICIO_ATENDER` (por rol `sistemas`, o por persona) |
| Edgar | Desarrollo | `SERVICIO_ATENDER` + `SERVICIO_COORDINAR` |
| Frank | Dirección General | `SERVICIO_ATENDER` + `SERVICIO_COORDINAR` — **de otro departamento**, así que NO hereda de `sistemas` |

⚠️ **Los roles reales de las tres personas no están confirmados** (se leen en la medición #1). Se asignan desde
`/admin/usuarios` como **override de persona** (`identity.user_permissions`, con nota) — el override gana sobre el rol en
los dos sentidos y es lo que usa el selector de agentes. Una persona sin `ATENDER` no aparece en «Asignar a…».

---

## 6. Re-login — el paso que se olvida

Los permisos viajan **dentro del JWT**. El servidor los lee frescos (el `RolesGuard` consulta la base, caché de 30 s),
pero la **pantalla** decide qué mostrar con el token que ya tiene: el botón «Reportar un problema» y el espacio 9 no
aparecen hasta que la persona **vuelva a entrar**. Avisar a quien deba verlo.

---

## 7. Verificar que quedó sirviendo

```sh
# 1. El commit servido es el esperado (el carril ya lo comprueba, pero se ve con los ojos):
curl -s https://megadulcessuite.com/api/health

# 2. La ruta existe y pide sesión (401 es lo correcto; 404 = el código nuevo no está sirviendo):
curl -s -o /dev/null -w "%{http_code}\n" https://megadulcessuite.com/api/service-desk/catalog

# 3. El barrido del SLA deja latido (≤ 10 min después de que el WORKER lleve el código):
sh ~/ops/prod/pgprod.sh -At -c "select status, rows_affected, last_finish, host, error from analytics.cron_runs where job_key='service_desk_sla'"
```

El latido `service_desk_sla` es el que vale (ADR-053): si falta o está en `error`, el barrido no corre. Entregar
**cero** es lo normal (nada venció); el latido lo declara así a propósito. En Salud BD aparece como
«Mesa de Servicio: barrido del SLA».

**Prueba de punta a punta con una persona real** (se hace a mano, con consentimiento, y se cancela al terminar):
entrar con un usuario que tenga `REPORTAR`, crear **una** solicitud sin adjuntos, verla en «Mis solicitudes», y desde
una cuenta con `ATENDER` tomarla; luego **cancelarla** (los tickets no se borran).

⛔ **No correr `database/tests/http-service-desk-test.js` contra producción**: crea y borra usuarios y tickets.
Es una prueba de desarrollo.

---

## 8. Encender la escalación (cuando toque)

La escalación **nace apagada** a propósito: `cash-count-sla` se retiró por estar mal calibrado, y un reloj sin
calibrar que avisa enseña a ignorar la alarma. Con ella apagada el barrido **mide y marca** pero **no avisa**.

**Criterio sugerido:** una semana de uso real, y revisar:
```sql
SELECT priority, count(*) AS total,
       count(*) FILTER (WHERE sla_first_breached_at IS NOT NULL)      AS primera_vencida,
       count(*) FILTER (WHERE sla_resolution_breached_at IS NOT NULL) AS resolucion_vencida
  FROM servicedesk.requests
 WHERE created_at > now() - interval '7 days' AND deleted_at IS NULL
 GROUP BY 1 ORDER BY 1;
```
Si **la mayoría** vence, los plazos están mal puestos: se ajustan en `/servicio/configuracion` **antes** de encender (si
no, el primer día llegan decenas de avisos y se enseña a ignorarlos). Encender = casilla «Escalar y avisar» en esa
misma pantalla (no requiere despliegue).

⚠️ **Si los `@Cron` corren también en los pods `api`** (medición #4), el barrido corre en 3 procesos. Es seguro: lleva
`running` en memoria **y** candado por tenant en la base (`pg_try_advisory_xact_lock`), así que sólo uno barre y los
avisos no se duplican (índice único por destinatario). Pero el latido dirá `host = api` o el del worker según quién
gane; no es una falla.

---

## 9. Reversa

Todo es aditivo, así que **no hay una reversa urgente que obligue a tocar la base**:

| Si… | Se hace | Cuesta |
|---|---|---|
| El barrido se porta mal | `ENABLE_SERVICE_DESK_SLA=false` y reiniciar `worker` | un cambio de secreto (§4: confirmar el procedimiento) |
| Hay que ocultar la Mesa a todos | Quitar la clave: `UPDATE identity.role_permissions SET permissions = permissions - 'SERVICIO_REPORTAR'` (el servidor responde 403 de inmediato; el botón desaparece al re-login) | reversible: la migración 4 vuelve a repartirla |
| El código nuevo no arranca | Lo hace solo el carril: **reversión automática + cuarentena** (RUNBOOK §4). Las tablas nuevas no estorban al código viejo | nada |

⛔ **No se borran las tablas de `servicedesk` en producción** (regla del proyecto) y los `down()` conservan a
propósito `identity.users.email/phone`. Si hubiera que retirar la fase de verdad, es decisión de una persona, no un
rollback automático.

---

## 10. Lo que este plan NO cubre, declarado

- **El camino exacto para actualizar `prod-env`** en K3s (§4): no está en el repo.
- **Si prod tiene `sistemas`, SMTP y bucket**: se miden en §1, no se asumen.
- **WhatsApp**: sin plantilla de Meta no hay canal; queda declarado por aviso.
- **Reportes y el botón en tienda/telemarketing** (MS.3.5, MS.3.7): pendientes. «A tu nombre» de Mi trabajo ya está (MS.3.6); lo que sigue declarado es la cola SIN asignar como bandeja de Mi trabajo (`servicio.atender`), que necesita un umbral de atraso que nadie ha fijado.
- **Teléfono físico y lector de pantalla**: la revisión visual usó un viewport de 390 px.
- **El E2E (190 aserciones) corre contra una base local**, nunca contra prod; lo que valida prod es §7.
