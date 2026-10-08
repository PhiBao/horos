#!/usr/bin/env python3
"""Build the four Horos README diagrams as self-contained HTML (diagram-design skill).

Sources of truth: README.md's three Mermaid blocks, redrawn — never converted.
Run:  python3 docs/diagrams/build.py
Out:  docs/diagrams/horos-{rule,release,refusal-ceremony,authority}.html

Every coordinate below is on the 4px grid; type follows the standard ramp
(names 12px Geist 600, sublabels 9px mono, arrow/legend labels 8px mono).
Verify with the skill's own gates after regenerating:
  python3 <skill>/scripts/self_check.py <file>
  python3 <skill>/scripts/verify-geometry.py <file>
"""

import re

INK = "#2d3142"
MUTED = "#4f5d75"
SOFT = "#7a8399"
PAPER = "#f5f5f5"
ACCENT = "#eb6c36"
ACCENT_TINT = "rgba(235,108,54,0.08)"
EXT_TINT = "rgba(79,93,117,0.10)"
EXT_STROKE = "#7a8399"
RULE = "rgba(45,49,66,0.10)"
ZONE_FILL = "rgba(45,49,66,0.02)"
ZONE_STROKE = "rgba(45,49,66,0.10)"
SANS = "'Geist', sans-serif"
MONO = "'Geist Mono', monospace"

HEAD = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{h1}</title>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{ font-family: 'Geist', system-ui, sans-serif; background: #f5f5f5; color: #2d3142;
      min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 3rem 2rem; }}
    .frame {{ max-width: 1200px; width: 100%; }}
    .diagram-container {{ width: 100%; overflow-x: auto; }}
    .eyebrow {{ font-family: 'Geist Mono', monospace; font-size: 0.66rem; font-weight: 500;
      letter-spacing: 0.18em; text-transform: uppercase; color: #4f5d75; margin-bottom: 0.5rem; }}
    h1 {{ font-family: 'Instrument Serif', serif; font-size: clamp(1.5rem, 2.4vw + 0.75rem, 2rem);
      font-weight: 400; letter-spacing: -0.02em; line-height: 1.15; margin-bottom: 1.5rem; }}
    svg {{ width: 100%; min-width: 960px; display: block; }}
    @media print {{ .diagram-container {{ overflow-x: visible; }} svg {{ min-width: 0; }} }}
  </style>
</head>
<body>
  <div class="frame">
    <p class="eyebrow">{eyebrow}</p>
    <h1>{h1}</h1>
    <div class="diagram-container">
      <svg viewBox="0 0 960 600" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="{slug}-title {slug}-desc">
        <title id="{slug}-title">{title}</title>
        <desc id="{slug}-desc">{desc}</desc>
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="#4f5d75"/></marker>
          <marker id="arrow-accent" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="#eb6c36"/></marker>
          <marker id="arrow-open" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polyline points="0 0, 8 3, 0 6" fill="none" stroke="#4f5d75" stroke-width="1.2"/></marker>
        </defs>
        <rect width="100%" height="100%" fill="#f5f5f5"/>
"""


def elbow(points, r=8):
    """Orthogonal path through points with rounded r=8 corners. Points share x or y pairwise."""
    assert len(points) >= 2
    d = [f"M{points[0][0]},{points[0][1]}"]
    for i in range(1, len(points) - 1):
        (x0, y0), (cx, cy), (x2, y2) = points[i - 1], points[i], points[i + 1]
        dx1, dy1 = cx - x0, cy - y0
        dx2, dy2 = x2 - cx, y2 - cy
        # unit directions
        ux1, uy1 = (1 if dx1 > 0 else -1 if dx1 < 0 else 0), (1 if dy1 > 0 else -1 if dy1 < 0 else 0)
        ux2, uy2 = (1 if dx2 > 0 else -1 if dx2 < 0 else 0), (1 if dy2 > 0 else -1 if dy2 < 0 else 0)
        d.append(f"L{cx - ux1 * r},{cy - uy1 * r}")
        d.append(f"Q{cx},{cy} {cx + ux2 * r},{cy + uy2 * r}")
    d.append(f"L{points[-1][0]},{points[-1][1]}")
    return " ".join(d)


def edge(points, marker="arrow", stroke=MUTED, sw=1.2, dash=None, comment=""):
    dash_s = f' stroke-dasharray="{dash}"' if dash else ""
    c = f"<!-- {comment} -->\n        " if comment else ""
    return (f'{c}<path d="{elbow(points)}" fill="none" stroke="{stroke}" '
            f'stroke-width="{sw}"{dash_s} marker-end="url(#{marker})"/>')


def hline(x1, x2, y, marker="arrow", stroke=MUTED, sw=1.2, dash=None, comment=""):
    dash_s = f' stroke-dasharray="{dash}"' if dash else ""
    c = f"<!-- {comment} -->\n        " if comment else ""
    return (f'{c}<line x1="{x1}" y1="{y}" x2="{x2}" y2="{y}" stroke="{stroke}" '
            f'stroke-width="{sw}"{dash_s} marker-end="url(#{marker})"/>')


def vline(x, y1, y2, marker="arrow", stroke=MUTED, sw=1.2, dash=None):
    dash_s = f' stroke-dasharray="{dash}"' if dash else ""
    return (f'<line x1="{x}" y1="{y1}" x2="{x}" y2="{y2}" stroke="{stroke}" '
            f'stroke-width="{sw}"{dash_s} marker-end="url(#{marker})"/>')


def alabel(cx, cy, text, color=MUTED, anchor="middle"):
    """Arrow label with opaque mask; cy = text baseline. Mask sits above the stroke."""
    w = int(len(text) * 4.96 + 16)
    x = cx - w / 2 if anchor == "middle" else (cx if anchor == "start" else cx - w)
    return (f'<rect x="{x:g}" y="{cy - 20:g}" width="{w}" height="12" rx="2" fill="{PAPER}"/>\n'
            f'        <text x="{cx:g}" y="{cy - 11:g}" fill="{color}" font-size="8" '
            f'font-family="{MONO}" text-anchor="middle" letter-spacing="0.06em">{text}</text>')


def alabel_side(x, cy, text, side="right", color=MUTED):
    """Label beside a vertical segment; x = text edge nearest the line."""
    w = int(len(text) * 4.96 + 16)
    rx = x + 8 if side == "right" else x - 8 - w
    cx = rx + w / 2
    return (f'<rect x="{rx:g}" y="{cy - 6:g}" width="{w}" height="12" rx="2" fill="{PAPER}"/>\n'
            f'        <text x="{cx:g}" y="{cy + 3:g}" fill="{color}" font-size="8" '
            f'font-family="{MONO}" text-anchor="middle" letter-spacing="0.06em">{text}</text>')


def node(x, y, w, h, name, subs=(), fill=PAPER, stroke="rgba(45,49,66,0.30)", sw=1, comment=""):
    cx = x + w / 2
    n = len(subs)
    # name sits just above vertical center accounting for sublabel lines
    name_y = y + h / 2 - (n * 14) / 2 + 4 if n else y + h / 2 + 4
    s = []
    if comment:
        s.append(f"<!-- Node: {comment} -->")
    s.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="{PAPER}"/>')
    s.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>')
    s.append(f'<text x="{cx:g}" y="{name_y:g}" fill="{INK}" font-size="12" font-weight="600" font-family="{SANS}" text-anchor="middle">{name}</text>')
    for i, sub in enumerate(subs):
        s.append(f'<text x="{cx:g}" y="{name_y + 18 + i * 14:g}" fill="{MUTED}" font-size="9" font-family="{MONO}" text-anchor="middle">{sub}</text>')
    return "\n        ".join(s)


def zone(x, y, w, h, label, comment=""):
    tw = int(len(label) * 5.9 + 20)
    c = f"<!-- Zone: {comment} -->\n        " if comment else ""
    return (f'{c}<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="{ZONE_FILL}" stroke="{ZONE_STROKE}" stroke-width="0.8"/>\n'
            f'        <rect x="{x + 8}" y="{y + 4}" width="{tw}" height="12" rx="2" fill="{PAPER}"/>\n'
            f'        <text x="{x + 8 + tw / 2:g}" y="{y + 13}" fill="rgba(45,49,66,0.40)" font-size="7" '
            f'font-family="{MONO}" text-anchor="middle" letter-spacing="0.14em">{label}</text>')


def legend(items, y=544):
    """items: (kind, text) with kind in line/dashed/ghost/focal/bar."""
    parts = [f'<line x1="30" y1="524" x2="930" y2="524" stroke="{RULE}" stroke-width="0.8"/>']
    x = 60
    for kind, text in items:
        if kind == "line":
            parts.append(f'<line x1="{x}" y1="{y - 3}" x2="{x + 40}" y2="{y - 3}" stroke="{MUTED}" stroke-width="1.2" marker-end="url(#arrow)"/>')
        elif kind == "accent-line":
            parts.append(f'<line x1="{x}" y1="{y - 3}" x2="{x + 40}" y2="{y - 3}" stroke="{ACCENT}" stroke-width="1.4" marker-end="url(#arrow-accent)"/>')
        elif kind == "dashed":
            parts.append(f'<line x1="{x}" y1="{y - 3}" x2="{x + 40}" y2="{y - 3}" stroke="{MUTED}" stroke-width="1" stroke-dasharray="5,4" marker-end="url(#arrow)"/>')
        elif kind == "ghost":
            parts.append(f'<line x1="{x}" y1="{y - 3}" x2="{x + 32}" y2="{y - 3}" stroke="{SOFT}" stroke-width="1" stroke-dasharray="5,4"/>')
            parts.append(f'<circle cx="{x + 40}" cy="{y - 3}" r="6" fill="{PAPER}" stroke="{SOFT}" stroke-width="1.2"/>')
            parts.append(f'<line x1="{x + 36.8}" y1="{y - 6.2}" x2="{x + 43.2}" y2="{y + 0.2}" stroke="{SOFT}" stroke-width="1.2"/>')
            parts.append(f'<line x1="{x + 43.2}" y1="{y - 6.2}" x2="{x + 36.8}" y2="{y + 0.2}" stroke="{SOFT}" stroke-width="1.2"/>')
        elif kind == "focal":
            parts.append(f'<rect x="{x}" y="{y - 11}" width="30" height="14" rx="3" fill="{ACCENT_TINT}" stroke="{ACCENT}" stroke-width="1.4"/>')
        elif kind == "ext":
            parts.append(f'<rect x="{x}" y="{y - 11}" width="30" height="14" rx="3" fill="{EXT_TINT}" stroke="{EXT_STROKE}" stroke-width="1"/>')
        elif kind == "bar":
            parts.append(f'<rect x="{x + 11}" y="{y - 13}" width="8" height="20" fill="rgba(45,49,66,0.06)" stroke="{MUTED}" stroke-width="0.8"/>')
        parts.append(f'<text x="{x + 52}" y="{y:g}" fill="{MUTED}" font-size="8" font-family="{MONO}" letter-spacing="0.06em">{text}</text>')
        x += 52 + int(len(text) * 5.0 + 60)
    return "\n        ".join(parts)


def stop(x, y, comment=""):
    c = f"<!-- {comment} -->\n        " if comment else ""
    return (f'{c}<circle cx="{x}" cy="{y}" r="7" fill="{PAPER}" stroke="{SOFT}" stroke-width="1.4"/>\n'
            f'        <line x1="{x - 3.5}" y1="{y - 3.5}" x2="{x + 3.5}" y2="{y + 3.5}" stroke="{SOFT}" stroke-width="1.4"/>\n'
            f'        <line x1="{x + 3.5}" y1="{y - 3.5}" x2="{x - 3.5}" y2="{y + 3.5}" stroke="{SOFT}" stroke-width="1.4"/>')


def page(slug, eyebrow, h1, title, desc, body):
    return HEAD.format(eyebrow=eyebrow, h1=h1, slug=slug, title=title, desc=desc) + body + """      </svg>
    </div>
  </div>
</body>
</html>
"""


def diagram_rule():
    """Secure paved road -> Architecture. The rule, and how it holds."""
    b = []
    # Zones (before arrows and nodes)
    b.append(zone(210, 40, 540, 166, "L2 · JUDGMENT · OFFCHAIN, REPLACEABLE", "L2 judgment"))
    b.append(zone(210, 264, 540, 150, "L1 · THE RULE · ONCHAIN, UNFORGEABLE", "L1 rule"))
    b.append(zone(210, 426, 540, 88, "L3 · MEMORY · COMPOUNDING ASSET", "L3 memory"))
    # Edges (before nodes). Ports fanned per rule 4; elbows r=8.
    # POLICY -> REG, the one permitted path into L1
    b.append(edge([(620, 174), (620, 230), (351, 230), (351, 300)], comment="proposal, never authority"))
    b.append(alabel_side(620, 200, "PROPOSAL ONLY", side="left"))
    # REG -> VAULT, destination resolution
    b.append(hline(426, 526, 347))
    b.append(alabel(476, 347, "ACTIVE ACCOUNT"))
    # REG -> PAGE, events feed (dashed)
    b.append(edge([(250, 394), (250, 440)], dash="5,4", comment="events feed"))
    b.append(alabel_side(250, 412, "EVENTS"))
    # AGENT submits (dashed), two fanned bottom ports.
    # The vault-bound run hops over the Circle-to-registry path at (613,420):
    # bridge the dashed (less important) run, leave the solid one uninterrupted.
    b.append(edge([(90, 334), (90, 506), (613, 506), (613, 394)], dash="5,4",
                   comment="agent submits to vault"))
    # NOTE: elbow() rounds every corner; the hop below is hand-drawn for the bridge
    b.append(alabel_side(613, 454, "SUBMITS"))
    b.append(edge([(140, 334), (140, 410), (300, 410), (300, 394)], dash="5,4", comment="agent submits to registry"))
    b.append(alabel_side(140, 372, "SUBMITS", side="right"))
    # CIRCLE signs (solid)
    b.append(edge([(770, 278), (700, 278), (700, 300)], comment="Circle signs into vault"))
    b.append(edge([(845, 334), (845, 266), (400, 266), (400, 300)], comment="Circle signs into registry"))
    # Forbidden: model -> release, stopped above the L1 boundary (hops over the proposal path)
    b.append('<path d="M710,174 V250" fill="none" stroke="#7a8399" stroke-width="1" stroke-dasharray="5,4"/>')
    b.append(stop(710, 250, "stopped before the trust boundary"))
    b.append(alabel_side(710, 208, "NO RELEASE", side="left"))
    # Nodes
    b.append(node(40, 250, 150, 84, "Agent", ["no private key"], fill=EXT_TINT, stroke=EXT_STROKE, comment="agent"))
    b.append(node(770, 250, 150, 84, "Circle custody", ["holds the key · signs"], fill=EXT_TINT, stroke=EXT_STROKE, comment="circle"))
    b.append(node(226, 72, 160, 102, "Invoice in", ["pdf · email · paste", "model proposes fields"], comment="invoice+extract"))
    b.append(node(401, 72, 160, 102, "Assemble evidence", ["payments · screening", "amount · terms"], comment="evidence"))
    b.append(node(576, 72, 160, 102, "Decide", ["RELEASE · HOLD · ESCALATE", "deterministic, in code"], comment="policy"))
    b.append(node(226, 300, 200, 94, "CounterpartyRegistry", ["durable identity", "public lineage · ceremony"], comment="registry"))
    b.append(node(526, 300, 208, 94, "CustodyVault", ["holds the USDC", "pay takes no address"],
                   fill=ACCENT_TINT, stroke=ACCENT, sw=1.5, comment="vault FOCAL"))
    b.append(node(226, 442, 300, 56, "Counterparty page", ["no signup · public"], comment="page"))
    # Legend
    b.append(legend([("line", "PROPOSES · READS"), ("dashed", "SUBMITS · EMITS"),
                     ("ghost", "BLOCKED — NO RELEASE PATH"), ("focal", "FOCAL · THE VAULT")]))
    return page("horos-rule", "ARCHITECTURE · HOROS", "The rule, and how it holds",
                "Horos — the rule, and how it holds",
                "Offchain judgment proposes while onchain contracts dispose; no path runs from the model to a release.",
                "\n        ".join(b))



def diagram_authority():
    """Secure paved road -> Architecture. Where the money and the authority sit."""
    b = []
    b.append(zone(300, 40, 620, 150, "AUTHORITY · TWO KEYS", "authority"))
    b.append(zone(280, 264, 220, 116, "CUSTODY · CIRCLE", "custody"))
    b.append(zone(540, 214, 380, 276, "ARC · ONCHAIN", "chain"))
    # Edges first
    b.append(hline(240, 300, 322, comment="agent submits into custody"))
    b.append(hline(460, 560, 322, comment="custody forwards into the registry"))
    b.append(alabel(505, 322, "FORWARDS"))
    b.append(edge([(480, 174), (480, 302), (560, 302)], comment="business signs the payer half"))
    b.append(alabel(516, 302, "PAYER SIGNS"))
    b.append(edge([(760, 174), (760, 200), (660, 200), (660, 260)], comment="vendor signs the old-key half"))
    b.append(alabel(710, 200, "OLD-KEY SIGNS"))
    b.append(hline(760, 824, 432, marker="arrow-accent", stroke=ACCENT, sw=1.4,
                   comment="USDC settles to the recorded account"))
    b.append(alabel(792, 432, "USDC"))
    # Forbidden: the agent paying out directly, stopped cold
    b.append(edge([(150, 364), (150, 508), (855, 508), (855, 478)], stroke=SOFT, sw=1,
                  dash="5,4", comment="no direct payment"))
    b.append(stop(855, 478, "stopped before the recipient"))
    b.append(alabel_side(855, 491, "NO DIRECT PAY", side="left"))
    # Nodes
    b.append(node(40, 280, 200, 84, "Agent work", ["reads · assembles · proposes"], comment="agent task"))
    b.append(node(320, 72, 280, 102, "Business", ["authorises destination"], comment="business"))
    b.append(node(620, 72, 280, 102, "Vendor", ["authorises own account"], comment="vendor"))
    b.append(node(300, 280, 160, 84, "Circle wallet", ["the only signer"], fill=EXT_TINT, stroke=EXT_STROKE, comment="wallet"))
    b.append(node(560, 260, 200, 84, "CounterpartyRegistry", ["no updateAccount fn"], comment="registry"))
    b.append(node(560, 390, 200, 84, "CustodyVault", ["pay takes an id, not address"],
                   fill=ACCENT_TINT, stroke=ACCENT, sw=1.5, comment="vault FOCAL"))
    cx, cy, r = 860, 432, 36
    b.append(f"<!-- Node: recipient -->\n        <rect x=\"{cx - r}\" y=\"{cy - r}\" width=\"{2 * r}\" height=\"{2 * r}\" rx=\"36\" fill=\"{PAPER}\"/>")
    b.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{EXT_TINT}" stroke="{EXT_STROKE}" stroke-width="1"/>')
    b.append(f'<text x="{cx}" y="{cy + 4}" fill="{INK}" font-size="12" font-weight="600" font-family="{SANS}" text-anchor="middle">recipient</text>')
    b.append(legend([("line", "SUBMITS · SIGNS"), ("accent-line", "USDC SETTLES"),
                     ("ghost", "BLOCKED — NO DIRECT PAY"), ("focal", "FOCAL · VAULT")]))
    return page("horos-authority", "ARCHITECTURE · HOROS", "Where the money and the authority sit",
                "Where the money and the authority sit",
                "The agent submits and proposes while the business and vendor sign; only the vault pays, and only to the recorded account.",
                "\n        ".join(b))



def actor(cx, y, w, name, sub):
    x = cx - w / 2
    return (f"<!-- Actor: {name} -->\n        <rect x=\"{x:g}\" y=\"{y}\" width=\"{w}\" height=\"54\" rx=\"6\" fill=\"{PAPER}\"/>\n"
            f'        <rect x="{x:g}" y="{y}" width="{w}" height="54" rx="6" fill="rgba(45,49,66,0.03)" stroke="rgba(45,49,66,0.30)" stroke-width="1"/>\n'
            f'        <text x="{cx:g}" y="{y + 23}" fill="{INK}" font-size="12" font-weight="600" font-family="{SANS}" text-anchor="middle">{name}</text>\n'
            f'        <text x="{cx:g}" y="{y + 40}" fill="{MUTED}" font-size="9" font-family="{MONO}" text-anchor="middle">{sub}</text>')


def lifeline(cx, y1, y2):
    return (f'<line x1="{cx}" y1="{y1}" x2="{cx}" y2="{y2}" stroke="rgba(45,49,66,0.20)" '
            f'stroke-width="1" stroke-dasharray="3,3"/>')


def bar(cx, y1, y2):
    return (f'<rect x="{cx - 4}" y="{y1}" width="8" height="{y2 - y1}" '
            f'fill="rgba(45,49,66,0.06)" stroke="{MUTED}" stroke-width="0.8"/>')


def selfloop(cx, y, w=30, h=20, marker="arrow", stroke=MUTED, sw=1.2, dash=None):
    dash_s = f' stroke-dasharray="{dash}"' if dash else ""
    return (f'<path d="M{cx},{y} H{cx + w - 6} Q{cx + w},{y} {cx + w},{y + 6} V{y + h - 6} '
            f'Q{cx + w},{y + h} {cx + w - 6},{y + h} H{cx},{y + h}" fill="none" stroke="{stroke}" '
            f'stroke-width="{sw}"{dash_s} marker-end="url(#{marker})"/>')


def band(x1, x2, y1, y2, label, sub=None):
    s = [f'<rect x="{x1}" y="{y1}" width="{x2 - x1}" height="{y2 - y1}" rx="4" fill="{ZONE_FILL}"/>',
         f'<text x="{x1 + 12}" y="{y1 + 18}" fill="{SOFT}" font-size="8" font-family="{MONO}" letter-spacing="0.12em">{label}</text>']
    if sub:
        s.append(f'<text x="{x1 + 12}" y="{y1 + 32}" fill="{SOFT}" font-size="8" font-family="{MONO}">{sub}</text>')
    return "\n        ".join(s)


def note_box(x1, x2, y, h, lines):
    s = [f'<rect x="{x1}" y="{y}" width="{x2 - x1}" height="{h}" rx="4" fill="{ZONE_FILL}" stroke="{RULE}" stroke-width="0.8"/>']
    cy = y + h / 2 - (len(lines) - 1) * 7
    for i, ln in enumerate(lines):
        s.append(f'<text x="{(x1 + x2) / 2:g}" y="{cy + i * 14:g}" fill="{MUTED}" font-size="8" '
                 f'font-family="{MONO}" text-anchor="middle">{ln}</text>')
    return "\n        ".join(s)


def diagram_release():
    """Sequence. Release — the ordinary invoice (5 lifelines, 7 messages)."""
    b = []
    cx = [90, 285, 480, 675, 870]
    names = [("Business", "sends invoice"), ("Agent", "no key"), ("Registry", "durable record"),
             ("Circle", "custody · signs"), ("Vault", "holds USDC")]
    for x, w, (n, s) in zip(cx, [100] * 5, names):
        # actor boxes w100
        xx = x - 50
        b.append(f"<!-- Actor: {n} -->\n        <rect x=\"{xx}\" y=\"96\" width=\"100\" height=\"54\" rx=\"6\" fill=\"{PAPER}\"/>")
        b.append(f'<rect x="{xx}" y="96" width="100" height="54" rx="6" fill="rgba(45,49,66,0.03)" stroke="rgba(45,49,66,0.30)" stroke-width="1"/>')
        b.append(f'<text x="{x}" y="119" fill="{INK}" font-size="12" font-weight="600" font-family="{SANS}" text-anchor="middle">{n}</text>')
        b.append(f'<text x="{x}" y="136" fill="{MUTED}" font-size="9" font-family="{MONO}" text-anchor="middle">{s}</text>')
        b.append(lifeline(x, 150, 516))
    # activation bars: Vault holds through the payable check; Registry holds while answering
    b.append(bar(870, 374, 466))
    b.append(bar(480, 420, 466))
    # messages (bars drawn before arrows? bars sit on lifelines; draw bars first, then arrows, then nodes-none here)
    # (x1, x2, y, label, label_cx, marker, color, dash). Labels sit in a gap beside
    # their own segment — never over another lifeline (sequence anti-pattern).
    msgs = [
        (140, 235, 190, "INVOICE", 187.5, "arrow", MUTED, None),
        (335, 430, 236, "ACTIVE ACCOUNT", 382.5, "arrow", MUTED, None),
        (430, 335, 282, "PAID BEFORE", 382.5, "arrow", MUTED, "5,4"),
        (335, 625, 328, "PAY", 382.5, "arrow", MUTED, None),
        (625, 820, 374, "SIGNED PAY", 772.5, "arrow", MUTED, None),
        (820, 530, 420, "IS PAYABLE", 772.5, "arrow", MUTED, None),
        (530, 820, 466, "TRUE", 772.5, "arrow-accent", ACCENT, None),
    ]
    for x1, x2, y, label, lcx, marker, color, dash in msgs:
        b.append(hline(x1, x2, y, marker=marker,
                       stroke=color, sw=1.4 if marker == "arrow-accent" else 1.2, dash=dash))
        w = int(len(label) * 4.96 + 16)
        b.append(f'<rect x="{lcx - w / 2:g}" y="{y - 20}" width="{w}" height="12" rx="2" fill="{PAPER}"/>')
        b.append(f'<text x="{lcx:g}" y="{y - 11}" fill="{color}" font-size="8" '
                 f'font-family="{MONO}" text-anchor="middle" letter-spacing="0.06em">{label}</text>')
    # gap-local labels for the two jumps: PAY sits in the A-R gap, IS PAYABLE in the C-V gap
    # (implemented above by full-span centering would collide; repositioned below)
    b.append(note_box(110, 830, 482, 30, [
        "vault.pay(counterpartyId, amount, ref) — no address parameter",
        "USDC goes to the recorded account"]))
    b.append(legend([("line", "CALLS"), ("dashed", "RETURNS"), ("accent-line", "HEADLINE · PAYABLE"),
                     ("bar", "HOLDS CONTROL")]))
    return page("horos-release", "SEQUENCE · HOROS", "Release — the ordinary invoice",
                "Release — the ordinary invoice",
                "Seven messages release an invoice to the address on record; the registry answers payable and the money follows.",
                "\n        ".join(b))



def diagram_refusal():
    """Sequence. Refusal, then ceremony (5 lifelines, 9 messages, 2 phase bands)."""
    b = []
    cx = [90, 285, 480, 675, 870]
    names = [("Business", "sends invoice"), ("Agent", "no key"), ("Circle", "custody · signs"),
             ("Registry", "durable record"), ("Vendor", "was last paid")]
    for x, (n, s) in zip(cx, names):
        xx = x - 50
        b.append(f"<!-- Actor: {n} -->\n        <rect x=\"{xx}\" y=\"96\" width=\"100\" height=\"54\" rx=\"6\" fill=\"{PAPER}\"/>")
        b.append(f'<rect x="{xx}" y="96" width="100" height="54" rx="6" fill="rgba(45,49,66,0.03)" stroke="rgba(45,49,66,0.30)" stroke-width="1"/>')
        b.append(f'<text x="{x}" y="119" fill="{INK}" font-size="12" font-weight="600" font-family="{SANS}" text-anchor="middle">{n}</text>')
        b.append(f'<text x="{x}" y="136" fill="{MUTED}" font-size="9" font-family="{MONO}" text-anchor="middle">{s}</text>')
        b.append(lifeline(x, 150, 530))
    # Phase bands (washes, no fragment frames: nothing branches)
    b.append(band(50, 370, 162, 292, "THE ATTACK", None))
    b.append(f'<text x="62" y="280" fill="{SOFT}" font-size="8" '
             f'font-family="{MONO}">nothing called — pay() names no address</text>')
    b.append(band(50, 910, 298, 534, "THE CEREMONY", "recipient can never sign its arrival"))
    # (x1, x2, y, label, label_cx) — labels in gaps, never over a lifeline
    msgs = [
        (140, 235, 206, "NEW ADDRESS", 187.5),
        (335, 625, 352, "PROPOSE", 382.5),
        (625, 530, 378, "PROPOSE", 577),
        (820, 530, 404, "ATTEST OLD KEY", 772),
        (140, 530, 430, "ATTEST PAYER", 187.5),
        (335, 625, 456, "ACTIVATE", 382.5),
        (625, 530, 482, "ACTIVATE", 577),
    ]
    for x1, x2, y, label, lcx in msgs:
        b.append(hline(x1, x2, y))
        w = int(len(label) * 4.96 + 16)
        b.append(f'<rect x="{lcx - w / 2:g}" y="{y - 20}" width="{w}" height="12" rx="2" fill="{PAPER}"/>')
        b.append(f'<text x="{lcx:g}" y="{y - 11}" fill="{MUTED}" font-size="8" '
                 f'font-family="{MONO}" text-anchor="middle" letter-spacing="0.06em">{label}</text>')
    # The refusal: a self-decision on the Agent lifeline
    b.append(selfloop(285, 238))
    b.append(f'<rect x="323" y="232" width="48" height="12" rx="2" fill="{PAPER}"/>')
    b.append(f'<text x="347" y="241" fill="{MUTED}" font-size="8" '
             f'font-family="{MONO}" text-anchor="middle" letter-spacing="0.06em">HOLDS</text>')
    # The durable outcome: lineage grows, in accent
    b.append('<path d="M675,508 H699 Q705,508 705,514 V522 Q705,528 699,528 H675,528" fill="none" '
             f'stroke="{ACCENT}" stroke-width="1.4" marker-end="url(#arrow-accent)"/>')
    b.append(f'<rect x="713" y="506" width="80" height="12" rx="2" fill="{PAPER}"/>')
    b.append(f'<text x="753" y="515" fill="{ACCENT}" font-size="8" '
             f'font-family="{MONO}" text-anchor="middle" letter-spacing="0.06em">LINEAGE GROWS</text>')
    # Legend (wash swatch hand-drawn: bands are washes, not zones)
    b.append(f'<line x1="30" y1="544" x2="930" y2="544" stroke="{RULE}" stroke-width="0.8"/>')
    b.append('<line x1="60" y1="561" x2="100" y2="561" stroke="#4f5d75" stroke-width="1.2" marker-end="url(#arrow)"/>')
    b.append(f'<text x="112" y="564" fill="{MUTED}" font-size="8" font-family="{MONO}" letter-spacing="0.06em">MESSAGES</text>')
    b.append(f'<line x1="250" y1="561" x2="290" y2="561" stroke="{ACCENT}" stroke-width="1.4" marker-end="url(#arrow-accent)"/>')
    b.append(f'<text x="302" y="564" fill="{MUTED}" font-size="8" font-family="{MONO}" letter-spacing="0.06em">DURABLE OUTCOME</text>')
    b.append(f'<rect x="500" y="553" width="40" height="14" rx="2" fill="{ZONE_FILL}" stroke="{RULE}" stroke-width="0.8"/>')
    b.append(f'<text x="552" y="564" fill="{MUTED}" font-size="8" font-family="{MONO}" letter-spacing="0.06em">PHASE</text>')
    return page("horos-refusal-ceremony", "SEQUENCE · HOROS", "Refusal, then ceremony",
                "Refusal, then ceremony",
                "A redirected invoice is refused without a call; the genuine move needs two signatures the recipient cannot supply.",
                "\n        ".join(b))

if __name__ == "__main__":
    import os
    here = os.path.dirname(os.path.abspath(__file__))
    for name, fn in [("horos-rule", diagram_rule), ("horos-authority", diagram_authority),
                    ("horos-release", diagram_release),
                    ("horos-refusal-ceremony", diagram_refusal)]:
        out = os.path.join(here, name + ".html")
        open(out, "w").write(fn())
        print("wrote", out)
