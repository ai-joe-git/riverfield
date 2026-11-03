#!/usr/bin/env python3
"""Remplacer le kernel Triton du nœud H3 SLA par Sol-Attn (comfy-kitchen, HIP).

Pourquoi : le kernel Triton `sla/kernel.py` ne rend jamais la main sur gfx1151 dès que la
séquence packée dépasse ~50k tokens (topk >~ 90). Le GPU se bloque, le noyau logue
`ring gfx_0.0.0 timeout` puis réinitialise le ring — ce qui tue la session graphique.
C'est arrivé à chaque essai 8 s / 0.6-0.8 MP.

comfy-kitchen fournit la même sélection creuse (top-k par bloc de requêtes, l'équivalent
« SLA-style top-k ») en kernel HIP natif : `sol_attn(topk_ratio=..., tail=False)`. Mesuré
ici 22x plus rapide que SDPA dense à T=32k, sans Triton.

Le patch est appliqué dans `sla/patch.py`, au point d'appel du kernel. Il est idempotent et
laisse une copie `sla/patch.py.orig-riverfield` pour revenir en arrière :

    cp sla/patch.py.orig-riverfield sla/patch.py

Usage : python local/patch-h3-sla-solattn.py [chemin-du-ComfyUI]
"""
from __future__ import annotations

import sys
from pathlib import Path

DEFAULT_COMFY = Path("/home/zardoz/comfyui-vanilla-gfx1151/ComfyUI")
NODE_DIR = "custom_nodes/comfyui-h3-sla-attention-rocm"

OLD = '''            call_idx = state["call_idx"]
            state["call_idx"] = call_idx + 1
            prev_lut = state["prev_lut"].get(call_idx) if stabilize_motion else None

            if stabilize_motion:
                lut, topk, history = get_block_map(
                    qb, kb, vb, topk_ratio, blkq, blkk,
                    protect_upto=prefix, prev_lut=prev_lut,
                    protect_ranges=protected_ranges, return_history=True,
                    stabilize_query_from=stabilize_query_from,
                    reference_ranges=reference_ranges,
                    reference_sparsity=reference_sparsity,
                )
                # Only the bounded boundary slice is retained -- see
                # block_map.py. Storing the full lut here is what made this
                # grow to several GB per run at 768p with stabilize_motion on.
                state["prev_lut"][call_idx] = history
            else:
                lut, topk = get_block_map(
                    qb, kb, vb, topk_ratio, blkq, blkk,
                    protect_upto=prefix, prev_lut=prev_lut,
                    protect_ranges=protected_ranges,
                    reference_ranges=reference_ranges,
                    reference_sparsity=reference_sparsity,
                )
            out = block_sparse_attention(qb, kb, vb, lut, topk, blkq, blkk)
'''

NEW = '''            call_idx = state["call_idx"]
            state["call_idx"] = call_idx + 1

            # ---- RiverField local patch: native Sol-Attn instead of Triton ----
            # The Triton block-sparse kernel in kernel.py never returns on gfx1151
            # once the packed sequence grows past roughly 50k tokens (topk >~ 90):
            # the GPU wedges, the kernel logs "ring gfx_0.0.0 timeout" and the
            # whole session is reset. comfy-kitchen ships the same SLA-style
            # top-k routing as a native HIP kernel (sol_attn(topk_ratio=...,
            # tail=False)), which measured 22x faster than dense SDPA here and
            # does not wedge anything. Same sparsity, no Triton.
            import comfy_kitchen
            nk = max(1, (int(kb.shape[1]) + blkk - 1) // blkk)
            topk = max(1, min(nk, int(round(topk_ratio * nk))))
            sink_blocks = (
                [0, min(nk, (prefix + blkk - 1) // blkk)] if prefix > 0 else None
            )
            out = comfy_kitchen.sol_attn(
                qb, kb, vb,
                scale=None,
                topk_ratio=topk_ratio,
                tail=False,
                sink_blocks=sink_blocks,
            )
            # ---- end RiverField local patch ----------------------------------
'''


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_COMFY
    patch_py = root / NODE_DIR / "sla" / "patch.py"
    if not patch_py.is_file():
        print(f"absent : {patch_py}")
        return 1

    text = patch_py.read_text()
    if "RiverField local patch: native Sol-Attn" in text:
        print("déjà patché")
        return 0
    if OLD not in text:
        print("motif introuvable — le nœud a changé, patch à revoir")
        return 1

    backup = patch_py.with_suffix(".py.orig-riverfield")
    if not backup.exists():
        backup.write_text(text)
    patch_py.write_text(text.replace(OLD, NEW, 1))
    print(f"patché : {patch_py}")
    print(f"sauvegarde : {backup}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
