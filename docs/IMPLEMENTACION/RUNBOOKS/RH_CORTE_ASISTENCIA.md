# Runbook — corte de asistencia: Mega Talento → Suite (Fase RH, `[RH.1.8]`)

> **Quién:** Edgar (prod en `md`), David (agente de relojes y Mega Talento), RH (valida y empieza a usarlo).
> **Cuándo:** ~~sábado 7-nov-2026~~ → **en cuanto Edgar pueda** (adelantado a pedido de David, 14-oct; el 14 no se hizo).
> Cualquier día sirve: la carga trae la semana completa desde Mega Talento. Las migraciones (§2.1–§2.3) en el día, salvo
> la de `identity.users` (`20261012094356`, candado exclusivo: de noche); lo que escribe la carga o reinicia pods, de
> preferencia fuera de horario.
> **Escrito el 2026-10-07** con los guiones ya probados contra la base local y contra Mega Talento real (sólo lectura).
> Nada de esto se ha corrido contra prod todavía: desde la máquina de trabajo no hay acceso a `md`.

## 0.0 Antes de empezar: decisiones del 14 y 16-oct

- **El lector sigue en la laptop de David (`LapSistemasA`)** — decisión de David, 16-oct. Es la **opción A** del paso 4:
  el mismo servicio («Mega Talento Agente de Checadas») cambia de dirección; no queda un segundo lector. La B (lector en
  `md`) queda para después y exige medir antes que `md` alcanza los 12 relojes (`[RH.0.3]`). ⛔ No aplicar
  `ops/k3s/29-hr-relojes.deployment.yaml` con la laptop viva: un ZKTeco acepta **una sola** sesión TCP.
- **Mismo token** — decisión de David, 16-oct: `HR_INGEST_KEY` toma el valor del token que el lector ya usa con Mega
  Talento (ver §2.4). El cambio en la laptop es sólo la dirección. Rotarlo cuando se apague Mega Talento.
- **La migración del #410 ya debería estar:** `20261014141356_talent_bot_documentos` (el código ya corre en prod). Si
  aparece pendiente, se aplica con el mismo comando del §2.2.
- **Personas nuevas después del corte:** las liga RH en `/rh/relojes` (PR #418, `[RH.1.12]`, ya mergeado).
- **Antes de cortar, revisar (auditoría del 16-oct):**
  - `horas_extra_ajustes` de Mega Talento: la carga **no** la trae. Hoy tiene 0 filas; si RH captura un ajuste antes del
    corte, se pierde. Confirmar que sigue en 0.
  - **BOT-RH lee `checadas` y escribe `horarios_confirmados` en la base de Mega Talento.** Después del corte calcularía con
    datos viejos y sus horarios no llegarían a la Suite. Decidir antes: apagar esas funciones del bot o apuntarlas a la
    Suite.
  - **CEDIS (`CLXK225060395`) sin leerse desde el 15-oct 15:05** (no abre el 4370). No bloquea, pero sale en rojo en
    `/rh/relojes` hasta que se revise en sitio.
- **Acceso a `md` para David (sólo si Edgar lo aprueba):** dar de alta la llave de la laptop con el guion de `[SEG.1]`,
  y quitarla después del corte si no debe quedarse:

  ```sh
  # en md, con la llave pública de la descripción del PR guardada en /tmp/david.pub
  sh ~/ops/prod/ssh-llaves.sh agregar /tmp/david.pub david@lapsistemasa
  # al terminar, si no se queda:
  sh ~/ops/prod/ssh-llaves.sh quitar david@lapsistemasa
  ```

  Sin el acceso, Edgar corre los pasos de `md` y David los del lector y la revisión.

---

## 0. Las reglas que no se negocian

1. **Nada se borra de Mega Talento.** Su asistencia queda de sólo lectura dos semanas después del corte.
2. **⚠️ Corregido el 16-oct: el lector NO reenvía solo lo que ya mandó.** Su cola (`cola.db`) descarta para siempre lo
   ya enviado (`UNIQUE(serie, codigo, fecha_hora)` + `ON CONFLICT DO NOTHING`, y lo enviado se conserva 30 días), sin
   importar a qué servidor fue. El backfill relee 36 h del reloj, pero esas checadas ya están en la cola como enviadas. Por
   eso **cambiar de dirección no reenvía nada, ni en la ida ni en la reversa**: se reenvía a mano con
   `corte-lector.js reenviar <desde>` (con el servicio detenido). Y con **401/403/409** el lector **marca el lote como
   enviado y sigue** (`reloj.js`, rama `!e.reintentable`): una llave mala o un reloj fuera del padrón vacían la cola sin
   entregar. Por eso, **antes de cambiar el lector, `corte-lector.js probar`** (sólo lee).
3. **Todo se aplica a mano y una cosa a la vez**: las migraciones, una por una (nunca `migrate:latest`: hay dos
   `knex_migrations` en prod). El despliegue se suelta con `soltar.sh`.
4. **Cada paso se verifica antes del siguiente.** El pre-vuelo es el que dice si se puede seguir.
5. **Fuera de horario:** la carga escribe ~215 mil filas y los reinicios de pods cortan conexiones.

---

## 1. Los dos guiones

| Guion | Qué hace | Escribe |
|---|---|---|
| `database/scripts/rh/prevuelo-corte-asistencia.js` | Revisa contra la base: identidad del clúster, migraciones pendientes y su orden, datos previos en `hr.*`, padrón ligado a personas, roles del reparto, variables de entorno, latidos, transacciones largas, horario y, si se le da, que Mega Talento sea alcanzable. Cada revisión sale **OK / AVISO / BLOQUEA / NO MEDIDO**. | **Nada** (sesión en sólo lectura; aborta si no lo confirma) |
| `database/scripts/rh/carga-unica-mega-talento.js --destino-prod` | La carga única: sitios, relojes, padrón, checadas, incidencias, cierres, horarios, alertas, órdenes. **Ensayo por omisión** (todo en una transacción que se deshace). Con `--aplicar`, la deja. Antes de escribir exige que el clúster sea prod y que su cadena de migraciones esté aplicada. | Sólo con `--aplicar` |

Los dos se corren **dentro del pod `api`** de prod (la URL buena ya está ahí y nunca sale del pod), igual que
`apply-one-migration-prod.js`. Lo mismo para todo el runbook:

```sh
ssh superoot@192.168.0.222
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
API=$(kubectl get pods -n prod -l app=api -o jsonpath='{.items[0].metadata.name}')
```

⚠️ **Hay dos pods de `api`.** Copiá y ejecutá en el **mismo** `$API`; volvé a calcularlo después de cada reinicio.
⚠️ `-c api` siempre: el pod tiene un contenedor de inicio y sin `-c` kubectl ensucia la salida.
⚠️ **El §3 de `ops/prod/RUNBOOK-despliegue.md` está viejo** (dice `docker cp prod-api`): prod corre en k3s desde
el 2026-10-02. El camino vigente es el de la cabecera de `apply-one-migration-prod.js`.

**La URL de Mega Talento** (la necesita la carga y, opcionalmente, el pre-vuelo) **nunca va en un argumento**:

```sh
# en md, una sola vez: el archivo con la URL, sólo legible por superoot
install -m 600 /dev/null ~/secrets/mt.url && nano ~/secrets/mt.url
# cada vez que se use: copiarlo al pod, leerlo ahí, borrarlo al terminar
kubectl cp ~/secrets/mt.url prod/$API:/tmp/mt.url -c api
```

---

## 2. Semana previa (T-7, fuera de horario) — dejar todo listo menos el agente

### 2.1 Pre-vuelo con el código de hoy

El código de RH todavía no está en el pod: el guion se copia.

```sh
# desde la máquina de trabajo
scp database/scripts/rh/prevuelo-corte-asistencia.js superoot@192.168.0.222:/tmp/
# en md
kubectl cp /tmp/prevuelo-corte-asistencia.js prod/$API:/app/database/scripts/ -c api
kubectl cp ~/secrets/mt.url prod/$API:/tmp/mt.url -c api
kubectl exec -n prod $API -c api -- sh -c \
  'PREVUELO_URL="$DATABASE_URL_NEW" MT_DATABASE_URL="$(cat /tmp/mt.url)" \
   node /app/database/scripts/prevuelo-corte-asistencia.js --exigir-prod; rm -f /tmp/mt.url'
```

**Qué se espera** y qué hacer con cada respuesta:

| Revisión | Esperado ahora | Si no |
|---|---|---|
| identidad | OK (clúster `7688376744939610156`) | BLOQUEA: estás en otra base. No sigas. |
| migraciones | AVISO con la lista de pendientes. Si la primera es `20260817220000_hr_attendance` (la base de la Fase CH), **va primero** | BLOQUEA por «nombre viejo» o «colisión»: avisar a David; se renombra antes del corte |
| datos previos | `hr.attendance_logs: 0` | Si hay checadas, el pre-vuelo dice de dónde (`source`, fechas, relojes). La carga **cede** ante ellas, pero hay que entender su origen antes de seguir |
| mega talento | OK, sólo lectura, ~215 mil checadas | BLOQUEA: el pod no alcanza Mega Talento. La carga no puede correr desde ahí |

### 2.2 Merge y migraciones

1. Mergear en orden **#281 → #283 → #286** (squash).
2. `ssh superoot@192.168.0.222 'ops/prod/soltar.sh --ver'` lista las migraciones pendientes. La compuerta 2 frena el
   despliegue hasta que se apliquen, **también el de cualquier otro merge**. Aplicarlas el mismo día del merge.
3. Aplicar **una por una, en este orden** (omitir las que el pre-vuelo dé por aplicadas):

   ```
   20260817220000_hr_attendance.js          ← base de la Fase CH (CH.0.9 nunca la aplicó a prod)
   20261007100000_hr_relojes_y_checadas.js
   20261007110000_hr_horarios_y_alertas.js
   20261007304401_hr_incidencias_y_cierres.js
   20261008094812_hr_agente_corridas.js
   20261008094813_hr_ordenes_quien.js
   20261008094815_hr_reparto_asistencia.js  ← reparte las claves de RH (ver §2.5)
   ```

   Para cada una (camino vigente, cabecera de `apply-one-migration-prod.js`):

   ```sh
   scp database/migrations-newdb/<archivo>.js database/scripts/apply-one-migration-prod.js superoot@192.168.0.222:/tmp/
   kubectl cp /tmp/<archivo>.js prod/$API:/app/database/migrations-newdb/ -c api
   kubectl cp /tmp/apply-one-migration-prod.js prod/$API:/app/database/scripts/ -c api
   kubectl exec -n prod $API -c api -- sh -c \
     'PROD_DB_URL="$DATABASE_URL_NEW" node /app/database/scripts/apply-one-migration-prod.js <archivo>.js'
   ```

   ⚠️ Antes de la primera: que no haya otra migración en curso (pre-vuelo, revisión «actividad») y que no haya un
   despliegue a medias (`kubectl rollout status deploy/api -n prod`).

4. `ops/prod/soltar.sh` y verificar: `/api/health` responde, el login sin credenciales da **401** (no 500), y
   `GET /api/hr/attendance/sites` responde **200 con una lista vacía** para un superadmin.

> Desplegar el código de RH antes del corte es seguro: el agente de alertas arranca apagado, la ingesta responde
> 401 sin `HR_INGEST_KEY` y las pantallas salen vacías. A cambio, el pre-vuelo y el ensayo corren con los guiones
> que ya trae la imagen, sin copiar nada.

### 2.3 Pre-vuelo otra vez (ahora ya viene en la imagen)

```sh
kubectl exec -n prod $API -c api -- sh -c \
  'PREVUELO_URL="$DATABASE_URL_NEW" node /app/database/scripts/rh/prevuelo-corte-asistencia.js --exigir-prod'
```

Esperado: **migraciones OK** (las 7). «padrón: NO MEDIDO» (todavía no hay carga).

### 2.4 La llave de la ingesta (`HR_INGEST_KEY`)

El agente se presenta con esta llave (cabecera `X-Agente-Token`). Va en el secreto `prod-env`, que comparten `api`
y `worker`. ~~Una llave nueva~~ → **el MISMO token que el lector ya usa con Mega Talento** (decisión de David, 16-oct):
el cambio en la laptop es sólo la dirección. David se lo pasa a Edgar por privado (está en el `config.json` del lector).

```sh
# en md: respaldo del secreto ANTES de tocarlo (es la reversa)
kubectl -n prod get secret prod-env -o yaml > ~/secrets/prod-env.respaldo-$(date +%Y%m%d-%H%M).yaml
chmod 600 ~/secrets/prod-env.respaldo-*.yaml
# el token del lector (lo manda David por privado), a un archivo: no a la pantalla ni al historial
chmod 600 ~/secrets/hr-ingest.key
kubectl -n prod patch secret prod-env --type merge \
  -p "{\"stringData\":{\"HR_INGEST_KEY\":\"$(cat ~/secrets/hr-ingest.key)\"}}"
kubectl -n prod rollout restart deploy/api && kubectl -n prod rollout status deploy/api
```

El token viaja **por un canal privado**: nunca en el repo, un chat de grupo ni un correo.
Verificar: el pre-vuelo dice «HR_INGEST_KEY presente», y la prueba **negativa**: sin la llave tiene que dar 401 (el
guardián compara la llave recibida contra `HR_INGEST_KEY`; sin llave no coincide). La prueba positiva con el token real
la hace David desde su laptop con `corte-lector.js probar`, que no imprime el token.

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' \
  https://megadulcessuite.com/api/hr/attendance/ingest/mt/checador/ingesta/latido   # esperado: 401
```

### 2.5 Las personas: `[RH.1.4]` es prerrequisito, no «después»

⛔ **Sin esto el corte no cuadra con Mega Talento.** La paridad de 0 diferencias (1,464 personas, 5,464 días) se
midió **con las personas ligadas**. Sin ficha, una persona sólo aparece si checó, y se pierden tres cosas:
- la **falta** de quien no vino en toda la semana;
- el corte **planta / promotoras** (sale del departamento);
- la exclusión de las **bajas**.

Medido con datos reales: tras la carga hay **991 enrolamientos activos y 0 ligados** → el pre-vuelo da **BLOQUEA**.

Antes del corte:
1. ~~RH valida los mapeos~~: ya no hace falta (`[RH.0.4]`, `[RH.1.4b]`): Mega Talento trae las plazas, la sección de RH de cada ficha y quién es la misma persona.
2. Se crean o enlazan las personas en `identity.users` y se ligan sus enrolamientos (`[RH.1.4]`) con
   `database/scripts/rh/carga-personas-mega-talento.js` (ensayo por omisión, `--aplicar` para dejarlo). Necesita la
   migraciones `20261012094356_rh_personas_bajas_y_sin_acceso` y `20261012151620_hr_secciones_por_ficha` aplicadas (van al final de la cadena del pre-vuelo) y corre
   **después** de la carga de checadas, que es la que deja los enrolamientos. Los mapeos están en
   `database/scripts/rh/mapeo-personas-mega-talento.json` (sólo plaza → almacén, confirmado contra Mega Talento); la
   sección de RH de cada ficha se guarda tal cual en `hr.person_site_profiles`. El cuadre cuenta las personas con varias
   fichas unidas y los avisos para Sistemas (cuentas duplicadas de la Suite). Reglas y lo que NO hace: cabecera del guion y
   [`FASE_RH_PLAN_DE_TRABAJO`](../FASES/FASE_RH_PLAN_DE_TRABAJO.md) §5.
   - Ensayo en prod, después del de §2.6 (mismo pod, misma `mt.url`):
     ```sh
     kubectl exec -n prod $API -c api -- sh -c        'CARGA_URL="$DATABASE_URL_NEW" MT_DATABASE_URL="$(cat /tmp/mt.url)"         node /app/database/scripts/rh/carga-personas-mega-talento.js --destino-prod --informe=/tmp/rh-personas.json'
     kubectl cp prod/$API:/tmp/rh-personas.json ~/rh-personas-$(date +%Y%m%d-%H%M).json -c api   # listas para RH, con nombres
     ```
   - ⚠️ En el ensayo de prod la carga de checadas se deshizo, así que las personas se crean pero no hay enrolamientos
     que ligar (`enrolamientos_ligados: 0`). El número que importa ahí es `creadas` / `por_decidir`; el de ligados se
     ve en el corte. En local, `--con-cargas` corre todo en la misma transacción.
   - El informe trae nombres: **nunca al repo** (el guion se niega a escribirlo dentro de él).
3. RH: quien califica y cierra va en el rol `recursos_humanos` (`/admin/personas`); contabilidad ya tiene la
   auditoría por el reparto. Que entren una vez para confirmar que ven las pantallas (vacías).

### 2.6 Ensayo de la carga en prod

Fuera de horario. Escribe ~215 mil filas y **las deshace**.

```sh
kubectl cp ~/secrets/mt.url prod/$API:/tmp/mt.url -c api
kubectl exec -n prod $API -c api -- sh -c \
  'CARGA_URL="$DATABASE_URL_NEW" MT_DATABASE_URL="$(cat /tmp/mt.url)" \
   node /app/database/scripts/rh/carga-unica-mega-talento.js --destino-prod; rm -f /tmp/mt.url' \
  | tee ~/rh-ensayo-$(date +%Y%m%d-%H%M).txt
```

**Esperado** (medido contra la base local el 2026-10-07; en prod sólo crecen las checadas):

```
attendance_sites: 12 de 12
attendance_devices: 12 de 12          (+ 12 relojes desconocidos, uno por sitio)
device_enrollments: 1540 de 1540
attendance_logs: ~215,1xx de ~215,1xx · fuera: {"fecha_basura":3}
attendance_incidents: 99 · attendance_alerts: ~10,4xx
Listo en ~45 s · Ensayo: no quedó nada escrito.
```

Si aparece `ya_en_un_reloj_del_sitio` con un número grande, el destino ya traía esas checadas (ver §2.1, «datos
previos»): la carga no las duplica, pero hay que saber de dónde vinieron.

### 2.7 El lector de relojes en `md` (`[RH.1.3]`) — opcional para el corte, recomendado

El lector ya está en el monorepo (`database/importers/checadores/agente/`, el agente de Mega Talento sólo con el
origen `relojes`) y tiene su manifiesto: `ops/k3s/29-hr-relojes.deployment.yaml`. **Nace fuera del despliegue**
(`migracion: preparado-externo`): `ops/vl/deploy.sh` lo saltea hasta que un commit lo cambie a `migrado`.

⛔ **Un ZKTeco acepta UNA sola sesión TCP.** El pod y el servicio de la laptop nunca corren a la vez.

Antes del corte (David, en `md`):
1. **`[RH.0.3]` ¿`md` alcanza los relojes?** `ops/rh/medir-relojes.sh ping <IPs>` en cualquier momento;
   `ops/rh/medir-relojes.sh tcp <IPs>` **sólo fuera de horario** (abre y cierra el 4370 de cada reloj, sin comandos).
   Las IPs son las de `/rh/relojes`. Si algún reloj no contesta desde `md`, ese carril se queda en la laptop (opción A).
2. **El secreto** (una vez): `kubectl -n ingesta create secret generic hr-relojes-env --from-literal=HR_INGEST_KEY='<la de prod-env>'`.
3. La imagen `trade-ingest` del commit ya trae el agente y sus dependencias (`node-zklib` 1.3.0, `better-sqlite3`
   11.10.0, las mismas que corren hoy en la laptop): no hay nada que instalar.

---

## 3. El día del corte (sábado 7-nov, después de las 20:00)

| # | Quién | Paso | Cómo se verifica |
|---|---|---|---|
| 1 | Edgar | **Pre-vuelo** con Mega Talento (§2.3 + `MT_DATABASE_URL`) | Sin BLOQUEA. «padrón» puede seguir NO MEDIDO: todavía no hay carga |
| 2 | Edgar | **Carga real**: lo mismo que §2.6 con `--aplicar`. Guardar la salida | El cuadre coincide con el del ensayo (las checadas crecen un poco) |
| 3 | Edgar | **Ligar personas** (`[RH.1.4]`): el comando de §2.5 con `--aplicar`, y otra vez el pre-vuelo | «padrón» en OK o AVISO, **nunca BLOQUEA**; `por_decidir` del cuadre = lista para RH |
| 4 | David | **El lector → Suite.** Una de dos (ver §2.7):<br>**B (recomendada, lector en `md`):** (a) detener el servicio «Mega Talento Agente de Checadas» en `LapSistemasA` y dejarlo **deshabilitado** (no desinstalado: es la reversa); (b) copiar `cola.db`, `cola.db-wal` y `cola.db-shm` de `api\agente\` de la laptop a `md:/home/superoot/rh-relojes/datos/` — **con el servicio ya detenido** — para que el pod arranque con la marca de agua de cada reloj y lo pendiente, en vez de releer años de log; (c) commit que cambia `migracion: preparado-externo` → `migrado` en `29-hr-relojes.deployment.yaml` y desplegar.<br>**A (la elegida, lector en la laptop; guion `corte-lector.js` en la carpeta `corte-lector` de David):** (a) `probar`: la Suite responde 200 y trae los 12 relojes del padrón con `modo: agente` (si no, NO se corta); (b) `a-suite`: respalda `config.json.antes-corte` y cambia sólo la dirección (mismo token); (c) detener el servicio y `reenviar <hora de inicio de la carga del paso 2 − 1 h>` para cerrar el hueco entre la carga y el cambio; (d) arrancar el servicio | **B:** `kubectl -n ingesta logs deploy/hr-relojes` muestra «Relojes a cargo: …» y lotes aceptados, sin 401; el servicio de la laptop sigue detenido. **A:** su log muestra el respaldo inicial y respuestas 200, sin 401 |
| 5 | Edgar | **La ingesta late** | Salud BD: `hr_attendance_ingest` con latido reciente. `/rh/relojes`: los relojes «Al día» en ~10 min |
| 6 | David | **Mega Talento dejó de recibir** | En su base, `max(recibido_en)` de `checadas` se queda quieto |
| 7 | Edgar | **Encender el agente de alertas**: respaldo de `prod-env`; `ENABLE_HR_ATTENDANCE_AGENT=true` (mismo `patch` que §2.4); `kubectl -n prod rollout restart deploy/worker`. Mergear y soltar el PR de `CRON_JOBS` (§3.1) | En ≤30 min, `hr_attendance_agent` late en Salud BD |
| 8 | RH | Abre `/rh/asistencia` de dos sitios y compara la semana anterior contra Mega Talento | Mismos retardos, faltas y horas |
| 9 | David | Mega Talento: asistencia **de sólo lectura** (se avisa a quien captura incidencias: desde ahora, en la Suite) | — |

**El hueco entre el paso 2 y el 4 (corregido el 16-oct):** lo que llega a Mega Talento después de que arranca la carga
queda en la cola del lector como enviado y **no** se reenvía solo. Lo cierra el `reenviar <inicio de la carga − 1 h>`
del paso 4 A(c); la Suite descarta lo repetido (`ON CONFLICT` + el puente con el histórico). **Anotar la hora en que
arranca la carga real.** Ojo: al reiniciarse, los
respaldos de los 12 relojes **se escalonan a lo largo de la primera hora** (`backfillMin` 60, ver
`api/agente/reloj.js`). Lo de un reloj puede tardar hasta ~1 h en aparecer. Lo que se checa después del reinicio
llega al momento. Ni lo que la carga
dejó en el «reloj desconocido» ni lo que ya estaba entra dos veces (`[RH.1.8]`, puente con el histórico).

### 3.1 Las filas de `CRON_JOBS` (PR preparado de antemano, se mergea en el paso 7)

En `apps/api/src/modules/db-health/db-health.service.ts`, dentro de `CRON_JOBS`. Sin ellas los dos latidos salen
`unknown` («no está en CRON_JOBS: no se puede juzgar»):

```ts
// [RH.1.8] Relojes: la ingesta late con cada lote y con cada latido del agente (minutos, aunque nadie cheque).
// Una sola llave para los 12 relojes: un reloj caído NO la pone roja — eso lo dice el semáforo de /rh/relojes.
{ key: 'hr_attendance_ingest', label: 'Relojes checadores: entrada de checadas', cadence: 'continuo (latido del lector, ≤5 min)', warnH: 0.5, critH: 2 },
// [RH.1.5] Agente de alertas de asistencia, cada 30 min en el worker (ENABLE_HR_ATTENDANCE_AGENT).
{ key: 'hr_attendance_agent', label: 'Asistencia: agente de alertas', cadence: 'cada 30 min (worker)', warnH: 1.5, critH: 3 },
```

No se agregan antes: dos filas de jobs que todavía no corren pondrían el tablero en **amarillo** («DECLARADO Y NUNCA
REPORTÓ», `veredictoSinLatido`) hasta el corte, con alerta abierta por el escáner (sin correo: el correo es sólo
para `critical`). Si la ingesta ya hubiera latido alguna vez en prod y luego se callara, saldría **rojo**.

**Corregido el 2026-10-21 al preparar el PR:** las filas van **sin `maxRunH`**. Los dos laten con `latirCron`, que
escribe `ok`/`error` de una vez y nunca deja la fila en `running`, así que el tope de duración no se evaluaría jamás.
Las llaves y la cadencia se verificaron contra el código (`HR_INGEST_JOB_KEY`, `AGENT_JOB_KEY`,
`@Cron('0 */30 * * * *')`, `LATIDO_MS` 5 min del lector) y `db-health.spec.ts` lo exige.

---

## 4. Reversa

**Mientras la cola conserve lo enviado (30 días desde que se mandó)** (limpia, corregido el 16-oct):
1. David: si se usó **B**, primero `kubectl -n ingesta scale deploy/hr-relojes --replicas=0` (y devolver la etiqueta a
   `preparado-externo`, para que el siguiente deploy no lo reviva). En los dos casos, restaurar
   `config.json.antes-corte` (`corte-lector.js a-mega-talento`), **con el servicio detenido `reenviar <hora del corte −
   1 h>`** y arrancar el servicio. Sin el `reenviar`, Mega Talento se queda sin todo lo que pasó durante el corte.
2. Edgar: `ENABLE_HR_ATTENDANCE_AGENT=false` (o restaurar el respaldo de `prod-env`) y reiniciar el `worker`.
3. Las incidencias capturadas en la Suite durante ese tiempo se recapturan en Mega Talento:
   `GET /api/hr/attendance/incidents?site_code=…&date_from=…&date_to=…` las lista.
4. Lo cargado en la Suite **no se borra**: no estorba, y sirve para el siguiente intento (la carga es idempotente).

**Después de 30 días:** lo enviado ya salió de la cola; para reponerlo habría que releer el log completo de cada reloj.
Se arregla hacia adelante en la Suite.

---

## 5. Lo que este corte NO hace (y se declara)

- **El lector en `md` es opcional** (`[RH.1.3]`, opción B del paso 4). Si no se muda ese día, sigue en la laptop
  `LapSistemasA` (opción A) y se muda después con los mismos pasos. Si se muda sin copiar `cola.db`, el primer
  respaldo manda el buffer completo de cada reloj; la ingesta no lo duplica (probado con datos reales: 83,512
  checadas reenviadas de tres sitios, 0 nuevas), sólo tarda.
- **No toca reclutamiento ni el bot** (corte del 5-dic).
- **No apaga Mega Talento** (18-dic).
- **La cola de alertas de Mega Talento** se carga, pero nadie la ha decidido nunca (10,429 sugeridas, 0 decididas).
  Su pantalla en la Suite espera a que RH diga si la usa.
- **No mide prod.** Todo lo de arriba se probó contra la base local y contra Mega Talento real. Lo que diga el
  pre-vuelo en prod manda sobre este documento.
