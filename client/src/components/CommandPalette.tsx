import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import fuzzysort from 'fuzzysort';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { findWorktree, resolveAndSelect, useAgentEvents, waitingSessions } from '../agentEvents';
import { useLang, useT } from '../i18n';
import { getActiveWorktreeCommands } from '../layout/worktreeCommands';
import { isActive } from '../repoSections';
import { getActiveFilesTab, type FilesTabHandle } from '../search/registry';
import { useDeck } from '../store';
import { useTheme } from '../theme/themeStore';
import type { ActiveRepo } from '../types';

type Section = 'waiting' | 'worktrees' | 'commands';

interface PaletteItem {
  id: string;
  section: Section;
  icon: string; // codicon 名
  iconClass?: string;
  label: string;
  sub?: string;
  run: () => void;
}

/**
 * Ctrl+K グローバルコマンドパレット: 確認待ちセッションへの直行 / ワークツリー
 * 移動 (全リポジトリー横断) / コマンド (Claude 起動・Worktree 追加・テーマ・言語)。
 * Ctrl+P (ファイル検索) は QuickOpenModal のまま共存し、ここからも呼び出せる。
 */
export default function CommandPalette({
  onClose,
  onOpenQuickOpen,
  onAddWorktree,
}: {
  onClose: () => void;
  onOpenQuickOpen: (target: FilesTabHandle) => void;
  onAddWorktree: (repo: ActiveRepo) => void;
}) {
  const t = useT();
  const setLang = useLang((s) => s.setLang);
  const setThemeMode = useTheme((s) => s.setMode);
  const { repos, select } = useDeck();
  const sessions = useAgentEvents((s) => s.sessions);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo<PaletteItem[]>(() => {
    const all: PaletteItem[] = [];
    for (const s of waitingSessions(sessions)) {
      const hit = findWorktree(s.cwd);
      all.push({
        id: `waiting:${s.id}`,
        section: 'waiting',
        icon: 'bell-dot',
        iconClass: 'palette-icon-waiting',
        label: hit
          ? `${hit.repo.name} / ${hit.worktree.branch ?? '(detached)'}`
          : s.cwd.split(/[\\/]/).pop() || s.cwd,
        sub: s.cwd,
        run: () => void resolveAndSelect(s.cwd),
      });
    }
    for (const repo of repos.filter(isActive)) {
      for (const wt of repo.worktrees) {
        all.push({
          id: `wt:${wt.path}`,
          section: 'worktrees',
          icon: 'git-branch',
          label: `${repo.name} / ${
            repo.gitMode === 'none'
              ? t('common.noGit')
              : (wt.branch ?? t('common.detached', { head: wt.head }))
          }`,
          sub: wt.path,
          run: () => select({ repoId: repo.id, worktreePath: wt.path }),
        });
      }
    }
    const wtCommands = getActiveWorktreeCommands();
    if (wtCommands) {
      all.push({
        id: 'cmd:claude',
        section: 'commands',
        icon: 'sparkle',
        iconClass: 'palette-icon-claude',
        label: t('palette.launchClaude'),
        run: () => wtCommands.launchClaude(),
      });
    }
    const filesTab = getActiveFilesTab();
    if (filesTab) {
      all.push({
        id: 'cmd:quickopen',
        section: 'commands',
        icon: 'search',
        label: t('palette.quickOpen'),
        run: () => onOpenQuickOpen(filesTab),
      });
    }
    for (const repo of repos.filter(isActive)) {
      if (repo.gitMode !== 'root') continue;
      all.push({
        id: `cmd:addwt:${repo.id}`,
        section: 'commands',
        icon: 'repo',
        label: t('palette.addWorktree', { repo: repo.name }),
        run: () => onAddWorktree(repo),
      });
    }
    all.push(
      {
        id: 'cmd:theme:light',
        section: 'commands',
        icon: 'color-mode',
        label: t('palette.theme', { mode: t('theme.light') }),
        run: () => setThemeMode('light'),
      },
      {
        id: 'cmd:theme:dark',
        section: 'commands',
        icon: 'color-mode',
        label: t('palette.theme', { mode: t('theme.dark') }),
        run: () => setThemeMode('dark'),
      },
      {
        id: 'cmd:theme:system',
        section: 'commands',
        icon: 'color-mode',
        label: t('palette.theme', { mode: t('theme.system') }),
        run: () => setThemeMode('system'),
      },
      {
        id: 'cmd:lang:ja',
        section: 'commands',
        icon: 'globe',
        label: t('palette.langJa'),
        run: () => setLang('ja'),
      },
      {
        id: 'cmd:lang:en',
        section: 'commands',
        icon: 'globe',
        label: t('palette.langEn'),
        run: () => setLang('en'),
      },
    );
    if (!query) return all;
    return fuzzysort
      .go(query, all, { keys: ['label', 'sub'], limit: 50 })
      .map((r) => r.obj);
  }, [sessions, repos, query, t, select, setThemeMode, setLang, onOpenQuickOpen, onAddWorktree]);

  useEffect(() => setSelected(0), [items]);
  useEffect(() => {
    listRef.current
      ?.querySelectorAll('[data-palette-item]')
      [selected]?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const runItem = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length === 0) return;
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setSelected((s) => (s + delta + items.length) % items.length);
    } else if (e.key === 'Enter') {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return; // IME confirm
      runItem(items[selected]);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  const sectionTitle = (section: Section): string =>
    section === 'waiting'
      ? t('bell.waitingSection')
      : section === 'worktrees'
        ? t('palette.sectionWorktrees')
        : t('palette.sectionCommands');

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="top-[15%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-[600px]"
      >
        <DialogTitle className="sr-only">{t('palette.title')}</DialogTitle>
        <input
          className="placeholder:text-muted-foreground h-11 w-full border-b bg-transparent px-4 text-sm outline-none"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('palette.placeholder')}
          autoFocus
          spellCheck={false}
        />
        <div className="max-h-[420px] overflow-y-auto p-1" ref={listRef}>
          {items.length === 0 && (
            <div className="text-muted-foreground py-6 text-center text-sm">
              {t('search.noResults')}
            </div>
          )}
          {items.map((item, i) => (
            <Fragment key={item.id}>
              {!query && (i === 0 || items[i - 1].section !== item.section) && (
                <div className="text-muted-foreground px-2 py-1.5 text-xs">
                  {sectionTitle(item.section)}
                </div>
              )}
              <div
                data-palette-item
                className={cn(
                  'flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
                  i === selected && 'bg-accent text-accent-foreground',
                )}
                onClick={() => runItem(item)}
                onMouseEnter={() => setSelected(i)}
                title={item.sub}
              >
                <span
                  className={cn(`codicon codicon-${item.icon} shrink-0 text-[14px]!`, item.iconClass)}
                />
                <span className="shrink-0">{item.label}</span>
                {item.sub && (
                  <span className="text-muted-foreground truncate text-xs">{item.sub}</span>
                )}
              </div>
            </Fragment>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
