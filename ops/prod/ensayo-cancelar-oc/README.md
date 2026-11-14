# Ensayo de «cancelar OC» contra el Kepler vivo (`[PQ.110]`)

Corre el `KeplerOcCancelAdapter` **real** contra Kepler y **no escribe nada**. Las lecturas son las de
verdad, con el mismo candado `FOR UPDATE NOWAIT`. El único paso que escribe, `confirmar`, se cambia por
lo siguiente:

1. Copia a tablas temporales las filas que la cancelación tocaría.
2. Corre sobre esas copias las mismas sentencias (`sentenciasCancelacion`).
3. Revisa el resultado contra lo que Kepler escribe al cancelar (anexo PQ §3c).
4. Le pregunta a Kepler si `kepler_push` tiene cada permiso que haría falta.
5. Hace `ROLLBACK`.

Mismo modelo que [`../ensayo-pago-kepler/`](../ensayo-pago-kepler/README.md): corre desde `md`, porque
Kepler sólo acepta a `kepler_push` desde ahí. Se empaqueta en un solo archivo y corre en un contenedor
que se borra al terminar.

## Cómo se corre

```bash
node ops/prod/ensayo-cancelar-oc/empaquetar.js /tmp/ensayo-cancelar-oc.cjs
scp /tmp/ensayo-cancelar-oc.cjs superoot@192.168.0.222:/tmp/ensayo-cancelar-oc-pq110.cjs
{ echo "$KEPLER_PUSH_URL_08"; echo '{"sucursal":"08","folios":["0000393","0000236","0000338"]}'; } \
  | ssh superoot@192.168.0.222 'docker run --rm -i --network host -v /tmp/ensayo-cancelar-oc-pq110.cjs:/e.cjs:ro mirror.gcr.io/library/node:22-alpine node /e.cjs'
ssh superoot@192.168.0.222 'rm -f /tmp/ensayo-cancelar-oc-pq110.cjs'
```

Cómo leer la salida:
- **Verde:** `fallas: []` en cada folio y `control.intacta: true`. El control compara el estado y el
  total de la OC real antes y después: tiene que ser idéntico.
- ⚠️ El adaptador escribe en su log «cancelada en Kepler» porque no sabe que es un ensayo. **Lo que vale es
  el control.**
- Elige los casos en el ODS: una OC en N sin vale y con requisición, una sin requisición, y una con vale
  vivo (esta debe salir **rechazada**).
- `[KR.7]` Para requisiciones, `{"sucursal":"08","requisiciones":["…"]}`: una en A o N sin OC viva (debe
  quedar como el testigo y su `candado` decir «0 filas (bien)») y una con OC viva (debe salir **rechazada**).

## Resultado

| Fecha | Servidor | Resultado |
|---|---|---|
| 2026-11-13 | 08 | **0000393** (con requisición 0000087, 4 renglones): las 4 sentencias afectan lo esperado, la OC queda como Kepler la deja y la requisición se reabre (A, `c42` = `c16`, `c24` = `c9`). **Falta `UPDATE (c24)` en `md.kdm2`**. **0000236** (sin requisición, 20 renglones): verde, con todos los permisos. **0000338** (con vale 0000533): rechazada con su motivo. Control: las 3 OC intactas. |
| 2026-11-14 | 08 | **`[KR.7]` requisiciones** (`"requisiciones": [...]` en el JSON): **0000064** y **0000077** (reabiertas en A porque su OC se canceló a mano; 4 y 1 renglones) quedan en las copias como el testigo de CEDIS 0003143 (C, `c13`–`c16` y `c42` en 0, `c67`–`c69`, sin renglones); **prueba negativa del candado** —se revive su OC copiada en un savepoint—: la cabecera afecta **0 filas**; los 10 permisos en true. **0000087** (con su OC 0000393 viva): rechazada con su motivo. Control: las 3 intactas. El empaquetador necesitaba el alias de `@megadulces/contracts` (desde el 13 la regla importa `OC_CANCELAR_MOTIVO_MIN`). |
| 2026-11-13 (tarde) | 08 | Después de aplicar `UPDATE (c24)` en los 6: los mismos 3 folios, **los 11 permisos en true**, `fallas: []` en los 3, 0000393 y 0000236 «cancelada» (sólo en el ensayo), 0000338 rechazada por su vale. Control: las 3 OC intactas (estado N y total idénticos antes y después). |
