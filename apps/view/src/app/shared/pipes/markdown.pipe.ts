import { Pipe, PipeTransform, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

/**
 * Markdown ligero y SEGURO para respuestas de AI (Maat/Thot) fuera del chat
 * principal (hilos, paneles). Escapa TODO el HTML primero y recién después aplica
 * un subconjunto: negritas, itálicas, code, links, encabezados, viñetas, numeradas,
 * citas y saltos. Sin dependencias. NO cubre tablas (usar el chat principal para eso).
 */
@Pipe({ name: 'markdown', standalone: true })
export class MarkdownPipe implements PipeTransform {
  private readonly sanitizer = inject(DomSanitizer);

  transform(src: string | null | undefined): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(this.mdToHtml(src || ''));
  }

  private esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private inline(s: string): string {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  private mdToHtml(raw: string): string {
    const lines = this.esc(raw).split(/\r?\n/);
    const out: string[] = [];
    let list: 'ul' | 'ol' | null = null;
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

    for (const rawLine of lines) {
      const t = rawLine.trim();
      if (!t) { closeList(); continue; }

      const h = t.match(/^(#{1,3})\s+(.*)$/);
      if (h) { closeList(); out.push(`<p class="md-h">${this.inline(h[2])}</p>`); continue; }

      const ol = t.match(/^\d+[.)]\s+(.*)$/);
      if (ol) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${this.inline(ol[1])}</li>`); continue; }

      const ul = t.match(/^[-*•]\s+(.*)$/);
      if (ul) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${this.inline(ul[1])}</li>`); continue; }

      closeList();
      out.push(`<p>${this.inline(t)}</p>`);
    }
    closeList();
    return out.join('');
  }
}
