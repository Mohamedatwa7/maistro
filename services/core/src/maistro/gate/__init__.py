"""The postability gate (docs/POSTABILITY.md).

rules.py is the pure rules engine — probe in, ValidationReport out.
Normalization (stage 4) is protocol-driven: NullNormalizer (current) runs
strict mode — fixable issues are escalated to blockers with an explicit
fix_hint, never silently passed. FfmpegNormalizer is the next M2 work item;
swapping it in changes no caller."""

from maistro.gate.rules import GateProbe, NullNormalizer, RulesEngine

__all__ = ["GateProbe", "NullNormalizer", "RulesEngine"]
