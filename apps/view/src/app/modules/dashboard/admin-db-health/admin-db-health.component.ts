import { ChangeDetectionStrategy, Component, DestroyRef, NgZone, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { encuestarVisible, PararEncuesta } from '../../../core/utils/poll-visible';
import { CommonModule } from '@angular/common';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { DbHealthService, DbHealthReport, HealthStatus, SourceHealth, HealthAlert, EngineReport, VersionReport } from './db-health.service';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';

type Sev = 'success' | 'warn' | 'danger' | 'secondary';

@Component({
  selector: 'app-admin-db-health',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TableModule, TagModule, ButtonModule, FreshnessPillComponent],
  template: `
    <div class="page">
      <header class="page-head">
        <div class="ttl">
          <h1>Salud de la base de datos</h1>
          <span class="sub">
            Frescura de las fuentes críticas · base <strong>{{ report()?.db_label || '—' }}</strong>
          </span>
        </div>
        <div class="actions">
          @if (report(); as r) {
            <app-freshness-pill measures="data" [since]="r.checked_at" label="verificado" [staleAfterSec]="300" />
            <p-tag [severity]="sev(r.overall)" [value]="'Global: ' + statusLabel(r.overall)" [rounded]="true" />
          }
          <button pButton type="button" [loading]="scanning()" (click)="scan()" size="small" class="p-button-outlined"><span class="p-button-icon p-button-icon-left pi pi-bolt" aria-hidden="true"></span><span class="p-button-label">Escanear ahora</span></button>
          <button pButton type="button" [loading]="loading()" (click)="load()" size="small"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Refrescar</span></button>
          <button pButton type="button" (click)="toggleAuto()" size="small" [class.p-button-outlined]="!auto()" [title]="auto() ? 'Auto-refresco cada 60s activo' : 'Auto-refresco pausado'"><span class="p-button-icon p-button-icon-left pi" [class.pi-pause]="auto()" [class.pi-play]="!auto()" aria-hidden="true"></span><span class="p-button-label">{{ auto() ? 'Auto 60s' : 'Manual' }}</span></button>
        </div>
      </header>

      <!-- [DH.5] Lo que pasó con un botón se dice: antes un escaneo o un «visto» fallido no decía nada. -->
      @if (actionMsg(); as m) {
        <div class="banner" [class.err]="m.bad" role="status">
          <i class="pi" [class.pi-exclamation-triangle]="m.bad" [class.pi-check]="!m.bad" aria-hidden="true"></i>
          {{ m.text }}
        </div>
      }

      <!-- [VL.15.E] QUÉ VERSIÓN CORRE. Va primero porque es la pregunta que se hace antes que
           cualquier otra cuando algo no cuadra: "¿ya subió mi cambio?". Antes vivía en una
           terminal (deploy.sh --estado) y en un JSON crudo (/api/health).
           ⚠️ SIN acentos graves acá: este HTML vive dentro de un template literal de TS y un
           acento grave lo TERMINA. Es la sexta vez que este repo lo paga. -->
      @if (version(); as v) {
        <section class="version">
          <div class="vnow">
            <span class="vlbl">Corriendo en producción</span>
            <code class="vsha">{{ v.corriendo.commit }}</code>
            <span class="vup">arriba desde hace {{ tiempoHumano(v.corriendo.uptime_seconds) }}</span>
          </div>
          <!-- [DH.5] Se compara contra el latido de auto-deploy.sh, que es el carril que despliega
               desde k3s. Antes se comparaba contra la bitácora de deploy.sh, parada el 1-oct, y el
               aviso de "contenedor levantado por fuera" salía en cada despliegue sano. -->
          @if (v.latido; as l) {
            <p class="vnota" [class.warn]="l.coincide === false || l.status !== 'ok'">
              <i class="pi" [class.pi-info-circle]="l.coincide !== false && l.status === 'ok'" [class.pi-exclamation-triangle]="l.coincide === false || l.status !== 'ok'" aria-hidden="true"></i>
              <span>
                Despliegue automático, último paso {{ l.at ? (l.at | date: 'dd/MM HH:mm') : 'sin fecha' }}:
                {{ l.note || l.status }}.
                @if (l.coincide === false) {
                  <strong>No es lo que corre ({{ v.corriendo.commit }}): manda lo que corre.</strong>
                }
              </span>
            </p>
          } @else {
            <p class="vnota warn"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
              No hay latido del despliegue automático: no se puede comparar lo que corre con lo último desplegado.</p>
          }
          @if (v.bitacora_disponible && v.despliegues.length) {
            <details class="det">
              <summary>Bitácora de despliegues manuales (deploy.sh) · el más reciente es del {{ v.despliegues[0].desplegado_en | date: 'dd/MM/yyyy' }}</summary>
            <table class="vtab">
              <thead><tr><th>Cuándo</th><th>Versión</th><th>Servicios</th><th>Resultado</th><th>Mig.</th><th>Quién</th></tr></thead>
              <tbody>
                @for (d of v.despliegues.slice(0, 6); track d.desplegado_en) {
                  <tr [class.malo]="d.resultado !== 'ok'">
                    <td>{{ d.desplegado_en | date: 'dd/MM HH:mm' }}</td>
                    <td><code>{{ d.commit_sha }}</code></td>
                    <td class="vsrv">{{ d.servicios }}</td>
                    <td>
                      @if (d.resultado === 'ok') { <span class="vok">correcto</span> }
                      @else { <span class="vmal">{{ d.resultado }}</span> }
                    </td>
                    <td>
                      @if (d.migraciones_pendientes > 0) { <span class="vmal">{{ d.migraciones_pendientes }} pend.</span> }
                      @else { <span class="vdash">—</span> }
                    </td>
                    <td>{{ d.quien || '—' }}</td>
                  </tr>
                }
              </tbody>
            </table>
            </details>
          }
        </section>
      } @else if (versionError()) {
        <p class="vnota warn"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> No se pudo leer qué versión corre: {{ versionError() }}</p>
      }

      <!-- Marcador — lectura instantánea de toda la parvada de feeds/fuentes -->
      <div class="scoreboard">
        <button class="tile ok"   [class.on]="filter()==='ok'"       [attr.aria-pressed]="filter()==='ok'"       (click)="setFilter('ok')"><span class="n">{{ counts().ok }}</span><span class="l">OK</span></button>
        <button class="tile warn" [class.on]="filter()==='warn'"     [attr.aria-pressed]="filter()==='warn'"     (click)="setFilter('warn')"><span class="n">{{ counts().warn }}</span><span class="l">Atrasados</span></button>
        <button class="tile crit" [class.on]="filter()==='critical'" [attr.aria-pressed]="filter()==='critical'" (click)="setFilter('critical')"><span class="n">{{ counts().critical }}</span><span class="l">Críticos</span></button>
        <button class="tile unk"  [class.on]="filter()==='unknown'"  [attr.aria-pressed]="filter()==='unknown'"  (click)="setFilter('unknown')"><span class="n">{{ counts().unknown }}</span><span class="l">Sin dato</span></button>
        <div class="tile tot"><span class="n">{{ counts().total }}</span><span class="l">Fuentes</span></div>
        @if (filter()) { <button class="clr" (click)="setFilter(null)"><i class="pi pi-filter-slash"></i> ver todo</button> }
      </div>

      @if (error()) {
        <div class="banner err">
          <i class="pi pi-exclamation-triangle"></i>
          No se pudo consultar la salud de la DB. {{ error() }}
        </div>
      } @else if (report()?.overall === 'critical') {
        <div class="banner crit">
          <i class="pi pi-times-circle"></i>
          Hay fuentes <strong>sin actualizarse</strong> más allá de su cadencia. Revisa el feed correspondiente.
        </div>
      }

      <!-- Bandeja PERSISTENTE de alertas (abre/resuelve el scanner cada 5 min) -->
      <h2 class="sec">Bandeja de alertas
        @if (alertsError()) { <span class="cnt bad">sin leer</span> }
        @else { <span class="cnt" [class.bad]="openAlerts().length">{{ openAlerts().length }} abierta(s)</span> }</h2>
      <div class="card dt-scope">
        <!-- [UIM.2] Apilado por campos: cada columna es un campo de UNA alerta. -->
        <p-table [value]="openAlerts()" styleClass="p-datatable-sm dt-stack" [tableStyle]="{ 'min-width': '48rem' }">
          <ng-template #header>
            <tr><th>Fuente</th><th>Estado</th><th class="num">Desactualizada</th><th>Detectada</th><th><span class="sr-only">Acciones</span></th></tr>
          </ng-template>
          <ng-template #body let-a>
            <tr [class.row-ack]="a.acknowledged_at">
              <td class="dt-id" role="cell">
                <div class="src">{{ a.source_label }}</div>
                @if (a.note) { <div class="note2">{{ a.note }}</div> }
              </td>
              <td role="cell" data-label="Estado"><p-tag [severity]="a.status==='critical' ? 'danger' : 'warn'" [value]="a.status==='critical' ? 'Crítico' : 'Atrasado'" /></td>
              <td class="num dt-num" role="cell" data-label="Desactualizada" [class.txt-warn]="a.status==='warn'" [class.txt-crit]="a.status==='critical'">{{ relAge(a.age_seconds) }}</td>
              <td role="cell" data-label="Detectada"><span class="when">{{ a.first_seen_at | date: 'dd/MM HH:mm' }}</span></td>
              <td class="dt-actions" role="cell">
                @if (a.acknowledged_at) { <span class="ackd"><i class="pi pi-check"></i> visto</span> }
                @else { <button pButton type="button" size="small" class="p-button-text p-button-sm" (click)="ack(a)"><span class="p-button-label">Marcar visto</span></button> }
              </td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <!-- [DH.5] Una lectura fallida NO es «todo sano»: antes se pintaba igual, en verde. -->
            @if (alertsError()) {
              <tr><td colspan="5" class="empty err-empty"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> No se pudo leer la bandeja: {{ alertsError() }}</td></tr>
            } @else {
              <tr><td colspan="5" class="empty ok-empty"><i class="pi pi-check-circle" aria-hidden="true"></i> Sin alertas abiertas — todo sano.</td></tr>
            }
          </ng-template>
        </p-table>
      </div>
      @if (resolvedAlerts().length) {
        <details class="resolved">
          <!-- [DH.5] El servidor trae como mucho 50: el total se dice, no se confunde con lo que se lista. -->
          <summary>Resueltas en 7 días ({{ resolvedTotal() }})@if (resolvedTotal() > resolvedAlerts().length) { · se listan las {{ resolvedAlerts().length }} más recientes }</summary>
          @for (a of resolvedAlerts(); track a.id) {
            <div class="rrow">
              <span class="src">{{ a.source_label }}</span>
              <span class="muted">falló {{ a.first_seen_at | date: 'dd/MM HH:mm' }} → recuperada {{ a.resolved_at | date: 'dd/MM HH:mm' }}</span>
            </div>
          }
        </details>
      }

      <!-- DBH.1 — MOTOR. Las tablas de abajo responden "¿llegó el dato?"; esto, "¿cómo está la base?" -->
      @if (engineError() && !engine()) {
        <h2 class="sec">Motor de la base</h2>
        <div class="banner err"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> No se pudo leer el motor: {{ engineError() }}</div>
      }
      @if (engine(); as e) {
        <h2 class="sec">Motor de la base
          <span class="cnt">{{ e.database.size_pretty }} · {{ e.database.version }}</span>
          <p-tag [severity]="sev(e.overall)" [value]="statusLabel(e.overall)" [rounded]="true" />
        </h2>

        <!-- [DH.5] Con error el servidor manda listas vacías: se dice el error, no «sin filas muertas». -->
        @if (e.error) {
          <div class="banner err"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> No se pudo leer el motor: {{ e.error }}</div>
        } @else {
        <div class="metrics">
          @for (m of e.metrics; track m.key) {
            <div class="metric" [class.warn]="m.status==='warn'" [class.crit]="m.status==='critical'">
              <span class="l">{{ m.label }}</span>
              <span class="v">{{ m.display }}</span>
              @if (m.note) { <span class="n">{{ m.note }}</span> }
            </div>
          }
        </div>

        <div class="card dt-scope">
          <!-- [UIM.2] Apilado por campos: cada columna es un campo de UNA tabla. -->
          <p-table [value]="e.bloat" styleClass="p-datatable-sm dt-stack" [tableStyle]="{ 'min-width': '48rem' }">
            <ng-template #header>
              <tr>
                <th>Tabla</th>
                <!-- [DH.5] reltuples: el contador n_live_tup se pierde cuando la base se reinicia. -->
                <th class="num">Filas (estimadas)</th>
                <th class="num">Muertas</th>
                <th class="num">%</th>
                <th>Última limpieza</th>
                <th class="num">Peso</th>
              </tr>
            </ng-template>
            <ng-template #body let-t>
              <tr>
                <td class="dt-id" role="cell">
                  <div class="src">{{ t.table }}</div>
                  <div class="tbl">{{ t.schema }}</div>
                </td>
                <td class="num tnum dt-num" role="cell" data-label="Filas (estimadas)">{{ t.live | number }}</td>
                <td class="num tnum dt-num" role="cell" data-label="Muertas">{{ t.dead | number }}</td>
                <td class="num tnum dt-num" role="cell" data-label="% muertas" [class.txt-warn]="t.status==='warn'" [class.txt-crit]="t.status==='critical'">
                  {{ t.dead_pct != null ? t.dead_pct + '%' : '—' }}
                </td>
                <td role="cell" data-label="Última limpieza">
                  @if (t.last_autovacuum) {
                    <span class="when">{{ t.last_autovacuum | date: 'dd/MM HH:mm' }}</span>
                  } @else {
                    <!-- [DH.5] "nunca" afirmaba de más: Postgres pierde este registro al reiniciarse sin apagado limpio
                         (medido el 2026-11-04: 1,104 de 1,227 tablas sin registro). -->
                    <span class="when muted">sin registro</span>
                  }
                </td>
                <td class="num tnum dt-num" role="cell" data-label="Peso">{{ t.size_pretty }}</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="6" class="empty">Sin filas muertas acumuladas.</td></tr>
            </ng-template>
          </p-table>
        </div>

        <details class="det">
          <summary>Peso por schema y configuración de autovacuum</summary>
          <div class="two">
            <div>
              @for (s of e.schemas; track s.schema) {
                <div class="kv"><span>{{ s.schema }}</span><b>{{ s.size_pretty }}</b><i>{{ s.tables }} tablas</i></div>
              }
            </div>
            <div>
              @for (a of e.autovacuum; track a.name) {
                <div class="kv"><span>{{ a.name }}</span><b>{{ a.setting }}</b></div>
              }
            </div>
          </div>
        </details>
        <p class="foot">«Sin registro» en la última limpieza: Postgres no anotó una desde que arrancó, o la tabla no llegó a su umbral. El registro se pierde si la base se reinicia sin apagado limpio.</p>
        }
      }

      <ng-container *ngTemplateOutlet="tbl; context: { $implicit: cronRows(), title: 'Crons / feeds (estado de ejecución)', firstCol: 'Cron' }"></ng-container>
      <ng-container *ngTemplateOutlet="tbl; context: { $implicit: appRows(), title: 'DB de la app', firstCol: 'Tabla' }"></ng-container>
      <!-- [DH.2] El rótulo decía "en prod no alcanza la LAN". Era cierto con prod en Railway y
           dejó de serlo cuando prod se mudó a md (VL.9): medido el 2026-09-25 desde el contenedor
           prod-api, 192.168.0.245:5432 y 192.168.0.222:5433 responden. Lo que falta es la variable
           de entorno, no la ruta — y son arreglos de dueños distintos. -->
      <ng-container *ngTemplateOutlet="tbl; context: { $implicit: sourceRows(), title: 'Fuentes / orígenes (DBs de otro host; cada una necesita su variable de conexión)', firstCol: 'Origen' }"></ng-container>

      <ng-template #tbl let-data let-title="title" let-firstCol="firstCol">
        <h2 class="sec">{{ title }}</h2>
        <div class="card dt-scope">
          <!-- [UIM.2] Apilado por campos: cada columna es un campo de UNA fuente. -->
          <p-table [value]="data" [loading]="false" styleClass="p-datatable-sm dt-stack" [tableStyle]="{ 'min-width': '48rem' }">
            <ng-template #header>
              <tr>
                <th>{{ firstCol }}</th>
                <th>Última actualización</th>
                <th class="num">Antigüedad</th>
                <th>Estado</th>
                <th>Cadencia esperada</th>
                <!-- [DH.1] La semana. Sin esto la tabla sólo sabía responder "¿cómo está ahora?" -->
                <th class="num" title="Corridas fallidas sobre el total, últimos 7 días">Semana</th>
                <th class="num">Filas</th>
              </tr>
            </ng-template>
            <ng-template #body let-s>
              <tr>
                <td class="dt-id" role="cell">
                  <div class="src">{{ s.label }}</div>
                  <div class="tbl">{{ s.table }}</div>
                </td>
                <td role="cell" data-label="Última actualización">
                  @if (s.last_update) {
                    <span class="when">{{ s.last_update | date: 'dd/MM HH:mm' }}</span>
                  } @else {
                    <span class="when muted">{{ s.status === 'unknown' ? '—' : 'nunca' }}</span>
                  }
                </td>
                <td class="num dt-num" role="cell" data-label="Antigüedad" [class.txt-warn]="s.status==='warn'" [class.txt-crit]="s.status==='critical'">
                  {{ relAge(s.age_seconds) }}
                </td>
                <td role="cell" data-label="Estado">
                  <p-tag [severity]="sev(s.status)" [value]="statusLabel(s.status)" />
                  @if (s.note) { <span class="note">{{ s.note }}</span> }
                </td>
                <td class="cadence" role="cell" data-label="Cadencia esperada">{{ s.cadence }}</td>
                <td class="num tnum dt-num" role="cell" data-label="Fallas 7 días">
                  @if (s.runs_7d) {
                    <span [class.txt-warn]="(s.fails_7d ?? 0) > 0" [title]="s.fails_7d + ' de ' + s.runs_7d + ' corridas fallaron en 7 dias'">
                      {{ s.fails_7d }}/{{ s.runs_7d }}
                    </span>
                  } @else {
                    <!-- Sin historial NO es "cero fallas": es que no hay con qué comprobarlo. -->
                    <span class="muted">—</span>
                  }
                </td>
                <td class="num tnum dt-num" role="cell" data-label="Filas">{{ s.rows != null ? (s.rows | number) : '—' }}</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="7" class="empty">
                @if (loading()) { Cargando… } @else if (filter()) { Ninguna fuente de este grupo en ese estado. } @else { Sin fuentes. }
              </td></tr>
            </ng-template>
          </p-table>
        </div>
      </ng-template>

      <p class="foot">
        <!-- [DH.5] Decía que todo salía de max(updated_at); los carriles se miden por su latido. -->
        La antigüedad de una tabla es la de su dato más nuevo (su columna de fecha o la consulta propia de la fuente);
        la de un cron, su última corrida terminada. Un valor en rojo = la información dejó de actualizarse.
      </p>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .page { padding: 1rem 1.25rem 2rem; max-width: 1100px; }
    .page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; }
    .page-head h1 { font-size: var(--text-page-head, 18px); font-weight: 700; letter-spacing: -0.01em; margin: 0; color: var(--text-main); }
    .page-head .sub { font-size: var(--fs-xs, .72rem); color: var(--text-faint); }
    .actions { display: inline-flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
    .scoreboard { display: flex; gap: .5rem; flex-wrap: wrap; align-items: stretch; margin-bottom: 1rem; }
    .tile { display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: .1rem; min-width: 92px; padding: .5rem .7rem; border: 1px solid var(--border-color); border-radius: var(--r-md, 8px); background: var(--surface-card, transparent); cursor: pointer; transition: border-color .12s, background .12s; text-align: left; }
    .tile:hover { border-color: color-mix(in srgb, var(--text-faint) 45%, var(--border-color)); }
    .tile.on { background: color-mix(in srgb, currentColor 8%, transparent); border-color: currentColor; }
    .tile .n { font-size: 1.35rem; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; color: var(--text-main); }
    .tile .l { font-size: .66rem; letter-spacing: .02em; text-transform: uppercase; color: var(--text-faint); }
    /* [DH.5] Texto en -soft-fg: --warn-fg da 2.15:1 y --ok-fg 3.30:1 sobre blanco. --danger-fg no existe: es --bad-fg. */
    .tile.ok   { color: var(--ok-soft-fg); }
    .tile.warn { color: var(--warn-soft-fg); }
    .tile.crit { color: var(--bad-fg); }
    .tile.unk  { color: var(--text-faint); }
    .tile.ok .n, .tile.warn .n, .tile.crit .n { color: currentColor; }
    .tile.tot { cursor: default; background: transparent; }
    .tile.tot:hover { border-color: var(--border-color); }
    .clr { align-self: center; display: inline-flex; align-items: center; gap: .3rem; border: none; background: none; cursor: pointer; font-size: .74rem; color: var(--text-faint); padding: 0 .4rem; }
    .clr:hover { color: var(--text-main); }
    .banner { display: flex; align-items: center; gap: .5rem; font-size: .8rem; padding: .6rem .8rem; border: 1px solid var(--border-color); border-radius: var(--r-md, 8px); margin-bottom: .9rem; }
    .banner.crit { color: var(--bad-fg); border-color: var(--bad-border); }
    .banner.err  { color: var(--warn-soft-fg); border-color: var(--warn-border); }
    .sec { font-size: .8rem; font-weight: 700; letter-spacing: -0.01em; color: var(--text-main); margin: 1.1rem 0 .5rem; }
    .card { border: 1px solid var(--border-color); border-radius: var(--r-md, 8px); overflow: hidden; }
    .src { font-weight: 600; color: var(--text-main); font-size: .82rem; }
    .tbl { font-size: .68rem; color: var(--text-faint); font-family: var(--font-mono, monospace); }
    .when { font-size: .78rem; color: var(--text-main); font-variant-numeric: tabular-nums; }
    .when.muted { color: var(--text-faint); }
    .num { text-align: right; }
    .tnum { font-variant-numeric: tabular-nums; }
    .txt-warn { color: var(--warn-soft-fg); font-weight: 600; }
    .txt-crit { color: var(--bad-fg); font-weight: 700; }
    .cadence { font-size: .76rem; color: var(--text-faint); }
    .note { font-size: .68rem; color: var(--text-faint); margin-left: .4rem; }
    .empty { text-align: center; color: var(--text-faint); padding: 1rem; font-size: .8rem; }
    .ok-empty { color: var(--ok-soft-fg); }
    .err-empty { color: var(--warn-soft-fg); }
    .foot { font-size: .7rem; color: var(--text-faint); margin-top: .8rem; }
    .foot code { font-family: var(--font-mono, monospace); }
    .cnt { font-size: .7rem; font-weight: 600; color: var(--text-faint); margin-left: .4rem; }
    .cnt.bad { color: var(--bad-fg); }
    .note2 { font-size: .68rem; color: var(--text-faint); margin-top: 1px; }
    .row-ack { opacity: .6; }
    .ackd { font-size: .7rem; color: var(--ok-soft-fg); }
    .resolved { margin-top: .6rem; font-size: .76rem; }
    .resolved summary { cursor: pointer; color: var(--text-faint); }
    .rrow { display: flex; gap: .6rem; padding: .25rem 0 .25rem .8rem; align-items: baseline; }
    .rrow .muted { color: var(--text-faint); font-size: .72rem; }

    /* DBH.1 motor — grid intrinseco: sin breakpoints, se acomoda al ancho del contenedor */
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: .5rem; margin-bottom: .7rem; }
    .metric { display: flex; flex-direction: column; gap: .1rem; padding: .55rem .75rem; border: 1px solid var(--border-color); border-radius: var(--r-md, 8px); background: var(--surface-card, transparent); }
    .metric .l { font-size: .68rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); }
    .metric .v { font-size: .95rem; font-weight: 600; color: var(--text-main); font-variant-numeric: tabular-nums; }
    .metric .n { font-size: .68rem; color: var(--text-faint); }
    .metric.warn { border-color: var(--warn-border); }
    .metric.warn .v { color: var(--warn-soft-fg); }
    .metric.crit { border-color: var(--bad-border); }
    .metric.crit .v { color: var(--bad-fg); }
    .det { margin-top: .6rem; font-size: .76rem; }
    .det summary { cursor: pointer; color: var(--text-faint); }
    .two { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: .4rem 1.5rem; padding: .5rem 0 0 .8rem; }
    .kv { display: flex; gap: .5rem; align-items: baseline; padding: .12rem 0; }
    .kv span { color: var(--text-faint); min-width: 12rem; }
    .kv b { font-variant-numeric: tabular-nums; color: var(--text-main); font-weight: 600; }
    .kv i { font-style: normal; color: var(--text-faint); font-size: .7rem; }

    /* [VL.15.E] Versión en producción. Tokens de Operations: sin decoración, densidad alta. */
    /* [DH.5] Sólo tokens que existen: --border-subtle, --border-faint, --surface-sunken y la paleta
       --red/--green/--amber-* no están en tokens.css, y su respaldo claro dejaba la fila de un
       despliegue fallido a 1.05:1 en modo oscuro. */
    .version { border: 1px solid var(--border-color); border-radius: var(--r-md);
               padding: .7rem .85rem; margin-bottom: 1rem; background: var(--surface-card); }
    .vnow { display: flex; align-items: baseline; gap: .55rem; flex-wrap: wrap; }
    .vlbl { font-size: var(--fs-xs, .72rem); color: var(--text-faint); text-transform: uppercase; letter-spacing: .04em; }
    .vsha { font-family: var(--font-mono, ui-monospace, monospace); font-size: .95rem; font-weight: 700;
            color: var(--text-main); background: var(--surface-ground); padding: .1rem .4rem; border-radius: var(--r-sm); }
    .vup { font-size: var(--fs-xs, .72rem); color: var(--text-faint); }
    .vnota { margin: .55rem 0 0; font-size: var(--fs-xs, .72rem); color: var(--text-faint); display: flex; gap: .35rem; align-items: flex-start; }
    .vnota.warn { color: var(--warn-soft-fg); }
    .vnota code { font-family: var(--font-mono, ui-monospace, monospace); }
    .vtab { width: 100%; border-collapse: collapse; margin-top: .6rem; font-size: var(--fs-xs, .72rem); }
    .vtab th { text-align: left; font-weight: 600; color: var(--text-faint); padding: .25rem .5rem .25rem 0; border-bottom: 1px solid var(--border-color); }
    .vtab td { padding: .3rem .5rem .3rem 0; border-bottom: 1px solid var(--border-color); color: var(--text-main); }
    .vtab td code { font-family: var(--font-mono, ui-monospace, monospace); }
    .vtab tr.malo td { background: var(--bad-soft-bg); }
    .vsrv { color: var(--text-faint); max-width: 22ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .vok { color: var(--ok-soft-fg); }
    .vmal { color: var(--bad-soft-fg); font-weight: 600; }
    .vdash { color: var(--text-faint); }
  `],
})
export class AdminDbHealthComponent implements OnInit, OnDestroy {
  private svc = inject(DbHealthService);

  readonly report = signal<DbHealthReport | null>(null);
  readonly loading = signal(false);
  readonly scanning = signal(false);
  readonly error = signal<string | null>(null);
  readonly openAlerts = signal<HealthAlert[]>([]);
  readonly resolvedAlerts = signal<HealthAlert[]>([]);
  /** [DH.5] Total de resueltas en 7 días; `resolvedAlerts` trae como mucho 50. */
  readonly resolvedTotal = signal(0);
  /**
   * [DH.5] Cada lectura declara su falla. Antes las tres fallaban en silencio y la pantalla
   * pintaba lo vacío como sano («Sin alertas abiertas — todo sano»).
   */
  readonly alertsError = signal<string | null>(null);
  readonly engineError = signal<string | null>(null);
  readonly versionError = signal<string | null>(null);
  /** [DH.5] Resultado de «Escanear ahora» / «Marcar visto»: si falla, se dice. */
  readonly actionMsg = signal<{ text: string; bad: boolean } | null>(null);
  /** DBH.1 — salud del motor. Nulo hasta que responde (o si el endpoint aún no existe). */
  readonly engine = signal<EngineReport | null>(null);
  /** [VL.15.E] Qué versión corre en prod. Nulo hasta que responde o si no hay endpoint. */
  readonly version = signal<VersionReport | null>(null);
  /** Filtro de severidad activo (clic en el marcador). null = ver todo. */
  readonly filter = signal<HealthStatus | null>(null);
  /** Auto-refresco cada 60s (pantalla viva). */
  readonly auto = signal(true);
  private pararAuto: PararEncuesta | null = null;
  private readonly destroyRef = inject(DestroyRef);
  private readonly zone = inject(NgZone);

  /** Conteo por severidad sobre TODAS las fuentes (crons + app + orígenes). */
  readonly counts = computed(() => {
    const s = this.report()?.sources ?? [];
    return {
      ok: s.filter((x) => x.status === 'ok').length,
      warn: s.filter((x) => x.status === 'warn').length,
      critical: s.filter((x) => x.status === 'critical').length,
      unknown: s.filter((x) => x.status === 'unknown').length,
      total: s.length,
    };
  });

  /**
   * [DH.3] ANSWER-FIRST. Las tablas salían en el orden en que el backend las arma, o sea: un
   * `critical` podía quedar en el renglón 40 de 51, debajo de cuarenta verdes. Con scroll interno
   * eso es lo mismo que no mostrarlo.
   *
   * El orden es el del veredicto —`critical` › `warn` › `unknown` › `ok`— y dentro de cada estado
   * manda **lo más viejo primero**, que es lo que lleva más tiempo sin que nadie lo mire.
   *
   * ⚠️ `unknown` va ARRIBA de `ok` a propósito: "no lo pude medir" no es salud, y si se ordena
   * después de los verdes desaparece. Es el mismo criterio con el que `RANK` ya lo pone por
   * encima de `ok` en el backend para calcular el semáforo global.
   */
  private static readonly ORDEN: Record<HealthStatus, number> = { critical: 0, warn: 1, unknown: 2, ok: 3 };

  private byGroup(g: SourceHealth['group']): SourceHealth[] {
    const f = this.filter();
    const O = AdminDbHealthComponent.ORDEN;
    return (this.report()?.sources ?? [])
      .filter((s) => s.group === g && (!f || s.status === f))
      .slice()
      .sort((a, b) => (O[a.status] - O[b.status]) || ((b.age_seconds ?? -1) - (a.age_seconds ?? -1)));
  }
  readonly appRows = computed<SourceHealth[]>(() => this.byGroup('app'));
  readonly sourceRows = computed<SourceHealth[]>(() => this.byGroup('source'));
  readonly cronRows = computed<SourceHealth[]>(() => this.byGroup('cron'));

  ngOnInit(): void {
    this.load();
    this.startAuto();
  }

  ngOnDestroy(): void { this.stopAuto(); }

  private startAuto(): void {
    this.stopAuto();
    if (this.auto()) {
      // Sólo con la pestaña a la vista: ver 'core/utils/poll-visible'.
      this.pararAuto = encuestarVisible(60_000, () => this.silentLoad(),
        { destroyRef: this.destroyRef, zone: this.zone });
    }
  }
  private stopAuto(): void { if (this.pararAuto) { this.pararAuto(); this.pararAuto = null; } }
  toggleAuto(): void { this.auto.update((v) => !v); this.startAuto(); }
  setFilter(s: HealthStatus | null): void { this.filter.update((cur) => (cur === s ? null : s)); }

  /** Refresco de fondo (auto): NO prende el spinner grande para no parpadear la vista. */
  private silentLoad(): void {
    this.svc.getReport().subscribe({
      next: (r) => { this.report.set(r); this.error.set(null); },
      error: () => { /* silencioso: no romper la pantalla viva por un blip de red */ },
    });
    this.loadAlerts();
    this.loadEngine();
    this.loadVersion();
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.svc.getReport().subscribe({
      next: (r) => { this.report.set(r); this.loading.set(false); },
      error: (e) => { this.error.set(e?.error?.message || e?.message || 'Error de red'); this.loading.set(false); },
    });
    this.loadAlerts();
    this.loadEngine();
    this.loadVersion();
  }

  /** El motor va en su propia llamada: si falla, la pantalla de frescura sigue funcionando igual,
   *  y la falla se declara en su sección (`[DH.5]`). */
  loadEngine(): void {
    this.svc.getEngine().subscribe({
      next: (e) => { this.engine.set(e); this.engineError.set(null); },
      error: (err) => { this.engine.set(null); this.engineError.set(this.motivo(err)); },
    });
  }

  /** El mensaje legible de un error HTTP. */
  private motivo(e: { error?: { message?: string }; message?: string; status?: number } | null | undefined): string {
    return e?.error?.message || e?.message || (e?.status ? `error ${e.status}` : 'error de red');
  }

  /** [VL.15.E] En su propia llamada, como el motor: si el API todavía no tiene el endpoint
   *  (o la bitácora no existe), la pantalla de frescura sigue funcionando igual. */
  /**
   * `[VL.15.E]` Segundos → algo que una persona lee de un vistazo. Es `uptime` del proceso, así
   * que también contesta "¿se reinició solo?" sin abrir un log: si dice minutos y nadie desplegó,
   * el contenedor se cayó y volvió.
   */
  tiempoHumano(seg: number): string {
    if (!Number.isFinite(seg) || seg < 0) return '—';
    if (seg < 90) return `${Math.round(seg)} s`;
    const min = seg / 60;
    if (min < 90) return `${Math.round(min)} min`;
    const h = min / 60;
    if (h < 48) return `${Math.round(h)} h`;
    return `${Math.round(h / 24)} días`;
  }

  loadVersion(): void {
    this.svc.getVersion().subscribe({
      next: (v) => { this.version.set(v); this.versionError.set(null); },
      error: (err) => { this.version.set(null); this.versionError.set(this.motivo(err)); },
    });
  }

  loadAlerts(): void {
    this.svc.listAlerts().subscribe({
      next: (r) => {
        const resueltas = r.recent_resolved ?? [];
        this.openAlerts.set(r.open ?? []);
        this.resolvedAlerts.set(resueltas);
        this.resolvedTotal.set(Math.max(r.recent_resolved_total ?? 0, resueltas.length));
        this.alertsError.set(null);
      },
      // [DH.5] Se vacía Y se declara: dejar la lista vieja a la vista la haría pasar por actual.
      error: (err) => { this.openAlerts.set([]); this.resolvedAlerts.set([]); this.resolvedTotal.set(0); this.alertsError.set(this.motivo(err)); },
    });
  }

  scan(): void {
    this.scanning.set(true);
    this.actionMsg.set(null);
    this.svc.scanNow().subscribe({
      next: (r) => {
        this.scanning.set(false);
        this.actionMsg.set({ bad: false, text: `Escaneo terminado: ${r.opened} abierta(s), ${r.escalated} escalada(s), ${r.resolved} resuelta(s), ${r.failing} fuente(s) fallando.` });
        this.load();
      },
      error: (err) => { this.scanning.set(false); this.actionMsg.set({ bad: true, text: `No se pudo escanear: ${this.motivo(err)}` }); },
    });
  }

  ack(a: HealthAlert): void {
    this.svc.ackAlert(a.id).subscribe({
      next: (r) => {
        if (!r?.ok) this.actionMsg.set({ bad: true, text: `No se marcó como vista «${a.source_label}»: la alerta ya no existe o no es de esta empresa.` });
        this.loadAlerts();
      },
      error: (err) => this.actionMsg.set({ bad: true, text: `No se pudo marcar como vista «${a.source_label}»: ${this.motivo(err)}` }),
    });
  }

  sev(s: HealthStatus): Sev {
    return s === 'ok' ? 'success' : s === 'warn' ? 'warn' : s === 'critical' ? 'danger' : 'secondary';
  }
  statusLabel(s: HealthStatus): string {
    return s === 'ok' ? 'OK' : s === 'warn' ? 'Atrasado' : s === 'critical' ? 'Crítico' : 'Desconocido';
  }
  relAge(sec: number | null): string {
    if (sec == null) return '—';
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h} h`;
    return `${Math.floor(h / 24)} d`;
  }
}
