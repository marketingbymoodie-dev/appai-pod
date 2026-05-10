# AOP Calibration Storage

The automated AOP calibration runner stores artifacts in a dedicated Supabase
Storage bucket named `aop-calibration`.

Create this bucket manually in Supabase Storage before running calibration in
production. The bucket must be public if the saved URLs need to be viewed
directly from the exported JSON or debug endpoints.

Stored paths:

- `runs/{runId}/panels/{panelKey}.png`
- `runs/{runId}/mockups/{viewName}.png`
- `runs/{runId}/export.json`

The runner uses `upsert: false` and refuses to overwrite existing calibration
artifacts. It does not use the customer `designs` bucket.
