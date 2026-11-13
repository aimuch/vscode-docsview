// Theme / light-dark / language preferences: applies them to the page and renders the
// toolbar controls and the appearance menu. Preferences live in VS Code settings; this
// module asks the host to change them and re-applies whatever the host sends back.
import type { Appearance, SchemeSetting, ThemeId } from '../../common/protocol';
import type { StringKey } from '../../common/strings';
import { config, el, onMessage, post, t } from './api';
import { icons } from './icons';

let current: Appearance = { ...config.appearance };
const listeners = new Set<(a: Appearance) => void>();

export function getAppearance(): Appearance {
  return current;
}

export function onAppearanceChange(listener: (a: Appearance) => void): void {
  listeners.add(listener);
}

/** VS Code reports its theme kind as a class on <body>. */
function editorIsDark(): boolean {
  const cls = document.body.classList;
  return cls.contains('vscode-dark') || cls.contains('vscode-high-contrast');
}

export function effectiveDark(): boolean {
  return current.scheme === 'auto' ? editorIsDark() : current.scheme === 'dark';
}

function setClass(name: string, on: boolean): void {
  if (document.body.classList.contains(name) !== on) {
    document.body.classList.toggle(name, on);
  }
}

function apply(): void {
  const body = document.body;
  if (current.scheme === 'auto') {
    delete body.dataset.scheme;
  } else {
    body.dataset.scheme = current.scheme;
  }
  body.dataset.theme = current.theme;
  const dark = effectiveDark();
  // Touch the class attribute only when something changes: the observer below watches it,
  // and an unconditional write would feed back into it in engines that report no-op writes.
  setClass('dv-dark', dark);
  setClass('dv-invert-pages', dark && current.invertPages);
  body.style.colorScheme = dark ? 'dark' : 'light';
  updateControls();
}

function update(patch: Partial<Appearance>): void {
  current = { ...current, ...patch };
  apply();
  listeners.forEach((l) => l(current));
  post({ type: 'setAppearance', patch });
}

// VS Code switching colour theme changes the body class.
new MutationObserver(() => {
  if (current.scheme === 'auto') {
    apply();
  }
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });

onMessage((message) => {
  if (message.type === 'appearance') {
    current = { ...message.appearance };
    apply();
    listeners.forEach((l) => l(current));
  }
});

// ---------------------------------------------------------------- controls

const THEMES: { id: ThemeId; name: StringKey; desc: StringKey; swatch: [string, string, string] }[] = [
  { id: 'editor', name: 'themeEditor', desc: 'themeEditorDesc', swatch: ['', '', ''] },
  { id: 'github', name: 'themeGithub', desc: 'themeGithubDesc', swatch: ['#ffffff', '#1f2328', '#0969da'] },
  { id: 'paper', name: 'themePaper', desc: 'themePaperDesc', swatch: ['#f8f4ec', '#2b2622', '#9a5b13'] },
  { id: 'academic', name: 'themeAcademic', desc: 'themeAcademicDesc', swatch: ['#ffffff', '#1a1a1a', '#3b5bdb'] },
];

const SCHEMES: { id: SchemeSetting; icon: keyof typeof icons; label: StringKey }[] = [
  { id: 'auto', icon: 'monitor', label: 'schemeAuto' },
  { id: 'light', icon: 'sun', label: 'schemeLight' },
  { id: 'dark', icon: 'moon', label: 'schemeDark' },
];

const updaters: (() => void)[] = [];

function updateControls(): void {
  updaters.forEach((u) => u());
}

function segButton(label: string, pressed: () => boolean, onClick: () => void, iconSvg?: string): HTMLButtonElement {
  const b = el('button', { class: iconSvg ? 'dv-seg-btn dv-seg-icon' : 'dv-seg-btn' });
  b.type = 'button';
  if (iconSvg) {
    b.innerHTML = iconSvg;
    b.title = label;
    b.setAttribute('aria-label', label);
  } else {
    b.textContent = label;
  }
  b.addEventListener('click', onClick);
  updaters.push(() => b.setAttribute('aria-pressed', String(pressed())));
  return b;
}

function group(label: string, buttons: HTMLButtonElement[], wide = false): HTMLElement {
  const node = el('div', { class: wide ? 'dv-seg dv-seg-wide' : 'dv-seg' }, buttons);
  node.setAttribute('role', 'group');
  node.setAttribute('aria-label', label);
  return node;
}

function schemeGroup(withText: boolean): HTMLElement {
  return group(
    t('scheme'),
    SCHEMES.map((s) =>
      segButton(
        t(s.label),
        () => current.scheme === s.id,
        () => update({ scheme: s.id }),
        withText ? undefined : icons[s.icon],
      ),
    ),
    withText,
  );
}

function themeSwatch(theme: (typeof THEMES)[number]): HTMLElement {
  const swatch = el('span', { class: 'dv-swatch' });
  if (theme.id === 'editor') {
    swatch.classList.add('dv-swatch-editor');
  } else {
    swatch.style.setProperty('--sw-bg', theme.swatch[0]);
    swatch.style.setProperty('--sw-accent', theme.swatch[2]);
  }
  return swatch;
}

let menu: HTMLElement | undefined;
let menuButton: HTMLButtonElement | undefined;

function closeMenu(): void {
  if (menu) {
    menu.hidden = true;
    menuButton?.setAttribute('aria-expanded', 'false');
  }
}

function buildMenu(): HTMLElement {
  const themeCards = THEMES.map((theme) => {
    const card = el('button', { class: 'dv-theme-card' });
    card.type = 'button';
    card.setAttribute('role', 'menuitemradio');
    const preview = el('span', { class: `dv-theme-preview dv-theme-preview-${theme.id}` }, [
      el('span', { class: 'dv-tp-title' }),
      el('span', { class: 'dv-tp-line' }),
      el('span', { class: 'dv-tp-link' }),
    ]);
    const name = el('span', { class: 'dv-theme-name' }, [el('span', { text: t(theme.name) })]);
    const check = el('span', { class: 'dv-theme-check' });
    check.innerHTML = icons.check;
    name.append(check);
    card.append(preview, name, el('span', { class: 'dv-theme-desc', text: t(theme.desc) }));
    card.addEventListener('click', () => update({ theme: theme.id }));
    updaters.push(() => card.setAttribute('aria-checked', String(current.theme === theme.id)));
    return card;
  });

  const invert = el('input');
  invert.type = 'checkbox';
  invert.addEventListener('change', () => update({ invertPages: invert.checked }));
  updaters.push(() => {
    invert.checked = current.invertPages;
  });

  const languageGroup = group(
    t('language'),
    (
      [
        ['auto', 'langAuto'],
        ['zh-cn', 'langZh'],
        ['en', 'langEn'],
      ] as const
    ).map(([id, label]) =>
      segButton(
        t(label),
        () => current.language === id,
        () => update({ language: id }),
      ),
    ),
    true,
  );

  const section = (title: StringKey, ...content: HTMLElement[]) =>
    el('div', { class: 'dv-menu-section' }, [el('div', { class: 'dv-menu-title', text: t(title) }), ...content]);

  const node = el('div', { class: 'dv-menu' }, [
    section('theme', el('div', { class: 'dv-theme-grid' }, themeCards)),
    section('scheme', schemeGroup(true), el('label', { class: 'dv-check' }, [invert, el('span', { text: t('invertPages') })])),
    section('language', languageGroup),
    el('div', { class: 'dv-menu-hint', text: t('appearanceHint') }),
  ]);
  node.setAttribute('role', 'menu');
  node.setAttribute('aria-label', t('appearance'));
  node.hidden = true;
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMenu();
      menuButton?.focus();
    }
  });
  return node;
}

document.addEventListener('mousedown', (e) => {
  if (menu && !menu.hidden && !menu.contains(e.target as Node) && !menuButton?.contains(e.target as Node)) {
    closeMenu();
  }
});

/** Theme menu button, light/dark switch and language switch for the right end of a toolbar. */
export function appearanceControls(): HTMLElement[] {
  const button = el('button', { class: 'dv-btn dv-theme-btn' });
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  const label = el('span', { class: 'dv-theme-label' });
  const chevron = el('span', { class: 'dv-chevron' });
  chevron.innerHTML = icons.chevronDown;
  const swatchHolder = el('span');
  button.append(swatchHolder, label, chevron);
  updaters.push(() => {
    const theme = THEMES.find((x) => x.id === current.theme) ?? THEMES[0];
    swatchHolder.replaceChildren(themeSwatch(theme));
    label.textContent = t('themeLabel', t(theme.name));
    button.title = t('appearance');
  });
  menuButton = button;
  menu ??= buildMenu();
  button.addEventListener('click', () => {
    if (!menu) {
      return;
    }
    const open = menu.hidden;
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) {
      const rect = button.getBoundingClientRect();
      menu.style.top = `${rect.bottom + 6}px`;
      menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
      menu.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    }
  });
  if (!menu.isConnected) {
    document.body.append(menu);
  }

  const language = group(t('language'), [
    segButton(
      '中',
      () => config.lang === 'zh',
      () => update({ language: 'zh-cn' }),
    ),
    segButton(
      'EN',
      () => config.lang === 'en',
      () => update({ language: 'en' }),
    ),
  ]);
  language.title = t('language');

  const nodes = [button, schemeGroup(false), language];
  apply();
  return nodes;
}

apply();
