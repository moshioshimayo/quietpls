"""Speaker labels for one side of a call (local, no network).

    uv run --python 3.12 --with sherpa-onnx==2.0.1 --with numpy python diarize/diarize.py \
        --model wespeaker_en_voxceleb_resnet34_LM.onnx --wav side.wav < segments.json

stdin:  [{"at": seconds, "end": seconds}, ...]   (whisper segments of this side)
stdout: {"labels": [0, 0, 1, ...]}               (cluster per segment, numbered by first appearance)

Each segment gets a speaker embedding; segments are clustered by cosine similarity
(average linkage, stop below --threshold). Segments too short to embed take the label
of the next embedded segment (whisper often splits "Great. Daniel, go ahead..."), or the
previous one at the end.

The 0.7 default was tuned on macOS TTS voices, which sound more alike to the model than
real people usually do; on real calls it may split one person into two. Renaming both
to the same name merges them.
"""

import argparse
import json
import sys
import wave

import numpy as np
import sherpa_onnx

MIN_SECONDS = 1.0


def read_wav(path):
    with wave.open(path, "rb") as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise SystemExit("expected mono 16-bit WAV")
        rate = w.getframerate()
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    return data.astype(np.float32) / 32768.0, rate


def embed(extractor, samples, rate):
    stream = extractor.create_stream()
    stream.accept_waveform(sample_rate=rate, waveform=samples)
    stream.input_finished()
    v = np.array(extractor.compute(stream), dtype=np.float32)
    return v / (np.linalg.norm(v) + 1e-9)


def cluster(vectors, threshold):
    groups = [[i] for i in range(len(vectors))]
    while len(groups) > 1:
        cents = np.array([np.mean([vectors[i] for i in g], axis=0) for g in groups])
        cents /= np.linalg.norm(cents, axis=1, keepdims=True) + 1e-9
        sim = cents @ cents.T
        np.fill_diagonal(sim, -1)
        a, b = np.unravel_index(np.argmax(sim), sim.shape)
        if sim[a, b] < threshold:
            break
        groups[a] += groups[b]
        del groups[b]
    label = {}
    for g in groups:
        for i in g:
            label[i] = g
    # number clusters by first appearance
    order, out = {}, []
    for i in range(len(vectors)):
        key = id(label[i])
        order.setdefault(key, len(order))
        out.append(order[key])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--wav", required=True)
    ap.add_argument("--threshold", type=float, default=0.7)
    args = ap.parse_args()

    segments = json.load(sys.stdin)
    samples, rate = read_wav(args.wav)
    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(
        sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=args.model, num_threads=2)
    )

    embedded, vectors = [], []
    for i, s in enumerate(segments):
        a, b = int(s["at"] * rate), int(s.get("end", s["at"]) * rate)
        if b - a >= MIN_SECONDS * rate:
            embedded.append(i)
            vectors.append(embed(extractor, samples[a:b], rate))

    labels = [0] * len(segments)
    if vectors:
        found = cluster(vectors, args.threshold)
        for i, lab in zip(embedded, found):
            labels[i] = lab
        for i in range(len(segments)):
            if i not in embedded:
                after = [k for k in embedded if k > i]
                labels[i] = labels[after[0] if after else max(k for k in embedded if k < i)]
    json.dump({"labels": labels, "embedded": len(vectors)}, sys.stdout)


if __name__ == "__main__":
    main()
