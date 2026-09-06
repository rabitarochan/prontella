import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api } from '../../api';
import { useT } from '../../i18n';
import type { VsCodeExtension } from '../../types';
import { useConfirm } from '../ConfirmDialog';

/**
 * VS Code タイルのプロファイル管理。
 *
 * 扱えるのは **Remote 設定 (Machine/settings.json)** と拡張機能だけ。
 * ユーザー設定とキーバインドはブラウザーの IndexedDB にあり、
 * サーバーからは読めも書けもしない (server/vscodeProfile.ts の冒頭に根拠)。
 * その事実は画面にも出す — 「書いたのに効かない」で悩ませないため。
 */
export default function VsCodeSettingsModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { confirm: confirmDialog, dialog } = useConfirm();
  const [settings, setSettings] = useState('');
  const [savedSettings, setSavedSettings] = useState('');
  const [extensions, setExtensions] = useState<VsCodeExtension[]>([]);
  const [newId, setNewId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    void Promise.all([api.vscodeSettings(), api.vscodeExtensions()])
      .then(([s, list]) => {
        setSettings(s.text);
        setSavedSettings(s.text);
        setExtensions(list);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const dirty = settings !== savedSettings;

  const save = async () => {
    setBusy('settings');
    setError('');
    setNotice('');
    try {
      const res = await api.saveVscodeSettings(settings);
      setSettings(res.text);
      setSavedSettings(res.text);
      setNotice(t('vscode.settingsSaved'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const install = async () => {
    const id = newId.trim();
    if (!id) return;
    setBusy(id);
    setError('');
    setNotice('');
    try {
      const res = await api.installVscodeExtension(id);
      setExtensions(res.extensions);
      setNewId('');
      setNotice(t('vscode.extensionChanged'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const uninstall = async (id: string) => {
    const ok = await confirmDialog({
      title: t('vscode.uninstallTitle'),
      message: t('vscode.uninstallMessage', { id }),
      confirmLabel: t('vscode.uninstall'),
      severity: 'danger',
    });
    if (!ok) return;
    setBusy(id);
    setError('');
    setNotice('');
    try {
      const res = await api.uninstallVscodeExtension(id);
      setExtensions(res.extensions);
      setNotice(t('vscode.extensionChanged'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="vscode-settings-dialog">
        <DialogHeader>
          <DialogTitle>{t('vscode.settingsTitle')}</DialogTitle>
        </DialogHeader>

        <div className="vscode-settings-body">
          <section>
            <h3>{t('vscode.remoteSettings')}</h3>
            <p className="vscode-settings-note">{t('vscode.remoteSettingsNote')}</p>
            <textarea
              className="vscode-settings-editor"
              spellCheck={false}
              value={settings}
              onChange={(e) => setSettings(e.target.value)}
            />
            <div className="vscode-settings-row">
              <Button onClick={() => void save()} disabled={!dirty || busy !== null}>
                {t('vscode.saveSettings')}
              </Button>
            </div>
          </section>

          <section>
            <h3>{t('vscode.extensions')}</h3>
            <p className="vscode-settings-note">{t('vscode.extensionsNote')}</p>
            <div className="vscode-settings-row">
              <Input
                placeholder="publisher.name"
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void install();
                }}
              />
              <Button onClick={() => void install()} disabled={!newId.trim() || busy !== null}>
                {busy === newId.trim() ? t('vscode.installing') : t('vscode.install')}
              </Button>
            </div>
            <ul className="vscode-ext-list">
              {extensions.length === 0 && <li className="vscode-settings-note">{t('vscode.noExtensions')}</li>}
              {extensions.map((e) => (
                <li key={e.id}>
                  <span className="vscode-ext-id">{e.id}</span>
                  {e.version && <span className="vscode-ext-version">{e.version}</span>}
                  <button
                    className="vscode-ext-remove"
                    title={t('vscode.uninstall')}
                    disabled={busy !== null}
                    onClick={() => void uninstall(e.id)}
                  >
                    <Trash2 />
                  </button>
                </li>
              ))}
            </ul>
          </section>

          {notice && <p className="vscode-settings-ok">{notice}</p>}
          {error && <p className="vscode-settings-error">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
      {dialog}
    </Dialog>
  );
}
