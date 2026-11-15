"""Hub-only, local large-v3 worker. Never downloads models or calls an API."""
import json
import os
from pathlib import Path
import platform
import sys
import wave

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"


def backend():
    return "mlx" if platform.system() == "Darwin" and platform.machine().lower() in ("arm64", "aarch64") else "faster-whisper"


def cached_model(engine):
    home = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface"))
    cache = Path(os.environ.get("HF_HUB_CACHE", home / "hub"))
    root = cache / ("models--mlx-community--whisper-large-v3-mlx" if engine == "mlx" else "models--Systran--faster-whisper-large-v3")
    ref = root / "refs" / "main"
    candidates = []
    if ref.is_file():
        revision = ref.read_text().strip()
        if revision and all(c in "0123456789abcdef" for c in revision):
            candidates.append(root / "snapshots" / revision)
    candidates.extend(sorted((root / "snapshots").glob("*")))
    for candidate in candidates:
        required = ("config.json", "weights.npz") if engine == "mlx" else ("model.bin", "config.json", "tokenizer.json", "vocabulary.json")
        if all((candidate / name).is_file() for name in required):
            return candidate
    return None


def mlx_audio(file):
    # Passing an array avoids mlx-whisper's own, unrestricted ffmpeg subprocess.
    # The parent has already decoded a bounded, file-only input to this PCM WAV.
    import numpy as np
    with wave.open(file, "rb") as audio:
        if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (1, 2, 16000, "NONE"):
            raise RuntimeError("expected 16kHz mono PCM16 WAV")
        frames = audio.getnframes()
        if not 0 < frames <= 16000 * 600:
            raise RuntimeError("audio length outside limit")
        data = audio.readframes(frames)
        if len(data) != frames * 2:
            raise RuntimeError("incomplete WAV")
    return np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0


def main():
    engine = backend()
    model_path = cached_model(engine)
    try:
        if engine == "mlx":
            import mlx_whisper
        else:
            from faster_whisper import WhisperModel
    except ImportError:
        if sys.argv[1:] == ["--check"]:
            print(json.dumps({"status": "unavailable", "backend": engine}))
            return
        raise
    if sys.argv[1:] == ["--check"]:
        print(json.dumps({"status": "ready" if model_path else "model-missing", "backend": engine}))
        return
    if len(sys.argv) != 2 or model_path is None:
        raise RuntimeError("local large-v3 model or audio missing")
    if engine == "mlx":
        result = mlx_whisper.transcribe(mlx_audio(sys.argv[1]), path_or_hf_repo=str(model_path),
                                        language=None, condition_on_previous_text=False, verbose=None)
        segments = ({"start": s["start"], "text": s["text"]} for s in result["segments"])
    else:
        model = WhisperModel(str(model_path), device="cpu", compute_type="int8",
                             cpu_threads=max(1, min(4, (os.cpu_count() or 2) - 1)),
                             num_workers=1, local_files_only=True)
        # Do not discard speech with VAD; retain full audio and disable text carryover.
        raw, _ = model.transcribe(sys.argv[1], beam_size=5, vad_filter=False, condition_on_previous_text=False)
        segments = ({"start": s.start, "text": s.text} for s in raw)
    output = []
    chars = 0
    for segment in segments:
        chars += len(segment["text"])
        if chars > 500000 or len(output) >= 20000:
            raise RuntimeError("transcript too large")
        output.append(segment)
    print(json.dumps({"segments": output}, ensure_ascii=False))


if __name__ == "__main__":
    main()
