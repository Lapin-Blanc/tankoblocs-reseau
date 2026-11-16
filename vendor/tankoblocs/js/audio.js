/*
 * TankoBlocs — effets sonores synthétisés (WebAudio, aucun fichier).
 */
(function (root) {
  'use strict';

  class TankAudio {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.enabled = true;
      this.noise = null;
      this.last = {};
    }

    /** À appeler après un geste de l'utilisateur (clic). */
    unlock() {
      if (!this.enabled) return;
      try {
        if (!this.ctx) {
          const AC = root.AudioContext || root.webkitAudioContext;
          if (!AC) return;
          this.ctx = new AC();
          this.master = this.ctx.createGain();
          this.master.gain.value = 0.28;
          this.master.connect(this.ctx.destination);
          const len = this.ctx.sampleRate;
          this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
          const d = this.noise.getChannelData(0);
          for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        }
        if (this.ctx.state === 'suspended') this.ctx.resume();
      } catch (e) {
        this.ctx = null;
      }
    }

    setEnabled(on) {
      this.enabled = !!on;
      if (on) this.unlock();
    }

    _ready(kind, minGapMs) {
      if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return false;
      const now = performance.now();
      if (this.last[kind] && now - this.last[kind] < minGapMs) return false;
      this.last[kind] = now;
      return true;
    }

    _noise(duration, filterType, freqFrom, freqTo, gain, when) {
      const c = this.ctx;
      const t = when || c.currentTime;
      const src = c.createBufferSource();
      src.buffer = this.noise;
      const f = c.createBiquadFilter();
      f.type = filterType;
      f.frequency.setValueAtTime(freqFrom, t);
      f.frequency.exponentialRampToValueAtTime(Math.max(30, freqTo), t + duration);
      const g = c.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + duration);
      src.connect(f); f.connect(g); g.connect(this.master);
      src.start(t, Math.random() * 0.5);
      src.stop(t + duration + 0.02);
    }

    _tone(type, freqFrom, freqTo, duration, gain) {
      const c = this.ctx;
      const t = c.currentTime;
      const o = c.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freqFrom, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, freqTo), t + duration);
      const g = c.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + duration);
      o.connect(g); g.connect(this.master);
      o.start(t);
      o.stop(t + duration + 0.02);
    }

    /** Joue les sons correspondant aux effets d'un tick. speed : vitesse de simulation. */
    play(fxList, speed) {
      if (!this.enabled || !this.ctx) return;
      const quiet = speed > 4;
      for (const f of fxList) {
        switch (f.t) {
          case 'fire':
            if (quiet || !this._ready('fire', 45)) break;
            this._noise(0.16, 'lowpass', 2400, 300, 0.5);
            this._tone('sine', 150, 45, 0.18, 0.55);
            break;
          case 'hit':
            if (!this._ready('hit', 40)) break;
            this._tone('square', 700, 180, 0.09, 0.12);
            this._noise(0.12, 'bandpass', 3000, 900, 0.5);
            break;
          case 'spark':
            if (quiet || !this._ready('spark', 60)) break;
            this._noise(0.05, 'highpass', 3000, 2000, 0.18);
            break;
          case 'crash':
            if (!this._ready('crash', 80)) break;
            this._noise(0.18, 'lowpass', 900, 120, 0.45);
            break;
          case 'explode':
            if (!this._ready('explode', 120)) break;
            this._noise(1.0, 'lowpass', 1600, 60, 1.0);
            this._tone('sine', 90, 28, 0.9, 0.7);
            break;
          case 'end':
            if (!this._ready('end', 500)) break;
            this._tone('triangle', 523, 523, 0.18, 0.2);
            setTimeout(() => this.ctx && this._tone('triangle', 784, 784, 0.35, 0.2), 160);
            break;
          default:
            break;
        }
      }
    }
  }

  root.TankAudio = TankAudio;
})(typeof window !== 'undefined' ? window : globalThis);
