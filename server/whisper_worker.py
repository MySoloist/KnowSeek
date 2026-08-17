"""
Whisper 语音识别子进程脚本。
在独立进程中运行，进程退出后所有内存（RAM + GPU VRAM）自动归还给操作系统。
"""
import json
import sys
import gc

import torch
import whisper


def main():
    model_name = sys.argv[1]
    audio_path = sys.argv[2]
    output_path = sys.argv[3]

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = whisper.load_model(model_name, device=device)
    result = model.transcribe(audio_path, language="zh")

    # 只保存需要的字段，减小序列化体积
    segments = []
    for seg in result.get("segments", []):
        segments.append({
            "start": seg.get("start", 0),
            "end": seg.get("end", 0),
            "text": seg.get("text", "").strip(),
        })

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(segments, f, ensure_ascii=False)

    # 主动清理
    del model, result, segments
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


if __name__ == "__main__":
    main()