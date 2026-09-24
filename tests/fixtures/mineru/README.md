# MinerU fixtures

Real `structured_content` output from MinerU 4.0.7 (`--tier flash`, CPU), used by
unit tests so CI never needs Python or a running MinerU.

| File | Source |
|---|---|
| `synthetic-paper.structured_content.json` | `make-synthetic-paper.mjs` — a self-authored two-column paper |
| `probes.structured_content.json` | the probe PDF built in `tests/e2e/helpers/probePdf.ts` |

`image_source` fields (base64 page crops, ~90% of the raw size) are replaced with
a placeholder; the app discards them anyway.

To regenerate: build `docker/mineru`, run it, upload the PDF through `/v1/uploads`,
create a `/v1/parse/jobs` job with `"tier": "flash"` and
`"output_formats": ["structured_content"]`, then download the output file.
