A stand-in language model for the built-in AI's browser tests (0.70.0):
a two-layer Llama with random weights (about 260 KB) and a 353-token
tokenizer, so the download, cache and generate path can be tested
offline without the real Qwen3.5 weights. Its output is meaningless.

Made with `make.py` (transformers, tokenizers) and
`optimum-cli export onnx -m model --task text-generation-with-past onnxout`;
the chat template is copied into tokenizer_config.json because
Transformers.js reads it from there for a tokenizer.
