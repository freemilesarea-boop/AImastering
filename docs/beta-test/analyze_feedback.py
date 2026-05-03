#!/usr/bin/env python3
"""
Beta-feedback analyzer (v3.4.1).

Cross-checks a beta tester's subjective ratings (feedback JSON) against the
engine's objective measurements (mastering result JSON) and produces a
compact human-readable correlation report.

Goal: surface "측정 정상 + 사용자 불만" cases — those are where the engine
needs new heuristics or thresholds.

Usage:
    python3 analyze_feedback.py feedback.json [result.json [result2.json ...]]
    python3 analyze_feedback.py --batch path/to/dir/

The script never modifies files.  Output is printed to stdout.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any


def _load(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# ── Cross-check rules (objective metric vs subjective rating) ──────────────

def _classify(score: int | None) -> str:
    if score is None:
        return "?"
    if score <= 2:
        return "bad"
    if score == 3:
        return "ok"
    return "good"


def _cross_check_vocal(metrics: dict, vocal_rating: str | None) -> tuple[str, str]:
    """Returns (status, explanation).  status ∈ {match, mismatch, n/a}."""
    loss = metrics.get("vocalLossDb")
    if loss is None or vocal_rating in (None, "", "?"):
        return "n/a", "vocalLossDb 또는 사용자 평가 없음"
    rating = vocal_rating.lower()
    if loss < 1.5:
        if rating in ("good", "ok"):
            return "match", f"vocalLossDb {loss:.2f} dB (정상) ↔ 사용자 '{rating}'"
        return "mismatch", (
            f"vocalLossDb {loss:.2f} dB 는 정상 범위인데 사용자가 '{rating}'."
            f"  → 측정값에 잡히지 않은 다른 청감 문제일 수 있음."
        )
    if loss >= 3.0:
        if rating == "bad":
            return "match", f"vocalLossDb {loss:.2f} dB (위험) ↔ 사용자 '{rating}'"
        return "mismatch", (
            f"vocalLossDb {loss:.2f} dB 인데 사용자 '{rating}'."
            f"  → 측정상 위험인데 청감엔 OK — 측정 임계값 너무 민감 가능."
        )
    # warn 범위
    return "ok", f"vocalLossDb {loss:.2f} dB (warn) — 사용자 '{rating}'"


def _cross_check_compression(metrics: dict, radio_feel: str | None) -> tuple[str, str]:
    crest_drop = metrics.get("crestFactorDropPct")
    lra_drop   = metrics.get("lraDropPct")
    if crest_drop is None and lra_drop is None:
        return "n/a", ""
    feel = (radio_feel or "").lower()
    aggressive = (crest_drop or 0) >= 0.40 or (lra_drop or 0) >= 0.50
    if aggressive and feel in ("strong", "slight"):
        return "match", (
            f"crest -{(crest_drop or 0)*100:.0f}% / LRA -{(lra_drop or 0)*100:.0f}% "
            f"+ 사용자 라디오 '{feel}'"
        )
    if not aggressive and feel == "strong":
        return "mismatch", (
            f"측정은 정상 (crest -{(crest_drop or 0)*100:.0f}%) 인데 "
            f"사용자가 라디오 느낌 '강함' 으로 평가.  → 청감 지표 추가 검토 필요."
        )
    if aggressive and feel in ("none", ""):
        return "mismatch", (
            f"측정상 과압축 (crest -{(crest_drop or 0)*100:.0f}%, "
            f"LRA -{(lra_drop or 0)*100:.0f}%) 이지만 사용자는 문제 없다고 판단."
            f"  → 청감과 무관한 측정 가능 (false positive)."
        )
    return "ok", f"crest -{(crest_drop or 0)*100:.0f}% LRA -{(lra_drop or 0)*100:.0f}%"


def _cross_check_reference(metrics: dict, similarity: str | None) -> tuple[str, str]:
    ref_score = metrics.get("referenceMatchOverall")
    if ref_score is None:
        return "n/a", ""
    sim = (similarity or "").lower()
    if ref_score >= 80 and sim == "very_close":
        return "match", f"reference score {ref_score:.0f} ↔ '{sim}'"
    if ref_score < 60 and sim == "different":
        return "match", f"reference score {ref_score:.0f} ↔ '{sim}'"
    if ref_score >= 80 and sim == "different":
        return "mismatch", (
            f"reference score {ref_score:.0f} 인데 사용자 '{sim}' 평가."
            f"  → match score 가 청감 일치도와 안 맞음."
        )
    if ref_score < 60 and sim == "very_close":
        return "mismatch", (
            f"reference score {ref_score:.0f} 인데 사용자 '{sim}' 평가."
            f"  → score 임계값 너무 엄격 가능."
        )
    return "ok", f"score {ref_score:.0f} / '{sim}'"


# ── Per-track analyzer ────────────────────────────────────────────────────

def analyze_track(track: dict, result_lookup: dict[str, dict]) -> dict[str, Any]:
    """Analyze one track's feedback entry, optionally enriched by the
    matching result.json.  result_lookup maps track title → result dict."""
    title = track.get("title", "(untitled)")
    out = {"title": title, "scenarios": {}, "summary": []}
    result = result_lookup.get(title)

    for scen_key, label in (
        ("scenarioA_kpop_loud", "A: KPOP Loud"),
        ("scenarioB_preset",    "B: Preset"),
        ("scenarioC_reference", "C: Reference"),
    ):
        s = track.get(scen_key) or {}
        if not s.get("ran"):
            continue
        # Pick metrics from per-feedback engineMetrics first, then result JSON
        metrics = s.get("engineMetrics_optional") or track.get("engineMetrics_optional") or {}
        if result and not metrics:
            metrics = _extract_engine_metrics(result)

        vocal_check = _cross_check_vocal(metrics, s.get("vocalClarity"))
        comp_check  = _cross_check_compression(metrics, s.get("radioFeel"))
        ref_check   = _cross_check_reference(metrics, s.get("similarityToReference"))

        out["scenarios"][scen_key] = {
            "label":        label,
            "score1to5":    s.get("score1to5"),
            "vocalCheck":   vocal_check,
            "compCheck":    comp_check,
            "refCheck":     ref_check,
            "userNotes":    s.get("freeNotes", ""),
            "biggestIssue": s.get("biggestIssue", ""),
        }
        # Surface mismatches into summary
        for status, expl in (vocal_check, comp_check, ref_check):
            if status == "mismatch":
                out["summary"].append(f"[{label}] ⚠ {expl}")

    return out


def _extract_engine_metrics(result: dict) -> dict[str, Any]:
    gs = result.get("gainStaging") or {}
    vp = result.get("vocalProtection") or {}
    lc = result.get("limiterCheck")  or {}
    qc = result.get("qualityCheck")  or {}
    rm = result.get("referenceMatch") or {}
    return {
        "vocalLossDb":         (gs.get("vocalLossDb")
                                if gs.get("vocalLossDb") is not None
                                else vp.get("vocalLossDb")),
        "crestFactorDropPct":  gs.get("crestFactorDropPct"),
        "lraDropPct":          gs.get("lraDropPct"),
        "limiterCheckOverall": lc.get("overall"),
        "qualityCheckOverall": qc.get("overall"),
        "referenceMatchOverall": rm.get("overall"),
        "vocalProtectionActive": vp.get("active"),
        "appliedSafeModes":    result.get("appliedSafeModes", []),
    }


# ── Main report renderer ──────────────────────────────────────────────────

def render(feedback: dict, result_paths: list[str]) -> str:
    result_lookup: dict[str, dict] = {}
    for p in result_paths:
        try:
            r = _load(p)
            # Match by title in input file name when result has no title
            title = r.get("inputFileInfo", {}).get("name") or os.path.basename(p)
            result_lookup[title] = r
            # Also try title from feedback that matches the input path
            for t in feedback.get("tracks", []):
                if t.get("title") and t["title"] in p:
                    result_lookup[t["title"]] = r
        except Exception as exc:
            print(f"[warn] could not load result {p}: {exc}", file=sys.stderr)

    lines: list[str] = []
    tester = feedback.get("tester", {})
    lines.append(f"# Beta feedback report — {tester.get('nickname', 'anonymous')}")
    lines.append(f"  app: {tester.get('appVersion', '?')}, OS: {tester.get('os', '?')}")
    lines.append("")

    track_reports = [analyze_track(t, result_lookup) for t in feedback.get("tracks", [])]

    # Per-track detail
    for tr in track_reports:
        lines.append(f"## {tr['title']}")
        for scen, data in tr["scenarios"].items():
            lines.append(f"  {data['label']}  — score {data['score1to5']}/5")
            for label, (status, expl) in (
                ("vocal", data["vocalCheck"]),
                ("comp",  data["compCheck"]),
                ("ref",   data["refCheck"]),
            ):
                if status != "n/a":
                    icon = {"match": "✓", "mismatch": "⚠", "ok": "·"}.get(status, " ")
                    lines.append(f"     {icon} {label:5}: {expl}")
            if data["biggestIssue"]:
                lines.append(f"     biggest issue: {data['biggestIssue']}")
            if data["userNotes"]:
                lines.append(f"     notes: {data['userNotes']}")
        lines.append("")

    # Summary of mismatches
    mismatches = [m for tr in track_reports for m in tr["summary"]]
    if mismatches:
        lines.append("## ⚠ Measurement vs perception mismatches")
        for m in mismatches:
            lines.append(f"  {m}")
        lines.append("")
    else:
        lines.append("## ✓ All measurement vs perception checks aligned.")
        lines.append("")

    overall = feedback.get("overall", {})
    if any(overall.values()):
        lines.append("## Overall feedback")
        for k, v in overall.items():
            if v:
                lines.append(f"  {k:18}: {v}")

    return "\n".join(lines)


# ── CLI ───────────────────────────────────────────────────────────────────

def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2

    if argv[1] == "--batch":
        if len(argv) < 3:
            print("--batch requires a directory path", file=sys.stderr)
            return 2
        d = Path(argv[2])
        feedback_files = list(d.glob("feedback*.json"))
        result_files   = list(d.glob("result*.json")) + list(d.glob("debug*.json"))
        for fp in feedback_files:
            print(render(_load(str(fp)), [str(p) for p in result_files]))
            print("\n" + "=" * 70 + "\n")
        return 0

    feedback_path = argv[1]
    result_paths  = argv[2:]
    print(render(_load(feedback_path), result_paths))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
