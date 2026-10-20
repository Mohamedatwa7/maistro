// Original HaosShowcase component — kept for a future React/Next.js migration.
// The live vanilla site ports this in index.html (rHome + .haos styles), themed
// for Maistro: AI LAB / 2026 / CONTENT AUTOMATION · MAISTRO · +8 subsidiaries ·
// 75% progress · action icon → #/trends.
// Setup when migrating: npx shadcn@latest init · npm i prop-types
// Palette (extend globals.css / Tailwind index.css):
//   --bg-color:#000; --primary-text-color:#95bdc9; --secondary-text-color:#484e58;
//   --glow-color-1:rgba(126,227,135,.25); --glow-color-2:rgba(150,230,160,.35);
//   --glow-color-3:rgba(100,200,110,.2); --line-color:#505050;
import React from 'react';
import PropTypes from 'prop-types';

export default function HaosShowcase({
  bg,
  category,
  year,
  solutionLabel,
  solutionValue,
  title,
  subtitle,
  statLabel,
  statValue,
  bottomValue,
  progressPercent,
  logoText,
  onAction,
  className,
}) {
  return (
    <section
      className={`haos-container ${className}`}
      role="region"
      aria-label="Haos Tech Solutions showcase"
    >
      {bg && <div className="bg">{bg}</div>}

      <div className="grid-item top-left">
        <span className="label">{category}</span>
        <span className="value">{solutionValue}</span>
      </div>

      <div className="grid-item top-center">
        <span className="label">YEAR</span>
        <span className="value">{year}</span>
      </div>

      <div className="grid-item top-right">
        <span className="label">{solutionLabel}</span>
        <span className="value">{solutionValue}</span>
      </div>

      <div className="grid-item main-content">
        <h1>{title}</h1>
        <h2>{subtitle}</h2>
        <div className="stats-block">
          <span className="label">{statLabel}</span>
          <div className="value">{statValue}</div>
        </div>
      </div>

      <div className="grid-item center-logo">
        <div className="haos-logo">{logoText}</div>
      </div>

      <div className="grid-item bottom-left">
        <div className="stats-value">{bottomValue}</div>
        <div
          className="progress-bar"
          role="progressbar"
          aria-valuenow={progressPercent}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>

      <div className="grid-item bottom-right">
        <div
          className="action-icon"
          role="button"
          tabIndex={0}
          aria-label="Perform action"
          onClick={onAction}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onAction();
            }
          }}
        />
      </div>
    </section>
  );
}

HaosShowcase.propTypes = {
  bg: PropTypes.node,
  category: PropTypes.string,
  year: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  solutionLabel: PropTypes.string,
  solutionValue: PropTypes.string,
  title: PropTypes.string,
  subtitle: PropTypes.string,
  statLabel: PropTypes.string,
  statValue: PropTypes.string,
  bottomValue: PropTypes.string,
  progressPercent: PropTypes.number,
  logoText: PropTypes.string,
  onAction: PropTypes.func,
  className: PropTypes.string,
};

HaosShowcase.defaultProps = {
  bg: null,
  category: 'CATEGORY',
  year: 'YEAR',
  solutionLabel: 'TECH SOLUTIONS',
  solutionValue: 'AUTOMATION & ROBOTICS',
  title: 'HAOS Tech Solutions',
  subtitle: 'Brand Concept & Identity',
  statLabel: 'HIGH-QUALITY',
  statValue: 'DEVELOPMENT',
  bottomValue: '+2K',
  progressPercent: 60,
  logoText: 'hAOS',
  onAction: () => {},
  className: '',
};
