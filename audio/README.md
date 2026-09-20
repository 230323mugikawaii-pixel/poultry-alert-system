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

Each cycle is tagged separately. A five-second no-progress deadline checks
currentTime and ended before diagnosing failure, so delayed events alone do
not cause a false error. Successful ended clears that cycle's deadline, not the
next cycle's. If a later cycle actually stops progressing, the UI leaves PLAYING
and reports PLAYBACK_STALLED; it does not claim the initial start failed. Native
play rejection, pause, error and premature ended remain separate failures.
The trace includes play calls/results, playing, timeupdate, ended, pause, error,
waiting, stalled, suspend, seeking and seeked, with safe relative times/media
states only. A bounded memory-only trace has no email, identity or credential.

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
