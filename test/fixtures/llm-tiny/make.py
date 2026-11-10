import json, os, torch
from tokenizers import Tokenizer, models, trainers, pre_tokenizers, decoders
from transformers import LlamaConfig, LlamaForCausalLM, PreTrainedTokenizerFast
out = "model"
os.makedirs(out, exist_ok=True)
corpus = ["The Zento Nova is a phone. Kovo Air and Lumi make headphones.", '{"lang":"en","market":"US","brands":[]}',
          "<|im_start|>system\nYou read answers.<|im_end|>\n<|im_start|>user\nhello<|im_end|>\n<|im_start|>assistant\n"] * 50
tok = Tokenizer(models.BPE(unk_token="<unk>"))
tok.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False)
tok.decoder = decoders.ByteLevel()
tr = trainers.BpeTrainer(vocab_size=400, special_tokens=["<unk>", "<|im_start|>", "<|im_end|>", "<|endoftext|>"], initial_alphabet=pre_tokenizers.ByteLevel.alphabet())
tok.train_from_iterator(corpus, tr)
fast = PreTrainedTokenizerFast(tokenizer_object=tok, unk_token="<unk>", eos_token="<|im_end|>", pad_token="<|endoftext|>", bos_token=None)
fast.chat_template = "{% for m in messages %}<|im_start|>{{ m.role }}\n{{ m.content }}<|im_end|>\n{% endfor %}{% if add_generation_prompt %}<|im_start|>assistant\n{% endif %}"
fast.save_pretrained(out)
torch.manual_seed(0)
cfg = LlamaConfig(vocab_size=len(fast), hidden_size=32, intermediate_size=64, num_hidden_layers=2, num_attention_heads=2, num_key_value_heads=1,
                  max_position_embeddings=2048, eos_token_id=fast.convert_tokens_to_ids("<|im_end|>"), pad_token_id=fast.convert_tokens_to_ids("<|endoftext|>"), bos_token_id=None, tie_word_embeddings=True)
m = LlamaForCausalLM(cfg)
m.save_pretrained(out)
print("vocab", len(fast))
