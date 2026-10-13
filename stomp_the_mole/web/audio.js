/* Stomp the Mole: arcade sounds, synthesised with Web Audio (no sound files, nothing to license).

     StompAudio.play('bonk')         one-shot sounds: pop bonk splat boing thud tick go buzzer fanfare
     StompAudio.charge(progress)     rising tone while the START pad fills; chargeStop() ends it
     StompAudio.setVolume(0.8)       master volume from config audio.volume
     StompAudio.state()              'running' | 'suspended' | 'none'
     StompAudio.onStateChange(fn)

   Every voice has a shaped envelope (exponential attack and release, never a hard
   start or stop) and all of them run through a compressor and a soft clipper, so
   overlapping sounds get louder without clipping.
*/
(function (global) {
  'use strict';

  const AC = global.AudioContext || global.webkitAudioContext;
  const SILENT = 0.0001;   // exponential ramps cannot reach zero

  // ------------------------------------------------------------------ building blocks

  function makeNoise(ac) {
    const buf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Linear up to 0.7, then a smooth knee that never quite reaches 1.
  function softClipCurve() {
    const n = 2048;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      const a = Math.abs(x);
      const y = a < 0.7 ? a : 0.7 + 0.3 * Math.tanh((a - 0.7) / 0.3);
      curve[i] = x < 0 ? -y : y;
    }
    return curve;
  }

  // bus -> compressor -> soft clip -> master volume -> speakers
  function buildChain(ac, volume) {
    const bus = ac.createGain();
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -9;     // single sounds pass almost untouched; pile-ups get limited
    comp.knee.value = 6;
    comp.ratio.value = 12;
    comp.attack.value = 0.003;
    comp.release.value = 0.12;
    const clip = ac.createWaveShaper();
    clip.curve = softClipCurve();
    clip.oversample = '2x';
    const master = ac.createGain();
    master.gain.value = volume;
    bus.connect(comp);
    comp.connect(clip);
    clip.connect(master);
    master.connect(ac.destination);
    return { ac: ac, out: bus, master: master, noise: makeNoise(ac) };
  }

  // attack / hold / release envelope on a gain node; returns the end time
  function env(gain, t, attack, peak, hold, release) {
    const p = gain.gain;
    p.setValueAtTime(SILENT, t);
    p.exponentialRampToValueAtTime(peak, t + attack);
    if (hold > 0) p.setValueAtTime(peak, t + attack + hold);
    p.exponentialRampToValueAtTime(SILENT, t + attack + hold + release);
    return t + attack + hold + release;
  }

  function voice(S, type, freq, t, attack, peak, hold, release, dest) {
    const o = S.ac.createOscillator();
    const g = S.ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    const end = env(g, t, attack, peak, hold, release);
    o.connect(g);
    g.connect(dest || S.out);
    o.start(t);
    o.stop(end + 0.03);
    return o;
  }

  function glide(o, t, to, dur) {
    o.frequency.exponentialRampToValueAtTime(to, t + dur);
  }

  function noise(S, t, attack, peak, hold, release, type, f0, f1, q) {
    const src = S.ac.createBufferSource();
    const f = S.ac.createBiquadFilter();
    const g = S.ac.createGain();
    src.buffer = S.noise;
    src.loop = true;
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    const end = env(g, t, attack, peak, hold, release);
    if (f1 && f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, end);
    src.connect(f);
    f.connect(g);
    g.connect(S.out);
    src.start(t, Math.random() * 0.5);
    src.stop(end + 0.03);
  }

  // vibrato / wobble: an LFO added to an oscillator's frequency, depth ramping d0 -> d1
  function wobble(S, target, t, rate, d0, d1, dur) {
    const l = S.ac.createOscillator();
    const g = S.ac.createGain();
    l.frequency.setValueAtTime(rate, t);
    g.gain.setValueAtTime(d0, t);
    g.gain.exponentialRampToValueAtTime(d1, t + dur);
    l.connect(g);
    g.connect(target.frequency);
    l.start(t);
    l.stop(t + dur + 0.05);
  }

  function lowpass(S, freq, q) {
    const f = S.ac.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = freq;
    f.Q.value = q;
    f.connect(S.out);
    return f;
  }

  // ------------------------------------------------------------------ the sounds

  const SOUNDS = {
    // mole pops up: quiet cork-like bloop
    pop: function (S, t) {
      glide(voice(S, 'sine', 300, t, 0.004, 0.13, 0, 0.11), t, 820, 0.06);
      glide(voice(S, 'triangle', 600, t, 0.003, 0.03, 0, 0.05), t, 1500, 0.04);
    },

    // mallet on a hard hat: wooden knock that drops in pitch
    bonk: function (S, t) {
      glide(voice(S, 'triangle', 640, t, 0.002, 0.55, 0.012, 0.24), t, 165, 0.13);
      glide(voice(S, 'sine', 1300, t, 0.001, 0.22, 0, 0.07), t, 440, 0.05);
      glide(voice(S, 'sine', 160, t, 0.002, 0.3, 0, 0.12), t, 70, 0.1);
      noise(S, t, 0.001, 0.24, 0, 0.04, 'bandpass', 2600, 1600, 1.4);
    },

    // wet squash: falling filtered noise, a soft body thump and a few droplets
    splat: function (S, t) {
      noise(S, t + 0.01, 0.004, 0.45, 0.02, 0.28, 'lowpass', 3000, 280, 2.5);
      glide(voice(S, 'sine', 180, t + 0.01, 0.003, 0.3, 0, 0.17), t + 0.01, 55, 0.14);
      for (let i = 0; i < 3; i++) {
        const d = t + 0.06 + i * 0.05 + Math.random() * 0.02;
        const f = 1000 + Math.random() * 1200;
        noise(S, d, 0.002, 0.08, 0, 0.05, 'bandpass', f, f * 0.6, 7);
      }
    },

    // mole got away: springy rising "boyoyoing"
    boing: function (S, t) {
      const a = voice(S, 'sine', 140, t, 0.006, 0.2, 0.1, 0.42);
      glide(a, t, 360, 0.45);
      wobble(S, a, t, 15, 48, 3, 0.55);
      const b = voice(S, 'triangle', 280, t, 0.006, 0.05, 0.1, 0.38);
      glide(b, t, 720, 0.45);
      wobble(S, b, t, 15, 96, 6, 0.55);
    },

    // stomp on an empty hole: soft, low, not punishing. The triangle glide and the band-passed
    // "thwack" give it mid-range body, so small PC speakers (little below ~150 Hz) still play it;
    // it stays about 4 dB under the hit.
    thud: function (S, t) {
      glide(voice(S, 'sine', 120, t, 0.003, 0.4, 0, 0.22), t, 42, 0.16);
      noise(S, t, 0.002, 0.16, 0, 0.09, 'lowpass', 600, 150, 0.7);
      glide(voice(S, 'triangle', 260, t, 0.002, 0.4, 0, 0.13), t, 140, 0.1);
      noise(S, t, 0.001, 0.35, 0, 0.07, 'bandpass', 900, 500, 1.2);
    },

    // clock tick (countdown and the last seconds); arg = seconds left, higher when <= 3
    tick: function (S, t, arg) {
      const urgent = typeof arg === 'number' && arg <= 3;
      const f = urgent ? 1760 : 1320;
      voice(S, 'sine', f, t, 0.001, urgent ? 0.34 : 0.28, 0.01, 0.07);
      voice(S, 'triangle', f * 1.5, t, 0.001, 0.08, 0, 0.035);
      noise(S, t, 0.001, 0.07, 0, 0.02, 'highpass', 3500, 0, 0.7);
    },

    // GO!: a bright major chord with a whoop into it
    go: function (S, t) {
      glide(voice(S, 'sine', 500, t, 0.005, 0.12, 0, 0.1), t, 1100, 0.08);
      const f = lowpass(S, 1600, 1);
      f.frequency.setValueAtTime(1600, t + 0.05);
      f.frequency.exponentialRampToValueAtTime(4200, t + 0.15);
      const chord = [523.25, 659.25, 783.99, 1046.5];
      for (let i = 0; i < chord.length; i++) {
        voice(S, 'sawtooth', chord[i] * 1.004, t + 0.05, 0.012, 0.075, 0.25, 0.45, f);
        voice(S, 'sawtooth', chord[i] * 0.996, t + 0.05, 0.012, 0.075, 0.25, 0.45, f);
      }
      voice(S, 'triangle', 2093, t + 0.06, 0.005, 0.05, 0.05, 0.35);
    },

    // round over: low buzzer, about 0.8 s, filtered so it is firm but not harsh
    buzzer: function (S, t) {
      const f = lowpass(S, 1000, 3);
      const a = voice(S, 'sawtooth', 92, t, 0.015, 0.19, 0.66, 0.12, f);
      const b = voice(S, 'square', 97, t, 0.015, 0.1, 0.66, 0.12, f);
      a.frequency.setValueAtTime(92, t + 0.5);
      a.frequency.exponentialRampToValueAtTime(80, t + 0.8);
      b.frequency.setValueAtTime(97, t + 0.5);
      b.frequency.exponentialRampToValueAtTime(84, t + 0.8);
    },

    // combo milestone / new high score: chiptune arpeggio into a held chord
    fanfare: function (S, t) {
      const f = lowpass(S, 2800, 0.8);
      const notes = [523.25, 659.25, 783.99, 1046.5];
      const step = 0.085;
      for (let i = 0; i < notes.length; i++) {
        voice(S, 'square', notes[i], t + i * step, 0.005, 0.07, 0.04, 0.1, f);
        voice(S, 'triangle', notes[i], t + i * step, 0.005, 0.1, 0.04, 0.12);
      }
      const end = t + notes.length * step;
      const chord = [783.99, 1046.5, 1318.5];
      for (let i = 0; i < chord.length; i++) {
        const o = voice(S, 'square', chord[i], end, 0.01, 0.045, 0.28, 0.4, f);
        wobble(S, o, end + 0.1, 6, chord[i] * 0.008, chord[i] * 0.012, 0.6);
        voice(S, 'triangle', chord[i], end, 0.01, 0.07, 0.28, 0.45);
      }
    },
  };

  // ------------------------------------------------------------------ runtime

  let S = null;            // {ac, out, master, noise}
  let volume = 0.8;
  let reported = null;
  const listeners = [];
  let chargeVoice = null;

  function init() {
    if (!AC || S) return;
    try {
      S = buildChain(new AC(), volume);
    } catch (err) {
      console.warn('Web Audio unavailable:', err);
      S = null;
      return;
    }
    S.ac.onstatechange = notify;
    tryResume();
  }

  function state() {
    if (!S) return 'none';
    return S.ac.state === 'running' ? 'running' : 'suspended';
  }

  function notify() {
    const now = state();
    if (now === reported) return;
    reported = now;
    for (let i = 0; i < listeners.length; i++) {
      try { listeners[i](now); } catch (err) { console.error(err); }
    }
  }

  function tryResume() {
    if (S && S.ac.state !== 'running' && S.ac.state !== 'closed') {
      S.ac.resume().then(notify, function () { /* needs a gesture; the flag or a click will do */ });
    }
  }

  function play(name, arg) {
    if (!S || S.ac.state !== 'running') return;
    const fn = SOUNDS[name];
    if (!fn) return;
    try {
      fn(S, S.ac.currentTime + 0.005, arg);
    } catch (err) {
      console.error('sound ' + name + ' failed:', err);
    }
  }

  // Rising two-octave tone with a tremolo that speeds up as the pad fills.
  function charge(progress) {
    if (!S || S.ac.state !== 'running') return;
    const p = progress < 0 ? 0 : progress > 1 ? 1 : progress;
    const t = S.ac.currentTime;
    const freq = 196 * Math.pow(4, p);
    if (!chargeVoice) {
      const ac = S.ac;
      const out = ac.createGain();
      const trem = ac.createGain();
      const lfo = ac.createOscillator();
      const lfoDepth = ac.createGain();
      const a = ac.createOscillator();
      const b = ac.createOscillator();
      const bGain = ac.createGain();
      a.type = 'triangle';
      b.type = 'sine';
      a.frequency.setValueAtTime(freq, t);
      b.frequency.setValueAtTime(freq * 2, t);
      bGain.gain.value = 0.35;
      trem.gain.value = 0.75;
      lfo.frequency.setValueAtTime(7, t);
      lfoDepth.gain.value = 0.25;
      lfo.connect(lfoDepth);
      lfoDepth.connect(trem.gain);
      a.connect(trem);
      b.connect(bGain);
      bGain.connect(trem);
      trem.connect(out);
      out.connect(S.out);
      out.gain.setValueAtTime(SILENT, t);
      out.gain.exponentialRampToValueAtTime(0.13, t + 0.06);
      a.start(t);
      b.start(t);
      lfo.start(t);
      chargeVoice = { out: out, a: a, b: b, lfo: lfo };
    }
    chargeVoice.a.frequency.setTargetAtTime(freq, t, 0.04);
    chargeVoice.b.frequency.setTargetAtTime(freq * 2, t, 0.04);
    chargeVoice.lfo.frequency.setTargetAtTime(7 + 11 * p, t, 0.05);
  }

  function chargeStop() {
    if (!chargeVoice || !S) return;
    const v = chargeVoice;
    chargeVoice = null;
    const t = S.ac.currentTime;
    v.out.gain.cancelScheduledValues(t);
    v.out.gain.setValueAtTime(v.out.gain.value, t);
    v.out.gain.setTargetAtTime(0, t, 0.025);
    v.a.stop(t + 0.25);
    v.b.stop(t + 0.25);
    v.lfo.stop(t + 0.25);
  }

  function setVolume(v) {
    volume = typeof v === 'number' && v >= 0 ? Math.min(v, 1) : 0.8;
    if (S) S.master.gain.setTargetAtTime(volume, S.ac.currentTime, 0.05);
  }

  // Render sounds into an OfflineAudioContext (diagnostics and tests only). `names` is one
  // name or a list played together, to check that overlaps stay below clipping.
  function renderOffline(names, arg, seconds) {
    const OAC = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    const off = new OAC(1, Math.ceil(44100 * (seconds || 1.5)), 44100);
    const chain = buildChain(off, volume);
    [].concat(names).forEach(function (name) { SOUNDS[name](chain, 0.02, arg); });
    return off.startRendering();
  }

  // The floor PC's browser is launched with --autoplay-policy=no-user-gesture-required;
  // a click or key still unlocks audio anywhere else.
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (type) {
    global.addEventListener(type, tryResume, true);
  });
  setInterval(function () {
    if (S && S.ac.state === 'suspended') tryResume();
  }, 3000);

  init();
  reported = state();

  global.StompAudio = {
    play: play,
    charge: charge,
    chargeStop: chargeStop,
    setVolume: setVolume,
    state: state,
    onStateChange: function (fn) { listeners.push(fn); },
    names: Object.keys(SOUNDS),
    renderOffline: renderOffline,
  };
})(window);
