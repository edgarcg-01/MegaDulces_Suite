# Runbook — corte de asistencia: Mega Talento → Suite (Fase RH, `[RH.1.8]`)

> **Quién:** Edgar (prod en `md`), David (agente de relojes y Mega Talento), RH (valida y empieza a usarlo).
> **Cuándo:** sábado **7-nov-2026**, fuera de horario hábil (después de las 20:00). La semana de nómina corre de jueves a
> miércoles: la semana del 5 al 11 de noviembre queda mitad en Mega Talento y mitad en la Suite, y la carga trae todo.
> **Escrito el 2026-10-07** con los guiones ya probados contra la base local y contra Mega Talento real (sólo lectura).
> Nada de esto se ha corrido contra prod todavía: desde la máquina de trabajo no hay acceso a `md`.

---

## 0. Las reglas que no se negocian

1. **Nada se borra de Mega Talento.** Su asistencia queda de sólo lectura dos semanas después del corte.
2. **La reversa limpia dura 36 horas.** El agente reenvía las últimas 36 h en cada respaldo. Si se regresa a Mega
   Talento dentro de ese plazo, no falta nada. Después de 36 h, regresar deja un hueco: se arregla hacia adelante.
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
   20261007300000_hr_incidencias_y_cierres.js
   20261007310000_hr_agente_corridas.js
   20261007320000_hr_ordenes_quien.js
   20261007330000_hr_reparto_asistencia.js  ← reparte las claves de RH (ver §2.5)
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
y `worker`. **Una llave nueva**, no la de Mega Talento.

```sh
# en md: respaldo del secreto ANTES de tocarlo (es la reversa)
kubectl -n prod get secret prod-env -o yaml > ~/secrets/prod-env.respaldo-$(date +%Y%m%d-%H%M).yaml
chmod 600 ~/secrets/prod-env.respaldo-*.yaml
# la llave, a un archivo (no a la pantalla ni al historial)
install -m 600 /dev/null ~/secrets/hr-ingest.key && openssl rand -hex 32 > ~/secrets/hr-ingest.key
kubectl -n prod patch secret prod-env --type merge \
  -p "{\"stringData\":{\"HR_INGEST_KEY\":\"$(cat ~/secrets/hr-ingest.key)\"}}"
kubectl -n prod rollout restart deploy/api && kubectl -n prod rollout status deploy/api
```

Pasarle la llave a David **por un canal privado**: nunca en el repo, un chat de grupo ni un correo.
Verificar: el pre-vuelo dice «HR_INGEST_KEY presente».

### 2.5 Las personas: `[RH.1.4]` es prerrequisito, no «después»

⛔ **Sin esto el corte no cuadra con Mega Talento.** La paridad de 0 diferencias (1,464 personas, 5,464 días) se
midió **con las personas ligadas**. Sin ficha, una persona sólo aparece si checó, y se pierden tres cosas:
- la **falta** de quien no vino en toda la semana;
- el corte **planta / promotoras** (sale del departamento);
- la exclusión de las **bajas**.

Medido con datos reales: tras la carga hay **991 enrolamientos activos y 0 ligados** → el pre-vuelo da **BLOQUEA**.

Antes del corte:
1. RH valida los mapeos de empleados (`[RH.0.4]`).
2. Se crean o enlazan las personas en `identity.users` y se ligan sus enrolamientos (`[RH.1.4]`). **El guion todavía
   no existe**: es el siguiente trabajo de esta fase y depende del paso 1.
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

---

## 3. El día del corte (sábado 7-nov, después de las 20:00)

| # | Quién | Paso | Cómo se verifica |
|---|---|---|---|
| 1 | Edgar | **Pre-vuelo** con Mega Talento (§2.3 + `MT_DATABASE_URL`) | Sin BLOQUEA. «padrón» puede seguir NO MEDIDO: todavía no hay carga |
| 2 | Edgar | **Carga real**: lo mismo que §2.6 con `--aplicar`. Guardar la salida | El cuadre coincide con el del ensayo (las checadas crecen un poco) |
| 3 | Edgar | **Ligar personas** (`[RH.1.4]`) y otra vez el pre-vuelo | «padrón» en OK o AVISO, **nunca BLOQUEA** |
| 4 | David | **Agente → Suite** (en `LapSistemasA`): copiar `config.json` a `config.json.antes-corte`; en `config.json` poner `apiUrl = https://megadulcessuite.com/api/hr/attendance/ingest/mt` y `token = <HR_INGEST_KEY>`; reiniciar el servicio «Mega Talento Agente de Checadas» | Su log muestra el respaldo inicial («backfill … nuevas a la cola») y respuestas 200, sin 401 |
| 5 | Edgar | **La ingesta late** | Salud BD: `hr_attendance_ingest` con latido reciente. `/rh/relojes`: los relojes «Al día» en ~10 min |
| 6 | David | **Mega Talento dejó de recibir** | En su base, `max(recibido_en)` de `checadas` se queda quieto |
| 7 | Edgar | **Encender el agente de alertas**: respaldo de `prod-env`; `ENABLE_HR_ATTENDANCE_AGENT=true` (mismo `patch` que §2.4); `kubectl -n prod rollout restart deploy/worker`. Mergear y soltar el PR de `CRON_JOBS` (§3.1) | En ≤30 min, `hr_attendance_agent` late en Salud BD |
| 8 | RH | Abre `/rh/asistencia` de dos sitios y compara la semana anterior contra Mega Talento | Mismos retardos, faltas y horas |
| 9 | David | Mega Talento: asistencia **de sólo lectura** (se avisa a quien captura incidencias: desde ahora, en la Suite) | — |

**Por qué no falta nada entre el paso 2 y el 4:** lo que llegó a Mega Talento después de la carga lo reenvía el
agente en su respaldo (desde su marca menos 36 h), y la Suite descarta lo repetido. Ojo: al reiniciarse, los
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
{ key: 'hr_attendance_ingest', label: 'Relojes checadores: entrada de checadas', cadence: 'continuo (latido del agente)', warnH: 0.5, critH: 2, maxRunH: 0.1 },
// [RH.1.5] Agente de alertas de asistencia, cada 30 min en el worker (ENABLE_HR_ATTENDANCE_AGENT).
{ key: 'hr_attendance_agent', label: 'Asistencia: agente de alertas', cadence: 'cada 30 min', warnH: 1.5, critH: 3, maxRunH: 0.5 },
```

No se agregan antes: dos filas de jobs que todavía no corren pondrían el tablero en rojo una semana.

---

## 4. Reversa

**Dentro de las primeras 36 horas** (limpia):
1. David: restaurar `config.json.antes-corte` y reiniciar el servicio. El agente reenvía las últimas 36 h a Mega
   Talento, así que no le falta nada.
2. Edgar: `ENABLE_HR_ATTENDANCE_AGENT=false` (o restaurar el respaldo de `prod-env`) y reiniciar el `worker`.
3. Las incidencias capturadas en la Suite durante ese tiempo se recapturan en Mega Talento:
   `GET /api/hr/attendance/incidents?site_code=…&date_from=…&date_to=…` las lista.
4. Lo cargado en la Suite **no se borra**: no estorba, y sirve para el siguiente intento (la carga es idempotente).

**Después de 36 horas:** Mega Talento tiene un hueco que el agente ya no rellena. No hay reversa limpia: se arregla
hacia adelante en la Suite.

---

## 5. Lo que este corte NO hace (y se declara)

- **No muda el lector de relojes al servidor** (`[RH.1.3]`): sigue en la laptop `LapSistemasA`. Cuando se mude, el
  primer respaldo manda el buffer completo; la ingesta ya no lo duplica (probado con datos reales: 83,512 checadas
  reenviadas de tres sitios, 0 nuevas).
- **No toca reclutamiento ni el bot** (corte del 5-dic).
- **No apaga Mega Talento** (18-dic).
- **La cola de alertas de Mega Talento** se carga, pero nadie la ha decidido nunca (10,429 sugeridas, 0 decididas).
  Su pantalla en la Suite espera a que RH diga si la usa.
- **No mide prod.** Todo lo de arriba se probó contra la base local y contra Mega Talento real. Lo que diga el
  pre-vuelo en prod manda sobre este documento.
