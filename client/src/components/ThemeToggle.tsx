import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useT, type StringKey } from '../i18n';
import { useTheme, type ThemeMode } from '../theme/themeStore';

const MODES: { mode: ThemeMode; labelKey: StringKey; Icon: typeof Sun }[] = [
  { mode: 'light', labelKey: 'theme.light', Icon: Sun },
  { mode: 'dark', labelKey: 'theme.dark', Icon: Moon },
  { mode: 'system', labelKey: 'theme.system', Icon: Monitor },
];

/** テーマ切り替え(ライト/ダーク/システム追従)。 */
export default function ThemeToggle() {
  const t = useT();
  const mode = useTheme((s) => s.mode);
  const resolved = useTheme((s) => s.resolved);
  const setMode = useTheme((s) => s.setMode);
  const CurrentIcon = resolved === 'dark' ? Moon : Sun;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" title={t('theme.tooltip')} aria-label={t('theme.tooltip')}>
          <CurrentIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {MODES.map(({ mode: m, labelKey, Icon }) => (
          <DropdownMenuItem key={m} onSelect={() => setMode(m)}>
            <Icon />
            {t(labelKey)}
            {mode === m && <Check className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
