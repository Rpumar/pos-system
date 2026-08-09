// Audio feedback utility using Web Audio API for low-latency beeps
// No external audio files needed — generates tones programmatically.

type ToneType = 'success' | 'error' | 'warning' | 'scan' | 'keypress';

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext || (window as any).webkitAudioContext;
  if (!AC) return null;
  return new AC();
}

let audioContext: AudioContext | null = null;

function ensureAudioContext(): AudioContext | null {
  if (audioContext) return audioContext;
  audioContext = getAudioContext();
  return audioContext;
}

function playTone(frequency: number, duration: number, type: OscillatorType = 'sine', volume = 0.3): void {
  const ctx = ensureAudioContext();
  if (!ctx) return;

  if (ctx.state === 'suspended') ctx.resume();

  const oscillator = ctx.createOscillator();
  const gainNode = ctx.createGain();

  oscillator.type = type;
  oscillator.frequency.value = frequency;
  gainNode.gain.value = volume;

  oscillator.connect(gainNode);
  gainNode.connect(ctx.destination);

  const now = ctx.currentTime;
  oscillator.start(now);
  oscillator.stop(now + duration);
}

export function playSound(type: ToneType): void {
  const ctx = ensureAudioContext();
  if (!ctx) return;

  switch (type) {
    case 'success': // Ascending major chord - payment success
      playTone(523.25, 0.1); // C5
      setTimeout(() => playTone(659.25, 0.1), 80);  // E5
      setTimeout(() => playTone(783.99, 0.15), 160); // G5
      break;
    case 'error': // Descending minor - error
      playTone(349.23, 0.2); // F4
      setTimeout(() => playTone(293.66, 0.3), 150);  // D4
      break;
    case 'warning': // Double beep - low stock, void sale
      playTone(440, 0.1); // A4
      setTimeout(() => playTone(440, 0.1), 150);
      break;
    case 'scan': // Quick high beep - successful scan
      playTone(880, 0.05); // A5
      break;
    case 'keypress': // Very subtle click
      playTone(1000, 0.02, 'square', 0.05);
      break;
  }
}

export function preloadAudio(): void {
  const ctx = ensureAudioContext();
  if (!ctx) return;
  // Prime the audio context on first user interaction
  if (ctx.state === 'suspended') {
    ctx.resume();
  }
}