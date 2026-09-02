# apps/tienda — Tienda mayorista (Fase CV)

Frontend Angular del checkout transaccional real de `catalogo-kp` (carrito →
checkout → seguimiento de pedido, contra `/api/tienda/*`). Sin login — compra
de invitado, igual que `tienda.html` (que sigue viva sin tocarse en
`apps/catalogo-kp/public/tienda.html`, hasta que 0Sistemas decida retirarla).

Detalle completo, decisiones y contratos de backend en
[`FASE_CV_CATALOGO_TIENDA_MAYOREO.md`](../../docs/IMPLEMENTACION/FASES/FASE_CV_CATALOGO_TIENDA_MAYOREO.md).

## Por qué no se despliega solo

`catalogo-kp` corre **on-prem** (no Railway, ver principio P1 de la fase) y
hoy no tiene dominio público. Este app se compila y su build se copia a
`apps/catalogo-kp/public/tienda/` — el mismo proceso NestJS de `catalogo-kp`
lo sirve como estático, mismo origen que su API, sin CORS ni exposición
nueva.

## Desarrollo local

```bash
nx serve tienda   # proxya /api a http://localhost:3000 (ver proxy.conf.json)
```

Requiere `catalogo-kp` corriendo en ese puerto (con `DATABASE_URL_KP_CONCENTRADA`
apuntando a `KP_CONCENTRADA` — real, no hay alternativa Docker).

## Build y despliegue (manual, hasta que exista un script)

```bash
nx build tienda
rm -rf apps/catalogo-kp/public/tienda
cp -r dist/apps/tienda/browser apps/catalogo-kp/public/tienda
nx build catalogo-kp
```

El nombre de la carpeta (`public/tienda/`) tiene que coincidir exactamente
con `<base href="/tienda/">` del `index.html` compilado — si se renombra,
hay que actualizar ambos. `apps/catalogo-kp/src/main.ts` sirve el fallback de
SPA para `/tienda/*` (rutas de Angular como `/tienda/carrito`) con un
`app.use()` de Express plano — **no** `setGlobalPrefix('api', { exclude })`,
que comparte el bug conocido de Express 5 + `path-to-regexp` que ya retiró
`ServeStaticModule` de esta Suite (ver comentario en el propio `main.ts`).

`apps/catalogo-kp/public/tienda/` está en `.gitignore` — es un artefacto de
build (nombres de archivo con hash), no se versiona.
