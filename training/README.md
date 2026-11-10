# Training Ask on CitoSkeleton's data

Ask, the assistant in the extension, answers questions about your own captures by calling read-only tools (`src/lib/assistantTools.js`). It already gets the tool's knowledge on every question (`src/lib/askKnowledge.js`), whichever engine answers:
- what is and isn't captured;
- the definitions of the measures;
- a playbook for each kind of question.

This folder goes one step further. It **fine-tunes the model itself**, so a small model calls the right tools and writes complete, accurate answers in the user's language.

Everything here is made up. The campaigns, brands (built from syllables), sites (`.example`) and answers are generated, so no one's data is ever used for training.

## What's here

| File | What it does |
|---|---|
| `synth.mjs` | Builds made-up campaigns in the extension's own record shape. They cover 10 kinds of business (consumer goods, software, banking, hotels, universities, public services, local, insurance), with 2–10 brands, 1–4 engines and 1–6 runs. They include usage limits, ads, product cards and the engines' own searches. |
| `phrases.mjs` | Questions in English, Spanish, Portuguese, French, Hindi and Arabic, and the wording of good answers. These are drafts and need a native speaker's review. |
| `gen.mjs` | Writes the training and test conversations. |
| `eval.mjs` | Scores a model on the test conversations, run exactly as the extension runs it. |
| `train.py` | LoRA fine-tune on the assistant's turns, then merges the result into the base model. |
| `export.py` | Exports to ONNX with 4-bit weights in the Transformers.js layout, puts the chat template where the browser reads it, and optionally uploads. |
| `colab.ipynb` | The same steps on a free Colab GPU. |

### How `gen.mjs` builds each conversation

1. It takes a made-up campaign.
2. It asks one kind of question (13 kinds).
3. It uses the system prompt and tools the extension itself would give for that question.
4. It runs the tool calls a complete answer needs, with the extension's own code.
5. It writes the answer from those results in the question's language.
6. It drops the conversation if the answer contains any number that is not in a tool result.

The test set uses another seed and includes a kind of business the training set never sees.

### How `eval.mjs` scores a model

| Score | What it checks |
|---|---|
| tools | Called what's needed |
| args | Its calls worked |
| faithful | No number the tools didn't give |
| complete | The reference answer's key numbers are present |
| language | Answered in the question's language |
| honest | For what isn't captured, says so |

`--oracle` replays the reference answers and must score 100%. `--openai URL --model NAME` scores any OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM).

## Run it

```bash
# 1. Data (about 2 minutes for 20,000 conversations; not committed, it is reproducible)
node training/gen.mjs --out training/data --train 20000 --test 1000 --seed 7
node training/eval.mjs --data training/data/test.jsonl --oracle --limit 200   # must say 100

# 2. Train (GPU). On a free Colab T4: Qwen3.5-0.8B in about an hour. On an A100: 2B in about 3–4 hours.
pip install -r training/requirements.txt
python training/train.py --data training/data/train.jsonl --base Qwen/Qwen3.5-2B --out runs/cito-2b --epochs 2 --bf16

# 3. Measure it against the base model before shipping
#    (serve both with an OpenAI-compatible server, e.g. `ollama create` from the merged folder)
node training/eval.mjs --data training/data/test.jsonl --openai http://localhost:11434/v1 --model qwen3.5:2b     --out base.json
node training/eval.mjs --data training/data/test.jsonl --openai http://localhost:11434/v1 --model cito-2b        --out tuned.json

# 4. Export for the extension, and upload
python training/export.py --model runs/cito-2b/merged --out runs/cito-2b/onnx --fp16 --upload YOU/citoskeleton-qwen3.5-2b-onnx
```

Then in the extension, go to About → Settings → Built-in AI → **Your trained model**, enter `YOU/citoskeleton-qwen3.5-2b-onnx` and click **Use my trained model**. **Test this computer** then compares it with Chrome's built-in AI.

**Ship a tuned model only if it beats the base model on `eval.mjs`**, overall and on *faithful*.

## What was verified, and what wasn't

- **Verified in the build container.** The whole chain runs end to end on the processor with a two-layer stand-in (`train.py --tiny`, starting from `test/fixtures/llm-tiny`):
  - generate;
  - train (30 steps; the loss falls);
  - merge;
  - export to 4-bit ONNX;
  - the extension loads that folder and runs both a check and Ask with it.

  The stand-in's weights are random, so its answers are noise. That run proves the plumbing works, not that the model learned anything.
- **Not verified.** Training the real Qwen3.5 needs a GPU and the base model from Hugging Face, and neither is available in the build container. If optimum can't export Qwen3.5's architecture yet:
  1. Use Transformers.js's own `scripts/convert.py` (it made the onnx-community Qwen3.5 builds).
  2. Then run `export.py --skip-export` on its output.
