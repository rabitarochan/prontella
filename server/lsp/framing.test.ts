import { describe, expect, it } from 'vitest';
import { createMessageReader, encodeMessage } from './framing.js';

function collect() {
  const messages: unknown[] = [];
  const errors: Error[] = [];
  const reader = createMessageReader(
    (m) => messages.push(m),
    (e) => errors.push(e),
  );
  return { reader, messages, errors };
}

describe('createMessageReader', () => {
  it('1 チャンク 1 通', () => {
    const { reader, messages } = collect();
    reader.push(encodeMessage({ id: 1 }));
    expect(messages).toEqual([{ id: 1 }]);
  });

  it('1 チャンクに 3 通', () => {
    const { reader, messages } = collect();
    reader.push(Buffer.concat([encodeMessage({ id: 1 }), encodeMessage({ id: 2 }), encodeMessage({ id: 3 })]));
    expect(messages).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it('ヘッダーの途中で分割される', () => {
    const { reader, messages } = collect();
    const whole = encodeMessage({ id: 1 });
    reader.push(whole.subarray(0, 5));
    reader.push(whole.subarray(5, 17));
    expect(messages).toEqual([]);
    reader.push(whole.subarray(17));
    expect(messages).toEqual([{ id: 1 }]);
  });

  it('ボディを 1 バイトずつ push しても壊れない', () => {
    const { reader, messages } = collect();
    const whole = encodeMessage({ text: 'こんにちは' });
    for (let i = 0; i < whole.length; i++) reader.push(whole.subarray(i, i + 1));
    expect(messages).toEqual([{ text: 'こんにちは' }]);
  });

  it('日本語本文をバイト数で正しく切る (次のメッセージを巻き込まない)', () => {
    const { reader, messages } = collect();
    reader.push(Buffer.concat([encodeMessage({ text: '日本語のホバー' }), encodeMessage({ id: 2 })]));
    expect(messages).toEqual([{ text: '日本語のホバー' }, { id: 2 }]);
    // Content-Length が文字数ではなくバイト数であることの直接確認
    expect(encodeMessage({ text: 'あ' }).toString('ascii')).toMatch(/^Content-Length: 14\r\n\r\n/);
  });

  it('未知ヘッダーが混ざっても content-length を拾う (大文字小文字を問わない)', () => {
    const { reader, messages } = collect();
    const body = Buffer.from('{"id":7}', 'utf8');
    reader.push(Buffer.from(`Content-Type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-LENGTH: ${body.length}\r\n\r\n`, 'ascii'));
    reader.push(body);
    expect(messages).toEqual([{ id: 7 }]);
  });

  it('不正な Content-Length は onError で止まり、以後は読まない', () => {
    const { reader, messages, errors } = collect();
    reader.push(Buffer.from('Content-Length: abc\r\n\r\n{}', 'ascii'));
    expect(errors).toHaveLength(1);
    reader.push(encodeMessage({ id: 1 }));
    expect(messages).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('Content-Length が無いヘッダーも onError', () => {
    const { reader, errors } = collect();
    reader.push(Buffer.from('X-Foo: bar\r\n\r\n{}', 'ascii'));
    expect(errors).toHaveLength(1);
  });

  it('本文が JSON でなければ onError', () => {
    const { reader, errors } = collect();
    reader.push(Buffer.from('Content-Length: 3\r\n\r\n{,}', 'ascii'));
    expect(errors).toHaveLength(1);
  });
});
