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
| 5 | `20261003100000_servicedesk_cola_sin_asignar.js` | Columna `settings.unassigned_alert_minutes` (default 60, CHECK 5–1440) + clave `servicio.atender` en el catálogo de responsabilidades | idempotente; `lock_timeout 3s`; **no reparte la clave** |
| 6 | `20261003110000_servicedesk_ruteo.js` | Tabla `routing_rules` (RLS forzado), 2 categorías nuevas (Equipo de cómputo e impresoras · Desarrollo) y siembra las 2 reglas del pedido **buscando a las personas por usuario** (`felipe_galvan`, `david_cisneros`) + la responsabilidad `servicio.atender` para ellas | idempotente; **si el usuario no existe en prod, la regla NO se crea y el log lo dice** (se da de alta en `/servicio/configuracion`); **no da el permiso de atender** |

```sh
# En tu máquina (rama con los 6 archivos y el aplicador):
for f in 20261002100000_servicedesk_catalogos 20261002110000_servicedesk_requests \
         20261002160000_servicedesk_notificaciones 20261002170000_servicedesk_permisos \
         20261003100000_servicedesk_cola_sin_asignar 20261003110000_servicedesk_ruteo; do
  scp database/migrations-newdb/$f.js superoot@192.168.0.222:/tmp/
done
scp database/scripts/apply-one-migration-prod.js superoot@192.168.0.222:/tmp/

# En md — un pod api cualquiera que NO se esté muriendo:
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
POD=$(k3s kubectl -n prod get pods -l app=api --field-selector=status.phase=Running -o name | head -1)
for f in 20261002100000_servicedesk_catalogos 20261002110000_servicedesk_requests \
         20261002160000_servicedesk_notificaciones 20261002170000_servicedesk_permisos \
         20261003100000_servicedesk_cola_sin_asignar 20261003110000_servicedesk_ruteo; do
  k3s kubectl -n prod cp /tmp/$f.js ${POD#pod/}:/app/database/migrations-newdb/$f.js -c api
done
k3s kubectl -n prod cp /tmp/apply-one-migration-prod.js ${POD#pod/}:/app/database/scripts/apply-one-migration-prod.js -c api

# Ver qué considera pendiente (debe listar SÓLO estas 6 de la fase; si lista otras, NO son tuyas):
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

⛔ **No correr `database/tests/http-service-desk-test.js` ni `http-service-desk-attachments-s3-test.js` contra producción**: crean y borran usuarios, tickets y objetos.
Son pruebas de desarrollo. El de adjuntos se corre contra un bucket **desechable** (`S3_*` de pruebas; p. ej. Zenko CloudServer en Docker) para medir el código; lo que se verifica en prod es la **credencial real** del bucket, creando **un** ticket con **una** foto a mano y cancelándolo.

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
- **Reportes** (MS.3.5): ya están (`/servicio/reportes`, sin migraciones ni permisos nuevos: sale en vivo de los tickets y lo gatea `SERVICIO_COORDINAR`). *(El botón en tienda/telemarketing, MS.3.7, ya existía: montan el mismo layout.)* «A tu nombre» de Mi trabajo ya está (MS.3.6); la cola SIN asignar como bandeja de Mi trabajo (MS.3.8) también está, con plazo de 60 min hábiles ajustable — pero **no se ve hasta repartir la responsabilidad `servicio.atender`** (a quien reparte los tickets) desde `/admin/personas`, y su migración `20261003100000` va después de las cuatro de la mesa.
- **Teléfono físico y lector de pantalla**: la revisión visual usó un viewport de 390 px.
- **El E2E (190 aserciones) corre contra una base local**, nunca contra prod; lo que valida prod es §7.

---

## 11. Acceso por cola (MS.7.1 + MS.7.6) — un paso más, y el ORDEN cambia

A partir de la fase multi-área ([`FASE_MS7`](../FASES/FASE_MS7_MANTENIMIENTO.md) §9) **atender ya no es sólo tener la clave**: es la clave **más** pertenecer a la cola del ticket (`servicedesk.queue_members`).

**Orden (a diferencia del resto de este runbook, aquí la migración va ANTES del deploy):**

1. Migrar **una sola** migración, con el candado de identidad: `20261006130000_servicedesk_queue_members.js` (`apply-one-migration-prod.js`). Es aditiva; el código viejo la ignora.
2. **Medir el respaldo** (debe ser TODA la gente que hoy atiende TI):
   ```sql
   SELECT u.username, m.role FROM servicedesk.queue_members m
     JOIN identity.users u ON u.id = m.user_id
     JOIN servicedesk.queues q ON q.id = m.queue_id AND q.code = 'ti' AND m.active
    ORDER BY m.role, u.username;
   -- Debe coincidir con GET /service-desk/agents de antes del cambio. Si falta alguien con SERVICIO_ATENDER, NO desplegar.
   ```
3. Desplegar api + view. **No hay permisos nuevos: sin re-login.**
4. **Verificar con dos personas:** una de TI abre su bandeja (debe ver lo de siempre) y alguien con la clave pero sin cola ve **0** (no «todo»).

**Por qué antes:** con `queue_members` vacía el código nuevo no deja ver ningún ticket a nadie. El backfill de la migración es lo que lo evita; por eso el paso 2 no es opcional.

**Dar de alta a una persona nueva** (cambia el §5): además de `SERVICIO_ATENDER` (y `SERVICIO_COORDINAR` si reparte), la coordinación **de esa cola** la agrega: `PUT /service-desk/config/queues/:id/members/:userId` con `{"role":"tecnico"}` (o `"coordinador"`). **Desde MS.7.17 se hace en la pantalla:** `/servicio/configuracion` › la cola › «Quién atiende esta cola» › Agregar (la API se niega con un mensaje claro si a la persona le falta la clave, y la lista de candidatos sólo ofrece a quien ya la tiene).

**Reversa:** la migración trae `down` (quita la tabla y las dos columnas). ⚠️ Si ya se desplegó el código nuevo, **revertir primero el código**: sin la tabla, `actors.service` falla al leer las membresías.

---

## 12. Activar Mantenimiento (MS.7.14) — la cola nace apagada

**Antes de empezar (todo debe estar listo; si falta algo, NO encender):** `20261006130000` (miembros) aplicada y verificada (§11); el código con **acceso por cola**, **«Mi trabajo» por cola** (MS.7.18) y **la pantalla de miembros** (MS.7.17) desplegado; y la persona que coordinará con **`SERVICIO_ATENDER` y `SERVICIO_COORDINAR`** dados desde Personas.

1. Aplicar **tres** migraciones, **una por una y en este orden**, con el candado de identidad: `20261007240000_servicedesk_seed_mantenimiento.js` (la cola y sus categorías), `20261007250000_servicedesk_sla_por_cola.js` (el SLA por cola, con los plazos de Mantenimiento en horario hábil) y `20261007260000_servicedesk_prioridad_riesgo.js` (la columna `safety_risk` y el modelo riesgo × operación de Mantenimiento; el código nuevo ya debe estar desplegado: sin él el alta de Mantenimiento no sabría preguntar el riesgo). Son seguras en cualquier momento: la cola nace **apagada** y el catálogo esconde las categorías de una cola apagada; para TI el SLA no cambia (sus 4 filas siguen siendo la general). La segunda **cambia la unicidad** de `sla_policies`: aplicarla con el código nuevo ya desplegado o en la misma ventana (el código viejo no conoce `queue_id` y, con filas por cola, leería mal las generales).
2. **Verificar** (debe dar `false`, 11 y 0):
   ```sql
   SELECT q.active, (SELECT count(*) FROM servicedesk.categories c WHERE c.queue_id = q.id) AS categorias,
                    (SELECT count(*) FROM servicedesk.queue_members m WHERE m.queue_id = q.id AND m.active) AS miembros
     FROM servicedesk.queues q WHERE q.code = 'mantenimiento';
   ```
3. **Nombrar a la coordinación** (sólo un administrador puede: aún no hay nadie que la coordine): `/servicio/configuracion` › Mantenimiento › «Quién atiende esta cola» › Agregar, rol *Coordinación*. La lista sólo ofrece a quien ya tiene la clave.
4. **Esa persona** agrega a su gente y **enciende la cola** («Encender cola»). Desde ese momento «Nueva solicitud» ofrece sus 11 categorías (todas piden ubicación; «Oficinas Corporativas» y «Estacionamiento CEDIS» están en la lista).
5. **Verificar con dos personas:** alguien de TI **no** ve el ticket de prueba de Mantenimiento; la coordinación de Mantenimiento **sí**, sin asignar.
6. **Validar con Frank** (se cambia desde la pantalla): la prioridad por defecto de cada categoría (nacen en `media`) y si todas deben exigir ubicación.

**Lo que Mantenimiento ya tiene:** su **SLA en horario hábil** (MS.7.2) y su **prioridad por riesgo × operación** (MS.7.7: «Nueva solicitud» pregunta ¿hay riesgo para personas? y ¿detiene la operación?). **Zonas (MS.7.3):** migración `20261007310000` (después de `…260000` y **antes** de desplegar el código que la lee: el código nuevo consulta `zones` y `asks_zone`; el viejo las ignora) — siembra las 5 zonas y enciende la pregunta en Mantenimiento. **Campos propios por cola (MS.7.4):** migración `20261007320000` (después de `…310000` y **antes** de desplegar el código que la lee: el alta inserta `requests.extra`) — crea la tabla y `requests.extra`, **sin sembrar campos**. Nadie los usa hasta que una coordinación los declare desde Configuración. **Pausa con motivo, ruteo por ubicación y traslado entre áreas (MS.7.5/7.9–7.11):** migración `20261007350000` (también **antes** del código). Ver el resumen y los cambios de comportamiento en §13. ⚠️ Confirmar con Frank las dos lecturas del SLA (el «24 h» de Alta = 1 día hábil; la Urgente en horario hábil no corre de noche): se cambian en `/servicio/configuracion` › «Plazos por prioridad» › ¿De qué cola? › Mantenimiento.

**Reversa:** apagar la cola desde la pantalla (los tickets ya levantados se conservan). La migración trae `down`, pero **conserva** la cola si ya tiene tickets.

---

## 13. Todo MS.7 junto: el orden, lo que cambia para la gente y cómo verificarlo (MS.7.19)

**Migraciones, una por una (nunca `migrate:latest`: hay dos `knex_migrations`), con `apply-one-migration-prod.js` dentro de `prod-api` y su candado de identidad. Orden y momento:**

| # | Archivo | ¿Antes o después del código? | Qué hace |
|---|---|---|---|
| 1 | `20261006130000_servicedesk_queue_members` | **ANTES** (§11, y medir el respaldo) | Quién atiende cada cola. |
| 2 | `20261007240000_servicedesk_seed_mantenimiento` | cualquier momento | La cola Mantenimiento y sus 11 categorías, **apagada**. |
| 3 | `20261007250000_servicedesk_sla_por_cola` | **con el código nuevo** (cambia la unicidad de `sla_policies`) | SLA por cola; TI no cambia. |
| 4 | `20261007260000_servicedesk_prioridad_riesgo` | **después** del código (§12) | `safety_risk` + Mantenimiento por riesgo × operación. |
| 5 | `20261007310000_servicedesk_zonas` | **ANTES** del código | Zonas y `asks_zone`. |
| 6 | `20261007320000_servicedesk_campos_por_cola` | **ANTES** del código | `queue_fields` y `requests.extra`; **no siembra campos**. |
| 7 | `20261007350000_servicedesk_pausa_ruteo_traslado` | **ANTES** del código | `pause_reason`, `routing_rules.warehouse_code`, `kind='transfer'`. |
| 8 | `20261007340000_servicedesk_is_test` | **ANTES** del código | `requests.is_test` (default `false`: nada cambia hasta que la coordinación marque uno). Después de desplegar, marcar desde la pantalla el «Prueba de tickets» (SRV-2026-00003). |

Regla para decidir el momento: una migración **aditiva que el código nuevo lee** (columnas y tablas nuevas) va **antes** — el código viejo las ignora y el nuevo no se cae; una que **cambia el significado de datos que el código viejo lee** (la unicidad del SLA) o **declara un valor que sólo el código nuevo sabe aplicar** (el modelo de riesgo) va con el código o después. Cada una trae `down`; revertir el **código primero**.

**Lo que cambia para la gente que ya usa la Mesa (avisarlo antes de desplegar):**
1. **Poner en espera ahora pide el motivo** (proveedor, refacción, aprobación, a quien reportó u otro). Es obligatorio también en TI. ⚠️ Cualquier integración que ponga tickets en espera por la API sin `pause_reason` recibirá 400.
2. **La respuesta de quien reportó ya no reanuda una espera que no es a él** (proveedor/refacción/aprobación/otro): el reloj sigue pausado hasta que quien atiende la reanuda. Lo que ya estaba en espera se comporta como siempre.
3. **«Nueva solicitud» pregunta el área primero** cuando hay más de una; con sólo TI encendida se ve igual que antes.
4. **La bandeja** muestra un filtro de área (sólo si se atiende más de una) y, en la ficha, **«Transferir a otra área»** para la coordinación.
5. Nada de esto toca los permisos: **sin re-login**.

**Verificación en producción después de desplegar (punta a punta, con tickets de prueba que se cancelan al terminar):** con **dos personas** —una de TI y una de Mantenimiento— comprobar: (a) levantar → asignar → poner en espera con motivo → quien reportó comenta y **no** reanuda → reanudar → resolver → confirmar/cerrar; (b) **acceso cruzado**: la de TI no ve ni toca el ticket de Mantenimiento, y al revés; (c) levantar en TI y **transferir** a Mantenimiento: mismo folio, el hilo viaja entero, TI ya no lo ve y Mantenimiento sí; trasladarlo de vuelta; (d) lo cerrado ya no se traslada. La misma historia está automatizada en el E2E (bloque 32, 691 aserciones) contra una base local — **no sustituye** esta verificación, porque prod tiene sus propios datos.

**Lo que sigue pendiente a propósito:** avisos por cola con plantillas propias (MS.7.13) y el resto de lo declarado en cada sección de [`FASE_MS7`](../FASES/FASE_MS7_MANTENIMIENTO.md) §9.
