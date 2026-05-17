# AI-assisted AOP calibration v1 (deterministic CV)

This is the v1 workflow that produces an *initial* mesh and mask
suggestion for the AOP Calibration Mapper without using GPT/SAM/RAFT or
any heavy ML model. It is intentionally simple and deterministic so we
can iterate on the harder pipeline later from a known baseline.

The pipeline uses four pieces:

1. A **calibration texture generator** that paints a per-panel triangulated
   target with unique high-saturation colors and printed triangle IDs:

   - script: `scripts/generate-aop-triangle-calibration.ts`
   - npm: `npm run aop:triangle:generate`

2. A **CV detector** that takes a Printify mockup PNG and the calibration
   manifest and emits a JSON description of the triangles it sees plus an
   initial mesh + mask suggestion:

   - script: `scripts/detect-aop-triangle-calibration.ts`
   - npm: `npm run aop:triangle:detect`

3. A **panel calibration ingestion CLI** that consumes the detection JSON
   plus the original flat panel PNG and produces reusable per-panel
   calibration data: piecewise-affine triangle mappings, a solved mesh,
   the outer-boundary mask polygon, quality diagnostics, and a
   reconstruction PNG that warps the source panel through the saved
   mappings:

   - script: `scripts/build-aop-panel-calibration.ts`
   - npm: `npm run aop:panel:calibrate`

4. The **AOP Calibration Mapper UI** (`/aop-calibration-mapper`) which
   accepts both detection JSON (initial guess) and calibration JSON
   (final piecewise-affine mapping). The same overlays are still
   available for manual mesh/mask editing on top of the suggestion.

> **Important:** This is *assisted* calibration, not fully automatic
> calibration. Always treat the output of step 2/3 as a starting point;
> expect to manually correct mesh handles, mask vertices, and z-order
> before saving the final calibration.

---

## End-to-end workflow

1. **Generate calibration panels.**

   ```bash
   npm run aop:triangle:generate
   # optional flags
   #   --longEdge 1024
   #   --size L
   #   --mappingPath tmp/printify-mapping-product-20.json
   ```

   Outputs:

   - `tmp/aop-triangle-calibration/panels/<panel>.png` — one PNG per AOP
     panel (12 panels for the zip-hoodie product 20 default).
   - `tmp/aop-triangle-calibration/manifest.json` — every triangle in
     normalized UV space, plus its target color so the detector can map
     observed pixels back to a known UV anchor.

2. **Run the existing Printify calibration with the triangle PNGs.**

   Use `scripts/run-aop-calibration.ts` (or the existing AppAI calibration
   tooling) to upload the triangle panels to Printify and produce
   per-view mockups. Mockups are saved under
   `tmp/aop-calibration/run-summary-*.json` and cached locally by the
   mapper dev API.

3. **Open the mapper.**

   `npm run dev`, then visit `/aop-calibration-mapper`. Click **Load
   starter assets** to load the calibration mockups and the locally
   rasterized panels. Add the triangle calibration panel for the panel
   you want to calibrate (you can upload it via *Upload custom panel*
   if it isn't already in `tmp/aop-render-tests/source-panels`).

4. **Run the detector.**

   ```bash
   npm run aop:triangle:detect -- \
     --panel back \
     --mockup tmp/aop-calibration-mapper-cache/<runId>-back.png
   ```

   Useful flags:

   - `--manifest <path>` — defaults to
     `tmp/aop-triangle-calibration/manifest.json`.
   - `--analysisLongEdge <px>` — downsample the mockup before color
     search (default `800`). Smaller numbers run faster but lose
     accuracy.
   - `--labThreshold <num>` — Lab distance accepted for a pixel to count
     as a triangle match (default `22`). Lower means stricter.
   - `--minPixels <num>` — minimum pixel cluster size to keep (default
     `12`).

   Outputs:

   - `tmp/aop-triangle-calibration/detections/<panel>.json` — the
     suggested mesh, mask, raw triangle clusters, and per-correspondence
     confidence values.
   - `tmp/aop-triangle-calibration/debug/<panel>-detected.png` — the
     mockup composited with detection markers + the suggested mesh
     overlay so you can sanity-check the detector before importing.

5. **Import detection JSON into the mapper.**

   In the **AI-assist (triangle CV)** section of the Properties panel,
   click **Auto-suggest mesh** and pick the JSON from step 4. The mapper
   will:

   - Replace the active panel's mesh with `suggestedMesh`.
   - Reset the panel transform so the suggested coordinates apply
     directly to the mockup.
   - Replace the panel's mask with `suggestedMask` (a tight bounding
     polygon around the detected triangles).
   - Store the raw detection so debug overlays can render.

6. **Manually correct.**

   Use the existing mesh / mask edit modes to refine. Detection overlays
   help you do this:

   - **Triangles** — colored dots at each detected centroid (green > 70%
     confidence, yellow > 40%, orange below).
   - **Lines** — dashed segments from the *current* warped UV centroid
     to the *detected* mockup XY. Short = mesh agrees with detection;
     long = mesh needs a nudge.
   - **Heatmap** — fill each suggested mesh cell with a confidence
     gradient (green → red).
   - **Rejects** — red dashed markers at the warped UV position of every
     triangle the detector dropped. Use them to spot occluded or warped
     regions where you might want to add manual correction.

7. **(Optional) Build per-panel calibration JSON.**

   Once the detection looks reasonable you can build a reusable
   piecewise-affine calibration with one CLI invocation:

   ```bash
   npm run aop:panel:calibrate -- \
     --panel back \
     --mockup tmp/aop-triangle-calibration/mockups/back.png
   # optional flags:
   #   --source <path>      # default tmp/.../panels/<panel>.png
   #   --detection <path>   # reuse a pre-existing detection JSON
   #   --skipReconstruction
   #   --skipDebug
   ```

   The CLI runs (or imports) detection, solves a confidence-weighted
   Gauss-Seidel mesh that pins each detected triangle's centroid to its
   measured XY in the mockup, traces the outer boundary of detected cells
   for the mask polygon, and emits:

   - `tmp/aop-triangle-calibration/calibrations/<panel>.json` — the full
     calibration record (per-triangle src/dst vertices, solved mesh,
     mask polygon, quality diagnostics).
   - `tmp/aop-triangle-calibration/reconstructions/<panel>.png` — the
     source panel warped through the saved mappings onto a transparent
     canvas at mockup size.
   - `tmp/aop-triangle-calibration/debug/<panel>-calibration-debug.png`
     — the Printify mockup composited with the reconstruction overlay
     plus mask boundary, triangle confidence markers, and dashed outlines
     around low-confidence triangles.

   The same calibration math is exposed inside the mapper: select a
   panel, import a detection, then click **Build from detection** in the
   *Panel calibration (piecewise affine)* section to apply the same
   mesh + mask without leaving the page.

8. **Manually correct.**

   Use the existing mesh / mask edit modes to refine. Detection overlays
   help you do this:

   - **Triangles** — colored dots at each detected centroid (green > 70%
     confidence, yellow > 40%, orange below).
   - **Lines** — dashed segments from the *current* warped UV centroid
     to the *detected* mockup XY. Short = mesh agrees with detection;
     long = mesh needs a nudge.
   - **Heatmap** — fill each suggested mesh cell with a confidence
     gradient (green → red).
   - **Rejects** — red dashed markers at the warped UV position of every
     triangle the detector dropped. Use them to spot occluded or warped
     regions where you might want to add manual correction.
   - **Mask boundary** — the calibration's traced outer boundary in
     dashed cyan.
   - **Show reconstruction only** — hides the Printify mockup and shows
     just the warped panel so you can confirm shape coverage in
     isolation.
   - **Diff vs mockup** — flips the panel preview into a `difference`
     blend so misalignments stand out as bright pixels.

9. **Save calibration.**

   When you're satisfied, save with **Save** in the Properties panel.
   Saved calibrations live in `tmp/aop-calibrations/<label>.json`. The
   detection itself is *not* saved into the calibration JSON — it is a
   per-session hint only, so calibrations stay portable. The
   piecewise-affine calibration JSON (step 7) is a separate, portable
   artifact that lives next to the run artifacts and can be replayed
   against any artwork panel for the same garment view.

---

## Manifest schema (v1)

```jsonc
{
  "version": "aop-triangle-calibration/v1",
  "generatedAt": "<ISO-8601>",
  "productTypeId": 20,
  "size": "L",
  "longEdge": 1024,
  "panels": {
    "<panelKey>": {
      "panelKey": "<panelKey>",
      "sourceSize": { "width": <int>, "height": <int> },
      "renderSize": { "width": <int>, "height": <int> },
      "cols": <int>,
      "rows": <int>,
      "triangleCount": <int>,
      "cornerColors": { "tl": "#ff0000", "tr": "#00ff00", "bl": "#ffff00", "br": "#00aaff" },
      "triangles": [
        {
          "id": <int>,
          "panelKey": "<panelKey>",
          "cell": { "row": <int>, "col": <int> },
          "type": "upper" | "lower",
          "uv": [ {"u": <0..1>, "v": <0..1>}, ... 3 entries ],
          "centroidUV": { "u": <0..1>, "v": <0..1> },
          "color": { "hex": "#rrggbb", "rgb": [r,g,b], "hsl": [h,s,l] }
        }
      ]
    }
  }
}
```

## Detection schema (v1)

```jsonc
{
  "panelName": "<panelKey>",
  "manifestVersion": "aop-triangle-calibration/v1",
  "detectedAt": "<ISO-8601>",
  "mockupSize": { "width": <int>, "height": <int> },
  "analysisSize": { "width": <int>, "height": <int> },
  "panelGrid": { "cols": <int>, "rows": <int> },
  "detectedTriangles": [
    {
      "id": <int>,
      "type": "upper" | "lower",
      "cell": { "row": <int>, "col": <int> },
      "centroidUV": { "u": <0..1>, "v": <0..1> },
      "expectedColor": "#rrggbb",
      "observedColor": "#rrggbb",
      "centroidXY": { "x": <px>, "y": <px> } | null,
      "pixelCount": <int>,
      "bboxXY": { "x": <px>, "y": <px>, "width": <px>, "height": <px> } | null,
      "meanLabDistance": <number>,
      "spread": <number>,
      "confidence": <0..1>,
      "rejected": <boolean>,
      "reason": "no_match" | "below_min_pixels" | undefined
    }
  ],
  "correspondences": [
    {
      "triangleId": <int>,
      "source": { "u": <0..1>, "v": <0..1>, "x": <px>, "y": <px> },
      "target": { "x": <px>, "y": <px> },
      "confidence": <0..1>
    }
  ],
  "suggestedMesh": {
    "rows": <int>,
    "cols": <int>,
    "points": [
      { "u": <0..1>, "v": <0..1>, "x": <px>, "y": <px>, "confidence": <0..1> }
    ]
  },
  "suggestedMask": [ { "u": <0..1>, "v": <0..1> }, ... ],
  "stats": {
    "totalTriangles": <int>,
    "accepted": <int>,
    "rejected": <int>,
    "averageConfidence": <0..1>
  }
}
```

---

## Calibration schema (v1)

```jsonc
{
  "version": "aop-panel-calibration/v1",
  "panelName": "<panelKey>",
  "manifestVersion": "aop-triangle-calibration/v1",
  "detectedAt": "<ISO-8601>",
  "builtAt": "<ISO-8601>",
  "sourceSize": { "width": <int>, "height": <int> },
  "mockupSize": { "width": <int>, "height": <int> },
  "panelGrid": { "cols": <int>, "rows": <int> },
  "triangles": [
    {
      "triangleId": <int>,
      "type": "upper" | "lower",
      "cell": { "row": <int>, "col": <int> },
      "vertexIndices": [<int>, <int>, <int>],
      "srcVertices": [[<px>,<px>], [<px>,<px>], [<px>,<px>]],
      "dstVertices": [[<px>,<px>], [<px>,<px>], [<px>,<px>]],
      "confidence": <0..1>
    }
  ],
  "mesh": {
    "rows": <int>,
    "cols": <int>,
    "points": [
      { "u": <0..1>, "v": <0..1>, "x": <px>, "y": <px>,
        "confidence": <0..1>, "constraintCount": <int> }
    ]
  },
  "mask": {
    "polygon":   [[<px>,<px>], ...],
    "polygonUV": [[<0..1>,<0..1>], ...],
    "source": "outer-boundary-of-detected-triangles" | "no-detection"
  },
  "quality": {
    "detectedTriangleCount": <int>,
    "totalTriangleCount": <int>,
    "coveragePercent": <0..100>,
    "avgConfidence": <0..1>,
    "meshUnconstrainedVertexCount": <int>,
    "meanCentroidErrorPx": <px>,
    "maxCentroidErrorPx": <px>,
    "missingTriangleIds": [<int>, ...],
    "lowConfidenceTriangleIds": [<int>, ...]
  }
}
```

`srcVertices` are pixel coordinates inside the source panel image
(`sourceSize`); `dstVertices` are pixel coordinates inside the mockup
image (`mockupSize`). The triangle list is the **reusable** mapping —
warping `srcVertices → dstVertices` for every triangle and compositing
them produces the reconstruction PNG, and the same math will warp any
customer artwork panel into the same garment shape.

`mesh.points` is the solved per-vertex mesh in the same mockup pixel
space — use it for the `MeshGrid` of a mapper panel. `mask.polygon` is
the outer boundary of detected cells in mockup pixels;
`mask.polygonUV` is the same polygon expressed in source UV space and
is what the mapper applies as a clipping mask after import.

## Tuning notes

- **`labThreshold`**: the detector classifies each pixel by the closest
  triangle color in Lab space. With 70-100 triangles per panel using
  golden-angle hue spread the average Lab distance between neighbours is
  ~10. Raise the threshold (default `22`) cautiously — going too high
  starts grabbing background pixels and the corner markers contaminate
  the centroid.
- **`analysisLongEdge`**: the analysis pass runs at this resolution and
  centroids are scaled back up to the original mockup size. `800` is a
  good balance between speed and accuracy for 2-4k mockups.
- **`minPixels`**: tightening this rejects more triangles but reduces
  the chance of a tiny noise cluster being treated as a detection.
- **Confidence**: `0.55 * labQuality + 0.25 * tightness + 0.2 * sizeFactor`.
  All three are clamped to `[0,1]`. Treat anything below ~0.4 as a
  region to manually inspect.

## OpenCV upgrade path (deferred)

The current detector uses sharp + raw RGBA buffers and a Lab-distance
classifier. We deliberately did not pull in `opencv4nodejs` for v1 to
avoid a native build dependency. When we want to upgrade:

1. `npm install opencv4nodejs` (requires CMake + OpenCV libs locally).
2. Replace the per-pixel Lab loop with `cv.Mat` and
   `inRange`/`findContours` for sub-pixel triangle bounds.
3. Use `findHomography` on the centroid correspondences to recover a
   smoother global mesh.

Until then, the existing pipeline is enough to seed the mapper with a
useful starting mesh and mask.
