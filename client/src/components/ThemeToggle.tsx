import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTheme, type ThemeMode } from '../theme/themeStore';

const MODES: { mode: ThemeMode; label: string; Icon: typeof Sun }[] = [
  { mode: 'light', label: 'ライト', Icon: Sun },
  { mode: 'dark', label: 'ダーク', Icon: Moon },
  { mode: 'system', label: 'システム', Icon: Monitor },
];

/** トップバーのテーマ切り替え(ライト/ダーク/システム追従)。 */
export default function ThemeToggle() {
  const mode = useTheme((s) => s.mode);
  const resolved = useTheme((s) => s.resolved);
  const setMode = useTheme((s) => s.setMode);
  const CurrentIcon = resolved === 'dark' ? Moon : Sun;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" title="テーマ切り替え" aria-label="テーマ切り替え">
          <CurrentIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {MODES.map(({ mode: m, label, Icon }) => (
          <DropdownMenuItem key={m} onSelect={() => setMode(m)}>
            <Icon />
            {label}
            {mode === m && <Check className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
