import { useEffect } from 'react';

type CardState = {
  expanded: boolean;
};

function savedListContent(heading: HTMLElement): HTMLElement | null {
  const candidate = heading.nextElementSibling;
  return candidate instanceof HTMLElement
    && (candidate.matches('.ads-txt-requirement-list') || candidate.matches('.ads-txt-empty'))
    ? candidate
    : null;
}

function rowLabel(content: HTMLElement | null, expanded: boolean): string {
  if (expanded) return 'Hide list';
  const count = content?.querySelectorAll('.ads-txt-requirement').length ?? 0;
  return count ? `Show ${count} row${count === 1 ? '' : 's'}` : 'Show list';
}

function updateToggle(toggle: HTMLButtonElement, label: string, expanded: boolean): void {
  toggle.setAttribute('aria-expanded', String(expanded));
  if (toggle.dataset.label === label && toggle.dataset.expanded === String(expanded)) return;

  const text = document.createElement('span');
  text.textContent = label;
  const chevron = document.createElement('span');
  chevron.className = 'ads-txt-requirements-collapse-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '⌄';
  toggle.replaceChildren(text, chevron);
  toggle.dataset.label = label;
  toggle.dataset.expanded = String(expanded);
}

export default function AdsTxtRequirementsCollapse() {
  useEffect(() => {
    const states = new WeakMap<HTMLElement, CardState>();
    const toggleCleanups = new Map<HTMLButtonElement, () => void>();
    const searchCleanups = new Map<HTMLInputElement, () => void>();

    const renderCard = (card: HTMLElement): void => {
      const heading = card.querySelector<HTMLElement>('.ads-txt-saved-search-heading');
      if (!heading) return;

      const searchInput = card.querySelector<HTMLInputElement>('.ads-txt-list-toolbar input[type="search"]');
      let state = states.get(card);
      if (!state) {
        state = { expanded: Boolean(searchInput?.value.trim()) };
        states.set(card, state);
      }

      let toggle = heading.querySelector<HTMLButtonElement>('.ads-txt-requirements-collapse-toggle');
      if (!toggle) {
        toggle = document.createElement('button');
        toggle.className = 'ads-txt-requirements-collapse-toggle';
        toggle.type = 'button';
        toggle.setAttribute('aria-label', 'Show or hide saved ads.txt requirements');

        const onToggle = () => {
          const current = states.get(card) ?? { expanded: false };
          current.expanded = !current.expanded;
          states.set(card, current);
          renderCard(card);
        };

        toggle.addEventListener('click', onToggle);
        toggleCleanups.set(toggle, () => toggle?.removeEventListener('click', onToggle));
        heading.append(toggle);
      }

      const content = savedListContent(heading);
      if (content) {
        if (!content.id) content.id = 'ads-txt-saved-requirements-list-content';
        content.hidden = !state.expanded;
        toggle.setAttribute('aria-controls', content.id);
      }

      updateToggle(toggle, rowLabel(content, state.expanded), state.expanded);

      if (searchInput && !searchCleanups.has(searchInput)) {
        const onSearch = () => {
          if (!searchInput.value.trim()) return;
          const current = states.get(card) ?? { expanded: false };
          current.expanded = true;
          states.set(card, current);
          renderCard(card);
        };

        searchInput.addEventListener('input', onSearch, true);
        searchCleanups.set(searchInput, () => searchInput.removeEventListener('input', onSearch, true));
      }
    };

    const apply = () => {
      document.querySelectorAll<HTMLElement>('#ads-txt-saved-requirements').forEach(renderCard);

      for (const [toggle, cleanup] of toggleCleanups) {
        if (toggle.isConnected) continue;
        cleanup();
        toggleCleanups.delete(toggle);
      }

      for (const [input, cleanup] of searchCleanups) {
        if (input.isConnected) continue;
        cleanup();
        searchCleanups.delete(input);
      }
    };

    const root = document.getElementById('root');
    const observer = new MutationObserver(apply);
    if (root) observer.observe(root, { childList: true, subtree: true });
    apply();

    return () => {
      observer.disconnect();
      toggleCleanups.forEach((cleanup) => cleanup());
      searchCleanups.forEach((cleanup) => cleanup());
      toggleCleanups.clear();
      searchCleanups.clear();
    };
  }, []);

  return null;
}
