/**
 * NoiseSuppressor AudioWorklet
 * 発話間のキーボード音・背景音をノイズゲートで除去
 */
class NoiseSuppressor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'threshold', defaultValue: 0.025, minValue: 0.001, maxValue: 0.5 }];
  }

  constructor() {
    super();
    this.envelope = 0;
    this.holdSamples = 0;
    // メッセージでthresholdを動的変更可能に
    this.port.onmessage = (e) => {
      if (e.data.threshold !== undefined) this._threshold = e.data.threshold;
    };
    this._threshold = null;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) return true;

    const threshold = this._threshold ?? parameters.threshold[0];
    // 350ms ホールド: 発話終了後もゲートを開けておく（語末カットを防ぐ）
    const holdMax = Math.round(sampleRate * 0.35);

    for (let i = 0; i < input.length; i++) {
      const abs = Math.abs(input[i]);

      // エンベロープフォロワー: 急激な立ち上がり・ゆっくりした立ち下がり
      if (abs > this.envelope) {
        this.envelope = abs * 0.85 + this.envelope * 0.15; // 速い追従
      } else {
        this.envelope *= 0.9998; // ゆっくり減衰
      }

      if (this.envelope > threshold) {
        // 音声を検出 → ゲートを開けてホールドタイマーリセット
        this.holdSamples = holdMax;
        output[i] = input[i];
      } else if (this.holdSamples > 0) {
        // ホールド中 → まだゲートを開けておく
        this.holdSamples--;
        output[i] = input[i];
      } else {
        // ゲート閉 → 無音（キーボード・背景音をカット）
        output[i] = 0;
      }
    }
    return true;
  }
}

registerProcessor('noise-suppressor', NoiseSuppressor);
