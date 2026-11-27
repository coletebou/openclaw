// How strongly the avatar should light up, from model speech. Cheap enough to run inline on
// every audio chunk. Each 20 ms hop yields one integer 0..100: loudness against a slowly
// decaying peak, so a quiet voice still lights the avatar and syllables read as pulses.

export const VOICE_LEVEL_HOP_MS = 20;
const SAMPLE_RATE_HZ = 24_000;
const HOP_SAMPLES = (SAMPLE_RATE_HZ * VOICE_LEVEL_HOP_MS) / 1000;
const SILENCE_RMS = 0.008;
const PEAK_FLOOR_RMS = 0.05;
// The loudness reference halves in about 7 seconds of quieter speech.
const PEAK_DECAY_PER_HOP = 0.998;
// Speech this far under the running peak no longer lights the avatar.
const RANGE_DB = 30;

/**
 * Returns an analyzer for one call's speech. Each call maps a PCM16 24 kHz mono chunk to one
 * level per complete hop. A trailing partial hop is dropped: the next chunk carries its own
 * start time, so nothing drifts, and the page interpolates across the gap.
 */
export function createVoiceLevelAnalyzer(): (pcm: Buffer) => number[] {
  let peakRms = PEAK_FLOOR_RMS;
  return (pcm) => {
    const levels: number[] = [];
    const hops = Math.floor(pcm.byteLength / 2 / HOP_SAMPLES);
    for (let hop = 0; hop < hops; hop += 1) {
      let total = 0;
      for (let index = 0; index < HOP_SAMPLES; index += 1) {
        const sample = pcm.readInt16LE((hop * HOP_SAMPLES + index) * 2) / 32_768;
        total += sample * sample;
      }
      const rms = Math.sqrt(total / HOP_SAMPLES);
      peakRms = Math.max(rms, peakRms * PEAK_DECAY_PER_HOP, PEAK_FLOOR_RMS);
      if (rms < SILENCE_RMS) {
        levels.push(0);
        continue;
      }
      const aboveFloor = Math.max(0, 1 + (20 * Math.log10(rms / peakRms)) / RANGE_DB);
      levels.push(Math.round(aboveFloor ** 1.5 * 100));
    }
    return levels;
  };
}
