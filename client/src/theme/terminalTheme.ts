import type { ITheme } from '@xterm/xterm';
import type { ResolvedTheme } from './themeStore';

// xterm はページの CSS 変数を参照できないため、ここに実色で定義する。
// 値は index.css のトークン(--terminal-bg 等)と揃えること。
// ANSI 16 色は VS Code の Dark+ / Light+ のターミナルパレットに合わせた。

const DARK: ITheme = {
  background: '#09090b',
  foreground: '#e4e4e7',
  cursor: '#e4e4e7',
  selectionBackground: '#264f78',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

const LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#3f3f46',
  cursor: '#3f3f46',
  selectionBackground: '#add6ff',
  black: '#000000',
  red: '#cd3131',
  green: '#00bc00',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5',
};

export function terminalTheme(resolved: ResolvedTheme): ITheme {
  return resolved === 'dark' ? DARK : LIGHT;
}
