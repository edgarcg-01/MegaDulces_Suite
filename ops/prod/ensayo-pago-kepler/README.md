# Ensayo del pago `X-D-26` contra el Kepler vivo (`[PGP.71]`)

Corre el `KeplerPagoSinkAdapter` **real** contra Kepler y termina en `ROLLBACK`: no escribe nada.
El único paso que escribe (`confirmar`) se cambia por revisar las tablas temporales.

**Por qué desde `md`:** `pg_hba.conf` de Kepler sólo acepta al usuario `kepler_push` desde el servidor
`md`. En `md` no hay `node` ni el repo, así que el ensayo se empaqueta en un solo archivo y corre en un
contenedor que se borra al terminar. En el sistema de `md` no se instala nada; sólo queda la imagen
`mirror.gcr.io/library/node:22-alpine` (de `mirror.gcr.io` porque Docker Hub ya rompió builds).

## Cómo se corre

1. Empaquetar en la máquina de trabajo (el archivo no lleva credenciales):
   ```bash
   node ops/prod/ensayo-pago-kepler/empaquetar.js /tmp/ensayo-pago.cjs
   scp /tmp/ensayo-pago.cjs superoot@192.168.0.222:/tmp/ensayo-pago-pgp71.cjs
   ```
2. Elegir una factura abierta real (`kdxe` con `c3='A'`, `c20 > 0`, concepto `C-…`) del ODS.
3. Correrlo. La conexión entra por la **entrada estándar**, nunca en la línea de comandos:
   ```bash
   { echo "$KEPLER_PUSH_URL_00"; echo '{"sucursal":"00","plantilla":"0023768","acreedor":"<C…>","aplicado":<saldo>,"factura":{"tipo":20,"subtipo":1,"folio":"<folio>"},"origen":{"bank":"BBVA","account_label":"4176"}}'; } \
     | ssh superoot@192.168.0.222 'docker run --rm -i --network host -v /tmp/ensayo-pago-pgp71.cjs:/e.cjs:ro mirror.gcr.io/library/node:22-alpine node /e.cjs'
   ssh superoot@192.168.0.222 'rm -f /tmp/ensayo-pago-pgp71.cjs'
   ```
4. Leer la salida. `fallas: []` y `revisado` con las cuatro tablas es verde. La última línea es el
   **control**: los documentos con la referencia `ENSAYO-PGP71` en Kepler tienen que ser **0**. Si no
   lo son, sale con código 2 y hay que avisar a quien administra Kepler.

## Qué tablas toca Kepler al capturar (las 360)

`foto-contadores.js` lee los contadores de Postgres de todas las tablas de `md` (el ODS sólo replica 242).
Protocolo: `foto 00 > antes.json` → Tesorería captura UN pago en Kepler → `foto 00 > despues.json` →
`comparar antes.json despues.json`. Lo que otra persona capture en esa ventana también sale: ventana corta y cruzar
contra los documentos nuevos de `kdm1`.

## Resultado

| Fecha | Resultado |
|---|---|
| 2026-11-04 | Corre de punta a punta en `md`. Lee el acreedor (`kdxd`) y se detiene en «permiso denegado a la tabla kdb1»: faltan los `GRANT` (ver `FASE_PGP_PAGO_A_PROVEEDOR.md` §4). Control: 0 documentos. |
| 2026-11-13 | `[PGP.106]` **Verde**, con las 8 escrituras: documento, `kdm5`, póliza E de noviembre cuadrada y los 13 permisos que pide escribir de verdad (`has_*_privilege`). Control: 0 documentos. El primer intento cayó en «permiso denegado a la tabla kdc22610» (la póliza de la plantilla, de octubre): el permiso es tabla por mes. |
