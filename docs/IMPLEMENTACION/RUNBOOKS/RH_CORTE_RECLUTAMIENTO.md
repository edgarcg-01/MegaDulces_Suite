# Runbook — corte de reclutamiento y bot: Mega Talento → Suite (Fase RH, `[RH.3.5]`)

> **Para:** Edgar (prod, `md`) y David (Meta y Mega Talento). **Cuándo:** hoy, 10-nov-2026 (Edgar adelantó el corte,
> que estaba para el 5-dic). La preparación (§2) puede hacerse en el día; **la carga (§3) va fuera de horario**, después
> de las 19:00, porque escribe ~220 mil filas y sube 1.5 GB al bucket.
>
> ⛔ Este documento es público (el repo lo es): **ningún secreto se escribe aquí**, ni en un chat ni en un correo. Las
> llaves van de Meta a un archivo `600` en `md` y de ahí al secreto de prod.

> ⭐ **Atajo:** [`ops/prod/rh-corte-reclutamiento.sh`](../../../ops/prod/rh-corte-reclutamiento.sh) hace cada paso de
> este runbook con un subcomando (`numero`, `credenciales`, `ensayo`, `aplicar`, `archivos`, `verificar`), copia los
> scripts al mismo pod en que los corre y guarda la salida en `~/` de `md`. Este documento dice el porqué y la reversa.
>
> **Revisado en prod el 10-nov (sólo lectura):** `app_runtime` tiene `INSERT` en `talent.candidates`,
> `job_postings`, `candidate_stage_transitions`, `candidate_events`, `bot_conversations` y `whatsapp.messages`, y
> `UPDATE` donde la carga de archivos actualiza (`candidates`, `messages`). El RLS de todas es
> `tenant_id = current_tenant_id()`, que lee el mismo `app.tenant_id` que fija la carga. La fila del número sólo
> la puede escribir `postgres`.

Todo dato termina en la base de prod que ya existe (`md` / `pg-prod`, base `railway`): en `talent.*` y en
`whatsapp.messages`. No se copia la base de Mega Talento ni se crea otra.

---

## 0. Dónde estamos (medido en prod, sólo lectura, 10-nov 09:00)

| Qué | Medido | Qué significa |
|---|---|---|
| Base | `system_identifier = 7688376744939610156` | prod real (`md`/`pg-prod`) |
| API desplegada | `6a236ebf0` (de hoy) | ya trae el módulo de RH y el bot de reclutamiento |
| Migraciones del corte | las 7 aplicadas (`20261012155411` … `20261014141356`, `20261109110836`) | no hay que aplicar nada |
| Mensajes de reclutamiento en prod | 0 | la carga empieza de cero |
| `whatsapp.phone_number_tenant_map` | sólo el número de prueba de Ventas (`1256572530868591`, `commerce`) | ✅ **§2.3 hecho el 10-nov** (`numero`): `1202633676268668 · recruitment` |
| WhatsApp de Ventas en prod | 41 mensajes en total, el último del **27-jul**, 0 en 30 días | nadie lo usa: sus variables pueden pasar a RH (§1) |
| `GET /api/webhooks/whatsapp` con token falso | **403** | el webhook está montado y el proveedor es Meta (el simulador habría aceptado) |

**No viajan en la imagen de hoy** (están en commits locales sin empujar): los dos scripts de la carga y el cambio que
deja convivir dos apps de Meta (`147d09c0b`, `[RH.3.5c]`). Los scripts se copian al pod (§3.1), como en el corte de
asistencia. El cambio de las dos apps **no hace falta hoy**: ver §1.

---

## 1. La decisión que permite hacerlo hoy sin desplegar

El número de RH vive en la app de Meta **mega-dulces-rh**, distinta de la de Ventas. La imagen de hoy valida la firma
con **una sola** clave (`WHATSAPP_APP_SECRET`) y habla con **un solo** token (`WHATSAPP_ACCESS_TOKEN`).

Como el WhatsApp de Ventas no se usa desde julio, **esas dos variables pasan a ser las de RH**:

| Variable de `prod-env` | Hoy | Después del corte |
|---|---|---|
| `WHATSAPP_APP_SECRET` | clave de la app de Ventas (o vacía) | **clave de la app mega-dulces-rh** |
| `WHATSAPP_ACCESS_TOKEN` | token de Ventas (o vacío) | **token de `suite-reclutamiento`** |
| `WHATSAPP_VERIFY_TOKEN` | — | **debe existir** (si está vacío, Meta no puede verificar el webhook) |
| `WHATSAPP_PHONE_NUMBER_ID` | número de prueba de Ventas | no se toca (las respuestas de RH salen del número que recibió) |

**Lo que se pierde:** el número de prueba de Ventas deja de recibir y contestar. Cuando Ventas vuelva a usar WhatsApp,
se despliega `[RH.3.5c]` y las de RH se mueven a `WHATSAPP_RECRUITMENT_APP_SECRET`,
`WHATSAPP_RECRUITMENT_ACCESS_TOKEN` y `WHATSAPP_RECRUITMENT_PHONE_NUMBER_ID=1202633676268668`; las de Ventas vuelven a su
lugar.

---

## 2. Preparación (en el día; nada de esto toca a los candidatos)

```sh
ssh superoot@192.168.0.222
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
API=$(kubectl get pods -n prod -l app=api -o jsonpath='{.items[0].metadata.name}')
```

⚠️ Hay dos pods de `api`: copiar y ejecutar en el **mismo** `$API`, y recalcularlo después de cada reinicio.
⚠️ `-c api` siempre.

### 2.1 David: la clave y el token (su documento del 10-nov, §2 y §3)

- La **clave** de la app mega-dulces-rh se **copia**, no se restablece.
- El **token** es de un usuario de sistema nuevo, `suite-reclutamiento`: rol Empleado, sólo
  `whatsapp_business_messaging` y `whatsapp_business_management`, sin vencimiento. No sirve el de `bot-rh` (se revoca
  al apagar el bot) ni el de `Employee`.

### 2.2 Edgar y David: cargarlos en `prod-env`

```sh
# respaldo del secreto ANTES de tocarlo: es la reversa
kubectl -n prod get secret prod-env -o yaml > ~/secrets/prod-env.respaldo-$(date +%Y%m%d-%H%M).yaml
chmod 600 ~/secrets/prod-env.respaldo-*.yaml

# los valores, a archivos 600 creados vacíos (nunca echo, nunca en la línea de comandos)
install -m 600 /dev/null ~/secrets/wa-rh.secret && nano ~/secrets/wa-rh.secret   # clave de la app
install -m 600 /dev/null ~/secrets/wa-rh.token  && nano ~/secrets/wa-rh.token    # token de suite-reclutamiento

# huella para comparar entre los dos sin enseñar el valor
for f in ~/secrets/wa-rh.secret ~/secrets/wa-rh.token; do printf '%s' "$(cat $f)" | sha256sum | cut -c1-16; done

# ¿existe el token de verificación? (imprime sólo el largo)
kubectl -n prod get secret prod-env -o jsonpath='{.data.WHATSAPP_VERIFY_TOKEN}' | base64 -d | wc -c

kubectl -n prod patch secret prod-env --type merge -p "{\"stringData\":{\
\"WHATSAPP_APP_SECRET\":\"$(tr -d '\n' < ~/secrets/wa-rh.secret)\",\
\"WHATSAPP_ACCESS_TOKEN\":\"$(tr -d '\n' < ~/secrets/wa-rh.token)\"}}"
kubectl -n prod rollout restart deploy/api && kubectl -n prod rollout status deploy/api
```

Si el largo del token de verificación sale `0`, se agrega igual (archivo `600`, `patch`, reinicio) y Edgar se lo pasa a
David **por privado**: es el que David pone en Meta en §3.4.

**Prueba (no imprime ninguna llave)**. Recalcular `$API` después del reinicio:

```sh
API=$(kubectl get pods -n prod -l app=api -o jsonpath='{.items[0].metadata.name}')
# la clave: Meta debe contestar {"name":"mega-dulces-rh",...}
kubectl exec -n prod $API -c api -- node -e "fetch('https://graph.facebook.com/v21.0/1325462126340938?fields=name&access_token=1325462126340938%7C'+process.env.WHATSAPP_APP_SECRET).then(r=>r.text()).then(console.log)"
# el token: Meta debe contestar el +52 1 352 123 1708
kubectl exec -n prod $API -c api -- node -e "fetch('https://graph.facebook.com/v21.0/1202633676268668?fields=display_phone_number,verified_name',{headers:{Authorization:'Bearer '+process.env.WHATSAPP_ACCESS_TOKEN}}).then(r=>r.text()).then(console.log)"
```

### 2.3 Edgar: el número de RH a su flujo

Sin esta fila, los mensajes del número de RH se van al bot de **Ventas**, y la ingesta recuerda esa ruta hasta el
siguiente reinicio. Va **antes** de mover el webhook.

```sh
kubectl exec -n prod deploy/pg-prod -- psql -U postgres -d railway -v ON_ERROR_STOP=1 -c "
INSERT INTO whatsapp.phone_number_tenant_map (phone_number_id, tenant_id, label, flow)
VALUES ('1202633676268668', '00000000-0000-0000-0000-00000000d01c', 'Reclutamiento RH (+52 352 123 1708)', 'recruitment')
ON CONFLICT (phone_number_id) DO UPDATE SET flow = 'recruitment';
SELECT phone_number_id, flow, label FROM whatsapp.phone_number_tenant_map;"
```

---

## 3. El corte (hoy, después de las 19:00)

**Antes de empezar:** RH deja de capturar en Mega Talento. Lo que se haga en Mega Talento después de §3.3 **no llega a
la Suite**: la carga no actualiza lo que ya cargó, sólo agrega lo nuevo.

### 3.1 Los scripts y la URL de Mega Talento, al pod

```sh
# desde la laptop, en la raíz del repo (los scripts todavía no están en la imagen)
scp database/scripts/rh/carga-reclutamiento-mega-talento.js database/scripts/rh/carga-archivos-mega-talento.js \
    superoot@192.168.0.222:/tmp/
```

```sh
# en md
API=$(kubectl get pods -n prod -l app=api -o jsonpath='{.items[0].metadata.name}')
kubectl cp /tmp/carga-reclutamiento-mega-talento.js prod/$API:/app/database/scripts/rh/ -c api
kubectl cp /tmp/carga-archivos-mega-talento.js     prod/$API:/app/database/scripts/rh/ -c api
kubectl cp ~/secrets/mt.url prod/$API:/tmp/mt.url -c api      # el mismo archivo del corte de asistencia
```

Si `~/secrets/mt.url` ya no existe, se crea como en el runbook de asistencia: `install -m 600 /dev/null
~/secrets/mt.url && nano ~/secrets/mt.url`.

### 3.2 Ensayo de la carga en prod (escribe y deshace)

```sh
kubectl exec -n prod $API -c api -- sh -c \
  'CARGA_URL="$DATABASE_URL_NEW" MT_DATABASE_URL="$(cat /tmp/mt.url)" \
   node /app/database/scripts/rh/carga-reclutamiento-mega-talento.js --con-bot --destino-prod' \
  | tee ~/rh-reclutamiento-ensayo-$(date +%Y%m%d-%H%M).txt
```

**Esperado** (ensayo contra la base local, 9-nov; en prod sólo crecen un poco):
mensajes ~220,9xx de ~220,9xx · conversaciones ~2,7xx (≈1,580 `postulada`, el resto a medias) · **0 rechazados** ·
~1 min · «no quedó nada escrito».

**Se detiene aquí si:** sale `permission denied` (el usuario del pod no puede escribir en `talent.*`), o los rechazados
no son 0, o los números se alejan mucho de lo esperado. En ese caso se manda la salida completa a revisar, sin
`--aplicar`.

### 3.3 La carga de verdad

```sh
kubectl exec -n prod $API -c api -- sh -c \
  'CARGA_URL="$DATABASE_URL_NEW" MT_DATABASE_URL="$(cat /tmp/mt.url)" \
   node /app/database/scripts/rh/carga-reclutamiento-mega-talento.js --con-bot --destino-prod --aplicar' \
  | tee ~/rh-reclutamiento-aplicado-$(date +%Y%m%d-%H%M).txt
```

### 3.4 David: el webhook a la Suite, **en cuanto termine §3.3**

Se mueve antes de los archivos a propósito: cada minuto que el bot de Railway sigue contestando es una conversación que
avanza allá y no aquí.

- App **mega-dulces-rh** → WhatsApp → Configuración → Webhook:
  - URL: `https://megadulcessuite.com/api/webhooks/whatsapp`
  - token de verificación: el de la Suite (§2.2).
  - Campo suscrito: `messages`.
- Prueba: un «hola» al +52 352 123 1708 desde un celular que **no** sea de un candidato. Tiene que contestar el bot
  de la Suite. Si no contesta, se aplica la reversa (§5) y se revisa con calma.

### 3.5 Repetir la carga (lo que entró mientras se movía el webhook)

El mismo comando de §3.3. Es idempotente: sólo agrega mensajes y candidatos nuevos. En una segunda corrida, lo que ya
estaba aparece como `ya_estaban`.

### 3.6 Los archivos al bucket (~15–20 min, ~1.5 GB)

```sh
kubectl exec -n prod $API -c api -- sh -c \
  'CARGA_URL="$DATABASE_URL_NEW" node /app/database/scripts/rh/carga-archivos-mega-talento.js --destino-prod --aplicar' \
  | tee ~/rh-archivos-$(date +%Y%m%d-%H%M).txt
kubectl exec -n prod $API -c api -- rm -f /tmp/mt.url
```

Usa el bucket del pod (las mismas variables `S3_*` que la API), y antes de bajar nada prueba que el bucket acepte un
objeto. **Esperado:** ≈6,250 ligas (5,806 del ensayo del 9-nov más las 440 que David dio de alta), ≈33 caídas (404,
se quedan con su liga). Esta cifra **no está medida** con las 440 nuevas: la medición es esta corrida.

### 3.7 Verificar (sólo lectura)

- En la Suite: Reclutamiento muestra los candidatos, y la ficha de uno con CV abre el archivo.
- El «hola» de §3.4 está en `whatsapp.messages` con `flow = 'recruitment'`.
- Se guardan los tres `.txt` de `~/` en `md`: son el acta del corte.

---

## 4. Después del corte

| Qué | Quién | Cuándo |
|---|---|---|
| Railway en sólo lectura | David | 2 semanas, luego se apaga |
| Revocar el token de `bot-rh`, revisar el usuario `Employee` | David | al apagar Railway |
| Rotar la contraseña de la base de Mega Talento | David | al apagar Railway (`[RH.4]`) |
| El …2222: si es prueba, se marca como spam en la Suite (se cargó igual) | RH / Edgar | cuando se confirme |
| Desplegar `[RH.3.5c]` y separar las variables de RH de las de Ventas | Edgar | antes de que Ventas vuelva a usar WhatsApp |

---

## 5. Reversa

1. David: el webhook de mega-dulces-rh vuelve a la URL del bot de Railway. El bot sigue vivo y con sus datos.
2. Edgar: si hace falta, restaurar el respaldo de `prod-env` (§2.2) y reiniciar `api`.
3. Lo cargado en la Suite **no se borra**: no estorba y sirve para el siguiente intento.
4. Los mensajes que recibió la Suite mientras tuvo el webhook **no están en Mega Talento**: se consultan en
   `whatsapp.messages` (`flow = 'recruitment'`).
