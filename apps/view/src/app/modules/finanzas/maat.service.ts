import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
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

  /** 👍/👎 sobre una respuesta (colector del aprendizaje L2). */
  feedback(messageId: string, vote: 1 | -1): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.base}/chat/feedback`, { message_id: messageId, vote });
  }

  /** Briefing determinista para el empty-state (proactividad). */
  briefing(): Observable<MaatBriefing> {
    return this.http.get<MaatBriefing>(`${this.base}/briefing`);
  }
}
