#!/usr/bin/env python3
"""Export HT-Demucs (v4) to ONNX for the precise stem-rebalance tier.

Run this on a machine that can reach the Demucs weight host (this CI/sandbox
cannot — HuggingFace and dl.fbaipublicfiles.com are network-blocked here).  It
produces `htdemucs.onnx` with a FIXED segment length and prints the
`--segment` / `--rate` values to feed into `pnpm pin:stem-model`.

Setup:
    pip install "torch>=2.1" "demucs>=4.0" onnx

Usage:
    python scripts/export-demucs-onnx.py --out htdemucs.onnx
    # then host the file and pin it:
    pnpm --filter @aimaster/desktop pin:stem-model \\
        --file htdemucs.onnx --url https://<host>/htdemucs.onnx \\
        --rate 44100 --segment <printed value>

Runtime contract (must match src/main/offline/stem-separation.ts):
    input  "mix"   float32 [1, 2, segment]   (stereo, model sample rate)
    output "stems" float32 [1, 4, 2, segment] (vocals, drums, bass, other)

NOTE: this is maintainer tooling — it is not run in CI and is not imported by
the app.  Validate the exported graph's separation quality before shipping.
"""
import argparse
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="htdemucs.onnx")
    ap.add_argument("--model", default="htdemucs", help="demucs model name")
    ap.add_argument("--opset", type=int, default=17, help="ONNX opset (>=17 for STFT)")
    args = ap.parse_args()

    try:
        import torch
        from demucs.pretrained import get_model
    except Exception as e:  # pragma: no cover - maintainer machine only
        print(f"missing deps: {e}\n  pip install 'torch>=2.1' 'demucs>=4.0' onnx", file=sys.stderr)
        return 2

    bag = get_model(args.model)
    bag.eval()
    # htdemucs is a bag of (usually one) model; export the underlying module.
    model = bag.models[0] if hasattr(bag, "models") and len(bag.models) else bag
    model.eval()

    sr = int(getattr(bag, "samplerate", 44100))
    segment = int(round(float(getattr(bag, "segment", 7.8)) * sr))
    # Demucs requires segment lengths it can frame cleanly; valid_length rounds up.
    if hasattr(model, "valid_length"):
        segment = int(model.valid_length(segment))

    print(f"model={args.model} samplerate={sr} segment_samples={segment}")

    class Wrap(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, mix):  # mix: [1, 2, segment]
            out = self.m(mix)     # [1, sources, 2, segment]
            return out

    wrap = Wrap(model).eval()
    dummy = torch.zeros(1, 2, segment, dtype=torch.float32)
    with torch.no_grad():
        torch.onnx.export(
            wrap, dummy, args.out,
            input_names=["mix"], output_names=["stems"],
            opset_version=args.opset, do_constant_folding=True,
        )

    print(f"\n✓ wrote {args.out}")
    print("next:")
    print(f"  pnpm --filter @aimaster/desktop pin:stem-model --file {args.out} "
          f"--url https://<host>/{args.out} --rate {sr} --segment {segment}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
