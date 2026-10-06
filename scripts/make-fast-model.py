#!/usr/bin/env python3
"""Build the bundled Fast model: ISNet general-use with weights stored as float16 (about half the size).

Every large float32 weight tensor is stored as float16 and a Cast node turns it back into float32
when the model loads (ONNX Runtime folds that into a constant), so inference runs in float32 exactly
as before and only the on-disk size shrinks. Inputs, outputs and operators are untouched.

Requires: pip install onnx numpy
Usage:    python scripts/make-fast-model.py [src.onnx] [dst.onnx]
Defaults: src-tauri/resources/models/isnet-general-use.onnx -> .../isnet-general-use-fp16.onnx
"""
import hashlib
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

MIN_ELEMENTS = 256  # leave tiny tensors (shapes, biases) alone

root = Path(__file__).resolve().parent.parent / "src-tauri" / "resources" / "models"
src = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "isnet-general-use.onnx"
dst = Path(sys.argv[2]) if len(sys.argv) > 2 else root / "isnet-general-use-fp16.onnx"

model = onnx.load(str(src))
graph = model.graph

converted = []
kept = []
casts = []
for init in graph.initializer:
    if init.data_type == TensorProto.FLOAT and int(np.prod(init.dims or [1])) >= MIN_ELEMENTS:
        weights = numpy_helper.to_array(init)
        small = numpy_helper.from_array(weights.astype(np.float16), name=f"{init.name}__fp16")
        kept.append(small)
        casts.append(
            helper.make_node("Cast", [small.name], [init.name], to=TensorProto.FLOAT, name=f"{init.name}__cast")
        )
        converted.append(init.name)
    else:
        kept.append(init)

del graph.initializer[:]
graph.initializer.extend(kept)
# Casts only read initializers, so they can safely come first (keeps the graph topologically sorted).
nodes = list(graph.node)
del graph.node[:]
graph.node.extend(casts + nodes)
# Older IR versions list initializers as graph inputs too; the originals are now node outputs.
names = set(converted)
inputs = [i for i in graph.input if i.name not in names]
del graph.input[:]
graph.input.extend(inputs)

onnx.checker.check_model(model)
onnx.save(model, str(dst))
print(f"{dst.name}: {dst.stat().st_size / 1e6:.1f} MB (from {src.stat().st_size / 1e6:.1f} MB), {len(converted)} tensors")
print("sha256", hashlib.sha256(dst.read_bytes()).hexdigest())
