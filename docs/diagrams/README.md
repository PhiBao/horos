# Diagrams

The four figures in the README's Architecture section, drawn with the
[diagram-design](https://github.com/cathrynlavery/diagram-design) skill
(self-contained HTML + SVG, no Mermaid). The `.html` files are the sources of
truth; the `.svg` files are what the README embeds, exported with the skill's
`export_svg.py`.

## Files

| File | README section | Type |
|---|---|---|
| `horos-rule` | The rule, and how it holds | Architecture (secure paved road) |
| `horos-release` | The ceremony — release trace | Sequence |
| `horos-refusal-ceremony` | The ceremony — refusal + ceremony trace | Sequence |
| `horos-authority` | Where the money and the authority sit | Architecture (secure paved road) |

The ceremony sequence was split in two: the source had 6 lifelines and 23
messages against a 5-lifeline / 12-message budget, so it became a release trace
(Business, Agent, Registry, Circle, Vault) and a refusal + ceremony trace
(Business, Agent, Circle, Registry, Vendor).

## Rebuilding

```bash
python3 docs/diagrams/build.py   # regenerate all four .html files
```

Then verify with the skill's own gates (paths depend on the install):

```bash
python3 <skill>/scripts/self_check.py docs/diagrams/horos-*.html
python3 <skill-root>/scripts/verify-geometry.py docs/diagrams/horos-*.html
python3 <skill>/scripts/export_svg.py docs/diagrams/<name>.html docs/diagrams/<name>.svg
```

Skin is the skill default (warm-paper editorial): it has to read in both GitHub
light and dark mode, so there is no dark variant. Remote fonts do not load in
GitHub-sanitized SVG — the exports were checked with fonts blocked and stay
legible on system sans/mono fallbacks.
