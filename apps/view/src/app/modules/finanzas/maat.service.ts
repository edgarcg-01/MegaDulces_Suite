import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpEventType } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** MAAT.3 — cliente del chat financiero (patrón ThotChat, dominio Finanzas). */

export interface MaatChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface MaatToolTrace {
  name: string;
  input: any;
  result: any;
}

export interface MaatChatResult {
  answer: string;
  source: 'llm' | 'no_api_key' | 'error';
  tools_used: MaatToolTrace[];
  iterations: number;
  session_id: string | null;
  message_id: string | null;
  suggestions: string[];
}

/** Evento del stream SSE: paso de progreso (real), respuesta final, o error. */
export type MaatStreamEvent =
  | { type: 'step'; label: string }
  | { type: 'done'; result: MaatChatResult }
  | { type: 'error' };

export interface MaatBriefingCard { icon: string; label: string; value: string; tone?: 'up' | 'down' | 'warn'; }
export interface MaatBriefing {
  greeting: string;
  cards: MaatBriefingCard[];
  findings: { tipo: string; num: number; total: number }[];
  suggestions: string[];
}

@Injectable({ providedIn: 'root' })
export class MaatService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/maat`;

  chat(
    history: MaatChatTurn[],
    message: string,
    opts?: {
      think?: boolean;
      deepSearch?: boolean;
      sessionId?: string | null;
      image?: { mediaType: string; data: string } | null;
    },
  ): Observable<MaatChatResult> {
    return this.http.post<MaatChatResult>(`${this.base}/chat`, {
      history,
      message,
      think: opts?.think ?? false,
      deep_search: opts?.deepSearch ?? false,
      session_id: opts?.sessionId || undefined,
      image: opts?.image ? { media_type: opts.image.mediaType, data: opts.image.data } : undefined,
    });
  }

  /**
   * Igual que chat(), pero por SSE: emite pasos de progreso REALES (la tool que
   * Maat está ejecutando) y al final el resultado. Usa HttpClient con
   * observe:'events' + partialText → reusa el interceptor de auth (token).
   */
  chatStream(
    history: MaatChatTurn[],
    message: string,
    opts?: {
      think?: boolean;
      deepSearch?: boolean;
      sessionId?: string | null;
      image?: { mediaType: string; data: string } | null;
    },
  ): Observable<MaatStreamEvent> {
    return new Observable<MaatStreamEvent>((sub) => {
      let consumed = 0;
      const emitFrom = (text: string) => {
        let buf = text.slice(consumed);
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          consumed += idx + 2;
          buf = buf.slice(idx + 2);
          const ev = this.parseSse(block);
          if (ev) sub.next(ev);
        }
      };
      const httpSub = this.http.post(`${this.base}/chat/stream`, {
        history,
        message,
        think: opts?.think ?? false,
        deep_search: opts?.deepSearch ?? false,
        session_id: opts?.sessionId || undefined,
        image: opts?.image ? { media_type: opts.image.mediaType, data: opts.image.data } : undefined,
      }, { observe: 'events', responseType: 'text', reportProgress: true }).subscribe({
        next: (ev: any) => {
          if (ev.type === HttpEventType.DownloadProgress) emitFrom(ev.partialText || '');
          else if (ev.type === HttpEventType.Response) { emitFrom(ev.body || ''); sub.complete(); }
        },
        error: (e) => sub.error(e),
      });
      return () => httpSub.unsubscribe();
    });
  }

  /** Parsea un bloque SSE ("event: X\ndata: {...}") a un MaatStreamEvent. */
  private parseSse(block: string): MaatStreamEvent | null {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return null;
    try {
      const parsed = JSON.parse(data);
      if (event === 'step') return { type: 'step', label: parsed.label || '' };
      if (event === 'done') return { type: 'done', result: parsed as MaatChatResult };
      if (event === 'error') return { type: 'error' };
    } catch { /* bloque parcial: ignorar */ }
    return null;
  }

  /** 👍/👎 sobre una respuesta (colector del aprendizaje L2). */
  feedback(messageId: string, vote: 1 | -1): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.base}/chat/feedback`, { message_id: messageId, vote });
  }

  /** Briefing determinista para el empty-state (proactividad). */
  briefing(): Observable<MaatBriefing> {
    return this.http.get<MaatBriefing>(`${this.base}/briefing`);
  }
}
