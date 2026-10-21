"""Brief composition (CONTRACTS.md §3.2): the creator's Brief is COMPOSED
from Trend Radar's embedded editorial brief + the chosen adaptation +
confirmed learnings — not fetched from TR's generative endpoint."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from maistro.generated.trend_radar import AgentTrend

DEFAULT_DEADLINE_DAYS = 3
DEFAULT_DURATION_CAP_S = 15.0


def compose_brief(
    trend: AgentTrend,
    *,
    platforms: list[str],
    learnings: list[str] | None = None,
    deadline_days: int = DEFAULT_DEADLINE_DAYS,
) -> dict[str, Any]:
    """Build the Brief body (contracts/schemas/brief.json shape).

    Picks the highest-scoring product adaptation when TR authored one;
    degrades gracefully to trend-level fields when it didn't."""
    editorial = trend.brief
    adaptation = None
    if editorial is not None and editorial.adaptations:
        adaptation = editorial.adaptations[0]

    product = {"product": "Galaxy", "line": "Phone"}
    if adaptation is not None:
        product = {"product": adaptation.product, "line": adaptation.line}
    elif trend.products:
        best = max(trend.products, key=lambda p: p.score)
        product = {"product": best.product, "line": best.line}

    hooks: list[str] = []
    if adaptation is not None and adaptation.hook:
        hooks.append(adaptation.hook)
    if trend.format is not None:
        hooks.append(f"Open on the mechanic: {trend.format.mechanic}")
    if not hooks:
        hooks.append(f"Lead with the trend: {trend.name}")

    sound = None
    if trend.sound is not None:
        sound = {"title": trend.sound.title, "author": trend.sound.author, "cue": trend.sound.cue}

    fmt = None
    if trend.format is not None:
        fmt = {
            "mechanic": trend.format.mechanic,
            "payoff": trend.format.payoff,
            "props": list(trend.format.props),
            "secondsToPayoff": trend.format.secondsToPayoff,
        }

    dos = list(adaptation.dos) if adaptation is not None and adaptation.dos else []
    donts = list(adaptation.donts) if adaptation is not None and adaptation.donts else []
    donts.append("No competitor devices or logos in frame")  # brand-safety hard rule

    deadline = datetime.now(UTC) + timedelta(days=deadline_days)
    return {
        "trend": {
            "name": trend.name,
            "why_now": trend.why,
            "stage": trend.stage,
            "sound": sound,
            "format": fmt,
            "evidence_tags": list(trend.tags),
        },
        "angle": (
            adaptation.samsungify or adaptation.idea
            if adaptation is not None
            else f"Samsung take on: {trend.why}"
        ),
        "product": product,
        "format": f"{int(DEFAULT_DURATION_CAP_S)}s vertical video, "
        + ("sound-led" if sound else "visual-led"),
        "hooks": hooks,
        "on_screen_text": adaptation.onScreenText if adaptation is not None else None,
        "sound_use": adaptation.soundUse if adaptation is not None else None,
        "cta": adaptation.cta if adaptation is not None else None,
        "dos": dos,
        "donts": donts,
        "kpi_focus": "upper",
        "references": [],
        "platforms": platforms,
        "constraints": {
            "duration_cap_s": DEFAULT_DURATION_CAP_S,
            "requires_audio": sound is not None,
        },
        "deadline": deadline.isoformat(),
        "learnings_applied": learnings or [],
    }


def render_brief_text(body: dict[str, Any]) -> str:
    """Flatten a Brief body into the advertiser-context text sent to F1X8 as
    `description` — this is what makes F1X8 return context_score (J4)."""
    lines = [
        f"Trend: {body['trend']['name']} — {body['trend']['why_now']}",
        f"Angle: {body['angle']}",
        f"Product: {body['product']['product']} ({body['product']['line']})",
        f"Format: {body['format']}",
        f"Hooks: {'; '.join(body['hooks'])}",
        f"KPI focus: {body['kpi_focus']} funnel",
    ]
    if body.get("dos"):
        lines.append("Do: " + "; ".join(body["dos"]))
    if body.get("donts"):
        lines.append("Don't: " + "; ".join(body["donts"]))
    return "\n".join(lines)
