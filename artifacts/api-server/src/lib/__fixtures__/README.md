# Reproducibility fixtures

This directory contains only small, synthetic, committed inputs for focused
tests. They are not exports, captures, or ownership records. Names such as
`PHI` and `HOU` identify the shape of a market-normalization incident; they do
not identify a production observation.

The reproducibility fixture manifest is
`reproducibility/manifest.json`. Its hashes cover the exact committed fixture
bytes. `historicalSha256` and `sourceBytes` are `null` when historical source
material is unavailable; no value should be guessed or copied from
`attached_assets`.

Private or unredacted evidence must never be committed here. Put local-only
files under `private/` (ignored by the repository) and keep any access or
ownership information outside this checkout. If a private fixture is needed
for a review, record only its shape and the reason it is unavailable in the
manifest.