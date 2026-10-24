// 模擬の音声レンダラー（B05-06、ADR 0050。設計 10 §1・§1A）。実際のマイク・WebRTC・OpenAI を使わない。
// DOM・Node.js・Electron に依存しない純粋なクラスで、音声レンダラーの窓（src/voice/voice-main.ts）と node:test の両方で動く。
// - main の 6 つの命令（VoiceRendererRequest）を受け、世代を照合して適用し、ACK（VoiceRendererAck）を返す。
//   自分の世代より古い命令は適用せず ignored_stale_epoch と自分の世代を返す（rendererEpochDecision）。
// - 停止の命令（stop_playback・close_voice_session・suspend_io）は、ACK を待たずにその場でローカルに止める（第 1 層）。
// - 合成の PCM（16 kHz・mono・16 bit・20 ms のフレーム）を作り、収音中はリング（上限 60 秒）へ入れ、会話中は「外部へ送った」
//   数を数える（実際には送らない）。suspend_io の後に送った数が増えないことを試験で確かめる。
// - 故障の注入: ACK の遅延・特定の命令で固まる（ハング）・ACK の欠落・適用の失敗。固まった後も、送信は止まらない
//   （実機では WebRTC の送信は別のスレッドで動き続けるため。止めるのは main の強制終了だけ）。
import {
  VOICE_IPC_CHANNELS,
  rendererEpochDecision,
  voiceRequestErrors,
  type VoiceEpochs,
  type VoiceIpcChannel,
} from '@buddy/domain';

export const PCM_SAMPLE_RATE = 16_000;
export const PCM_FRAME_MS = 20;
export const PCM_FRAME_SAMPLES = (PCM_SAMPLE_RATE * PCM_FRAME_MS) / 1000;
// リングの上限（60 秒。設計 10 §5A の方式 A の上限と同じ）。
export const PCM_RING_FRAMES = (60 * 1000) / PCM_FRAME_MS;

export interface MockFaults {
  // ACK を返すまでの遅延（ms）。ローカルの停止は遅らせない。
  readonly delayMs: number;
  // この命令を受けたら固まる（以後、命令も ACK も処理しない）。null は固まらない。
  readonly hangOn: VoiceIpcChannel | null;
  // ACK を返さない命令（適用はする）。
  readonly dropAck: readonly VoiceIpcChannel[];
  // 適用に失敗して outcome failed を返す命令。
  readonly fail: readonly VoiceIpcChannel[];
}

export const NO_FAULTS: MockFaults = {
  delayMs: 0,
  hangOn: null,
  dropAck: [],
  fail: [],
};

const SHORT_NAMES: Readonly<Record<string, VoiceIpcChannel>> =
  Object.fromEntries(
    VOICE_IPC_CHANNELS.map((channel) => [
      channel.slice('voice.'.length),
      channel,
    ]),
  );

// 故障の指定（開発の起動の --buddy-voice-fault=）。形は「delay=250,hang=suspend_io,drop=stop_playback:play,fail=play」。
// 知らない項目・値は全体を無効にして故障なしにする（指定の誤りで黙って一部だけ効かせない）。
export function parseMockFaults(spec: string | null): MockFaults {
  if (spec === null || spec === '') return NO_FAULTS;
  let delayMs = 0;
  let hangOn: VoiceIpcChannel | null = null;
  const dropAck: VoiceIpcChannel[] = [];
  const fail: VoiceIpcChannel[] = [];
  const channels = (value: string): VoiceIpcChannel[] | null => {
    const out = value.split(':').map((name) => SHORT_NAMES[name]);
    return out.every((channel) => channel !== undefined)
      ? (out as VoiceIpcChannel[])
      : null;
  };
  for (const part of spec.split(',')) {
    const [key, value = ''] = part.split('=');
    if (key === 'delay' && /^\d{1,5}$/u.test(value)) delayMs = Number(value);
    else if (key === 'hang' && SHORT_NAMES[value] !== undefined)
      hangOn = SHORT_NAMES[value] ?? null;
    else if (key === 'drop' && channels(value) !== null)
      dropAck.push(...(channels(value) ?? []));
    else if (key === 'fail' && channels(value) !== null)
      fail.push(...(channels(value) ?? []));
    else return NO_FAULTS;
  }
  return { delayMs, hangOn, dropAck, fail };
}

export interface MockAck {
  readonly request_id: string;
  readonly channel: VoiceIpcChannel;
  readonly outcome:
    'applied' | 'ignored_stale_epoch' | 'rejected_invalid' | 'failed';
  readonly io_epoch: string;
  readonly audio_epoch: string | null;
  readonly output_epoch: string;
  readonly session_epoch: string | null;
  readonly acked_at: string;
}

export interface MockRendererPorts {
  readonly ack: (ack: MockAck) => void;
  // 遅延の後に実行する（窓では setTimeout、試験では手で進める時計）。
  readonly schedule: (ms: number, task: () => void) => void;
  // ACK の acked_at（UTC の RFC 3339）。
  readonly wallNow: () => string;
  // 固まる（窓では本当にイベントループを止める。試験では何もしない）。
  readonly hang?: () => void;
}

interface Epochs {
  io: string | null;
  audio: string | null;
  output: string | null;
  session: string | null;
}

export interface MockRendererStats {
  readonly hung: boolean;
  // Live の接続を開いている（模擬）。
  readonly live: boolean;
  // 送信トラックが有効（会話中に外部へ送る）。
  readonly sending: boolean;
  // 収音している（合成の PCM をリングへ入れる）。
  readonly capturing: boolean;
  readonly playing: boolean;
  readonly ringFrames: number;
  // 外部へ送ったフレームの数（模擬。実際には送らない）。
  readonly sentFrames: number;
  readonly clipsPlayed: readonly string[];
  readonly silenceTimeoutMs: number | null;
  readonly epochs: Readonly<Epochs>;
  // 最後に適用した停止（第 1 層）の命令。
  readonly lastLocalStop: VoiceIpcChannel | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const bigger = (a: string | null, b: string | null): string | null => {
  if (a === null) return b;
  if (b === null) return a;
  return BigInt(a) >= BigInt(b) ? a : b;
};

// 合成の PCM の 1 フレーム（440 Hz の小さな正弦波）。実際の音声ではない。
export function syntheticFrame(index: number): Int16Array {
  const frame = new Int16Array(PCM_FRAME_SAMPLES);
  for (let i = 0; i < PCM_FRAME_SAMPLES; i += 1) {
    const t = (index * PCM_FRAME_SAMPLES + i) / PCM_SAMPLE_RATE;
    frame[i] = Math.round(Math.sin(2 * Math.PI * 440 * t) * 1000);
  }
  return frame;
}

export class MockVoiceRenderer {
  readonly #ports: MockRendererPorts;
  readonly #faults: MockFaults;
  #epochs: Epochs = { io: null, audio: null, output: null, session: null };
  #hung = false;
  #live = false;
  #sending = false;
  #capturing = false;
  #playing = false;
  #ring: Int16Array[] = [];
  #frameIndex = 0;
  #sentFrames = 0;
  #clips: string[] = [];
  #silenceTimeoutMs: number | null = null;
  #lastLocalStop: VoiceIpcChannel | null = null;

  constructor(ports: MockRendererPorts, faults: MockFaults = NO_FAULTS) {
    this.#ports = ports;
    this.#faults = faults;
  }

  get stats(): MockRendererStats {
    return {
      hung: this.#hung,
      live: this.#live,
      sending: this.#sending,
      capturing: this.#capturing,
      playing: this.#playing,
      ringFrames: this.#ring.length,
      sentFrames: this.#sentFrames,
      clipsPlayed: [...this.#clips],
      silenceTimeoutMs: this.#silenceTimeoutMs,
      epochs: { ...this.#epochs },
      lastLocalStop: this.#lastLocalStop,
    };
  }

  // 20 ms ごとに呼ぶ。固まっていても、開いた送信トラックは止まらない（実機の WebRTC の模型）。
  tick(): void {
    if (this.#hung) {
      if (this.#live && this.#sending) this.#sentFrames += 1;
      return;
    }
    if (this.#capturing) {
      this.#ring.push(syntheticFrame(this.#frameIndex));
      this.#frameIndex += 1;
      if (this.#ring.length > PCM_RING_FRAMES) this.#ring.shift();
    }
    if (this.#live && this.#sending) this.#sentFrames += 1;
  }

  receive(raw: unknown): void {
    if (this.#hung) return;
    if (
      !isRecord(raw) ||
      typeof raw['request_id'] !== 'string' ||
      typeof raw['channel'] !== 'string' ||
      !(VOICE_IPC_CHANNELS as readonly string[]).includes(raw['channel']) ||
      !isRecord(raw['payload']) ||
      typeof raw['ack_timeout_ms'] !== 'number'
    )
      return;
    const channel = raw['channel'] as VoiceIpcChannel;
    const requestId = raw['request_id'];
    const payload = raw['payload'];
    if (this.#faults.hangOn === channel) {
      this.#hung = true;
      this.#ports.hang?.();
      return;
    }
    const command = {
      io_epoch: str(payload['io_epoch']),
      audio_epoch: str(payload['audio_epoch']),
      output_epoch: str(payload['output_epoch']),
      session_epoch: str(payload['session_epoch']),
    };
    const invalid =
      voiceRequestErrors({
        channel,
        request_id: requestId,
        ack_timeout_ms: raw['ack_timeout_ms'],
        payload: payload as never,
      }).length > 0 ||
      Object.values(command).some(
        (value) => value !== null && !/^(?:0|[1-9][0-9]*)$/u.test(value),
      );
    if (invalid) {
      this.#reply(requestId, channel, 'rejected_invalid', command);
      return;
    }
    const current = {
      io_epoch: this.#epochs.io,
      audio_epoch: this.#epochs.audio,
      output_epoch: this.#epochs.output,
      session_epoch: this.#epochs.session,
    };
    if (
      rendererEpochDecision(defined(command), defined(current)) ===
      'ignore_stale'
    ) {
      this.#reply(requestId, channel, 'ignored_stale_epoch', current);
      return;
    }
    if (this.#faults.fail.includes(channel)) {
      this.#reply(requestId, channel, 'failed', command);
      return;
    }
    this.#epochs = {
      io: bigger(this.#epochs.io, command.io_epoch),
      audio: bigger(this.#epochs.audio, command.audio_epoch),
      output: bigger(this.#epochs.output, command.output_epoch),
      session: bigger(this.#epochs.session, command.session_epoch),
    };
    this.#apply(channel, payload);
    if (this.#faults.dropAck.includes(channel)) return;
    this.#reply(requestId, channel, 'applied', command);
  }

  #apply(channel: VoiceIpcChannel, payload: Record<string, unknown>): void {
    switch (channel) {
      case 'voice.start':
        // 模擬では、answer の適用と同時に送信トラックを有効にする（session.started とサイドバンド接続済みの両方を待つ門は、
        // サイドバンド接続済みを音声レンダラーへ伝える経路が決まっていない。ADR 0041 の U28、ADR 0050）。
        this.#live = true;
        this.#capturing = true;
        this.#sending = true;
        return;
      case 'voice.stop_playback':
        // 再生だけを止め、待機中の音声を捨てる。収音・Live の入力は保つ（10 §1A）。
        this.#playing = false;
        this.#lastLocalStop = channel;
        return;
      case 'voice.close_voice_session':
        // Live の送受信と再生を終える。端末内の収音（KWS・③）は入出力の許可に従うので保つ（10 §1A）。
        this.#live = false;
        this.#sending = false;
        this.#playing = false;
        this.#lastLocalStop = channel;
        return;
      case 'voice.suspend_io':
        // 第 1 層: 再生の mute・待機音声の破棄・送信の無効・収音の停止・PCM とリングの消去・WebRTC を閉じる（10 §1）。
        this.#playing = false;
        this.#sending = false;
        this.#live = false;
        this.#capturing = false;
        for (const frame of this.#ring) frame.fill(0);
        this.#ring = [];
        this.#lastLocalStop = channel;
        return;
      case 'voice.play':
        this.#clips.push(String(payload['clip_id']));
        return;
      case 'voice.set_silence_timeout':
        this.#silenceTimeoutMs = Number(payload['timeout_ms']);
        return;
    }
  }

  #reply(
    requestId: string,
    channel: VoiceIpcChannel,
    outcome: MockAck['outcome'],
    epochs: {
      readonly io_epoch: string | null;
      readonly audio_epoch: string | null;
      readonly output_epoch: string | null;
      readonly session_epoch: string | null;
    },
  ): void {
    // 要求にない世代は自分の世代を返す（ACK の形は 4 つの世代を必ず持つ）。
    const ack: MockAck = {
      request_id: requestId,
      channel,
      outcome,
      io_epoch: epochs.io_epoch ?? this.#epochs.io ?? '0',
      audio_epoch: epochs.audio_epoch ?? this.#epochs.audio,
      output_epoch: epochs.output_epoch ?? this.#epochs.output ?? '0',
      session_epoch: epochs.session_epoch ?? this.#epochs.session,
      acked_at: this.#ports.wallNow(),
    };
    if (this.#faults.delayMs > 0)
      this.#ports.schedule(this.#faults.delayMs, () => {
        // 遅延の間に固まったら、遅れた ACK も返さない。
        if (!this.#hung) this.#ports.ack(ack);
      });
    else this.#ports.ack(ack);
  }
}

const str = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

// 値のない世代を除いた形（domain の VoiceEpochs は省略で「その世代を見ない」を表す）。
function defined(epochs: {
  readonly io_epoch: string | null;
  readonly audio_epoch: string | null;
  readonly output_epoch: string | null;
  readonly session_epoch: string | null;
}): VoiceEpochs {
  const out: { -readonly [K in keyof VoiceEpochs]: VoiceEpochs[K] } = {};
  if (epochs.io_epoch !== null) out.io_epoch = epochs.io_epoch;
  if (epochs.audio_epoch !== null) out.audio_epoch = epochs.audio_epoch;
  if (epochs.output_epoch !== null) out.output_epoch = epochs.output_epoch;
  if (epochs.session_epoch !== null) out.session_epoch = epochs.session_epoch;
  return out;
}
