// Theme / light-dark / language preferences: applies them to the page and provides
// both the Settings Drawer sections and the compact pin-to-toolbar widgets.
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

const updaters = new Set<() => void>();

function updateControls(): void {
  updaters.forEach((u) => u());
}

function apply(): void {
  const body = document.body;
  if (current.scheme === 'auto') {
    delete body.dataset.scheme;
  } else {
    body.dataset.scheme = current.scheme;
  }
  body.dataset.theme = current.theme;
  body.dataset.mdWidth = current.mdWidth;
  body.dataset.sidebarPos = current.sidebarPosition;
  if (current.mdFontSize) {
    body.style.setProperty('--md-font-size', `${current.mdFontSize}px`);
  }
  if (current.mdLineHeight) {
    body.style.setProperty('--md-line-height', String(current.mdLineHeight));
  }
  const dark = effectiveDark();
  setClass('dv-dark', dark);
  setClass('dv-invert-pages', dark && current.invertPages);
  setClass('dv-highlight', current.highlight);
  body.style.colorScheme = dark ? 'dark' : 'light';
  updateControls();
}

export function updateAppearance(patch: Partial<Appearance>): void {
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

// ---------------------------------------------------------------- metadata

export const THEMES: { id: ThemeId; name: StringKey; desc: StringKey; swatch: [string, string, string] }[] = [
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
  const sync = () => b.setAttribute('aria-pressed', String(pressed()));
  updaters.add(sync);
  sync();
  return b;
}

function group(label: string, buttons: HTMLButtonElement[], wide = false): HTMLElement {
  const node = el('div', { class: wide ? 'dv-seg dv-seg-wide' : 'dv-seg' }, buttons);
  node.setAttribute('role', 'group');
  node.setAttribute('aria-label', label);
  return node;
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

// ---------------------------------------------------------------- compact toolbar widgets (when pinned)

/** Toolbar toggle for row/column highlighting, shared by the sheet and Markdown views. */
export function highlightToggle(): HTMLButtonElement {
  const b = el('button', { class: 'dv-btn dv-icon-btn', title: t('highlightRowCol') });
  b.type = 'button';
  b.innerHTML = icons.crosshair;
  b.addEventListener('click', () => updateAppearance({ highlight: !current.highlight }));
  const sync = () => {
    b.setAttribute('aria-pressed', String(current.highlight));
    b.classList.toggle('dv-active', current.highlight);
  };
  updaters.add(sync);
  sync();
  return b;
}

/** Toolbar toggle that locks cell editing in sheets. */
export function lockToggle(): HTMLButtonElement {
  const b = el('button', { class: 'dv-btn dv-icon-btn', title: t('lockEdits') });
  b.type = 'button';
  b.innerHTML = icons.lock;
  b.addEventListener('click', () => updateAppearance({ lockEdits: !current.lockEdits }));
  const sync = () => {
    b.setAttribute('aria-pressed', String(current.lockEdits));
    b.classList.toggle('dv-active', current.lockEdits);
  };
  updaters.add(sync);
  sync();
  return b;
}

/** Compact toolbar toggle for Markdown fixed vs adaptive content width. */
export function mdWidthToggle(): HTMLButtonElement {
  const b = el('button', { class: 'dv-btn dv-icon-btn', title: t('mdWidthToggle') });
  b.type = 'button';
  b.innerHTML = icons.fitWidth;
  b.addEventListener('click', () =>
    updateAppearance({ mdWidth: current.mdWidth === 'fluid' ? 'fixed' : 'fluid' }),
  );
  const sync = () => {
    const fluid = current.mdWidth === 'fluid';
    b.setAttribute('aria-pressed', String(fluid));
    b.classList.toggle('dv-active', fluid);
  };
  updaters.add(sync);
  sync();
  return b;
}

/** Compact toolbar toggle for inverting paged documents in dark mode. */
export function invertToggle(): HTMLButtonElement {
  const b = el('button', { class: 'dv-btn dv-icon-btn', title: t('invertPages') });
  b.type = 'button';
  b.innerHTML = icons.invert;
  b.addEventListener('click', () => updateAppearance({ invertPages: !current.invertPages }));
  const sync = () => {
    b.setAttribute('aria-pressed', String(current.invertPages));
    b.classList.toggle('dv-active', current.invertPages);
  };
  updaters.add(sync);
  sync();
  return b;
}

/** Compact segmented light/dark switch for pinning on the top toolbar. */
export function schemeToolbarGroup(): HTMLElement {
  return group(
    t('scheme'),
    SCHEMES.map((s) =>
      segButton(
        t(s.label),
        () => current.scheme === s.id,
        () => updateAppearance({ scheme: s.id }),
        icons[s.icon],
      ),
    ),
  );
}

/** Compact segmented language switch for pinning on the top toolbar. */
export function languageToolbarGroup(): HTMLElement {
  const resolvedLang = () => (current.language === 'auto' ? config.lang : current.language === 'en' ? 'en' : 'zh');
  const node = group(t('language'), [
    segButton(
      '中',
      () => resolvedLang() === 'zh',
      () => updateAppearance({ language: 'zh-cn' }),
    ),
    segButton(
      'EN',
      () => resolvedLang() === 'en',
      () => updateAppearance({ language: 'en' }),
    ),
  ]);
  node.title = t('language');
  return node;
}

/** Compact theme picker dropdown button for pinning on the top toolbar. */
export function themeToolbarButton(): HTMLElement {
  const button = el('button', { class: 'dv-btn dv-theme-btn' });
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  const label = el('span', { class: 'dv-theme-label' });
  const chevron = el('span', { class: 'dv-chevron' });
  chevron.innerHTML = icons.chevronDown;
  const swatchHolder = el('span');
  button.append(swatchHolder, label, chevron);

  const popup = el('div', { class: 'dv-menu dv-more-menu' });
  popup.setAttribute('role', 'menu');
  popup.hidden = true;

  const onOutside = (e: MouseEvent) => {
    if (!popup.contains(e.target as Node) && !button.contains(e.target as Node)) {
      close();
    }
  };
  const close = () => {
    if (!popup.hidden) {
      popup.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', onOutside);
    }
  };

  for (const theme of THEMES) {
    const item = el('button', { class: 'dv-menu-item' });
    item.type = 'button';
    item.setAttribute('role', 'menuitemradio');
    const mark = el('span', { class: 'dv-menu-check' });
    item.append(mark, themeSwatch(theme), el('span', { class: 'dv-menu-label', text: t(theme.name) }));
    item.addEventListener('click', () => {
      close();
      updateAppearance({ theme: theme.id });
    });
    const syncItem = () => {
      const active = current.theme === theme.id;
      item.setAttribute('aria-checked', String(active));
      mark.innerHTML = active ? icons.check : '';
    };
    updaters.add(syncItem);
    syncItem();
    popup.append(item);
  }

  const syncBtn = () => {
    const theme = THEMES.find((x) => x.id === current.theme) ?? THEMES[0];
    swatchHolder.replaceChildren(themeSwatch(theme));
    label.textContent = t('themeLabel', t(theme.name));
    button.title = t('slotTheme');
  };
  updaters.add(syncBtn);
  syncBtn();

  button.addEventListener('click', () => {
    if (!popup.hidden) {
      close();
      return;
    }
    popup.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onOutside);
    const rect = button.getBoundingClientRect();
    const mw = popup.offsetWidth || 372;
    const mh = popup.offsetHeight || 280;
    popup.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, rect.right - mw))}px`;
    popup.style.right = 'auto';
    popup.style.top = `${Math.max(8, Math.min(window.innerHeight - mh - 8, rect.bottom + 6))}px`;
    popup.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  });
  popup.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      close();
      button.focus();
    }
  });
  document.body.append(popup);
  return button;
}

// ---------------------------------------------------------------- Settings Drawer sections

/** Builds the Appearance and Language sections rendered inside the right-hand Settings Drawer. */
export function buildAppearanceDrawerSections(): HTMLElement[] {
  const themeCards = THEMES.map((theme) => {
    const card = el('button', { class: 'dv-theme-card' });
    card.type = 'button';
    card.setAttribute('role', 'radio');
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
    card.addEventListener('click', () => updateAppearance({ theme: theme.id }));
    const sync = () => card.setAttribute('aria-checked', String(current.theme === theme.id));
    updaters.add(sync);
    sync();
    return card;
  });

  const mdWidthRow = el('div', { class: 'dv-st-row' }, [
    el('span', { class: 'dv-st-label', text: t('mdWidth') }),
    group(t('mdWidth'), [
      segButton(
        t('mdWidthFixed'),
        () => current.mdWidth === 'fixed',
        () => updateAppearance({ mdWidth: 'fixed' }),
      ),
      segButton(
        t('mdWidthFluid'),
        () => current.mdWidth === 'fluid',
        () => updateAppearance({ mdWidth: 'fluid' }),
      ),
    ]),
  ]);
  mdWidthRow.dataset.settingSlot = 'width';

  const splitRow = el('div', { class: 'dv-st-row' }, [
    el('span', { class: 'dv-st-label', text: t('splitPosition') }),
    group(t('splitPosition'), [
      segButton(
        t('splitSourceLeft'),
        () => current.splitPosition === 'sourceLeft',
        () => updateAppearance({ splitPosition: 'sourceLeft' }),
      ),
      segButton(
        t('splitPreviewLeft'),
        () => current.splitPosition === 'previewLeft',
        () => updateAppearance({ splitPosition: 'previewLeft' }),
      ),
    ]),
  ]);

  const schemeRow = el('div', { class: 'dv-st-row' }, [
    el('span', { class: 'dv-st-label', text: t('scheme') }),
    group(
      t('scheme'),
      SCHEMES.map((s) =>
        segButton(
          t(s.label),
          () => current.scheme === s.id,
          () => updateAppearance({ scheme: s.id }),
        ),
      ),
    ),
  ]);
  schemeRow.dataset.settingSlot = 'scheme';

  const invert = el('input');
  invert.type = 'checkbox';
  invert.addEventListener('change', () => updateAppearance({ invertPages: invert.checked }));
  const syncInvert = () => {
    invert.checked = current.invertPages;
  };
  updaters.add(syncInvert);
  syncInvert();

  const notices = el('input');
  notices.type = 'checkbox';
  notices.addEventListener('change', () => updateAppearance({ showNotices: notices.checked }));
  const syncNotices = () => {
    notices.checked = current.showNotices;
  };
  updaters.add(syncNotices);
  syncNotices();

  const themeHeader = el('div', { class: 'dv-st-subhead' }, [
    el('span', { class: 'dv-st-label', text: t('theme') }),
    ...(config.kind !== 'markdown' && config.kind !== 'epub'
      ? [el('span', { class: 'dv-st-muted', text: t('themeMarkdownHint') })]
      : []),
  ]);

  const loupeRow =
    config.kind === 'image'
      ? el('div', { class: 'dv-st-row' }, [
          el('span', { class: 'dv-st-label', text: t('loupePosition') }),
          group(t('loupePosition'), [
            segButton(
              t('loupeFollow'),
              () => current.loupePosition === 'follow',
              () => updateAppearance({ loupePosition: 'follow' }),
            ),
            segButton(
              t('loupeFixed'),
              () => current.loupePosition === 'fixed',
              () => updateAppearance({ loupePosition: 'fixed' }),
            ),
          ]),
        ])
      : undefined;

  const sidebarPosRow =
    config.kind !== 'sheet' && config.kind !== 'text'
      ? el('div', { class: 'dv-st-row' }, [
          el('span', { class: 'dv-st-label', text: t('sidebarPosition') }),
          group(t('sidebarPosition'), [
            segButton(
              t('sidebarLeft'),
              () => current.sidebarPosition === 'left',
              () => updateAppearance({ sidebarPosition: 'left' }),
            ),
            segButton(
              t('sidebarRight'),
              () => current.sidebarPosition === 'right',
              () => updateAppearance({ sidebarPosition: 'right' }),
            ),
          ]),
        ])
      : undefined;

  const themeGrid = el('div', { class: 'dv-theme-grid' }, themeCards);
  themeGrid.setAttribute('role', 'radiogroup');
  themeGrid.setAttribute('aria-label', t('theme'));
  themeGrid.dataset.settingSlot = 'theme';

  const mdTypographyRows =
    config.kind === 'markdown' || config.kind === 'epub'
      ? [
          el('div', { class: 'dv-st-row' }, [
            el('span', { class: 'dv-st-label', text: t('mdFontSize') }),
            group(
              t('mdFontSize'),
              [13, 15, 17, 19].map((sz) =>
                segButton(
                  `${sz}`,
                  () => (current.mdFontSize ?? 15) === sz,
                  () => updateAppearance({ mdFontSize: sz }),
                ),
              ),
            ),
          ]),
          el('div', { class: 'dv-st-row' }, [
            el('span', { class: 'dv-st-label', text: t('mdLineHeight') }),
            group(
              t('mdLineHeight'),
              [1.5, 1.7, 1.9].map((lh) =>
                segButton(
                  String(lh),
                  () => Math.abs((current.mdLineHeight ?? 1.7) - lh) < 0.05,
                  () => updateAppearance({ mdLineHeight: lh }),
                ),
              ),
            ),
          ]),
        ]
      : [];

  const appearanceSection = el('section', { class: 'dv-st-section' }, [
    el('h3', { class: 'dv-st-heading', text: t('appearanceAll') }),
    themeHeader,
    themeGrid,
    mdWidthRow,
    ...mdTypographyRows,
    splitRow,
    ...(sidebarPosRow ? [sidebarPosRow] : []),
    ...(loupeRow ? [loupeRow] : []),
    schemeRow,
    (() => {
      const r = el('label', { class: 'dv-check' }, [invert, el('span', { text: t('invertPages') })]);
      r.dataset.settingSlot = 'invertPages';
      return r;
    })(),
    el('label', { class: 'dv-check' }, [notices, el('span', { text: t('showNotices') })]),
  ]);

  const langChoices = el('div', { class: 'dv-st-choices' });
  langChoices.setAttribute('role', 'radiogroup');
  langChoices.setAttribute('aria-label', t('language'));
  for (const [id, labelKey] of [
    ['auto', 'langAuto'],
    ['zh-cn', 'langZh'],
    ['en', 'langEn'],
  ] as const) {
    const choice = el('button', { class: 'dv-st-choice' });
    choice.type = 'button';
    choice.setAttribute('role', 'radio');
    const dot = el('span', { class: 'dv-st-radio' });
    choice.append(dot, el('span', { text: t(labelKey) }));
    choice.addEventListener('click', () => updateAppearance({ language: id }));
    const sync = () => {
      const selected = current.language === id;
      choice.classList.toggle('dv-selected', selected);
      choice.setAttribute('aria-checked', String(selected));
    };
    updaters.add(sync);
    sync();
    langChoices.append(choice);
  }

  const languageSection = el('section', { class: 'dv-st-section' }, [
    el('h3', { class: 'dv-st-heading', text: t('languageAll') }),
    langChoices,
  ]);
  languageSection.dataset.settingSlot = 'language';

  return [appearanceSection, languageSection];
}

apply();
