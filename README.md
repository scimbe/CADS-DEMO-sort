# Sort Arena — a CADS-Tunnel reference pipeline

A live sorting-algorithm visualizer where the sorting isn't done by this repo's own code — it's
done by whichever LLM harness a participant chooses to bring, over a real Agent-Fabric channel.
Same underlying task, same strict output contract, wildly different results depending on the
system prompt, skill, and tool discipline wrapped around the model. That gap — harness matters
more than the raw prompt — is the entire point.

Built the same way as CADS-Tunnel's other reference pipelines
([CADS-flappy-demo](https://github.com/scimbe/CADS-flappy-demo),
[CADS-cookbook-demo](https://github.com/scimbe/CADS-cookbook-demo),
[CADS-a2a-demo](https://github.com/scimbe/CADS-a2a-demo)): a static visualization page, a thin
HTTP bridge that dials role agents over the Agent-Fabric channel (or a configured shell command
in dev), and `run-demo.sh up/down/status` to publish it on a CADS-Tunnel plane.

## What's actually here vs. what's a starting point

- The move protocol (`docs/protocol.md`) is the fixed contract — read this first.
- `handlers/reference-sorter.sh` is a plain, non-LLM reference implementation (real insertion
  sort) — always online, exists so the arena is never empty and so there's a known-correct
  baseline to compare every LLM participant against.
- `participants/*` are real example harnesses wired around the same model, each deliberately
  different, built to make the harness-vs-prompt point concrete — see each one's own README for
  what's different about it and why.
- `templates/*` are copy-and-go starting points for joining with your own Claude Code, Codex,
  Gemini CLI, or opencode instance.

## Why this teaches something real

Every participant gets the identical round input and must answer inside the identical strict
JSON contract (`docs/protocol.md`). Nothing about the wire format lets a "better" harness cheat —
the only thing that differs between participants is what's wrapped around the model call:
the system prompt, whether it's coached on an actual algorithm, whether it's given a
self-check step, what tools (if any) it's allowed to reach for. Watching that alone produce
visibly different comparison counts, swap counts, fault rates, and finishing times — on the
same model — is a more convincing lesson than being told it in the abstract.

## Repo layout

```
index.html            the visualization ("Sort Arena")
bridge/                HTTP bridge: orchestrates rounds, validates moves, scores, streams to the page
handlers/              the stdin/stdout contract + a non-LLM reference sorter
participants/          example LLM harnesses (the "Beispiel-Mitspieler")
templates/             starter kits per CLI tool (Claude Code, Codex, Gemini CLI, opencode)
docs/protocol.md        the move contract every participant must honor
docs/onboarding.md      how to join, llms.txt-style (mirrors CADS-Tunnel's agent-onboarding.md)
run-demo.sh             up | down | status — same shape as the sibling demos
compose.sort-demo.yml
```

## Status

Under active build — see the repo's issues for the milestone breakdown and what's
implemented/tested so far vs. still scaffolded.
