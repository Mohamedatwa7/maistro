"""Gate pipeline — the five stages of docs/POSTABILITY.md as one call:

    bytes -> probe -> rules -> (normalize -> re-probe -> re-rules) -> sealed

Used by the MCP submit/check tools. The service layer receives the sealed
probe + report and never touches bytes. Score-what-you-post: the returned
`data` IS the artifact that gets sealed, scored, approved, and posted."""

from __future__ import annotations

from dataclasses import dataclass

from maistro.errors import ServiceError
from maistro.gate.normalize import FfmpegNormalizer
from maistro.gate.rules import BriefConstraints, GateProbe, RulesEngine
from maistro.generated.entities.validation_report import (
    Normalization,
    Probe,
    Status,
    ValidationReport,
)
from maistro.ingest import probe_bytes


@dataclass
class GateResult:
    report: ValidationReport
    data: bytes  # the sealed artifact (normalized when fixes applied)
    probe: GateProbe


async def run_gate(
    data: bytes,
    filename: str,
    media_type: str,
    platforms: list[str],
    brief: BriefConstraints | None,
    rules: RulesEngine,
    normalizer: FfmpegNormalizer | None,
    brief_id: object | None = None,
) -> GateResult:
    probe = await probe_bytes(data, filename)
    report = rules.evaluate(probe, media_type, platforms, brief=brief, brief_id=brief_id)

    if report.status != Status.postable_after_fixes or normalizer is None:
        return GateResult(report=report, data=data, probe=probe)

    fixable_codes = {i.code for i in report.issues if i.class_.value == "fixable"}
    normalized, applied, ffmpeg_version = await normalizer.normalize(
        data, probe, fixable_codes
    )
    final_probe = await probe_bytes(normalized, "normalized.mp4")
    final_report = rules.evaluate(
        final_probe, media_type, platforms, brief=brief, brief_id=brief_id
    )
    if final_report.status == Status.rejected:
        # Convergence failure is a blocker, never a silent pass.
        raise ServiceError(
            422,
            "normalize_failed",
            "normalized output still violates platform rules",
            extra=final_report.model_dump(by_alias=True, mode="json"),
        )
    # Merge: original probe + issues (marked auto-fixed), normalization
    # record, final probe of the sealed artifact.
    merged = ValidationReport(
        status=Status.postable_after_fixes,
        checked_against=report.checked_against,
        probe=report.probe,
        issues=[
            issue.model_copy(update={"auto_fixed": issue.code in fixable_codes})
            for issue in report.issues
        ]
        + [i for i in final_report.issues if i.class_.value == "warning"],
        normalization=Normalization(
            applied=applied,
            output_sha256=final_probe.sha256,
            output_size_bytes=final_probe.size_bytes,
            ffmpeg_version=ffmpeg_version,
        ),
        final=Probe.model_validate(final_probe.model_dump()).model_dump(),
    )
    return GateResult(report=merged, data=normalized, probe=final_probe)
