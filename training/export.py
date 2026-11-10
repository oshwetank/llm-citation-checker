#!/usr/bin/env python3
"""
export.py — turn the trained model into what the extension loads (0.75.0).

    python training/export.py --model runs/cito-2b/merged --out runs/cito-2b/onnx [--upload you/citoskeleton-qwen3.5-2b-onnx]

Steps:
  1. ONNX export with optimum (text generation with a KV cache).
  2. The Transformers.js layout: onnx/model.onnx, and 4-bit weights as
     onnx/model_q4.onnx (MatMulNBits, block 32): what the extension's
     "wasm" dtype asks for. On a GPU machine also model_q4f16.onnx (fp16,
     then 4-bit) for the graphics chip.
  3. The chat template written into tokenizer_config.json: Transformers.js
     reads it only there, and newer transformers saves it to a separate
     chat_template.jinja that the browser would never see.
  4. Optionally, upload to the Hugging Face Hub; the extension's
     "CitoSkeleton-tuned" size points at that repo.

Qwen3.5 note: if optimum can't export its architecture yet, use the
conversion script Transformers.js ships (scripts/convert.py in its repo),
which is how the onnx-community Qwen3.5 builds were made, then run this
with --skip-export on that folder to do steps 2–4.
"""
import argparse, json, os, shutil, subprocess, sys

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--skip-export", action="store_true")
    p.add_argument("--fp16", action="store_true", help="also write model_q4f16.onnx")
    p.add_argument("--upload", default="")
    a = p.parse_args()
    os.makedirs(a.out, exist_ok=True)

    if not a.skip_export:
        subprocess.run([sys.executable, "-m", "optimum.commands.optimum_cli", "export", "onnx", "--model", a.model,
                        "--task", "text-generation-with-past", a.out], check=True)
    onnx_dir = os.path.join(a.out, "onnx")
    os.makedirs(onnx_dir, exist_ok=True)
    for f in os.listdir(a.out):
        if f.endswith(".onnx") or f.endswith(".onnx_data"):
            shutil.move(os.path.join(a.out, f), os.path.join(onnx_dir, f))

    from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer
    import onnx
    src = os.path.join(onnx_dir, "model.onnx")
    m = onnx.load(src, load_external_data=True)
    q = MatMulNBitsQuantizer(m, block_size=32, is_symmetric=True)
    q.process()
    onnx.save_model(q.model.model, os.path.join(onnx_dir, "model_q4.onnx"), save_as_external_data=os.path.getsize(src) > 1.8e9)
    if a.fp16:
        from onnxruntime.transformers.float16 import convert_float_to_float16
        m16 = convert_float_to_float16(onnx.load(src, load_external_data=True), keep_io_types=True)
        q16 = MatMulNBitsQuantizer(m16, block_size=32, is_symmetric=True)
        q16.process()
        onnx.save_model(q16.model.model, os.path.join(onnx_dir, "model_q4f16.onnx"), save_as_external_data=True)

    # The chat template where Transformers.js looks for it.
    tc_path = os.path.join(a.out, "tokenizer_config.json")
    tc = json.load(open(tc_path, encoding="utf-8")) if os.path.exists(tc_path) else {}
    for name in ["chat_template.jinja", "chat_template.json"]:
        f = os.path.join(a.model, name)
        if os.path.exists(f) and not tc.get("chat_template"):
            raw = open(f, encoding="utf-8").read()
            tc["chat_template"] = json.loads(raw)["chat_template"] if name.endswith(".json") else raw
    if not tc.get("chat_template"):
        sys.exit("no chat template found: the extension couldn't format a conversation for this model")
    json.dump(tc, open(tc_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    files = sorted(os.path.relpath(os.path.join(d, f), a.out) for d, _, fs in os.walk(a.out) for f in fs)
    print(json.dumps({"out": a.out, "files": files}, indent=2))

    if a.upload:
        from huggingface_hub import HfApi
        HfApi().upload_folder(folder_path=a.out, repo_id=a.upload, repo_type="model")
        print(f"uploaded to https://huggingface.co/{a.upload}")

if __name__ == "__main__":
    main()
