"""laya-quantize.py — a smaller copy of Laya for the extension (0.83.0).

Laya's multilingual ONNX export (duration465/laya-onnx, multilingual/) is
fp32, 1.3 GB, which the extension downloads once. This makes an int8 copy,
about a quarter of the size: dynamic quantization of the weights of every
MatMul (ONNX Runtime's quantize_dynamic, per channel), the layout and the
tokenizer unchanged, so the extension reads it the same way.

  pip install onnxruntime onnx huggingface_hub
  python training/laya-quantize.py --out laya-int8                    # make it
  python training/laya-quantize.py --out laya-int8 --check            # compare with fp32
  python training/laya-quantize.py --out laya-int8 --upload you/laya-onnx-int8

Then point the extension at it: LAYA_DEFAULT in src/aiService.js
({repo: "you/laya-onnx-int8", rev: "<commit>", sub: "multilingual"}).

Before switching, run --check: it feeds the same sequences to both and prints
how often the top choice agrees and the largest probability difference.
Quantizing an encoder this way usually keeps the top choice; measure it on
your own answers before trusting it.
"""
import argparse
import json
import os
import shutil

import numpy as np

SRC_REPO = "duration465/laya-onnx"
SUB = "multilingual"


def fetch(rev):
    from huggingface_hub import snapshot_download
    d = snapshot_download(SRC_REPO, revision=rev, allow_patterns=[f"{SUB}/*", f"{SUB}/tokenizer/*", "README.md"])
    return os.path.join(d, SUB)


def quantize(src, out):
    from onnxruntime.quantization import QuantType, quantize_dynamic
    dst = os.path.join(out, SUB)
    os.makedirs(os.path.join(dst, "tokenizer"), exist_ok=True)
    quantize_dynamic(
        os.path.join(src, "laya.onnx"),
        os.path.join(dst, "laya.onnx"),
        weight_type=QuantType.QInt8,
        per_channel=True,
        op_types_to_quantize=["MatMul"],
        use_external_data_format=True,
    )
    # The extension reads exactly laya.onnx + laya.onnx.data, as the source
    # has them: re-saved so every weight is in that one file, whatever name
    # or threshold the quantizer used.
    import onnx
    m = onnx.load(os.path.join(dst, "laya.onnx"), load_external_data=True)
    for f in os.listdir(dst):
        if f != "laya.onnx" and f.startswith("laya.onnx"):
            os.remove(os.path.join(dst, f))
    onnx.save_model(m, os.path.join(dst, "laya.onnx"), save_as_external_data=True, all_tensors_to_one_file=True,
                    location="laya.onnx.data", size_threshold=0)
    for f in ["laya_config.json", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json"]:
        shutil.copy(os.path.join(src, f), os.path.join(dst, f))
    sizes = {f: os.path.getsize(os.path.join(dst, f)) for f in ["laya.onnx", "laya.onnx.data"] if os.path.exists(os.path.join(dst, f))}
    print("wrote", dst, {k: f"{v / 1e6:.0f} MB" for k, v in sizes.items()})
    return dst


def check(src, dst, n=24, seed=0):
    import onnxruntime as ort
    rng = np.random.default_rng(seed)
    a = ort.InferenceSession(os.path.join(src, "laya.onnx"))
    b = ort.InferenceSession(os.path.join(dst, "laya.onnx"))
    with open(os.path.join(src, "tokenizer", "tokenizer.json"), encoding="utf-8") as f:
        vocab = len(json.load(f)["model"]["vocab"])
    agree, worst = 0, 0.0
    for _ in range(n):
        L, K = int(rng.integers(40, 600)), int(rng.integers(2, 10))
        ids = rng.integers(5, vocab, size=(1, L)).astype(np.int64)
        ids[0, 0], ids[0, -1] = 2, 1
        pos = np.sort(rng.choice(np.arange(2, L - 2), size=K, replace=False)).astype(np.int64)[None]
        ids[0, pos[0]] = 4
        feeds = {"input_ids": ids, "attention_mask": np.ones_like(ids), "marker_pos": pos,
                 "marker_mask": np.ones((1, K), dtype=bool), "qtype": np.array([0], dtype=np.int64)}
        la, lb = a.run(["logits"], feeds)[0][0], b.run(["logits"], feeds)[0][0]
        pa, pb = np.exp(la - la.max()), np.exp(lb - lb.max())
        pa, pb = pa / pa.sum(), pb / pb.sum()
        agree += int(pa.argmax() == pb.argmax())
        worst = max(worst, float(np.abs(pa - pb).max()))
    print(json.dumps({"sequences": n, "top_choice_agrees": f"{agree}/{n}", "largest_probability_difference": round(worst, 4)}))


def upload(out, repo):
    from huggingface_hub import HfApi
    api = HfApi()
    api.create_repo(repo, exist_ok=True)
    readme = os.path.join(out, "README.md")
    with open(readme, "w") as f:
        f.write(f"---\nlicense: apache-2.0\nbase_model:\n  - {SRC_REPO}\n  - convaiinnovations/laya\nlibrary_name: onnx\n---\n\n"
                f"# Laya multilingual, int8\n\nA dynamic int8 quantization (ONNX Runtime quantize_dynamic, MatMul weights, per channel) of "
                f"[{SRC_REPO}](https://huggingface.co/{SRC_REPO}) `{SUB}/`, made by CitoSkeleton's training/laya-quantize.py. "
                f"Same files and inputs. Weights under Apache-2.0 (convaiinnovations/laya).\n")
    api.upload_folder(folder_path=out, repo_id=repo)
    print("uploaded to", repo, "- pin its commit in LAYA_DEFAULT.rev")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--rev", default="main", help="commit of the source repository to read")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--upload", metavar="OWNER/NAME")
    a = ap.parse_args()
    src = fetch(a.rev)
    dst = os.path.join(a.out, SUB)
    if not os.path.exists(os.path.join(dst, "laya.onnx")):
        dst = quantize(src, a.out)
    if a.check:
        check(src, dst)
    if a.upload:
        upload(a.out, a.upload)


if __name__ == "__main__":
    main()
