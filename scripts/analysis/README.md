# Export analysis scripts

Run on the phone (Termux python3), against an exported file. They use Termux's ffmpeg only to
read the file. `an.py` has the shared helpers (PCM dump, RMS, frequency).

- `beeps.py FILE`: beep onsets/offsets (ms) of a test clip with 1 s beeps, for audio timing.
- `tone.py`, `onset.py`, `st.py`, `rep.py`: pitch, onset and RMS checks used for speed changes.
- `boxes.py FILE`: top-level MP4 boxes (checks that moov comes before mdat).
- `ink.py`: counts drawing-layer pixels in frames, for overlay timing.
