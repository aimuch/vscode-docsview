// Markdown Slide Deck Presentation Mode: splits rendered blocks by `<hr>` (`---`) or `<h1>`/`<h2>`
// into an interactive fullscreen deck with keyboard navigation and a virtual laser pointer.
import { el, t } from '../shared/api';
import { overlayStack } from '../shared/overlayStack';
import { iconButton, toggleButton } from '../shared/ui';

export function splitArticleIntoSlides(article: HTMLElement): HTMLElement[][] {
  const children = Array.from(article.children).filter(
    (n): n is HTMLElement =>
      n instanceof HTMLElement && !n.classList.contains('md-edit') && !n.classList.contains('md-frontmatter'),
  );
  if (!children.length) {
    return [];
  }
  const hasHr = children.some((c) => c.tagName === 'HR');
  const slides: HTMLElement[][] = [];
  let bucket: HTMLElement[] = [];

  if (hasHr) {
    for (const child of children) {
      if (child.tagName === 'HR') {
        if (bucket.length) {
          slides.push(bucket);
          bucket = [];
        }
      } else {
        bucket.push(child);
      }
    }
  } else {
    for (const child of children) {
      if ((child.tagName === 'H1' || child.tagName === 'H2') && bucket.length) {
        slides.push(bucket);
        bucket = [child];
      } else {
        bucket.push(child);
      }
    }
  }
  if (bucket.length) {
    slides.push(bucket);
  }
  return slides;
}

export class MarkdownSlideDeck {
  private overlay: HTMLElement | undefined;
  private cardEl: HTMLElement | undefined;
  private counterEl: HTMLElement | undefined;
  private laserDot: HTMLElement | undefined;
  private slides: HTMLElement[][] = [];
  private index = 0;
  private active = false;
  private laserOn = false;

  constructor(
    private readonly article: HTMLElement,
    private readonly getScroller?: () => HTMLElement,
  ) {
    window.addEventListener('keydown', (e) => {
      if (
        (e.target as HTMLElement | null)?.closest(
          'input, textarea, select, button, [role="menu"], [role="dialog"], .dv-st-drawer',
        ) ||
        document.querySelector('.md-lightbox:not([hidden])')
      ) {
        return;
      }
      if (e.key === 'F5' && !this.active) {
        e.preventDefault();
        this.open();
        return;
      }
      if (!this.active) {
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault();
        this.step(1);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
        e.preventDefault();
        this.step(-1);
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        this.setLaser(!this.laserOn);
      }
    });
  }

  get isOpen(): boolean {
    return this.active;
  }

  private laserToggle = toggleButton('laser', `${t('laserPointer')} (L)`, (on) => this.setLaser(on));

  private setLaser(on: boolean): void {
    this.laserOn = on;
    this.laserToggle.set(on);
    this.overlay?.classList.toggle('dv-laser-on', on);
    if (!on && this.laserDot) {
      this.laserDot.hidden = true;
    }
  }

  private ensureDom(): void {
    if (this.overlay) {
      return;
    }
    this.cardEl = el('article', { class: 'markdown-body md-slide-card' });
    this.counterEl = el('span', { class: 'dv-label' });
    this.laserDot = el('div', { class: 'dv-laser-dot' });
    this.laserDot.hidden = true;

    const hud = el('div', { class: 'dv-present-hud' }, [
      iconButton('left', t('prevPage'), () => this.step(-1)),
      this.counterEl,
      iconButton('right', t('nextPage'), () => this.step(1)),
      this.laserToggle.node,
      iconButton('close', t('exitPresentation'), () => this.close()),
    ]);
    hud.addEventListener('click', (e) => e.stopPropagation());

    this.overlay = el('div', { class: 'dv-present-overlay md-slide-overlay' }, [
      this.cardEl,
      hud,
      this.laserDot,
    ]);
    this.overlay.hidden = true;
    document.body.append(this.overlay);

    this.overlay.addEventListener('mousemove', (e) => {
      if (this.active && this.laserOn && this.laserDot) {
        this.laserDot.hidden = false;
        this.laserDot.style.left = `${e.clientX}px`;
        this.laserDot.style.top = `${e.clientY}px`;
      }
    });
    this.overlay.addEventListener('mouseleave', () => {
      if (this.laserDot) {
        this.laserDot.hidden = true;
      }
    });
    this.overlay.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest<HTMLAnchorElement>('a[href]');
      if (anchor) {
        const href = anchor.getAttribute('href') ?? '';
        if (href.startsWith('#')) {
          e.preventDefault();
          e.stopPropagation();
          let id = href.slice(1);
          try {
            id = decodeURIComponent(id);
          } catch {
            // use raw id
          }
          const hitIdx = this.slides.findIndex((bucket) =>
            bucket.some((n) => n.id === id || (id ? n.querySelector(`[id="${CSS.escape(id)}"]`) !== null : false)),
          );
          if (hitIdx >= 0) {
            this.index = hitIdx;
            this.renderCurrent();
          }
          return;
        }
        return;
      }
      if (target?.closest('.dv-present-hud, button, .md-slide-card pre')) {
        return;
      }
      this.step(1);
    });
  }

  open(): void {
    this.slides = splitArticleIntoSlides(this.article);
    if (!this.slides.length) {
      return;
    }
    this.ensureDom();
    const scroller = this.getScroller?.();
    let startIdx = 0;
    if (scroller) {
      const topThreshold = scroller.getBoundingClientRect().top + 80;
      for (let i = 0; i < this.slides.length; i++) {
        const firstNode = this.slides[i][0];
        if (firstNode && firstNode.getBoundingClientRect().top <= topThreshold) {
          startIdx = i;
        }
      }
    }
    this.index = startIdx;
    this.active = true;
    this.overlay!.hidden = false;
    this.renderCurrent();
    overlayStack.push({
      id: 'markdownSlides',
      isOpen: () => this.active,
      close: () => this.close(),
      restoreFocus: () => this.getScroller?.(),
    });
  }

  close(): void {
    if (!this.active) {
      return;
    }
    this.active = false;
    overlayStack.remove('markdownSlides');
    if (this.overlay) {
      this.overlay.hidden = true;
    }
    if (this.laserDot) {
      this.laserDot.hidden = true;
    }
  }

  step(delta: -1 | 1): void {
    if (!this.slides.length) {
      return;
    }
    this.index = Math.max(0, Math.min(this.slides.length - 1, this.index + delta));
    this.renderCurrent();
  }

  private renderCurrent(): void {
    if (!this.cardEl || !this.counterEl || !this.slides.length) {
      return;
    }
    this.cardEl.dir = this.article.dir;
    const clones = this.slides[this.index].map((node) => {
      const c = node.cloneNode(true) as HTMLElement;
      c.querySelectorAll('.md-copy, .md-mermaid-expand').forEach((n) => n.remove());
      return c;
    });
    this.cardEl.replaceChildren(...clones);
    this.counterEl.textContent = `${this.index + 1} / ${this.slides.length}`;
  }
}
