// desktop-audio.js — the sound round (v0.1.13 — the owner ask: "I want some
// sound engineering, some modern, futurist and low-key sounds. for this:
// 1. when you login. 2. when you delete a task 3. when you fulfill a tasks
// 4. when you move a task to another state 5. when syncing complete").
// GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
// into frontend/dist/js/ and checksummed in frontend/island.checksums.json.
// Loads blocking, right AFTER desktop-shim.js (it wraps the seam the shim
// just defined) and BEFORE every deferred island script.
//
// WHAT THIS FILE OWNS (the desktop-owned sound layer):
//   1. window.hibanaAudio.play(name) — the five cues, synthesized live via
//      the Web Audio API (WebView2 = Chromium; window.AudioContext always
//      exists there). NO audio files ship: every sound is a few oscillator
//      voices + envelopes, so the whole engine is ~5KB of text and nothing
//      binary ever enters dist. The palette is FUTURIST + LOW-KEY by design:
//      sine/triangle partials only (glassy, synthetic — no acoustic
//      emulations), perfect-fifth intervals (the open, weightless sonority),
//      short exponential pluck envelopes (attack 8-16ms so nothing clicks,
//      decay settles under the next paint), per-voice lowpass shaping, and a
//      master gain of 0.5 with per-voice peaks of 0.02-0.1 — every cue lands
//      around -20dBFS, audible as a whisper of confirmation, never an alarm.
//        login   — the welcome fifth: E5 rising to B5 over a soft E4 bed
//                  with a faint E6 shimmer (~0.75s; desktop-login.js plays
//                  it on the ok resolve and delays the reload so it lands).
//        delete  — the dissolve thock: a 320->165Hz triangle body + a 98Hz
//                  sub weight + a band-passed noise puff (~0.3s; the sound
//                  of something dissolving — never a trash-can crash).
//        fulfill — the completion ding: G5 + D6 plucks over a G3 bed with a
//                  high sparkle tail (~0.8s; the "task done" satisfaction).
//        move    — the micro tick: a 540->660Hz sine glide, 75ms — the
//                  quietest of the five, tactile like a precision switch.
//        sync    — the all-clear: a stacked-fifth arpeggio A4 -> E5 -> B5
//                  with a glassy E6 tail over an A3 bed (~1.1s; the sonic
//                  twin of the green "Everything synced" panel).
//   2. The task-action OBSERVER on the transport seam: it wraps
//      window.hibanaFetch (the shim's ONE seam — every task mutation the
//      island makes crosses it) and classifies BEFORE the call (the island
//      state still holds the PREVIOUS status while the request is in
//      flight — window.HibanaBoard.findTask reads it live), then plays the
//      matching cue ONLY on a 2xx resolve — a failed delete/move/fulfill is
//      silent, because nothing happened:
//        DELETE /api/devtasks/:id (exactly one path segment — the tag/
//        screenshot deleters never match)      -> 'delete'
//        PATCH  /api/devtasks/:id with a status the task did NOT already
//        carry:  -> 'done' = 'fulfill', any other change = 'move'
//        (a PATCH whose status equals the current status — the editor's
//        every-save resend — is a plain edit and stays silent; same-name
//        cues within 150ms coalesce, so "Clear done" sounds ONCE).
//   3. The gesture unlock: Chromium gates audio behind a user activation —
//      the first pointerdown/keydown warms the context (resume()), and
//      every play() re-checks it; all five call sites inherently follow a
//      real gesture (submit, confirm, drag, the Sync click).
//
// WHAT IT MUST NEVER OWN: no island bytes (the wrapper touches nothing the
// island ships — it observes the seam the shim already owns), no storage
// (the Go mirror owns persistence), no network of its own, no volume UI
// (the ask is the five cues; nothing else).
(function () {
  'use strict'

  var ctx = null
  var master = null
  var lastPlay = {}

  function ensureCtx() {
    if (ctx) return ctx
    var AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return null
    try {
      ctx = new AC()
      master = ctx.createGain()
      master.gain.value = 0.5
      master.connect(ctx.destination)
    } catch (e) { ctx = null; master = null }
    return ctx
  }

  function unlock() {
    var c = ensureCtx()
    if (c && c.state === 'suspended') { try { c.resume() } catch (e) { /* a locked context stays silent, never broken */ } }
  }

  // The warm-up: the FIRST gesture unlocks the context for the document's
  // life, so a drag's drop (a gesture chain) and every click-driven cue
  // schedule against an already-running context.
  document.addEventListener('pointerdown', unlock, { once: true, capture: true })
  document.addEventListener('keydown', unlock, { once: true, capture: true })

  // One synth voice: osc -> (optional lowpass) -> envelope -> master.
  function tone(o) {
    var osc = ctx.createOscillator()
    osc.type = o.type || 'sine'
    osc.frequency.setValueAtTime(o.f0, o.t)
    if (o.f1 && o.f1 !== o.f0) osc.frequency.exponentialRampToValueAtTime(o.f1, o.t + o.dur * 0.85)
    var g = ctx.createGain()
    var atk = o.attack || 0.012
    g.gain.setValueAtTime(0.0001, o.t)
    g.gain.linearRampToValueAtTime(o.peak, o.t + atk)
    g.gain.exponentialRampToValueAtTime(0.0001, o.t + o.dur)
    var head = osc
    if (o.lp) {
      var f = ctx.createBiquadFilter()
      f.type = 'lowpass'
      f.frequency.value = o.lp
      f.Q.value = 0.7
      osc.connect(f)
      head = f
    }
    head.connect(g)
    g.connect(master)
    osc.start(o.t)
    osc.stop(o.t + o.dur + 0.05)
  }

  // The noise breath (the delete cue's puff): a decaying white-noise buffer
  // through a band-pass — the "dissolving" tail, barely there.
  function puff(o) {
    var len = Math.max(256, Math.floor(ctx.sampleRate * o.dur))
    var buf = ctx.createBuffer(1, len, ctx.sampleRate)
    var d = buf.getChannelData(0)
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len)
    var src = ctx.createBufferSource()
    src.buffer = buf
    var bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = o.freq
    bp.Q.value = 0.9
    var g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, o.t)
    g.gain.linearRampToValueAtTime(o.peak, o.t + 0.008)
    g.gain.exponentialRampToValueAtTime(0.0001, o.t + o.dur)
    src.connect(bp)
    bp.connect(g)
    g.connect(master)
    src.start(o.t)
    src.stop(o.t + o.dur + 0.02)
  }

  // The five cues (frequencies in Hz, A4=440 — the intervals are perfect
  // fifths by design: the futurist, weightless sonority).
  var SOUNDS = {
    login: function (t) {
      tone({ f0: 329.63, type: 'triangle', t: t, dur: 0.55, peak: 0.03, lp: 1600 })
      tone({ f0: 659.25, type: 'sine', t: t, dur: 0.5, peak: 0.1, lp: 2800 })
      tone({ f0: 987.77, type: 'sine', t: t + 0.16, dur: 0.62, peak: 0.08, lp: 3200 })
      tone({ f0: 1318.51, type: 'sine', t: t + 0.34, dur: 0.4, peak: 0.022, lp: 6000 })
    },
    delete: function (t) {
      tone({ f0: 320, f1: 165, type: 'triangle', t: t, dur: 0.17, peak: 0.09, lp: 750 })
      tone({ f0: 98, type: 'sine', t: t, dur: 0.12, peak: 0.05 })
      puff({ t: t + 0.01, dur: 0.13, freq: 700, peak: 0.032 })
    },
    fulfill: function (t) {
      tone({ f0: 196, type: 'triangle', t: t, dur: 0.5, peak: 0.028, lp: 900 })
      tone({ f0: 783.99, type: 'sine', t: t, dur: 0.38, peak: 0.085, lp: 3400 })
      tone({ f0: 1174.66, type: 'sine', t: t + 0.09, dur: 0.5, peak: 0.07, lp: 4000 })
      tone({ f0: 2349.32, type: 'sine', t: t + 0.2, dur: 0.28, peak: 0.016, lp: 7000 })
    },
    move: function (t) {
      tone({ f0: 540, f1: 660, type: 'sine', t: t, dur: 0.075, peak: 0.05, lp: 1900 })
    },
    sync: function (t) {
      tone({ f0: 220, type: 'triangle', t: t, dur: 0.9, peak: 0.03, lp: 1000 })
      tone({ f0: 440, type: 'sine', t: t, dur: 0.5, peak: 0.085, lp: 2400 })
      tone({ f0: 659.25, type: 'sine', t: t + 0.13, dur: 0.6, peak: 0.075, lp: 2800 })
      tone({ f0: 987.77, type: 'sine', t: t + 0.26, dur: 0.8, peak: 0.065, lp: 3400 })
      tone({ f0: 1318.51, type: 'sine', t: t + 0.42, dur: 0.7, peak: 0.02, lp: 6000 })
    },
  }

  function play(name) {
    var fn = SOUNDS[name]
    if (!fn) return false
    if (!ensureCtx()) return false
    unlock()
    var now = Date.now()
    if (lastPlay[name] && now - lastPlay[name] < 150) return false // coalesce: "Clear done" sounds ONCE
    lastPlay[name] = now
    try { fn(ctx.currentTime + 0.02) } catch (e) { return false }
    return true
  }

  window.hibanaAudio = { play: play }

  // ------------------------------------------------------ the seam observer
  // Classify BEFORE the call (the island's live state still holds the
  // PREVIOUS status while the request is in flight) and play ONLY on a 2xx
  // resolve — a failed mutation is silent. The wrapper returns the ORIGINAL
  // promise untouched, so the callers' error/abort semantics are byte-ident.
  function classify(path, opts) {
    if (!path || typeof path !== 'string') return null
    var method = ((opts && opts.method) || 'GET').toUpperCase()
    var m = /^\/api\/devtasks\/([^\/?]+)$/.exec(path)
    if (!m) return null
    if (method === 'DELETE') return 'delete'
    if (method === 'PATCH') {
      var body = opts && opts.body
      var parsed = null
      if (typeof body === 'string') { try { parsed = JSON.parse(body) } catch (e) { return null } }
      else if (body && typeof body === 'object') parsed = body
      if (!parsed || typeof parsed.status !== 'string') return null
      var prior = null
      try {
        var HB = window.HibanaBoard
        var task = HB && typeof HB.findTask === 'function' ? HB.findTask(m[1]) : null
        if (task && typeof task.status === 'string') prior = task.status
      } catch (e) { /* a missing board never blocks the cue */ }
      if (parsed.status === prior) return null // the editor's same-status resend: a plain edit
      return parsed.status === 'done' ? 'fulfill' : 'move'
    }
    return null
  }

  var seam = window.hibanaFetch
  if (typeof seam === 'function') {
    window.hibanaFetch = function (path, opts) {
      var verdict = classify(path, opts)
      var p = seam.call(window, path, opts)
      if (verdict) {
        p.then(function (res) { if (res && res.ok) play(verdict) }, function () { /* a rejected call is silent */ })
      }
      return p
    }
  }
})()
