# Local notification audio

These original, deterministic PCM WAV files are synthesized by
`node scripts/generate-alarm-audio.mjs` (no recordings, external CDN, or runtime
Web Audio dependency). Commit the WAV assets with the frontend.

- `confirmation-v1.wav`: 44.1 kHz mono 16-bit PCM, 0.50 seconds, 660 Hz sine,
  peak amplitude 0.25.
- `alarm-v1.wav`: same encoding, 0.94 seconds; 880 / 1175 / 880 Hz square tones,
  each 0.22 seconds, peak amplitude 0.28, short attack/release envelopes.
- `alarm-loop-v2.wav`: the same three tones plus silence, total 1.30 seconds.
  This is the repeated-pattern resource. v1 remains for comparison.

HTML Audio is the candidate output backend. Web Audio code remains available
in the repository for comparison; it is not an automatic fallback. Confirmation
and alarm playback reuse a media element to preserve per-element playback
permission. The HTML candidate plays the whole 1.30-second resource with
`loop=false`. After natural `ended`, it clears the old cycle's listeners and
deadline, then calls `load()` and `play()` on the SAME element. This resets the
resource without a seek-to-zero between cycles. In Safari, both native looping
and manual currentTime=0 replay previously stopped progressing at a boundary;
same-element resource reload sustained the controlled comparison. The browser's
internal cause is not established. No app-level second repeat timer is used.

Each cycle is tagged separately. The initial five-second no-progress deadline
checks currentTime and ended before diagnosing failure; native progress also
counts when Safari has not settled its play Promise. After one completed pattern,
a 750ms no-progress deadline attempts at most two consecutive recoveries. It
removes old listeners/deadlines, pauses and unloads the retired element, then
creates ONE replacement and loads/plays the same local resource. Late native
results only refer to the retired element. A completed recovery pattern resets
the consecutive-failure budget. No retry is allowed after stop/Abort/pagehide.
Actual recovery latency includes browser scheduling/loading and is not guaranteed
to stay under one second in a suspended or throttled browser. The UI describes
recovery explicitly; exhaustion leaves PLAYING and reports PLAYBACK_STALLED.
Initial permission failure never triggers an autoplay retry. Native
play rejection, pause, error and premature ended remain separate failures.
The trace includes play calls/results, playing, timeupdate, ended, pause, error,
waiting, stalled, suspend, seeking and seeked, with safe relative times/media
states only. It also records local OS epoch timestamps and the first native
playing event once per operation, retained separately from the bounded trace.
This supports same-Mac cross-browser timing; it is not acoustic-output proof or
clock synchronization across different devices. No email, identity or credential
is included in the player's trace.

Cancellation removes all listeners and deadlines, pauses and resets currentTime.
Pending native play is retired so late results cannot restart or stop a newer
element. Generation/pagehide/tab coordination remain outside and around this
player. There is no total-duration or cycle-count cutoff.

Safari comparisons of AAC encoding and visible native controls did not reliably
resolve the reported behavior; neither is included as a speculative fix. The
final candidate still requires human confirmation of uninterrupted audible
repetition, not merely a PLAYING state or lack of watchdog failure.

The local E2E asset server must honor byte Range requests (206/Content-Range),
including seek requests. Range support alone did not resolve the observed
Safari stall; it is still a requirement to check separately from playback.

Serve these assets from the frontend's own origin as `audio/wav`. Browser play
acceptance and media completion are software observations, not a claim that a
person heard the sound. Human confirmation of confirmation/alarm/repetition/stop
is required before accepting the candidate.
