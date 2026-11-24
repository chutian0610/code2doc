# Contributing

Thanks! code2doc is small and typed; most changes fit in one focused PR.

## Dev setup

Requires Node 20+.

```
npm ci
npm test           # the dogfood doc tree under code2doc/ is guarded too
npm run typecheck
```

## Pull requests

- One focused change per PR — CI gates typecheck + tests on every push.
- The doc tree under `code2doc/` is checked by the suite. If you change
  public symbols, update the claims and refresh fingerprints
  (`npm run refresh-anchors`) rather than weakening an anchor.
- Architecture decisions start as an ADR in [docs/adr/](docs/adr/).

## Issues

- Bug reports: use the template — command, output, expectation.
- New language support: open a "language support request". Adding a
  language is one extractor plus tests
  ([how](code2doc/howtos/add-a-language.md)).
