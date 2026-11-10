"""laya-fixtures.py — writes the fixtures the Laya tests read (0.83.0).

  python test/tools/laya-fixtures.py      (needs: tokenizers, onnx, numpy)

1. test/fixtures/laya-ref.json: sequences built by the model's own Python
   reference, render_options and build_sequence, copied verbatim from
   convaiinnovations/laya rl_common.py (Apache-2.0), over a tiny WordLevel
   tokenizer. Every string the reference tokenizes is recorded with its ids,
   so test/laya.test.mjs runs src/lib/laya.js on exactly the same tokens.
2. test/fixtures/laya-tiny/: a stand-in Laya bundle, laid out like
   duration465/laya-onnx's multilingual/ folder: laya.onnx with its weights in
   laya.onnx.data, laya_config.json, tokenizer/. Same inputs and outputs as
   the real model (input_ids, attention_mask, marker_pos, marker_mask, qtype
   -> logits, act_probs). Its "opinion" is a weight per token: the score of an
   option is the weight of the word right after its [MASK], so the tests know
   which label wins and which are unsure.
Made-up text only.
"""
import json
import os
import re

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper
from tokenizers import Tokenizer, models, pre_tokenizers

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "..", "fixtures")
TINY = os.path.join(FIX, "laya-tiny")


# ------------------------------------------------- verbatim from rl_common.py
def serialize_state(state) -> str:
    if isinstance(state, str):
        return state
    return json.dumps(state, ensure_ascii=False)


def render_options(q):
    t, crit = q["t"], q.get("crit")
    if t == "choice":
        return [k if not v else "%s: %s" % (k, v) for k, v in crit.items()]
    if t == "score":
        return ["level %d: %s" % (i, c) for i, c in enumerate(crit)]
    crit = crit or {}
    return ["false: " + (crit.get("false") or "no, the statement does not hold"),
            "true: " + (crit.get("true") or "yes, the statement holds")]


def build_sequence(tok, state, q, max_len, head_max_len, option_order=None, truncate_left=False):
    mask_tok = tok.mask_token
    opts = render_options(q)
    order = option_order if option_order is not None else list(range(len(opts)))
    ins = str(q["ins"]).replace(mask_tok, " ")
    head_ids = tok("%s question: %s" % (q["t"], ins), add_special_tokens=False)["input_ids"]
    opt_ids = []
    for i in order:
        opt_ids.append([tok.mask_token_id] + tok(" " + opts[i].replace(mask_tok, " "), add_special_tokens=False)["input_ids"][:48])
    opt_budget = head_max_len - sum(len(o) for o in opt_ids)
    if opt_budget < 16:
        per = max(4, (head_max_len - 16) // max(1, len(opt_ids)))
        opt_ids = [o[:per] for o in opt_ids]
        opt_budget = head_max_len - sum(len(o) for o in opt_ids)
    head_ids = head_ids[:max(8, opt_budget)]
    ids = [tok.cls_token_id] + head_ids + [tok.sep_token_id]
    markers = []
    for o in opt_ids:
        markers.append(len(ids))
        ids.extend(o)
    ids.append(tok.sep_token_id)
    room = max(0, max_len - len(ids) - 1)
    st = tok(serialize_state(state).replace(mask_tok, " "), add_special_tokens=False)["input_ids"]
    st = st[-room:] if truncate_left else st[:room]
    ids = ids + st + [tok.sep_token_id]
    return ids[:max_len], [m for m in markers if m < max_len]
# ----------------------------------------------------------------------------


SPECIALS = ["[PAD]", "[SEP]", "[CLS]", "<unk>", "[MASK]"]  # ids 0..4, as in the real bundle


class Tok:
    """The slice of a Hugging Face tokenizer build_sequence uses, recording what it encodes."""
    mask_token = "[MASK]"

    def __init__(self, tk):
        self.tk = tk
        self.mask_token_id = tk.token_to_id("[MASK]")
        self.cls_token_id = tk.token_to_id("[CLS]")
        self.sep_token_id = tk.token_to_id("[SEP]")
        self.seen = {}

    def __call__(self, text, add_special_tokens=False):
        ids = self.tk.encode(text, add_special_tokens=False).ids
        self.seen[text] = ids
        return {"input_ids": ids}


def words_of(*texts):
    out = []
    for t in texts:
        out += re.findall(r"\w+|[^\w\s]+", t)
    return out


def make_tokenizer(extra_words):
    vocab = {s: i for i, s in enumerate(SPECIALS)}
    for w in extra_words:
        if w not in vocab:
            vocab[w] = len(vocab)
    tk = Tokenizer(models.WordLevel(vocab=vocab, unk_token="<unk>"))
    tk.pre_tokenizer = pre_tokenizers.Whitespace()
    for s in SPECIALS:
        tk.add_special_tokens([s])
    return tk, vocab


# The words the stand-in knows: CitoSkeleton's questions and options
# (src/lib/laya.js) and the test answers. Anything else is <unk>.
LABEL_TEXT = """
choice score noul question What does the person's prompt ask for? How far along is the person who asked, in choosing?
Who is the answer written for? Where does the answer apply? In the answer, what is How does the answer treat
comparison local price_value trust careers howto for_use best_top other awareness consideration decision post_purchase
consumer business public_sector mixed national regional global brand product retailer publisher institution place person
recommended positive neutral negative advised_against mentioned level false true no yes the statement does not hold holds
prompt answer name passages best reading lamp lamps for Zento Kovo Lumora is a are top pick good cheap avoid it buy
comparing options or looking alternatives something nearby in about price cost deals value money safety reliability
compliance jobs hiring salaries how to do what fit particular use asking choices reviews none of these learning topic
not choosing yet weighing few ready pick one already has using fixing complaining buying themselves their home company
professional government body school public service people companies alike city area country countries region anywhere
world shop marketplace that sells things website magazine reviewer organisation else put first spoken well described
without praise criticism criticised reader told only named passing Über Größe
"""


def ref_cases(tok):
    long_state = {"prompt": "best lamp", "answer": " ".join(["Zento is a good lamp ."] * 120)}
    many = {"t": "choice", "ins": "pick one", "crit": {("o%d" % i): ("option text " * 20).strip() for i in range(12)}}
    base = {"t": "choice", "ins": "What is Zento?", "crit": {"brand": "a company or brand", "product": None, "other": "something else"}}
    cases = [
        ("choice with and without option text", {"name": "Zento", "passages": ["Zento is a top pick."]}, base, {}),
        ("a string state", "Zento is a good lamp", base, {}),
        ("score options", {"answer": "cheap"}, {"t": "score", "ins": "How cheap is it?", "crit": ["not", "a little", "very"]}, {}),
        ("yes/no with the default wording", {"answer": "buy it"}, {"t": "noul", "ins": "Does it say to buy?", "crit": None}, {}),
        ("yes/no with its own wording", {"answer": "avoid it"}, {"t": "noul", "ins": "Avoid?", "crit": {"false": "no", "true": "yes avoid"}}, {}),
        ("a [MASK] typed in the text is a space", {"answer": "Zento [MASK] Kovo"}, {"t": "choice", "ins": "Which [MASK] one?", "crit": {"Zento": None, "Kovo": "[MASK] other"}}, {}),
        ("a long state is cut to max_len", long_state, base, {"max_len": 64}),
        ("a long state cut from the left", long_state, base, {"max_len": 64, "truncate_left": True}),
        ("many long options shrink to fit the head", {"answer": "x"}, many, {"head_max_len": 96}),
        ("options in another order", {"answer": "Kovo"}, base, {"option_order": [2, 0, 1]}),
        ("non-ASCII kept (json.dumps ensure_ascii=False)", {"name": "Über", "answer": "Größe"}, base, {}),
        ("max_len shorter than the options", {"answer": "x"}, base, {"max_len": 12}),
    ]
    out = []
    for label, state, q, kw in cases:
        max_len, head = kw.get("max_len", 1024), kw.get("head_max_len", 256)
        ids, markers = build_sequence(tok, state, q, max_len, head, option_order=kw.get("option_order"), truncate_left=kw.get("truncate_left", False))
        out.append({"label": label, "state": state, "q": q, "maxLen": max_len, "headMaxLen": head,
                    "optionOrder": kw.get("option_order"), "truncateLeft": kw.get("truncate_left", False),
                    "options": render_options(q), "ids": ids, "markers": markers})
    return out


def make_model(vocab, path):
    """logits[b, k] = W[input_ids[b, marker_pos[b, k] + 1]], masked; act_probs = [0.5, 0.5]."""
    w = np.zeros((len(vocab),), dtype=np.float32)
    # What the stand-in "believes": these first words of an option win.
    for word, score in {"best_top": 6.0, "decision": 6.0, "consumer": 6.0, "brand": 6.0, "recommended": 6.0}.items():
        w[vocab[word]] = score
    # Scope is left flat (every option 0): an unsure label, by design.
    W = numpy_helper.from_array(w, name="W")
    one = numpy_helper.from_array(np.array(1, dtype=np.int64), name="one")
    neg = numpy_helper.from_array(np.array(-1e4, dtype=np.float32), name="neg")
    half = numpy_helper.from_array(np.array([0.5, 0.5], dtype=np.float32), name="half")
    two = numpy_helper.from_array(np.array([2], dtype=np.int64), name="two")
    nodes = [
        helper.make_node("Add", ["marker_pos", "one"], ["next_pos"]),
        helper.make_node("GatherElements", ["input_ids", "next_pos"], ["next_ids"], axis=1),
        helper.make_node("Gather", ["W", "next_ids"], ["scores"], axis=0),
        helper.make_node("Where", ["marker_mask", "scores", "neg"], ["logits"]),
        helper.make_node("Shape", ["qtype"], ["b"]),
        helper.make_node("Concat", ["b", "two"], ["act_shape"], axis=0),
        helper.make_node("Expand", ["half", "act_shape"], ["act_probs"]),
    ]
    g = helper.make_graph(nodes, "laya_tiny", [
        helper.make_tensor_value_info("input_ids", TensorProto.INT64, ["B", "L"]),
        helper.make_tensor_value_info("attention_mask", TensorProto.INT64, ["B", "L"]),
        helper.make_tensor_value_info("marker_pos", TensorProto.INT64, ["B", "K"]),
        helper.make_tensor_value_info("marker_mask", TensorProto.BOOL, ["B", "K"]),
        helper.make_tensor_value_info("qtype", TensorProto.INT64, ["B"]),
    ], [
        helper.make_tensor_value_info("logits", TensorProto.FLOAT, ["B", "K"]),
        helper.make_tensor_value_info("act_probs", TensorProto.FLOAT, ["B", 2]),
    ], initializer=[W, one, neg, half, two])
    m = helper.make_model(g, opset_imports=[helper.make_opsetid("", 17)], producer_name="citoskeleton-test")
    m.ir_version = 8
    onnx.checker.check_model(m)
    for f in ("laya.onnx", "laya.onnx.data"):
        if os.path.exists(os.path.join(path, f)):
            os.remove(os.path.join(path, f))
    onnx.save_model(m, os.path.join(path, "laya.onnx"), save_as_external_data=True, all_tensors_to_one_file=True,
                    location="laya.onnx.data", size_threshold=0)


def main():
    os.makedirs(os.path.join(TINY, "tokenizer"), exist_ok=True)
    tk, vocab = make_tokenizer(words_of(LABEL_TEXT, "o0 o1 o2 o3 o4 o5 o6 o7 o8 o9 o10 o11 option text not little very Does it say to Avoid Which one x"))
    tok = Tok(tk)
    cases = ref_cases(tok)
    with open(os.path.join(FIX, "laya-ref.json"), "w", encoding="utf-8") as f:
        json.dump({"source": "convaiinnovations/laya rl_common.build_sequence (verbatim), tiny WordLevel tokenizer",
                   "special": {"cls": tok.cls_token_id, "sep": tok.sep_token_id, "mask": tok.mask_token_id},
                   "encodings": tok.seen, "cases": cases}, f, ensure_ascii=False, indent=1)
    tk.save(os.path.join(TINY, "tokenizer", "tokenizer.json"))
    with open(os.path.join(TINY, "tokenizer", "tokenizer_config.json"), "w") as f:
        json.dump({"tokenizer_class": "PreTrainedTokenizerFast", "cls_token": "[CLS]", "sep_token": "[SEP]", "mask_token": "[MASK]",
                   "pad_token": "[PAD]", "unk_token": "<unk>", "bos_token": "[CLS]", "eos_token": "[SEP]",
                   "model_max_length": 1024, "clean_up_tokenization_spaces": False}, f, indent=1)
    with open(os.path.join(TINY, "laya_config.json"), "w") as f:
        json.dump({"max_len": 1024, "head_max_len": 256, "temperature": [1.0, 1.0, 1.0], "temperature_by_options": {}}, f, indent=1)
    make_model(vocab, TINY)
    print("wrote", len(cases), "reference cases and the stand-in model")


if __name__ == "__main__":
    main()
