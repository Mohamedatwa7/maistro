// Original slideshow component — kept for a future React/Next.js migration.
// SUPERSEDED on the live site by the ASCII dither landing (see
// ascii-dither-landing.md); the vanilla port that used this was removed.
// Setup when migrating: npx shadcn@latest init (no extra deps needed).
import React, { useState } from "react";

const slides = [
  {
    img: "https://images.unsplash.com/photo-1519501025264-65ba15a82390?q=80&w=1920&auto=format&fit=crop",
    text: ["TRENDS BECOME", "CAMPAIGNS"],
  },
  {
    img: "https://images.unsplash.com/photo-1620121692029-d088224ddc74?q=80&w=1920&auto=format&fit=crop",
    text: ["AI CREATES", "HUMANS APPROVE"],
  },
  {
    img: "https://images.unsplash.com/photo-1557672172-298e090bd0f1?q=80&w=1920&auto=format&fit=crop",
    text: ["FROM MOODBOARD", "TO FINAL CUT"],
  },
  {
    img: "https://images.unsplash.com/photo-1419242902214-272b3f66ee7a?q=80&w=1920&auto=format&fit=crop",
    text: ["POSTED AT THE", "PERFECT MOMENT"],
  },
  {
    img: "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?q=80&w=1920&auto=format&fit=crop",
    text: ["PERFORMANCE", "CLOSES THE LOOP"],
  },
];

export default function Component() {
  const [current, setCurrent] = useState(0);

  const nextSlide = () => setCurrent((prev) => (prev + 1) % slides.length);
  const prevSlide = () =>
    setCurrent((prev) => (prev - 1 + slides.length) % slides.length);

  return (
    <div className="slideshow">
      {slides.map((slide, i) => (
        <div
          key={i}
          className={`slide ${i === current ? "active" : ""}`}
          style={{ backgroundImage: `url(${slide.img})` }}
        >
          <div className="slide-text">
            {slide.text.map((t, j) => (
              <span key={j}>{t}</span>
            ))}
          </div>
        </div>
      ))}

      {/* Persistent wordmark */}
      <div className="brand-mark">MAISTRO</div>

      {/* Controls */}
      <button className="nav left" onClick={prevSlide}>
        â†
      </button>
      <button className="nav right" onClick={nextSlide}>
        â†’
      </button>

      {/* Counter */}
      <div className="counter">
        0{current + 1} / 0{slides.length}
      </div>
    </div>
  );
}
