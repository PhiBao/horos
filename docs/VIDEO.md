# The demo video

**`video/horos-demo.mp4` — 2:55, narrated, subtitled, 1920×1080.**

Eight segments: the hook, the problem, the interface rule, the live refusal on Arc
mainnet, the chain picker and the custody difference between the two deployments, the
public record, the chain read, and the close. Every number, address and transaction in
it exists in this repository or on the chain; nothing is illustrated.

## How it is made

Built with [demo-video-template](https://github.com/PhiBao/demo-video-template) —
narration from edge-tts, scene capture from Playwright, assembly and subtitle burn-in
from ffmpeg. It is generated, not screen-recorded, which is why it can be regenerated
from `docs/video/` rather than re-performed.

| File | What it is |
|---|---|
| [`docs/video/story.json`](video/story.json) | the narration and the scene for each segment — **the source of truth** |
| [`docs/video/video.json`](video/video.json) | branding, voice, theme, subtitle style |
| [`docs/video/horos.srt`](video/horos.srt) | the subtitles that were burned in, as a sidecar |

The three `page` scenes drive the **live site** in a real browser: they load the
counterparty, click the sample invoices, press Decide, scroll to the reasons and the
lineage, and switch the chain picker. If the site changes shape, those scenes fail
loudly rather than quietly showing a stale screenshot.

To rebuild, from a checkout of the template:

```bash
cp docs/video/story.json  ~/demo-video-template/videos/horos/script/story.json
cp docs/video/video.json  ~/demo-video-template/videos/horos/config/video.json
cd ~/demo-video-template && ./scripts/run.sh --project horos
```

Then read `qa/report.txt` and look at `qa/contact_sheet.jpg` and `qa/frames/*.jpg`
before believing it. The build exits zero whether or not the frames are right.

## What the QA gate caught

Worth recording, because it is the argument for having a gate at all:

- **The mainnet site was pointing at a stale deployment.** A first mainnet deploy
  was followed by a second at smaller amounts; the site was never re-synced, so the
  record page rendered an empty counterparty — `exists: true`, no name, no accounts.
  The screen recording found it. Nothing in the test suite could have.
- **One scene ran 48 seconds against 22 seconds of narration.** The actions were
  choreographed for a slower read. Cut to six steps.
- **Subtitles were unreadable over text-dense pages.** A heavier outline was not
  enough; they now sit on a translucent plate, which is the only thing that works
  when the page itself is full of words.

## Notes

- **The chain beat is timed to the narration, and the first cut of it was not.** The
  picker switches to testnet for the sentence about testnet and back for the sentence
  after it. The first attempt had the right pictures in the wrong order — testnet on
  screen while the voice said "mainnet runs in real USDC" — which nothing but the
  frames would have shown. The cue times in `horos.srt` are what the actions are now
  aligned to, so re-voicing the segment means re-checking that beat.
- The narration is **generated**, so it can be re-voiced by changing `story.json`
  and re-running. There is no recorded human audio to keep in sync.
- The mainnet vault was swept before this cut, so the decision card in it shows the
  vault as it now is — empty. The ceremony it shows is permanent and on the explorer;
  the balance is not part of the argument, and the record page states the current
  balance honestly.
- No competitor is named anywhere in the narration or on screen.
