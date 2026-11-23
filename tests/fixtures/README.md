# Test audio fixtures

Mono 16 kHz PCM16 WAV, read with `readWav` in `tests/unit/helpers/worklet-harness.js`.

| file | what | source and license |
|---|---|---|
| `speech-tts.wav` | synthetic speech (macOS `say`), dense | generated for the 2026-11-20 loudness research |
| `speech-human.wav` | 30 s of real human read speech, nonstop with natural gaps | LibriVox, *Short Story Collection 088*, "The Gift of the Magi" by O. Henry (track 08), public domain ([PD mark 1.0](http://creativecommons.org/publicdomain/mark/1.0/); LibriVox recordings are dedicated to the public domain). Source: `https://archive.org/download/ss088_2006_librivox/ss088_08_various_64kb.mp3` (sha256 `b4b969467ac5932ebe9c6d18d5f73145510c28814a0adb9d97981abe706ed93d`). Cut with `ffmpeg -ss 60 -t 30 -i <mp3> -ac 1 -ar 16000 -c:a pcm_s16le -map_metadata -1 -fflags +bitexact speech-human.wav` (ffmpeg 9.1). |
