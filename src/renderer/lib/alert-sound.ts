/**
 * Web Audio API Alert Sound Synthesizer (zero external audio file dependency).
 *
 * Plays a clean, pleasant dual-tone chime (880Hz A5 → 1046.5Hz C6) on loop
 * when an alert fires, stopping when all alert toasts are dismissed or when
 * a 30-second safety timeout is reached.
 */

let audioCtx: AudioContext | null = null;
let loopTimer: any = null;
let autoStopTimer: any = null;
let isLooping = false;

const AUTO_STOP_MS = 30_000; // Stop audio loop after 30 seconds if unattended

function getAudioContext(): AudioContext {
  if (!audioCtx || audioCtx.state === "closed") {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    audioCtx = new AudioContextClass();
  }
  if (audioCtx.state === "suspended") {
    void audioCtx.resume();
  }
  return audioCtx;
}

/**
 * Play a single dual-tone chime pulse (A5 -> C6).
 */
function playChimePulse() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    // Tone 1: 880Hz (A5)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(880, now);
    gain1.gain.setValueAtTime(0.15, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

    osc1.connect(gain1);
    gain1.connect(ctx.destination);

    osc1.start(now);
    osc1.stop(now + 0.15);

    // Tone 2: 1046.5Hz (C6) - 100ms offset
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(1046.5, now + 0.1);
    gain2.gain.setValueAtTime(0.18, now + 0.1);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

    osc2.connect(gain2);
    gain2.connect(ctx.destination);

    osc2.start(now + 0.1);
    osc2.stop(now + 0.35);
  } catch {
    // Audio context may fail if blocked by browser policy before user interaction
  }
}

/**
 * Start looping the alert sound. Idempotent — calling multiple times
 * while already playing does not stack or create audio chaos.
 */
export function playAlertSoundLoop(): void {
  if (isLooping) return;
  isLooping = true;

  // Play immediately
  playChimePulse();

  // Repeat pulse every 1.2 seconds
  loopTimer = setInterval(() => {
    playChimePulse();
  }, 1200);

  // Safety auto-stop after 30 seconds
  if (autoStopTimer) clearTimeout(autoStopTimer);
  autoStopTimer = setTimeout(() => {
    stopAlertSound();
  }, AUTO_STOP_MS);
}

/**
 * Stop looping the alert sound immediately.
 */
export function stopAlertSound(): void {
  isLooping = false;
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
  if (autoStopTimer) {
    clearTimeout(autoStopTimer);
    autoStopTimer = null;
  }
}

/**
 * Play a single test chime (used for UI "Test Sound" button).
 */
export function testAlertSound(): void {
  stopAlertSound();
  playChimePulse();
  setTimeout(() => playChimePulse(), 300);
}
