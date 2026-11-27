/**
 * The auth brand panel (preview `aside()` in features/auth.js): an illustration of layered documents (a page with a
 * marked passage under a focus ring, a page behind it, a small chart in front) joined to a network of people, concepts
 * and collections. Decorative; colours and motion live in pages/auth.css (`.au-art*`), hidden under 1024 px.
 */
export function AuthAside() {
  return (
    <aside className="auth__aside au-aside">
      <svg className="au-art" viewBox="0 0 520 420" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
        <defs>
          <pattern id="au-art-dots" width="20" height="20" patternUnits="userSpaceOnUse">
            <circle className="au-art__dot" cx="2" cy="2" r="1.1" />
          </pattern>
          <radialGradient id="au-art-fade">
            <stop offset="0" stopColor="#fff" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <mask id="au-art-mask">
            <rect width="520" height="420" fill="url(#au-art-fade)" />
          </mask>
          <filter id="au-art-shadow" x="-30%" y="-30%" width="160%" height="170%">
            <feDropShadow className="au-art__shadow" dx="0" dy="14" stdDeviation="16" />
          </filter>
        </defs>
        <rect width="520" height="420" fill="url(#au-art-dots)" mask="url(#au-art-mask)" />
        <circle className="au-art__orbit" cx="290" cy="214" r="178" />
        <circle className="au-art__orbit" cx="290" cy="214" r="116" />
        <g className="au-art__float au-art__float--late">
          <g transform="rotate(7 366 176)" filter="url(#au-art-shadow)">
            <rect className="au-art__paper" x="290" y="62" width="156" height="200" rx="16" />
            <rect className="au-art__tile--blue" x="308" y="82" width="26" height="26" rx="8" />
            <rect className="au-art__glyph--blue" x="316" y="90" width="10" height="10" rx="3" />
            <rect className="au-art__ink-strong" x="344" y="86" width="70" height="7" rx="3.5" />
            <rect className="au-art__ink" x="344" y="99" width="46" height="5" rx="2.5" />
            <rect className="au-art__ink" x="308" y="128" width="120" height="5" rx="2.5" />
            <rect className="au-art__ink" x="308" y="142" width="104" height="5" rx="2.5" />
            <rect className="au-art__ink" x="308" y="156" width="116" height="5" rx="2.5" />
            <rect className="au-art__ink" x="308" y="170" width="70" height="5" rx="2.5" />
          </g>
        </g>
        <g transform="rotate(-3 266 218)" filter="url(#au-art-shadow)">
          <rect className="au-art__paper" x="168" y="96" width="196" height="244" rx="18" />
          <rect className="au-art__tile--peach" x="188" y="116" width="30" height="30" rx="9" />
          <path className="au-art__glyph--peach" d="M197 124h8l5 5v9a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-12a2 2 0 0 1 2-2z" />
          <rect className="au-art__ink-strong" x="228" y="121" width="92" height="8" rx="4" />
          <rect className="au-art__ink" x="228" y="135" width="58" height="6" rx="3" />
          <rect className="au-art__ink" x="188" y="168" width="156" height="6" rx="3" />
          <rect className="au-art__ink" x="188" y="184" width="140" height="6" rx="3" />
          <rect className="au-art__ink" x="188" y="200" width="150" height="6" rx="3" />
          <rect className="au-art__mark" x="184" y="214" width="132" height="16" rx="5" />
          <rect className="au-art__mark-ink" x="190" y="219" width="120" height="6" rx="3" />
          <rect className="au-art__ink" x="188" y="240" width="146" height="6" rx="3" />
          <rect className="au-art__ink" x="188" y="256" width="122" height="6" rx="3" />
          <rect className="au-art__ink" x="188" y="272" width="98" height="6" rx="3" />
          <rect className="au-art__ink" x="188" y="306" width="40" height="14" rx="7" />
          <rect className="au-art__ink" x="234" y="306" width="54" height="14" rx="7" />
        </g>
        <g className="au-art__float">
          <g transform="rotate(-7 146 300)" filter="url(#au-art-shadow)">
            <rect className="au-art__paper" x="70" y="246" width="152" height="112" rx="14" />
            <rect className="au-art__ink-strong" x="86" y="262" width="56" height="6" rx="3" />
            <rect className="au-art__ink" x="86" y="274" width="36" height="5" rx="2.5" />
            <rect className="au-art__bar--soft" x="88" y="314" width="16" height="28" rx="4" />
            <rect className="au-art__bar--blue" x="112" y="300" width="16" height="42" rx="4" />
            <rect className="au-art__bar--soft" x="136" y="320" width="16" height="22" rx="4" />
            <rect className="au-art__bar--violet" x="160" y="292" width="16" height="50" rx="4" />
            <rect className="au-art__bar--soft" x="184" y="308" width="16" height="34" rx="4" />
          </g>
        </g>
        <path className="au-art__link au-art__link--quiet" d="M78 92 Q 54 150 104 186" />
        <path className="au-art__link au-art__link--quiet" d="M458 60 Q 526 180 478 300" />
        <path className="au-art__link" d="M313 227 C 250 120, 160 70, 78 92" />
        <path className="au-art__link" d="M313 227 C 360 160, 400 86, 458 60" />
        <path className="au-art__link" d="M313 227 C 380 250, 420 300, 478 300" />
        <path className="au-art__link" d="M313 227 C 330 300, 360 362, 404 378" />
        <circle className="au-art__lens" cx="313" cy="227" r="30" />
        <circle className="au-art__halo au-art__halo--violet" cx="78" cy="92" r="22" />
        <circle className="au-art__halo au-art__halo--peach" cx="478" cy="300" r="22" />
        <circle className="au-art__node au-art__node--violet" cx="78" cy="92" r="15" />
        <circle className="au-art__node au-art__node--blue" cx="458" cy="60" r="13" />
        <circle className="au-art__node au-art__node--peach" cx="478" cy="300" r="15" />
        <g className="au-art__icon" transform="translate(70.8 84.8) scale(0.6)">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </g>
        <g className="au-art__icon" transform="translate(451.4 53.4) scale(0.55)">
          <path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z" />
          <circle cx="7.5" cy="7.5" r=".5" />
        </g>
        <g className="au-art__icon" transform="translate(470.8 292.8) scale(0.6)">
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" />
        </g>
        <circle className="au-art__node au-art__node--amber" cx="404" cy="378" r="6" />
        <circle className="au-art__node au-art__node--blue" cx="104" cy="186" r="5" />
        <circle className="au-art__node au-art__node--violet" cx="313" cy="227" r="6" />
        <rect className="au-art__spark" x="150" y="50" width="10" height="10" rx="2" transform="rotate(45 155 55)" />
        <circle className="au-art__ring" cx="236" cy="380" r="6" />
      </svg>
    </aside>
  );
}
