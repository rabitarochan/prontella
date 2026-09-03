import { useDeck } from '../store';
import { useMonitorView } from './monitorViewStore';
import { useVncView } from './vncViewStore';

/**
 * main 領域のモード切替 (VNC / ターミナルモニター) を 1 か所に集約する。
 *
 * どちらも「リポジトリー未選択のときに main 全体を占める」ビューで互いに排他。
 * 入るときはリポジトリー選択を外す (選択が残っていると App 側の「選択優先」
 * effect が即座にモードを解除してしまう) → 他方を OFF → 自分を ON の順。
 * Rail のボタンとコマンドパレットの両方から呼ぶ。
 */

export function enterVnc(): void {
  useDeck.getState().select(null);
  useMonitorView.getState().setActive(false);
  useVncView.getState().setActive(true);
}

export function exitVnc(): void {
  useVncView.getState().setActive(false);
}

export function enterMonitor(): void {
  useDeck.getState().select(null);
  useVncView.getState().setActive(false);
  useMonitorView.getState().setActive(true);
}

export function exitMonitor(): void {
  useMonitorView.getState().setActive(false);
}
