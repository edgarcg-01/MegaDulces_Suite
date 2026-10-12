# Lector de relojes checadores (Fase RH · `[RH.1.3]`)

El agente de Mega Talento (`mega-talento-90/api/agente` @ e8a2ad3) traído a la Suite, **sólo con el origen
`relojes`**: lee los ZKTeco por TCP 4370 y empuja a la entrada compatible de la Suite
(`/api/hr/attendance/ingest/mt/checador/ingesta…`, `[RH.1.2b]`). Corre como carril del namespace `ingesta`
en `md`: [`ops/k3s/29-hr-relojes.deployment.yaml`](../../../../ops/k3s/29-hr-relojes.deployment.yaml).

⛔ **Un ZKTeco acepta UNA sola sesión TCP.** Este lector y el servicio de Windows de la laptop nunca corren a la
vez. El manifiesto nace fuera del despliegue (`migracion: preparado-externo`) y se enciende en el corte:
[`RH_CORTE_ASISTENCIA`](../../../../docs/IMPLEMENTACION/RUNBOOKS/RH_CORTE_ASISTENCIA.md) §2.7 y paso 4.

## Lo que cambió contra el original

| Original (Mega Talento) | Aquí |
|---|---|
| `config.json` (apiUrl, token) | Entorno: `HR_AGENT_API_URL`, `HR_INGEST_KEY`, `HR_AGENT_DATA_DIR`… (ver `config.js`) |
| Origen `hr` (leía la base del proveedor) u origen `relojes` | Sólo `relojes`. El sistema del proveedor dejó de existir el 21-ago-2026 |
| Servicio de Windows (`node-windows`) | Pod de k3s: el kubelet lo levanta si sale |
| Log a archivo con rotación | stdout (k8s / dozzle) |
| `cola.db` y `padron.json` junto al código | En `HR_AGENT_DATA_DIR` (hostPath en `md`) |

Lo demás —el protocolo, la cola, la marca de agua, el descubrimiento por serie, las órdenes al reloj— es el
código de Mega Talento sin cambios de comportamiento (sólo ajustes de lint que no alteran nada).

Correrlo a mano (sin relojes alcanzables no toca ninguno: la lista viene de la API):

```sh
HR_AGENT_API_URL=http://localhost:3000/api/hr/attendance/ingest/mt HR_INGEST_KEY=… node database/importers/checadores/agente/index.js --una-vez
```

---

_Lo que sigue es el README original de Mega Talento: explica **por qué** cada pieza es como es. Lo del origen
`hr` y del servicio de Windows es historia (ver la tabla de arriba)._

## Las piezas

| Archivo | Qué resuelve |
|---|---|
| `index.js` | arranque, config, elige origen, mantenimiento, apagado limpio |
| `origen-hr.js` | el "trigger" de 30 s contra `hr.attendance_logs` |
| `reloj.js` | modo `relojes`: stream en vivo + backfill horario sobre UNA sesión |
| `descubrir.js` | encuentra un reloj por SERIE cuando el DHCP le movió la IP |
| `cola.js` | cola local SQLite: un corte de internet no cuesta checadas |
| `enviar.js` | el único punto que habla con la nube, con backoff |
| `instalar-servicio.js` | servicio de Windows (arranque automático, reinicio) |

---

## Decisiones que parecen raras y no lo son

**Todo se escribe primero a la cola y después se manda.** Al revés (mandar, y
guardar solo si falla) parece equivalente: si el proceso muere entre el evento y
el envío, esa marca no existió nunca y no hay forma de saber que faltó. Con la
cola, el peor caso es mandarla dos veces, y eso la API lo ignora por dedup.

**La marca de agua va sobre `punched_local`, no sobre `imported_at`.** Medido el
17/08/2026: las 129,477 filas del origen tenían `imported_at` de los últimos 3
minutos — ese sistema la reescribe en cada resincronización. Usarla significaría
releer la tabla entera en cada vuelta. A cambio, `punched_local` no ve las
importaciones tardías, y por eso hay dos redes: traslape de 10 min en cada
vuelta, y una pasada de 7 días cada hora.

**La hora se pide a Postgres ya formateada como texto.** `punched_local` es
`timestamp without time zone` y node-pg lo convertiría a `Date` usando la zona
de **la máquina que corre el agente**. Si esa PC estuviera en otra zona —o
cambiara el horario de verano— todas las checadas se recorrerían en silencio.
Pidiendo `to_char(...)` no hay conversión que se pueda equivocar.

**Una vuelta a la vez.** El `setInterval` de 30 s no sabe cuánto tarda la
anterior, y la primera —recuperando el histórico— tarda minutos. Sin candado se
encimarían.

**Un lote vacío también se manda.** Es el latido. Un reloj sin checadas a las
3 de la tarde puede ser "nadie ha checado" o "lleva 6 horas muerto", y la
pantalla tiene que poder distinguirlos.

**Los relojes en pausa no se sincronizan.** `192.168.0.81` (numeración propia sin
traducir) y `192.168.0.196` (sin identificar). Sus marcas se atribuirían a la
persona o a la plaza equivocada, y eso no se nota mirando la pantalla.

**Un 409 o un 202 no se reintentan.** La API ya guardó el lote crudo en
`ingesta_lotes`; el dato no se perdió. Reintentar solo llenaría esa tabla de
copias.

---

## El agente NO tiene `DATABASE_URL`

Solo `apiUrl` + `token`. Antes cada PC de sucursal tenía el string de conexión de
producción en un archivo de texto. Quitarlo era parte del objetivo.
