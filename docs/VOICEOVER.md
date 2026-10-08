# Voiceover script — horos-demo.mp4 (2:51, 15 scenes)

**The video already has on-screen captions.** They are dense and they carry the
detail. The voiceover should therefore **add**, not read: the framing, the stakes,
the transitions, and the one sentence per scene that the caption cannot say. If you
read the captions aloud the result is a slow, redundant three minutes.

Pace target: **~2.3 words per second**. The script is 380 spoken words over 171 seconds,
which leaves room to breathe. Silence over a visual reads as confidence; do not
fill it.

## Recording

Record **one file per scene** — it is far easier to hit a 9-second window than to
perform 171 seconds flawlessly, and a single blown line costs one scene instead of
the take. Name them `01.wav`, `02.wav`, … and I will place each at its offset with
ffmpeg and mux the result into the mp4.

- Quiet room, mic 15–20cm away, slightly off-axis. Phone memo is fine; a hiss-free
  take beats a wide-range noisy one.
- Speak the line, then **stop and leave two seconds of silence** before the next.
  I trim to the exact window.
- One line per scene, two at most. If a line will not fit, tell me — I will cut it
  rather than have you rush.
- No need to match the captions. Say the numbers once, clearly: *three point oh
  four billion*, *twenty-four thousand incidents*, *two point four USDC*.

## The script

| # | In | Scene | Line | Notes |
|---|---|---|---|---|
| 1 | 0:00 | title | *Horos. It pays invoices, and cannot be talked into paying the wrong address.* | Flat, unhurried. Let the name land before the rest. |
| 2 | 0:06 | problem | *One sentence: our bank details have changed. Calling to confirm used to catch it. Now the voice can be synthesised too.* | The whole premise in three beats. Slow on "synthesised". |
| 3 | 0:15 | the claim | *Most systems check the address against a list. Checks can be argued with. This removes the parameter, so the attack has nothing to hand it.* | The turn of the argument. Land hard on "nothing to hand it". |
| 4 | 0:25 | site · refusal | *Two invoices from the same supplier. The first is paid. The second asks to be paid somewhere new — and the policy stops it before anything is signed.* | Matter-of-fact. This is a recording, not a reveal. |
| 5 | 0:37 | site · every reason | *Six reasons, each naming its own signal. Two are worth pointing at. The document contains text addressed to whoever is reading it. And the account has never been paid.* | Two sentences and a clause. Pause after "pointing at". |
| 6 | 0:52 | site · the public record | *When a supplier genuinely moves accounts, it takes a ceremony. The account that was last paid agrees. The business agrees. The new account can never sign for its own arrival.* | Four short sentences. Even rhythm, no rush. |
| 7 | 1:05 | live run · no key | *This run holds no key. Circle signs every transaction; there is nothing here for a prompt to reach.* | The claim the whole design is built on. Calm, certain. |
| 8 | 1:13 | live run · named once | *The vendor consents to being registered; the business is named once. From then on the payer half of any move belongs to one key — not the agent's.* | Slightly technical. Slow on "consents" and "one key". |
| 9 | 1:25 | live run · refusal (1) | *This invoice asks for a different account. The document gives itself away — it says disregard previous instructions, do not verify.* | Read the quoted phrases flatly, as evidence. |
| 10 | 1:34 | live run · refusal (2) | *Four probabilities, not a verdict. Above zero point five, the policy escalates. The model can slow a payment; never release one.* | The key architectural sentence. Pause before "never release one". |
| 11 | 1:43 | live run · the ceremony | *So the vendor performs the ceremony. It proposes the move. The account that was last paid signs. The business signs, with its own key. Two signatures, from two parties, and neither is the account that benefits.* | Build. The last clause is the punchline — do not trail off. |
| 12 | 1:59 | live run · and now it pays | *And now it pays — two point four USDC to the new account. The lineage grew by one. Nothing here was edited; every line is a transaction.* | Warmth here. This is the payoff. |
| 13 | 2:13 | chain · read with no key | *Everything you just watched, you can check without trusting me. This reads the deployment straight from the chain — no key, no API, no wallet. It takes one script and a public RPC.* | Genuine, not defensive. An invitation. |
| 14 | 2:28 | chain · the interface | *Two accounts. The second replaced the first, with two signatures behind it. And the interface itself: pay takes a counterparty id, not an address. That is a fact about the ABI, and it is checked, not asserted.* | Let the last sentence stand alone. |
| 15 | 2:43 | end | *The refusal is the product. It's all in the repo — eleven audit findings, every fix has a test.* | Brisk. This is the close; do not slow down for it. |

**Total: 380 spoken words / 171 seconds.** Nine seconds of headroom against the
three-minute limit, so a line can run over without breaking the brief.

## Two things to keep true

- **No competitor is named anywhere**, spoken or written. Not in the script, not in
  the video description, not in the form.
- **Numbers stay as recorded.** If you ad-lib, do not round up the traction: the
  video shows one counterparty and 2.4 USDC on testnet, and the submission form is
  where the honest traction numbers belong.

## After recording

Send me the files (or a folder path) and I will:

1. Trim each take to its window and level-match them.
2. Mux the voiceover into `video/horos-demo.mp4` without re-encoding the video.
3. Re-verify the duration is still under 180 seconds.
4. Give you the file to upload to Loom/YouTube/Vimeo, which is what the submission
   form asks for — a link, not a file.
