// Claude のプラン使用量 (5 時間枠 / 週枠 / モデル別枠) の取得。
//
// 出どころは Agent SDK の Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
// — `/usage` コマンドの裏にある構造化データ。ユーザーメッセージを 1 通も送らずに
// 呼べる control request なので、トークンは消費しない (agentSession.ts が
// supportedCommands() / supportedModels() を入力前に投げているのと同じ経路)。
//
// 実測レイテンシー (本実装のもとになった計測): 初回 14.2 秒 / 2 回目 2.8 秒 /
// 3 回目 1.9 秒。初回のほとんどは claude CLI の起動なので、Query は 1 本だけ
// 常駐させて使い回す。
//
// API 名が示すとおり実験的で、shape も存在も変わりうる。呼び出しはこのファイル
// 1 箇所に閉じ、例外・メソッド不在・非サブスクリプションのいずれも
// 「available: false」へ縮退させる (呼び出し側にエラーを見せない)。
//
// 生のペイロードには sdk.d.ts の型に載っていないコードネーム鍵 (tangelo /
// nimbus_quill / iguana_necktie 等) が多数含まれる。型定義にある
// five_hour / seven_day / model_scoped だけを読むこと。

import { query, type Query } from '@anthropic-ai/claude-agent-sdk';
import { terminalEnv } from './childEnv.js';

export interface UsageWindow {
  /** 枠の使用率 0-100。取得できないときは null。 */
  utilization: number | null;
  /** ISO 8601。枠が未アクティブのときは null になりうる。 */
  resetsAt: string | null;
}

export interface UsageModelWindow extends UsageWindow {
  /** サーバー supplied のラベル ('Fable' 等)。 */
  displayName: string;
}

export interface UsageSnapshot {
  /** 'pro' | 'max' | 'team' | 'enterprise' 等。API キー / 3P プロバイダーでは null。 */
  subscriptionType: string | null;
  /** false = プラン制限が適用されない (API キー / Bedrock / Vertex) か取得失敗。 */
  available: boolean;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  /** モデル別の週枠。サーバーが出したときだけ入る。 */
  modelScoped: UsageModelWindow[];
  fetchedAt: number;
}

/** 成功したスナップショットのキャッシュ TTL。 */
const CACHE_TTL_MS = 60_000;
/** 失敗後の再試行間隔 (指数バックオフ)。 */
const RETRY_MIN_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;

function unavailable(): UsageSnapshot {
  return {
    subscriptionType: null,
    available: false,
    fiveHour: null,
    sevenDay: null,
    modelScoped: [],
    fetchedAt: Date.now(),
  };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function window_(v: unknown): UsageWindow | null {
  if (typeof v !== 'object' || v === null) return null;
  const w = v as { utilization?: unknown; resets_at?: unknown };
  return { utilization: num(w.utilization), resetsAt: str(w.resets_at) };
}

/** SDK のレスポンスから、型定義に載っているフィールドだけを取り出す。 */
export function toSnapshot(res: unknown): UsageSnapshot {
  if (typeof res !== 'object' || res === null) return unavailable();
  const r = res as {
    subscription_type?: unknown;
    rate_limits_available?: unknown;
    rate_limits?: unknown;
  };
  const available = r.rate_limits_available === true;
  const limits =
    available && typeof r.rate_limits === 'object' && r.rate_limits !== null
      ? (r.rate_limits as {
          five_hour?: unknown;
          seven_day?: unknown;
          model_scoped?: unknown;
        })
      : null;
  const modelScoped: UsageModelWindow[] = Array.isArray(limits?.model_scoped)
    ? limits.model_scoped
        .map((m): UsageModelWindow | null => {
          const w = window_(m);
          const name = str((m as { display_name?: unknown })?.display_name);
          return w && name ? { displayName: name, ...w } : null;
        })
        .filter((m): m is UsageModelWindow => m !== null)
    : [];

  return {
    subscriptionType: str(r.subscription_type),
    available,
    fiveHour: limits ? window_(limits.five_hour) : null,
    sevenDay: limits ? window_(limits.seven_day) : null,
    modelScoped,
    fetchedAt: Date.now(),
  };
}

/** 入力を一切出さない prompt。CLI は control request で起動するので、これで足りる。 */
function silentPrompt(): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]: () => ({
      // 解決しない = ストリーミング入力モードのまま待機し続ける
      next: () => new Promise<IteratorResult<never>>(() => {}),
    }),
  };
}

class UsageProbe {
  private q: Query | null = null;
  private cache: UsageSnapshot | null = null;
  private inflight: Promise<UsageSnapshot> | null = null;
  private failures = 0;
  private nextRetryAt = 0;
  private closed = false;

  /** TTL キャッシュ + single-flight。初回は 15 秒程度かかる。 */
  getUsage(): Promise<UsageSnapshot> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < CACHE_TTL_MS) {
      return Promise.resolve(this.cache);
    }
    // 直近が失敗ならバックオフ中は取りに行かず、最後の結果 (無ければ unavailable) を返す
    if (this.failures > 0 && now < this.nextRetryAt) {
      return Promise.resolve(this.cache ?? unavailable());
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.fetch().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetch(): Promise<UsageSnapshot> {
    try {
      const q = this.ensureQuery();
      const fn = (
        q as unknown as {
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>;
        }
      ).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (typeof fn !== 'function') {
        // SDK が未対応のバージョン。プロセスを作り直しても直らないので殺しておく
        this.disposeQuery();
        return this.fail();
      }
      const snapshot = toSnapshot(await fn.call(q));
      this.failures = 0;
      this.cache = snapshot;
      return snapshot;
    } catch {
      // CLI が落ちた / control request が壊れた。次回は作り直す
      this.disposeQuery();
      return this.fail();
    }
  }

  private fail(): UsageSnapshot {
    this.failures += 1;
    this.nextRetryAt =
      Date.now() + Math.min(RETRY_MIN_MS * 2 ** (this.failures - 1), RETRY_MAX_MS);
    this.cache = unavailable();
    return this.cache;
  }

  private ensureQuery(): Query {
    if (this.q) return this.q;
    this.q = query({
      prompt: silentPrompt(),
      options: {
        cwd: process.cwd(),
        // env を指定するとサブプロセスの環境は「マージではなく完全置換」になる
        // (SDK 仕様)。agentSession.ts と同じく terminalEnv() のフルセットを渡し、
        // deck の起動元シェル由来の汚染を claude に持ち込まない (pj-child-env)。
        env: terminalEnv(),
      },
    });
    return this.q;
  }

  private disposeQuery(): void {
    const q = this.q;
    this.q = null;
    try {
      void q?.interrupt?.();
    } catch {
      // 既に死んでいる — 次回 ensureQuery で作り直す
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.disposeQuery();
  }
}

const probe = new UsageProbe();

export function getUsage(): Promise<UsageSnapshot> {
  return probe.getUsage();
}

export function closeUsageProbe(): void {
  probe.close();
}
