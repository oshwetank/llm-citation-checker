#!/usr/bin/env python3
"""
train.py — fine-tune Qwen3.5 to answer Ask's questions (0.75.0).

    python training/train.py --data training/data/train.jsonl \
        --base Qwen/Qwen3.5-2B --out runs/cito-2b --epochs 2

What it does, and why:
  * LoRA (PEFT) on the attention and MLP projections: a few million trainable
    weights instead of billions, so a free Colab T4 trains the 0.8B model in
    about an hour and an A100 the 2B one in a few hours.
  * Each conversation is rendered with the base model's own chat template
    (with its tools), exactly as Transformers.js renders it in the extension.
    The loss is on the assistant's turns only (its tool calls and its
    answer): the model learns what to call and how to answer, not to recite
    the system prompt or the tool results.
  * At the end the adapter is merged into the base weights and saved as a
    plain model folder, ready for training/export.sh (ONNX, 4-bit, upload).

--tiny trains a few steps of a two-layer stand-in (test/fixtures/llm-tiny)
on the processor: it proves the pipeline runs end to end, not that anything
was learned. The real run needs a GPU and the base model from Hugging Face.
"""
import argparse, json, math, os, random, sys

def parse():
    p = argparse.ArgumentParser()
    p.add_argument("--data", required=True)
    p.add_argument("--base", default="Qwen/Qwen3.5-2B")
    p.add_argument("--out", required=True)
    p.add_argument("--epochs", type=float, default=2)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--lora-r", type=int, default=16)
    p.add_argument("--lora-alpha", type=int, default=32)
    p.add_argument("--max-len", type=int, default=4096)
    p.add_argument("--batch", type=int, default=1)
    p.add_argument("--grad-accum", type=int, default=16)
    p.add_argument("--limit", type=int, default=0, help="use only the first N conversations")
    p.add_argument("--tiny", action="store_true", help="stand-in model on the processor, a few steps")
    p.add_argument("--max-steps", type=int, default=-1)
    p.add_argument("--bf16", action="store_true")
    return p.parse_args()

# Qwen's own way of writing a tool call, for a template that has no tools
# section (the tiny stand-in's). The real Qwen template is used when present.
def fallback_render(messages, tools, add_generation_prompt=False):
    out = []
    for i, m in enumerate(messages):
        if m["role"] == "system":
            sys_text = m["content"]
            if tools:
                sys_text += "\n\n# Tools\n<tools>\n" + "\n".join(json.dumps(t, ensure_ascii=False) for t in tools) + "\n</tools>"
            out.append(f"<|im_start|>system\n{sys_text}<|im_end|>\n")
        elif m["role"] == "assistant":
            body = m.get("content") or ""
            for c in m.get("tool_calls") or []:
                f = c["function"]
                body += "\n<tool_call>\n" + json.dumps({"name": f["name"], "arguments": f["arguments"]}, ensure_ascii=False) + "\n</tool_call>"
            out.append(f"<|im_start|>assistant\n{body.strip()}<|im_end|>\n")
        elif m["role"] == "tool":
            out.append(f"<|im_start|>user\n<tool_response>\n{m['content']}\n</tool_response><|im_end|>\n")
        else:
            out.append(f"<|im_start|>{m['role']}\n{m['content']}<|im_end|>\n")
    if add_generation_prompt:
        out.append("<|im_start|>assistant\n")
    return "".join(out)

def make_render(tok):
    tmpl = getattr(tok, "chat_template", None) or ""
    native = "tool_call" in tmpl or "tools" in tmpl
    def render(messages, tools, add_generation_prompt=False):
        if native:
            return tok.apply_chat_template(messages, tools=[{"type": "function", "function": t} for t in tools] if tools else None,
                                           tokenize=False, add_generation_prompt=add_generation_prompt, enable_thinking=False)
        return fallback_render(messages, tools, add_generation_prompt)
    return render, native

def encode(ex, tok, render, max_len):
    """input_ids, with labels only on the assistant's turns."""
    msgs, tools = ex["messages"], ex.get("tools") or []
    ids, labels = [], []
    prev_text = ""
    for i, m in enumerate(msgs):
        if m["role"] != "assistant":
            continue
        before = render(msgs[:i], tools, add_generation_prompt=True)
        through = render(msgs[:i + 1], tools)
        if not through.startswith(prev_text) or not before.startswith(prev_text):
            return None  # a template that rewrites earlier turns: skip rather than mislabel
        ctx = tok(before[len(prev_text):], add_special_tokens=False)["input_ids"]
        ans = tok(through[len(before):], add_special_tokens=False)["input_ids"]
        ids += ctx + ans
        labels += [-100] * len(ctx) + ans
        prev_text = through
    if not ids or len(ids) > max_len:
        return None
    return {"input_ids": ids, "labels": labels, "attention_mask": [1] * len(ids)}

def main():
    a = parse()
    import torch
    from transformers import AutoTokenizer, AutoModelForCausalLM, Trainer, TrainingArguments, AutoConfig
    from peft import LoraConfig, get_peft_model

    rows = [json.loads(l) for l in open(a.data, encoding="utf-8") if l.strip()]
    if a.limit:
        rows = rows[: a.limit]
    random.Random(7).shuffle(rows)

    if a.tiny:
        here = os.path.dirname(os.path.abspath(__file__))
        tiny = os.path.join(here, "..", "test", "fixtures", "llm-tiny")
        tok = AutoTokenizer.from_pretrained(tiny)
        cfg = AutoConfig.from_pretrained(tiny)
        # Its tokenizer has a few hundred tokens, so a conversation is long in
        # tokens; the window is widened (RoPE, random weights: no harm).
        cfg.max_position_embeddings = 32768
        model = AutoModelForCausalLM.from_config(cfg)
        a.max_len = 32768
    else:
        tok = AutoTokenizer.from_pretrained(a.base)
        model = AutoModelForCausalLM.from_pretrained(a.base, torch_dtype=torch.bfloat16 if a.bf16 else "auto")
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    render, native = make_render(tok)
    print(f"chat template: {'the model’s own, with tools' if native else 'Qwen-format fallback'}", file=sys.stderr)

    data = [e for e in (encode(r, tok, render, a.max_len) for r in rows) if e]
    print(f"{len(data)} of {len(rows)} conversations fit in {a.max_len} tokens", file=sys.stderr)
    if not data:
        sys.exit("nothing to train on")

    targets = [n for n in ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]
               if any(n in name for name, _ in model.named_modules())]
    model = get_peft_model(model, LoraConfig(r=a.lora_r, lora_alpha=a.lora_alpha, lora_dropout=0.05, target_modules=targets, task_type="CAUSAL_LM"))
    model.print_trainable_parameters()

    def collate(batch):
        n = max(len(b["input_ids"]) for b in batch)
        pad = lambda xs, v: xs + [v] * (n - len(xs))
        return {
            "input_ids": torch.tensor([pad(b["input_ids"], tok.pad_token_id) for b in batch]),
            "labels": torch.tensor([pad(b["labels"], -100) for b in batch]),
            "attention_mask": torch.tensor([pad(b["attention_mask"], 0) for b in batch]),
        }

    args = TrainingArguments(
        output_dir=os.path.join(a.out, "checkpoints"), num_train_epochs=a.epochs, max_steps=a.max_steps,
        per_device_train_batch_size=a.batch, gradient_accumulation_steps=1 if a.tiny else a.grad_accum,
        learning_rate=a.lr, lr_scheduler_type="cosine", warmup_ratio=0.03, logging_steps=1 if a.tiny else 10,
        save_strategy="no" if a.tiny else "epoch", bf16=a.bf16, report_to=[], remove_unused_columns=False,
        use_cpu=a.tiny,
    )
    trainer = Trainer(model=model, args=args, train_dataset=data, data_collator=collate)
    result = trainer.train()
    losses = [h["loss"] for h in trainer.state.log_history if "loss" in h]
    merged = model.merge_and_unload()
    merged.save_pretrained(os.path.join(a.out, "merged"))
    tok.save_pretrained(os.path.join(a.out, "merged"))
    json.dump({"base": "tiny stand-in" if a.tiny else a.base, "conversations": len(data), "steps": trainer.state.global_step,
               "first_loss": losses[0] if losses else None, "last_loss": losses[-1] if losses else None},
              open(os.path.join(a.out, "train-summary.json"), "w"), indent=2)
    print(json.dumps({"steps": trainer.state.global_step, "first_loss": losses[:1], "last_loss": losses[-1:]}))

if __name__ == "__main__":
    main()
